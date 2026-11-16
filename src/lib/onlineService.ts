import { FRIENDS_API_BASE, fetchFriends, publishSession, stopHosting, type LobbyInfo } from './friends'

/**
 * The live VAULTED relay is the default, so a fresh install already discovers
 * public lobbies. Users can point this at their own HTTP or WebSocket service.
 */
export const DEFAULT_ONLINE_SERVICE_URL = FRIENDS_API_BASE
export const ONLINE_POLL_MS = 12_000

export type OnlineStatus = 'checking' | 'connected' | 'offline'

export interface OnlineServiceUpdate {
  lobbies: LobbyInfo[]
  connected: boolean
  error?: string
}

export interface OnlineLobbyRegistration {
  address: string
  buildId: string | null
  label: string | null
  public: boolean
  seasonId?: string | null
  players?: number
}

/** The currently subscribed sockets let a host publish without a second connection. */
const activeSockets = new Map<string, WebSocket>()
/** The latest registration sent to each source, used to withdraw it on the same source. */
const activeLobbyRegistrations = new Map<string, OnlineLobbyRegistration>()

export function normalizeOnlineServiceUrl(input: string): string {
  const trimmed = String(input || '').trim()
  if (!trimmed) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('That is not a valid online server URL.')
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('Use an http(s) or ws(s) online server URL.')
  }
  parsed.hash = ''
  const href = parsed.toString()
  return href.endsWith('/') ? href.slice(0, -1) : href
}

function friendsRelayUrl(endpoint: string): string | null {
  try {
    const target = new URL(endpoint)
    const relay = new URL(FRIENDS_API_BASE)
    if (target.origin !== relay.origin) return null
    return target.pathname === '/' || target.pathname === '/api' || target.pathname === '/api/'
      ? FRIENDS_API_BASE
      : null
  } catch {
    return null
  }
}

function lobbyCandidates(endpoint: string): string[] {
  const base = endpoint.replace(/\/+$/, '')
  const path = new URL(base).pathname
  if (/\/(lobbies|sessions|summary)$/i.test(path)) return [base]
  if (/\/api$/i.test(path)) return [`${base}/lobbies`, `${base}/sessions`]
  return [`${base}/lobbies`, `${base}/api/lobbies`, `${base}/api/sessions`]
}

function publishCandidates(endpoint: string): string[] {
  const base = endpoint.replace(/\/+$/, '')
  const path = new URL(base).pathname
  if (/\/(lobbies|sessions)$/i.test(path)) return [base]
  if (/\/api$/i.test(path)) return [`${base}/lobbies`, `${base}/sessions`]
  return [`${base}/lobbies`, `${base}/api/lobbies`, `${base}/api/sessions`]
}

interface LobbyEntry {
  value: unknown
  seasonHint?: string
}

function seasonHintFor(key: string): string | undefined {
  return /^ch\d+-s\d+$/i.test(key) ? key.toLowerCase() : undefined
}

function lobbyEntries(payload: unknown, seasonHint?: string): LobbyEntry[] {
  if (Array.isArray(payload)) return payload.map((value) => ({ value, seasonHint }))
  if (!payload || typeof payload !== 'object') return []

  const record = payload as Record<string, unknown>
  if ('address' in record || 'host' in record) {
    return [{ value: record, seasonHint }]
  }

  for (const key of ['lobbies', 'sessions', 'activeLobbies', 'servers', 'items', 'data', 'seasons']) {
    if (record[key] === undefined || record[key] === null) continue
    const nested = lobbyEntries(record[key], seasonHint)
    if (nested.length > 0) return nested
  }

  // A service may key its lobby map by season id (ch1-s3, ch2-s1, …).
  const entries: LobbyEntry[] = []
  for (const [key, value] of Object.entries(record)) {
    const hint = seasonHintFor(key) ?? seasonHint
    if (Array.isArray(value)) {
      for (const item of value) entries.push({ value: item, seasonHint: hint })
    } else if (value && typeof value === 'object') {
      entries.push({ value, seasonHint: hint })
    }
  }
  return entries
}

