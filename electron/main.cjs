const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const net = require('node:net')
const { spawn, execFile } = require('node:child_process')
const { autoUpdater } = require('electron-updater')

const DEV = process.argv.includes('--dev')
const SMOKE = process.argv.includes('--smoke')
/** set to a direct archive URL to exercise the downloader in smoke mode */
const SMOKE_URL = process.env.RIFT_SMOKE_URL ?? ''
/** optional expected hash for a smoke download */
const SMOKE_SHA256 = process.env.RIFT_SMOKE_SHA256 ?? ''
/** e.g. RIFT_SMOKE_SIZE=1600x900 — lets the smoke capture use a larger window */
const SMOKE_SIZE = process.env.RIFT_SMOKE_SIZE ?? ''

/** @type {BrowserWindow | null} */
let mainWindow = null

/** buildId -> { pid } */
const running = new Map()
/** buildId -> AbortController */
const downloads = new Map()
/** buildId -> running archive extraction process */
const extractions = new Map()

/**
 * Every old Fortnite client needs a private server and a redirected login.
 * The bundled backend listens here; Tellurium is injected into the client so
 * its Epic requests are sent to that backend instead of the retired services.
 */
const BACKEND_PORT = 3551
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}/`
const BACKEND_START_TIMEOUT = 60_000
const MATCHMAKER_PORT = 3552
const MATCHMAKER_URL = `http://127.0.0.1:${MATCHMAKER_PORT}`
const MATCHMAKER_PROTOCOL = 3
const GAME_SERVER_PORT = 7777
const BACKEND_PASSWORD = 'Rebooted'
const LEGACY_FLTOKEN = '3db3ba5dcbd2e16703f3978d'
const LEGACY_CALDERA =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ'
const LEGACY_CALDERA_EOS =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoic2FyYWgiLCJnZW5lcmF0ZWQiOjE3NzQxMjEzNzksImNhbGRlcmFHdWlkIjoiZWYzMGE4MjUtMzFlNi00ZWRhLTlmM2EtZTI4YzgwNjYxODkxIiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXRFT1MiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.f7EcDmsjj3XHzdbMl41YHyJE-LlAirjbjaqzcdqBB_Y'

let backendInstallPromise = null
let backendStartPromise = null
let backendReady = false
let backendUsername = ''
let matchmakerStartPromise = null
let gameServerReadyPromise = null
/** { child, pid, injectorPid, buildId, dll, payload } for the local listen server */
let gameServerState = null
let gameServerStarting = false
let gameServerPlaylist = null
let gameServerWatchdog = null
let gameServerRestartTimer = null
let gameServerStopping = false
let playlistSyncPromise = null
let playlistWatcher = null

/** pending automatic update install */
let autoInstallTimer = null

app.setName('VAULTED Launcher')
app.setAppUserModelId('com.vaulted.launcher')

/** Encrypted copy of the signed-in session, so a launch never asks again. */
function sessionFilePath() {
  return path.join(app.getPath('userData'), 'session.bin')
}

function readSessionFile() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(fs.readFileSync(sessionFilePath()))
  } catch {
    return null
  }
}

function writeSessionFile(value) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    fs.mkdirSync(path.dirname(sessionFilePath()), { recursive: true })
    fs.writeFileSync(sessionFilePath(), safeStorage.encryptString(String(value)), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function accountSessionPath() {
  return path.join(app.getPath('userData'), 'account-session.json')
}

/** Signed-in account token; survives reinstalling the launcher. */
function readAccountSession() {
  try {
    const raw = fs.readFileSync(accountSessionPath(), 'utf8')
    return raw.trim() || null
  } catch {
    return null
  }
}

function writeAccountSession(value) {
  try {
    const file = accountSessionPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(value), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function clearAccountSession() {
  try {
    fs.rmSync(accountSessionPath(), { force: true })
    return true
  } catch {
    return false
  }
}

function clearSessionFile() {
  try {
    fs.rmSync(sessionFilePath(), { force: true })
  } catch {
    /* already gone */
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function windowSize() {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(SMOKE_SIZE)
  return match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : { width: 1180, height: 840 }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...windowSize(),
    minWidth: 880,
    minHeight: 620,
    show: false,
    frame: false,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    // native resize borders on a frameless window
    thickFrame: true,
    backgroundColor: '#05060a',
    title: 'VAULTED — Fortnite Build Launcher',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (SMOKE) runSmokeTest()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (SMOKE) {
    smokeLog('window created')
    mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
      smokeLog(`did-fail-load ${code} ${description} ${url}`)
    })
    mainWindow.webContents.on('did-finish-load', () => smokeLog('did-finish-load'))
  }

  // anything that tries to open a new window goes to the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (DEV) {
    mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

/* ------------------------------------------------------------------ builds */

function buildsRoot() {
  return path.join(app.getPath('userData'), 'builds')
}

function assertBuild(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid launch request.')

  const { executable, path: folder } = payload
  if (typeof executable !== 'string' || !executable) throw new Error('This build has no executable path.')
  if (typeof folder !== 'string' || !folder) throw new Error('This build has no folder path.')

  if (!fs.existsSync(folder)) throw new Error(`Build folder not found:\n${folder}`)
  if (!fs.existsSync(executable)) {
    throw new Error(`Client executable not found:\n${executable}\n\nPick the folder that contains FortniteGame\\Binaries\\Win64.`)
  }
}

const CLIENT_EXE = 'fortniteclient-win64-shipping.exe'

/** Newer builds also ship bootstrapper copies next to the real client. */
function isClientExecutableName(name) {
  const lower = String(name).toLowerCase()
  return lower === CLIENT_EXE || lower.startsWith(`${CLIENT_EXE}_`)
}

function findClientExecutable(root, accept) {
  const visited = new Set()

  const walk = (dir, depth) => {
    if (depth > 16) return null

    let real
    try {
      real = fs.realpathSync(dir).toLowerCase()
    } catch {
      return null
    }
    if (visited.has(real)) return null
    visited.add(real)

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }

    for (const entry of entries) {
      if (entry.isDirectory() || !accept(entry.name)) continue
      const full = path.join(dir, entry.name)
      try {
        if (fs.statSync(full).size > 0) return full
      } catch {
        /* unreadable entry, keep looking */
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const found = walk(path.join(dir, entry.name), depth + 1)
      if (found) return found
    }

    return null
  }

  return walk(root, 0)
}

function findPrimaryExecutable(root) {
  return findClientExecutable(root, (name) => name.toLowerCase() === CLIENT_EXE)
}

function findExecutable(root) {
  // Prefer the real client. Only fall back to an EAC/EOS/BattlEye bootstrapper
  // when an archive genuinely has no plain Shipping.exe.
  return (
    findPrimaryExecutable(root) ??
    findClientExecutable(root, (name) => name.toLowerCase().startsWith(`${CLIENT_EXE}_`))
  )
}

/** strips the standard "...\FortniteGame\Binaries\Win64\exe" tail to get the build root */
function folderForExecutable(executable) {
  const match = executable.match(/^(.*?)[\\/]FortniteGame[\\/]Binaries[\\/]Win64[\\/][^\\/]+$/i)
  return match ? match[1] : path.dirname(executable)
}

/**
 * Looks through the usual places a downloaded build ends up and returns each
 * folder that contains FortniteClient-Win64-Shipping.exe. The renderer maps the
 * version in the folder name to a chapter/season, so no paths are typed by hand.
 */
function scanForBuilds() {
  const home = os.homedir()
  const roots = [
    // VAULTED's own downloads are the most important and can be buried a few
    // folders deep, so do not let a large D:\ scan exhaust the budget first.
    path.join(app.getPath('userData'), 'builds'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    'C:\\Fortnite Builds',
    'D:\\Fortnite Builds',
    'E:\\Fortnite Builds',
    'F:\\Fortnite Builds',
    'C:\\Fortnite',
    'D:\\Fortnite',
    'E:\\Fortnite',
    'D:\\',
    'E:\\',
  ]

  const found = []
  const seen = new Set()
  let budget = 6000

  const walk = (dir, depth) => {
    if (budget <= 0 || depth > 8) return

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      budget -= 1
      if (budget <= 0) return

      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (isClientExecutableName(entry.name)) {
        const root = folderForExecutable(full)
        const key = root.toLowerCase()
        if (!seen.has(key) && fs.existsSync(root)) {
          seen.add(key)
          found.push(root)
        }
      }
    }
  }

  for (const root of roots) {
    if (fs.existsSync(root)) walk(root, 0)
  }

  return found
}

function abortError() {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/* ----------------------------------------------------- private server runtime */

/** Packaged runtime files live next to app.asar; dev uses the repo folder. */
function runtimeRoot() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'runtime') : ''
  if (packaged && fs.existsSync(path.join(packaged, 'VAULTED-Backend.zip'))) return packaged
  return path.join(__dirname, '..', 'runtime')
}

function backendPaths() {
  const root = path.join(app.getPath('userData'), 'private-server')
  return {
    root,
    node: path.join(root, 'node', 'node.exe'),
    app: path.join(root, 'neonite_v2', 'app.js'),
    cwd: path.join(root, 'neonite_v2'),
  }
}

function backendLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'private-server.log')
}

function matchmakerLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'matchmaker.log')
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalizeUsername(value) {
  return (
    String(value || 'Player')
      .replace(/[^a-z0-9_]/gi, '')
      .slice(0, 24) || 'Player'
  )
}

/** Apply the small VAULTED-only fixes to the bundled Neonite copy. */
function patchBackendRuntime(paths) {
  const patchRoot = path.join(runtimeRoot(), 'neonite-patch')
  const files = [
    'api/controllers/MatchMakingController.js',
    'api/controllers/AuthController.js',
    'config/matchmakingRoutes.js',
    'config/vaultedFriendsRoutes.js',
    'api/controllers/VaultedFriendsController.js',
    'profile.js',
    'vaulted-inventory.cjs',
  ]
  for (const relative of files) {
    const source = path.join(patchRoot, relative)
    const destination = path.join(paths.cwd, relative)
    if (!fs.existsSync(source)) continue
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const incoming = fs.readFileSync(source)
    let current = null
    try {
      current = fs.readFileSync(destination)
    } catch {
      /* first install */
    }
    if (!current || !current.equals(incoming)) fs.writeFileSync(destination, incoming)
  }
}

