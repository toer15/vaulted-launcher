import type { SeasonInfo } from '../types'

/**
 * Art is bundled with the app, so the launcher works offline and never
 * hotlinks a CDN. Vite fingerprints and emits each file, which also works over
 * file:// in the Electron build.
 *
 * `art` is the original key art. `lobby` is the exact in-game lobby backdrop
 * used during that chapter/season, archived for all 43 releases.
 */
const artModules = import.meta.glob('../assets/art/*.jpg', {
  eager: true,
  import: 'default',
}) as Record<string, string>

const lobbyModules = import.meta.glob('../assets/lobby/*.jpg', {
  eager: true,
  import: 'default',
}) as Record<string, string>

function index(modules: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [filePath, url] of Object.entries(modules)) {
    const key = filePath.split('/').pop()?.replace(/\.jpg$/i, '')
    if (key) result[key] = url
  }
  return result
}

const ART = index(artModules)
const LOBBY = index(lobbyModules)

export function artKeyFor(season: SeasonInfo): string | null {
  if (!season.known) return null
  return season.artKey ?? `ch${season.chapter}-s${season.season}`
}

export function artFor(season: SeasonInfo): string | null {
  const key = artKeyFor(season)
  return key ? ART[key] ?? null : null
}

/** The authentic lobby backdrop for this exact season. */
export function lobbyFor(season: SeasonInfo): string | null {
  const key = artKeyFor(season)
  return key ? LOBBY[key] ?? null : null
}

/**
 * Cards show the season's official cover art, the same artwork Epic used on
 * that season's promotional card. The lobby backdrop is only a fallback for a
 * season that ships without key art.
 */
export function seasonImageFor(season: SeasonInfo): string | null {
  return artFor(season) ?? lobbyFor(season)
}

export const ART_COUNT = Object.keys(ART).length
export const LOBBY_COUNT = Object.keys(LOBBY).length
