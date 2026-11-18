// Verifies the multi-connection range downloader: byte-exact output, parallel
// speedup on a range-capable host, and the single-stream fallback for hosts
// that ignore Range requests.
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const engine = require('../electron/rangeDownloader.cjs')

const SIZE = 48 * 1024 * 1024
const payload = crypto.randomBytes(SIZE)
const expected = crypto.createHash('sha256').update(payload).digest('hex')

function startServer({ ranges = true, size = SIZE, body = payload } = {}) {
  const server = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''))
    if (!ranges || !range) {
      res.writeHead(ranges ? 200 : 200, {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
        ...(ranges ? { 'accept-ranges': 'bytes' } : {}),
      })
      res.end(bufferFor(req, body))
      return
    }
    const start = Number(range[1])
    const end = Math.min(size - 1, Number(range[2]))
    const slice = body.subarray(start, end + 1)
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': slice.length,
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${size}`,
    })
    res.end(slice)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function bufferFor(_req, body) {
  return body
}

/** Deliberately slow range host, so cancellation can be tested mid-transfer. */
function startSlowServer(bytesPerSecond) {
  const server = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''))
    const start = range ? Number(range[1]) : 0
    const end = range ? Math.min(SIZE - 1, Number(range[2])) : SIZE - 1
    const slice = payload.subarray(start, end + 1)
    res.writeHead(range ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': slice.length,
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${SIZE}` } : {}),
    })
    const step = 64 * 1024
    let offset = 0
    const timer = setInterval(() => {
      if (offset >= slice.length) {
        clearInterval(timer)
        res.end()
        return
      }
      res.write(slice.subarray(offset, offset + step))
      offset += step
    }, (step / bytesPerSecond) * 1000)
    res.on('close', () => clearInterval(timer))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function tempTarget(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-range-'))
  return { dir, target: path.join(dir, name) }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (chunk) => sha.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(sha.digest('hex')))
  })
}

async function measure(port, connections) {
  const { dir, target } = tempTarget('archive.bin')
  const ranges = engine.planRanges(SIZE)
  const started = Date.now()
  await engine.downloadRanges({
    url: `http://127.0.0.1:${port}/archive.bin`,
    partPath: target,
    total: SIZE,
    ranges,
    connections,
    attempts: 3,
    stallMs: 30_000,
    headers: { 'Accept-Encoding': 'identity' },
  })
  const seconds = Math.max(0.001, (Date.now() - started) / 1000)
  const size = fs.statSync(target).size
  const hash = await hashFile(target)
  fs.rmSync(dir, { recursive: true, force: true })
  const megabytesPerSecond = size / 1024 ** 2 / seconds
  console.log(
    `${connections === 1 ? 'single stream' : `${connections} connections`}: ${(size / 1024 ** 2).toFixed(0)} MiB in ${seconds.toFixed(2)}s = ${megabytesPerSecond.toFixed(0)} MiB/s, sha256 ${hash === expected ? 'match' : 'MISMATCH'}`,
  )
  return { hash, megabytesPerSecond }
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

;(async () => {
  const server = await startServer()
  const port = server.address().port
  try {
    const probe = await engine.probeRange(`http://127.0.0.1:${port}/archive.bin`, {
      headers: { 'Accept-Encoding': 'identity' },
    })
    console.log(`probe: supported=${probe.supported} total=${probe.total}`)
    if (!probe.supported || probe.total !== SIZE) fail('range probe did not read the archive size')

    const single = await measure(port, 1)
    const parallel = await measure(port, 12)
    if (single.hash !== expected || parallel.hash !== expected) fail('downloaded bytes did not match')
    if (engine.connectionCount(48 * 1024 ** 2) < 6) fail('mid-size archives should use several connections')
    if (engine.connectionCount(3 * 1024 ** 3) !== 16) fail('gigabyte archives should use the full 16-socket pool')
    if (engine.connectionCount(SIZE, 4) !== 4) fail('connection override was ignored')
    if (parallel.megabytesPerSecond < single.megabytesPerSecond * 0.4) {
      fail('parallel download was unexpectedly slower than a single stream')
    }
  } finally {
    server.close()
  }

  // Hosts without Range support: probe must say so and the single stream must
  // still produce a byte-exact file.
  const plain = await startServer({ ranges: false })
  const plainPort = plain.address().port
  try {
    const probe = await engine.probeRange(`http://127.0.0.1:${plainPort}/archive.bin`, {
      headers: { 'Accept-Encoding': 'identity' },
    })
    console.log(`no-range probe: supported=${probe.supported}`)
    if (probe.supported) fail('host without range support was reported as supported')

    const { dir, target } = tempTarget('fallback.bin')
    let total = 0
    await engine.downloadSingleStream({
      url: `http://127.0.0.1:${plainPort}/archive.bin`,
      partPath: target,
      onTotal: (value) => {
        total = value
      },
      headers: { 'Accept-Encoding': 'identity' },
    })
    const hash = await hashFile(target)
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`single-stream fallback: bytes=${total} sha256 ${hash === expected ? 'match' : 'MISMATCH'}`)
    if (hash !== expected) fail('single-stream fallback produced corrupt bytes')
  } finally {
    plain.close()
  }

  // Cancellation: once aborted, no worker may keep pulling ranges, and the
  // promise must reject promptly instead of downloading the whole file.
  const slow = await startSlowServer(512 * 1024)
  const slowPort = slow.address().port
  try {
    const { dir, target } = tempTarget('cancelled.bin')
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 400)
    let aborted = false
    try {
      await engine.downloadRanges({
        url: `http://127.0.0.1:${slowPort}/archive.bin`,
        partPath: target,
        total: SIZE,
        ranges: engine.planRanges(SIZE),
        connections: 8,
        signal: controller.signal,
        attempts: 3,
        stallMs: 30_000,
      })
    } catch (error) {
      aborted = error.name === 'AbortError'
    }
    const elapsed = Date.now() - started
    const sizeAtAbort = fs.statSync(target).size
    await new Promise((resolve) => setTimeout(resolve, 750))
    const sizeLater = fs.statSync(target).size
    console.log(
      `cancel mid-transfer: aborted=${aborted} in ${elapsed}ms, bytes after abort ${sizeAtAbort} -> ${sizeLater}`,
    )
    if (!aborted) fail('abort did not reject the download')
    if (elapsed > 4000) fail('abort took too long to stop the download')
    if (sizeLater !== sizeAtAbort) fail('bytes were still written after the download was cancelled')
    fs.rmSync(dir, { recursive: true, force: true })
  } finally {
    slow.close()
  }

  if (process.exitCode) console.error('range downloader test failed')
  else console.log('range downloader test passed')
})().catch((error) => {
  console.error('FAILED', error)
  process.exitCode = 1
})
