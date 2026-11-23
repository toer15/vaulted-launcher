'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const path = require('node:path')

/**
 * Launcher installers are large binaries served by CDNs that routinely reset
 * connections. A raw fetch() stream reports that reset as `TypeError:
 * terminated` and loses every byte already received. This module downloads
 * through Chromium's network stack first, then pooled Node HTTPS, keeps a
 * `.part` file, and resumes with an HTTP Range request after a drop. A hidden
 * Electron BrowserWindow download is the last resort for hosts that block
 * direct requests. The finished file must have a real Windows installer header
 * before anything is executed.
 */

const MIN_INSTALLER_BYTES = 64 * 1024
const MAX_INSTALLER_BYTES = 900 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const DOWNLOAD_ATTEMPTS = 8
// Echo's LiteSpeed endpoint injects an error page into any response larger than
// about 524 MB. Bounded ranges keep every response below that server limit.
const DOWNLOAD_RANGE_CHUNK_BYTES = 384 * 1024 * 1024
const DOWNLOAD_RETRY_DELAY_MS = 900
const MAX_REDIRECTS = 6
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 })
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 })

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function browserHeaders(offset = 0, partMeta = null, rangeEnd = 0) {
  const headers = {
    accept: 'application/octet-stream, application/x-msdownload, */*',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'identity',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'user-agent': USER_AGENT,
  }
  // Do not send Range on the first request: some CDNs answer a zero Range with
  // a chunked stream and no total, which makes a short read indistinguishable
  // from a complete file. Resume requests still use an explicit Range.
  if (offset > 0 || rangeEnd > 0) {
    headers.range = `bytes=${offset}-${rangeEnd > 0 ? rangeEnd : ''}`
    // If the host's file changed, If-Range makes it send 200 (the full file)
    // instead of a 206 that would splice two different binaries together.
    if (offset > 0 && partMeta?.etag) headers['if-range'] = partMeta.etag
    else if (offset > 0 && partMeta?.lastModified) headers['if-range'] = partMeta.lastModified
  }
  return headers
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

async function removeQuietly(file) {
  await fs.promises.rm(file, { force: true }).catch(() => {})
}

function readPartMeta(part) {
  try {
    return JSON.parse(fs.readFileSync(`${part}.json`, 'utf8'))
  } catch {
    return null
  }
}

async function removePart(part) {
  await removeQuietly(part)
  await removeQuietly(`${part}.json`)
}

function rememberPart(part, release, total, headers) {
  const etag = headers?.etag || headers?.ETag || ''
  const lastModified = headers?.['last-modified'] || headers?.['Last-Modified'] || ''
  if (!etag && !lastModified && !total) return
  try {
    fs.writeFileSync(
      `${part}.json`,
      JSON.stringify({ url: release.url, total: total || 0, etag, lastModified }),
    )
  } catch {
    /* resume still works from the byte count when this cannot be written */
  }
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim())
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? 0 : Number(match[3]),
  }
}

function isCancelled(error) {
  return /cancelled|canceled|aborted/i.test(error instanceof Error ? error.message : String(error || ''))
}

function isUnsafe(error) {
  return /unsafe size|exceeded the safe size|not a valid Windows installer|empty or truncated/i.test(
    error instanceof Error ? error.message : String(error || ''),
  )
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error || 'The launcher download failed.'))
}

function progressReporter(options, initialTotal, startedAt) {
  let lastSent = 0
  let lastReceived = 0
  let total = initialTotal
  return (received, nextTotal = total) => {
    if (nextTotal > 0) total = nextTotal
    const now = Date.now()
    if (now - lastSent < 250 && received !== total) return
    const elapsed = Math.max(0.001, (now - startedAt) / 1000)
    const delta = Math.max(0, received - lastReceived)
    lastReceived = received
    lastSent = now
    options.report?.({
      received,
      total,
      percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
      etaSeconds:
        total > 0 && delta > 0
          ? Math.max(0, Math.round((total - received) / (delta / Math.max(0.25, elapsed))))
          : null,
      bytesPerSecond: Math.round(received / elapsed),
      phase: 'runtime',
      url: options.url || '',
    })
  }
}

