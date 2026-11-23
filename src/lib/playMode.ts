import { artKeyFor } from './art'
import { lobbyIsFresh, lobbyPlayers, type LobbyInfo } from './friends'
import { isBannedOnlineProvider } from './onlinePolicy'
import type { CommunityDirectoryEntry, CommunityProviderStatus, CommunityServer } from './network'
import type { Build, GlobalBackend, ProviderLiveStatus } from '../types'

export type PlayModeLabel =
  | 'ONLINE'
  | 'SERVER CHECKING'
  | 'SERVER DOWN'
  | 'READY'
  | 'LAUNCHER'
  | 'ONLINE UNAVAILABLE'
  | 'OFFLINE'
  | 'ARCHIVED'

/** Shown on cards whose season has no online route yet. */
export const ONLINE_UNAVAILABLE_LABEL = 'ONLINE UNAVAILABLE'
/** Full explanation used by the big card and the small-card subtitle. */
export const ONLINE_UNAVAILABLE_MESSAGE =
  "Online play isn't available to enter yet. The app owner is working hard to get this season online."

/** How a season can actually be played today. */
export type SeasonAvailability = 'global' | 'launcher' | 'directory' | 'unsupported'

export interface SeasonPlayMode {
  online: boolean
  label: PlayModeLabel
  /** joinable live servers included in playerCount */
  lobbyCount: number
  playerCount: number
  /** provider servers not represented by joinable rows, included in totals */
  communityServerCount?: number
  /** community provider pre-mapped in builds.json, e.g. EZFN */
  providerLabel?: string
  /** directory population not represented by joinable rows */
  communityPlayerCount?: number
  /** players reported by the global backend health/population probe */
  backendPlayerCount?: number
  /** reachable global backend servers (at least one when online) */
  backendServerCount?: number
  communityProviderLabel?: string
  /** external directories that list this season */
  directoryProviders?: string[]
  /** a live global OGFN backend accepts players for this season */
  globalOnline?: boolean
  /** compact label(s) for the global backend(s), e.g. "Era / Stellar" */
  globalProviderLabel?: string
  /** no health sample yet for a supported global backend */
  globalChecking?: boolean
  /** every supported global backend has answered and is down */
  globalOffline?: boolean
  /** whether this season has a hosted backend, a bundled launcher, or no live route */
  availability?: SeasonAvailability
  /** a reachable external project hosts this season through its own launcher */
  externalAvailable?: boolean
  /** compact label for the reachable external project(s) */
  externalProviderLabel?: string
  /** Discord-gated online community (the card shows ONLINE · DISCORD) */
  discordOnline?: boolean
  /** archive-only card; never offers Play */
  archived?: boolean
}

/** Shared neutral state for a season with no live route. */
export const DEFAULT_PLAY_MODE: SeasonPlayMode = {
  online: false,
  label: ONLINE_UNAVAILABLE_LABEL,
  lobbyCount: 0,
  playerCount: 0,
  availability: 'unsupported',
}

/**
 * True only when this season has a route another player can actually join.
 * A local lobby, a launcher profile, or an unknown directory listing is not
 * online play and must not be presented as one.
 */
export function onlineIsAvailable(mode: SeasonPlayMode | null | undefined): boolean {
  if (!mode || mode.archived) return false
  return Boolean(mode.online || mode.globalOnline || mode.externalAvailable || mode.discordOnline)
}

/**
 * True for both card states that count as online: a live ONLINE server or an
 * ONLINE · DISCORD community. An external launcher link alone does not
 * qualify: those cards show only LAUNCHER and keep the red launcher badge and
 * a disabled download action.
 */
export function onlineIsLive(mode: SeasonPlayMode | null | undefined): boolean {
  return Boolean(
    mode && !mode.archived && (mode.online || mode.globalOnline || mode.discordOnline),
  )
}

/**
 * True when the player can actually enter this season: a live online backend,
 * a live community server, or a real external project whose own launcher hosts
 * the season. A launcher-backed season keeps its LAUNCHER badge, but it is a
 * real online route and must unlock Download/Start exactly like a backend.
 */
export function onlineIsPlayable(mode: SeasonPlayMode | null | undefined): boolean {
  if (!mode || mode.archived) return false
  return onlineIsLive(mode) || mode.externalAvailable === true
}

/** True when the probe has finished and no online route was found. */
export function onlineIsUnavailable(mode: SeasonPlayMode | null | undefined): boolean {
  if (!mode || mode.archived || onlineIsAvailable(mode)) return false
  // A global backend that has not answered yet is still checking, not absent.
  if (mode.availability === 'global' && mode.globalOffline !== true) return false
  return true
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
  const backend =
    typeof mode?.backendPlayerCount === 'number' && Number.isFinite(mode.backendPlayerCount)
      ? mode.backendPlayerCount
      : 0
  return Math.max(0, Math.floor(joinable + statusOnly + backend))
}

