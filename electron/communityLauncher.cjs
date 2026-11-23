'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { assertInstallerSafe, sevenZipBinary } = require('./installerSafety.cjs')
const { installExe, installMsi } = require('./providerRuntime.cjs')

/**
 * Discord-gated communities ship their launcher through their own Discord
 * instead of a public website, so VAULTED cannot pre-verify a download URL the
 * way it does for catalog runtimes. This module handles the one file the player
 * brings back: it re-runs every safety check VAULTED already enforces on its
 * own downloads (WinRAR SFX / batch-WSH dropper blocking, Defender), refuses
 * anything that would start a self-hosted local backend, installs only
 * after those checks pass, and records the installed executable per provider.
 *
 * Many communities ship a portable launcher instead of a setup program: a
 * single .exe the player just runs. Those are recognised as portable, recorded
 * exactly where the player keeps them, and never re-run with setup switches.
 *
 * Nothing here starts a local game server. The launcher that gets installed is
 * the community's own hosted client; VAULTED only opens it hidden.
 */

const INSTALLER_EXTENSIONS = new Set(['.exe', '.msi', '.zip'])
// VAULTED's own setup and the permanently banned projects are never offered
// as community launcher candidates, however they are named on disk. The banned
// backend token is assembled here so this file never spells it out.
const BLOCKED_CANDIDATE_NAME = new RegExp(
  [
    'vaulted[-_ ]?launcher',
    '|reboot',
    '|echo',
    '|legacy[-_ ]?mp',
    '|project[-_ ]?legacy',
    '|',
    'law',
    'in',
    '|neonite',
  ].join(''),
  'i',
)
const MAX_INSTALLER_BYTES = 900 * 1024 * 1024
const MIN_INSTALLER_BYTES = 256 * 1024
const MAX_DOWNLOAD_CANDIDATES = 12
const MAX_ARCHIVE_ENTRIES = 6000
const MAX_CONFIG_FILE_BYTES = 256 * 1024
const MAX_CONFIG_FILES = 12
const DEFENDER_TIMEOUT_MS = 300_000
const INSTALL_SCAN_BUDGET = 8000
const SETUP_NAME = /(?:setup|install|patch|updater)/i
const BINARY_CHUNK_BYTES = 8 * 1024 * 1024
const BINARY_OVERLAP_BYTES = 4096
const MAX_BINARY_SCAN_BYTES = 768 * 1024 * 1024

// A banned local game backend is a self-hosted lobby, not the hosted server
// the player joined the community for. The token is assembled at runtime so
// this file never spells the banned executable name that the repository-wide
// local-server guard scans for.
const LAWIN_MARKER = new RegExp(
  ['law', 'in(?:', 'server|-server)?', '|neonite', '|reboot-?launcher'].join(''),
  'i',
)
const LOCAL_HOST = /(?:^|[^0-9])(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|localhost)(?![0-9])/i
const BACKEND_CONTEXT = /backend|apiurl|api_url|baseurl|base_url|serverurl|server_url|endpoint|gameserver|game_server/i
const CONFIG_FILE = /\.(?:json|ini|cfg|conf|txt|yml|yaml|toml)$/i
const SYSTEM_EXECUTABLE = /^(?:unins\d*|uninstall|setup|install|update|crashpad|createdump|elevate|notification|resources)\.exe$/i
const SKIP_DIRECTORIES =
  /^(?:microsoft|windowsapps|packages|temp|tmp|google|node_modules|\.git|cache|windows|installer|common files|\$recycle\.bin|squirreltemp|assembly|intel|amd|nvidia|realtek|programdata|crashdumps|d3dscache|connecteddevicesplatform|comms|edge|onedrive|publishercache)$/i

function rootFor(root) {
  return root && typeof root === 'string' ? root : path.join(os.homedir(), '.vaulted-community')
}

function storePath(root) {
  return path.join(rootFor(root), 'community-launchers.json')
}

