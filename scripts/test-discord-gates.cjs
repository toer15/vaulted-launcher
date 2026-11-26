'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { providerCatalog, providerProfile } = require('../electron/onlineProviders.cjs')
const { inviteCode, verifyDiscordCommunity } = require('../electron/discordGate.cjs')
const { openDiscordInvite, safeDiscordInvite } = require('../electron/externalLinks.cjs')
const builds = require('../src/assets/builds.json')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const expected = {
  'rewind-official': 'ch4-s2',
  'omen-official': 'ch1-s3',
  'vynx-official': 'ch2-s1',
  'origins-official': 'ch3-s1',
  crystal: 'ch2-s5',
  arc: 'ch1-s4',
  eon: 'ch2-s7',
  hydro: 'ch2-s5',
  interloop: 'ch2-s2',
  'chapter-og': 'ch2-s2',
  evo: 'ch2-s2',
  venom: 'ch4-s4',
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

  // Step 1's Open Discord Server button hands the invite to the OS. Main only
  // ever opens a pinned Discord invite, never a local/loopback or foreign URL.
  for (const provider of catalog) {
    if (!provider.discordGate) continue
    assert.equal(
      safeDiscordInvite(provider.discordGate.inviteUrl),
      provider.discordGate.inviteUrl,
      `${provider.id} invite is not openable`,
    )
  }
  for (const rejected of [
    'http://discord.gg/omenmp',
    'https://127.0.0.1/invite/omenmp',
    'https://localhost/omenmp',
    'https://radminvpn.com/omenmp',
    'https://user:pass@discord.gg/omenmp',
    'https://evil.example/omenmp',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/cmd.exe',
    'https://discord.gg/',
  ]) {
    assert.equal(safeDiscordInvite(rejected), null, `${rejected} must not be openable`)
  }

  const opened = []
  const shell = { openExternal: async (url) => { opened.push(url) } }
  assert.deepEqual(await openDiscordInvite(gate.inviteUrl, { shell }), {
    opened: true,
    url: gate.inviteUrl,
  })
  assert.deepEqual(opened, [gate.inviteUrl])
  await assert.rejects(openDiscordInvite('http://discord.gg/omenmp', { shell }), /verified Discord invite/i)
  await assert.rejects(openDiscordInvite(gate.inviteUrl, {}), /cannot open links/i)
  assert.equal(opened.length, 1, 'a rejected invite must never reach the shell')

  // The modal's primary button must be the two-state flow, not a pre-emptive
  // "I've Joined" verification, and the open state has to survive a reopen.
  const modal = read('src/components/DiscordGateModal.tsx')
  assert.match(modal, /Open \$\{projectLabel\} Discord Server/, 'modal has no Open Discord Server label')
  assert.match(modal, /serverOpened\s*\?\s*'Verify'/, 'modal has no Verify state')
  assert.doesNotMatch(modal, /I've Joined — Verify Community/, 'modal still verifies before the player joins')
  assert.match(modal, /markDiscordGateOpened\(gate\)/, 'opening the server is not remembered')
  assert.match(modal, /hasDiscordGateBeenOpened\(gate\)/, 'reopened modal does not restore Verify')
  assert.match(modal, /onClick=\{onCopyInvite\}|onCopyInvite/, 'copyable invite fallback was removed')
  assert.match(read('electron/main.cjs'), /arc:open-discord-invite/, 'no IPC to open the invite')
  assert.match(read('src/lib/discordGates.ts'), /vaulted\.discordGateOpened\.v1/)

  console.log(
    'Discord gate checks passed: every community invite, guild identity, two-state Open/Verify button, and invite link safety',
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})