/** Persist the launcher account so EOS/external-auth logins use the same name. */
function writeBackendUsername(paths, username) {
  const configPath = path.join(paths.cwd, 'config.ini')
  let config = ''
  try {
    config = fs.readFileSync(configPath, 'utf8')
  } catch {
    return
  }

  const safe = normalizeUsername(username)
  config = config.replace(/^bEnableOverride\s*=.*$/m, 'bEnableOverride=true')
  config = config.replace(/^username\s*=.*$/m, `username=${safe}`)
  if (!/^bEnableOverride\s*=/m.test(config)) config += '\nbEnableOverride=true\n'
  if (!/^username\s*=/m.test(config)) config += `username=${safe}\n`
  fs.writeFileSync(configPath, config)
}

function portOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await delay(250)
  }
  return portOpen(port)
}

/** Fortnite's listen server binds UDP 7777; net.connect only sees TCP. */
function udpPortBound(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'udp'], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout) return resolve(false)
      for (const line of String(stdout).split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/)
        if (columns.length < 4 || columns[0].toUpperCase() !== 'UDP') continue
        if (columns[1].endsWith(`:${port}`)) return resolve(true)
      }
      resolve(false)
    })
  })
}

async function gameServerPortOpen() {
  const [tcp, udp] = await Promise.all([portOpen(GAME_SERVER_PORT), udpPortBound(GAME_SERVER_PORT)])
  return tcp || udp
}

async function waitForGameServerPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await gameServerPortOpen()) return true
    await delay(200)
  }
  return gameServerPortOpen()
}

function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stop a listener only when its command line proves it belongs to VAULTED. */
function stopOwnedListener(port, marker) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false)
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout) return resolve(false)
      const pids = new Set()
      for (const line of String(stdout).split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/)
        if (columns.length < 5) continue
        const local = columns[1]
        if (!local.endsWith(`:${port}`) || columns[3] !== 'LISTENING') continue
        const pid = Number(columns[4])
        if (pid > 0) pids.add(pid)
      }
      if (!pids.size) return resolve(false)

      const check = (pid) =>
        new Promise((done) => {
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
            ],
            { windowsHide: true, timeout: 8000 },
            (err, out) => done(!err && String(out || '').toLowerCase().includes(marker)),
          )
        })

      void (async () => {
        for (const pid of pids) {
          if (!(await check(pid))) continue
          await new Promise((done) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done())
          })
        }
        resolve(true)
      })()
    })
  })
}

function extractZipArchive(archive, destination) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn(sevenZipBinary(), ['x', '-y', '-bso0', '-bse1', `-o${destination}`, archive], {
      windowsHide: true,
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-6000)
    })
    child.on('error', (error) => reject(new Error(`Could not start the backend extractor: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0 || code === 1) resolve()
      else reject(new Error(`Could not unpack the private server (7-Zip exited ${code}).${stderr.trim() ? `\n${stderr.trim()}` : ''}`))
    })
  })
}

async function ensureBackendRuntime() {
  const paths = backendPaths()
  if (fs.existsSync(paths.node) && fs.existsSync(paths.app)) {
    patchBackendRuntime(paths)
    return paths
  }

  if (backendInstallPromise) return backendInstallPromise

  backendInstallPromise = (async () => {
    send('arc:launch-status', { message: 'Installing the private server (one time)…' })
    const archive = path.join(runtimeRoot(), 'VAULTED-Backend.zip')
    if (!fs.existsSync(archive)) {
      throw new Error('The private server files are missing from this installation. Reinstall VAULTED.')
    }

    await fs.promises.rm(paths.root, { recursive: true, force: true }).catch(() => {})
    await fs.promises.mkdir(paths.root, { recursive: true })
    await extractZipArchive(archive, paths.root)

    if (!fs.existsSync(paths.node) || !fs.existsSync(paths.app)) {
      throw new Error('The private server could not be installed correctly. Reinstall VAULTED.')
    }
    return backendPaths()
  })().finally(() => {
    backendInstallPromise = null
  })

  return backendInstallPromise
}

async function backendResponds(timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(BACKEND_URL, { signal: controller.signal })
    try {
      await response.body?.cancel()
    } catch {
      /* the status code is all we need */
    }
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await backendResponds()) return true
    await delay(350)
  }
  return backendResponds()
}

function gameServerStatePath() {
  return path.join(app.getPath('userData'), 'game-server-state.json')
}

function joinTargetPath() {
  return path.join(app.getPath('userData'), 'vaulted-join.json')
}

function publicAddressPath() {
  return path.join(app.getPath('userData'), 'public-address.json')
}

/** A forwarded host:port (or playit.gg tunnel) chosen by the player wins. */
function readPublicOverride() {
  try {
    const value = JSON.parse(fs.readFileSync(publicAddressPath(), 'utf8'))
    if (value && typeof value.address === 'string' && value.address.trim()) {
      return { address: value.address.trim(), port: Number(value.port) || GAME_SERVER_PORT }
    }
  } catch {
    /* automatic mapping */
  }
  return null
}

function setPublicOverride(value) {
  const raw = String(value || '').trim()
  if (!raw) {
    try {
      fs.rmSync(publicAddressPath(), { force: true })
    } catch {
      /* nothing stored */
    }
    return { ok: true, value: null }
  }
  if (!/^[a-zA-Z0-9.-]{1,63}:\d{2,5}$/.test(raw)) {
    return { ok: false, error: 'Use host:port, for example 203.0.113.7:7777' }
  }
  const [address, portText] = raw.split(':')
  try {
    fs.mkdirSync(path.dirname(publicAddressPath()), { recursive: true })
    fs.writeFileSync(publicAddressPath(), JSON.stringify({ address, port: Number(portText) }), 'utf8')
    return { ok: true, value: raw }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save that address.' }
  }
}

function portmapper() {
  try {
    return require(path.join(runtimeRoot(), 'portmap.cjs'))
  } catch {
    return null
  }
}

/**
 * The address friends should use. A manual forward is checked first, then
 * UPnP/NAT-PMP, then plain LAN so same-WiFi play always keeps working.
 */
async function resolvePublicAddress() {
  const manual = readPublicOverride()
  if (manual) return { ...manual, public: true, method: 'manual' }
  const mapper = portmapper()
  if (mapper) {
    try {
      const mapped = await mapper.mapPublicPort(GAME_SERVER_PORT)
      if (mapped?.address) {
        return { address: mapped.address, port: GAME_SERVER_PORT, public: true, method: mapped.method }
      }
    } catch (error) {
      console.warn(`[VAULTED] Could not open the game port: ${error instanceof Error ? error.message : error}`)
    }
  }
  const lan = lanAddress()
  return lan ? { address: lan, port: GAME_SERVER_PORT, public: false, method: 'lan' } : null
}

/** Tells the backend + matchmaker to send this client to a friend's lobby. */
function writeJoinTarget(host, port) {
  try {
    const file = joinTargetPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ host, port, at: new Date().toISOString() }), 'utf8')
  } catch (error) {
    console.warn(`[VAULTED] Could not write the join target: ${error.message}`)
  }
}

function clearJoinTarget() {
  try {
    fs.rmSync(joinTargetPath(), { force: true })
  } catch {
    /* nothing to clear */
  }
}

function joinTargetFromPayload(payload) {
  const host = typeof payload?.joinHost === 'string' ? payload.joinHost.trim() : ''
  if (!host) return null
  const port = Number(payload?.joinPort) || GAME_SERVER_PORT
  return { host, port }
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const address of list || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

function readGameServerState() {
  try {
    const value = JSON.parse(fs.readFileSync(gameServerStatePath(), 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** Share the host's active playlist with the standalone matchmaker process. */
function writeGameServerState(ready, playlist) {
  try {
    const file = gameServerStatePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    fs.writeFileSync(
      temporary,
      JSON.stringify({ ready: Boolean(ready), playlist: playlist || null, updatedAt: new Date().toISOString() }),
      'utf8',
    )
    fs.renameSync(temporary, file)
  } catch (error) {
    console.warn(`[VAULTED] Could not update the game-server state: ${error.message}`)
  }
}

async function matchmakerResponds(timeoutMs = 900) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${MATCHMAKER_URL}/health`, { signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json()
    return body?.service === 'vaulted-matchmaker' && body?.version === MATCHMAKER_PROTOCOL
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function ensureLocalMatchmaker() {
  if (await matchmakerResponds()) return
  if (matchmakerStartPromise) return matchmakerStartPromise

  matchmakerStartPromise = (async () => {
    const paths = await ensureBackendRuntime()
    const script = path.join(runtimeRoot(), 'matchmaker.cjs')
    if (!fs.existsSync(script)) throw new Error('The local matchmaker is missing from this installation. Reinstall VAULTED.')

    // A stale copy from an older release may hold the port. Only replace it
    // when the process is our own matchmaker, never an unrelated service.
    if (await portOpen(MATCHMAKER_PORT)) {
      await stopOwnedListener(MATCHMAKER_PORT, 'matchmaker.cjs')
      await delay(400)
    }

    const logFile = matchmakerLogPath()
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const fd = fs.openSync(logFile, 'a')
    let child
    try {
      child = spawn(paths.node, [script], {
        cwd: path.dirname(script),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: {
          ...process.env,
          VAULTED_MATCHMAKER_PORT: String(MATCHMAKER_PORT),
          VAULTED_GAME_PORT: String(GAME_SERVER_PORT),
          VAULTED_GAME_HOST: '127.0.0.1',
          VAULTED_GAME_STATE_FILE: gameServerStatePath(),
          VAULTED_JOIN_FILE: joinTargetPath(),
        },
      })
    } finally {
      fs.closeSync(fd)
    }
    if (!child.pid) throw new Error('The local matchmaker could not start.')
    child.unref()

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await matchmakerResponds()) return
      await delay(120)
    }
    throw new Error('The local matchmaker did not start. Check the matchmaker log.')
  })().finally(() => {
    matchmakerStartPromise = null
  })

  return matchmakerStartPromise
}

/**
 * Writes the launcher's owned cosmetics into the private server's athena
 * profile. The backend also re-applies the sidecar list on every profile read,
 * so a later lobby save cannot erase a purchase.
 */
let inventorySyncChain = Promise.resolve()

function privateInventoryModule() {
  const file = path.join(runtimeRoot(), 'neonite-patch', 'vaulted-inventory.cjs')
  if (!fs.existsSync(file)) throw new Error('The in-game inventory bridge is missing. Reinstall VAULTED.')
  return require(file)
}

async function syncVaultedInventoryNow(payload) {
  if (typeof payload?.username !== 'string' || !payload.username.trim()) {
    return { synced: false, reason: 'no-account' }
  }

  const username = normalizeUsername(payload.username)
  const paths = backendPaths()
  if (!fs.existsSync(paths.app)) {
    return { synced: false, reason: 'private-server-not-installed' }
  }

  const inventory = privateInventoryModule()
  const result = inventory.sync(paths.cwd, username, {
    items: payload.items,
    equipped: payload.equipped,
  })
  return { synced: true, ...result }
}

function syncVaultedInventory(payload) {
  const task = inventorySyncChain.catch(() => {}).then(() => syncVaultedInventoryNow(payload))
  inventorySyncChain = task.catch(() => {})
  return task
}

async function ensureLocalBackend(username) {
  const requestedUser = normalizeUsername(username)
  if (backendReady && backendUsername === requestedUser && (await backendResponds())) {
    return { reused: true, pid: null }
  }
  if (backendStartPromise) return backendStartPromise

  backendStartPromise = (async () => {
    const paths = await ensureBackendRuntime()
    patchBackendRuntime(paths)
    writeBackendUsername(paths, requestedUser)

    // The previous release has no ticket/session fix. Stop only our own
    // Neonite listener so the patched files are loaded for this launch.
    if (await backendResponds()) {
      await stopOwnedListener(BACKEND_PORT, 'app.js')
      for (let attempt = 0; attempt < 40 && (await portOpen(BACKEND_PORT)); attempt += 1) {
        await delay(120)
      }
    }
    if (await portOpen(BACKEND_PORT)) {
      throw new Error('Port 3551 is already used by another program. Close it and try again.')
    }

    const logFile = backendLogPath()
    await fs.promises.mkdir(path.dirname(logFile), { recursive: true })

    send('arc:launch-status', { message: 'Starting the private server…' })
    const fd = fs.openSync(logFile, 'a')
    let child
    try {
      child = spawn(paths.node, ['app.js'], {
        cwd: paths.cwd,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, NODE_ENV: 'production', VAULTED_JOIN_FILE: joinTargetPath() },
      })
    } finally {
      fs.closeSync(fd)
    }

    if (!child.pid) throw new Error('The private server could not start.')
    child.unref()

    if (!(await waitForBackend(BACKEND_START_TIMEOUT))) {
      try {
        await killProcessTree(child.pid)
      } catch {
        /* best effort */
      }
      let detail = ''
      try {
        detail = fs.readFileSync(logFile, 'utf8').slice(-4000).trim()
      } catch {
        /* no log yet */
      }
      throw new Error(`The private server did not start.${detail ? `\n\n${detail}` : ''}`)
    }

    backendReady = true
    backendUsername = requestedUser
    return { reused: false, pid: child.pid }
  })().finally(() => {
    backendStartPromise = null
  })

  return backendStartPromise
}

function usesEosAuth(payload) {
  try {
    return fs.existsSync(
      path.join(path.dirname(payload.executable), 'FortniteClient-Win64-Shipping_EAC_EOS.exe'),
    )
  } catch {
    return false
  }
}

/**
 * Newer clients expect these bootstrappers to exist, but letting them run starts
 * a second, anti-cheat-protected copy of the game. They are started suspended and
 * killed when the real client exits, which is how OGFN launchers bypass EAC.
 */
function suspendedBootstrappers(executable) {
  try {
    const directory = path.dirname(executable)
    return [
      'FortniteLauncher.exe',
      'FortniteClient-Win64-Shipping_EAC.exe',
      'FortniteClient-Win64-Shipping_EAC_EOS.exe',
    ]
      .map((name) => path.join(directory, name))
      .filter((candidate) => fs.existsSync(candidate))
  } catch {
    return []
  }
}

/** The Aftermath crash handler shipped with some builds deadlocks the client. */
function removeAftermathDlls(executable) {
  const directory = path.dirname(executable)
  for (const name of ['GFSDK_Aftermath_Lib.x64.dll', 'GFSDK_Aftermath_Lib.dll']) {
    try {
      fs.rmSync(path.join(directory, name), { force: true })
    } catch {
      /* locked or already gone */
    }
  }
}

function fortniteLaunchArgs(payload, options = {}) {
  const username = normalizeUsername(payload.username)
  const eos = usesEosAuth(payload)
  const args = [
    '-epicapp=Fortnite',
    '-epicenv=Prod',
    '-epiclocale=en-us',
    '-epicportal',
    '-skippatchcheck',
    '-nobe',
    `-fromfl=${eos ? 'eaceos' : 'eac'}`,
    `-fltoken=${LEGACY_FLTOKEN}`,
    `-caldera=${eos ? LEGACY_CALDERA_EOS : LEGACY_CALDERA}`,
    `-AUTH_LOGIN=${username}`,
    `-AUTH_PASSWORD=${BACKEND_PASSWORD}`,
    '-AUTH_TYPE=epic',
    '-log',
  ]
  if (eos) {
    args.push('-nouac', '-nocodeguards')
    // Chapter 4+ EOS builds ship without the D3D12 shader archive. D3D11 uses
    // the cooked shader library inside the paks and reaches the lobby instead
    // of dying in the preload screen with MissingRequiredShadersError.
    args.push('-d3d11')
  }
  if (options.host) {
    // The bundled server is headless: it has no ImGui window and starts its
    // listen server without a Start click. Null RHI keeps the spare host client
    // invisible as well, so only the player's own Fortnite window is shown.
    args.push('-nosplash', '-nosound', '-nullrhi')
  }
  return args
}

/**
 * Starts the game suspended, loads the redirect DLL into it, then resumes it.
 * Doing this before any client code runs is what guarantees the very first
 * OAuth request is redirected instead of hitting Epic and failing with 1015.
 */
function launchInjectedGame(payload, options = {}) {
  return new Promise((resolve, reject) => {
    const injector = path.join(runtimeRoot(), 'VaultedInjector.exe')
    const dll = path.join(runtimeRoot(), 'Tellurium.dll')
    if (!fs.existsSync(injector)) return reject(new Error('The login injector is missing from this installation. Reinstall VAULTED.'))
    if (!fs.existsSync(dll)) return reject(new Error('The login redirect is missing from this installation. Reinstall VAULTED.'))

    const workingDirectory = path.dirname(payload.executable)
    removeAftermathDlls(payload.executable)

    const injectorArgs = [payload.executable, dll, workingDirectory]
    for (const bootstrapper of suspendedBootstrappers(payload.executable)) {
      injectorArgs.push('--aux', bootstrapper)
    }
    if (options.host) injectorArgs.push('--hide-window')
    injectorArgs.push('--', ...fortniteLaunchArgs(payload, options))

    const child = spawn(injector, injectorArgs, {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENSSL_ia32cap: '~0x20000000' },
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const finishError = (message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(message))
    }
    const timer = setTimeout(() => {
      finishError('The login redirect timed out while attaching to Fortnite.')
      void killProcessTree(child.pid)
    }, 30_000)

    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-4000)
      const match = /(?:^|\r?\n)PID=(\d+)/.exec(stdout)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ child, pid: Number(match[1]) })
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on('error', (error) => finishError(`Could not run the login injector: ${error.message}`))
    child.on('exit', (code) => {
      if (settled) return
      const detail = stderr.trim() || stdout.trim()
      finishError(`Fortnite could not start.${detail ? `\n${detail}` : code ? ` (injector exited ${code})` : ''}`)
    })
  })
}