/** Total live external servers counted in the same season total. */
export function seasonServerCount(mode: SeasonPlayMode | null | undefined): number {
  const joinable = typeof mode?.lobbyCount === 'number' && Number.isFinite(mode.lobbyCount) ? mode.lobbyCount : 0
  const statusOnly =
    typeof mode?.communityServerCount === 'number' && Number.isFinite(mode.communityServerCount)
      ? mode.communityServerCount
      : 0
  const backend =
    typeof mode?.backendServerCount === 'number' && Number.isFinite(mode.backendServerCount)
      ? mode.backendServerCount
      : 0
  return Math.max(0, Math.floor(joinable + statusOnly + backend))
}

export function onlineStatusLabel(players: number, servers = 0): string {
  const total = Math.max(0, Math.floor(players))
  if (total <= 0) {
    // An unreported population is not zero players. Keep the server signal
    // without turning a missing count into a fabricated 0.
    return servers > 0 ? `ONLINE · ${servers} server${servers === 1 ? '' : 's'}` : 'OFFLINE'
  }
  const serverText =
    servers > 0 ? ` · ${servers} server${servers === 1 ? '' : 's'}` : ''
  return `ONLINE · ${total} playing${serverText}`
}

/**
 * One label for the season badge. Only a reachable global backend or a live
 * relay/directory server may produce an online label; a bundled provider
 * profile alone is not evidence that the season is online.
 */