/**
 * Validate the first bytes before an installer is ever executed. EXE setups
 * start with `MZ`; MSI packages are OLE compound files (and some vendors wrap
 * an MSI in an MZ self-extractor, which is accepted too).
 */
async function validateInstaller(file, metadata) {
  let stat
  try {
    stat = await fs.promises.stat(file)
  } catch {
    throw new Error('The launcher installer was not written to disk.')
  }
  if (!stat.isFile() || stat.size < MIN_INSTALLER_BYTES) {
    throw new Error('The launcher installer was empty or truncated.')
  }
  if (stat.size > MAX_INSTALLER_BYTES) {
    throw new Error(`The launcher installer has an unsafe size (${stat.size} bytes).`)
  }
  const handle = await fs.promises.open(file, 'r')
  const header = Buffer.alloc(8)
  try {
    await handle.read(header, 0, header.length, 0)
  } finally {
    await handle.close()
  }
  const isMz = header[0] === 0x4d && header[1] === 0x5a
  const isMsi = header.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  const expectedMsi = String(metadata?.kind || '').toLowerCase() === 'msi'
  if (expectedMsi ? !(isMsi || isMz) : !isMz) {
    throw new Error(
      `The launcher download is not a valid Windows installer${expectedMsi ? ' (MSI)' : ' (MZ)'}. ` +
        'The host may have returned an error page instead of the setup file.',
    )
  }
  const sha256 = await sha256File(file)
  return { size: stat.size, sha256 }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function electronRuntime() {
  try {
    // In Electron main this is the module object; in plain Node it is a path
    // string, so the guards below keep unit tests and repair scripts working.
    const electron = require('electron')
    if (electron && electron.app && electron.net && electron.BrowserWindow) return electron
  } catch {
    /* not running under Electron */
  }
  return null
}

function writeAllSync(fd, chunk) {
  let written = 0
  while (written < chunk.length) {
    written += fs.writeSync(fd, chunk, written, chunk.length - written)
  }
}

/**
 * One Range-aware attempt through Chromium's network stack. The caller keeps
 * `.part`, so a reset is resumed rather than restarted.
 */
function downloadViaElectronNet(release, part, metadata, options) {
  const electron = electronRuntime()
  if (!electron) {
    return Promise.reject(new Error('Electron network transport is unavailable.'))
  }
  const offset = fileSize(part)
  const partMeta = readPartMeta(part)
  const expected = Number(options.expectedTotal) || 0
  const rangeEnd =
    expected > offset
      ? Math.min(expected - 1, offset + DOWNLOAD_RANGE_CHUNK_BYTES - 1)
      : offset + DOWNLOAD_RANGE_CHUNK_BYTES - 1
  const requestUrl = new URL(release.url)
  if (!['https:', 'http:'].includes(requestUrl.protocol)) {
    return Promise.reject(new Error('The launcher download URL is not HTTP(S).'))
  }
  const startedAt = Date.now()
  const report = progressReporter({ ...options, url: release.url }, 0, startedAt)
  return new Promise((resolve, reject) => {
    let settled = false
    let received = 0
    let total = 0
    let fd = null
    let response = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {}
        fd = null
      }
      callback(value)
    }
    const fail = (error) => finish(reject, asError(error))
    const abort = () => {
      try {
        request?.abort()
      } catch {}
      fail(new Error('The launcher download was cancelled.'))
    }
    let timer = setTimeout(() => {
      try {
        request?.abort()
      } catch {}
      fail(new Error('The launcher download took too long.'))
    }, DOWNLOAD_TIMEOUT_MS)
    options.signal?.addEventListener('abort', abort, { once: true })

    let request
    try {
      request = electron.net.request({
        method: 'GET',
        url: release.url,
        redirect: 'follow',
        headers: browserHeaders(offset, partMeta, rangeEnd),
      })
    } catch (error) {
      fail(error)
      return
    }

    request.on('response', (incoming) => {
      response = incoming
      const status = Number(incoming.statusCode) || 0
      if (status === 416) {
        const range = parseContentRange(
          incoming.responseHeaders?.['content-range'] ||
            incoming.responseHeaders?.['Content-Range'],
        )
        if (offset > 0 && range && range.total > 0 && offset >= range.total) {
          finish(resolve, { part, received: offset, total: range.total })
        } else {
          fail(new Error('The launcher server rejected the resume range.'))
        }
        return
      }
      if (status !== 200 && status !== 206) {
        const error = new Error(`The provider runtime download returned HTTP ${status}.`)
        error.status = status
        error.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429 && status !== 403
        fail(error)
        return
      }
      const contentRange = parseContentRange(
        incoming.responseHeaders?.['content-range'] ||
          incoming.responseHeaders?.['Content-Range'],
      )
      const lengthHeader =
        incoming.responseHeaders?.['content-length'] ||
        incoming.responseHeaders?.['Content-Length']
      const length = Number(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader) || 0
      const append = status === 206 && offset > 0
      if (status === 206 && contentRange && contentRange.start !== offset) {
        fail(new Error('The launcher server resumed from the wrong byte offset.'))
        return
      }
      total =
        status === 206 && contentRange
          ? contentRange.total
          : length || Number(options.expectedTotal) || 0
      rememberPart(part, release, total, incoming.responseHeaders || {})
      if (total > MAX_INSTALLER_BYTES) {
        fail(new Error(`The provider runtime installer exceeded the safe size limit (${total} bytes).`))
        return
      }
      try {
        fd = fs.openSync(part, append ? 'a' : 'w')
      } catch (error) {
        fail(error)
        return
      }
      incoming.on('data', (chunk) => {
        if (settled) return
        received += chunk.length
        if (received + (append ? offset : 0) > MAX_INSTALLER_BYTES) {
          fail(new Error('The provider runtime installer exceeded the safe size limit.'))
          return
        }
        try {
          writeAllSync(fd, chunk)
        } catch (error) {
          fail(error)
          return
        }
        report(received + (append ? offset : 0), total)
      })
      incoming.once('aborted', () => fail(new Error('The launcher connection was reset.')))
      incoming.once('error', fail)
      incoming.once('end', () => {
        if (settled) return
        if (fd !== null) {
          try {
            fs.closeSync(fd)
          } catch {}
          fd = null
        }
        const finalSize = fileSize(part)
        if (total > 0 && finalSize < total) {
          fail(new Error(`The launcher download stopped at ${finalSize} of ${total} bytes.`))
          return
        }
        finish(resolve, { part, received: finalSize, total: total || finalSize })
      })
    })
    request.once('error', fail)
    request.end()
  })
}