function injectDll(pid, dllPath) {
  return new Promise((resolve, reject) => {
    const injector = path.join(runtimeRoot(), 'VaultedInjector.exe')
    if (!fs.existsSync(injector)) return reject(new Error('The injector is missing from this installation. Reinstall VAULTED.'))
    if (!fs.existsSync(dllPath)) return reject(new Error('The local game server is missing from this installation. Reinstall VAULTED.'))

    const child = spawn(injector, ['--inject', String(pid), dllPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      finish(new Error('The local game server injector timed out.'))
      void killProcessTree(child.pid)
    }, 25_000)

    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-3000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-3000)
    })
    child.on('error', (error) => finish(new Error(`Could not start the local game server: ${error.message}`)))
    child.on('exit', (code) => {
      if (code === 0) finish()
      else finish(new Error(`The local game server could not attach.${stderr.trim() || stdout.trim() ? `\n${(stderr || stdout).trim()}` : code ? ` (exited ${code})` : ''}`))
    })
  })
}

function gameServerDll() {
  const candidate = path.join(runtimeRoot(), 'VAULTED-Server.dll')
  if (fs.existsSync(candidate)) return candidate
  throw new Error('The local game server DLL is missing from this installation. Reinstall VAULTED.')
}

/** The game server names its saved profile after the detected game version. */
function fortniteVersionKey(payload) {
  const text = [payload?.version, payload?.path, payload?.executable].filter(Boolean).join(' ')
  const match = String(text).match(/(?:^|[^\d])(\d{1,2})\.(\d{1,2})(?:[^\d]|$)/)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null
  if (major < 1 || major > 44 || minor < 0 || minor > 99) return null
  // The server formats its profile key as a fixed two-decimal version.
  return `fn_${major}.${String(minor).padEnd(2, '0')}`
}

const DEFAULT_PLAYLIST = 'Playlist_DefaultSolo'
let cachedPlaylistPaths = null

/** The client writes the player's current playlist here before matchmaking. */
function gameUserSettingsPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  return path.join(localAppData, 'FortniteGame', 'Saved', 'Config', 'WindowsClient', 'GameUserSettings.ini')
}

function readSelectedPlaylist(useDefault = true) {
  try {
    const text = fs.readFileSync(gameUserSettingsPath(), 'utf8')
    const match = /LastSelectedPlaylist\s*=\s*\([^\r\n]*?PlaylistName\s*=\s*"([^"]+)"/i.exec(text)
    if (!match?.[1]) return useDefault ? DEFAULT_PLAYLIST : null
    return canonicalPlaylistName(match[1])
  } catch {
    return useDefault ? DEFAULT_PLAYLIST : null
  }
}

