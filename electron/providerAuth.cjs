'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const crypto = require('node:crypto')
const WebSocket = require('ws')

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000
const VERIFICATION_POLL_MS = 5_000
const REQUEST_TIMEOUT_MS = 20_000
const REALTIME_VERIFY_TIMEOUT_MS = 20_000
const REALTIME_RECONNECT_BASE_MS = 1_000
const REALTIME_RECONNECT_MAX_MS = 15_000
const REALTIME_PROCESS_POLL_MS = 2_000
// Era's gateway treats a socket as dead after 45s without traffic. Refresh
// in-game presence well inside that window so a long matchmaking queue cannot
// age the client out of the session.
const REALTIME_KEEPALIVE_MS = 20_000
const REALTIME_DEAD_AFTER_MS = 45_000
const REALTIME_TOKEN_REFRESH_MARGIN_MS = 90_000
const TOKEN_FILE = 'provider-auth.bin'
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const PROVIDER_SESSION_EXPIRED = 'provider_session_expired'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BUILD_VERIFICATION_STATUS = 'build_verification_required'
const GAME_VERIFY_MAX_FILES = 64
const GAME_VERIFY_EXE = 'FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe'
const GAME_VERIFY_ROOTS = ['FortniteGame/Content/Paks', 'FortniteGame/Plugins']
const GAME_VERIFY_EXT = /\.(?:pak|sig|utoc|ucas)$/i
const BUILD_MANIFEST_FORMAT = 'era-chunks-v3'
const BUILD_CHUNK_HASH = /^[0-9a-f]{32}$/i
const BUILD_RELATIVE_PATH_MAX = 320
const RETRAC_LAUNCHER_SOCKET = 'wss://launcher-service-prod.retr.ac/websocket/launcher'
const RETRAC_LAUNCHER_VERSION = '3.0.13'
const PROVIDER_CODE_TIMEOUT_MS = 20_000

function safeText(value, limit = 300) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/** Keep provider/account errors useful without echoing bearer tokens to logs. */
function redactDiagnosticText(value, secrets = []) {
  let text = safeText(value, 500)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) text = text.split(secret).join('[redacted]')
  }
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
}

/** A hard auth rejection that needs a fresh interactive sign-in. */
function isSessionExpiredError(error) {
  if (!error || error.buildVerificationRequired === true) return false
  if (error.accountStatus && error.accountStatus !== PROVIDER_SESSION_EXPIRED) return false
  if (error.verificationRequired === true) return false
  if (error.sessionExpired === true || error.code === PROVIDER_SESSION_EXPIRED) return true
  if (error.status === 401) return true
  if (Number(error.retracCloseCode) === 4002 || Number(error.code) === 4002) return true
  const text = `${safeText(error.code, 80)} ${safeText(error.message, 500)}`
  return /(?:invalid[ _-]?token|token[ _-]?expired|expired[ _-]?token|session (?:has )?expired|invalid[ _-]?session|unauthori[sz]ed|\b(?:4002|4401|4403)\b)/i.test(
    text,
  )
}

function sessionExpiredError(config, cause = null) {
  const error = new Error(
    `Your ${config.label} session expired. Connect the account again from the season card.`,
  )
  error.code = PROVIDER_SESSION_EXPIRED
  error.sessionExpired = true
  error.status = 401
  if (cause) error.cause = cause
  return error
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Windows returns EPERM for a live process owned by another user/session.
    return error?.code === 'EPERM'
  }
}

// Provider account APIs use these status codes when the signed-in account is
// valid but still needs a Discord/account action before it can request a game
// code. Keep them structured so the launch UI can explain the next step
// instead of leaking a machine code or treating it as an expired session.
const VERIFICATION_STATUS_CODES = new Set([
  'verification_required',
  'verification_pending',
  'pending_verification',
  'account_verification_required',
  'account_not_verified',
  'account_unverified',
  'email_verification_required',
  'discord_verification_required',
  'guild_verification_required',
  'discord_required',
  'discord_membership_required',
  'not_in_guild',
  'guild_member_required',
  'membership_required',
])
const ACCOUNT_STATUS_CODES = new Set([
  ...VERIFICATION_STATUS_CODES,
  'account_banned',
  'account_suspended',
  'account_restricted',
  'account_locked',
  'account_disabled',
  'account_not_found',
  'account_missing',
  'account_link_required',
  'account_status',
  'account_status_error',
  'whitelist_required',
  'role_required',
])
const ACCOUNT_STATUS_PATTERN =
  /^(?:account|user|discord|guild|membership|whitelist|verification|verify|not_verified|unverified|banned|suspended|restricted|locked|disabled)/

function accountStatusCode(json) {
  if (!json || typeof json !== 'object') return ''
  const error = json.error && typeof json.error === 'object' ? json.error : null
  const details = error?.details && typeof error.details === 'object' ? error.details : null
  const candidates = [
    error?.code,
    error?.type,
    error?.status,
    error?.reason,
    details?.code,
    details?.type,
    error?.message,
    typeof json.error === 'string' ? json.error : '',
    json.code,
    json.status,
    json.reason,
  ]
  for (const candidate of candidates) {
    const raw = safeText(candidate, 80)
    if (!raw || /\s/.test(raw)) continue
    const code = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
    if (/^[a-z][a-z0-9_-]{2,}$/.test(code)) return code
  }
  return ''
}

function isGameFileVerification(json, detail) {
  const text = [
    json?.message,
    json?.detail,
    json?.errorMessage,
    json?.error && typeof json.error === 'object' ? json.error.message : '',
    json?.error && typeof json.error === 'object' ? json.error.detail : '',
    detail,
  ]
    .filter((value) => typeof value === 'string')
    .join(' ')
  return /verify(?:\s+the)?\s+game\s+files|game\s+files?\s+(?:must\s+be\s+verified|need\s+to\s+be\s+verified|verification|integrity)|verify\s+files\s+before\s+launching/i.test(
    text,
  )
}

function accountStatusFor(json, status, detail) {
  const code = accountStatusCode(json)
  // Era returns `verification_required` for two unrelated things: an account
  // that still needs Discord/account verification, and a completely valid
  // account whose local game files failed the build-integrity gate. The
  // message is the only discriminator; the latter must never open an account
  // verification page or trigger a token refresh.
  if (status >= 400 && status < 500 && isGameFileVerification(json, detail)) {
    return BUILD_VERIFICATION_STATUS
  }
  if (code && (ACCOUNT_STATUS_CODES.has(code) || ACCOUNT_STATUS_PATTERN.test(code))) return code
  if (
    status >= 400 &&
    status < 500 &&
    /verification[_ -]?required|verification[_ -]?pending|verify your account|not[_ -]?verified|discord server|guild|membership|whitelist/i.test(detail)
  ) {
    return 'verification_required'
  }
  return ''
}

function isVerificationStatus(code) {
  if (code === BUILD_VERIFICATION_STATUS) return false
  return (
    VERIFICATION_STATUS_CODES.has(code) ||
    /verification|verify|verified|discord|guild|membership|whitelist/i.test(code)
  )
}

function isVerificationFailure(error) {
  return Boolean(
    error?.verificationRequired === true ||
      (error?.accountStatus && isVerificationStatus(String(error.accountStatus))) ||
      (error?.code && isVerificationStatus(String(error.code))),
  )
}

/** Provider sessions are global to an account, never to a season/build. */
function normalizeProviderId(value) {
  return safeText(value, 120).toLowerCase().split(':')[0].trim()
}

/**
 * Era returns a build's major version and, when available, a human season
 * number. Convert both forms to the stable season key used by VAULTED's build
 * catalogue so newly published seasons do not need another provider entry.
 */
function seasonIdForBuild(build) {
  const name = safeText(build?.name, 160)
  const version = safeText(build?.version, 40)
  const versionMajor = Number(version.split('.')[0])
  const declaredSeason = Number(build?.season)
  const chapterSeason = /chapter\s+(\d{1,2})\s+season\s+(\d{1,2})/i.exec(name)
  const miniSeason = /chapter\s+(\d{1,2})\s+mini\s+season\s+(\d{1,2})/i.exec(name)

  if (miniSeason) return `ch${Number(miniSeason[1])}-mini${Number(miniSeason[2])}`
  if (/fortnite\s+og/i.test(name)) return 'ch4-s5'
  if (chapterSeason) return `ch${Number(chapterSeason[1])}-s${Number(chapterSeason[2])}`

  const major = Number.isInteger(versionMajor) && versionMajor > 0
    ? versionMajor
    : Number.isInteger(declaredSeason) && declaredSeason > 0
      ? declaredSeason
      : 0
  if (major >= 1 && major <= 10) return `ch1-s${major}`
  if (major >= 11 && major <= 18) return `ch2-s${major - 10}`
  if (major >= 19 && major <= 22) return `ch3-s${major - 18}`
  if (major >= 23 && major <= 26) return `ch4-s${major - 22}`
  if (major === 27) return 'ch4-s5'
  if (major >= 28 && major <= 31) return `ch5-s${major - 27}`
  if (major === 32) return 'ch5-remix'
  if (major === 33 || major === 34) return `ch6-s${major - 32}`
  if (major === 35) return 'ch6-mini1'
  if (major === 36 || major === 37) return `ch6-s${major - 33}`
  if (major === 38) return 'ch6-mini2'
  if (major >= 39 && major <= 42) return `ch7-s${major - 38}`
  if (major === 43) return 'ch7-mini1'
  return ''
}

