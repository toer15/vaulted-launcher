'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile, spawn } = require('node:child_process')
const { downloadInstaller, probeReleaseInfo, validateInstaller } = require('./installerDownload.cjs')
const { assertInstallerSafe } = require('./installerSafety.cjs')
const {
  WINDOW_HIDER_PS,
  cleanProcessNames,
  startHiddenWindowWatcher,
  startWindowsScriptHostGuard,
} = require('./hiddenWindows.cjs')

/**
 * Download and verify a provider's documented desktop runtime.
 *
 * This module only understands catalog metadata that main has already
 * validated. It never accepts a URL or a filesystem path from the renderer.
 * The release endpoint is the provider's own version service, or a pinned
 * official installer URL. The installer must be HTTPS from a configured host.
 * MSI releases must carry a valid Authenticode signature. Interactive EXE
 * releases may be unsigned only when the catalog explicitly opts in, because
 * the player sees and confirms the installer UI instead of a silent install.
 */

const VERSION_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const MAX_EXE_SEARCH_ENTRIES = 3_000
// A vendor launcher can finish its own bootstrap (a script or a SFX that then
// unpacks the real client) after its installer process exits, so the installed
// executable is polled instead of sampled once.
const INSTALL_DETECT_TIMEOUT_MS = 90_000
const runtimeTasks = new Map()

function expandEnvironmentPath(value, env = process.env) {
  return String(value || '').replace(/%([A-Z0-9_()]+)%/gi, (match, name) => {
    const resolved = env[String(name).toUpperCase()]
    return typeof resolved === 'string' && resolved ? resolved : match
  })
}

function hostAllowed(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase()
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

function safeVersion(value) {
  const version = typeof value === 'string' ? value.trim() : ''
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version) ? version : ''
}

function installerFileName(metadata, version) {
  const name = String(metadata.installerName || '').replace('{version}', version)
  const extension = metadata.kind === 'msi' ? 'msi' : 'exe'
  if (!new RegExp(`^[^\\\\/:*?"<>|]+\\.${extension}$`, 'i').test(name)) {
    throw new Error('The provider runtime metadata has an invalid installer name.')
  }
  return name
}

function executableInRoots(metadata, env = process.env) {
  const names = new Set(
    (metadata.executableNames || []).map((name) => String(name).toLowerCase()),
  )
  if (names.size === 0) return ''
  // A bare file name is not enough: `echo.exe` also exists inside Git's own
  // Program Files tree. The folder holding the launcher must belong to the
  // provider, so an unrelated tool can never be mistaken for a company's app.
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const ownerTokens = new Set()
  for (const name of names) ownerTokens.add(normalize(name.replace(/\.exe$/i, '')))
  for (const word of String(metadata.label || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 3) ownerTokens.add(normalize(word))
  }
  const ownerFolder = (directory) => {
    const folder = normalize(path.basename(directory))
    if (!folder) return false
    for (const token of ownerTokens) {
      if (token && (folder.includes(token) || token.includes(folder))) return true
    }
    return false
  }
  const roots = [
    ...new Set(
      (metadata.installRoots || [])
        .map((root) => path.normalize(expandEnvironmentPath(root, env)))
        .filter((root) => path.isAbsolute(root)),
    ),
  ]
  // Each root gets its own budget. A single shared counter let one large root
  // (for example %LOCALAPPDATA%/Programs) exhaust the scan before the real
  // install root (for example Squirrel's %LOCALAPPDATA%/VendorLauncher) was read.
  const visit = (directory, depth, budget) => {
    if (depth > 3 || budget.inspected >= MAX_EXE_SEARCH_ENTRIES) return ''
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return ''
    }
    for (const entry of entries) {
      if (++budget.inspected >= MAX_EXE_SEARCH_ENTRIES) return ''
      const full = path.join(directory, entry.name)
      if (entry.isFile() && names.has(entry.name.toLowerCase()) && ownerFolder(directory)) {
        return full
      }
      if (
        entry.isDirectory() &&
        depth < 3 &&
        !/^(?:node_modules|\.git|cache|temp|tmp|logs?)$/i.test(entry.name)
      ) {
        const found = visit(full, depth + 1, budget)
        if (found) return found
      }
    }
    return ''
  }
  for (const root of roots) {
    const found = visit(root, 0, { inspected: 0 })
    if (found) return found
  }
  return ''
}