/** Playlist asset paths for every mode the frontend can select. */
function playlistPaths() {
  if (cachedPlaylistPaths) return cachedPlaylistPaths
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runtimeRoot(), 'playlist-paths.json'), 'utf8'))
    cachedPlaylistPaths = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    cachedPlaylistPaths = {}
  }
  return cachedPlaylistPaths
}

function canonicalPlaylistName(value) {
  const raw = String(value || '').trim().replace(/^"|"$/g, '').replace(/[^a-z0-9_]/gi, '')
  if (!raw) return DEFAULT_PLAYLIST
  // The backend defaults every fresh profile to Papaya (Party Royale). Its
  // playlist has a party-bus flight that is over in a few seconds, so a BR
  // round started from it skips the real Battle Bus. The launcher only offers
  // Battle Royale modes, so treat that stock default as Solos.
  if (raw.toLowerCase() === 'playlist_papaya') return DEFAULT_PLAYLIST
  const candidate = /^playlist_/i.test(raw) ? raw : `Playlist_${raw}`
  const paths = playlistPaths()
  const exact = Object.keys(paths).find((key) => key.toLowerCase() === candidate.toLowerCase())
  return exact || candidate.replace(/^playlist_/i, 'Playlist_')
}

function playlistAssetPath(playlist) {
  const name = canonicalPlaylistName(playlist)
  const paths = playlistPaths()
  return paths[name] || `/Game/Athena/Playlists/${name}.${name}`
}

/** The server's playlist radio-button index; Custom is the safe index for new modes. */
const PLAYLIST_SELECTION_INDEX = {
  playlist_defaultsolo: 0,
  playlist_defaultduo: 1,
  playlist_trios: 2,
  playlist_defaulttrios: 2,
  playlist_defaultsquad: 3,
  playlist_playground: 12,
  playlist_playgroundv2: 13,
  playlist_creative: 13,
  playlist_nobuildbr_solo: 8,
  playlist_nobuildbr_duo: 9,
  playlist_nobuildbr_trio: 10,
  playlist_nobuildbr_squad: 11,
  playlist_showdown_solo: 29,
  playlist_showdown_duos: 30,
  playlist_showdown_trios: 31,
  playlist_showdown_squads: 32,
  playlist_showdownalt_solo: 33,
  playlist_showdownalt_duos: 34,
  playlist_showdownalt_trios: 35,
  playlist_showdownalt_squads: 36,
}

function playlistSelectionIndex(playlist) {
  return PLAYLIST_SELECTION_INDEX[canonicalPlaylistName(playlist).toLowerCase()] ?? 51
}

/**
 * The bundled game server has a Start Match button. AutoHosting lets the host
 * start its listen server without a second click. The selected playlist must
 * be written into the same profile, otherwise the server always falls back to
 * Solos even though the player queued for a different mode.
 */
function configureAutoHost(payload, selectedPlaylist = readSelectedPlaylist()) {
  const profile = fortniteVersionKey(payload)
  if (!profile) return false

  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  const directory = path.join(localAppData, 'VAULTED')
  const settingsPath = path.join(directory, 'auto_hosting.json')

  let document = { schema_version: 1, profiles: {} }
  try {
    const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (existing && typeof existing === 'object' && existing.schema_version === 1 && existing.profiles && typeof existing.profiles === 'object') {
      document = existing
    }
  } catch {
    /* first run or a malformed old file */
  }

  const previous = document.profiles[profile] && typeof document.profiles[profile] === 'object' ? document.profiles[profile] : {}
  const playlist = canonicalPlaylistName(selectedPlaylist)
  // The server reads restore data from the profile's "preferences" object. A
  // top-level selection is ignored, and save_settings must be true for the
  // host to apply it before starting a match.
  const preferences = previous.preferences && typeof previous.preferences === 'object' && !Array.isArray(previous.preferences) ? { ...previous.preferences } : {}
  const selection = preferences.selection && typeof preferences.selection === 'object' && !Array.isArray(preferences.selection) ? { ...preferences.selection } : {}
  const resolvedPaths = preferences.resolved_paths && typeof preferences.resolved_paths === 'object' && !Array.isArray(preferences.resolved_paths) ? { ...preferences.resolved_paths } : {}
  const autoHost = previous.auto_host && typeof previous.auto_host === 'object' && !Array.isArray(previous.auto_host) ? { ...previous.auto_host } : {}
  selection.playlist = playlistSelectionIndex(playlist)
  resolvedPaths.playlist = playlistAssetPath(playlist)
  preferences.selection = selection
  preferences.resolved_paths = resolvedPaths
  autoHost.enabled = true
  autoHost.delay_seconds = 5
  autoHost.save_settings = true
  document.profiles[profile] = {
    ...previous,
    preferences,
    auto_host: autoHost,
  }

  try {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(document, null, 2))
    return true
  } catch (error) {
    console.warn(`[VAULTED] Could not enable automatic game-server hosting: ${error.message}`)
    return false
  }
}

/** Stop and rebuild the hidden host when the player switches playlists in the lobby. */
async function syncGameServerPlaylist() {
  if (playlistSyncPromise || gameServerStarting || !gameServerState || running.size === 0) return
  const selected = readSelectedPlaylist(false)
  if (!selected || selected === gameServerPlaylist) return
  const payload = gameServerState.payload
  if (!payload) return

  playlistSyncPromise = (async () => {
    const id = typeof payload.id === 'string' ? payload.id : undefined
    send('arc:launch-status', { id, message: `Switching the local game server to ${selected.replace(/^Playlist_/i, '')}…` })
    await stopGameServer()
    try {
      await ensureGameServer(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[VAULTED] Could not switch the local game server playlist: ${message}`)
      send('arc:launch-status', { id, message: `Could not switch the game server to ${selected.replace(/^Playlist_/i, '')}.` })
    }
  })().finally(() => {
    playlistSyncPromise = null
  })

  return playlistSyncPromise
}

function startPlaylistWatcher() {
  if (playlistWatcher) return
  playlistWatcher = setInterval(() => {
    void syncGameServerPlaylist()
  }, 1200)
  playlistWatcher.unref?.()
}

/** Read enough of a log to identify the build without loading a 30 MB log. */
function logBelongsToBuild(file, expectedExecutable) {
  if (!expectedExecutable) return true
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(64 * 1024)
      const read = fs.readSync(fd, head, 0, head.length, 0)
      const text = head.subarray(0, read).toString('utf8')
      const match = /LogInit:\s*Base Directory:\s*([^\r\n]+)/i.exec(text)
      if (!match) return false
      const normalize = (value) => path.resolve(String(value).trim()).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const expected = normalize(path.dirname(expectedExecutable))
      const actual = normalize(match[1])
      return actual === expected || actual.startsWith(`${expected}/`)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Wait for the host client to finish its private-server login. */
async function waitForFortniteLogin(startedAt, pid, timeoutMs = 60_000, expectedExecutable = '', hostMarker = '') {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  const logDirectory = path.join(localAppData, 'FortniteGame', 'Saved', 'Logs')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (pid && !processAlive(pid)) return false
    try {
      // Only the live log belongs to this host. Previous sessions leave
      // FortniteGame-backup-*.log files with completed login lines; matching
      // one of those injects the server before the new host is ready.
      // The visible client can start while the host is still signing in. The
      // second client rotates FortniteGame.log to a backup and the host keeps
      // appending to that renamed file, so both names are read here.
      // Fortnite writes the second concurrent client to FortniteGame_2.log, so
      // every client log in this directory has to be considered.
      const logs = fs.readdirSync(logDirectory)
        .filter((name) => /^FortniteGame(?:_\d+)?(?:-backup-[^/\\]*)?\.log$/i.test(name))
        .map((name) => {
          const file = path.join(logDirectory, name)
          return { file, stat: fs.statSync(file) }
        })
        .filter(({ stat }) => stat.isFile() && stat.mtimeMs >= startedAt - 15_000)
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)

      for (const { file } of logs) {
        // The official client writes to FortniteGame.log too. Never let its
        // previous "(Completed)" line make us inject into an unready host.
        if (!logBelongsToBuild(file, expectedExecutable)) continue
        // Only the hidden host carries the headless flags. The player's own
        // client log must never be mistaken for the host's login.
        if (hostMarker && !logHeadHas(file, hostMarker)) continue
        const text = fs.readFileSync(file, 'utf8')
        if (/UOnlineAccountCommon::ContinueLoggingIn/i.test(text) && /\(Completed\)/i.test(text)) {
          return true
        }
      }
    } catch {
      /* the host is still creating its log file */
    }
    await delay(200)
  }
  return false
}

/** Read the first block of a log and look for a launch flag. */
function logHeadHas(file, marker) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(64 * 1024)
      const read = fs.readSync(fd, head, 0, head.length, 0)
      return head.subarray(0, read).toString('utf8').toLowerCase().includes(marker.toLowerCase())
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

async function stopGameServer() {
  gameServerStopping = true
  if (gameServerWatchdog) {
    clearInterval(gameServerWatchdog)
    gameServerWatchdog = null
  }
  if (gameServerRestartTimer) {
    clearTimeout(gameServerRestartTimer)
    gameServerRestartTimer = null
  }
  const state = gameServerState
  gameServerState = null
  gameServerPlaylist = null
  gameServerReadyPromise = null
  writeGameServerState(false, null)
  if (state?.injectorPid && state.injectorPid !== state.pid) await killProcessTree(state.injectorPid)
  if (state?.pid) await killProcessTree(state.pid)
  gameServerStopping = false
}

/**
 * The hidden host exits when a match finishes. Start another one for the
 * selected playlist while the player stays in the lobby, so the next PLAY
 * does not wait on a queue that has no game server behind it. Clients are
 * preserved: only the server process is replaced.
 */
function scheduleGameServerRestart(payload) {
  if (!payload || gameServerStopping || gameServerRestartTimer) return
  if (running.size === 0) return
  gameServerRestartTimer = setTimeout(() => {
    gameServerRestartTimer = null
    if (gameServerStopping || gameServerState || gameServerStarting || running.size === 0) return
    void (async () => {
      if (await gameServerPortOpen()) return
      try {
        send('arc:launch-status', { id: payload.id, message: 'Restarting the local game server…' })
        await ensureGameServer(payload, { preserveClients: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[VAULTED] Could not restart the local game server: ${message}`)
      }
    })()
  }, 2500)
  gameServerRestartTimer.unref?.()
}

