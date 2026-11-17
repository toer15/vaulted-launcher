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
  PROVIDER_FLTOKEN,
  providerFortniteArgs,
  providerLaunchDiagnostic,
} = require('../electron/providerLaunchArgs.cjs')
const { createProviderAuth } = require('../electron/providerAuth.cjs')
const { providerCatalog, providerProfile } = require('../electron/onlineProviders.cjs')

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

  const local = providerFortniteArgs(backendUrl, '', 'neo', '', { localAuth: true })
  assert.equal(local.includes('-AUTH_LOGIN=unused'), true)
  assert.equal(local.includes('-AUTH_PASSWORD=unused'), true)
  assert.equal(local.includes('-AUTH_TYPE=epic'), true)
  assert.equal(local.includes('-log'), true)
  assert.equal(local.at(-1), `-backend=${backendUrl}`)

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
    assert.match(error.message, new RegExp(accessToken))
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
  writeTokenStore()
  testLaunchArguments()
  await testStellarExchangeSuccess()
  await testStellarExchangeHttpError()
  await testStellarExchangeInvalidPayload()
  await testStellarExchangeTimeout()
  console.log(
    'provider launch smoke passed: Stellar exchange payload, 401/invalid/timeout diagnostics, and Stellar/Retrac/local launch arguments checked offline',
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