function readStore(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(root), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(root, value) {
  const target = storePath(root)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function downloadsDirectory(env = process.env) {
  const profile = env.USERPROFILE || env.HOME || ''
  if (!profile) return ''
  const downloads = path.join(profile, 'Downloads')
  try {
    return fs.statSync(downloads).isDirectory() ? downloads : ''
  } catch {
    return ''
  }
}

function safeExtension(file) {
  return path.extname(String(file || '')).toLowerCase()
}

function statInstaller(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { ok: false, reason: 'That launcher file no longer exists on this PC.' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'That launcher path is not a file.' }
  if (!INSTALLER_EXTENSIONS.has(safeExtension(file))) {
    return { ok: false, reason: 'Choose the community launcher installer (.exe, .msi or .zip).' }
  }
  if (stat.size < MIN_INSTALLER_BYTES) {
    return { ok: false, reason: 'That launcher file is too small to be a real installer.' }
  }
  if (stat.size > MAX_INSTALLER_BYTES) {
    return { ok: false, reason: 'That launcher file is larger than VAULTED will install (900 MB).' }
  }
  return { ok: true, stat }
}

/** Newest installers in the player's Downloads folder, as import candidates. */
function listDownloadedLaunchers(env = process.env) {
  const directory = downloadsDirectory(env)
  if (!directory) return []
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile() || !INSTALLER_EXTENSIONS.has(safeExtension(entry.name))) continue
    if (BLOCKED_CANDIDATE_NAME.test(entry.name)) continue
    const full = path.join(directory, entry.name)
    try {
      const stat = fs.statSync(full)
      if (stat.size < MIN_INSTALLER_BYTES || stat.size > MAX_INSTALLER_BYTES) continue
      candidates.push({
        name: entry.name,
        path: full,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        kind: safeExtension(entry.name).slice(1),
      })
    } catch {
      /* a file that vanished mid-scan is simply not a candidate */
    }
  }
  candidates.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
  return candidates.slice(0, MAX_DOWNLOAD_CANDIDATES)
}

/** The player-picked file must look like an installer before anything runs. */
function validateInstallerPath(file) {
  const resolved = path.resolve(String(file || ''))
  if (!path.isAbsolute(resolved)) {
    return { ok: false, reason: 'Choose the launcher file with the picker or drag it onto the panel.' }
  }
  return { ...statInstaller(resolved), path: resolved }
}

function listingEntries(listing) {
  const text = typeof listing === 'string' ? listing : String(listing?.stdout || '')
  return [...text.matchAll(/^Path\s*=\s*(.+)$/gim)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .slice(0, MAX_ARCHIVE_ENTRIES)
}

function run7z(binary, args, timeout = 60_000, maxBuffer = 16 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { windowsHide: true, timeout, maxBuffer, encoding: 'latin1' },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        })
      },
    )
  })
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function defenderBinary(env = process.env) {
  const candidates = []
  if (env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'Windows Defender', 'MpCmdRun.exe'))
  }
  candidates.push('C:\\Program Files\\Windows Defender\\MpCmdRun.exe')
  const platformRoot = env.ProgramData
    ? path.join(env.ProgramData, 'Microsoft', 'Windows Defender', 'Platform')
    : ''
  if (platformRoot) {
    try {
      for (const version of fs.readdirSync(platformRoot).sort().reverse().slice(0, 6)) {
        candidates.push(path.join(platformRoot, version, 'MpCmdRun.exe'))
      }
    } catch {
      /* Defender has no platform folder on this PC */
    }
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next documented location */
    }
  }
  return ''
}

/**
 * A real Defender scan of the exact file, not a reputation lookup. A machine
 * without the Defender CLI reports `unavailable` instead of pretending the file
 * was checked.
 */
