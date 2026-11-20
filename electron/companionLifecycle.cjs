'use strict'

/**
 * The one lifecycle rule for every merged companion launcher.
 *
 * A companion launcher owns the provider's auth, session heartbeat and the
 * matchmaking bridge. It must stay alive for the whole time the game client is
 * open — including the minutes a client can spend booting, signing in or
 * loading the lobby. It is closed exactly once:
 *
 *   - immediately on an explicit Stop from VAULTED, or
 *   - after the game has actually been seen running and every
 *     FortniteClient-Win64-Shipping.exe process has been gone for
 *     EXIT_GRACE_MS without one coming back.
 *
 * Nothing else may close it. In particular:
 *
 *   - the launcher's own bootstrapper PID exiting is NOT a signal (most of these
 *     launchers are single-instance and forward to an already-running copy, or
 *     spawn the real process and exit at once);
 *   - a failed probe is NOT "the game exited" (tasklist can time out under load);
 *   - one missed poll is NOT "the game exited" (the client restarts itself
 *     around EAC/anti-cheat, and closing in that gap breaks skin saving and
 *     matchmaking for the rest of the session).
 *
 * The regression suite (scripts/test-season-regressions.cjs) locks this truth
 * table.
 */

/** The process the whole lifecycle is about: the game, never the launcher. */
const GAME_PROCESS_NAME = 'FortniteClient-Win64-Shipping.exe'

/** Poll cadence: three seconds, as required. */
const GAME_POLL_MS = 3_000

/**
 * How long the client must stay gone before the launcher is closed. Closing is
 * delayed, never advanced: a client that restarts itself inside this window
 * keeps its launcher.
 */
const EXIT_GRACE_MS = 20_000

/**
 * Single-observation form of the rule: given that the game is (or is not)
 * running right now and whether it has ever been seen running, is the launcher
 * allowed to close?
 */
function shouldCloseCompanionLauncher({ gameRunning, sawGame, requestedStop = false }) {
  if (requestedStop === true) return true
  return sawGame === true && gameRunning !== true
}

/** Fresh per-session memory for observeCompanionSession(). */
function createCompanionSessionState() {
  return { sawGame: false, absentSince: null }
}

/**
 * Advance one season's launcher session by one poll and decide whether the
 * companion launcher may be closed.
 *
 * observation:
 *   running       - a FortniteClient-Win64-Shipping.exe process (or the exact
 *                   client PID this launch reported) is alive right now
 *   probeOk       - the probe answered at all; false means "unknown", which
 *                   never closes anything
 *   requestedStop - the player pressed Stop
 *   now           - clock for the absence grace window
 *
 * Returns { close, reason, state } and never mutates the state it was given.
 */
function observeCompanionSession(state, observation = {}) {
  const now = Number.isFinite(observation.now) ? Number(observation.now) : Date.now()
  const next = {
    sawGame: state?.sawGame === true,
    absentSince: state?.absentSince ?? null,
  }

  if (observation.requestedStop === true) {
    return { close: true, reason: 'stop', state: next, absentMs: 0 }
  }
  if (observation.probeOk !== true) {
    // Unknown is not an exit: keep the launcher and keep counting nothing.
    return { close: false, reason: 'probe-failed', state: next, absentMs: 0 }
  }

  const gameRunning = observation.running === true
  if (gameRunning) {
    next.sawGame = true
    next.absentSince = null
    return { close: false, reason: 'running', state: next, absentMs: 0 }
  }

  // The client was never observed: the launcher is booting, retrying or waiting
  // on the player. It stays until the game has really run (or Stop).
  if (shouldCloseCompanionLauncher({ gameRunning: false, sawGame: next.sawGame }) !== true) {
    return { close: false, reason: 'not-started', state: next, absentMs: 0 }
  }

  if (next.absentSince === null) next.absentSince = now
  const absentMs = Math.max(0, now - next.absentSince)
  if (absentMs < EXIT_GRACE_MS) {
    return { close: false, reason: 'confirming-exit', state: next, absentMs }
  }
  return { close: true, reason: 'game-exited', state: next, absentMs }
}

module.exports = {
  EXIT_GRACE_MS,
  GAME_POLL_MS,
  GAME_PROCESS_NAME,
  createCompanionSessionState,
  observeCompanionSession,
  shouldCloseCompanionLauncher,
}
