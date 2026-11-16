import { artKeyFor } from './art'
import { lobbyIsFresh, lobbyPlayers, type LobbyInfo } from './friends'
import type { CommunityDirectoryEntry, CommunityProviderStatus, CommunityServer } from './network'
import type { Build, GlobalBackend } from '../types'

export type PlayModeLabel = 'ONLINE READY' | 'ONLINE PLAY'

export interface SeasonPlayMode {
  online: boolean
  label: PlayModeLabel
  /** joinable live servers included in playerCount */
  lobbyCount: number
  playerCount: number
  /** status-only provider servers included in communityPlayerCount */
  communityServerCount?: number
  /** community provider pre-mapped in builds.json, e.g. EZFN */
  providerLabel?: string
  /** players reported by an external directory that has no joinable address */
  communityPlayerCount?: number
  communityProviderLabel?: string
  /** external directories that list this season */
  directoryProviders?: string[]
  /** a live global OGFN backend accepts players for this season */
  globalOnline?: boolean
  /** compact label(s) for the global backend(s), e.g. "Era / Stellar" */
  globalProviderLabel?: string
}

/** Shared neutral state so every one of the 43 cards renders an online badge. */
export const DEFAULT_PLAY_MODE: SeasonPlayMode = {
  online: false,
  label: 'ONLINE READY',
  lobbyCount: 0,
  playerCount: 0,
}

/**
 * The real-time total for one season: every joinable live server plus every
 * status-only provider server. Both sources describe different servers, so
 * they are summed. Launcher presence heartbeats are deliberately excluded:
 * the badge reports players on live servers, never this PC or a fallback 1.
 */
export function onlinePlayerCount(mode: SeasonPlayMode | null | undefined): number {
  const joinable = typeof mode?.playerCount === 'number' && Number.isFinite(mode.playerCount) ? mode.playerCount : 0
  const statusOnly =
    typeof mode?.communityPlayerCount === 'number' && Number.isFinite(mode.communityPlayerCount)
      ? mode.communityPlayerCount
      : 0
  return Math.max(0, Math.floor(joinable + statusOnly))
}

/** Total live external servers counted in the same season total. */
export function seasonServerCount(mode: SeasonPlayMode | null | undefined): number {
  const joinable = typeof mode?.lobbyCount === 'number' && Number.isFinite(mode.lobbyCount) ? mode.lobbyCount : 0
  const statusOnly =
    typeof mode?.communityServerCount === 'number' && Number.isFinite(mode.communityServerCount)
      ? mode.communityServerCount
      : 0
  return Math.max(0, Math.floor(joinable + statusOnly))
}

export function onlineStatusLabel(players: number, servers = 0): string {
  const total = Math.max(0, Math.floor(players))
  if (total <= 0) {
    return servers > 0 ? `ONLINE · 0 PLAYING · ${servers} server${servers === 1 ? '' : 's'}` : 'ONLINE READY'
  }
  const serverText =
    servers > 0 ? ` · ${servers} server${servers === 1 ? '' : 's'}` : ''
  return `ONLINE · ${total} playing${serverText}`
}

/** Human label for a directory season id, used to describe fallback targets. */
export function seasonLabelForId(value: string | null | undefined): string {
  const raw = String(value || '').trim()
  const match = /^ch(\d{1,2})-s(\d{1,2})$/i.exec(raw)
  return match ? `Chapter ${Number(match[1])} · Season ${Number(match[2])}` : raw || 'another season'
}

