#!/usr/bin/env node
'use strict'

/**
 * Auto-Fix regressions:
 *
 *  1. Only VAULTED's own leftovers (temp download fragments, stale locks and
 *     completed archives) are ever candidates. Game data, save files and
 *     `.vaulted-previous` repair backups are never touched.
 *  2. A recent lock is kept because an active operation may still own it.
 *  3. The renderer tab, pre-launch check and main-process IPC stay wired, and
 *     no local-play path comes back through Auto-Fix.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const {
  isOptionalVerifyIssue,
  removeLooseFiles,
  scanLooseFiles,
} = require('../electron/autoFix.cjs')

function write(file, bytes = 64) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x41))
}

function age(file, minutes) {
  const when = new Date(Date.now() - minutes * 60_000)
  fs.utimesSync(file, when, when)
}

function testLooseFileCleanup() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-autofix-'))
  try {
    const season = path.join(tempRoot, 'ch1-s6')
    const gameFile = path.join(season, 'FortniteGame', 'Content', 'Paks', 'pakchunk0-WindowsClient.pak')
    const client = path.join(
      season,
      'FortniteGame',
      'Binaries',
      'Win64',
      'FortniteClient-Win64-Shipping.exe',
    )
    write(gameFile, 4096)
    write(client, 2048)

    const part = path.join(season, '6.21.rar.part')
    const tmp = path.join(season, 'FortniteGame', 'extract.tmp')
    const archive = path.join(season, '6.21.rar')
    const oldLock = path.join(season, 'Fortnite.lock')
    const oldVaultedLock = path.join(season, '.vaulted-lock')
    const freshLock = path.join(season, 'download.lock')
    const notes = path.join(season, 'notes.txt')
    const backupArchive = path.join(season, 'client.vaulted-previous', 'old.7z')
    write(part, 10)
    write(tmp, 10)
    write(archive, 1024)
    write(oldLock, 4)
    write(oldVaultedLock, 4)
    write(freshLock, 4)
    write(notes, 12)
    write(backupArchive, 1024)
    age(oldLock, 120)
    age(oldVaultedLock, 120)

    const scan = scanLooseFiles(season)
    assert.deepEqual(
      scan.temp.map((file) => file.relative).sort(),
      ['6.21.rar.part', path.join('FortniteGame', 'extract.tmp')].sort(),
      'only interrupted-download fragments are temp files',
    )
    assert.equal(scan.locks.length, 3, 'every lock file is reported for review')
    assert.equal(scan.archives.length, 1, 'a completed archive is reported once')
    assert.equal(
      scan.archives[0].relative,
      '6.21.rar',
      'archives inside a .vaulted-previous repair backup are never reported',
    )

    const removal = removeLooseFiles(season, { minAgeMs: 60_000 })
    assert.equal(removal.removed.length, 4, 'two temp files and two stale locks are removed')
    assert.ok(!fs.existsSync(part), 'the interrupted archive fragment is removed')
    assert.ok(!fs.existsSync(tmp), 'nested temp files are removed')
    assert.ok(!fs.existsSync(oldLock), 'stale lock files are removed')
    assert.ok(!fs.existsSync(oldVaultedLock), 'stale VAULTED lock files are removed')
    assert.ok(fs.existsSync(freshLock), 'a recent lock is kept for the active operation')
    assert.ok(fs.existsSync(archive), 'archives are only removed by an explicit cleanup')
    assert.ok(fs.existsSync(gameFile), 'game PAK data is never removed')
    assert.ok(fs.existsSync(client), 'the client executable is never removed')
    assert.ok(fs.existsSync(notes), 'unrecognised files are never removed')
    assert.ok(fs.existsSync(backupArchive), 'repair backups are never removed')

    const withArchives = removeLooseFiles(season, { minAgeMs: 60_000, includeArchives: true })
    assert.equal(withArchives.removed.length, 1, 'the completed archive is removed on request')
    assert.ok(!fs.existsSync(archive), 'the completed archive is gone')
    assert.ok(fs.existsSync(backupArchive), 'the repair backup archive survives cleanup')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function testOptionalVerifyIssues() {
  // Cosmetic caches and placeholders must never trigger a full re-download.
  assert.equal(isOptionalVerifyIssue('FortniteGame/PersistentDownloadDir/CMS/art.png', 'empty'), true)
  assert.equal(isOptionalVerifyIssue('FortniteGame/Content/PackagedReplays/placeholder.txt', 'empty'), true)
  assert.equal(isOptionalVerifyIssue('FortniteGame/Content/Paks/pakchunk0.pak', 'empty'), false)
  assert.equal(isOptionalVerifyIssue('FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe', 'empty'), false)
  assert.equal(isOptionalVerifyIssue('Engine/Binaries/Win64/x.dll', 'empty'), false)
  assert.equal(isOptionalVerifyIssue('build.7z.part', 'empty'), true, 'temp fragments are cleanup-owned')
  assert.equal(isOptionalVerifyIssue('build.7z.part.json', 'empty'), true)
  assert.equal(isOptionalVerifyIssue('FortniteGame/Content/Paks/pakchunk0.pak', 'corrupt'), false)
  assert.equal(isOptionalVerifyIssue('FortniteGame/Content/Paks/pakchunk0.pak', 'missing'), false)
}

function testWiring() {
  const main = read('electron/main.cjs')
  const preload = read('electron/preload.cjs')
  const app = read('src/App.tsx')
  const topbar = read('src/components/TopBar.tsx')
  const view = read('src/components/AutoFixView.tsx')

  assert.match(main, /ipcMain\.handle\('arc:autofix-scan'/)
  assert.match(main, /ipcMain\.handle\('arc:autofix-repair'/)
  assert.match(main, /async function autoFixScan\(/)
  assert.match(main, /async function autoFixRepair\(/)
  assert.match(
    main,
    /await ensureRuntimeInstalled\(\)\s*\n\s*await stageCoreRuntimeDlls\(\)/,
    'Auto-Fix restores the bundled runtime and DLLs',
  )
  assert.match(main, /await stageSeasonLauncherDlls\(providerId\)/, 'Auto-Fix stages provider DLLs')
  assert.match(main, /stageSeasonLauncherDlls\(providerId\)/)
  assert.match(main, /cleanupManagedBuild\(/, 'Auto-Fix removes duplicate trees and old archives')
  assert.match(
    main,
    /ensureProviderRuntime\(providerId, metadata,/,
    'Auto-Fix repairs a missing or broken companion launcher',
  )
  assert.match(main, /require\('\.\/autoFix\.cjs'\)/)
  assert.match(preload, /autoFix: \{/, 'Auto-Fix must be exposed to the renderer')
  assert.match(app, /const preLaunchAutoFix = useCallback/)
  assert.match(
    app,
    /if \(!\(await preLaunchAutoFix\(build\)\)\) return/,
    'Play must run the fast Auto-Fix check before launching',
  )
  assert.match(app, /<AutoFixView/, 'the Auto-Fix tab must render')
  assert.match(app, /view === 'autofix'/)
  assert.match(topbar, /Auto-Fix<\/span>/, 'the top navigation must offer Auto-Fix')
  assert.match(view, /Auto-Fix Everything/, 'one button repairs every downloaded season')
  assert.match(view, /Fix season/, 'a single season can be repaired on its own')

  // Local play stays removed: Auto-Fix can only repair online seasons.
  assert.match(app, /onlineIsPlayable\(playModes\[build\.id\]\)/)
  assert.equal(/(?:startLocalServer|launchLocal|localhost|127\.0\.0\.1)/i.test(view), false, 'Auto-Fix adds no local route')
}

try {
  testLooseFileCleanup()
  testOptionalVerifyIssues()
  testWiring()
  console.log(
    'auto-fix checks passed: temp/lock cleanup preserves game data, saves, archives and .vaulted-previous backups; Auto-Fix tab, pre-launch check, runtime/DLL staging, launcher repair and archive cleanup are wired; no local play',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
