#!/usr/bin/env node
'use strict'

/**
 * Provider MSI install regressions.
 *
 * Retrac ships a per-machine MSI. Windows Installer answers that with
 * "Error 1925 — You do not have sufficient privileges to complete this
 * installation for all users of the machine" when VAULTED runs msiexec as the
 * normal player, and msiexec then exits 1603. The launcher used to surface only
 * "MSI exit 1603", so the season stayed locked with no explanation.
 *
 * These checks lock the repair:
 *   - the real installer reason is read back from msiexec's UTF-16LE log,
 *   - a privilege failure is recognised as needing the Windows admin prompt,
 *   - a cancelled or unrelated failure is not mistaken for one,
 *   - the portable fallback lands in the provider's own per-user folder and
 *     its executable can be found by the documented installer name.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  findExecutableIn,
  msiExecutableNames,
  perUserInstallFolder,
  readMsiLog,
} = require('../electron/providerRuntime.cjs')

const root = path.join(__dirname, '..')
const providerCatalog = JSON.parse(
  fs.readFileSync(path.join(root, 'resources/providers/provider.json'), 'utf8'),
)
const retrac = providerCatalog.providers.find((entry) => entry.id === 'retrac-official')
assert.ok(retrac?.runtime, 'Retrac runtime metadata must exist')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-msi-test-'))

function writeMsiLog(name, lines) {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf16le')
  return file
}

function cleanup() {
  fs.rmSync(tmp, { recursive: true, force: true })
}

try {
  // --- the exact failure this launcher hit -----------------------------------
  const privileged = writeMsiLog('per-machine.log', [
    'MSI (s) (60:7C) [21:41:10:194]: Doing action: InstallFinalize',
    'MSI (s) (60:7C) [21:41:10:215]: Product: Retrac -- Error 1925. You do not have sufficient privileges to complete this installation for all users of the machine.  Log on as administrator and then retry this installation.',
    'MSI (s) (60:7C) [21:41:10:244]: Windows Installer installed the product. Product Name: Retrac. Product Version: 3.0.13. Product Language: 1033. Manufacturer: retrac. Installation success or error status: 1603.',
  ])
  const retracDiagnostic = readMsiLog(privileged)
  assert.equal(retracDiagnostic.code, 1603, 'the wrapped msiexec exit code is kept')
  assert.equal(retracDiagnostic.needsAdmin, true, 'a per-machine MSI needs the Windows admin prompt')
  assert.match(retracDiagnostic.message, /Installation error 1925|error 1925/i)
  assert.match(retracDiagnostic.message, /sufficient privileges/i)

  // --- a decline / unrelated failure must not trigger a second UAC prompt ---
  const cancelled = writeMsiLog('cancelled.log', [
    'MSI (c) (18:74) [21:41:10:232]: Product: Retrac -- Installation failed.',
    'MSI (c) (18:74) [21:41:10:251]: MainEngineThread is returning 1602',
    'Installation success or error status: 1602.',
  ])
  const cancelledDiagnostic = readMsiLog(cancelled)
  assert.equal(cancelledDiagnostic.code, 1602)
  assert.equal(cancelledDiagnostic.needsAdmin, false, 'a user-cancelled setup stays cancelled')

  // --- a missing log is not a crash -----------------------------------------
  const missing = readMsiLog(path.join(tmp, 'does-not-exist.log'), 1603)
  assert.equal(missing.code, 1603)
  assert.equal(missing.needsAdmin, true, 'the fallback code still identifies a privilege failure')
  assert.equal(missing.message, '')

  // --- portable fallback target and executable discovery --------------------
  const env = { ...process.env, LOCALAPPDATA: 'C:\\Users\\player\\AppData\\Local' }
  assert.equal(
    perUserInstallFolder(retrac.runtime, env).toLowerCase(),
    path.normalize('C:\\Users\\player\\AppData\\Local\\Programs\\Retrac').toLowerCase(),
    'the first per-user documented folder is the portable install target',
  )
  assert.equal(
    perUserInstallFolder(retrac.runtime, { ...env, LOCALAPPDATA: '' }),
    '',
    'no per-user folder means the fallback stays off',
  )

  const names = msiExecutableNames(retrac.runtime)
  assert.ok(names.has('retrac.exe'), 'the MSI executable name comes from the catalog')

  const extracted = path.join(tmp, 'extract')
  fs.mkdirSync(path.join(extracted, 'ProgramFilesFolder', 'Retrac', 'locales'), { recursive: true })
  fs.writeFileSync(path.join(extracted, 'ProgramFilesFolder', 'Retrac', 'Retrac.exe'), 'launcher')
  assert.equal(
    findExecutableIn(extracted, names),
    path.join(extracted, 'ProgramFilesFolder', 'Retrac', 'Retrac.exe'),
    'a nested administrative install still finds the provider executable',
  )
  assert.equal(findExecutableIn(extracted, new Set(['missing.exe'])), '')

  console.log(
    'MSI install regressions passed: per-machine MSI (Retrac) needs the Windows admin prompt instead of a bare 1603, the real Windows Installer reason is read back from the UTF-16LE log, user-cancelled setups are not retried as privilege failures, and the portable fallback targets the provider\u2019s per-user folder and locates its executable',
  )
} finally {
  cleanup()
}
