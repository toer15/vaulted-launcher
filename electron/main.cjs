const { app, BrowserWindow, WebContentsView, dialog, ipcMain, safeStorage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const dns = require('node:dns')
const net = require('node:net')
const { spawn, execFile } = require('node:child_process')
const { autoUpdater } = require('electron-updater')
const {
  ensureProviderRedirects,
  stageProviderDlls,
  STAGED_RUNTIME_DLLS,
  runtimeConfig,
  sharedRuntimeRoot,
  providerCatalog,
  providerDllPath,
  legacyRedirectDllPath,
  providerForId,
  providerProfile,
  providerRuntime,
  providerRuntimeMetadata,
  providerUsesLegacyRedirect,
  redirectDllMatchesProfile,
  redirectSupportsBackendParameter,
} = require('./onlineProviders.cjs')
const { fetchCommunityServers, normalizeHostPort, probePing } = require('./communityServers.cjs')
const { createProviderAuth } = require('./providerAuth.cjs')
const {
  LEGACY_CALDERA,
  LEGACY_CALDERA_EOS,
  LEGACY_FLTOKEN,
  providerFortniteArgs,
  providerLaunchDiagnostic,
  logProviderLaunchDiagnostic,
} = require('./providerLaunchArgs.cjs')
const { createEraBridge } = require('./eraBridge.cjs')
const { cleanupManagedBuild: cleanupBuildFolder } = require('./buildCleanup.cjs')
const { isOptionalVerifyIssue, removeLooseFiles, scanLooseFiles } = require('./autoFix.cjs')
const { writeSavedBuild } = require('./rebootLauncher.cjs')
const {
  clickCompanionPlayButton,
  dismissCompanionServerPrompt,
  hideCompanionLauncher,
} = require('./companionAutomation.cjs')
const { fetchProviderLiveStatuses } = require('./providerStatus.cjs')
const { planProviderOverlay, selectProviderArchiveSource } = require('./providerArchive.cjs')
const { inviteCode, verifyDiscordCommunity } = require('./discordGate.cjs')
const { startHiddenWindowWatcher } = require('./hiddenWindows.cjs')
const {
  GAME_POLL_MS,
  createCompanionSessionState,
  observeCompanionSession,
} = require('./companionLifecycle.cjs')
const rangeDownload = require('./rangeDownloader.cjs')
const {
  ensureProviderRuntime,
  installedExecutable,
  installedExecutables,
  launchArguments,
} = require('./providerRuntime.cjs')

const { botFillPreferences } = require('./botFill.cjs')

const DEV = process.argv.includes('--dev')
const SMOKE = process.argv.includes('--smoke')
/** set to a direct archive URL to exercise the downloader in smoke mode */
const SMOKE_URL = process.env.RIFT_SMOKE_URL ?? ''
/** optional expected hash for a smoke download */
const SMOKE_SHA256 = process.env.RIFT_SMOKE_SHA256 ?? ''
/** optional provider metadata so smoke mode exercises archive repair validation */
const SMOKE_PROVIDER_ID = process.env.RIFT_SMOKE_PROVIDER_ID ?? ''
const SMOKE_SEASON_ID = process.env.RIFT_SMOKE_SEASON_ID ?? ''
const SMOKE_BUILD_ID = process.env.RIFT_SMOKE_BUILD_ID ?? ''
const SMOKE_PREFERRED_FOLDER = process.env.RIFT_SMOKE_PREFERRED_FOLDER ?? ''
const SMOKE_REPAIR = process.env.RIFT_SMOKE_REPAIR === '1'
/** e.g. RIFT_SMOKE_SIZE=1600x900 — lets the smoke capture use a larger window */
const SMOKE_SIZE = process.env.RIFT_SMOKE_SIZE ?? ''

/** @type {BrowserWindow | null} */
let mainWindow = null

/** Native OAuth account link for live global providers (Era). */
const providerAuth = createProviderAuth({
  app,
  safeStorage,
  BrowserWindow,
  WebContentsView,
  getParentWindow: () => mainWindow,
  listProviders: () => providerCatalog(),
  profileForId: (id) => providerProfile(id),
})

/** buildId -> { pid, injectorPid, startedAt, expectedExecutable } */
const running = new Map()
/** builds the user asked VAULTED to close, so their exit is not a crash */
const expectedBuildCloses = new Set()
/** buildId -> join watchdog (only auto-discovered lobby joins) */
const joinWatchdogs = new Map()
/** buildId -> AbortController */
const downloads = new Map()
/** buildId -> running archive extraction process */
const extractions = new Map()
/** providerId -> signed external launcher spawned by VAULTED */
const providerLaunchers = new Map()
/** providerId -> interval that keeps that launcher's window hidden */
const companionWindowHiders = new Map()

/**
 * Keep a companion launcher invisible for its whole session: immediately after
 * spawn, then once a second in case Flutter recreates or restores its window
 * when the game starts. The player must only ever see VAULTED and Fortnite.
 */
function startCompanionWindowHider(providerId, pid) {
  const id = String(providerId || '').trim().toLowerCase()
  if (!id || !pid) return null
  stopCompanionWindowHider(id)
  const state = { pid, timer: null }
  const hide = () => {
    void hideCompanionLauncher(pid)
  }
  hide()
  state.timer = setInterval(hide, 1_000)
  state.timer.unref?.()
  companionWindowHiders.set(id, state)
  return state
}

function stopCompanionWindowHider(providerId) {
  const id = String(providerId || '').trim().toLowerCase()
  const state = companionWindowHiders.get(id)
  if (!state) return
  if (state.timer) clearInterval(state.timer)
  companionWindowHiders.delete(id)
}
/** providerId -> live game-session monitor for that merged companion launcher */
const companionMonitors = new Map()
/** providerId -> auth heartbeat that keeps the launched session alive */
const sessionHeartbeats = new Map()
/** How often a running game's provider session is rotated and re-proved. */
const SESSION_HEARTBEAT_MS = 4 * 60_000

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
const MATCHMAKER_PROTOCOL = 4
const GAME_SERVER_PORT = 7777
const BACKEND_PASSWORD = 'Rebooted'

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

  // VAULTED never opens a browser window for a game launch.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (DEV) {
    mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

/* ------------------------------------------------------------------ builds */

function defaultInstallDir() {
  return path.join(app.getPath('userData'), 'builds')
}

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

/** User-editable global client defaults and per-season install state. */
function profilesFilePath() {
  return path.join(app.getPath('userData'), 'profiles.json')
}

function readProfilesFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesFilePath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeProfilesFile(next) {
  try {
    const document = next && typeof next === 'object' && !Array.isArray(next) ? next : {}
    const target = profilesFilePath()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(document, null, 2), 'utf8')
    fs.renameSync(temporary, target)
    return { ok: true, profiles: document, path: target }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save profiles.json.',
    }
  }
}

function normalizeInstallDir(value, fallback) {
  const raw = String(value || '').trim()
  if (!raw) return fallback
  const expanded = raw.replace(/%([^%]+)%/g, (_match, name) => process.env[name] || _match)
  return path.resolve(expanded)
}

const DEFAULT_ONLINE_SERVICE_URL = 'https://site-710f0be1e3b24f2694e9e13b9ce4c84b.freebuff.page/api'

/** Persisted cloud source URL plus the folder every download is unpacked into. */
function readAppSettings() {
  const fallback = {
    cloudSourceUrl: '',
    onlineServiceUrl: DEFAULT_ONLINE_SERVICE_URL,
    defaultInstallDir: defaultInstallDir(),
    hostPublicLobby: true,
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'))
    const cloudSourceUrl = typeof parsed?.cloudSourceUrl === 'string' ? parsed.cloudSourceUrl.trim() : ''
    const onlineServiceUrl =
      typeof parsed?.onlineServiceUrl === 'string'
        ? parsed.onlineServiceUrl.trim()
        : DEFAULT_ONLINE_SERVICE_URL
    return {
      cloudSourceUrl: /^https?:\/\//i.test(cloudSourceUrl) ? cloudSourceUrl : '',
      onlineServiceUrl: !onlineServiceUrl || /^(https?|wss?):\/\//i.test(onlineServiceUrl) ? onlineServiceUrl : '',
      defaultInstallDir: normalizeInstallDir(parsed?.defaultInstallDir, fallback.defaultInstallDir),
      hostPublicLobby: parsed?.hostPublicLobby !== false,
    }
  } catch {
    return fallback
  }
}

function writeAppSettings(next) {
  const current = readAppSettings()
  const cloudSourceUrl =
    typeof next?.cloudSourceUrl === 'string' ? next.cloudSourceUrl.trim() : current.cloudSourceUrl
  if (cloudSourceUrl && !/^https?:\/\//i.test(cloudSourceUrl)) {
    return { ok: false, error: 'Cloud source must be an http(s) URL.', settings: current }
  }
  const onlineServiceUrl =
    typeof next?.onlineServiceUrl === 'string'
      ? next.onlineServiceUrl.trim()
      : current.onlineServiceUrl
  if (onlineServiceUrl && !/^(https?|wss?):\/\//i.test(onlineServiceUrl)) {
    return { ok: false, error: 'Online server must be an http(s) or ws(s) URL.', settings: current }
  }
  const hostPublicLobby =
    typeof next?.hostPublicLobby === 'boolean' ? next.hostPublicLobby : current.hostPublicLobby
  const resetInstallDir =
    next && Object.prototype.hasOwnProperty.call(next, 'defaultInstallDir') && !String(next.defaultInstallDir || '').trim()
  const nextInstallDir = resetInstallDir
    ? defaultInstallDir()
    : normalizeInstallDir(next?.defaultInstallDir, current.defaultInstallDir)
  try {
    fs.mkdirSync(nextInstallDir, { recursive: true })
    fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true })
    const settings = { cloudSourceUrl, onlineServiceUrl, defaultInstallDir: nextInstallDir, hostPublicLobby }
    fs.writeFileSync(settingsFilePath(), JSON.stringify(settings, null, 2), 'utf8')
    return { ok: true, settings }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save settings.json.',
      settings: current,
    }
  }
}

function buildsRoot() {
  return readAppSettings().defaultInstallDir
}

const folderSizeCache = new Map()
const folderSizePending = new Map()

/** Total bytes in an installed build folder, cached because cards re-render often. */
async function folderSize(folder) {
  const resolved = path.resolve(folder)
  try {
    const root = await fs.promises.stat(resolved)
    if (!root.isDirectory()) return null
  } catch {
    return null
  }

  const cached = folderSizeCache.get(resolved)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.bytes
  if (folderSizePending.has(resolved)) return folderSizePending.get(resolved)

  const pending = (async () => {
    let bytes = 0
    let entries = 0
    const stack = [resolved]
    while (stack.length > 0 && entries < 500000) {
      const dir = stack.pop()
      let children
      try {
        children = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (entries >= 500000) break
        const full = path.join(dir, child.name)
        if (child.isDirectory()) {
          stack.push(full)
          continue
        }
        if (!child.isFile()) continue
        try {
          const stat = await fs.promises.stat(full)
          bytes += stat.size
          entries += 1
        } catch {
          /* skip files another process is still writing */
        }
      }
    }
    folderSizeCache.set(resolved, { bytes, at: Date.now() })
    return bytes
  })().finally(() => folderSizePending.delete(resolved))

  folderSizePending.set(resolved, pending)
  return pending
}

/* ------------------------------------------------------------ disk cleanup */

async function cleanupManagedBuild(key, targetDir, canonicalHint = '') {
  const cleanup = await cleanupBuildFolder({
    targetDir,
    buildsRoot: buildsRoot(),
    profile: readProfilesFile()?.builds?.[key] || null,
    canonicalHint,
  })
  if (cleanup) {
    folderSizeCache.delete(path.resolve(targetDir))
    folderSizeCache.delete(path.resolve(cleanup.folder))
  }
  return cleanup
}

async function cleanupManagedBuildStorage() {
  const root = path.resolve(buildsRoot())
  const result = { folders: [], freedBytes: 0, removed: [] }
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const key = entry.name
    if (running.has(key) || downloads.has(key)) continue
    try {
      const cleanup = await cleanupManagedBuild(key, path.join(root, key))
      if (!cleanup) continue
      result.folders.push(cleanup.folder)
      result.freedBytes += cleanup.freedBytes
      result.removed.push(...cleanup.removed)
    } catch (error) {
      console.warn(`[VAULTED] Could not clean ${key}: ${error instanceof Error ? error.message : error}`)
    }
  }
  return result
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

/** A folder named by season id, version, or CL number is a build candidate. */
function looksLikeSeasonBuildFolder(name) {
  const value = String(name || '').trim()
  return (
    /^(?:ch(?:apter)?[\s_-]*\d+[\s_-]*(?:s|season)[\s_-]*\d+|c\d{1,2}[\s_-]?s\d{1,2}|ch\d+-s\d+)$/i.test(value) ||
    /\b\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\b/.test(value) ||
    /CL[-_ ]?\d{4,}/i.test(value)
  )
}

/**
 * Looks through the usual places a downloaded build ends up and returns each
 * folder that contains FortniteClient-Win64-Shipping.exe. The renderer maps the
 * version in the folder name to a chapter/season, so no paths are typed by hand.
 */
function scanForBuilds(extraRoots = []) {
  const home = os.homedir()
  const requested = Array.isArray(extraRoots)
    ? extraRoots.map((root) => (typeof root === 'string' ? root.trim() : '')).filter(Boolean)
    : []
  const explicitRoots = Array.from(new Set(requested.map((root) => path.resolve(root))))
  const roots = [
    // Settings roots and exact manifest paths are scanned first so a large
    // Downloads or D:\ walk cannot exhaust the budget before them.
    ...explicitRoots,
    // VAULTED's own downloads are the most important and can be buried a few
    // folders deep, so do not let a large D:\ scan exhaust the budget first.
    buildsRoot(),
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

  const addFolder = (folder) => {
    try {
      if (!folder || !fs.statSync(folder).isDirectory()) return
      if (fs.readdirSync(folder).length === 0) return
    } catch {
      return
    }
    const key = path.resolve(folder).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push(path.resolve(folder))
  }

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
        // An external launcher can own the client exe; the FortniteGame data
        // folder is enough to identify this directory as a build root.
        if (entry.name.toLowerCase() === 'fortnitegame') addFolder(dir)
        walk(full, depth + 1)
      } else if (isClientExecutableName(entry.name)) {
        const root = folderForExecutable(full)
        addFolder(root)
      }
    }
  }

  const explicitSet = new Set(explicitRoots.map((root) => root.toLowerCase()))
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    walk(root, 0)

    // External launchers can own the client executable, so a build folder may
    // contain no FortniteGame tree or Shipping.exe. For the explicitly chosen
    // builds root, add version-named direct subfolders that produced no deeper
    // match. Downloaded roots with a real client are already covered above.
    if (!explicitSet.has(path.resolve(root).toLowerCase())) continue

    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }

    const rootKey = path.resolve(root).toLowerCase()
    const covered = (child) =>
      found.some((folder) => {
        const key = folder.toLowerCase()
        const prefix = `${child.toLowerCase()}${path.sep}`
        return key === child.toLowerCase() || key.startsWith(prefix)
      })

    let added = false
    for (const entry of entries) {
      if (!entry.isDirectory() || !looksLikeSeasonBuildFolder(entry.name)) continue
      const child = path.resolve(root, entry.name)
      if (covered(child)) continue
      addFolder(child)
      added = true
    }

    // The player may point the root directly at one season folder.
    if (!added && looksLikeSeasonBuildFolder(path.basename(rootKey))) {
      const hasCandidate = found.some((folder) => {
        const key = folder.toLowerCase()
        return key === rootKey || key.startsWith(`${rootKey}${path.sep}`)
      })
      if (!hasCandidate) addFolder(root)
    }
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
function bundledRuntimeRoot() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'runtime') : ''
  // Prefer an existing packaged runtime even when it is incomplete: returning
  // the repo fallback would hide the broken installed runtime from diagnostics.
  if (packaged && fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', 'runtime')
}

/** Every build launches against the runtime copy inside the app's data folder. */
function runtimeRoot() {
  return path.join(app.getPath('userData'), 'runtime')
}

let runtimeInstallPromise = null

/** Copy missing or changed runtime files beside the app data, once per launch. */
function ensureRuntimeInstalled() {
  if (runtimeInstallPromise) return runtimeInstallPromise
  runtimeInstallPromise = (async () => {
    const source = bundledRuntimeRoot()
    const target = runtimeRoot()
    if (path.resolve(source) === path.resolve(target)) return target
    if (!fs.existsSync(source)) {
      throw new Error('The bundled runtime folder is missing from this installation. Reinstall VAULTED.')
    }
    await fs.promises.mkdir(target, { recursive: true })
    const sync = async (from, to) => {
      const entries = await fs.promises.readdir(from, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const sourcePath = path.join(from, entry.name)
        const targetPath = path.join(to, entry.name)
        if (entry.isDirectory()) {
          await fs.promises.mkdir(targetPath, { recursive: true })
          await sync(sourcePath, targetPath)
          continue
        }
        if (!entry.isFile()) continue
        const [incoming, current] = await Promise.all([
          fs.promises.stat(sourcePath),
          fs.promises.stat(targetPath).catch(() => null),
        ])
        if (!current || current.size !== incoming.size || current.mtimeMs < incoming.mtimeMs) {
          await fs.promises.copyFile(sourcePath, targetPath)
        }
      }
    }
    await sync(source, target)
    return target
  })().catch((error) => {
    runtimeInstallPromise = null
    throw error
  })
  return runtimeInstallPromise
}

/**
 * Stage every DLL a launcher and its seasons need inside the launcher's own
 * download/verify step. A season is only called ready once this passes, and a
 * failure is reported there instead of surfacing as a broken first match.
 */
/**
 * Copy any DLL that only ships in the providers' shared runtime folder into
 * VAULTED's staged runtime. Cobalt (Chapter 1) is packaged there rather than in
 * the base runtime folder, so without this the launch-time check would report a
 * missing DLL long after the launcher said it was ready.
 */
async function stageCoreRuntimeDlls() {
  const target = runtimeRoot()
  const sources = [bundledRuntimeRoot()]
  try {
    sources.push(sharedRuntimeRoot())
  } catch {
    /* the base runtime folder is still a valid source */
  }
  await fs.promises.mkdir(target, { recursive: true })
  for (const name of STAGED_RUNTIME_DLLS) {
    const destination = path.join(target, name)
    try {
      const current = fs.statSync(destination)
      if (current.isFile() && current.size > 0) continue
    } catch {
      /* not staged yet */
    }
    for (const source of sources) {
      const candidate = path.join(source, name)
      try {
        const stat = fs.statSync(candidate)
        if (!stat.isFile() || stat.size === 0) continue
        await fs.promises.copyFile(candidate, destination)
        break
      } catch {
        /* try the next documented runtime folder */
      }
    }
  }
}

async function stageSeasonLauncherDlls(providerId = '') {
  await ensureRuntimeInstalled()
  await stageCoreRuntimeDlls()
  let extraDlls = []
  try {
    const config = runtimeConfig()
    if (Array.isArray(config?.dlls)) extraDlls = config.dlls.map((name) => String(name))
  } catch {
    /* older installs still get the core DLL list from stageProviderDlls */
  }
  const report = await stageProviderDlls({
    providerId,
    runtimeRoot: runtimeRoot(),
    extraDlls,
  })
  if (report.missing.length > 0) {
    throw new Error(report.missing.map((item) => item.error).join('\n'))
  }
  return report
}

