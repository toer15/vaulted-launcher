'use strict'

/**
 * Global backend health/population sampling.
 *
 * The renderer never supplies a URL here. It asks for the current catalog, and
 * this module probes only the backend origins that main already validated from
 * the bundled provider.json. The backend may answer with a health status and an
 * optional population payload; a missing player field is kept undefined rather
 * than fabricated. When a backend publishes no in-game count, its configured
 * public Discord presence is sampled separately and labelled, so the UI never
 * mistakes community presence for players in a match.
 */

const DEFAULT_TIMEOUT_MS = 2500
const DISCORD_TIMEOUT_MS = 1500
const PLAYER_KEYS = [
  'players',
  'playerCount',
  'player_count',
  'onlinePlayers',
  'online_players',
  'numPlayers',
  'concurrentPlayers',
  'concurrent_players',
]
const SERVER_KEYS = ['servers', 'serverCount', 'server_count', 'onlineServers', 'online_servers']
const OFFLINE_STATUSES = new Set(['offline', 'down', 'maintenance', 'unhealthy', 'closed'])

function safeHttpUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function finiteCount(value, { positive = false } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < (positive ? 1 : 0)) return undefined
  return Math.min(1_000_000, Math.floor(number))
}

function objectAt(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function playerCountFromPayload(payload) {
  const roots = [
    payload,
    objectAt(payload)?.data,
    objectAt(payload)?.status,
    objectAt(payload)?.stats,
    objectAt(payload)?.population,
    objectAt(objectAt(payload)?.data)?.status,
    objectAt(objectAt(payload)?.data)?.stats,
    objectAt(objectAt(payload)?.data)?.population,
  ]
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue
    for (const key of PLAYER_KEYS) {
      const value = root[key]
      if (Array.isArray(value)) return Math.min(1_000_000, value.length)
      const count = finiteCount(value)
      if (count !== undefined) return count
    }
  }
  return undefined
}

function offlineReasonFromPayload(payload) {
  const roots = [
    payload,
    objectAt(payload)?.data,
    objectAt(payload)?.status,
    objectAt(payload)?.health,
    objectAt(payload)?.stats,
  ]
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue
    if (root.offline === true) return 'Backend reports offline.'
    if (root.down === true) return 'Backend reports down.'
    if (root.maintenance === true) return 'Backend reports maintenance.'
    if (root.online === false) return 'Backend reports offline.'
    for (const key of ['status', 'state', 'health', 'overall']) {
      const value = root[key]
      if (typeof value === 'string' && OFFLINE_STATUSES.has(value.trim().toLowerCase())) {
        return `Backend reports ${value.trim().toLowerCase()}.`
      }
    }
  }
  return null
}

async function readDiscordPresence(population, options = {}) {
  const invite =
    population && population.kind === 'discord' && typeof population.invite === 'string'
      ? population.invite.trim()
      : ''
  if (!/^[A-Za-z0-9-]{2,64}$/.test(invite)) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS)
  try {
    const response = await (options.fetchImpl || fetch)(
      `https://discord.com/api/v10/invites/${encodeURIComponent(invite)}?with_counts=true`,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'VAULTED-Launcher' },
        cache: 'no-store',
        signal: controller.signal,
      },
    )
    if (!response.ok) return undefined
    const payload = await response.json()
    return finiteCount(payload?.approximate_presence_count)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function serverCountFromPayload(payload) {
  const roots = [
    payload,
    objectAt(payload)?.data,
    objectAt(payload)?.status,
    objectAt(payload)?.stats,
    objectAt(payload)?.population,
    objectAt(objectAt(payload)?.data)?.status,
    objectAt(objectAt(payload)?.data)?.stats,
  ]
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue
    for (const key of SERVER_KEYS) {
      const value = root[key]
      if (Array.isArray(value)) return Math.min(1000, value.length)
      const count = finiteCount(value, { positive: true })
      if (count !== undefined) return count
    }
  }
  return undefined
}