export interface HostedLobbyInfo {
  address: string
  port: number
  buildId: string
  label: string
  public: boolean
  seasonId?: string | null
  /** live players currently connected, including bots */
  players?: number
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

function lobbyPing(lobby: LobbyInfo): number {
  return typeof lobby.pingMs === 'number' && Number.isFinite(lobby.pingMs) && lobby.pingMs >= 0
    ? lobby.pingMs
    : Number.POSITIVE_INFINITY
}

/**
 * Discovery ranking is shared by the hero, the cards, and the fallback modal:
 * the fullest live lobby wins; equally full lobbies are ordered by the lowest
 * measured ping, then by the most recent heartbeat.
 */
export function compareLobbies(left: LobbyInfo, right: LobbyInfo): number {
  return (
    lobbyPlayers(right) - lobbyPlayers(left) ||
    lobbyPing(left) - lobbyPing(right) ||
    Date.parse(right.updated) - Date.parse(left.updated)
  )
}

export function rankLobbies(lobbies: LobbyInfo[]): LobbyInfo[] {
  return [...lobbies].sort(compareLobbies)
}

/**
 * Directory provider ids and manifest provider ids only differ by the EZFN
 * "hybrid" suffix. Treat them as the same community so a season's assigned
 * provider is never skipped because of a label mismatch.
 */
export function providerMatches(serverProviderId: string | undefined, buildProviderId: string | undefined): boolean {
  if (!buildProviderId) return true
  const candidate = String(serverProviderId || 'community').toLowerCase()
  if (!candidate || candidate === 'community') return true
  const target = buildProviderId.toLowerCase()
  return candidate === target || candidate.replace(/-hybrid$/, '') === target.replace(/-hybrid$/, '')
}

/** A public, fresh row with a real address can be joined directly. */
export function isLiveLobby(server: CommunityServer): boolean {
  return (
    server.public !== false &&
    Boolean(server.host) &&
    Number.isInteger(server.port) &&
    server.port > 0 &&
    lobbyIsFresh(server)
  )
}

/** Only directory rows may be used as a cross-season fallback. */
export function isLiveExternalServer(server: CommunityServer): boolean {
  return server.external === true && server.source !== 'manual' && isLiveLobby(server)
}

export type ExternalServerTier = 'exact' | 'provider' | 'external' | 'none'

export interface ExternalServerRoute {
  /** the live external server Play connects to, including a fallback target */
  server: CommunityServer | null
  /** the best live server that actually matches the selected season */
  exactServer: CommunityServer | null
  /** a different-season provider target used only when the season is empty */
  fallbackServer: CommunityServer | null
  /** why that server won: exact sub-patch, same provider, or any provider */
  tier: ExternalServerTier
  /** exact-season servers, best first, shown above the divider */
  exactOptions: CommunityServer[]
  /** every other live external server, shown below the divider */
  fallbackOptions: CommunityServer[]
  /** every selectable live external server: exact season first */
  options: CommunityServer[]
}

/**
 * The external-only router. It never returns a local address, so Play can only
 * ever connect to a server run by a community provider:
 *   1. highest-population live server reporting this exact season on the
 *      assigned provider, then on any provider;
 *   2. otherwise the highest-population live server on the assigned provider;
 *   3. otherwise the highest-population live external server anywhere.
 */
export function routeExternalServer(
  build: Build,
  servers: CommunityServer[],
): ExternalServerRoute {
  const seasonKey = artKeyFor(build.season)
  const providerId = build.onlineProvider?.id
  const allLive = rankLobbies((servers || []).filter(isLiveLobby)) as CommunityServer[]
  const live = allLive.filter(isLiveExternalServer)
  const providerServers = live.filter((server) => providerMatches(server.providerId, providerId))
  const exactProvider = seasonKey
    ? allLive.filter(
        (server) => server.seasonId === seasonKey && providerMatches(server.providerId, providerId),
      )
    : []
  const exactAnywhere = seasonKey ? allLive.filter((server) => server.seasonId === seasonKey) : []

  // Exact-season matches stay first (assigned provider, then any provider).
  // Every other live external server follows below a divider, so the dropdown
  // is never empty while a directory has an online server.
  const exactOptions: CommunityServer[] = []
  const seen = new Set<string>()
  for (const server of [...exactProvider, ...exactAnywhere]) {
    const key = server.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    exactOptions.push(server)
  }
  const exactAddresses = new Set(exactOptions.map((server) => server.address.toLowerCase()))
  const fallbackOptions = [
    ...providerServers.filter((server) => !exactAddresses.has(server.address.toLowerCase())),
    ...live.filter(
      (server) =>
        !exactAddresses.has(server.address.toLowerCase()) &&
        !providerMatches(server.providerId, providerId),
    ),
  ]
  const options = [...exactOptions, ...fallbackOptions]

  const exactServer = exactProvider[0] ?? exactAnywhere[0] ?? null
  const fallbackServer = exactServer ? null : providerServers[0] ?? live[0] ?? null
  const server = exactServer ?? fallbackServer
  const tier: ExternalServerTier =
    exactServer
      ? 'exact'
      : providerServers.length > 0
        ? 'provider'
        : live.length > 0
          ? 'external'
          : 'none'
  return { server, exactServer, fallbackServer, tier, exactOptions, fallbackOptions, options }
}

/**
 * Directory rows and relay rows can describe the same host. Keep one row per
 * address while retaining the fullest count, lowest ping, and newest heartbeat.
 */
export function mergeLobbies(lobbies: LobbyInfo[]): LobbyInfo[] {
  const byAddress = new Map<string, LobbyInfo>()
  for (const lobby of lobbies) {
    const key = lobby.address.trim().toLowerCase()
    if (!key) continue
    const existing = byAddress.get(key)
    if (!existing) {
      byAddress.set(key, lobby)
      continue
    }
    const best = compareLobbies(lobby, existing) < 0 ? lobby : existing
    const other = best === lobby ? existing : lobby
    const players = [lobby.players, existing.players].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
    )
    const pings = [lobby.pingMs, existing.pingMs].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    )
    byAddress.set(key, {
      ...other,
      ...best,
      players: players.length > 0 ? Math.max(...players) : undefined,
      playersKnown: Boolean(lobby.playersKnown || existing.playersKnown),
      external: Boolean(lobby.external || existing.external),
      pingMs: pings.length > 0 ? Math.min(...pings) : undefined,
      updated: Date.parse(best.updated) >= Date.parse(other.updated) ? best.updated : other.updated,
    })
  }
  return rankLobbies([...byAddress.values()])
}