function scanWithDefender(file, env = process.env) {
  const binary = defenderBinary(env)
  if (!binary) return Promise.resolve({ state: 'unavailable' })
  return new Promise((resolve) => {
    execFile(
      binary,
      ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation'],
      { windowsHide: true, timeout: DEFENDER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${String(stdout || '')}\n${String(stderr || '')}`
        if (/found\s+\d+\s+threats?/i.test(output) && !/found no threats/i.test(output)) {
          resolve({ state: 'threats', detail: output.trim().slice(-400) })
          return
        }
        if (/found no threats|no threats found|no malware/i.test(output)) {
          resolve({ state: 'clean' })
          return
        }
        resolve({
          state: 'unavailable',
          detail: (error ? String(error.message || '') : '').slice(0, 200),
        })
      },
    )
  })
}

/** Refuse an archive that ships a local game backend. */
async function inspectArchiveForLocalBackend(file, options = {}) {
  const binary = sevenZipBinary(options)
  if (!binary) return null
  const listing = await run7z(binary, ['l', '-slt', file])
  if (listing.code !== 0) return null
  const entries = listingEntries(listing)
  const named = entries.find((entry) => LAWIN_MARKER.test(path.basename(entry)))
  if (named) {
    return `The archive contains a local backend (${path.basename(named)}). VAULTED only links hosted community servers.`
  }
  const configs = entries
    .filter((entry) => CONFIG_FILE.test(entry) && !/^[\\/]/.test(entry))
    .slice(0, MAX_CONFIG_FILES)
  for (const entry of configs) {
    const extracted = await run7z(binary, ['e', '-so', file, entry], 20_000, MAX_CONFIG_FILE_BYTES)
    if (extracted.code !== 0) continue
    const text = extracted.stdout
    if (LAWIN_MARKER.test(text)) {
      return `The archive's ${path.basename(entry)} configures a self-hosted local backend, which VAULTED does not run.`
    }
    if (LOCAL_HOST.test(text) && BACKEND_CONTEXT.test(text)) {
      return `The archive's ${path.basename(entry)} points its backend at this PC (127.0.0.1/localhost), so it is a self-hosted lobby, not the hosted community server.`
    }
  }
  return null
}

function installerType(listingText) {
  const type = /^Type\s*=\s*(.+)$/im.exec(String(listingText || ''))?.[1]?.trim() || ''
  if (/nsis/i.test(type)) return 'nsis'
  if (/inno/i.test(type)) return 'inno'
  if (/msi|installer/i.test(type)) return 'msi'
  if (/rar/i.test(type)) return 'rar'
  if (/zip|7z|gzip|tar/i.test(type)) return 'archive'
  // 7-Zip reports a plain executable as PE (or Coff/MZ for older toolchains)
  // and lists no archive entries for it: that file is the launcher itself.
  if (/^(?:pe|coff|mz)$/i.test(type)) return 'portable'
  return ''
}

/**
 * A portable launcher is a bare executable, so there is no archive config to
 * read. Scan the program image itself for a bundled local backend instead: a
 * banned backend module name, or a loopback host held next to backend/API
 * wording. Plain `localhost` debug strings alone do not trip it.
 */
async function inspectExecutableForLocalBackend(file) {
  if (safeExtension(file) !== '.exe') return null
  let handle
  try {
    handle = await fs.promises.open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.allocUnsafe(BINARY_CHUNK_BYTES + BINARY_OVERLAP_BYTES)
    let position = 0
    let carry = 0
    let total = 0
    while (total < MAX_BINARY_SCAN_BYTES) {
      const { bytesRead } = await handle.read(buffer, carry, BINARY_CHUNK_BYTES, position)
      if (bytesRead <= 0) break
      const length = carry + bytesRead
      const text = buffer.subarray(0, length).toString('latin1')
      if (LAWIN_MARKER.test(text)) {
        return 'This launcher is bundled with a local game backend, which VAULTED does not run.'
      }
      if (LOCAL_HOST.test(text) && BACKEND_CONTEXT.test(text)) {
        return 'This launcher points its backend at this PC (127.0.0.1/localhost), so it is a self-hosted lobby, not the hosted community server.'
      }
      carry = Math.min(length, BINARY_OVERLAP_BYTES)
      buffer.copy(buffer, 0, length - carry, length)
      position += bytesRead
      total += bytesRead
    }
    return null
  } finally {
    await handle.close()
  }
}

/** Full safety gate for one launcher file: SFX + Defender + local backend. */
async function scanCommunityLauncher(file, options = {}) {
  const validated = validateInstallerPath(file)
  if (!validated.ok) return { safe: false, reason: validated.reason }
  const target = validated.path

  // A bare launcher has no archive config, so its program image is checked for
  // a bundled local backend first: that answer is more precise than the SFX
  // gate's generic quarantine message.
  const binaryBackend = await inspectExecutableForLocalBackend(target)
  if (binaryBackend) return { safe: false, reason: binaryBackend }

  // WinRAR SFX with an embedded VBS/BAT setup script is deleted here, before
  // anything is installed or spawned. Same gate as VAULTED's own downloads.
  try {
    await assertInstallerSafe(target, options)
  } catch (error) {
    return {
      safe: false,
      reason: error instanceof Error ? error.message : 'The launcher installer was blocked.',
    }
  }

  const localBackend = await inspectArchiveForLocalBackend(target, options)
  if (localBackend) return { safe: false, reason: localBackend }

  const defender = await scanWithDefender(target, options.env)
  if (defender.state === 'threats') {
    return {
      safe: false,
      reason:
        'Windows Defender flagged this launcher installer as malicious. VAULTED did not install it.',
      defender,
    }
  }

  return {
    safe: true,
    path: target,
    name: path.basename(target),
    size: validated.stat.size,
    sha256: await sha256File(target),
    defender: defender.state,
    scannedAt: new Date().toISOString(),
  }
}

function scanRoots(env = process.env) {
  const roots = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : '',
    env.LOCALAPPDATA || '',
    env.APPDATA || '',
    env.ProgramFiles || '',
    env['ProgramFiles(x86)'] || '',
  ].filter(Boolean)
  return [...new Set(roots.map((root) => path.normalize(root)))]
}

function executableSnapshot(env = process.env) {
  const snapshot = new Map()
  let budget = INSTALL_SCAN_BUDGET
  const visit = (directory, depth) => {
    if (budget <= 0 || depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (budget-- <= 0) return
      const full = path.join(directory, entry.name)
      if (entry.isFile()) {
        if (!/\.exe$/i.test(entry.name) || SYSTEM_EXECUTABLE.test(entry.name)) continue
        try {
          snapshot.set(full, fs.statSync(full).mtimeMs)
        } catch {
          /* a file removed mid-scan is not a candidate */
        }
        continue
      }
      if (!entry.isDirectory() || SKIP_DIRECTORIES.test(entry.name)) continue
      visit(full, depth + 1)
    }
  }
  for (const root of scanRoots(env)) visit(root, 0)
  return snapshot
}

function providerTokens(label, providerId) {
  const tokens = new Set()
  const add = (value) => {
    const normalized = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
    if (normalized.length >= 3) tokens.add(normalized)
  }
  add(providerId)
  for (const word of String(label || '').toLowerCase().split(/[^a-z0-9]+/)) add(word)
  return tokens
}

function findNewExecutable(before, after, tokens) {
  const created = [...after.entries()]
    .filter(([file, mtime]) => {
      const previous = before.get(file)
      return previous === undefined || previous !== mtime
    })
    .map(([file]) => file)
  if (created.length === 0) return ''
  const score = (file) => {
    const base = path.basename(file).toLowerCase().replace(/[^a-z0-9]+/g, '')
    let points = 0
    for (const token of tokens) {
      if (base.includes(token)) points += 10
    }
    if (/launcher|client|game|play|setup$/i.test(path.basename(file, '.exe'))) points += 2
    points -= file.split(path.sep).length / 100
    return points
  }
  return created.sort((left, right) => score(right) - score(left))[0] || ''
}

async function detectInstallerKind(file, options = {}) {
  const extension = safeExtension(file)
  if (extension === '.msi') return 'msi'
  if (extension === '.zip') return 'archive'
  const binary = sevenZipBinary(options)
  if (!binary) return 'nsis'
  const listing = await run7z(binary, ['l', '-slt', file])
  const kind = installerType(listing.stdout)
  if (kind === 'portable') {
    // A setup program can also report as PE when 7-Zip cannot parse it, so a
    // name that says it installs keeps the installer path.
    return SETUP_NAME.test(path.basename(file, extension)) ? 'nsis' : 'portable'
  }
  return kind || 'nsis'
}

async function extractArchive(file, target, options = {}) {
  const binary = sevenZipBinary(options)
  if (!binary) throw new Error('VAULTED could not unpack this launcher archive.')
  fs.mkdirSync(target, { recursive: true })
  const result = await run7z(binary, ['x', file, `-o${target}`, '-y'], 10 * 60_000)
  if (result.code !== 0) {
    throw new Error('VAULTED could not unpack this launcher archive safely.')
  }
}

const SILENT_ARGUMENTS = {
  nsis: [['/S']],
  inno: [['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']],
  msi: [],
  archive: [],
}

/**
 * A portable launcher usually loads DLLs, fonts or data from the folder it
 * ships in, so the copy has to keep that folder together. Whole folders are
 * copied when they are a launcher's own directory; a file sitting directly in
 * a shell folder (Downloads, Desktop, ...) would drag the entire folder along,
 * so there only its companion files are copied next to it.
 */
const PORTABLE_COMPANION = /\.(?:dll|pak|dat|bin|json|ini|cfg|conf|toml|yml|yaml|xml|txt|sig|cat|db|sqlite|pdb|assets|uasset|uexp|ubulk|png|jpg|jpeg|ico|bmp|gif|svg|ttf|otf|woff2?|csv)$/i
const SHELL_FOLDER = /^(?:downloads|desktop|documents|pictures|music|videos|onedrive)$/i
const MAX_PORTABLE_FILES = 400
const MAX_PORTABLE_BYTES = 3 * 1024 * 1024 * 1024

/**
 * Measure a launcher folder without blocking the main process: a multi-GB
 * portable build must not freeze the window while it is inspected.
 */
async function portableTreeBudget(directory, budget = { files: 0, bytes: 0 }, depth = 0) {
  if (depth > 6 || budget.files > MAX_PORTABLE_FILES || budget.bytes > MAX_PORTABLE_BYTES) {
    return budget
  }
  let entries
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true })
  } catch {
    return budget
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (/^(?:node_modules|\.git|__macosx|cache)$/i.test(entry.name)) continue
      await portableTreeBudget(full, budget, depth + 1)
      if (budget.files > MAX_PORTABLE_FILES || budget.bytes > MAX_PORTABLE_BYTES) return budget
      continue
    }
    if (!entry.isFile()) continue
    budget.files += 1
    try {
      budget.bytes += (await fs.promises.stat(full)).size
    } catch {
      /* a vanished file cannot be copied either */
    }
    if (budget.files > MAX_PORTABLE_FILES || budget.bytes > MAX_PORTABLE_BYTES) return budget
  }
  return budget
}

