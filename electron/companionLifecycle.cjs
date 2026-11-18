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
 *   - after the game has actually been running and every
 *     FortniteClient-Win64-Shipping.exe process has exited.
 *
 * No idle timer may close it, and a launcher must never be skipped because the
 * game already reported itself as started. The regression suite
 * (scripts/test-season-regressions.cjs) locks this truth table.
 */
function shouldCloseCompanionLauncher({ gameRunning, sawGame, requestedStop = false }) {
  if (requestedStop === true) return true
  return sawGame === true && gameRunning !== true
}

module.exports = { shouldCloseCompanionLauncher }