export interface ActiveServerChoice {
  build: Build
  /** the healthiest single lobby, used for the one-click join */
  lobby: LobbyInfo
  /** every live player across that season's lobbies */
  players: number
}

/**
 * Find an installed season that already has players when the selected season
 * is empty. A season is only offered when it has a joinable, fresh lobby, so
 * the fallback can never lead to a second dead end.
 */
export function findActiveServerChoice(
  builds: Build[],
  lobbies: LobbyInfo[],
  installed: Record<string, boolean>,
  excludeBuildId: string,
  lanIp: string | null,
  viewerUsername?: string | null,
): ActiveServerChoice | null {
  let best: ActiveServerChoice | null = null
  for (const build of builds) {
    if (build.id === excludeBuildId || !installed[build.id]) continue
    const matching = rankLobbies(
      lobbies.filter(
        (lobby) =>
          lobby.public &&
          lobbyIsFresh(lobby) &&
          lobbyIsReachable(lobby, lanIp) &&
          lobbyMatchesBuild(lobby, build) &&
          (!viewerUsername || lobby.username !== viewerUsername),
      ),
    )
    const lobby = matching[0]
    if (!lobby) continue
    const players = matching.reduce((total, candidate) => total + lobbyPlayers(candidate), 0)
    if (players <= 0) continue
    if (
      !best ||
      players > best.players ||
      (players === best.players && lobbyPlayers(lobby) > lobbyPlayers(best.lobby))
    ) {
      best = { build, lobby, players }
    }
  }
  return best
}

