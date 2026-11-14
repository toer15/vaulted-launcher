import type { SeasonInfo } from '../types'

/**
 * Key art is bundled with the app (src/assets/art/<chapter>-<season>.jpg), so
 * the launcher works offline and never hotlinks a CDN. Vite fingerprints and
 * emits each file, which also works over file:// in the Electron build.
 */
const modules = import.meta.glob('../assets/art/*.jpg', {
  eager: true,
  import: 'default',
}) as Record<string, string>

const ART: Record<string, string> = {}

for (const [filePath, url] of Object.entries(modules)) {
  const key = filePath.split('/').pop()?.replace(/\.jpg$/i, '')
  if (key) ART[key] = url
}

export function artKeyFor(season: SeasonInfo): string | null {
  if (!season.known) return null
  return season.artKey ?? `ch${season.chapter}-s${season.season}`
}

export function artFor(season: SeasonInfo): string | null {
  const key = artKeyFor(season)
  return key ? ART[key] ?? null : null
}

export const ART_COUNT = Object.keys(ART).length
