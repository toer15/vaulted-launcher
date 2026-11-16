import defaultBuilds from '../assets/builds.json'
import type { BuildManifest, BuildSource } from './network'

export type CloudSourceMode = 'manifest' | 'bucket'

export interface CloudSourceResult {
  manifest: BuildManifest
  mode: CloudSourceMode
  /** URL that actually answered (manifest.json) or the bucket base */
  resolvedUrl: string
  count: number
}

interface TextResponse {
  ok: boolean
  status: number
  url: string
  text: string
  error?: string
}

const REQUEST_TIMEOUT = 15_000
const BUNDLED = defaultBuilds as BuildManifest

/** Accepts a bare host, a bucket base, or a manifest.json URL. */
export function normalizeCloudUrl(input: string): string {
  const trimmed = String(input || '').trim()
  if (!trimmed) throw new Error('Paste a manifest.json or bucket URL first.')

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('That is not a valid http(s) URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Cloud sources must use http:// or https://.')
  }
  parsed.hash = ''
  const href = parsed.toString()
  return href.endsWith('/') ? href.slice(0, -1) : href
}

async function fetchText(url: string): Promise<TextResponse> {
  if (window.arc?.fetchText) {
    try {
      return await window.arc.fetchText(url)
    } catch (error) {
      return {
        ok: false,
        status: 0,
        url,
        text: '',
        error: error instanceof Error ? error.message : 'Could not reach that URL.',
      }
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      text: await response.text(),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      text: '',
      error: error instanceof Error ? error.message : 'Could not reach that URL.',
    }
  } finally {
    clearTimeout(timer)
  }
}

function seasonMap(value: unknown): Record<string, BuildSource> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, Record<string, unknown>>
  const entries = Object.entries(record).filter(([, source]) => source && typeof source === 'object')
  if (entries.length === 0) return null

  const result: Record<string, BuildSource> = {}
  for (const [key, source] of entries) {
    const downloadUrl = String(source.downloadUrl || source.url || '').trim()
    if (!downloadUrl) continue
    result[key] = {
      ...(source as unknown as BuildSource),
      id: String(source.id || key),
      downloadUrl,
      url: String(source.url || downloadUrl),
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

function readManifest(payload: unknown): BuildManifest | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>

  const array = Array.isArray(root.seasons) ? root.seasons : Array.isArray(root.builds) ? root.builds : null
  if (array) {
    const record: Record<string, unknown> = {}
    for (const item of array) {
      if (!item || typeof item !== 'object') continue
      const source = item as Record<string, unknown>
      const key = String(source.id || '').trim()
      if (key) record[key] = source
    }
    const seasons = seasonMap(record)
    return seasons ? { updatedAt: typeof root.updatedAt === 'string' ? root.updatedAt : undefined, seasons } : null
  }

  const nested = root.seasons ?? root.builds
  const seasons =
    seasonMap(nested) ??
    (/^ch\d+-/i.test(Object.keys(root)[0] ?? '') ? seasonMap(root) : null)

  return seasons
    ? { updatedAt: typeof root.updatedAt === 'string' ? root.updatedAt : undefined, seasons }
    : null
}

/**
 * A cloud manifest may only override archive URLs. Metadata that the app
 * already knows (title, version, size, runtime) is preserved for every season.
 */
function mergeWithBundled(remote: BuildManifest): BuildManifest {
  const seasons: Record<string, BuildSource> = {}
  for (const [key, bundled] of Object.entries(BUNDLED.seasons)) {
    const incoming = remote.seasons[key]
    if (!incoming) {
      seasons[key] = bundled
      continue
    }
    const downloadUrl = incoming.downloadUrl || incoming.url || bundled.downloadUrl || bundled.url
    seasons[key] = {
      ...bundled,
      ...incoming,
      id: incoming.id || key,
      downloadUrl,
      url: incoming.url || downloadUrl,
    }
  }
  for (const [key, source] of Object.entries(remote.seasons)) {
    if (!seasons[key]) seasons[key] = source
  }
  return { updatedAt: remote.updatedAt ?? new Date().toISOString(), seasons }
}

function bucketUrl(base: string, file: string): string {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${file}`
  return url.toString()
}

/** Mode B: every season maps to {base}/{id}.zip, with a version.zip fallback. */
function bucketManifest(base: string): BuildManifest {
  const seasons: Record<string, BuildSource> = {}
  for (const [key, source] of Object.entries(BUNDLED.seasons)) {
    const primary = bucketUrl(base, `${key}.zip`)
    const version = String(source.buildVersion || source.version || '').trim()
    seasons[key] = {
      ...source,
      id: key,
      downloadUrl: primary,
      url: primary,
      fallbackDownloadUrl: version ? bucketUrl(base, `${encodeURIComponent(version)}.zip`) : undefined,
    }
  }
  return { updatedAt: new Date().toISOString(), seasons }
}

function failure(response: TextResponse, explicitJson: boolean): Error {
  if (response.status === 0) {
    return new Error(
      response.error
        ? `Could not reach the cloud source: ${response.error}`
        : 'Could not reach the cloud source.',
    )
  }
  return new Error(
    explicitJson
      ? `The manifest URL answered ${response.status}.`
      : `The cloud source answered ${response.status}.`,
  )
}

/**
 * Resolves one user-supplied URL into a manifest for every card.
 *
 * Mode A: a .json URL, or {base}/manifest.json when the bucket publishes one.
 * Mode B: any other base URL resolves to {base}/{season.id}.zip.
 */
export async function resolveCloudSource(input: string): Promise<CloudSourceResult> {
  const base = normalizeCloudUrl(input)
  const parsed = new URL(base)
  const explicitJson = /\.json$/i.test(parsed.pathname)
  const candidate = explicitJson ? base : bucketUrl(base, 'manifest.json')
  const response = await fetchText(candidate)

  if (response.ok) {
    let payload: unknown = null
    try {
      payload = JSON.parse(response.text)
    } catch {
      payload = null
    }
    const remote = readManifest(payload)
    if (remote) {
      const manifest = mergeWithBundled(remote)
      return {
        manifest,
        mode: 'manifest',
        resolvedUrl: response.url || candidate,
        count: Object.keys(manifest.seasons).length,
      }
    }
    if (explicitJson) throw new Error('That JSON file does not contain any season download URLs.')
  } else if (explicitJson || response.status === 0) {
    throw failure(response, explicitJson)
  }

  // No manifest published at this base: treat it as a raw storage bucket.
  const manifest = bucketManifest(base)
  return {
    manifest,
    mode: 'bucket',
    resolvedUrl: base,
    count: Object.keys(manifest.seasons).length,
  }
}
