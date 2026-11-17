'use strict'

const assert = require('node:assert/strict')
const { providerCatalog, providerProfile } = require('../electron/onlineProviders.cjs')
const { inviteCode, verifyDiscordCommunity } = require('../electron/discordGate.cjs')
const builds = require('../src/assets/builds.json')

const expected = {
  crystal: 'ch2-s5',
  arc: 'ch1-s4',
  eon: 'ch2-s7',
  hydro: 'ch2-s5',
  interloop: 'ch2-s2',
  echo: 'ch1-s3',
}

const catalog = providerCatalog()
const byId = new Map(catalog.map((provider) => [provider.id, provider]))
for (const [id, seasonId] of Object.entries(expected)) {
  const provider = byId.get(id)
  assert.ok(provider, `${id} is missing from the provider catalog`)
  assert.ok(provider.discordGate, `${id} has no Discord gate`)
  assert.equal(provider.discordGate.providerId, id)
  assert.match(provider.discordGate.inviteUrl, /^https:\/\/discord\.(?:gg|com)\//)
  assert.match(provider.discordGate.guildId || '', /^\d{17,20}$/, `${id} has no pinned Discord guild`)
  assert.ok(inviteCode(provider.discordGate.inviteUrl), `${id} invite is not openable`)
  assert.ok(provider.supportedSeasons.includes(seasonId), `${id} is not mapped to ${seasonId}`)

  const season = builds.seasons[seasonId]
  assert.ok(season, `${seasonId} is missing from builds.json`)
  const providers = [season.onlineProvider, ...(season.onlineProviders ?? [])].filter(Boolean)
  assert.ok(
    providers.some((entry) => entry.id === id),
    `${seasonId} does not list the ${id} Discord provider`,
  )
  // Discord is a gate/additional community, never the primary local engine.
  const primary = byId.get(season.onlineProvider?.id)
  assert.ok(primary, `${seasonId} has no primary provider`)
  assert.notEqual(primary.mode, 'external', `${seasonId} primary provider is external`)

  const profile = providerProfile(id)
  assert.equal(profile.discordGate?.providerId, id, `${id} profile lost its Discord gate`)
}

// Retrac's Discord is the official community badge, not a Play gate.
const retrac = byId.get('retrac-official')
assert.ok(retrac?.discordGate, 'Retrac has no official Discord badge')
assert.equal(retrac.discordGate.statusOnly, true, 'Retrac Discord must stay status-only')
assert.equal(retrac.discordGate.inviteUrl, 'https://discord.gg/retrac')
assert.equal(retrac.discordGate.guildId, '1175919536839610512')
assert.ok(retrac.supportedSeasons.includes('ch2-s4'), 'Retrac is not mapped to the merged 14.60 card')
assert.equal(retrac.statusUrl, 'https://retrac.site/api/status')
assert.deepEqual(retrac.population, { kind: 'discord', invite: 'retrac', label: 'Discord' })

assert.equal(inviteCode('http://discord.gg/unsafe'), '')
assert.equal(inviteCode('https://discord.com/invite/safe-code'), 'safe-code')

async function main() {
  const gate = byId.get('arc').discordGate
  const result = await verifyDiscordCommunity(gate, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        guild: { id: gate.guildId, name: 'ARC' },
        approximate_member_count: 1234,
      }),
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.guildId, gate.guildId)
  assert.equal(result.memberCount, 1234)

  await assert.rejects(
    verifyDiscordCommunity(gate, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          guild: { id: '999999999999999999', name: 'wrong server' },
          approximate_member_count: 1,
        }),
      }),
    }),
    /different server/i,
  )
  console.log('Discord gate checks passed: 6 community invites, season mappings, and guild identity')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})