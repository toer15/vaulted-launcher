'use strict'

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { providerRoot } = require('./onlineProviders.cjs')

/**
 * Public community discovery.
 *
 * Endpoints live in resources/providers/community.json so directories can be
 * added, moved or re-mapped without changing the launch path. The renderer
 * only asks for a season/provider; it never supplies a URL, which keeps this
 * from becoming an arbitrary-network-request bridge.
 *
 * A directory may expose three different shapes:
 *   - joinable lobbies (an address is required)
 *   - provider/season status (players, max players, region)
 *   - a curated project directory (provider/season availability)
 *
 * They are deliberately kept separate. A health endpoint is never turned into
 * a lobby, and a directory entry without an address is never made joinable.
 */
const DEFAULT_TIMEOUT_MS = 6000
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_SERVERS = 250
const DEFAULT_FRESHNESS_MS = 30_000
const DEFAULT_RETRY_AFTER_MS = 60_000
const DEFAULT_PING_TIMEOUT_MS = 350
/** endpoint id -> timestamp before which a failed directory is not retried */
const endpointRetryAt = new Map()
const FALLBACK_ENDPOINTS = [
  {
    id: 'vaulted-public',
    label: 'VAULTED Public',
    kind: 'vaulted-summary',
    url: 'https://site-710f0be1e3b24f2694e9e13b9ce4c84b.freebuff.page/api/summary',
    auth: 'account',
    seasonParam: 'season',
    providerIds: ['*'],
    seasonIds: ['*'],
  },
]

function safeString(value, limit = 100) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function safeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function safeSeasonId(value) {
  const text = safeString(value, 32).toLowerCase()
  return /^ch\d{1,2}-s\d{1,2}$/.test(text) ? text : ''
}

function readPath(value, pathValue) {
  if (pathValue === undefined || pathValue === null || pathValue === '') return undefined
  if (Array.isArray(pathValue)) {
    for (const candidate of pathValue) {
      const found = readPath(value, candidate)
      if (found !== undefined) return found
    }
    return undefined
  }

  let current = value
  for (const part of String(pathValue).split('.')) {
    if (current === undefined || current === null) return undefined
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
    else if (typeof current === 'object') current = current[part]
    else return undefined
  }
  return current
}

function configuredValue(raw, endpoint, key, fallbacks = []) {
  const configured = endpoint.fields?.[key]
  if (configured) {
    const found = readPath(raw, configured)
    if (found !== undefined) return found
  }
  for (const fallback of fallbacks) {
    if (raw[fallback] !== undefined && raw[fallback] !== null) return raw[fallback]
  }
  return undefined
}

function normalizeHostPort(value, fallbackPort = 7777) {
  const raw = safeString(value, 255)
  if (!raw) return null

  let host = raw
  let port = safeNumber(fallbackPort, 7777)

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
    // Unbracketed IPv6 has no unambiguous port; use the game's default port.
    host = raw
  }

  if (!host || host.length > 253 || !/^[A-Za-z0-9._:-]+$/.test(host)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function addressFor(raw, endpoint) {
  const configuredAddress = configuredValue(raw, endpoint, 'address', [
    'address',
    'server',
    'endpoint',
    'host',
    'ip',
  ])
  const explicitAddress = safeString(configuredAddress, 255)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
  if (explicitAddress) {
    const parsed = normalizeHostPort(explicitAddress, safeNumber(configuredValue(raw, endpoint, 'port', ['port']), 7777))
    if (parsed) return parsed
  }

  const host = safeString(configuredValue(raw, endpoint, 'host', ['host', 'ip']), 253)
  if (!host) return null
  return normalizeHostPort(host, safeNumber(configuredValue(raw, endpoint, 'port', ['port']), 7777))
}

function updatedAt(raw, endpoint) {
  const value = configuredValue(raw, endpoint, 'updated', [
    'updated',
    'updatedAt',
    'lastSeen',
    'last_seen',
    'timestamp',
  ])
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e11 ? value * 1000 : value).toISOString()
  }
  return new Date().toISOString()
}

function countFromValue(value) {
  const direct = value && typeof value === 'object' && !Array.isArray(value) ? value.count ?? value.players : value
  if (Array.isArray(direct)) return Math.min(10_000, Math.max(0, direct.length))
  const number = Number(direct)
  return Number.isFinite(number) ? Math.min(10_000, Math.max(0, Math.floor(number))) : undefined
}

function playerCount(raw, endpoint) {
  const configured = configuredValue(raw, endpoint, 'players', [
    'players',
    'playerCount',
    'player_count',
    'numPlayers',
    'count',
    'Joined',
  ])
  return countFromValue(configured)
}

function maxPlayerCount(raw, endpoint) {
  const value = configuredValue(raw, endpoint, 'maxPlayers', [
    'maxPlayers',
    'max_players',
    'capacity',
    'MaxPlayers',
  ])
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.min(10_000, Math.floor(number)) : undefined
}