/**
 * Starts a hidden second client and turns it into the local listen server by
 * injecting the headless server after its login. Matchmaking then assigns the
 * player client to 127.0.0.1:7777.
 */
async function ensureGameServer(payload, options = {}) {
  if (gameServerStarting) return { reused: false, busy: true }
  gameServerStarting = true
  try {
    return await startGameServer(payload, options)
  } finally {
    gameServerStarting = false
  }
}

async function startGameServer(payload, options = {}) {
  const selectedPlaylist = readSelectedPlaylist()
  if (await gameServerPortOpen()) {
    // A previous host can still own the port after a launcher restart. It is
    // only safe to reuse when its written state matches the selected playlist;
    // the matchmaker must never assign a Solos world to a No Build queue.
    const previous = readGameServerState()
    const previousPlaylist = previous?.playlist ? canonicalPlaylistName(previous.playlist) : null
    if (previous?.ready === true && previousPlaylist === selectedPlaylist) {
      writeGameServerState(true, previousPlaylist)
      return { reused: true }
    }
  }
  if (gameServerState) await stopGameServer()

  // A client left behind by a previous launcher session keeps the game's
  // single-instance lock and silently prevents the hidden host from opening
  // port 7777. That is what leaves the in-game queue pinging forever. Only
  // clients launched by VAULTED carry -AUTH_LOGIN, so the official client is
  // never touched.
  send('arc:launch-status', { id: payload?.id, message: 'Clearing the previous Fortnite session…' })
  if (!options.preserveClients) await stopStaleVaultedClients()
  for (let attempt = 0; attempt < 12 && (await gameServerPortOpen()); attempt += 1) {
    await delay(400)
  }
  if (await gameServerPortOpen()) {
    throw new Error(
      'Port 7777 is already used by another program. Close any other Fortnite client or server and try again.',
    )
  }

  const dll = gameServerDll()
  const hostUsername = `${normalizeUsername(payload.username)}Host`.slice(0, 24)
  configureAutoHost(payload, selectedPlaylist)
  writeGameServerState(false, selectedPlaylist)

  send('arc:launch-status', { id: payload?.id, message: 'Starting the local game server…' })
  const hostStartedAt = Date.now()
  const launched = await launchInjectedGame(
    { ...payload, username: hostUsername },
    { host: true },
  )

  const state = {
    child: launched.child,
    pid: launched.pid,
    injectorPid: launched.child.pid ?? null,
    buildId: payload?.id ?? payload?.path ?? '',
    dll,
    payload: { ...payload },
  }
  gameServerState = state
  gameServerPlaylist = selectedPlaylist
  if (gameServerWatchdog) clearInterval(gameServerWatchdog)
  gameServerWatchdog = setInterval(() => {
    if (gameServerState !== state) return
    if (processAlive(state.pid)) return
    clearInterval(gameServerWatchdog)
    gameServerWatchdog = null
    gameServerState = null
    gameServerPlaylist = null
    writeGameServerState(false, null)
    scheduleGameServerRestart(state.payload)
  }, 5000)
  gameServerWatchdog.unref?.()

  try {
    send('arc:launch-status', { id: payload?.id, message: 'Waiting for the game server to log in…' })
    const loggedIn = await waitForFortniteLogin(hostStartedAt, state.pid, 50_000, payload.executable, '-nullrhi')
    if (!processAlive(state.pid)) {
      throw new Error('The local game server closed before it finished loading. Close any other running Fortnite client and try again.')
    }
    if (!loggedIn) {
      throw new Error('The local game server did not finish signing in. Close any other Fortnite client and try again.')
    }

    send('arc:launch-status', { id: payload?.id, message: 'Starting matchmaking on the local game server…' })
    const memoryDll = path.join(runtimeRoot(), 'Memory.dll')
    const versionMajor = Number(String(payload?.version || '').split('.')[0])
    if (Number.isFinite(versionMajor) && versionMajor > 0 && versionMajor <= 10 && fs.existsSync(memoryDll)) {
      await injectDll(state.pid, memoryDll)
      await delay(800)
    }
    await injectDll(state.pid, dll)

    // The host still needs a few seconds to open its listen port. Return now so
    // the visible client can boot in parallel with that wait instead of after
    // it; the caller awaits ready() through awaitGameServerReady().
    const ready = (async () => {
      if (!(await waitForGameServerPort(75_000))) {
        throw new Error('The local game server did not open port 7777. Close any other running Fortnite client and try again.')
      }
      writeGameServerState(true, selectedPlaylist)
      send('arc:launch-status', { id: payload?.id, message: 'Local game server is ready.' })
    })()
    ready.catch(() => {})
    gameServerReadyPromise = ready
    return { reused: false }
  } catch (error) {
    gameServerReadyPromise = null
    await stopGameServer()
    throw error
  }
}

/** Wait for the listen port that the host opens after the server DLL loads. */
async function awaitGameServerReady() {
  const ready = gameServerReadyPromise
  gameServerReadyPromise = null
  if (!ready) return
  try {
    await ready
  } catch (error) {
    await stopGameServer()
    throw error
  }
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve()
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    } else {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
      resolve()
    }
  })
}

/**
 * Close a Fortnite client left behind by an earlier VAULTED run. Such a client
 * holds the single-instance mutex, so the hidden host exits before the server
 * can open its port and the player sits in an empty matchmaking queue forever.
 * Only VAULTED launches contain -AUTH_LOGIN; an official Epic client is left
 * alone.
 */
async function stopStaleVaultedClients() {
  if (process.platform !== 'win32') return
  // The PowerShell query below costs a second or more. Almost every launch has
  // no Fortnite client open at all, so check that with a fast tasklist first.
  const anyFortnite = await new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq FortniteClient-Win64-Shipping.exe', '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 8000 },
      (error, stdout) => {
        if (error || !stdout) return resolve(false)
        resolve(/FortniteClient-Win64-Shipping\.exe/i.test(String(stdout)))
      },
    )
  })
  if (!anyFortnite) return
  const pids = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='FortniteClient-Win64-Shipping.exe'\" | Where-Object { $_.CommandLine -match '-AUTH_LOGIN=' } | ForEach-Object { $_.ProcessId }",
      ],
      { windowsHide: true, timeout: 12_000 },
      (error, stdout) => {
        if (error || !stdout) return resolve([])
        resolve(
          String(stdout)
            .split(/\r?\n/)
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isInteger(value) && value > 0),
        )
      },
    )
  })

  for (const pid of pids) {
    await killProcessTree(pid)
  }
  if (pids.length > 0) {
    // Give Windows time to release the mutex and the listen port.
    await delay(1200)
  }
}

/** Normalize a manifest checksum, rejecting anything that is not real SHA-256. */
function normalizeSha256(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('The archive checksum in the build manifest is not a valid SHA-256 hash.')
  }
  return normalized
}

/** Hash the bytes that actually reached disk, not the network stream. */
function sha256File(filePath, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    let finished = false

    const finish = (error, digest) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      stream.destroy()
      if (error) reject(error)
      else resolve(digest)
    }

    const onAbort = () => finish(abortError())

    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => finish(null, hash.digest('hex')))
    stream.on('error', (error) => finish(error))

    if (signal.aborted) onAbort()
  })
}

let cachedSevenZip = null

/** Full 7-Zip (not the cut-down 7za) so RAR and RAR5 archives work too. */
function sevenZipBinary() {
  if (cachedSevenZip) return cachedSevenZip

  const candidates = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, '7zip', '7z.exe'))
  candidates.push(path.join(__dirname, '..', 'node_modules', '7zip-bin-full', 'win', 'x64', '7z.exe'))

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedSevenZip = candidate
      return candidate
    }
  }

  throw new Error('The archive extractor is missing from this installation. Reinstall VAULTED.')
}

function extractArchive(archivePath, destination, controller, id) {
  let binary
  try {
    binary = sevenZipBinary()
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    let stderr = ''
    let finished = false
    const child = spawn(
      binary,
      ['x', '-y', '-bso0', '-bse1', `-o${destination}`, archivePath],
      { windowsHide: true },
    )

    extractions.set(id, child)

    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }

    const finish = (error) => {
      if (finished) return
      finished = true
      extractions.delete(id)
      controller.signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }

    controller.signal.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000)
    })
    child.on('error', (error) => {
      finish(new Error(`Could not start the archive extractor: ${error.message}`))
    })
    child.on('close', (code) => {
      if (controller.signal.aborted) finish(abortError())
      else if (code === 0 || code === 1) finish()
      else {
        const detail = stderr.trim()
        finish(new Error(`Could not extract the archive (7-Zip exited ${code}).${detail ? `\n${detail}` : ''}`))
      }
    })

    if (controller.signal.aborted) onAbort()
  })
}

const MAX_DOWNLOAD_CONNECTIONS = 8
const MIN_PARALLEL_BYTES = 4 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 100
const DOWNLOAD_HEADERS = {
  'User-Agent': 'VAULTED-Launcher/1.1',
  // byte ranges must refer to the archive itself, not a compressed response
  'Accept-Encoding': 'identity',
}

class RangeUnsupportedError extends Error {}

function archiveName(parsed) {
  let name = ''
  try {
    name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
  } catch {
    name = parsed.pathname.split('/').filter(Boolean).pop() || ''
  }
  name = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return name ? name.slice(-180) : 'build.zip'
}

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar', '.ipa', '.apk', '.iso'])

function uniqueFilePath(directory, name) {
  const candidate = path.join(directory, name)
  if (!fs.existsSync(candidate)) return candidate

  const extension = path.extname(name)
  const base = extension ? name.slice(0, -extension.length) : name
  for (let index = 1; index < 1000; index += 1) {
    const next = path.join(directory, `${base}-${index}${extension}`)
    if (!fs.existsSync(next)) return next
  }
  return path.join(directory, `${base}-${Date.now()}${extension}`)
}

function archiveTypeFromHeader(contentType, contentDisposition) {
  const value = `${contentType} ${contentDisposition}`.toLowerCase()
  if (/7z|x-7z/.test(value)) return '7z'
  if (/rar|x-rar/.test(value)) return 'rar'
  if (/iso9660|disk image/.test(value)) return 'iso'
  if (/zip|compressed/.test(value)) return 'zip'
  return null
}

