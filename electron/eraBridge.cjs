'use strict'

const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')

const REQUEST_TIMEOUT_MS = 60_000

/**
 * The Era client is a native module loaded into the game. Its HTTP stack talks
 * to the live backend directly, so the game has to reach Era through a local
 * HTTP origin instead of the packaged Tellurium TLS proxy. This bridge forwards
 * every request to Era and keeps the small account/verify reads stable after
 * the backend stops treating the launcher's own OAuth token as a game client.
 */
function createEraBridge({ upstream, accountId, displayName, onSessionKilled }) {
  const target = new URL(upstream)
  const transport = target.protocol === 'http:' ? http : https
  const accountCache = new Map()
  let sessionKillNotified = false
  let catalogWarningLogged = false

  /**
   * Era's 6.21 catalog endpoint rejects both the launcher token and the game
   * token with the generic "session expired" body even while the same token
   * authenticates account and enabled-features calls. Confirm the bearer still
   * works on the account route before treating a catalog 401 as the known
   * upstream catalog limitation; a real 401 must still reach the game.
   */
  function tokenStillAuthenticates(authorization) {
    const id = String(accountId || '').trim()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return Promise.resolve(false)
    }
    const token = String(authorization || '').replace(/^Bearer\s+/i, '').trim()
    if (!token) return Promise.resolve(false)
    return new Promise((resolve) => {
      const probe = transport.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          method: 'GET',
          path: `/account/api/public/account/${encodeURIComponent(id)}`,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Accept-Encoding': 'identity',
            'User-Agent': 'VAULTED-Launcher/era-bridge',
          },
          timeout: 10_000,
        },
        (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode === 200))
        },
      )
      probe.once('timeout', () => probe.destroy())
      probe.once('error', () => resolve(false))
      probe.end()
    })
  }

  async function normalizeCatalogFailure(upstreamResponse, authorization) {
    const chunks = []
    for await (const chunk of upstreamResponse) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    let json = null
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      return { body, empty: null }
    }
    if (json?.errorMessage !== 'Your session has expired. Sign in again.') {
      return { body, empty: null }
    }
    if (!(await tokenStillAuthenticates(authorization))) return { body, empty: null }
    if (!catalogWarningLogged) {
      catalogWarningLogged = true
      console.warn(
        '[era-bridge] Era catalog rejected a valid account token upstream; returning an empty offer list for the 6.21 price check',
      )
    }
    return { body, empty: Buffer.from('{}') }
  }

  /**
   * The game signs in with `sessions/kill?killType=OTHERS_ACCOUNT_CLIENT_SERVICE`,
   * which revokes the launcher's gateway session too. Tell the launcher after
   * that request finishes so it can reconnect and re-assert presence instead of
   * sending heartbeats on a revoked socket.
   */
  const notifySessionKilled = () => {
    if (sessionKillNotified) return
    sessionKillNotified = true
    try {
      onSessionKilled?.()
    } catch {
      /* a bridge callback must not break the game's login request */
    }
  }

  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const pathname = String(request.url || '').split('?')[0]

      if (pathname === '/account/api/oauth/verify') {
        const authorization = String(request.headers.authorization || '')
        const token = authorization.replace(/^Bearer\s+/i, '')
        const payload = Buffer.from(
          JSON.stringify({
            token,
            session_id: crypto.randomUUID().replace(/-/g, ''),
            token_type: 'bearer',
            client_id: 'ec684b8c687f479fadea3cb2ad83f5c6',
            internal_client: false,
            display_name: displayName || '',
            app: 'fortnite',
            account_id: accountId || '',
            expires_in: 28800,
            expires_at: new Date(Date.now() + 28800 * 1000).toISOString(),
            displayName: displayName || '',
            accountId: accountId || '',
          }),
        )
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': payload.length,
          'cache-control': 'no-store',
        })
        response.end(payload)
        return
      }

      const headers = { ...request.headers }
      delete headers.host
      delete headers.connection
      delete headers['content-length']
      headers.host = target.host
      headers['accept-encoding'] = 'identity'
      if (body.length) headers['content-length'] = String(body.length)

      const forwarded = transport.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          method: request.method,
          path: request.url,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode || 502
          const responseHeaders = { ...upstreamResponse.headers }
          delete responseHeaders.connection
          delete responseHeaders['transfer-encoding']

          if (
            pathname === '/account/api/oauth/sessions/kill' &&
            String(request.method || '').toUpperCase() === 'DELETE'
          ) {
            upstreamResponse.once('end', notifySessionKilled)
          }

          if (
            pathname === '/catalog/api/shared/bulk/offers' &&
            String(request.method || '').toUpperCase() === 'GET' &&
            status === 401
          ) {
            void normalizeCatalogFailure(
              upstreamResponse,
              request.headers.authorization,
            ).then(({ body: originalBody, empty }) => {
              if (empty) {
                response.writeHead(200, {
                  'content-type': 'application/json; charset=utf-8',
                  'content-length': String(empty.length),
                  'cache-control': 'no-store',
                })
                response.end(empty)
                return
              }
              const headers = { ...responseHeaders, 'content-length': String(originalBody.length) }
              response.writeHead(status, headers)
              response.end(originalBody)
            }).catch(() => {
              if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
              response.end('Era bridge catalog response failed')
            })
            return
          }

          const cacheable = pathname.startsWith('/account/api/public/account')
          if (!cacheable) {
            response.writeHead(status, responseHeaders)
            upstreamResponse.pipe(response)
            return
          }

          const responseChunks = []
          upstreamResponse.on('data', (chunk) => responseChunks.push(chunk))
          upstreamResponse.on('end', () => {
            const responseBody = Buffer.concat(responseChunks)
            if (status === 200) {
              accountCache.set(pathname, {
                body: responseBody,
                headers: {
                  ...responseHeaders,
                  'content-length': String(responseBody.length),
                },
              })
            }
            const cached = status === 401 ? accountCache.get(pathname) : null
            if (cached) {
              response.writeHead(200, cached.headers)
              response.end(cached.body)
              return
            }
            responseHeaders['content-length'] = String(responseBody.length)
            response.writeHead(status, responseHeaders)
            response.end(responseBody)
          })
        },
      )

      forwarded.on('timeout', () => forwarded.destroy(new Error('Era bridge request timed out')))
      forwarded.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
        response.end('Era bridge upstream error')
      })
      response.on('close', () => {
        if (!response.writableEnded) forwarded.destroy()
      })
      forwarded.end(body)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      if (!port) {
        reject(new Error('Era bridge did not get a loopback port'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

module.exports = { createEraBridge }
