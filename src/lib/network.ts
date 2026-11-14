/**
 * VAULTED Network client.
 *
 * One small service hosts accounts, the per-season presence counter, the build
 * source manifest and the update feed. Everything degrades gracefully: if the
 * service is unreachable the launcher still runs, it just can't count players
 * or pull a download URL.
 */

import defaultBuilds from '../assets/builds.json'

export const API_BASE =
  'https://site-c377de5341934c84b54b325555448242.freebuff.page'

const SESSION_KEY = 'vaulted.session.v1'
const MANIFEST_KEY = 'vaulted.manifest.v1'
const REQUEST_TIMEOUT = 10_000

export interface RiftUser {
  id: string
  username: string
}

export interface RiftSession {
  token: string
  user: RiftUser
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
    if (!parsed?.token || !parsed?.user?.username) return null
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
  const raw = JSON.stringify(session)
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

/* ---------------------------------------------------------------- presence */

export async function sendHeartbeat(token: string, seasons: string[]): Promise<void> {
  if (seasons.length === 0) return
  await request('/api/presence', { method: 'POST', token, body: { seasons } })
}

export interface ActiveCounts {
  counts: Record<string, number>
  total: number
}

export async function fetchActive(): Promise<ActiveCounts> {
  const data = await request<{ counts?: Record<string, number>; total?: number }>('/api/active')
  return { counts: data.counts ?? {}, total: data.total ?? 0 }
}

/* ---------------------------------------------------------------- manifest */

export interface BuildSource {
  url: string
  version?: string
  sha256?: string
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
    return data
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

export async function openExternal(url: string): Promise<void> {
  if (typeof window !== 'undefined' && window.arc?.openExternal) {
    await window.arc.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
