'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

/**
 * WinRAR SFX installers can embed a `Setup=` script in their archive comment.
 * Running the SFX extracts that script into %TEMP%\RarSFX* and launches it
 * through Windows Script Host. There is no safe way to run an untrusted script
 * automatically: a compromised launcher can use it to disable Defender, create
 * SYSTEM persistence, or execute a downloaded payload.
 *
 * VAULTED never executes these SFX scripts. It inspects the archive with the
 * bundled 7-Zip, blocks any RAR SFX that contains a setup script or batch/WSH
 * payload, deletes the download, and reports the reason in the normal install
 * error UI.
 */

const SCRIPT_FILE = /\.(?:vbs|vbe|js|jse|wsf|wsh|bat|cmd|ps1)$/i
const DANGEROUS_SCRIPT =
  /Add-MpPreference|Exclusions\\Paths|schtasks(?:\.exe)?|Invoke-WebRequest|DownloadString|ProgramData[\\/]+System|wscript|cscript|Start-Process|powershell/i

function sevenZipBinary(options = {}) {
  const candidates = []
  if (options.sevenZipBinary) candidates.push(String(options.sevenZipBinary))
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, '7zip', '7z.exe'))
  candidates.push(path.join(__dirname, '..', 'node_modules', '7zip-bin-full', 'win', 'x64', '7z.exe'))
  candidates.push(path.join(__dirname, '..', 'resources', '7zip', '7z.exe'))
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next location */
    }
  }
  return ''
}

function inspectionFailureReason(detail) {
  const text = String(detail || '')
  if (/contains a virus|potentially unwanted|malware|virus or potentially/i.test(text)) {
    return (
      'Windows Defender already flags this launcher installer as malicious and blocked inspection. ' +
      'VAULTED quarantined it without running it.'
    )
  }
  return 'VAULTED could not safely inspect this launcher installer, so it was quarantined instead of run.'
}

function run7z(binary, args, timeout = 20_000, maxBuffer = 8 * 1024 * 1024) {
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

/**
 * Inspect a downloaded installer without executing it. Returns
 * `{ safe: true }` for ordinary NSIS/MSI EXEs, or a block report for a WinRAR
 * SFX with an embedded setup script.
 */
async function inspectInstaller(file, options = {}) {
  let stat
  try {
    stat = await fs.promises.stat(file)
  } catch {
    return { safe: false, reason: 'The launcher installer was not written to disk.' }
  }
  if (!stat.isFile() || stat.size < 64 * 1024) {
    return { safe: false, reason: 'The launcher installer is empty or truncated.' }
  }

  const binary = sevenZipBinary(options)
  if (!binary) {
    // Do not guess about an archive we cannot inspect. Normal installers are
    // still covered by the existing size/header/signature checks.
    return { safe: true, inspected: false }
  }

  const listing = await run7z(binary, ['l', '-slt', file])
  if (listing.code !== 0) {
    return {
      safe: false,
      reason: inspectionFailureReason(`${listing.stderr}\n${listing.stdout}`),
    }
  }
  const type = /^Type\s*=\s*(.+)$/im.exec(listing.stdout)?.[1]?.trim() || ''
  if (!/^Rar/i.test(type)) return { safe: true, inspected: true, type }

  const names = [...listing.stdout.matchAll(/^Path\s*=\s*(.+)$/gim)]
    .map((match) => match[1].trim())
    .filter(Boolean)
  const scripts = [...new Set(names.filter((name) => SCRIPT_FILE.test(name)))]
  const setup = /Setup\s*=\s*([^\r\n]+)/i.exec(listing.stdout)?.[1]?.trim() || ''
  if (!setup && scripts.length === 0) return { safe: true, inspected: true, type }

  // Read only the embedded script files. They are never executed or written to
  // the install folder; extraction to stdout is just for the block message.
  let scriptText = ''
  for (const script of scripts.slice(0, 8)) {
    const extracted = await run7z(binary, ['e', '-so', file, script], 20_000, 2 * 1024 * 1024)
    if (extracted.code === 0) scriptText += `\n${script}\n${extracted.stdout.slice(0, 500_000)}`
  }
  const dangerous = DANGEROUS_SCRIPT.test(scriptText) || DANGEROUS_SCRIPT.test(setup)
  const detail = dangerous
    ? 'Its embedded batch/WSH script tries to change Defender settings, download a payload, or create SYSTEM persistence.'
    : `Its embedded setup script (${setup || scripts[0]}) would run through Windows Script Host.`
  return {
    safe: false,
    inspected: true,
    type,
    setup,
    scripts,
    reason:
      `The ${path.basename(file)} WinRAR SFX installer was blocked and quarantined. ` +
      `${detail} VAULTED never runs WinRAR SFX setup scripts.`,
  }
}

/** Inspect and delete an unsafe installer. Safe installers are left in place. */
async function assertInstallerSafe(file, options = {}) {
  const report = await inspectInstaller(file, options)
  if (report.safe !== false) return report
  await fs.promises.rm(file, { force: true }).catch(() => {})
  throw new Error(report.reason)
}

module.exports = {
  DANGEROUS_SCRIPT,
  SCRIPT_FILE,
  assertInstallerSafe,
  inspectInstaller,
  inspectionFailureReason,
  sevenZipBinary,
}
