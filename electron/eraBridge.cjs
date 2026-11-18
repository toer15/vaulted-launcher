'use strict'

const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')

const REQUEST_TIMEOUT_MS = 60_000
const GAME_TOKEN_REFRESH_MARGIN_MS = 60_000
const DEFAULT_CLIENT_ID = 'ec684b8c687f479fadea3cb2ad83f5c6'

/**
 * The Era client is a native module loaded into the game. Its HTTP stack talks
 * to the live backend directly, so the game has to reach Era through a local
 * HTTP origin instead of the packaged Tellurium TLS proxy. This bridge forwards
 * every request to Era and keeps the small account/verify reads stable after
 * the backend stops treating the launcher's own OAuth token as a game client.
 *
 * Era's game access token is short-lived. The game only checks in through
 * /oauth/verify once a minute, so returning that same token after it expires
 * leaves the profile and cloud-storage calls answering 401. Remember the login
 * grant, rotate it with its refresh token before expiry, and put the fresh
 * bearer on every forwarded request.
 */
function createEraBridge({ upstream, accountId, displayName, onSessionKilled, onPresenceRequired }) {
  const target = new URL(upstream)
  const transport = target.protocol === 'http:' ? http : https
  const accountCache = new Map()
  const profileCache = new Map()
  let profileFallbackLogged = false
  let sessionKillNotified = false
  let catalogWarningLogged = false
  let refreshWarningLogged = false
  let gameTokenRefresh = null

  const gameToken = {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    sessionId: '',
    clientId: '',
    contentType: '',
    basicAuth: '',
  }

  function upstreamJson(pathname, { method = 'POST', headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
      const request = transport.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          method,
          path: pathname,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.once('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = JSON.parse(text)
            } catch {
              /* leave json null; the caller only uses a parsed token */
            }
            resolve({ status: response.statusCode || 0, json, text })
          })
        },
      )
      request.once('timeout', () => request.destroy(new Error('Era bridge token request timed out')))
      request.once('error', reject)
      request.end(body)
    })
  }

  function isEraClientMissing(body) {
    const text = body.toString('utf8')
    return (
      /The Era client isn't running\./i.test(text) ||
      /numericErrorCode["']?\s*[:=]\s*1032/.test(text)
    )
  }

  function rememberGameToken(json, authorization = '') {
    if (!json || typeof json !== 'object' || typeof json.access_token !== 'string') return
    gameToken.accessToken = json.access_token
    if (typeof json.refresh_token === 'string' && json.refresh_token) {
      gameToken.refreshToken = json.refresh_token
    }
    if (typeof json.session_id === 'string' && json.session_id) {
      gameToken.sessionId = json.session_id
    }
    const expiresIn = Number(json.expires_in)
    gameToken.expiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0
    if (typeof json.client_id === 'string' && json.client_id) gameToken.clientId = json.client_id
    if (authorization) gameToken.basicAuth = String(authorization)
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      console.log(`[era-bridge] game token issued for ${expiresIn}s`)
    }
  }

  async function refreshGameToken() {
    if (gameTokenRefresh) return gameTokenRefresh
    if (!gameToken.refreshToken || !gameToken.basicAuth) return gameToken.accessToken
    gameTokenRefresh = (async () => {
      try {
        const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(
          gameToken.refreshToken,
        )}`
        const result = await upstreamJson('/account/api/oauth/token', {
          headers: {
            Accept: 'application/json',
            Authorization: gameToken.basicAuth,
            'Content-Type': gameToken.contentType || 'application/x-www-form-urlencoded',
            'Accept-Encoding': 'identity',
            'User-Agent': 'VAULTED-Launcher/era-bridge',
          },
          body,
        })
        if (result.status === 200 && result.json?.access_token) {
          rememberGameToken(result.json, gameToken.basicAuth)
          refreshWarningLogged = false
          console.log('[era-bridge] game token refreshed')
          return gameToken.accessToken
        }
        if (!refreshWarningLogged) {
          refreshWarningLogged = true
          console.warn(`[era-bridge] game token refresh failed (HTTP ${result.status})`)
        }
      } catch (error) {
        if (!refreshWarningLogged) {
          refreshWarningLogged = true
          console.warn(
            `[era-bridge] game token refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      } finally {
        gameTokenRefresh = null
      }
      return gameToken.accessToken
    })()
    return gameTokenRefresh
  }

  async function freshGameToken() {
    if (!gameToken.accessToken) return ''
    if (
      !gameToken.expiresAt ||
      gameToken.expiresAt - Date.now() > GAME_TOKEN_REFRESH_MARGIN_MS
    ) {
      return gameToken.accessToken
    }
    return await refreshGameToken()
  }

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
    request.on('end', async () => {
      try {
        const body = Buffer.concat(chunks)
        const pathname = String(request.url || '').split('?')[0]
        const method = String(request.method || 'GET').toUpperCase()

        if (pathname === '/account/api/oauth/verify') {
          // Era checks the game-client presence during verify and again when
          // the client asks for a matchmaking session. Re-assert it before the
          // periodic verify so a long lobby session cannot age out.
          await Promise.resolve(onPresenceRequired?.()).catch(() => {})
          const authorization = String(request.headers.authorization || '')
          const incoming = authorization.replace(/^Bearer\s+/i, '')
          const fresh = await freshGameToken()
          const token = fresh || incoming
          // Verify is the game's only periodic session renewal. Forwarding it
          // lets Era extend the game session; a synthetic reply cannot renew
          // that server-side lease. Fall back to the synthetic shape only when
          // the upstream verify itself rejects the game token.
          const upstreamVerify = await upstreamJson(pathname, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
              'Accept-Encoding': 'identity',
              'User-Agent': 'VAULTED-Launcher/era-bridge',
            },
          })
          if (upstreamVerify.status === 200 && upstreamVerify.json) {
            const verified = { ...upstreamVerify.json }
            if (!verified.token && token) verified.token = token
            if (!verified.session_id && gameToken.sessionId) {
              verified.session_id = gameToken.sessionId
            }
            const payload = Buffer.from(JSON.stringify(verified))
            response.writeHead(200, {
              'content-type': 'application/json',
              'content-length': payload.length,
              'cache-control': 'no-store',
            })
            response.end(payload)
            return
          }
          if (!refreshWarningLogged) {
            refreshWarningLogged = true
            console.warn(
              `[era-bridge] upstream verify rejected the game token (HTTP ${upstreamVerify.status}); using the local verify shape`,
            )
          }
          const remaining = gameToken.expiresAt
            ? Math.max(60, Math.round((gameToken.expiresAt - Date.now()) / 1000))
            : 28800
          const payload = Buffer.from(
            JSON.stringify({
              token,
              // The game stores this session id at login and sends it with its
              // later requests. A fresh random id makes Era see a different
              // client session and answer profile reads with 401.
              session_id: gameToken.sessionId || crypto.randomUUID().replace(/-/g, ''),
              token_type: 'bearer',
              client_id: gameToken.clientId || DEFAULT_CLIENT_ID,
              internal_client: false,
              display_name: displayName || '',
              app: 'fortnite',
              account_id: accountId || '',
              expires_in: remaining,
              expires_at: new Date(Date.now() + remaining * 1000).toISOString(),
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

        // FindSingleSession is issued after the matchmaking queue assigns a
        // match. Era answers it with 401 "The Era client isn't running" (1032)
        // if its client-presence lease lapsed, even when the bearer is valid.
        // Refresh presence immediately before forwarding the lookup.
        if (pathname.startsWith('/fortnite/api/matchmaking/session/')) {
          await Promise.resolve(onPresenceRequired?.()).catch(() => {})
        }

        const headers = { ...request.headers }
        delete headers.host
        delete headers.connection
        delete headers['content-length']
        headers.host = target.host
        headers['accept-encoding'] = 'identity'

        // The game's own copy of the token can be minutes old. Use the fresh
        // grant on profile, cloud-storage, party and matchmaking calls so Era
        // never sees the expired bearer that produced the post-match 401.
        const requestAuthorization = String(request.headers.authorization || '')
        if (
          /^Bearer\s+/i.test(requestAuthorization) &&
          pathname !== '/account/api/oauth/token' &&
          pathname !== '/account/api/oauth/exchange'
        ) {
          const fresh = await freshGameToken()
          if (fresh) headers.authorization = `Bearer ${fresh}`
        }

        if (body.length) headers['content-length'] = String(body.length)

        const forwarded = transport.request(
          {
            hostname: target.hostname,
            port: target.port || (target.protocol === 'http:' ? 80 : 443),
            method,
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
              method === 'DELETE'
            ) {
              upstreamResponse.once('end', notifySessionKilled)
            }

            const matchmakingSession = pathname.startsWith('/fortnite/api/matchmaking/session/')
            if (matchmakingSession && status === 401) {
              // The queue assignment is already valid, but Era's presence lease
              // can expire between the queue and FindSingleSession. Reassert
              // presence, rotate the game token if possible, then replay the
              // lookup once instead of surfacing "The Era client isn't running".
              const responseChunks = []
              upstreamResponse.on('data', (chunk) => responseChunks.push(chunk))
              upstreamResponse.once('end', async () => {
                // Force a fresh gateway session here: a presence resend on the
                // same stale socket can still leave Era's lease marked absent.
                await Promise.resolve(onPresenceRequired?.(true)).catch(() => {})
                const fresh = await refreshGameToken().catch(() => '')
                const retryHeaders = { ...headers }
                if (fresh) retryHeaders.authorization = `Bearer ${fresh}`
                const retry = transport.request(
                  {
                    hostname: target.hostname,
                    port: target.port || (target.protocol === 'http:' ? 80 : 443),
                    method,
                    path: request.url,
                    headers: retryHeaders,
                    timeout: REQUEST_TIMEOUT_MS,
                  },
                  (retryResponse) => {
                    const retryStatus = retryResponse.statusCode || 502
                    const retryResponseHeaders = { ...retryResponse.headers }
                    delete retryResponseHeaders.connection
                    delete retryResponseHeaders['transfer-encoding']
                    response.writeHead(retryStatus, retryResponseHeaders)
                    retryResponse.pipe(response)
                  },
                )
                retry.on('timeout', () => retry.destroy(new Error('Era bridge retry timed out')))
                retry.on('error', () => {
                  if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
                  response.end('Era bridge matchmaking retry failed')
                })
                retry.end(body)
              })
              return
            }

            if (
              pathname === '/account/api/oauth/token' &&
              method === 'POST'
            ) {
              const responseChunks = []
              upstreamResponse.on('data', (chunk) => responseChunks.push(chunk))
              upstreamResponse.once('end', () => {
                const responseBody = Buffer.concat(responseChunks)
                if (status === 200) {
                  let json = null
                  try {
                    json = JSON.parse(responseBody.toString('utf8'))
                  } catch {
                    /* keep the original response body */
                  }
                  rememberGameToken(json, request.headers.authorization)
                }
                responseHeaders['content-length'] = String(responseBody.length)
                response.writeHead(status, responseHeaders)
                response.end(responseBody)
              })
              return
            }

            const profilePath = pathname.startsWith('/fortnite/api/game/v2/profile/')
            const cloudPath = pathname.startsWith('/fortnite/api/cloudstorage/')
            if ((profilePath || cloudPath) && status === 401) {
              const responseChunks = []
              upstreamResponse.on('data', (chunk) => responseChunks.push(chunk))
              upstreamResponse.once('end', () => {
                const responseBody = Buffer.concat(responseChunks)
                if (!isEraClientMissing(responseBody)) {
                  responseHeaders['content-length'] = String(responseBody.length)
                  response.writeHead(status, responseHeaders)
                  response.end(responseBody)
                  return
                }

                // Era's own client-presence lease has lapsed, but the game is
                // still running and its match just finished. Answer profile
                // and cloud-save calls from the last successful snapshot (or
                // a valid empty profile) instead of letting a 401 reach
                // UFortOnlineAccount::ForceLogout.
                const profileId = (() => {
                  try {
                    return new URL(request.url, 'http://era').searchParams.get('profileId') || 'athena'
                  } catch {
                    return 'athena'
                  }
                })()
                const cached = profilePath ? profileCache.get(profileId) : null
                const fallbackBody = cached?.body ||
                  Buffer.from(
                    JSON.stringify(
                      profilePath
                        ? {
                            profileRevision: 0,
                            profileId,
                            profileChanges: [],
                            profileCommand: pathname.split('/').pop() || 'QueryProfile',
                            serverTime: new Date().toISOString(),
                          }
                        : method === 'GET'
                          ? []
                          : {},
                    ),
                  )
                if (!profileFallbackLogged) {
                  profileFallbackLogged = true
                  console.warn(
                    '[era-bridge] Era stopped recognising the game client; keeping the session alive with local profile responses',
                  )
                }
                response.writeHead(200, {
                  'content-type': 'application/json; charset=utf-8',
                  'content-length': String(fallbackBody.length),
                  'cache-control': 'no-store',
                })
                response.end(fallbackBody)
              })
              return
            }

            if (profilePath) {
              const responseChunks = []
              upstreamResponse.on('data', (chunk) => responseChunks.push(chunk))
              upstreamResponse.once('end', () => {
                const responseBody = Buffer.concat(responseChunks)
                if (status === 200) {
                  let profileId = 'athena'
                  try {
                    profileId =
                      new URL(request.url, 'http://era').searchParams.get('profileId') || 'athena'
                  } catch {
                    /* keep the default */
                  }
                  profileCache.set(profileId, {
                    body: responseBody,
                    headers: {
                      ...responseHeaders,
                      'content-length': String(responseBody.length),
                    },
                  })
                }
                responseHeaders['content-length'] = String(responseBody.length)
                response.writeHead(status, responseHeaders)
                response.end(responseBody)
              })
              return
            }

            if (
              pathname === '/catalog/api/shared/bulk/offers' &&
              method === 'GET' &&
              status === 401
            ) {
              void normalizeCatalogFailure(
                upstreamResponse,
                headers.authorization || request.headers.authorization,
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
      } catch {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
        response.end('Era bridge request failed')
      }
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
