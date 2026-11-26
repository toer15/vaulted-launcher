'use strict'

const events = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')

/**
 * High-throughput byte-range downloader.
 *
 * A single TCP stream rarely fills a fast fibre connection because of per-flow
 * congestion control and the mirror's per-connection throttling. This engine
 * opens many keep-alive connections and writes each range straight to its byte
 * offset in one pre-allocated file, so no archive is ever held in memory.
 *
 * Hosts that ignore `Range` are detected by the probe and the caller falls back
 * to a single stream; nothing here ever corrupts a partially downloaded file.
 */

const REQUEST_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5
const WRITE_BATCH_BYTES = 2 * 1024 * 1024
const MAX_CONNECTIONS = 24
const MIN_PARALLEL_BYTES = 2 * 1024 * 1024

class RangeUnsupportedError extends Error {}

let poolSize = 0
let agents = null

function createDownloadPool(connections) {
  const size = Math.max(1, Math.min(MAX_CONNECTIONS, Math.round(connections) || 8))
  if (agents && poolSize >= size) return agents
  const options = {
    keepAlive: true,
    maxSockets: size,
    maxFreeSockets: size,
    scheduling: 'lifo',
    timeout: REQUEST_TIMEOUT_MS,
  }
  agents = { http: new http.Agent(options), https: new https.Agent(options), size }
  poolSize = size
  return agents
}

function abortError() {
  const error = new Error('Download cancelled')
  error.name = 'AbortError'
  return error
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** One GET with keep-alive reuse and redirect following, returning the raw stream. */
function requestStream(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error('The download URL is not valid.'))
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error('The download URL must use http(s).'))
      return
    }
    if (options.signal?.aborted) {
      reject(abortError())
      return
    }
    const pool = createDownloadPool(options.connections ?? poolSize ?? 8)
    const lib = target.protocol === 'http:' ? http : https
    const agent = target.protocol === 'http:' ? pool.http : pool.https
    let activeResponse = null
    const request = lib.request(
      target,
      {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        agent,
      },
      (response) => {
        activeResponse = response
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(status) && location && redirects < MAX_REDIRECTS) {
          response.resume()
          cleanup()
          requestStream(new URL(location, target).toString(), options, redirects + 1).then(
            resolve,
            reject,
          )
          return
        }
        // Stay attached while the body streams: an abort must be able to stop a
        // transfer that already received its headers.
        response.once('close', cleanup)
        response.once('end', cleanup)
        resolve({
          status,
          headers: response.headers,
          stream: response,
          url: target.toString(),
        })
      },
    )

    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort)
      activeResponse?.removeListener('close', cleanup)
      activeResponse?.removeListener('end', cleanup)
    }
    const onAbort = () => {
      request.destroy(abortError())
      activeResponse?.destroy?.(abortError())
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    request.on('error', (error) => {
      cleanup()
      reject(options.signal?.aborted ? abortError() : error)
    })
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Download connection stalled'))
    })
    request.end()
  })
}

async function writeAt(handle, buffer, position) {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesWritten) throw new Error('Could not write the download to disk.')
    offset += bytesWritten
  }
}

/**
 * Connections scale with the archive size: small files stay simple, and
 * multi-gigabyte builds use the full 24-socket pool. `VAULTED_DOWNLOAD_CONNECTIONS`
 * overrides the pool for testing or unusual links.
 */
function connectionCount(total, override) {
  const configured = Number(override ?? process.env.VAULTED_DOWNLOAD_CONNECTIONS)
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(MAX_CONNECTIONS, Math.round(configured)))
  }
  if (!(total > 0)) return 8
  if (total < MIN_PARALLEL_BYTES) return 1
  if (total < 8 * 1024 * 1024) return 2
  if (total < 32 * 1024 * 1024) return 6
  if (total < 64 * 1024 * 1024) return 12
  // Archive.org scales to roughly two dozen parallel requests per client.
  // Beyond that it starts throttling and total throughput drops.
  return 24
}

/** Split a file into resume-friendly chunks, not one range per socket. */
function planRanges(total, options = {}) {
  const maxRanges = Math.max(1, Math.min(4096, options.maxRanges ?? 2048))
  const chunkBytes =
    total >= 512 * 1024 * 1024
      ? options.largeChunkBytes ?? 16 * 1024 * 1024
      : options.chunkBytes ?? 8 * 1024 * 1024
  const chunks = Math.max(1, Math.min(maxRanges, Math.ceil(total / chunkBytes)))
  const size = Math.ceil(total / chunks)
  const ranges = []
  for (let start = 0; start < total; start += size) {
    ranges.push({ start, end: Math.min(total - 1, start + size - 1), received: 0 })
  }
  return ranges
}

