'use strict'

/**
 * Play handoff for every external companion launcher.
 *
 * VAULTED already downloaded the exact season folder. This module points the
 * launcher's own library at that folder and invokes the launcher's own launch
 * action, using the API/UI each project actually ships:
 *
 *   Era       library.list + game.launch (library.addExisting via native picker)
 *   Hydro     seasons.json + game:launch
 *   Neo       getSession + getLibrary/import_neo_build + launch_neo_build
 *   Omen      LauncherManager.LibraryManager + LaunchBuild
 *   Hestia    hestia.installs + the launcher's own Launch button
 *   Retrac    persisted library entry + the launcher's own build tile
 *   Eon       %LOCALAPPDATA%\EonLauncherV2\Settings.ini + native Play button
 *
 * Everything is local. The launcher window is already hidden; when a one-time
 * sign-in or launcher update is required the caller reveals that exact window
 * and calls back once the player is done.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { evaluateOnPage, waitForLauncherPage } = require('./communityBridge.cjs')
const { candidateRoots, detectBuildVersion } = require('./buildVersion.cjs')
const { delay, runPowerShell } = require('./companionAutomation.cjs')

const CLIENT_RELATIVE = path.join(
  'FortniteGame',
  'Binaries',
  'Win64',
  'FortniteClient-Win64-Shipping.exe',
)

const KNOWN_BUILD_NAMES = {
  '4.5': 'Chapter 1 Season 4',
  '5.10': 'Chapter 1 Season 5',
  '8.51': 'Chapter 1 Season 8',
  '14.60': 'Chapter 2 Season 4',
  '15.50': 'Chapter 2 Season 5',
  '17.50': 'Chapter 2 Season 7',
  '10.40': 'Season X',
  '11.00': 'Chapter 2 Season 1',
  '11.31': 'Chapter 2 Season 1',
}

/** Providers with a dedicated adapter. Unknown communities use the generic
 *  sign-in-aware Play click and still get the exact folder through the bridge. */
const COMPANION_PLAY_ADAPTERS = Object.freeze({
  'era-official': 'era',
  era: 'era',
  hydro: 'hydro',
  neo: 'neo',
  'omen-official': 'omen',
  'hestia-official': 'hestia',
  'retrac-official': 'retrac',
  eon: 'eon',
})

function normalizePath(value) {
  return String(value || '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

function sameFolder(left, right) {
  const a = normalizePath(left)
  const b = normalizePath(right)
  if (!a || !b) return false
  return a === b || a.endsWith(`\\${b}`) || b.endsWith(`\\${a}`)
}

function communityJunction(folder) {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'VAULTED', 'community-launchers', 'builds')
    : ''
  if (!base) return folder
  return path.join(base, path.basename(path.resolve(folder)))
}

/** Resolve the real game root and client inside the downloaded season folder. */
function resolveGameFolder(folder) {
  const roots = [path.resolve(folder)]
  try {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (/^(?:FortniteGame|Engine|Content|Binaries)$/i.test(entry.name)) continue
      roots.push(path.join(folder, entry.name))
    }
  } catch {
    /* the caller reports an incomplete folder */
  }
  for (const root of roots) {
    const executable = path.join(root, CLIENT_RELATIVE)
    if (fs.existsSync(executable)) return { root, executable }
  }
  return { root: path.resolve(folder), executable: '' }
}

/** The exact version/changelist inside the folder, not the season card's label. */
async function detectGameBuild(folder, fallbackVersion = '') {
  const resolved = resolveGameFolder(folder)
  let detected = { version: '', changelist: null, source: '' }
  try {
    detected = await detectBuildVersion(folder)
  } catch {
    detected = { version: '', changelist: null, source: '' }
  }
  let version = String(detected.version || '').trim()
  let cl = Number(detected.changelist) || null
  if (!version && fallbackVersion) {
    const match = String(fallbackVersion).match(/(\d{1,2}\.\d{1,2})(?:\.\d+)?(?:-CL-(\d{5,}))?/i)
    if (match) {
      version = match[1]
      cl = cl || (match[2] ? Number(match[2]) : null)
    }
  }
  return {
    folder: path.resolve(folder),
    root: resolved.root,
    executable: resolved.executable,
    version,
    cl,
    manifestVersion: version && cl ? `++Fortnite+Release-${version}-CL-${cl}` : '',
  }
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return fallback
  }
}