function serverPing(raw, endpoint) {
  const value = configuredValue(raw, endpoint, 'ping', [
    'pingMs',
    'ping',
    'latencyMs',
    'latency',
  ])
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.min(60_000, Math.round(number)) : undefined
}

function onlineFor(raw, endpoint) {
  const value = configuredValue(raw, endpoint, 'online', ['online', 'Joinable', 'joinable', 'status'])
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = safeString(value, 32).toLowerCase()
  if (['up', 'online', 'operational', 'joinable', 'open', 'available', 'in_game', 'starting', 'true', '1'].includes(text)) {
    return true
  }
  if (['down', 'offline', 'closed', 'false', '0', 'ended', 'restarting'].includes(text)) return false
  return undefined
}

function seasonFor(raw, hint, endpoint) {
  const direct = [
    configuredValue(raw, endpoint, 'season', []),
    raw.seasonId,
    raw.seasonKey,
    raw.season_id,
    raw.buildId,
  ].find((value) => typeof value === 'string' && safeSeasonId(value))
  if (direct) return safeSeasonId(direct)

  if (typeof raw.season === 'string' && safeSeasonId(raw.season)) return safeSeasonId(raw.season)

  const version = configuredValue(raw, endpoint, 'build', [
    'version',
    'build',
    'buildVersion',
    'build_version',
  ])
  if (version !== undefined) {
    const exact = endpoint.seasonMap?.[String(version)] ?? endpoint.seasonMap?.[String(version).split('.')[0]]
    if (exact) return exact
    const fromVersion = seasonFromVersion(version)
    if (fromVersion) return fromVersion
  }

  const label = String(
    configuredValue(raw, endpoint, 'label', [
      'label',
      'title',
      'seasonLabel',
      'seasonName',
      'Playlist',
    ]) || '',
  )
  const fromLabel =
    /chapter\s*(\d{1,2})\s*[,·:-]?\s*season\s*(\d{1,2})/i.exec(label) ||
    /\bch\s*(\d{1,2})\s*[·:-]\s*s\s*(\d{1,2})\b/i.exec(label)
  if (fromLabel) return `ch${Number(fromLabel[1])}-s${Number(fromLabel[2])}`

  const chapter = Number(raw.chapter)
  const season = Number(raw.season)
  if (Number.isInteger(chapter) && chapter > 0 && Number.isInteger(season) && season > 0) {
    return `ch${chapter}-s${season}`
  }

  // A hint comes from a payload keyed by season; it must not override a real
  // build/version field on the row itself.
  if (typeof hint === 'string' && safeSeasonId(hint)) return safeSeasonId(hint)

  if (endpoint.defaultSeasonId) return endpoint.defaultSeasonId
  const fixed = endpoint.seasonIds.find((value) => value !== '*')
  return fixed || null
}

/**
 * Fortnite build major to season mapping, used when a directory publishes a
 * version instead of a season id. A config seasonMap can override any entry.
 */
function seasonFromVersion(value) {
  const text = safeString(value, 32)
  const match = /^(\d{1,2})(?:\.(\d{1,3}))?/.exec(text)
  if (!match) return null
  const major = Number(match[1])
  const minor = match[2] === undefined ? null : Number(match[2])

  if (major === 1) {
    if (minor !== null && minor >= 11) return 'ch1-s2'
    return 'ch1-s1'
  }
  if (major === 2) return 'ch1-s2'
  if (major >= 3 && major <= 10) return `ch1-s${major}`
  if (major >= 11 && major <= 17) return `ch2-s${major - 10}`
  if (major >= 18 && major <= 24) return `ch3-s${major - 17}`
  if (major >= 25 && major <= 30) return `ch4-s${major - 24}`
  if (major >= 31 && major <= 35) return `ch5-s${major - 30}`
  return null
}

function providerFor(raw, endpoint) {
  const direct = configuredValue(raw, endpoint, 'provider', ['providerId', 'provider', 'Provider'])
  const value = safeString(direct, 40)
  if (value) return value
  if (endpoint.providerId) return endpoint.providerId
  if (endpoint.providerIds.length === 1 && endpoint.providerIds[0] !== '*') return endpoint.providerIds[0]
  return 'community'
}

function providerLabelFor(providerId, endpoint) {
  const mapped = endpoint.providerMap?.[providerId] ?? endpoint.providerMap?.[providerId.toLowerCase()]
  if (mapped) return mapped.label || mapped.id || providerId
  if (endpoint.providerLabel && endpoint.providerId === providerId) return endpoint.providerLabel
  return providerId
}

/**
 * Manifest providers and directory providers differ only by the EZFN
 * "hybrid" suffix. Sharing one matcher keeps the season's assigned provider
 * eligible instead of silently dropping it from discovery.
 */
