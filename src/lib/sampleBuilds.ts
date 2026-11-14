import { artKeyFor } from './art'
import { SEASON_CATALOGUE, type SeasonCatalogueEntry } from './seasons'
import { uid } from './storage'
import type { Build, SeasonInfo } from '../types'

/** Where the downloader unpacks a season that isn't on disk yet. */
const PLACEHOLDER_ROOT = '%APPDATA%\\VAULTED Launcher\\builds'

/** An empty library slot for a season, pointed at the download folder. */
export function buildForSeason(season: SeasonInfo, version: string, key: string): Build {
  const path = `${PLACEHOLDER_ROOT}\\${key}`

  return {
    id: uid(),
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

/** Every season in the game — Chapter 1 Season 1 through Chapter 7 Mini Season 1. */
export function seedBuilds(): Build[] {
  return SEASON_CATALOGUE.map(catalogueBuild)
}

const seasonKey = (season: { chapter: number; season: number }) => `${season.chapter}:${season.season}`

const CATALOGUE_ORDER = new Map(
  SEASON_CATALOGUE.map((entry, index) => [`${entry.season.chapter}:${entry.season.season}`, index]),
)

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
 * Saved libraries from older versions only held a few builds. Add whichever
 * seasons are missing while keeping the user's own order and real paths.
 */
export function ensureAllSeasons(builds: Build[]): Build[] {
  const present = new Set(builds.filter((build) => build.season.known).map((build) => seasonKey(build.season)))
  const missing = SEASON_CATALOGUE.filter((entry) => !present.has(seasonKey(entry.season)))
  if (missing.length === 0) return builds

  // first time the catalogue grows: lay the seasons out in release order,
  // keeping the paths of builds that are already linked
  const bySeason = new Map<string, Build>()
  for (const build of builds) {
    if (!build.season.known) continue
    const key = seasonKey(build.season)
    if (!bySeason.has(key)) bySeason.set(key, build)
  }

  const ordered: Build[] = []
  const placed = new Set<string>()
  for (const entry of SEASON_CATALOGUE) {
    const existing = bySeason.get(seasonKey(entry.season))
    ordered.push(existing ?? catalogueBuild(entry))
    if (existing) placed.add(existing.id)
  }

  // extra copies and unmapped builds keep their place, just at the end
  return [...ordered, ...builds.filter((build) => !placed.has(build.id))]
}