/** Files without which every launch is guaranteed to fail. */
const REQUIRED_RUNTIME_FILES = [
  ['VaultedInjector.exe', 'login injector'],
  ['Tellurium.dll', 'redirect DLL'],
  ['VAULTED-Server.dll', 'local server DLL'],
  ['Memory.dll', 'memory library'],
  ['matchmaker.cjs', 'matchmaker'],
  ['join-watchdog.cjs', 'join watchdog'],
  ['portmap.cjs', 'port mapper'],
  ['playlist-paths.json', 'playlist map'],
  ['VAULTED-Backend.zip', 'private-server backend'],
  [path.join('neonite-patch', 'vaulted-inventory.cjs'), 'inventory patch'],
  [path.join('neonite-patch', 'profile.js'), 'profile patch'],
  [path.join('neonite-patch', 'api', 'controllers', 'AuthController.js'), 'auth controller'],
  [path.join('neonite-patch', 'api', 'controllers', 'MatchMakingController.js'), 'matchmaking controller'],
  [path.join('neonite-patch', 'api', 'controllers', 'VaultedFriendsController.js'), 'friends controller'],
  [path.join('neonite-patch', 'config', 'matchmakingRoutes.js'), 'matchmaking routes'],
  [path.join('neonite-patch', 'config', 'vaultedFriendsRoutes.js'), 'friends routes'],
]

function runtimeProblems() {
  const root = runtimeRoot()
  const problems = []
  for (const [name, label] of REQUIRED_RUNTIME_FILES) {
    const file = path.join(root, name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      problems.push(`Runtime file missing: ${name} (${label})`)
      continue
    }
    if (!stat.isFile()) {
      problems.push(`Runtime file missing: ${name} (${label})`)
      continue
    }
    if (stat.size === 0) {
      problems.push(`Runtime file is empty: ${name} (${label})`)
      continue
    }
    try {
      fs.accessSync(file, fs.constants.R_OK)
    } catch {
      problems.push(`Runtime file is unreadable: ${name} (${label})`)
    }
  }
  return problems
}

/** DLLs the launcher stages before a season is called ready. */
function stagedRuntimeProblems() {
  const problems = []
  const root = runtimeRoot()
  for (const name of STAGED_RUNTIME_DLLS) {
    // Tellurium and Memory are already covered by runtimeProblems; only report
    // the extra staged DLLs here so the list stays free of duplicates.
    if (name === 'Tellurium.dll' || name === 'Memory.dll') continue
    const file = path.join(root, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size === 0) {
        problems.push(`Runtime DLL is missing or empty: ${name}`)
      }
    } catch {
      problems.push(`Runtime DLL is missing or empty: ${name}`)
    }
  }
  return problems
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

function injectorLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'injector.log')
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

/** Apply the small VAULTED-only fixes to the bundled private-server copy. */
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
function writeBackendAuthCode(paths, username) {
  const safe = normalizeUsername(username)
  const code = `vlt_${crypto.randomBytes(24).toString('hex')}`
  const file = path.join(paths.cwd, 'vaulted-auth.json')
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ code, username: safe, expiresAt: Date.now() + 10 * 60 * 1000 }),
      { mode: 0o600 },
    )
  } catch (error) {
    throw new Error(`Could not prepare the local game login: ${error.message}`)
  }
  return code
}

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

function sessionStatusPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  return path.join(localAppData, 'VAULTED', 'session-status.json')
}

/**
 * The injected server writes its live population once per second. Treat an old
 * file as empty so a stopped host cannot keep advertising its last bot count.
 */
