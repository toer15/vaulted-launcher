#!/usr/bin/env node
'use strict'

/**
 * Season regressions. Run with `npm run test:regression` (also part of
 * `npm run build`, so `npm run dist` runs it too).
 *
 * It locks two things that previously broke live play:
 *
 *   1. The merged companion launcher lifecycle. The launcher is started before
 *      the client, kept for the entire game session, and closed only after
 *      every FortniteClient-Win64-Shipping.exe process exits or the player
 *      presses Stop. No timer may close it early.
 *   2. Every working season keeps its exact route, DLL profile, login mode and
 *      card state, so fixing one provider can never silently change another.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const builds = require('../src/assets/builds.json')
const {
  EXIT_GRACE_MS,
  GAME_POLL_MS,
  GAME_PROCESS_NAME,
  createCompanionSessionState,
  observeCompanionSession,
  shouldCloseCompanionLauncher,
} = require('../electron/companionLifecycle.cjs')
const { mergeSavedBuild } = require('../electron/rebootLauncher.cjs')
const { probeProviderStatus } = require('../electron/providerStatus.cjs')
const {
  BANNED_PROVIDER_IDS,
  isBannedProvider,
  providerCatalog,
  providerProfile,
  providerRuntime,
  providerRuntimeMetadata,
  providerUsesLegacyRedirect,
} = require('../electron/onlineProviders.cjs')

const MAIN = read('electron/main.cjs')

function season(id) {
  const value = builds.seasons[id]
  assert.ok(value, `${id} is missing from builds.json`)
  return value
}

function routeIds(value) {
  return [value.onlineProvider, ...(value.onlineProviders || [])]
    .filter(Boolean)
    .map((entry) => entry.id)
}

function testLifecycleRule() {
  // While the game runs, the launcher stays — before or after the first poll.
  assert.equal(
    shouldCloseCompanionLauncher({ gameRunning: true, sawGame: true }),
    false,
    'launcher must stay alive while the client is running',
  )
  assert.equal(
    shouldCloseCompanionLauncher({ gameRunning: true, sawGame: false }),
    false,
    'launcher must stay alive while the client is still booting',
  )
  // A launcher is never closed by an idle timer before the game appears.
  assert.equal(
    shouldCloseCompanionLauncher({ gameRunning: false, sawGame: false }),
    false,
    'launcher must not be closed before the game has run',
  )
  // Closing the game closes the launcher.
  assert.equal(
    shouldCloseCompanionLauncher({ gameRunning: false, sawGame: true }),
    true,
    'launcher must close after the game exits',
  )
  // Stop closes it even mid-session.
  assert.equal(
    shouldCloseCompanionLauncher({ gameRunning: true, sawGame: true, requestedStop: true }),
    true,
    'Stop must close the launcher immediately',
  )
  assert.equal(
    shouldCloseCompanionLauncher({ gameRunning: false, sawGame: false, requestedStop: true }),
    true,
    'Stop must close a launcher whose game never appeared',
  )
}

function testLaunchWiring() {
  assert.match(
    MAIN,
    /\} = require\('\.\/companionLifecycle\.cjs'\)/,
    'main must use the shared lifecycle rule',
  )
  for (const symbol of [
    'GAME_POLL_MS,',
    'createCompanionSessionState,',
    'observeCompanionSession,',
  ]) {
    assert.ok(MAIN.includes(symbol), `main must import ${symbol.replace(',', '')}`)
  }

  const startAt = MAIN.indexOf('await startCompanionLauncher(providerId, { folder })')
  const launchAt = MAIN.indexOf('await launchInjectedGame(launchPayload')
  assert.ok(startAt > 0, 'the managed launch must start the companion launcher')
  assert.ok(launchAt > 0, 'the managed launch must inject the client')
  assert.ok(startAt < launchAt, 'the companion launcher must start before Fortnite')

  assert.match(
    MAIN,
    /attachCompanionGameProcess\(providerId, launched\.pid\)/,
    'the client start must bind the real client PID to the launcher monitor',
  )
  assert.equal(
    /markProviderLauncherGameStarted/.test(MAIN),
    false,
    'nothing may claim the game started before its process exists',
  )

  const closeAt = MAIN.indexOf("ipcMain.handle('arc:close-build'")
  assert.ok(closeAt > 0, 'the Stop handler is missing')
  const closeBody = MAIN.slice(closeAt, closeAt + 1400)
  assert.match(
    closeBody,
    /closeCompanionLauncherForProvider\(entry\.providerId\)/,
    'Stop must close the season companion launcher',
  )

  // No timer or startup timeout may close a companion launcher.
  assert.equal(
    /setTimeout\([\s\S]{0,200}closeCompanionLauncherForProvider/.test(MAIN),
    false,
    'a timer must never close a companion launcher',
  )
  const monitorAt = MAIN.indexOf('function startCompanionSessionMonitor(')
  assert.ok(monitorAt > 0, 'the launcher session monitor is missing')
  const monitorBody = MAIN.slice(monitorAt, MAIN.indexOf('/** Resolve every process started', monitorAt))
  assert.match(
    monitorBody,
    /observeCompanionSession\(state\.session, \{/,
    'the session monitor must ask the shared rule',
  )
  assert.match(
    monitorBody,
    /\}, GAME_POLL_MS\)/,
    'the session monitor must poll the game every GAME_POLL_MS (3s)',
  )
  assert.match(
    monitorBody,
    /closeCompanionLauncherForProvider\(id\)/,
    'the session monitor must close the whole launcher tree',
  )
  assert.match(
    monitorBody,
    /state\.gamePid \? processAlive\(state\.gamePid\) : false/,
    'the monitor must keep the exact client PID as a liveness signal',
  )
  assert.equal(
    /\bchild\.(?:pid|on|once|exit|kill)\b/.test(monitorBody),
    false,
    'the session monitor must never depend on the spawned launcher child (its bootstrapper PID exits early)',
  )
  assert.equal(
    /setTimeout\(|killProcessTree\(|taskkill/.test(monitorBody),
    false,
    'the session monitor must close through the shared close helper only',
  )

  // The close has to follow the launcher's process names, because the PID a
  // bootstrapper spawned from is gone long before the session ends.
  const launcherCloseAt = MAIN.indexOf('async function closeCompanionLauncherForProvider(')
  assert.ok(launcherCloseAt > 0, 'the companion launcher close helper is missing')
  const launcherCloseBody = MAIN.slice(
    launcherCloseAt,
    MAIN.indexOf('function providerWindowNames(', launcherCloseAt),
  )
  assert.match(
    launcherCloseBody,
    /processPidsByImage\(names\)/,
    'the close must target the launcher process names, not only the spawn PID',
  )
  assert.match(
    launcherCloseBody,
    /pid !== process\.pid/,
    'the close must never target VAULTED itself',
  )
}

/**
 * The exact failure this suite exists for: a companion launcher whose
 * bootstrapper PID exits (single-instance handoff, or a loader that spawns the
 * real process and quits) must NOT be cleaned up while
 * FortniteClient-Win64-Shipping.exe is alive — and it must never be closed one
 * second before the client has actually been seen running and really exited.
 */
function testLauncherOutlivesBootstrapper() {
  assert.equal(GAME_PROCESS_NAME, 'FortniteClient-Win64-Shipping.exe')
  assert.equal(GAME_POLL_MS, 3_000, 'the lifecycle must poll the game every three seconds')
  assert.ok(EXIT_GRACE_MS >= 12_000, 'closing must be delayed, never advanced')

  const t0 = 1_000_000
  const poll = (state, running, extra = {}) =>
    observeCompanionSession(state, { running, probeOk: true, now: t0 + extra.ticks * GAME_POLL_MS, ...extra })

  // 1. The bootstrapper PID exits before the client appears: nothing closes.
  let state = createCompanionSessionState()
  let decision = poll(state, false, { ticks: 0 })
  assert.equal(decision.close, false, 'a launcher must survive its bootstrapper exiting before the game appears')
  state = decision.state

  // 2. The client appears: the launcher stays.
  decision = poll(state, true, { ticks: 1 })
  assert.equal(decision.close, false)
  state = decision.state
  assert.equal(state.sawGame, true, 'seeing the client must arm the after-exit close')

  // 3. A failed probe is unknown, never an exit.
  decision = observeCompanionSession(state, {
    running: false,
    probeOk: false,
    now: t0 + 2 * GAME_POLL_MS,
  })
  assert.equal(decision.close, false, 'a failed tasklist probe must never close the launcher')
  state = decision.state

  // 4. One missed poll inside the grace window is not an exit either.
  decision = poll(state, false, { ticks: 3 })
  assert.equal(decision.close, false, 'the launcher must survive a single missed poll')
  state = decision.state

  // 5. The client comes back (EAC/launcher restart): still open, grace reset.
  decision = poll(state, true, { ticks: 4 })
  assert.equal(decision.close, false)
  state = decision.state

  // 6. The client exits and stays gone: the launcher closes exactly once, and
  //    only after the whole grace window has passed.
  decision = poll(state, false, { ticks: 5 })
  assert.equal(decision.close, false, 'closing must wait for the grace window')
  state = decision.state
  const justBefore = observeCompanionSession(state, {
    running: false,
    probeOk: true,
    now: t0 + 5 * GAME_POLL_MS + EXIT_GRACE_MS - 1,
  })
  assert.equal(justBefore.close, false, 'the launcher must not close one millisecond early')
  const afterGrace = observeCompanionSession(justBefore.state, {
    running: false,
    probeOk: true,
    now: t0 + 5 * GAME_POLL_MS + EXIT_GRACE_MS,
  })
  assert.equal(afterGrace.close, true, 'the launcher must close once the game has really exited')
  assert.equal(afterGrace.reason, 'game-exited')

  // 7. Stop is the only immediate close.
  const stop = observeCompanionSession(createCompanionSessionState(), {
    running: true,
    probeOk: true,
    requestedStop: true,
  })
  assert.equal(stop.close, true, 'Stop must close the launcher immediately')

  // 8. A launcher whose game never appears is never closed by the poll, however
  //    long it waits.
  state = createCompanionSessionState()
  for (let tick = 0; tick < 200; tick += 1) {
    decision = poll(state, false, { ticks: tick })
    assert.equal(decision.close, false, 'a launcher must never be closed before the game has run')
    state = decision.state
  }
}

