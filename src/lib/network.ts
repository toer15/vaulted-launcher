/**
 * VAULTED Network client.
 *
 * One small service hosts accounts, the per-season presence counter, the build
 * source manifest and the update feed. Everything degrades gracefully: if the
 * service is unreachable the launcher still runs, it just can't count players
 * or pull a download URL.
 */

import defaultBuilds from '../assets/builds.json'
import { FRIENDS_API_BASE, type LobbyInfo } from './friends'
import type { OnlineProviderConfig, ProviderLiveStatus, ShopEquipped } from '../types'

export const API_BASE =
  'https://site-c377de5341934c84b54b325555448242.freebuff.page'

/** Provider identities are account-wide, never scoped to a season/build. */
export function normalizeProviderId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().split(':')[0].trim() : ''
}

const SESSION_KEY = 'vaulted.session.v1'
const MANIFEST_KEY = 'vaulted.manifest.v1'
const REQUEST_TIMEOUT = 10_000

export interface RiftUser {
  id: string
  username: string
  /** provider profile fields, carried by a native provider session */
  avatarUrl?: string
  providerId?: string
  providerLabel?: string
}

export interface RiftSession {
  /** empty for a provider-backed session; never a fabricated VAULTED token */
  token: string
  user: RiftUser
  /** true when the provider identity is the whole account (no VAULTED relay token) */
  providerOnly?: boolean
}

export type ApiError = Error & { status?: number }

function apiError(message: string, status?: number): ApiError {
  const error = new Error(message) as ApiError
  error.status = status
  return error
}

async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; token?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })

    const data = await response.json().catch(() => null)

    if (!response.ok) {
      throw apiError(
        (data && typeof data.error === 'string' && data.error) || 'The VAULTED service did not answer.',
        response.status,
      )
    }

    return data as T
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw apiError('The VAULTED service took too long to answer.')
    }
    throw error instanceof Error ? error : apiError('Network error.')
  } finally {
    clearTimeout(timer)
  }
}

/* ----------------------------------------------------------------- accounts */

function parseSession(raw: string | null): RiftSession | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RiftSession
    if (!parsed?.user?.username) return null
    // Provider sessions are looked up by providerId alone. Normalising here
    // also repairs old `providerId:seasonId` values from previous builds.
    if (parsed.user.providerId) {
      const providerId = normalizeProviderId(parsed.user.providerId)
      if (providerId) parsed.user.providerId = providerId
      else delete parsed.user.providerId
    }
    // Migrate sessions written by older provider builds; they used a
    // provider-prefixed placeholder token that looked like a VAULTED token.
    if (parsed.token?.startsWith('provider:') && parsed.user.providerId) {
      parsed.providerOnly = true
      parsed.token = ''
    }
    if (!parsed.token && !parsed.providerOnly) return null
    return parsed
  } catch {
    return null
  }
}

/** Encrypted copy kept by the desktop shell, independent of browser storage. */
function readPersistedSession(): RiftSession | null {
  try {
    return parseSession(window.arc?.session?.readSync?.() ?? null)
  } catch {
    return null
  }
}

export function loadSession(): RiftSession | null {
  let cached: RiftSession | null = null
  try {
    cached = parseSession(localStorage.getItem(SESSION_KEY))
  } catch {
    /* storage disabled */
  }
  if (cached) return cached

  const persisted = readPersistedSession()
  if (persisted) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(persisted))
    } catch {
      /* the file copy is still enough */
    }
  }
  return persisted
}

