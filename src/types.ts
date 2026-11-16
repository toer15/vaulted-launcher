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
}

/** A live global OGFN backend configured in resources/providers/provider.json. */
export interface GlobalBackend extends OnlineProviderConfig {
  backendUrl: string
  website?: string
  signInUrl?: string
  auth: 'none' | 'exchangeCode' | 'oauth'
  /** global_live means VAULTED signs in and fetches game codes natively */
  mode?: 'download' | 'global_live'
  global: boolean
  supportedSeasons: string[]
}

export interface ProviderAuthStatus {
  providerId: string
  signedIn: boolean
  displayName?: string | null
  avatarUrl?: string | null
  accountId?: string | null
  expiresAt?: number | null
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
  /** launcher/provider label inherited from the global profile settings */
  providerLabel?: string
  /** bundled provider that hosts this season directly */
  onlineProvider?: OnlineProviderConfig
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
  phase: 'downloading' | 'verifying' | 'extracting' | 'paused'
  /** bytes kept from an interrupted download, when paused */
  received?: number
  total?: number
  /** exact source of the interrupted download, so Continue does not depend on the manifest */
  url?: string
  fallbackUrl?: string
  sha256?: string | null
}

export interface ToastMessage {
  id: string
  title: string
  description?: string
  tone: 'success' | 'info' | 'error'
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
