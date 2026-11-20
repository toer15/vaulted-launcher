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
const { shouldCloseCompanionLauncher } = require('../electron/companionLifecycle.cjs')
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
    /const \{ shouldCloseCompanionLauncher \} = require\('\.\/companionLifecycle\.cjs'\)/,
    'main must use the shared lifecycle rule',
  )
  assert.match(
    MAIN,
    /shouldCloseCompanionLauncher\(\{ gameRunning, sawGame: state\.sawGame \}\)/,
    'the launcher monitor must ask the shared rule',
  )

  const startAt = MAIN.indexOf('await startCompanionLauncher(providerId)')
  const launchAt = MAIN.indexOf('await launchInjectedGame(launchPayload')
  assert.ok(startAt > 0, 'the managed launch must start the companion launcher')
  assert.ok(launchAt > 0, 'the managed launch must inject the client')
  assert.ok(startAt < launchAt, 'the companion launcher must start before Fortnite')

  assert.match(
    MAIN,
    /markProviderLauncherGameStarted\(providerId\)/,
    'the client start must arm the after-exit close',
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
    /shouldCloseCompanionLauncher\(\{ gameRunning, sawGame: state\.sawGame \}\)/,
    'the session monitor must ask the shared rule',
  )
  assert.match(monitorBody, /\}, 5000\)/, 'the session monitor must keep polling the game')
  assert.match(
    monitorBody,
    /closeCompanionLauncherForProvider\(id\)/,
    'the session monitor must close the whole launcher tree',
  )
  assert.equal(
    /\bchild\b/.test(monitorBody),
    false,
    'the session monitor must not depend on the spawned child (single-instance launchers exit early)',
  )
}

function testWorkingSeasons() {
  // Era keeps the 6.21 managed route and Tellurium.
  const era = season('ch1-s6')
  assert.equal(era.version, '6.21')
  assert.equal(era.onlineProvider?.id, 'era')
  assert.equal(providerProfile('era').auth, 'oauth')
  assert.match(providerRuntime(providerProfile('era')).dll, /Tellurium\.dll$/)
  assert.ok(providerRuntimeMetadata('era'), 'Era must keep its launcher metadata')

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
  // A launcher that installs its own season builds must not be gated behind a
  // VAULTED archive download; Retrac's manifest-driven launcher still is.
  assert.equal(rebootOfficial.runtime?.ownsBuild, true)
  const retracCatalog = providerCatalog().find((entry) => entry.id === 'retrac-official')
  assert.equal(retracCatalog?.runtime?.ownsBuild, false)
  const app = read('src/App.tsx')
  assert.match(
    app,
    /activeRuntime\.ownsBuild !== true/,
    'Start must skip the local download gate for a launcher that owns its builds',
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

function testCardStates() {
  const playMode = read('src/lib/playMode.ts')
  assert.match(playMode, /ONLINE_UNAVAILABLE_LABEL = 'ONLINE UNAVAILABLE'/)
  assert.match(playMode, /availability === 'launcher'/)
  const card = read('src/components/ActiveBuildCard.tsx')
  assert.match(card, /onlineIsUnavailable/)
}

try {
  testLifecycleRule()
  testLaunchWiring()
  testWorkingSeasons()
  testOnlineRoutes()
  testProviderIsolation()
  testCardStates()
  console.log(
    'season regressions passed: launcher lifecycle (start-before-game, alive for the session, close on game exit/Stop), visible external launchers, Project Reboot online routing, 6.21 Era, 12.41 Stellar/EZFN, 14.60 Retrac, Discord gates, unavailable seasons, and per-provider isolation',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