function archiveTypeFromName(name) {
  const extension = path.extname(name).toLowerCase()
  if (extension === '.zip' || extension === '.ipa' || extension === '.apk') return 'zip'
  if (extension === '.7z') return '7z'
  if (extension === '.rar') return 'rar'
  if (extension === '.iso') return 'iso'
  return null
}

function extensionForArchiveType(type) {
  if (type === 'zip') return '.zip'
  if (type === '7z') return '.7z'
  if (type === 'rar') return '.rar'
  if (type === 'iso') return '.iso'
  return ''
}

/** Read just enough bytes to tell an archive from an HTML/error page. */
async function readFileHead(filePath, length = 512) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function archiveTypeFromMagic(buffer) {
  if (!buffer || buffer.length < 4) return null
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2])) return 'zip'
  if (buffer.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z'
  if (buffer.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))) return 'rar'
  if (buffer.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01]))) return 'rar'
  return null
}

function looksLikeWebPage(buffer) {
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')
}

async function inspectDownloadedFile(filePath, contentType, contentDisposition, requestedName) {
  const head = await readFileHead(filePath)
  if (looksLikeWebPage(head)) return { type: null, web: true }

  return {
    type:
      archiveTypeFromMagic(head) ??
      archiveTypeFromHeader(contentType, contentDisposition) ??
      archiveTypeFromName(requestedName),
    web: false,
  }
}

function downloadConnectionCount(total) {
  if (total < MIN_PARALLEL_BYTES) return 1
  return Math.min(MAX_DOWNLOAD_CONNECTIONS, Math.max(2, Math.ceil(total / (4 * 1024 * 1024))))
}

/** Ask for one byte so the host tells us both the archive size and range support. */
async function probeRangeSupport(parsed, signal) {
  const response = await fetch(parsed, {
    signal,
    redirect: 'follow',
    headers: { ...DOWNLOAD_HEADERS, Range: 'bytes=0-0' },
  })

  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)

  const contentRange = (response.headers.get('content-range') || '').trim()
  const match = /^bytes\s+0-0\/(\d+)$/i.exec(contentRange)
  const total = match ? Number(match[1]) : 0
  const supported = response.status === 206 && total > 0

  try {
    await response.body?.cancel()
  } catch {
    /* the probe is disposable */
  }

  return {
    supported,
    total,
    finalUrl: response.url || String(parsed),
    contentType: (response.headers.get('content-type') || '').toLowerCase(),
    contentDisposition: response.headers.get('content-disposition') || '',
  }
}

async function writeAt(handle, buffer, position) {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesWritten) throw new Error('Could not write the download to disk.')
    offset += bytesWritten
  }
}

async function downloadSingleStream(parsed, partPath, signal, onTotal, onChunk) {
  const response = await fetch(parsed, { signal, redirect: 'follow', headers: DOWNLOAD_HEADERS })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)
  if (!response.body) throw new Error('The server returned an empty response.')

  onTotal(Number(response.headers.get('content-length') ?? 0))

  const handle = await fs.promises.open(partPath, 'w')
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk)
      onChunk(chunk.length)
    }
  } finally {
    await handle.close()
  }
}

async function downloadParallel(parsed, partPath, total, signal, onChunk) {
  const connections = downloadConnectionCount(total)
  if (connections <= 1) throw new RangeUnsupportedError('The archive is too small to split.')

  const segmentSize = Math.ceil(total / connections)
  const ranges = []
  for (let index = 0; index < connections; index += 1) {
    const start = index * segmentSize
    if (start >= total) break
    ranges.push({ start, end: Math.min(total - 1, start + segmentSize - 1) })
  }

  const prep = await fs.promises.open(partPath, 'w')
  try {
    await prep.truncate(total)
  } finally {
    await prep.close()
  }

  const workers = new AbortController()
  const abortWorkers = () => workers.abort()
  signal.addEventListener('abort', abortWorkers, { once: true })

  const tasks = ranges.map(async ({ start, end }) => {
    // A separate handle per range avoids concurrent writes racing through one
    // file descriptor. Positional writes still target this range's exact slice.
    const handle = await fs.promises.open(partPath, 'r+')
    try {
      const response = await fetch(parsed, {
        signal: workers.signal,
        redirect: 'follow',
        headers: { ...DOWNLOAD_HEADERS, Range: `bytes=${start}-${end}` },
      })

      if (response.status !== 206) {
        try {
          await response.body?.cancel()
        } catch {
          /* ignore */
        }
        throw new RangeUnsupportedError('The server did not honor byte ranges.')
      }
      if (!response.body) throw new Error('The server returned an empty range response.')

      const reader = response.body.getReader()
      let position = start
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await writeAt(handle, value, position)
          position += value.length
          onChunk(value.length)
        }
      } finally {
        reader.releaseLock()
      }

      if (position !== end + 1) throw new Error('The server returned an incomplete byte range.')
    } finally {
      await handle.close()
    }
  })

  try {
    await Promise.all(tasks)
  } catch (error) {
    workers.abort()
    await Promise.allSettled(tasks)
    throw error
  } finally {
    signal.removeEventListener('abort', abortWorkers)
  }
}

function findNestedArchives(root, depth = 0, found = []) {
  if (depth > 6 || found.length >= 4) return found

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (entry.isDirectory()) continue
    if (!entry.isFile()) continue
    const extension = path.extname(entry.name).toLowerCase()
    // .ipa/.apk are mobile packages, not another Windows archive layer.
    if (!['.zip', '.7z', '.rar', '.iso'].includes(extension)) continue
    found.push(path.join(root, entry.name))
    if (found.length >= 4) return found
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.unpacked-')) continue
    findNestedArchives(path.join(root, entry.name), depth + 1, found)
    if (found.length >= 4) return found
  }

  return found
}

function hasMobilePayload(root, depth = 0) {
  if (depth > 6) return false

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    const lower = entry.name.toLowerCase()
    if (entry.isDirectory()) {
      if (lower === 'payload' || lower.endsWith('.app')) return true
    } else if (lower.endsWith('.ipa') || lower.endsWith('.apk') || lower === 'androidmanifest.xml') {
      return true
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.unpacked-')) continue
    if (hasMobilePayload(path.join(root, entry.name), depth + 1)) return true
  }

  return false
}

/** Some mirrors wrap the real game inside another .zip/.7z/.rar. */
async function unpackNestedArchives(root, downloadedArchive, controller, id) {
  const archives = findNestedArchives(root).filter(
    (candidate) => path.resolve(candidate).toLowerCase() !== path.resolve(downloadedArchive).toLowerCase(),
  )

  for (const archive of archives) {
    if (controller.signal.aborted) throw abortError()
    const label = path.basename(archive).replace(/[^a-z0-9._-]/gi, '_').slice(-80)
    const destination = path.join(path.dirname(archive), `.unpacked-${label}`)
    try {
      await fs.promises.mkdir(destination, { recursive: true })
      await extractArchive(archive, destination, controller, id)
    } catch (error) {
      if (controller.signal.aborted) throw abortError()
      // A nested archive that cannot be opened must not discard the outer
      // download or anything already unpacked next to it.
      continue
    }
    const executable = findPrimaryExecutable(destination) ?? findExecutable(destination)
    if (executable) return executable
  }

  return null
}

/**
 * Streams an archive to disk, reports progress, unpacks .zip files and locates
 * the client executable. Large archives use parallel byte ranges so several
 * connections can fill the pipe at once; hosts without range support fall back
 * to a normal stream. Used by the IPC handler and by the smoke test.
 */