/**
 * One Range-aware attempt through pooled Node HTTPS/HTTP, including redirects
 * (GitHub release downloads redirect to release-assets.githubusercontent.com).
 */
function downloadViaHttp(release, part, metadata, options, redirects = 0) {
  const offset = fileSize(part)
  const partMeta = readPartMeta(part)
  const expected = Number(options.expectedTotal) || 0
  const rangeEnd =
    expected > offset
      ? Math.min(expected - 1, offset + DOWNLOAD_RANGE_CHUNK_BYTES - 1)
      : offset + DOWNLOAD_RANGE_CHUNK_BYTES - 1
  const url = new URL(release.url)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    return Promise.reject(new Error('The launcher download URL is not a safe HTTP(S) URL.'))
  }
  const transport = url.protocol === 'https:' ? https : http
  const agent = url.protocol === 'https:' ? httpsAgent : httpAgent
  const startedAt = Date.now()
  const report = progressReporter({ ...options, url: release.url }, 0, startedAt)
  return new Promise((resolve, reject) => {
    let settled = false
    let received = 0
    let total = 0
    let fd = null
    let request = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {}
        fd = null
      }
      callback(value)
    }
    const fail = (error) => finish(reject, asError(error))
    const abort = () => {
      try {
        request?.destroy()
      } catch {}
      fail(new Error('The launcher download was cancelled.'))
    }
    let timer = setTimeout(() => {
      try {
        request?.destroy()
      } catch {}
      fail(new Error('The launcher download took too long.'))
    }, DOWNLOAD_TIMEOUT_MS)
    options.signal?.addEventListener('abort', abort, { once: true })

    try {
      request = transport.request(
        url,
        {
          method: 'GET',
          agent,
          headers: browserHeaders(offset, partMeta, rangeEnd),
          timeout: DOWNLOAD_TIMEOUT_MS,
        },
        (incoming) => {
          const status = Number(incoming.statusCode) || 0
          if ([301, 302, 303, 307, 308].includes(status)) {
            incoming.resume()
            const location = incoming.headers.location
            if (!location || redirects >= MAX_REDIRECTS) {
              fail(new Error('The launcher download redirected too many times.'))
              return
            }
            const next = new URL(location, url).toString()
            finish(resolve, downloadViaHttp({ ...release, url: next }, part, metadata, options, redirects + 1))
            return
          }
          if (status === 416) {
            const range = parseContentRange(incoming.headers['content-range'])
            if (offset > 0 && range && range.total > 0 && offset >= range.total) {
              finish(resolve, { part, received: offset, total: range.total })
            } else {
              fail(new Error('The launcher server rejected the resume range.'))
            }
            incoming.resume()
            return
          }
          if (status !== 200 && status !== 206) {
            const error = new Error(`The provider runtime download returned HTTP ${status}.`)
            error.status = status
            error.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429 && status !== 403
            fail(error)
            incoming.resume()
            return
          }
          const contentRange = parseContentRange(incoming.headers['content-range'])
          const length = Number(incoming.headers['content-length']) || 0
          const append = status === 206 && offset > 0
          if (status === 206 && contentRange && contentRange.start !== offset) {
            fail(new Error('The launcher server resumed from the wrong byte offset.'))
            incoming.resume()
            return
          }
          total =
            status === 206 && contentRange
              ? contentRange.total
              : length || Number(options.expectedTotal) || 0
          rememberPart(part, release, total, incoming.headers || {})
          if (total > MAX_INSTALLER_BYTES) {
            fail(new Error(`The provider runtime installer exceeded the safe size limit (${total} bytes).`))
            incoming.resume()
            return
          }
          try {
            fd = fs.openSync(part, append ? 'a' : 'w')
          } catch (error) {
            fail(error)
            incoming.resume()
            return
          }
          incoming.on('data', (chunk) => {
            if (settled) return
            received += chunk.length
            if (received + (append ? offset : 0) > MAX_INSTALLER_BYTES) {
              fail(new Error('The provider runtime installer exceeded the safe size limit.'))
              return
            }
            try {
              writeAllSync(fd, chunk)
            } catch (error) {
              fail(error)
              return
            }
            report(received + (append ? offset : 0), total)
          })
          incoming.once('aborted', () => fail(new Error('The launcher connection was reset.')))
          incoming.once('error', fail)
          incoming.once('end', () => {
            if (settled) return
            if (fd !== null) {
              try {
                fs.closeSync(fd)
              } catch {}
              fd = null
            }
            const finalSize = fileSize(part)
            if (total > 0 && finalSize < total) {
              fail(new Error(`The launcher download stopped at ${finalSize} of ${total} bytes.`))
              return
            }
            finish(resolve, { part, received: finalSize, total: total || finalSize })
          })
        },
      )
    } catch (error) {
      fail(error)
      return
    }
    request.once('error', fail)
    request.once('timeout', () => fail(new Error('The launcher connection timed out.')))
    request.end()
  })
}

