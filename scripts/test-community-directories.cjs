'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { WebSocketServer } = require('ws')
const { botFillPreferences } = require('../electron/botFill.cjs')
const {
  dedupeStatusesAgainstServers,
  fetchCommunityServers,
  mergeCommunityServers,
  normalizeCommunityPayload,
  normalizeStatusPayload,
  parseAwesomeOgfn,
  parseFortniteVersions,
  rankCommunityServers,
  seasonFromVersion,
} = require('../electron/communityServers.cjs')

function endpoint(overrides = {}) {
  return {
    id: 'test',
    label: 'Test Directory',
    kind: 'generic-server-list',
    enabled: true,
    statusOnly: false,
    timeoutMs: 3000,
    freshnessMs: 30000,
    providerIds: ['*'],
    seasonIds: ['*'],
    fields: {},
    seasonMap: {},
    providerMap: {},
    ...overrides,
  }
}

function testLobbyAndPlayerFields() {
  const generic = endpoint({
    fields: {
      address: 'endpoint.address',
      players: 'endpoint.players',
      maxPlayers: 'endpoint.capacity',
      build: 'build',
      updated: 'seen',
    },
    seasonMap: { '7.40': 'ch1-s7' },
  })
  const servers = normalizeCommunityPayload(
    {
      data: {
        servers: [
          {
            endpoint: { address: '203.0.113.20:7777', players: 12, capacity: 100 },
            build: '7.40',
            seen: '2026-11-16T12:00:00Z',
          },
          { endpoint: { address: '203.0.113.21' }, build: '7.40', password: 'secret' },
        ],
      },
    },
    generic,
    undefined,
  )
  assert.equal(servers.length, 1)
  assert.equal(servers[0].address, '203.0.113.20:7777')
  assert.equal(servers[0].seasonId, 'ch1-s7')
  assert.equal(servers[0].players, 12)
  assert.equal(servers[0].playersKnown, true)
  assert.equal(servers[0].maxPlayers, 100)
  assert.equal(servers[0].freshForMs, 30000)
}

function testStatusOnlyFields() {
  const eon = endpoint({
    id: 'eon',
    kind: 'eon-server-status',
    statusOnly: true,
    providerId: 'eon',
    providerLabel: 'Eon',
    providerIds: ['eon'],
    seasonIds: ['ch2-s7'],
    defaultSeasonId: 'ch2-s7',
    entriesPath: 'servers',
    fields: {
      players: 'Joined',
      maxPlayers: 'MaxPlayers',
      region: 'Region',
      online: 'Joinable',
    },
  })
  const statuses = normalizeStatusPayload(
    {
      servers: [
        { ServerName: 'EU-1', Region: 'EU', Joined: 42, MaxPlayers: 100, Joinable: true },
        { ServerName: 'EU-2', Region: 'EU', Joined: 3, MaxPlayers: 100, Joinable: true },
        { ServerName: 'EU-3', Region: 'EU', Joined: 99, MaxPlayers: 100, Joinable: false },
      ],
    },
    eon,
  )
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0].players, 45)
  assert.equal(statuses[0].maxPlayers, 200)
  assert.equal(statuses[0].servers, 2)
  assert.equal(normalizeCommunityPayload({ servers: [] }, eon).length, 0)
}

function testStatusServerDedupe() {
  const eon = endpoint({
    id: 'eon-server-status',
    kind: 'eon-server-status',
    statusOnly: true,
    alsoServers: true,
    providerId: 'eon',
    providerLabel: 'Eon',
    providerIds: ['eon'],
    seasonIds: ['ch2-s7'],
    defaultSeasonId: 'ch2-s7',
    entriesPath: 'servers',
    fields: {
      address: 'Ip',
      port: 'Port',
      players: 'Joined',
      maxPlayers: 'MaxPlayers',
      online: 'Joinable',
    },
  })
  const payload = {
    servers: [
      { ServerName: 'EU-1', Ip: '203.0.113.61', Port: 7777, Joined: 42, MaxPlayers: 100, Joinable: true },
      { ServerName: 'EU-2', Ip: '203.0.113.62', Port: 7777, Joined: 3, MaxPlayers: 100, Joinable: true },
      { ServerName: 'EU-3', Ip: '203.0.113.63', Port: 7777, Joined: 99, MaxPlayers: 100, Joinable: false },
      // A status-only row has population but no join address. Its players must
      // remain in the aggregate because no server row can represent them.
      { ServerName: 'status-only', Joined: 7, MaxPlayers: 100, Joinable: true },
    ],
  }
  const servers = normalizeCommunityPayload(payload, { ...eon, statusOnly: false })
  const statuses = normalizeStatusPayload(payload, eon)
  const deduped = dedupeStatusesAgainstServers(statuses, servers)

  assert.equal(servers.length, 2)
  assert.equal(servers.reduce((total, server) => total + server.players, 0), 45)
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].players, 7)
  assert.equal(deduped[0].servers, 1)
  assert.equal(deduped[0].maxPlayers, 100)
  // Joinable rows (45) plus the status-only residual (7) equals the directory
  // total (52), not 97 (the old status + server double count).
  assert.equal(
    servers.reduce((total, server) => total + server.players, 0) + deduped[0].players,
    52,
  )
}

