'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

/**
 * Download and verify a provider's documented desktop runtime.
 *
 * This module only understands catalog metadata that main has already
 * validated. It never accepts a URL or a filesystem path from the renderer.
 * The release endpoint is the provider's own version service; the installer
 * must be an HTTPS MSI from a configured host and must carry a valid
 * Authenticode signature from the configured publisher.
 */

const VERSION_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const INSTALL_TIMEOUT_MS = 4 * 60_000
const MIN_INSTALLER_BYTES = 64 * 1024
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024
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
  if (!/^[^\\/:*?"<>|]+\.msi$/i.test(name)) {
    throw new Error('The provider runtime metadata has an invalid installer name.')
  }
  return name
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
  return ''
}

function launchArguments(metadata, version) {
  const manifestId = metadata.manifestIds?.[String(version || '').trim()]
  if (!manifestId) return null
  return (metadata.launchArgs || []).map((arg) =>
    String(arg).replace(/\{manifestId\}/g, manifestId),
  )
}

function runtimeFolder(root, providerId) {
  return path.join(root, String(providerId || 'provider').replace(/[^a-z0-9-]/gi, ''))
}

async function resolveRelease(metadata, options = {}) {
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

async function downloadInstaller(release, metadata, options) {
  const fetchImpl = options.fetchImpl || fetch
  const target = options.target
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const part = `${target}.part`
  let received = 0
  let total = 0
  let lastSent = 0
  let startedAt = Date.now()
  try {
    const response = await fetchImpl(release.url, {
      headers: { accept: 'application/octet-stream', 'user-agent': 'VAULTED-Launcher' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`The provider runtime download returned HTTP ${response.status}.`)
    }
    total = Number(response.headers.get('content-length')) || 0
    if (total > 0 && (total < MIN_INSTALLER_BYTES || total > MAX_INSTALLER_BYTES)) {
      throw new Error(`The provider runtime installer has an unsafe size (${total} bytes).`)
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.rm(part, { force: true })
    const output = fs.createWriteStream(part, { flags: 'wx' })
    let outputError = null
    output.once('error', (error) => {
      outputError = error
    })
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (options.signal?.aborted) throw new Error('The provider runtime download was cancelled.')
        const chunk = Buffer.from(value)
        received += chunk.length
        if (received > MAX_INSTALLER_BYTES) {
          throw new Error('The provider runtime installer exceeded the safe size limit.')
        }
        await new Promise((resolve, reject) => {
          output.write(chunk, (error) => (error ? reject(error) : resolve()))
        })
        if (outputError) throw outputError
        const now = Date.now()
        if (now - lastSent >= 250) {
          const elapsed = Math.max(0.001, (now - startedAt) / 1000)
          options.report?.({
            received,
            total,
            percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
            etaSeconds:
              total > 0 ? Math.max(0, Math.round((total - received) / (received / elapsed))) : null,
            bytesPerSecond: Math.round(received / elapsed),
            phase: 'runtime',
            url: release.url,
          })
          lastSent = now
        }
      }
      await new Promise((resolve, reject) => {
        output.once('error', reject)
        output.end(resolve)
      })
    } catch (error) {
      output.destroy()
      await fs.promises.rm(part, { force: true }).catch(() => {})
      throw error
    }
    if (received < MIN_INSTALLER_BYTES) {
      await fs.promises.rm(part, { force: true }).catch(() => {})
      throw new Error('The provider runtime installer was empty or truncated.')
    }
    await fs.promises.rename(part, target)
    options.report?.({
      received,
      total: received,
      percent: 100,
      etaSeconds: null,
      bytesPerSecond: null,
      phase: 'runtime',
      url: release.url,
    })
    return { size: received, sha256: await sha256File(target) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    await fs.promises.rm(part, { force: true }).catch(() => {})
  }
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

async function ensureProviderRuntime(providerId, metadata, options = {}) {
  if (!metadata || metadata.kind !== 'msi') return null
  const cacheKey = `${providerId}:${options.root}`
  if (runtimeTasks.has(cacheKey)) return runtimeTasks.get(cacheKey)

  const task = (async () => {
    const release = await resolveRelease(metadata, options)
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
      fs.existsSync(installer)
    ) {
      try {
        const size = (await fs.promises.stat(installer)).size
        if (size === Number(meta.size) && (await sha256File(installer)) === meta.sha256) {
          await authenticode(installer, metadata.signerSubject)
          verified = true
        }
      } catch {
        verified = false
      }
    }

    if (!verified) {
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
      const publisher = await authenticode(installer, metadata.signerSubject)
      meta = {
        version: release.version,
        url: release.url,
        size: downloaded.size,
        sha256: downloaded.sha256,
        publisher,
        verifiedAt: new Date().toISOString(),
      }
      await fs.promises.mkdir(folder, { recursive: true })
      await fs.promises.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    }

    let executable = installedExecutable(metadata, options.env)
    const currentInstall =
      executable && (await fileVersion(executable)).startsWith(release.version)
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
      await installMsi(installer)
      executable = installedExecutable(metadata, options.env)
      if (!executable) {
        throw new Error(
          `The signed provider runtime installed, but ${metadata.processName} was not found in its documented install folders.`,
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
  ensureProviderRuntime,
  installedExecutable,
  launchArguments,
  resolveRelease,
}
