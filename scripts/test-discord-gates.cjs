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
  // Discord is a gate/additional community, never a local engine. A season
  // with no managed backend may still list an external community as its
  // primary route (ch1-s4 after Neo's removal); that card only ever opens the
  // community's launcher and never starts a local lobby.
  const primary = byId.get(season.onlineProvider?.id)
  assert.ok(primary, `${seasonId} has no primary provider`)
  if (primary.mode === 'external') {
    assert.ok(
      providers.every((entry) => byId.get(entry.id)?.mode === 'external'),
      `${seasonId} mixes an external primary with a managed backend`,
    )
  }

  const profile = providerProfile(id)
  assert.equal(profile.discordGate?.providerId, id, `${id} profile lost its Discord gate`)
}

// Every Discord-only community must have a usable Step 1 gate, not just the
// six season mappings exercised above. This catches a new Discord season that
// is added to the catalogue without an invite or pinned guild.
for (const provider of catalog.filter((entry) => entry.external && entry.launchKind === 'discord')) {
  assert.ok(provider.discordGate, `${provider.id} has no Discord gate`)
  assert.notEqual(provider.discordGate.statusOnly, true, `${provider.id} gate is status-only`)
  assert.equal(provider.discordGate.providerId, provider.id)
  assert.ok(inviteCode(provider.discordGate.inviteUrl), `${provider.id} invite is not openable`)
  assert.match(provider.discordGate.guildId || '', /^\d{17,20}$/, `${provider.id} has no pinned Discord guild`)
  assert.ok(provider.launcher, `${provider.id} has no launcher detection metadata`)
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

  // discord.com can answer desktop clients with a Cloudflare 429. The public
  // legacy API host must still complete the same pinned-guild verification.
  const attempted = []
  const fallback = await verifyDiscordCommunity(gate, {
    fetchImpl: async (url) => {
      attempted.push(url)
      if (attempted.length === 1) {
        return { ok: false, status: 429, json: async () => ({ message: 'rate limited' }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ guild: { id: gate.guildId, name: 'ARC' } }),
      }
    },
  })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.guildId, gate.guildId)
  assert.ok(attempted.length >= 2, 'Discord API fallback was not attempted')
  assert.match(attempted[1], /^https:\/\/discordapp\.com\/api\/v9\/invites\//)

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