async function evaluate(page, expression) {
  const raw = await evaluateOnPage(page.webSocketDebuggerUrl, expression)
  return parseJson(raw, raw)
}

async function waitForPageValue(page, expression, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(page, expression).catch(() => false)
    if (value) return true
    await delay(350)
  }
  return false
}

/* ------------------------------------------------------------------ Era --- */

async function eraLibrary(page) {
  const result = await evaluate(
    page,
    `(async () => JSON.stringify(await window.era.invoke('library.list')))()`,
  )
  return Array.isArray(result) ? result : []
}

async function eraLaunch(page, buildId) {
  return evaluate(
    page,
    `(async () => {
      try {
        await window.era.invoke('game.launch', { build_id: ${JSON.stringify(buildId)} });
        return JSON.stringify({ ok: true });
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && error.message || error) });
      }
    })()`,
  )
}

/** Drive Era's own native folder picker to add the exact downloaded build. */
async function eraAddExisting(page, launcherPid, folder) {
  const started = await evaluate(
    page,
    `(() => {
      try {
        window.__vaultedEraAdd = window.era.invoke('library.addExisting');
        return 'started';
      } catch (error) { return String(error && error.message || error); }
    })()`,
  )
  if (started !== 'started') return false
  await delay(1_200)
  const picked = await pickFolderInNativeDialog(launcherPid, folder)
  if (!picked) return false
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const list = await eraLibrary(page).catch(() => [])
    if (list.some((entry) => sameFolder(entry.directory, folder))) return true
    await delay(800)
  }
  return false
}

async function playEra({ page, launcherPid, folder, build, allowImport = true }) {
  const list = await eraLibrary(page)
  const entry = list.find((candidate) => sameFolder(candidate.directory, folder))
  if (!entry) {
    if (!allowImport) return { status: 'needs-import', detail: 'era-library' }
    const imported = await eraAddExisting(page, launcherPid, folder)
    if (!imported) return { status: 'needs-import', detail: 'era-library' }
    const refreshed = await eraLibrary(page)
    const added = refreshed.find((candidate) => sameFolder(candidate.directory, folder))
    if (!added) return { status: 'needs-import', detail: 'era-library' }
    const launched = await eraLaunch(page, added.id)
    return launched?.ok ? { status: 'played', build } : { status: 'failed', detail: launched?.error }
  }
  const launched = await eraLaunch(page, entry.id)
  return launched?.ok ? { status: 'played', build } : { status: 'failed', detail: launched?.error }
}

/* ---------------------------------------------------------------- Hydro --- */

function hydroManifestPath() {
  const base = process.env.LOCALAPPDATA
  if (!base) return ''
  return path.join(base, 'Hydro', 'LauncherV4', 'seasons.json')
}