/**
 * Last-resort Chromium download session. It is off-screen for its whole life
 * and never becomes visible or focused.
 */
function downloadViaBrowserWindow(release, part, metadata, options) {
  const electron = electronRuntime()
  if (!electron) {
    return Promise.reject(new Error('The Electron download session is unavailable.'))
  }
  if (typeof electron.app.isReady === 'function' && !electron.app.isReady()) {
    return Promise.reject(new Error('The Electron download session is not ready yet.'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let window = null
    let timer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (window && !window.isDestroyed()) window.destroy()
      callback(value)
    }
    const fail = (error) => finish(reject, asError(error))
    const abort = () => fail(new Error('The launcher download was cancelled.'))
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      window = new electron.BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        skipTaskbar: true,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      const session = window.webContents.session
      const onWillDownload = (_event, item) => {
        try {
          item.setSavePath(part)
        } catch (error) {
          fail(error)
          return
        }
        item.on('updated', (_event, state) => {
          if (state !== 'progressing') return
          const received = item.getReceivedBytes()
          const total = item.getTotalBytes()
          options.report?.({
            received,
            total,
            percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
            etaSeconds: null,
            bytesPerSecond: null,
            phase: 'runtime',
            url: release.url,
          })
        })
        item.once('done', (_event, state) => {
          if (state === 'completed') {
            const size = fileSize(part)
            if (size < MIN_INSTALLER_BYTES) {
              fail(new Error('The launcher installer was empty or truncated.'))
              return
            }
            finish(resolve, { part, received: size, total: size })
            return
          }
          fail(new Error(`The Electron download session stopped: ${state}.`))
        })
      }
      session.once('will-download', onWillDownload)
      timer = setTimeout(() => fail(new Error('The launcher download took too long.')), DOWNLOAD_TIMEOUT_MS)
      window.loadURL('about:blank').catch(() => {})
      session.downloadURL(release.url)
    } catch (error) {
      fail(error)
    }
  })
}

