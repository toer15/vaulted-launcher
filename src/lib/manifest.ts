import { artKeyFor } from './art'
import type { BuildManifest } from './network'
import { SEASON_CATALOGUE } from './seasons'
import type { OnlineProviderConfig } from '../types'

/** Bundled runtime selected for a build without asking the player anything. */
export type RuntimeProfile = 'legacy' | 'modern'

export interface SeasonManifestEntry {
  /** stable card/build id, e.g. ch1-s3 */
  id: string
  /** display title, e.g. Chapter 1 Season 3 */
  title: string
  chapter: number
  season: number
  /** archive/client version, e.g. 3.6 */
  buildVersion: string
  /** archive size in decimal gigabytes */
  sizeGB: number
  /** archive size in bytes, kept for progress and labels */
  sizeBytes: number
  /** direct archive endpoint used by the one-click download */
  downloadUrl: string
  /** live provider build used for the build.verify/exchange repair path */
  providerBuild?: { providerId: string; seasonId: string; buildId?: string }
  /** alternate bucket filename, e.g. {base}/{buildVersion}.zip */
  fallbackDownloadUrl?: string
  /** which bundled runtime the Play button should use */
  runtimeProfile: RuntimeProfile
  /** {AppDefaultBuildsDir}\{id}, resolved against the real builds folder */
  defaultInstallDir: string
  sha256?: string
  servers?: Array<{ name: string; url: string }>
  /** bundled provider profile; online status still depends on a live hosted backend */
  onlineProvider?: OnlineProviderConfig
  /** every provider that can host this season, primary first */
  onlineProviders?: OnlineProviderConfig[]
  /** kept as an archive; Play is disabled for this card */
  archived?: boolean
}

/** The fallback used before the desktop shell reports its real builds root. */
export const FALLBACK_BUILDS_ROOT = '%APPDATA%\\VAULTED Launcher\\builds'

/**
 * Chapter 1 clients need Memory.dll beside the local server; later chapters use
 * the modern EOS path. The manifest pre-assigns this, but a version fallback
 * keeps remote manifests and hand-added folders working too.
 */
export function runtimeProfileFor(chapter: number, version?: string): RuntimeProfile {
  if (Number.isFinite(chapter) && chapter > 0) return chapter <= 1 ? 'legacy' : 'modern'
  const major = Number(String(version ?? '').split('.')[0])
  return Number.isFinite(major) && major > 0 && major <= 10 ? 'legacy' : 'modern'
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function catalogueIndex(): Map<string, (typeof SEASON_CATALOGUE)[number]['season']> {
  const byKey = new Map<string, (typeof SEASON_CATALOGUE)[number]['season']>()
  for (const entry of SEASON_CATALOGUE) {
    const key = artKeyFor(entry.season) ?? `ch${entry.season.chapter}-s${entry.season.season}`
    byKey.set(key, entry.season)
  }
  return byKey
}

const CATALOGUE = catalogueIndex()

/** Keep a season's primary provider first and ignore duplicate ids. */
function providerList(
  primary: OnlineProviderConfig | undefined,
  all: OnlineProviderConfig[] | undefined,
): OnlineProviderConfig[] | undefined {
  const providers: OnlineProviderConfig[] = []
  const seen = new Set<string>()
  for (const provider of [primary, ...(Array.isArray(all) ? all : [])]) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) continue
    const id = provider.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    providers.push(provider)
  }
  return providers.length > 0 ? providers : undefined
}

/**
 * Normalises every manifest season into the single self-contained shape the
 * cards use. Fields already present in manifest.json win; anything a remote or
 * older manifest omitted is derived from the bundled 43-season catalogue.
 */
export function buildSeasonManifest(
  manifest: BuildManifest | null | undefined,
  buildsRoot?: string | null,
): Record<string, SeasonManifestEntry> {
  const root = String(buildsRoot || FALLBACK_BUILDS_ROOT).replace(/[\\/]+$/, '')
  const result: Record<string, SeasonManifestEntry> = {}

  for (const [key, source] of Object.entries(manifest?.seasons ?? {})) {
    if (!source || typeof source !== 'object') continue
    const downloadUrl = String(source.downloadUrl || source.url || '').trim()
    const providerSource = source.providerBuild
    const providerBuild =
      providerSource && typeof providerSource.providerId === 'string' && providerSource.providerId.trim()
        ? {
            providerId: providerSource.providerId.trim(),
            seasonId:
              typeof providerSource.seasonId === 'string' && providerSource.seasonId.trim()
                ? providerSource.seasonId.trim()
                : key,
            ...(typeof providerSource.buildId === 'string' && providerSource.buildId.trim()
              ? { buildId: providerSource.buildId.trim() }
              : {}),
          }
        : undefined
    if (!downloadUrl && !providerBuild) continue

    const catalogueSeason = CATALOGUE.get(key)
    const chapter = Number.isFinite(source.chapter) ? Number(source.chapter) : (catalogueSeason?.chapter ?? 0)
    const season = Number.isFinite(source.season) ? Number(source.season) : (catalogueSeason?.season ?? 0)
    const buildVersion = String(source.buildVersion || source.version || '').trim()
    const sizeBytes = positive(source.sizeBytes) ?? Math.round((positive(source.sizeGB) ?? 0) * 1e9)
    const sizeGB = positive(source.sizeGB) ?? Math.round((sizeBytes / 1e9) * 100) / 100
    const id = String(source.id || key).trim() || key
    const runtimeProfile =
      source.runtimeProfile === 'legacy' || source.runtimeProfile === 'modern'
        ? source.runtimeProfile
        : runtimeProfileFor(chapter, buildVersion)

    result[key] = {
      id,
      title: String(source.title || catalogueSeason?.label || key).trim() || key,
      chapter,
      season,
      buildVersion,
      sizeGB,
      sizeBytes,
      downloadUrl,
      providerBuild,
      fallbackDownloadUrl: source.fallbackDownloadUrl,
      runtimeProfile,
      defaultInstallDir: `${root}\\${key}`,
      sha256: source.sha256,
      servers: Array.isArray(source.servers) ? source.servers : undefined,
      onlineProvider: source.onlineProvider,
      onlineProviders: providerList(source.onlineProvider, source.onlineProviders),
      archived: source.archived === true,
    }
  }

  return result
}
