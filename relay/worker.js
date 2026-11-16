/**
 * VAULTED account + friends relay.
 *
 * Accounts are username + password (PBKDF2 hashed). A device holds a session
 * token, never the password, and a name belongs to the account — not to an
 * install — so reinstalling or switching PCs only requires signing in again.
 *
 * QR sign-in: the desktop asks for a code, the phone opens /qr/<code>, signs in
 * with the password and approves, and the desktop polls the session in.
 */

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'cache-control': 'no-store',
}

const SESSION_DAYS = 90
const CODE_MINUTES = 5

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown'
}

function limitKey(request, bucket, suffix) {
  return `${bucket}:${clientIp(request)}:${suffix || ''}`
}

/**
 * Attempts are counted in D1 so a scripted guess run cannot dodge the limit by
 * landing on a different Worker isolate. Returns 0 when allowed, otherwise the
 * seconds left on the lockout.
 */
async function rateLimit(env, request, bucket, limit, windowMs, suffix) {
  const key = limitKey(request, bucket, suffix)
  const now = Date.now()
  const row = await env.DB.prepare('SELECT count, reset_at FROM auth_attempts WHERE key = ?').bind(key).first()
  let count = 1
  let resetAt = now + windowMs
  if (row) {
    const existing = new Date(row.reset_at).getTime()
    if (existing > now) {
      count = row.count + 1
      resetAt = existing
    }
  }
  await env.DB.prepare(
    'INSERT INTO auth_attempts (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at',
  )
    .bind(key, count, new Date(resetAt).toISOString())
    .run()
  if (count === 1) {
    // A fresh window is the natural moment to drop counters nobody can hit
    // any more, instead of paying for a delete on every attempt.
    try {
      await env.DB.prepare('DELETE FROM auth_attempts WHERE reset_at < ?').bind(new Date(now).toISOString()).run()
    } catch {
      /* pruning is best effort */
    }
  }
  if (count > limit) return Math.max(1, Math.ceil((resetAt - now) / 1000))
  return 0
}

async function clearRateLimit(env, request, bucket, suffix) {
  try {
    await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(limitKey(request, bucket, suffix)).run()
  } catch {
    /* a stale counter is not worth failing a successful sign-in */
  }
}

function tooManyAttempts(retry) {
  return new Response(
    JSON.stringify({ error: `Too many attempts. Try again in ${retry} second${retry === 1 ? '' : 's'}.` }),
    { status: 429, headers: { ...HEADERS, 'retry-after': String(retry) } },
  )
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS })
}

function key(value) {
  return String(value || '').trim().toLowerCase()
}

function display(value) {
  return String(value || '').trim().slice(0, 32)
}

function validName(name) {
  return /^[a-zA-Z0-9_.\- ]{2,32}$/.test(name)
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString()
}

function randomDigits(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

function recoveryCode() {
  const raw = randomDigits(12)
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
}

function newToken() {
  return `${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, '')}`
}

function bytesToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    // Kept modest so a sign-in stays inside the Workers CPU budget.
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 2500, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return bytesToBase64(new Uint8Array(bits))
}

