'use strict'

/**
 * Makes the hidden listen server reachable from outside the LAN.
 *
 * Two automatic paths are attempted, both using only Node's standard library:
 *   1. UPnP IGD  — SSDP discovery, then AddPortMapping on the router.
 *   2. NAT-PMP   — the Apple/ASUS/OpenWrt style port mapping protocol.
 *
 * When the router has neither enabled the host still works on the local
 * network; the launcher can then publish a manually forwarded address instead.
 */

const dgram = require('node:dgram')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const { execFile } = require('node:child_process')

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const address of list || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

function gatewayAddress() {
  return new Promise((resolve) => {
    const fallback = () => {
      try {
        const route = require('node:fs').readFileSync('/proc/net/route', 'utf8')
        for (const line of route.split('\n').slice(1)) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 3) continue
          const hex = parts[2]
          if (!hex || hex === '00000000') continue
          const value = Number.parseInt(hex, 16)
          const ip = [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255].join('.')
          if (ip !== '0.0.0.0') return resolve(ip)
        }
      } catch {
        /* not linux */
      }
      resolve(null)
    }
    execFile('ipconfig', { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      if (error || !stdout) return fallback()
      let found = null
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(/Default Gateway[^:]*:\s*([0-9.]+)/i)
        if (match && match[1] !== '0.0.0.0') found = match[1]
      }
      resolve(found || null)
    })
  })
}

function request(url, { method = 'GET', headers = {}, body = '' } = {}, timeout = 2500) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return reject(new Error('bad url'))
    }
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        timeout,
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode || 0, text }))
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))
  return match ? match[1].trim() : null
}

function discoverGateway(timeout = 2600) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    const locations = new Set()
    const message = Buffer.from(
      [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'MX: 2',
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        '',
        '',
      ].join('\r\n'),
    )
    const finish = () => {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve([...locations])
    }
    const timer = setTimeout(finish, timeout)
    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })
    socket.on('message', (data) => {
      const text = data.toString()
      const location = (text.match(/LOCATION:\s*(\S+)/i) || [])[1]
      if (location) locations.add(location)
    })
    socket.bind(() => {
      const send = () => socket.send(message, 0, message.length, 1900, '239.255.255.250', () => {})
      send()
      setTimeout(send, 700)
    })
  })
}

async function findIgd() {
  const locations = await discoverGateway()
  for (const location of locations) {
    try {
      const { text } = await request(location)
      const services = text.match(/<service>([\s\S]*?)<\/service>/gi) || []
      for (const block of services) {
        const type = tag(block, 'serviceType') || ''
        if (!/WAN(IP|PPP)Connection:1/i.test(type)) continue
        const control = tag(block, 'controlURL')
        if (!control) continue
        return { controlUrl: new URL(control, location).toString(), type }
      }
    } catch {
      /* try the next device */
    }
  }
  return null
}

function soapEnvelope(service, action, fields) {
  const inner = Object.entries(fields)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('')
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${service}">${inner}</u:${action}></s:Body></s:Envelope>`
  )
}

async function upnpMap(port, internal) {
  const igd = await findIgd()
  if (!igd) return null
  const call = (action, fields) =>
    request(igd.controlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset="utf-8"',
        soapaction: `"${igd.type}#${action}"`,
        'content-length': Buffer.byteLength(soapEnvelope(igd.type, action, fields)),
      },
      body: soapEnvelope(igd.type, action, fields),
    })

  let external = null
  try {
    const { text } = await call('GetExternalIPAddress', {})
    external = tag(text, 'NewExternalIPAddress')
  } catch {
    /* most routers still accept the mapping below */
  }
  if (!external) return null

  for (const protocol of ['UDP', 'TCP']) {
    try {
      await call('AddPortMapping', {
        NewRemoteHost: '',
        NewExternalPort: port,
        NewProtocol: protocol,
        NewInternalPort: port,
        NewInternalClient: internal,
        NewEnabled: 1,
        NewPortMappingDescription: 'VAULTED lobby',
        NewLeaseDuration: 0,
      })
    } catch {
      /* a router may only map one protocol; the other attempt is harmless */
    }
  }
  return { address: external, port, method: 'upnp', internal }
}

function natPmp(port, gateway, internal) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let stage = 'address'
    let external = null
    const finish = (value) => {
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 2500)
    socket.on('error', () => finish(null))
    socket.on('message', (data) => {
      if (data.length < 8 || (data[1] !== 128 && data[1] !== 129)) return
      const result = data.readUInt16BE(2)
      if (result !== 0) return finish(null)
      if (stage === 'address') {
        external = `${data[8]}.${data[9]}.${data[10]}.${data[11]}`
        stage = 'map'
        const map = Buffer.alloc(12)
        map.writeUInt8(0, 0)
        map.writeUInt8(1, 1)
        map.writeUInt16BE(port, 4)
        map.writeUInt16BE(port, 6)
        map.writeUInt32BE(7200, 8)
        socket.send(map, 0, map.length, 5351, gateway)
        return
      }
      finish(external ? { address: external, port, method: 'natpmp', internal } : null)
    })
    socket.bind(() => {
      const address = Buffer.from([0, 0])
      socket.send(address, 0, address.length, 5351, gateway)
    })
  })
}

async function mapPublicPort(port) {
  const internal = lanIp()
  if (!internal) return null
  try {
    const upnp = await upnpMap(port, internal)
    if (upnp) return upnp
  } catch {
    /* fall through */
  }
  const gateway = await gatewayAddress()
  if (!gateway) return null
  try {
    return await natPmp(port, gateway, internal)
  } catch {
    return null
  }
}

module.exports = { mapPublicPort, lanIp }