function buildList(payload) {
  if (Array.isArray(payload?.data)) return payload.data
  return Array.isArray(payload) ? payload : []
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function callbackPage(title, detail, ok) {
  const colour = ok ? '#34d399' : '#fb7185'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: radial-gradient(circle at 50% 0%, #122238, #05070c 70%);
      color: #e8eef8; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    }
    main {
      width: min(420px, calc(100vw - 40px)); padding: 30px;
      border: 1px solid #263548; border-radius: 22px;
      background: rgba(11, 19, 30, .92); box-shadow: 0 30px 90px rgba(0, 0, 0, .55);
    }
    .dot { width: 10px; height: 10px; border-radius: 99px; background: ${colour}; box-shadow: 0 0 18px ${colour}; }
    .eyebrow { display: flex; align-items: center; gap: 9px; color: ${colour}; font-size: 11px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 16px 0 8px; font-size: 23px; letter-spacing: -.02em; }
    p { margin: 0; color: #91a1b6; font-size: 13px; line-height: 1.65; }
    .hint { margin-top: 20px; padding-top: 16px; border-top: 1px solid #223044; color: #687a91; font-size: 11px; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow"><span class="dot"></span>${ok ? 'Account connected' : 'Sign-in stopped'}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    <div class="hint">You can close this window and return to VAULTED.</div>
  </main>
</body>
</html>`
}

function createProviderAuth({
  app,
  safeStorage,
  BrowserWindow,
  WebContentsView,
  getParentWindow,
  listProviders,
  profileForId,
  // Injectable only so the focused verification harness can use local fakes
  // and short poll intervals. Production callers keep the real fetch/timings.
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  verificationTimeoutMs = VERIFICATION_TIMEOUT_MS,
  verificationPollMs = VERIFICATION_POLL_MS,
  // Injectable only for the focused harness. Production uses the real build
  // file hashes and Era realtime gateway.
  buildVerifyImpl = null,
  gameFileHashesImpl = null,
  // Structured, redacted exchange diagnostics. Production defaults to the
  // process log; the offline test harness captures the same objects.
  diagnosticSink = null,
}) {
  if (!app || !safeStorage || !BrowserWindow) throw new Error('Provider authentication requires Electron.')
  if (typeof listProviders !== 'function' || typeof profileForId !== 'function') {
    throw new Error('Provider authentication has no provider catalog.')
  }
  const providerUserAgent = `VAULTED-Launcher/${
    safeText(typeof app.getVersion === 'function' ? app.getVersion() : '', 40) || 'unknown'
  } (${process.platform}; ${process.arch})`

  const emitDiagnostic = (diagnostic) => {
    try {
      if (typeof diagnosticSink === 'function') diagnosticSink(diagnostic)
      else console.info('[provider-auth]', JSON.stringify(diagnostic))
    } catch {
      /* diagnostics must never affect the account flow */
    }
  }

  /** providerId -> in-flight login promise */
  const activeLogins = new Map()
  /** providerId|buildId -> short-lived code created by the post-login check */
  const verificationCodes = new Map()
  /** providerId|buildId -> verification URL/diagnostic awaiting an explicit Verify Account click */
  const pendingVerifications = new Map()
  const loggedVerificationResponses = new Set()
  /** build root -> { fingerprint, files } so unchanged installs are not rehashed */
  const gameFileHashCache = new Map()
  let tokenCache = null

  function tokenFilePath() {
    return path.join(app.getPath('userData'), TOKEN_FILE)
  }

  function normalizeStore(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const normalized = {}
    for (const [rawId, record] of Object.entries(source)) {
      const id = normalizeProviderId(rawId)
      if (!id || !record || typeof record !== 'object' || Array.isArray(record)) continue
      // Old builds wrote `providerId:seasonId` keys. Collapse those to the
      // provider account so every season shares the same encrypted session.
      if (!normalized[id]) normalized[id] = record
    }
    return normalized
  }

  function readStore() {
    if (tokenCache) return tokenCache
    try {
      if (!safeStorage.isEncryptionAvailable()) return {}
      const text = safeStorage.decryptString(fs.readFileSync(tokenFilePath()))
      tokenCache = normalizeStore(JSON.parse(text))
    } catch {
      tokenCache = {}
    }
    return tokenCache
  }

  function writeStore(store) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Windows secure storage is unavailable, so VAULTED will not save your provider session. Unlock Windows Credential Manager and try again.',
      )
    }
    const target = tokenFilePath()
    const normalized = normalizeStore(store)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(normalized)), { mode: 0o600 })
      fs.rmSync(target, { force: true })
      fs.renameSync(temporary, target)
      tokenCache = normalized
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  function clearToken(providerId) {
    const id = normalizeProviderId(providerId)
    const store = { ...readStore() }
    if (!id || !Object.prototype.hasOwnProperty.call(store, id)) return
    delete store[id]
    writeStore(store)
  }

  function providerConfig(providerId) {
    const id = normalizeProviderId(providerId)
    let profile
    try {
      profile = profileForId(id)
    } catch {
      profile = null
    }
    if (!profile || !['oauth', 'deeplink', 'embedded_web'].includes(profile.auth)) {
      throw new Error('That provider does not support an in-app account sign-in.')
    }

    let apiBaseUrl
    try {
      apiBaseUrl = new URL(profile.apiBaseUrl)
    } catch {
      throw new Error(`${profile.label} has no valid account API. Reinstall VAULTED.`)
    }
    if (apiBaseUrl.protocol !== 'https:' || apiBaseUrl.username || apiBaseUrl.password) {
      throw new Error(`${profile.label} has an invalid account API. Reinstall VAULTED.`)
    }

    const safePath = (value, fallback) => {
      const candidate = typeof value === 'string' ? value.trim() : ''
      return /^\/[A-Za-z0-9/_-]{1,200}$/.test(candidate) ? candidate : fallback
    }

    let oauth = null
    if (profile.auth === 'oauth') {
      const source = profile.oauth
      if (!source || typeof source !== 'object') {
        throw new Error(`${profile.label} is missing its OAuth configuration. Reinstall VAULTED.`)
      }
      let authorizeUrl
      let tokenUrl
      try {
        authorizeUrl = new URL(source.authorizeUrl)
        tokenUrl = new URL(source.tokenUrl)
      } catch {
        throw new Error(`${profile.label} has an invalid OAuth endpoint. Reinstall VAULTED.`)
      }
      for (const endpoint of [authorizeUrl, tokenUrl]) {
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
          throw new Error(`${profile.label} OAuth endpoints must use https without credentials.`)
        }
      }
      const clientId = safeText(source.clientId, 128)
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) {
        throw new Error(`${profile.label} has an invalid OAuth client ID. Reinstall VAULTED.`)
      }
      const fixedRedirect = source.fixedRedirect === true
      let redirectUri = source.redirectUri ? httpsUrl(source.redirectUri) : ''
      // Retrac's current launcher client uses its registered desktop scheme
      // (retrac://callback), not a web redirect. Accept that only for a
      // fixed-redirect client so a bundled profile cannot invent a callback.
      if (!redirectUri && fixedRedirect && typeof source.redirectUri === 'string') {
        try {
          const candidate = new URL(source.redirectUri.trim())
          if (
            /^[a-z][a-z0-9+.-]*:$/.test(candidate.protocol) &&
            candidate.hostname === 'callback' &&
            !candidate.username &&
            !candidate.password &&
            !candidate.search &&
            !candidate.hash
          ) {
            redirectUri = candidate.toString()
          }
        } catch {
          redirectUri = ''
        }
      }
      if (source.redirectUri && !redirectUri) {
        throw new Error(`${profile.label} has an invalid OAuth callback. Reinstall VAULTED.`)
      }
      oauth = {
        authorizeUrl: authorizeUrl.toString(),
        tokenUrl: tokenUrl.toString(),
        clientId,
        scope: safeText(source.scope, 256),
        redirectUri: redirectUri || '',
        fixedRedirect,
        // Retrac's current launcher posts its token grant as JSON. Era and the
        // other providers use the standard form body.
        tokenFormat: source.tokenFormat === 'json' ? 'json' : 'form',
        methods: {},
      }
      if (source.methods && typeof source.methods === 'object' && !Array.isArray(source.methods)) {
        for (const method of ['discord', 'google']) {
          const endpoint = source.methods[method]
          if (typeof endpoint !== 'string') continue
          const candidate = endpoint.trim()
          if (/^\/[A-Za-z0-9/_-]{1,200}$/.test(candidate)) oauth.methods[method] = candidate
        }
      }
    }

    let deeplink = null
    if (profile.auth === 'deeplink') {
      const source = profile.deeplink
      const scheme = safeText(source?.scheme, 40).toLowerCase()
      const authorizeUrl = httpsUrl(source?.authorizeUrl)
      const tokenParam = safeText(source?.tokenParam, 40)
      const refreshParam = safeText(source?.refreshParam, 40)
      if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme) || !authorizeUrl) {
        throw new Error(`${profile.label} is missing its deep-link sign-in configuration. Reinstall VAULTED.`)
      }
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(tokenParam)) {
        throw new Error(`${profile.label} has an invalid deep-link token parameter.`)
      }
      deeplink = { scheme, authorizeUrl, tokenParam, refreshParam }
    }

    let embeddedWeb = null
    if (profile.auth === 'embedded_web') {
      const source = profile.embeddedWeb
      const loginUrl = httpsUrl(source?.loginUrl)
      let callbackUrl = null
      try {
        const candidate = new URL(String(source?.callbackUrl || ''))
        if (['http:', 'https:'].includes(candidate.protocol) && !candidate.username && !candidate.password) {
          callbackUrl = candidate.toString()
        }
      } catch {
        callbackUrl = null
      }
      const tokenParam = safeText(source?.tokenParam, 40)
      const refreshParam = safeText(source?.refreshParam, 40)
      if (!loginUrl || !callbackUrl || !/^[A-Za-z0-9._-]{1,40}$/.test(tokenParam)) {
        throw new Error(`${profile.label} is missing its embedded sign-in configuration. Reinstall VAULTED.`)
      }
      embeddedWeb = { loginUrl, callbackUrl, tokenParam, refreshParam }
    }

    const buildIds = {}
    if (oauth?.buildIds && typeof oauth.buildIds === 'object' && !Array.isArray(oauth.buildIds)) {
      for (const [season, buildId] of Object.entries(oauth.buildIds)) {
        if (/^ch\d{1,2}(?:-s\d{1,2}|-remix|-mini\d+)$/.test(season) && UUID.test(String(buildId))) {
          buildIds[season] = String(buildId)
        }
      }
    }

    return {
      id: profile.id,
      label: profile.label || profile.name || profile.id,
      auth: profile.auth,
      oauth,
      deeplink,
      embeddedWeb,
      launchHandshakePending: profile.launchHandshakePending === true,
      apiBaseUrl: apiBaseUrl.origin,
      // Era's game-file integrity check is a realtime-gateway operation, not an
      // HTTP route. Keep the gateway origin beside the API origin so the
      // exchange can perform the same pre-launch handshake as Era's launcher.
      realtimeUrl:
        websocketUrl(profile.realtimeUrl) || (id === 'era' ? 'wss://rt.erafn.dev' : ''),
      buildsPath: safePath(profile.buildsPath, '/launcher/v1/builds'),
      exchangeCodePath: safePath(profile.exchangeCodePath, '/launcher/v1/game/exchange-code'),
      profilePath: safeText(profile.profilePath, 220),
      statusUrl: httpsUrl(profile.statusUrl) || '',
      // Era's game host is used for the silent token/profile refresh. It is
      // never opened as a browser or embedded invite page.
      gameBaseUrl:
        httpsUrl(profile.backendUrl) ||
        httpsUrl(profile.gameBaseUrl) ||
        (id === 'era' ? 'https://game.erafn.dev' : ''),
      supportedSeasons: Array.isArray(profile.supportedSeasons)
        ? profile.supportedSeasons.filter((season) => /^ch\d{1,2}(?:-s\d{1,2}|-remix|-mini\d+)$/.test(season))
        : [],
      buildIds,
    }
  }

  function tokenStatus(providerId) {
    const id = normalizeProviderId(providerId)
    const record = readStore()[id]
    if (!record || typeof record !== 'object') {
      return {
        providerId: id,
        signedIn: false,
        displayName: null,
        avatarUrl: null,
        accountId: null,
        expiresAt: null,
        verificationCompleted: false,
      }
    }
    const signedIn = Boolean(
      safeText(record.refresh_token, 4096) ||
        (safeText(record.access_token, 8192) &&
          (!Number.isFinite(record.expires_at) || record.expires_at > Date.now())),
    )
    return {
      providerId: id,
      signedIn,
      displayName: safeText(record.display_name, 120) || null,
      avatarUrl: safeText(record.avatar_url, 2048) || null,
      accountId: safeText(record.account_id, 120) || null,
      expiresAt: Number.isFinite(record.expires_at) ? record.expires_at : null,
      verificationCompleted: record.verificationCompleted === true,
    }
  }

  function statuses() {
    const result = {}
    for (const provider of listProviders()) {
      if (!provider || !['oauth', 'deeplink', 'embedded_web'].includes(provider.auth)) continue
      result[provider.id] = tokenStatus(provider.id)
    }
    return result
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal })
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The provider did not answer in time. Try again.')
      throw new Error(`Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  function responseHeaderSnapshot(headers) {
    const snapshot = {}
    try {
      if (headers && typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
          snapshot[String(key)] = /^(?:set-cookie|authorization)$/i.test(String(key))
            ? '[redacted]'
            : String(value)
        })
      } else if (headers && typeof headers.entries === 'function') {
        for (const [key, value] of headers.entries()) {
          snapshot[String(key)] = /^(?:set-cookie|authorization)$/i.test(String(key))
            ? '[redacted]'
            : String(value)
        }
      } else if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          snapshot[String(key)] = /^(?:set-cookie|authorization)$/i.test(String(key))
            ? '[redacted]'
            : String(value)
        }
      }
    } catch {
      /* diagnostics must never hide the provider error */
    }
    return snapshot
  }

  function responseError(json, status, fallback, headers = null) {
    const detail =
      (json && typeof json.error === 'object' && (json.error.message || json.error.detail)) ||
      (typeof json?.error === 'string' && (json?.message || json?.error)) ||
      json?.errorMessage ||
      json?.message ||
      json?.detail ||
      fallback
    const error = new Error(String(detail || `The provider answered HTTP ${status}.`))
    error.status = status
    const accountStatus = accountStatusFor(json, status, String(detail || ''))
    const requiredAction =
      json?.required_action ??
      json?.requiredAction ??
      json?.details?.required_action ??
      (json?.error && typeof json.error === 'object' ? json.error.required_action : null)
    const requiredActionUrl =
      typeof requiredAction === 'string'
        ? requiredAction
        : requiredAction && typeof requiredAction === 'object'
          ? requiredAction.verification_url || requiredAction.verificationUrl || requiredAction.url
          : ''
    if (accountStatus === BUILD_VERIFICATION_STATUS) {
      // This is a game-file integrity answer, not an account status. Keep it
      // separate so the launch path cannot mistake it for a Discord/account
      // verification failure or clear the still-valid OAuth session.
      error.code = BUILD_VERIFICATION_STATUS
      error.buildVerificationRequired = true
    } else if (accountStatus) {
      error.code = accountStatus
      error.accountStatus = accountStatus
      error.verificationRequired = isVerificationStatus(accountStatus)
    }
    // Some providers attach the exact interactive verification destination to
    // the rejection. Use only that safe HTTPS URL; never fall back to a
    // bundled Discord invite.
    const suppliedVerificationUrl = verificationUrl(
      json?.verification_url ||
        json?.verificationUrl ||
        json?.details?.verification_url ||
        json?.details?.verificationUrl ||
        requiredActionUrl ||
        (json?.error && typeof json.error === 'object'
          ? json.error.verification_url || json.error.verificationUrl
          : ''),
    )
    if (suppliedVerificationUrl) error.verificationUrl = suppliedVerificationUrl
    if (accountStatus && isVerificationStatus(accountStatus)) {
      error.verificationDetails = {
        status,
        headers: responseHeaderSnapshot(headers),
        error: json?.error ?? null,
        message: detail,
        verification_url: suppliedVerificationUrl || null,
        required_action: requiredAction || null,
        body: json ?? null,
      }
    }
    return error
  }

  function logVerificationResponse(config, error) {
    if (!error?.verificationDetails) return
    const details = error.verificationDetails
    let key
    try {
      key = `${config.id}|${details.status}|${JSON.stringify(details.body)}`
    } catch {
      key = `${config.id}|${details.status}|${details.message}`
    }
    if (loggedVerificationResponses.has(key)) return
    loggedVerificationResponses.add(key)
    if (loggedVerificationResponses.size > 20) {
      const oldest = loggedVerificationResponses.values().next().value
      if (oldest) loggedVerificationResponses.delete(oldest)
    }
    try {
      console.warn(
        `[provider-auth] ${config.label} verification response: ${JSON.stringify(details)}`,
      )
    } catch {
      /* logging must not affect the account flow */
    }
  }

  async function requestJsonWithMeta(
    url,
    options = {},
    fallback = 'The provider rejected the request.',
  ) {
    const response = await fetchWithTimeout(url, options)
    const text = await response.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        if (!response.ok) throw responseError(null, response.status, fallback, response.headers)
        throw new Error('The provider returned an unreadable response. Try again.')
      }
    }
    if (!response.ok) {
      const error = responseError(json, response.status, fallback, response.headers)
      if (
        response.status === 401 &&
        !error.accountStatus &&
        error.verificationRequired !== true &&
        error.buildVerificationRequired !== true
      ) {
        error.code = PROVIDER_SESSION_EXPIRED
        error.sessionExpired = true
      }
      throw error
    }
    return { json, headers: response.headers, status: response.status }
  }

  async function requestJson(url, options = {}, fallback = 'The provider rejected the request.') {
    return (await requestJsonWithMeta(url, options, fallback)).json
  }

  async function tokenRequest(config, params) {
    if (!config.oauth?.tokenUrl) {
      throw new Error(`${config.label} uses a direct session and cannot refresh it here. Sign in again.`)
    }
    const url = new URL(config.oauth.tokenUrl)
    const json = config.oauth.tokenFormat === 'json'
    if (!json) url.searchParams.set('client_id', config.oauth.clientId)
    const fields = { ...params, client_id: config.oauth.clientId }
    return requestJson(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded',
        },
        body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
      },
      `${config.label} could not complete the account sign-in.`,
    )
  }

  function tokenRecord(config, token, previous = {}) {
    const accessToken = safeText(token?.access_token, 8192)
    if (!accessToken) throw new Error(`${config.label} did not return a session token.`)
    const expiresIn = Number(token?.expires_in)
    return {
      access_token: accessToken,
      refresh_token: safeText(token?.refresh_token, 4096) || safeText(previous.refresh_token, 4096),
      refresh_expires_at:
        Number(token?.refresh_expires_in) > 0
          ? Date.now() + Number(token.refresh_expires_in) * 1000
          : Number.isFinite(previous.refresh_expires_at)
            ? previous.refresh_expires_at
            : null,
      expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      display_name: safeText(previous.display_name, 120) || null,
      avatar_url: httpsUrl(previous.avatar_url),
      account_id: safeText(previous.account_id, 120) || null,
      // Keep the OAuth method for diagnostics. Verification pages are only
      // taken from the provider's verification_required response, never from
      // this method or a bundled invite.
      auth_method: ['discord', 'google'].includes(previous.auth_method)
        ? previous.auth_method
        : null,
      // Persist account-wide verified state so later Play clicks never force
      // the Discord/account-link step again.
      verificationCompleted: previous.verificationCompleted === true,
      updated_at: Date.now(),
    }
  }

  /** Token handed directly to the embedded page (Stellar/EZFN). */
  function directTokenRecord(config, accessToken, refreshToken, previous = {}) {
    const access = safeText(accessToken, 8192)
    if (!access) throw new Error(`${config.label} did not return a session token.`)
    return {
      access_token: access,
      refresh_token: safeText(refreshToken, 4096) || safeText(previous.refresh_token, 4096),
      refresh_expires_at: null,
      expires_at: null,
      display_name: safeText(previous.display_name, 120) || null,
      avatar_url: httpsUrl(previous.avatar_url),
      account_id: safeText(previous.account_id, 120) || null,
      auth_method: safeText(previous.auth_method, 20) || null,
      verificationCompleted: false,
      updated_at: Date.now(),
    }
  }

  function httpsUrl(value) {
    try {
      const url = new URL(String(value || '').trim())
      if (url.protocol !== 'https:' || url.username || url.password) return null
      return url.toString()
    } catch {
      return null
    }
  }

  function websocketUrl(value) {
    try {
      const url = new URL(String(value || '').trim())
      if (url.protocol !== 'wss:' || url.username || url.password) return null
      return url.toString().replace(/\/+$/, '')
    } catch {
      return null
    }
  }

  function verificationUrl(value) {
    const url = httpsUrl(value)
    if (!url) return null
    try {
      const host = new URL(url).hostname.toLowerCase()
      if (
        host === 'discord.com' ||
        host === 'discord.gg' ||
        host.endsWith('.discord.com') ||
        host.endsWith('.discord.gg')
      ) {
        return null
      }
    } catch {
      return null
    }
    return url
  }

  function firstText(...values) {
    for (const value of values) {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text) return text
    }
    return ''
  }

  function discordAvatar(profile) {
    const discord =
      profile?.discord && typeof profile.discord === 'object'
        ? profile.discord
        : profile?.connections?.discord && typeof profile.connections.discord === 'object'
          ? profile.connections.discord
          : profile?.user?.discord && typeof profile.user.discord === 'object'
            ? profile.user.discord
            : null
    const id = firstText(discord?.id, discord?.user_id, profile?.discord_id, profile?.discordId)
    const hash = firstText(discord?.avatar, discord?.avatar_hash, profile?.discord_avatar)
    if (!/^\d{5,32}$/.test(id)) return null
    if (hash && /^[A-Za-z0-9_]{10,64}$/.test(hash)) {
      const extension = hash.startsWith('a_') ? 'gif' : 'png'
      return `https://cdn.discordapp.com/avatars/${id}/${hash}.${extension}?size=128`
    }
    try {
      const index = Number(BigInt(id) >> 22n) % 6
      return `https://cdn.discordapp.com/embed/avatars/${index}.png`
    } catch {
      return null
    }
  }

  function profileIdentity(json, apiBaseUrl = '') {
    const root = json?.data ?? json
    const profile = root?.user && typeof root.user === 'object' ? { ...root, ...root.user } : root
    const account = profile?.account && typeof profile.account === 'object' ? profile.account : {}
    const accountId = safeText(
      firstText(
        profile?.id,
        profile?.user_id,
        profile?.userId,
        profile?.account_id,
        account.id,
        profile?.discord?.id,
      ),
      120,
    )
    const rawAvatar = firstText(
      profile?.avatar_url,
      profile?.avatarUrl,
      profile?.avatar,
      profile?.picture,
      profile?.picture_url,
      profile?.image_url,
      profile?.imageUrl,
      profile?.profile_picture,
      profile?.pfp,
      account.avatar_url,
      account.avatar,
    )
    const hashAvatar =
      /^\d{5,32}$/.test(accountId) && /^[A-Za-z0-9_]{10,64}$/.test(rawAvatar)
        ? `https://cdn.discordapp.com/avatars/${accountId}/${rawAvatar}.${
            rawAvatar.startsWith('a_') ? 'gif' : 'png'
          }?size=128`
        : null
    const absoluteAvatar =
      rawAvatar.startsWith('/') && apiBaseUrl ? new URL(rawAvatar, apiBaseUrl).toString() : rawAvatar
    const avatarUrl = httpsUrl(absoluteAvatar) || discordAvatar(profile) || hashAvatar
    return {
      displayName: safeText(
        firstText(
          profile?.display_name,
          profile?.displayName,
          profile?.global_name,
          profile?.username,
          profile?.name,
        ),
        120,
      ),
      avatarUrl,
      accountId,
    }
  }

  async function fetchProfile(config, accessToken) {
    if (!config.profilePath) return { displayName: '', avatarUrl: null, accountId: '' }
    try {
      const json = await requestJson(
        new URL(config.profilePath, config.apiBaseUrl),
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        },
        'The account profile could not be read.',
      )
      return profileIdentity(json, config.apiBaseUrl)
    } catch {
      return { displayName: '', avatarUrl: null, accountId: '' }
    }
  }

  async function accessToken(config, options = {}) {
    const store = readStore()
    const record = store[config.id]
    if (!record || typeof record !== 'object') {
      throw sessionExpiredError(config)
    }

    const access = safeText(record.access_token, 8192)
    if (
      options.force !== true &&
      access &&
      (!Number.isFinite(record.expires_at) || record.expires_at - TOKEN_REFRESH_MARGIN_MS > Date.now())
    ) {
      return access
    }

    const refresh = safeText(record.refresh_token, 4096)
    if (!refresh || !config.oauth?.tokenUrl) {
      clearToken(config.id)
      throw sessionExpiredError(config)
    }

    let token
    try {
      token = await tokenRequest(config, {
        grant_type: 'refresh_token',
        refresh_token: refresh,
      })
    } catch (error) {
      if (error?.status === 400 || error?.status === 401 || isSessionExpiredError(error)) {
        clearToken(config.id)
        throw sessionExpiredError(config, error)
      }
      throw error
    }

    const next = tokenRecord(config, token, record)
    writeStore({ ...readStore(), [config.id]: next })
    return next.access_token
  }

  /**
   * Force one silent rotating refresh before an online operation. A 400/401
   * from the refresh grant means the stored token is unusable, so clear it and
   * return a structured re-auth signal instead of a generic launch failure.
   */
  async function refreshSession(providerId) {
    const config = providerConfig(providerId)
    const record = readStore()[config.id]
    if (!record || typeof record !== 'object') throw sessionExpiredError(config)
    // Direct embedded sessions (for example Stellar) have no refresh grant.
    // A locally valid token is healthy; an expired one needs a fresh sign-in.
    if (!safeText(record.refresh_token, 4096) || !config.oauth?.tokenUrl) {
      const access = safeText(record.access_token, 8192)
      if (
        access &&
        (!Number.isFinite(record.expires_at) || record.expires_at - TOKEN_REFRESH_MARGIN_MS > Date.now())
      ) {
        return { ...tokenStatus(config.id), refreshed: false }
      }
      clearToken(config.id)
      throw sessionExpiredError(config)
    }
    await accessToken(config, { force: true })
    return { ...tokenStatus(config.id), refreshed: true }
  }

  /**
   * Force a rotating refresh-token grant so a Discord/Google account linked on
   * Era after login is picked up without any browser window. The existing
   * access token is kept if the refresh endpoint is temporarily unavailable.
   */
  async function refreshAccessToken(config, record) {
    const refresh = safeText(record?.refresh_token, 4096)
    if (!refresh) return null
    try {
      const token = await tokenRequest(config, {
        grant_type: 'refresh_token',
        refresh_token: refresh,
      })
      const next = tokenRecord(config, token, record)
      writeStore({ ...readStore(), [config.id]: next })
      return next.access_token
    } catch {
      // The caller can still retry the exchange with the current token. A
      // failed silent refresh must not sign the player out or open a window.
      return null
    }
  }

  async function silentVerificationRefresh(config, token) {
    let access = token
    const record = readStore()[config.id]
    if (record?.refresh_token) {
      const refreshed = await refreshAccessToken(config, record)
      if (refreshed) access = refreshed
    }

    // These are deliberately best-effort side effects: the exchange endpoint
    // remains the authoritative gate. Fetching the profile and validating the
    // token on the game host gives Era a chance to observe newly linked
    // Discord/Google accounts before we retry the exchange.
    const identity = await fetchProfile(config, access)
    if (identity.displayName || identity.avatarUrl || identity.accountId) {
      const current = readStore()[config.id]
      if (current && typeof current === 'object') {
        writeStore({
          ...readStore(),
          [config.id]: {
            ...current,
            display_name: identity.displayName || current.display_name || null,
            avatar_url: identity.avatarUrl || current.avatar_url || null,
            account_id: identity.accountId || current.account_id || null,
            updated_at: Date.now(),
          },
        })
      }
    }
    if (config.gameBaseUrl) {
      try {
        await requestJson(
          new URL('/account/api/oauth/verify', config.gameBaseUrl),
          {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${access}`,
            },
          },
          `${config.label} could not refresh the game session.`,
        )
      } catch {
        /* a game-host refresh is advisory, not a launch blocker */
      }
    }
    return access
  }

  async function trySilentVerificationRecovery(config, token, build) {
    const access = await silentVerificationRefresh(config, token)
    try {
      return { result: await gameCode(config, access, build), error: null }
    } catch (error) {
      return { result: null, error }
    }
  }

  function seasonNumber(seasonId) {
    const match = /^ch(\d{1,2})-s(\d{1,2})$/.exec(String(seasonId || ''))
    return match ? Number(match[2]) : null
  }

  function buildLabel(build) {
    const name = safeText(build?.name, 120)
    const version = safeText(build?.version, 40)
    return [name, version ? `v${version}` : ''].filter(Boolean).join(' ')
  }

  /** Keep manifest paths relative to the install root and Windows-safe. */
  function safeBuildRelativePath(value) {
    const raw = safeText(value, BUILD_RELATIVE_PATH_MAX).replace(/\\/g, '/')
    if (!raw || raw.startsWith('/') || /^[a-z]:/i.test(raw)) return ''
    const parts = raw.split('/')
    if (
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[<>:"|?*\x00-\x1f]/.test(part),
      )
    ) {
      return ''
    }
    return parts.join('/')
  }

  /** Content manifests list bare filenames, never subdirectories. */
  function safeBuildFileName(value) {
    const raw = safeText(value, 180)
    if (!raw || raw !== path.basename(raw)) return ''
    if (/[<>:"/\\|?*\x00-\x1f]/.test(raw) || raw === '.' || raw === '..') return ''
    return raw
  }

  function manifestSourceUrl(value) {
    return httpsUrl(value) || ''
  }

  /**
   * Era's `era-chunks-v3` manifest stores every file as an ordered list of
   * independently gzipped MD5-addressed chunks. Validate the whole list before
   * handing it to the downloader so a malformed manifest cannot create paths
   * outside the install folder or silently write a sparse file.
   */
  function parseBuildFileList(payload, label) {
    const root = payload?.data ?? payload
    if (!root || typeof root !== 'object') {
      throw new Error(`${label} returned an unreadable build manifest.`)
    }
    if (root.format && root.format !== BUILD_MANIFEST_FORMAT) {
      throw new Error(`${label} returned an unsupported build manifest (${safeText(root.format, 40)}).`)
    }
    const rawFiles = Array.isArray(root.fileList)
      ? root.fileList
      : Array.isArray(root.files)
        ? root.files
        : []
    if (rawFiles.length === 0) {
      throw new Error(`${label} returned an empty build manifest.`)
    }

    const files = []
    const seen = new Set()
    for (const item of rawFiles) {
      const relative = safeBuildRelativePath(item?.pathName ?? item?.path)
      if (!relative) {
        throw new Error(`${label} returned an unsafe file path in its build manifest.`)
      }
      if (seen.has(relative.toLowerCase())) {
        throw new Error(`${label} returned the same file twice in its build manifest.`)
      }
      seen.add(relative.toLowerCase())

      const size = Number(item?.size)
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`${label} returned an invalid size for ${relative}.`)
      }

      const chunks = []
      for (const itemChunk of Array.isArray(item?.chunkList) ? item.chunkList : []) {
        const hash = safeText(itemChunk?.hash, 32).toLowerCase()
        const offset = Number(itemChunk?.offset)
        const chunkSize = Number(itemChunk?.size)
        if (!BUILD_CHUNK_HASH.test(hash) || !Number.isSafeInteger(offset) || offset < 0) {
          throw new Error(`${label} returned an invalid chunk for ${relative}.`)
        }
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
          throw new Error(`${label} returned an invalid chunk size for ${relative}.`)
        }
        chunks.push({ hash, offset, size: chunkSize })
      }
      chunks.sort((a, b) => a.offset - b.offset)
      let nextOffset = 0
      for (const chunk of chunks) {
        if (chunk.offset !== nextOffset) {
          throw new Error(`${label} returned a gap in the chunks for ${relative}.`)
        }
        nextOffset += chunk.size
      }
      if (nextOffset !== size) {
        throw new Error(`${label} returned a chunk list that does not add up for ${relative}.`)
      }
      files.push({ path: relative, size, chunks })
    }
    return files
  }

  async function liveBuildManifest(config, token, build) {
    const authHeaders = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': providerUserAgent,
    }
    const manifestPath = `${config.buildsPath}/${encodeURIComponent(build.id)}/manifest`
    const response = await requestJson(
      new URL(manifestPath, config.apiBaseUrl),
      { headers: authHeaders },
      `${config.label} could not load the live build manifest.`,
    )
    const data = response?.data ?? response
    if (!data || typeof data !== 'object') {
      throw new Error(`${config.label} returned an unreadable build manifest.`)
    }
    if (data.format && data.format !== BUILD_MANIFEST_FORMAT) {
      throw new Error(`${config.label} returned an unsupported build manifest (${safeText(data.format, 40)}).`)
    }

    // The API returns a signed R2 URL and an API-proxied fallback. Prefer the
    // fallback: browser/Node fetch cannot add the R2 signature's required
    // x-amz-content-sha256 header, while the proxy accepts the provider token.
    const fallback = data.fallback && typeof data.fallback === 'object' ? data.fallback : {}
    const manifestUrl = manifestSourceUrl(fallback.manifest_url) || manifestSourceUrl(data.manifest_url)
    // The chunk base is public and long-lived; the fallback proxy URL expires
    // with the signed manifest and cannot carry a 26 GB download.
    const chunkBaseUrl =
      manifestSourceUrl(data.chunk_base_url) || manifestSourceUrl(fallback.chunk_base_url)
    if (!manifestUrl || !chunkBaseUrl) {
      throw new Error(`${config.label} did not return a usable build manifest or chunk source.`)
    }

    const manifest = await requestJson(
      manifestUrl,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
      `${config.label} could not download the live build manifest.`,
    )
    const files = parseBuildFileList(manifest, config.label)
    const contentSource = data.content && typeof data.content === 'object' ? data.content : null
    const contentManifestUrl = manifestSourceUrl(contentSource?.manifest_url)
    const contentBaseUrl = manifestSourceUrl(contentSource?.file_base_url)
    const contentFiles = []
    if (contentManifestUrl && contentBaseUrl) {
      const content = await requestJson(
        contentManifestUrl,
        { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
        `${config.label} could not load the live content manifest.`,
      )
      const changes = Array.isArray(content?.changes)
        ? content.changes
        : Array.isArray(content?.data?.changes)
          ? content.data.changes
          : []
      for (const change of changes) {
        const name = safeBuildFileName(change?.name)
        const size = Number(change?.size)
        if (!name || !Number.isSafeInteger(size) || size < 0) {
          throw new Error(`${config.label} returned an invalid content file in its live manifest.`)
        }
        const type = safeText(change?.type, 40).toUpperCase()
        if (type && !/DOWNLOAD|UPDATE/.test(type)) continue
        contentFiles.push({ name, size, hash: safeText(change?.hash, 64).toLowerCase() })
      }
    }

    const totalBytes =
      files.reduce((sum, file) => sum + file.size, 0) +
      contentFiles.reduce((sum, file) => sum + file.size, 0)
    return {
      buildId: build.id,
      buildName: safeText(manifest?.buildName, 120) || safeText(build.name, 120),
      buildVersion: safeText(build.version, 40),
      files,
      contentFiles,
      totalBytes,
      chunkBaseUrl,
      contentBaseUrl,
      expiresAt: safeText(data.expires_at, 80) || null,
    }
  }

  function chooseBuild(builds, config, seasonId, version) {
    const available = Array.isArray(builds) ? builds : []
    const requestedId = config.buildIds[seasonId]
    if (requestedId) {
      const exact = available.find((build) => String(build?.id).toLowerCase() === requestedId.toLowerCase())
      if (exact) return exact
    }

    const season = seasonNumber(seasonId)
    // Era's `season` field is not consistent across chapters (some builds use
    // the chapter-relative number, others the lifetime season number). Match
    // the same normalized key used by live discovery first.
    const mappedSeason = available.filter((build) => seasonIdForBuild(build) === seasonId)
    const matchingSeason =
      season == null ? [] : available.filter((build) => Number(build?.season) === season)
    const exactVersion = String(version || '')
    const matchingVersion = exactVersion
      ? available.filter((build) => String(build?.version || '') === exactVersion)
      : []

    let candidates =
      mappedSeason.length > 0
        ? mappedSeason
        : matchingSeason.length > 0
          ? matchingSeason
          : matchingVersion
    if (candidates.length === 0) {
      candidates = available.filter((build) => {
        const name = String(build?.name || '').toLowerCase()
        return season != null && name.includes(`season ${season}`)
      })
    }
    if (candidates.length === 0) {
      throw new Error(
        `${config.label} has no playable build for ${seasonId || 'this season'} on your account.`,
      )
    }

    const exact = exactVersion
      ? candidates.filter((build) => String(build?.version || '') === exactVersion)
      : []
    const pool = exact.length > 0 ? exact : candidates
    pool.sort((a, b) => {
      const publicScore = Number(Boolean(b?.public)) - Number(Boolean(a?.public))
      if (publicScore) return publicScore
      const versionScore = String(b?.version || '').localeCompare(String(a?.version || ''), undefined, {
        numeric: true,
      })
      if (versionScore) return versionScore
      return Number(b?.build_cl || 0) - Number(a?.build_cl || 0)
    })

    const build = pool[0]
    if (build?.access === 'restricted') {
      throw new Error(
        `${config.label} says this account cannot play ${buildLabel(build)}. Check your provider roles or whitelist.`,
      )
    }
    if (!UUID.test(String(build?.id || ''))) {
      throw new Error(`${config.label} returned a build without a usable ID. Try again in a moment.`)
    }
    return build
  }

  async function gameFilesToVerify(buildPath) {
    const root = path.resolve(buildPath)
    const files = []
    const add = async (relative) => {
      const stat = await fs.promises.stat(path.join(root, relative)).catch(() => null)
      if (stat?.isFile()) files.push(relative)
    }
    await add(GAME_VERIFY_EXE)

    const content = []
    const walk = async (relativeDir) => {
      let entries
      try {
        entries = await fs.promises.readdir(path.join(root, relativeDir), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const relative = `${relativeDir}/${entry.name}`
        if (entry.isDirectory()) await walk(relative)
        else if (entry.isFile() && GAME_VERIFY_EXT.test(entry.name)) content.push(relative)
      }
    }
    for (const relativeDir of GAME_VERIFY_ROOTS) await walk(relativeDir)
    content.sort()
    return [...files, ...content].slice(0, GAME_VERIFY_MAX_FILES)
  }

  function sha256File(file) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }

  async function gameFileHashes(buildPath) {
    const root = path.resolve(buildPath)
    const relativeFiles = await gameFilesToVerify(root)
    if (relativeFiles.length === 0) {
      throw new Error(
        `VAULTED could not find a Fortnite install to verify at ${root}. Download the build before launching.`,
      )
    }
    const fingerprint = (
      await Promise.all(
        relativeFiles.map(async (relative) => {
          const stat = await fs.promises.stat(path.join(root, ...relative.split('/'))).catch(() => null)
          return stat ? `${relative}:${stat.size}:${stat.mtimeMs}` : `${relative}:missing`
        }),
      )
    ).join('|')
    const cacheKey = root.toLowerCase()
    const cached = gameFileHashCache.get(cacheKey)
    if (cached?.fingerprint === fingerprint) return cached.files

    const results = new Array(relativeFiles.length)
    let next = 0
    const worker = async () => {
      while (next < relativeFiles.length) {
        const index = next++
        const relative = relativeFiles[index]
        results[index] = {
          path: relative,
          sha256: await sha256File(path.join(root, ...relative.split('/'))),
        }
      }
    }
    // Four streams is the same bounded parallelism Era's own launcher uses.
    await Promise.all(Array.from({ length: Math.min(4, relativeFiles.length) }, worker))
    gameFileHashCache.set(cacheKey, { fingerprint, files: results })
    return results
  }

  /** MD5/SHA-256 selected by the digest length published in Era's manifest. */
  function manifestHashAlgorithm(value) {
    const hash = safeText(value, 64).toLowerCase()
    if (!hash) return ''
    if (/^[a-f0-9]{32}$/.test(hash)) return 'md5'
    if (/^[a-f0-9]{64}$/.test(hash)) return 'sha256'
    return 'invalid'
  }

  async function readExactBytes(handle, length, position) {
    const buffer = Buffer.alloc(length)
    let total = 0
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, position + total)
      if (!bytesRead) break
      total += bytesRead
    }
    return total === length ? buffer : buffer.subarray(0, total)
  }

  function hashFileWithAlgorithm(file, algorithm) {
    return new Promise((resolve, reject) => {
      const digest = crypto.createHash(algorithm)
      const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      stream.on('data', (chunk) => digest.update(chunk))
      stream.on('end', () => resolve(digest.digest('hex')))
      stream.on('error', reject)
    })
  }

  /**
   * Compare one installed file with the provider's complete manifest entry.
   * Base files use every ordered MD5 chunk; content files use their published
   * MD5/SHA-256. Size is checked first so a truncated archive is reported
   * without reading gigabytes of wrong bytes.
   */
  async function verifyManifestEntry(root, relative, expectedSize, chunks, expectedHash, contentName = '') {
    const file = path.resolve(root, ...relative.split('/'))
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat?.isFile()) return { path: relative, kind: 'missing', expectedSize }
    if (stat.size !== expectedSize) {
      return { path: relative, kind: 'size', expectedSize, actualSize: stat.size }
    }

    // Era's content manifest hash is an identity of `<name>:<size>`, not a
    // digest of the PAK bytes. Match the launcher's own check exactly; a
    // content file with the wrong size still changes this identity.
    if (contentName) {
      const algorithm = manifestHashAlgorithm(expectedHash)
      if (algorithm === 'invalid') {
        return { path: relative, kind: 'hash-format', expectedHash }
      }
      const actualHash = crypto
        .createHash('md5')
        .update(`${contentName}:${stat.size}`)
        .digest('hex')
      if (actualHash !== String(expectedHash).toLowerCase()) {
        return { path: relative, kind: 'hash', expectedHash, actualHash, identity: true }
      }
      return null
    }

    if (chunks.length > 0) {
      let handle
      try {
        handle = await fs.promises.open(file, 'r')
        for (const chunk of chunks) {
          const buffer = await readExactBytes(handle, chunk.size, chunk.offset)
          if (buffer.length !== chunk.size) {
            return {
              path: relative,
              kind: 'size',
              expectedSize,
              actualSize: stat.size,
              chunkOffset: chunk.offset,
            }
          }
          const digest = crypto.createHash('md5').update(buffer).digest('hex')
          if (digest !== chunk.hash) {
            return {
              path: relative,
              kind: 'hash',
              expectedHash: chunk.hash,
              actualHash: digest,
              chunkOffset: chunk.offset,
            }
          }
        }
      } finally {
        await handle?.close().catch(() => {})
      }
    }

    if (expectedHash) {
      const algorithm = manifestHashAlgorithm(expectedHash)
      if (algorithm === 'invalid') {
        return { path: relative, kind: 'hash-format', expectedHash }
      }
      const actualHash = await hashFileWithAlgorithm(file, algorithm)
      if (actualHash !== String(expectedHash).toLowerCase()) {
        return { path: relative, kind: 'hash', expectedHash, actualHash, algorithm }
      }
    }

    return null
  }

  /**
   * Validate every expected base and content file, not just the executable and
   * first PAK set that Era's realtime build.verify checks. This is deliberately
   * run before the exchange so a bad archive cannot spend an exchange request.
   */
  async function verifyManifestTree(manifest, buildPath) {
    const root = path.resolve(buildPath)
    const entries = [
      ...(Array.isArray(manifest.files) ? manifest.files : []).map((file) => ({
        path: file.path,
        size: file.size,
        chunks: Array.isArray(file.chunks) ? file.chunks : [],
        hash: '',
      })),
      ...(Array.isArray(manifest.contentFiles) ? manifest.contentFiles : []).map((file) => ({
        path: `FortniteGame/Content/Paks/${file.name}`,
        size: file.size,
        chunks: [],
        hash: file.hash || '',
        contentName: file.name,
      })),
    ]

    const issues = []
    let checkedFiles = 0
    let bytes = 0
    let next = 0
    const worker = async () => {
      while (next < entries.length) {
        const entry = entries[next++]
        let issue
        try {
          issue = await verifyManifestEntry(
            root,
            entry.path,
            entry.size,
            entry.chunks,
            entry.hash,
            entry.contentName || '',
          )
        } catch (error) {
          issue = {
            path: entry.path,
            kind: 'read',
            error: error instanceof Error ? error.message : String(error),
          }
        }
        if (issue) issues.push(issue)
        else {
          checkedFiles += 1
          bytes += entry.size
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, entries.length)) }, worker))

    const missing = issues.filter((issue) => issue.kind === 'missing').length
    const sizeMismatches = issues.filter((issue) => issue.kind === 'size').length
    const hashMismatches = issues.filter((issue) => issue.kind === 'hash').length
    return {
      root,
      expectedFiles: entries.length,
      checkedFiles,
      bytes,
      ok: issues.length === 0,
      issueCount: issues.length,
      missing,
      sizeMismatches,
      hashMismatches,
      issues,
      mismatched: issues.map((issue) => issue.path),
      elapsedMs: 0,
    }
  }

  async function verifyBuildManifest(providerId, options = {}) {
    const config = providerConfig(providerId)
    const buildPath = safeText(options.buildPath, 2048)
    if (!buildPath) throw new Error('VAULTED did not receive the extracted build path to verify.')
    const manifest = await buildManifest(providerId, {
      seasonId: safeText(options.seasonId, 40),
      buildId: safeText(options.buildId, 64),
    })
    const startedAt = Date.now()
    const report = await verifyManifestTree(manifest, buildPath)
    return {
      providerId: config.id,
      providerLabel: config.label,
      buildId: manifest.buildId,
      buildName: manifest.buildName,
      buildVersion: manifest.buildVersion,
      ...report,
      elapsedMs: Date.now() - startedAt,
    }
  }

  async function sendBuildVerify(config, token, buildId, files) {
    if (!config.realtimeUrl) {
      throw new Error(`${config.label} did not provide a game-file verification service.`)
    }
    const url = `${config.realtimeUrl}/v1`
    return await new Promise((resolve, reject) => {
      let settled = false
      let verified = false
      let closed = false
      let socket = null
      let connectionId = 0
      let currentToken = token
      let verificationTimer = null
      let reconnectTimer = null
      let reconnectDelay = REALTIME_RECONNECT_BASE_MS
      let processTimer = null
      let keepaliveTimer = null
      let deadTimer = null
      let keepaliveBusy = false
      let socketVerified = false
      let forceTokenRefresh = false
      let gamePid = null
      let nextRef = 0

      const log = (message) =>
        console.log(`[provider-auth] ${config.label} realtime: ${message}`)

      function clearVerificationTimer() {
        if (!verificationTimer) return
        clearTimeout(verificationTimer)
        verificationTimer = null
      }

      function clearReconnectTimer() {
        if (!reconnectTimer) return
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      function clearProcessTimer() {
        if (!processTimer) return
        clearInterval(processTimer)
        processTimer = null
      }

      function clearKeepaliveTimer() {
        if (!keepaliveTimer) return
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }

      function clearDeadTimer() {
        if (!deadTimer) return
        clearTimeout(deadTimer)
        deadTimer = null
      }

      function close(reason = 'requested') {
        if (closed) return
        closed = true
        verified = false
        socketVerified = false
        clearVerificationTimer()
        clearReconnectTimer()
        clearProcessTimer()
        clearKeepaliveTimer()
        clearDeadTimer()
        const current = socket
        socket = null
        try {
          current?.close(1000)
        } catch {
          /* already closed */
        }
        log(`closed (${reason})`)
      }

      /**
       * The gateway pings every ~15s and treats 45s of silence as a dead link.
       * Reset this watchdog on every frame so a half-open socket reconnects
       * instead of silently leaving matchmaking registered to a dead session.
       */
      function touch() {
        clearDeadTimer()
        if (closed) return
        deadTimer = setTimeout(() => {
          deadTimer = null
          if (closed) return
          log(`no gateway traffic for ${REALTIME_DEAD_AFTER_MS}ms; reconnecting`)
          try {
            socket?.terminate()
          } catch {
            /* already gone */
          }
        }, REALTIME_DEAD_AFTER_MS)
        deadTimer.unref?.()
      }

      async function keepaliveTick() {
        if (closed || keepaliveBusy || !gamePid || !processIsAlive(gamePid)) return
        keepaliveBusy = true
        try {
          // Refresh just before expiry so a reconnect also carries a valid
          // token. The live socket stays authenticated; the next reconnect
          // uses this rotated token.
          const record = readStore()[config.id]
          if (
            Number.isFinite(record?.expires_at) &&
            record.expires_at - Date.now() <= REALTIME_TOKEN_REFRESH_MARGIN_MS
          ) {
            try {
              currentToken = await accessToken(config)
            } catch (error) {
              log(
                `token refresh failed during in-game keepalive: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
            }
          }
          if (closed || !socketVerified) return
          sendInGamePresence()
          const ws = socket
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping()
            } catch {
              /* the close handler will schedule the reconnect */
            }
          }
        } finally {
          keepaliveBusy = false
        }
      }

      function startKeepalive() {
        if (closed || keepaliveTimer) return
        keepaliveTimer = setInterval(() => void keepaliveTick(), REALTIME_KEEPALIVE_MS)
        keepaliveTimer.unref?.()
      }

      const session = {
        providerId: config.id,
        buildId,
        attachGameProcess(pid) {
          if (closed) return
          gamePid = Number(pid)
          if (!Number.isInteger(gamePid) || gamePid <= 0) {
            close('invalid game process id')
            return
          }
          clearProcessTimer()
          if (!processIsAlive(gamePid)) {
            close(`game process ${gamePid} already exited`)
            return
          }
          // The gateway session belongs to the client, not the launcher. Keep
          // it open for the complete process lifetime, including the period
          // after exchange-code and before the first lobby frame.
          processTimer = setInterval(() => {
            if (closed) return
            if (!processIsAlive(gamePid)) close(`game process ${gamePid} exited`)
          }, REALTIME_PROCESS_POLL_MS)
          startKeepalive()
          sendInGamePresence()
          log(`tracking game process ${gamePid}`)
        },
        /**
         * Drop the gateway socket and let the normal reconnect path build a
         * fresh Era session. Used after the game's login kills all other
         * account-client sessions, which otherwise leaves an open-looking but
         * revoked launcher socket whose presence Era ignores.
         */
        refresh(reason = 'requested') {
          if (closed) return
          log(`refreshing gateway session (${reason})`)
          clearDeadTimer()
          const ws = socket
          if (!ws) {
            scheduleReconnect(reason)
            return
          }
          try {
            ws.close(1000)
          } catch {
            scheduleReconnect(reason)
          }
        },
        close(reason = 'requested') {
          close(reason)
        },
        get active() {
          return !closed
        },
        get verified() {
          return verified
        },
      }

      function fail(error) {
        if (settled) {
          log(`gateway error after verification: ${error instanceof Error ? error.message : error}`)
          close('gateway error after verification')
          return
        }
        settled = true
        closed = true
        verified = false
        socketVerified = false
        clearVerificationTimer()
        clearReconnectTimer()
        clearProcessTimer()
        clearKeepaliveTimer()
        clearDeadTimer()
        const current = socket
        socket = null
        try {
          current?.close(1000)
        } catch {
          /* already closed */
        }
        reject(error)
      }

      function finish(error, reply) {
        if (error) {
          fail(error)
          return
        }
        if (settled) return
        settled = true
        verified = true
        socketVerified = true
        clearVerificationTimer()
        reconnectDelay = REALTIME_RECONNECT_BASE_MS
        if (reply && typeof reply === 'object') {
          // Keep the live socket out of the IPC result while letting the
          // launcher tie it to the game process it is about to start.
          Object.defineProperty(reply, 'realtimeSession', {
            value: session,
            enumerable: false,
            configurable: true,
          })
        }
        log('verified; keeping the gateway socket open for the game session')
        resolve(reply)
      }

      function scheduleReconnect(reason) {
        if (closed || reconnectTimer) return
        const delay = reconnectDelay
        reconnectDelay = Math.min(reconnectDelay * 2, REALTIME_RECONNECT_MAX_MS)
        log(`gateway socket closed (${reason}); reconnecting in ${delay}ms`)
        reconnectTimer = setTimeout(async () => {
          reconnectTimer = null
          if (closed) return
          const force = forceTokenRefresh
          forceTokenRefresh = false
          try {
            currentToken = await accessToken(config, { force })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log(`token refresh failed during reconnect: ${message}`)
            if (force && /expired|sign in again/i.test(message)) {
              close('session expired')
              return
            }
            scheduleReconnect('token refresh failed')
            return
          }
          if (closed) return
          connect()
        }, delay)
      }

      function replyToHeartbeat(ws, frame) {
        const ref = safeText(frame.ref, 80)
        const op = frame.op === 'ping' ? 'pong' : 'heartbeat.ack'
        const reply = { op, ...(ref ? { ref } : {}), d: frame.d ?? null }
        try {
          ws.send(JSON.stringify(reply))
          log(`${frame.op} -> ${op}`)
        } catch (error) {
          log(`could not answer ${frame.op}: ${error instanceof Error ? error.message : error}`)
        }
      }

      /**
       * Era's game host checks this presence on every auth verify. The official
       * launcher sends it once the client is running; without it the backend
       * answers `/account/api/oauth/verify` with 401 "The Era client isn't
       * running" after roughly a minute and kicks the player out of the lobby.
       */
      function sendInGamePresence() {
        const ws = socket
        if (closed || !socketVerified || !ws || ws.readyState !== WebSocket.OPEN) return
        try {
          ws.send(
            JSON.stringify({
              op: 'presence.set',
              d: {
                status: 'in_game',
                activity: {
                  build_id: buildId,
                  playlist: null,
                  party_size: null,
                  match_id: null,
                  since: new Date().toISOString(),
                },
              },
            }),
          )
          log('presence.set in_game')
        } catch (error) {
          log(`could not set in-game presence: ${error instanceof Error ? error.message : error}`)
        }
      }

      function connect() {
        if (closed) return
        const id = ++connectionId
        let ws
        try {
          ws = new WebSocket(url, {
            headers: {
              Authorization: `Bearer ${currentToken}`,
              'User-Agent': providerUserAgent,
            },
            handshakeTimeout: 15_000,
            maxPayload: 64 * 1024,
            // ws answers protocol-level ping frames automatically. App-level
            // gateway ping/heartbeat frames are answered below.
            autoPong: true,
          })
        } catch (error) {
          scheduleReconnect(error instanceof Error ? error.message : String(error))
          return
        }
        socket = ws
        socketVerified = false
        let sent = false
        const ref = String(++nextRef)
        const isCurrent = () => id === connectionId && socket === ws && !closed

        clearVerificationTimer()
        verificationTimer = setTimeout(() => {
          if (!isCurrent()) return
          if (!settled) {
            finish(new Error(`${config.label} did not answer the game-file check in time.`))
          } else {
            log('re-verification timed out; reconnecting')
            try {
              ws.close(1000)
            } catch {
              /* already closed */
            }
          }
        }, REALTIME_VERIFY_TIMEOUT_MS)

        ws.on('open', () => {
          if (!isCurrent()) return
          touch()
          log('gateway socket open')
        })
        ws.on('ping', () => {
          // ws has already queued the matching pong.
          if (!isCurrent()) return
          touch()
          log('gateway ping (pong sent)')
        })
        ws.on('pong', () => {
          if (isCurrent()) touch()
        })
        ws.on('message', (raw) => {
          if (!isCurrent()) return
          touch()
          let frame
          try {
            frame = JSON.parse(raw.toString())
          } catch {
            return
          }
          if (frame?.op === 'ping' || frame?.op === 'heartbeat') {
            replyToHeartbeat(ws, frame)
            return
          }
          if (frame?.op === 'session.revoked') {
            const reason = safeText(frame.d?.reason, 40) || 'revoked'
            if (reason === 'replaced' || reason === 'logout' || reason === 'banned') {
              close(`session ${reason}`)
            } else {
              // token_revoked: reconnect with a freshly rotated access token.
              forceTokenRefresh = true
              try {
                ws.close(1000)
              } catch {
                /* already closed */
              }
            }
            return
          }
          if (frame?.op === 'welcome' && !sent) {
            sent = true
            try {
              ws.send(
                JSON.stringify({
                  op: 'build.verify',
                  ref,
                  d: { build_id: buildId, files },
                }),
              )
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)))
            }
            return
          }
          if (frame?.ref !== ref) return
          if (frame.op === 'error') {
            const code = safeText(frame.d?.code, 80) || 'verification_failed'
            fail(new Error(`${config.label} could not verify the game files (${code}).`))
            return
          }
          if (frame.op !== 'build.verify.ok') {
            fail(new Error(`${config.label} returned an unexpected game-file check response.`))
            return
          }
          if (settled) {
            verified = true
            socketVerified = true
            clearVerificationTimer()
            reconnectDelay = REALTIME_RECONNECT_BASE_MS
            // A reconnect starts a new gateway session. Re-assert the game
            // presence so the backend does not treat the fresh socket as a
            // launcher that is merely sitting online.
            if (gamePid && processIsAlive(gamePid)) sendInGamePresence()
            log('gateway re-verified after reconnect')
            return
          }
          finish(null, frame.d)
        })
        ws.on('error', (error) => {
          if (!isCurrent()) return
          const message = error instanceof Error ? error.message : String(error)
          if (!settled) fail(error instanceof Error ? error : new Error(message))
          else log(`gateway error: ${message}`)
        })
        ws.on('close', (code, reason) => {
          if (socket === ws) socket = null
          if (!isCurrent() && (closed || id !== connectionId)) return
          clearVerificationTimer()
          clearDeadTimer()
          socketVerified = false
          const detail = `${code || 'unknown'}${reason ? ` ${reason}` : ''}`
          if (closed) return
          if (!settled) {
            fail(new Error(`${config.label} closed the game-file check connection (${detail}).`))
            return
          }
          if (code === 4409) {
            close('session replaced on another computer')
            return
          }
          if (code === 4401 || code === 4403) forceTokenRefresh = true
          scheduleReconnect(detail)
        })
      }

      connect()
    })
  }

  async function verifyLocalBuild(config, token, build, buildPath) {
    if (!buildPath) {
      const error = new Error(
        `${config.label} requires a game-file integrity check, but VAULTED did not receive the installed build path.`,
      )
      error.code = BUILD_VERIFICATION_STATUS
      error.buildVerificationRequired = true
      throw error
    }
    const files = gameFileHashesImpl
      ? await gameFileHashesImpl(buildPath)
      : await gameFileHashes(buildPath)
    const result = buildVerifyImpl
      ? await buildVerifyImpl({ config, token, build, buildPath, files })
      : await sendBuildVerify(config, token, build.id, files)
    if (result?.ok === true) return result
    const mismatched = Array.isArray(result?.mismatched) ? result.mismatched : []
    const detail = mismatched.length
      ? `${mismatched.length} file(s) do not match ${buildLabel(build)}: ${mismatched.slice(0, 5).join(', ')}${mismatched.length > 5 ? ', …' : ''}`
      : `the files do not match ${buildLabel(build)}`
    const error = new Error(
      `${config.label} rejected the installed game files: ${detail}. Download or repair the matching build before launching.`,
    )
    error.code = BUILD_VERIFICATION_STATUS
    error.buildVerificationRequired = true
    error.buildVerificationMismatches = mismatched
    // Keep the verified build's identity with the failure. The renderer uses
    // this to offer the exact live-version repair button without trusting a
    // local folder name (6.31 versus Era's 6.21, for example).
    error.buildId = build.id
    error.buildVersion = safeText(build.version, 40)
    error.buildName = safeText(build.name, 120)
    throw error
  }

  async function gameCode(config, token, build) {
    let response
    try {
      response = await requestJsonWithMeta(
        new URL(config.exchangeCodePath, config.apiBaseUrl),
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': providerUserAgent,
          },
          body: JSON.stringify({ build_id: build.id }),
        },
        `${config.label} could not create a game login code.`,
      )
    } catch (error) {
      // A 403 can mean the account is valid but needs verification. That is a
      // fixable account state, not an expired session, so preserve the
      // structured status for the interactive verification flow instead of
      // clearing the token or surfacing a raw provider code.
      if (error?.accountStatus || error?.verificationRequired || error?.buildVerificationRequired) {
        if (!error?.buildVerificationRequired) logVerificationResponse(config, error)
        throw error
      }
      if (isSessionExpiredError(error)) {
        // Keep the encrypted refresh token until the caller has had one chance
        // to rotate it. If rotation is rejected, accessToken clears the record
        // and raises the structured re-auth signal.
        throw sessionExpiredError(config, error)
      }
      throw error
    }

    const payload = response.json?.data ?? response.json
    // Some APIs return an account-status error in a 200 envelope. Preserve it
    // before failing on the missing one-time code.
    if (payload?.error || accountStatusFor(payload, 200, '')) {
      const envelopeError = responseError(
        payload,
        200,
        `${config.label} could not create a game login code.`,
        response.headers,
      )
      if (envelopeError.accountStatus || envelopeError.buildVerificationRequired) {
        if (!envelopeError.buildVerificationRequired) logVerificationResponse(config, envelopeError)
        throw envelopeError
      }
    }
    const code = safeText(payload?.code, 4096)
    if (!code || !/^[A-Za-z0-9._~+/=-]{8,4096}$/.test(code)) {
      throw new Error(`${config.label} returned an invalid one-time login code. Try Play again.`)
    }

    return {
      code,
      expiresIn: Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : 300,
      buildId: build.id,
      buildName: buildLabel(build),
    }
  }

  function verificationBuild(builds, config) {
    const available = Array.isArray(builds) ? builds : []
    for (const seasonId of config.supportedSeasons) {
      try {
        return chooseBuild(available, config, seasonId, '')
      } catch {
        /* try the next configured season */
      }
    }
    return (
      available.find(
        (build) =>
          UUID.test(String(build?.id || '')) && build?.access !== 'restricted' && build?.public !== false,
      ) ||
      available.find((build) => UUID.test(String(build?.id || '')) && build?.access !== 'restricted') ||
      null
    )
  }

  function verificationPageFor(_config, _method, error = null) {
    // Only a URL returned by Era's verification_required response may be
    // opened. There is intentionally no Discord/Era fallback here: Play must
    // never launch an embedded invite page on its own.
    return verificationUrl(error?.verificationUrl)
  }

  function openVerificationWindow(config, url, parentWindow = null) {
    const state = {
      closed: false,
      failure: null,
      close: () => {},
    }
    const parent =
      parentWindow && !parentWindow.isDestroyed()
        ? parentWindow
        : typeof getParentWindow === 'function'
          ? getParentWindow()
          : null
    const hasParent = Boolean(parent && !parent.isDestroyed())
    // A verification window opened from the sign-in modal cannot itself be a
    // modal child of that transient modal on every Electron version. Keep it
    // parented/centered and non-blocking in that case; launch-time verification
    // (parented to the main window) remains modal.
    const parentIsModal = Boolean(
      parent && typeof parent.isModal === 'function' && parent.isModal(),
    )
    const width = 560
    const height = 760
    const bounds = hasParent ? parent.getBounds() : null
    let win = null
    let authView = null
    let viewReady = false
    let closing = false

    const close = () => {
      if (closing) return
      closing = true
      state.closed = true
      try {
        if (authView) {
          try {
            if (win && !win.isDestroyed()) win.contentView.removeChildView(authView)
          } catch {
            /* the window is already gone */
          }
          authView.webContents.close()
        }
      } catch {
        /* already closed */
      }
      authView = null
      try {
        if (win && !win.isDestroyed()) win.destroy()
      } catch {
        /* already gone */
      }
    }
    state.close = close

    try {
      win = new BrowserWindow({
        width,
        height,
        minWidth: 420,
        minHeight: 580,
        show: false,
        frame: false,
        autoHideMenuBar: true,
        backgroundColor: '#0B0F14',
        title: 'VAULTED · SECURE ACCOUNT LINK',
        parent: hasParent ? parent : undefined,
        modal: hasParent && !parentIsModal,
        center: !hasParent,
        ...(bounds
          ? {
              x: Math.max(0, Math.round(bounds.x + (bounds.width - width) / 2)),
              y: Math.max(0, Math.round(bounds.y + (bounds.height - height) / 2)),
            }
          : {}),
        roundedCorners: true,
        hasShadow: true,
        webPreferences: {
          preload: path.join(__dirname, 'providerAuthShell.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      })
    } catch (error) {
      state.failure = new Error(
        `VAULTED could not open the ${config.label} verification window: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      state.closed = true
      return state
    }

    win.setMenuBarVisibility(false)
    win.once('ready-to-show', () => {
      if (!state.closed && win && !win.isDestroyed()) win.show()
    })
    win.on('closed', () => {
      state.closed = true
      try {
        authView?.webContents.close()
      } catch {
        /* already closed */
      }
      authView = null
    })
    if (hasParent) parent.once('closed', close)
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !state.closed) {
        event.preventDefault()
        close()
      }
    })

    if (typeof WebContentsView === 'function') {
      const layout = () => {
        if (!authView || state.closed || !win || win.isDestroyed()) return
        const [contentWidth, contentHeight] = win.getContentSize()
        authView.setBounds({
          x: 0,
          y: 54,
          width: Math.max(0, contentWidth),
          height: Math.max(0, contentHeight - 54),
        })
      }
      const attachView = () => {
        if (state.closed || viewReady) return
        viewReady = true
        try {
          win.contentView.addChildView(authView)
          layout()
        } catch (error) {
          state.failure = new Error(
            `VAULTED could not show the ${config.label} verification page: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
          close()
        }
      }

      win.on('resize', layout)
      authView = new WebContentsView({
        webPreferences: {
          partition: `persist:provider-auth-${config.id}`,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      })
      authView.setBackgroundColor?.('#0B0F14')
      const contents = authView.webContents
      contents.setWindowOpenHandler(({ url: openedUrl }) => {
        if (/^https?:\/\//i.test(openedUrl)) void contents.loadURL(openedUrl).catch(() => {})
        return { action: 'deny' }
      })
      contents.on('did-finish-load', attachView)
      contents.on('did-fail-load', (_event, codeValue, description, _url, isMainFrame) => {
        if (isMainFrame && codeValue !== -3 && !state.closed) {
          state.failure = new Error(
            `${config.label} verification page could not load (${description || codeValue}).`,
          )
          close()
        }
      })

      void win
        .loadFile(path.join(__dirname, 'providerAuthShell.html'), {
          query: { provider: config.label, mode: 'verification' },
        })
        .catch((error) => {
          state.failure = new Error(
            `VAULTED could not open its verification window: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
          close()
        })
      void contents.loadURL(url).catch((error) => {
        state.failure = new Error(
          `${config.label} verification page could not load: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        close()
      })
    } else {
      void win.loadURL(url).catch((error) => {
        state.failure = new Error(
          `${config.label} verification page could not load: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        close()
      })
    }

    return state
  }

  async function completeVerification(config, token, build, originalError, parentWindow = null) {
    const method = safeText(readStore()[config.id]?.auth_method, 20)
    const url = verificationPageFor(config, method, originalError)
    if (!url) throw originalError
    const window = openVerificationWindow(config, url, parentWindow)
    try {
      const deadline = Date.now() + verificationTimeoutMs
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, verificationPollMs))
        if (window.failure) throw window.failure
        if (window.closed) {
          throw new Error(`${config.label} verification was closed before it finished.`)
        }
        try {
          const result = await gameCode(config, token, build)
          if (window.closed) {
            throw new Error(`${config.label} verification was closed before it finished.`)
          }
          return result
        } catch (error) {
          if (isVerificationFailure(error)) continue
          // A short verification poll can hit the exchange rate limit. Keep
          // the window open and try again on the next interval.
          if (error?.status === 429) continue
          throw error
        }
      }
      throw new Error(
        `${config.label} verification is still pending. Complete it in the verification window, then try Play again.`,
      )
    } finally {
      window.close()
    }
  }

  function codeCacheKey(config, build) {
    return `${config.id}|${build.id}`
  }

  function takeVerificationCode(config, build) {
    const key = codeCacheKey(config, build)
    const cached = verificationCodes.get(key)
    if (!cached) return null
    verificationCodes.delete(key)
    if (cached.cachedUntil <= Date.now()) return null
    const { cachedUntil: _cachedUntil, ...result } = cached
    return result
  }

  function cacheVerificationCode(config, build, result) {
    const expiresIn = Number(result?.expiresIn) > 0 ? Number(result.expiresIn) : 300
    verificationCodes.set(codeCacheKey(config, build), {
      ...result,
      cachedUntil: Date.now() + Math.max(0, expiresIn * 1000 - 10_000),
    })
  }

  function markVerificationCompleted(config) {
    const store = { ...readStore() }
    const record = store[config.id]
    if (!record || typeof record !== 'object' || record.verificationCompleted === true) return
    try {
      writeStore({
        ...store,
        [config.id]: { ...record, verificationCompleted: true, updated_at: Date.now() },
      })
    } catch {
      // A failed persistence write must not undo a successful launch code.
    }
  }

  function rememberVerification(config, build, error) {
    const url = verificationUrl(error?.verificationUrl)
    if (!url) return null
    const key = codeCacheKey(config, build)
    pendingVerifications.set(key, { url, error, createdAt: Date.now() })
    return url
  }

  function takePendingVerification(config, build) {
    const key = codeCacheKey(config, build)
    const pending = pendingVerifications.get(key)
    if (!pending) return null
    pendingVerifications.delete(key)
    if (Date.now() - pending.createdAt > VERIFICATION_TIMEOUT_MS) return null
    if (!verificationUrl(pending.url)) return null
    return pending
  }

  async function verifyAfterLogin(config, token, _parentWindow = null) {
    let build = null
    try {
      const buildsJson = await requestJson(
        new URL(config.buildsPath, config.apiBaseUrl),
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        },
        `${config.label} could not list its live builds.`,
      )
      const builds = Array.isArray(buildsJson?.data)
        ? buildsJson.data
        : Array.isArray(buildsJson)
          ? buildsJson
          : []
      build = verificationBuild(builds, config)
    } catch {
      // A transient build-list failure must not fail an otherwise valid link.
      return
    }
    if (!build) return

    let result
    try {
      result = await gameCode(config, token, build)
    } catch (error) {
      if (!isVerificationFailure(error)) return
      logVerificationResponse(config, error)
      // Try to recognize a Discord/Google link completed on Era without
      // showing any window. If it still needs interaction, leave the session
      // signed in and let the explicit Verify Account action handle it.
      const recovery = await trySilentVerificationRecovery(config, token, build)
      if (!recovery.result) return
      result = recovery.result
    }
    markVerificationCompleted(config)
    // Keep the verified code for the launch that normally follows sign-in, so
    // the immediate Play/auto-launch does not spend a second exchange request.
    cacheVerificationCode(config, build, result)
  }

  /**
   * Live builds available to the signed-in provider account. The renderer
   * uses this only to widen a provider's supported season keys; launch and
   * manifest resolution still go through the authenticated main process.
   */
  async function listBuilds(providerId) {
    const config = providerConfig(providerId)
    const token = await accessToken(config)
    const payload = await requestJson(
      new URL(config.buildsPath, config.apiBaseUrl),
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': providerUserAgent,
        },
      },
      `${config.label} could not list its live builds.`,
    )
    const seen = new Set()
    const builds = []
    for (const build of buildList(payload)) {
      const id = safeText(build?.id, 64)
      const seasonId = seasonIdForBuild(build)
      if (!UUID.test(id) || !seasonId || build?.access === 'restricted' || seen.has(seasonId)) continue
      seen.add(seasonId)
      builds.push({
        id,
        name: safeText(build?.name, 160) || safeText(build?.version, 40) || 'Era build',
        version: safeText(build?.version, 40),
        seasonId,
        ...(Number.isFinite(Number(build?.size_bytes)) && Number(build.size_bytes) > 0
          ? { sizeBytes: Number(build.size_bytes) }
          : {}),
      })
    }
    return builds.sort((a, b) => a.seasonId.localeCompare(b.seasonId))
  }

  async function buildManifest(providerId, options = {}) {
    const config = providerConfig(providerId)
    const token = await accessToken(config)
    const buildsJson = await requestJson(
      new URL(config.buildsPath, config.apiBaseUrl),
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      `${config.label} could not list its live builds.`,
    )
    const builds = Array.isArray(buildsJson?.data)
      ? buildsJson.data
      : Array.isArray(buildsJson)
        ? buildsJson
        : []
    const requestedId = safeText(options.buildId, 64)
    let build = requestedId
      ? builds.find((candidate) => String(candidate?.id).toLowerCase() === requestedId.toLowerCase())
      : null
    if (!build) build = chooseBuild(builds, config, safeText(options.seasonId, 40), '')
    const manifest = await liveBuildManifest(config, token, build)
    return {
      providerId: config.id,
      providerLabel: config.label,
      ...manifest,
    }
  }

  /** Main-process headers for manifest/chunk downloads; never sent to the renderer. */
  async function resourceHeaders(providerId) {
    const config = providerConfig(providerId)
    const token = await accessToken(config)
    return {
      Accept: '*/*',
      Authorization: `Bearer ${token}`,
      'User-Agent': providerUserAgent,
    }
  }

  /**
   * Retrac's current launcher authenticates its WebSocket with the OAuth
   * access token and asks for a one-time game code. The reply carries the code
   * under `id: 'code'`; provider-specific state never crosses IPC.
   */
  function retracGameCode(config, token) {
    return new Promise((resolve, reject) => {
      let socket = null
      let settled = false
      const timer = setTimeout(() => {
        finish(new Error(`${config.label} did not answer with a game code in time. Try Play again.`))
      }, PROVIDER_CODE_TIMEOUT_MS)

      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          socket?.removeAllListeners()
          socket?.close()
        } catch {
          /* already closed */
        }
        if (error) reject(error)
        else resolve(result)
      }

      try {
        const encoded = Buffer.from(token, 'utf8').toString('base64')
        socket = new WebSocket(
          `${RETRAC_LAUNCHER_SOCKET}?token=${encodeURIComponent(encoded)}`,
          { handshakeTimeout: PROVIDER_CODE_TIMEOUT_MS },
        )
      } catch (error) {
        finish(new Error(`${config.label} could not open its launcher socket: ${error instanceof Error ? error.message : String(error)}`))
        return
      }

      socket.once('open', () => {
        try {
          socket.send(JSON.stringify({ id: 'request_code', version: RETRAC_LAUNCHER_VERSION }))
        } catch (error) {
          finish(new Error(`${config.label} could not request a game code: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
      socket.on('message', (raw) => {
        let message
        try {
          message = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (!message || typeof message !== 'object') return
        if (message.id === 'error' || message.error || message.code === 4002) {
          const cause = new Error(
            `${config.label} rejected the game-code request: ${safeText(message.error || message.message, 300) || 'unknown error'}`,
          )
          cause.code = message.code === 4002 ? 4002 : safeText(message.code, 80) || 'provider_error'
          finish(isSessionExpiredError(cause) ? sessionExpiredError(config, cause) : cause)
          return
        }
        if (message.id !== 'code') return
        const code = safeText(message.code, 4096)
        if (!code) {
          finish(new Error(`${config.label} returned an empty game code.`))
          return
        }
        finish(null, code)
      })
      socket.once('error', (error) => {
        finish(new Error(`${config.label} launcher socket failed: ${error instanceof Error ? error.message : String(error)}`))
      })
      socket.once('close', (code, reason) => {
        if (settled) return
        const detail = `${code || 'unknown'}${reason?.length ? ` ${reason.toString()}` : ''}`
        const cause = new Error(
          `${config.label} closed the launcher socket before returning a game code (${detail}).`,
        )
        cause.retracCloseCode = code
        cause.code = code
        finish(isSessionExpiredError(cause) ? sessionExpiredError(config, cause) : cause)
      })
    })
  }

  /**
   * EZFN exposes the standard Epic OAuth exchange route on its game host. The
   * embedded sign-in already returned the account access token, so the launch
   * code is the same exchange code the shipped client would request.
   */
  async function ezfnGameCode(config, token, onResponse = null) {
    const exchange = await requestJsonWithMeta(
      new URL('/account/api/oauth/exchange', config.apiBaseUrl),
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': providerUserAgent,
        },
      },
      `${config.label} could not create a game login code.`,
    )
    if (typeof onResponse === 'function') onResponse(exchange.status)
    const payload = exchange.json?.data ?? exchange.json
    const code = safeText(payload?.code, 4096)
    if (!code) {
      throw new Error(`${config.label} returned an invalid one-time login code. Try Play again.`)
    }
    return {
      code,
      expiresIn: Number(payload?.expiresIn || payload?.expires_in) > 0
        ? Number(payload.expiresIn || payload.expires_in)
        : 300,
    }
  }

  async function exchangeCode(providerId, options = {}) {
    const config = providerConfig(providerId)
    const stored = readStore()[config.id]
    const shouldRefreshFirst =
      Boolean(stored?.refresh_token && config.oauth?.tokenUrl) &&
      (!Number.isFinite(stored?.expires_at) ||
        stored.expires_at - TOKEN_REFRESH_MARGIN_MS <= Date.now())
    let token = await accessToken(config, shouldRefreshFirst ? { force: true } : {})
    const seasonId = safeText(options.seasonId, 40)

    /** Run a handshake, then rotate once if the backend hard-rejects the token. */
    const withSessionRefresh = async (operation, initialToken = token) => {
      try {
        return await operation(initialToken)
      } catch (error) {
        if (!isSessionExpiredError(error)) throw error
        let refreshed
        try {
          refreshed = await accessToken(config, { force: true })
        } catch (refreshError) {
          throw isSessionExpiredError(refreshError)
            ? sessionExpiredError(config, refreshError?.cause || error)
            : refreshError
        }
        try {
          return await operation(refreshed)
        } catch (retryError) {
          throw isSessionExpiredError(retryError)
            ? sessionExpiredError(config, retryError?.cause || retryError)
            : retryError
        }
      }
    }
    const version = safeText(options.version, 40)
    const buildPath = safeText(options.buildPath, 2048)

    // These two providers have a launcher-side code exchange rather than
    // Era's build-list and realtime build.verify flow. Keep their handshakes
    // isolated so the proven Era path above is unchanged.
    if (config.id === 'retrac') {
      const code = await withSessionRefresh((fresh) => retracGameCode(config, fresh))
      const launchToken = await accessToken(config).catch(() => token)
      const result = {
        code,
        expiresIn: 300,
        buildId: '',
        buildName: safeText(`${seasonId || 'Retrac'} ${version || ''}`, 120),
      }
      Object.defineProperty(result, 'authToken', {
        value: launchToken,
        enumerable: false,
        configurable: true,
      })
      return result
    }
    if (config.id === 'stellar') {
      // Stellar exposes the standard Epic OAuth exchange host route. The
      // Discord callback already returned the account token, so this is the
      // same one-time game code the official launcher requests before launch.
      const endpoint = new URL('/account/api/oauth/exchange', config.apiBaseUrl).toString()
      const startedAt = Date.now()
      let responseStatus = null
      const baseDiagnostic = {
        event: 'provider_exchange',
        schemaVersion: 1,
        operation: 'stellar_oauth_exchange',
        providerId: config.id,
        endpoint,
        method: 'GET',
        request: {
          accept: 'application/json',
          authorization: 'Bearer [redacted]',
          userAgent: providerUserAgent,
          body: null,
        },
      }
      try {
        const result = await withSessionRefresh((fresh) =>
          ezfnGameCode(config, fresh, (status) => {
            responseStatus = status
          }),
        )
        emitDiagnostic({
          ...baseDiagnostic,
          ok: true,
          status: responseStatus,
          durationMs: Date.now() - startedAt,
          codeLength: result.code.length,
          expiresIn: result.expiresIn,
        })
        result.buildId = ''
        result.buildName = safeText(`${seasonId || 'Stellar'} ${version || ''}`, 120)
        return result
      } catch (error) {
        emitDiagnostic({
          ...baseDiagnostic,
          ok: false,
          status: Number.isInteger(error?.status) ? error.status : responseStatus,
          durationMs: Date.now() - startedAt,
          error: {
            name: safeText(error?.name, 80) || 'Error',
            code: safeText(error?.code, 80) || null,
            accountStatus: safeText(error?.accountStatus, 80) || null,
            verificationRequired: error?.verificationRequired === true,
            message: redactDiagnosticText(error?.cause?.message || error?.message, [token]),
          },
        })
        throw error
      }
    }
    if (config.id === 'ezfn') {
      const result = await withSessionRefresh((fresh) => ezfnGameCode(config, fresh))
      result.buildId = ''
      result.buildName = safeText(`${seasonId || 'EZFN'} ${version || ''}`, 120)
      return result
    }

    let buildsJson
    try {
      buildsJson = await requestJson(
        new URL(config.buildsPath, config.apiBaseUrl),
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        },
        `${config.label} could not list its live builds.`,
      )
    } catch (error) {
      if (!isSessionExpiredError(error)) throw error
      token = await accessToken(config, { force: true })
      buildsJson = await requestJson(
        new URL(config.buildsPath, config.apiBaseUrl),
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        },
        `${config.label} could not list its live builds.`,
      )
    }
    const builds = Array.isArray(buildsJson?.data)
      ? buildsJson.data
      : Array.isArray(buildsJson)
        ? buildsJson
        : []
    const build = chooseBuild(builds, config, seasonId, version)

    const cached = takeVerificationCode(config, build)
    let realtimeSession = null
    const withRealtimeSession = (result) => {
      if (realtimeSession && result && typeof result === 'object') {
        // This handle is consumed by the main process immediately after the
        // exchange. It must never cross IPC or be serialized for the renderer.
        Object.defineProperty(result, 'realtimeSession', {
          value: realtimeSession,
          enumerable: false,
          configurable: true,
        })
      }
      return result
    }

    // The realtime build.verify socket authenticates with the same OAuth
    // token. Rotate once if it closes with an expiry code before the exchange.
    const verifyWithSession = async () => {
      try {
        return await verifyLocalBuild(config, token, build, buildPath)
      } catch (error) {
        if (!isSessionExpiredError(error)) throw error
        token = await accessToken(config, { force: true })
        return await verifyLocalBuild(config, token, build, buildPath)
      }
    }

    if (cached) {
      // A cached code is still a real game launch. Re-open the verified
      // gateway session so Era does not see a running client with no client
      // connection and kick it after roughly a minute.
      if (buildPath && config.realtimeUrl) {
        const verification = await verifyWithSession()
        realtimeSession = verification.realtimeSession || null
      }
      return withRealtimeSession(cached)
    }

    // Match the official launcher's order: build.verify runs before the
    // exchange when the installed folder is known. This avoids spending an
    // exchange request just to be told the same gate applies.
    let buildVerified = false
    if (buildPath && config.realtimeUrl) {
      const verification = await verifyWithSession()
      realtimeSession = verification.realtimeSession || null
      buildVerified = true
    }

    try {
      const result = await gameCode(config, token, build)
      markVerificationCompleted(config)
      return withRealtimeSession(result)
    } catch (error) {
      // A backend can revoke an access token before its advertised expiry. If
      // the exchange says the token is invalid, rotate it once and rebuild the
      // verified gateway session before retrying the exchange.
      if (isSessionExpiredError(error)) {
        let freshToken
        try {
          freshToken = await accessToken(config, { force: true })
        } catch (refreshError) {
          realtimeSession?.close('session refresh required')
          throw isSessionExpiredError(refreshError)
            ? sessionExpiredError(config, refreshError)
            : refreshError
        }
        realtimeSession?.close('session token rotated')
        realtimeSession = null
        if (buildPath && config.realtimeUrl) {
          const verification = await verifyLocalBuild(config, freshToken, build, buildPath)
          realtimeSession = verification.realtimeSession || null
        }
        try {
          const result = await gameCode(config, freshToken, build)
          markVerificationCompleted(config)
          return withRealtimeSession(result)
        } catch (retryError) {
          realtimeSession?.close('session retry failed')
          throw isSessionExpiredError(retryError)
            ? sessionExpiredError(config, retryError)
            : retryError
        }
      }
      // Era's exchange endpoint is gated on a successful realtime
      // `build.verify` for the installed files. This is not an account
      // verification state, so verify the build and retry the exchange once.
      if (error?.buildVerificationRequired) {
        if (!buildVerified) {
          realtimeSession?.close('build verification retry')
          const verification = await verifyWithSession()
          realtimeSession = verification.realtimeSession || null
        }
        const result = await gameCode(config, token, build)
        markVerificationCompleted(config)
        return withRealtimeSession(result)
      }
      if (!isVerificationFailure(error)) {
        realtimeSession?.close('exchange failed')
        throw error
      }
      logVerificationResponse(config, error)
      const recovery = await trySilentVerificationRecovery(config, token, build)
      if (recovery.result) {
        markVerificationCompleted(config)
        return withRealtimeSession(recovery.result)
      }
      const finalError =
        recovery.error && isVerificationFailure(recovery.error) ? recovery.error : error
      if (!finalError.verificationUrl && error?.verificationUrl) {
        finalError.verificationUrl = error.verificationUrl
      }
      logVerificationResponse(config, finalError)
      // Remember the exact provider-supplied HTTPS page for the explicit
      // Verify Account action. Do not open it from Play.
      rememberVerification(config, build, finalError)
      realtimeSession?.close('exchange requires verification')
      throw finalError
    }
  }

  async function verifyAccount(providerId, options = {}) {
    const config = providerConfig(providerId)
    const token = await accessToken(config)
    const seasonId = safeText(options.seasonId, 40)
    const version = safeText(options.version, 40)

    const buildsJson = await requestJson(
      new URL(config.buildsPath, config.apiBaseUrl),
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      `${config.label} could not list its live builds.`,
    )
    const builds = Array.isArray(buildsJson?.data)
      ? buildsJson.data
      : Array.isArray(buildsJson)
        ? buildsJson
        : []
    const build = chooseBuild(builds, config, seasonId, version)
    const pending = takePendingVerification(config, build)
    if (!pending) {
      throw new Error(
        `${config.label} did not return a verification page for this launch. Press Play again and use Verify Account only if Era provides one.`,
      )
    }

    try {
      const result = await completeVerification(config, token, build, pending.error)
      markVerificationCompleted(config)
      cacheVerificationCode(config, build, result)
      return result
    } catch (caught) {
      // Keep the provider-supplied page available when the player closes or
      // times out the explicit window, so Verify Account can be retried without
      // forcing another Play attempt.
      rememberVerification(config, build, pending.error)
      const error = caught instanceof Error ? caught : new Error(String(caught))
      if (pending?.url) {
        error.verificationUrl = pending.url
        error.verificationRequired = true
      }
      throw error
    }
  }

  /**
   * Shared branded sign-in shell for provider flows that redirect to a custom
   * scheme or a fixed loopback callback instead of an OAuth local server.
   */
  function openAuthShell(config, { loginUrl, match, onCallback }) {
    return new Promise((resolve, reject) => {
      let settled = false
      let win = null
      let authView = null
      let viewReady = false
      let timer = null

      const settle = (error, result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try {
          if (authView) {
            try {
              if (win && !win.isDestroyed()) win.contentView.removeChildView(authView)
            } catch {
              /* the window is already gone */
            }
            authView.webContents.close()
          }
        } catch {
          /* already closed */
        }
        authView = null
        try {
          if (win && !win.isDestroyed()) win.destroy()
        } catch {
          /* already gone */
        }
        if (error) reject(error)
        else resolve(result)
      }

      const callbackFor = (rawUrl) => {
        try {
          return match(new URL(String(rawUrl || '')))
        } catch {
          return false
        }
      }

      const handleNavigation = (event, rawUrl) => {
        if (!callbackFor(rawUrl) || settled) return
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        let callback
        try {
          callback = new URL(String(rawUrl || ''))
        } catch {
          settle(new Error(`${config.label} returned an unreadable sign-in callback.`))
          return
        }
        Promise.resolve()
          .then(() => onCallback(callback))
          .then((result) => settle(null, result))
          .catch((error) =>
            settle(error instanceof Error ? error : new Error(`${config.label} sign-in failed.`)),
          )
      }

      const parent = typeof getParentWindow === 'function' ? getParentWindow() : null
      const hasParent = Boolean(parent && !parent.isDestroyed())
      const width = 560
      const height = 760
      const bounds = hasParent ? parent.getBounds() : null
      try {
        win = new BrowserWindow({
          width,
          height,
          minWidth: 420,
          minHeight: 580,
          show: false,
          frame: false,
          autoHideMenuBar: true,
          backgroundColor: '#0B0F14',
          title: 'VAULTED · SECURE ACCOUNT LINK',
          parent: hasParent ? parent : undefined,
          modal: hasParent,
          center: !hasParent,
          ...(bounds
            ? {
                x: Math.max(0, Math.round(bounds.x + (bounds.width - width) / 2)),
                y: Math.max(0, Math.round(bounds.y + (bounds.height - height) / 2)),
              }
            : {}),
          roundedCorners: true,
          hasShadow: true,
          webPreferences: {
            preload: path.join(__dirname, 'providerAuthShell.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        })
      } catch (error) {
        reject(
          new Error(
            `VAULTED could not open the ${config.label} sign-in window: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
        return
      }

      win.setMenuBarVisibility(false)
      win.once('ready-to-show', () => {
        if (!settled && win && !win.isDestroyed()) win.show()
      })
      win.on('closed', () => {
        if (!settled) settle(new Error(`${config.label} sign-in was canceled.`))
      })
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape' && !settled) {
          event.preventDefault()
          win.close()
        }
      })

      if (typeof WebContentsView === 'function') {
        const layout = () => {
          if (!authView || settled || !win || win.isDestroyed()) return
          const [contentWidth, contentHeight] = win.getContentSize()
          authView.setBounds({
            x: 0,
            y: 54,
            width: Math.max(0, contentWidth),
            height: Math.max(0, contentHeight - 54),
          })
        }
        const attachView = () => {
          if (settled || viewReady) return
          viewReady = true
          try {
            win.contentView.addChildView(authView)
            layout()
          } catch (error) {
            settle(
              new Error(
                `VAULTED could not show the ${config.label} sign-in page: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            )
          }
        }
        authView = new WebContentsView({
          webPreferences: {
            partition: `persist:provider-auth-${config.id}`,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        })
        authView.setBackgroundColor?.('#0B0F14')
        const contents = authView.webContents
        win.on('resize', layout)
        contents.setWindowOpenHandler(({ url }) => {
          if (callbackFor(url)) handleNavigation(null, url)
          else if (/^https?:\/\//i.test(url)) void contents.loadURL(url).catch(() => {})
          return { action: 'deny' }
        })
        contents.on('will-navigate', handleNavigation)
        contents.on('will-redirect', handleNavigation)
        contents.on('did-finish-load', attachView)
        contents.on('did-fail-load', (_event, codeValue, description, _url, isMainFrame) => {
          if (isMainFrame && codeValue !== -3 && !settled) {
            settle(
              new Error(
                `${config.label} sign-in page could not load (${description || codeValue}). Check your connection and try again.`,
              ),
            )
          }
        })
        contents.on('before-input-event', (_event, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape' && !settled) win.close()
        })
        void win
          .loadFile(path.join(__dirname, 'providerAuthShell.html'), {
            query: { provider: config.label },
          })
          .catch((error) => {
            settle(
              new Error(
                `VAULTED could not open its sign-in window: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            )
          })
        void contents.loadURL(loginUrl).catch((error) => {
          settle(
            new Error(
              `${config.label} sign-in page could not load: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          )
        })
      } else {
        win.webContents.setWindowOpenHandler(({ url }) => {
          if (callbackFor(url)) handleNavigation(null, url)
          else if (/^https?:\/\//i.test(url)) void win.loadURL(url).catch(() => {})
          return { action: 'deny' }
        })
        win.webContents.on('will-navigate', handleNavigation)
        win.webContents.on('will-redirect', handleNavigation)
        win.webContents.on('did-fail-load', (_event, codeValue, description, _url, isMainFrame) => {
          if (isMainFrame && codeValue !== -3 && !settled) {
            settle(
              new Error(
                `${config.label} sign-in page could not load (${description || codeValue}). Check your connection and try again.`,
              ),
            )
          }
        })
        void win.loadURL(loginUrl).catch((error) => {
          settle(
            new Error(
              `${config.label} sign-in page could not load: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          )
        })
      }

      timer = setTimeout(() => {
        settle(new Error(`${config.label} sign-in timed out. Try again.`))
      }, loginTimeoutMs)
    })
  }

  function registerLogin(id, promise) {
    activeLogins.set(id, promise)
    promise.finally(() => activeLogins.delete(id)).catch(() => {})
    return promise
  }

  function loginAdapter(id, config, method) {
    if (activeLogins.has(id)) {
      return Promise.reject(new Error('A provider sign-in window is already open. Finish it first.'))
    }
    const loginUrl =
      config.auth === 'deeplink' ? config.deeplink.authorizeUrl : config.embeddedWeb.loginUrl
    const match = (url) => {
      if (config.auth === 'deeplink') return url.protocol === config.deeplink.scheme
      const expected = new URL(config.embeddedWeb.callbackUrl)
      return url.origin === expected.origin && url.pathname === expected.pathname
    }
    const promise = openAuthShell(config, {
      loginUrl,
      match,
      onCallback: async (callback) => {
        const tokenParam =
          config.auth === 'deeplink' ? config.deeplink.tokenParam : config.embeddedWeb.tokenParam
        const refreshParam =
          config.auth === 'deeplink' ? config.deeplink.refreshParam : config.embeddedWeb.refreshParam
        // EZFN's account page has used both query and fragment callbacks. Read
        // whichever form actually carries the configured token parameter.
        const hashParams = new URLSearchParams(callback.hash.replace(/^#/, ''))
        const params = callback.searchParams.has(tokenParam)
          ? callback.searchParams
          : hashParams
        const error = params.get('error') || callback.searchParams.get('error')
        if (error) {
          throw new Error(
            `${config.label} sign-in failed: ${params.get('error_description') || callback.searchParams.get('error_description') || error}`,
          )
        }
        const accessToken = safeText(params.get(tokenParam), 8192)
        if (!accessToken) {
          throw new Error(`${config.label} did not return a session token. Try again.`)
        }
        const refreshToken = refreshParam
          ? safeText(params.get(refreshParam), 4096)
          : ''
        const previous = readStore()[id]
        const record = directTokenRecord(config, accessToken, refreshToken, previous)
        record.auth_method = ['discord', 'google'].includes(method) ? method : 'discord'
        writeStore({ ...readStore(), [id]: record })
        const identity = await fetchProfile(config, accessToken)
        const current = readStore()[id]
        if (current) {
          writeStore({
            ...readStore(),
            [id]: {
              ...current,
              display_name: identity.displayName || current.display_name || null,
              avatar_url: identity.avatarUrl || current.avatar_url || null,
              account_id: identity.accountId || current.account_id || null,
              updated_at: Date.now(),
            },
          })
        }
        return tokenStatus(id)
      },
    })
    return registerLogin(id, promise)
  }

  function loginFixedOAuth(id, config, method) {
    if (activeLogins.has(id)) {
      return Promise.reject(new Error('A provider sign-in window is already open. Finish it first.'))
    }
    const redirectUri = config.oauth.redirectUri
    if (!redirectUri) {
      return Promise.reject(new Error(`${config.label} has no fixed OAuth callback. Reinstall VAULTED.`))
    }
    const authorize = new URL(config.oauth.authorizeUrl)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', config.oauth.clientId)
    authorize.searchParams.set('redirect_uri', redirectUri)
    if (config.oauth.scope) authorize.searchParams.set('scope', config.oauth.scope)
    const expected = new URL(redirectUri)
    const customScheme = !['http:', 'https:'].includes(expected.protocol)
    const promise = openAuthShell(config, {
      loginUrl: authorize.toString(),
      match: (url) =>
        customScheme
          ? url.protocol === expected.protocol && url.hostname === expected.hostname
          : url.origin === expected.origin && url.pathname === expected.pathname,
      onCallback: async (callback) => {
        const oauthError = callback.searchParams.get('error')
        if (oauthError) {
          throw new Error(
            `${config.label} sign-in failed: ${callback.searchParams.get('error_description') || oauthError}`,
          )
        }
        const code = safeText(callback.searchParams.get('code'), 4096)
        if (!code) throw new Error(`${config.label} did not return an authorization code.`)
        const token = await tokenRequest(config, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        })
        const record = tokenRecord(config, token)
        const identity = await fetchProfile(config, record.access_token)
        record.display_name = identity.displayName || null
        record.avatar_url = identity.avatarUrl || null
        record.account_id = identity.accountId || null
        record.auth_method = ['discord', 'google'].includes(method) ? method : 'discord'
        writeStore({ ...readStore(), [id]: record })
        return tokenStatus(id)
      },
    })
    return registerLogin(id, promise)
  }

  function login(providerId, options = {}) {
    const id = normalizeProviderId(providerId)
    const method = safeText(options?.method, 20)
    const config = providerConfig(id)
    if (config.auth !== 'oauth') return loginAdapter(id, config, method)
    if (config.oauth.fixedRedirect) return loginFixedOAuth(id, config, method)
    if (activeLogins.has(id)) {
      return Promise.reject(new Error('A provider sign-in window is already open. Finish it first.'))
    }

    for (const key of verificationCodes.keys()) {
      if (key.startsWith(`${id}|`)) verificationCodes.delete(key)
    }
    for (const key of pendingVerifications.keys()) {
      if (key.startsWith(`${id}|`)) pendingVerifications.delete(key)
    }
    const state = crypto.randomBytes(32).toString('base64url')
    const verifier = crypto.randomBytes(64).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

    const loginPromise = new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      let win = null
      let authView = null
      let viewReady = false
      let server = null
      let redirectUri = ''
      let callbackHandled = false

      const settle = (error, result) => {
        if (settled) return
        settled = true
        callbackHandled = true
        if (timer) clearTimeout(timer)
        activeLogins.delete(id)
        try {
          server?.closeAllConnections?.()
          server?.close()
        } catch {
          /* already closed */
        }
        try {
          if (authView) {
            try {
              if (win && !win.isDestroyed()) win.contentView.removeChildView(authView)
            } catch {
              /* the window is already gone */
            }
            authView.webContents.close()
          }
        } catch {
          /* already closed */
        }
        authView = null
        try {
          if (win && !win.isDestroyed()) win.destroy()
        } catch {
          /* already gone */
        }
        if (error) reject(error)
        else resolve(result)
      }

      const failPage = (title, detail) => callbackPage(title, detail, false)

      const finishLogin = async (code) => {
        try {
          const token = await tokenRequest(config, {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          })
          const record = tokenRecord(config, token)
          const identity = await fetchProfile(config, record.access_token)
          record.display_name = identity.displayName || null
          record.avatar_url = identity.avatarUrl || null
          record.account_id = identity.accountId || null
          record.auth_method = ['discord', 'google'].includes(method) ? method : null
          writeStore({ ...readStore(), [id]: record })
          // Check the account immediately after the OAuth handoff. Era's
          // exchange endpoint is the only public endpoint that distinguishes a
          // valid-but-unverified account from a normal session. A verification
          // response triggers a silent refresh/retry only; the sign-in modal
          // closes without opening an invite page. Explicit Verify Account is
          // the only path that can show the embedded provider page.
          await verifyAfterLogin(config, record.access_token, win)
          settle(null, tokenStatus(id))
        } catch (error) {
          settle(error instanceof Error ? error : new Error('The provider sign-in failed.'))
        }
      }

      const callbackFor = (rawUrl) => {
        try {
          const url = new URL(String(rawUrl || ''))
          if (redirectUri) {
            const expected = new URL(redirectUri)
            if (url.origin === expected.origin && url.pathname === expected.pathname) return url
          }
          if (
            url.protocol === 'vaulted:' &&
            (url.pathname === '/callback' || url.hostname === 'auth' || url.hostname === 'callback')
          ) {
            return url
          }
          return null
        } catch {
          return null
        }
      }

      const processCallback = (callback, response = null) => {
        if (settled || callbackHandled) {
          if (response) {
            response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' })
            response.end('This sign-in callback was already handled.')
          }
          return
        }

        const fail = (message, detail, status = 400) => {
          callbackHandled = true
          if (response) {
            response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(failPage('Sign-in was not completed', detail))
          }
          settle(new Error(message))
        }

        const oauthError = callback.searchParams.get('error')
        if (oauthError) {
          const detail = callback.searchParams.get('error_description') || oauthError
          fail(`${config.label} sign-in failed: ${detail}`, detail)
          return
        }
        if (callback.searchParams.get('state') !== state) {
          fail(
            'The provider sign-in response could not be verified. Try again.',
            'The OAuth state did not match. Close this window and try again.',
          )
          return
        }
        const code = safeText(callback.searchParams.get('code'), 4096)
        if (!code) {
          fail(
            'The provider did not return an authorization code.',
            'The provider did not return an authorization code.',
          )
          return
        }

        callbackHandled = true
        if (response) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(
            callbackPage(
              `Signed in to ${config.label}`,
              'VAULTED is finishing the account link. This window will close automatically.',
              true,
            ),
          )
        }
        // Do not hide the branded modal here: finishLogin keeps it open while
        // the post-OAuth verification check runs, and settle() closes it after
        // the account is ready (or after a verification failure).
        void finishLogin(code)
      }

      server = http.createServer((request, response) => {
        let callback
        try {
          callback = new URL(request.url || '/', 'http://127.0.0.1')
        } catch {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Invalid callback.')
          return
        }
        if (callback.pathname !== '/callback') {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Not found.')
          return
        }
        processCallback(callback, response)
      })

      server.once('error', (error) => {
        settle(
          new Error(
            `VAULTED could not open the local sign-in callback: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      })

      server.listen(0, '127.0.0.1', () => {
        if (settled) return
        const address = server.address()
        if (!address || typeof address === 'string') {
          settle(new Error('VAULTED could not allocate a local sign-in callback.'))
          return
        }
        redirectUri = `http://127.0.0.1:${address.port}/callback`

        const authorize = new URL(config.oauth.authorizeUrl)
        authorize.searchParams.set('response_type', 'code')
        authorize.searchParams.set('client_id', config.oauth.clientId)
        authorize.searchParams.set('redirect_uri', redirectUri)
        authorize.searchParams.set('state', state)
        authorize.searchParams.set('code_challenge', challenge)
        authorize.searchParams.set('code_challenge_method', 'S256')
        if (config.oauth.scope) authorize.searchParams.set('scope', config.oauth.scope)

        let loginUrl = authorize.toString()
        const methodPath = config.oauth.methods?.[method]
        if (methodPath) {
          const methodUrl = new URL(methodPath, new URL(config.oauth.authorizeUrl).origin)
          methodUrl.searchParams.set('return', `${authorize.pathname}${authorize.search}`)
          loginUrl = methodUrl.toString()
        }

        const parent = typeof getParentWindow === 'function' ? getParentWindow() : null
        const hasParent = Boolean(parent && !parent.isDestroyed())
        const width = 560
        const height = 760
        const bounds = hasParent ? parent.getBounds() : null
        win = new BrowserWindow({
          width,
          height,
          minWidth: 420,
          minHeight: 580,
          show: false,
          frame: false,
          autoHideMenuBar: true,
          backgroundColor: '#0B0F14',
          title: 'VAULTED · SECURE ACCOUNT LINK',
          parent: hasParent ? parent : undefined,
          modal: hasParent,
          center: !hasParent,
          ...(bounds
            ? {
                x: Math.max(0, Math.round(bounds.x + (bounds.width - width) / 2)),
                y: Math.max(0, Math.round(bounds.y + (bounds.height - height) / 2)),
              }
            : {}),
          roundedCorners: true,
          hasShadow: true,
          webPreferences: {
            preload: path.join(__dirname, 'providerAuthShell.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        })
        win.setMenuBarVisibility(false)
        win.once('ready-to-show', () => {
          if (!settled && win && !win.isDestroyed()) win.show()
        })
        win.on('closed', () => {
          if (!settled) {
            settle(new Error(`${config.label} sign-in was canceled.`))
          }
        })
        win.webContents.on('before-input-event', (event, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape' && !settled) {
            event.preventDefault()
            win.close()
          }
        })

        const onNavigation = (event, url) => {
          const callback = callbackFor(url)
          if (!callback) return
          event.preventDefault()
          processCallback(callback)
        }

        if (typeof WebContentsView === 'function') {
          const layout = () => {
            if (!authView || settled || !win || win.isDestroyed()) return
            const [contentWidth, contentHeight] = win.getContentSize()
            authView.setBounds({
              x: 0,
              y: 54,
              width: Math.max(0, contentWidth),
              height: Math.max(0, contentHeight - 54),
            })
          }

          authView = new WebContentsView({
            webPreferences: {
              partition: `persist:provider-auth-${id}`,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          })
          authView.setBackgroundColor?.('#0B0F14')
          const contents = authView.webContents
          const attachView = () => {
            if (settled || viewReady) return
            viewReady = true
            try {
              win.contentView.addChildView(authView)
              layout()
            } catch (error) {
              settle(
                new Error(
                  `VAULTED could not show the ${config.label} sign-in page: ${error instanceof Error ? error.message : String(error)}`,
                ),
              )
            }
          }

          win.on('resize', layout)
          contents.setWindowOpenHandler(({ url }) => {
            const callback = callbackFor(url)
            if (callback) processCallback(callback)
            else if (/^https?:\/\//i.test(url)) void contents.loadURL(url).catch(() => {})
            return { action: 'deny' }
          })
          contents.on('will-navigate', onNavigation)
          contents.on('will-redirect', onNavigation)
          contents.on('did-finish-load', attachView)
          contents.on('did-fail-load', (_event, codeValue, description, _url, isMainFrame) => {
            if (isMainFrame && codeValue !== -3 && !settled) {
              settle(
                new Error(
                  `${config.label} sign-in page could not load (${description || codeValue}). Check your connection and try again.`,
                ),
              )
            }
          })
          contents.on('before-input-event', (_event, input) => {
            if (input.type === 'keyDown' && input.key === 'Escape' && !settled) win.close()
          })

          void win
            .loadFile(path.join(__dirname, 'providerAuthShell.html'), {
              query: { provider: config.label },
            })
            .catch((error) => {
              settle(
                new Error(
                  `VAULTED could not open its sign-in window: ${error instanceof Error ? error.message : String(error)}`,
                ),
              )
            })
          void contents.loadURL(loginUrl).catch((error) => {
            settle(
              new Error(
                `${config.label} sign-in page could not load: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
          })
        } else {
          win.webContents.setWindowOpenHandler(({ url }) => {
            const callback = callbackFor(url)
            if (callback) processCallback(callback)
            else if (/^https?:\/\//i.test(url)) void win.loadURL(url).catch(() => {})
            return { action: 'deny' }
          })
          win.webContents.on('will-navigate', onNavigation)
          win.webContents.on('will-redirect', onNavigation)
          win.webContents.on('did-fail-load', (_event, codeValue, description, _url, isMainFrame) => {
            if (isMainFrame && codeValue !== -3 && !settled) {
              settle(
                new Error(
                  `${config.label} sign-in page could not load (${description || codeValue}). Check your connection and try again.`,
                ),
              )
            }
          })
          void win.loadURL(loginUrl).catch((error) => {
            settle(
              new Error(
                `${config.label} sign-in page could not load: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
          })
        }

        timer = setTimeout(() => {
          settle(new Error(`${config.label} sign-in timed out. Try again.`))
        }, loginTimeoutMs)
      })
    })

    activeLogins.set(id, loginPromise)
    loginPromise.finally(() => activeLogins.delete(id)).catch(() => {})
    return loginPromise
  }

  function logout(providerId) {
    const id = normalizeProviderId(providerId)
    const config = providerConfig(id)
    clearToken(config.id)
    for (const key of verificationCodes.keys()) {
      if (key.startsWith(`${id}|`)) verificationCodes.delete(key)
    }
    for (const key of pendingVerifications.keys()) {
      if (key.startsWith(`${id}|`)) pendingVerifications.delete(key)
    }
    return tokenStatus(config.id)
  }

  return {
    statuses,
    status: (providerId) => {
      const id = normalizeProviderId(providerId)
      providerConfig(id)
      return tokenStatus(id)
    },
    login,
    logout,
    refreshSession,
    exchangeCode,
    verifyAccount,
    listBuilds,
    buildManifest,
    verifyBuildManifest,
    resourceHeaders,
  }
}

module.exports = { createProviderAuth }
