/**
 * VAULTED Network — tiny backend for the launcher.
 *
 *  POST /api/signup    { username, password } -> { token, user }
 *  POST /api/login     { username, password } -> { token, user }
 *  GET  /api/me        Bearer <token>         -> { user }
 *  POST /api/logout    Bearer <token>         -> { ok }
 *  POST /api/presence  Bearer, { seasons }    -> { ok }        (heartbeat)
 *  GET  /api/active                           -> { counts, total, ttl }
 *  GET  /builds.json                           -> build source manifest
 *  GET  /latest.json                           -> app update feed
 *
 * Accounts are username + password (letters, numbers, symbols; 6–64 chars).
 * Passwords are salted and stretched with PBKDF2 (the iteration count is kept
 * modest to stay inside Workers CPU limits);
 * session tokens are random and only their SHA-256 hash is stored.
 * Presence is a heartbeat per season; /api/active counts heartbeats from the
 * last 90 seconds, which is what the "active now" badges show.
 */

const SESSION_TTL = 365 * 24 * 60 * 60 * 1000
const PRESENCE_TTL = 90 * 1000
const PBKDF2_ITERATIONS = 12000

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  })

const bad = (message, status = 400) => json({ error: message }, status)

/* ------------------------------------------------------------------ schema */

let schemaReady = false

async function ensureSchema(env) {
  if (schemaReady) return
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS presence (
        user_id TEXT NOT NULL,
        season_key TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (user_id, season_key)
      )`,
    ),
  ])
  schemaReady = true
}

/* ------------------------------------------------------------------ crypto */

const enc = new TextEncoder()
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes))
const fromB64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return toB64(new Uint8Array(bits))
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function same(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ sessions */

function bearerToken(request) {
  const header = request.headers.get('authorization') || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

async function sessionUser(request, env) {
  const token = bearerToken(request)
  if (!token) return null

  const tokenHash = await sha256(token)
  const row = await env.DB.prepare(
    `SELECT s.expires_at AS expiresAt, u.id AS id, u.username AS username
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`,
  )
    .bind(tokenHash)
    .first()

  if (!row) return null
  if (row.expiresAt < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run()
    return null
  }

  return { id: row.id, username: row.username }
}

async function createSession(env, userId) {
  const token = newToken()
  const tokenHash = await sha256(token)
  const now = Date.now()
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, userId, now, now + SESSION_TTL)
    .run()
  return token
}

/* -------------------------------------------------------------------- routes */

async function signup(request, env) {
  const body = await readJson(request)
  const username = String(body?.username ?? '').trim()
  const password = String(body?.password ?? '').trim()

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return bad('Username: 3–20 letters, numbers or underscores.', 422)
  }
  if (!/^[\x21-\x7E]{6,64}$/.test(password)) {
    return bad('Password must be 6–64 characters, no spaces.', 422)
  }

  const lower = username.toLowerCase()
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username_lower = ?').bind(lower).first()
  if (existing) return bad('That username is taken.', 409)

  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)))
  const hash = await hashPassword(password, fromB64(salt))
  const id = crypto.randomUUID()

  try {
    await env.DB.prepare(
      'INSERT INTO users (id, username, username_lower, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(id, username, lower, salt, hash, Date.now())
      .run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) return bad('That username is taken.', 409)
    throw error
  }

  const token = await createSession(env, id)
  return json({ token, user: { id, username } }, 201)
}

async function login(request, env) {
  const body = await readJson(request)
  const username = String(body?.username ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '').trim()
  if (!username || !password) return bad('Username and password are required.', 422)

  const row = await env.DB.prepare('SELECT id, username, salt, hash FROM users WHERE username_lower = ?')
    .bind(username)
    .first()
  if (!row) return bad('Wrong username or password.', 401)

  const hash = await hashPassword(password, fromB64(row.salt))
  if (!same(hash, row.hash)) return bad('Wrong username or password.', 401)

  const token = await createSession(env, row.id)
  return json({ token, user: { id: row.id, username: row.username } })
}

async function me(request, env) {
  const user = await sessionUser(request, env)
  if (!user) return bad('Not signed in.', 401)

  // sliding expiry: every launch keeps the session alive for another year
  const token = bearerToken(request)
  if (token) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
      .bind(Date.now() + SESSION_TTL, await sha256(token))
      .run()
  }

  return json({ user: { id: user.id, username: user.username } })
}

async function logout(request, env) {
  const token = bearerToken(request)
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256(token)).run()
  }
  return json({ ok: true })
}

async function presence(request, env) {
  const user = await sessionUser(request, env)
  if (!user) return bad('Not signed in.', 401)

  const body = await readJson(request)
  const keys = Array.isArray(body?.seasons)
    ? [...new Set(body.seasons.map((key) => String(key)).filter((key) => /^[a-z0-9-]{2,48}$/.test(key)))].slice(0, 20)
    : []
  if (keys.length === 0) return bad('No seasons supplied.', 422)

  const now = Date.now()
  await env.DB.batch(
    keys.map((key) =>
      env.DB.prepare(
        `INSERT INTO presence (user_id, season_key, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(user_id, season_key) DO UPDATE SET last_seen = excluded.last_seen`,
      )
        .bind(user.id, key, now),
    ),
  )

  // occasional tidy-up of rows nobody has refreshed for a day
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - 24 * 60 * 60 * 1000).run()
  }

  return json({ ok: true })
}

async function active(env) {
  const now = Date.now()
  const rows = await env.DB.prepare(
    'SELECT season_key AS seasonKey, COUNT(*) AS count FROM presence WHERE last_seen > ? GROUP BY season_key',
  )
    .bind(now - PRESENCE_TTL)
    .all()

  const counts = {}
  let total = 0
  for (const row of rows.results ?? []) {
    counts[row.seasonKey] = Number(row.count)
    total += Number(row.count)
  }

  return json({ counts, total, ttl: PRESENCE_TTL })
}

/* ------------------------------------------------------------------ static */

async function assetJson(env, pathname) {
  if (!env.ASSETS) return json({ error: 'Not found' }, 404)
  const response = await env.ASSETS.fetch(new Request(`https://assets.local${pathname}`))
  if (!response.ok) return json({ error: 'Not found' }, 404)
  const body = await response.text()
  return new Response(body, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (url.pathname === '/builds.json' || url.pathname === '/latest.json') {
      return assetJson(env, url.pathname)
    }

    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) {
        const response = await env.ASSETS.fetch(request)
        if (response.status !== 404) return response
      }
      return json({ service: 'VAULTED Network', ok: true })
    }

    try {
      await ensureSchema(env)

      if (url.pathname === '/api/health') return json({ ok: true, time: Date.now() })
      if (url.pathname === '/api/signup' && request.method === 'POST') return signup(request, env)
      if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env)
      if (url.pathname === '/api/me' && request.method === 'GET') return me(request, env)
      if (url.pathname === '/api/logout' && request.method === 'POST') return logout(request, env)
      if (url.pathname === '/api/presence' && request.method === 'POST') return presence(request, env)
      if (url.pathname === '/api/active' && request.method === 'GET') return active(env)

      return bad('Unknown endpoint.', 404)
    } catch (error) {
      console.error('VAULTED API error', error)
      return bad('Server error.', 500)
    }
  },
}