async function finalize(part, target, metadata, options, expectedTotal = 0) {
  const verified = await validateInstaller(part, metadata)
  if (expectedTotal > 0 && verified.size !== expectedTotal) {
    throw new Error(
      `The launcher download is incomplete (${verified.size} of ${expectedTotal} bytes); resuming.`,
    )
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.rm(target, { force: true })
  await fs.promises.rename(part, target)
  await removeQuietly(`${part}.json`)
  options.report?.({
    received: verified.size,
    total: verified.size,
    percent: 100,
    etaSeconds: null,
    bytesPerSecond: null,
    phase: 'runtime',
    url: options.url || '',
  })
  return { ...verified, total: expectedTotal || verified.size }
}

/**
 * Ask the host for the total byte count before downloading. HEAD is enough on
 * most CDNs; a one-byte Range request covers hosts that reject HEAD but still
 * advertise Content-Range. A failed probe returns 0 and leaves the normal
 * Content-Length/Content-Range checks in charge.
 */
function probeReleaseInfo(release, options = {}) {
  let initial
  try {
    initial = new URL(release.url)
  } catch {
    return Promise.resolve({ total: 0, etag: '', lastModified: '' })
  }
  if (!['https:', 'http:'].includes(initial.protocol) || initial.username || initial.password) {
    return Promise.resolve({ total: 0, etag: '', lastModified: '' })
  }
  return new Promise((resolve) => {
    let settled = false
    let active = null
    let etag = ''
    let lastModified = ''
    const finish = (total) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        active?.destroy()
      } catch {}
      resolve({ total: total > 0 ? total : 0, etag, lastModified })
    }
    const timer = setTimeout(() => finish(0), 20_000)
    const request = (url, method, headers, redirects, followed) => {
      const transport = url.protocol === 'https:' ? https : http
      const agent = url.protocol === 'https:' ? httpsAgent : httpAgent
      try {
        active = transport.request(
          url,
          { method, agent, headers, timeout: 20_000 },
          (incoming) => {
            const status = Number(incoming.statusCode) || 0
            etag = String(incoming.headers.etag || '')
            lastModified = String(incoming.headers['last-modified'] || '')
            if ([301, 302, 303, 307, 308].includes(status) && incoming.headers.location) {
              incoming.resume()
              if (redirects >= MAX_REDIRECTS) {
                finish(0)
                return
              }
              request(new URL(incoming.headers.location, url), method, headers, redirects + 1, followed)
              return
            }
            if (status === 405 || status === 403) {
              incoming.resume()
              if (!followed) {
                request(url, 'GET', { ...headers, range: 'bytes=0-0' }, redirects, true)
              } else {
                finish(0)
              }
              return
            }
            const range = parseContentRange(incoming.headers['content-range'])
            const total =
              (range && range.total) || Number(incoming.headers['content-length']) || 0
            incoming.resume()
            finish(total)
          },
        )
      } catch {
        finish(0)
        return
      }
      active.once('error', () => finish(0))
      active.once('timeout', () => finish(0))
      active.end()
    }
    request(initial, 'HEAD', browserHeaders(0), 0, false)
  })
}

