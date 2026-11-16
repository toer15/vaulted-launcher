'use strict'

/**
 * Detects whether a Fortnite client actually joined the requested host.
 *
 * The launcher's initial join launch resolves as soon as the client process is
 * running, so a host that disappears while the client is loading would
 * otherwise leave the UI "running" forever. This module is deliberately pure
 * except for the optional polling loop, which makes the decision logic easy to
 * simulate without starting Fortnite.
 */

const JOIN_SUCCESS = /LogNet:\s*Welcomed by server/i
const JOIN_FAILURE = /LogNet:\s*Connection failed; returning to Entry/i
const JOIN_BROWSE = /LogNet:\s*Browse:/i

function hasJoinAttempt(text, host) {
  if (!text || !host) return false
  if (!JOIN_BROWSE.test(text)) return false
  return text.includes(host)
}

/**
 * classifyJoinLog returns:
 *  - joined: the client received the server welcome
 *  - failed: the client tried the host and the connection failed
 *  - pending: still loading / waiting
 */
function classifyJoinLog(text, host) {
  const value = typeof text === 'string' ? text : ''
  if (JOIN_SUCCESS.test(value) && hasJoinAttempt(value, host)) return 'joined'
  if (hasJoinAttempt(value, host) && JOIN_FAILURE.test(value)) return 'failed'
  return 'pending'
}

/**
 * Decide the outcome for one watchdog tick. Keeping timeout evaluation here
 * lets the tests cover the exact condition the running app uses.
 */
function joinOutcome({ text, host, elapsedMs, timeoutMs }) {
  const state = classifyJoinLog(text, host)
  if (state !== 'pending') return state
  if (Number(elapsedMs) >= Number(timeoutMs)) return 'timeout'
  return 'pending'
}

/**
 * Creates a watchdog with a manually callable check() for simulations and a
 * start() helper that polls in the app.
 */
function createJoinWatchdog({
  host,
  startedAt = Date.now(),
  timeoutMs = 75_000,
  intervalMs = 1_000,
  readLog = () => '',
  isAlive = () => true,
  now = () => Date.now(),
  onFailed = () => {},
  onJoined = () => {},
}) {
  let stopped = false
  let timer = null
  let reported = false

  const stop = () => {
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const check = () => {
    if (stopped) return 'stopped'
    if (!isAlive()) {
      stop()
      return 'stopped'
    }

    let text = ''
    try {
      text = readLog()
    } catch {
      /* the log may not exist yet */
    }

    const elapsedMs = Math.max(0, now() - startedAt)
    const outcome = joinOutcome({ text, host, elapsedMs, timeoutMs })
    if (outcome === 'joined') {
      if (!reported) onJoined()
      stop()
      return 'joined'
    }
    if (outcome === 'failed' || outcome === 'timeout') {
      if (!reported) {
        reported = true
        onFailed(outcome === 'timeout' ? 'timeout' : 'connection-failed')
      }
      stop()
      return outcome
    }
    return 'pending'
  }

  const start = () => {
    if (stopped || timer) return
    // Check immediately: a fast failure can already be in the log.
    check()
    if (!stopped) {
      timer = setInterval(check, intervalMs)
      timer.unref?.()
    }
  }

  return { check, start, stop }
}

module.exports = { classifyJoinLog, joinOutcome, createJoinWatchdog }