function normalizeLobby(value: unknown, index: number, seasonHint?: string): LobbyInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const host = String(raw.host || raw.ip || '').trim()
  const port = Number(raw.port) || 7777
  const address = String(raw.address || raw.server || (host ? `${host}:${port}` : '')).trim()
  if (!address) return null

  const chapter = Number(raw.chapter)
  const seasonNumber = Number(raw.season)
  const idSeason = typeof raw.id === 'string' && /^ch\d+-s\d+$/i.test(raw.id) ? raw.id : ''
  const seasonId =
    String(
      raw.seasonId ||
        raw.seasonKey ||
        raw.buildId ||
        idSeason ||
        seasonHint ||
        raw.season_id ||
        (typeof raw.season === 'string' && raw.season.startsWith('ch') ? raw.season : '') ||
        (Number.isFinite(chapter) && Number.isFinite(seasonNumber) && chapter > 0
          ? `ch${chapter}-s${seasonNumber}`
          : ''),
    ).trim() || null

  const playersValue = raw.players
  const players = Array.isArray(playersValue)
    ? playersValue.length
    : Number(playersValue ?? raw.playerCount ?? raw.player_count ?? raw.numPlayers ?? raw.count) || 0
  const updatedValue = raw.updated ?? raw.updatedAt ?? raw.lastSeen ?? raw.last_seen
  const updated =
    typeof updatedValue === 'string'
      ? updatedValue
      : typeof updatedValue === 'number' && Number.isFinite(updatedValue)
        ? new Date(updatedValue < 1e11 ? updatedValue * 1000 : updatedValue).toISOString()
        : new Date().toISOString()

  return {
    username: String(raw.username || raw.owner || raw.hostName || raw.name || `lobby-${index + 1}`),
    address,
    buildId: seasonId,
    seasonId,
    label: String(raw.label || raw.title || raw.seasonLabel || raw.seasonName || '').trim() || null,
    public: (raw.public ?? raw.isPublic) !== false && raw.private !== true,
    updated,
    players: players > 0 ? players : undefined,
  }
}

function normalizeLobbies(payload: unknown): LobbyInfo[] {
  return lobbyEntries(payload)
    .map((entry, index) => normalizeLobby(entry.value, index, entry.seasonHint))
    .filter((lobby): lobby is LobbyInfo => Boolean(lobby && lobby.public))
}

interface TextResponse {
  ok: boolean
  status: number
  text: string
  error?: string
}

async function readText(url: string): Promise<TextResponse> {
  if (window.arc?.fetchText) {
    try {
      return await window.arc.fetchText(url)
    } catch (error) {
      return {
        ok: false,
        status: 0,
        text: '',
        error: error instanceof Error ? error.message : 'Could not reach the online service.',
      }
    }
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
    })
    return { ok: response.ok, status: response.status, text: await response.text() }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: controller.signal.aborted
        ? 'The online service took too long to answer.'
        : error instanceof Error
          ? error.message
          : 'Could not reach the online service.',
    }
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchHttpLobbies(endpoint: string): Promise<LobbyInfo[]> {
  let lastError = 'The online service did not return a lobby list.'
  for (const candidate of lobbyCandidates(endpoint)) {
    const result = await readText(candidate)
    if (result.status === 0) throw new Error(result.error || 'Could not reach the online service.')
    if (result.status === 404) {
      lastError = `No lobby endpoint at ${candidate}.`
      continue
    }
    if (!result.ok) {
      lastError = result.error || `The online service answered ${result.status}.`
      continue
    }
    try {
      return normalizeLobbies(JSON.parse(result.text))
    } catch {
      lastError = 'The online service returned a non-JSON lobby list.'
    }
  }
  throw new Error(lastError)
}

/** Fetch or subscribe once; used to prime the UI and by the HTTP poller. */
export async function fetchOnlineLobbies(endpoint: string): Promise<LobbyInfo[]> {
  if (friendsRelayUrl(endpoint)) {
    const summary = await fetchFriends()
    return summary.lobbies.filter((lobby) => lobby.public)
  }
  return fetchHttpLobbies(endpoint)
}

async function postJson(url: string, payload: unknown): Promise<TextResponse> {
  const body = JSON.stringify(payload)
  if (window.arc?.fetchText) {
    try {
      return await window.arc.fetchText(url, { method: 'POST', body })
    } catch (error) {
      return {
        ok: false,
        status: 0,
        text: '',
        error: error instanceof Error ? error.message : 'Could not reach the online service.',
      }
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    return { ok: response.ok, status: response.status, text: await response.text() }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: error instanceof Error ? error.message : 'Could not reach the online service.',
    }
  }
}

/**
 * Registers a locally hosted lobby with the configured source. The friends
 * relay uses the account session; custom services receive the lobby directly.
 */
export async function publishOnlineLobby(
  endpoint: string,
  lobby: OnlineLobbyRegistration,
): Promise<boolean> {
  const normalized = endpoint.trim()
  if (!normalized) return false

  if (friendsRelayUrl(normalized)) {
    await publishSession(lobby.address, {
      buildId: lobby.buildId ?? undefined,
      label: lobby.label ?? undefined,
      public: lobby.public,
    })
    activeLobbyRegistrations.set(normalized, lobby)
    return true
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return false
  }

  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    const openSocket = activeSockets.get(normalized)
    const message = JSON.stringify({ type: 'host', lobby })
    if (openSocket?.readyState === WebSocket.OPEN) {
      openSocket.send(message)
      activeLobbyRegistrations.set(normalized, lobby)
      return true
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timer = 0
      const socket = new WebSocket(normalized)
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        if (value) activeLobbyRegistrations.set(normalized, lobby)
        window.clearTimeout(timer)
        try {
          socket.close()
        } catch {
          /* already closed */
        }
        resolve(value)
      }
      timer = window.setTimeout(() => finish(false), 2_500)
      socket.onopen = () => {
        try {
          socket.send(message)
          window.setTimeout(() => finish(true), 250)
        } catch {
          finish(false)
        }
      }
      socket.onerror = () => finish(false)
      socket.onclose = () => finish(false)
    })
  }

  let lastError = 'The online service did not accept the lobby.'
  for (const candidate of publishCandidates(normalized)) {
    const result = await postJson(candidate, lobby)
    if (result.status === 0) throw new Error(result.error || 'Could not reach the online service.')
    if (result.status === 404) {
      lastError = `No lobby registration endpoint at ${candidate}.`
      continue
    }
    if (result.ok) {
      activeLobbyRegistrations.set(normalized, lobby)
      return true
    }
    lastError = result.error || `The online service answered ${result.status}.`
  }
  throw new Error(lastError)
}

