import defaultBuilds from '../assets/builds.json'
import { artKeyFor } from './art'
import { SEASON_CATALOGUE, accentForChapter, type SeasonCatalogueEntry } from './seasons'
import { uid } from './storage'
import type { Build, SeasonInfo } from '../types'

/** Where the downloader unpacks a season that isn't on disk yet. */
const PLACEHOLDER_ROOT = '%APPDATA%\\VAULTED Launcher\\builds'

/** An empty library slot for a season, pointed at the download folder. */
export function buildForSeason(
  season: SeasonInfo,
  version: string,
  key: string,
  id = uid(),
  profileKey?: string,
): Build {
  const path = `${PLACEHOLDER_ROOT}\\${key}`

  return {
    id,
    ...(profileKey ? { profileKey } : {}),
    version,
    folderName: 'Not downloaded',
    path,
    executable: `${path}\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe`,
    season,
    addedAt: Date.now(),
    placeholder: true,
  }
}

function catalogueBuild(entry: SeasonCatalogueEntry): Build {
  const key = artKeyFor(entry.season) ?? `ch${entry.season.chapter}-s${entry.season.season}`
  return buildForSeason(entry.season, '', key)
}

const seasonKey = (season: { chapter: number; season: number }) => `${season.chapter}:${season.season}`

const CATALOGUE_ORDER = new Map(
  SEASON_CATALOGUE.map((entry, index) => [`${entry.season.chapter}:${entry.season.season}`, index]),
)

const CATALOGUE_KEYS = new Set(
  SEASON_CATALOGUE.map((entry) => artKeyFor(entry.season) ?? `ch${entry.season.chapter}-s${entry.season.season}`),
)

interface ManifestSeasonSource {
  id?: string
  title?: string
  label?: string
  short?: string
  era?: string
  artKey?: string
  chapter?: number
  season?: number
  buildVersion?: string
  version?: string
}

/** Extra cards that deliberately share a catalogue season, e.g. 14.50 and 14.60. */
const EXTRA_MANIFEST_KEYS = Object.keys((defaultBuilds as { seasons: Record<string, unknown> }).seasons).filter(
  (key) => !CATALOGUE_KEYS.has(key),
)

function manifestExtraBuild(key: string): Build | null {
  const source = (defaultBuilds as { seasons: Record<string, ManifestSeasonSource> }).seasons[key]
  if (!source) return null
  const chapter = Number(source.chapter)
  const season = Number(source.season)
  if (!Number.isFinite(chapter) || !Number.isFinite(season) || chapter <= 0 || season <= 0) return null
  const info: SeasonInfo = {
    chapter,
    season,
    label: source.label || source.title || key,
    short: source.short ?? `CH${chapter} · S${season}`,
    era: source.era ?? 'Added from the build catalogue',
    accent: accentForChapter(chapter),
    known: true,
    artKey: source.artKey ?? `ch${chapter}-s${season}`,
  }
  return buildForSeason(info, source.buildVersion || source.version || '', key, key, key)
}

/** Every season in the game — Chapter 1 Season 1 through Chapter 7 Mini Season 1. */
export function seedBuilds(): Build[] {
  return [
    ...SEASON_CATALOGUE.map(catalogueBuild),
    ...EXTRA_MANIFEST_KEYS.map(manifestExtraBuild).filter((build): build is Build => Boolean(build)),
  ]
}

/** Release order, oldest chapter/season first. Seasons outside the table go last. */
export function sortBuilds(builds: Build[]): Build[] {
  return [...builds].sort((a, b) => {
    const left = a.season.known ? CATALOGUE_ORDER.get(seasonKey(a.season)) : undefined
    const right = b.season.known ? CATALOGUE_ORDER.get(seasonKey(b.season)) : undefined
    if (left != null && right != null) return left - right
    if (left != null) return -1
    if (right != null) return 1
    return a.addedAt - b.addedAt
  })
}

/**
 * The library is the 43-season catalogue. Keep one build per season, prefer a
 * real build over a placeholder, add any missing seasons, and drop duplicate
 * or unmapped folders that older scans left behind.
 */
export function ensureAllSeasons(builds: Build[]): Build[] {
  const bySeason = new Map<string, Build>()
  const extras = new Map<string, Build>()

  for (const build of builds) {
    if (!build.season?.known) continue
    if (EXTRA_MANIFEST_KEYS.includes(build.id)) {
      // Cards created before profileKey existed inherited the 14.50 profile.
      // Rebuild those once so the handoff card starts clean.
      const migrated = build.profileKey ? build : manifestExtraBuild(build.id)
      if (migrated) extras.set(build.id, migrated)
      continue
    }
    const key = seasonKey(build.season)
    if (!CATALOGUE_ORDER.has(key)) continue

    const existing = bySeason.get(key)
    if (!existing || (existing.placeholder && !build.placeholder)) {
      bySeason.set(key, build)
    }
  }

  return [
    ...SEASON_CATALOGUE.map((entry) => bySeason.get(seasonKey(entry.season)) ?? catalogueBuild(entry)),
    ...EXTRA_MANIFEST_KEYS.map((key) => extras.get(key) ?? manifestExtraBuild(key)).filter(
      (build): build is Build => Boolean(build),
    ),
  ]
}
