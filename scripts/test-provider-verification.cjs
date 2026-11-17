#!/usr/bin/env node
'use strict'

/**
 * Focused Era verification harness.
 *
 * This exercises the real providerAuth module with:
 * - fake Electron BrowserWindow/WebContentsView objects,
 * - a real local loopback OAuth callback server,
 * - a fake fetch implementation for Era's token/profile/builds/exchange APIs,
 * - short poll and timeout intervals supplied through the test-only options.
 *
 * The important contract: Play/login may silently refresh and retry, but they
 * must never open a verification window. Only an explicit verifyAccount call
 * may open the embedded page, and only for a provider-supplied HTTPS URL.
 */
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { createProviderAuth } = require('../electron/providerAuth.cjs')

const ERA_BUILD_ID = '11111111-1111-4111-8111-111111111111'
const SUCCESS_CODE = 'VERIFIED-CODE-123'
const VERIFY_URL = 'https://erafn.dev/account/verify'
const ERA_PROFILE = {
  id: 'era',
  name: 'Project Era',
  label: 'Era',
  auth: 'oauth',
  backendUrl: 'https://game.erafn.dev',
  website: 'https://erafn.dev/',
  oauth: {
    authorizeUrl: 'https://id.erafn.dev/oauth/authorize',
    tokenUrl: 'https://id.erafn.dev/oauth/token',
    clientId: 'era-launcher',
    scope: 'launcher.all',
    methods: { discord: '/oauth/discord/redirect', google: '/oauth/google/redirect' },
  },
  apiBaseUrl: 'https://api.erafn.dev',
  buildsPath: '/launcher/v1/builds',
  exchangeCodePath: '/launcher/v1/game/exchange-code',
  profilePath: '/launcher/v1/me',
  // Deliberately absent: the bundled profile must never be a verification
  // fallback. Only Era's exchange response may supply the page.
  supportedSeasons: ['ch1-s6'],
}
const BUILD = {
  id: ERA_BUILD_ID,
  name: 'Season 6',
  version: '6.0',
  season: 6,
  public: true,
  access: 'allowed',
  build_cl: 1,
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

function jsonResponse(status, body) {
  const text = JSON.stringify(body)
  const headers = {
    'content-type': 'application/json',
    'x-era-request-id': 'era-test-request',
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[String(name).toLowerCase()] ?? null,
      forEach: (callback) => {
        for (const [key, value] of Object.entries(headers)) callback(value, key)
      },
      entries: () => Object.entries(headers)[Symbol.iterator](),
    },
    text: async () => text,
  }
}

function verificationRequiredResponse(url = VERIFY_URL) {
  return jsonResponse(403, {
    error: {
      code: 'verification_required',
      message: 'Complete Era account verification before requesting a game code.',
      verification_url: url,
    },
    required_action: {
      type: 'verify_account',
      verification_url: url,
    },
  })
}

function successResponse() {
  return jsonResponse(200, { data: { code: SUCCESS_CODE, expires_in: 300 } })
}

/**
 * Create a fake fetch router. `exchange` is a function (call index -> response)
 * or an array of responses/factories. No real network request is made.
 */
