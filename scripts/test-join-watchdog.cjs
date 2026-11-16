'use strict'

const assert = require('node:assert/strict')
const {
  classifyJoinLog,
  joinOutcome,
  createJoinWatchdog,
} = require('../runtime/join-watchdog.cjs')

const host = '203.0.113.7'
const welcome = [
  `[2026.11.15-12.00.00:000][  0]LogNet: Browse: ${host}//Game/Maps/Frontend?EncryptionToken=test`,
  '[2026.11.15-12.00.01:000][  1]LogNet: Welcomed by server (Level: /Game/Athena/Maps/Athena_Terrain)',
].join('\n')

const failed = [
  `[2026.11.15-12.00.00:000][  0]LogNet: Browse: ${host}//Game/Maps/Frontend?EncryptionToken=test`,
  '[2026.11.15-12.00.08:000][  8]LogNet: Connection failed; returning to Entry',
].join('\n')

// A successful join is recognized even before the timeout.
assert.equal(classifyJoinLog(welcome, host), 'joined')
assert.equal(joinOutcome({ text: welcome, host, elapsedMs: 1_000, timeoutMs: 60_000 }), 'joined')
// A later disconnect after the welcome is a normal match close, not a failed
// join, so it must not cause a second local-host launch.
assert.equal(
  classifyJoinLog(`${welcome}\nLogNet: Connection failed; returning to Entry`, host),
  'joined',
)

// The failure line is only treated as this join's failure when the client
// actually browsed to that host; an unrelated network failure must not trigger
// a season relaunch.
assert.equal(classifyJoinLog(failed, host), 'failed')
assert.equal(joinOutcome({ text: failed, host, elapsedMs: 8_000, timeoutMs: 60_000 }), 'failed')
assert.equal(
  classifyJoinLog('LogNet: Connection failed; returning to Entry', host),
  'pending',
)
assert.equal(
  classifyJoinLog(failed, '198.51.100.9'),
  'pending',
)

// A client that never gets welcomed is treated as a failed join at the
// watchdog deadline.
assert.equal(joinOutcome({ text: '', host, elapsedMs: 59_999, timeoutMs: 60_000 }), 'pending')
assert.equal(joinOutcome({ text: '', host, elapsedMs: 60_000, timeoutMs: 60_000 }), 'timeout')

// Simulate the actual watcher: pending, then timeout, emitting exactly once.
let t = 0
const events = []
const watch = createJoinWatchdog({
  host,
  startedAt: 0,
  timeoutMs: 5_000,
  now: () => t,
  readLog: () => '',
  isAlive: () => true,
  onFailed: (reason) => events.push(reason),
})
assert.equal(watch.check(), 'pending')
t = 5_000
assert.equal(watch.check(), 'timeout')
assert.deepEqual(events, ['timeout'])
assert.equal(watch.check(), 'stopped')
assert.equal(events.length, 1)

// Simulate a connection failure: the watchdog reports it, and a simulated
// retry callback starts the selected season as a host exactly once.
const failureEvents = []
let hostedSeason = null
const failureWatch = createJoinWatchdog({
  host,
  startedAt: 0,
  timeoutMs: 60_000,
  now: () => 8_000,
  readLog: () => failed,
  isAlive: () => true,
  onFailed: (reason) => {
    failureEvents.push(reason)
    hostedSeason = 'Chapter 1 Season 2'
  },
})
assert.equal(failureWatch.check(), 'failed')
assert.deepEqual(failureEvents, ['connection-failed'])
assert.equal(hostedSeason, 'Chapter 1 Season 2')
assert.equal(failureWatch.check(), 'stopped')
assert.equal(hostedSeason, 'Chapter 1 Season 2')

const successEvents = []
const successWatch = createJoinWatchdog({
  host,
  startedAt: 0,
  timeoutMs: 60_000,
  now: () => 1_000,
  readLog: () => welcome,
  isAlive: () => true,
  onJoined: () => successEvents.push('joined'),
  onFailed: (reason) => successEvents.push(reason),
})
assert.equal(successWatch.check(), 'joined')
assert.equal(successWatch.check(), 'stopped')
assert.deepEqual(successEvents, ['joined'])

console.log('join watchdog simulation passed')
