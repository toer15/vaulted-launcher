import defaultBuilds from '../assets/builds.json'
import { artKeyFor } from './art'
import { SEASON_CATALOGUE, type SeasonCatalogueEntry } from './seasons'
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

interface ManifestSeasonSource {
  buildVersion?: string
  version?: string
}

function catalogueBuild(entry: SeasonCatalogueEntry): Build {
  const key = artKeyFor(entry.season) ?? `ch${entry.season.chapter}-s${entry.season.season}`
  const source = (defaultBuilds as { seasons: Record<string, ManifestSeasonSource> }).seasons[key]
  return buildForSeason(entry.season, source?.buildVersion || source?.version || '', key)
}

const seasonKey = (season: { chapter: number; season: number }) => `${season.chapter}:${season.season}`

const CATALOGUE_ORDER = new Map(
  SEASON_CATALOGUE.map((entry, index) => [`${entry.season.chapter}:${entry.season.season}`, index]),
)

/** Every season in the game — Chapter 1 Season 1 through Chapter 7 Mini Season 1. */
export function seedBuilds(): Build[] {
  return SEASON_CATALOGUE.map(catalogueBuild)
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

/** The 14.60 Retrac card is the only Chapter 2 Season 4 build in the library. */
function isCurrentChapter2Season4(build: Build): boolean {
  if (build.season.chapter !== 2 || build.season.season !== 4) return true
  if (String(build.version || '').startsWith('14.6')) return true
  return /[\\/]ch2-s4-1460(?:[\\/]|$)/i.test(build.path || '')
}

/**
 * The library is the 43-season catalogue. Keep one build per season, prefer a
 * real build over a placeholder, add any missing seasons, and drop duplicate
 * or unmapped folders that older scans left behind. Chapter 2 Season 4 also
 * drops the old archived 14.50 card so Retrac's 14.60 build is the only entry.
 */
export function ensureAllSeasons(builds: Build[]): Build[] {
  const bySeason = new Map<string, Build>()

  for (const build of builds) {
    if (!build.season?.known) continue
    const key = seasonKey(build.season)
    if (!CATALOGUE_ORDER.has(key)) continue
    if (!isCurrentChapter2Season4(build)) continue

    const existing = bySeason.get(key)
    if (!existing || (existing.placeholder && !build.placeholder)) {
      // A 14.60 card migrated from the old duplicate keeps its install path
      // and downloaded state, but must drop the old "· 14.60" title.
      bySeason.set(
        key,
        key === '2:4'
          ? {
              ...build,
              season: {
                ...build.season,
                label: 'Chapter 2 Season 4',
                short: 'CH2 · S4',
              },
            }
          : build,
      )
    }
  }

  return SEASON_CATALOGUE.map(
    (entry) => bySeason.get(seasonKey(entry.season)) ?? catalogueBuild(entry),
  )
}