function createFakeFetch({ exchange }) {
  const calls = []
  let exchangeIndex = 0
  const fetchImpl = async (url, options = {}) => {
    const text = String(url)
    calls.push({
      url: text,
      method: options.method || 'GET',
      body: typeof options.body === 'string' ? options.body : '',
    })

    if (text.startsWith('https://id.erafn.dev/oauth/token')) {
      return jsonResponse(200, {
        access_token: 'oauth-access-token',
        refresh_token: 'oauth-refresh-token',
        expires_in: 3600,
      })
    }
    if (text === 'https://api.erafn.dev/launcher/v1/me') {
      return jsonResponse(200, {
        data: { display_name: 'Era Tester', account_id: 'era-account-1' },
      })
    }
    if (text === 'https://api.erafn.dev/launcher/v1/builds') {
      return jsonResponse(200, { data: [BUILD] })
    }
    if (text === 'https://game.erafn.dev/account/api/oauth/verify') {
      return jsonResponse(200, { data: { valid: true } })
    }
    if (text === 'https://api.erafn.dev/launcher/v1/game/exchange-code') {
      const index = exchangeIndex
      exchangeIndex += 1
      if (Array.isArray(exchange)) {
        const entry = exchange[Math.min(index, exchange.length - 1)]
        return await (typeof entry === 'function' ? entry(index) : entry)
      }
      return await exchange(index)
    }
    throw new Error(`Unexpected fake fetch URL: ${text}`)
  }
  return {
    fetchImpl,
    calls,
    exchangeCalls: () => calls.filter((call) => call.url.endsWith('/game/exchange-code')),
    tokenCalls: () => calls.filter((call) => call.url.startsWith('https://id.erafn.dev/oauth/token')),
    profileCalls: () => calls.filter((call) => call.url === 'https://api.erafn.dev/launcher/v1/me'),
    gameVerifyCalls: () =>
      calls.filter((call) => call.url === 'https://game.erafn.dev/account/api/oauth/verify'),
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume()
      response.on('end', resolve)
      response.on('error', reject)
    })
    request.setTimeout(1500, () => request.destroy(new Error('OAuth callback timed out')))
    request.on('error', reject)
  })
}

