'use strict'

/**
 * Global backend health/population sampling.
 *
 * The renderer never supplies a URL here. It asks for the current catalog, and
 * this module probes only the backend origins that main already validated from
 * the bundled provider.json. The backend may answer with a health status and an
 * optional population payload; a missing player field is kept undefined rather
 * than fabricated.
 */

const DEFAULT_TIMEOUT_MS = 4500
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
  const url = safeHttpUrl(provider?.statusUrl || provider?.backendUrl)
  const checkedAt = new Date().toISOString()
  if (!providerId || !url) {
    return { providerId, online: false, servers: 0, checkedAt }
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
    // A 401/404 still proves the backend is reachable. Only transport failures
    // and server-side failures make a global backend unavailable.
    const online = response.status > 0 && response.status < 500
    if (!online) {
      return { providerId, online: false, servers: 0, pingMs, checkedAt }
    }
    const payload = await readPayload(response)
    const players = playerCountFromPayload(payload)
    const reportedServers = serverCountFromPayload(payload)
    return {
      providerId,
      online: true,
      players,
      servers: reportedServers ?? 1,
      pingMs,
      checkedAt,
    }
  } catch {
    return {
      providerId,
      online: false,
      servers: 0,
      pingMs: Math.max(0, Date.now() - startedAt),
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