function testMeteorSchema() {
  const meteor = endpoint({
    id: 'meteor',
    kind: 'generic-server-status',
    statusOnly: true,
    providerId: 'meteor',
    providerLabel: 'Meteor',
    providerIds: ['meteor'],
    seasonIds: ['ch1-s6'],
    defaultSeasonId: 'ch1-s6',
    entriesPath: ['servers', 'data.servers'],
    fields: {
      players: 'playerCount',
      maxPlayers: 'maxPlayers',
      region: 'region',
      playlist: 'playlist',
      online: 'status',
      updated: 'lastSeen',
    },
  })
  const statuses = normalizeStatusPayload(
    {
      count: 2,
      servers: [
        {
          serverId: 'eu-01',
          name: 'eu-01',
          status: 'in_game',
          region: 'EU',
          playlist: 'Playlist_DefaultDuo',
          playerCount: 37,
          maxPlayers: 100,
          lastSeen: Date.now(),
        },
        {
          serverId: 'nae-01',
          name: 'nae-01',
          status: 'available',
          region: 'NAE',
          playlist: 'Playlist_DefaultDuo',
          playerCount: 0,
          maxPlayers: 100,
          lastSeen: Date.now(),
        },
        {
          serverId: 'stale-01',
          name: 'stale-01',
          status: 'available',
          region: 'EU',
          playerCount: 999,
          maxPlayers: 100,
          lastSeen: Date.now() - 120_000,
        },
      ],
    },
    meteor,
  )
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0].providerId, 'meteor')
  assert.equal(statuses[0].players, 37)
  assert.equal(statuses[0].maxPlayers, 200)
  assert.equal(statuses[0].servers, 2)
  assert.equal(statuses[0].region, 'EU / NAE')
}

function testRebootSchema() {
  const browser = endpoint({
    id: 'reboot-browser',
    kind: 'reboot-server-browser',
    format: 'websocket',
    freshnessMs: 0,
    providerId: 'reboot',
    providerLabel: 'Reboot',
    providerIds: ['reboot'],
    seasonIds: ['*'],
    entriesPath: 'data',
    fields: { name: 'name', address: 'ip', build: 'version', updated: 'timestamp' },
  })
  const servers = normalizeCommunityPayload(
    {
      type: 'add',
      data: [
        {
          id: 'abc',
          name: 'Reboot lobby',
          ip: '198.51.100.7:7777',
          version: '17.50',
          timestamp: '2026-11-16T12:00:00Z',
        },
      ],
    },
    browser,
  )
  assert.equal(servers.length, 1)
  assert.equal(servers[0].seasonId, 'ch2-s7')
  assert.equal(servers[0].players, undefined)
  assert.equal(servers[0].playersKnown, false)
  assert.equal(servers[0].freshForMs, 0)
  assert.equal(servers[0].external, true)
}

function testBotFillPreferences() {
  const settings = botFillPreferences({
    health: 21,
    name: 'My Bot ',
    bEnableBots: true,
    botCount: 94,
    auto_fill: true,
    count: 94,
  })
  assert.equal(settings.bEnableBots, false)
  assert.equal(settings.botCount, 0)
  assert.equal(settings.auto_fill, false)
  assert.equal(settings.count, 0)
  assert.equal(settings.target_lobby_players, 0)
  assert.equal(settings.health, 21)
  assert.equal(settings.name, 'My Bot ')
  assert.equal(botFillPreferences({ health: 21 }).count, 0)
}

