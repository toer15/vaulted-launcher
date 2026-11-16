import { artKeyFor } from './art'
import { buildFromPath, executableFor, extractVersion, folderNameOf } from './seasons'
import type { SeasonManifestEntry } from './manifest'
import type { Build } from '../types'

/** One season's persisted on-disk state in profiles.json. */
export interface BuildProfile {
  /** stable manifest/season key, e.g. ch1-s3 */
  seasonId: string
  /** the folder passed to the client on launch */
  buildFolderPath: string
  /** per-card override; null means use defaultExecutablePath */
  executablePath: string | null
  /** label shown for this card's executable; empty inherits defaultProviderLabel */
  providerLabel: string
  isInstalled: boolean
  version?: string
  label?: string
  detectedAt?: number
}

/**
 * `%APPDATA%\VAULTED Launcher\profiles.json`.
 *
 * A flat `builds` map keeps the file useful without a schema migration: season
 * keys survive generated React ids and downloaded folders being recreated.
 */
export interface ProfilesFile {
  schemaVersion: 1
  defaultExecutablePath: string
  defaultProviderLabel: string
  defaultBuildsRoot: string
  builds: Record<string, BuildProfile>
}

export interface DetectedBuild {
  key: string
  build: Build
  folder: string
  version: string
  label: string
  score: number
}

const STORAGE_KEY = 'vaulted.profiles.v1'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalText(value: unknown): string | undefined {
  const valueText = text(value)
  return valueText || undefined
}

