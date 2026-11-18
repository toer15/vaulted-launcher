export interface Accent {
  /** gradient start */
  from: string
  /** gradient end */
  to: string
  /** glow colour used for bloom + borders */
  glow: string
}

export interface SeasonInfo {
  chapter: number
  season: number
  /** "Chapter 1 Season 3" */
  label: string
  /** "CH1 · S3" */
  short: string
  /** flavour text for the hero card */
  era: string
  accent: Accent
  /** false when the version could not be mapped */
  known: boolean
  /** bundled artwork key override (mini seasons, Fortnite OG) */
  artKey?: string
}

export interface OnlineProviderConfig {
  /** stable provider id used by the bundled provider profile */
  id: string
  /** full project name, e.g. Project Neo */
  name: string
  /** compact badge label, e.g. Neo */
  label: string
  /** signed in, but the provider's game-code handshake is not wired yet */
  launchHandshakePending?: boolean
}

/** Public community-presence fallback configured on a provider. */
export interface ProviderPopulationConfig {
  kind: 'discord'
  invite: string
  /** short label shown beside the sampled count, e.g. "Discord" */
  label: string
}

/** A community Discord that gates online access for one mapped provider. */
export interface DiscordGate {
  /** provider that owns this community invite */
  providerId: string
  /** display name of the community, e.g. Crystal Discord */
  label: string
  /** validated https invite opened by VAULTED */
  inviteUrl: string
  /** Discord guild id, when the invite is a server-discovery link */
  guildId?: string
  /** show the community badge without requiring a join before Play */
  statusOnly?: boolean
}

/** A locally remembered Discord unlock. The provider id is the stable key. */
export interface DiscordGateVerification {
  providerId: string
  guildId?: string
  guildName?: string
  memberCount?: number
  verifiedAt: number
}

/** A live health/population sample for one configured global backend. */
export interface ProviderLiveStatus {
  providerId: string
  online: boolean
  /** players reported by the backend itself or the community directory */
  players?: number
  /** public Discord presence, used only when the backend reports no players */
  communityPlayers?: number
  populationSource?: 'provider' | 'discord' | 'directory'
  populationLabel?: string
  /** Reachable backend count; never fabricated from a homepage response. */
  servers: number
  /** True only when the response reported a positive player or server count. */
  serverData?: boolean
  pingMs?: number
  /** why a down probe failed, or the reachable HTTP status */
  reason?: string
  checkedAt: string
}

/** Optional companion-launcher detection metadata for a Discord community. */
export interface ProviderLauncherConfig {
  label: string
  installedExecutables: string[]
  executableNames: string[]
  installRoots: string[]
  processName: string
}

/** A live global OGFN backend configured in resources/providers/provider.json. */
export interface GlobalBackend extends OnlineProviderConfig {
  backendUrl: string
  website?: string
  signInUrl?: string
  auth: 'none' | 'exchangeCode' | 'oauth' | 'deeplink' | 'embedded_web'
  /** this provider's session is established through Discord OAuth */
  discordAuth?: boolean
  /** global_live means VAULTED signs in and fetches game codes natively */
  mode?: 'download' | 'global_live' | 'external'
  /** external launchers are opened through their official launcher/site */
  external?: boolean
  /** signed companion launcher that must be installed before the season download */
  runtime?: { required: boolean; label: string }
  /** installed companion launcher detection for Discord-only communities */
  launcher?: ProviderLauncherConfig
  /** official launcher, or a Discord community for projects without a site */
  launchKind?: 'official' | 'discord'
  /** official launcher, download page, or Discord invite opened when external */
  launchUrl?: string
  /** signed in, but the provider's game-code handshake is not wired yet */
  launchHandshakePending?: boolean
  /** preferred health endpoint, resolved in main */
  statusUrl?: string
  /** public fallback population source when the health endpoint omits players */
  population?: ProviderPopulationConfig
  /** Discord community that must be joined before online play unlocks */
  discordGate?: DiscordGate
  global: boolean
  /** discover additional live seasons from the provider account at runtime */
  dynamicSeasons?: boolean
  supportedSeasons: string[]
  /** refreshed by the main-process health poll */
  live?: ProviderLiveStatus
}

export interface ProviderBuild {
  id: string
  name: string
  version: string
  seasonId: string
  sizeBytes?: number
}

export interface ProviderAuthStatus {
  providerId: string
  signedIn: boolean
  displayName?: string | null
  avatarUrl?: string | null
  accountId?: string | null
  expiresAt?: number | null
  /** Account-wide Era/Discord verification was accepted and stored. */
  verificationCompleted?: boolean
}

export interface Build {
  id: string
  /** parsed version, e.g. "3.6" */
  version: string
  /** original folder name, kept for display + debugging */
  folderName: string
  /** folder the user added */
  path: string
  /** resolved client executable inside the build */
  executable: string
  /** distinct profile key for a second card on the same season, e.g. 14.60 */
  profileKey?: string
  /** launcher/provider label inherited from the global profile settings */
  providerLabel?: string
  /** bundled provider that hosts this season directly */
  onlineProvider?: OnlineProviderConfig
  /** every provider that can host this season; primary is onlineProvider */
  onlineProviders?: OnlineProviderConfig[]
  /** Discord-gated communities mapped to this season */
  discordGates?: DiscordGate[]
  /** historical build kept for archive use; Play must stay disabled */
  archived?: boolean
  season: SeasonInfo
  addedAt: number
  /** true until a real build folder is linked or downloaded */
  placeholder?: boolean
}

