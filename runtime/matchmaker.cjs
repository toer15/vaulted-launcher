'use strict'

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const matchmakerVersion = 2
const matchmakerPort = Number(process.env.VAULTED_MATCHMAKER_PORT || 3552)
const gamePort = Number(process.env.VAULTED_GAME_PORT || 7777)
const gameHost = process.env.VAULTED_GAME_HOST || '127.0.0.1'
const gameStateFile = process.env.VAULTED_GAME_STATE_FILE ||
  (process.env.APPDATA ? path.join(process.env.APPDATA, 'VAULTED Launcher', 'game-server-state.json') : '')

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
  const timers = []

  const close = () => {
    closed = true
    for (const timer of timers) clearInterval(timer)
    if (!socket.destroyed) socket.destroy()
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

  function finishMatch() {
    if (closed) return
    const matchId = randomId().toUpperCase()
    const sessionId = randomId().toUpperCase()
    sendStatus('SessionAssignment', { matchId })
    schedule(1200, () => {
      sendJson(socket, {
        name: 'Play',
        payload: { matchId, sessionId, joinDelaySec: 1 },
      })
      log(`assigned ${sessionId}`)
    })
  }

  function begin() {
    if (ready || closed) return
    ready = true
    log('client connected')

    sendStatus('Connecting')
    schedule(500, () => sendStatus('Waiting', { totalPlayers: 1, connectedPlayers: 1 }))
    schedule(1500, () =>
      sendStatus('Queued', {
        ticketId: randomId(),
        queuedPlayers: 0,
        estimatedWaitSec: 0,
        status: {},
      }),
    )

    let announced = false
    const probe = () => {
      if (closed || announced) return
      const socketTest = net.connect({ host: gameHost, port: gamePort })
      socketTest.setTimeout(700)
      socketTest.once('connect', () => {
        socketTest.destroy()
        if (!hostReadyForSelectedPlaylist()) return
        announced = true
        log('game server is listening; assigning session')
        finishMatch()
      })
      socketTest.once('timeout', () => socketTest.destroy())
      socketTest.once('error', () => socketTest.destroy())
    }

    probe()
    const interval = setInterval(probe, 2000)
    timers.push(interval)
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
        log(`client message: ${message.name || message.type || 'unknown'}`)
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
  })

  begin()
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, service: 'vaulted-matchmaker', version: matchmakerVersion, gamePort }))
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