async function testAggregationAndRanking() {
  const now = new Date().toISOString()
  const merged = mergeCommunityServers([
    {
      address: '203.0.113.40:7777',
      players: 2,
      playersKnown: true,
      pingMs: 90,
      updated: now,
      seasonId: 'ch1-s1',
      source: 'a',
    },
    {
      address: '203.0.113.40:7777',
      players: 10,
      playersKnown: true,
      pingMs: 55,
      updated: now,
      seasonId: 'ch1-s2',
      source: 'b',
    },
    {
      address: '203.0.113.41:7777',
      players: 10,
      playersKnown: true,
      pingMs: 20,
      updated: now,
      seasonId: 'ch1-s3',
      source: 'c',
    },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged.find((item) => item.address === '203.0.113.40:7777').players, 10)
  assert.equal(merged.find((item) => item.address === '203.0.113.40:7777').pingMs, 55)

  const ranked = await rankCommunityServers(
    [
      { address: '203.0.113.50:7777', players: 3, playersKnown: true, pingMs: 12, updated: now },
      { address: '203.0.113.51:7777', players: 3, playersKnown: true, pingMs: 8, updated: now },
      { address: '203.0.113.52:7777', players: 18, playersKnown: true, pingMs: 180, updated: now },
    ],
    { probePing: false },
  )
  assert.deepEqual(
    ranked.map((item) => item.address),
    ['203.0.113.52:7777', '203.0.113.51:7777', '203.0.113.50:7777'],
  )
}

function testMarkdownDirectories() {
  const awesome = endpoint({
    kind: 'awesome-ogfn',
    providerMap: {
      Stellar: { id: 'stellar', label: 'Stellar' },
      Era: { id: 'era', label: 'Era' },
      Hydro: { id: 'hydro', label: 'Hydro' },
    },
  })
  const awesomeEntries = parseAwesomeOgfn(
    [
      '## Hosted Servers/Projects',
      '- [Stellar (Chapter 2, Season 2)](https://discord.gg/stellarfn)',
      '- [Era (Chapter 1, Season 8)](https://discord.gg/erafn)',
      '- [Hydro (Chapter 2, Season 5)](https://discord.gg/hydromp)',
      '## Self Hosted Servers/Projects',
      '- [Erbium (Universal, S3-S29)](https://github.com/plooshi/Erbium)',
    ].join('\n'),
    awesome,
  )
  assert.deepEqual(
    awesomeEntries.map((entry) => [entry.providerId, entry.seasonId]),
    [
      ['stellar', 'ch2-s2'],
      ['era', 'ch1-s8'],
      ['hydro', 'ch2-s5'],
    ],
  )

  const versions = endpoint({
    kind: 'fortnite-versions-directory',
    providerMap: {
      'Project Era': { id: 'era', label: 'Era' },
      EZFN: { id: 'ezfn', label: 'EZFN' },
    },
  })
  const versionEntries = parseFortniteVersions(
    [
      '## Multiplayer',
      '### Season 7',
      '| Project Name | Build | Download links | Additional Info |',
      '| Project Era | 7.20-CL-4727874 | Download | Most popular |',
      '| EZFN | 7.40-CL-5046157 | Download | LateGame |',
    ].join('\n'),
    versions,
  )
  assert.deepEqual(
    versionEntries.map((entry) => [entry.providerId, entry.seasonId, entry.build]),
    [
      ['era', 'ch1-s7', '7.20'],
      ['ezfn', 'ch1-s7', '7.40'],
    ],
  )
}

async function testLiveConfigPipeline() {
  let server
  const httpServer = http.createServer((request, response) => {
    if (request.url.startsWith('/lobbies')) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          servers: [
            {
              address: '203.0.113.50:7777',
              players: 9,
              maxPlayers: 50,
              season: 'ch2-s2',
              provider: 'ezfn',
              pingMs: 42,
              updated: new Date().toISOString(),
            },
          ],
        }),
      )
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const httpPort = httpServer.address().port

  const websocketServer = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => websocketServer.once('listening', resolve))
  websocketServer.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        type: 'add',
        data: [
          {
            id: 'ws-1',
            name: 'Reboot live lobby',
            ip: '198.51.100.22:7777',
            version: '14.40',
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    )
  })
  server = websocketServer.address().port

  const previous = process.env.VAULTED_COMMUNITY_ENDPOINTS
  process.env.VAULTED_COMMUNITY_ENDPOINTS = JSON.stringify([
    {
      id: 'http-fixture',
      label: 'HTTP fixture',
      kind: 'generic-server-list',
      url: `http://127.0.0.1:${httpPort}/lobbies`,
      providerIds: ['*'],
      seasonIds: ['*'],
      fields: {
        address: 'address',
        players: 'players',
        maxPlayers: 'maxPlayers',
        season: 'season',
        provider: 'provider',
        ping: 'pingMs',
        updated: 'updated',
      },
    },
    {
      id: 'ws-fixture',
      label: 'WS fixture',
      kind: 'reboot-server-browser',
      url: `ws://127.0.0.1:${server}`,
      format: 'websocket',
      freshnessMs: 0,
      providerId: 'reboot',
      providerIds: ['reboot'],
      seasonIds: ['*'],
      entriesPath: 'data',
      fields: { name: 'name', address: 'ip', build: 'version', updated: 'timestamp' },
    },
  ])

  try {
    const result = await fetchCommunityServers({ probePing: false })
    assert.equal(result.errors.length, 0)
    assert.equal(result.servers.length, 2)
    assert.equal(result.statuses.length, 0)
    assert.equal(result.directories.length, 0)
    const reboot = result.servers.find((item) => item.source === 'ws-fixture')
    assert.equal(reboot.seasonId, 'ch2-s4')
    assert.equal(reboot.freshForMs, 0)
    assert.equal(result.servers.find((item) => item.source === 'http-fixture').pingMs, 42)

    const filtered = await fetchCommunityServers({ seasonId: 'ch2-s2', probePing: false })
    assert.equal(filtered.servers.length, 1)
    assert.equal(filtered.servers[0].providerId, 'ezfn')
  } finally {
    if (previous === undefined) delete process.env.VAULTED_COMMUNITY_ENDPOINTS
    else process.env.VAULTED_COMMUNITY_ENDPOINTS = previous
    websocketServer.close()
    httpServer.close()
  }
}