/** Compare Windows paths without depending on the caller's slash style/case. */
function normalizeProfilePath(value: string): string {
  return text(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** True when child is an executable/file inside parent, not a sibling prefix. */
function pathIsInside(child: string, parent: string): boolean {
  const childPath = normalizeProfilePath(child)
  const parentPath = normalizeProfilePath(parent)
  return Boolean(childPath && parentPath && childPath.startsWith(`${parentPath}\\`))
}

/**
 * Relinking or moving a season must not carry an executable path from the old
 * folder into the new one. A stored path is stale when it points inside the
 * previous build folder; a deliberate override inside the new folder or
 * outside any build folder is kept.
 */
function executableForInstalledFolder(
  existing: BuildProfile | undefined,
  build: Build,
  folder: string,
): string | null {
  const stored = text(existing?.executablePath)
  if (!stored) return text(build.executable) || null

  const storedInNewFolder = pathIsInside(stored, folder)
  const storedInOldFolder = Boolean(existing && pathIsInside(stored, existing.buildFolderPath))
  if (storedInNewFolder || !storedInOldFolder) return stored

  // The old folder no longer owns this season, so its client path cannot be
  // used. Persist the executable the native linker just verified instead.
  return text(build.executable) || null
}

/** Human-readable launcher name derived from an executable path. */
export function providerLabelFromPath(value: string): string {
  const raw = text(value)
  if (!raw) return ''

  // Protocol-style values are useful as a label even though card Play is
  // currently executable-only; this keeps the label correct if one is stored.
  const protocol = raw.match(/^([a-z][a-z0-9+.-]*):/i)
  if (protocol && !/^[a-z]:[\\/]/i.test(raw)) return protocol[1]

  const clean = raw.replace(/[\\/]+$/, '')
  const base = clean.split(/[\\/]/).pop() || clean
  return base
    .replace(/\.(exe|com|bat|cmd|lnk)$/i, '')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeEntry(value: unknown, fallbackKey: string): BuildProfile | null {
  const raw = asRecord(value)
  if (!raw) return null

  const buildFolderPath = text(raw.buildFolderPath ?? raw.buildPath ?? raw.folderPath ?? raw.path)
  const executablePath = text(raw.executablePath ?? raw.executable)
  if (!buildFolderPath) return null

  const seasonId = text(raw.seasonId ?? raw.id ?? fallbackKey) || fallbackKey
  const providerLabel = text(raw.providerLabel ?? raw.launcherLabel)
  const isInstalled = raw.isInstalled !== false && Boolean(buildFolderPath)
  const detectedAt = typeof raw.detectedAt === 'number' && Number.isFinite(raw.detectedAt)
    ? raw.detectedAt
    : undefined

  return {
    seasonId,
    buildFolderPath,
    executablePath: executablePath || null,
    providerLabel: providerLabel || (executablePath ? providerLabelFromPath(executablePath) : ''),
    isInstalled,
    version: optionalText(raw.version),
    label: optionalText(raw.label),
    detectedAt,
  }
}

/** Accepts the current file plus older `profiles` maps/arrays without data loss. */
export function normalizeProfiles(value: unknown, fallbackBuildsRoot = ''): ProfilesFile {
  const raw = asRecord(value)
  const builds: Record<string, BuildProfile> = {}
  const source = raw ? raw.builds ?? raw.profiles : null

  if (Array.isArray(source)) {
    for (const item of source) {
      const entry = asRecord(item)
      const key = text(entry?.seasonId ?? entry?.id)
      if (!key) continue
      const normalized = normalizeEntry(item, key)
      if (normalized) builds[normalized.seasonId] = normalized
    }
  } else {
    const map = asRecord(source)
    if (map) {
      for (const [key, item] of Object.entries(map)) {
        const normalized = normalizeEntry(item, key)
        if (normalized) builds[normalized.seasonId || key] = normalized
      }
    }
  }

  const defaultExecutablePath = text(raw?.defaultExecutablePath)
  const defaultProviderLabel = text(raw?.defaultProviderLabel)
  return {
    schemaVersion: 1,
    defaultExecutablePath,
    defaultProviderLabel:
      defaultProviderLabel || (defaultExecutablePath ? providerLabelFromPath(defaultExecutablePath) : ''),
    defaultBuildsRoot: text(raw?.defaultBuildsRoot) || fallbackBuildsRoot,
    builds,
  }
}

export function emptyProfiles(defaultBuildsRoot = ''): ProfilesFile {
  return {
    schemaVersion: 1,
    defaultExecutablePath: '',
    defaultProviderLabel: '',
    defaultBuildsRoot,
    builds: {},
  }
}

function saveLocal(profiles: ProfilesFile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
  } catch {
    /* storage disabled — the native profiles.json still holds the real copy */
  }
}

function readLocal(fallbackBuildsRoot: string): ProfilesFile {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return normalizeProfiles(raw ? JSON.parse(raw) : null, fallbackBuildsRoot)
  } catch {
    return emptyProfiles(fallbackBuildsRoot)
  }
}

/** Native profiles.json wins; localStorage keeps browser previews and offline reads useful. */
export async function loadProfiles(fallbackBuildsRoot = ''): Promise<ProfilesFile> {
  const local = readLocal(fallbackBuildsRoot)
  try {
    const native = await window.arc?.profiles?.read?.()
    if (native) {
      const normalized = normalizeProfiles(native, fallbackBuildsRoot || local.defaultBuildsRoot)
      saveLocal(normalized)
      return normalized
    }
  } catch {
    /* keep the local copy */
  }
  return local
}

export async function persistProfiles(profiles: ProfilesFile): Promise<ProfilesFile> {
  const normalized = normalizeProfiles(profiles)
  saveLocal(normalized)

  const bridge = window.arc?.profiles
  if (bridge?.save) {
    const result = await bridge.save(normalized)
    if (!result?.ok) throw new Error(result?.error || 'Could not save profiles.json.')
    const saved = result.profiles ? normalizeProfiles(result.profiles, normalized.defaultBuildsRoot) : normalized
    saveLocal(saved)
    return saved
  }
  return normalized
}

export async function pickDefaultExecutable(): Promise<string | null> {
  return (await window.arc?.pickExecutable?.()) ?? null
}

export async function pickDefaultBuildsRoot(): Promise<string | null> {
  return (await window.arc?.pickBuildsRoot?.()) ?? null
}

export function profileKeyForBuild(build: Build): string {
  return artKeyFor(build.season) ?? build.id
}

export function profileForBuild(profiles: ProfilesFile, build: Build): BuildProfile | undefined {
  const key = profileKeyForBuild(build)
  return profiles.builds[key] ?? profiles.builds[build.id]
}

/**
 * Global fallback order: the card's custom executable, then the global client.
 * A null result means VAULTED runs the build's own Fortnite client through the
 * existing injector/private-server path.
 */
export function profileExecutableFor(build: Build, profiles: ProfilesFile): string | null {
  const profile = profileForBuild(profiles, build)
  return profile?.executablePath || profiles.defaultExecutablePath || null
}

/** Global launcher name, derived from the executable when no explicit label exists. */
export function effectiveDefaultProviderLabel(profiles: ProfilesFile): string {
  if (!profiles.defaultExecutablePath) return ''
  return profiles.defaultProviderLabel || providerLabelFromPath(profiles.defaultExecutablePath)
}

/** The label a card should show for its effective launcher. */
export function profileProviderLabelFor(build: Build, profiles: ProfilesFile): string {
  const profile = profileForBuild(profiles, build)
  if (!profile?.executablePath) return effectiveDefaultProviderLabel(profiles)
  return profile.providerLabel || providerLabelFromPath(profile.executablePath)
}

export interface AppliedProfiles {
  builds: Build[]
  installed: Record<string, boolean>
  changed: boolean
}

/** Applies every installed profile to its season card without touching other cards. */
export function applyProfilesToBuilds(builds: Build[], profiles: ProfilesFile): AppliedProfiles {
  const installed: Record<string, boolean> = {}
  let changed = false

  const next = builds.map((build) => {
    const profile = profileForBuild(profiles, build)
    if (!profile?.isInstalled || !profile.buildFolderPath) return build

    installed[build.id] = true
    const folder = profile.buildFolderPath
    // Keep a downloader-discovered executable when the folder has not moved;
    // otherwise use the standard client location for this build root.
    const clientExecutable = !build.placeholder && build.path === folder ? build.executable : executableFor(folder)
    const executable = profile.executablePath || profiles.defaultExecutablePath || clientExecutable
    const providerLabel = profileProviderLabelFor(build, profiles)
    const version = profile.version || build.version || extractVersion(folder) || 'unknown'
    const folderName = folderNameOf(folder)

    if (
      build.path === folder &&
      build.executable === executable &&
      (build.providerLabel ?? '') === providerLabel &&
      build.placeholder !== true &&
      build.folderName === folderName &&
      build.version === version
    ) {
      return build
    }

    changed = true
    return {
      ...build,
      path: folder,
      executable,
      providerLabel,
      placeholder: false,
      folderName,
      version,
    }
  })

  return { builds: changed ? next : builds, installed, changed }
}

/** Adds every newly detected folder to profiles.json, preserving per-card exe overrides. */
export function withDetectedBuilds(profiles: ProfilesFile, detections: DetectedBuild[]): ProfilesFile {
  if (detections.length === 0) return profiles
  const builds = { ...profiles.builds }

  for (const detection of detections) {
    const existing = builds[detection.key]
    builds[detection.key] = {
      seasonId: detection.key,
      buildFolderPath: detection.folder,
      executablePath: existing?.executablePath ?? null,
      providerLabel: existing?.providerLabel ?? '',
      isInstalled: true,
      version: detection.version || existing?.version,
      label: detection.label || existing?.label,
      detectedAt: Date.now(),
    }
  }

  return { ...profiles, builds }
}

/** Persists a folder the player picked manually for one card. */
export function withInstalledBuild(
  profiles: ProfilesFile,
  build: Build,
  folder = build.path,
): ProfilesFile {
  if (!folder) return profiles
  const key = profileKeyForBuild(build)
  const existing = profiles.builds[key]
  return {
    ...profiles,
    builds: {
      ...profiles.builds,
      [key]: {
        seasonId: key,
        buildFolderPath: folder,
        // Persist the exact client the linker verified (some builds only ship a
        // bootstrapper executable). A custom override survives when it is still
        // valid for the new folder; an executable from the previous folder is
        // replaced instead of leaving a stale path behind.
        executablePath: executableForInstalledFolder(existing, build, folder),
        providerLabel: existing?.providerLabel ?? '',
        isInstalled: true,
        version: build.version || existing?.version,
        label: build.season.label,
        detectedAt: Date.now(),
      },
    },
  }
}

export function withoutBuildProfile(profiles: ProfilesFile, build: Build): ProfilesFile {
  const key = profileKeyForBuild(build)
  if (!profiles.builds[key]) return profiles
  const builds = { ...profiles.builds }
  delete builds[key]
  return { ...profiles, builds }
}

export function installedProfileCount(profiles: ProfilesFile): number {
  return Object.values(profiles.builds).filter((profile) => profile.isInstalled).length
}

function clNumber(value: string): string | null {
  const match = String(value || '').match(/CL[-_ ]?(\d{4,})/i)
  return match ? match[1] : null
}

function versionKey(value: string): string | null {
  const match = String(value || '').match(/(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?(?!\d)/)
  return match ? `${Number(match[1])}.${Number(match[2])}` : null
}

/**
 * Matches a folder to one of the 43 seasons by season key, CL build number,
 * version, or the parsed chapter/season fallback. This also works when a build
 * has no Shipping.exe because the external launcher owns the client.
 */
export function matchBuildFromFolder(
  folder: string,
  builds: Build[],
  seasonManifest: Record<string, SeasonManifestEntry>,
): DetectedBuild | null {
  if (!folder) return null

  const folderText = folder.toLowerCase()
  const folderName = folderNameOf(folder).toLowerCase()
  const segments = folderText.split(/[\\/]+/).filter(Boolean)
  const folderSeed = buildFromPath(folder, 'scan')
  const folderVersion = extractVersion(folder) ?? (folderSeed.version !== 'unknown' ? folderSeed.version : '')
  const folderVersionKey = versionKey(folderVersion)
  const folderCl = clNumber(folder)

  let keyMatch: string | null = null
  for (const build of builds) {
    const key = profileKeyForBuild(build)
    if (segments.includes(key.toLowerCase()) || folderName === key.toLowerCase() || folderName === build.id.toLowerCase()) {
      keyMatch = key
      break
    }
  }

  if (!keyMatch) {
    const chapterSeason = folderText.match(/ch(?:apter)?[\s_-]*(\d+)[\s_-]*(?:s|season)[\s_-]*(\d+)/i)
    if (chapterSeason) keyMatch = `ch${Number(chapterSeason[1])}-s${Number(chapterSeason[2])}`
  }
  if (!keyMatch) {
    const compact = folderText.match(/(?:^|[\\/_\s-])c(\d{1,2})[\s_-]?s(\d{1,2})(?:$|[\\/_\s-])/i)
    if (compact) keyMatch = `ch${Number(compact[1])}-s${Number(compact[2])}`
  }

  const byKey = keyMatch
    ? builds.find((build) => profileKeyForBuild(build) === keyMatch)
    : undefined
  if (byKey) {
    const key = profileKeyForBuild(byKey)
    return {
      key,
      build: byKey,
      folder,
      version: folderVersion || byKey.version || seasonManifest[key]?.buildVersion || '',
      label: seasonManifest[key]?.title || byKey.season.label,
      score: 4,
    }
  }

  if (folderCl) {
    for (const build of builds) {
      const key = profileKeyForBuild(build)
      const entry = seasonManifest[key]
      const candidates = [entry?.downloadUrl, entry?.fallbackDownloadUrl, build.version, build.path]
      if (candidates.some((value) => value && clNumber(String(value)) === folderCl)) {
        return {
          key,
          build,
          folder,
          version: folderVersion || entry?.buildVersion || build.version,
          label: entry?.title || build.season.label,
          score: 3,
        }
      }
    }
  }

  if (folderVersionKey) {
    for (const build of builds) {
      const key = profileKeyForBuild(build)
      const entry = seasonManifest[key]
      if (versionKey(entry?.buildVersion ?? '') === folderVersionKey || versionKey(build.version) === folderVersionKey) {
        return {
          key,
          build,
          folder,
          version: folderVersion || entry?.buildVersion || build.version,
          label: entry?.title || build.season.label,
          score: 2,
        }
      }
    }
  }

  if (folderSeed.season.known) {
    const key = artKeyFor(folderSeed.season)
    const build = key ? builds.find((candidate) => profileKeyForBuild(candidate) === key) : undefined
    if (key && build) {
      return {
        key,
        build,
        folder,
        version: folderVersion || folderSeed.version || build.version,
        label: seasonManifest[key]?.title || build.season.label,
        score: 1,
      }
    }
  }

  return null
}
