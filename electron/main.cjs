const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
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
const BACKEND_PASSWORD = 'Rebooted'
const LEGACY_FLTOKEN = '3db3ba5dcbd2e16703f3978d'
const LEGACY_CALDERA =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ'
const LEGACY_CALDERA_EOS =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoic2FyYWgiLCJnZW5lcmF0ZWQiOjE3NzQxMjEzNzksImNhbGRlcmFHdWlkIjoiZWYzMGE4MjUtMzFlNi00ZWRhLTlmM2EtZTI4YzgwNjYxODkxIiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXRFT1MiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.f7EcDmsjj3XHzdbMl41YHyJE-LlAirjbjaqzcdqBB_Y'

let backendInstallPromise = null
let backendStartPromise = null

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

function findExecutable(root, depth = 0) {
  if (depth > 8) return null

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && entry.name.toLowerCase() === 'fortniteclient-win64-shipping.exe') {
      return path.join(root, entry.name)
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findExecutable(path.join(root, entry.name), depth + 1)
    if (found) return found
  }

  return null
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
      } else if (entry.name.toLowerCase() === 'fortniteclient-win64-shipping.exe') {
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
  if (fs.existsSync(paths.node) && fs.existsSync(paths.app)) return paths

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

async function ensureLocalBackend() {
  if (await backendResponds()) return { reused: true, pid: null }
  if (backendStartPromise) return backendStartPromise

  backendStartPromise = (async () => {
    const paths = await ensureBackendRuntime()
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
        env: { ...process.env, NODE_ENV: 'production' },
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

function fortniteLaunchArgs(payload) {
  const username =
    String(payload.username || 'Player')
      .replace(/[^a-z0-9_]/gi, '')
      .slice(0, 24) || 'Player'
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
  if (eos) args.push('-nouac', '-nocodeguards')
  return args
}

/**
 * Starts the game suspended, loads the redirect DLL into it, then resumes it.
 * Doing this before any client code runs is what guarantees the very first
 * OAuth request is redirected instead of hitting Epic and failing with 1015.
 */
function launchInjectedGame(payload) {
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
    injectorArgs.push('--', ...fortniteLaunchArgs(payload))

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

  return { supported, total }
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
  const targetExisted = fs.existsSync(targetDir)
  await fs.promises.mkdir(targetDir, { recursive: true })

  const name = archiveName(parsed)
  const filePath = path.join(targetDir, name)
  const partPath = `${filePath}.part`
  await fs.promises.rm(partPath, { force: true }).catch(() => {})

  const controller = new AbortController()
  downloads.set(id, controller)
  let lastLogged = -20
  let lastSent = 0
  let startedAt = Date.now()
  let received = 0
  let total = 0

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
    let probe = { supported: false, total: 0 }
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
          `Download checksum mismatch for ${name}. The archive is corrupted and was not installed. Expected ${expectedSha256}, got ${actualSha256}.`,
        )
      }
    }

    await fs.promises.rm(filePath, { force: true })
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

    const extension = path.extname(name).toLowerCase()
    if (extension === '.zip' || extension === '.7z' || extension === '.rar') {
      await extractArchive(filePath, targetDir, controller, id)
    }

    if (controller.signal.aborted) throw abortError()
    const executable = findExecutable(targetDir)
    const archiveWasExtracted = extension === '.zip' || extension === '.7z' || extension === '.rar'

    // Only a confirmed install is allowed to discard the archive. A missing
    // executable, an extraction error, or a cancellation keeps it for manual
    // recovery.
    if (executable && archiveWasExtracted) {
      try {
        await fs.promises.rm(filePath, { force: true })
        if (SMOKE_URL) smokeLog('archive deleted after successful install')
      } catch {
        // The installed build is still usable if antivirus or a file lock
        // prevents cleanup; leave the archive in place.
      }
    }

    return {
      filePath,
      executable,
      folder: executable ? folderForExecutable(executable) : targetDir,
    }
  } catch (error) {
    // Never wipe a completed archive because extraction failed or the user
    // cancelled. Only remove an empty target created by a failed download.
    if (!fs.existsSync(filePath) && !targetExisted) {
      await fs.promises.rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  } finally {
    await fs.promises.rm(partPath, { force: true }).catch(() => {})
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

  ipcMain.handle('arc:launch-build', async (_event, payload) => {
    assertBuild(payload)

    const id = typeof payload.id === 'string' ? payload.id : null
    let injector = null
    let gamePid = null

    try {
      send('arc:launch-status', { id: id ?? undefined, message: 'Preparing the private server…' })
      await ensureLocalBackend()

      send('arc:launch-status', { id: id ?? undefined, message: 'Starting Fortnite…' })
      const launched = await launchInjectedGame(payload)
      injector = launched.child
      gamePid = launched.pid

      if (id) {
        running.set(id, { pid: gamePid, injectorPid: injector.pid ?? null })
        injector.on('exit', () => {
          running.delete(id)
          send('arc:build-exited', { id })
        })
      }

      send('arc:launch-status', { id: id ?? undefined, message: 'Signing in to the private server…' })
      return { pid: gamePid, privateServer: true }
    } catch (error) {
      if (gamePid) await killProcessTree(gamePid)
      if (injector?.pid) await killProcessTree(injector.pid)
      if (id) running.delete(id)
      throw error
    }
  })

  ipcMain.handle('arc:close-build', async (_event, payload) => {
    const id = String(payload?.id ?? '')
    const entry = running.get(id)
    if (!entry?.pid) return { closed: false }

    await killProcessTree(entry.pid)

    running.delete(id)
    return { closed: true }
  })

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
    return { ok: true, version: result?.updateInfo?.version ?? null }
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

app.whenReady().then(() => {
  if (SMOKE) {
    smokeLog('app ready; argv=' + JSON.stringify(process.argv))
    app.on('render-process-gone', (_event, _contents, details) => smokeLog('render gone: ' + JSON.stringify(details)))
  }

  // silent auto-update via GitHub releases: no browser, no prompts
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
  autoUpdater.on('error', (err) => {
    if (SMOKE) smokeLog('updater error: ' + String(err && err.message ? err.message : err))
  })

  registerIpc()
  createWindow()

  // check on launch and every 30 minutes; downloads install themselves
  if (!DEV && !SMOKE) {
    const check = () => autoUpdater.checkForUpdates().catch(() => {})
    setTimeout(check, 5000)
    setInterval(check, 30 * 60 * 1000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