async function hashRecovery(code, salt) {
  const encoder = new TextEncoder()
  const bits = await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${code}`))
  return bytesToBase64(new Uint8Array(bits))
}

async function makePassword(password) {
  const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)))
  return { salt, hash: await hashPassword(password, salt) }
}

async function makeRecovery(code) {
  const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)))
  return { salt, hash: await hashRecovery(code, salt) }
}

function sameSecret(candidate, hash) {
  if (!hash || candidate.length !== hash.length) return false
  let diff = 0
  for (let i = 0; i < candidate.length; i += 1) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i)
  return diff === 0
}

async function matchesPassword(password, salt, hash) {
  if (!salt || !hash) return false
  return sameSecret(await hashPassword(password, salt), hash)
}

async function matchesRecovery(code, salt, hash) {
  if (!salt || !hash) return false
  return sameSecret(await hashRecovery(code, salt), hash)
}

let schemaPromise = null
function schema(env) {
  if (!schemaPromise) {
    schemaPromise = env.DB.batch([
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS users (lower TEXT PRIMARY KEY, username TEXT NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, recovery_hash TEXT NOT NULL, recovery_salt TEXT NOT NULL, created TEXT NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS auth_sessions (token TEXT PRIMARY KEY, lower TEXT NOT NULL, created TEXT NOT NULL, expires TEXT NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS pairs_v2 (a TEXT NOT NULL, b TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (a, b))',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS login_codes (code TEXT PRIMARY KEY, status TEXT NOT NULL, lower TEXT, token TEXT, created TEXT NOT NULL, expires TEXT NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at TEXT NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS sessions_v2 (lower TEXT PRIMARY KEY, address TEXT NOT NULL, build_id TEXT, label TEXT, public INTEGER NOT NULL DEFAULT 0, season_id TEXT, players INTEGER NOT NULL DEFAULT 1, updated TEXT NOT NULL)',
      ),
    ])
      .then(async () => {
        // Older deployments created sessions_v2 without the lobby metadata.
        for (const sql of [
          'ALTER TABLE sessions_v2 ADD COLUMN build_id TEXT',
          'ALTER TABLE sessions_v2 ADD COLUMN label TEXT',
          'ALTER TABLE sessions_v2 ADD COLUMN public INTEGER NOT NULL DEFAULT 0',
          'ALTER TABLE sessions_v2 ADD COLUMN season_id TEXT',
          'ALTER TABLE sessions_v2 ADD COLUMN players INTEGER NOT NULL DEFAULT 1',
        ]) {
          try {
            await env.DB.prepare(sql).run()
          } catch {
            /* the column already exists */
          }
        }
      })
      .catch((error) => {
        schemaPromise = null
        throw error
      })
  }
  return schemaPromise
}

async function readBody(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

function bearer(request) {
  const header = request.headers.get('authorization') || ''
  if (header) return header.replace(/^Bearer\s+/i, '').trim()
  return new URL(request.url).searchParams.get('token') || ''
}

async function sessionUser(env, request) {
  const token = bearer(request)
  if (!token) return null
  const row = await env.DB.prepare(
    'SELECT s.token, s.expires, u.lower, u.username FROM auth_sessions s JOIN users u ON u.lower = s.lower WHERE s.token = ?',
  )
    .bind(token)
    .first()
  if (!row) return null
  if (row.expires && new Date(row.expires).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run()
    return null
  }
  return row
}

async function createSession(env, lower) {
  const token = newToken()
  await env.DB.prepare('INSERT INTO auth_sessions (token, lower, created, expires) VALUES (?, ?, ?, ?)')
    .bind(token, lower, new Date().toISOString(), isoIn(SESSION_DAYS * 24 * 60 * 60 * 1000))
    .run()
  return token
}

async function summaryFor(env, user) {
  const me = user.lower
  const { results } = await env.DB.prepare(
    `SELECT p.a, p.b, p.status, p.at, a.username AS a_name, b.username AS b_name
       FROM pairs_v2 p
       JOIN users a ON a.lower = p.a
       JOIN users b ON b.lower = p.b
      WHERE p.a = ? OR p.b = ?`,
  )
    .bind(me, me)
    .all()

  const friends = []
  const incoming = []
  const outgoing = []

  for (const row of results || []) {
    if (row.status === 'accepted') {
      friends.push(row.a === me ? row.b_name : row.a_name)
    } else if (row.status === 'pending') {
      if (row.b === me) incoming.push({ from: row.a_name, at: row.at })
      if (row.a === me) outgoing.push({ to: row.b_name, at: row.at })
    }
  }

  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const row = (value) => ({
    username: value.name,
    address: value.address,
    buildId: value.build_id || null,
    label: value.label || null,
    public: Boolean(value.public),
    seasonId: value.season_id || null,
    players: Math.max(1, Math.min(100, Number(value.players) || 1)),
    updated: value.updated,
  })

  const { results: live } = await env.DB.prepare(
    `SELECT u.username AS name, s.address AS address, s.build_id, s.label, s.public, s.season_id, s.players, s.updated AS updated
       FROM sessions_v2 s
       JOIN users u ON u.lower = s.lower
       JOIN pairs_v2 p ON p.status = 'accepted' AND ((p.a = ? AND p.b = s.lower) OR (p.b = ? AND p.a = s.lower))
      WHERE s.updated > ?`,
  )
    .bind(me, me, cutoff)
    .all()

  const hosting = (live || []).map(row)

  const { results: open } = await env.DB.prepare(
    `SELECT u.username AS name, s.address AS address, s.build_id, s.label, s.public, s.season_id, s.players, s.updated AS updated
       FROM sessions_v2 s
       JOIN users u ON u.lower = s.lower
      WHERE s.updated > ? AND s.lower != ? AND s.public = 1
      ORDER BY s.updated DESC
      LIMIT 60`,
  )
    .bind(cutoff, me)
    .all()

  const lobbies = (open || []).map(row)

  const own = await env.DB.prepare(
    `SELECT u.username AS name, s.address AS address, s.build_id, s.label, s.public, s.season_id, s.players, s.updated AS updated
       FROM sessions_v2 s
       JOIN users u ON u.lower = s.lower
      WHERE s.lower = ? AND s.updated > ?`,
  )
    .bind(me, cutoff)
    .first()

  return { username: user.username, friends, incoming, outgoing, hosting, lobbies, mine: own ? row(own) : null }
}

async function accountByLower(env, lower) {
  return env.DB.prepare('SELECT * FROM users WHERE lower = ?').bind(lower).first()
}

const PHONE_PAGE = (code) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Sign in to VAULTED</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #1c1f3a, #05060a 70%); color: #e7e9f5; }
  .card { width: 100%; max-width: 380px; background: rgba(20, 23, 38, 0.9); border: 1px solid #2a2f45;
    border-radius: 20px; padding: 22px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { color: #9aa3bf; font-size: 13px; margin: 0 0 18px; line-height: 1.5; }
  label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #9aa3bf; margin: 12px 0 6px; }
  input { width: 100%; padding: 12px; border-radius: 12px; border: 1px solid #2a2f45; background: #0b0e18; color: #fff; font-size: 15px; }
  input:focus { outline: none; border-color: #6c7cff; }
  button { width: 100%; margin-top: 18px; padding: 13px; border: 0; border-radius: 12px; font-size: 15px; font-weight: 600;
    color: #fff; background: linear-gradient(135deg, #6c7cff, #a855f7); cursor: pointer; }
  button:disabled { opacity: .6; }
  .note { margin-top: 14px; font-size: 12.5px; min-height: 18px; }
  .ok { color: #6ee7a8; } .bad { color: #ff9db1; }
  .code { font-family: ui-monospace, monospace; letter-spacing: .12em; color: #cfd4ff; }
</style></head>
<body>
  <main class="card">
    <h1>Sign in to VAULTED</h1>
    <p>This phone will approve the launcher for code <span class="code">${code}</span>. Your password is only sent to the VAULTED relay.</p>
    <form id="form">
      <label for="username">Username</label>
      <input id="username" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" required />
      <button id="submit" type="submit">Approve sign-in</button>
    </form>
    <div class="note" id="note"></div>
  </main>
<script>
  const form = document.getElementById('form')
  const note = document.getElementById('note')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = document.getElementById('submit')
    button.disabled = true
    note.className = 'note'
    note.textContent = 'Approving…'
    try {
      const response = await fetch('/api/qr/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: ${JSON.stringify(code)},
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
        }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Could not approve that sign-in.')
      note.className = 'note ok'
      note.textContent = 'Approved. You can return to the launcher now.'
      form.style.display = 'none'
    } catch (error) {
      note.className = 'note bad'
      note.textContent = error.message
      button.disabled = false
    }
  })
</script>
</body></html>`

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response('', { headers: HEADERS })
    if (!env.DB) return json({ error: 'The relay has no database bound.' }, 500)

    try {
      await schema(env)
    } catch {
      return json({ error: 'The relay could not reach its database.' }, 500)
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'VAULTED accounts + friends relay' })
    }

    if (request.method === 'GET' && url.pathname.startsWith('/qr/')) {
      const code = decodeURIComponent(url.pathname.slice('/qr/'.length)).toUpperCase()
      const row = await env.DB.prepare('SELECT code, status, expires FROM login_codes WHERE code = ?').bind(code).first()
      const expired = !row || new Date(row.expires).getTime() < Date.now()
      const used = row && row.status === 'approved'
      if (expired || used) {
        return new Response(
          '<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;background:#05060a;color:#e7e9f5;display:grid;place-items:center;height:100vh"><p>This sign-in code has expired. Start a new one in the launcher.</p></body>',
          { status: 410, headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      }
      return new Response(PHONE_PAGE(code), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }

    if (request.method === 'POST' && url.pathname === '/api/account/register') {
      const wait = await rateLimit(env, request, 'register', 5, 10 * 60 * 1000)
      if (wait) return tooManyAttempts(wait)
      const body = await readBody(request)
      const username = display(body.username)
      const password = String(body.password || '')
      if (!validName(username)) {
        return json({ error: 'Pick a username of 2–32 letters, numbers, spaces, dots, dashes or underscores.' }, 400)
      }
      if (!validPassword(password)) return json({ error: 'Passwords need at least 8 characters.' }, 400)

      const existing = await accountByLower(env, key(username))
      if (existing) {
        return json({ error: `The name ${existing.username} is already registered. Sign in instead, or use “Forgot password”.` }, 409)
      }

      const pass = await makePassword(password)
      const recovery = recoveryCode()
      const rec = await makeRecovery(recovery.replace(/-/g, ''))
      try {
        await env.DB.prepare(
          'INSERT INTO users (lower, username, pass_hash, pass_salt, recovery_hash, recovery_salt, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
          .bind(key(username), username, pass.hash, pass.salt, rec.hash, rec.salt, new Date().toISOString())
          .run()
      } catch {
        return json({ error: 'That username was just taken. Pick another one.' }, 409)
      }

      const user = await accountByLower(env, key(username))
      // Registration counts are deliberately not cleared on success: otherwise
      // a script could keep minting accounts forever.
      const token = await createSession(env, user.lower)
      return json({ token, username: user.username, recoveryCode: recovery })
    }

    if (request.method === 'POST' && url.pathname === '/api/account/login') {
      const body = await readBody(request)
      const wait = await rateLimit(env, request, 'login', 6, 60 * 1000, key(body.username))
      if (wait) return tooManyAttempts(wait)
      const user = await accountByLower(env, key(body.username))
      const password = String(body.password || '')
      if (!user || !(await matchesPassword(password, user.pass_salt, user.pass_hash))) {
        return json({ error: 'That username and password don’t match.' }, 401)
      }
      await clearRateLimit(env, request, 'login', user.lower)
      const token = await createSession(env, user.lower)
      return json({ token, username: user.username })
    }

    if (request.method === 'POST' && url.pathname === '/api/account/reset') {
      const body = await readBody(request)
      const wait = await rateLimit(env, request, 'reset', 4, 5 * 60 * 1000, key(body.username))
      if (wait) return tooManyAttempts(wait)
      const user = await accountByLower(env, key(body.username))
      const code = String(body.recoveryCode || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
      const password = String(body.password || '')
      if (!user) return json({ error: 'No account is using that username.' }, 404)
      if (!validPassword(password)) return json({ error: 'Passwords need at least 8 characters.' }, 400)
      if (!(await matchesRecovery(code, user.recovery_salt, user.recovery_hash))) {
        return json({ error: 'That recovery code is not correct.' }, 401)
      }

      const pass = await makePassword(password)
      const recovery = recoveryCode()
      const rec = await makeRecovery(recovery.replace(/-/g, ''))
      await env.DB.prepare(
        'UPDATE users SET pass_hash = ?, pass_salt = ?, recovery_hash = ?, recovery_salt = ? WHERE lower = ?',
      )
        .bind(pass.hash, pass.salt, rec.hash, rec.salt, user.lower)
        .run()
      await env.DB.prepare('DELETE FROM auth_sessions WHERE lower = ?').bind(user.lower).run()
      await clearRateLimit(env, request, 'reset', user.lower)
      await clearRateLimit(env, request, 'login', user.lower)
      const token = await createSession(env, user.lower)
      return json({ token, username: user.username, recoveryCode: recovery })
    }

    if (request.method === 'POST' && url.pathname === '/api/account/logout') {
      const user = await sessionUser(env, request)
      if (user) await env.DB.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(user.token).run()
      return json({ ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/api/account/me') {
      const user = await sessionUser(env, request)
      if (!user) return json({ error: 'Not signed in.' }, 401)
      return json({ username: user.username })
    }

    if (request.method === 'POST' && url.pathname === '/api/qr/start') {
      const code = randomDigits(8)
      await env.DB.prepare('DELETE FROM login_codes WHERE expires < ?').bind(new Date().toISOString()).run()
      await env.DB.prepare('INSERT INTO login_codes (code, status, lower, token, created, expires) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(code, 'pending', null, null, new Date().toISOString(), isoIn(CODE_MINUTES * 60 * 1000))
        .run()
      return json({ code, url: `${url.origin}/qr/${code}`, expiresIn: CODE_MINUTES * 60 })
    }

    if (request.method === 'GET' && url.pathname === '/api/qr/poll') {
      const code = String(url.searchParams.get('code') || '').toUpperCase()
      const row = await env.DB.prepare('SELECT code, status, lower, token, expires FROM login_codes WHERE code = ?')
        .bind(code)
        .first()
      if (!row) return json({ status: 'expired' })
      if (new Date(row.expires).getTime() < Date.now()) {
        await env.DB.prepare('DELETE FROM login_codes WHERE code = ?').bind(code).run()
        return json({ status: 'expired' })
      }
      if (row.status !== 'approved' || !row.token) return json({ status: 'pending' })
      const user = await accountByLower(env, row.lower)
      await env.DB.prepare('DELETE FROM login_codes WHERE code = ?').bind(code).run()
      return json({ status: 'approved', token: row.token, username: user ? user.username : null })
    }

    if (request.method === 'POST' && url.pathname === '/api/qr/approve') {
      const wait = await rateLimit(env, request, 'qr', 8, 5 * 60 * 1000)
      if (wait) return tooManyAttempts(wait)
      const body = await readBody(request)
      const code = String(body.code || '').toUpperCase()
      const row = await env.DB.prepare('SELECT code, status, expires FROM login_codes WHERE code = ?').bind(code).first()
      if (!row) return json({ error: 'That sign-in code is not valid any more.' }, 404)
      if (row.status === 'approved') return json({ error: 'That sign-in code was already used.' }, 409)
      if (new Date(row.expires).getTime() < Date.now()) {
        await env.DB.prepare('DELETE FROM login_codes WHERE code = ?').bind(code).run()
        return json({ error: 'That sign-in code has expired. Start a new one.' }, 410)
      }
      const user = await accountByLower(env, key(body.username))
      const password = String(body.password || '')
      if (!user || !(await matchesPassword(password, user.pass_salt, user.pass_hash))) {
        return json({ error: 'That username and password don’t match.' }, 401)
      }
      const token = await createSession(env, user.lower)
      await env.DB.prepare('UPDATE login_codes SET status = ?, lower = ?, token = ? WHERE code = ?')
        .bind('approved', user.lower, token, code)
        .run()
      await clearRateLimit(env, request, 'qr')
      return json({ ok: true, username: user.username })
    }

    if (request.method === 'POST' && url.pathname === '/api/session') {
      const user = await sessionUser(env, request)
      if (!user) return json({ error: 'Sign in to host a lobby.' }, 401)
      const body = await readBody(request)
      const address = String(body.address || '').trim().slice(0, 64)
      if (!/^[a-zA-Z0-9.-]{1,63}:\d{2,5}$/.test(address)) {
        return json({ error: 'That lobby address is not valid.' }, 400)
      }
      const buildId = String(body.buildId || '').trim().slice(0, 80) || null
      const label = String(body.label || '').trim().slice(0, 80) || null
      const seasonId = String(body.seasonId || '').trim().slice(0, 80) || null
      const players = Math.max(1, Math.min(100, Number(body.players) || 1))
      const visibility = body.public === true ? 1 : 0
      await env.DB.prepare(
        'INSERT INTO sessions_v2 (lower, address, build_id, label, public, season_id, players, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(lower) DO UPDATE SET address = excluded.address, build_id = excluded.build_id, label = excluded.label, public = excluded.public, season_id = excluded.season_id, players = excluded.players, updated = excluded.updated',
      )
        .bind(user.lower, address, buildId, label, visibility, seasonId, players, new Date().toISOString())
        .run()
      return json({ ok: true, address, buildId, label, public: Boolean(visibility), seasonId, players })
    }

    if (request.method === 'POST' && url.pathname === '/api/session/clear') {
      const user = await sessionUser(env, request)
      if (!user) return json({ error: 'Sign in first.' }, 401)
      await env.DB.prepare('DELETE FROM sessions_v2 WHERE lower = ?').bind(user.lower).run()
      return json({ ok: true })
    }

    // ---- friends (session authenticated) ----
    if (request.method === 'GET' && url.pathname === '/api/summary') {
      const user = await sessionUser(env, request)
      if (!user) return json({ error: 'Sign in to see your friends.' }, 401)
      return json(await summaryFor(env, user))
    }

    if (request.method === 'POST' && url.pathname === '/api/request') {
      const user = await sessionUser(env, request)
      if (!user) return json({ error: 'Sign in to add friends.' }, 401)
      const body = await readBody(request)
      const targetName = display(body.to)
      if (!validName(targetName)) {
        return json({ error: 'Enter a username of 2–32 letters, numbers, spaces, dots, dashes or underscores.' }, 400)
      }
      if (key(targetName) === user.lower) return json({ error: "You can't add yourself." }, 400)

      const target = await accountByLower(env, key(targetName))
      if (!target) {
        return json({ error: `No VAULTED account is using the name ${targetName} yet.` }, 404)
      }

      const existing = await env.DB.prepare('SELECT a, b, status FROM pairs_v2 WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)')
        .bind(user.lower, target.lower, target.lower, user.lower)
        .first()

      if (existing) {
        if (existing.status === 'accepted') return json({ error: `${target.username} is already on your friends list.` }, 409)
        if (existing.a === target.lower) {
          await env.DB.prepare('UPDATE pairs_v2 SET status = ?, at = ? WHERE a = ? AND b = ?')
            .bind('accepted', new Date().toISOString(), target.lower, user.lower)
            .run()
          return json({ ok: true, accepted: true, ...(await summaryFor(env, user)) })
        }
        return json({ error: `A request to ${target.username} is already pending.` }, 409)
      }

      await env.DB.prepare('INSERT INTO pairs_v2 (a, b, status, at) VALUES (?, ?, ?, ?)')
        .bind(user.lower, target.lower, 'pending', new Date().toISOString())
        .run()
      return json({ ok: true, accepted: false, ...(await summaryFor(env, user)) })
    }

    if (request.method === 'POST' && url.pathname === '/api/respond') {
      const user = await sessionUser(env, request)
      if (!user) return json({ error: 'Sign in to answer requests.' }, 401)
      const body = await readBody(request)
      const from = key(body.from)
      const accept = body.accept === true || body.accept === 'true'
      const pair = await env.DB.prepare('SELECT a, b, status FROM pairs_v2 WHERE a = ? AND b = ?').bind(from, user.lower).first()
      if (!pair || pair.status !== 'pending') return json({ error: 'That request is no longer available.' }, 404)
      if (accept) {
        await env.DB.prepare('UPDATE pairs_v2 SET status = ?, at = ? WHERE a = ? AND b = ?')
          .bind('accepted', new Date().toISOString(), from, user.lower)
          .run()
      } else {
        await env.DB.prepare('DELETE FROM pairs_v2 WHERE a = ? AND b = ?').bind(from, user.lower).run()
      }
      return json({ ok: true, ...(await summaryFor(env, user)) })
    }

    if (request.method === 'POST' && url.pathname === '/api/remove') {
      const user = await sessionUser(env, request)
      if (!user) return json({ error: 'Sign in to change your friends.' }, 401)
      const body = await readBody(request)
      const friend = key(body.friend)
      await env.DB.prepare('DELETE FROM pairs_v2 WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)')
        .bind(user.lower, friend, friend, user.lower)
        .run()
      return json({ ok: true, ...(await summaryFor(env, user)) })
    }

    return json({ error: 'Not found.' }, 404)
  },
}
