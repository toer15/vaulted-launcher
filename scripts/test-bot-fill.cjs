#!/usr/bin/env node
'use strict'

/**
 * Verifies that the runtime manifest, launcher helper and bundled server all
 * agree that AI bots are disabled. Every auto-fill value must be false/zero,
 * including legacy keys, so an old profile cannot re-enable spawning.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { botFillPreferences, botFillSupport } = require('../electron/botFill.cjs')

const root = path.join(__dirname, '..')
const runtimeConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'resources', 'providers', 'runtime.json'), 'utf8'),
)
const server = fs.readFileSync(path.join(root, 'runtime', 'VAULTED-Server.dll'))

assert.equal(runtimeConfig.botFill.supported, false)
assert.equal(runtimeConfig.botFill.count, 0)
assert.equal(runtimeConfig.botFill.targetLobbyPlayers, 0)
assert.equal(server.toString('utf8').includes('auto_fill'), true)
assert.equal(server.toString('utf16le').includes('AI bot spawning is disabled'), true)

const support = botFillSupport(runtimeConfig)
assert.equal(support.supported, false)

const enabled = botFillPreferences({
  health: 21,
  name: 'My Bot ',
  bEnableBots: true,
  botCount: 94,
  auto_fill: true,
  count: 94,
})
assert.equal(enabled.auto_fill, false)
assert.equal(enabled.count, 0)
assert.equal(enabled.target_lobby_players, 0)
assert.equal(enabled.max_lobby_players, 0)
assert.equal(enabled.batch_size, 0)
assert.equal(enabled.batch_interval_ms, 0)
assert.equal(enabled.bEnableBots, false)
assert.equal(enabled.botCount, 0)
assert.equal(enabled.health, 21)
assert.equal(enabled.name, 'My Bot ')

console.log('bot-fill checks passed: every auto-fill value is disabled and zero')
