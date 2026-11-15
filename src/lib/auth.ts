/**
 * VAULTED account session.
 *
 * The password is never stored — only a long-lived session token, kept in the
 * launcher's userData folder so reinstalling keeps you signed in, and mirrored
 * to localStorage for the browser preview.
 */

const API = 'https://site-710f0be1e3b24f2694e9e13b9ce4c84b.freebuff.page/api'
const SESSION_KEY = 'vaulted.account.session'

export interface AccountSession {
  username: string
  token: string
}

export interface QrStart {
  code: string
  url: string
  expiresIn: number
}

export type QrPoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'approved'; token: string; username: string | null }

let cached: AccountSession | null | undefined

async function readStored(): Promise<AccountSession | null> {
  try {
    const raw = await window.arc?.accountSession?.read?.()
    if (raw) {
      const parsed = JSON.parse(raw) as AccountSession
      if (parsed?.token && parsed?.username) return parsed
    }
  } catch {
    /* fall through */
  }
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AccountSession
      if (parsed?.token && parsed?.username) return parsed
    }
  } catch {
    /* no storage */
  }
  return null
}

export async function getSession(): Promise<AccountSession | null> {
  if (cached !== undefined) return cached
  cached = await readStored()
  return cached
}

export async function setSession(session: AccountSession): Promise<void> {
  cached = session
  try {
    await window.arc?.accountSession?.save?.(JSON.stringify(session))
  } catch {
    /* bridge unavailable */
  }
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* storage disabled */
  }
}

export async function clearSession(): Promise<void> {
  cached = null
  try {
    await window.arc?.accountSession?.clear?.()
  } catch {
    /* bridge unavailable */
  }
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* storage disabled */
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string }
    if (payload?.error) return payload.error
  } catch {
    /* not json */
  }
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after') || 0)
    return retry > 0
      ? `Too many attempts. Try again in ${retry} second${retry === 1 ? '' : 's'}.`
      : 'Too many attempts right now. Wait a moment and try again.'
  }
  return `The account service answered ${response.status}.`
}

async function post<T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(await readError(response))
  return (await response.json()) as T
}

export async function register(username: string, password: string): Promise<{ session: AccountSession; recoveryCode: string }> {
  const payload = await post<{ token: string; username: string; recoveryCode: string }>('/account/register', {
    username,
    password,
  })
  const session = { username: payload.username, token: payload.token }
  await setSession(session)
  return { session, recoveryCode: payload.recoveryCode }
}

export async function login(username: string, password: string): Promise<AccountSession> {
  const payload = await post<{ token: string; username: string }>('/account/login', { username, password })
  const session = { username: payload.username, token: payload.token }
  await setSession(session)
  return session
}

export async function resetPassword(
  username: string,
  recoveryCode: string,
  password: string,
): Promise<{ session: AccountSession; recoveryCode: string }> {
  const payload = await post<{ token: string; username: string; recoveryCode: string }>('/account/reset', {
    username,
    recoveryCode,
    password,
  })
  const session = { username: payload.username, token: payload.token }
  await setSession(session)
  return { session, recoveryCode: payload.recoveryCode }
}

export function startQr(): Promise<QrStart> {
  return post<QrStart>('/qr/start', {})
}

export async function pollQr(code: string): Promise<QrPoll> {
  const response = await fetch(`${API}/qr/poll?code=${encodeURIComponent(code)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(await readError(response))
  return (await response.json()) as QrPoll
}

export async function signOut(): Promise<void> {
  const session = await getSession()
  await clearSession()
  if (!session) return
  try {
    await post('/account/logout', {}, session.token)
  } catch {
    /* offline sign-out is still a sign-out */
  }
}