function installedExecutable(metadata, env = process.env) {
  for (const candidate of metadata.installedExecutables || []) {
    const resolved = path.normalize(expandEnvironmentPath(candidate, env))
    if (!path.isAbsolute(resolved)) continue
    try {
      if (fs.statSync(resolved).isFile()) return resolved
    } catch {
      /* not installed at this documented location */
    }
  }
  return executableInRoots(metadata, env)
}

/**
 * Every documented launcher location that exists on this PC, in order.
 *
 * A provider that has been reinstalled can leave an old, partially removed
 * copy behind at an earlier path. The caller tries these in turn, so a broken
 * leftover never hides the working install next to it.
 */
function installedExecutables(metadata, env = process.env) {
  const found = []
  for (const candidate of metadata.installedExecutables || []) {
    const resolved = path.normalize(expandEnvironmentPath(candidate, env))
    if (!path.isAbsolute(resolved) || found.includes(resolved)) continue
    try {
      if (fs.statSync(resolved).isFile()) found.push(resolved)
    } catch {
      /* not installed at this documented location */
    }
  }
  const inRoots = executableInRoots(metadata, env)
  if (inRoots && !found.includes(inRoots)) found.push(inRoots)
  return found
}

function launchArguments(metadata, version) {
  const manifestId = metadata.manifestIds?.[String(version || '').trim()]
  if (!manifestId) {
    // Single-season launchers do not need a build flag; opening the official
    // executable is the complete handoff.
    return (metadata.launchArgs || []).map((arg) => String(arg))
  }
  return (metadata.launchArgs || []).map((arg) =>
    String(arg).replace(/\{manifestId\}/g, manifestId),
  )
}

function runtimeFolder(root, providerId) {
  return path.join(root, String(providerId || 'provider').replace(/[^a-z0-9-]/gi, ''))
}

async function resolveRelease(metadata, options = {}) {
  if (metadata.kind === 'exe') {
    let downloadUrl
    try {
      downloadUrl = new URL(String(metadata.downloadUrl || ''))
    } catch {
      throw new Error('The provider launcher metadata has no valid download URL.')
    }
    if (
      downloadUrl.protocol !== 'https:' ||
      downloadUrl.username ||
      downloadUrl.password ||
      !hostAllowed(downloadUrl.hostname, metadata.downloadHosts || [])
    ) {
      throw new Error('The provider launcher download is not from a trusted HTTPS host.')
    }
    // The official download route may be extensionless (for example
    // /launcher) and send Content-Disposition instead. The installer name and
    // host are validated separately, and the downloaded file is always saved
    // with the catalog's .exe name.
    const version = safeVersion(metadata.version)
    if (!version) throw new Error('The provider launcher metadata has no valid version.')
    return { version, url: downloadUrl.toString(), signature: '' }
  }
  const fetchImpl = options.fetchImpl || fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetchImpl(metadata.versionUrl, {
      headers: { accept: 'application/json', 'user-agent': 'VAULTED-Launcher' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`The provider version service returned HTTP ${response.status}.`)
    }
    const payload = await response.json()
    const version = safeVersion(payload?.version)
    if (!version) throw new Error('The provider version service returned no usable version.')
    let downloadUrl
    try {
      downloadUrl = new URL(String(payload?.url || ''))
    } catch {
      throw new Error('The provider version service returned an invalid download URL.')
    }
    if (
      downloadUrl.protocol !== 'https:' ||
      downloadUrl.username ||
      downloadUrl.password ||
      !hostAllowed(downloadUrl.hostname, metadata.downloadHosts)
    ) {
      throw new Error('The provider runtime download is not from a trusted HTTPS host.')
    }
    if (!/\.msi$/i.test(downloadUrl.pathname)) {
      throw new Error('The provider runtime download is not an MSI installer.')
    }
    return {
      version,
      url: downloadUrl.toString(),
      signature: typeof payload?.signature === 'string' ? payload.signature : '',
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

function authenticode(file, signerSubject) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Provider runtime signature checks require Windows.'))
  }
  const quote = (value) => String(value).replace(/'/g, "''")
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${quote(file)}'`,
    `if ($signature.Status -ne 'Valid') { Write-Output ('INVALID|' + $signature.Status); exit 2 }`,
    `if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notlike '*${quote(signerSubject)}*') { Write-Output ('PUBLISHER|' + $signature.SignerCertificate.Subject); exit 3 }`,
    `Write-Output ('VALID|' + $signature.SignerCertificate.Subject)`,
  ].join('; ')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 45_000 },
      (error, stdout, stderr) => {
        const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
        if (error || !line.startsWith('VALID|')) {
          reject(
            new Error(
              `The provider runtime installer is not signed by ${signerSubject}. ${
                line || String(stderr || '').trim() || 'Signature check failed.'
              }`,
            ),
          )
          return
        }
        resolve(line.slice('VALID|'.length))
      },
    )
  })
}