function providerMatches(serverProviderId, targetProviderId) {
  if (!targetProviderId) return true
  const left = safeString(serverProviderId, 40).toLowerCase()
  const right = safeString(targetProviderId, 40).toLowerCase()
  if (!left || !right || left === 'community' || right === 'community') return true
  return left === right || left.replace(/-hybrid$/, '') === right.replace(/-hybrid$/, '')
}

function collectEntries(payload, hint, depth = 0) {
  if (depth > 4 || payload == null) return []
  if (Array.isArray(payload)) return payload.map((value) => ({ value, hint }))
  if (typeof payload !== 'object') return []

  const record = payload
  if (
    typeof record.address === 'string' ||
    typeof record.host === 'string' ||
    typeof record.ip === 'string'
  ) {
    return [{ value: record, hint }]
  }

  for (const key of ['lobbies', 'sessions', 'activeLobbies', 'servers', 'items', 'data']) {
    if (record[key] === undefined || record[key] === null) continue
    const nested = collectEntries(record[key], hint, depth + 1)
    if (nested.length > 0) return nested
  }

  const entries = []
  for (const [key, value] of Object.entries(record)) {
    const seasonHint = safeSeasonId(key) || hint
    if (Array.isArray(value)) {
      for (const item of value) entries.push({ value: item, hint: seasonHint })
    } else if (value && typeof value === 'object') {
      entries.push({ value, hint: seasonHint })
    }
  }
  return entries
}

function entriesForPayload(payload, endpoint, hint) {
  const configured = endpoint.entriesPath
  if (configured) {
    const value = readPath(payload, configured)
    if (Array.isArray(value)) return value.map((item) => ({ value: item, hint }))
    if (value && typeof value === 'object') return [{ value, hint }]
    return []
  }
  return collectEntries(payload, hint)
}

function normalizeServer(value, endpoint, hint, index) {
  if (!value || typeof value !== 'object' || endpoint.statusOnly) return null
  const raw = value
  if (raw.password || raw.passwordRequired === true) return null
  if (raw.public === false || raw.public === 0 || raw.isPublic === false || raw.private === true) return null

  const online = onlineFor(raw, endpoint)
  if (online === false) return null

  const address = addressFor(raw, endpoint)
  if (!address) return null

  const seasonId = seasonFor(raw, hint, endpoint)
  const providerId = providerFor(raw, endpoint)
  const name =
    safeString(configuredValue(raw, endpoint, 'name', ['name', 'title', 'label', 'ServerName']), 80) ||
    safeString(raw.label || raw.title || raw.seasonLabel || raw.seasonName || endpoint.label, 80)
  const label = safeString(
    configuredValue(raw, endpoint, 'label', ['label', 'title', 'seasonLabel', 'seasonName', 'Playlist']),
    80,
  )
  const username = safeString(
    raw.username || raw.owner || raw.hostName || raw.author || raw.ServerName || raw.name || 'community',
    40,
  )
  const players = playerCount(raw, endpoint)
  const maxPlayers = maxPlayerCount(raw, endpoint)

  return {
    id: `${endpoint.id}:${seasonId || 'all'}:${address.host}:${address.port}:${index}`,
    name: name || label || providerLabelFor(providerId, endpoint),
    username,
    address: `${address.host}:${address.port}`,
    host: address.host,
    port: address.port,
    buildId: seasonId,
    seasonId,
    label: label || null,
    public: true,
    updated: updatedAt(raw, endpoint),
    freshForMs: endpoint.freshnessMs,
    players: players !== undefined && players > 0 ? players : undefined,
    playersKnown: players !== undefined || endpoint.kind === 'vaulted-summary',
    pingMs: serverPing(raw, endpoint),
    maxPlayers,
    providerId,
    providerLabel: providerLabelFor(providerId, endpoint),
    source: endpoint.id,
    sourceLabel: endpoint.label,
    // The VAULTED relay is the fallback directory; every other configured
    // endpoint is an external community directory that Play prefers.
    external: endpoint.id !== 'vaulted-public',
  }
}

