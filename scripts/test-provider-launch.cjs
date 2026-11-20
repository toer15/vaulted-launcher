#!/usr/bin/env node
'use strict'

/**
 * Offline Stellar launch tests.
 *
 * No Discord session, Electron window, network, or game install is used:
 * - providerAuth receives a fake encrypted token store and fake fetch
 * - the launch-argument builder is the same pure module used by main.cjs
 * - structured diagnostics are captured through the production sink hook
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  LEGACY_CALDERA,
  LOCAL_AUTH_DOMAIN,
  LOCAL_AUTH_PASSWORD,
  PROVIDER_FLTOKEN,
  localAuthLogin,
  providerFortniteArgs,
  providerLaunchDiagnostic,
} = require('../electron/providerLaunchArgs.cjs')
const { createProviderAuth, retracCodeFromMessage } = require('../electron/providerAuth.cjs')
const {
  providerCatalog,
  providerProfile,
  providerRuntime,
  providerRuntimeMetadata,
  providerUsesLegacyRedirect,
} = require('../electron/onlineProviders.cjs')
const { launchArguments } = require('../electron/providerRuntime.cjs')
const seasonManifest = require('../src/assets/builds.json').seasons

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-provider-launch-'))
const tokenFile = path.join(temporaryRoot, 'provider-auth.bin')
const accessToken = 'stellar-access-token-that-must-not-leak'
const exchangeCode = 'stellar-exchange-code-123'
const backendUrl = 'http://127.0.0.1:3551/'

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(String(value), 'utf8'),
  decryptString: (value) => Buffer.from(value).toString('utf8'),
}

function writeTokenStore() {
  fs.writeFileSync(
    tokenFile,
    fakeSafeStorage.encryptString(
      JSON.stringify({
        stellar: {
          access_token: accessToken,
          refresh_token: null,
          expires_at: null,
          display_name: 'Test player',
        },
      }),
    ),
  )
}

function createAuth({ fetchImpl, diagnostics, requestTimeoutMs = 20_000 } = {}) {
  return createProviderAuth({
    app: {
      getVersion: () => '1.0.0-test',
      getPath: () => temporaryRoot,
    },
    safeStorage: fakeSafeStorage,
    BrowserWindow: function FakeBrowserWindow() {},
    WebContentsView: function FakeWebContentsView() {},
    getParentWindow: () => null,
    listProviders: () => providerCatalog(),
    profileForId: (id) => providerProfile(id),
    fetchImpl,
    requestTimeoutMs,
    diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
  })
}

function jsonResponse(status, body, raw = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { 'content-type': 'application/json' },
    text: async () => (raw === null ? JSON.stringify(body) : raw),
  }
}

function testLiveProviderMappings() {
  // A season with a real hosted backend must never silently default to a
  // a lobby-only local backend. The hosted providers serve the
  // seasons mapped to them; local providers are only for unmapped seasons.
  const liveProviders = new Set(['era', 'stellar', 'ezfn'])
  const catalogById = new Map(providerCatalog().map((provider) => [provider.id, provider]))
  for (const [seasonId, season] of Object.entries(seasonManifest)) {
    const providers = season.onlineProviders ?? (season.onlineProvider ? [season.onlineProvider] : [])
    const live = providers.filter((provider) => liveProviders.has(provider.id))
    if (live.length === 0) continue
    assert.equal(
      season.onlineProvider?.id,
      live[0].id,
      `${seasonId} must default to its live provider ${live[0].id}`,
    )
    const localFallback = providers.filter((provider) => {
      const entry = catalogById.get(provider.id)
      return entry?.mode === 'download' && entry?.auth === 'none'
    })
    assert.deepEqual(
      localFallback,
      [],
      `${seasonId} must not offer a local fallback beside a live provider`,
    )
  }
  // Chapter 2 Season 4 is one clean 14.60 card that hands off to Retrac's
  // signed launcher, instead of the old archived 14.50 duplicate.
  assert.equal(seasonManifest['ch2-s4']?.title, 'Chapter 2 Season 4')
  assert.equal(seasonManifest['ch2-s4']?.buildVersion, '14.60')
  assert.equal(seasonManifest['ch2-s4']?.defaultInstallDir, '{AppDefaultBuildsDir}\\ch2-s4-1460')
  assert.equal(seasonManifest['ch2-s4']?.onlineProvider?.id, 'retrac-official')
  assert.equal(seasonManifest['ch2-s4']?.archived, undefined)
  assert.equal(seasonManifest['ch2-s4-1460'], undefined)
  assert.equal(
    seasonManifest['ch2-s2']?.onlineProviders?.some((provider) => provider.id === 'slurp'),
    true,
  )
  assert.equal(
    seasonManifest['ch2-s7']?.onlineProviders?.some((provider) => provider.id === 'eon'),
    true,
  )
  assert.equal(
    seasonManifest['ch2-s7']?.onlineProviders?.some((provider) => provider.id === 'fortmp'),
    false,
  )
  assert.equal(
    seasonManifest['ch2-s1']?.onlineProviders?.some((provider) => provider.id === 'ambient'),
    true,
  )
  const official = providerCatalog().find((provider) => provider.id === 'retrac-official')
  assert.equal(official?.mode, 'external')
  assert.equal(official?.auth, 'none')
  assert.equal(official?.launchKind, 'official')
  assert.equal(official?.statusUrl, 'https://retrac.site/api/status')
  assert.deepEqual(official?.supportedSeasons, ['ch2-s4'])
  assert.equal(official?.discordGate?.statusOnly, true)
  assert.equal(official?.discordGate?.inviteUrl, 'https://discord.gg/retrac')
  for (const id of ['slurp', 'ambient', 'reef', 'legacy-mp', 'horizon', 'sunset', 'blue-og', 'glow']) {
    const provider = providerCatalog().find((entry) => entry.id === id)
    assert.equal(provider?.mode, 'external', `${id} must stay an external community route`)
    assert.equal(provider?.auth, 'none', `${id} must not fake a VAULTED account login`)
    assert.equal(Boolean(provider?.launchUrl), true, `${id} needs a documented launch URL`)
    const profile = providerProfile(id)
    assert.equal(profile.external, true, `${id} profile must expose the external flag`)
    assert.equal(profile.mode, 'external', `${id} profile must keep the external mode`)
    assert.match(profile.launchUrl, /^https:\/\//, `${id} profile must expose its sanitized launch URL`)
  }
  // Dead routes are removed rather than kept as plausible-looking links.
  for (const id of ['fortmp', 'havoc', 'natrex']) {
    assert.equal(providerCatalog().some((entry) => entry.id === id), false, `${id} must be removed`)
    assert.equal(
      Object.values(seasonManifest).some((season) =>
        [...(season.onlineProvider ? [season.onlineProvider] : []), ...(season.onlineProviders || [])].some(
          (provider) => provider.id === id,
        ),
      ),
      false,
      `${id} must not remain in a season mapping`,
    )
  }
  const runtime = providerRuntimeMetadata('retrac-official')
  assert.equal(runtime?.kind, 'msi')
  assert.equal(runtime?.label, 'Retrac Launcher')
  assert.equal(runtime?.versionUrl, 'https://launcher-service-prod.retr.ac/version/0.0.0')
  assert.deepEqual(runtime?.downloadHosts, ['cdn.retrac.site'])
  assert.equal(runtime?.signerSubject, 'Lezah Limited')
  assert.deepEqual(launchArguments(runtime, '14.60'), [
    '-action_after=launch_build:++Fortnite+Release-14.60-CL-14786821-Windows',
  ])
  assert.equal(providerRuntimeMetadata('slurp'), null)
  // Retrac is driven by its own build manifest flag, so the 14.60 archive must
  // still be downloaded before its launcher can be handed the folder. Every
  // runtime is metadata only now: no launcher owns its season build.
  assert.deepEqual(official?.runtime, {
    required: true,
    label: 'Retrac Launcher',
  })
  // v1.x-v3.x predate the Curl signatures Tellurium waits for. They must
  // select Cobalt while every modern build keeps Tellurium.
  assert.equal(providerUsesLegacyRedirect('3.0', 'ch1-s3'), true)
  assert.equal(providerUsesLegacyRedirect('', 'ch1-s2'), true)
  assert.equal(providerUsesLegacyRedirect('4.10', 'ch1-s4'), false)
  assert.equal(providerUsesLegacyRedirect('14.60', 'ch2-s4'), false)
  assert.match(providerRuntime(providerProfile('reboot'), { legacy: true }).dll, /Cobalt\.dll$/)
  assert.match(providerRuntime(providerProfile('reboot')).dll, /Tellurium\.dll$/)
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'providerAuth.cjs'), 'utf8')
  assert.match(authSource, /authorisation_code/)
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'discordGates.ts'), 'utf8'),
    /!gate\.statusOnly/,
    'a status-only Discord badge must never gate Play',
  )
  assert.match(authSource, /anticheat_token/)
  assert.match(
    authSource,
    /RETRAC_LAUNCHER_SOCKET = 'wss:\/\/launcher-service-prod\.retr\.ac\/websocket\/launcher'/,
  )
}

function testRetracCodeReply() {
  const current = retracCodeFromMessage({
    id: 'code',
    authorisation_code: 'a17-current-code',
    anticheat_token: 'current-anticheat-token',
  })
  assert.deepEqual(current, {
    code: 'a17-current-code',
    anticheatToken: 'current-anticheat-token',
  })
  assert.deepEqual(retracCodeFromMessage({ id: 'code', code: 'legacy-code' }), {
    code: 'legacy-code',
    anticheatToken: '',
  })
  assert.equal(retracCodeFromMessage({ id: 'code', authorisation_code: '' }), null)
  assert.equal(retracCodeFromMessage({ id: 'code', code: '' }), null)
}

function testRetracPendingLaunchRouting() {
  // There is no React test harness in this project, so lock the wiring that
  // regressed: Download Season leaves a pending launch, the pending effect
  // resumes through startBuild, and startBuild must reach the Retrac CLI
  // branch before the generic installed/download routing.
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const helperAt = renderer.indexOf('const openRetracBuild = useCallback')
  const startAt = renderer.indexOf('const startBuild = useCallback')
  assert.ok(helperAt > 0, 'Retrac launch helper is missing')
  assert.ok(startAt > helperAt, 'startBuild must be able to call the Retrac launch helper')

  const startBody = renderer.slice(startAt, renderer.indexOf('startBuildRef.current = startBuild', startAt))
  const signedInAt = startBody.indexOf('if (!signedIn && !isRetracOfficial)')
  const retracAt = startBody.indexOf('if (isRetracOfficial)')
  const installedAt = startBody.indexOf('if (!installed[build.id])')
  assert.ok(signedInAt >= 0, 'startBuild must exempt Retrac from the VAULTED sign-in prompt')
  assert.ok(retracAt > signedInAt, 'startBuild must route Retrac after the sign-in exemption')
  assert.ok(installedAt > retracAt, 'post-download Retrac must reach its CLI branch before generic download routing')
  assert.match(startBody, /await openRetracBuild\(build\)/)

  const helperAtEnd = renderer.indexOf('/** Show the generic account prompt', helperAt)
  const helperBody = renderer.slice(helperAt, helperAtEnd)
  assert.match(helperBody, /openProviderLauncher\?\.\('retrac-official'/, 'Retrac must use the official CLI bridge')
  assert.match(helperBody, /requestDownload\(build, \{ launchAfter: true \}\)/, 'missing Retrac builds must still download first')

  const pendingAt = renderer.indexOf('const pending = pendingProviderLaunchRef.current')
  const pendingBody = renderer.slice(pendingAt, pendingAt + 900)
  assert.match(pendingBody, /startBuildRef\.current\?\./, 'the post-download pending launch must resume through startBuild')

  assert.match(main, /launchArguments\(runtimeMetadata, version\)/, 'the Retrac CLI must receive its manifest flag')
  assert.match(
    main,
    /registerProviderLauncher\(id, launch\.child\); startCompanionSessionMonitor\(id, current\)/,
    'the opened Retrac process must be tracked for auto-close',
  )
  assert.match(main, /await closeProcessTreeGracefully\(entry\.pid\)/, 'tracked Retrac must be closed after the game exits')
}

function testLaunchArguments() {
  const stellar = providerFortniteArgs(
    backendUrl,
    exchangeCode,
    'stellar',
    'retrac-only-token-must-be-ignored',
  )
  assert.deepEqual(stellar, [
    '-epicapp=Fortnite',
    '-epicenv=Prod',
    '-epiclocale=en-us',
    '-epicportal',
    '-noeac',
    '-nobe',
    '-nouac',
    '-nocodeguards',
    '-NOSSLPINNING',
    '-fromfl=eac',
    `-caldera=${LEGACY_CALDERA}`,
    `-fltoken=${PROVIDER_FLTOKEN}`,
    '-skippatchcheck',
    '-AUTH_LOGIN=',
    `-AUTH_PASSWORD=${exchangeCode}`,
    '-AUTH_TYPE=exchangecode',
    `-backend=${backendUrl}`,
  ])
  assert.equal(stellar.at(-1), `-backend=${backendUrl}`, 'Stellar backend must remain the final argument')
  assert.equal(stellar.some((arg) => arg.startsWith('-actoken=')), false)

  const retrac = providerFortniteArgs(backendUrl, 'retrac-code-123', 'retrac', 'retrac-token')
  assert.equal(retrac.includes('-AUTH_LOGIN=retrac@.'), true)
  assert.equal(retrac.includes('-AUTH_PASSWORD=retrac-code-123'), true)
  assert.equal(retrac.includes('-actoken=retrac-token'), true)
  assert.equal(retrac.at(-1), `-backend=${backendUrl}`)

  assert.equal(localAuthLogin('Player 123!'), `Player123@${LOCAL_AUTH_DOMAIN}`)
  assert.equal(localAuthLogin(''), `Player@${LOCAL_AUTH_DOMAIN}`)

  const local = providerFortniteArgs(backendUrl, '', 'reboot', '', {
    localAuth: true,
    username: 'Player 123!',
  })
  assert.equal(local.includes(`-AUTH_LOGIN=Player123@${LOCAL_AUTH_DOMAIN}`), true)
  assert.equal(local.includes(`-AUTH_PASSWORD=${LOCAL_AUTH_PASSWORD}`), true)
  assert.equal(local.includes('-AUTH_TYPE=epic'), true)
  assert.equal(local.includes('-log'), true)
  assert.equal(local.includes('-AUTH_LOGIN=unused'), false)
  assert.equal(local.at(-1), `-backend=${backendUrl}`)

  const localExchange = providerFortniteArgs(backendUrl, '', 'reboot', '', {
    localAuth: true,
    username: 'Player 123!',
    localExchangeCode: 'vlt_local_exchange_code',
  })
  assert.equal(localExchange.includes('-AUTH_LOGIN=unused'), true)
  assert.equal(localExchange.includes('-AUTH_PASSWORD=vlt_local_exchange_code'), true)
  assert.equal(localExchange.includes('-AUTH_TYPE=exchangecode'), true)
  assert.equal(localExchange.includes('-AUTH_TYPE=epic'), false)
  assert.equal(localExchange.includes('-log'), true)
  assert.equal(localExchange.at(-1), `-backend=${backendUrl}`)

  const unauth = providerFortniteArgs('', '', 'stellar')
  assert.equal(unauth.some((arg) => arg.startsWith('-AUTH_')), false)
  assert.equal(unauth.at(-1), '-skippatchcheck')

  const diagnostic = providerLaunchDiagnostic({
    providerId: 'retrac',
    buildId: 'build-123',
    seasonId: 'ch2-s1',
    version: '6.21',
    args: retrac,
    backendUrl,
    authCode: 'retrac-code-123',
    authToken: 'retrac-token',
  })
  assert.equal(diagnostic.event, 'provider_launch_args')
  assert.equal(diagnostic.authMode, 'exchangecode')
  assert.equal(diagnostic.authCodePresent, true)
  assert.equal(diagnostic.authTokenPresent, true)
  const localDiagnostic = providerLaunchDiagnostic({
    providerId: 'reboot',
    args: localExchange,
    backendUrl,
    localAuth: true,
    localExchange: true,
  })
  assert.equal(localDiagnostic.authMode, 'local-exchange')
  assert.equal(diagnostic.backendHost, '127.0.0.1:3551')
  assert.equal(diagnostic.backendLast, true)
  assert.equal(diagnostic.args.includes('-AUTH_PASSWORD=[redacted]'), true)
  assert.equal(diagnostic.args.includes('-actoken=[redacted]'), true)
  assert.equal(diagnostic.args.includes('-backend=[redacted]'), true)
  assert.equal(diagnostic.args.includes('-caldera=[redacted]'), true)
  const serialized = JSON.stringify(diagnostic)
  assert.equal(serialized.includes('retrac-code-123'), false)
  assert.equal(serialized.includes('retrac-token'), false)
  assert.equal(serialized.includes(backendUrl), false)
}

async function testStellarExchangeSuccess() {
  const requests = []
  const diagnostics = []
  const auth = createAuth({
    diagnostics,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options })
      return jsonResponse(200, { code: exchangeCode, expiresIn: 420 })
    },
  })

  const result = await auth.exchangeCode('stellar', { seasonId: 'ch2-s1', version: '2.1.9' })
  assert.equal(result.code, exchangeCode)
  assert.equal(result.expiresIn, 420)
  assert.equal(result.buildId, '')
  assert.equal(result.buildName, 'ch2-s1 2.1.9')

  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(
    request.url,
    'https://prod-api-v1.stellarfn.dev/account/api/oauth/exchange',
    'Stellar must use the live Epic-compatible exchange route',
  )
  assert.equal(request.options.method, undefined, 'exchange must remain a GET with no body')
  assert.equal(request.options.body, undefined)
  assert.deepEqual(request.options.headers, {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `VAULTED-Launcher/1.0.0-test (${process.platform}; ${process.arch})`,
  })
  assert.ok(request.options.signal instanceof AbortSignal)

  assert.equal(diagnostics.length, 1)
  const diagnostic = diagnostics[0]
  assert.equal(diagnostic.event, 'provider_exchange')
  assert.equal(diagnostic.operation, 'stellar_oauth_exchange')
  assert.equal(diagnostic.providerId, 'stellar')
  assert.equal(diagnostic.endpoint, request.url)
  assert.equal(diagnostic.method, 'GET')
  assert.equal(diagnostic.ok, true)
  assert.equal(diagnostic.status, 200)
  assert.equal(diagnostic.codeLength, exchangeCode.length)
  assert.equal(diagnostic.expiresIn, 420)
  assert.equal(diagnostic.request.authorization, 'Bearer [redacted]')
  assert.equal(JSON.stringify(diagnostic).includes(accessToken), false)
}

async function testStellarExchangeHttpError() {
  const diagnostics = []
  const auth = createAuth({
    diagnostics,
    fetchImpl: async () =>
      jsonResponse(401, {
        error: {
          code: 'invalid_token',
          message: `Invalid token ${accessToken}`,
        },
      }),
  })

  await assert.rejects(auth.exchangeCode('stellar', { seasonId: 'ch2-s1' }), (error) => {
    assert.equal(error.status, 401)
    assert.equal(error.sessionExpired, true)
    assert.match(error.message, /session expired/i)
    // A rejected token must never be echoed back to the renderer or logs.
    assert.equal(error.message.includes(accessToken), false)
    return true
  })

  assert.equal(diagnostics.length, 1)
  const diagnostic = diagnostics[0]
  assert.equal(diagnostic.ok, false)
  assert.equal(diagnostic.status, 401)
  assert.equal(diagnostic.error.message, 'Invalid token [redacted]')
  assert.equal(JSON.stringify(diagnostic).includes(accessToken), false)
}

async function testStellarExchangeInvalidPayload() {
  const diagnostics = []
  const auth = createAuth({
    diagnostics,
    fetchImpl: async () => jsonResponse(200, { data: { expiresIn: 300 } }),
  })

  await assert.rejects(
    auth.exchangeCode('stellar', { seasonId: 'ch2-s1' }),
    /invalid one-time login code/i,
  )
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].ok, false)
  assert.equal(diagnostics[0].status, 200)
  assert.match(diagnostics[0].error.message, /invalid one-time login code/i)
}

async function testStellarExchangeTimeout() {
  const diagnostics = []
  const auth = createAuth({
    diagnostics,
    requestTimeoutMs: 10,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  })

  await assert.rejects(auth.exchangeCode('stellar', { seasonId: 'ch2-s1' }), /did not answer in time/i)
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].ok, false)
  assert.equal(diagnostics[0].status, null)
  assert.match(diagnostics[0].error.message, /did not answer in time/i)
}

async function main() {
  testLiveProviderMappings()
  testRetracCodeReply()
  testRetracPendingLaunchRouting()
  writeTokenStore()
  testLaunchArguments()
  await testStellarExchangeSuccess()
  writeTokenStore()
  await testStellarExchangeHttpError()
  writeTokenStore()
  await testStellarExchangeInvalidPayload()
  writeTokenStore()
  await testStellarExchangeTimeout()
  console.log(
    'provider launch smoke passed: Stellar exchange payload, 401/invalid/timeout diagnostics, Stellar/Retrac/local launch arguments, and the post-download Retrac CLI handoff checked offline',
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })
