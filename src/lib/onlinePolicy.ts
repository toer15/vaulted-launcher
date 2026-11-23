/**
 * Providers that may never be used as a season's online route.
 *
 * Reboot Launcher always starts a bundled private local backend on 127.0.0.1.
 * That is not public matchmaking, even when Reboot joins a game server from
 * someone's server browser, so VAULTED refuses the whole launcher instead of
 * quietly starting a private lobby.
 */
export const BANNED_ONLINE_PROVIDER_IDS = ['reboot-official', 'reboot', 'echo'] as const

const BANNED_ONLINE_PROVIDERS = new Set<string>(BANNED_ONLINE_PROVIDER_IDS)

export function isBannedOnlineProvider(id: unknown): boolean {
  return typeof id === 'string' && BANNED_ONLINE_PROVIDERS.has(id.trim().toLowerCase())
}