function addLobby(mode: SeasonPlayMode, players: number): SeasonPlayMode {
  const livePlayers = Math.max(0, Math.floor(players))
  return {
    ...mode,
    online: true,
    label: 'ONLINE PLAY',
    // A live listed lobby is a real server even when it is empty. Player totals
    // still use the reported count, while the server badge reflects the row.
    lobbyCount: mode.lobbyCount + 1,
    playerCount: mode.playerCount + livePlayers,
  }
}

/**
 * Pick the healthiest public lobby for a season before Play launches. The
 * selected address is handed to the bundled runtime's join target; the
 * renderer never invents a host or port.
 */
export function findBestPublicLobby(
  build: Build,
  lobbies: LobbyInfo[],
  lanIp: string | null,
  viewerUsername?: string | null,
): LobbyInfo | null {
  return (
    lobbies
      .filter(
        (lobby) =>
          lobby.public &&
          lobbyIsFresh(lobby) &&
          lobbyIsReachable(lobby, lanIp) &&
          lobbyMatchesBuild(lobby, build) &&
          (!viewerUsername || lobby.username !== viewerUsername),
      )
      .sort(compareLobbies)[0] ?? null
  )
}

/**
 * One source of truth for both the featured hero and every sidebar card.
 * Every build starts online-ready, then public, fresh, reachable lobbies are
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
  communityStatuses: CommunityProviderStatus[] = [],
  communityDirectories: CommunityDirectoryEntry[] = [],
  globalBackends: GlobalBackend[] = [],
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
      : DEFAULT_PLAY_MODE
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
    modes[build.id] = addLobby(modes[build.id] ?? DEFAULT_PLAY_MODE, lobbyPlayers(lobby))
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
        modes[build.id] = addLobby(
          modes[build.id] ?? DEFAULT_PLAY_MODE,
          Math.max(0, Math.floor(hostedLobby.players ?? 0)),
        )
      }
    }
  }

  // A configured global backend is a real live destination even when it does
  // not expose a public per-lobby player count. It is separate from the relay
  // and directory populations so the UI never invents a player number.
  for (const build of builds) {
    const seasonKey = artKeyFor(build.season)
    if (!seasonKey) continue
    const backends = globalBackends.filter(
      (backend) => backend.global && backend.supportedSeasons.includes(seasonKey),
    )
    if (backends.length > 0) {
      modes[build.id] = {
        ...(modes[build.id] ?? DEFAULT_PLAY_MODE),
        online: true,
        globalOnline: true,
        globalProviderLabel: backends.map((backend) => backend.label).join(' / '),
      }
    }
  }

  // A directory can publish live player counts for a provider without
  // publishing an IP. Keep those numbers separate from lobby counts so the UI
  // never implies there is an address to join.
  for (const build of builds) {
    const seasonKey = artKeyFor(build.season)
    if (!seasonKey) continue

    const statuses = communityStatuses.filter(
      (status) => status.seasonId === seasonKey && status.online !== false,
    )
    const statusPlayers = statuses.reduce((total, status) => total + (status.players ?? 0), 0)
    const statusServers = statuses.reduce((total, status) => total + Math.max(0, status.servers ?? 0), 0)
    const statusLabels = [...new Set(statuses.map((status) => status.providerLabel))]
    const directoryLabels = [
      ...new Set(
        communityDirectories
          .filter((entry) => entry.seasonId === seasonKey)
          .map((entry) => entry.providerLabel),
      ),
    ]

    if (statusServers > 0 || statusPlayers > 0 || directoryLabels.length > 0) {
      modes[build.id] = {
        ...(modes[build.id] ?? DEFAULT_PLAY_MODE),
        ...(statusServers > 0 || statusPlayers > 0
          ? {
              communityPlayerCount: statusPlayers,
              communityServerCount: statusServers,
              communityProviderLabel: statusLabels.join(' / '),
            }
          : {}),
        ...(directoryLabels.length > 0 ? { directoryProviders: directoryLabels } : {}),
      }
    }
  }

  return modes
}