export interface Account {
  username: string
  initials: string
  outfit: string
  level: number
  cosmetics: number
  /** provider avatar, shown in the top-right pill after a native sign-in */
  avatarUrl?: string | null
  /** e.g. Era, when this identity comes from a live provider account */
  providerLabel?: string | null
  /** provider-backed session without a VAULTED relay account */
  providerOnly?: boolean
}

export type LaunchPhase = 'idle' | 'launching' | 'running' | 'error'

/** What the active card's primary button should do right now. */
export type BuildState = 'missing' | 'downloading' | 'paused' | 'ready' | 'launching' | 'running' | 'error'

export interface DownloadState {
  /** null while the server hasn't reported a content-length */
  percent: number | null
  /** estimated seconds left, or null while the rate is unknown */
  etaSeconds: number | null
  /** live transfer rate in bytes per second */
  speedBytesPerSecond?: number | null
  phase: 'downloading' | 'verifying' | 'extracting' | 'runtime' | 'paused'
  /** bytes kept from an interrupted download, when paused */
  received?: number
  total?: number
  /** exact source of the interrupted download, so Continue does not depend on the manifest */
  url?: string
  fallbackUrl?: string
  sha256?: string | null
  /** interrupted provider-manifest sync, resumed against the live build */
  providerBuild?: { providerId: string; seasonId: string; buildId?: string }
  /** this archive replaces an installed build that failed Era's file check */
  repair?: boolean
  /** after this download, launch through the provider exchange instead of a community server */
  launchAfter?: boolean
  forceProviderId?: string
  /** archive top-level folder to detect first, e.g. 6.21 */
  preferredFolder?: string
  /** exact version to attach to the downloaded client */
  buildVersion?: string
  /** provider build used for full-manifest archive validation */
  providerId?: string
  seasonId?: string
  buildId?: string
  validateProvider?: boolean
}

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastMessage {
  id: string
  title: string
  description?: string
  tone: 'success' | 'info' | 'error'
  /** Optional one-click action shown below the message. */
  action?: ToastAction
  /** Keep actionable errors visible longer than normal notifications. */
  ttlMs?: number
}

export type ShopItemType =
  | 'outfit'
  | 'backpack'
  | 'pickaxe'
  | 'glider'
  | 'emote'
  | 'wrap'
  | 'contrail'
  | 'spray'
  | 'emoji'
  | 'loadingscreen'
  | 'music'
  | 'toy'
  | 'pet'
  | 'petcarrier'
  | 'sidekick'
  | 'shoe'
  | 'aura'
  | 'banner'

export type ShopEquipped = Record<ShopItemType, string | null>

export type ShopRarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'
  | 'mythic'
  | 'marvel'
  | 'dc'
  | 'icon'
  | 'gaminglegends'
  | 'starwars'
  | 'shadow'
  | 'frozen'
  | 'lava'
  | 'slurp'
  | 'dark'

export interface ShopItem {
  id: string
  slug: string
  name: string
  type: ShopItemType
  rarity: ShopRarity
  price: number
  season: string
  /** remote cosmetic art; bundled classics use a local PNG instead */
  image?: string
  setName?: string
  series?: string
  description?: string
}

export interface ShopHoliday {
  id: string
  name: string
  tagline: string
  accent: string
  accentAlt: string
  soft: string
}

export interface ShopProgress {
  /** UTC day this progress belongs to */
  day: string
  /** season/chapter the player chose for today's challenges */
  buildId: string | null
  launches: number
  playSeconds: number
  claimed: string[]
}

export interface ShopState {
  version: 1
  vbucks: number
  owned: string[]
  /** the cosmetic active in each slot, shared by every chapter and season */
  equipped: ShopEquipped
  progress: ShopProgress
}

export interface BuildVerifyIssues {
  missing: string[]
  empty: string[]
  unreadable: string[]
  temp: string[]
  corrupt: string[]
  /** required VAULTED runtime files, e.g. the login injector */
  runtime: string[]
}

export interface BuildVerifyReport {
  managed: boolean
  running?: boolean
  verified: boolean
  files: number
  bytes: number
  paks: number
  issueCount: number
  issues: BuildVerifyIssues
  elapsedMs: number
}

export interface BuildExitInfo {
  id: string
  code: number | null
  signal: string | null
  durationMs: number
  /** true when VAULTED closed the client, so the exit is not a crash */
  expected: boolean
  reason: 'closed-by-app' | 'client-closed' | 'injector-failed'
  /** last useful Fortnite log lines after an unexpected close */
  log?: string
}

export interface ShopDay {
  day: string
  holiday: ShopHoliday | null
  featured: ShopItem[]
  daily: ShopItem[]
}
