/**
 * AI bot spawning is disabled.
 *
 * The launcher still writes the `preferences.bots` block because the server
 * reads it through AutoHosting, but every value is now explicitly off/zero.
 * This also overwrites profiles saved by older launcher builds that enabled
 * auto-fill, so an old `auto_fill: true` cannot re-enable bots.
 */
const AUTO_FILL_MODE = 'auto_hosting_preferences'
const DEFAULT_TARGET_PLAYERS = 0
const DEFAULT_BOT_COUNT = 0
const DEFAULT_BOT_BATCH_SIZE = 0
const DEFAULT_BOT_BATCH_INTERVAL_MS = 0
const MAX_LOBBY_PLAYERS = 0

function botFillSupport(runtimeConfig) {
  const config = runtimeConfig && typeof runtimeConfig === 'object' ? runtimeConfig.botFill : null
  const enableKey = config && typeof config.enableKey === 'string' ? config.enableKey.trim() : ''
  const countKey =
    config && typeof config.countKey === 'string' && config.countKey.trim()
      ? config.countKey.trim()
      : 'count'
  const supported = Boolean(
    config &&
      config.supported === true &&
      config.mode === AUTO_FILL_MODE &&
      enableKey,
  )
  return {
    supported,
    mode: supported ? AUTO_FILL_MODE : typeof config?.mode === 'string' ? config.mode : 'disabled',
    enableKey: supported ? enableKey : '',
    countKey: supported ? countKey : '',
    manualCommand: typeof config?.manualCommand === 'string' ? config.manualCommand : '',
    reason: typeof config?.reason === 'string' ? config.reason : '',
  }
}

function botFillPreferences(existing) {
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  return {
    ...current,
    // Current runtime keys.
    auto_fill: false,
    count: 0,
    target_lobby_players: 0,
    max_lobby_players: 0,
    batch_size: 0,
    batch_interval_ms: 0,
    // Legacy launcher keys kept explicitly false for older profiles/tools.
    bEnableBots: false,
    botCount: 0,
    health: Number.isFinite(Number(current.health)) ? Number(current.health) : 100,
    shield: Number.isFinite(Number(current.shield)) ? Number(current.shield) : 100,
    use_custom_names:
      typeof current.use_custom_names === 'boolean' ? current.use_custom_names : false,
    name: typeof current.name === 'string' && current.name ? current.name : 'VAULTED Bot ',
  }
}

module.exports = {
  AUTO_FILL_MODE,
  DEFAULT_BOT_BATCH_INTERVAL_MS,
  DEFAULT_BOT_BATCH_SIZE,
  DEFAULT_BOT_COUNT,
  DEFAULT_TARGET_PLAYERS,
  MAX_LOBBY_PLAYERS,
  botFillPreferences,
  botFillSupport,
}
