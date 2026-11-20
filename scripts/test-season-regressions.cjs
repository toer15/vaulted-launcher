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
const path = require('node:path')

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
const {
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

  const startAt = MAIN.indexOf('await startCompanionLauncher(providerId)')
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
  // Chapter 1 Season 6 runs on Project Reboot's online launcher. Era's own
  // binary closed itself mid-session on 6.21, which broke skin saving and
  // matchmaking, so this season never routes through Era again.
  const ch1s6 = season('ch1-s6')
  assert.equal(ch1s6.version, '6.21')
  assert.equal(ch1s6.onlineProvider?.id, 'reboot-official')
  assert.deepEqual(
    [...new Set(routeIds(ch1s6))],
    ['reboot-official'],
    'ch1-s6 must only route to Project Reboot',
  )
  assert.equal(ch1s6.providerBuild, undefined, "ch1-s6 must not keep Era's live build id")
  assert.ok(ch1s6.downloadUrl, 'ch1-s6 must keep its real 6.21 season build download')
  assert.equal(ch1s6.runtimeProfile, 'legacy')
  const rebootOnline = providerCatalog().find((entry) => entry.id === 'reboot-official')
  assert.equal(rebootOnline?.mode, 'external', 'Project Reboot is the online launcher route')
  assert.ok(
    rebootOnline.supportedSeasons.includes('ch1-s6'),
    'reboot-official must advertise ch1-s6',
  )
  assert.match(
    providerRuntimeMetadata('reboot-official')?.label || '',
    /Reboot Launcher/,
    'the Season 6 companion launcher must stay installable',
  )
  // Real online multiplayer only: the replacement route is never loopback.
  const rebootProfile = providerProfile('reboot-official')
  assert.match(rebootProfile.backendUrl, /^https:\/\//, 'the Season 6 route must be online')
  assert.equal(
    /127\.0\.0\.1|localhost|\[::1\]|\b10\.\d+\.\d+\.\d+/.test(rebootProfile.backendUrl),
    false,
    'the Season 6 route must never be a local/loopback backend',
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
    echo: 'ch1-s3',
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

  // Unavailable seasons stay unavailable instead of gaining a local route.
  for (const id of ['ch1-s7', 'ch1-s10']) {
    const value = season(id)
    assert.equal(value.onlineProvider, undefined, `${id} must stay unavailable`)
    assert.equal(value.onlineProviders, undefined, `${id} must stay unavailable`)
  }

  // No season may route through the removed Neo/Neonite provider.
  for (const value of Object.values(builds.seasons)) {
    assert.equal(routeIds(value).some((id) => /^neo/i.test(id)), false, `${value.id} routes through Neo`)
  }

  // 4.x builds predate Tellurium's hooks and stay on Cobalt.
  assert.equal(providerUsesLegacyRedirect('4.10', 'ch1-s4'), false)
  assert.match(providerRuntime(providerProfile('reboot'), { legacy: true }).dll, /Cobalt\.dll$/)
}

function testOnlineRoutes() {
  // Every season that has a Project Reboot build must also be routable to
  // Project Reboot's real online launcher. A local-only `reboot` profile can
  // never put a player in a match, so it must not be the primary route.
  const rebootSeasons = Object.values(builds.seasons).filter((value) =>
    routeIds(value).includes('reboot-official'),
  )
  assert.ok(rebootSeasons.length >= 20, 'the Project Reboot seasons disappeared')
  const rebootOfficial = providerCatalog().find((entry) => entry.id === 'reboot-official')
  assert.equal(rebootOfficial?.mode, 'external', 'reboot-official must stay an online launcher route')
  assert.equal(rebootOfficial?.external, true)
  assert.match(
    providerRuntimeMetadata('reboot-official')?.label || '',
    /Reboot Launcher/,
    'the Project Reboot launcher runtime must stay installable',
  )
  for (const value of rebootSeasons) {
    assert.equal(
      value.onlineProvider?.id,
      'reboot-official',
      `${value.id} must route Play to Project Reboot's online launcher`,
    )
    assert.ok(
      rebootOfficial.supportedSeasons.includes(value.id),
      `reboot-official no longer advertises ${value.id}`,
    )
    // The local profile stays bundled as the repair source for its DLLs, but it
    // must never be offered as the Play route for a season.
    assert.equal(
      routeIds(value).includes('reboot'),
      false,
      `${value.id} must not offer the local-only reboot profile as a route`,
    )
    assert.equal(providerProfile('reboot').mode, 'download')
  }

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
  assert.equal('ownsBuild' in (rebootOfficial.runtime || {}), false)
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

  // An external project's launcher is the player's game entry, so VAULTED must
  // open it visibly. Only a managed background companion is hidden.
  const openAt = MAIN.indexOf('async function openProviderLauncherEntry(')
  const launchAt = MAIN.indexOf('async function launchOnlineProvider(', openAt)
  assert.ok(openAt > 0 && launchAt > openAt, 'the external launcher handoff is missing')
  const externalHandoff = MAIN.slice(openAt, launchAt)
  assert.equal(
    /startHiddenWindowWatcher/.test(externalHandoff),
    false,
    'an external launcher must not be hidden; the player needs its window to start the game',
  )
  assert.match(
    externalHandoff,
    /registerProviderLauncher\(id, launch\.child\); startCompanionSessionMonitor\(id, current\)/,
    'an external launcher must still be tracked and closed after the game exits',
  )
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
    /windowsHide: false/,
    'an external launcher window must not be started hidden',
  )
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

  // EZFN Hybrid is a lobby-only cosmetic tool, not a match server. Seasons that
  // only have that profile must keep saying online is unavailable instead of
  // pretending a local profile is multiplayer.
  const hybrid = season('ch5-s1')
  assert.equal(hybrid.onlineProvider?.id, 'ezfn-hybrid')
  const hybridCatalog = providerCatalog().find((entry) => entry.id === 'ezfn-hybrid')
  assert.equal(hybridCatalog?.mode, 'download', 'ezfn-hybrid must stay a local profile')
  assert.equal(hybridCatalog?.auth, 'none')
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
    'echo',
    'retrac-official',
    'reboot-official',
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

function testCardStates() {
  const playMode = read('src/lib/playMode.ts')
  assert.match(playMode, /ONLINE_UNAVAILABLE_LABEL = 'ONLINE UNAVAILABLE'/)
  assert.match(playMode, /availability === 'launcher'/)
  const card = read('src/components/ActiveBuildCard.tsx')
  assert.match(card, /onlineIsUnavailable/)
}

try {
  testLifecycleRule()
  testLauncherOutlivesBootstrapper()
  testLaunchWiring()
  testWorkingSeasons()
  testOnlineRoutes()
  testDiscordOnlyDirectLaunch()
  testSessionStability()
  testProviderIsolation()
  testCardStates()
  console.log(
    'season regressions passed: launcher lifecycle (start-before-game, alive for the session, survives bootstrapper exit and single missed polls, close only after the client really exits/Stop), visible external launchers, Project Reboot online routing, Chapter 1 Season 6 on Project Reboot (no Era, no loopback), 12.41 Stellar/EZFN, 14.60 Retrac, Discord gates, unavailable seasons, and per-provider isolation, plus the session stability layer (pre-launch helper cleanup, launch-time token rotation with a one-shot 401 retry, in-game heartbeat, and WebSocket close-code logging)',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
