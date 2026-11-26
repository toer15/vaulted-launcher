'use strict'

/**
 * Which companion launcher this PC is actually signed into.
 *
 * Each project owns its own account, so a season may only unlock when that
 * exact launcher has a saved session. VAULTED reads the launcher's documented
 * store first:
 *
 *   Eon      %LOCALAPPDATA%\EonLauncherV2\Settings.ini   [Credentials]
 *   Omen     %APPDATA%\launcher.omenmp.mp\.auth          account.accessToken
 *   Hestia   %LOCALAPPDATA%\xyz.hestia.launcher\EBWebView\...  launcherToken
 *   Others   their Electron/WebView2 Local Storage token
 *
 * A launcher that is already open is also asked directly through its own
 * session API (Era session.get, Hydro authGetSession, Neo getSession, Omen
 * LauncherManager, or the page's saved token). The result is always keyed to
 * one provider id; nothing is guessed globally.
 */

const fs = require('node:fs')
const path = require('node:path')
const { evaluateOnPage, waitForLauncherPage } = require('./communityBridge.cjs')
const { readEonConfig } = require('./companionPlay.cjs')

const MAX_STORE_FILES = 8
const MAX_STORE_BYTES = 4 * 1024 * 1024
const TOKEN_KEY = /token|auth|session|credential/i
const IGNORED_KEY =
  /(?:seen|news|trailer|theme|colou?r|library|options|settings|app_info|client\.store|version|build|folder|path|fps|mode)/i
const TOKEN_VALUE = /^(?:Bearer\s+)?([A-Za-z0-9._~+/=-]{16,})$/i

const LOCAL = process.env.LOCALAPPDATA || ''
const ROAMING = process.env.APPDATA || ''

const discoveredRootsCache = new Map()

function normalizeId(value) {
  return String(value || '').trim().toLowerCase()
}

function join(...parts) {
  const clean = parts.filter(Boolean)
  if (clean.length === 0) return ''
  return path.join(...clean)
}

function leveldbFiles(directory) {
  let entries = []
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/\.(?:log|ldb)$/i.test(entry.name)) continue
    const full = path.join(directory, entry.name)
    try {
      files.push({ file: full, modified: fs.statSync(full).mtimeMs })
    } catch {
      /* a locked or removed shard is skipped */
    }
  }
  files.sort((left, right) => right.modified - left.modified)
  return files.slice(0, MAX_STORE_FILES).map((entry) => entry.file)
}

function readStoreText(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return ''
    return fs.readFileSync(file).toString('latin1')
  } catch {
    return ''
  }
}