function createHarness({
  fetchImpl,
  seedToken = false,
  seedVerificationCompleted = false,
  verificationPollMs = 5,
  verificationTimeoutMs = 2000,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-provider-verification-'))
  const userData = path.join(root, 'userData')
  fs.mkdirSync(userData, { recursive: true })

  const windows = []
  const views = []
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8'),
  }

  class FakeWebContents extends EventEmitter {
    constructor() {
      super()
      this.loadedUrls = []
      this.loadedFiles = []
      this.closed = false
    }

    loadURL(url) {
      this.loadedUrls.push(String(url))
      this.emit('did-finish-load')
      return Promise.resolve()
    }

    loadFile(file, options) {
      this.loadedFiles.push({ file, options })
      return Promise.resolve()
    }

    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler
    }

    close() {
      this.closed = true
    }
  }

  class FakeWebContentsView {
    constructor(options) {
      this.options = options
      this.webContents = new FakeWebContents()
      this.bounds = null
      views.push(this)
    }

    setBackgroundColor() {}

    setBounds(bounds) {
      this.bounds = bounds
    }
  }

  class FakeWindow extends EventEmitter {
    constructor(options = {}) {
      super()
      this.options = options
      this.webContents = new FakeWebContents()
      this.childViews = []
      this.destroyed = false
      this.shown = false
      this.contentView = {
        addChildView: (view) => {
          this.childViews.push(view)
        },
        removeChildView: (view) => {
          this.childViews = this.childViews.filter((candidate) => candidate !== view)
        },
      }
      windows.push(this)
      setTimeout(() => {
        if (!this.destroyed) this.emit('ready-to-show')
      }, 0)
    }

    setMenuBarVisibility() {}

    getContentSize() {
      return [this.options.width || 560, this.options.height || 760]
    }

    getBounds() {
      return {
        x: 0,
        y: 0,
        width: this.options.width || 560,
        height: this.options.height || 760,
      }
    }

    isDestroyed() {
      return this.destroyed
    }

    isModal() {
      return this.options.modal === true
    }

    show() {
      this.shown = true
    }

    loadFile(file, options) {
      this.webContents.loadedFiles.push({ file, options })
      return Promise.resolve()
    }

    loadURL(url) {
      return this.webContents.loadURL(url)
    }

    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }

    close() {
      this.destroy()
    }
  }

  const mainWindow = new FakeWindow({ title: 'main', width: 1200, height: 800 })
  // The main window is not a created login/verification child.
  windows.length = 0

  if (seedToken) {
    const store = {
      era: {
        access_token: 'seeded-access-token',
        refresh_token: 'seeded-refresh-token',
        expires_at: Date.now() + 3_600_000,
        auth_method: 'discord',
        display_name: 'Seeded Era Tester',
        verificationCompleted: seedVerificationCompleted,
      },
    }
    fs.writeFileSync(
      path.join(userData, 'provider-auth.bin'),
      safeStorage.encryptString(JSON.stringify(store)),
    )
  }

  const app = {
    getPath: (name) => (name === 'userData' ? userData : root),
  }
  const auth = createProviderAuth({
    app,
    safeStorage,
    BrowserWindow: FakeWindow,
    WebContentsView: FakeWebContentsView,
    getParentWindow: () => mainWindow,
    listProviders: () => [{ id: 'era', auth: 'oauth' }],
    profileForId: (id) => (id === 'era' ? ERA_PROFILE : null),
    fetchImpl,
    requestTimeoutMs: 1000,
    loginTimeoutMs: 3000,
    verificationTimeoutMs,
    verificationPollMs,
  })

  return {
    auth,
    windows,
    views,
    mainWindow,
    async cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

async function triggerOAuthCallback(views) {
  await waitFor(
    () =>
      views.some((view) =>
        view.webContents.loadedUrls.some((url) => url.includes('/oauth/discord/redirect')),
      ),
    'the Discord OAuth redirect',
  )
  const view = views.find((candidate) =>
    candidate.webContents.loadedUrls.some((url) => url.includes('/oauth/discord/redirect')),
  )
  assert.ok(view, 'the login view did not load the Discord redirect')
  const methodUrl = new URL(view.webContents.loadedUrls.at(-1))
  const returnValue = methodUrl.searchParams.get('return')
  assert.ok(returnValue, 'the Discord redirect did not carry the authorize return URL')
  const authorize = new URL(returnValue, methodUrl.origin)
  const state = authorize.searchParams.get('state')
  const redirect = authorize.searchParams.get('redirect_uri')
  assert.ok(state, 'the authorize URL did not carry a state')
  assert.ok(redirect, 'the authorize URL did not carry a loopback redirect')

  const callback = new URL(redirect)
  callback.searchParams.set('state', state)
  callback.searchParams.set('code', 'oauth-code')
  await httpGet(callback)
}

async function testSilentRecoveryCompletesWithoutWindow() {
  const fakeFetch = createFakeFetch({
    exchange: [() => verificationRequiredResponse(), () => successResponse()],
  })
  const harness = createHarness({ fetchImpl: fakeFetch.fetchImpl, seedToken: true })
  try {
    const result = await harness.auth.exchangeCode('era', { seasonId: 'ch1-s6', version: '6.0' })

    assert.equal(result.code, SUCCESS_CODE)
    assert.equal(result.buildId, ERA_BUILD_ID)
    assert.equal(harness.windows.length, 0, 'silent recovery must not open a verification window')
    assert.equal(fakeFetch.exchangeCalls().length, 2, 'the exchange should be retried exactly once')
    assert.equal(fakeFetch.tokenCalls().length, 1, 'the session should be refreshed silently')
    assert.match(fakeFetch.tokenCalls()[0].body, /grant_type=refresh_token/)
    assert.ok(fakeFetch.profileCalls().length >= 1, 'the Era profile should be refreshed silently')
    assert.equal(fakeFetch.gameVerifyCalls().length, 1, 'the game host token should be checked')
    assert.equal(harness.auth.status('era').verificationCompleted, true)
  } finally {
    await harness.cleanup()
  }
}

async function testVerificationRequiredNeedsExplicitButton() {
  const fakeFetch = createFakeFetch({
    exchange: [
      () => verificationRequiredResponse(),
      () => verificationRequiredResponse(),
      () => successResponse(),
    ],
  })
  const harness = createHarness({ fetchImpl: fakeFetch.fetchImpl, seedToken: true })
  try {
    let failure = null
    try {
      await harness.auth.exchangeCode('era', { seasonId: 'ch1-s6', version: '6.0' })
    } catch (error) {
      failure = error
    }
    assert.ok(failure, 'the exchange should reject rather than opening a window')
    assert.match(failure.message, /verification/i)
    assert.equal(failure.verificationUrl, VERIFY_URL)
    assert.equal(failure.verificationDetails.status, 403)
    assert.equal(failure.verificationDetails.body.error.code, 'verification_required')
    assert.equal(failure.verificationDetails.headers['x-era-request-id'], 'era-test-request')
    assert.equal(harness.windows.length, 0, 'Play must never open the verification window')
    assert.equal(harness.auth.status('era').signedIn, true)
    assert.equal(harness.auth.status('era').verificationCompleted, false)

    const verification = harness.auth.verifyAccount('era', {
      seasonId: 'ch1-s6',
      version: '6.0',
    })
    await waitFor(() => harness.windows.length === 1, 'the explicit verification window')
    const window = harness.windows[0]
    await waitFor(() => window.shown, 'the explicit verification window to show', 500)
    assert.equal(window.options.title, 'VAULTED · SECURE ACCOUNT LINK')
    assert.equal(window.options.parent, harness.mainWindow)
    assert.equal(window.options.modal, true)
    assert.equal(window.childViews.length, 1)
    assert.equal(window.childViews[0].webContents.loadedUrls.at(-1), VERIFY_URL)

    const result = await verification
    assert.equal(result.code, SUCCESS_CODE)
    assert.equal(window.destroyed, true, 'verification window stayed open after success')
    assert.equal(harness.auth.status('era').verificationCompleted, true)

    const exchangeCount = fakeFetch.exchangeCalls().length
    const cached = await harness.auth.exchangeCode('era', { seasonId: 'ch1-s6', version: '6.0' })
    assert.equal(cached.code, SUCCESS_CODE)
    assert.equal(fakeFetch.exchangeCalls().length, exchangeCount, 'the verified code was not reused')
  } finally {
    await harness.cleanup()
  }
}

async function testCompletedStateSurvivesSilentRefresh() {
  const fakeFetch = createFakeFetch({
    exchange: [() => verificationRequiredResponse(), () => verificationRequiredResponse()],
  })
  const harness = createHarness({
    fetchImpl: fakeFetch.fetchImpl,
    seedToken: true,
    seedVerificationCompleted: true,
  })
  try {
    await assert.rejects(harness.auth.exchangeCode('era', { seasonId: 'ch1-s6', version: '6.0' }))
    assert.equal(fakeFetch.tokenCalls().length, 1, 'the silent refresh should still rotate the token')
    assert.equal(harness.windows.length, 0, 'a completed account must not reopen a popup')
    assert.equal(
      harness.auth.status('era').verificationCompleted,
      true,
      'the completed state must survive a token refresh',
    )
  } finally {
    await harness.cleanup()
  }
}

async function testLoginDoesNotOpenVerificationWindow() {
  const fakeFetch = createFakeFetch({
    exchange: [() => verificationRequiredResponse(), () => verificationRequiredResponse()],
  })
  const harness = createHarness({ fetchImpl: fakeFetch.fetchImpl })
  try {
    const login = harness.auth.login('era', { method: 'discord' })
    await triggerOAuthCallback(harness.views)
    const status = await login

    assert.equal(status.signedIn, true)
    assert.equal(status.displayName, 'Era Tester')
    assert.equal(harness.windows.length, 1, 'login must not append an automatic verification window')
    assert.equal(harness.windows[0].destroyed, true, 'the sign-in modal stayed open')
    assert.equal(status.verificationCompleted, false)
    assert.equal(fakeFetch.exchangeCalls().length, 2, 'post-login verification should retry silently once')
    assert.equal(fakeFetch.tokenCalls().length, 2, 'login token plus one silent refresh')
    assert.equal(fakeFetch.gameVerifyCalls().length, 1)
  } finally {
    await harness.cleanup()
  }
}

async function testDiscordInviteIsNeverAValidVerificationPage() {
  const fakeFetch = createFakeFetch({
    exchange: [
      () => verificationRequiredResponse('https://discord.gg/erafn'),
      () => verificationRequiredResponse('https://discord.gg/erafn'),
    ],
  })
  const harness = createHarness({ fetchImpl: fakeFetch.fetchImpl, seedToken: true })
  try {
    await assert.rejects(harness.auth.exchangeCode('era', { seasonId: 'ch1-s6', version: '6.0' }))
    assert.equal(harness.windows.length, 0)
    assert.equal(fakeFetch.exchangeCalls().length, 2)

    await assert.rejects(
      harness.auth.verifyAccount('era', { seasonId: 'ch1-s6', version: '6.0' }),
      /did not return a verification page/i,
    )
    assert.equal(harness.windows.length, 0, 'a Discord invite must never open a verification window')
  } finally {
    await harness.cleanup()
  }
}

async function testCancelCleansUpExplicitVerification() {
  const fakeFetch = createFakeFetch({
    exchange: [
      () => verificationRequiredResponse(),
      () => verificationRequiredResponse(),
      () => successResponse(),
    ],
  })
  const harness = createHarness({
    fetchImpl: fakeFetch.fetchImpl,
    seedToken: true,
    verificationPollMs: 50,
  })
  try {
    await assert.rejects(harness.auth.exchangeCode('era', { seasonId: 'ch1-s6', version: '6.0' }))
    const verification = harness.auth.verifyAccount('era', { seasonId: 'ch1-s6', version: '6.0' })
    await waitFor(() => harness.windows.length === 1, 'the cancellable verification window')
    const window = harness.windows[0]
    window.close()

    await assert.rejects(verification, /verification was closed before it finished/i)
    assert.equal(window.destroyed, true, 'canceled verification window was left open')
    assert.equal(harness.auth.status('era').signedIn, true, 'cancel should preserve the session')
    assert.equal(
      fakeFetch.exchangeCalls().length,
      2,
      'the canceled verification kept polling after its window closed',
    )
  } finally {
    await harness.cleanup()
  }
}

async function testExplicitVerificationTimeoutCleansUp() {
  const fakeFetch = createFakeFetch({
    exchange: () => verificationRequiredResponse(),
  })
  const harness = createHarness({
    fetchImpl: fakeFetch.fetchImpl,
    seedToken: true,
    verificationPollMs: 10,
    verificationTimeoutMs: 45,
  })
  try {
    await assert.rejects(harness.auth.exchangeCode('era', { seasonId: 'ch1-s6', version: '6.0' }))
    await assert.rejects(
      harness.auth.verifyAccount('era', { seasonId: 'ch1-s6', version: '6.0' }),
      /verification is still pending/i,
    )
    assert.equal(harness.windows.length, 1, 'timeout should only have opened one verification window')
    assert.equal(harness.windows[0].destroyed, true, 'timed-out verification window was left open')
    assert.equal(harness.auth.status('era').signedIn, true, 'timeout should preserve the valid session')
  } finally {
    await harness.cleanup()
  }
}

async function main() {
  await testSilentRecoveryCompletesWithoutWindow()
  await testVerificationRequiredNeedsExplicitButton()
  await testCompletedStateSurvivesSilentRefresh()
  await testLoginDoesNotOpenVerificationWindow()
  await testDiscordInviteIsNeverAValidVerificationPage()
  await testCancelCleansUpExplicitVerification()
  await testExplicitVerificationTimeoutCleansUp()
  console.log(
    'provider verification checks passed: silent refresh/retry, no automatic window, explicit HTTPS verification, Discord rejection, cache reuse, cancel/timeout cleanup',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
