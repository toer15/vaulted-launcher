'use strict'

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const matchmakerVersion = 3
const matchmakerPort = Number(process.env.VAULTED_MATCHMAKER_PORT || 3552)
const gamePort = Number(process.env.VAULTED_GAME_PORT || 7777)
const gameHost = process.env.VAULTED_GAME_HOST || '127.0.0.1'
const gameStateFile = process.env.VAULTED_GAME_STATE_FILE ||
  (process.env.APPDATA ? path.join(process.env.APPDATA, 'VAULTED Launcher', 'game-server-state.json') : '')
const joinFile = process.env.VAULTED_JOIN_FILE || ''
const activeClients = new Set()

function log(message) {
  console.log(`[VAULTED-MM] ${new Date().toISOString()} ${message}`)
}

function randomId() {
  return crypto.randomBytes(16).toString('hex')
}

/** The launcher writes the player's current playlist here before matchmaking. */
function selectedPlaylistName() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  try {
    const text = fs.readFileSync(
      path.join(localAppData, 'FortniteGame', 'Saved', 'Config', 'WindowsClient', 'GameUserSettings.ini'),
      'utf8',
    )
    const match = /LastSelectedPlaylist\s*=\s*\([^\r\n]*?PlaylistName\s*=\s*"([^"]+)"/i.exec(text)
    return match?.[1]?.replace(/[^a-z0-9_]/gi, '') || null
  } catch {
    return null
  }
}

/** Set while the launcher is joining a friend's lobby instead of hosting one. */
function joinTarget() {
  if (!joinFile) return null
  try {
    const value = JSON.parse(fs.readFileSync(joinFile, 'utf8'))
    if (value && typeof value.host === 'string' && value.host.trim()) {
      return { host: value.host.trim(), port: Number(value.port) || gamePort }
    }
  } catch (error) {
    /* no join in progress */
  }
  return null
}

/** Never assign a session until the hidden host is running the selected mode. */
function hostReadyForSelectedPlaylist() {
  if (!gameStateFile) return true
  let state
  try {
    state = JSON.parse(fs.readFileSync(gameStateFile, 'utf8'))
  } catch (error) {
    // Missing state is the legacy fallback; a half-written file must wait.
    return error?.code === 'ENOENT'
  }
  if (!state || typeof state !== 'object') return true
  if (state.ready !== true) return false
  const hostPlaylist = String(state.playlist || '').trim()
  if (!hostPlaylist) return true
  const selected = selectedPlaylistName()
  if (!selected) return true
  return hostPlaylist.toLowerCase() === selected.toLowerCase()
}

