'use strict'

/**
 * Integration simulation for the real automatic-join fallback.
 *
 * The fallback coordinator and attempt tracker below are the production module
 * used by App.tsx. The deferred launch promises reproduce the ordering where a
 * post-launch join failure is detected while the original launch call is still
 * in flight, then that original call resolves after the fallback has started.
 */

import assert from 'node:assert/strict'
import watchdogModule from '../runtime/join-watchdog.cjs'
import { HostingStopQueue, LaunchAttemptTracker, runJoinFallback } from '../src/lib/joinFallback.ts'

const { createJoinWatchdog } = watchdogModule

const buildId = 'ch1-s4'
const selectedSeason = 'Chapter 1 Season 4'
const payload = {
  id: buildId,
  host: '203.0.113.7',
  port: 7777,
  reason: 'connection-failed',
}

// ---------------------------------------------------------------------------
// The initial join is still in flight when the watchdog reports the failure.
// The fallback claims the attempt, closes the failed client, and starts hosting.
// A duplicate failure during the close must not claim a second fallback.
// ---------------------------------------------------------------------------
{
  const attempts = new LaunchAttemptTracker()
  const order = []
  let closeCalls = 0
  let hostCalls = 0
  let hostedSeason = null
  let visibleState = 'initial-pending'

  let releaseClose
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve
  })
  let resolveInitial
  const initialLaunch = new Promise((resolve) => {
    resolveInitial = resolve
  })

  const initialToken = attempts.start(buildId, 'join')
  const initialCompletion = initialLaunch.then(() => {
    // This is the same production commitIfCurrent guard App uses around the
    // running-state update. If it is broken, visibleState is overwritten and
    // this simulation fails.
    const applied = attempts.commitIfCurrent(initialToken, () => {
      visibleState = 'initial-join-state'
    })
    return applied ? 'applied-join-state' : 'ignored-stale-launch'
  })

  const hooks = {
    closeFailedClient: async () => {
      closeCalls += 1
      order.push('close')
      await closeGate
    },
    prepareHost: async () => {
      order.push('prepare')
    },
    announce: () => {
      order.push('announce')
    },
    startHost: async () => {
      hostCalls += 1
      hostedSeason = selectedSeason
      attempts.start(buildId, 'host')
      visibleState = 'fallback-host-state'
      order.push('host')
    },
  }

  // The real runtime watchdog detects the failed join and invokes the real
  // fallback with the reason it reports. No detection or fallback logic is
  // duplicated in this test.
  let fallback = null
  const watch = createJoinWatchdog({
    host: payload.host,
    startedAt: 0,
    timeoutMs: 60_000,
    now: () => 8_000,
    readLog: () =>
      [
        `[2026.11.15-12.00.00:000][  0]LogNet: Browse: ${payload.host}//Game/Maps/Frontend?EncryptionToken=test`,
        '[2026.11.15-12.00.08:000][  8]LogNet: Connection failed; returning to Entry',
      ].join('\n'),
    isAlive: () => true,
    onFailed: (reason) => {
      fallback = runJoinFallback(attempts, { ...payload, reason }, hooks)
    },
  })
  assert.equal(watch.check(), 'failed')
  assert.ok(fallback)
  assert.equal(watch.check(), 'stopped')

  // The first call claims before awaiting close; a concurrent duplicate must
  // be rejected immediately.
  assert.equal(
    await runJoinFallback(attempts, payload, {
      closeFailedClient: async () => {
        closeCalls += 1
      },
      prepareHost: () => {},
      announce: () => {},
      startHost: async () => {
        hostCalls += 1
      },
    }),
    false,
  )

  // The original launch finishes after the fallback has already started, while
  // close() is still in progress. It must not restore join/run state.
  resolveInitial()
  assert.equal(await initialCompletion, 'ignored-stale-launch')
  assert.equal(visibleState, 'initial-pending')

  releaseClose()
  assert.equal(await fallback, true)
  assert.equal(closeCalls, 1)
  assert.equal(hostCalls, 1)
  assert.equal(hostedSeason, selectedSeason)
  assert.equal(visibleState, 'fallback-host-state')
  assert.deepEqual(order, ['close', 'prepare', 'announce', 'host'])

  // Even after the fallback has completed, a duplicate failure cannot close the
  // new host or start another one.
  assert.equal(
    await runJoinFallback(attempts, payload, {
      closeFailedClient: async () => {
        closeCalls += 1
      },
      prepareHost: () => {},
      announce: () => {},
      startHost: async () => {
        hostCalls += 1
      },
    }),
    false,
  )
  assert.equal(closeCalls, 1)
  assert.equal(hostCalls, 1)
}

// ---------------------------------------------------------------------------
// The stronger ordering: the initial launch resolves only after the fallback's
// host launch has already begun. The new host token makes that completion stale.
// ---------------------------------------------------------------------------
{
  const attempts = new LaunchAttemptTracker()
  let resolveInitial
  const initialLaunch = new Promise((resolve) => {
    resolveInitial = resolve
  })
  let visibleState = 'initial-pending'
  const initialToken = attempts.start(buildId, 'join')
  const initialCompletion = initialLaunch.then(() => {
    const applied = attempts.commitIfCurrent(initialToken, () => {
      visibleState = 'initial-join-state'
    })
    return applied ? 'applied-join-state' : 'ignored-stale-launch'
  })

  let hostCalls = 0
  const fallback = runJoinFallback(attempts, payload, {
    closeFailedClient: async () => {},
    prepareHost: () => {},
    announce: () => {},
    startHost: async () => {
      hostCalls += 1
      attempts.start(buildId, 'host')
      visibleState = 'fallback-host-state'
      resolveInitial()
    },
  })

  assert.equal(await fallback, true)
  assert.equal(await initialCompletion, 'ignored-stale-launch')
  assert.equal(visibleState, 'fallback-host-state')
  assert.equal(hostCalls, 1)
}

// ---------------------------------------------------------------------------
// A successful join queues a lobby stop. If the join-failed fallback claims
// that launch before the stop runs, the stop must be skipped. If the stop was
// already in flight, the fallback must wait for it before publishing its host.
// ---------------------------------------------------------------------------
{
  let currentToken = 1
  let stopCalls = 0
  let releaseStop
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve
  })
  const stops = new HostingStopQueue({
    stop: () => {
      stopCalls += 1
      return stopGate
    },
    isCurrent: (token) => token === currentToken,
  })

  const staleStop = stops.stopFor(1)
  currentToken = 2
  await staleStop
  assert.equal(stopCalls, 0, 'a stale join must not stop hosting')

  currentToken = 3
  const firstStop = stops.stopFor(3)
  const fallbackStop = stops.stopFor()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopCalls, 1, 'the first stop should be in flight')

  let fallbackStopDone = false
  fallbackStop.then(() => {
    fallbackStopDone = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fallbackStopDone, false, 'the fallback stop must wait for the first stop')

  releaseStop()
  await firstStop
  await fallbackStop
  assert.equal(stopCalls, 2)
  assert.equal(fallbackStopDone, true)
}

console.log('join fallback integration simulation passed')