async function downloadBuild(payload) {
  const { id, key, url } = payload ?? {}
  if (typeof id !== 'string' || !id) throw new Error('Invalid download request.')
  const expectedSha256 = normalizeSha256(payload?.sha256)

  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error('That download link is not a valid URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) download links are supported.')
  }

  const safeKey = String(key ?? id).replace(/[^a-z0-9_-]/gi, '') || 'build'
  if (downloads.has(id)) throw new Error('This build is already downloading.')

  const targetDir = path.join(buildsRoot(), safeKey)
  const existingExecutable = findExecutable(targetDir)
  if (existingExecutable) {
    throw new Error(
      `A build is already installed for this season at:\n${folderForExecutable(existingExecutable)}\n\nVAULTED will not overwrite or delete it. Delete that build first if you really want to download another copy.`,
    )
  }
  await fs.promises.mkdir(targetDir, { recursive: true })

  const requestedName = archiveName(parsed)
  let filePath = uniqueFilePath(targetDir, requestedName)
  // Never reuse or remove a previous .part file. A cancelled download stays on
  // disk for manual recovery.
  const partPath = uniqueFilePath(targetDir, `${requestedName}.part`)

  const controller = new AbortController()
  downloads.set(id, controller)
  let lastLogged = -20
  let lastSent = 0
  let startedAt = Date.now()
  let received = 0
  let total = 0
  let probe = { supported: false, total: 0, finalUrl: String(parsed), contentType: '', contentDisposition: '' }

  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastSent < PROGRESS_INTERVAL_MS) return
    lastSent = now

    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null
    const elapsedSeconds = (now - startedAt) / 1000
    const bytesPerSecond = elapsedSeconds > 0 ? received / elapsedSeconds : 0
    const etaSeconds =
      total > 0 && bytesPerSecond > 0 && elapsedSeconds >= 1
        ? Math.max(0, Math.round((total - received) / bytesPerSecond))
        : null

    send('arc:download-progress', {
      id,
      received,
      total,
      percent,
      etaSeconds,
      phase: 'downloading',
    })

    if (SMOKE_URL && (percent === null || percent - lastLogged >= 20 || percent === 100)) {
      lastLogged = percent ?? lastLogged
      smokeLog(`download progress ${percent ?? '?'}% (${received}/${total} bytes)`)
    }
  }

  try {
    try {
      probe = await probeRangeSupport(parsed, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) throw abortError()
      // A normal GET may still work when the probe cannot be completed.
    }

    startedAt = Date.now()
    total = probe.total
    report(true)

    if (probe.supported && downloadConnectionCount(probe.total) > 1) {
      try {
        await downloadParallel(parsed, partPath, probe.total, controller.signal, (bytes) => {
          received += bytes
          report()
        })
        if (received !== probe.total) throw new Error('The download did not receive every byte.')
      } catch (error) {
        if (controller.signal.aborted) throw abortError()

        // Range support can be advertised and still fail behind a CDN. Restart
        // once as a single stream rather than leaving a broken archive.
        await fs.promises.rm(partPath, { force: true }).catch(() => {})
        received = 0
        total = 0
        startedAt = Date.now()
        report(true)
        await downloadSingleStream(
          parsed,
          partPath,
          controller.signal,
          (nextTotal) => {
            total = nextTotal
            report(true)
          },
          (bytes) => {
            received += bytes
            report()
          },
        )
      }
    } else {
      await downloadSingleStream(
        parsed,
        partPath,
        controller.signal,
        (nextTotal) => {
          total = nextTotal
          report(true)
        },
        (bytes) => {
          received += bytes
          report()
        },
      )
    }

    if (controller.signal.aborted) throw abortError()
    report(true)

    if (expectedSha256) {
      send('arc:download-progress', {
        id,
        received,
        total,
        percent: 100,
        etaSeconds: null,
        phase: 'verifying',
      })
      if (SMOKE_URL) smokeLog('download complete, verifying checksum')

      const actualSha256 = await sha256File(partPath, controller.signal)
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `Download checksum mismatch for ${requestedName}. The archive is corrupted and was not installed. Expected ${expectedSha256}, got ${actualSha256}.`,
        )
      }
    }

    const inspection = await inspectDownloadedFile(
      partPath,
      probe.contentType,
      probe.contentDisposition,
      requestedName,
    )

    if (inspection.web) {
      filePath = uniqueFilePath(targetDir, `${requestedName}.html`)
      await fs.promises.rename(partPath, filePath)
      throw new Error(
        `The download source returned a web page instead of an archive. The file was kept at:\n${filePath}\n\nNothing was deleted. Try Refresh sources in Settings.`,
      )
    }

    if (!inspection.type) {
      filePath = uniqueFilePath(targetDir, requestedName)
      await fs.promises.rename(partPath, filePath)
      throw new Error(
        `The downloaded file is not a supported archive. It was kept at:\n${filePath}\n\nNothing was deleted.`,
      )
    }

    const extension = path.extname(requestedName).toLowerCase()
    const finalName = ARCHIVE_EXTENSIONS.has(extension)
      ? requestedName
      : `${requestedName}${extensionForArchiveType(inspection.type)}`
    filePath = uniqueFilePath(targetDir, finalName)

    // Promote the finished download before touching it. Existing archives are
    // never removed or overwritten; a second copy gets a -1/-2 suffix.
    await fs.promises.rename(partPath, filePath)

    send('arc:download-progress', {
      id,
      received,
      total,
      percent: 100,
      etaSeconds: null,
      phase: 'extracting',
    })
    if (SMOKE_URL) smokeLog('download complete, extracting')

    const mobileArchive = path.extname(filePath).toLowerCase() === '.ipa' || path.extname(filePath).toLowerCase() === '.apk'
    if (!mobileArchive) {
      await extractArchive(filePath, targetDir, controller, id)
      if (controller.signal.aborted) throw abortError()
    }

    let executable = findPrimaryExecutable(targetDir)
    if (!executable && !mobileArchive) {
      executable = await unpackNestedArchives(targetDir, filePath, controller, id)
    }
    if (!executable) executable = findExecutable(targetDir)

    const mobile = !executable && (mobileArchive || hasMobilePayload(targetDir))
    const reason = executable ? null : mobile ? 'mobile' : 'no-executable'

    // Deliberately never delete filePath here. The user's download is kept even
    // after a successful install, and nothing is removed on failure either.
    return {
      filePath,
      executable,
      folder: executable ? folderForExecutable(executable) : targetDir,
      reason,
    }
  } catch (error) {
    // Never wipe the target folder, archive, or extracted files because of a
    // failed detection, extraction, checksum, or cancellation.
    throw error
  } finally {
    // Only remove a .part that never received any bytes. Partial downloads are
    // left in place for manual recovery instead of being silently discarded.
    if (received === 0) await fs.promises.rm(partPath, { force: true }).catch(() => {})
    extractions.delete(id)
    downloads.delete(id)
  }
}

const VERIFY_MAX_FILES = 250000
const VERIFY_TEMP_RE = /\.(part|tmp|temp|crdownload|download|!ut|aria2)$/i

function emptyVerifyReport() {
  return {
    managed: true,
    verified: false,
    files: 0,
    bytes: 0,
    paks: 0,
    issueCount: 0,
    issues: { missing: [], empty: [], unreadable: [], temp: [], corrupt: [] },
    elapsedMs: 0,
  }
}

function addVerifyIssue(report, kind, message) {
  report.issueCount += 1
  if (report.issues[kind] && report.issues[kind].length < 15) report.issues[kind].push(message)
}

/** Read a few small samples so a multi-gigabyte PAK is not loaded into RAM. */
async function sampleFile(filePath, size) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const length = Math.min(512, Math.max(1, size))
    const positions = [0]
    if (size > length) positions.push(Math.max(0, Math.floor(size / 2) - Math.floor(length / 2)))
    if (size > length * 2) positions.push(size - length)

    const buffers = []
    for (const position of positions) {
      const buffer = Buffer.alloc(length)
      const result = await handle.read(buffer, 0, length, position)
      if (result.bytesRead > 0) buffers.push(buffer.subarray(0, result.bytesRead))
    }
    return Buffer.concat(buffers)
  } finally {
    await handle.close()
  }
}

/**
 * Validates a VAULTED-managed install without modifying it. Every file is
 * checked for existence/readability, zero-byte truncation and leftovers from
 * interrupted downloads; executables and PAK headers get an additional sanity
 * read so a half-written client is reported instead of silently launched.
 */
async function verifyBuild(payload) {
  const id = typeof payload?.id === 'string' ? payload.id : ''
  const startedAt = Date.now()
  const report = emptyVerifyReport()

  if (!id || typeof payload?.path !== 'string' || !payload.path || typeof payload?.executable !== 'string') {
    return { ...report, managed: false }
  }

  const root = path.resolve(buildsRoot())
  const target = path.resolve(payload.path)
  const relativeTarget = path.relative(root, target)
  if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    return { ...report, managed: false }
  }
  if (running.has(id) || downloads.has(id)) {
    return { ...report, running: true }
  }

  const executable = path.resolve(payload.executable)
  const relativeExecutable = path.relative(target, executable)
  const executableIsInside = Boolean(relativeExecutable) && !relativeExecutable.startsWith('..') && !path.isAbsolute(relativeExecutable)
  const paksDir = path.join(folderForExecutable(executable), 'FortniteGame', 'Content', 'Paks')
  let executableStat = null

  if (!executableIsInside || !fs.existsSync(executable)) {
    addVerifyIssue(report, 'missing', relativeExecutable || path.basename(executable) || 'client executable')
  } else {
    try {
      executableStat = await fs.promises.stat(executable)
      if (executableStat.size === 0) addVerifyIssue(report, 'empty', relativeExecutable)
      if (executableStat.size > 1) {
        const header = await sampleFile(executable, 2)
        if (header.length < 2 || header[0] !== 0x4d || header[1] !== 0x5a) {
          addVerifyIssue(report, 'corrupt', `${relativeExecutable} (not a Windows executable)`)
        }
      }
    } catch {
      addVerifyIssue(report, 'unreadable', relativeExecutable)
    }
  }

  if (!fs.existsSync(paksDir)) {
    addVerifyIssue(report, 'missing', 'FortniteGame/Content/Paks')
  }

  const stack = [target]
  let stoppedAtLimit = false

  while (stack.length > 0 && !stoppedAtLimit) {
    const current = stack.pop()
    let entries
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      addVerifyIssue(report, 'unreadable', path.relative(target, current) || '.')
      continue
    }

    for (const entry of entries) {
      if (report.files >= VERIFY_MAX_FILES) {
        stoppedAtLimit = true
        break
      }

      const full = path.join(current, entry.name)
      const relative = path.relative(target, full)

      if (entry.isSymbolicLink()) {
        addVerifyIssue(report, 'corrupt', `${relative} (symbolic link)`)
        continue
      }
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue

      report.files += 1
      const lowerName = entry.name.toLowerCase()
      if (VERIFY_TEMP_RE.test(entry.name)) addVerifyIssue(report, 'temp', relative)

      let stat
      try {
        stat = await fs.promises.stat(full)
      } catch {
        addVerifyIssue(report, 'unreadable', relative)
        continue
      }

      report.bytes += stat.size
      if (stat.size === 0) {
        addVerifyIssue(report, 'empty', relative)
        continue
      }

      try {
        await fs.promises.access(full, fs.constants.R_OK)
      } catch {
        addVerifyIssue(report, 'unreadable', relative)
        continue
      }

      if (lowerName.endsWith('.pak')) {
        const normalizedPaks = path.resolve(paksDir).toLowerCase()
        if (full.toLowerCase().startsWith(`${normalizedPaks}${path.sep}`)) report.paks += 1
        if (stat.size < 1024) {
          addVerifyIssue(report, 'corrupt', `${relative} (PAK is too small)`)
          continue
        }
        try {
          const sample = await sampleFile(full, stat.size)
          if (sample.length === 0 || sample.every((byte) => byte === 0)) {
            addVerifyIssue(report, 'corrupt', `${relative} (empty PAK data)`)
          }
        } catch {
          addVerifyIssue(report, 'unreadable', relative)
        }
      }
    }
  }

  if (stoppedAtLimit) addVerifyIssue(report, 'corrupt', `Scan stopped after ${VERIFY_MAX_FILES.toLocaleString()} files.`)
  if (report.paks === 0 && fs.existsSync(paksDir)) {
    addVerifyIssue(report, 'missing', 'FortniteGame/Content/Paks has no PAK files')
  }

  report.verified = report.issueCount === 0
  report.elapsedMs = Date.now() - startedAt
  return report
}