function normalizeCommunityPayload(payload, endpoint, hint) {
  const seen = new Set()
  const servers = []
  const entries = entriesForPayload(payload, endpoint, hint || undefined)
  for (const entry of entries) {
    const server = normalizeServer(entry.value, endpoint, entry.hint, servers.length)
    if (!server) continue
    const key = `${server.seasonId || 'all'}|${server.address.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    servers.push(server)
    if (servers.length >= MAX_SERVERS) break
  }
  return servers
}

function normalizeStatusEntry(value, endpoint, hint) {
  if (!value || typeof value !== 'object') return null
  const raw = value
  const online = onlineFor(raw, endpoint)
  if (online === false) return null

  const players = playerCount(raw, endpoint)
  const maxPlayers = maxPlayerCount(raw, endpoint)
  if (online === undefined && players === undefined && maxPlayers === undefined) return null

  const seasonId = seasonFor(raw, hint, endpoint)
  const providerId = providerFor(raw, endpoint)
  const region = safeString(configuredValue(raw, endpoint, 'region', ['Region', 'region']), 32)
  const playlist = safeString(configuredValue(raw, endpoint, 'playlist', ['Playlist', 'playlist']), 64)
  const updated = updatedAt(raw, endpoint)
  if (endpoint.freshnessMs > 0 && Date.parse(updated) < Date.now() - endpoint.freshnessMs) return null
  return {
    providerId,
    providerLabel: providerLabelFor(providerId, endpoint),
    seasonId,
    online: online !== false,
    players,
    maxPlayers,
    region: region || null,
    playlist: playlist || null,
    serverName:
      safeString(configuredValue(raw, endpoint, 'name', ['ServerName', 'name', 'title']), 80) || null,
    updated,
    source: endpoint.id,
    sourceLabel: endpoint.label,
  }
}

function aggregateStatuses(statuses) {
  const grouped = new Map()
  for (const status of statuses) {
    const key = `${status.providerId}|${status.seasonId || 'all'}`
    let current = grouped.get(key)
    if (!current) {
      current = {
        providerId: status.providerId,
        providerLabel: status.providerLabel,
        seasonId: status.seasonId,
        online: false,
        players: undefined,
        maxPlayers: undefined,
        servers: 0,
        regions: new Set(),
        playlists: new Set(),
        updated: status.updated,
        source: status.source,
        sourceLabel: status.sourceLabel,
      }
      grouped.set(key, current)
    }
    current.online = current.online || status.online
    current.servers += 1
    if (status.players !== undefined) current.players = (current.players ?? 0) + status.players
    if (status.maxPlayers !== undefined) current.maxPlayers = (current.maxPlayers ?? 0) + status.maxPlayers
    if (status.region) current.regions.add(status.region)
    if (status.playlist) current.playlists.add(status.playlist)
    if (Date.parse(status.updated) > Date.parse(current.updated)) current.updated = status.updated
  }

  return [...grouped.values()].map((status) => ({
    providerId: status.providerId,
    providerLabel: status.providerLabel,
    seasonId: status.seasonId,
    online: status.online,
    players: status.players,
    maxPlayers: status.maxPlayers,
    servers: status.servers,
    region: status.regions.size > 0 ? [...status.regions].join(' / ') : null,
    playlist: status.playlists.size > 0 ? [...status.playlists].join(' / ') : null,
    updated: status.updated,
    source: status.source,
    sourceLabel: status.sourceLabel,
  }))
}

function normalizeStatusPayload(payload, endpoint, hint) {
  const entries = entriesForPayload(payload, endpoint, hint || undefined)
  const statuses = []
  for (const entry of entries) {
    const status = normalizeStatusEntry(entry.value, endpoint, entry.hint)
    if (status) statuses.push(status)
  }
  return aggregateStatuses(statuses)
}

function cleanMarkdown(value) {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function markdownUrl(value) {
  const match = /\((https?:\/\/[^)\s]+)\)/i.exec(value)
  return match ? safeString(match[1], 2048) : null
}

function providerEntry(name, seasonId, source, endpoint, rawLine = '') {
  const cleanName = cleanMarkdown(name)
  const key = Object.keys(endpoint.providerMap || {}).find(
    (candidate) => candidate.toLowerCase() === cleanName.toLowerCase(),
  )
  if (!key) return null
  const mapped = endpoint.providerMap[key]
  return {
    providerId: safeString(mapped.id, 40) || key.toLowerCase(),
    providerLabel: safeString(mapped.label, 60) || key,
    seasonId: safeSeasonId(seasonId) || null,
    seasonLabel: seasonId ? null : null,
    name: cleanName,
    url: safeString(mapped.url, 2048) || markdownUrl(rawLine) || null,
    source: endpoint.id,
    sourceLabel: endpoint.label,
  }
}

function seasonIdFromChapterSeason(chapter, season) {
  const c = Number(chapter)
  const s = String(season).trim().toUpperCase() === 'X' ? 10 : Number(season)
  if (!Number.isInteger(c) || c < 1 || !Number.isInteger(s) || s < 1) return null
  return `ch${c}-s${s}`
}

/**
 * awesome-ogfn's hosted-projects section is a stable Markdown bullet list:
 *   * Era (Chapter 1, Season 8)
 */
function parseAwesomeOgfn(text, endpoint) {
  const directories = []
  let inHosted = false
  for (const line of String(text).split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      const title = cleanMarkdown(heading[1])
      inHosted =
        /hosted\s+servers?\s*\/?\s*projects?/i.test(title) && !/self\s+hosted/i.test(title)
      continue
    }
    if (!inHosted) continue

    const bullet = /^\s*[-*]\s+(.+)$/.exec(line)
    if (!bullet) continue
    const content = bullet[1]
    const linked = cleanMarkdown(content)
    const name = linked.replace(/\([^)]*\)/g, '').replace(/^⭐\s*/, '').trim()
    const parenthetical = /\(([^)]*)\)/.exec(linked)?.[1] || ''
    const seasonMatch =
      /chapter\s*(\d{1,2})\s*[,·:-]?\s*season\s*([0-9]{1,2}|x)/i.exec(parenthetical) ||
      /chapter\s*(\d{1,2})\s*[,·:-]?\s*season\s*([0-9]{1,2}|x)/i.exec(content)
    const seasonId = seasonMatch ? seasonIdFromChapterSeason(seasonMatch[1], seasonMatch[2]) : null
    const entry = providerEntry(name, seasonId, endpoint.id, endpoint, content)
    if (entry) directories.push(entry)
  }
  return directories
}

/**
 * Fortnite-Versions/Projects.md uses season headings and Markdown tables.
 * Capture the project name and build version, then map the provider name.
 */
function parseFortniteVersions(text, endpoint) {
  const directories = []
  let season = null
  for (const line of String(text).split(/\r?\n/)) {
    const heading = /^#{1,6}\s+.*?season\s*(\d{1,2})/i.exec(line)
    if (heading) {
      season = seasonIdFromChapterSeason(1, heading[1])
      continue
    }
    if (!/^\s*\|/.test(line)) continue
    const cells = line
      .split('|')
      .map((cell) => cleanMarkdown(cell))
      .filter(Boolean)
    if (cells.length < 2) continue
    const name = cells[0]
    if (/^(project name|season|build|download)/i.test(name)) continue
    const build = /(\d{1,2}\.\d{1,3})/.exec(cells[1])?.[1] || ''
    const mappedSeason = season || (build ? seasonFromVersion(build) : null)
    const entry = providerEntry(name, mappedSeason, endpoint.id, endpoint, line)
    if (entry) {
      if (build) entry.build = build
      directories.push(entry)
    }
  }
  return directories
}

function parseDirectoryPayload(text, endpoint) {
  if (endpoint.kind === 'awesome-ogfn') return parseAwesomeOgfn(text, endpoint)
  if (endpoint.kind === 'fortnite-versions-directory') return parseFortniteVersions(text, endpoint)
  return []
}

function dedupeDirectories(entries) {
  const seen = new Set()
  const result = []
  for (const entry of entries) {
    const key = `${entry.source}|${entry.providerId}|${entry.seasonId || 'all'}|${entry.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

function readConfig() {
  const file = path.join(providerRoot(), 'community.json')
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    raw = null
  }

  let endpoints = Array.isArray(raw?.endpoints) ? raw.endpoints : FALLBACK_ENDPOINTS
  const env = process.env.VAULTED_COMMUNITY_ENDPOINTS
  if (env) {
    try {
      const custom = JSON.parse(env)
      if (Array.isArray(custom)) endpoints = custom
      else if (Array.isArray(custom?.endpoints)) endpoints = custom.endpoints
    } catch {
      /* keep the bundled directory */
    }
  }

  const valid = []
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint !== 'object') continue
    const id = safeString(endpoint.id, 48)
    const label = safeString(endpoint.label, 64)
    const url = safeString(endpoint.url, 2048)
    if (!id || !label || !url) continue

    const kind = safeString(endpoint.kind, 40) || 'generic-server-list'
    const websocket =
      safeString(endpoint.format, 16).toLowerCase() === 'websocket' ||
      kind === 'reboot-server-browser' ||
      /^wss?:/i.test(url)
    try {
      const parsed = new URL(url)
      if (websocket) {
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') continue
      } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        continue
      }
    } catch {
      continue
    }

    const fields = {}
    if (endpoint.fields && typeof endpoint.fields === 'object') {
      for (const [key, value] of Object.entries(endpoint.fields)) {
        const field = safeString(value, 80)
        if (field) fields[key] = field
      }
    }

    const seasonMap = {}
    if (endpoint.seasonMap && typeof endpoint.seasonMap === 'object') {
      for (const [key, value] of Object.entries(endpoint.seasonMap)) {
        const seasonId = safeSeasonId(value)
        if (seasonId) seasonMap[safeString(key, 40)] = seasonId
      }
    }

    const providerMap = {}
    if (endpoint.providerMap && typeof endpoint.providerMap === 'object') {
      for (const [key, value] of Object.entries(endpoint.providerMap)) {
        const mapped = typeof value === 'string' ? { id: value, label: key } : value
        const providerId = safeString(mapped?.id, 40)
        if (!providerId) continue
        providerMap[safeString(key, 60)] = {
          id: providerId,
          label: safeString(mapped?.label, 60) || key,
          url: safeString(mapped?.url, 2048),
        }
      }
    }

    valid.push({
      id,
      label,
      kind,
      enabled: endpoint.enabled !== false,
      url,
      format: websocket ? 'websocket' : 'http',
      auth: endpoint.auth === 'account' ? 'account' : 'none',
      seasonParam: safeString(endpoint.seasonParam, 24) || 'season',
      providerParam: safeString(endpoint.providerParam, 24),
      statusOnly: endpoint.statusOnly === true,
      timeoutMs: Math.min(15_000, Math.max(1000, safeNumber(endpoint.timeoutMs, DEFAULT_TIMEOUT_MS))),
      freshnessMs: Math.min(86_400_000, Math.max(0, safeNumber(endpoint.freshnessMs, DEFAULT_FRESHNESS_MS))),
      entriesPath: Array.isArray(endpoint.entriesPath)
        ? endpoint.entriesPath.map((value) => safeString(value, 80)).filter(Boolean)
        : safeString(endpoint.entriesPath, 80),
      fields,
      seasonMap,
      providerMap,
      providerId: safeString(endpoint.providerId, 40),
      providerLabel: safeString(endpoint.providerLabel, 60),
      defaultSeasonId: safeSeasonId(endpoint.defaultSeasonId),
      providerIds: Array.isArray(endpoint.providerIds)
        ? endpoint.providerIds.map((value) => safeString(value, 40)).filter(Boolean)
        : endpoint.providerId
          ? [safeString(endpoint.providerId, 40)]
          : ['*'],
      seasonIds: Array.isArray(endpoint.seasonIds)
        ? endpoint.seasonIds
            .map((value) => safeSeasonId(value) || (value === '*' ? '*' : ''))
            .filter(Boolean)
        : endpoint.defaultSeasonId
          ? [endpoint.defaultSeasonId]
          : ['*'],
    })
  }

  return {
    requestTimeoutMs: Math.min(15_000, Math.max(1500, safeNumber(raw?.requestTimeoutMs, DEFAULT_TIMEOUT_MS))),
    failureCooldownMs: Math.min(3_600_000, Math.max(0, safeNumber(raw?.failureCooldownMs, DEFAULT_RETRY_AFTER_MS))),
    pingTimeoutMs: Math.min(5000, Math.max(100, safeNumber(raw?.pingTimeoutMs, DEFAULT_PING_TIMEOUT_MS))),
    maxServers: Math.min(1000, Math.max(1, safeNumber(raw?.maxServers, MAX_SERVERS))),
    endpoints: valid.length > 0 ? valid : FALLBACK_ENDPOINTS,
  }
}

