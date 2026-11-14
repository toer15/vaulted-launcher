const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn, execFile } = require('node:child_process')

const DEV = process.argv.includes('--dev')
const SMOKE = process.argv.includes('--smoke')
/** set to a direct archive URL to exercise the downloader in smoke mode */
const SMOKE_URL = process.env.RIFT_SMOKE_URL ?? ''
/** e.g. RIFT_SMOKE_SIZE=1600x900 — lets the smoke capture use a larger window */
const SMOKE_SIZE = process.env.RIFT_SMOKE_SIZE ?? ''

/** @type {BrowserWindow | null} */
let mainWindow = null

/** buildId -> { pid } */
const running = new Map()
/** buildId -> AbortController */
const downloads = new Map()

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
  if (depth > 6) return null

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
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    'C:\\Fortnite Builds',
    'D:\\Fortnite Builds',
    path.join(app.getPath('userData'), 'builds'),
  ]

  const found = []
  const seen = new Set()
  let budget = 6000

  const walk = (dir, depth) => {
    if (budget <= 0 || depth > 5) return

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

function extractZip(zipPath, destination) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Automatic .zip extraction is currently Windows-only. Unpack it and point VAULTED at the folder.'))
  }

  const quote = (value) => value.replace(/'/g, "''")
  const script = `Expand-Archive -LiteralPath '${quote(zipPath)}' -DestinationPath '${quote(destination)}' -Force`

  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
      (error) => (error ? reject(new Error(`Could not extract the archive: ${error.message}`)) : resolve()),
    )
  })
}

/**
 * Streams an archive to disk, reports progress, unpacks .zip files and locates
 * the client executable. Used by the IPC handler and by the smoke test.
 */
async function downloadBuild(payload) {
  const { id, key, url } = payload ?? {}
  if (typeof id !== 'string' || !id) throw new Error('Invalid download request.')

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
  await fs.promises.mkdir(targetDir, { recursive: true })

  const controller = new AbortController()
  downloads.set(id, controller)
  let lastLogged = -20

  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'VAULTED-Launcher/1.0' },
    })

    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)
    if (!response.body) throw new Error('The server returned an empty response.')

    const total = Number(response.headers.get('content-length') ?? 0)
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'build.zip')
    const filePath = path.join(targetDir, name)

    const handle = await fs.promises.open(filePath, 'w')
    let received = 0
    send('arc:download-progress', { id, received, total, percent: total ? 0 : null, phase: 'downloading' })

    try {
      for await (const chunk of response.body) {
        await handle.write(chunk)
        received += chunk.length
        const percent = total ? Math.min(100, Math.round((received / total) * 100)) : null

        send('arc:download-progress', { id, received, total, percent, phase: 'downloading' })

        if (SMOKE_URL && (percent === null || percent - lastLogged >= 20 || percent === 100)) {
          lastLogged = percent ?? lastLogged
          smokeLog(`download progress ${percent ?? '?'}% (${received}/${total} bytes)`)
        }
      }
    } finally {
      await handle.close()
    }

    send('arc:download-progress', { id, received, total, percent: 100, phase: 'extracting' })
    if (SMOKE_URL) smokeLog('download complete, extracting')

    if (/\.zip$/i.test(name)) {
      await extractZip(filePath, targetDir)
    }

    const executable = findExecutable(targetDir)
    return {
      filePath,
      executable,
      folder: executable ? folderForExecutable(executable) : targetDir,
    }
  } finally {
    downloads.delete(id)
  }
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
    const controller = downloads.get(String(payload?.id))
    if (!controller) return { cancelled: false }
    controller.abort()
    downloads.delete(String(payload?.id))
    return { cancelled: true }
  })

  ipcMain.handle('arc:launch-build', async (_event, payload) => {
    assertBuild(payload)

    const id = typeof payload.id === 'string' ? payload.id : null
    const child = spawn(payload.executable, [], {
      cwd: payload.path,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    if (id) {
      running.set(id, { pid: child.pid ?? null })
      child.on('exit', () => {
        running.delete(id)
        send('arc:build-exited', { id })
      })
    }

    return { pid: child.pid ?? null }
  })

  ipcMain.handle('arc:close-build', async (_event, payload) => {
    const id = String(payload?.id ?? '')
    const entry = running.get(id)
    if (!entry?.pid) return { closed: false }

    await new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      } else {
        try {
          process.kill(entry.pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
        resolve()
      }
    })

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
        const result = await downloadBuild({ id: 'smoke-build', key: 'smoke-build', url: SMOKE_URL })
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

app.whenReady().then(() => {
  if (SMOKE) {
    smokeLog('app ready; argv=' + JSON.stringify(process.argv))
    app.on('render-process-gone', (_event, _contents, details) => smokeLog('render gone: ' + JSON.stringify(details)))
  }

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