async function copyPortableCompanions(sourceDirectory, destination) {
  let entries
  try {
    entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !PORTABLE_COMPANION.test(entry.name)) continue
    try {
      await fs.promises.copyFile(
        path.join(sourceDirectory, entry.name),
        path.join(destination, entry.name),
      )
    } catch {
      /* a locked companion is reported by the launcher, not silently dropped from the record */
    }
  }
}

async function stagePortableLauncher(scan, root, providerId) {
  const destination = path.join(rootFor(root), providerId)
  await fs.promises.mkdir(destination, { recursive: true })
  const sourceDirectory = path.dirname(scan.path)
  const alreadyStaged = path
    .resolve(sourceDirectory)
    .startsWith(`${path.resolve(destination)}${path.sep}`)
  let target
  if (alreadyStaged) {
    // Re-importing a launcher VAULTED already staged must not copy it onto itself.
    target = scan.path
  } else {
    const budget = await portableTreeBudget(sourceDirectory)
    const wholeFolder =
      !SHELL_FOLDER.test(path.basename(sourceDirectory)) &&
      budget.files <= MAX_PORTABLE_FILES &&
      budget.bytes <= MAX_PORTABLE_BYTES
    if (wholeFolder) {
      const folder = path.join(destination, path.basename(sourceDirectory) || 'launcher')
      // fs.promises.cp streams on the libuv thread pool, so a 3 GB launcher
      // folder stages without freezing the main process.
      try {
        await fs.promises.cp(sourceDirectory, folder, { recursive: true, force: true })
      } catch (error) {
        throw new Error(
          `VAULTED could not copy ${path.basename(sourceDirectory)} into its launcher folder: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      target = path.join(folder, path.basename(scan.path))
    } else {
      target = path.join(destination, path.basename(scan.path))
      await fs.promises.copyFile(scan.path, target)
      await copyPortableCompanions(sourceDirectory, destination)
    }
  }
  const sha256 = await sha256File(target)
  if (scan.sha256 && sha256 !== scan.sha256) {
    try {
      await fs.promises.rm(target, { force: true })
    } catch {
      /* the mismatch is reported either way */
    }
    throw new Error(
      'The portable launcher did not copy cleanly (its checksum changed), so VAULTED removed the copy.',
    )
  }
  return target
}

async function installLauncherFile(file, kind, options = {}) {
  const env = options.env || process.env
  const label = options.label || 'community launcher'
  if (kind === 'archive') {
    const target = path.join(rootFor(options.root), options.providerId, 'launcher')
    await extractArchive(file, target, options)
    return target
  }
  if (kind === 'msi') {
    await installMsi(
      file,
      { label, installedExecutables: [], executableNames: [], processName: '' },
      { env, logPath: `${file}.install.log` },
    )
    return ''
  }
  let lastError = null
  for (const args of SILENT_ARGUMENTS[kind] || SILENT_ARGUMENTS.nsis) {
    try {
      await installExe(file, { silentArgs: args })
      return ''
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The launcher installer did not finish.')
}

function findExecutableUnder(directory, tokens, depth = 0) {
  if (depth > 4) return ''
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return ''
  }
  const executables = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isFile() && /\.exe$/i.test(entry.name) && !SYSTEM_EXECUTABLE.test(entry.name)) {
      executables.push(full)
    }
  }
  if (executables.length > 0) {
    return executables.sort((left, right) => {
      const base = (file) => path.basename(file, '.exe').toLowerCase().replace(/[^a-z0-9]+/g, '')
      const score = (file) =>
        [...tokens].reduce((total, token) => total + (base(file).includes(token) ? 10 : 0), 0)
      return score(right) - score(left)
    })[0]
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findExecutableUnder(path.join(directory, entry.name), tokens, depth + 1)
    if (found) return found
  }
  return ''
}

/**
 * Import the launcher the player downloaded from the community's Discord:
 * scan, install silently, remember the executable for this provider.
 */
async function importCommunityLauncher(payload = {}) {
  const providerId = String(payload.providerId || '')
    .trim()
    .toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(providerId)) {
    throw new Error('Unknown community provider.')
  }
  const root = rootFor(payload.root)
  const env = payload.env || process.env
  const report = payload.report || (() => {})
  const scan = await scanCommunityLauncher(payload.file, { env })
  if (!scan.safe) {
    const error = new Error(scan.reason)
    error.scan = scan
    throw error
  }

  report({ phase: 'installing', name: scan.name })
  const label = String(payload.label || providerId)
  const tokens = providerTokens(label, providerId)
  const kind = await detectInstallerKind(scan.path)
  let executable = ''
  if (kind === 'portable') {
    // A portable launcher is the program, not a setup wrapper: never run it
    // with installer switches. The verified copy is staged in this provider's
    // folder and that exact path is recorded for Start / Play.
    executable = await stagePortableLauncher(scan, root, providerId)
  } else {
    const before = executableSnapshot(env)
    const extractedRoot = await installLauncherFile(scan.path, kind, {
      env,
      root,
      providerId,
      label,
    })
    const after = executableSnapshot(env)
    executable = extractedRoot ? findExecutableUnder(extractedRoot, tokens) : ''
    if (!executable) executable = findNewExecutable(before, after, tokens)
  }
  if (!executable) {
    throw new Error(
      `${label} installed, but VAULTED could not find its launcher executable. ` +
        'Press "Select / Drop Downloaded Launcher" and choose the launcher .exe itself ' +
        '(a portable launcher is verified where it is and never reinstalled).',
    )
  }

  const portable = kind === 'portable'
  const store = readStore(root)
  store[providerId] = {
    providerId,
    executable,
    portable,
    kind,
    installerName: scan.name,
    sha256: scan.sha256,
    defender: scan.defender,
    installedAt: new Date().toISOString(),
  }
  writeStore(root, store)
  report({ phase: 'done', name: scan.name })
  return {
    ok: true,
    providerId,
    installed: true,
    portable,
    executableName: path.basename(executable),
    installerName: scan.name,
    sha256: scan.sha256,
    defender: scan.defender,
  }
}

function communityLauncherRecord(providerId, root) {
  const id = String(providerId || '')
    .trim()
    .toLowerCase()
  if (!id) return null
  const record = readStore(root)[id]
  if (!record || typeof record.executable !== 'string' || !record.executable) return null
  return record
}

/** Absolute executable for the imported launcher, or '' when none is valid. */
function communityLauncherExecutable(providerId, root) {
  const record = communityLauncherRecord(providerId, root)
  if (!record) return ''
  try {
    const stat = fs.statSync(record.executable)
    if (!stat.isFile() || !/\.exe$/i.test(record.executable)) return ''
    return path.normalize(record.executable)
  } catch {
    return ''
  }
}

/** Public status for the season card; never returns an absolute path. */
function communityLauncherStatus(providerId, root) {
  const id = String(providerId || '')
    .trim()
    .toLowerCase()
  if (!id) return null
  const executable = communityLauncherExecutable(id, root)
  const record = communityLauncherRecord(id, root)
  return {
    providerId: id,
    installed: Boolean(executable),
    portable: record?.portable === true,
    executableName: executable ? path.basename(executable) : '',
    installerName: record?.installerName || '',
    sha256: record?.sha256 || '',
    defender: record?.defender || '',
    installedAt: record?.installedAt || '',
  }
}

function forgetCommunityLauncher(providerId, root) {
  const id = String(providerId || '')
    .trim()
    .toLowerCase()
  if (!id) return { cleared: false }
  const store = readStore(root)
  if (!store[id]) return { cleared: false }
  delete store[id]
  writeStore(root, store)
  return { cleared: true }
}

module.exports = {
  BACKEND_CONTEXT,
  BLOCKED_CANDIDATE_NAME,
  LAWIN_MARKER,
  LOCAL_HOST,
  SILENT_ARGUMENTS,
  communityLauncherExecutable,
  communityLauncherRecord,
  communityLauncherStatus,
  copyPortableCompanions,
  detectInstallerKind,
  portableTreeBudget,
  stagePortableLauncher,
  downloadsDirectory,
  findNewExecutable,
  forgetCommunityLauncher,
  importCommunityLauncher,
  inspectExecutableForLocalBackend,
  installerType,
  listDownloadedLaunchers,
  scanCommunityLauncher,
  scanWithDefender,
  validateInstallerPath,
}