function probeTotalSize(release, options = {}) {
  return probeReleaseInfo(release, options)
    .then((info) => info.total)
    .catch(() => 0)
}

async function downloadDirect(release, part, metadata, options) {
  let firstError = null
  if (electronRuntime()) {
    try {
      return await downloadViaElectronNet(release, part, metadata, { ...options, expectedTotal: options.expectedTotal })
    } catch (error) {
      firstError = asError(error)
      if (isCancelled(firstError) || isUnsafe(firstError)) throw firstError
    }
  }
  try {
    return await downloadViaHttp(release, part, metadata, options)
  } catch (error) {
    const next = asError(error)
    if (firstError) next.cause = firstError
    throw next
  }
}

/**
 * Download an installer with byte-resume across every retry. A connection reset
 * leaves `.part` intact; the next attempt asks for `bytes=<received>-` instead
 * of starting over. If direct transports keep failing, one hidden Chromium
 * download session is tried before the error is reported.
 */
async function downloadInstaller(release, metadata, options = {}) {
  const target = String(options.target || '')
  if (!target) throw new Error('The launcher download has no destination.')
  const part = `${target}.part`
  const releaseInfo = await probeReleaseInfo(release, options).catch(() => ({
    total: 0,
    etag: '',
    lastModified: '',
  }))
  const expectedTotal = releaseInfo.total || 0
  if (expectedTotal > MAX_INSTALLER_BYTES) {
    throw new Error(`The launcher installer has an unsafe size (${expectedTotal} bytes).`)
  }
  const existingMeta = readPartMeta(part)
  if (
    fileSize(part) > 0 &&
    (!existingMeta ||
      existingMeta.url !== release.url ||
      (expectedTotal > 0 && Number(existingMeta.total) !== expectedTotal))
  ) {
    await removePart(part)
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.rm(target, { force: true }).catch(() => {})
  let lastError = null
  let browserTried = false
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw new Error('The launcher download was cancelled.')
    try {
      await downloadDirect(release, part, metadata, { ...options, expectedTotal })
      const finalized = await finalize(part, target, metadata, options, expectedTotal)
      return { ...finalized, etag: releaseInfo.etag, lastModified: releaseInfo.lastModified }
    } catch (error) {
      lastError = asError(error)
      if (isCancelled(lastError) || isUnsafe(lastError)) {
        await removePart(part)
        throw lastError
      }
      const incomplete = /download is incomplete|stopped at \d+ of \d+ bytes/i.test(
        lastError instanceof Error ? lastError.message : String(lastError),
      )
      if (
        !incomplete &&
        !browserTried &&
        electronRuntime() &&
        (lastError.status === 403 || attempt === DOWNLOAD_ATTEMPTS)
      ) {
        browserTried = true
        try {
          await removePart(part)
          await downloadViaBrowserWindow(release, part, metadata, options)
          const finalized = await finalize(part, target, metadata, options, expectedTotal)
          return { ...finalized, etag: releaseInfo.etag, lastModified: releaseInfo.lastModified }
        } catch (fallbackError) {
          lastError = asError(fallbackError)
        }
      }
      if (lastError.permanent === true || attempt === DOWNLOAD_ATTEMPTS) break
      await delay(DOWNLOAD_RETRY_DELAY_MS * attempt)
    }
  }
  await removePart(part)
  throw lastError || new Error('The launcher download failed.')
}

module.exports = {
  MIN_INSTALLER_BYTES,
  MAX_INSTALLER_BYTES,
  downloadInstaller,
  downloadViaBrowserWindow,
  downloadViaElectronNet,
  downloadViaHttp,
  probeReleaseInfo,
  probeTotalSize,
  validateInstaller,
}