export function saveSession(session: RiftSession): void {
  const providerId = normalizeProviderId(session.user.providerId)
  const normalized = providerId
    ? { ...session, user: { ...session.user, providerId } }
    : session
  const raw = JSON.stringify(normalized)
  try {
    localStorage.setItem(SESSION_KEY, raw)
  } catch {
    /* storage disabled — the file copy below still remembers the user */
  }
  try {
    window.arc?.session?.save(raw)?.catch(() => {})
  } catch {
    /* browser preview */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
  try {
    window.arc?.session?.clear()?.catch(() => {})
  } catch {
    /* browser preview */
  }
}

export async function signUp(username: string, password: string): Promise<RiftSession> {
  const session = await request<RiftSession>('/api/signup', {
    method: 'POST',
    body: { username, password },
  })
  saveSession(session)
  return session
}

export async function signIn(username: string, password: string): Promise<RiftSession> {
  const session = await request<RiftSession>('/api/login', {
    method: 'POST',
    body: { username, password },
  })
  saveSession(session)
  return session
}

export async function fetchMe(token: string): Promise<RiftUser> {
  const data = await request<{ user: RiftUser }>('/api/me', { token })
  return data.user
}

export async function signOut(token: string): Promise<void> {
  clearSession()
  try {
    await request('/api/logout', { method: 'POST', token })
  } catch {
    /* local sign-out is what matters */
  }
}

/* --------------------------------------------------------------- inventory */

export interface RemoteInventory {
  owned: string[]
  equipped: Partial<ShopEquipped>
  updatedAt?: number
}

function normalizeInventory(data: unknown): RemoteInventory {
  const value = (data ?? {}) as { owned?: unknown; equipped?: unknown; updatedAt?: unknown }
  const owned = Array.isArray(value.owned)
    ? [...new Set(value.owned.filter((item): item is string => typeof item === 'string' && item.length > 0))].slice(0, 20000)
    : []
  const equipped: Partial<ShopEquipped> = {}
  if (value.equipped && typeof value.equipped === 'object') {
    for (const [type, itemId] of Object.entries(value.equipped as Record<string, unknown>)) {
      if (typeof itemId === 'string' && itemId) equipped[type as keyof ShopEquipped] = itemId
    }
  }
  return {
    owned,
    equipped,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
  }
}

/** The account-owned collection, used when the same user signs in anywhere. */
export async function fetchInventory(token: string): Promise<RemoteInventory> {
  return normalizeInventory(await request<unknown>('/api/inventory', { token }))
}

/** Merge a collection into the account and return the server's canonical copy. */
export async function saveInventory(
  token: string,
  owned: string[],
  equipped: ShopEquipped,
): Promise<RemoteInventory> {
  return normalizeInventory(
    await request<unknown>('/api/inventory', {
      method: 'POST',
      token,
      body: { owned, equipped },
    }),
  )
}

/* ---------------------------------------------------------------- presence */

export async function sendHeartbeat(token: string, seasons: string[]): Promise<void> {
  if (seasons.length === 0) return
  await request('/api/presence', { method: 'POST', token, body: { seasons } })
}

export interface ActiveCounts {
  counts: Record<string, number>
  total: number
}

/* ------------------------------------------------------- community servers */

/** A live lobby returned by a configured public community directory. */
export interface CommunityServer extends LobbyInfo {
  id: string
  name: string
  host: string
  port: number
  providerId: string
  providerLabel?: string
  source: string
  sourceLabel?: string
  maxPlayers?: number
}

/**
 * A provider/season report from a directory that is not fully represented by
 * joinable rows. Kept separate from CommunityServer on purpose: these rows
 * must never be joined, but their residual population is included in totals.
 */
export interface CommunityProviderStatus {
  providerId: string
  providerLabel: string
  seasonId: string | null
  online: boolean
  players?: number
  maxPlayers?: number
  servers: number
  region: string | null
  playlist: string | null
  updated: string
  source: string
  sourceLabel?: string
}

/** A curated external project directory row (provider + season mapping). */
export interface CommunityDirectoryEntry {
  providerId: string
  providerLabel: string
  seasonId: string | null
  name: string
  url: string | null
  source: string
  sourceLabel?: string
}

export interface CommunityServerQuery {
  token?: string | null
  seasonId?: string | null
  providerId?: string | null
  /** Bypass the failure cooldown so Play always checks every directory. */
  force?: boolean
}

export interface CommunityServerResult {
  servers: CommunityServer[]
  statuses: CommunityProviderStatus[]
  directories: CommunityDirectoryEntry[]
  errors: Array<{ endpoint: string; message: string }>
  checkedAt: string
}

function communityAddress(address: string, fallbackPort = 7777): { host: string; port: number } | null {
  const value = String(address || '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
  if (!value) return null
  const split = value.lastIndexOf(':')
  const host = (split > 0 ? value.slice(0, split) : value).replace(/^\[|\]$/g, '')
  const port = Number(split > 0 ? value.slice(split + 1) : '') || fallbackPort
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function sanitizeCommunityServer(value: unknown, index: number): CommunityServer | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const address = communityAddress(String(raw.address || ''), Number(raw.port) || 7777)
  if (!address) return null
  const seasonId = typeof raw.seasonId === 'string' ? raw.seasonId : typeof raw.buildId === 'string' ? raw.buildId : null
  const players = Number(raw.players)
  const hasPlayers =
    raw.players !== undefined && raw.players !== null && Number.isFinite(players) && players >= 0
  const pingMs = Number(raw.pingMs)
  const freshForMs = typeof raw.freshForMs === 'number' ? raw.freshForMs : undefined
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `community-${index}`,
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Community lobby',
    username: typeof raw.username === 'string' ? raw.username : 'community',
    address: `${address.host}:${address.port}`,
    host: address.host,
    port: address.port,
    buildId: seasonId,
    seasonId,
    label: typeof raw.label === 'string' ? raw.label : null,
    public: raw.public !== false,
    updated: typeof raw.updated === 'string' ? raw.updated : new Date().toISOString(),
    freshForMs: typeof freshForMs === 'number' && Number.isFinite(freshForMs) && freshForMs >= 0 ? freshForMs : undefined,
    players: hasPlayers ? Math.floor(players) : undefined,
    playersKnown:
      typeof raw.playersKnown === 'boolean' ? raw.playersKnown : hasPlayers ? true : undefined,
    pingMs: Number.isFinite(pingMs) && pingMs >= 0 ? Math.round(pingMs) : undefined,
    providerId: typeof raw.providerId === 'string' ? raw.providerId : 'community',
    providerLabel: typeof raw.providerLabel === 'string' ? raw.providerLabel : undefined,
    source: typeof raw.source === 'string' ? raw.source : 'community',
    sourceLabel: typeof raw.sourceLabel === 'string' ? raw.sourceLabel : undefined,
    maxPlayers: Number(raw.maxPlayers) > 0 ? Math.floor(Number(raw.maxPlayers)) : undefined,
    external: raw.external === true,
  }
}

function sanitizeProviderStatus(value: unknown): CommunityProviderStatus | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : ''
  if (!providerId) return null
  const players = Number(raw.players)
  const maxPlayers = Number(raw.maxPlayers)
  const servers = Number(raw.servers)
  return {
    providerId,
    providerLabel:
      typeof raw.providerLabel === 'string' && raw.providerLabel ? raw.providerLabel : providerId,
    seasonId: typeof raw.seasonId === 'string' ? raw.seasonId : null,
    online: raw.online !== false,
    players: Number.isFinite(players) && players > 0 ? Math.floor(players) : undefined,
    maxPlayers: Number.isFinite(maxPlayers) && maxPlayers > 0 ? Math.floor(maxPlayers) : undefined,
    servers: Number.isFinite(servers) && servers >= 0 ? Math.floor(servers) : 0,
    region: typeof raw.region === 'string' ? raw.region : null,
    playlist: typeof raw.playlist === 'string' ? raw.playlist : null,
    updated: typeof raw.updated === 'string' ? raw.updated : new Date().toISOString(),
    source: typeof raw.source === 'string' ? raw.source : 'community',
    sourceLabel: typeof raw.sourceLabel === 'string' ? raw.sourceLabel : undefined,
  }
}