/** A token written directly after a known Local Storage key. */
function tokenAfterKey(text, key) {
  const lower = text.toLowerCase()
  const needle = String(key || '').toLowerCase()
  if (!needle) return ''
  let at = lower.indexOf(needle)
  let guard = 0
  while (at >= 0 && guard < 8) {
    guard += 1
    const tail = text.slice(at + needle.length, at + needle.length + 400)
    const bearer = tail.match(/Bearer\s+([A-Za-z0-9._~+/=-]{12,})/i)
    if (bearer) return bearer[1]
    const direct = tail.match(/^[\x00-\x1f\s"',]{0,24}([A-Za-z0-9._~+/=-]{18,})/)
    if (direct && !/^(?:https?|file):/i.test(direct[1]) && !IGNORED_KEY.test(direct[1])) {
      return direct[1]
    }
    at = lower.indexOf(needle, at + needle.length)
  }
  return ''
}

/**
 * A bearer or JWT token anywhere in the store. Local Storage key names differ
 * between projects (Era, Hydro, Retrac, Stellar, EZFN), so the value itself is
 * the signal rather than one hard-coded key.
 */
function genericToken(text) {
  const bearer = text.match(/Bearer\s+([A-Za-z0-9._~+/=-]{16,})/i)
  if (bearer) return bearer[1]
  const runs = text.split(/[^\x20-\x7e]+/)
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]
    if (run.length < 8 || !TOKEN_KEY.test(run) || IGNORED_KEY.test(run)) continue
    const jwt = run.match(/(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/)
    if (jwt) return jwt[1]
    for (let next = index + 1; next <= index + 2 && next < runs.length; next += 1) {
      const value = runs[next].trim().replace(/^["',]+|["',]+$/g, '')
      const token = value.match(TOKEN_VALUE)
      if (token && !IGNORED_KEY.test(token[1]) && !/^(?:https?|file):/i.test(token[1])) {
        return token[1]
      }
    }
  }
  return ''
}

function readWebTokenStore(roots, keys, authoritativeMissing = false) {
  let exists = false
  for (const root of roots) {
    const files = leveldbFiles(root)
    if (files.length === 0) continue
    exists = true
    for (const file of files) {
      const text = readStoreText(file)
      if (!text) continue
      for (const key of keys || []) {
        if (tokenAfterKey(text, key)) {
          return { known: true, signedIn: true, source: 'disk', account: key }
        }
      }
      if (genericToken(text)) {
        return { known: true, signedIn: true, source: 'disk', account: 'saved-session' }
      }
    }
  }
  // A browser store also exists for a launcher that has simply been opened
  // once. Unless its sign-out removes a known key, a missing token means "not
  // readable here", not "signed out", and must never erase a recorded account.
  if (exists && authoritativeMissing) {
    return { known: true, signedIn: false, source: 'disk' }
  }
  return { known: false, signedIn: null, source: 'disk' }
}

function readOmenStore(files) {
  let exists = false
  for (const file of files) {
    const text = readStoreText(file)
    if (!text) continue
    exists = true
    try {
      const parsed = JSON.parse(text)
      const account =
        parsed && parsed.account && typeof parsed.account === 'object' ? parsed.account : parsed
      for (const key of ['accessToken', 'access_token', 'token', 'launcherToken', 'refreshToken']) {
        const value = account && account[key]
        if (typeof value === 'string' && value.trim().length >= 16) {
          return { known: true, signedIn: true, source: 'disk', account: 'omen' }
        }
      }
    } catch {
      /* an empty/partial .auth is a signed-out Omen */
    }
  }
  return exists
    ? { known: true, signedIn: false, source: 'disk' }
    : { known: false, signedIn: null, source: 'disk' }
}

function readEonStore() {
  try {
    const config = readEonConfig()
    if (!config || !config.exists) return { known: false, signedIn: null, source: 'disk' }
    return {
      known: true,
      signedIn: config.signedIn === true,
      source: 'disk',
      account: config.signedIn === true ? 'eon' : '',
    }
  } catch {
    return { known: false, signedIn: null, source: 'disk' }
  }
}

/** App-data folders belonging to a launcher whose storage path is not documented. */
function discoveredRoots(providerId) {
  if (discoveredRootsCache.has(providerId)) return discoveredRootsCache.get(providerId)
  const base = providerId.replace(/-official$/, '')
  const stems = new Set()
  if (base.length >= 3) stems.add(base)
  // The launcher's own folder is occasionally named after the project rather
  // than the provider id.
  const aliases = {
    'glow': ['glow'],
    'rewind-official': ['rewind'],
    'origins-official': ['origins'],
    'interloop': ['interloop'],
    'vynx-official': ['vynx'],
  }
  for (const alias of aliases[providerId] || []) stems.add(alias)
  const roots = []
  if (stems.size === 0) {
    discoveredRootsCache.set(providerId, roots)
    return roots
  }
  for (const parent of [LOCAL, ROAMING]) {
    if (!parent) continue
    let entries = []
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (![...stems].some((stem) => name.includes(stem.replace(/[^a-z0-9]+/g, '')))) continue
      const folder = path.join(parent, entry.name)
      for (const candidate of [
        path.join(folder, 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
        path.join(folder, 'Local Storage', 'leveldb'),
      ]) {
        if (!roots.includes(candidate)) roots.push(candidate)
      }
      if (roots.length >= 8) break
    }
  }
  discoveredRootsCache.set(providerId, roots)
  return roots
}

function storeForProvider(providerId) {
  const id = normalizeId(providerId)
  if (id === 'eon') return { kind: 'eon' }
  if (id === 'omen' || id === 'omen-official') {
    return {
      kind: 'omen',
      files: [
        join(ROAMING, 'launcher.omenmp.mp', '.auth'),
        join(ROAMING, 'OmenLauncher', '.auth'),
        join(ROAMING, 'omen-launcher', '.auth'),
      ],
    }
  }
  if (id === 'hestia' || id === 'hestia-official') {
    return {
      kind: 'web',
      keys: ['hestia.launcherToken'],
      authoritativeMissing: true,
      roots: [
        join(LOCAL, 'xyz.hestia.launcher', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
        join(ROAMING, 'xyz.hestia.launcher', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
      ],
    }
  }
  if (id === 'retrac' || id === 'retrac-official') {
    return {
      kind: 'web',
      keys: ['retrac.token', 'retrac.accessToken', 'token'],
      roots: [
        join(LOCAL, 'launcher.retrac.site', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
      ],
    }
  }
  if (id === 'stellar') {
    return {
      kind: 'web',
      keys: ['stellar.token', 'stellar.accessToken', 'token'],
      roots: [
        join(LOCAL, 'dev.stellar.launcher', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
        join(ROAMING, 'dev.stellar.launcher', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
      ],
    }
  }
  if (id === 'ezfn') {
    return {
      kind: 'web',
      keys: ['ezfn.token', 'ezfn.accessToken', 'token', 'refresh_token'],
      authoritativeMissing: true,
      roots: [
        join(LOCAL, 'org.ezfn', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
        join(LOCAL, 'EZFNLauncherV4', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
      ],
    }
  }
  if (id === 'era' || id === 'era-official') {
    return {
      kind: 'web',
      keys: ['era.token', 'era.accessToken', 'era.session', 'token'],
      roots: [join(ROAMING, 'Era Launcher', 'Local Storage', 'leveldb')],
    }
  }
  if (id === 'hydro') {
    return {
      kind: 'web',
      keys: ['hydro.token', 'hydro.accessToken', 'token'],
      roots: [join(ROAMING, 'Hydro', 'Local Storage', 'leveldb')],
    }
  }
  if (id === 'neo') {
    return {
      kind: 'web',
      keys: ['neo.token', 'neo.accessToken', 'token'],
      roots: [
        join(LOCAL, 'NeoLauncherData', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
        join(LOCAL, 'NeoLauncher', 'EBWebView', 'Default', 'Local Storage', 'leveldb'),
      ],
    }
  }
  return { kind: 'web', keys: [], roots: discoveredRoots(id) }
}

/** Read one provider's saved launcher session from disk. */
async function readLauncherSession(providerId) {
  const id = normalizeId(providerId)
  if (!id) return { known: false, signedIn: null, source: 'disk' }
  const store = storeForProvider(id)
  if (store.kind === 'eon') return readEonStore()
  if (store.kind === 'omen') return readOmenStore(store.files)
  return readWebTokenStore(store.roots, store.keys, store.authoritativeMissing === true)
}

/* ------------------------------------------------------------ live page --- */

const PAGE_STATE_EXPRESSION = `(() => {
  const out = { signedIn: null, source: 'page' };
  try {
    const tokenKey = /token|auth|session|credential/i;
    const ignoredKey = /(?:seen|news|trailer|theme|colou?r|library|options|settings|app_info|client\\.store|version|build|folder|path|fps|mode)/i;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = String(localStorage.key(index) || '');
      if (!tokenKey.test(key) || ignoredKey.test(key)) continue;
      const value = String(localStorage.getItem(key) || '');
      if (
        /Bearer\\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value) ||
        /^[A-Za-z0-9._~+/=-]{24,}$/.test(value) ||
        /^eyJ[A-Za-z0-9_-]{8,}\\./.test(value)
      ) {
        out.signedIn = true;
        out.account = key;
        break;
      }
    }
    const text = String(document.body && document.body.innerText || '');
    if (out.signedIn === null) {
      if (/sign out|log out|logout/i.test(text)) out.signedIn = true;
      else if (/sign in|log in|login|continue with discord|authorize/i.test(text)) out.signedIn = false;
    }
  } catch (error) {}
  return JSON.stringify(out);
})()`

function providerPageExpression(providerId) {
  const id = normalizeId(providerId)
  if (id === 'era' || id === 'era-official') {
    return `(async () => {
      const out = { signedIn: null, source: 'era' };
      try {
        const session = await window.era.invoke('session.get');
        if (session) {
          const token = session.accessToken || session.access_token || session.token ||
            (session.session && (session.session.accessToken || session.session.access_token || session.session.token));
          const user = session.user || session.account ||
            (session.session && (session.session.user || session.session.account));
          if (session.signedIn === true || session.isLoggedIn === true || session.authenticated === true) out.signedIn = true;
          else if (token) out.signedIn = true;
          else if (user && (user.id || user.userId || user.accountId || user.displayName || user.username)) out.signedIn = true;
          else if (session.signedIn === false || session.isLoggedIn === false || session.session === null) out.signedIn = false;
        } else if (session === null) out.signedIn = false;
      } catch (error) {}
      return JSON.stringify(out);
    })()`
  }
  if (id === 'hydro') {
    return `(async () => {
      const out = { signedIn: null, source: 'hydro' };
      try {
        const session = await window.hydro.authGetSession();
        if (session && (session.access_token || session.accessToken || session.account_id || session.accountId || session.display_name || session.displayName)) out.signedIn = true;
        else if (session === null || session === undefined) out.signedIn = false;
      } catch (error) {}
      return JSON.stringify(out);
    })()`
  }
  if (id === 'neo') {
    return `(async () => {
      const out = { signedIn: null, source: 'neo' };
      try {
        const session = await window.neoLauncherServices.getSession();
        if (session && (session.isLoggedIn === true || session.signedIn === true)) out.signedIn = true;
        else if (session && (session.isLoggedIn === false || session.signedIn === false)) out.signedIn = false;
        else if (session && (session.user || session.account)) out.signedIn = true;
      } catch (error) {}
      return JSON.stringify(out);
    })()`
  }
  if (id === 'omen' || id === 'omen-official') {
    return `(() => {
      const out = { signedIn: null, source: 'omen' };
      try {
        const manager = globalThis.LauncherManager;
        if (manager && manager.AuthManager) {
          const account = manager.AuthManager.Account;
          out.signedIn = Boolean(account && (account.accessToken || account.access_token || account.id || account.accountId));
        }
      } catch (error) {}
      return JSON.stringify(out);
    })()`
  }
  return ''
}

/** Ask a launcher that is running right now for its own session state. */
async function readLauncherSessionOnPage(providerId, port, options = {}) {
  const safePort = Math.max(0, Math.floor(Number(port) || 0))
  if (!safePort) return { known: false, signedIn: null, source: 'page' }
  let page = null
  try {
    page = await waitForLauncherPage(safePort, Number(options.timeoutMs) || 2_500)
  } catch {
    page = null
  }
  if (!page || !page.webSocketDebuggerUrl) {
    return { known: false, signedIn: null, source: 'page' }
  }
  const evaluate = async (expression) => {
    if (!expression) return null
    try {
      const raw = await evaluateOnPage(page.webSocketDebuggerUrl, expression, 5_000)
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      return null
    }
  }
  let result = await evaluate(providerPageExpression(providerId))
  if (!result || result.signedIn === null || result.signedIn === undefined) {
    result = await evaluate(PAGE_STATE_EXPRESSION)
  }
  if (!result) return { known: false, signedIn: null, source: 'page' }
  if (result.signedIn === true) {
    return { known: true, signedIn: true, source: 'page', account: result.account || '' }
  }
  if (result.signedIn === false) {
    return { known: true, signedIn: false, source: 'page' }
  }
  return { known: false, signedIn: null, source: 'page' }
}

module.exports = {
  readLauncherSession,
  readLauncherSessionOnPage,
}