function endpointMatches(endpoint, seasonId, providerId) {
  if (seasonId && !endpoint.seasonIds.includes('*') && !endpoint.seasonIds.includes(seasonId)) return false
  if (
    providerId &&
    !endpoint.providerIds.includes('*') &&
    !endpoint.providerIds.some((id) => providerMatches(id, providerId))
  ) {
    return false
  }
  return true
}

function targetUrl(endpoint, seasonId, providerId) {
  const url = new URL(endpoint.url)
  if (seasonId) url.searchParams.set(endpoint.seasonParam, seasonId)
  if (providerId && endpoint.providerParam) url.searchParams.set(endpoint.providerParam, providerId)
  return url
}

function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const request = fetchImpl
    ? fetchImpl(url, { ...options, signal: controller.signal })
    : fetch(url, { ...options, signal: controller.signal })
  return request.finally(() => clearTimeout(timer))
}

async function fetchWebSocketPayload(endpoint, options) {
  let WebSocket
  try {
    WebSocket = require('ws')
  } catch {
    throw new Error('The WebSocket directory adapter is unavailable.')
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let socket
    const finish = (error, payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        /* already closed */
      }
      if (error) reject(error)
      else resolve(payload)
    }
    const timer = setTimeout(() => finish(new Error('Community directory timed out.')), options.timeoutMs)

    try {
      socket = new WebSocket(endpoint.url, {
        handshakeTimeout: options.timeoutMs,
        maxPayload: options.maxBytes,
        perMessageDeflate: false,
        headers: { 'user-agent': 'VAULTED-Launcher' },
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Community directory was unreachable.'))
      return
    }

    socket.on('message', (data) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
        if (text.length > options.maxBytes) throw new Error('Community directory returned an oversized response.')
        const payload = JSON.parse(text)
        const type = safeString(payload?.type, 24).toLowerCase()
        if (type && type !== 'add' && !Array.isArray(payload?.data)) return
        finish(null, payload)
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Community directory returned invalid JSON.'))
      }
    })
    socket.on('error', (error) => finish(error instanceof Error ? error : new Error('Community directory was unreachable.')))
    socket.on('unexpected-response', (_request, response) => {
      finish(new Error(`Community directory answered ${response.statusCode}.`))
    })
    socket.on('close', () => {
      if (!settled) finish(new Error('Community directory closed without a server list.'))
    })
  })
}