export function seasonStatusLabel(mode: SeasonPlayMode | null | undefined): string {
  if (mode?.archived) return 'ARCHIVED'
  if (mode?.globalOnline || mode?.online) {
    return onlineStatusLabel(onlinePlayerCount(mode), seasonServerCount(mode))
  }
  if (mode?.availability === 'global') {
    return mode.globalOffline ? ONLINE_UNAVAILABLE_LABEL : 'CHECKING'
  }
  if (mode?.availability === 'launcher') {
    return mode.externalAvailable || mode.discordOnline
      ? 'LAUNCHER'
      : ONLINE_UNAVAILABLE_LABEL
  }
  return ONLINE_UNAVAILABLE_LABEL
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

/** A loopback row belongs to this PC and is never a remote multiplayer target. */
export function isRemoteServer(server: Pick<CommunityServer, 'host'> | null | undefined): boolean {
  const host = String(server?.host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return Boolean(host) && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
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

/** Download-mode engines run on this PC and cannot be launched through a website. */
export function isLocalEngine(provider: Pick<GlobalBackend, 'global' | 'mode'>): boolean {
  return provider.global !== true || provider.mode === 'download'
}

/**
 * The badge and Play use one rule: any mapped engine whose probe is reachable
 * is routable. A missing population/server payload is not a reason to skip the
 * engine while the UI is already showing that season as ONLINE. A local
 * lobby-only engine never wins Auto over an exact live remote
 * server: its health probe only proves this PC can start a private lobby.
 */
export function providerCanAutoRoute(
  provider: GlobalBackend,
  live: ProviderLiveStatus | undefined,
  _exactServer?: CommunityServer | null,
): boolean {
  if (live?.online !== true) return false
  // VAULTED only routes seasons to online servers. A bundled local launcher
  // is never a fallback, even when its health probe responds on this PC.
  if (isLocalEngine(provider)) return false
  return true
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
  const providerIds = [
    build.onlineProvider?.id,
    ...(build.onlineProviders ?? []).map((provider) => provider.id),
  ].filter((id): id is string => Boolean(id) && !isBannedOnlineProvider(id))
  const matchesBuildProvider = (serverProviderId: string | undefined) =>
    providerIds.length === 0 || providerIds.some((id) => providerMatches(serverProviderId, id))
  const allLive = rankLobbies((servers || []).filter(isLiveLobby)) as CommunityServer[]
  const live = allLive.filter(isLiveExternalServer)
  const providerServers = live.filter((server) => matchesBuildProvider(server.providerId))
  const exactProvider = seasonKey
    ? allLive.filter(
        (server) => server.seasonId === seasonKey && matchesBuildProvider(server.providerId),
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
        !matchesBuildProvider(server.providerId),
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
    label: 'ONLINE',
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
  const globalBySeason = new Map<string, GlobalBackend[]>()
  const externalBySeason = new Map<string, GlobalBackend[]>()
  for (const backend of globalBackends) {
    // Local launchers are not global multiplayer backends. Their probe only
    // confirms the bundled private lobby can start, so it must not make a
    // season look globally ONLINE or become Auto's chosen server.
    if (backend.mode === 'external') {
      // External companion projects are real remote destinations, but they do
      // not expose joinable server APIs. Track them separately so the card can
      // say LAUNCHER without inventing a server count.
      if (backend.live?.online === true) {
        for (const seasonId of backend.supportedSeasons) {
          const current = externalBySeason.get(seasonId) ?? []
          current.push(backend)
          externalBySeason.set(seasonId, current)
        }
      }
      continue
    }
    if (isLocalEngine(backend)) continue
    // Every mapped engine contributes to the season's live badge and count.
    // Reachability is the only requirement; the probe already supplies one
    // server when a backend does not publish a player or server count.
    for (const seasonId of backend.supportedSeasons) {
      const current = globalBySeason.get(seasonId) ?? []
      current.push(backend)
      globalBySeason.set(seasonId, current)
    }
  }

  const modes: Record<string, SeasonPlayMode> = {}
  for (const build of builds) {
    // A bundled provider profile only describes where the build came from. It
    // is not a live server. Only a configured global backend or a live relay /
    // directory row can put a season online.
    const seasonKey = artKeyFor(build.season)
    const archived = build.archived === true
    const hasGlobal = !archived && Boolean(seasonKey && globalBySeason.has(seasonKey))
    const external = !archived && seasonKey ? externalBySeason.get(seasonKey) ?? [] : []
    const hasExternal = external.length > 0
    const configuredProviders = [
      build.onlineProvider,
      ...(build.onlineProviders ?? []),
    ].filter(
      (provider): provider is NonNullable<typeof provider> =>
        Boolean(provider?.id) && !isBannedOnlineProvider(provider?.id),
    )
    const hasProvider = configuredProviders.length > 0
    // A provider Discord gate is an online community route and produces the
    // card's ONLINE · DISCORD badge. It is online even when no relay/backend
    // health probe exists for the season.
    const hasDiscord = !archived && (build.discordGates?.length ?? 0) > 0
    const availability: SeasonAvailability = archived
      ? 'unsupported'
      : hasGlobal
        ? 'global'
        : hasExternal || hasDiscord || hasProvider
          ? 'launcher'
          : 'unsupported'
    modes[build.id] = {
      online: false,
      label: archived
        ? 'ARCHIVED'
        : hasGlobal
          ? 'SERVER CHECKING'
          : hasExternal || hasDiscord
            ? 'LAUNCHER'
            : ONLINE_UNAVAILABLE_LABEL,
      lobbyCount: 0,
      playerCount: 0,
      ...(hasProvider
        ? {
            providerLabel:
              configuredProviders[0]?.label || configuredProviders[0]?.name,
          }
        : {}),
      availability,
      ...(hasExternal
        ? {
            externalAvailable: true,
            externalProviderLabel: external.map((provider) => provider.label).join(' / '),
          }
        : {}),
      ...(hasDiscord ? { discordOnline: true } : {}),
      ...(archived ? { archived: true } : {}),
    }
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

  // A configured global backend is a real live destination only after its
  // health probe says it is online. A missing sample is "checking", never a
  // synthetic online state.
  for (const build of builds) {
    const seasonKey = artKeyFor(build.season)
    if (!seasonKey) continue
    const backends = globalBySeason.get(seasonKey) ?? []
    if (backends.length > 0) {
      const existing = modes[build.id] ?? DEFAULT_PLAY_MODE
      const known = backends.filter((backend) => backend.live)
      const onlineBackends = backends.filter((backend) => backend.live?.online === true)
      const globalOnline = onlineBackends.length > 0
      const globalOffline = known.length > 0 && onlineBackends.length === 0
      const discordRoute = existing.discordOnline === true && !globalOnline && !existing.online
      const backendPlayers = onlineBackends.reduce(
        (total, backend) => total + Math.max(0, Math.floor(backend.live?.players ?? 0)),
        0,
      )
      const backendServers = onlineBackends.reduce(
        (total, backend) => total + Math.max(1, Math.floor(backend.live?.servers ?? 1)),
        0,
      )
      modes[build.id] = {
        ...existing,
        online: existing.online || globalOnline,
        label: globalOnline
          ? 'ONLINE'
          : existing.online
            ? existing.label
            : discordRoute
              ? 'LAUNCHER'
              : globalOffline
                ? 'SERVER DOWN'
                : 'SERVER CHECKING',
        availability: discordRoute ? 'launcher' : 'global',
        globalOnline,
        globalChecking: known.length === 0,
        globalOffline,
        globalProviderLabel: backends.map((backend) => backend.label).join(' / '),
        ...(globalOnline
          ? { backendPlayerCount: backendPlayers, backendServerCount: backendServers }
          : {}),
      }
    }
  }

  // A directory can publish live player counts without a joinable address (or
  // a status API can include both). The main-process directory fetch removes
  // addresses already represented as joinable rows; keep the residual separate
  // so the UI never implies there is an address to join.
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
      const existing = modes[build.id] ?? DEFAULT_PLAY_MODE
      const hasLiveStatus = statusServers > 0 || statusPlayers > 0
      const availability =
        existing.availability === 'global' || existing.availability === 'launcher'
          ? existing.availability
          : directoryLabels.length > 0
            ? 'directory'
            : existing.availability
      modes[build.id] = {
        ...existing,
        ...(hasLiveStatus
          ? {
              online: true,
              label: existing.online ? existing.label : 'ONLINE',
              communityPlayerCount: statusPlayers,
              communityServerCount: statusServers,
              communityProviderLabel: statusLabels.join(' / '),
            }
          : {}),
        availability,
        ...(directoryLabels.length > 0 ? { directoryProviders: directoryLabels } : {}),
      }
    }
  }

  // An archived card must never become playable through a lobby, directory
  // row, or backend that happens to reuse the same season id.
  for (const build of builds) {
    if (build.archived === true) {
      modes[build.id] = { ...DEFAULT_PLAY_MODE, label: 'ARCHIVED', archived: true }
    }
  }

  return modes
}