async function main() {
  assert.equal(seasonFromVersion('1.10'), 'ch1-s1')
  assert.equal(seasonFromVersion('1.11'), 'ch1-s2')
  assert.equal(seasonFromVersion('7.20'), 'ch1-s7')
  assert.equal(seasonFromVersion('14.40'), 'ch2-s4')
  assert.equal(seasonFromVersion('17.50'), 'ch2-s7')
  assert.equal(seasonFromVersion('18.00'), 'ch2-s8')
  assert.equal(seasonFromVersion('19.01'), 'ch3-s1')
  assert.equal(seasonFromVersion('25.00'), 'ch4-s3')
  assert.equal(seasonFromVersion('27.00'), 'ch4-s5')
  assert.equal(seasonFromVersion('31.40'), 'ch5-s4')
  assert.equal(seasonFromVersion('32.00'), 'ch5-remix')
  assert.equal(seasonFromVersion('33.20'), 'ch6-s1')
  assert.equal(seasonFromVersion('35.30'), 'ch6-mini1')
  assert.equal(seasonFromVersion('36.00'), 'ch6-s3')
  assert.equal(seasonFromVersion('38.00'), 'ch6-mini2')
  assert.equal(seasonFromVersion('39.00'), 'ch7-s1')
  assert.equal(seasonFromVersion('43.00'), 'ch7-mini1')
  assert.equal(seasonFromVersion('++Fortnite+Release-14.60-CL-14184942'), 'ch2-s4')
  assert.equal(seasonFromVersion('++Fortnite+Release-25.30-CL-00000000'), 'ch4-s3')
  assert.equal(seasonFromVersion('++Fortnite+Release-43.00-CL-00000000'), 'ch7-mini1')
  assert.equal(seasonFromVersion('++Fortnite+Release-...'), null)

  const catalogue = require('../src/assets/builds.json').seasons
  for (const [seasonId, source] of Object.entries(catalogue)) {
    assert.equal(
      seasonFromVersion(source.buildVersion),
      seasonId,
      `${seasonId} build ${source.buildVersion} should map back to itself`,
    )
  }

  testLobbyAndPlayerFields()
  testStatusOnlyFields()
  testStatusServerDedupe()
  testMeteorSchema()
  testRebootSchema()
  testMarkdownDirectories()
  testBotFillPreferences()
  await testAggregationAndRanking()
  await testLiveConfigPipeline()
  console.log('community directory checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
