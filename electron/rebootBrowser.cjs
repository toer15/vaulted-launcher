'use strict'

const net = require('node:net')
const crypto = require('node:crypto')
const { findInstalledLauncher } = require('./hostedLaunchers.cjs')

const REBOOT_BROWSER_HOST = '192.99.216.42'
const REBOOT_BROWSER_PORT = 8080
const REBOOT_BROWSER_PATH = '/'
const REBOOT_BROWSER_TIMEOUT = 5000
const MAX_PAYLOAD = 2 * 1024 * 1024

const TARGETS = {
  'reboot-c1s9': ['9.'],
  'reboot-c2s1': ['11.'],
  'reboot-c2s5': ['15.'],
  'reboot-c2s7': ['17.'],
}

const SAFE_LOBBY_ID = /^[A-Za-z0-9_-]{1,80}$/

function parseFrame(buffer) {
  if (buffer.length < 2) return null

  const first = buffer[0]
  const second = buffer[1]
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const large = buffer.readBigUInt64BE(2)
    if (large > BigInt(MAX_PAYLOAD)) return { error: 'Reboot sent an oversized browser frame.' }
    length = Number(large)
    offset = 10
  }

  if (length > MAX_PAYLOAD) return { error: 'Reboot sent an oversized browser frame.' }

  let mask = null
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + length) return null

  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4]
    }
  }

  return {
    fin,
    opcode,
    payload,
    rest: buffer.subarray(offset + length),
  }
}

function readRebootBrowser(options = {}) {
  const host = options.host ?? REBOOT_BROWSER_HOST
  const port = options.port ?? REBOOT_BROWSER_PORT
  const path = options.path ?? REBOOT_BROWSER_PATH
  const timeoutMs = options.timeoutMs ?? REBOOT_BROWSER_TIMEOUT

  return new Promise((resolve) => {
    let socket = null
    let timer = null
    let settled = false
    let upgraded = false
    let buffer = Buffer.alloc(0)
    let fragments = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        /* already closed */
      }
      resolve(result)
    }

    timer = setTimeout(() => finish({ error: 'Reboot server browser timed out.' }), timeoutMs)

    try {
      socket = net.connect({ host, port })
    } catch (error) {
      finish({ error: error instanceof Error ? error.message : String(error) })
      return
    }

    socket.setNoDelay(true)
    socket.once('connect', () => {
      const key = crypto.randomBytes(16).toString('base64')
      const accept = crypto
        .createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          'Origin: https://rebootfn.org',
          '',
          '',
        ].join('\r\n'),
      )
      socket.__rebootAccept = accept
    })

    socket.on('data', (data) => {
      if (settled) return
      buffer = Buffer.concat([buffer, data])
      if (buffer.length > MAX_PAYLOAD + 16384) {
        finish({ error: 'Reboot sent an oversized browser response.' })
        return
      }

      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = buffer.subarray(0, headerEnd).toString('latin1')
        if (!/^HTTP\/1\.[01] 101\b/i.test(header)) {
          finish({ error: 'Reboot server browser refused the connection.' })
          return
        }
        const accept = /sec-websocket-accept:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim()
        if (accept && socket.__rebootAccept && accept !== socket.__rebootAccept) {
          finish({ error: 'Reboot server browser returned an invalid handshake.' })
          return
        }
        upgraded = true
        buffer = buffer.subarray(headerEnd + 4)
      }

      while (!settled) {
        const frame = parseFrame(buffer)
        if (!frame) break
        if (frame.error) {
          finish({ error: frame.error })
          return
        }
        buffer = frame.rest

        if (frame.opcode === 0x8) {
          finish({ error: 'Reboot closed the server browser connection.' })
          return
        }
        if (frame.opcode !== 0x1 && frame.opcode !== 0x0) continue

        if (frame.opcode === 0x1) fragments = frame.fin ? frame.payload : Buffer.from(frame.payload)
        else if (fragments) fragments = Buffer.concat([fragments, frame.payload])

        if (!frame.fin || !fragments) continue

        const text = fragments.toString('utf8')
        fragments = null
        let message
        try {
          message = JSON.parse(text)
        } catch {
          finish({ error: 'Reboot server browser sent an invalid response.' })
          return
        }
        if (!message || message.type !== 'add' || !Array.isArray(message.data)) {
          finish({ error: 'Reboot server browser sent an unexpected response.' })
          return
        }
        finish({ entries: message.data })
        return
      }
    })

    socket.once('error', (error) => finish({ error: error.message }))
    socket.once('close', () => finish({ error: 'Reboot server browser closed the connection.' }))
  })
}

function normalizeLobby(value) {
  if (!value || typeof value !== 'object') return null
  const lobby = value
  if (
    typeof lobby.id !== 'string' ||
    !SAFE_LOBBY_ID.test(lobby.id) ||
    typeof lobby.version !== 'string' ||
    typeof lobby.password !== 'string'
  ) {
    return null
  }
  const address = normalizeAddress(lobby.ip)
  if (!address) return null
  return {
    id: lobby.id,
    name: typeof lobby.name === 'string' ? lobby.name : '',
    author: typeof lobby.author === 'string' ? lobby.author : '',
    host: address.host,
    port: address.port,
    version: lobby.version,
    password: lobby.password,
    timestamp: typeof lobby.timestamp === 'string' ? lobby.timestamp : '',
  }
}

/** Reboot publishes the game address as either "host" or "host:port". */
function normalizeAddress(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw || raw.length > 255) return null

  let host = raw
  let port = 7777

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return null
    host = raw.slice(1, end)
    const rest = raw.slice(end + 1)
    if (rest) {
      if (!rest.startsWith(':')) return null
      port = Number(rest.slice(1))
    }
  } else if (raw.split(':').length === 2) {
    const colon = raw.lastIndexOf(':')
    host = raw.slice(0, colon)
    port = Number(raw.slice(colon + 1))
  } else if (raw.includes(':')) {
    // Unbracketed IPv6 has no unambiguous port; use the default game port.
    host = raw
  }

  if (!host || host.length > 253) return null
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function selectRebootLobby(entries, projectId) {
  const prefixes = TARGETS[projectId]
  if (!prefixes || !Array.isArray(entries)) return null

  return (
    entries
      .map(normalizeLobby)
      .filter((lobby) => {
        if (!lobby || lobby.password) return false
        const version = lobby.version.replace(/^v/i, '').trim()
        return prefixes.some((prefix) => version.startsWith(prefix))
      })
      .sort((a, b) => {
        const aTime = Date.parse(a.timestamp)
        const bTime = Date.parse(b.timestamp)
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
      })[0] ?? null
  )
}

async function findRebootLobby(projectId, options = {}) {
  const executable = findInstalledLauncher(projectId)

  const result = await readRebootBrowser(options)
  if (result.error) return { installed: Boolean(executable), lobby: null, error: result.error }

  const found = selectRebootLobby(result.entries, projectId)
  return {
    installed: Boolean(executable),
    lobby: found
      ? {
          id: found.id,
          name: found.name,
          version: found.version,
          author: found.author,
          host: found.host,
          port: found.port,
        }
      : null,
    ...(found ? {} : { error: 'No public lobby is listed for this season.' }),
  }
}

module.exports = { findRebootLobby, normalizeAddress, readRebootBrowser, selectRebootLobby }
