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
}

export type LaunchPhase = 'idle' | 'launching' | 'running' | 'error'

/** What the active card's primary button should do right now. */
export type BuildState = 'missing' | 'downloading' | 'ready' | 'launching' | 'running' | 'error'

export interface DownloadState {
  /** null while the server hasn't reported a content-length */
  percent: number | null
  /** estimated seconds left, or null while the rate is unknown */
  etaSeconds: number | null
  phase: 'downloading' | 'verifying' | 'extracting'
}

export interface ToastMessage {
  id: string
  title: string
  description?: string
  tone: 'success' | 'info' | 'error'
}

export type ShopItemType = 'outfit' | 'emote' | 'pickaxe' | 'glider' | 'backpack'
export type ShopRarity = 'uncommon' | 'rare' | 'epic' | 'legendary'

export interface ShopItem {
  id: string
  slug: string
  name: string
  type: ShopItemType
  rarity: ShopRarity
  price: number
  season: string
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
  progress: ShopProgress
}

export interface ShopDay {
  day: string
  featured: ShopItem[]
  daily: ShopItem[]
}