/** Hydro reads seasons.json on every IPC call; write the exact VAULTED build. */
function prepareHydroLibrary(folder, build) {
  const file = hydroManifestPath()
  if (!file) return null
  let manifest = {}
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) manifest = {}
  } catch {
    manifest = {}
  }
  const resolved = resolveGameFolder(folder)
  if (!resolved.executable) return null
  const version = build?.version || '15.50'
  const cl = build?.cl || null
  const keyBase = cl ? `${version}-CL-${cl}` : `${version}`
  let key = String(keyBase).replace(/[<>:"/\\|?*]/g, '_').trim()
  const normalizedFolder = normalizePath(folder)
  const existingKey = Object.keys(manifest).find((candidate) => {
    const entry = manifest[candidate]
    const entryFolder = normalizePath(entry?.path)
    const entryExe = normalizePath(entry?.exe_path)
    return (
      sameFolder(entryFolder, folder) ||
      (entryFolder && normalizedFolder && entryFolder.startsWith(`${normalizedFolder}\\`)) ||
      (entryExe && normalizedFolder && entryExe.startsWith(`${normalizedFolder}\\`))
    )
  })
  if (existingKey) key = existingKey
  manifest[key] = {
    key,
    name: `Fortnite ${version}`,
    version,
    cl: cl || '',
    path: resolved.root,
    exe_path: resolved.executable,
    added_at: String(Math.floor(Date.now() / 1000)),
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.vaulted.tmp`
    fs.writeFileSync(temp, JSON.stringify(manifest, null, 2))
    fs.renameSync(temp, file)
    return { key, version, path: resolved.root }
  } catch {
    return null
  }
}

async function playHydro({ page, folder, build }) {
  await waitForPageValue(
    page,
    `Boolean(window.hydro && typeof window.hydro.authGetSession === 'function')`,
  )
  const session = await evaluate(
    page,
    `(async () => {
      try { return JSON.stringify(await window.hydro.authGetSession()); }
      catch (error) { return JSON.stringify({ error: String(error && error.message || error) }); }
    })()`,
  )
  if (!session || session.error || !(session.access_token || session.account_id || session.display_name)) {
    return { status: 'needs-sign-in', detail: 'hydro-session' }
  }
  const seasons = await evaluate(
    page,
    `(async () => JSON.stringify(await window.hydro.seasonsList()))()`,
  )
  const list = Array.isArray(seasons) ? seasons : []
  const entry = list.find((candidate) => sameFolder(candidate.path, folder))
  if (!entry) return { status: 'needs-import', detail: 'hydro-library' }
  if (String(entry.version) !== '15.50') {
    return { status: 'unsupported', detail: `hydro-version-${entry.version || 'unknown'}` }
  }
  const result = await evaluate(
    page,
    `(async () => {
      try { return JSON.stringify(await window.hydro.gameLaunch(${JSON.stringify(entry.key)})); }
      catch (error) { return JSON.stringify({ ok: false, error: String(error && error.message || error) }); }
    })()`,
  )
  if (result?.ok) return { status: 'played', build }
  if (/sign in/i.test(String(result?.error || ''))) {
    return { status: 'needs-sign-in', detail: 'hydro-session' }
  }
  return { status: 'failed', detail: result?.error || 'hydro-launch' }
}

/* ------------------------------------------------------------------ Neo --- */

async function playNeo({ page, folder, build }) {
  const ready = await waitForPageValue(
    page,
    `Boolean(window.neoLauncherServices && typeof window.neoLauncherServices.getSession === 'function')`,
  )
  if (!ready) return { status: 'unsupported', detail: 'neo-not-ready' }
  const session = await evaluate(
    page,
    `(async () => {
      try { return JSON.stringify(await window.neoLauncherServices.getSession()); }
      catch (error) { return JSON.stringify({ error: String(error && error.message || error) }); }
    })()`,
  )
  if (!session || session.error || session.isLoggedIn !== true) {
    return { status: 'needs-sign-in', detail: 'neo-session' }
  }
  let library = await evaluate(
    page,
    `(async () => {
      try { return JSON.stringify(await window.neoLauncherServices.getLibrary()); }
      catch (error) { return JSON.stringify({ builds: [], error: String(error && error.message || error) }); }
    })()`,
  )
  let builds = Array.isArray(library?.builds) ? library.builds : []
  let match = builds.find((candidate) =>
    sameFolder(
      candidate.path || candidate.installPath || candidate.install_path || candidate.location ||
        candidate.rootPath || candidate.root_path || candidate.directory,
      folder,
    ),
  )
  if (!match) {
    const imported = await evaluate(
      page,
      `(async () => {
        try {
          return JSON.stringify(await window.neoLauncherServices.import_neo_build({
            path: ${JSON.stringify(folder)},
            source: 'imported',
          }));
        } catch (error) { return JSON.stringify({ isSuccess: false, error: String(error && error.message || error) }); }
      })()`,
    )
    if (imported?.isSuccess !== true) {
      return { status: 'needs-import', detail: imported?.error || 'neo-import' }
    }
    library = await evaluate(
      page,
      `(async () => JSON.stringify(await window.neoLauncherServices.getLibrary()))()`,
    )
    builds = Array.isArray(library?.builds) ? library.builds : []
    match = builds.find((candidate) =>
      sameFolder(
        candidate.path || candidate.installPath || candidate.install_path || candidate.location ||
          candidate.rootPath || candidate.root_path || candidate.directory,
        folder,
      ),
    )
  }
  const version =
    build?.cl ? `${build.version}-CL-${build.cl}` : String(match?.version || build?.version || '')
  const installPath =
    match?.path || match?.installPath || match?.install_path || match?.location ||
    match?.rootPath || match?.root_path || match?.directory || folder
  const result = await evaluate(
    page,
    `(async () => {
      try {
        return JSON.stringify(await window.neoLauncherServices.launch_neo_build({
          installPath: ${JSON.stringify(installPath)},
          version: ${JSON.stringify(version)},
          modifiers: {},
          launchOptions: {},
          displayOverride: null,
        }));
      } catch (error) { return JSON.stringify({ isSuccess: false, error: String(error && error.message || error) }); }
    })()`,
  )
  if (result?.isSuccess === true) return { status: 'played', build }
  return { status: 'failed', detail: result?.error || result?.message || 'neo-launch' }
}

/* ----------------------------------------------------------------- Omen --- */

function omenExpresssion(folder, build) {
  return `(async () => {
    const folder = ${JSON.stringify(folder)};
    const separator = String.fromCharCode(92);
    const client = ${JSON.stringify(CLIENT_RELATIVE.split(path.sep).join('/'))};
    const exe = folder + separator + client.split('/').join(separator);
    const manager = globalThis.LauncherManager;
    const library = manager && manager.LibraryManager;
    if (!library || typeof library.SaveLibraryDiskEntries !== 'function') {
      return JSON.stringify({ status: 'unsupported', detail: 'omen-library' });
    }
    const account = manager.AuthManager && manager.AuthManager.Account;
    if (!account || !account.accessToken) {
      return JSON.stringify({ status: 'needs-sign-in', detail: 'omen-session' });
    }
    const entries = Array.isArray(library.libraryDiskEntries) ? library.libraryDiskEntries : [];
    let entry = entries.find((item) => item && String(item.path || '').toLowerCase() === folder.toLowerCase());
    if (!entry) {
      let version = ${JSON.stringify(build?.version || '')};
      let cl = ${JSON.stringify(build?.cl || 0)};
      if (!version || !cl) {
        try {
          const read = await window.__TAURI_INTERNALS__.invoke('read_version', { path: exe });
          if (Array.isArray(read)) { version = read[0]; cl = read[1]; }
          else if (read && typeof read === 'object') { version = read.version; cl = read.cl; }
        } catch (error) {
          return JSON.stringify({ status: 'needs-import', detail: 'omen-read-version' });
        }
      }
      if (!version || !cl) return JSON.stringify({ status: 'needs-import', detail: 'omen-version' });
      let info = null;
      try { info = await library.AddVersionInfo(String(version), parseInt(cl, 10)); }
      catch (error) { return JSON.stringify({ status: 'needs-sign-in', detail: 'omen-version-info' }); }
      if (!info || !info.version_id) return JSON.stringify({ status: 'needs-sign-in', detail: 'omen-version-info' });
      entry = {
        path: folder,
        manifestId: '++Fortnite+Release-' + version + '-CL-' + cl + '.json',
        versionId: info.version_id,
        version: parseFloat(version),
        cl: parseInt(cl, 10),
      };
      library.libraryDiskEntries = entries.concat([entry]);
      await library.SaveLibraryDiskEntries();
      if (typeof library.emit === 'function') library.emit();
    }
    try {
      await library.LaunchBuild(entry.versionId, '');
      return JSON.stringify({ status: 'played', versionId: entry.versionId });
    } catch (error) {
      return JSON.stringify({ status: 'failed', detail: String(error && error.message || error) });
    }
  })()`
}

async function playOmen({ page, folder, build }) {
  // The launcher initializes its library and account asynchronously after the
  // window exists. An uninitialised page is not a signed-out page.
  await waitForPageValue(
    page,
    `Boolean(globalThis.LauncherManager && globalThis.LauncherManager.LibraryManager && globalThis.LauncherManager.AuthManager)`,
  )
  // The launcher's library may hold either VAULTED's downloaded folder or the
  // space-free junction the community handoff created for it.
  const junction = communityJunction(folder)
  const first = await evaluate(page, omenExpresssion(junction, build))
  if (first?.status === 'needs-import' || first?.status === 'failed') {
    const second = await evaluate(page, omenExpresssion(folder, build))
    if (second?.status === 'played') return second
  }
  return first
}

/* --------------------------------------------------------------- Hestia --- */

async function playHestia({ page, folder }) {
  await waitForPageValue(
    page,
    `String((document.body && document.body.innerText) || '').trim().length > 0`,
    10_000,
  )
  const expression = `(async () => {
    const folder = ${JSON.stringify(folder)};
    const key = 'hestia.installs';
    const currentKey = 'windows-1.11';
    let installs = {};
    try { installs = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
    const text = String(document.body && document.body.innerText || '');
    const signedOut = /sign in|log in|login|continue with discord|authorize/i.test(text) &&
      !/sign out|log out|logout/i.test(text);
    if (signedOut) return JSON.stringify({ status: 'needs-sign-in', detail: 'hestia-session' });
    const current = installs[currentKey];
    const same = current && String(current.path || '').toLowerCase() === folder.toLowerCase();
    if (!same) {
      const marker = sessionStorage.getItem('vaulted-hestia-folder');
      if (marker !== folder) {
        installs[currentKey] = {
          path: folder,
          manifestCreatedAt: null,
          installedAt: new Date().toISOString(),
        };
        localStorage.setItem(key, JSON.stringify(installs));
        sessionStorage.setItem('vaulted-hestia-folder', folder);
        location.reload();
        return JSON.stringify({ status: 'reload', detail: 'hestia-library' });
      }
      return JSON.stringify({ status: 'needs-import', detail: 'hestia-library' });
    }
    sessionStorage.removeItem('vaulted-hestia-folder');
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter((button) => !button.disabled);
    const target = buttons.find((button) => /launch|play/i.test(button.textContent || ''));
    if (target) {
      target.click();
      return JSON.stringify({ status: 'clicked', detail: 'hestia-play' });
    }
    return JSON.stringify({ status: 'needs-import', detail: 'hestia-play-button' });
  })()`
  return evaluate(page, expression)
}

/* --------------------------------------------------------------- Retrac --- */

async function playRetrac({ page, folder, build, manifestId = '' }) {
  const version = build?.manifestVersion || String(manifestId || '')
  if (!version) return { status: 'needs-import', detail: 'retrac-version' }
  // The Tauri route mounts after the WebView2 document; wait for its shell so
  // an empty page is never mistaken for an update or sign-in screen.
  await waitForPageValue(
    page,
    `String((document.body && document.body.innerText) || '').trim().length > 0`,
    10_000,
  )
  // The router paints a shell before its route text; never seed the library
  // over the launcher's required-update screen.
  await delay(1_200)
  const buildName = KNOWN_BUILD_NAMES[build.version] || `Fortnite ${build.version}`
  const expression = `(async () => {
    const folder = ${JSON.stringify(folder)};
    const version = ${JSON.stringify(version)};
    const buildName = ${JSON.stringify(buildName)};
    const manifestId = version + '-Windows';
    const text = String(document.body && document.body.innerText || '');
    if (
      location.pathname.endsWith('/update') ||
      /update now|required update|launcher update|new version|out of date/i.test(text)
    ) {
      return JSON.stringify({ status: 'needs-update', detail: 'retrac-update' });
    }
    if (/sign in|log in|login|continue with discord/i.test(text) && !/sign out|log out|logout/i.test(text)) {
      return JSON.stringify({ status: 'needs-sign-in', detail: 'retrac-session' });
    }
    let persisted = {};
    try { persisted = JSON.parse(localStorage.getItem('library') || '{}') || {}; } catch {}
    const state = persisted.state && typeof persisted.state === 'object' ? persisted.state : {};
    const library = Array.isArray(state.library) ? state.library : [];
    const existingIndex = library.findIndex((entry) => entry && entry.version === version);
    const existing = existingIndex >= 0 ? library[existingIndex] : null;
    const processLocation = folder + String.fromCharCode(92) + 'FortniteGame' + String.fromCharCode(92) +
      'Binaries' + String.fromCharCode(92) + 'Win64' + String.fromCharCode(92) +
      'FortniteClient-Win64-Shipping.exe';
    const splashLocation = folder + String.fromCharCode(92) + 'FortniteGame' + String.fromCharCode(92) +
      'Content' + String.fromCharCode(92) + 'Splash' + String.fromCharCode(92) + 'Splash.bmp';
    const folderChanged = Boolean(existing) && (
      String(existing.rootLocation || '').toLowerCase() !== folder.toLowerCase() ||
      String(existing.processLocation || '').toLowerCase() !== processLocation.toLowerCase()
    );
    if (!existing || folderChanged) {
      const entry = {
        ...(existing || {}),
        rootLocation: folder,
        processLocation,
        splashLocation,
        version,
        buildName,
        manifestId,
        hasIntialisedEasyAnticheat: false,
        addedToWindowsDefender: false,
        triedToAddToWindowsDefender: false,
      };
      persisted.state = {
        ...state,
        library: existing
          ? library.map((item, index) =>
              index === existingIndex ? entry : item,
            )
          : library.concat([entry]),
      };
      localStorage.setItem('library', JSON.stringify(persisted));
      sessionStorage.setItem('vaulted-retrac-folder', folder);
      if (!location.pathname.endsWith('/library')) location.href = '/library';
      else location.reload();
      return JSON.stringify({ status: 'reload', detail: 'retrac-library' });
    }
    sessionStorage.removeItem('vaulted-retrac-folder');
    if (!location.pathname.endsWith('/library')) {
      location.href = '/library';
      return JSON.stringify({ status: 'reload', detail: 'retrac-route' });
    }
    const tile = document.getElementById(version);
    if (!tile) return JSON.stringify({ status: 'needs-import', detail: 'retrac-tile' });
    // Retrac's row has a dedicated Launch Fortnite/Launch Build icon button.
    // Clicking the build title only selects the row and never starts the game.
    const launchButton = Array.from(tile.querySelectorAll('button')).find((button) => {
      if (button.disabled) return false;
      const label = String(button.textContent || button.getAttribute('aria-label') || '');
      return /launch\s+(?:fortnite|build|game)/i.test(label);
    });
    const target = launchButton || Array.from(tile.querySelectorAll('*'))
      .find((node) => String(node.textContent || '').trim() === buildName);
    if (!target) return JSON.stringify({ status: 'needs-import', detail: 'retrac-tile' });
    target.click();
    return JSON.stringify({ status: 'clicked', detail: 'retrac-play' });
  })()`
  return evaluate(page, expression)
}

/* ---------------------------------------------------------------- Eon ----- */

function eonSettingsPath() {
  const base = process.env.LOCALAPPDATA
  if (!base) return ''
  return path.join(base, 'EonLauncherV2', 'Settings.ini')
}

/** Eon's INI parser unescapes both backslashes and \\n. */
function unescapeEonValue(value) {
  return String(value || '').replace(/\\(\\|n)/g, (_match, escaped) =>
    escaped === 'n' ? '\n' : '\\',
  )
}

/** Read the settings Eon will load on its next start. */
function readEonConfig() {
  const file = eonSettingsPath()
  const empty = { file, exists: false, folder: '', signedIn: false }
  if (!file) return empty
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return empty
  }
  let section = ''
  let folder = ''
  let token = ''
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    const value = line.match(/^\s*([^=]+?)\s*=\s*(.*)$/)
    if (!value) continue
    const key = value[1].trim().toLowerCase()
    if (section === 'game' && key === 'fortnitepath') {
      folder = unescapeEonValue(value[2].trim())
    }
    if (section === 'credentials' && key === 'launchertoken') {
      token = unescapeEonValue(value[2].trim())
    }
  }
  return { file, exists: true, folder, signedIn: Boolean(token) }
}

/** Eon stores its game path in Settings.ini; preserve every other setting. */
function prepareEonConfig(folder) {
  const before = readEonConfig()
  const file = before.file
  if (!file) return { ok: false, changed: false, ...before }
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    text = [
      '[Account]',
      'Username=',
      'Email=',
      'SkinUrl=',
      '',
      '[Credentials]',
      'LauncherToken=',
      '',
      '[Game]',
      'FortnitePath=',
      'IsBubbleBuildsEnabled=false',
      '',
    ].join('\r\n')
  }
  // Match Eon's own serializer. A raw path containing a backslash followed by
  // n (for example C:\\new\\build) would otherwise deserialize as a newline.
  const escaped = String(path.resolve(folder))
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
  let replaced = false
  const lines = text.split(/\r?\n/)
  const output = []
  let section = ''
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      section = header[1].trim().toLowerCase()
      output.push(line)
      continue
    }
    if (section === 'game' && /^\s*FortnitePath\s*=/i.test(line)) {
      output.push(`FortnitePath=${escaped}`)
      replaced = true
      continue
    }
    output.push(line)
  }
  if (!replaced) {
    let gameAt = output.findIndex((line) => /^\s*\[Game\]\s*$/i.test(line))
    if (gameAt < 0) {
      output.push('', '[Game]', `FortnitePath=${escaped}`, 'IsBubbleBuildsEnabled=false')
    } else {
      output.splice(gameAt + 1, 0, `FortnitePath=${escaped}`)
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.vaulted.tmp`
    fs.writeFileSync(temp, output.join('\r\n'))
    fs.renameSync(temp, file)
    const after = readEonConfig()
    return {
      ok: true,
      changed:
        normalizePath(before.folder) !== normalizePath(after.folder) || !before.exists,
      previousFolder: before.folder,
      folder: after.folder,
      signedIn: after.signedIn,
    }
  } catch {
    return { ok: false, changed: false, ...before }
  }
}

/* ---------------------------------------------------------- generic UI ---- */

function bodyLooksSignedOut() {
  return `(() => {
    const text = String(document.body && document.body.innerText || '');
    return JSON.stringify({
      signedOut: /sign in|log in|login|continue with discord|authorize/i.test(text) &&
        !/sign out|log out|logout/i.test(text),
    });
  })()`
}

async function playGeneric({ page }) {
  const state = await evaluate(page, bodyLooksSignedOut())
  if (state?.signedOut) return { status: 'needs-sign-in', detail: 'generic-session' }
  const clicked = await evaluate(
    page,
    `(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const target = candidates.find((node) => {
        const label = String(node.textContent || node.getAttribute('aria-label') || '').trim();
        return /^(?:play|launch|start)(?:\\b|\\s)/i.test(label) && !node.disabled;
      });
      if (!target) return JSON.stringify({ clicked: false });
      target.click();
      return JSON.stringify({ clicked: true, label: String(target.textContent || '').trim() });
    })()`,
  )
  return clicked?.clicked
    ? { status: 'clicked', detail: clicked.label || 'generic-play' }
    : { status: 'unsupported', detail: 'generic-play-button' }
}

/* ------------------------------------------------- native folder picker --- */

const DIALOG_TYPES = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VaultedPicker {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
function Find-VaultedDialog([int]$targetPid) {
  $script:found = [IntPtr]::Zero
  $cb = [VaultedPicker+EnumProc]{
    param($h, $l)
    $owner = [uint32]0
    [void][VaultedPicker]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq $targetPid) {
      $name = New-Object System.Text.StringBuilder 64
      [void][VaultedPicker]::GetClassName($h, $name, 64)
      if ($name.ToString() -eq '#32770') { $script:found = $h; return $false }
    }
    return $true
  }
  [void][VaultedPicker]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}
`

async function pickFolderInNativeDialog(pid, folder) {
  if (process.platform !== 'win32') return false
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  const escaped = String(folder).replace(/'/g, "''")
  const script = `${DIALOG_TYPES}
$dialog = Find-VaultedDialog ${safePid}
if ($dialog -eq [IntPtr]::Zero) { 'NO_DIALOG'; exit 2 }
[void][VaultedPicker]::ShowWindow($dialog, 9)
[void][VaultedPicker]::SetForegroundWindow($dialog)
Start-Sleep -Milliseconds 350
[System.Windows.Forms.SendKeys]::SendWait('^l')
Start-Sleep -Milliseconds 250
Set-Clipboard -Value '${escaped}'
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
'PICKED'
`
  const { output } = await runPowerShell(script, 25_000)
  return output === 'PICKED'
}

/* ------------------------------------------------------- native buttons --- */

/** Invoke a native WinUI/WPF button by its accessible name, without a cursor. */
async function clickNativeLaunchButton(pid, options = {}) {
  if (process.platform !== 'win32') return { clicked: false, reason: 'unsupported' }
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  const pattern = String(options.pattern || 'launch|play|start').replace(/'/g, "''")
  // Eon hosts its WebView content in a separate accessibility window. Searching
  // only the first top-level XAML window therefore sees the startup splash and
  // never its Sign In / Play buttons. Filter the whole desktop tree by PID so
  // WinUI, WebView2 and Chromium accessibility content are all included.
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$rootPid = ${safePid}
# WebView2 renders Eon's page in child msedgewebview2 processes. Their UIA
# elements have the renderer PID, not Eon's PID, so include every descendant.
$allowed = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$allowed.Add($rootPid)
try {
  $procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($proc in $procs) {
      if ($allowed.Contains([int]$proc.ParentProcessId) -and -not $allowed.Contains([int]$proc.ProcessId)) {
        [void]$allowed.Add([int]$proc.ProcessId)
        $changed = $true
      }
    }
  }
} catch {
  # PID-only fallback still works for native WinUI buttons.
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$signedOut = $false
foreach ($element in $all) {
  if (-not $allowed.Contains([int]$element.Current.ProcessId)) { continue }
  $name = [string]$element.Current.Name
  $type = [string]$element.Current.ControlType.ProgrammaticName
  if ($type -eq 'ControlType.Button' -and $name -match '(?i)^(sign in|signin|log in|login|continue with)') {
    $signedOut = $true
  }
  if ($type -eq 'ControlType.Button' -and $name -match '(?i)^(launch|play|start)(\\s|$)') {
    $invoke = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($invoke) { $invoke.Invoke(); "CLICKED:$name"; exit 0 }
  }
}
if ($signedOut) { 'SIGNED_OUT'; exit 3 }
'NO_BUTTON'; exit 4
`
  const { output } = await runPowerShell(script, 20_000)
  if (output.startsWith('CLICKED:')) return { clicked: true, label: output.slice(8) }
  if (output === 'SIGNED_OUT') return { clicked: false, reason: 'needs-sign-in' }
  return { clicked: false, reason: output || 'no-button' }
}

/* --------------------------------------------------------------- public --- */

/**
 * One attempt at pointing the launcher at `folder` and pressing its own Play.
 * Callers retry this while the launcher is visible for sign-in or update.
 */
async function playCompanionBuild(options = {}) {
  const providerId = String(options.providerId || '').trim().toLowerCase()
  const folder = typeof options.folder === 'string' ? options.folder : ''
  if (!providerId) return { status: 'failed', detail: 'no-provider' }
  if (!folder) return { status: 'failed', detail: 'no-folder' }
  const adapter = COMPANION_PLAY_ADAPTERS[providerId]
  const build = await detectGameBuild(
    folder,
    options.version || options.manifestId || '',
  )
  if (
    !build.version &&
    !options.manifestId &&
    adapter !== 'era' &&
    adapter !== 'eon'
  ) {
    return { status: 'failed', detail: 'no-build-version' }
  }
  if (adapter === 'hydro') {
    prepareHydroLibrary(folder, build)
  }
  // Eon disables WebView2 DevTools in its WinUI host, so there is no page to
  // query even when a port is allocated. Its Settings.ini is the exact-folder
  // handoff and its own Play button is reachable through UI Automation.
  if (adapter === 'eon') {
    const config = prepareEonConfig(folder)
    return {
      status: 'native',
      detail: config.signedIn ? 'eon-ready' : 'eon-sign-in',
      signedIn: config.signedIn,
    }
  }
  const port = Number(options.port) || 0
  if (!port) return { status: 'unsupported', detail: 'no-bridge' }
  const page = await waitForLauncherPage(port, Number(options.pageTimeoutMs) || 12_000)
  if (!page) return { status: 'unsupported', detail: 'launcher-not-reachable' }
  const context = {
    page,
    folder,
    build,
    launcherPid: Number(options.launcherPid) || 0,
    allowImport: options.allowImport !== false,
    executable: options.executable || '',
  }
  const manifestId = String(options.manifestId || '').replace(/-Windows$/i, '')
  context.manifestId = manifestId
  try {
    if (adapter === 'era') return await playEra(context)
    if (adapter === 'hydro') return await playHydro(context)
    if (adapter === 'neo') return await playNeo(context)
    if (adapter === 'omen') return await playOmen(context)
    if (adapter === 'hestia') return await playHestia(context)
    if (adapter === 'retrac') return await playRetrac(context)
    return await playGeneric(context)
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

module.exports = {
  COMPANION_PLAY_ADAPTERS,
  clickNativeLaunchButton,
  communityJunction,
  detectGameBuild,
  playCompanionBuild,
  prepareEonConfig,
  prepareHydroLibrary,
  readEonConfig,
  resolveGameFolder,
}
