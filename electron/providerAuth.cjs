'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const crypto = require('node:crypto')

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000
const VERIFICATION_POLL_MS = 5_000
const REQUEST_TIMEOUT_MS = 20_000
const TOKEN_FILE = 'provider-auth.bin'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function safeText(value, limit = 300) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
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

function accountStatusFor(json, status, detail) {
  const code = accountStatusCode(json)
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
}) {
  if (!app || !safeStorage || !BrowserWindow) throw new Error('Provider authentication requires Electron.')
  if (typeof listProviders !== 'function' || typeof profileForId !== 'function') {
    throw new Error('Provider authentication has no provider catalog.')
  }

  /** providerId -> in-flight login promise */
  const activeLogins = new Map()
  /** providerId|buildId -> short-lived code created by the post-login check */
  const verificationCodes = new Map()
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
    if (!profile || profile.auth !== 'oauth') {
      throw new Error('That provider does not support an in-app account sign-in.')
    }

    const oauth = profile.oauth
    if (!oauth || typeof oauth !== 'object') {
      throw new Error(`${profile.label} is missing its OAuth configuration. Reinstall VAULTED.`)
    }

    let authorizeUrl
    let tokenUrl
    try {
      authorizeUrl = new URL(oauth.authorizeUrl)
      tokenUrl = new URL(oauth.tokenUrl)
    } catch {
      throw new Error(`${profile.label} has an invalid OAuth endpoint. Reinstall VAULTED.`)
    }
    for (const endpoint of [authorizeUrl, tokenUrl]) {
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
        throw new Error(`${profile.label} OAuth endpoints must use https without credentials.`)
      }
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

    const clientId = safeText(oauth.clientId, 128)
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) {
      throw new Error(`${profile.label} has an invalid OAuth client ID. Reinstall VAULTED.`)
    }

    const safePath = (value, fallback) => {
      const candidate = typeof value === 'string' ? value.trim() : ''
      return /^\/[A-Za-z0-9/_-]{1,200}$/.test(candidate) ? candidate : fallback
    }

    const buildIds = {}
    if (oauth.buildIds && typeof oauth.buildIds === 'object' && !Array.isArray(oauth.buildIds)) {
      for (const [season, buildId] of Object.entries(oauth.buildIds)) {
        if (/^ch\d{1,2}(?:-s\d{1,2}|-remix|-mini\d+)$/.test(season) && UUID.test(String(buildId))) {
          buildIds[season] = String(buildId)
        }
      }
    }

    const methods = {}
    if (oauth.methods && typeof oauth.methods === 'object' && !Array.isArray(oauth.methods)) {
      for (const method of ['discord', 'google']) {
        const endpoint = oauth.methods[method]
        if (typeof endpoint !== 'string') continue
        const candidate = endpoint.trim()
        if (/^\/[A-Za-z0-9/_-]{1,200}$/.test(candidate)) methods[method] = candidate
      }
    }

    return {
      id: profile.id,
      label: profile.label || profile.name || profile.id,
      oauth: {
        authorizeUrl: authorizeUrl.toString(),
        tokenUrl: tokenUrl.toString(),
        clientId,
        scope: safeText(oauth.scope, 256) || 'launcher.all',
        methods,
      },
      apiBaseUrl: apiBaseUrl.origin,
      buildsPath: safePath(profile.buildsPath, '/launcher/v1/builds'),
      exchangeCodePath: safePath(profile.exchangeCodePath, '/launcher/v1/game/exchange-code'),
      profilePath: safeText(profile.profilePath, 220),
      verificationUrl:
        httpsUrl(profile.verificationUrl) || (profile.id === 'era' ? 'https://discord.gg/erafn' : ''),
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
    }
  }

  function statuses() {
    const result = {}
    for (const provider of listProviders()) {
      if (!provider || provider.auth !== 'oauth') continue
      result[provider.id] = tokenStatus(provider.id)
    }
    return result
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The provider did not answer in time. Try again.')
      throw new Error(`Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  function responseError(json, status, fallback) {
    const detail =
      (json && typeof json.error === 'object' && (json.error.message || json.error.detail)) ||
      (typeof json?.error === 'string' && json.error) ||
      json?.errorMessage ||
      json?.message ||
      json?.detail ||
      fallback
    const error = new Error(String(detail || `The provider answered HTTP ${status}.`))
    error.status = status
    const accountStatus = accountStatusFor(json, status, String(detail || ''))
    if (accountStatus) {
      error.code = accountStatus
      error.accountStatus = accountStatus
      error.verificationRequired = isVerificationStatus(accountStatus)
    }
    // Some providers attach the exact interactive verification destination to
    // the rejection. Use it when it is a safe HTTPS URL; otherwise the provider
    // profile supplies the default page.
    const verificationUrl = httpsUrl(
      json?.verification_url ||
        json?.verificationUrl ||
        json?.details?.verification_url ||
        json?.details?.verificationUrl ||
        (json?.error && typeof json.error === 'object'
          ? json.error.verification_url || json.error.verificationUrl
          : ''),
    )
    if (verificationUrl) error.verificationUrl = verificationUrl
    return error
  }

  async function requestJson(url, options = {}, fallback = 'The provider rejected the request.') {
    const response = await fetchWithTimeout(url, options)
    const text = await response.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        if (!response.ok) throw responseError(null, response.status, fallback)
        throw new Error('The provider returned an unreadable response. Try again.')
      }
    }
    if (!response.ok) throw responseError(json, response.status, fallback)
    return json
  }

  async function tokenRequest(config, params) {
    const url = new URL(config.oauth.tokenUrl)
    url.searchParams.set('client_id', config.oauth.clientId)
    const body = new URLSearchParams({
      ...params,
      client_id: config.oauth.clientId,
    })
    return requestJson(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
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
      // Remember how the OAuth session was created so an interactive Era
      // verification step can open the account-link page for Google sessions
      // and the Discord server page for Discord sessions.
      auth_method: ['discord', 'google'].includes(previous.auth_method)
        ? previous.auth_method
        : null,
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

  async function accessToken(config) {
    const store = readStore()
    const record = store[config.id]
    if (!record || typeof record !== 'object') {
      throw new Error(`Sign in to ${config.label} from the season card first.`)
    }

    const access = safeText(record.access_token, 8192)
    if (access && (!Number.isFinite(record.expires_at) || record.expires_at - 60_000 > Date.now())) {
      return access
    }

    const refresh = safeText(record.refresh_token, 4096)
    if (!refresh) {
      clearToken(config.id)
      throw new Error(`Your ${config.label} session expired. Sign in again from the season card.`)
    }

    let token
    try {
      token = await tokenRequest(config, {
        grant_type: 'refresh_token',
        refresh_token: refresh,
      })
    } catch (error) {
      if (error?.status === 400 || error?.status === 401) {
        clearToken(config.id)
        throw new Error(`Your ${config.label} session expired. Sign in again from the season card.`)
      }
      throw error
    }

    const next = tokenRecord(config, token, record)
    writeStore({ ...readStore(), [config.id]: next })
    return next.access_token
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

  function chooseBuild(builds, config, seasonId, version) {
    const available = Array.isArray(builds) ? builds : []
    const requestedId = config.buildIds[seasonId]
    if (requestedId) {
      const exact = available.find((build) => String(build?.id).toLowerCase() === requestedId.toLowerCase())
      if (exact) return exact
    }

    const season = seasonNumber(seasonId)
    const matchingSeason =
      season == null ? [] : available.filter((build) => Number(build?.season) === season)
    const exactVersion = String(version || '')
    const matchingVersion = exactVersion
      ? available.filter((build) => String(build?.version || '') === exactVersion)
      : []

    let candidates = matchingSeason.length > 0 ? matchingSeason : matchingVersion
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

  async function gameCode(config, token, build) {
    let response
    try {
      response = await requestJson(
        new URL(config.exchangeCodePath, config.apiBaseUrl),
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
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
      if (error?.accountStatus || error?.verificationRequired) throw error
      if (error?.status === 401 || error?.status === 403) {
        clearToken(config.id)
        throw new Error(`Your ${config.label} session expired. Sign in again from the season card.`)
      }
      throw error
    }

    const payload = response?.data ?? response
    // Some APIs return an account-status error in a 200 envelope. Preserve it
    // before failing on the missing one-time code.
    if (payload?.error || accountStatusFor(payload, 200, '')) {
      const envelopeError = responseError(
        payload,
        200,
        `${config.label} could not create a game login code.`,
      )
      if (envelopeError.accountStatus) throw envelopeError
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

  function verificationPageFor(config, method, error = null) {
    const supplied = httpsUrl(error?.verificationUrl)
    if (supplied) return supplied
    // Era's launcher OAuth has no separate verification endpoint. The public
    // exchange endpoint is the authoritative gate. If it reports a pending
    // account, use Era's own sign-in-methods page for a Google session (to
    // confirm/link Discord) and the official Discord invite for a Discord
    // session (to complete the guild step). Both run in the branded embedded
    // window; the poll below decides when the account is actually ready.
    if (config.id === 'era') {
      return method === 'google' ? 'https://id.erafn.dev/logins' : 'https://discord.gg/erafn'
    }
    return config.verificationUrl
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
      const deadline = Date.now() + VERIFICATION_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, VERIFICATION_POLL_MS))
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

  async function verifyAfterLogin(config, token, parentWindow = null) {
    if (!config.verificationUrl) return
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
      result = await completeVerification(config, token, build, error, parentWindow)
    }
    // Keep the verified code for the launch that normally follows sign-in, so
    // the immediate Play/auto-launch does not spend a second exchange request.
    cacheVerificationCode(config, build, result)
  }

  async function exchangeCode(providerId, options = {}) {
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

    const cached = takeVerificationCode(config, build)
    if (cached) return cached

    try {
      return await gameCode(config, token, build)
    } catch (error) {
      if (!isVerificationFailure(error) || !verificationPageFor(config, '', error)) throw error
      return await completeVerification(config, token, build, error)
    }
  }

  function login(providerId, options = {}) {
    const id = normalizeProviderId(providerId)
    const method = safeText(options?.method, 20)
    if (activeLogins.has(id)) {
      return Promise.reject(new Error('A provider sign-in window is already open. Finish it first.'))
    }

    const config = providerConfig(id)
    for (const key of verificationCodes.keys()) {
      if (key.startsWith(`${id}|`)) verificationCodes.delete(key)
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
          // valid-but-unverified account from a normal session. If it asks for
          // verification, keep this whole sign-in operation pending while the
          // embedded verification window is open.
          // Keep the branded sign-in modal open behind the verification page;
          // the verification window is parented to it so closing the modal
          // also cancels the pending check.
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
        }, LOGIN_TIMEOUT_MS)
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
    exchangeCode,
  }
}

module.exports = { createProviderAuth }