/** Withdraw the last lobby registration from the same source that received it. */
export async function clearOnlineLobby(endpoint: string): Promise<void> {
  const normalized = endpoint.trim()
  if (!normalized) return
  const registration = activeLobbyRegistrations.get(normalized)
  activeLobbyRegistrations.delete(normalized)

  if (friendsRelayUrl(normalized)) {
    await stopHosting()
    return
  }
  if (!registration) return

  try {
    // A private registration disappears from public discovery immediately and
    // lets services that support explicit unlisting drop the entry as well.
    await publishOnlineLobby(normalized, { ...registration, public: false })
  } finally {
    activeLobbyRegistrations.delete(normalized)
  }
}

function subscribeWebSocket(endpoint: string, onUpdate: (update: OnlineServiceUpdate) => void): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let attempt = 0

  const schedule = () => {
    if (stopped || reconnectTimer !== null) return
    const delay = Math.min(15_000, 1_000 * 2 ** attempt++)
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  const connect = () => {
    if (stopped) return
    try {
      socket = new WebSocket(endpoint)
    } catch (error) {
      onUpdate({
        lobbies: [],
        connected: false,
        error: error instanceof Error ? error.message : 'Could not open the online service socket.',
      })
      schedule()
      return
    }

    socket.onopen = () => {
      attempt = 0
      activeSockets.set(endpoint, socket as WebSocket)
      onUpdate({ lobbies: [], connected: true })
      try {
        socket?.send(JSON.stringify({ type: 'subscribe', channel: 'lobbies' }))
      } catch {
        /* the server may push automatically */
      }
    }

    socket.onmessage = (event) => {
      void (async () => {
        try {
          const text =
            typeof event.data === 'string'
              ? event.data
              : event.data instanceof Blob
                ? await event.data.text()
                : ''
          if (!text) return
          onUpdate({ lobbies: normalizeLobbies(JSON.parse(text)), connected: true })
        } catch {
          /* ignore malformed push messages and keep the socket alive */
        }
      })()
    }

    socket.onerror = () => {
      onUpdate({ lobbies: [], connected: false, error: 'The online server socket failed.' })
    }

    socket.onclose = () => {
      if (socket && activeSockets.get(endpoint) === socket) activeSockets.delete(endpoint)
      if (stopped) return
      onUpdate({ lobbies: [], connected: false, error: 'The online server socket disconnected.' })
      schedule()
    }
  }

  connect()
  return () => {
    stopped = true
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    if (socket) {
      if (activeSockets.get(endpoint) === socket) activeSockets.delete(endpoint)
      socket.close()
    }
  }
}

/**
 * Starts HTTP lobby polling or a WebSocket subscription. The returned function
 * tears the connection down when the endpoint changes or the app unmounts.
 */
export function subscribeOnlineService(
  endpoint: string,
  onUpdate: (update: OnlineServiceUpdate) => void,
): () => void {
  const normalized = endpoint.trim()
  if (!normalized) {
    onUpdate({ lobbies: [], connected: false, error: 'No online service configured.' })
    return () => {}
  }

  try {
    const parsed = new URL(normalized)
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      return subscribeWebSocket(normalized, onUpdate)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      onUpdate({ lobbies: [], connected: false, error: 'Use an http(s) or ws(s) online server URL.' })
      return () => {}
    }
  } catch {
    onUpdate({ lobbies: [], connected: false, error: 'That online service URL is not valid.' })
    return () => {}
  }

  let stopped = false
  let timer: number | null = null
  const poll = async () => {
    if (stopped) return
    try {
      const lobbies = await fetchOnlineLobbies(normalized)
      if (!stopped) onUpdate({ lobbies, connected: true })
    } catch (error) {
      if (!stopped) {
        onUpdate({
          lobbies: [],
          connected: false,
          error: error instanceof Error ? error.message : 'Could not reach the online service.',
        })
      }
    }
    if (!stopped) timer = window.setTimeout(() => void poll(), ONLINE_POLL_MS)
  }

  void poll()
  return () => {
    stopped = true
    if (timer !== null) window.clearTimeout(timer)
  }
}
