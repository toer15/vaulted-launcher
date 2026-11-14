import type { Accent, Build, SeasonInfo } from '../types'

interface SeasonEntry {
  chapter: number
  season: number
  /** display name for the season number, e.g. "X" or "OG" */
  name?: string
  era: string
  /** full label override (mini seasons / specials) */
  label?: string
  /** chip override (mini seasons / specials) */
  short?: string
  /** bundled art key override */
  artKey?: string
}

/**
 * Fortnite major version -> chapter/season.
 * Chapter 1 shipped 1.x through 10.x, Chapter 2 started at 11.x, and each
 * later chapter adds four versions. Mini seasons (Remix, Galactic Battle,
 * The Simpsons, Treasure Hunters, Fortnite OG) get their own version and label.
 * The minor/patch number (3.6, 12.41) is kept for display only.
 */
const SEASON_TABLE: Record<number, SeasonEntry> = {
  // ---------------------------------------------------------------- chapter 1
  1: { chapter: 1, season: 1, era: '2017 · where it all began' },
  2: { chapter: 1, season: 2, era: '2018 · tilted towers era' },
  3: { chapter: 1, season: 3, era: '2018 · meteors and lucky landing' },
  4: { chapter: 1, season: 4, era: '2018 · the superhero season' },
  5: { chapter: 1, season: 5, era: '2018 · rifts and the cube' },
  6: { chapter: 1, season: 6, era: '2018 · darkness rises' },
  7: { chapter: 1, season: 7, era: '2018 · winterfest, planes' },
  8: { chapter: 1, season: 8, era: '2019 · buried treasure' },
  9: { chapter: 1, season: 9, era: '2019 · the future is bright' },
  10: { chapter: 1, season: 10, name: 'X', era: '2019 · the end of chapter one' },

  // ---------------------------------------------------------------- chapter 2
  11: { chapter: 2, season: 1, era: '2019 · a whole new island' },
  12: { chapter: 2, season: 2, era: '2020 · top secret' },
  13: { chapter: 2, season: 3, era: '2020 · floods and sharks' },
  14: { chapter: 2, season: 4, era: '2020 · nexus war' },
  15: { chapter: 2, season: 5, era: '2020 · bounty hunters' },
  16: { chapter: 2, season: 6, era: '2021 · primal' },
  17: { chapter: 2, season: 7, era: '2021 · alien invasion' },
  18: { chapter: 2, season: 8, era: '2021 · the last reality' },

  // ---------------------------------------------------------------- chapter 3
  19: { chapter: 3, season: 1, era: '2021 · flipping the island' },
  20: { chapter: 3, season: 2, era: '2022 · resistance' },
  21: { chapter: 3, season: 3, era: '2022 · vibin' },
  22: { chapter: 3, season: 4, era: '2022 · paradise' },

  // ---------------------------------------------------------------- chapter 4
  23: { chapter: 4, season: 1, era: '2022 · a new beginning' },
  24: { chapter: 4, season: 2, era: '2023 · mega' },
  25: { chapter: 4, season: 3, era: '2023 · wilds' },
  26: { chapter: 4, season: 4, era: '2023 · last resort' },
  27: { chapter: 4, season: 5, label: 'Fortnite OG', short: 'CH4 · OG', artKey: 'ch4-s5', era: '2023 · back to chapter 1' },

  // ---------------------------------------------------------------- chapter 5
  28: { chapter: 5, season: 1, era: '2023 · underground' },
  29: { chapter: 5, season: 2, era: '2024 · myths and mortals' },
  30: { chapter: 5, season: 3, era: '2024 · wrecked' },
  31: { chapter: 5, season: 4, era: '2024 · absolute doom' },
  32: { chapter: 5, season: 5, label: 'Chapter 2 Remix', short: 'CH2 · REMIX', artKey: 'ch5-remix', era: '2024 · chapter 2, remixed' },

  // ---------------------------------------------------------------- chapter 6
  33: { chapter: 6, season: 1, era: '2024 · hunters' },
  34: { chapter: 6, season: 2, era: '2025 · lawless' },
  35: { chapter: 6, season: 9, label: 'Chapter 6 Mini Season 1', short: 'CH6 · MINI 1', artKey: 'ch6-mini1', era: '2025 · galactic battle' },
  36: { chapter: 6, season: 3, era: '2025 · super' },
  37: { chapter: 6, season: 4, era: '2025 · shock n awesome' },
  38: { chapter: 6, season: 10, label: 'Chapter 6 Mini Season 2', short: 'CH6 · MINI 2', artKey: 'ch6-mini2', era: '2025 · the simpsons' },

  // ---------------------------------------------------------------- chapter 7
  39: { chapter: 7, season: 1, era: '2025 · pacific break' },
  40: { chapter: 7, season: 2, era: '2026 · showdown' },
  41: { chapter: 7, season: 3, era: '2026 · runners' },
  42: { chapter: 7, season: 4, era: '2026 · override' },
  43: { chapter: 7, season: 11, label: 'Chapter 7 Mini Season 1', short: 'CH7 · MINI 1', artKey: 'ch7-mini1', era: '2026 · treasure hunters' },
}