/** Ask for one byte so the host tells us both the archive size and range support. */
async function probeRange(url, options = {}) {
  const response = await requestStream(url, {
    method: 'GET',
    connections: 1,
    signal: options.signal,
    headers: { ...(options.headers ?? {}), Range: 'bytes=0-0' },
  })
  if (response.status < 200 || response.status >= 300) {
    response.stream.resume()
    throw new Error(`Download failed: HTTP ${response.status}`)
  }
  const header = (name) => {
    const value = response.headers[name]
    return Array.isArray(value) ? value.join(', ') : value ?? ''
  }
  const contentRange = header('content-range').trim()
  const match = /^bytes\s+0-0\/(\d+)$/i.exec(contentRange)
  const total = match ? Number(match[1]) : 0
  const supported =
    response.status === 206 &&
    total > 0 &&
    /\bbytes\b/i.test(header('accept-ranges') || 'bytes')
  response.stream.resume()
  return {
    supported,
    total,
    finalUrl: response.url,
    contentType: header('content-type').toLowerCase(),
    contentDisposition: header('content-disposition'),
  }
}

/** Plain single-connection download, used for hosts without Range support. */
async function downloadSingleStream(options) {
  const { partPath, signal, onTotal, onChunk } = options
  let offset = Math.max(0, Number(options.resumeOffset) || 0)
  const response = await requestStream(options.url, {
    connections: 1,
    signal,
    headers: {
      ...(options.headers ?? {}),
      ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
    },
  })
  if (response.status < 200 || response.status >= 300) {
    response.stream.resume()
    throw new Error(`Download failed: HTTP ${response.status}`)
  }
  // A host that ignores the resume range would append a second copy; restart.
  if (offset > 0 && response.status !== 206) {
    offset = 0
    options.onRestart?.()
  }
  const contentLength = Number(response.headers['content-length'] ?? 0)
  onTotal?.(offset + contentLength)

  const handle = await fs.promises.open(partPath, offset > 0 ? 'r+' : 'w')
  let position = offset
  let buffered = []
  let bufferedBytes = 0
  const flush = async () => {
    if (bufferedBytes === 0) return
    const buffer = buffered.length === 1 ? buffered[0] : Buffer.concat(buffered, bufferedBytes)
    buffered = []
    bufferedBytes = 0
    await writeAt(handle, buffer, position)
    position += buffer.length
    onChunk?.(buffer.length)
  }
  try {
    if (offset > 0) await handle.truncate(offset)
    for await (const chunk of response.stream) {
      buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      bufferedBytes += chunk.length
      if (bufferedBytes >= WRITE_BATCH_BYTES) await flush()
    }
    await flush()
  } finally {
    await handle.close()
  }
}

