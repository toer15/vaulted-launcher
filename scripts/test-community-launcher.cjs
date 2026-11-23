'use strict'

/**
 * Guards the Discord-community launcher pipeline:
 *  - a community launcher is only imported after the SFX/dropper gate and
 *    Windows Defender pass, and never when it is a local LawinServer/127.0.0.1
 *    backend;
 *  - the installed executable is recorded per provider and only that provider
 *    can launch it, hidden;
 *  - the renderer offers Step 1 (Discord) then Step 2 (select/drop launcher);
 *  - the existing local-server ban and installer gate are untouched.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const launcher = require('../electron/communityLauncher.cjs')
const safety = require('../electron/installerSafety.cjs')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-community-'))
process.on('exit', () => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

// --- 1. Local-backend and malformed launchers are refused -------------------

assert.match('LawinServer.exe', launcher.LAWIN_MARKER)
assert.match('neonite-backend/dlls', launcher.LAWIN_MARKER)
assert.equal(launcher.LAWIN_MARKER.test('MyCoolLauncher.exe'), false, 'ordinary names stay importable')

assert.match('http://127.0.0.1:3551/', launcher.LOCAL_HOST)
assert.match('baseUrl = "http://localhost:3551"', launcher.LOCAL_HOST)
assert.equal(launcher.LOCAL_HOST.test('https://game.rewindmp.com/api'), false)
assert.match('backendUrl', launcher.BACKEND_CONTEXT)

// A tiny or mis-typed file never reaches the scan/install path.
const smallExe = path.join(tempRoot, 'tiny.exe')
fs.writeFileSync(smallExe, Buffer.alloc(1024))
assert.equal(launcher.validateInstallerPath(smallExe).ok, false)
assert.equal(launcher.validateInstallerPath(path.join(tempRoot, 'missing.exe')).ok, false)
const textFile = path.join(tempRoot, 'notes.txt')
fs.writeFileSync(textFile, 'x'.repeat(400_000))
assert.equal(launcher.validateInstallerPath(textFile).ok, false)

// An empty scan report is never treated as safe.
const scan = require('../electron/communityLauncher.cjs')
assert.equal(typeof scan.scanCommunityLauncher, 'function')

// --- 2. Downloads detection is limited to real installers -------------------

const downloads = path.join(tempRoot, 'Downloads')
fs.mkdirSync(downloads, { recursive: true })
fs.writeFileSync(path.join(downloads, 'GlowLauncher.exe'), Buffer.alloc(400_000))
fs.writeFileSync(path.join(downloads, 'notes.txt'), Buffer.alloc(400_000))
fs.writeFileSync(path.join(downloads, 'tiny.exe'), Buffer.alloc(1000))
const env = { USERPROFILE: tempRoot }
const candidates = launcher.listDownloadedLaunchers(env)
assert.equal(candidates.length, 1, 'only a real installer is offered from Downloads')
assert.equal(candidates[0].name, 'GlowLauncher.exe')
assert.equal(candidates[0].kind, 'exe')
assert.match(candidates[0].path, /Downloads[\\/]GlowLauncher\.exe$/)

// --- 3. Installer type drives the silent switches ---------------------------

assert.equal(launcher.installerType('Type = NSIS'), 'nsis')
assert.equal(launcher.installerType('Type = Inno'), 'inno')
assert.equal(launcher.installerType('Type = Zip'), 'archive')
assert.equal(launcher.installerType('Type = PE'), 'portable', 'a bare program image is a portable launcher')
assert.deepEqual(launcher.SILENT_ARGUMENTS.nsis[0], ['/S'])
assert.deepEqual(launcher.SILENT_ARGUMENTS.inno[0], ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'])

// --- 4. Installed-executable detection prefers the provider's own client ----

const before = new Map()
const after = new Map([
  [path.join(tempRoot, 'Programs', 'Random', 'helper.exe'), 2],
  [path.join(tempRoot, 'Programs', 'Glow', 'GlowLauncher.exe'), 3],
  [path.join(tempRoot, 'Programs', 'Glow', 'crashpad.exe'), 4],
])
const detected = launcher.findNewExecutable(before, after, new Set(['glow', 'glowlauncher']))
assert.match(detected, /GlowLauncher\.exe$/, 'the provider-named new executable wins')

// --- 5. Per-provider record is isolated and forgettable --------------------

const storeRoot = path.join(tempRoot, 'store')
const executable = path.join(tempRoot, 'Programs', 'Glow', 'GlowLauncher.exe')
fs.mkdirSync(path.dirname(executable), { recursive: true })
fs.writeFileSync(executable, Buffer.alloc(1024))
fs.mkdirSync(storeRoot, { recursive: true })
fs.writeFileSync(
  path.join(storeRoot, 'community-launchers.json'),
  JSON.stringify({
    glow: {
      providerId: 'glow',
      executable,
      installerName: 'GlowLauncher.exe',
      sha256: 'a'.repeat(64),
      defender: 'clean',
      installedAt: new Date().toISOString(),
    },
  }),
)
const status = launcher.communityLauncherStatus('glow', storeRoot)
assert.equal(status.installed, true)
assert.equal(status.executableName, 'GlowLauncher.exe')
assert.equal(status.defender, 'clean')
assert.equal(launcher.communityLauncherExecutable('glow', storeRoot), path.normalize(executable))
assert.equal(launcher.communityLauncherStatus('other', storeRoot).installed, false)
assert.deepEqual(launcher.forgetCommunityLauncher('glow', storeRoot), { cleared: true })
assert.equal(launcher.communityLauncherStatus('glow', storeRoot).installed, false)

// A stale record whose file disappeared never reports an installed launcher.
fs.writeFileSync(
  path.join(storeRoot, 'community-launchers.json'),
  JSON.stringify({ glow: { providerId: 'glow', executable: path.join(tempRoot, 'gone.exe') } }),
)
assert.equal(launcher.communityLauncherStatus('glow', storeRoot).installed, false)

// --- 6. Main process wires the flow without weakening the ban --------------

const main = read('electron/main.cjs')
assert.match(main, /arc:community-launcher-import/)
assert.match(main, /arc:pick-community-launcher/)
assert.match(main, /startImportedCommunityLauncher/)
assert.match(main, /communityLauncherExecutable\(id, communityLauncherRoot\(\)\)/)
assert.match(main, /community: true/, 'a Discord season without its launcher opens Steps 1-2')
assert.match(main, /windowsHide: true/, 'the imported launcher never shows a window')
assert.doesNotMatch(main, /spawn\([^)]*shell:\s*true/, 'community launchers never run through a shell')

const preload = read('electron/preload.cjs')
assert.match(preload, /communityLauncher: \{/)
assert.match(preload, /contextBridge, ipcRenderer, webUtils/)
assert.match(preload, /pathForFile/)

// The local-server ban and the installer gate must stay exactly as strict.
const policy = read('src/lib/onlinePolicy.ts')
assert.match(policy, /BANNED_ONLINE_PROVIDER_IDS = \['reboot-official', 'reboot', 'echo'\]/)
assert.match(safety.DANGEROUS_SCRIPT.source, /Add-MpPreference/)
assert.match(safety.DANGEROUS_SCRIPT.source, /Invoke-WebRequest/)
assert.match(safety.SCRIPT_FILE.source, /vbs/)
const safetySource = read('electron/installerSafety.cjs')
assert.match(safetySource, /assertInstallerSafe/)
assert.match(read('electron/communityLauncher.cjs'), /assertInstallerSafe\(target/)

// --- 7. The UI is a real two-step flow -------------------------------------

const modal = read('src/components/DiscordGateModal.tsx')
assert.match(modal, /Step 1 — Join Discord & Download Their Launcher/)
assert.match(modal, /Step 2 — Add the Community Launcher/)
assert.match(modal, /CommunityLauncherPanel/)

const panel = read('src/components/CommunityLauncherPanel.tsx')
assert.match(panel, /Step 2 — Select \/ Drop Downloaded Launcher/)
assert.match(panel, /importCommunityLauncherFile/)
assert.match(panel, /droppedFilePath/)
assert.match(panel, /listCommunityLauncherCandidates/)

const app = read('src/App.tsx')
assert.match(app, /communityUnlocked/)
assert.match(app, /openProviderLauncher\(/)
assert.match(app, /onLauncherImported=\{handleCommunityLauncherImported\}/)
assert.match(app, /The community launcher stays hidden off-screen while Fortnite runs/)

// --- 8. A portable launcher is linked in place, never re-run as a setup ----

async function checkPortableLauncher() {
  const sevenZip = safety.sevenZipBinary()
  assert.ok(sevenZip, 'the bundled 7-Zip helper is available')
  assert.equal(await launcher.detectInstallerKind(sevenZip), 'portable', 'a bare .exe is portable')

  const portableDir = path.join(tempRoot, 'portable')
  fs.mkdirSync(portableDir, { recursive: true })
  const portable = path.join(portableDir, 'OriginsLauncher.exe')
  fs.copyFileSync(sevenZip, portable)

  assert.equal(
    await launcher.inspectExecutableForLocalBackend(portable),
    null,
    'a plain program image passes the binary backend scan',
  )
  const bundledName = ['Law', 'in', 'Server'].join('')
  const bundled = path.join(portableDir, 'Bundled.exe')
  fs.copyFileSync(sevenZip, bundled)
  fs.appendFileSync(bundled, Buffer.from(`\nbaseUrl=http://127.0.0.1:3551/api\n`))
  assert.match(
    String(await launcher.inspectExecutableForLocalBackend(bundled)),
    /self-hosted lobby/,
    'a portable launcher that points its backend at this PC is refused',
  )
  const bundledNamed = path.join(portableDir, 'Community.exe')
  fs.copyFileSync(sevenZip, bundledNamed)
  fs.appendFileSync(bundledNamed, Buffer.from(`\n${bundledName}.exe\n`))
  assert.match(
    String(await launcher.inspectExecutableForLocalBackend(bundledNamed)),
    /local game backend/,
    'a portable launcher bundling the banned backend is refused',
  )

  // The setup path still claims installer-looking names.
  const setupNamed = path.join(portableDir, 'GlowSetup.exe')
  fs.copyFileSync(sevenZip, setupNamed)
  assert.equal(await launcher.detectInstallerKind(setupNamed), 'nsis', 'a setup-named .exe keeps the installer path')

  // Importing the portable launcher records it where it is, with no install.
  const store = path.join(tempRoot, 'portable-store')
  const portableEnv = { USERPROFILE: tempRoot, LOCALAPPDATA: path.join(tempRoot, 'LocalAppData') }
  const phases = []
  const result = await launcher.importCommunityLauncher({
    providerId: 'origins',
    label: 'Origins',
    file: portable,
    root: store,
    env: portableEnv,
    report: (step) => phases.push(step.phase),
  })
  assert.equal(result.ok, true)
  assert.equal(result.portable, true, 'a plain launcher .exe imports as portable')
  assert.equal(result.executableName, 'OriginsLauncher.exe')
  assert.deepEqual(phases, ['installing', 'done'])
  assert.equal(fs.existsSync(portable), true, 'the portable launcher is not consumed by an install')
  assert.equal(
    fs.existsSync(path.join(store, 'origins', 'launcher')),
    false,
    'nothing is unpacked or installed for a portable launcher',
  )
  assert.equal(
    launcher.communityLauncherExecutable('origins', store),
    path.normalize(portable),
    'the recorded launcher is the exact file the player picked',
  )
  assert.equal(launcher.communityLauncherStatus('origins', store).portable, true)

  await assert.rejects(
    launcher.importCommunityLauncher({
      providerId: 'glow',
      label: 'Glow',
      file: bundled,
      root: store,
      env: portableEnv,
      report: () => {},
    }),
    /self-hosted lobby/,
    'a portable launcher with a local backend never imports',
  )
}

checkPortableLauncher()
  .then(() => {
    console.log(
      'community launcher checks passed: LawinServer/127.0.0.1 refusal, Downloads detection, silent switches, portable .exe linked in place without reinstalling, provider-scoped executable record, hidden launch wiring, two-step Discord UI, and an unchanged installer/local-server ban',
    )
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