const CHAPTER_ACCENTS: Record<number, Accent> = {
  1: { from: '#3b82f6', to: '#8b5cf6', glow: '#4f7cff' },
  2: { from: '#0ea5e9', to: '#14b8a6', glow: '#22d3ee' },
  3: { from: '#8b5cf6', to: '#6366f1', glow: '#a78bfa' },
  4: { from: '#f59e0b', to: '#ef4444', glow: '#fbbf24' },
  5: { from: '#f43f5e', to: '#8b5cf6', glow: '#fb7185' },
  6: { from: '#2dd4bf', to: '#6366f1', glow: '#2dd4bf' },
  7: { from: '#fb7185', to: '#f59e0b', glow: '#fb7185' },
}

const UNKNOWN_ACCENT: Accent = { from: '#64748b', to: '#334155', glow: '#94a3b8' }

/** Chapter colour pair, with a neutral fallback for seasons added later. */
export function accentForChapter(chapter: number): Accent {
  return CHAPTER_ACCENTS[chapter] ?? UNKNOWN_ACCENT
}

/** Every mapped season, oldest first — the library lists all of them. */
export interface SeasonCatalogueEntry {
  major: number
  season: SeasonInfo
}

export const SEASON_CATALOGUE: SeasonCatalogueEntry[] = Object.keys(SEASON_TABLE)
  .map(Number)
  .sort((a, b) => a - b)
  .map((major) => ({ major, season: seasonForMajor(major) }))

/** Matches 3.6, 12.41, 1.7.2 but never a run of digits like 15538114. */
const VERSION_PATTERN = /(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?(?!\d)/

export function seasonForMajor(major: number): SeasonInfo {
  const entry = SEASON_TABLE[major]
  if (!entry) {
    return {
      chapter: 0,
      season: 0,
      label: 'Unrecognised build',
      short: 'VERSION UNKNOWN',
      era: 'No chapter mapping for this version',
      accent: UNKNOWN_ACCENT,
      known: false,
    }
  }

  const seasonName = entry.name ?? String(entry.season)
  return {
    chapter: entry.chapter,
    season: entry.season,
    label: entry.label ?? `Chapter ${entry.chapter} Season ${seasonName}`,
    short: entry.short ?? `CH${entry.chapter} · S${seasonName}`,
    era: entry.era,
    accent: CHAPTER_ACCENTS[entry.chapter] ?? UNKNOWN_ACCENT,
    known: true,
    artKey: entry.artKey,
  }
}

/**
 * Pull a Fortnite version out of anything the user drops in: a folder path,
 * a folder name such as "3.6-CL-15538114", or "++Fortnite+Release-12.41".
 * Segments are scanned right-to-left because the build folder is usually the
 * deepest part of the path.
 */
export function extractVersion(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const segments = trimmed.split(/[\\/]+/).filter(Boolean).reverse()
  for (const segment of segments) {
    const match = segment.match(VERSION_PATTERN)
    if (!match) continue

    const major = Number(match[1])
    const minor = Number(match[2])
    if (major < 1 || major > 44 || minor < 0 || minor > 99) continue

    return `${major}.${minor}`
  }

  return null
}

export function folderNameOf(path: string): string {
  const normalised = path.replace(/[\\/]+$/, '')
  const parts = normalised.split(/[\\/]+/)
  return parts[parts.length - 1] || normalised
}

/** Windows client executable inside a build folder. */
export function executableFor(path: string): string {
  const base = path.replace(/[\\/]+$/, '')
  return `${base}\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe`
}

export function buildFromPath(path: string, id: string): Build {
  const folderName = folderNameOf(path)
  const version = extractVersion(path) ?? extractVersion(folderName) ?? 'unknown'
  const major = Number(version.split('.')[0])
  const season = Number.isFinite(major) ? seasonForMajor(major) : seasonForMajor(-1)

  return {
    id,
    version,
    folderName,
    path,
    executable: executableFor(path),
    season,
    addedAt: Date.now(),
  }
}