function readSessionStatus() {
  try {
    const value = JSON.parse(fs.readFileSync(sessionStatusPath(), 'utf8'))
    const updated = Number(value?.updated) * 1000
    if (!Number.isFinite(updated) || Date.now() - updated > 15_000) return null
    const players = Math.max(1, Math.min(100, Number(value.players) || 1))
    const bots = Math.max(0, Math.min(99, Number(value.bots) || 0))
    return {
      players,
      bots,
      humans: Math.max(0, Math.min(100, Number(value.humans) || Math.max(0, players - bots))),
      phase: Math.max(0, Number(value.phase) || 0),
      updated: new Date(updated).toISOString(),
    }
  } catch {
    return null
  }
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
  const candidates = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const address of list || []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const ip = address.address
      // Prefer the normal home-LAN ranges over a VPN/virtual adapter; friends
      // on the same WiFi cannot reach a 100.x tunnel address.
      const score = ip.startsWith('192.168.')
        ? 3
        : ip.startsWith('10.')
          ? 2
          : /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
            ? 1
            : 0
      candidates.push({ ip, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.ip || null
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
    // Every launch gets a fresh one-time code so the client can skip Epic's
    // manual login form even when the private server is already running.
    const gameCode = writeBackendAuthCode(backendPaths(), requestedUser)
    return { reused: true, pid: null, gameCode }
  }
  if (backendStartPromise) return backendStartPromise

  backendStartPromise = (async () => {
    const paths = await ensureBackendRuntime()
    patchBackendRuntime(paths)
    writeBackendUsername(paths, requestedUser)
    const gameCode = writeBackendAuthCode(paths, requestedUser)

    // The previous release has no ticket/session fix. Stop only our own
    // private-server listener so the patched files are loaded for this launch.
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
    return { reused: false, pid: child.pid, gameCode }
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
 * 6.21 reads [UAC-FE] from its saved config, not from command-line -ini:
 * overrides. With the launcher check left enabled it closes the client with
 * "Fortnite was not started correctly". These values are restored once the
 * client has finished authenticating so an official install sharing the same
 * config folder is not affected.
 */
function applyProviderEnvironmentBypass() {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  const configDirectory = path.join(localAppData, 'FortniteGame', 'Saved', 'Config', 'WindowsClient')
  const backups = []
  for (const name of ['Engine.ini', 'Game.ini']) {
    const file = path.join(configDirectory, name)
    let original = null
    try {
      original = fs.readFileSync(file)
    } catch {
      /* the client creates it on first run */
    }
    const text = original ? original.toString('utf8') : ''
    if (/\[UAC-FE\][\s\S]*?bAllowLauncherCheck\s*=\s*False/i.test(text)) continue
    const addition =
      `${text.length && !text.endsWith('\n') ? '\r\n' : ''}` +
      `\r\n[UAC-FE]\r\nbAllowLauncherCheck=False\r\nbAllowPakCheck=False\r\nbCloseOnPakCheck=False\r\n`
    try {
      fs.mkdirSync(configDirectory, { recursive: true })
      fs.appendFileSync(file, addition, 'utf8')
      backups.push({ file, original })
    } catch {
      /* a read-only install still gets the portal flags below */
    }
  }
  return () => {
    for (const backup of backups.reverse()) {
      try {
        if (backup.original === null) fs.rmSync(backup.file, { force: true })
        else fs.writeFileSync(backup.file, backup.original)
      } catch {
        /* the next launch can overwrite it */
      }
    }
  }
}

function restoreEnvironmentWhenClientExits(pid, restore) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearInterval(watcher)
    clearTimeout(fallback)
    restore()
  }
  const watcher = setInterval(() => {
    if (!processAlive(pid)) finish()
  }, 2000)
  const fallback = setTimeout(finish, 120_000)
  watcher.unref?.()
  fallback.unref?.()
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
      'FortniteClient-Win64-Shipping_BE.exe',
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

function normalizeProviderAuthCode(value) {
  if (typeof value !== 'string') return ''
  const code = value.trim()
  if (code.length < 8 || code.length > 4096) return ''
  // Exchange codes and one-time access tokens are URL-safe. Reject whitespace
  // or shell-looking text before it becomes a process argument.
  return /^[A-Za-z0-9._~+/=-]+$/.test(code) ? code : ''
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
    '-noeac',
    '-nobe',
    '-NOSSLPINNING',
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
 * Creates the client suspended, maps the redirect DLL before its entry point,
 * then resumes it. Tellurium waits inside the process for a valid unpacked
 * image and reports hook readiness through injector.log before a launch is
 * allowed to resolve.
 */
function launchInjectedGame(payload, options = {}) {
  return new Promise((resolve, reject) => {
    const injector = options.injector || path.join(runtimeRoot(), 'VaultedInjector.exe')
    const legacy = providerUsesLegacyRedirect(payload?.version, payload?.seasonId)
    const dll =
      options.dll ||
      (legacy ? legacyRedirectDllPath() : path.join(runtimeRoot(), 'Tellurium.dll'))
    if (!fs.existsSync(injector)) return reject(new Error('The injector is missing from this installation. Reinstall VAULTED.'))
    if (!fs.existsSync(dll)) return reject(new Error('The redirect DLL is missing from this installation. Reinstall VAULTED.'))

    const workingDirectory = path.dirname(payload.executable)
    removeAftermathDlls(payload.executable)

    const logPath = injectorLogPath()
    const hookToken = crypto.randomBytes(16).toString('hex')
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
    } catch {
      /* diagnostics must never prevent a launch */
    }

    const injectorArgs = [payload.executable, dll, workingDirectory]
    for (const bootstrapper of suspendedBootstrappers(payload.executable)) {
      injectorArgs.push('--aux', bootstrapper)
    }
    if (options.host) injectorArgs.push('--hide-window')
    const gameArgs = Array.isArray(options.args) ? options.args : fortniteLaunchArgs(payload, options)
    injectorArgs.push('--', ...gameArgs)

    const child = spawn(injector, injectorArgs, {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENSSL_ia32cap: '~0x20000000',
        VAULTED_HOOK_LOG: logPath,
        VAULTED_HOOK_TOKEN: hookToken,
        ...(options.env || {}),
      },
    })

    const appendLog = (stream, chunk) => {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${stream}] ${chunk.toString()}`)
      } catch {
        /* diagnostics must never prevent a launch */
      }
    }
    const safeArgs = injectorArgs.map((argument) =>
      /^(-AUTH_PASSWORD=|-actoken=|-caldera=)/i.test(argument)
        ? `${argument.slice(0, argument.indexOf('=') + 1)}<redacted>`
        : argument,
    )
    appendLog(
      'launcher',
      `\n=== ${new Date().toISOString()} ===\ninjector: ${injector}\ndll: ${dll}\nmode: pre-entry\nhook-token: ${hookToken.slice(0, 8)}\nargs: ${safeArgs.join(' ')}\n`,
    )

    let stdout = ''
    let stderr = ''
    let hookVerified = false
    let settled = false
    const finishError = (message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      appendLog('launcher', `error: ${message}\n`)
      reject(new Error(message))
    }
    const timer = setTimeout(() => {
      finishError('The redirect DLL timed out while attaching to Fortnite.')
      void killProcessTree(child.pid)
    }, 120_000)

    child.stdout?.on('data', (chunk) => {
      appendLog('stdout', chunk)
      stdout = (stdout + chunk.toString()).slice(-4000)
      if (/(?:^|\r?\n)HOOK_VERIFIED=/m.test(stdout)) hookVerified = true
      const match = /(?:^|\r?\n)PID=(\d+)/.exec(stdout)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        appendLog('launcher', `ready: pid=${match[1]} hook=${hookVerified ? 'verified' : 'unverified'}\n`)
        resolve({ child, pid: Number(match[1]), hookVerified })
      }
    })
    child.stderr?.on('data', (chunk) => {
      appendLog('stderr', chunk)
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on('error', (error) => finishError(`Could not run the game injector: ${error.message}`))
    child.on('exit', (code) => {
      appendLog('launcher', `injector exited: ${code === null ? 'unknown' : code}\n`)
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
  // Every launcher-hosted match is standard Athena Battle Royale. AutoHosting
  // restores these values from the profile, so force the full standard set
  // here (including old profiles saved while late-game was enabled).
  const lateGame =
    preferences.lategame && typeof preferences.lategame === 'object' && !Array.isArray(preferences.lategame)
      ? { ...preferences.lategame }
      : {}
  lateGame.enabled = false
  lateGame.moving_bus = false
  lateGame.long_zone = false
  lateGame.custom_safe_zone = false
  lateGame.custom_moving_zone = false
  lateGame.versionized_loadout = false
  lateGame.custom_loadout = false
  lateGame.starting_zone = 1
  preferences.lategame = lateGame

  const gameplay =
    preferences.gameplay && typeof preferences.gameplay === 'object' && !Array.isArray(preferences.gameplay)
      ? { ...preferences.gameplay }
      : {}
  gameplay.infinite_materials = false
  gameplay.infinite_ammo = false
  preferences.gameplay = gameplay

  const match =
    preferences.match && typeof preferences.match === 'object' && !Array.isArray(preferences.match)
      ? { ...preferences.match }
      : {}
  match.auto_bus_start = true
  match.bus_start_delay = 30
  match.bus_settings_user_override = false
  match.player_has_pickaxe = true
  preferences.match = match

  const respawns =
    preferences.respawns && typeof preferences.respawns === 'object' && !Array.isArray(preferences.respawns)
      ? { ...preferences.respawns }
      : {}
  respawns.enabled = false
  respawns.storm_respawns = false
  respawns.keep_inventory = false
  respawns.midzone_respawns = false
  respawns.join_in_progress = false
  preferences.respawns = respawns

  const loadout =
    preferences.loadout && typeof preferences.loadout === 'object' && !Array.isArray(preferences.loadout)
      ? { ...preferences.loadout }
      : {}
  for (const key of ['primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'traps']) {
    loadout[key] = ''
    loadout[`${key}_amount`] = 0
  }
  preferences.loadout = loadout

  // AI bot spawning is disabled. Rewrite the block on every launch so profiles
  // saved with auto-fill enabled by an older launcher are turned off too.
  const existingBots =
    preferences.bots && typeof preferences.bots === 'object' && !Array.isArray(preferences.bots)
      ? preferences.bots
      : {}
  const bots = botFillPreferences({ ...existingBots, health: 100, shield: 100 })
  if (Object.keys(bots).length > 0) preferences.bots = bots
  else delete preferences.bots

  autoHost.enabled = true
  autoHost.delay_seconds = 25
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

/** Read the tail of a log without loading a large Fortnite log in full. */
function readLogTail(file, maxBytes = 750_000) {
  try {
    const stat = fs.statSync(file)
    const length = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length))
    } finally {
      fs.closeSync(fd)
    }
    return buffer.toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Text from the live client log(s) for a launch. Old backup logs are skipped:
 * they often contain a completed login from a previous session and would make
 * the watchdog think this join succeeded before it even started.
 */
function recentFortniteLogText(startedAt, expectedExecutable) {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  const logDirectory = path.join(localAppData, 'FortniteGame', 'Saved', 'Logs')
  let files
  try {
    files = fs
      .readdirSync(logDirectory)
      .filter((name) => /^FortniteGame(?:_\d+)?\.log$/i.test(name))
      .map((name) => {
        const file = path.join(logDirectory, name)
        return { file, stat: fs.statSync(file) }
      })
      .filter(({ stat }) => stat.isFile() && stat.mtimeMs >= startedAt - 15_000)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  } catch {
    return ''
  }

  let text = ''
  for (const { file } of files) {
    if (!logBelongsToBuild(file, expectedExecutable)) continue
    text += readLogTail(file)
  }
  return text
}

/**
 * Turn the client log into a short, human-readable reason for an unexpected
 * close. Prefer the last error/fatal/exception lines, but fall back to the last
 * lines of the log when the client died without reporting an error.
 */
function summarizeClientExit(startedAt, expectedExecutable) {
  const text = recentFortniteLogText(startedAt, expectedExecutable)
  if (!text.trim()) return ''
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const failures = lines.filter((line) =>
    /\b(error|fatal|exception|crash|failed|failure|assert(?:ion)?|abort)\b/i.test(line),
  )
  const picked = (failures.length > 0 ? failures : lines).slice(-6)
  return picked
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').slice(0, 320))
    .join('\n')
    .slice(0, 1800)
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
    const runtimeProfile =
      payload?.runtimeProfile === 'legacy' || payload?.runtimeProfile === 'modern'
        ? payload.runtimeProfile
        : Number.isFinite(versionMajor) && versionMajor > 0 && versionMajor <= 10
          ? 'legacy'
          : 'modern'
    if (runtimeProfile === 'legacy' && fs.existsSync(memoryDll)) {
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

/**
 * Watch an automatic public-lobby join after the client has started. The join
 * launch resolves before Fortnite has necessarily connected, so this is the
 * only place that can distinguish a real join from a host disappearing during
 * loading. Explicit friend joins never install this watchdog.
 */
function startJoinWatchdog({ id, pid, join, startedAt, expectedExecutable }) {
  if (!id || !join?.host) return
  stopJoinWatchdog(id)

  let watchdogModule
  try {
    watchdogModule = require(path.join(runtimeRoot(), 'join-watchdog.cjs'))
  } catch (error) {
    console.warn(`[VAULTED] Join watchdog unavailable: ${error instanceof Error ? error.message : error}`)
    return
  }

  const watchdog = watchdogModule.createJoinWatchdog({
    host: join.host,
    startedAt,
    timeoutMs: 75_000,
    readLog: () => recentFortniteLogText(startedAt, expectedExecutable),
    isAlive: () => processAlive(pid) && running.get(id)?.pid === pid,
    onFailed: (reason) => {
      if (running.get(id)?.pid !== pid) return
      console.warn(`[VAULTED] Join to ${join.host}:${join.port} failed: ${reason}`)
      send('arc:join-failed', {
        id,
        host: join.host,
        port: join.port,
        reason,
      })
    },
  })
  joinWatchdogs.set(id, watchdog)
  watchdog.start()
}

function stopJoinWatchdog(id) {
  if (!id) return
  const watchdog = joinWatchdogs.get(id)
  if (!watchdog) return
  watchdog.stop()
  joinWatchdogs.delete(id)
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
 * Ask the client to close through its window first. The redirect DLL restores
 * its hooks before forwarding WM_CLOSE so Unreal can flush settings and exit
 * normally; force-kill only if the client ignores the close request.
 */
function closeProcessTreeGracefully(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve()
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
      return resolve()
    }

    execFile('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true }, () => {
      const deadline = Date.now() + 12000
      const poll = () => {
        if (!processAlive(pid)) return resolve()
        if (Date.now() >= deadline) {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
          return
        }
        setTimeout(poll, 100)
      }
      poll()
    })
  })
}

/**
 * Close a Fortnite client left behind by an earlier VAULTED run. Such a client
 * holds the single-instance mutex, so the hidden host exits before the server
 * can open its port and the player sits in an empty matchmaking queue forever.
 * Only VAULTED launches contain -AUTH_LOGIN; an official Epic client is left
 * alone.
 */
/**
 * One poll of the game process. `ok: false` means the probe itself failed
 * (tasklist timed out or was refused under load); an unknown answer is never
 * treated as "the game exited", because that would close the companion
 * launcher mid-session.
 */
function fortniteClientProbe() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: true, running: false })
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq FortniteClient-Win64-Shipping.exe', '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 8_000 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') return resolve({ ok: false, running: false })
        resolve({ ok: true, running: /FortniteClient-Win64-Shipping\.exe/i.test(stdout) })
      },
    )
  })
}

/**
 * Register a spawned companion launcher for status reporting only. A
 * single-instance launcher may forward to an already-running copy and exit at
 * once, so the session monitor below never depends on the child's lifetime.
 */
function registerProviderLauncher(providerId, child) {
  if (!child?.pid) return
  providerLaunchers.set(providerId, { pid: child.pid, startedAt: Date.now() })
}

/**
 * Keep a season's companion launcher alive for the whole game session.
 *
 * The monitor watches FortniteClient-Win64-Shipping.exe, and the exact client
 * PID this launch reported — never the spawned launcher process, whose
 * bootstrapper PID exits as soon as it forwards to an existing instance or
 * spawns the real launcher. The shared rule (electron/companionLifecycle.cjs)
 * decides the close:
 *   - no client seen yet, or a client running: keep the launcher, always;
 *   - the client stayed gone for the grace window after having run: close that
 *     provider's launcher tree (by executable path and process name);
 *   - Stop: closeCompanionLauncherForProvider() closes it directly.
 * No exit listener, idle timer or startup health check may close it earlier.
 */
const COMPANION_GAME_TIMEOUT_MS = 150_000
/** One pending game-start watch per provider; Stop/relaunch replaces it. */
const companionGameWaits = new Map()

/**
 * Wait for the companion launcher's real game process after its window opens.
 *
 * The launcher may already be starting the game, so a running client is never
 * clicked again. Otherwise VAULTED presses the launcher's own Play button and
 * then waits for FortniteClient-Win64-Shipping.exe. `running` is announced only
 * after that process exists; a timeout is reported instead of a fake success.
 */
function beginCompanionGameWatch({ providerId, launcherPid, launcherNames = [], gameExecutable }) {
  const id = String(providerId || '').trim().toLowerCase()
  if (!id || !launcherPid) return null
  const token = Symbol(id)
  companionGameWaits.set(id, token)
  void (async () => {
    try {
      await delay(1_200)
      let launcher = launcherPid
      let running = await processPidsByImage([CLIENT_EXE])
      if (running.length === 0) {
        // Re-check after the launcher's own auto-start window so VAULTED never
        // clicks Stop on a game the launcher just opened by itself.
        await delay(800)
        running = await processPidsByImage([CLIENT_EXE])
        if (running.length === 0) {
          await hideCompanionLauncher(launcher)
          const play = await clickCompanionPlayButton(launcher)
          if (!play.clicked) {
            // A bootstrapper can hand off to a second launcher process.
            const current = await processPidsByImage(launcherNames)
            if (current.length > 0) {
              launcher = current[0]
              startCompanionWindowHider(id, launcher)
              await clickCompanionPlayButton(launcher)
            }
          }
          // Reboot then asks whether to start its local game server. Ignore
          // starts the client immediately; Start server would open a large
          // server download. The prompt shares the hidden Flutter view, so the
          // same message click dismisses it without showing anything.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await delay(attempt === 0 ? 5_000 : 4_000)
            if ((await processPidsByImage([CLIENT_EXE])).length > 0) break
            await hideCompanionLauncher(launcher)
            await dismissCompanionServerPrompt(launcher)
          }
        }
      }
      const deadline = Date.now() + COMPANION_GAME_TIMEOUT_MS
      let gamePid = null
      while (Date.now() < deadline) {
        if (companionGameWaits.get(id) !== token) return
        const pids = await processPidsByImage([CLIENT_EXE])
        if (pids.length > 0) {
          const owned = gameExecutable ? await executablePids(gameExecutable) : []
          gamePid = owned[0] || pids[0]
          break
        }
        await delay(1_500)
      }
      if (companionGameWaits.get(id) !== token) return
      companionGameWaits.delete(id)
      if (gamePid) {
        attachCompanionGameProcess(id, gamePid)
        send('arc:companion-game-started', { providerId: id, pid: gamePid })
        return
      }
      send('arc:companion-game-timeout', {
        providerId: id,
        message:
          'The launcher opened but Fortnite did not start. If Windows asked to allow the launcher through the firewall, choose Allow, then press Start again.',
      })
    } catch (error) {
      if (companionGameWaits.get(id) === token) {
        companionGameWaits.delete(id)
        send('arc:companion-game-timeout', {
          providerId: id,
          message: error instanceof Error ? error.message : 'Fortnite did not start.',
        })
      }
    }
  })()
  return { waiting: true }
}

function startCompanionSessionMonitor(providerId, executable) {
  const id = String(providerId || '').trim().toLowerCase()
  if (!id) return null
  const existing = companionMonitors.get(id)
  if (existing) return existing
  const state = {
    providerId: id,
    executable: executable || '',
    gamePid: null,
    checking: false,
    session: createCompanionSessionState(),
    timer: null,
  }
  companionMonitors.set(id, state)
  state.timer = setInterval(async () => {
    if (state.checking || companionMonitors.get(id) !== state) return
    state.checking = true
    try {
      const probe = await fortniteClientProbe()
      const trackedAlive = state.gamePid ? processAlive(state.gamePid) : false
      const decision = observeCompanionSession(state.session, {
        running: trackedAlive || probe.running === true,
        probeOk: probe.ok === true || trackedAlive,
        now: Date.now(),
      })
      state.session = decision.state
      if (!decision.close) return
      // Only the game exiting (after the grace window) reaches this point.
      clearInterval(state.timer)
      companionMonitors.delete(id)
      await closeCompanionLauncherForProvider(id)
      send('arc:provider-launcher-exited', { providerId: id, pid: null, reason: decision.reason })
    } finally {
      state.checking = false
    }
  }, GAME_POLL_MS)
  state.timer.unref?.()
  return state
}

/** Resolve every process started from one exact executable path. */
function executablePids(executable) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !executable) return resolve([])
    const literal = String(executable).replace(/'/g, "''")
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${literal}' } | ForEach-Object { $_.ProcessId }`,
      ],
      { windowsHide: true, timeout: 8_000 },
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
}

/** The installed launcher metadata for a provider, shared by start/close. */
function companionLauncherMetadata(providerId) {
  const id = String(providerId || '').trim().toLowerCase()
  if (!id) return null
  return (
    providerRuntimeMetadata(id) ??
    providerCatalog().find((entry) => entry.id === id)?.launcher ??
    null
  )
}

/**
 * Start the season's merged companion launcher in the background and keep it
 * alive for 100% of the game session. Its auth, session heartbeat and
 * matchmaking bridge are what let the client enter matches, so nothing here
 * arms a timeout that could close it after the game starts.
 */
async function startCompanionLauncher(providerId) {
  const id = String(providerId || '').trim().toLowerCase()
  if (!id) return null
  const metadata = companionLauncherMetadata(id)
  const executable = metadata ? installedExecutable(metadata) : ''
  const existing = providerLaunchers.get(id)
  if (existing) {
    startCompanionSessionMonitor(id, executable)
    return { pid: existing.pid, executable, alreadyRunning: true }
  }
  if (!metadata) return null
  if (!executable) {
    console.warn(
      `[VAULTED] ${metadata.label || id} is not installed on this PC; the game starts without its companion launcher.`,
    )
    return null
  }
  startHiddenWindowWatcher(providerWindowNames(metadata), { seconds: 21_600, exitWhenGone: true })
  const child = spawn(executable, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(executable),
  })
  child.unref()
  registerProviderLauncher(id, child)
  startCompanionSessionMonitor(id, executable)
  return { pid: child.pid ?? null, executable }
}

/**
 * Bind the exact game PID the injector reported to this season's monitor.
 *
 * It is a local, cheap liveness signal next to the process-name poll, so the
 * launcher survives the whole boot sequence (window creation, sign-in, shader
 * warm-up) even when a tasklist poll is slow or misses the process. It never
 * claims the game "started": only an observed process does that.
 */
function attachCompanionGameProcess(providerId, pid) {
  const monitor = companionMonitors.get(String(providerId || '').trim().toLowerCase())
  if (!monitor) return false
  const gamePid = Number(pid)
  if (Number.isInteger(gamePid) && gamePid > 0) monitor.gamePid = gamePid
  return true
}

/**
 * Stop's exact half: close the season's launcher process tree now. This is the
 * only non-game-exit close path; it never runs on a timer.
 */
async function closeCompanionLauncherForProvider(providerId) {
  const id = String(providerId || '').trim().toLowerCase()
  if (!id) return false
  companionGameWaits.delete(id)
  stopCompanionWindowHider(id)
  let closed = false
  const monitor = companionMonitors.get(id)
  if (monitor) {
    if (monitor.timer) clearInterval(monitor.timer)
    companionMonitors.delete(id)
    closed = true
  }
  const entry = providerLaunchers.get(id)
  const targets = new Set()
  if (entry) {
    providerLaunchers.delete(id)
    targets.add(entry.pid)
    closed = true
  }
  const metadata = companionLauncherMetadata(id)
  const executable = metadata ? installedExecutable(metadata) : ''
  // A launcher's bootstrapper PID exits as soon as it hands off, so the close
  // follows the launcher's documented process names too — never the game or
  // its anti-cheat bootstrappers.
  const names = providerWindowNames(metadata).filter((name) => !/fortnite/i.test(name))
  for (const pid of await executablePids(executable)) {
    targets.add(pid)
    closed = true
  }
  for (const pid of await processPidsByImage(names)) {
    targets.add(pid)
    closed = true
  }
  // A launcher has no unsaved game state, so it is force-closed: a graceful
  // WM_CLOSE it ignores would delay the close by 12s per process, and the
  // lifecycle must be immediate on game exit and on Stop.
  const killable = (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid
  for (const pid of targets) {
    if (killable(pid)) await killProcessTree(pid)
  }
  // A single-instance launcher can leave a second process behind; re-resolve
  // both selectors once so the whole tree is really gone.
  for (const pid of await executablePids(executable)) {
    if (killable(pid)) await killProcessTree(pid)
  }
  for (const pid of await processPidsByImage(names)) {
    if (killable(pid)) await killProcessTree(pid)
  }
  return closed
}

function providerWindowNames(metadata) {
  const names = [metadata?.processName, ...(metadata?.executableNames || [])].filter(
    (name) => typeof name === 'string' && name.trim(),
  )
  return [...new Set(names.map((name) => name.trim()))]
}

/** Public companion-launcher detection; never returns the filesystem path. */
function providerLauncherStatus(providerId) {
  const id = String(providerId || '').trim().toLowerCase()
  if (!id) return null
  const provider = providerCatalog().find((entry) => entry.id === id)
  const metadata = provider?.launcher
  if (!metadata) return null
  return {
    providerId: id,
    label: metadata.label,
    installed: Boolean(installedExecutable(metadata)),
  }
}

/** Public runtime state for the season card; no URLs or filesystem internals. */
function providerRuntimeStatus(providerId) {
  const id = String(providerId || '').trim().toLowerCase()
  const metadata = providerRuntimeMetadata(id)
  if (!metadata) return null
  return {
    providerId: id,
    required: true,
    label: metadata.label,
    installed: Boolean(installedExecutable(metadata)),
  }
}

/** PIDs of every process with one of these image names. */
function processPidsByImage(names) {
  const clean = [
    ...new Set((names || []).map((name) => String(name || '').replace(/\.exe$/i, '').trim())),
  ].filter((name) => /^[A-Za-z0-9 ._-]{1,80}$/.test(name))
  if (clean.length === 0 || process.platform !== 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Name ${clean.map((name) => `'${name}'`).join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`,
      ],
      { windowsHide: true, timeout: 8_000 },
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
}

/** True while any Fortnite client process is open. */
function anyFortniteClientRunning() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq FortniteClient-Win64-Shipping.exe', '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 8_000 },
      (error, stdout) => {
        if (error || !stdout) return resolve(false)
        resolve(/FortniteClient-Win64-Shipping\.exe/i.test(String(stdout)))
      },
    )
  })
}

/**
 * Remove helpers a crashed or closed session left behind before a new launch.
 *
 * A leftover injector keeps a dead session's ports and pipes claimed, which is
 * how a fresh launch starts fine and then loses its login mid-session. Nothing
 * is touched while a Fortnite client is still open.
 */
async function cleanupStaleSessionHelpers(providerId = '') {
  const cleaned = []
  clearJoinTarget()
  if (!(await anyFortniteClientRunning())) {
    for (const pid of await processPidsByImage(['VaultedInjector.exe'])) {
      await killProcessTree(pid)
      cleaned.push(`injector ${pid}`)
    }
  }
  // A heartbeat for an earlier launch must not keep polling a dead process.
  if (stopProviderSessionHeartbeat(providerId, 'pre-launch cleanup')) {
    cleaned.push(`${providerId} heartbeat`)
  }
  if (cleaned.length > 0) {
    console.log(`[VAULTED] Pre-launch session cleanup: ${cleaned.join(', ')}.`)
  }
  return cleaned
}

/**
 * Keep a launched provider session alive for as long as its client runs.
 *
 * The launcher rotates the stored token every few minutes so locker saves and
 * matchmaking tickets never hit an expired session mid-game, and logs the exact
 * failure when a backend drops instead of letting Play fail silently later.
 */
function startProviderSessionHeartbeat(providerId, pid, label = '') {
  const id = String(providerId || '').trim().toLowerCase()
  const gamePid = Number(pid)
  if (!id || !Number.isInteger(gamePid) || gamePid <= 0) return null
  stopProviderSessionHeartbeat(id, 'replaced by a new launch')
  const name = label || id
  const state = { providerId: id, pid: gamePid, timer: null, refreshes: 0, failures: 0 }
  const tick = async () => {
    if (!processAlive(state.pid)) {
      stopProviderSessionHeartbeat(id, `game process ${state.pid} exited`)
      return
    }
    try {
      const status = await providerAuth.refreshSession(id)
      if (status?.refreshed) {
        state.refreshes += 1
        state.failures = 0
        console.log(
          `[VAULTED] ${name} session token refreshed during the game session (${state.refreshes}).`,
        )
      }
    } catch (error) {
      state.failures += 1
      const message = error instanceof Error ? error.message : String(error)
      const expiry = sessionExpiryCode(error)
      console.warn(
        `[VAULTED] ${name} session heartbeat failed (${state.failures})${
          expiry ? ` [${expiry}]` : ''
        }: ${message}`,
      )
      // Two consecutive expired answers mean the account really needs a fresh
      // sign-in; tell the player now instead of at the next match.
      if (expiry && state.failures >= 2) {
        send('arc:provider-session-expired', { providerId: id, label: name, message })
        stopProviderSessionHeartbeat(id, 'session expired')
      }
    }
  }
  state.timer = setInterval(() => void tick(), SESSION_HEARTBEAT_MS)
  state.timer.unref?.()
  sessionHeartbeats.set(id, state)
  void tick()
  return state
}

function stopProviderSessionHeartbeat(providerId, reason = '') {
  const id = String(providerId || '').trim().toLowerCase()
  const state = id ? sessionHeartbeats.get(id) : null
  if (!state) return false
  if (state.timer) clearInterval(state.timer)
  sessionHeartbeats.delete(id)
  if (reason) console.log(`[VAULTED] ${id} session heartbeat stopped (${reason}).`)
  return true
}

/** A provider error that means "rotate the token and try again". */
function sessionExpiryCode(error) {
  if (!error) return ''
  if (error.sessionExpired === true) return 'session_expired'
  if (error.code === 'provider_session_expired') return 'provider_session_expired'
  if (error.status === 401) return 'http_401'
  return ''
}

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

/**
 * Read the complete archive once before replacing an installed build. A
 * truncated or corrupt RAR/ZIP is rejected here instead of being unpacked and
 * sent through another exchange attempt.
 */
function testArchive(archivePath, controller) {
  let binary
  try {
    binary = sevenZipBinary()
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    let stderr = ''
    let finished = false
    const child = spawn(binary, ['t', '-bso0', '-bse1', archivePath], {
      windowsHide: true,
    })

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
      controller.signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }

    controller.signal.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000)
    })
    child.on('error', (error) => {
      finish(new Error(`Could not test the archive: ${error.message}`))
    })
    child.on('close', (code) => {
      if (controller.signal.aborted) finish(abortError())
      else if (code === 0 || code === 1) finish()
      else {
        const detail = stderr.trim()
        finish(
          new Error(
            `The downloaded archive is corrupt and was rejected before extraction (7-Zip exited ${code}).${
              detail ? `\n${detail}` : ''
            }`,
          ),
        )
      }
    })

    if (controller.signal.aborted) onAbort()
  })
}

// Archive.org is the main source and caps useful concurrency around a dozen
// sockets. A small chunk queue keeps every socket busy and prevents one slow
// tail request from holding up the last gigabytes of a build.
const MAX_DOWNLOAD_CONNECTIONS = 16
const MIN_PARALLEL_BYTES = 2 * 1024 * 1024
const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const DOWNLOAD_LARGE_CHUNK_BYTES = 16 * 1024 * 1024
const DOWNLOAD_MAX_RANGES = 2048
const DOWNLOAD_STALL_MS = 30_000
const DOWNLOAD_ATTEMPTS = 3
const PROGRESS_INTERVAL_MS = 250
const DOWNLOAD_HEADERS = {
  'User-Agent': 'VAULTED-Launcher/1.1',
  // byte ranges must refer to the archive itself, not a compressed response
  'Accept-Encoding': 'identity',
}
const DOWNLOAD_META_SUFFIX = '.part.json'

const { RangeUnsupportedError } = rangeDownload

function downloadMetaPath(partPath) {
  return `${partPath}${DOWNLOAD_META_SUFFIX.slice('.part'.length)}`
}

function writeDownloadMeta(partPath, value) {
  try {
    const file = downloadMetaPath(partPath)
    const temporary = `${file}.tmp`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...value, updatedAt: new Date().toISOString() }))
    fs.renameSync(temporary, file)
  } catch (error) {
    console.warn(`[VAULTED] Could not save download progress: ${error instanceof Error ? error.message : error}`)
  }
}

function removeDownloadMeta(partPath) {
  try {
    fs.rmSync(downloadMetaPath(partPath), { force: true })
  } catch {
    /* nothing to remove */
  }
}

function downloadMetaRecords() {
  const root = path.resolve(buildsRoot())
  const records = []
  let folders
  try {
    folders = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return records
  }

  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    let files
    try {
      files = fs.readdirSync(path.join(root, folder.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(DOWNLOAD_META_SUFFIX)) continue
      const file = path.join(root, folder.name, entry.name)
      let meta
      try {
        meta = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      if (!meta || typeof meta !== 'object') continue
      const partPath = path.resolve(String(meta.partPath || ''))
      const relative = path.relative(root, partPath)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
      if (!partPath.toLowerCase().endsWith('.part') || !fs.existsSync(partPath)) continue
      records.push({ meta, partPath, file })
    }
  }

  // If a previous launch failed to recognise an interruption and started a
  // second part for the same season, keep the most-progressed one. That is the
  // one worth resuming and the one the user should see.
  return records.sort((a, b) => (Number(b.meta.received) || 0) - (Number(a.meta.received) || 0))
}

function findResumableDownload({ id, key, url, sha256 }) {
  for (const { meta, partPath } of downloadMetaRecords()) {
    // The library can regenerate a build's random id (for example after the
    // catalogue is rebuilt), but a season's folder key is stable. Match on the
    // key so an interruption still resumes after that id changes.
    if (meta.key !== key) continue
    if (String(meta.url || '') !== String(url)) continue
    if (normalizeSha256(meta.sha256) !== sha256) continue
    if (meta.received == null || meta.total == null) continue
    return { ...meta, partPath }
  }
  return null
}

/** Used by the renderer after a restart/crash to offer Continue download. */
function listInterruptedDownloads() {
  const root = path.resolve(buildsRoot())
  const items = []
  const seen = new Set()
  for (const { meta, partPath } of downloadMetaRecords()) {
    if (!meta.id || typeof meta.id !== 'string') continue
    // Multiple stale partials can exist for one season after a source changed;
    // records are most-progressed-first, so only surface the best one.
    const identity = String(meta.key || meta.id)
    if (seen.has(identity)) continue
    const received = Number(meta.received) || 0
    const total = Number(meta.total) || 0
    if (received <= 0) continue
    if (total > 0 && received >= total) continue
    const folder = path.dirname(partPath)
    if (findExecutable(folder)) continue
    seen.add(identity)
    items.push({
      id: meta.id,
      key: String(meta.key || ''),
      url: String(meta.url || ''),
      sha256: meta.sha256 || null,
      received,
      total,
      percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null,
    })
  }
  return items
}

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
  return Math.min(MAX_DOWNLOAD_CONNECTIONS, rangeDownload.connectionCount(total))
}

/** Split a file into small resume-friendly chunks, not one range per socket. */
function planDownloadRanges(total) {
  // Multi-gigabyte builds use larger chunks so request setup cannot become a
  // meaningful share of the download; smaller builds keep more workers busy.
  return rangeDownload.planRanges(total, {
    maxRanges: DOWNLOAD_MAX_RANGES,
    chunkBytes: DOWNLOAD_CHUNK_BYTES,
    largeChunkBytes: DOWNLOAD_LARGE_CHUNK_BYTES,
  })
}

function downloadCoverage(ranges, received) {
  const intervals = []
  if (Array.isArray(ranges) && ranges.length > 0) {
    for (const range of ranges) {
      const start = Math.max(0, Number(range?.start) || 0)
      const end = Math.max(start, Number(range?.end) || 0)
      const done = Math.min(end - start + 1, Math.max(0, Number(range?.received) || 0))
      if (done > 0) intervals.push([start, start + done])
    }
  } else if (received > 0) {
    intervals.push([0, received])
  }

  intervals.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const interval of intervals) {
    const last = merged[merged.length - 1]
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
    else merged.push([interval[0], interval[1]])
  }
  return merged
}

/** Carry bytes already on disk into a new chunk plan after the plan changes. */
function withDownloadCoverage(planned, coverage) {
  return planned.map(({ start, end }) => {
    let cursor = start
    for (const [from, to] of coverage) {
      if (to <= cursor) continue
      if (from > cursor) break
      cursor = Math.min(end + 1, Math.max(cursor, to))
      if (cursor >= end + 1) break
    }
    return { start, end, received: cursor - start }
  })
}

/** Ask for one byte so the host tells us both the archive size and range support. */
async function probeRangeSupport(parsed, signal) {
  return rangeDownload.probeRange(parsed, { headers: DOWNLOAD_HEADERS, signal })
}

async function downloadSingleStream(
  parsed,
  partPath,
  signal,
  onTotal,
  onChunk,
  resumeOffset = 0,
  onRestart = null,
) {
  return rangeDownload.downloadSingleStream({
    url: parsed,
    partPath,
    signal,
    onTotal,
    onChunk,
    resumeOffset,
    onRestart,
    headers: DOWNLOAD_HEADERS,
  })
}

async function downloadParallel(parsed, partPath, total, ranges, signal, onChunk) {
  return rangeDownload.downloadRanges({
    url: parsed,
    partPath,
    total,
    ranges,
    signal,
    onChunk,
    connections: downloadConnectionCount(total),
    attempts: DOWNLOAD_ATTEMPTS,
    stallMs: DOWNLOAD_STALL_MS,
    headers: DOWNLOAD_HEADERS,
  })
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
/** HEAD probe used only when a bucket provides a version.zip fallback. */
async function archiveReachable(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' },
    })
    return response.ok || response.status === 405 || response.status === 501
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function downloadBuild(payload) {
  let { id, key, url } = payload ?? {}
  if (typeof id !== 'string' || !id) throw new Error('Invalid download request.')
  const expectedSha256 = normalizeSha256(payload?.sha256)
  // Provider repair deliberately re-downloads over an existing season folder.
  // Normal downloads keep the no-overwrite guard so a second click can never
  // silently replace a build the user already has.
  const repair = payload?.repair === true
  const requestedFolder =
    typeof payload?.preferredFolder === 'string' ? payload.preferredFolder.trim() : ''
  const preferredFolder = /^[a-z0-9][a-z0-9._ -]{0,79}$/i.test(requestedFolder)
    ? requestedFolder
    : ''

  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error('That download link is not a valid URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) download links are supported.')
  }

  // Direct-bucket mode uses {base}/{season.id}.zip and falls back to the
  // version.zip name when the bucket stores builds that way.
  const fallbackUrl = String(payload?.fallbackUrl || '').trim()
  if (fallbackUrl && fallbackUrl !== String(parsed)) {
    try {
      const fallbackParsed = new URL(fallbackUrl)
      if (
        (fallbackParsed.protocol === 'http:' || fallbackParsed.protocol === 'https:') &&
        !(await archiveReachable(String(parsed))) &&
        (await archiveReachable(fallbackUrl))
      ) {
        parsed = fallbackParsed
        url = fallbackUrl
      }
    } catch {
      /* an invalid fallback never blocks the primary source */
    }
  }

  const safeKey = String(key ?? id).replace(/[^a-z0-9_-]/gi, '') || 'build'
  const providerId =
    typeof payload?.providerId === 'string'
      ? payload.providerId.trim().toLowerCase().split(':')[0]
      : ''
  const seasonId =
    (typeof payload?.seasonId === 'string' ? payload.seasonId.trim() : '') || safeKey
  const buildId =
    typeof payload?.buildId === 'string' ? payload.buildId.trim().slice(0, 64) : ''
  const validateProvider = payload?.validateProvider === true
  if (validateProvider && (!providerId || !buildId)) {
    throw new Error('The provider build ID is required to validate this archive.')
  }
  if (downloads.has(id)) throw new Error('This build is already downloading.')

  const targetDir = path.join(buildsRoot(), safeKey)
  const preferredRoot = preferredFolder ? path.join(targetDir, preferredFolder) : ''
  if (
    preferredRoot &&
    path.dirname(preferredRoot) !== targetDir
  ) {
    throw new Error('The preferred build folder is outside this season.')
  }
  const existingExecutable = findExecutable(targetDir)
  if (existingExecutable && !repair) {
    throw new Error(
      `A build is already installed for this season at:\n${folderForExecutable(existingExecutable)}\n\nVAULTED will not overwrite or delete it. Delete that build first if you really want to download another copy.`,
    )
  }
  await fs.promises.mkdir(targetDir, { recursive: true })

  const resume = findResumableDownload({ id, key: safeKey, url: String(parsed), sha256: expectedSha256 })
  const requestedName = resume?.requestedName ? path.basename(String(resume.requestedName)) : archiveName(parsed)
  // Reuse the interrupted .part when its metadata matches this exact source.
  // Otherwise never overwrite an older partial download.
  let partPath = resume?.partPath ?? uniqueFilePath(targetDir, `${requestedName}.part`)
  let filePath = ''
  let ranges = Array.isArray(resume?.ranges)
    ? resume.ranges
        .map((range) => ({
          start: Number(range?.start) || 0,
          end: Number(range?.end) || 0,
          received: Number(range?.received) || 0,
        }))
        .filter((range) => range.end >= range.start)
    : null
  let received = Number(resume?.received) || 0
  let total = Number(resume?.total) || 0

  const controller = new AbortController()
  downloads.set(id, controller)
  let lastLogged = -20
  let lastSent = 0
  let startedAt = Date.now()
  let sessionReceived = 0
  let previousRootBackup = ''
  let persistTimer = null
  let lastPersist = 0
  let probe = { supported: false, total: 0, finalUrl: String(parsed), contentType: '', contentDisposition: '' }

  const restorePreferredRoot = async () => {
    if (!previousRootBackup || !preferredRoot) return
    try {
      await fs.promises.rm(preferredRoot, { recursive: true, force: true })
      await fs.promises.rename(previousRootBackup, preferredRoot)
      previousRootBackup = ''
    } catch (error) {
      console.warn(
        `[VAULTED] Could not restore the previous build after a rejected archive: ${
          error instanceof Error ? error.message : error
        }`,
      )
    }
  }

  const persistNow = () => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (!partPath) return
    writeDownloadMeta(partPath, {
      id,
      key: safeKey,
      url: String(parsed),
      sha256: expectedSha256,
      requestedName,
      partPath,
      total,
      received,
      ranges: ranges || null,
      phase: 'downloading',
    })
    lastPersist = Date.now()
  }

  const schedulePersist = () => {
    if (persistTimer) return
    const wait = Math.max(0, 250 - (Date.now() - lastPersist))
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, wait)
    persistTimer.unref?.()
  }

  // A short rolling window reports the current link speed instead of the
  // average since the download started, so a connection that ramps up or
  // stalls shows the truth immediately.
  const speedSamples = [{ at: Date.now(), bytes: 0 }]

  const report = (force = false) => {
    const now = Date.now()
    schedulePersist()
    if (!force && now - lastSent < PROGRESS_INTERVAL_MS) return
    lastSent = now

    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null
    speedSamples.push({ at: now, bytes: sessionReceived })
    while (speedSamples.length > 2 && now - speedSamples[0].at > 3_000) speedSamples.shift()
    const windowStart = speedSamples[0]
    const windowSeconds = Math.max(0.5, (now - windowStart.at) / 1000)
    const windowBytes = Math.max(0, sessionReceived - windowStart.bytes)
    const bytesPerSecond = windowBytes / windowSeconds
    const elapsedSeconds = (now - startedAt) / 1000
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
      bytesPerSecond: Math.round(bytesPerSecond),
      url: String(parsed),
      phase: 'downloading',
    })

    if (SMOKE_URL && (percent === null || percent - lastLogged >= 20 || percent === 100)) {
      lastLogged = percent ?? lastLogged
      smokeLog(
        `download progress ${percent ?? '?'}% (${received}/${total} bytes, ${(bytesPerSecond / 1024 ** 2).toFixed(1)} MiB/s)`,
      )
    }
  }

  // The documented runtime is independent of the season archive. Start its
  // download now so a slow game archive and a slow MSI share one wait, but keep
  // its progress off the bar until the archive work reaches its end; otherwise
  // a fast runtime would make the unified percentage jump backwards.
  const runtimeMetadata = providerId ? providerRuntimeMetadata(providerId) : null
  let runtimeResult = null
  let runtimeError = ''
  let runtimeProgressAllowed = false
  let runtimeSettled = false
  const runtimeTask = runtimeMetadata
    ? ensureProviderRuntime(providerId, runtimeMetadata, {
        root: path.join(app.getPath('userData'), 'provider-runtimes'),
        signal: controller.signal,
        report: (progress) => {
          if (!runtimeProgressAllowed) return
          send('arc:download-progress', {
            id,
            ...progress,
            url: String(parsed),
          })
        },
      })
        .then((result) => {
          runtimeResult = result
        })
        .catch((error) => {
          runtimeError = error instanceof Error ? error.message : String(error)
        })
        .finally(() => {
          runtimeSettled = true
        })
    : Promise.resolve()

  try {
    downloadBlock: {
      // A prior repair keeps its downloaded archive. Reuse it so a retry does
      // not spend another 10.8 GB before the strict manifest check can reject
      // or install it. The archive is still re-tested and re-extracted below.
      let source
      try {
        source = await selectProviderArchiveSource({
          targetDir,
          requestedName,
          repair,
          probe: () => probeRangeSupport(parsed, controller.signal),
        })
      } catch (error) {
        if (controller.signal.aborted) throw abortError()
        // A normal GET may still work when the probe cannot be completed.
        source = { cached: null, probe: null }
      }
      if (source.cached) {
        const cachedArchive = source.cached
        filePath = cachedArchive.path
        received = cachedArchive.size
        total = cachedArchive.size
        partPath = ''
        send('arc:download-progress', {
          id,
          received,
          total,
          percent: 100,
          etaSeconds: null,
          bytesPerSecond: null,
          phase: 'downloading',
        })
        if (SMOKE_URL) smokeLog(`reusing cached archive ${cachedArchive.path}`)
        break downloadBlock
      }
      if (source.probe) probe = source.probe

    const probedTotal = Number(probe.total) || 0
    if (total > 0 && probedTotal > 0 && total !== probedTotal) {
      // The source changed since the interruption. Never append new bytes to
      // an archive from a different build; keep the old partial for recovery
      // and start a separate part file for this source.
      ranges = null
      received = 0
      partPath = uniqueFilePath(targetDir, `${requestedName}.part`)
    }
    if (probedTotal > 0) total = probedTotal

    startedAt = Date.now()
    sessionReceived = 0
    const connections = total > 0 ? downloadConnectionCount(total) : 0
    const coverage = downloadCoverage(ranges, received)
    const planned = total > 0 ? planDownloadRanges(total) : []
    const canUseRanges = Boolean(probe.supported && connections > 1 && planned.length > 1)

    if (canUseRanges) {
      // Re-map bytes already on disk into the current chunk plan. This keeps
      // old progress valid even when the connection count or chunk size changes.
      ranges = withDownloadCoverage(planned, coverage)
      received = ranges.reduce((sum, range) => sum + range.received, 0)
      persistNow()
      report(true)

      if (received < total) {
        try {
          await downloadParallel(parsed, partPath, total, ranges, controller.signal, (bytes) => {
            received += bytes
            sessionReceived += bytes
            report()
          })
        } catch (error) {
          if (controller.signal.aborted) throw abortError()
          // Some CDNs advertise ranges then reject them. Retry once as a
          // normal stream only when nothing was written, so saved progress is
          // never thrown away.
          if (error instanceof RangeUnsupportedError && received === 0) {
            ranges = null
            startedAt = Date.now()
            sessionReceived = 0
            persistNow()
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
                sessionReceived += bytes
                report()
              },
            )
            if (controller.signal.aborted) throw abortError()
            if (total > 0) received = total
            report(true)
            persistNow()
          } else {
            throw error
          }
        }
      }
      if (ranges) {
        received = ranges.reduce(
          (sum, range) => sum + Math.min(range.end - range.start + 1, Math.max(0, range.received)),
          0,
        )
        if (received !== total) throw new Error('The download did not receive every byte.')
      }
    } else {
      // Range metadata from a previous attempt cannot be used if the host no
      // longer supports ranges. A single stream still resumes when possible.
      if (ranges) {
        ranges = null
        received = 0
      }
      if (total > 0 && received > total) received = 0
      persistNow()
      report(true)

      if (total === 0 || received < total) {
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
            sessionReceived += bytes
            report()
          },
          received,
          () => {
            // The host returned 200 instead of 206: it ignored our Range and
            // sent the whole file, so the bytes on disk restart at zero.
            received = 0
            ranges = null
          },
        )
      }
    }

    if (controller.signal.aborted) throw abortError()
    if (total > 0) received = total
    report(true)
    persistNow()

    if (expectedSha256) {
      send('arc:download-progress', {
        id,
        received,
        total,
        percent: 100,
        etaSeconds: null,
        bytesPerSecond: null,
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
      removeDownloadMeta(partPath)
      throw new Error(
        `The download source returned a web page instead of an archive. The file was kept at:\n${filePath}\n\nNothing was deleted. Try Refresh sources in Settings.`,
      )
    }

    if (!inspection.type) {
      filePath = uniqueFilePath(targetDir, requestedName)
      await fs.promises.rename(partPath, filePath)
      removeDownloadMeta(partPath)
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
    removeDownloadMeta(partPath)
    }

    const mobileArchive = path.extname(filePath).toLowerCase() === '.ipa' || path.extname(filePath).toLowerCase() === '.apk'
    if (!mobileArchive) {
      send('arc:download-progress', {
        id,
        received,
        total,
        percent: 100,
        etaSeconds: null,
        bytesPerSecond: null,
        phase: 'verifying',
      })
      // Read the whole archive before replacing anything. This catches a
      // truncated RAR/ZIP before the old build is touched or the exchange runs.
      if (repair || validateProvider) await testArchive(filePath, controller)
      if (controller.signal.aborted) throw abortError()

      send('arc:download-progress', {
        id,
        received,
        total,
        percent: 100,
        etaSeconds: null,
        bytesPerSecond: null,
        phase: 'extracting',
      })
      if (SMOKE_URL) smokeLog('download complete, extracting')

      if (repair && preferredRoot && fs.existsSync(preferredRoot)) {
        // Keep the old install recoverable until the new archive passes the
        // full manifest check. A bad archive must not destroy a usable build.
        const backup = uniqueFilePath(
          targetDir,
          `${preferredFolder || path.basename(preferredRoot)}.vaulted-previous`,
        )
        await fs.promises.rename(preferredRoot, backup)
        previousRootBackup = backup
      }
      await extractArchive(filePath, targetDir, controller, id)
      if (controller.signal.aborted) throw abortError()
    }

    // A repair archive can sit beside an older nested build. Prefer the
    // folder named by the provider version so detection cannot accidentally
    // return the old 6.31 client that just failed build.verify.
    let executable = preferredRoot ? findPrimaryExecutable(preferredRoot) : null
    if (!executable) executable = findPrimaryExecutable(targetDir)
    if (!executable && !mobileArchive) {
      executable = await unpackNestedArchives(targetDir, filePath, controller, id)
    }
    if (!executable) executable = findExecutable(targetDir)

    let manifestReport = null
    if (validateProvider) {
      if (!executable) {
        throw new Error(
          'The downloaded archive does not contain a Windows Fortnite client. No exchange was attempted.',
        )
      }
      send('arc:download-progress', {
        id,
        received,
        total,
        percent: 100,
        etaSeconds: null,
        bytesPerSecond: null,
        phase: 'verifying',
      })
      manifestReport = await providerAuth.verifyBuildManifest(providerId, {
        seasonId,
        buildId,
        buildPath: folderForExecutable(executable),
      })
      if (!manifestReport.ok) {
        const buildRoot = folderForExecutable(executable)
        const overlay = await repairProviderOverlay({
          targetDir: buildRoot,
          providerId,
          seasonId,
          buildId,
          report: manifestReport,
          signal: controller.signal,
        })
        if (overlay) {
          manifestReport = await providerAuth.verifyBuildManifest(providerId, {
            seasonId,
            buildId,
            buildPath: buildRoot,
          })
        }
        if (!manifestReport.ok) throw new Error(providerMismatchMessage(manifestReport))
      }
    }

    runtimeProgressAllowed = true
    if (!runtimeSettled && runtimeMetadata) {
      send('arc:download-progress', {
        id,
        received: 0,
        total: 0,
        percent: 0,
        etaSeconds: null,
        bytesPerSecond: null,
        phase: 'runtime',
        url: String(parsed),
      })
    }
    await runtimeTask

    const mobile = !executable && (mobileArchive || hasMobilePayload(targetDir))
    const reason = executable ? null : mobile ? 'mobile' : 'no-executable'

    // Keep the previous install on disk. It is the user's only local rollback
    // point if a newer provider build turns out to be bad.
    previousRootBackup = ''

    if (executable && !mobile) {
      // Reclaim the downloaded archive. Duplicate client trees are only removed
      // when profiles.json confirms the selected tree and the other copy is
      // incomplete; repair backups and two complete clients are preserved.
      await cleanupManagedBuild(safeKey, targetDir, folderForExecutable(executable)).catch((error) => {
        console.warn(`[VAULTED] Could not clean up the installed build: ${error.message}`)
      })
    }

    return {
      filePath,
      executable,
      folder: executable ? folderForExecutable(executable) : targetDir,
      reason,
      ...(manifestReport
        ? {
            manifestVerified: true,
            manifestFiles: manifestReport.expectedFiles,
            manifestBytes: manifestReport.bytes,
          }
        : {}),
      ...(runtimeResult
        ? {
            runtimeVersion: runtimeResult.version,
            runtimeInstalled: runtimeResult.installed,
            runtimeInstaller: runtimeResult.installer,
            runtimeExecutable: runtimeResult.executable,
          }
        : {}),
      ...(runtimeError ? { runtimeError } : {}),
    }
  } catch (error) {
    // Never wipe the target folder, archive, or extracted files because of a
    // failed detection, extraction, checksum, or cancellation.
    await restorePreferredRoot()
    throw error
  } finally {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    // Persist one last progress snapshot for the next launch. Only a .part
    // that never received any bytes is removed; an interrupted download is
    // kept so the UI can offer Continue download.
    if (received > 0 && fs.existsSync(partPath)) {
      persistNow()
    } else if (received === 0) {
      await fs.promises.rm(partPath, { force: true }).catch(() => {})
      removeDownloadMeta(partPath)
    }
    extractions.delete(id)
    downloads.delete(id)
  }
}

const PROVIDER_SYNC_STATE = '.vaulted-provider-sync.json'

function providerSyncStatePath(targetDir) {
  return path.join(targetDir, PROVIDER_SYNC_STATE)
}

async function readProviderSyncState(targetDir, buildId) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(providerSyncStatePath(targetDir), 'utf8'))
    if (parsed?.buildId === buildId && parsed.files && typeof parsed.files === 'object') {
      return { buildId, files: parsed.files, content: parsed.content || {} }
    }
  } catch {
    /* a missing/corrupt cache only costs one verification pass */
  }
  return { buildId, files: {}, content: {} }
}

async function writeProviderSyncState(targetDir, state) {
  const destination = providerSyncStatePath(targetDir)
  const temporary = `${destination}.tmp`
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(state))
    await fs.promises.rm(destination, { force: true })
    await fs.promises.rename(temporary, destination)
  } catch {
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
  }
}

function providerChunkUrl(chunkBaseUrl, hash) {
  // Era's CDN stores chunk filenames with the manifest's uppercase hash.
  // The parser lowercases hashes for local MD5 comparison, so restore the
  // filename casing here; a lowercase URL returns HTTP 404.
  return `${String(chunkBaseUrl).replace(/\/+$/, '')}/${encodeURIComponent(
    String(hash).toUpperCase(),
  )}.chunk`
}

function providerContentUrl(contentBaseUrl, name) {
  return `${String(contentBaseUrl).replace(/\/+$/, '')}/${encodeURIComponent(name)}`
}

/** Read exactly `length` bytes, or return a shorter buffer at EOF. */
async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total)
    if (!bytesRead) break
    total += bytesRead
  }
  return total === length ? buffer : buffer.subarray(0, total)
}

async function providerChunkMatches(handle, chunk) {
  const buffer = await readExact(handle, chunk.size, chunk.offset)
  if (buffer.length !== chunk.size) return false
  const digest = crypto.createHash('md5').update(buffer).digest('hex')
  return digest === chunk.hash
}

function decodeProviderChunk(buffer, chunk) {
  const candidates = [buffer]
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      candidates.unshift(zlib.gunzipSync(buffer))
    } catch {
      /* try the raw bytes and let the size/hash check explain the failure */
    }
  }
  for (const candidate of candidates) {
    if (candidate.length !== chunk.size) continue
    if (crypto.createHash('md5').update(candidate).digest('hex') !== chunk.hash) continue
    return candidate
  }
  throw new Error(`Era returned a chunk that does not match its manifest (${chunk.hash}).`)
}

async function fetchProviderBytes(url, signal, getHeaders, label) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal.aborted) throw abortError()
    const headers = await getHeaders(attempt > 0)
    const response = await fetch(url, { headers, signal, redirect: 'follow' })
    if (response.status === 401 && attempt === 0) {
      lastError = new Error(`${label} rejected the provider session while downloading.`)
      continue
    }
    if (!response.ok) {
      throw new Error(`${label} download answered HTTP ${response.status}.`)
    }
    return Buffer.from(await response.arrayBuffer())
  }
  throw lastError || new Error(`${label} download failed.`)
}

/**
 * Download/repair one manifest file. Existing chunks are hashed in place and
 * only mismatched or missing chunks are fetched, so a 6.31 install can be
 * repaired to Era's 6.21 manifest without replacing unchanged multi-gigabyte
 * PAKs.
 */
async function syncProviderFile({
  targetDir,
  file,
  chunkBaseUrl,
  signal,
  getHeaders,
  progress,
  state,
  saveState,
}) {
  const destination = path.join(targetDir, ...file.path.split('/'))
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })

  const stat = await fs.promises.stat(destination).catch(() => null)
  const cached = state.files[file.path]
  if (
    stat?.isFile() &&
    stat.size === file.size &&
    cached?.size === file.size &&
    cached?.mtimeMs === stat.mtimeMs
  ) {
    progress(file.size, 0)
    return { reused: file.size, downloaded: 0 }
  }

  const canPatch = Boolean(stat?.isFile() && stat.size === file.size && file.chunks.length > 0)
  const handle = await fs.promises.open(destination, canPatch ? 'r+' : 'w')
  let reused = 0
  let downloaded = 0
  try {
    if (!canPatch) await handle.truncate(0)
    const valid = new Array(file.chunks.length).fill(false)

    if (canPatch) {
      for (let index = 0; index < file.chunks.length; index += 1) {
        if (signal.aborted) throw abortError()
        const chunk = file.chunks[index]
        if (await providerChunkMatches(handle, chunk)) {
          valid[index] = true
          reused += chunk.size
          progress(chunk.size, 0)
        }
      }
    }

    let next = 0
    const worker = async () => {
      while (next < file.chunks.length) {
        const index = next++
        if (valid[index]) continue
        if (signal.aborted) throw abortError()
        const chunk = file.chunks[index]
        let buffer
        try {
          buffer = decodeProviderChunk(
            await fetchProviderBytes(
              providerChunkUrl(chunkBaseUrl, chunk.hash),
              signal,
              getHeaders,
              'Era chunk',
            ),
            chunk,
          )
        } catch (error) {
          if (signal.aborted) throw abortError()
          throw error
        }
        await handle.write(buffer, 0, buffer.length, chunk.offset)
        downloaded += buffer.length
        progress(buffer.length, buffer.length)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, Math.max(1, file.chunks.length)) }, () => worker()),
    )
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }

  const after = await fs.promises.stat(destination)
  state.files[file.path] = { size: after.size, mtimeMs: after.mtimeMs }
  await saveState()
  return { reused, downloaded }
}

/**
 * Remove game payloads that are not in the live manifest. A previous build can
 * leave differently named PAKs beside the repaired files; Era's verifier scans
 * that folder, so stale entries would keep the install at a non-zero mismatch
 * count even after every manifest file was replaced.
 */
async function pruneProviderGameFiles(targetDir, expectedRelativePaths) {
  const expected = new Set(expectedRelativePaths.map((value) => value.toLowerCase()))
  const payload = /\.(?:pak|sig|utoc|ucas)$/i
  const walk = async (relativeDir) => {
    let entries
    try {
      entries = await fs.promises.readdir(path.join(targetDir, ...relativeDir.split('/')), {
        withFileTypes: true,
      })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(relative)
        continue
      }
      if (!entry.isFile() || !payload.test(entry.name)) continue
      if (expected.has(relative.toLowerCase())) continue
      await fs.promises.rm(path.join(targetDir, ...relative.split('/')), { force: true }).catch(() => {})
    }
  }
  await walk('FortniteGame/Content/Paks')
  await walk('FortniteGame/Plugins')
}

async function syncProviderContentFile({
  targetDir,
  file,
  contentBaseUrl,
  signal,
  getHeaders,
  progress,
  state,
  saveState,
}) {
  const destination = path.join(targetDir, 'FortniteGame', 'Content', 'Paks', file.name)
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  const stat = await fs.promises.stat(destination).catch(() => null)
  const cached = state.content[file.name]
  if (
    stat?.isFile() &&
    stat.size === file.size &&
    cached?.size === file.size &&
    cached?.mtimeMs === stat.mtimeMs
  ) {
    progress(file.size, 0)
    return { reused: file.size, downloaded: 0 }
  }

  const buffer = await fetchProviderBytes(
    providerContentUrl(contentBaseUrl, file.name),
    signal,
    getHeaders,
    `Era content ${file.name}`,
  )
  if (buffer.length !== file.size) {
    throw new Error(`Era returned an incomplete content file for ${file.name}.`)
  }
  const temporary = `${destination}.part`
  await fs.promises.writeFile(temporary, buffer)
  await fs.promises.rm(destination, { force: true })
  await fs.promises.rename(temporary, destination)
  const after = await fs.promises.stat(destination)
  state.content[file.name] = { size: after.size, mtimeMs: after.mtimeMs }
  await saveState()
  progress(buffer.length, buffer.length)
  return { reused: 0, downloaded: buffer.length }
}

/**
 * A public archive can be a valid base build while still missing Era's small
 * overlay (content PAKs, imgui.ini, EMS config, and the provider launcher).
 * Repair only those bounded mismatches from the live manifest; a genuinely
 * wrong archive is too large to patch and is rejected instead of triggering
 * another multi-gigabyte download.
 */
async function repairProviderOverlay({
  targetDir,
  providerId,
  seasonId,
  buildId,
  report,
  signal,
}) {
  if (!report?.issues?.length) return null
  const manifest = await providerAuth.buildManifest(providerId, { seasonId, buildId })
  const plan = planProviderOverlay({ report, manifest })
  if (!plan) return null
  const { patchBase, patchContent, bytes } = plan
  if (!manifest.contentBaseUrl && patchContent.size > 0) {
    throw new Error('Era did not return a content source for the archive overlay; the archive was rejected.')
  }

  const headers = await providerAuth.resourceHeaders(providerId)
  const getHeaders = async () => headers
  const state = { files: {}, content: {} }
  const saveState = async () => {}
  const total = bytes
  let completed = 0
  const progress = (amount) => {
    completed += Math.max(0, Number(amount) || 0)
    if (total > 0) {
      send('arc:download-progress', {
        id: 'provider-overlay',
        received: Math.min(completed, total),
        total,
        percent: Math.min(100, Math.round((completed / total) * 100)),
        etaSeconds: null,
        bytesPerSecond: null,
        phase: 'verifying',
      })
    }
  }

  for (const file of patchBase.values()) {
    if (signal.aborted) throw abortError()
    await syncProviderFile({
      targetDir,
      file,
      chunkBaseUrl: manifest.chunkBaseUrl,
      signal,
      getHeaders,
      progress,
      state,
      saveState,
    })
  }
  for (const file of patchContent.values()) {
    if (signal.aborted) throw abortError()
    await syncProviderContentFile({
      targetDir,
      file,
      contentBaseUrl: manifest.contentBaseUrl,
      signal,
      getHeaders,
      progress,
      state,
      saveState,
    })
  }
  await pruneProviderGameFiles(targetDir, [
    ...manifest.files.map((file) => file.path),
    ...manifest.contentFiles.map((file) => `FortniteGame/Content/Paks/${file.name}`),
  ])
  return { files: plan.files, bytes }
}

function providerMismatchMessage(report) {
  const sample = report.issues
    .slice(0, 5)
    .map((issue) => {
      if (issue.kind === 'size') {
        return `${issue.path} (size ${issue.actualSize ?? '?'} / expected ${issue.expectedSize})`
      }
      if (issue.kind === 'hash') {
        return `${issue.path} (hash ${issue.actualHash || '?'} / expected ${issue.expectedHash || '?'})`
      }
      return `${issue.path} (${issue.kind})`
    })
    .join('\n')
  return (
    `The downloaded archive does not match Era's live ${report.buildVersion || 'provider'} build: ` +
    `${report.issueCount} of ${report.expectedFiles} expected files failed verification ` +
    `(${report.missing} missing, ${report.sizeMismatches} size, ${report.hashMismatches} hash). ` +
    `No exchange was attempted.\n${sample}`
  )
}

/**
 * Sync a downloaded season to the provider's live chunk manifest. This is the
 * one-click repair path: the manifest is fetched with the signed-in provider
 * token, every local chunk is checked, and only missing/mismatched chunks are
 * downloaded. Files are written under the season's managed folder, so the
 * resulting tree is the exact build Era's build.verify expects.
 */
async function syncProviderBuild(payload) {
  const id = typeof payload?.id === 'string' ? payload.id : ''
  const providerId =
    typeof payload?.providerId === 'string'
      ? payload.providerId.trim().toLowerCase().split(':')[0]
      : ''
  const key = String(payload?.key || id).replace(/[^a-z0-9_-]/gi, '') || 'build'
  const seasonId = typeof payload?.seasonId === 'string' ? payload.seasonId : key
  if (!id || !providerId) throw new Error('Invalid provider build sync request.')
  if (downloads.has(id)) throw new Error('This build is already downloading.')

  const targetDir = path.join(buildsRoot(), key)
  await fs.promises.mkdir(targetDir, { recursive: true })

  const controller = new AbortController()
  downloads.set(id, controller)
  const signal = controller.signal

  let headers = null
  let headersAt = 0
  const getHeaders = async (force = false) => {
    if (!headers || force || Date.now() - headersAt > 10 * 60 * 1000) {
      headers = await providerAuth.resourceHeaders(providerId)
      headersAt = Date.now()
    }
    return headers
  }

  try {
    await getHeaders(true)
    const manifest = await providerAuth.buildManifest(providerId, {
      seasonId,
      buildId: typeof payload?.buildId === 'string' ? payload.buildId : '',
    })
    const total = Number(manifest.totalBytes) || 0
    const state = await readProviderSyncState(targetDir, manifest.buildId)
    state.buildId = manifest.buildId
    const startedAt = Date.now()
    let received = 0
    let downloaded = 0
    let reused = 0
    let lastSent = 0

    const report = (force = false) => {
      const now = Date.now()
      if (!force && now - lastSent < PROGRESS_INTERVAL_MS) return
      lastSent = now
      const elapsed = (now - startedAt) / 1000
      const bytesPerSecond = elapsed > 0 ? downloaded / elapsed : 0
      const remaining = Math.max(0, total - received)
      send('arc:download-progress', {
        id,
        received,
        total,
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
        etaSeconds:
          bytesPerSecond > 0 && elapsed >= 1 ? Math.max(0, Math.round(remaining / bytesPerSecond)) : null,
        bytesPerSecond: Math.round(bytesPerSecond),
        url: 'provider-live-build',
        phase: 'downloading',
      })
    }
    const progress = (bytes, downloadedBytes) => {
      received += bytes
      downloaded += downloadedBytes
      report()
    }
    const saveState = async () => {
      await writeProviderSyncState(targetDir, state)
    }

    report(true)
    for (const file of manifest.files) {
      if (signal.aborted) throw abortError()
      const result = await syncProviderFile({
        targetDir,
        file,
        chunkBaseUrl: manifest.chunkBaseUrl,
        signal,
        getHeaders,
        progress,
        state,
        saveState,
      })
      reused += result.reused
    }
    for (const file of manifest.contentFiles) {
      if (signal.aborted) throw abortError()
      const result = await syncProviderContentFile({
        targetDir,
        file,
        contentBaseUrl: manifest.contentBaseUrl,
        signal,
        getHeaders,
        progress,
        state,
        saveState,
      })
      reused += result.reused
    }

    if (signal.aborted) throw abortError()
    // The manifest is the complete expected game payload. Removing stale
    // PAK/SIG/UTOC/UCAS files here is what makes build.verify report zero
    // mismatches after repairing an older 6.31 folder.
    await pruneProviderGameFiles(targetDir, [
      ...manifest.files.map((file) => file.path),
      ...manifest.contentFiles.map((file) => `FortniteGame/Content/Paks/${file.name}`),
    ])
    if (total > 0) received = total
    send('arc:download-progress', {
      id,
      received,
      total,
      percent: 100,
      etaSeconds: null,
      bytesPerSecond: null,
      url: 'provider-live-build',
      phase: 'verifying',
    })

    const executable = path.join(
      targetDir,
      'FortniteGame',
      'Binaries',
      'Win64',
      CLIENT_EXE,
    )
    if (!fs.existsSync(executable)) {
      throw new Error(
        `Era's live build was downloaded, but ${CLIENT_EXE} is missing. Try the update again.`,
      )
    }
    await cleanupManagedBuild(key, targetDir, targetDir).catch((error) => {
      console.warn(`[VAULTED] Could not clean up the synced build: ${error.message}`)
    })
    return {
      folder: targetDir,
      executable,
      buildId: manifest.buildId,
      buildName: manifest.buildName,
      buildVersion: manifest.buildVersion,
      files: manifest.files.length + manifest.contentFiles.length,
      totalBytes: total,
      downloadedBytes: downloaded,
      reusedBytes: reused,
    }
  } finally {
    if (downloads.get(id) === controller) downloads.delete(id)
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
    issues: { missing: [], empty: [], unreadable: [], temp: [], corrupt: [], runtime: [] },
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

  // A build can be perfectly intact and still fail every launch when the
  // injector or backend files beside app.asar are missing.
  for (const problem of runtimeProblems()) addVerifyIssue(report, 'runtime', problem)

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

  // The launcher bootstrap is required even when the shipping client itself
  // is present. Keep it in the required set so a partial provider update is
  // repaired instead of failing after Play.
  const launcherExe = path.join(path.dirname(executable), 'FortniteLauncher.exe')
  if (!fs.existsSync(launcherExe)) {
    addVerifyIssue(report, 'missing', path.relative(target, launcherExe) || 'FortniteLauncher.exe')
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

      if (/\.(?:pak|ucas|utoc)$/i.test(lowerName)) {
        const normalizedPaks = path.resolve(paksDir).toLowerCase()
        if (lowerName.endsWith('.pak') && full.toLowerCase().startsWith(`${normalizedPaks}${path.sep}`)) {
          report.paks += 1
        }
        if (stat.size < 1024) {
          addVerifyIssue(report, 'corrupt', `${relative} (content file is too small)`)
          continue
        }
        try {
          const sample = await sampleFile(full, stat.size)
          if (sample.length === 0 || sample.every((byte) => byte === 0)) {
            addVerifyIssue(report, 'corrupt', `${relative} (empty content data)`)
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

/* ------------------------------------------------------------------ auto-fix */

function resolveAutoFixTarget(payload = {}) {
  const id = typeof payload?.id === 'string' ? payload.id : ''
  const root = path.resolve(buildsRoot())
  const raw = typeof payload?.path === 'string' ? payload.path : ''
  const target = raw ? path.resolve(raw) : ''
  const relative = target ? path.relative(root.toLowerCase(), target.toLowerCase()) : ''
  const managed =
    Boolean(target) && Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
  return { id, root, target, managed }
}

function verifyIssueLabel(kind) {
  switch (kind) {
    case 'missing':
      return 'Fortnite file is missing'
    case 'empty':
      return 'Fortnite file is empty'
    case 'unreadable':
      return 'Fortnite file is unreadable'
    case 'corrupt':
      return 'Fortnite file is corrupt'
    case 'temp':
      return 'Leftover temporary file'
    case 'runtime':
      return 'VAULTED runtime needs repair'
    default:
      return 'Fortnite build needs repair'
  }
}

/**
 * Read-only Auto-Fix health report for one downloaded season. A quick scan
 * checks the executable, PAK folder, runtime DLLs, launcher and leftovers; a
 * deep scan also hashes/samples every installed game file through verifyBuild.
 */
async function autoFixScan(payload = {}) {
  const { id, root, target, managed } = resolveAutoFixTarget(payload)
  const providerId =
    typeof payload?.providerId === 'string' ? payload.providerId.trim().toLowerCase() : ''
  const seasonId = typeof payload?.seasonId === 'string' ? payload.seasonId.trim() : ''
  const checkedAt = new Date().toISOString()
  const issues = []
  const seen = new Set()
  const add = (kind, label, detail = '') => {
    const key = `${kind}|${label}|${detail}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ kind, label, detail })
  }

  if (!id) return { id, managed: false, issues, checkedAt }
  if (running.has(id) || downloads.has(id)) {
    return { id, managed, running: true, issues, checkedAt }
  }

  // A stale profile can point at a folder that no longer exists while the
  // build is still on disk. Recover the canonical tree instead of asking for a
  // full re-download.
  let recovered = null
  if (managed && target && !fs.existsSync(target) && seasonId) {
    const candidate = path.join(root, seasonId)
    if (candidate !== target && fs.existsSync(candidate)) {
      const found = findPrimaryExecutable(candidate)
      if (found) recovered = { folder: folderForExecutable(found), executable: found }
    }
  }
  let folder = recovered?.folder || target
  let executable =
    recovered?.executable ||
    (typeof payload?.executable === 'string' ? path.resolve(payload.executable) : '')
  // A build that was reinstalled or moved can keep a valid season folder but a
  // stale executable path. Find the real client before calling it missing.
  if (managed && folder && fs.existsSync(folder) && (!executable || !fs.existsSync(executable))) {
    const found = findPrimaryExecutable(folder)
    if (found) {
      recovered = { folder: folderForExecutable(found), executable: found }
      folder = recovered.folder
      executable = found
    }
  }
  const looseCounts = { temp: 0, locks: 0, archives: 0 }
  const loosePaths = new Set()

  if (!managed) {
    add('path', "This build is not inside VAULTED's builds folder", target)
  } else if (!folder || !fs.existsSync(folder)) {
    add('path', 'Install folder is missing', target || '(not set)')
  }

  if (folder && fs.existsSync(folder)) {
    const relativeExecutable = executable ? path.relative(folder, executable) : ''
    const executableIsInside =
      Boolean(executable) &&
      Boolean(relativeExecutable) &&
      !relativeExecutable.startsWith('..') &&
      !path.isAbsolute(relativeExecutable)
    if (!executableIsInside || !fs.existsSync(executable)) {
      add(
        'build',
        'Fortnite client executable is missing',
        executable ? path.basename(executable) : 'FortniteClient-Win64-Shipping.exe',
      )
    } else {
      try {
        const stat = await fs.promises.stat(executable)
        if (stat.size === 0) {
          add('build', 'Fortnite client executable is empty', relativeExecutable)
        } else {
          const header = Buffer.alloc(2)
          const handle = await fs.promises.open(executable, 'r')
          try {
            await handle.read(header, 0, 2, 0)
          } finally {
            await handle.close()
          }
          if (header[0] !== 0x4d || header[1] !== 0x5a) {
            add('build', 'Fortnite client executable is corrupt', relativeExecutable)
          }
        }
      } catch {
        add('build', 'Fortnite client executable is unreadable', relativeExecutable)
      }
    }

    const paksDir = path.join(folder, 'FortniteGame', 'Content', 'Paks')
    if (!fs.existsSync(paksDir)) {
      add('build', 'Fortnite content PAK folder is missing', path.relative(folder, paksDir))
    }

    const loose = scanLooseFiles(folder, {
      maxDepth: payload.deep === true ? 4 : 1,
      maxEntries: payload.deep === true ? 60_000 : 1_500,
    })
    looseCounts.temp = loose.temp.length
    looseCounts.locks = loose.locks.length
    looseCounts.archives = loose.archives.length
    for (const file of loose.temp) {
      loosePaths.add(file.relative.toLowerCase())
      add('temp', 'Leftover temporary file', file.relative)
    }
    // A lock younger than a minute may belong to an operation still running.
    for (const file of loose.locks) {
      loosePaths.add(file.relative.toLowerCase())
      if (file.ageMs >= 60_000) add('temp', 'Stale lock file', file.relative)
    }
    for (const file of loose.archives) {
      loosePaths.add(file.relative.toLowerCase())
      add('cleanup', 'Leftover downloaded archive', file.relative)
    }
  }

  for (const problem of runtimeProblems()) add('runtime', 'VAULTED runtime needs repair', problem)
  for (const problem of stagedRuntimeProblems()) add('runtime', 'VAULTED DLL needs repair', problem)

  let launcher = null
  const metadata = providerId ? providerRuntimeMetadata(providerId) : null
  if (metadata) {
    launcher = providerRuntimeStatus(providerId)
    if (!launcher?.installed) {
      add('launcher', `${metadata.label} is not installed`, 'Auto-Fix installs the official launcher')
    }
  }

  let verify = null
  if (payload.deep === true && managed && folder && fs.existsSync(folder) && executable) {
    verify = await verifyBuild({ id, path: folder, executable })
    if (verify.running) {
      return { id, managed, running: true, issues: [], checkedAt, recovered }
    }
    const kinds = {
      missing: 'build',
      empty: 'build',
      unreadable: 'build',
      corrupt: 'build',
      temp: 'temp',
      runtime: 'runtime',
    }
    let listed = 0
    let ignored = 0
    for (const [kind, list] of Object.entries(verify.issues || {})) {
      for (const item of list || []) {
        const relative = String(item || '').replace(/\\/g, '/').toLowerCase()
        // A fragment or lock the cleanup pass owns is not also a broken build
        // file, and a cosmetic empty cache file is not worth a full re-download.
        if (isOptionalVerifyIssue(item, kind)) {
          ignored += 1
          continue
        }
        if (loosePaths.has(relative) || loosePaths.has(item)) {
          ignored += 1
          continue
        }
        listed += 1
        add(kinds[kind] || 'build', verifyIssueLabel(kind), item)
      }
    }
    if ((verify.issueCount || 0) - ignored > listed) {
      add(
        'summary',
        'More build problems found',
        `${verify.issueCount - ignored - listed} additional file issues`,
      )
    }
  }

  return {
    id,
    managed,
    running: false,
    verified: verify ? verify.verified : issues.length === 0,
    issues,
    checkedAt,
    launcher,
    loose: looseCounts,
    verify,
    recovered,
  }
}

/**
 * Repair everything Auto-Fix owns without touching good game files: VAULTED
 * runtime + staged DLLs, leftover temp/lock files, duplicate trees, stale
 * archives and a missing/broken companion launcher. Game-file repair is driven
 * by the renderer through the normal archive/provider sync path.
 */
async function autoFixRepair(payload = {}) {
  const { id, root, target, managed } = resolveAutoFixTarget(payload)
  if (!id) throw new Error('Invalid Auto-Fix request.')
  if (running.has(id) || downloads.has(id)) {
    throw new Error('Close Fortnite and wait for downloads to finish before Auto-Fix repairs this season.')
  }
  if (!managed) {
    throw new Error("Auto-Fix can only repair seasons downloaded inside VAULTED's builds folder.")
  }
  if (await anyFortniteClientRunning()) {
    throw new Error('Close Fortnite before running Auto-Fix.')
  }
  const providerId =
    typeof payload?.providerId === 'string' ? payload.providerId.trim().toLowerCase() : ''
  const seasonId = typeof payload?.seasonId === 'string' ? payload.seasonId.trim() : ''
  const actions = []
  const remaining = []
  let freedBytes = 0
  const report = (phase, label, percent) =>
    send('arc:autofix-progress', { id, phase, label, percent })
  const messageOf = (error) => (error instanceof Error ? error.message : String(error || ''))

  report('runtime', 'Repairing VAULTED runtime files…', 8)
  try {
    await ensureRuntimeInstalled()
    await stageCoreRuntimeDlls()
    actions.push('Restored VAULTED runtime files (injector, Tellurium, Cobalt, Server DLL)')
  } catch (error) {
    remaining.push(messageOf(error))
  }

  let metadata = null
  if (providerId) {
    metadata = providerRuntimeMetadata(providerId)
    report('dlls', `Staging ${metadata?.label || providerId} DLLs…`, 24)
    try {
      const staged = await stageSeasonLauncherDlls(providerId)
      if (staged.staged.length > 0) {
        actions.push(`Verified ${staged.staged.length} launcher DLLs`)
      }
    } catch (error) {
      remaining.push(messageOf(error))
    }
  }

  let recovered = null
  let folder = target
  if (managed && folder && !fs.existsSync(folder) && seasonId) {
    const candidate = path.join(root, seasonId)
    const found = fs.existsSync(candidate) ? findPrimaryExecutable(candidate) : null
    if (found) {
      recovered = { folder: folderForExecutable(found), executable: found }
      folder = recovered.folder
      actions.push(`Recovered the install path ${folder}`)
    }
  }

  if (folder && fs.existsSync(folder)) {
    report('cleanup', 'Removing temp files and stale locks…', 46)
    const removal = removeLooseFiles(folder, { includeArchives: false })
    freedBytes += removal.freedBytes
    if (removal.removed.length > 0) {
      actions.push(`Removed ${removal.removed.length} temporary or stale lock file(s)`)
    }
    if (removal.kept.length > 0) {
      remaining.push(`${removal.kept.length} recent lock file(s) kept because they may be in use`)
    }

    report('cleanup', 'Cleaning duplicate installs and old archives…', 64)
    try {
      const executable = recovered?.executable || payload?.executable || ''
      const cleanup = await cleanupManagedBuild(
        seasonId || path.basename(folder),
        folder,
        executable ? folderForExecutable(executable) : folder,
      )
      if (cleanup) {
        freedBytes += cleanup.freedBytes || 0
        const removedCount = (cleanup.removed || []).length
        if (removedCount > 0) actions.push(`Removed ${removedCount} leftover archive or broken tree(s)`)
      }
    } catch (error) {
      remaining.push(messageOf(error))
    }
  } else if (managed) {
    remaining.push('The season folder is missing, so its game files need a fresh download')
  }

  let launcher = null
  if (metadata) {
    const status = providerRuntimeStatus(providerId)
    let force = payload?.forceLauncher === true
    if (status?.installed && !force) {
      const executable = installedExecutable(metadata)
      try {
        const stat = executable ? fs.statSync(executable) : null
        if (!stat || stat.size === 0) force = true
      } catch {
        force = true
      }
    }
    if (!status?.installed || force) {
      report('launcher', `${force ? 'Repairing' : 'Installing'} ${metadata.label}…`, 80)
      try {
        launcher = await ensureProviderRuntime(providerId, metadata, {
          root: path.join(app.getPath('userData'), 'provider-runtimes'),
          forceInstall: force,
        })
        actions.push(
          `${metadata.label}${launcher?.version ? ` ${launcher.version}` : ''} ${force ? 'repaired' : 'installed'}`,
        )
      } catch (error) {
        remaining.push(messageOf(error))
      }
    }
  }

  report('done', 'Auto-Fix finished', 100)
  return { id, actions, remaining, removed: [], freedBytes, recovered, launcher }
}

const PROVIDER_ACCOUNT_STATUS_PREFIX = 'VAULTED_PROVIDER_ACCOUNT_STATUS:'
const PROVIDER_BUILD_STATUS_PREFIX = 'VAULTED_PROVIDER_BUILD_STATUS:'

/** Only an explicit, non-Discord HTTPS verification page may open in VAULTED. */
function providerVerificationUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!/^https:\/\//i.test(raw)) return ''
  try {
    const url = new URL(raw)
    if (url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    if (
      host === 'discord.com' ||
      host === 'discord.gg' ||
      host.endsWith('.discord.com') ||
      host.endsWith('.discord.gg')
    ) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

/** Turn a game-file integrity rejection into an actionable live-build repair. */
function providerBuildIssue(profile, error) {
  if (error?.buildVerificationRequired !== true) return null
  const buildVersion = String(error?.buildVersion || '').trim()
  const buildName = String(error?.buildName || '').trim()
  return {
    code: 'build_verification_required',
    providerId: String(profile?.id || ''),
    providerLabel: String(profile?.label || profile?.name || profile?.id || 'Provider'),
    buildId: String(error?.buildId || '').trim(),
    buildVersion,
    buildName,
    mismatched: Array.isArray(error?.buildVerificationMismatches)
      ? error.buildVerificationMismatches.filter((path) => typeof path === 'string').slice(0, 40)
      : [],
    message: error instanceof Error ? error.message : String(error || ''),
  }
}

/** Turn a structured provider account status into an actionable launch error. */
function providerAccountIssue(profile, error) {
  const providerLabel = String(profile?.label || profile?.name || profile?.id || 'online service')
  // An expired/revoked backend session is not a generic launch failure. The
  // renderer uses this flag to clear the stale account and open the native
  // Connect online account prompt, then resume the same Play automatically.
  if (
    error?.sessionExpired === true ||
    error?.code === 'provider_session_expired' ||
    (error?.status === 401 &&
      !error?.accountStatus &&
      error?.verificationRequired !== true &&
      error?.buildVerificationRequired !== true)
  ) {
    return {
      code: 'session_expired',
      providerId: String(profile?.id || ''),
      providerLabel,
      providerName: String(profile?.name || providerLabel),
      reauthRequired: true,
      verificationRequired: false,
      message: `Your ${providerLabel} session expired. Connect the account again to continue online play.`,
    }
  }
  // Only let providerAuth's structured account status through this path. A
  // transport error code such as ECONNRESET must keep its normal launch error.
  if (!error?.accountStatus && error?.verificationRequired !== true) return null
  const code = String(error?.accountStatus || error?.code || 'verification_required').toLowerCase()
  const verification =
    error?.verificationRequired === true ||
    /(?:^|_)(?:verification|verify|verified|discord|guild|membership|whitelist)(?:_|$)/.test(code)
  const providerName = String(profile?.name || profile?.label || profile?.id || 'the provider')
  const issuer = providerLabel
  const rawWebsite = String(profile?.website || profile?.signInUrl || '').trim()
  const website = /^https?:\/\//i.test(rawWebsite)
    ? rawWebsite.replace(/\/+$/, '')
    : profile?.id === 'era'
      ? 'https://erafn.dev'
      : ''
  const isEra = profile?.id === 'era'
  const accountLabel = isEra ? 'Project Era' : providerLabel
  const destination = isEra ? 'Project Era' : `${providerName}'s account page`
  const verificationUrl = providerVerificationUrl(error?.verificationUrl)

  let message
  if (verification) {
    const action = verificationUrl
      ? ` Use Verify Account to open the page ${providerName} supplied.`
      : ` Link or verify the account on ${providerName}, then press Retry.`
    message = `Your signed-in ${accountLabel} account needs account verification in ${destination} before ${issuer} will issue game launch codes.${action}`
  } else {
    const link = website ? ` Check ${website}, then press Retry.` : ' Check your account, then press Retry.'
    let reason = 'The provider rejected this account status.'
    if (/banned|suspended|disabled/.test(code)) {
      reason = `${providerName} has suspended or banned this account, so it cannot receive launch codes right now.`
    } else if (/restricted|locked|whitelist|role/.test(code)) {
      reason = `This account is restricted or missing a required ${providerName} role or whitelist entry.`
    } else if (/not_found|missing/.test(code)) {
      reason = `The provider could not find this signed-in account. Sign in again from the season card.`
    } else if (/link_required|not_linked/.test(code)) {
      reason = `This account needs to be linked to ${providerName} before it can receive launch codes.`
    }
    message = `Your signed-in ${accountLabel} account cannot receive ${issuer} game launch codes right now. ${reason}${link}`
  }

  return {
    code: code || 'account_status',
    providerId: String(profile?.id || ''),
    providerLabel,
    providerName,
    website,
    verificationUrl: verificationUrl || undefined,
    verificationRequired: verification,
    message,
  }
}

const EXTERNAL_LAUNCH_STABILITY_MS = 4_000

/**
 * Start an external project's launcher and prove it is actually alive.
 *
 * A broken or half-uninstalled launcher (a Flutter app missing its bundled
 * `data` folder, for example) starts and exits within a second. Reporting that
 * as a running season leaves the card on "Running" with no window open and no
 * game process for the session monitor to watch, so the early exit is captured
 * here instead.
 */
function spawnExternalLauncher(executable, args) {
  return new Promise((resolve) => {
    let child
    try {
      // The launcher is a background helper now, never the player's window.
      // windowsHide covers the console/bootstrapper; the automation below also
      // moves and hides the Flutter window as soon as it exists.
      child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: path.dirname(executable),
      })
      if (child.pid) {
        // The Flutter window appears during the stability wait below, before
        // the provider-scoped hider exists. Keep hiding it from the first
        // moment so even a launcher that shows itself cannot flash on screen.
        const earlyPid = child.pid
        void hideCompanionLauncher(earlyPid)
        const earlyHide = setInterval(() => void hideCompanionLauncher(earlyPid), 400)
        earlyHide.unref?.()
        const stopEarlyHide = setTimeout(() => clearInterval(earlyHide), 12_000)
        stopEarlyHide.unref?.()
      }
    } catch (error) {
      resolve({ child: null, exitCode: null, error })
      return
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ child, exitCode: null, error: null }),
      EXTERNAL_LAUNCH_STABILITY_MS,
    )
    timer.unref?.()
    child.once('error', (error) => finish({ child, exitCode: null, error }))
    child.once('exit', (code, signal) =>
      finish({ child, exitCode: Number.isInteger(code) ? code : -1, signal, error: null }),
    )
  })
}

async function openProviderLauncherEntry(providerId, options = {}) {
    const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : ''
    const profile = id && providerForId(id) ? providerProfile(id) : null
    if (!profile || profile.external !== true || profile.mode !== 'external') {
      return { opened: false, error: 'That provider does not use an official launcher.' }
    }

    /** PIDs of a launcher that is already running under any of its names. */
    const runningLauncherPids = (names) => processPidsByImage(names)

    /**
     * Start a launcher from every documented install location, repair the
     * install once when all of them die on startup, and register the launcher
     * only after it survives. `repair` runs the provider's own installer and
     * returns the executable that is now on disk.
     */
    const startVisibleLauncher = async (executablePaths, args, repair = null, names = []) => {
      const candidates = (Array.isArray(executablePaths) ? executablePaths : [executablePaths]).filter(
        Boolean,
      )
      if (candidates.length === 0) {
        return { opened: false, error: `${profile.label} is not installed yet.` }
      }
      let current = candidates[0]
      const adoptRunning = async () => {
        const pids = await runningLauncherPids(names)
        if (pids.length === 0) return null
        providerLaunchers.set(id, { pid: pids[0], startedAt: Date.now() })
        startCompanionWindowHider(id, pids[0])
        startCompanionSessionMonitor(id, current)
        return { opened: true, path: current, pid: pids[0], tracked: true, alreadyRunning: true }
      }
      // Most companions are single-instance: spawning a second copy exits at
      // once. Adopt the running window instead of calling it a broken install.
      const already = await adoptRunning()
      if (already) return already

      let lastExit = null
      let lastError = null
      const tryStart = async (paths) => {
        for (const candidate of paths) {
          current = candidate
          const attempt = await spawnExternalLauncher(candidate, args)
          if (attempt.error) {
            lastError = attempt.error
            continue
          }
          if (attempt.exitCode === null) return attempt
          lastExit = attempt.exitCode
          const raced = await adoptRunning()
          if (raced) return raced
        }
        return null
      }

      let launch = await tryStart(candidates)
      if (!launch && typeof repair === 'function') {
        const firstExit = lastExit
        try {
          const repairedExecutable = await repair()
          if (repairedExecutable) launch = await tryStart([repairedExecutable])
        } catch (error) {
          return {
            opened: false,
            error: `${profile.label} closed immediately after it started (exit code ${firstExit}) and its installer could not repair it. ${
              error instanceof Error ? error.message : String(error)
            }`,
          }
        }
      }
      if (!launch) {
        const adopted = await adoptRunning()
        if (adopted) return adopted
        if (lastExit !== null) {
          return {
            opened: false,
            error: `${profile.label} closed immediately after it started (exit code ${lastExit}), so its installation at ${path.dirname(current)} is incomplete. Reinstall it from its official installer, then press Start again.`,
          }
        }
        return {
          opened: false,
          error: `${profile.label} could not be started: ${lastError?.message || 'unknown error'}`,
        }
      }
      launch.child.unref()
      // Visible on purpose: this launcher is how the player starts the game.
      // Only a managed provider's background companion (startCompanionLauncher)
      // is hidden. The session monitor keeps this launcher alive for the whole
      // game session and closes it after Fortnite exits or on Stop.
      registerProviderLauncher(id, launch.child)
      startCompanionWindowHider(id, launch.child.pid)
      startCompanionSessionMonitor(id, current)
      return { opened: true, path: current, pid: launch.child.pid ?? null, tracked: true }
    }

    // A Discord-only community has no launcher application at all. VAULTED
    // joins its live public servers with its own direct launch, so never ask
    // the player to install a launcher that does not exist.
    if (profile.directLaunch === true) {
      return {
        opened: false,
        directLaunch: true,
        error: `${profile.label} is a Discord-only community without a launcher app. VAULTED joins its live servers directly, and none is online right now.`,
      }
    }

    // A provider with documented runtime metadata starts its official launcher
    // with the exact build flag it publishes when it has one. Single-season
    // launchers are opened directly; Retrac additionally receives its 14.60
    // manifest flag. VAULTED never edits a provider's private library.
    const runtimeMetadata = providerRuntimeMetadata(id)
    const runtimeRoot = path.join(app.getPath('userData'), 'provider-runtimes')
    const launchOptions =
      options && typeof options === 'object' && !Array.isArray(options) ? options : {}
    const buildFolder = typeof launchOptions.folder === 'string' ? launchOptions.folder : ''
    const buildExecutable =
      typeof launchOptions.executable === 'string' ? launchOptions.executable : ''
    if (runtimeMetadata) {
      const requestedVersion =
        typeof launchOptions.version === 'string' ? launchOptions.version.trim() : ''
      const manifestVersions = Object.keys(runtimeMetadata.manifestIds || {})
      const version = runtimeMetadata.manifestIds?.[requestedVersion]
        ? requestedVersion
        : manifestVersions[0] || runtimeMetadata.version || ''
      let executable = installedExecutable(runtimeMetadata)
      if (!executable) {
        // The season archive may already have been installed before this
        // runtime metadata existed. Prepare the signed launcher on Play as
        // well, without requiring another 14.60 archive download.
        try {
          const runtime = await ensureProviderRuntime(id, runtimeMetadata, {
            root: path.join(app.getPath('userData'), 'provider-runtimes'),
          })
          executable = runtime?.executable || ''
        } catch (error) {
          return {
            opened: false,
            error: error instanceof Error ? error.message : 'The provider runtime could not be prepared.',
          }
        }
      }
      if (!executable) {
        return {
          opened: false,
          error: `${profile.label} is not installed yet. Use the launcher install step on the season card once.`,
        }
      }
      // Reboot reads its saved builds from `settings/v3_game_storage.gs` at
      // startup. Pre-wire the VAULTED install and select it so the launcher's
      // own Play button starts this season without adding a folder by hand.
      let savedBuild = null
      if (id === 'reboot-official' && buildFolder) {
        const requestedGameVersion =
          typeof launchOptions.gameVersion === 'string' && launchOptions.gameVersion.trim()
            ? launchOptions.gameVersion.trim()
            : requestedVersion
        const savedName =
          typeof launchOptions.name === 'string' && launchOptions.name.trim()
            ? launchOptions.name.trim()
            : `${profile.label} ${requestedGameVersion}`.trim()
        savedBuild = writeSavedBuild({
          executable,
          name: savedName,
          gameVersion: requestedGameVersion,
          location: buildFolder,
        })
      }
      const args = launchArguments(runtimeMetadata, version) || []
      const repairRuntime = async () => {
        const repaired = await ensureProviderRuntime(id, runtimeMetadata, {
          root: runtimeRoot,
          forceInstall: true,
        })
        return repaired?.executable || ''
      }
      const launcherNames = providerWindowNames(runtimeMetadata)
      const launcherCandidates = installedExecutables(runtimeMetadata)
      if (!launcherCandidates.includes(executable)) launcherCandidates.unshift(executable)
      const finishLaunch = (started) => {
        if (!started?.opened) return started
        const result = { ...started, args, version, savedBuild }
        if (id === 'reboot-official' && started.pid) {
          const gameExecutable =
            buildExecutable || (buildFolder ? findPrimaryExecutable(buildFolder) : '') || ''
          beginCompanionGameWatch({
            providerId: id,
            launcherPid: started.pid,
            launcherNames,
            gameExecutable,
          })
          result.waitingForGame = true
        }
        return result
      }
      try {
        const started = await startVisibleLauncher(launcherCandidates, args, repairRuntime, launcherNames)
        return finishLaunch(started)
      } catch (error) {
        return {
          opened: false,
          error: error instanceof Error ? error.message : `${profile.label} could not be started.`,
        }
      }
    }

    // Discord-only communities may have a companion launcher, but no public
    // HTTPS installer metadata. Detect it on this PC and start it when present;
    // otherwise fall through to the verified community handoff below.
    const launcherMetadata = providerCatalog().find((entry) => entry.id === id)?.launcher
    if (launcherMetadata) {
      const executable = installedExecutable(launcherMetadata)
      if (executable) {
        try {
          // No installer metadata exists for this community, so an early exit
          // is reported instead of being silently repaired.
          const started = await startVisibleLauncher(
            installedExecutables(launcherMetadata),
            [],
            null,
            providerWindowNames(launcherMetadata),
          )
          return started.opened ? { ...started, version: '' } : started
        } catch (error) {
          return {
            opened: false,
            error: error instanceof Error ? error.message : 'The community launcher could not be started.',
          }
        }
      }
    }

    // A community that publishes no launcher metadata has nothing VAULTED can
    // start. Report that as an in-app community step: the renderer opens its
    // community dialog on this PC. VAULTED never opens a website in a browser.
    const communityUrl = [profile.launchUrl, profile.website].find(
      (value) =>
        typeof value === 'string' &&
        /^https:\/\/(?:discord\.gg\/|discord\.com\/(?:invite|servers)\/)/i.test(value),
    )
    if (communityUrl) {
      return {
        opened: false,
        community: true,
        inviteUrl: communityUrl,
        error: `${profile.label} has no launcher installed on this PC. Open the ${profile.label} community step inside VAULTED, install its launcher there, then press Start again.`,
      }
    }

    return {
      opened: false,
      error: `${profile.label} does not publish a launcher that VAULTED can open, so online play stays unavailable on this PC.`,
    }
}

async function launchOnlineProvider(payload) {
  const id = typeof payload?.id === 'string' ? payload.id : ''
  // Provider identity is account-wide; casing or a legacy season suffix must
  // never create a second session or a second launch path.
  const providerId =
    typeof payload?.providerId === 'string'
      ? payload.providerId.trim().toLowerCase().split(':')[0]
      : ''
  if (!id || !providerId) throw new Error('Invalid online provider launch request.')
  if (running.has(id)) throw new Error('This season is already running.')

  const provider = providerForId(providerId)
  if (!provider) throw new Error('That online provider is not in the bundled catalog.')

  const folder =
    typeof payload?.buildFolderPath === 'string'
      ? payload.buildFolderPath
      : typeof payload?.path === 'string'
        ? payload.path
        : ''
  if (!folder) throw new Error('This season has not been downloaded yet.')

  let executable
  try {
    if (!fs.statSync(folder).isDirectory()) throw new Error('not a folder')
    // A repaired provider build lives directly under the managed season
    // folder. Prefer that executable over an older nested copy left by a
    // previous archive download.
    const direct = path.join(folder, 'FortniteGame', 'Binaries', 'Win64', CLIENT_EXE)
    executable = fs.existsSync(direct) ? direct : findPrimaryExecutable(folder)
  } catch {
    throw new Error('The downloaded season folder is incomplete. Download the season again from VAULTED.')
  }
  if (!executable) {
    throw new Error(
      'FortniteClient-Win64-Shipping.exe is missing from this season. Download the season again from VAULTED.',
    )
  }

  const profile = providerProfile(providerId)
  const seasonId = typeof payload?.seasonId === 'string' ? payload.seasonId : id
  const version = typeof payload?.version === 'string' ? payload.version : ''
  // External projects own their backend, sign-in and anticheat. VAULTED never
  // injects into them: it opens the documented launcher for the exact build,
  // the same handoff the season card's Start button uses. This runs before the
  // managed provider runtime checks, so a launcher-only community (ARC, Eon,
  // Hydro, …) opens cleanly even when no redirect DLL is involved.
  if (profile.mode === 'external' || profile.external === true) {
    const opened = await openProviderLauncherEntry(providerId, { version, folder, executable })
    if (!opened?.opened) throw new Error(opened?.error || `${profile.label} could not be opened.`)
    return {
      launched: false,
      gameStarted: false,
      openedLauncher: true,
      providerId,
      name: profile.name || provider.name,
      pid: opened.pid ?? null,
      external: true,
      companion: false,
    }
  }

  // Clear helpers and pipes a crashed or closed earlier session left behind so
  // this launch never inherits a stale injector or join target.
  await cleanupStaleSessionHelpers(providerId)
  await ensureRuntimeInstalled()
  // Repair an old or partially installed provider tree before the launch check
  // below can turn it into a missing-DLL dialog.
  await ensureProviderRedirects()
  // VAULTED no longer starts local lobby-only engines. Play is online-only;
  // seasons without a live route are shown as unavailable on their cards.
  if (profile.auth === 'none') {
    throw new Error(
      `${profile.label} has no online server available yet. The app owner is working hard to get this season online.`,
    )
  }
  const legacy = providerUsesLegacyRedirect(version, seasonId)
  const runtime = providerRuntime(profile, { legacy })
  const redirectDll = runtime.dll
  let redirectReady = false
  try {
    redirectReady = fs.statSync(redirectDll).isFile()
  } catch {
    /* the profile is scaffolded; the DLL may not have been dropped in yet */
  }
  if (!redirectReady) {
    throw new Error(
      `VAULTED could not prepare the ${profile.label} redirect DLL automatically.\n\n` +
        `The bundled redirect DLL is missing from this installation. Reinstall VAULTED.`,
    )
  }
  if (!redirectDllMatchesProfile(redirectDll, runtime.profile)) {
    throw new Error(
      `The ${profile.label} redirect DLL does not match the checksum of the DLL bundled with VAULTED.\n\n` +
        `Reinstall VAULTED to restore the validated provider files.`,
    )
  }
  if (!fs.existsSync(runtime.injector)) {
    throw new Error('The bundled open-source runtime injector is missing. Reinstall VAULTED.')
  }
  if (!redirectSupportsBackendParameter(redirectDll)) {
    throw new Error(
      `The ${profile.label} redirect DLL cannot be pointed at ${profile.backendUrl}.\n\n` +
        `${path.basename(redirectDll)} does not support the -backend= launch option. Reinstall VAULTED or update the bundled redirect build.`,
    )
  }

  const launchPayload = { ...payload, path: folder, executable }
  assertBuild(launchPayload)

  // A verified Discord OAuth session is the authorization for this launch.
  // Do not keep the pre-auth "handshake pending" gate in front of the live
  // exchange attempt after the player has completed that sign-in.
  let discordAuthorized = false
  if (profile.discordAuth === true) {
    try {
      discordAuthorized = providerAuth.status(providerId).signedIn === true
    } catch {
      discordAuthorized = false
    }
  }
  if (profile.launchHandshakePending && !discordAuthorized) {
    throw new Error(
      `${profile.label} is signed in, but its launch handshake is pending. VAULTED has no verified game-code exchange for this provider yet.`,
    )
  }
  if (!['oauth', 'embedded_web', 'deeplink'].includes(profile.auth)) {
    throw new Error(
      `VAULTED requires verified in-app sign-in for ${profile.label}. Manual provider codes are no longer supported.`,
    )
  }

  let authCode = ''
  let authToken = ''
  // The verified Era gateway socket must outlive exchange-code. Keep its
  // main-process handle until the client process exits; never send it to the
  // renderer or close it after build.verify.
  let realtimeSession = null
  {
    // Rotate the stored session token before the exchange. A token that expired
    // between pressing Start and the login is the usual start of a session that
    // stops accepting locker saves and matchmaking tickets later on.
    try {
      const refreshed = await providerAuth.refreshSession(providerId)
      if (refreshed?.refreshed) {
        console.log(`[VAULTED] ${profile.label} session token refreshed before launch.`)
      }
    } catch (error) {
      console.warn(
        `[VAULTED] ${profile.label} pre-launch token refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    const requestExchange = () =>
      providerAuth.exchangeCode(providerId, {
        seasonId,
        version,
        // Era gates exchange-code on its realtime build.verify operation. Pass
        // the exact installed folder so providerAuth can hash the same
        // executable/PAK files the official launcher verifies.
        buildPath: folder,
      })
    try {
      let exchange
      try {
        exchange = await requestExchange()
      } catch (error) {
        // A 401/expired session must not end the launch: rotate the token once
        // and retry, then report the real reason if it still fails.
        const expiry = sessionExpiryCode(error)
        if (!expiry) throw error
        console.warn(
          `[VAULTED] ${profile.label} login rejected the session (${expiry}); refreshing and retrying once.`,
        )
        await providerAuth.refreshSession(providerId)
        exchange = await requestExchange()
      }
      realtimeSession = exchange.realtimeSession || null
      authToken = typeof exchange.authToken === 'string' ? exchange.authToken : ''
      authCode = normalizeProviderAuthCode(exchange.code)
      if (!authCode) {
        realtimeSession?.close('invalid login code')
        throw new Error('The provider returned an invalid login code.')
      }
    } catch (error) {
      realtimeSession?.close('exchange failed')
      const buildIssue = providerBuildIssue(profile, error)
      if (buildIssue) {
        // A build integrity rejection is not an account-status issue. Keep it
        // separate so the card can offer the exact live-build repair instead of
        // an account-verification button.
        throw new Error(
          `${buildIssue.message}\n${PROVIDER_BUILD_STATUS_PREFIX}${JSON.stringify(buildIssue)}`,
        )
      }
      const issue = providerAccountIssue(profile, error)
      if (issue) {
        // Keep the friendly explanation first, then carry an opaque marker so the
        // renderer can offer the correct account action without exposing a raw
        // verification code or losing the status through Electron IPC.
        throw new Error(
          `${issue.message}\n${PROVIDER_ACCOUNT_STATUS_PREFIX}${JSON.stringify(issue)}`,
        )
      }
      throw new Error(
        `VAULTED could not get a fresh ${profile.label} login code.\n\n` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const join = joinTargetFromPayload(payload)
  if (join) writeJoinTarget(join.host, join.port)
  else clearJoinTarget()

  // The packaged redirect DLL needs to observe the game's HTTP stack. Route
  // the game through a loopback origin so the bridge can keep Era's periodic
  // account reads from logging the lobby out, while the realtime session
  // registers the running process for matchmaking.
  let backendUrl = profile.backendUrl
  let eraBridge = null
  if (providerId === 'era') {
    try {
      const account = providerAuth.status('era')
      eraBridge = await createEraBridge({
        upstream: profile.backendUrl,
        accountId: account.accountId || '',
        displayName: account.displayName || '',
        onSessionKilled: () =>
          realtimeSession?.refresh('game login killed the launcher session'),
        // Era requires a live client-presence lease for matchmaking session
        // lookup. Reassert it at verify and immediately before FindSingleSession
        // instead of letting a long queue consume the lease.
        onPresenceRequired: (force = false) =>
          realtimeSession?.reassertPresence?.('matchmaking requested presence', force === true) ??
          Promise.resolve(false),
      })
      backendUrl = eraBridge.url
    } catch (error) {
      await eraBridge?.close()
      realtimeSession?.close('Era client bridge failed')
      throw new Error(
        `VAULTED could not prepare Era's client bridge.\n\n${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const providerArgs = providerFortniteArgs(backendUrl, authCode, providerId, authToken)
  logProviderLaunchDiagnostic(
    providerLaunchDiagnostic({
      providerId,
      buildId: id,
      seasonId,
      version,
      args: providerArgs,
      backendUrl,
      authCode,
      authToken,
    }),
  )

  // (a) The companion launcher starts first: its auth, session heartbeat and
  // matchmaking bridge must be live before the client. It stays up for the
  // whole game session and is only closed by Stop or by the game exiting.
  const companionLauncher = await startCompanionLauncher(providerId)

  const restoreEnvironment = applyProviderEnvironmentBypass()
  let launched
  try {
    launched = await launchInjectedGame(launchPayload, {
      injector: runtime.injector,
      dll: redirectDll,
      args: providerArgs,
      env: {
        VAULTED_PROVIDER_ID: providerId,
        // Retained for diagnostics; the redirect itself receives -backend= below.
        VAULTED_PROVIDER_BACKEND_URL: backendUrl,
        VAULTED_PROVIDER_CONFIG: profile.configPath,
        VAULTED_PROVIDER_DLL: redirectDll,
        VAULTED_SEASON_ID: seasonId,
        VAULTED_BUILD_VERSION: version,
        VAULTED_BUILD_FOLDER: folder,
        ...(join
          ? {
              VAULTED_JOIN_FILE: joinTargetPath(),
              VAULTED_PUBLIC_SERVER_HOST: join.host,
              VAULTED_PUBLIC_SERVER_PORT: String(join.port),
            }
          : {}),
      },
    })
  } catch (error) {
    realtimeSession?.close('game launch failed')
    void eraBridge?.close()
    // The game never started, so there is no session for the launcher to keep
    // alive: close it instead of leaving it running with no client.
    await closeCompanionLauncherForProvider(providerId)
    restoreEnvironment()
    throw error
  }
  restoreEnvironmentWhenClientExits(launched.pid, restoreEnvironment)
  // (c) Bind the exact client PID the injector reported: the launcher monitor
  // keeps the launcher while that PID lives or any client process is found, and
  // closes it only after every FortniteClient-Win64-Shipping.exe process has
  // really exited.
  attachCompanionGameProcess(providerId, launched.pid)

  // Keep the provider session alive for the entire client lifetime: a token
  // that expires mid-game is exactly what makes locker saves and matchmaking
  // tickets stop working long after the launch itself succeeded.
  startProviderSessionHeartbeat(providerId, launched.pid, profile.label)

  // Attach only after the real client PID exists. The session polls that PID
  // and closes exactly once it disappears, so a launcher-side exchange failure
  // or a crashed launch cannot leave an orphaned gateway socket behind.
  realtimeSession?.attachGameProcess(launched.pid)

  const startedAt = Date.now()
  const entry = {
    pid: launched.pid,
    injectorPid: launched.child.pid ?? null,
    startedAt,
    expectedExecutable: executable,
    external: false,
    providerId,
    companionLauncherPid: companionLauncher?.pid ?? null,
    realtimeSession,
    eraBridge,
  }
  running.set(id, entry)
  launched.child.once('exit', (code, signal) => {
    if (running.get(id) !== entry) return
    void entry.eraBridge?.close()
    stopProviderSessionHeartbeat(providerId, 'game process exited')
    realtimeSession?.close('game process exited')
    running.delete(id)
    clearJoinTarget()
    const expected = expectedBuildCloses.delete(id)
    send('arc:build-exited', {
      id,
      code: Number.isInteger(code) ? code : null,
      signal: signal ?? null,
      durationMs: Math.max(0, Date.now() - startedAt),
      expected,
      reason: expected ? 'closed-by-app' : code ? 'injector-failed' : 'client-closed',
    })
  })

  return {
    installed: true,
    launched: true,
    providerId,
    name: profile.name,
    pid: launched.pid,
    hookVerified: launched.hookVerified === true,
    privateServer: false,
    matchmaking: Boolean(join),
    joined: join ? `${join.host}:${join.port}` : null,
    external: false,
    provider: providerId,
    companionLauncherPid: companionLauncher?.pid ?? null,
  }
}

function privateIpAddress(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (mapped) return privateIpAddress(mapped[1])
  if (host.includes(':')) {
    return host === '::' || host === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/i.test(host)
  }
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
  if (parts[0] >= 224) return true
  return false
}

function pingHost(host) {
  return new Promise((resolve) => {
    const args =
      process.platform === 'win32'
        ? ['-n', '1', '-w', '1400', host]
        : ['-c', '1', '-W', '2', host]
    execFile('ping', args, { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      if (error) return resolve(undefined)
      const text = String(stdout || '')
      const match = /(?:time[=<]\s*)([\d.]+)\s*ms/i.exec(text)
      if (match && Number.isFinite(Number(match[1]))) return resolve(Math.max(0, Math.round(Number(match[1]))))
      resolve(0)
    })
  })
}

async function probeCommunityAddress(inputHost, inputPort) {
  const parsed = normalizeHostPort(
    Number(inputPort) ? `${inputHost}:${inputPort}` : String(inputHost || ''),
    7777,
  )
  if (!parsed || !/^[A-Za-z0-9.-]{1,253}$/.test(parsed.host)) {
    return { reachable: false, error: 'Enter a public server address as ip:port.' }
  }
  if (privateIpAddress(parsed.host)) {
    return { reachable: false, error: 'Use a public internet address, not localhost or a LAN IP.' }
  }
  try {
    const records = await dns.promises.lookup(parsed.host, { all: true, verbatim: true })
    if (records.some((record) => privateIpAddress(record.address))) {
      return { reachable: false, error: 'That hostname resolves to a private network address.' }
    }
  } catch {
    return { reachable: false, error: 'That hostname could not be resolved.' }
  }

  const tcpPing = await probePing(parsed.host, parsed.port, 900)
  if (tcpPing !== undefined) {
    return { reachable: true, pingMs: tcpPing, host: parsed.host, port: parsed.port, method: 'tcp' }
  }
  const icmpPing = await pingHost(parsed.host)
  if (icmpPing !== undefined) {
    return { reachable: true, pingMs: icmpPing, host: parsed.host, port: parsed.port, method: 'icmp' }
  }
  return {
    reachable: false,
    error: 'The host did not answer a TCP probe or ping. Check the IP and port, then try again.',
    host: parsed.host,
    port: parsed.port,
  }
}

function registerIpc() {
  ipcMain.handle('arc:check-builds', (_event, builds) => {
    /** @type {Record<string, boolean>} */
    const result = {}
    for (const build of Array.isArray(builds) ? builds : []) {
      if (!build || typeof build.id !== 'string') continue
      result[build.id] =
        typeof build.executable === 'string' &&
        typeof build.path === 'string' &&
        fs.existsSync(build.executable) &&
        fs.existsSync(build.path)
    }
    return result
  })

  ipcMain.handle('arc:download-build', (_event, payload) => downloadBuild(payload))
  ipcMain.handle('arc:sync-provider-build', (_event, payload) => syncProviderBuild(payload))
  ipcMain.handle('arc:list-interrupted-downloads', () => listInterruptedDownloads())

  ipcMain.handle('arc:cleanup-build-storage', () => cleanupManagedBuildStorage())

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
    folderSizeCache.delete(path.resolve(managedFolder))
    folderSizeCache.delete(path.resolve(payload.path))
    return { deleted: true, managed: true }
  })

  ipcMain.handle('arc:verify-build', (_event, payload) => verifyBuild(payload))
  ipcMain.handle('arc:autofix-scan', (_event, payload) => autoFixScan(payload))
  ipcMain.handle('arc:autofix-repair', (_event, payload) => autoFixRepair(payload))

  ipcMain.handle('arc:scan-builds', (_event, roots) => scanForBuilds(roots))

  ipcMain.handle('arc:profiles-read', () => readProfilesFile())
  ipcMain.handle('arc:profiles-save', (_event, next) => writeProfilesFile(next))

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

  ipcMain.handle('arc:pause-download', async (_event, payload) => {
    const id = String(payload?.id)
    const controller = downloads.get(id)
    if (!controller) return { paused: false }

    controller.abort()
    // downloadBuild persists its metadata in its finally block. Wait briefly
    // so clicking Continue straight after Pause cannot race that cleanup.
    const deadline = Date.now() + 5000
    while (downloads.has(id) && Date.now() < deadline) await delay(25)
    return { paused: true }
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
    // The same pre-launch cleanup applies to VAULTED's own direct path: a
    // leftover injector from an earlier session must not shadow this launch.
    await cleanupStaleSessionHelpers()
    await ensureRuntimeInstalled()

    const id = typeof payload.id === 'string' ? payload.id : null
    let join = joinTargetFromPayload(payload)
    const localHost = false
    if (!join) {
      throw new Error(
        'Online play is not available for this season yet. The app owner is working hard to get it online.',
      )
    }
    const joinFallback = join && payload.joinFallback === true
    if (id) stopJoinWatchdog(id)
    let injector = null
    let gamePid = null
    let matchmakingReady = false

    try {
      send('arc:launch-status', {
        id: id ?? undefined,
        message: localHost ? 'Starting the VAULTED game server…' : 'Connecting to the live server…',
      })
      writeJoinTarget(join.host, join.port)
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
        const entry = {
          pid: gamePid,
          injectorPid: injector.pid ?? null,
          startedAt: Date.now(),
          expectedExecutable: payload.executable,
        }
        running.set(id, entry)
        injector.on('exit', (code, signal) => {
          // A late exit from a replaced client must not tear down the new
          // fallback host or report a second, unrelated close.
          if (running.get(id) !== entry) return
          stopJoinWatchdog(id)
          running.delete(id)
          const expected = expectedBuildCloses.delete(id)
          const durationMs = Math.max(0, Date.now() - entry.startedAt)
          const log = expected ? '' : summarizeClientExit(entry.startedAt, entry.expectedExecutable)
          send('arc:build-exited', {
            id,
            code: Number.isInteger(code) ? code : null,
            signal: signal ?? null,
            durationMs,
            expected,
            reason: expected ? 'closed-by-app' : code ? 'injector-failed' : 'client-closed',
            log,
          })
          if (running.size === 0) {
            clearJoinTarget()
            if (gameServerState) void stopGameServer()
            else void stopStaleVaultedClients()
          }
        })
      }

      send('arc:launch-status', {
        id: id ?? undefined,
        message: `Joining ${join.host}:${join.port}…`,
      })

      send('arc:launch-status', { id: id ?? undefined, message: 'Starting Fortnite…' })
      const launched = await launchInjectedGame(payload)
      const playerStartedAt = Date.now()
      registerPlayer(launched)

      // The launch resolves before the client has connected to the remote
      // lobby. Keep watching the log so a host that disappears during loading
      // triggers a local-host retry instead of leaving Play stuck.
      if (joinFallback && gamePid) {
        startJoinWatchdog({
          id,
          pid: gamePid,
          join,
          startedAt: playerStartedAt,
          expectedExecutable: payload.executable,
        })
      }

      send('arc:launch-status', { id: id ?? undefined, message: 'Signing in to the private server…' })
      return {
        pid: gamePid,
        privateServer: localHost,
        matchmaking: matchmakingReady,
        joined: `${join.host}:${join.port}`,
      }
    } catch (error) {
      if (id) stopJoinWatchdog(id)
      if (gamePid) await killProcessTree(gamePid)
      if (injector?.pid) await killProcessTree(injector.pid)
      if (id) running.delete(id)
      if (running.size === 0 && gameServerState) await stopGameServer()
      throw error
    }
  })

  ipcMain.handle('arc:online-provider-launch', (_event, payload) =>
    launchOnlineProvider(payload),
  )

  // External communities are opened through the documented entry point in
  // provider.json. VAULTED does not inject credentials or fake a launcher
  // handshake; the project owns its sign-in, anticheat and season selection.
  ipcMain.handle('arc:open-provider-launcher', (_event, providerId, options = {}) =>
    openProviderLauncherEntry(providerId, options),
  )

  ipcMain.handle('arc:provider-launcher-status', () =>
    [...providerLaunchers.entries()].map(([providerId, entry]) => ({
      providerId,
      pid: entry.pid,
      startedAt: new Date(entry.startedAt).toISOString(),
    })),
  )

  ipcMain.handle('arc:stop-provider-launcher', async (_event, providerId) => ({
    stopped: await closeCompanionLauncherForProvider(providerId),
  }))

  ipcMain.handle('arc:provider-runtime-status', (_event, providerId) =>
    providerRuntimeStatus(providerId),
  )

  ipcMain.handle('arc:provider-launcher-detect', (_event, providerId) =>
    providerLauncherStatus(providerId),
  )

  ipcMain.handle('arc:install-provider-runtime', async (_event, providerId) => {
    const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : ''
    const metadata = providerRuntimeMetadata(id)
    if (!metadata) throw new Error('That provider has no companion runtime.')
    try {
      // Stage the DLLs this launcher and its seasons need while the download
      // step is still on screen, so Play never prepares files itself.
      send('arc:runtime-progress', {
        providerId: id,
        label: metadata.label,
        phase: 'dlls',
        percent: null,
        received: 0,
        total: 0,
        etaSeconds: null,
        bytesPerSecond: null,
      })
      const stagedBefore = await stageSeasonLauncherDlls(id)
      const result = await ensureProviderRuntime(id, metadata, {
        root: path.join(app.getPath('userData'), 'provider-runtimes'),
        report: (progress) =>
          send('arc:runtime-progress', {
            providerId: id,
            label: metadata.label,
            ...progress,
            phase: progress.phase === 'installing' ? 'installing' : 'downloading',
          }),
      })
      // Verify again after the installer ran: the launcher is only announced
      // as ready once every DLL is staged and hash-checked.
      const stagedAfter = await stageSeasonLauncherDlls(id)
      send('arc:runtime-progress', {
        providerId: id,
        label: metadata.label,
        phase: 'done',
        percent: 100,
        received: 0,
        total: 0,
        etaSeconds: null,
        bytesPerSecond: null,
      })
      return {
        ok: true,
        providerId: id,
        label: metadata.label,
        version: result.version,
        installed: result.installed,
        dlls: [...new Set([...stagedBefore.staged, ...stagedAfter.staged].map((item) => item.name))],
      }
    } catch (error) {
      send('arc:runtime-progress', {
        providerId: id,
        label: metadata.label,
        phase: 'error',
        percent: null,
        received: 0,
        total: 0,
        etaSeconds: null,
        bytesPerSecond: null,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })

  ipcMain.handle('arc:provider-catalog', () => providerCatalog())

  // Discord-gated communities are verified from their public invite metadata.
  // The renderer never receives a Discord token; launch still uses the season's
  // normal provider auth and redirect DLL path after this gate is unlocked.
  ipcMain.handle('arc:discord-gate-verify', async (_event, providerId) => {
    const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : ''
    if (!id) throw new Error('Invalid Discord community request.')
    const profile = providerProfile(id)
    if (!profile.discordGate) {
      throw new Error(`${profile.label} does not use a Discord community gate.`)
    }
    return verifyDiscordCommunity(profile.discordGate)
  })

  ipcMain.handle('arc:provider-auth-status', () => providerAuth.statuses())

  // Backend health is deliberately checked in main, where the provider catalog
  // is trusted and the renderer cannot turn this into an arbitrary URL fetch.
  // Local download engines are sampled too so every season can report its own
  // live status without exposing which engine is behind it.
  ipcMain.handle('arc:provider-live-status', () =>
    fetchProviderLiveStatuses(providerCatalog()),
  )

  // Prepare the hash-checked bundled provider files before a one-click launch.
  // This only repairs VAULTED's own signed resources into its app cache; it
  // never downloads a DLL or patch from a third-party launcher.
  ipcMain.handle('arc:provider-prepare', async (_event, providerId) => {
    const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : ''
    if (!id) throw new Error('Invalid provider preparation request.')
    const profile = providerProfile(id)
    // Verifying an already-installed launcher stages the same DLLs its install
    // step would, so an existing install is never left unprepared.
    const staged = await stageSeasonLauncherDlls(id)
    const dlls = [...new Set(staged.staged.map((item) => item.name))]
    if (profile.mode === 'external') {
      return { ok: true, providerId: id, label: profile.label, cached: true, external: true, dlls }
    }
    const runtime = providerRuntime(profile)
    if (!fs.existsSync(runtime.injector)) {
      throw new Error(`The bundled runtime injector for ${profile.label} is missing. Reinstall VAULTED.`)
    }
    if (!fs.existsSync(runtime.dll) || !redirectDllMatchesProfile(runtime.dll, runtime.profile)) {
      throw new Error(`VAULTED could not verify the bundled ${profile.label} redirect DLL.`)
    }
    return { ok: true, providerId: id, label: profile.label, cached: true, dlls }
  })

  // Live build discovery is authenticated in main. The renderer supplies only
  // a provider id, never a URL or a season/build id.
  ipcMain.handle('arc:provider-builds', (_event, providerId) => providerAuth.listBuilds(providerId))

  const broadcastProviderAuth = (status) => {
    if (!status?.providerId) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('arc:provider-auth-changed', status)
    }
  }

  ipcMain.handle('arc:provider-auth-login', async (_event, providerId, method) => {
    const status = await providerAuth.login(providerId, { method })
    broadcastProviderAuth(status)
    return status
  })

  // Called silently by Play and the full Verify repair pipeline before any
  // socket/exchange handshake. It rotates the encrypted refresh token without
  // opening a browser; a hard rejection returns the structured re-auth marker.
  ipcMain.handle('arc:provider-auth-refresh', async (_event, providerId) => {
    try {
      const status = await providerAuth.refreshSession(providerId)
      broadcastProviderAuth(status)
      return status
    } catch (error) {
      let profile = null
      try {
        profile = providerProfile(providerId)
      } catch {
        /* invalid provider id keeps the original error */
      }
      const issue = providerAccountIssue(profile, error)
      if (issue) {
        throw new Error(
          `${issue.message}\n${PROVIDER_ACCOUNT_STATUS_PREFIX}${JSON.stringify(issue)}`,
        )
      }
      throw error
    }
  })

  // Opening the embedded verification view is never part of Play. It is only
  // reached after the renderer's explicit Verify Account action, and
  // providerAuth requires a pending provider-supplied HTTPS URL for this launch.
  ipcMain.handle('arc:provider-auth-verify-account', async (_event, providerId, options) => {
    try {
      const result = await providerAuth.verifyAccount(providerId, options || {})
      broadcastProviderAuth(providerAuth.status(providerId))
      return result
    } catch (error) {
      let profile = null
      try {
        profile = providerProfile(providerId)
      } catch {
        /* the provider profile may not exist for an invalid id */
      }
      const issue = providerAccountIssue(profile, error)
      if (issue) {
        throw new Error(
          `${issue.message}\n${PROVIDER_ACCOUNT_STATUS_PREFIX}${JSON.stringify(issue)}`,
        )
      }
      throw error
    }
  })

  ipcMain.handle('arc:provider-auth-logout', async (_event, providerId) => {
    const status = await providerAuth.logout(providerId)
    broadcastProviderAuth(status)
    return status
  })

  ipcMain.on('arc:provider-auth-close', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    if (sender && sender !== mainWindow) sender.close()
  })

  ipcMain.handle('arc:probe-server', (_event, payload) =>
    probeCommunityAddress(payload?.host, payload?.port),
  )

  /** Public community directories are allowlisted in resources/providers. */
  ipcMain.handle('arc:community-servers', async (_event, payload) => {
    try {
      return await fetchCommunityServers({
        token: typeof payload?.token === 'string' ? payload.token : '',
        seasonId: typeof payload?.seasonId === 'string' ? payload.seasonId : '',
        providerId: typeof payload?.providerId === 'string' ? payload.providerId : '',
        force: payload?.force === true,
      })
    } catch (error) {
      return {
        servers: [],
        statuses: [],
        directories: [],
        errors: [{ endpoint: 'community', message: error instanceof Error ? error.message : 'Community discovery failed.' }],
        checkedAt: new Date().toISOString(),
      }
    }
  })

  ipcMain.handle('arc:close-build', async (_event, payload) => {
    const id = String(payload?.id ?? '')
    stopJoinWatchdog(id)
    const entry = running.get(id)
    if (!entry?.pid) return { closed: false }

    // Mark this exit before the close reaches the injector's exit event. The
    // UI already knows about a user-requested close and should not show a
    // crash message.
    expectedBuildCloses.add(id)
    await closeProcessTreeGracefully(entry.pid)
    // Stop is the one close path that does not wait for the game to exit:
    // the season's companion launcher goes down with it.
    await closeCompanionLauncherForProvider(entry.providerId)
    void entry.eraBridge?.close()
    entry.realtimeSession?.close('game process closed by app')

    running.delete(id)
    expectedBuildCloses.delete(id)
    if (running.size === 0) {
      clearJoinTarget()
      if (gameServerState) await stopGameServer()
      else await stopStaleVaultedClients()
    }
    return { closed: true }
  })

  ipcMain.handle('arc:lan-ip', () => lanAddress())
  ipcMain.handle('arc:public-address', () => resolvePublicAddress())
  ipcMain.handle('arc:session-status', () => readSessionStatus())
  ipcMain.handle('arc:get-public-address', () => {
    const manual = readPublicOverride()
    return manual ? `${manual.address}:${manual.port}` : ''
  })
  ipcMain.handle('arc:set-public-address', (_event, value) => setPublicOverride(value))

  ipcMain.handle('arc:builds-root', () => buildsRoot())
  ipcMain.handle('arc:settings-read', () => readAppSettings())
  ipcMain.handle('arc:settings-save', (_event, next) => writeAppSettings(next))

  ipcMain.handle('arc:fetch-text', async (_event, rawUrl, options) => {
    const url = String(rawUrl || '')
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, status: 0, url, text: '', error: 'Only http(s) URLs are supported.' }
    }
    const headers = { 'cache-control': 'no-cache' }
    const method = options?.method === 'POST' ? 'POST' : 'GET'
    if (method === 'POST') headers['content-type'] = 'application/json'
    const body = method === 'POST' && typeof options?.body === 'string' ? options.body : undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: controller.signal,
        headers,
      })
      const text = await response.text()
      return {
        ok: response.ok,
        status: response.status,
        url: response.url || url,
        text: text.slice(0, 5_000_000),
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        url,
        text: '',
        error: error instanceof Error ? error.message : 'Could not fetch that URL.',
      }
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('arc:pick-install-dir', async () => {
    const parent = mainWindow ?? undefined
    const options = {
      title: 'Select the default install folder',
      buttonLabel: 'Use this folder',
      defaultPath: buildsRoot(),
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('arc:pick-executable', async () => {
    const parent = mainWindow ?? undefined
    const options = {
      title: 'Select the default client executable',
      buttonLabel: 'Use this executable',
      properties: ['openFile'],
      filters: [
        { name: 'Windows executables', extensions: ['exe'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('arc:pick-builds-root', async () => {
    const parent = mainWindow ?? undefined
    const profiles = readProfilesFile()
    const options = {
      title: 'Select the default builds root',
      buttonLabel: 'Use this folder',
      defaultPath:
        typeof profiles?.defaultBuildsRoot === 'string' && profiles.defaultBuildsRoot.trim()
          ? profiles.defaultBuildsRoot
          : buildsRoot(),
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
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

  ipcMain.handle('arc:link-build-folder', async () => {
    const parent = mainWindow ?? undefined
    const options = {
      title: 'Link an existing Fortnite season folder',
      buttonLabel: 'Link this folder',
      properties: ['openDirectory'],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null

    const picked = result.filePaths[0]
    const executable = findExecutable(picked)
    if (!executable) {
      return {
        ok: false,
        error: 'FortniteClient-Win64-Shipping.exe was not found in that folder. Pick the build root or its FortniteGame\\Binaries\\Win64 folder.',
      }
    }

    return { ok: true, folder: folderForExecutable(executable), executable }
  })

  ipcMain.handle('arc:build-size', (_event, folder) => {
    if (typeof folder !== 'string' || !folder.trim()) return null
    return folderSize(folder)
  })

  ipcMain.handle('arc:open-build-folder', async (_event, folder) => {
    if (typeof folder !== 'string' || !folder.trim()) return { ok: false, error: 'No install folder.' }
    try {
      const stat = await fs.promises.stat(folder)
      if (!stat.isDirectory()) return { ok: false, error: 'That install folder no longer exists.' }
      const error = await shell.openPath(folder)
      return error ? { ok: false, error } : { ok: true }
    } catch {
      return { ok: false, error: 'That install folder no longer exists.' }
    }
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
          repair: SMOKE_REPAIR,
          preferredFolder: SMOKE_PREFERRED_FOLDER || undefined,
          providerId: SMOKE_PROVIDER_ID || undefined,
          seasonId: SMOKE_SEASON_ID || undefined,
          buildId: SMOKE_BUILD_ID || undefined,
          validateProvider: Boolean(SMOKE_PROVIDER_ID && SMOKE_BUILD_ID),
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

app.whenReady().then(async () => {
  // The runtime lives in app data so upgrades refresh it in one place. Copy it
  // before a download or Play can use it, and never block the UI on failure:
  // the launch handler reports a precise missing-file message instead.
  try {
    await ensureRuntimeInstalled()
  } catch (error) {
    console.warn(`[VAULTED] Could not refresh the bundled runtime: ${error instanceof Error ? error.message : error}`)
  }

  // Provider redirect DLLs are self-healing too. This runs without blocking
  // startup; provider launch awaits the same singleton before injecting.
  void ensureProviderRedirects()
    .then((report) => {
      if (report.errors.length > 0) {
        console.warn(`[VAULTED] Provider redirect repair: ${report.errors.map((item) => `${item.id}: ${item.error}`).join('; ')}`)
      }
    })
    .catch((error) => {
      console.warn(`[VAULTED] Could not repair provider redirect DLLs: ${error instanceof Error ? error.message : error}`)
    })

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