function sanitizeDirectoryEntry(value: unknown): CommunityDirectoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : ''
  if (!providerId) return null
  return {
    providerId,
    providerLabel:
      typeof raw.providerLabel === 'string' && raw.providerLabel ? raw.providerLabel : providerId,
    seasonId: typeof raw.seasonId === 'string' ? raw.seasonId : null,
    name: typeof raw.name === 'string' && raw.name ? raw.name : providerId,
    url: typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url : null,
    source: typeof raw.source === 'string' ? raw.source : 'community',
    sourceLabel: typeof raw.sourceLabel === 'string' ? raw.sourceLabel : undefined,
  }
}

function fallbackCommunityServers(payload: unknown): CommunityServer[] {
  const lobbies = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (payload as { lobbies?: unknown }).lobbies
      : null
  if (!Array.isArray(lobbies)) return []
  return lobbies
    .map((lobby, index) => sanitizeCommunityServer(lobby, index))
    .filter((server): server is CommunityServer => Boolean(server && server.public))
}

/**
 * Reads the allowlisted public directories through the desktop shell. The
 * browser fallback only uses the VAULTED summary so preview mode still shows
 * counts without turning the renderer into an arbitrary URL fetcher.
 */
export async function fetchCommunityDirectory(
  query: CommunityServerQuery = {},
): Promise<CommunityServerResult> {
  try {
    const result = await window.arc?.fetchCommunityServers?.({
      token: query.token ?? undefined,
      seasonId: query.seasonId ?? undefined,
      providerId: query.providerId ?? undefined,
      force: query.force === true,
    })
    if (result) {
      return {
        servers: (Array.isArray(result.servers) ? result.servers : [])
          .map((server, index) => sanitizeCommunityServer(server, index))
          .filter((server): server is CommunityServer => Boolean(server && server.public)),
        statuses: (Array.isArray(result.statuses) ? result.statuses : [])
          .map(sanitizeProviderStatus)
          .filter((status): status is CommunityProviderStatus => Boolean(status)),
        directories: (Array.isArray(result.directories) ? result.directories : [])
          .map(sanitizeDirectoryEntry)
          .filter((entry): entry is CommunityDirectoryEntry => Boolean(entry)),
        errors: Array.isArray(result.errors)
          ? result.errors.filter(
              (error): error is { endpoint: string; message: string } =>
                Boolean(error && typeof error.endpoint === 'string' && typeof error.message === 'string'),
            )
          : [],
        checkedAt: typeof result.checkedAt === 'string' ? result.checkedAt : new Date().toISOString(),
      }
    }
  } catch {
    /* fall through to the browser-safe relay query */
  }

  const empty: CommunityServerResult = {
    servers: [],
    statuses: [],
    directories: [],
    errors: [],
    checkedAt: new Date().toISOString(),
  }
  if (!query.token) return empty
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(`${FRIENDS_API_BASE}/summary`, {
      headers: { authorization: `Bearer ${query.token}` },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) return empty
    return {
      ...empty,
      servers: fallbackCommunityServers(await response.json()).filter((server) => {
        if (query.seasonId && server.seasonId && server.seasonId !== query.seasonId) return false
        if (query.providerId && server.providerId !== 'community' && server.providerId !== query.providerId) return false
        return true
      }),
    }
  } catch {
    return empty
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchCommunityServers(query: CommunityServerQuery = {}): Promise<CommunityServer[]> {
  return (await fetchCommunityDirectory(query)).servers
}

/** Refresh global backend health/population through the trusted main process. */
export async function fetchProviderLiveStatuses(): Promise<Record<string, ProviderLiveStatus>> {
  const result = await window.arc?.providerLiveStatus?.()
  if (!result || typeof result !== 'object') return {}
  const statuses: Record<string, ProviderLiveStatus> = {}
  for (const [providerId, value] of Object.entries(result)) {
    const raw = value as Partial<ProviderLiveStatus>
    if (!providerId || typeof raw !== 'object' || raw === null || raw.online !== true) continue
    const players = Number(raw.players)
    const servers = Number(raw.servers)
    const pingMs = Number(raw.pingMs)
    statuses[providerId] = {
      providerId,
      online: true,
      players: Number.isFinite(players) && players >= 0 ? Math.floor(players) : undefined,
      servers:
        Number.isFinite(servers) && servers > 0
          ? Math.floor(servers)
          : 1,
      pingMs: Number.isFinite(pingMs) && pingMs >= 0 ? Math.round(pingMs) : undefined,
      checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : new Date().toISOString(),
    }
  }
  // An explicitly offline backend still needs to clear the previous sample.
  for (const [providerId, value] of Object.entries(result)) {
    if (!providerId || statuses[providerId]) continue
    const raw = value as Partial<ProviderLiveStatus>
    if (!raw || typeof raw !== 'object' || raw.online !== false) continue
    statuses[providerId] = {
      providerId,
      online: false,
      servers: 0,
      checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : new Date().toISOString(),
    }
  }
  return statuses
}

export async function fetchActive(): Promise<ActiveCounts> {
  const data = await request<{ counts?: Record<string, number>; total?: number }>('/api/active')
  return { counts: data.counts ?? {}, total: data.total ?? 0 }
}

/* ---------------------------------------------------------------- manifest */

export interface BuildSource {
  /** stable card/build id, e.g. ch1-s3 */
  id?: string
  title?: string
  /** version string, e.g. 3.6 */
  buildVersion?: string
  /** direct archive endpoint for the one-click download */
  downloadUrl?: string
  /** bucket fallback, e.g. {base}/{buildVersion}.zip when {id}.zip is absent */
  fallbackDownloadUrl?: string
  /** decimal gigabytes, precomputed for the card labels */
  sizeGB?: number
  /** which bundled runtime Play should use */
  runtimeProfile?: 'legacy' | 'modern'
  /** {AppDefaultBuildsDir}\{id} */
  defaultInstallDir?: string
  url: string
  version?: string
  sha256?: string
  /** archive size in bytes, used by the library download labels */
  sizeBytes?: number
  servers?: Array<{ name: string; url: string }>
  /** bundled community client that hosts this exact season */
  onlineProvider?: OnlineProviderConfig
  /** extra seasons can declare their own chapter/season metadata */
  chapter?: number
  season?: number
  label?: string
  short?: string
  era?: string
  artKey?: string
}

export interface BuildManifest {
  updatedAt?: string
  seasons: Record<string, BuildSource>
}

export function manifestUrl(): string {
  try {
    const override = localStorage.getItem(MANIFEST_KEY)
    if (override && /^https?:\/\//i.test(override)) return override
  } catch {
    /* ignore */
  }
  return `${API_BASE}/builds.json`
}

export function setManifestUrl(url: string | null): void {
  try {
    if (!url) localStorage.removeItem(MANIFEST_KEY)
    else localStorage.setItem(MANIFEST_KEY, url.trim())
  } catch {
    /* ignore */
  }
}

export async function fetchManifest(): Promise<BuildManifest> {
  const url = manifestUrl()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw apiError(`Build sources answered ${response.status}.`, response.status)
    const data = (await response.json()) as BuildManifest
    if (!data || typeof data !== 'object' || typeof data.seasons !== 'object' || data.seasons === null) {
      throw apiError('Build sources are in an unexpected format.')
    }
    // The bundled sources ship with the app and are the verified set, so they
    // win for every season the app already knows. A remote manifest can still
    // add seasons that were released after this build.
    const merged: BuildManifest = {
      ...data,
      seasons: { ...data.seasons, ...(defaultBuilds as BuildManifest).seasons },
    }
    return merged
  } catch (error) {
    // fall back to the manifest bundled with the app
    return defaultBuilds as BuildManifest
  } finally {
    clearTimeout(timer)
  }
}

/* ----------------------------------------------------------------- updates */

export interface LatestRelease {
  version: string
  url?: string
  notes?: string
}

export async function fetchLatest(): Promise<LatestRelease> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(`${API_BASE}/latest.json`, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw apiError(`Update feed answered ${response.status}.`, response.status)
    return (await response.json()) as LatestRelease
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchGitHubLatest(): Promise<LatestRelease | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
    const response = await fetch('https://api.github.com/repos/toer15/vaulted-launcher/releases/latest', {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json' },
    })
    clearTimeout(timer)
    if (!response.ok) return null
    const data = (await response.json()) as { tag_name?: string; assets?: Array<{ browser_download_url?: string; name?: string }> }
    const version = String(data?.tag_name ?? '').replace(/^v/i, '')
    if (!version) return null
    const asset = data.assets?.find((item) => /\.exe$/i.test(item.name ?? '')) ?? data.assets?.[0]
    return { version, url: asset?.browser_download_url }
  } catch {
    return null
  }
}
export function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}