async function fetchEndpoint(endpoint, options) {
  if (endpoint.format === 'websocket') {
    const timeoutMs = Number.isFinite(endpoint.timeoutMs) ? endpoint.timeoutMs : options.timeoutMs
    const payload = await fetchWebSocketPayload(endpoint, {
      timeoutMs: Math.min(timeoutMs, options.timeoutMs),
      maxBytes: MAX_BODY_BYTES,
    })
    if (endpoint.statusOnly) {
      return {
        servers: [],
        statuses: normalizeStatusPayload(payload, endpoint, options.seasonId || undefined),
        directories: [],
      }
    }
    let servers = normalizeCommunityPayload(payload, endpoint, options.seasonId || undefined)
    if (options.seasonId) servers = servers.filter((server) => server.seasonId === options.seasonId)
    if (options.providerId) {
      servers = servers.filter(
        (server) => server.providerId === 'community' || server.providerId === options.providerId,
      )
    }
    return { servers, statuses: [], directories: [] }
  }

  const headers = {
    accept: endpoint.kind === 'awesome-ogfn' || endpoint.kind === 'fortnite-versions-directory'
      ? 'text/plain, text/markdown'
      : 'application/json',
    'user-agent': 'VAULTED-Launcher',
  }
  if (endpoint.auth === 'account' && options.token) headers.authorization = `Bearer ${options.token}`

  const response = await fetchWithTimeout(
    targetUrl(endpoint, options.seasonId, options.providerId),
    {
      method: 'GET',
      headers,
      cache: 'no-store',
    },
    Math.min(Number.isFinite(endpoint.timeoutMs) ? endpoint.timeoutMs : options.timeoutMs, options.timeoutMs),
    options.fetchImpl,
  )
  if (!response.ok) {
    throw new Error(`Community directory answered ${response.status}.`)
  }

  const text = await response.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('Community directory returned an oversized response.')

  if (endpoint.kind === 'awesome-ogfn' || endpoint.kind === 'fortnite-versions-directory') {
    return { servers: [], statuses: [], directories: parseDirectoryPayload(text, endpoint) }
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Community directory returned invalid JSON.')
  }
  if (payload?.error) {
    throw new Error(safeString(payload.error, 120) || 'Community directory rejected the request.')
  }

  if (endpoint.statusOnly || endpoint.kind === 'eon-server-status') {
    return {
      servers: [],
      statuses: normalizeStatusPayload(payload, endpoint, options.seasonId || undefined),
      directories: [],
    }
  }

  let servers = normalizeCommunityPayload(payload, endpoint, options.seasonId || undefined)
  if (options.seasonId) servers = servers.filter((server) => server.seasonId === options.seasonId)
  if (options.providerId) {
    servers = servers.filter((server) => providerMatches(server.providerId, options.providerId))
  }
  return { servers, statuses: [], directories: [] }
}