async function readPayload(response) {
  const type = response.headers.get('content-type') || ''
  if (!/json|text/i.test(type)) return null
  try {
    const text = await response.text()
    if (!text || text.length > 2 * 1024 * 1024) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Probe one catalog backend. This is a real request to the backend origin, not
 * a synthetic "GLOBAL LIVE" state. A backend that answers anything below 500 is
 * reachable; population is used only when the response actually reports it.
 */
async function probeProviderStatus(provider, options = {}) {
  const providerId = typeof provider?.id === 'string' ? provider.id.trim() : ''
  // Discord-only communities have no game-server health endpoint. Their
  // Discord gate is the availability signal; probing discord.com would turn
  // every listing into a fake online server.
  const discordOnly = provider?.mode === 'external' && !provider?.statusUrl
  const url = discordOnly ? null : safeHttpUrl(provider?.statusUrl || provider?.backendUrl)
  const checkedAt = new Date().toISOString()
  if (!providerId || !url) {
    return {
      providerId,
      online: false,
      servers: 0,
      serverData: false,
      reason: discordOnly
        ? 'This community exposes a Discord gate rather than a game-server health endpoint.'
        : 'No health endpoint is configured.',
      checkedAt,
    }
  }

  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(15_000, Math.max(500, options.timeoutMs))
      : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await (options.fetchImpl || fetch)(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'VAULTED-Launcher',
      },
      cache: 'no-store',
      signal: controller.signal,
    })
    const pingMs = Math.max(0, Date.now() - startedAt)
    // A 401/404 still proves the backend is reachable. Only transport failures,
    // 5xx responses and an explicit offline flag make a backend unavailable.
    if (response.status >= 500) {
      return {
        providerId,
        online: false,
        servers: 0,
        serverData: false,
        pingMs,
        reason: `Health endpoint returned HTTP ${response.status}.`,
        checkedAt,
      }
    }
    if (response.status <= 0) {
      return {
        providerId,
        online: false,
        servers: 0,
        serverData: false,
        pingMs,
        reason: 'Health endpoint did not return an HTTP status.',
        checkedAt,
      }
    }
    const payload = await readPayload(response)
    const offlineReason = offlineReasonFromPayload(payload)
    if (offlineReason) {
      return {
        providerId,
        online: false,
        servers: 0,
        serverData: false,
        pingMs,
        reason: offlineReason,
        checkedAt,
      }
    }
    const players = playerCountFromPayload(payload)
    const reportedServers = serverCountFromPayload(payload)
    let communityPlayers
    let populationSource = players !== undefined ? 'provider' : undefined
    let populationLabel
    if (players === undefined) {
      communityPlayers = await readDiscordPresence(provider?.population, options)
      if (communityPlayers !== undefined) {
        populationSource = 'discord'
        populationLabel = provider?.population?.label || 'Discord'
      }
    }
    // A homepage or health page can answer 200 without describing a game
    // server. The reachable backend is still a live destination, so the badge
    // reports at least one server even when the API omits a population count.
    const serverData =
      (typeof players === 'number' && players > 0) ||
      (typeof reportedServers === 'number' && reportedServers > 0)
    return {
      providerId,
      online: true,
      players,
      communityPlayers,
      populationSource,
      populationLabel,
      servers: Math.max(1, reportedServers ?? 0),
      serverData,
      pingMs,
      checkedAt,
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError'
    return {
      providerId,
      online: false,
      servers: 0,
      serverData: false,
      pingMs: Math.max(0, Date.now() - startedAt),
      reason: timedOut
        ? `Health check timed out after ${timeoutMs} ms.`
        : `Health check failed: ${error instanceof Error && error.message ? error.message : 'network error'}.`,
      checkedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchProviderLiveStatuses(providers, options = {}) {
  const unique = new Map()
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!provider || typeof provider.id !== 'string' || unique.has(provider.id)) continue
    unique.set(provider.id, provider)
  }
  const statuses = await Promise.all(
    [...unique.values()].map((provider) => probeProviderStatus(provider, options)),
  )
  return Object.fromEntries(statuses.map((status) => [status.providerId, status]))
}

module.exports = {
  fetchProviderLiveStatuses,
  probeProviderStatus,
}
