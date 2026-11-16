import { artKeyFor } from './art'
import { lobbyIsFresh, lobbyPlayers, type LobbyInfo } from './friends'
import type { Build } from '../types'

export type PlayModeLabel = 'ONLINE PLAY' | 'LOCAL PLAY'

export interface SeasonPlayMode {
  online: boolean
  label: PlayModeLabel
  lobbyCount: number
  playerCount: number
  /** community provider pre-mapped in builds.json, e.g. EZFN */
  providerLabel?: string
}

/** Shared neutral state so every one of the 43 cards renders a mode badge. */
export const LOCAL_PLAY_MODE: SeasonPlayMode = {
  online: false,
  label: 'LOCAL PLAY',
  lobbyCount: 0,
  playerCount: 0,
}

export interface HostedLobbyInfo {
  address: string
  port: number
  buildId: string
  label: string
  public: boolean
  seasonId?: string | null
}

function lobbyHost(address: string): string {
  const value = String(address || '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
  const split = value.lastIndexOf(':')
  return (split > 0 ? value.slice(0, split) : value).replace(/^\[|\]$/g, '')
}

function privateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
}

/** Public lobbies work anywhere; a private address is only useful on this LAN. */
export function lobbyIsReachable(lobby: LobbyInfo, lanIp: string | null): boolean {
  if (lobby.public) return true
  const host = lobbyHost(lobby.address)
  if (!lanIp || !privateIpv4(host)) return false
  // Home routers overwhelmingly use a /24; do not send players to a different network.
  return host.split('.').slice(0, 3).join('.') === lanIp.split('.').slice(0, 3).join('.')
}

/** A lobby may identify the season by installed build id, manifest key, or label. */
export function lobbyMatchesBuild(lobby: LobbyInfo, build: Build): boolean {
  const seasonKey = artKeyFor(build.season)
  return (
    lobby.buildId === build.id ||
    Boolean(seasonKey && (lobby.buildId === seasonKey || lobby.seasonId === seasonKey)) ||
    lobby.label?.toLowerCase() === build.season.label.toLowerCase()
  )
}

function addLobby(mode: SeasonPlayMode, players: number): SeasonPlayMode {
  return {
    ...mode,
    online: true,
    label: 'ONLINE PLAY',
    lobbyCount: mode.lobbyCount + 1,
    playerCount: mode.playerCount + Math.max(1, players),
  }
}

/**
 * One source of truth for both the featured hero and every sidebar card.
 * Every build starts at LOCAL PLAY, then public, fresh, reachable lobbies are
 * folded in by installed build id, manifest season id, or season label. A
 * public lobby hosted by this PC counts too, but is deduplicated if the relay
 * echoes it back in the lobby feed.
 */
export function playModesForBuilds(
  builds: Build[],
  lobbies: LobbyInfo[],
  hostedLobby: HostedLobbyInfo | null | undefined,
  lanIp: string | null,
  viewerUsername?: string | null,
): Record<string, SeasonPlayMode> {
  const modes: Record<string, SeasonPlayMode> = {}
  for (const build of builds) {
    // A provider bundled in the manifest is authoritative: the season is online
    // even when no VAULTED relay lobby is listed. The provider is launched
    // directly, so no matchmaking URL is required.
    modes[build.id] = build.onlineProvider
      ? {
          online: true,
          label: 'ONLINE PLAY',
          lobbyCount: 0,
          playerCount: 0,
          providerLabel: build.onlineProvider.label || build.onlineProvider.name,
        }
      : LOCAL_PLAY_MODE
  }

  const hostedAddress = hostedLobby ? `${hostedLobby.address}:${hostedLobby.port}`.trim().toLowerCase() : null
  const seen = new Set<string>()
  for (const lobby of lobbies) {
    if (!lobby.public || !lobbyIsFresh(lobby) || !lobbyIsReachable(lobby, lanIp)) continue
    // Keep this PC's own live lobby, but ignore a stale relay entry after this
    // PC stops hosting. The explicit hosted entry below covers the live case
    // when the relay has not echoed the lobby yet.
    if (viewerUsername && lobby.username === viewerUsername) {
      if (!hostedLobby?.public || lobby.address.trim().toLowerCase() !== hostedAddress) continue
    }
    const build = builds.find((candidate) => lobbyMatchesBuild(lobby, candidate))
    if (!build) continue

    const key = `${build.id}|${lobby.address.trim().toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    modes[build.id] = addLobby(modes[build.id] ?? LOCAL_PLAY_MODE, lobbyPlayers(lobby))
  }

  if (hostedLobby?.public) {
    const seasonKey = hostedLobby.seasonId ?? null
    const build = builds.find(
      (candidate) =>
        candidate.id === hostedLobby.buildId ||
        Boolean(seasonKey && artKeyFor(candidate.season) === seasonKey) ||
        candidate.season.label.toLowerCase() === hostedLobby.label.toLowerCase(),
    )
    if (build) {
      const key = `${build.id}|${hostedAddress}`
      if (!seen.has(key)) {
        seen.add(key)
        modes[build.id] = addLobby(modes[build.id] ?? LOCAL_PLAY_MODE, 1)
      }
    }
  }

  return modes
}