function communityPlayerCount(server) {
  if (typeof server?.players === 'number' && Number.isFinite(server.players) && server.players > 0) {
    return Math.floor(server.players)
  }
  // A directory row without a real count contributes nothing. The old
  // host placeholder made an empty server look like one live player.
  return 0
}

function updatedAtMs(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function compareCommunityServers(left, right) {
  const players = communityPlayerCount(right) - communityPlayerCount(left)
  if (players !== 0) return players
  const leftPing = Number.isFinite(left?.pingMs) ? left.pingMs : Number.POSITIVE_INFINITY
  const rightPing = Number.isFinite(right?.pingMs) ? right.pingMs : Number.POSITIVE_INFINITY
  if (leftPing !== rightPing) return leftPing - rightPing
  return updatedAtMs(right?.updated) - updatedAtMs(left?.updated)
}

/**
 * One player-server address is one lobby, no matter how many directories list it.
 * Keep the healthiest metadata from every duplicate instead of showing the same
 * host+port twice under two provider names or seasons.
 */
function mergeCommunityServers(servers) {
  const byAddress = new Map()
  for (const server of Array.isArray(servers) ? servers : []) {
    const address = safeString(server?.address, 255).toLowerCase()
    if (!address) continue
    const existing = byAddress.get(address)
    if (!existing) {
      byAddress.set(address, { ...server })
      continue
    }

    const preferred = compareCommunityServers(server, existing) < 0 ? server : existing
    const other = preferred === server ? existing : server
    const merged = { ...other, ...preferred }
    const playerCounts = [server.players, existing.players].filter(
      (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
    )
    merged.players = playerCounts.length > 0 ? Math.max(...playerCounts) : undefined
    merged.playersKnown = Boolean(server.playersKnown || existing.playersKnown)
    merged.maxPlayers = Math.max(server.maxPlayers || 0, existing.maxPlayers || 0) || undefined
    const pings = [server.pingMs, existing.pingMs].filter((value) => Number.isFinite(value))
    merged.pingMs = pings.length > 0 ? Math.min(...pings) : undefined
    const updated = [server.updated, existing.updated]
      .map((value) => updatedAtMs(value))
      .filter((value) => value > 0)
    if (updated.length > 0) merged.updated = new Date(Math.max(...updated)).toISOString()
    byAddress.set(address, merged)
  }
  return [...byAddress.values()]
}

function probePing(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const started = process.hrtime.bigint()
    let timer
    let socket
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        /* already closed */
      }
      resolve(value)
    }

    try {
      socket = net.connect({ host, port })
    } catch {
      resolve(undefined)
      return
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000
      finish(Math.max(0, Math.round(elapsed)))
    })
    socket.once('timeout', () => finish(undefined))
    socket.once('error', () => finish(undefined))
    timer = setTimeout(() => finish(undefined), timeoutMs + 50)
  })
}