function testWorkingSeasons() {
  // Chapter 1 Season 6 runs on Project Era's official launcher. Era's own
  // installer (Era-Setup-4.0.42.exe, 115 MB NSIS) passed the installer safety
  // gate and a Defender scan, installs silently to
  // %LOCALAPPDATA%\Programs\era-launcher\Era.exe, and Era's public API reports
  // the live season number, which is 6 today.
  const ch1s6 = season('ch1-s6')
  assert.equal(ch1s6.version, '6.21')
  assert.ok(ch1s6.downloadUrl, 'ch1-s6 must keep its real 6.21 season build download')
  assert.equal(ch1s6.runtimeProfile, 'legacy')
  assert.equal(ch1s6.onlineProvider?.id, 'era-official', 'ch1-s6 must route through Era')
  assert.deepEqual(
    [...new Set(routeIds(ch1s6))],
    ['era-official'],
    'ch1-s6 must have exactly one verified launcher route',
  )
  const eraOfficial = providerCatalog().find((entry) => entry.id === 'era-official')
  assert.ok(eraOfficial?.runtime, 'Era must ship its launcher runtime')
  assert.deepEqual(eraOfficial.supportedSeasons, [
    'ch1-s1',
    'ch1-s2',
    'ch1-s3',
    'ch1-s4',
    'ch1-s5',
    'ch1-s6',
    'ch1-s7',
    'ch1-s8',
    'ch1-s9',
  ])
  assert.equal(eraOfficial.mode, 'external')
  // Era hosts one Chapter 1 season at a time and reports it, so it follows that
  // season instead of pinning ch1-s6 forever.
  assert.equal(eraOfficial.liveSeason?.path, 'data.season.number')
  assert.equal(eraOfficial.liveSeason?.seasonPrefix, 'ch1-s')
  assert.equal(eraOfficial.liveSeason?.equals, undefined, 'Era must follow, not pin a season')
  for (let number = 1; number <= 9; number += 1) {
    assert.equal(
      routeIds(season(`ch1-s${number}`)).includes('era-official'),
      true,
      `ch1-s${number} must carry Era so a rotation can follow it`,
    )
  }
  // A dedicated community's route must stay the primary one; Era is attached
  // behind it so following a rotation never demotes SunSet or ARC.
  for (const [seasonId, primaryId] of Object.entries({
    // Project Hestia hosts 1.11 from its own launcher, so it leads Season 2;
    // SunSet stays attached as the community route behind it.
    'ch1-s2': 'hestia-official',
    'ch1-s3': 'omen-official',
    'ch1-s4': 'arc',
    'ch1-s5': 'sunset',
  })) {
    assert.equal(
      season(seasonId).onlineProvider?.id,
      primaryId,
      `${seasonId} must keep ${primaryId} as its dedicated provider`,
    )
    assert.equal(season(seasonId).onlineProviders?.[0]?.id, primaryId)
  }
  assert.equal(
    routeIds(season('ch1-s10')).includes('era-official'),
    false,
    'Season X belongs to Neo, so Era must not claim it',
  )
  const eraRuntime = providerRuntimeMetadata('era-official')
  assert.equal(eraRuntime?.processName, 'Era.exe')
  assert.equal(eraRuntime?.silentArgs?.[0], '/S')
  assert.ok(
    eraRuntime?.installedExecutables?.includes('%LOCALAPPDATA%/Programs/era-launcher/Era.exe'),
    'the verified Era install path must be first-class',
  )
  assert.match(eraRuntime?.downloadUrl || '', /^https:\/\/api\.erafn\.dev\//)
  const rebootOnline = providerCatalog().find((entry) => entry.id === 'reboot-official')
  assert.equal(rebootOnline, undefined, 'Reboot must not be exposed as an online provider')
  assert.equal(isBannedProvider('reboot-official'), true, 'Reboot must be banned')
  assert.equal(isBannedProvider('reboot'), true, 'the local Reboot profile must be banned')
  assert.match(
    providerRuntimeMetadata('reboot-official')?.label || '',
    /Reboot Launcher/,
    'the old Reboot runtime stays only as a repair source',
  )
  // Era keeps its launcher runtime for DLL staging and repair, but owns no
  // season and may not re-claim one from its live build list.
  const eraCatalog = providerCatalog().find((entry) => entry.id === 'era')
  assert.ok(eraCatalog, 'Era must stay in the provider catalog')
  assert.equal(eraCatalog.dynamicSeasons, false, 'Era must not discover season routes at runtime')
  assert.deepEqual(eraCatalog.supportedSeasons, [], 'Era must not claim any season')
  assert.ok(providerRuntimeMetadata('era'), 'Era must keep its launcher metadata')
  for (const value of Object.values(builds.seasons)) {
    assert.equal(routeIds(value).includes('era'), false, `${value.id} still routes through Era`)
  }

  // Stellar/EZFN keep 12.41 and their sign-in modes.
  const ch2s2 = season('ch2-s2')
  assert.equal(ch2s2.version, '12.41')
  assert.equal(ch2s2.onlineProvider?.id, 'ezfn')
  for (const id of ['ezfn', 'stellar']) {
    assert.ok(routeIds(ch2s2).includes(id), `ch2-s2 lost ${id}`)
  }
  assert.equal(providerProfile('stellar').auth, 'deeplink')
  assert.equal(providerProfile('ezfn').auth, 'embedded_web')

  // Retrac keeps its 14.60 official launcher route.
  const retrac = season('ch2-s4')
  assert.equal(retrac.version, '14.60')
  assert.equal(retrac.onlineProvider?.id, 'retrac-official')
  assert.ok(providerRuntimeMetadata('retrac-official')?.label === 'Retrac Launcher')

  // Discord-gated communities keep their gate route.
  for (const [id, seasonId] of Object.entries({
    arc: 'ch1-s4',
    eon: 'ch2-s7',
    hydro: 'ch2-s5',
    interloop: 'ch2-s2',
    crystal: 'ch2-s5',
  })) {
    const provider = providerCatalog().find((entry) => entry.id === id)
    assert.ok(provider?.discordGate, `${id} lost its Discord gate`)
    assert.ok(provider.supportedSeasons.includes(seasonId), `${id} lost ${seasonId}`)
    assert.ok(routeIds(season(seasonId)).includes(id), `${seasonId} lost ${id}`)
  }

  // Reboot-only seasons and seasons without any public backend stay unavailable.
  for (const id of [
    'ch2-s3',
    'ch2-s6',
    'ch2-s8',
    'ch3-s2',
    'ch3-s3',
    'ch3-s4',
    'ch4-s1',
    'ch4-s3',
    'ch4-s5',
  ]) {
    const value = season(id)
    assert.equal(value.onlineProvider, undefined, `${id} must stay unavailable`)
    assert.equal(value.onlineProviders, undefined, `${id} must stay unavailable`)
  }

  // Project Rewind is a live 2026 Chapter 4 community (Discord guild pinned
  // and verified: 45k members, 5k online). Its season routes through the
  // two-step community unlock, never through an installer VAULTED runs.
  const ch4s2 = season('ch4-s2')
  assert.equal(ch4s2.version, '24.20')
  assert.equal(ch4s2.onlineProvider?.id, 'rewind-official', 'ch4-s2 must route through Rewind')
  assert.deepEqual([...new Set(routeIds(ch4s2))], ['rewind-official'])
  const rewind = providerCatalog().find((entry) => entry.id === 'rewind-official')
  assert.ok(rewind?.discordGate, 'Rewind needs its Discord gate')
  assert.equal(rewind.discordGate.guildId, '1419395512121032879', 'Rewind guild must stay pinned')
  assert.equal(rewind.discordGate.inviteUrl, 'https://discord.gg/rewindmp')
  assert.equal(rewind.runtime, undefined, 'Rewind ships no installer VAULTED runs')
  assert.equal(rewind.directLaunch, true, 'Rewind unlocks through the community launcher import')

  // Project Origins hosts Chapter 3 Season 1 (19.01). It joins the verified
  // BlueOG route as a second, equally Discord-gated community.
  const ch3s1 = season('ch3-s1')
  assert.equal(ch3s1.onlineProvider?.id, 'blue-og', 'BlueOG must stay the primary Ch3 S1 route')
  const ch3s1Routes = [...new Set(routeIds(ch3s1))]
  assert.ok(ch3s1Routes.includes('origins-official'), 'ch3-s1 must list Origins')
  const origins = providerCatalog().find((entry) => entry.id === 'origins-official')
  assert.equal(origins?.discordGate?.guildId, '1500960775743733942', 'Origins guild must stay pinned')
  assert.equal(origins?.runtime, undefined, 'Origins ships no installer VAULTED runs')

  // Omen (Season 3: 3.5/3.6), ARC (Season 4: v4.5) and VYNX (Season 11) are
  // real hosted communities, but each runs a build this catalog does not
  // install: ch1-s3 ships 3.0.0-CL-3901517, ch1-s4 ships 4.10-CL-4053532 and
  // ch2-s1 ships 11.00-CL-9562734. A launcher's backend and its redirect only
  // accept its own build, so those cards must stay locked until the exact
  // build ships and a launch against that launcher is verified.
  for (const [seasonId, providerId, guildId, invite, launcherBuild] of [
    ['ch1-s3', 'omen-official', '1510765844404109332', 'https://discord.gg/omenmp', '3.5/3.6'],
    ['ch1-s4', 'arc', '1538872114537562163', 'https://discord.gg/arcogfn', '4.5'],
    ['ch2-s1', 'vynx-official', '1366960510699831306', 'https://discord.gg/vynxzy', 'Chapter 2 Season 1'],
  ]) {
    const value = season(seasonId)
    assert.equal(value.onlineProvider?.id, providerId, `${seasonId} still names ${providerId}`)
    assert.equal(value.onlineProviders?.[0]?.id, providerId)
    const provider = providerCatalog().find((entry) => entry.id === providerId)
    assert.equal(provider?.discordGate?.guildId, guildId, `${providerId} guild must stay pinned`)
    assert.equal(provider?.discordGate?.inviteUrl, invite, `${providerId} invite must stay pinned`)
    assert.equal(
      provider?.communityVerified,
      false,
      `${providerId} runs ${launcherBuild}, which the ${seasonId} install (${value.version}) does not match`,
    )
    assert.equal(provider?.directLaunch, true, `${providerId} keeps its community launcher route`)
    assert.equal(provider?.runtime, undefined, `${providerId} ships no installer VAULTED runs`)
  }
  // Locked means no ONLINE · DISCORD: the verified early return requires a
  // community whose build matches, and these three are route-only.
  for (const id of ['ch1-s3', 'ch1-s4', 'ch2-s1']) {
    assert.equal(
      providerCatalog().some((entry) =>
        routeIds(season(id)).includes(entry.id) && entry.communityVerified === true,
      ),
      false,
      `${id} must not advertise a verified community while its build mismatches`,
    )
  }

  // Rewind runs Chapter 5 Season 1 (28.30) as well as 24.20: its invite states
  // Chapter 5 Season 1 and a 2026 Rewind tutorial walks through that build.
  const ch5s1 = season('ch5-s1')
  assert.equal(ch5s1.version, '28.30')
  assert.equal(ch5s1.onlineProvider?.id, 'rewind-official', 'ch5-s1 must route through Rewind')
  assert.deepEqual([...new Set(routeIds(ch5s1))], ['rewind-official'])
  assert.ok(
    rewind.supportedSeasons.includes('ch5-s1') && rewind.supportedSeasons.includes('ch4-s2'),
    'Rewind must cover both 24.20 and 28.30',
  )

  // Chapter 1 Season X runs on Project Neo's verified launcher. The launcher
  // installs to %LOCALAPPDATA%\NeoLauncher\current\NeoLauncher.exe (confirmed on
  // this PC, Neo 1.1.7), and its own log reports the live service build 9380822,
  // which is exactly this season's 10.40 build.
  const ch1s10 = season('ch1-s10')
  assert.equal(ch1s10.version, '10.40')
  assert.equal(ch1s10.onlineProvider?.id, 'neo', 'ch1-s10 must route through Neo')
  assert.deepEqual(
    [...new Set(routeIds(ch1s10))],
    ['neo'],
    'ch1-s10 must have exactly one verified launcher route',
  )
  assert.match(ch1s10.downloadUrl || '', /10\.40-CL-9380822/, 'Neo runs the 10.40 build')
  const neo = providerCatalog().find((entry) => entry.id === 'neo')
  assert.ok(neo?.runtime, 'Neo must ship its launcher runtime')
  assert.deepEqual(neo.supportedSeasons, ['ch1-s10'])
  assert.equal(neo.mode, 'external')
  const neoRuntime = providerRuntimeMetadata('neo')
  assert.equal(neoRuntime?.processName, 'NeoLauncher.exe')
  assert.ok(
    neoRuntime?.installedExecutables?.includes(
      '%LOCALAPPDATA%/NeoLauncher/current/NeoLauncher.exe',
    ),
    'the verified Neo install path must be first-class',
  )
  assert.match(neoRuntime?.downloadUrl || '', /^https:\/\/projectneofn\.dev\//)
  assert.equal(neoRuntime?.silentArgs?.length, 0, 'Neo shows its own setup UI; /S is ignored')

  // The old Neo/Neonite backend routes stay removed; only the verified launcher
  // may answer to a neo route id.
  for (const value of Object.values(builds.seasons)) {
    assert.equal(
      routeIds(value).some((id) => /^(?:neo-official|neonite)$/i.test(id)),
      false,
      `${value.id} routes through the removed Neo backend`,
    )
  }

  // 4.x builds predate Tellurium's hooks and stay on Cobalt.
  assert.equal(providerUsesLegacyRedirect('4.10', 'ch1-s4'), false)
  assert.match(providerRuntime(providerProfile('reboot'), { legacy: true }).dll, /Cobalt\.dll$/)
}

function testResearchedLaunchersStayUnwired() {
  // 2026-11-23 research sweep. The community index (awesome-ogfn) lists six
  // hosted OG Fortnite projects: Stellar, Retrac, EZFN, Era, Eon and Neo.
  // Everything else found online was rejected on evidence, and none of it may
  // quietly become a green online route or an installer VAULTED runs.
  assert.equal(isBannedProvider('legacy-official'), true, 'Project Legacy must stay banned')
  assert.equal(
    providerCatalog().some((entry) => entry.id === 'legacy-official'),
    false,
    'a banned launcher must never reach the renderer',
  )
  const legacy = JSON.parse(read('resources/providers/provider.json')).providers.find(
    (entry) => entry.id === 'legacy-official',
  )
  assert.equal(legacy?.banned, true, 'Project Legacy must be marked banned in the catalog')
  assert.deepEqual(legacy?.seasons, [], 'Project Legacy owns no season')
  assert.equal(legacy?.runtime, undefined, 'Project Legacy must have no installable runtime')
  assert.match(
    legacy?.bannedReason || '',
    /Trojan:Win32\/Suschil|Defender/i,
    'the Defender detection must stay documented',
  )
  assert.ok(
    !providerRuntimeMetadata('legacy-official'),
    'no installer metadata may revive the flagged Legacy download',
  )
  for (const value of Object.values(builds.seasons)) {
    assert.equal(
      routeIds(value).includes('legacy-official'),
      false,
      `${value.id} must not route through the flagged Project Legacy launcher`,
    )
  }

  // Prototypes that only ship a Discord invite, a dead host, or an installer we
  // could not verify stay locked instead of gaining a launcher by accident.
  for (const id of ['ch1-s1', 'ch1-s3', 'ch1-s4', 'ch1-s7', 'ch1-s8', 'ch1-s9', 'ch3-s1', 'ch4-s4', 'ch2-s1']) {
    for (const routeId of routeIds(season(id))) {
      // Era is the one verified, scanned, season-gated launcher allowed to sit
      // behind a locked Chapter 1 card: it only unlocks the season its API says
      // is live today.
      if (routeId === 'era-official') continue
      const entry = providerCatalog().find((provider) => provider.id === routeId)
      assert.ok(!entry?.runtime, `${id} must not gain an unverified installer through ${routeId}`)
    }
  }

  // Only the four verified online seasons ship a companion launcher. A new
  // provider without a live status sample and a clean installer must fail here.
  const runtimeSeasons = new Set()
  for (const entry of providerCatalog()) {
    if (!entry.runtime) continue
    for (const seasonId of entry.supportedSeasons || []) runtimeSeasons.add(seasonId)
  }
  assert.deepEqual(
    [...runtimeSeasons].sort(),
    [
      'ch1-s1',
      'ch1-s10',
      'ch1-s2',
      'ch1-s3',
      'ch1-s4',
      'ch1-s5',
      'ch1-s6',
      'ch1-s7',
      'ch1-s8',
      'ch1-s9',
      'ch2-s2',
      'ch2-s4',
      'ch2-s5',
      'ch2-s7',
    ],
    'only verified online seasons may ship a companion launcher',
  )
}

function testLawinServerBan() {
  // Reboot always starts an embedded LawinServer on loopback, even when its
  // server browser points a match at someone else's game server. No season may
  // offer it as an online route, and no launch entry point may start it.
  assert.equal(BANNED_PROVIDER_IDS.has('reboot-official'), true)
  assert.equal(BANNED_PROVIDER_IDS.has('reboot'), true)
  assert.equal(BANNED_PROVIDER_IDS.has('echo'), true, 'the malicious Echo installer must stay banned')

  // Echo's SFX embeds echo.vbs/echo.bat. The batch disables Defender,
  // downloads a payload and creates a SYSTEM scheduled task; it must never run.
  const echoCatalog = JSON.parse(read('resources/providers/provider.json')).providers.find(
    (entry) => entry.id === 'echo',
  )
  assert.equal(echoCatalog?.banned, true)
  assert.deepEqual(echoCatalog?.seasons, [])
  assert.match(echoCatalog?.bannedReason || '', /WinRAR SFX|malicious|SYSTEM scheduled task/i)
  assert.deepEqual(
    [...new Set(routeIds(season('ch1-s3')))],
    ['omen-official', 'era-official'],
    'ch1-s3 routes through Omen and keeps Era behind it',
  )
  const sunset = providerCatalog().find((entry) => entry.id === 'sunset')
  assert.ok(sunset, 'the SunSet replacement is missing from the provider catalog')
  assert.equal(sunset.launchKind, 'discord')
  assert.equal(sunset.runtime, undefined, 'SunSet must not install a companion launcher')
  assert.equal(
    /(?:^|[/:@])(?:127\.0\.0\.1|localhost|\[::1\])(?:[/:]|$)/i.test(sunset.backendUrl || ''),
    false,
    'SunSet must be hosted online, never loopback/local',
  )
  const community = JSON.parse(read('resources/providers/community.json'))
  const communityProviders = community.endpoints.flatMap((endpoint) =>
    Object.values(endpoint.providerMap || {}),
  )
  assert.equal(
    communityProviders.some((entry) => entry.id === 'echo'),
    false,
    'the community directory must not advertise Echo',
  )
  const safety = read('electron/installerSafety.cjs')
  assert.match(safety, /Setup\\s\*=\\s\*/, 'the SFX scanner must read the WinRAR Setup command')
  assert.match(safety, /assertInstallerSafe/)
  assert.match(safety, /RarSFX|WinRAR SFX/, 'the block must identify script-driven SFX installers')
  const wshSample = "Add-MpPreference -ExclusionPath 'C:\\ProgramData\\System'; schtasks /Create"
  const installerSafety = require('../electron/installerSafety.cjs')
  assert.match(wshSample, installerSafety.DANGEROUS_SCRIPT)
  assert.match(
    installerSafety.inspectionFailureReason('ERROR: contains a virus or potentially unwanted software'),
    /Defender.*malicious/i,
    'a Defender-blocked installer must report a real security reason',
  )
  assert.match(read('electron/providerRuntime.cjs'), /assertInstallerSafe\(installer/, 'installers must be inspected before execution')
  assert.match(read('electron/providerRuntime.cjs'), /startWindowsScriptHostGuard\(wshLog/, 'installer spawns must guard Windows Script Host')
  assert.match(read('electron/hiddenWindows.cjs'), /blocked ' \+ \$_\.ProcessName/, 'the WSH guard must log blocked scripts')
  assert.equal(
    providerCatalog().some((provider) => isBannedProvider(provider.id)),
    false,
    'the UI catalog must not expose a banned provider',
  )
  assert.equal(
    providerCatalog().some((provider) =>
      /(?:^|[/:@])(?:127\.0\.0\.1|localhost|\[::1\])(?:[/:]|$)/i.test(provider.backendUrl || ''),
    ),
    false,
    'no online provider may point at a loopback backend',
  )

  for (const value of Object.values(builds.seasons)) {
    for (const id of routeIds(value)) {
      assert.equal(isBannedProvider(id), false, `${value.id} still routes through banned ${id}`)
    }
  }
  const serverBuilds = JSON.parse(read('server/assets/builds.json')).seasons || {}
  for (const value of Object.values(serverBuilds)) {
    for (const id of routeIds(value)) {
      assert.equal(isBannedProvider(id), false, `${value.id} still routes through banned ${id}`)
    }
  }

  const catalog = JSON.parse(read('resources/providers/provider.json')).providers || []
  const reboot = catalog.find((entry) => entry.id === 'reboot-official')
  assert.equal(reboot?.banned, true, 'Reboot must be marked banned in the catalog')
  assert.deepEqual(reboot?.seasons, [], 'Reboot must not advertise any season')
  assert.match(reboot?.bannedReason || '', /private local backend/i)
  for (const entry of catalog) {
    assert.equal(
      /(?:^|[/:@])(?:127\.0\.0\.1|localhost|\[::1\])(?:[/:]|$)/i.test(entry.backendUrl || ''),
      false,
      `${entry.id} points at a loopback backend`,
    )
  }

  assert.match(
    MAIN,
    /if \(isBannedProvider\(id\)\) return \{ opened: false, error: BANNED_PROVIDER_REASON \}/,
    'the external launcher handoff must reject banned providers',
  )
  assert.match(
    MAIN,
    /if \(isBannedProvider\(providerId\)\) throw new Error\(BANNED_PROVIDER_REASON\)/,
    'the managed provider launch must reject banned providers',
  )
  assert.match(
    MAIN,
    /if \(isBannedProvider\(id\)\) return null/,
    'the companion launcher must reject banned providers',
  )
  const automation = read('electron/companionAutomation.cjs')
  assert.equal(
    /dismissCompanionServerPrompt|start a local game server/i.test(MAIN + automation),
    false,
    'the local-server prompt must not be clicked or accepted anywhere',
  )
  assert.equal(
    /lawinserver|127\.0\.0\.1|localhost/i.test(automation),
    false,
    'companion automation must never interact with a local backend',
  )

  // Strict project scan: no runtime source may mention or launch the private
  // local server executable, and no prompt handler may reintroduce it.
  const runtimeRoots = ['electron', 'src', 'resources/providers', 'runtime', 'server/assets']
  const textExtensions = /\.(?:cjs|mjs|js|ts|tsx|json|ps1|cs|html|css|md)$/i
  const walk = (dir) => {
    const absolute = path.join(root, dir)
    const entries = fs.readdirSync(absolute, { withFileTypes: true, recursive: true })
    return entries
      .filter((entry) => entry.isFile() && textExtensions.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name))
  }
  const forbidden = []
  for (const dir of runtimeRoots) {
    for (const file of walk(dir)) {
      if (/lawinserver|start a local game server/i.test(fs.readFileSync(file, 'utf8'))) {
        forbidden.push(path.relative(root, file))
      }
    }
  }
  assert.deepEqual(forbidden, [], `local-server prompt/lawinserver remains in: ${forbidden.join(', ')}`)
  assert.equal(/lawinserver\.exe/i.test(MAIN), false, 'main must never spawn the local server')
  assert.match(
    read('src/lib/onlinePolicy.ts'),
    /'reboot-official', 'reboot', 'echo'/,
    'the renderer must keep the same ban list',
  )
}

function testOnlineRoutes() {
  // Reboot is not an online route any more: every season keeps only its live
  // public provider (EZFN, Stellar, Retrac, or a Discord community), never the
  // embedded LawinServer launcher.
  const rebootSeasons = Object.values(builds.seasons).filter((value) =>
    routeIds(value).some((id) => isBannedProvider(id)),
  )
  assert.equal(rebootSeasons.length, 0, 'a season still routes through Reboot/LawinServer')

  // EZFN and Stellar both exchange a real one-time game code, so a stale
  // pre-auth handshake gate must never block their online launch again.
  for (const id of ['ezfn', 'stellar']) {
    const provider = providerCatalog().find((entry) => entry.id === id)
    assert.ok(provider, `${id} is missing from the catalog`)
    assert.notEqual(
      provider.launchHandshakePending,
      true,
      `${id} must not be gated before its exchange-code launch`,
    )
    assert.ok(['deeplink', 'embedded_web', 'oauth'].includes(provider.auth))
  }
  // Every online season downloads its real Fortnite season build inside
  // VAULTED. No launcher "owns" its builds and skips that archive any more.
  const retracCatalog = providerCatalog().find((entry) => entry.id === 'retrac-official')
  assert.equal('ownsBuild' in (retracCatalog?.runtime || {}), false)
  assert.ok(
    !read('electron/onlineProviders.cjs').includes('ownsBuild'),
    'the catalog must not expose an ownsBuild shortcut',
  )
  const app = read('src/App.tsx')
  assert.ok(!app.includes('ownsBuild'), 'Start must not consult an ownsBuild shortcut')
  assert.match(
    app,
    /if \(!installed\[build\.id\]\) \{\r?\n\s*if \(activeRuntime\?\.required && !activeRuntime\.installed\)/,
    'every online season must install its runtime and download its build first',
  )
  assert.match(
    app,
    /if \(automaticExternal && !installed\[build\.id\]\)/,
    'an auto-selected external launcher must wait for the season build',
  )
  // Data lock: every online card has a real archive or provider build to fetch,
  // so requiring that download can never strand an online season.
  const onlineSeasons = Object.values(
    JSON.parse(read('src/assets/builds.json')).seasons || {},
  ).filter((season) => season.onlineProvider || season.onlineProviders)
  assert.ok(onlineSeasons.length > 0, 'no online seasons were found')
  for (const season of onlineSeasons) {
    assert.ok(
      season.downloadUrl || season.providerBuild,
      `${season.id} is online but has no real build source to download`,
    )
  }
  assert.ok(
    !read('src/components/ActiveBuildCard.tsx').includes('ownsBuild'),
    'the card must always show the download step for a missing build',
  )

  const auth = read('electron/providerAuth.cjs')
  assert.match(auth, /config\.id === 'ezfn'/, 'EZFN lost its exchange-code handshake')
  assert.match(auth, /config\.id === 'stellar'/, 'Stellar lost its exchange-code handshake')

  // Every companion launcher is a background helper: it must never be shown,
  // focused or clicked with the real cursor. VAULTED hides it off-screen and
  // posts mouse messages straight to its Flutter view.
  const openAt = MAIN.indexOf('async function openProviderLauncherEntry(')
  const launchAt = MAIN.indexOf('async function launchOnlineProvider(', openAt)
  assert.ok(openAt > 0 && launchAt > openAt, 'the external launcher handoff is missing')
  const externalHandoff = MAIN.slice(openAt, launchAt)
  assert.match(
    externalHandoff,
    /registerProviderLauncher\(id, launch\.child\)\r?\n\s*startCompanionWindowHider\(id, launch\.child\.pid\)\r?\n\s*startCompanionSessionMonitor\(id, current\)/,
    'an external launcher must be hidden and closed after the game exits',
  )
  assert.match(MAIN, /function startCompanionWindowHider\(providerId, pid\)/)
  assert.match(MAIN, /state\.timer = setInterval\(hide, 1_000\)/)
  assert.match(MAIN, /stopCompanionWindowHider\(id\)/, 'Stop must stop the window hider')
  const companionAt = MAIN.indexOf('async function startCompanionLauncher(')
  assert.ok(companionAt > 0, 'the managed companion launcher start is missing')
  assert.match(
    MAIN.slice(companionAt, companionAt + 2200),
    /startHiddenWindowWatcher/,
    'a managed companion launcher must stay hidden',
  )

  // A launcher that dies on startup (half-uninstalled) must never be reported
  // as a running season: Start has to notice the early exit and repair the
  // install once through the provider's own setup.
  assert.match(MAIN, /const EXTERNAL_LAUNCH_STABILITY_MS = 4_000/)
  assert.match(MAIN, /function spawnExternalLauncher\(executable, args\)/)
  const handoff = MAIN.slice(
    MAIN.indexOf('async function openProviderLauncherEntry('),
    MAIN.indexOf('async function launchOnlineProvider(', MAIN.indexOf('async function openProviderLauncherEntry(')),
  )
  assert.equal(
    /child\.once\('spawn', \(\) => resolve\(true\)\)/.test(handoff),
    false,
    'an external launcher must be verified alive instead of assumed started',
  )
  assert.match(handoff, /startVisibleLauncher\(launcherCandidates, args, repairRuntime, launcherNames\)/)
  assert.match(
    handoff,
    /const launcherCandidates = installedExecutables\(runtimeMetadata\)/,
    'a broken leftover install must not hide the working one',
  )
  assert.match(handoff, /const already = await adoptRunning\(\)/)
  const spawnHelper = MAIN.slice(
    MAIN.indexOf('function spawnExternalLauncher('),
    MAIN.indexOf('async function openProviderLauncherEntry('),
  )
  assert.match(
    spawnHelper,
    /windowsHide: true/,
    'an external launcher must start hidden',
  )
  assert.match(spawnHelper, /void hideCompanionLauncher\(earlyPid\)/, 'the launcher window must be hidden on spawn')
  assert.match(spawnHelper, /setInterval\(\(\) => void hideCompanionLauncher\(earlyPid\), 400\)/, 'the launcher must stay hidden during its startup wait')
  const automation = read('electron/companionAutomation.cjs')
  assert.match(automation, /ShowWindow\(\$top, 0\)/, 'the launcher window must be hidden with SW_HIDE')
  assert.match(automation, /-20000, -20000/, 'the launcher window must be moved off every monitor')
  assert.match(automation, /GetClassName/, 'the automation must target the Flutter view')
  assert.match(automation, /FLUTTERVIEW/, 'mouse messages must go to FLUTTERVIEW')
  assert.match(automation, /PostMessage\(\$view, 0x0201/, 'Play must be a hidden message click')
  for (const banned of ['SetCursorPos', 'mouse_event', 'SetForegroundWindow', 'SetWindowPos($h, [IntPtr]::new(-1)']) {
    assert.equal(
      automation.includes(banned),
      false,
      `companion automation must not use visible input: ${banned}`,
    )
  }
  assert.match(read('electron/providerRuntime.cjs'), /\n  installedExecutables,\n/)
  assert.match(handoff, /alreadyRunning: true/)
  assert.match(handoff, /forceInstall: true/)
  assert.match(
    handoff,
    /closed immediately after it started/,
    'an early launcher exit must be reported to the player',
  )
  assert.match(read('electron/providerRuntime.cjs'), /options\.forceInstall !== true/)
  assert.match(
    read('src/App.tsx'),
    /setLaunchFailure\(\{ id: build\.id, message \}\)/,
    'a failed launcher handoff must surface on the card',
  )

  // Every DLL a launcher needs is staged inside that launcher's own download
  // step, so Play never prepares files at launch time.
  const providers = read('electron/onlineProviders.cjs')
  assert.match(providers, /async function stageProviderDlls\(options = \{\}\)/)
  assert.match(providers, /const STAGED_RUNTIME_DLLS = \['Tellurium\.dll', 'Cobalt\.dll', 'Memory\.dll'\]/)
  assert.match(providers, /\n  stageProviderDlls,\n/)
  const prepareHandler = MAIN.slice(
    MAIN.indexOf("ipcMain.handle('arc:provider-prepare'"),
    MAIN.indexOf("ipcMain.handle('arc:provider-builds'"),
  )
  assert.match(prepareHandler, /const staged = await stageSeasonLauncherDlls\(id\)/)
  assert.match(
    prepareHandler,
    /cached: true, dlls \}/,
    'prepare must report the DLLs it staged',
  )
  const installHandler = MAIN.slice(
    MAIN.indexOf("ipcMain.handle('arc:install-provider-runtime'"),
    MAIN.indexOf("ipcMain.handle('arc:provider-catalog'"),
  )
  assert.ok(
    installHandler.indexOf("phase: 'dlls'") < installHandler.indexOf('await ensureProviderRuntime('),
    'the launcher download must stage DLLs before the installer runs',
  )
  assert.match(
    installHandler,
    /const stagedAfter = await stageSeasonLauncherDlls\(id\)/,
    'a launcher may only be ready after its DLLs are verified',
  )
  assert.ok(
    installHandler.indexOf('stagedAfter') < installHandler.indexOf("phase: 'done'"),
    'the done event must follow the DLL verification',
  )
  assert.match(MAIN, /async function stageSeasonLauncherDlls\(providerId = ''\)/)
  assert.match(
    MAIN,
    /async function stageCoreRuntimeDlls\(\)/,
    'Cobalt lives in the shared providers runtime and must be staged too',
  )
  assert.match(MAIN, /await stageCoreRuntimeDlls\(\)/)
  assert.match(MAIN, /if \(report\.missing\.length > 0\) \{/)
  assert.match(
    read('src/components/ActiveBuildCard.tsx'),
    /Staging required DLLs \(Tellurium, Cobalt, Memory\)…/,
    'the launcher download card must show the DLL staging step',
  )

  // Hub rule: a local profile is never a season destination. EZFN Hybrid is a
  // lobby-only cosmetic tool, so its former seasons are Online Unavailable: the
  // archive stays known, but the card greys and locks Download/Play.
  const hybridCatalog = providerCatalog().find((entry) => entry.id === 'ezfn-hybrid')
  assert.equal(hybridCatalog?.mode, 'download', 'ezfn-hybrid must stay a local profile')
  assert.equal(hybridCatalog?.auth, 'none')
  const localOnlySeasons = [
    'ch5-s2',
    'ch5-s3',
    'ch5-s4',
    'ch5-remix',
    'ch6-s1',
    'ch6-s2',
    'ch6-s3',
    'ch6-s4',
    'ch6-mini1',
    'ch6-mini2',
    'ch7-s1',
    'ch7-s2',
    'ch7-s3',
    'ch7-s4',
    'ch7-mini1',
  ]
  for (const id of localOnlySeasons) {
    const value = season(id)
    assert.equal(value.onlineProvider, undefined, `${id} must not route to a local profile`)
    assert.equal(value.onlineProviders, undefined, `${id} must not route to a local profile`)
    assert.ok(value.downloadUrl, `${id} must keep its archive for a future real launcher`)
  }

  // No season may route through a local/download engine at all. Every route is
  // a real remote project: a live backend or an official launcher.
  for (const value of Object.values(builds.seasons)) {
    for (const id of routeIds(value)) {
      const provider = providerCatalog().find((entry) => entry.id === id)
      assert.ok(provider, `${value.id} routes to ${id}, which is not a bundled provider`)
      assert.notEqual(provider.mode, 'download', `${value.id} routes through the local ${id} profile`)
      assert.equal(provider.global, true, `${value.id} routes through a non-global ${id} profile`)
    }
  }

  // Hub availability: a verified launcher-backed season is playable (and its
  // download unlocks) even though its badge stays LAUNCHER rather than ONLINE.
  const appHub = read('src/App.tsx')
  const playModeSource = read('src/lib/playMode.ts')
  assert.match(playModeSource, /export function onlineIsPlayable\(/)
  assert.match(playModeSource, /onlineIsLive\(mode\) \|\|/)
  assert.match(
    playModeSource,
    /mode\.externalAvailable === true \|\|\r?\n\s*mode\.communityAvailable === true/,
    'a verified community route is playable too',
  )
  const card = read('src/components/ActiveBuildCard.tsx')
  assert.match(card, /onlineIsPlayable\(playMode\)/, 'a launcher-backed season must unlock its download')
  assert.match(
    appHub,
    /onlineIsPlayable\(playModes\[build\.id\]\)/,
    'Start must treat a real launcher route as a playable online season',
  )
  // Picking a launcher-backed season prepares that launcher automatically.
  assert.match(appHub, /const autoRuntimePrep = useRef<Set<string>>\(new Set\(\)\)/)
  assert.match(
    appHub,
    /autoRuntimePrep\.current\.add\(activeCompanionProviderId\)[\s\S]{0,80}void handleInstallRuntime\(\)/,
    'selecting a launcher-backed season must install its real launcher',
  )
  // Launcher downloads retry transient failures with the same headers.
  const runtimeSource = read('electron/providerRuntime.cjs')
  const downloadSource = read('electron/installerDownload.cjs')
  assert.match(runtimeSource, /require\('\.\/installerDownload\.cjs'\)/, 'launcher downloads use the resilient transport')
  assert.match(downloadSource, /const DOWNLOAD_ATTEMPTS = 8/)
  assert.match(downloadSource, /for \(let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt \+= 1\)/)
  assert.match(downloadSource, /'user-agent': USER_AGENT/, 'launcher downloads keep a browser identity header')
  assert.match(downloadSource, /headers\.range = `bytes=\$\{offset\}-/, 'launcher retries request only the missing bytes')
}

function testProviderIsolation() {
  const catalog = providerCatalog()
  const ids = catalog.map((provider) => provider.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate provider ids would merge two seasons')
  const managed = catalog.filter(
    (provider) => provider.mode !== 'external' && provider.auth && provider.auth !== 'none',
  )
  const backends = managed.map((provider) => provider.backendUrl).filter(Boolean)
  assert.equal(
    new Set(backends).size,
    backends.length,
    'two managed providers share one backend URL; their login paths would collide',
  )
  // Every managed provider keeps its own auth mode and no inherited value.
  for (const provider of managed) {
    assert.ok(
      ['oauth', 'deeplink', 'embedded_web'].includes(provider.auth),
      `${provider.id} lost a supported login mode`,
    )
  }
}

/**
 * Discord-only communities ship no launcher application. Their seasons must
 * launch through VAULTED's own direct path (redirect DLL + live public server)
 * instead of stopping on "has no launcher installed on this PC".
 */
function testDiscordOnlyDirectLaunch() {
  const catalog = providerCatalog()
  const directIds = [
    'arc',
    'crystal',
    'slurp',
    'ambient',
    'reef',
    'legacy-mp',
    'horizon',
    'sunset',
    'blue-og',
    'glow',
    'rewind-official',
    'origins-official',
    'omen-official',
    'vynx-official',
  ]
  for (const id of directIds) {
    const entry = catalog.find((provider) => provider.id === id)
    assert.ok(entry, `${id} is missing from the provider catalog`)
    assert.equal(entry.directLaunch, true, `${id} must launch directly instead of opening a launcher`)
    assert.equal(entry.mode, 'external', `${id} mode changed`)
    assert.ok(!entry.runtime, `${id} must not require a companion runtime`)
    assert.ok(entry.discordGate, `${id} lost its Discord gate`)
    const profile = providerProfile(id)
    assert.equal(profile.directLaunch, true, `${id} profile lost its direct-launch flag`)
  }
  // Launcher-backed and managed communities keep their existing route.
  for (const id of [
    'eon',
    'hydro',
    'interloop',
    'retrac-official',
    'era',
    'ezfn',
    'stellar',
  ]) {
    const entry = catalog.find((provider) => provider.id === id)
    assert.ok(entry, `${id} is missing from the provider catalog`)
    assert.notEqual(entry.directLaunch, true, `${id} must keep its existing launch route`)
  }

  const APP = read('src/App.tsx')
  assert.match(APP, /provider\.directLaunch !== true/, 'Auto must not hand a launcherless season to a launcher')
  assert.match(
    APP,
    /if \(provider\.directLaunch === true\) \{/,
    'the external branch must join a live server for these communities',
  )
  assert.match(APP, /globalTarget && globalTarget\.directLaunch !== true \? globalTarget : null/)
  assert.match(
    APP,
    /No live \$\{build\.season\.label\} server is online right now\./,
    'the failure for these seasons must be about live servers, not a launcher',
  )
  const guardAt = MAIN.indexOf('if (profile.directLaunch === true) {')
  assert.ok(guardAt > 0, 'main has no direct-launch guard')
  assert.doesNotMatch(
    MAIN.slice(guardAt, guardAt + 500),
    /install its launcher/,
    'the direct-launch guard must not ask the player to install a launcher',
  )

  // A verified, installed Discord-only season runs the ordinary VAULTED direct
  // path: the injector plus the redirect DLL selected for the build (Cobalt for
  // 4.10) and the live public server as its join target.
  assert.equal(season('ch1-s4').onlineProvider.id, 'arc')
  assert.ok(
    routeIds(season('ch1-s4')).includes('era-official'),
    'Era must stay attached to ch1-s4 as the season-gated launcher route',
  )
  assert.match(MAIN, /ipcMain\.handle\('arc:launch-build'/, 'the direct launch IPC is missing')
  assert.match(MAIN, /legacy \? legacyRedirectDllPath\(\) : path\.join\(runtimeRoot\(\), 'Tellurium\.dll'\)/)
  assert.match(APP, /await launchBuild\(/, 'the direct launch is not reachable from Play')
  assert.match(
    read('src/components/ActiveBuildCard.tsx'),
    /Ready — Start joins a live \$\{season\.label\} server\./,
    'the card still promises a launcher for these seasons',
  )
}

/**
 * The session stability layer: stale helpers are cleared before a launch, the
 * account token is rotated at launch and during the whole game session, and a
 * backend drop is logged with its exact close code.
 */
function testSessionStability() {
  assert.match(MAIN, /async function cleanupStaleSessionHelpers\(providerId = ''\)/)
  assert.match(
    MAIN,
    /if \(!\(await anyFortniteClientRunning\(\)\)\) \{\r?\n\s*for \(const pid of await processPidsByImage\(\['VaultedInjector\.exe'\]\)\)/,
    'a stale injector must only be cleaned while no client is running',
  )
  assert.match(
    MAIN,
    /if \(cleaned\.length > 0\) \{\r?\n\s*console\.log\(`\[VAULTED\] Pre-launch session cleanup/,
  )
  const providerLaunch = MAIN.slice(
    MAIN.indexOf('async function launchOnlineProvider('),
    MAIN.indexOf('function privateIpAddress('),
  )
  assert.match(
    providerLaunch,
    /attachCompanionGameProcess\(providerId, launched\.pid\)/,
    'the managed launch must bind the real client PID to the launcher monitor',
  )
  assert.match(
    providerLaunch,
    /await cleanupStaleSessionHelpers\(providerId\)/,
    'the managed launch must clear stale helpers first',
  )
  const directLaunchStart = MAIN.indexOf("ipcMain.handle('arc:launch-build'")
  const directLaunch = MAIN.slice(directLaunchStart, directLaunchStart + 1500)
  assert.match(
    directLaunch,
    /await cleanupStaleSessionHelpers\(\)/,
    'the direct launch path must clear stale helpers too',
  )

  // Token rotation at launch, plus one retry after a 401/expired exchange.
  assert.match(providerLaunch, /const refreshed = await providerAuth\.refreshSession\(providerId\)/)
  assert.match(providerLaunch, /const requestExchange = \(\) =>/)
  assert.match(providerLaunch, /const expiry = sessionExpiryCode\(error\)/)
  assert.match(
    providerLaunch,
    /await providerAuth\.refreshSession\(providerId\)\r?\n\s*exchange = await requestExchange\(\)/,
  )
  assert.match(MAIN, /function sessionExpiryCode\(error\) \{/)

  // In-session heartbeat: alive for the whole client, refreshed, logged, and
  // stopped when the client exits.
  assert.match(MAIN, /const SESSION_HEARTBEAT_MS = 4 \* 60_000/)
  assert.match(MAIN, /function startProviderSessionHeartbeat\(providerId, pid, label = ''\)/)
  const heartbeat = MAIN.slice(
    MAIN.indexOf('function startProviderSessionHeartbeat('),
    MAIN.indexOf('function stopProviderSessionHeartbeat('),
  )
  assert.match(heartbeat, /await providerAuth\.refreshSession\(id\)/)
  assert.match(heartbeat, /if \(!processAlive\(state\.pid\)\)/)
  assert.match(heartbeat, /send\('arc:provider-session-expired'/, 'an expired session must be reported')
  assert.match(heartbeat, /state\.timer = setInterval\(\(\) => void tick\(\), SESSION_HEARTBEAT_MS\)/)
  assert.match(providerLaunch, /startProviderSessionHeartbeat\(providerId, launched\.pid, profile\.label\)/)
  assert.match(
    providerLaunch,
    /attachCompanionGameProcess\(providerId, launched\.pid\)[\s\S]{0,700}startProviderSessionHeartbeat\(providerId, launched\.pid/,
  )
  assert.match(providerLaunch, /stopProviderSessionHeartbeat\(providerId, 'game process exited'\)/)

  // Exact WebSocket close codes are always logged.
  assert.match(
    read('electron/providerAuth.cjs'),
    /gateway socket closed: code=\$\{code \?\? 'none'\} reason=\$\{closeReason \|\| 'none'\}/,
  )

  // The renderer hears about an expired session instead of silently failing.
  assert.match(read('electron/preload.cjs'), /onProviderSessionExpired: \(callback\) =>/)
  assert.match(read('src/lib/launch.ts'), /export function subscribeProviderSessionExpired\(/)
  assert.match(read('src/App.tsx'), /subscribeProviderSessionExpired\(\(payload\) => \{/)
  assert.match(read('src/App.tsx'), /session expired`/)
}

function testAutoFixWiring() {
  const app = read('src/App.tsx')
  const main = read('electron/main.cjs')
  const topbar = read('src/components/TopBar.tsx')
  const view = read('src/components/AutoFixView.tsx')
  assert.match(main, /ipcMain\.handle\('arc:autofix-scan'/, 'Auto-Fix scan IPC is missing')
  assert.match(main, /ipcMain\.handle\('arc:autofix-repair'/, 'Auto-Fix repair IPC is missing')
  assert.match(main, /await ensureRuntimeInstalled\(\)/, 'Auto-Fix must restore runtime files')
  assert.match(main, /await stageSeasonLauncherDlls\(providerId\)/, 'Auto-Fix must stage DLLs')
  assert.match(main, /ensureProviderRuntime\(providerId, metadata,/, 'Auto-Fix must repair launchers')
  assert.match(app, /const preLaunchAutoFix = useCallback/, 'the pre-launch check is missing')
  assert.match(
    app,
    /if \(!\(await preLaunchAutoFix\(build\)\)\) return/,
    'Play must use the pre-launch Auto-Fix check',
  )
  assert.match(app, /<AutoFixView/, 'the Auto-Fix tab is not rendered')
  assert.match(app, /view === 'autofix'/, 'the Auto-Fix view state is missing')
  assert.match(topbar, /Auto-Fix<\/span>/, 'the top navigation lost Auto-Fix')
  assert.match(view, /Auto-Fix Everything/, 'Auto-Fix must offer one-click repair')
  assert.match(view, /Fix season/, 'Auto-Fix must repair a single season')
  // Local play stays removed: Auto-Fix only repairs real online seasons.
  assert.match(app, /onlineIsPlayable\(playModes\[build\.id\]\)/)
  assert.equal(/127\.0\.0\.1|localhost/i.test(view), false, 'Auto-Fix must not add a local route')
  const autoFix = require('../electron/autoFix.cjs')
  assert.equal(autoFix.isTempFile('build.7z.part'), true)
  assert.equal(autoFix.isTempFile('build.7z.part.json'), true, 'resume metadata is a temp file')
  assert.equal(autoFix.isTempFile('pakchunk0-WindowsClient.pak'), false)
  assert.equal(autoFix.isLockFile('Fortnite.lock'), true)
  assert.equal(autoFix.isLockFile('pakchunk0.sig'), false)
}

function testCardStates() {
  const playMode = read('src/lib/playMode.ts')
  assert.match(playMode, /ONLINE_UNAVAILABLE_LABEL = 'ONLINE UNAVAILABLE'/)
  assert.match(playMode, /availability === 'launcher'/)
  const card = read('src/components/ActiveBuildCard.tsx')
  assert.match(card, /onlineIsUnavailable/)

  // The library can be reduced to only seasons a player can enter right now,
  // including launcher-backed routes without a player-count sample.
  const rail = read('src/components/LibraryRail.tsx')
  assert.match(rail, /type LibraryFilter = 'all' \| 'online' \| 'installed' \| 'active'/)
  assert.match(rail, /builds\.filter\(\(build\) => onlineIsPlayable\(playModes\[build\.id\]\)\)/)
  assert.match(rail, /aria-label={`Online available \(\$\{onlineBuilds\.length\}\)`}/)
  assert.match(rail, /filter === 'online' && visibleBuilds\.length === 0/)
}

function testHestiaAddsChapter1Season2Route() {
  // Project Hestia hosts Chapter 1 Season 2 (1.11) from its own launcher. It is
  // an extra option next to SunSet, whose dedicated primary stays untouched.
  const builds = JSON.parse(read('src/assets/builds.json'))
  const season = builds.seasons['ch1-s2']
  assert.equal(season.version, '1.11')
  const ids = (season.onlineProviders || []).map((provider) => provider.id)
  assert.ok(ids.includes('hestia-official'), 'ch1-s2 must offer Project Hestia')
  assert.ok(ids.includes('sunset'), 'ch1-s2 must keep the SunSet community route')
  assert.equal(
    season.onlineProvider.id,
    'hestia-official',
    'the verified Hestia launcher is the playable Chapter 1 Season 2 route',
  )
  const providers = JSON.parse(read('resources/providers/provider.json')).providers
  const hestia = providers.find((provider) => provider.id === 'hestia-official')
  assert.ok(hestia, 'Project Hestia must be in the provider catalog')
  assert.equal(hestia.mode, 'external')
  assert.deepEqual(hestia.seasons, ['ch1-s2'])
  assert.equal(hestia.runtime.downloadUrl, 'https://ogfn.org/download')
  assert.ok(
    hestia.runtime.installedExecutables.includes('%LOCALAPPDATA%/Hestia/hestia-launcher.exe'),
    'the verified Hestia install path must be detected',
  )
}

function testInstallSeasonRequiresExplicitClick() {
  // A season is 6-30 GB: selecting a card, pressing Start or resuming a launch
  // must never start that download. Only the Install Season button may.
  const app = read('src/App.tsx')
  assert.match(
    app,
    /options\.explicit !== true && !installed\[build\.id\] && !downloads\[build\.id\]/,
    'the download request must require an explicit install',
  )
  assert.match(
    app,
    /const handleInstallSeason = useCallback\(\(\) => \{[\s\S]{0,200}requestDownload\(build, \{ explicit: true \}\)/,
    'Install Season must be the only explicit download entry point',
  )
  assert.match(app, /onInstallSeason=\{handleInstallSeason\}/)
  assert.equal(
    (app.match(/requestDownload\(build, \{ launchAfter: true \}\)/g) || []).length,
    0,
    'no launch path may start a season download',
  )
  assert.match(app, /Press Install Season to download/)
  assert.match(
    read('src/components/ActiveBuildCard.tsx'),
    /if \(onInstallSeason\) onInstallSeason\(\)/,
    'the Install Season button must call the explicit handler',
  )
}

async function testSeasonRotationGuard() {
  // Era hosts one Chapter 1 season at a time and publishes which one. The card
  // may only stay live while Era reports the season VAULTED shipped for it, so
  // a rotation must take the route offline instead of lying about Season 6.
  const era = providerCatalog().find((entry) => entry.id === 'era-official')
  assert.ok(era?.liveSeason, 'Era must declare its live-season guard')
  const reply = (season) => async () =>
    new Response(JSON.stringify({ data: { season: { number: season } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const live = await probeProviderStatus(era, { fetchImpl: reply(6) })
  assert.equal(live.online, true, 'Era on Season 6 must count as live')
  assert.equal(live.liveSeasonId, 'ch1-s6', 'Era must report the season it is hosting')
  const rotated = await probeProviderStatus(era, { fetchImpl: reply(7) })
  assert.equal(rotated.online, true, 'Era stays reachable after a rotation')
  assert.equal(rotated.liveSeasonId, 'ch1-s7', 'Era must follow the newly live season')
  const silent = await probeProviderStatus(era, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })
  assert.equal(silent.online, true, 'a backend that hides its season stays reachable')
  assert.equal(silent.liveSeasonId, undefined, 'an unknown season unlocks no card')

  // Only the reported season may follow the launcher; every other card keeps
  // its locked state even though the backend answered.
  const playMode = read('src/lib/playMode.ts')
  assert.match(playMode, /const liveSeasonId = backend\.live\.liveSeasonId/)
  assert.match(playMode, /if \(liveSeasonId && liveSeasonId !== seasonId\) continue/)
  assert.match(read('electron/providerStatus.cjs'), /liveSeasonId: liveSeason\.seasonId/)
  assert.match(
    read('src/App.tsx'),
    /live\?\.online === true && live\.liveSeasonId \? \[live\.liveSeasonId\]/,
    'the renderer must narrow a rotating project to the season it reports',
  )
  assert.match(
    read('src/components/ActiveBuildCard.tsx'),
    /missing: onlineUnavailableForPlay\s*\?/,
    'a locked season must not advertise an install step',
  )

  // A launcher-backed project without a JSON health endpoint still counts as
  // reachable when its official site answers: no public API is required.
  const noApi = { ...era, statusUrl: '', backendUrl: 'https://erafn.dev/' }
  const siteOnly = await probeProviderStatus(noApi, {
    fetchImpl: async () =>
      new Response('<html>Era</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  })
  assert.equal(siteOnly.online, true, 'a live launcher site is a reachability signal')
  const siteDown = await probeProviderStatus(noApi, {
    fetchImpl: async () => new Response('down', { status: 503 }),
  })
  assert.equal(siteDown.online, false, 'a failing site is never reported as live')
}

async function testDiscordOnlyNeverCountsOnline() {
  // The exact Ch1 S3 regression: SunSet is a live Discord community with no
  // public game-server endpoint and no companion launcher. Its invite must not
  // be fetched as a health endpoint and must never produce an online sample.
  let fetched = 0
  const sunset = providerCatalog().find((entry) => entry.id === 'sunset')
  assert.ok(sunset, 'SunSet must remain in the catalog for the unavailable card')
  const status = await probeProviderStatus(sunset, {
    fetchImpl: async () => {
      fetched += 1
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(fetched, 0, 'a Discord-only route must not be probed as a game server')
  assert.equal(status.online, false, 'a Discord invite is not a live game server')
  assert.match(status.reason || '', /Discord\/website gate/i)

  const playMode = read('src/lib/playMode.ts')
  assert.equal(
    /discordOnline|hasDiscord/.test(playMode),
    false,
    'a Discord gate must never synthesize an online play mode',
  )
  assert.match(
    playMode,
    /return Boolean\(mode\.online \|\| mode\.globalOnline \|\| mode\.externalAvailable\)/,
    'online availability must require a live backend or launcher-backed external route',
  )
  // Playability is wider than availability: a community catalog-verified by
  // hand is a real hosted route through the two-step launcher import, while
  // SunSet (unverified here) keeps its invite out of both flags.
  assert.match(
    playMode,
    /mode\.externalAvailable === true \|\|\r?\n\s*mode\.communityAvailable === true/,
    'a verified community may count as playable, nothing else',
  )
  assert.match(playMode, /communityVerified === true/, 'only a catalog-verified community unlocks')
  assert.doesNotMatch(
    playMode,
    /communityVerified:\s*true/,
    'the renderer must not hard-code a community as verified',
  )
  assert.equal(
    providerCatalog().find((entry) => entry.id === 'sunset')?.communityVerified,
    false,
    'an unverified community gate must keep ONLINE UNAVAILABLE',
  )
  assert.match(
    read('src/components/BuildList.tsx'),
    /discordGate && onlineIsPlayable\(playMode\)/,
    'the sidebar may only show ONLINE · DISCORD on a playable route',
  )
  const card = read('src/components/ActiveBuildCard.tsx')
  assert.match(
    card,
    /discordGate && onlineIsPlayable\(playMode\)/,
    'the hero may only show ONLINE · DISCORD on a playable route',
  )
  assert.match(
    read('src/App.tsx'),
    /provider\.live\?\.online === true/,
    'Auto may only download/launch a launcher with an explicit live sample',
  )

  // The full-library audit must always cover all 43 seasons, and offline mode
  // (deterministic CI) must classify every route as unavailable rather than
  // inventing a live server from a Discord gate.
  const audit = spawnSync(process.execPath, ['scripts/audit-seasons.cjs', '--offline', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(audit.status, 0, audit.stderr || audit.stdout)
  const report = JSON.parse(audit.stdout)
  assert.equal(report.expectedSeasons, 43)
  assert.equal(report.seasons.length, 43, 'the audit must sweep every bundled season')
  assert.equal(report.counts.LAUNCHER, 0, 'offline mode must not report a launcher as verified')
  assert.equal(report.counts.COMMUNITY, 4, 'only the four build-matched communities are playable')
  for (const id of ['ch4-s2', 'ch4-s4', 'ch3-s1', 'ch5-s1']) {
    assert.equal(
      report.seasons.find((row) => row.id === id)?.state,
      'COMMUNITY',
      `${id} must be reported as a verified community route`,
    )
  }
  // Real communities whose launcher runs a different build stay locked, even
  // though their route and Discord gate are configured.
  for (const id of ['ch1-s3', 'ch1-s4', 'ch2-s1']) {
    const row = report.seasons.find((entry) => entry.id === id)
    assert.equal(row?.state, 'UNAVAILABLE', `${id} must stay locked while its build mismatches`)
    assert.equal(row?.wired, false, `${id} must not report itself as wired while locked`)
  }
  for (const id of ['ch2-s6', 'ch3-s2']) {
    const row = report.seasons.find((entry) => entry.id === id)
    assert.equal(row?.state, 'UNAVAILABLE', `${id} has no verified community yet`)
    assert.equal(row?.wired, false)
  }
}

function testOnlineBadgeColors() {
  const card = read('src/components/ActiveBuildCard.tsx')
  const list = read('src/components/BuildList.tsx')
  const playMode = read('src/lib/playMode.ts')

  // An available LAUNCHER is a real online route, so its pill is green. The
  // hero pill colors from the label itself so it cannot drift from the text.
  assert.match(card, /if \(label === 'LAUNCHER'\) return 'up'/, 'hero LAUNCHER pill must be green')
  assert.match(
    card,
    /label\.startsWith\('ONLINE UNAVAILABLE'\)\) return 'down'/,
    'ONLINE UNAVAILABLE must stay red',
  )
  assert.match(
    card,
    /statusToneFor\(heroHealth, playMode, onlineStatus\)/,
    'the hero pill must derive its color from its label',
  )
  // The server dropdown pill follows the same rule.
  assert.match(card, /serverBadge === 'LAUNCHER'/, 'the dropdown LAUNCHER pill must be green')
  assert.match(card, /border-rose-400\/25 bg-rose-500\/\[0\.08\] text-rose-200\/80/)

  // The small sidebar card treats an available launcher as a live route and
  // keeps ONLINE UNAVAILABLE on the red class.
  assert.match(
    list,
    /const isLive =[\s\S]{0,260}playMode\.externalAvailable === true/,
    'sidebar LAUNCHER pill must be green',
  )
  assert.match(list, /onlineIsUnavailable\(playMode\)/)
  assert.match(list, /seasonStatusLabel\(playMode\)/)
  assert.match(playMode, /ONLINE_UNAVAILABLE_LABEL = 'ONLINE UNAVAILABLE'/)
}

/**
 * Launcher installers must never use the old fetch() body reader, which turns
 * a CDN reset into `TypeError: terminated`. The live download is exercised
 * against a local server that cuts the first response in half; the retry must
 * ask for the remaining bytes and the finished file must be a real MZ setup.
 */
async function testResilientLauncherDownloads() {
  const { downloadInstaller, validateInstaller } = require('../electron/installerDownload.cjs')
  const runtime = read('electron/providerRuntime.cjs')
  assert.equal(/getReader\(|downloadInstallerOnce|response\.body/.test(runtime), false, 'the launcher installer must not use a fetch body stream')
  assert.match(runtime, /require\('\.\/installerDownload\.cjs'\)/, 'providerRuntime must use the resilient downloader')
  assert.match(runtime, /await validateInstaller\(installer, metadata\)/, 'cached installers must be header-checked too')
  const transport = read('electron/installerDownload.cjs')
  assert.match(transport, /electron\.net\.request/, 'downloads must use Electron net.request')
  assert.match(transport, /new electron\.BrowserWindow/, 'downloads must have an off-screen BrowserWindow fallback')
  assert.match(transport, /headers\.range = `bytes=\$\{offset\}-/, 'downloads must send a byte Range when resuming')
  assert.match(transport, /function validateInstaller/, 'downloads must validate the installer header')
  assert.match(transport, /function probeTotalSize/, 'downloads must verify the host total before accepting a file')
  assert.match(transport, /if-range/, 'a resume must be tied to the host ETag/Last-Modified')
  assert.match(transport, /existingMeta/, 'a partial without matching identity must be discarded')
  assert.match(transport, /isMz/, 'EXE downloads must be checked for the MZ header')

  // Every active launcher URL is HTTPS, never loopback. Live reachability is
  // audited separately; this lock prevents a future local/plain-HTTP route.
  const catalog = JSON.parse(read('resources/providers/provider.json')).providers || []
  for (const provider of catalog) {
    for (const url of [provider.runtime?.downloadUrl, provider.runtime?.versionUrl]) {
      if (!url) continue
      const parsed = new URL(url)
      assert.equal(parsed.protocol, 'https:', `${provider.id} launcher URL is not HTTPS`)
      assert.equal(
        /^(?:127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname),
        false,
        `${provider.id} launcher URL points at loopback`,
      )
    }
  }

  const total = 180 * 1024
  const payload = Buffer.alloc(total, 0x41)
  payload[0] = 0x4d
  payload[1] = 0x5a
  let requests = 0
  const ranges = []
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': total, 'content-type': 'application/octet-stream' })
      res.end()
      return
    }
    requests += 1
    const range = String(req.headers.range || '')
    ranges.push(range)
    const match = /^bytes=(\d+)-/.exec(range)
    const start = match ? Number(match[1]) : 0
    if (requests === 1) {
      // Echo-style first answer: no Content-Length, then the connection drops.
      // The independent probe total is what makes this short read detectable.
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write(payload.subarray(0, 70 * 1024))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.writeHead(206, {
      'content-length': total - start,
      'content-range': `bytes ${start}-${total - 1}/${total}`,
      'content-type': 'application/octet-stream',
    })
    res.end(payload.subarray(start))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-launcher-download-'))
  const target = path.join(dir, 'EchoLauncher-Setup.exe')
  try {
    const result = await downloadInstaller(
      { url: `http://127.0.0.1:${server.address().port}/download` },
      { kind: 'exe' },
      { target },
    )
    assert.ok(requests >= 2, 'a terminated stream must be retried')
    assert.match(ranges[0] || '', /^bytes=0-\d+$/, 'the first request must use a bounded Range')
    assert.match(ranges[1] || '', /^bytes=[1-9]\d*-\d+$/, 'the retry must resume at the received byte offset')
    assert.equal(result.size, total)
    assert.deepEqual(fs.readFileSync(target), payload, 'the resumed download must contain every byte')
    assert.equal(fs.existsSync(`${target}.part`), false, 'the partial file must be cleaned up')

    const bad = path.join(dir, 'not-an-installer.exe')
    fs.writeFileSync(bad, Buffer.alloc(70 * 1024, 0x41))
    await assert.rejects(() => validateInstaller(bad, { kind: 'exe' }), /not a valid Windows installer/i)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function testRebootAutoLaunch() {
  const existing = { name: 'My own build', gameVersion: '7.30', location: 'D:\\games\\other' }
  const storage = {
    versions: JSON.stringify([existing]),
    version: existing.name,
    username: 'Tommy',
    password: '',
    custom_launch_args: '-epicapp=Fortnite',
  }
  const build = {
    name: 'Chapter 1 Season 6',
    gameVersion: '6.21',
    location: path.join('C:\\Users\\tommy\\AppData\\Roaming\\VAULTED Launcher\\builds\\ch1-s6'),
  }
  const merged = mergeSavedBuild(storage, build)
  const versions = JSON.parse(merged.storage.versions)
  assert.equal(versions.length, 2, 'the player\'s saved build must be kept')
  assert.equal(versions[0].name, existing.name)
  assert.equal(versions[1].name, build.name)
  assert.equal(versions[1].gameVersion, '6.21')
  assert.equal(merged.storage.version, build.name, 'the VAULTED build must be selected')
  assert.equal(merged.storage.username, 'Tommy')
  assert.equal(merged.storage.custom_launch_args, '-epicapp=Fortnite')

  const again = mergeSavedBuild(merged.storage, build)
  assert.equal(JSON.parse(again.storage.versions).length, 2, 're-wiring must not duplicate the build')
  const renamed = mergeSavedBuild(merged.storage, { ...build, name: 'C1S6' })
  assert.equal(JSON.parse(renamed.storage.versions).length, 2, 'same folder updates in place')
  assert.equal(renamed.storage.version, 'C1S6')

  // A corrupt storage file must not discard the player's name/args.
  const recovered = mergeSavedBuild({ versions: 'not json', username: 'Tommy' }, build)
  assert.equal(JSON.parse(recovered.storage.versions).length, 1)
  assert.equal(recovered.storage.username, 'Tommy')

  // Main wires the build before spawning the launcher, then clicks its own
  // Play action and reports the real client PID (never the launcher PID).
  assert.match(MAIN, /writeSavedBuild\(\{/, 'the launcher config must be written before start')
  assert.match(MAIN, /beginCompanionGameWatch/, 'main must watch for the real game process')
  assert.match(MAIN, /clickCompanionPlayButton/, 'main must trigger the launcher Play action')
  assert.match(MAIN, /arc:companion-game-started/)
  assert.match(MAIN, /arc:companion-game-timeout/)
  assert.match(read('electron/preload.cjs'), /arc:companion-game-started/)

  const app = read('src/App.tsx')
  assert.match(app, /Starting launcher & Fortnite…/, 'the waiting status must be shown')
  assert.match(app, /result\.waitingForGame === true/)
  assert.match(app, /subscribeCompanionGameStarted/)
  assert.match(app, /subscribeCompanionGameTimeout/)
  // Only the observed-process event may flip the card to Running: the waiting
  // branch returns before the immediate `running` assignment.
  const waitingStart = app.indexOf('result.waitingForGame === true')
  assert.ok(waitingStart > 0)
  const waitingLaunching = app.indexOf("setPhase('launching')", waitingStart)
  const waitingReturn = app.indexOf('return true', waitingStart)
  const waitingRunning = app.indexOf("setPhase('running')", waitingStart)
  assert.ok(
    waitingLaunching > waitingStart && waitingLaunching < waitingReturn,
    'the launcher wait must stay on the launching phase',
  )
  assert.ok(
    waitingRunning > waitingReturn,
    'running must only be set after the game-start event',
  )
}

/**
 * The discord-gated communities stay playable only through the two-step
 * import: their invite is Step 1, their own launcher is Step 2, and the file
 * the player brings back is scanned before it can unlock anything.
 */
function testCommunityLauncherUnlock() {
  const launcher = read('electron/communityLauncher.cjs')
  assert.match(launcher, /assertInstallerSafe\(target/, 'community launchers must pass the SFX gate')
  assert.match(launcher, /scanWithDefender/, 'community launchers must be scanned by Defender')
  assert.match(launcher, /LOCAL_HOST/, 'a loopback backend must be detected')
  assert.match(launcher, /BACKEND_CONTEXT/, 'a loopback backend must be detected in configs')
  assert.match(launcher, /kind === 'msi'/, 'MSI launchers must install through msiexec')
  assert.match(launcher, /community-launchers\.json/)

  assert.match(
    MAIN,
    /arc:community-launcher-import/,
    'main must expose the community launcher import',
  )
  assert.match(MAIN, /startImportedCommunityLauncher/, 'the imported launcher must have a start path')
  assert.match(MAIN, /hidden: true/, 'an imported community launcher runs hidden')
  assert.match(
    launcher,
    /stagePortableLauncher/,
    'a portable .exe is copied into the provider folder, never run as a setup',
  )
  assert.match(
    launcher,
    /fs\.cpSync\(sourceDirectory, folder/,
    'a portable launcher keeps the folder and files it ships with',
  )
  assert.match(
    launcher,
    /copyPortableCompanions/,
    'a launcher dropped in Downloads still brings its DLLs and data',
  )
  assert.match(
    launcher,
    /inspectExecutableForLocalBackend/,
    'a portable .exe image is checked for a bundled local backend',
  )
  assert.match(
    MAIN,
    /path\.join\(base, 'VAULTED', 'community-launchers'\)/,
    'imports live under %LOCALAPPDATA%\\VAULTED\\community-launchers',
  )
  assert.match(
    MAIN,
    /startCompanionLauncher\(providerId, \{ folder \}\)/,
    'Start hands the imported launcher the installed season folder',
  )
  assert.match(
    MAIN,
    /startImportedCommunityLauncher\(id, launchOptions\)/,
    'Play opens the imported launcher for a community season',
  )
  assert.doesNotMatch(
    MAIN,
    /community-launcher-import[\s\S]{0,400}shell:\s*true/,
    'an imported community launcher must never run through a shell',
  )

  const modal = read('src/components/DiscordGateModal.tsx')
  assert.match(modal, /Step 1 — Join Discord & Download Their Launcher/)
  assert.match(modal, /CommunityLauncherPanel/)
  const panel = read('src/components/CommunityLauncherPanel.tsx')
  assert.match(panel, /Step 2 — Select \/ Drop Downloaded Launcher/)
  assert.match(panel, /importCommunityLauncherFile/)

  const app = read('src/App.tsx')
  assert.match(
    app,
    /communityProvider\?\.directLaunch === true &&/,
    'Play must unlock a Discord season once its launcher is verified',
  )
  assert.match(app, /const communityUnlocked = Boolean\(/, 'the unlock must stay explicit')

  // The safety gate itself is untouched by this feature.
  const safety = read('electron/installerSafety.cjs')
  assert.ok(safety.includes('Add-MpPreference'), 'the Defender-tampering block must stay')
  assert.ok(safety.includes('assertInstallerSafe'), 'the shared installer gate must stay exported')
  assert.match(
    read('src/lib/onlinePolicy.ts'),
    /'reboot-official', 'reboot', 'echo'/,
    'the renderer ban list must not change',
  )
}

async function run() {
  try {
    testCommunityLauncherUnlock()
    testLifecycleRule()
  testLauncherOutlivesBootstrapper()
  testLaunchWiring()
  testWorkingSeasons()
  testResearchedLaunchersStayUnwired()
  testLawinServerBan()
  testOnlineRoutes()
  testDiscordOnlyDirectLaunch()
  testSessionStability()
  testProviderIsolation()
  testCardStates()
  testHestiaAddsChapter1Season2Route()
  testInstallSeasonRequiresExplicitClick()
  await testSeasonRotationGuard()
  await testDiscordOnlyNeverCountsOnline()
  testOnlineBadgeColors()
      testAutoFixWiring()
    testRebootAutoLaunch()
    await testResilientLauncherDownloads()
  console.log(
    'season regressions passed: launcher lifecycle (start-before-game, alive for the session, survives bootstrapper exit and single missed polls, close only after the client really exits/Stop), fully hidden companion launchers (off-screen SW_HIDE windows, Flutter message clicks, zero cursor/foreground input), a complete local-server ban (no lawinserver executable or local-server prompt in runtime code, Reboot removed from every season route and every launch entry point), no Reboot-only season presented as online, 12.41 Stellar/EZFN, 14.60 Retrac, Discord gates, unavailable seasons, per-provider isolation, hub routing (launcher-backed seasons unlock Download/Start, no season routes through a local profile, real launcher auto-installs on selection, launcher downloads retry), the session stability layer (pre-launch helper cleanup, launch-time token rotation with a one-shot 401 retry, in-game heartbeat, and WebSocket close-code logging), the Auto-Fix tab (scan/repair IPC, runtime and DLL staging, launcher repair, pre-launch health check, no local route), and online badge colors (LAUNCHER green on the hero, sidebar and dropdown pills; ONLINE UNAVAILABLE red)',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
  }
}

void run()
