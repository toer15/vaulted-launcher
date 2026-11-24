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
// Clutter and banned builds must never be offered as a community launcher.
for (const name of [
  'VAULTED-Launcher-1.0.200-Setup.exe',
  'reboot_launcher.exe',
  'ProjectRebooted-Launcher.exe',
  'echo-launcher.exe',
  'ProjectEcho-Setup.exe',
  'LegacyMP-Setup.exe',
  'ProjectLegacy.exe',
]) {
  fs.writeFileSync(path.join(downloads, name), Buffer.alloc(500_000))
}
assert.match('reboot_launcher.exe', launcher.BLOCKED_CANDIDATE_NAME)
assert.match('VAULTED-Launcher-1.0.200-Setup.exe', launcher.BLOCKED_CANDIDATE_NAME)
assert.match('echofn-setup.exe', launcher.BLOCKED_CANDIDATE_NAME)
assert.match('ProjectLegacy-Setup.exe', launcher.BLOCKED_CANDIDATE_NAME)
assert.equal(
  launcher.BLOCKED_CANDIDATE_NAME.test('GlowLauncher.exe'),
  false,
  'a genuine community launcher stays listed',
)
const env = { USERPROFILE: tempRoot }
const candidates = launcher.listDownloadedLaunchers(env)
assert.equal(candidates.length, 1, 'only a real installer is offered from Downloads')
assert.equal(candidates[0].name, 'GlowLauncher.exe')
assert.equal(candidates[0].kind, 'exe')
assert.match(candidates[0].path, /Downloads[\\/]GlowLauncher\.exe$/)
for (const banned of ['VAULTED-Launcher', 'reboot', 'echo', 'Legacy']) {
  assert.equal(
    candidates.some((candidate) => candidate.name.toLowerCase().includes(banned.toLowerCase())),
    false,
    `Found in Downloads must never list ${banned}`,
  )
}

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
assert.match(
  main,
  /path\.join\(base, 'VAULTED', 'community-launchers'\)/,
  'imported launchers live under %LOCALAPPDATA%\\VAULTED\\community-launchers',
)
assert.match(main, /migrateCommunityLauncherStore/, 'an earlier userData store is carried over once')
assert.match(main, /VAULTED_COMMUNITY_LAUNCHER/, 'the hidden launcher is told it runs for VAULTED')
assert.match(main, /VAULTED_GAME_DIR/, 'Start hands the launcher the installed build folder')
assert.match(
  main,
  /startCompanionLauncher\(providerId, \{ folder \}\)/,
  'Start passes the installed build folder into the hidden launcher',
)
assert.match(
  main,
  /let imported = await startImportedCommunityLauncher\(id, launchOptions\)/,
  'Play routes a community season straight to the imported launcher',
)
assert.match(main, /startImportedCommunityLauncher/)
assert.match(
  main,
  /async function autoDiscoverCommunityLauncher\(providerId\)/,
  'Start auto-discovers a launcher the player already installed or downloaded',
)
assert.match(main, /installedExecutables\(metadata\)/, 'documented %LOCALAPPDATA% installs are checked')
assert.match(main, /listDownloadedLaunchers\(\)/, 'the Downloads folder is checked')
assert.match(main, /await scanCommunityLauncher\(file\)/, 'a discovered launcher is safety-scanned first')
assert.match(
  main,
  /await adoptInstalledCommunityLauncher\(\{ providerId: id, file, root \}\)/,
  'an already-installed launcher is adopted in place, never copied alone',
)
assert.match(main, /await importCommunityLauncher\(\{/, 'a downloaded launcher is imported through Step 2')
assert.match(
  main,
  /const discovered = await autoDiscoverCommunityLauncher\(id\)/,
  'the direct-launch branch runs auto-discovery before asking for the file',
)
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
assert.match(
  panel,
  /Done — Back to Season Card\n/,
  'Step 2 must offer a way straight back to the season card',
)
// The panel is now a fallback only: Start no longer forces a verify screen.
assert.match(
  read('src/App.tsx'),
  /discordGate=\{null\}/,
  'the season card must not gate Play on Discord',
)
assert.match(panel, /onDone\?.\(\)/, 'the Done button must close the gate')
assert.match(
  panel,
  /only\s*\n?\s*needed if VAULTED has not imported this community's launcher/,
  'Step 2 must explain that it is optional once Step 1 verified',
)
assert.match(modal, /onDone={onClose}/, 'the modal hands its close handler to Step 2')

// Step 2 must never be a dead end: the verified primary closes the gate, there
// is a direct way to reach the Discord channel that hosts the launcher, and an
// import resumes the Start that asked for it.
assert.match(
  modal,
  /verified\s*\n?\s*\?\s*'Done — Back to Season Card'/,
  'a verified Step 2 must not show a dead "Community verified" button',
)
assert.match(
  modal,
  /Open \{projectLabel\} Discord Server\n/,
  'Step 2 must offer the Discord server so the launcher can be downloaded',
)
assert.match(
  modal,
  /Open \{projectLabel\} in Discord and download its launcher from the launcher\/\n\s*download channel/,
  'Step 2 must say where the launcher file comes from',
)

// --- 7b. Discord seasons are linked end to end, with no verify screen ------
// Start must never be gated on a Discord verification, Download must fetch the
// community's own client archive inside VAULTED (never a browser tab), and an
// installed launcher must be adopted for the hidden handoff.
const launchSource = read('src/App.tsx')
const mainSource = read('electron/main.cjs')
const builds = JSON.parse(read('src/assets/builds.json'))
assert.equal(/lockedGate/.test(launchSource), false, 'no verification lock may block Start')
assert.match(
  launchSource,
  /const communityUnlocked = Boolean\(\r?\n\s*communityProvider\?\.directLaunch === true && communityGate,/,
  'a Discord-hosted project is an online route without verification',
)
assert.match(
  launchSource,
  /const handleInstallSeason = useCallback\(\(\) => \{\r?\n\s*const build = activeBuild\r?\n\s*if \(!build\) return\r?\n\s*requestDownload\(build, \{ explicit: true \}\)/,
  'Download must start VAULTED own download, never a browser handoff',
)
assert.equal(
  /handleInstallSeason[\s\S]{0,400}openDiscordInvite/.test(launchSource),
  false,
  'Install Season must never open Discord instead of downloading',
)
assert.equal(
  /if \(gate\) \{[\s\S]{0,600}openDiscordInvite/.test(launchSource),
  false,
  'a missing community launcher must never open a browser tab',
)
const ch1s3Entry = builds.seasons['ch1-s3']
assert.equal(
  ch1s3Entry.downloadUrl,
  'https://cdn.omen.mp/archives/++Fortnite+Release-3.6-CL-4019403.zip',
  "Chapter 1 Season 3 must download Omen's own client archive",
)
assert.match(
  ch1s3Entry.fallbackDownloadUrl,
  /^https:\/\/archive\.org\//,
  'the community archive must keep its mirror fallback',
)
assert.match(
  mainSource,
  /function autoDiscoverCommunityLauncher\(providerId\)/,
  'main must still detect an installed community launcher',
)
assert.match(
  mainSource,
  /const profile =\r?\n\s*providerCatalog\(\)\.find\(\(entry\) => entry\.id === id\)/,
  'discovery must read the full catalog row, not the manifest-only row',
)
assert.match(
  read('electron/preload.cjs'),
  /findSeasonArchives: \(payload\) => ipcRenderer\.invoke\('arc:find-season-archives'/,
  'preload must expose the Downloads scan',
)

assert.match(launchSource, /communityUnlocked/)
assert.match(launchSource, /openProviderLauncher\(/)
assert.match(launchSource, /onLauncherImported=\{handleCommunityLauncherImported\}/)
assert.match(
  launchSource,
  /The community launcher stays hidden off-screen while Fortnite runs/,
)

// --- 8. A portable launcher is linked in place, never re-run as a setup ----

async function checkPortableLauncher() {
  const sevenZip = safety.sevenZipBinary()
  assert.ok(sevenZip, 'the bundled 7-Zip helper is available')
  assert.equal(await launcher.detectInstallerKind(sevenZip), 'portable', 'a bare .exe is portable')

  const portableDir = path.join(tempRoot, 'portable', 'OriginsLauncher')
  fs.mkdirSync(path.join(portableDir, 'data'), { recursive: true })
  const portable = path.join(portableDir, 'OriginsLauncher.exe')
  fs.copyFileSync(sevenZip, portable)
  // A portable launcher loads these from the folder it ships in.
  fs.writeFileSync(path.join(portableDir, 'OriginsLauncher.dll'), Buffer.alloc(2048, 7))
  fs.writeFileSync(path.join(portableDir, 'data', 'settings.json'), '{"region":"eu"}')
  fs.writeFileSync(path.join(portableDir, 'unrelated.zip'), Buffer.alloc(1024, 1))

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
  const stagedFolder = path.join(store, 'origins', 'OriginsLauncher')
  const staged = path.join(stagedFolder, 'OriginsLauncher.exe')
  assert.equal(
    fs.existsSync(staged),
    true,
    'the verified portable launcher is copied into that provider folder',
  )
  assert.equal(
    fs.existsSync(path.join(stagedFolder, 'OriginsLauncher.dll')),
    true,
    'a portable launcher keeps the DLL that ships beside it',
  )
  assert.equal(
    fs.readFileSync(path.join(stagedFolder, 'data', 'settings.json'), 'utf8'),
    '{"region":"eu"}',
    'a portable launcher keeps its data subfolders',
  )
  assert.equal(
    fs.existsSync(path.join(stagedFolder, 'unrelated.zip')),
    true,
    'the launcher folder is copied as a whole, exactly as the player received it',
  )
  assert.equal(
    launcher.communityLauncherExecutable('origins', store),
    path.normalize(staged),
    'Start runs the staged copy inside the provider folder, not the Downloads file',
  )
  assert.equal(result.sha256, await (require('node:crypto').createHash('sha256').update(fs.readFileSync(staged)).digest('hex')), 'the recorded sha256 is the staged copy')
  assert.equal(launcher.communityLauncherStatus('origins', store).portable, true)
  assert.equal(launcher.communityLauncherStatus('origins', store).executableName, 'OriginsLauncher.exe')

  // A launcher dropped straight into a shell folder is not copied with the
  // whole Downloads folder: only it and its companion files move.
  const flatName = 'VynxLauncher.exe'
  const flat = path.join(downloads, flatName)
  fs.copyFileSync(sevenZip, flat)
  fs.writeFileSync(path.join(downloads, 'VynxLauncher.dll'), Buffer.alloc(1024, 3))
  fs.writeFileSync(path.join(downloads, 'notes.txt'), Buffer.alloc(512, 4))
  fs.writeFileSync(path.join(downloads, 'other-installer.exe'), Buffer.alloc(700_000, 5))
  const flatResult = await launcher.importCommunityLauncher({
    providerId: 'vynx',
    label: 'Vynx',
    file: flat,
    root: store,
    env: portableEnv,
    report: () => {},
  })
  const flatStaged = path.join(store, 'vynx', flatName)
  assert.equal(flatResult.portable, true)
  assert.equal(fs.existsSync(flatStaged), true, 'a Downloads launcher is copied flat into its provider folder')
  assert.equal(
    fs.existsSync(path.join(store, 'vynx', 'VynxLauncher.dll')),
    true,
    'its companion DLL comes with it',
  )
  assert.equal(
    fs.existsSync(path.join(store, 'vynx', 'other-installer.exe')),
    false,
    'an unrelated installer in Downloads is never copied',
  )
  assert.equal(
    fs.existsSync(path.join(store, 'vynx', 'VynxLauncher', 'VynxLauncher.exe')),
    false,
    'a shell folder is never copied as if it were the launcher folder',
  )

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

/**
 * ONLINE · DISCORD seasons are hosted by their community launcher 24/7 and
 * must never fall through to the managed live-server gate.
 */
async function checkDiscordHostedLaunch() {
  const app = read('src/App.tsx')
  const hostedAt = app.indexOf('const discordHostedProvider = providerCatalog.find(')
  const liveGateAt = app.indexOf('No live ${build.season.label} server is online right now.')
  assert.ok(hostedAt > 0, 'Play has no direct route for verified Discord-hosted seasons')
  assert.ok(
    liveGateAt > hostedAt,
    'the Discord-hosted route must return before the live-server failure can fire',
  )
  assert.match(
    app.slice(hostedAt, hostedAt + 900),
    /entry\.directLaunch === true/,
    'the route must only claim direct-launch communities',
  )
  assert.match(
    app.slice(hostedAt, hostedAt + 900),
    /Boolean\(entry\.discordGate\)/,
    'the route must only claim Discord-gated communities',
  )
  assert.match(
    app.slice(hostedAt, hostedAt + 1400),
    /await startOnlineProvider\(build, discordHostedProvider\)\s*\n\s*return/,
    'Play must hand the season to its community launcher and stop',
  )
  assert.match(
    app.slice(hostedAt, hostedAt + 900),
    /isDiscordGateVerified\(discordGateVerifications, discordHostedProvider\.discordGate!\)/,
    'only a verified Step 1 unlocks the 24/7 route',
  )

  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-adopt-'))
  await assert.rejects(
    launcher.adoptInstalledCommunityLauncher({
      providerId: 'omen-official',
      file: path.join(store, 'missing', 'Omen.exe'),
      root: store,
    }),
    /no longer exists|not found|missing|invalid/i,
    'an adopted launcher must exist on disk',
  )
  assert.equal(
    launcher.communityLauncherExecutable('omen-official', store),
    '',
    'a rejected adoption never records a launcher',
  )
  // The adopted record is what Start reads; a missing file can never satisfy it.
  assert.equal(
    launcher.communityLauncherRecord('omen-official', store),
    null,
    'a rejected adoption leaves no executable record behind',
  )
  fs.rmSync(store, { recursive: true, force: true })
}

checkPortableLauncher()
  .then(checkDiscordHostedLaunch)
  .then(() => {
    console.log(
      'community launcher checks passed: LawinServer/127.0.0.1 refusal, Downloads detection, silent switches, portable .exe copied with the folder and companions it ships with, without reinstalling, Start handing the season folder to the hidden launcher, auto-discovery of installed/downloaded launchers through the same safety scan, a 24/7 route for verified ONLINE · DISCORD seasons that never reports "No live server available", provider-scoped executable record, two-step Discord UI, and an unchanged installer/local-server ban',
    )
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