async function rankCommunityServers(servers, options = {}) {
  const merged = mergeCommunityServers(servers)
  if (options.probePing !== false) {
    const timeoutMs = Math.min(5000, Math.max(100, safeNumber(options.pingTimeoutMs, DEFAULT_PING_TIMEOUT_MS)))
    await Promise.all(
      merged.map(async (server) => {
        if (Number.isFinite(server.pingMs) || !server.host || !server.port) return
        const pingMs = await probePing(server.host, server.port, timeoutMs)
        if (pingMs !== undefined) server.pingMs = pingMs
      }),
    )
  }
  return merged.sort(compareCommunityServers)
}

async function fetchCommunityServers(input = {}) {
  const token = safeString(input.token, 4096)
  const seasonId = safeSeasonId(input.seasonId)
  const providerId = safeString(input.providerId, 40)
  const config = readConfig()
  const now = Date.now()
  const endpoints = config.endpoints.filter(
    (endpoint) =>
      endpoint.enabled !== false &&
      (endpoint.auth !== 'account' || Boolean(token)) &&
      endpointMatches(endpoint, seasonId, providerId) &&
      (input.force === true || (endpointRetryAt.get(endpoint.id) ?? 0) <= now),
  )

  const settled = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const result = await fetchEndpoint(endpoint, {
          token,
          seasonId,
          providerId,
          timeoutMs: config.requestTimeoutMs,
          fetchImpl: input.fetchImpl,
        })
        endpointRetryAt.delete(endpoint.id)
        return result
      } catch (error) {
        const message =
          error?.name === 'AbortError'
            ? 'Community directory timed out.'
            : error instanceof Error
              ? error.message
              : 'Community directory was unreachable.'
        if (config.failureCooldownMs > 0) {
          endpointRetryAt.set(endpoint.id, Date.now() + config.failureCooldownMs)
        }
        return {
          servers: [],
          statuses: [],
          directories: [],
          error: { endpoint: endpoint.id, message },
        }
      }
    }),
  )

  const servers = []
  const statuses = []
  const directories = []
  const errors = []
  const statusSeen = new Set()
  const directorySeen = new Set()

  for (const result of settled) {
    if (result.error) errors.push(result.error)
    for (const server of result.servers) servers.push(server)
    for (const status of result.statuses) {
      if (seasonId && status.seasonId !== seasonId) continue
      if (providerId && !providerMatches(status.providerId, providerId)) continue
      const key = `${status.providerId}|${status.seasonId || 'all'}|${status.source}`
      if (statusSeen.has(key)) continue
      statusSeen.add(key)
      statuses.push(status)
    }
    for (const directory of result.directories) {
      if (seasonId && directory.seasonId !== seasonId) continue
      if (providerId && !providerMatches(directory.providerId, providerId)) continue
      const key = `${directory.providerId}|${directory.seasonId || 'all'}|${directory.name.toLowerCase()}`
      if (directorySeen.has(key)) continue
      directorySeen.add(key)
      directories.push(directory)
    }
  }

  const ranked = await rankCommunityServers(servers, {
    pingTimeoutMs: config.pingTimeoutMs,
    probePing: input.probePing,
  })

  return {
    servers: ranked.slice(0, config.maxServers),
    statuses,
    directories: dedupeDirectories(directories),
    errors,
    checkedAt: new Date().toISOString(),
  }
}

module.exports = {
  compareCommunityServers,
  fetchCommunityServers,
  mergeCommunityServers,
  normalizeCommunityPayload,
  normalizeHostPort,
  normalizeStatusPayload,
  parseAwesomeOgfn,
  parseFortniteVersions,
  probePing,
  providerMatches,
  rankCommunityServers,
  readConfig,
  seasonFromVersion,
}