function fileVersion(file) {
  if (process.platform !== 'win32') return Promise.resolve('')
  const quote = (value) => String(value).replace(/'/g, "''")
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${quote(file)}').VersionInfo.FileVersion`,
      ],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => resolve(error ? '' : String(stdout || '').trim()),
    )
  })
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function installMsi(file) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('The provider runtime MSI can only be installed on Windows.'))
      return
    }
    execFile(
      'msiexec.exe',
      ['/i', file, '/qn', '/norestart'],
      { windowsHide: true, timeout: INSTALL_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
        if (code === 0 || code === 3010) {
          resolve(code)
          return
        }
        reject(
          new Error(
            `The signed provider runtime could not be installed automatically (MSI exit ${code}). ` +
              `The verified installer was kept at ${file}.${stderr ? ` ${String(stderr).trim()}` : ''}`,
          ),
        )
      },
    )
  })
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Installers that need administrator rights run through one elevated
 * PowerShell. The same elevated process hides the launcher windows the vendor
 * setup auto-starts, because a non-elevated process cannot hide a window owned
 * by an elevated one.
 */
function installExeElevated(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('The provider launcher EXE can only be installed on Windows.'))
      return
    }
    const hideNames = cleanProcessNames(options.hideNames || [])
    const script = [
      WINDOW_HIDER_PS,
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$installer = ${psLiteral(file)}`,
      `$installerArgs = @(${args.map(psLiteral).join(', ')})`,
      `$hideTargets = @(${hideNames.map(psLiteral).join(', ')})`,
      'function Hide-TargetWindows { foreach ($target in $hideTargets) { Get-Process -Name $target -ErrorAction SilentlyContinue | ForEach-Object { [VaultedWindowHider]::Hide($_.Id) } } }',
      'if ($installerArgs.Count -gt 0) { $p = Start-Process -FilePath $installer -ArgumentList $installerArgs -WindowStyle Hidden -PassThru } else { $p = Start-Process -FilePath $installer -WindowStyle Hidden -PassThru }',
      'if ($null -eq $p) { exit 1 }',
      'Hide-TargetWindows',
      '$deadline = (Get-Date).AddMinutes(10)',
      'while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Hide-TargetWindows; Start-Sleep -Milliseconds 300 }',
      '# A setup can start the vendor launcher as it exits. Keep hiding it for a',
      '# short grace period so nothing pops up over VAULTED.',
      '$grace = (Get-Date).AddSeconds(20)',
      'while ((Get-Date) -lt $grace) { Hide-TargetWindows; Start-Sleep -Milliseconds 300 }',
      'if ($p.HasExited) { exit $p.ExitCode } else { exit 0 }',
    ].join('\r\n')

    const scriptPath = path.join(
      os.tmpdir(),
      `vaulted-install-${process.pid}-${Date.now()}.ps1`,
    )
    try {
      fs.writeFileSync(scriptPath, `${script}\r\n`, 'utf8')
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not prepare the installer script.'))
      return
    }

    const wrapper =
      `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(` +
      `'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',${psLiteral(
        scriptPath,
      )}) -Verb RunAs -WindowStyle Hidden -PassThru; ` +
      'if ($null -eq $p) { exit 1 }; $p.WaitForExit(); exit $p.ExitCode'

    let settled = false
    let probeTimer = null
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      if (probeTimer) clearInterval(probeTimer)
      callback(value)
    }
    // A portable launcher never exits, so the install step waits on the
    // documented install folder instead of the vendor process lifetime.
    if (typeof options.isInstalled === 'function') {
      probeTimer = setInterval(() => {
        if (settled) return
        try {
          if (options.isInstalled()) settle(resolve, 0)
        } catch {
          /* keep waiting for the documented install location */
        }
      }, 1_000)
      probeTimer.unref?.()
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', wrapper],
      { windowsHide: true, timeout: INSTALL_TIMEOUT_MS + 60_000 },
      (error, _stdout, stderr) => {
        fs.promises.rm(scriptPath, { force: true }).catch(() => {})
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
        if (code === 0 || code === 3010) {
          settle(resolve, code)
          return
        }
        const detail = String(stderr || '').trim()
        settle(
          reject,
          new Error(
            `The provider launcher installer needs Windows administrator approval. ` +
              `Approve the UAC prompt to finish installing it.${detail ? ` ${detail}` : ''}`,
          ),
        )
      },
    )
  })
}

function installExe(file, options = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('The provider launcher EXE can only be installed on Windows.'))
      return
    }
    const args = Array.isArray(options.silentArgs) ? options.silentArgs : []
    const wshLog = path.join(
      os.tmpdir(),
      `vaulted-wsh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
    )
    startWindowsScriptHostGuard(wshLog, { seconds: INSTALL_TIMEOUT_MS / 1000 + 30 })
    const readWshBlock = () => {
      try {
        const detail = fs.readFileSync(wshLog, 'utf8').trim()
        fs.rmSync(wshLog, { force: true })
        return detail
      } catch {
        return ''
      }
    }
    const child = spawn(file, args, {
      detached: false,
      stdio: 'ignore',
      // A silent vendor installer has no UI of its own; an interactive one must
      // stay visible so the player can confirm it.
      windowsHide: args.length > 0,
    })
    let settled = false
    let probeTimer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (probeTimer) clearInterval(probeTimer)
      const blockedWsh = readWshBlock()
      if (blockedWsh) {
        callback(
          reject,
          new Error(
            `The provider installer tried to run Windows Script Host and was blocked (${blockedWsh}). ` +
              'Its setup script was not allowed to finish.',
          ),
        )
        return
      }
      callback(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(
        reject,
        new Error('The provider launcher installer did not finish within 10 minutes.'),
      )
    }, INSTALL_TIMEOUT_MS)
    timer.unref?.()
    // Portable / Squirrel launchers start their own resident app and never let
    // the setup process exit. Watch the install location instead of waiting for
    // that process, so the season unlocks as soon as the launcher is on disk.
    if (typeof options.isInstalled === 'function') {
      probeTimer = setInterval(() => {
        if (settled) return
        try {
          if (options.isInstalled()) finish(resolve, 0)
        } catch {
          /* keep waiting for the documented install location */
        }
      }, 1_000)
      probeTimer.unref?.()
    }
    child.once('error', (error) => {
      // Node reports ERROR_ELEVATION_REQUIRED from CreateProcess as EACCES on
      // Windows. These installers carry a requireAdministrator manifest, so
      // relaunch them through ShellExecute with the normal UAC prompt instead
      // of surfacing a misleading permission error.
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        if (settled) return
        const blockedWsh = readWshBlock()
        if (blockedWsh) {
          settled = true
          clearTimeout(timer)
          reject(
            new Error(
              `The provider installer tried to run Windows Script Host and was blocked (${blockedWsh}).`,
            ),
          )
          return
        }
        settled = true
        clearTimeout(timer)
        installExeElevated(file, args, {
          isInstalled: options.isInstalled,
          hideNames: options.hideNames,
        }).then(resolve, reject)
        return
      }
      finish(reject, error)
    })
    child.once('exit', (code) => {
      if (code === 0 || code === 3010 || code === null) {
        finish(resolve, code ?? 0)
        return
      }
      finish(
        reject,
        new Error(
          `The provider launcher installer was closed before setup completed (exit ${code}).`,
        ),
      )
    })
  })
}