function registerIpc() {
  ipcMain.handle('arc:check-builds', (_event, builds) => {
    /** @type {Record<string, boolean>} */
    const result = {}
    for (const build of Array.isArray(builds) ? builds : []) {
      if (!build || typeof build.id !== 'string') continue
      result[build.id] = typeof build.executable === 'string' && fs.existsSync(build.executable)
    }
    return result
  })

  ipcMain.handle('arc:download-build', (_event, payload) => downloadBuild(payload))

  ipcMain.handle('arc:delete-build', async (_event, payload) => {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id || typeof payload?.path !== 'string' || !payload.path) {
      return { deleted: false, managed: false }
    }
    if (running.has(id) || downloads.has(id)) return { deleted: false, managed: true, running: true }

    const root = path.resolve(buildsRoot())
    const target = path.resolve(payload.path)
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { deleted: false, managed: false }
    }

    // A download owns the whole top-level key folder (archive + extracted
    // client), so deleting a nested executable also removes the archive.
    const topLevel = relative.split(path.sep)[0]
    const managedFolder = path.join(root, topLevel)
    if (!managedFolder || path.dirname(managedFolder) !== root) return { deleted: false, managed: false }

    await fs.promises.rm(managedFolder, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    return { deleted: true, managed: true }
  })

  ipcMain.handle('arc:verify-build', (_event, payload) => verifyBuild(payload))

  ipcMain.handle('arc:scan-builds', () => scanForBuilds())

  // the readable copy of the session for synchronous boot
  ipcMain.on('arc:read-session-sync', (event) => {
    event.returnValue = readSessionFile()
  })
  ipcMain.handle('arc:save-session', (_event, value) => writeSessionFile(value))
  ipcMain.handle('arc:account-session-read', () => readAccountSession())
  ipcMain.handle('arc:account-session-save', (_event, value) => writeAccountSession(value))
  ipcMain.handle('arc:account-session-clear', () => clearAccountSession())
  ipcMain.handle('arc:clear-session', () => {
    clearSessionFile()
    return true
  })

  ipcMain.handle('arc:cancel-download', (_event, payload) => {
    const id = String(payload?.id)
    const controller = downloads.get(id)
    const extractor = extractions.get(id)
    if (!controller && !extractor) return { cancelled: false }

    controller?.abort()
    if (extractor) {
      try {
        extractor.kill()
      } catch {
        /* already gone */
      }
      extractions.delete(id)
    }
    downloads.delete(id)
    return { cancelled: true }
  })

  ipcMain.handle('arc:sync-inventory', async (_event, payload) => {
    try {
      return await syncVaultedInventory(payload)
    } catch (error) {
      console.warn(`[VAULTED] Could not sync the in-game inventory: ${error instanceof Error ? error.message : error}`)
      return { synced: false, error: error instanceof Error ? error.message : 'The in-game inventory could not be updated.' }
    }
  })

  ipcMain.handle('arc:launch-build', async (_event, payload) => {
    assertBuild(payload)

    const id = typeof payload.id === 'string' ? payload.id : null
    const join = joinTargetFromPayload(payload)
    let injector = null
    let gamePid = null
    let gameServerReady = false
    let matchmakingReady = false

    try {
      send('arc:launch-status', { id: id ?? undefined, message: 'Preparing the private server…' })
      if (join) writeJoinTarget(join.host, join.port)
      else clearJoinTarget()
      await ensureLocalBackend(payload.username)
      if (payload.inventory) {
        try {
          await syncVaultedInventory({ username: payload.username, ...payload.inventory })
        } catch (error) {
          console.warn(`[VAULTED] Could not sync the in-game inventory: ${error instanceof Error ? error.message : error}`)
        }
      }
      // The matchmaker only hands out the host once port 7777 exists, so it can
      // be running long before the host is. Starting it first means an early
      // Play click in game queues instead of erroring.
      try {
        await ensureLocalMatchmaker()
        matchmakingReady = true
      } catch (error) {
        console.warn(`[VAULTED] Local matchmaker unavailable: ${error instanceof Error ? error.message : error}`)
      }

      const registerPlayer = (launched) => {
        injector = launched.child
        gamePid = launched.pid
        if (!id) return
        running.set(id, { pid: gamePid, injectorPid: injector.pid ?? null })
        injector.on('exit', () => {
          running.delete(id)
          send('arc:build-exited', { id })
          if (running.size === 0) {
            clearJoinTarget()
            if (gameServerState) void stopGameServer()
            else void stopStaleVaultedClients()
          }
        })
      }

      let serverSpawned = false
      if (!join) {
        try {
          await ensureGameServer(payload)
          serverSpawned = true
        } catch (error) {
          // Some modern EOS builds never expose the local listen server.
          // Do not leave a live matchmaker behind in that case: the client would
          // reach the lobby, queue, and ping an empty matchmaker forever.
          console.warn(`[VAULTED] Local game server unavailable: ${error instanceof Error ? error.message : error}`)
          await stopGameServer()
          await stopOwnedListener(MATCHMAKER_PORT, 'matchmaker.cjs')
          send('arc:launch-status', {
            id: id ?? undefined,
            message: 'Game server unavailable — opening the lobby only.',
          })
        }
      } else {
        send('arc:launch-status', {
          id: id ?? undefined,
          message: `Joining ${join.host}:${join.port}…`,
        })
      }

      send('arc:launch-status', { id: id ?? undefined, message: 'Starting Fortnite…' })
      const launched = await launchInjectedGame(payload)
      registerPlayer(launched)

      if (serverSpawned) {
        await awaitGameServerReady()
        gameServerReady = true
      }

      send('arc:launch-status', { id: id ?? undefined, message: 'Signing in to the private server…' })
      return {
        pid: gamePid,
        privateServer: gameServerReady,
        matchmaking: matchmakingReady,
        joined: join ? `${join.host}:${join.port}` : null,
      }
    } catch (error) {
      if (gamePid) await killProcessTree(gamePid)
      if (injector?.pid) await killProcessTree(injector.pid)
      if (id) running.delete(id)
      if (running.size === 0 && gameServerState) await stopGameServer()
      throw error
    }
  })

  ipcMain.handle('arc:close-build', async (_event, payload) => {
    const id = String(payload?.id ?? '')
    const entry = running.get(id)
    if (!entry?.pid) return { closed: false }

    await killProcessTree(entry.pid)

    running.delete(id)
    if (running.size === 0) {
      clearJoinTarget()
      if (gameServerState) await stopGameServer()
      else await stopStaleVaultedClients()
    }
    return { closed: true }
  })

  ipcMain.handle('arc:lan-ip', () => lanAddress())
  ipcMain.handle('arc:public-address', () => resolvePublicAddress())
  ipcMain.handle('arc:get-public-address', () => {
    const manual = readPublicOverride()
    return manual ? `${manual.address}:${manual.port}` : ''
  })
  ipcMain.handle('arc:set-public-address', (_event, value) => setPublicOverride(value))

  ipcMain.handle('arc:pick-folder', async () => {
    const parent = mainWindow ?? undefined
    const options = {
      title: 'Select a Fortnite build folder',
      buttonLabel: 'Use this build',
      properties: ['openDirectory'],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('win:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('win:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })

  ipcMain.handle('win:close', () => {
    mainWindow?.close()
  })
}

/* ------------------------------------------------------------------- smoke */

function smokeLog(line) {
  const file = path.join(__dirname, '..', '.logs', 'smoke.log')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
}

/** Headless verification: render a frame, or exercise the downloader. */
function runSmokeTest() {
  smokeLog('ready-to-show fired')

  if (SMOKE_URL) {
    void (async () => {
      try {
        const result = await downloadBuild({
          id: 'smoke-build',
          key: 'smoke-build',
          url: SMOKE_URL,
          sha256: SMOKE_SHA256 || undefined,
        })
        smokeLog('DOWNLOAD_OK ' + JSON.stringify(result))
        app.quit()
      } catch (error) {
        smokeLog('DOWNLOAD_FAIL ' + String(error && error.message ? error.message : error))
        app.exit(1)
      }
    })()
    return
  }

  setTimeout(async () => {
    try {
      const image = await mainWindow.webContents.capturePage()
      const out = path.join(__dirname, '..', '.logs', 'smoke.png')
      fs.writeFileSync(out, image.toPNG())
      smokeLog('SMOKE_OK ' + out)
      app.quit()
    } catch (error) {
      smokeLog('SMOKE_FAIL ' + String(error))
      app.exit(1)
    }
  }, 1500)
}

ipcMain.handle('shell:open-external', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url)
})

/**
 * Applies a downloaded update without any browser or download page. Waits for
 * an active build download or running game to finish so it never interrupts
 * one, then installs silently and reopens the launcher on the new version.
 */
function scheduleSilentInstall() {
  if (DEV || SMOKE || autoInstallTimer) return

  const attempt = () => {
    if (downloads.size > 0 || running.size > 0) {
      autoInstallTimer = setTimeout(attempt, 30_000)
      return
    }
    autoInstallTimer = null
    try {
      autoUpdater.quitAndInstall(true, true)
    } catch {
      /* autoInstallOnAppQuit is the fallback */
    }
  }

  autoInstallTimer = setTimeout(attempt, 10_000)
}

ipcMain.handle('arc:check-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates()
    return { ok: true, version: result?.updateInfo?.version ?? null, currentVersion: app.getVersion() }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
})

ipcMain.handle('arc:install-update', async () => {
  try {
    autoUpdater.quitAndInstall()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
})

ipcMain.handle('arc:download-update', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
})

app.whenReady().then(() => {
  if (SMOKE) {
    smokeLog('app ready; argv=' + JSON.stringify(process.argv))
    app.on('render-process-gone', (_event, _contents, details) => smokeLog('render gone: ' + JSON.stringify(details)))
  }

  // Keep the launcher on the newest release without requiring a Settings
  // click: check on launch, download in the background, then install as soon
  // as no game or build download is active.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.on('update-available', (info) => {
    send('arc:update-available', { version: info.version })
  })
  autoUpdater.on('update-downloaded', (info) => {
    send('arc:update-downloaded', { version: info.version })
    scheduleSilentInstall()
  })
  autoUpdater.on('download-progress', (progress) => {
    send('arc:update-progress', { percent: Math.round(progress?.percent ?? 0) })
  })
  autoUpdater.on('error', (err) => {
    const message = String(err && err.message ? err.message : err)
    send('arc:update-error', { message })
    if (SMOKE) smokeLog('updater error: ' + message)
  })

  registerIpc()
  createWindow()
  startPlaylistWatcher()

  // Warm the local matchmaker while the user is still choosing a season, so a
  // Start click does not pay for process startup. It waits for port 7777 on its
  // own, so running it before the host exists is safe.
  void ensureLocalMatchmaker().catch(() => {})

  // Check on launch and every five minutes; downloads install themselves.
  if (!DEV && !SMOKE) {
    const check = () => autoUpdater.checkForUpdates().catch(() => {})
    setTimeout(check, 5000)
    setInterval(check, 5 * 60 * 1000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