/** Many connections, each writing its own slice at the right file offset. */
async function downloadRanges(options) {
  const { partPath, total, signal, onChunk } = options
  const ranges = Array.isArray(options.ranges) ? options.ranges : []
  if (ranges.length <= 1) throw new RangeUnsupportedError('The archive is too small to split.')

  const prepare = await fs.promises.open(partPath, fs.existsSync(partPath) ? 'r+' : 'w')
  try {
    await prepare.truncate(total)
  } finally {
    await prepare.close()
  }

  const attempts = Math.max(1, options.attempts ?? 3)
  const stallMs = Math.max(5_000, options.stallMs ?? 30_000)
  const connections = Math.max(1, Math.min(MAX_CONNECTIONS, options.connections ?? 8))
  createDownloadPool(connections)

  const workers = new AbortController()
  // One abort listener per in-flight range is expected; lift Node's default cap
  // so a 16-socket pool does not warn about a leak that is not there.
  events.setMaxListeners(0, workers.signal)
  const abortWorkers = () => workers.abort()
  signal?.addEventListener('abort', abortWorkers, { once: true })

  const pending = ranges.filter((range) => {
    const length = range.end - range.start + 1
    range.received = Math.min(length, Math.max(0, Number(range.received) || 0))
    return range.received < length
  })

  // Adaptive concurrency: mirrors such as archive.org throttle or reject bursts
  // of sockets, which shows up as a long stalling tail. The pool shrinks when a
  // host pushes back and creeps back up as requests succeed.
  const throttle = { limit: connections, active: 0, retryAfterMs: 0 }
  const acquire = async () => {
    while (throttle.active >= throttle.limit) {
      if (signal?.aborted || workers.signal.aborted) throw abortError()
      await delay(40)
    }
    throttle.active += 1
  }
  const release = () => {
    throttle.active = Math.max(0, throttle.active - 1)
  }
  const backOff = (status, retryAfter) => {
    throttle.limit = Math.max(2, Math.floor(throttle.limit * 0.6))
    const headerSeconds = Number(retryAfter)
    throttle.retryAfterMs = Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds * 1000 : 800
  }
  const recovered = () => {
    if (throttle.retryAfterMs > 0) {
      throttle.retryAfterMs = 0
      return
    }
    throttle.limit = Math.min(connections, throttle.limit + 1)
  }

  const downloadRange = async (handle, range) => {
    const length = range.end - range.start + 1
    let failures = 0

    while (true) {
      // Cancellation must stop queued ranges too, not only in-flight requests.
      if (signal?.aborted || workers.signal.aborted) throw abortError()
      let offset = Math.min(length, Math.max(0, Number(range.received) || 0))
      range.received = offset
      if (offset >= length) return

      const attempt = new AbortController()
      const onAbort = () => attempt.abort()
      let stallTimer = null
      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => attempt.abort(new Error('Download connection stalled')), stallMs)
        stallTimer.unref?.()
      }
      workers.signal.addEventListener('abort', onAbort, { once: true })

      let position = range.start + offset
      let buffered = []
      let bufferedBytes = 0
      const flush = async () => {
        if (bufferedBytes === 0) return
        const buffer = buffered.length === 1 ? buffered[0] : Buffer.concat(buffered, bufferedBytes)
        buffered = []
        bufferedBytes = 0
        await writeAt(handle, buffer, position)
        position += buffer.length
        range.received = position - range.start
        onChunk?.(buffer.length)
      }

      let slotHeld = false
      try {
        await acquire()
        slotHeld = true
        if (signal?.aborted || workers.signal.aborted) throw abortError()
        resetStall()
        const response = await requestStream(options.url, {
          connections,
          signal: attempt.signal,
          headers: {
            ...(options.headers ?? {}),
            Range: `bytes=${range.start + offset}-${range.end}`,
          },
        })
        if (response.status !== 206) {
          response.stream.resume()
          if (response.status === 200) throw new RangeUnsupportedError('The server did not honor byte ranges.')
          if ([429, 503, 504].includes(response.status)) {
            backOff(response.status, response.headers['retry-after'])
          }
          throw new Error(`Download range failed: HTTP ${response.status}`)
        }
        for await (const chunk of response.stream) {
          resetStall()
          if (position + chunk.length > range.end + 1) {
            throw new Error('The server returned too many bytes for a range.')
          }
          buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          bufferedBytes += chunk.length
          if (bufferedBytes >= WRITE_BATCH_BYTES) await flush()
        }
        await flush()
        if (position !== range.end + 1) throw new Error('The server returned an incomplete byte range.')
        recovered()
        return
      } catch (error) {
        if (signal?.aborted || workers.signal.aborted) throw abortError()
        if (error instanceof RangeUnsupportedError) throw error
        failures += 1
        if (failures >= attempts) throw error
        // Keep every byte already written and resume this range from there,
        // waiting out any server-provided retry delay.
        await delay(Math.max(400 * failures, throttle.retryAfterMs))
      } finally {
        if (stallTimer) clearTimeout(stallTimer)
        if (slotHeld) release()
        workers.signal.removeEventListener('abort', onAbort)
      }
    }
  }

  const workerCount = Math.min(connections, Math.max(1, pending.length))
  let next = 0
  const tasks = Array.from({ length: workerCount }, async () => {
    const handle = await fs.promises.open(partPath, 'r+')
    try {
      while (true) {
        const range = pending[next]
        next += 1
        if (!range) return
        await downloadRange(handle, range)
      }
    } finally {
      await handle.close()
    }
  })

  try {
    await Promise.all(tasks)
  } catch (error) {
    workers.abort()
    await Promise.allSettled(tasks)
    throw error
  } finally {
    signal?.removeEventListener('abort', abortWorkers)
  }
}

module.exports = {
  MAX_CONNECTIONS,
  RangeUnsupportedError,
  WRITE_BATCH_BYTES,
  connectionCount,
  createDownloadPool,
  downloadRanges,
  downloadSingleStream,
  planRanges,
  probeRange,
  requestStream,
}