/** Poll for a launcher the vendor installer placed via its own bootstrap. */
async function waitForExecutable(metadata, env, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? INSTALL_DETECT_TIMEOUT_MS)
  const signal = options.signal
  for (;;) {
    const found = installedExecutable(metadata, env)
    if (found) return found
    if (signal?.aborted || Date.now() >= deadline) return ''
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

async function ensureProviderRuntime(providerId, metadata, options = {}) {
  if (!metadata || (metadata.kind !== 'msi' && metadata.kind !== 'exe')) return null
  const cacheKey = `${providerId}:${options.root}`
  if (runtimeTasks.has(cacheKey)) return runtimeTasks.get(cacheKey)

  const task = (async () => {
    const release = await resolveRelease(metadata, options)
    const expectedInfo = await probeReleaseInfo(release, options).catch(() => ({
      total: 0,
      etag: '',
      lastModified: '',
    }))
    const expectedSize = expectedInfo.total || 0
    const folder = runtimeFolder(options.root, providerId)
    const installer = path.join(folder, installerFileName(metadata, release.version))
    const metaPath = path.join(folder, 'runtime.json')
    let meta = null
    try {
      meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'))
    } catch {
      meta = null
    }

    let verified = false
    if (
      meta?.version === release.version &&
      meta?.url === release.url &&
      meta?.sha256 &&
      (!expectedSize || Number(meta.size) === expectedSize) &&
      (!expectedInfo.etag || meta?.etag === expectedInfo.etag) &&
      fs.existsSync(installer)
    ) {
      try {
        const size = (await fs.promises.stat(installer)).size
        if (size === Number(meta.size) && (await sha256File(installer)) === meta.sha256) {
          await validateInstaller(installer, metadata)
          if (metadata.signerSubject) await authenticode(installer, metadata.signerSubject)
          verified = true
        }
      } catch {
        verified = false
      }
    }

    if (!verified) {
      // A previous build may have accepted a short CDN response. Keep those
      // bytes as a resume seed instead of downloading them again.
      if (expectedSize > 0 && fs.existsSync(installer)) {
        try {
          const existingSize = (await fs.promises.stat(installer)).size
          if (existingSize > 0 && existingSize < expectedSize) {
            await fs.promises.rm(`${installer}.part`, { force: true })
            await fs.promises.rename(installer, `${installer}.part`)
          }
        } catch {
          /* a fresh download is still safe */
        }
      }
      options.report?.({
        received: 0,
        total: 0,
        percent: 0,
        etaSeconds: null,
        bytesPerSecond: null,
        phase: 'runtime',
        url: release.url,
      })
      const downloaded = await downloadInstaller(release, metadata, {
        ...options,
        target: installer,
      })
      const publisher = metadata.signerSubject
        ? await authenticode(installer, metadata.signerSubject)
        : 'unsigned-interactive-installer'
      meta = {
        version: release.version,
        url: release.url,
        size: downloaded.size,
        total: downloaded.total || downloaded.size,
        etag: downloaded.etag || expectedInfo.etag || '',
        lastModified: downloaded.lastModified || expectedInfo.lastModified || '',
        sha256: downloaded.sha256,
        publisher,
        verifiedAt: new Date().toISOString(),
      }
      await fs.promises.mkdir(folder, { recursive: true })
      await fs.promises.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    }

    // Never hand an archive with an embedded setup script to Windows. This
    // blocks WinRAR SFX droppers before they can extract a script into RarSFX*
    // and launch wscript.exe.
    try {
      await assertInstallerSafe(installer, options)
    } catch (error) {
      await fs.promises.rm(metaPath, { force: true }).catch(() => {})
      throw error
    }

    let executable = installedExecutable(metadata, options.env)
    // A launcher that is on disk but crashes on startup is not a working
    // install. `forceInstall` runs the vendor's own setup again over it, which
    // is the only repair that restores its bundled Flutter assets.
    const currentInstall =
      options.forceInstall !== true &&
      executable &&
      (metadata.kind === 'exe' || (await fileVersion(executable)).startsWith(release.version))
    if (!currentInstall && metadata.autoInstall !== false && options.install !== false) {
      options.report?.({
        received: meta.size,
        total: meta.size,
        percent: 100,
        etaSeconds: null,
        bytesPerSecond: null,
        phase: 'installing',
        url: release.url,
      })
      if (metadata.kind === 'msi') {
        await installMsi(installer)
      } else {
        const silentArgs = Array.isArray(metadata.silentArgs) ? metadata.silentArgs : []
        // Squirrel-based setups start the vendor launcher as they finish.
        // Hide those windows from the moment the installer runs so no
        // third-party UI can appear over VAULTED.
        const hideNames = cleanProcessNames([
          metadata.processName,
          ...(metadata.executableNames || []),
        ])
        startHiddenWindowWatcher(hideNames, { seconds: 240 })
        await installExe(installer, {
          silentArgs,
          hideNames,
          isInstalled: () => installedExecutable(metadata, options.env),
        })
        executable = await waitForExecutable(metadata, options.env, {
          timeoutMs: silentArgs.length > 0 ? INSTALL_DETECT_TIMEOUT_MS : 0,
          signal: options.signal,
        })
        if (!executable && silentArgs.length > 0) {
          // Some vendor setups ignore a silent switch and need the player to
          // confirm their official UI. Never send the player to a website.
          options.report?.({
            received: meta.size,
            total: meta.size,
            percent: 100,
            etaSeconds: null,
            bytesPerSecond: null,
            phase: 'installing',
            url: release.url,
          })
          await installExe(installer, {
            silentArgs: [],
            isInstalled: () => installedExecutable(metadata, options.env),
          })
        }
      }
      executable = await waitForExecutable(metadata, options.env, {
        signal: options.signal,
      })
      if (!executable) {
        throw new Error(
          `The ${metadata.label} installer finished, but ${metadata.processName} was not found in its documented install folders. Press Install again to retry; VAULTED never opens the project website instead.`,
        )
      }
      await fs.promises.writeFile(
        path.join(folder, 'installed.json'),
        `${JSON.stringify({ version: release.version, executable, installedAt: new Date().toISOString() }, null, 2)}\n`,
      )
    }

    return {
      providerId,
      version: release.version,
      installer,
      executable,
      installed: Boolean(executable),
      sha256: meta.sha256,
      publisher: meta.publisher,
    }
  })()

  runtimeTasks.set(cacheKey, task)
  try {
    return await task
  } finally {
    runtimeTasks.delete(cacheKey)
  }
}

module.exports = {
  downloadInstaller,
  ensureProviderRuntime,
  installExe,
  installedExecutable,
  installedExecutables,
  launchArguments,
  resolveRelease,
  validateInstaller,
  waitForExecutable,
}