/** A tiny RFC 6455 server: the client only needs text status messages. */
function frame(text, opcode = 0x1) {
  const payload = Buffer.from(text)
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

function sendJson(socket, value) {
  if (!socket.destroyed && socket.writable) socket.write(frame(JSON.stringify(value)))
}

function websocketClient(socket) {
  let buffer = Buffer.alloc(0)
  let closed = false
  let ready = false
  let announced = false
  const timers = []

  let cancelled = false
  const close = () => {
    closed = true
    for (const timer of timers) clearInterval(timer)
    if (!socket.destroyed) socket.destroy()
  }

  function cancel() {
    if (closed || cancelled) return
    cancelled = true
    announced = true
    for (const timer of timers) clearInterval(timer)
    sendStatus('Cancelled')
    log('queue cancelled; told the client to return to the lobby')
    // Keep the socket up briefly so the client can process the status; it
    // closes it itself when it returns to the frontend.
    schedule(5000, () => close())
  }

  function schedule(delay, callback) {
    const timer = setTimeout(() => {
      if (!closed) callback()
    }, delay)
    timers.push(timer)
  }

  function sendStatus(state, extra = {}) {
    sendJson(socket, {
      name: 'StatusUpdate',
      payload: { state, ...extra },
    })
  }

  function shutdown() {
    if (socket.destroyed) return
    try {
      socket.write(frame('', 0x8))
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (!socket.destroyed) socket.end()
    }, 80)
  }

  function finishMatch() {
    if (closed || cancelled) return
    const matchId = crypto.randomUUID().toUpperCase()
    const sessionId = crypto.randomUUID().toUpperCase()
    sendStatus('SessionAssignment', { matchId, sessionId })
    schedule(900, () => {
      sendJson(socket, {
        name: 'Play',
        payload: { matchId, sessionId, joinDelaySec: 1, serverAddress: gameHost, serverPort: gamePort },
      })
      log(`assigned ${sessionId}`)
      // The 1.10 client only starts the join when the matchmaking connection
      // drops. A clean WebSocket close frame is reported as ServiceError, so
      // the socket is destroyed instead; that is what makes it finalize and
      // travel to the assigned server.
      schedule(2200, () => {
        log('dropping matchmaking socket so the client starts the join')
        close()
      })
    })
  }

  function begin() {
    if (ready || closed) return
    ready = true
    log('client connected')

    sendStatus('Connecting')
    schedule(500, () =>
      sendStatus('Waiting', { totalPlayers: 1, connectedPlayers: 1, estimatedWaitSec: 1 }),
    )
    schedule(1500, () =>
      sendStatus('Queued', {
        ticketId: randomId(),
        queuedPlayers: 1,
        estimatedWaitSec: 1,
        status: {},
      }),
    )

    let waitingOnStateSince = 0
    // The host writes game-server-state.json when its selected mode is loaded.
    // Probing TCP 7777 was wrong: UE listens on UDP, so the queue never left
    // "Waiting for server" even though the host was ready.
    const probe = () => {
      if (closed || cancelled || announced) return
      const join = joinTarget()
      if (join) {
        announced = true
        log(`joining ${join.host}:${join.port}; skipping the local host probe`)
        finishMatch()
        return
      }
      if (!hostReadyForSelectedPlaylist()) {
        if (!waitingOnStateSince) {
          waitingOnStateSince = Date.now()
          log('hidden host is not ready for the selected playlist yet')
        }
        if (Date.now() - waitingOnStateSince > 8000) {
          log('host not ready after 8s; attempting join anyway')
          announced = true
          finishMatch()
        }
        return
      }
      announced = true
      log('hidden host is ready for the selected playlist; assigning session')
      finishMatch()
    }

    // Start looking for the host only after the client has entered Queued;
    // assigning earlier skipped the queue and made CANCEL useless.
    schedule(1650, () => {
      probe()
      const interval = setInterval(probe, 1000)
      timers.push(interval)
    })
  }

  function handleFrame(parsed) {
    if (parsed.opcode === 0x8) {
      close()
      return
    }
    if (parsed.opcode === 0x9) {
      if (!socket.destroyed) socket.write(frame(parsed.payload, 0xA))
      return
    }
    if (parsed.opcode === 0x1 || parsed.opcode === 0x2) {
      const text = parsed.payload.toString('utf8')
      try {
        const message = JSON.parse(text)
        const name = String(message.name || message.type || 'unknown')
        log(`client message: ${name} ${text.slice(0, 300)}`)
        if (/cancel|leave|abort/i.test(name)) {
          cancel()
        }
      } catch {
        log(`client message: ${text.slice(0, 200)}`)
      }
    }
  }

  function readFrames() {
    while (buffer.length >= 2) {
      const first = buffer[0]
      const second = buffer[1]
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(16 * 1024 * 1024)) {
          close()
          return
        }
        length = Number(big)
        offset = 10
      }

      const masked = (second & 0x80) !== 0
      const maskOffset = offset
      if (masked) offset += 4
      if (buffer.length < offset + length) return

      let payload = buffer.subarray(offset, offset + length)
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4)
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
      }

      buffer = buffer.subarray(offset + length)
      if ((first & 0x80) === 0) {
        close()
        return
      }
      handleFrame({ opcode: first & 0x0f, payload })
      if (closed) return
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    readFrames()
  })
  socket.on('error', close)
  socket.on('close', () => {
    closed = true
    for (const timer of timers) clearInterval(timer)
    activeClients.delete(api)
  })

  const api = { close, cancel, get cancelled() { return cancelled } }
  activeClients.add(api)
  begin()
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, service: 'vaulted-matchmaker', version: matchmakerVersion, gamePort }))
    return
  }
  if (req.url === '/cancel' && (req.method === 'POST' || req.method === 'GET')) {
    let cancelled = 0
    for (const client of activeClients) {
      if (client.cancelled) continue
      client.cancel()
      cancelled += 1
    }
    log(`cancel endpoint cancelled ${cancelled} queue(s)`)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, cancelled }))
    return
  }
  res.writeHead(404)
  res.end()
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  websocketClient(socket)
})

server.on('error', (error) => {
  log(`server error: ${error.message}`)
  process.exitCode = 1
})

server.listen(matchmakerPort, '127.0.0.1', () => {
  log(`listening on ws://127.0.0.1:${matchmakerPort}, game server ${gameHost}:${gamePort}`)
})
