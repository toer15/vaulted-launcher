import { artKeyFor } from './art'
import type {
  Build,
  BuildExitInfo,
  BuildVerifyReport,
  OnlineProviderConfig,
  ShopEquipped,
  ShopItemType,
} from '../types'

export interface InventoryItem {
  id: string
  type: ShopItemType
}

export interface InventoryPayload {
  items: InventoryItem[]
  equipped?: ShopEquipped
}

export interface InventorySyncResult {
  synced: boolean
  added?: number
  owned?: number
  accountId?: string
  reason?: string
  error?: string
}

export interface LaunchPayload {
  id?: string
  path: string
  executable: string
  version: string
  /** private-server account name shown in Fortnite */
  username?: string
  /** the account's owned shop items, written into the in-game athena profile */
  inventory?: InventoryPayload
  /** set to join a friend's lobby instead of starting a local host */
  joinHost?: string
  joinPort?: number
  /** only automatic public-lobby joins are allowed to fall back to hosting */
  joinFallback?: boolean
  /** pre-assigned runtime for this build, from the season manifest */
  runtimeProfile?: 'legacy' | 'modern'
}

export interface WindowControls {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
}

export interface OnlineProviderDetection {
  providerId?: string
  name?: string
  label?: string
  installed: boolean
  executable?: string | null
  protocolRegistered?: boolean
  viaProtocol?: boolean
  installerUrl?: string
  error?: string
}

export interface OnlineProviderLaunchResult {
  installed: boolean
  launched: boolean
  providerId?: string
  name?: string
  pid?: number | null
  external?: boolean
  provider?: string
  error?: string
}

export interface DownloadProgress {
  id: string
  received: number
  total: number
  /** null when the server sends no content-length */
  percent: number | null
  /** estimated seconds left, or null while the rate is unknown */
  etaSeconds: number | null
  /** live transfer rate in bytes per second */
  bytesPerSecond: number | null
  /** the resolved source URL, including a bucket fallback switch */
  url?: string
  phase: 'downloading' | 'verifying' | 'extracting'
}

export interface InterruptedDownload {
  id: string
  key: string
  url: string
  sha256: string | null
  received: number
  total: number
  percent: number | null
}

export interface DownloadResult {
  filePath: string
  executable: string | null
  folder: string
  reason?: 'mobile' | 'no-executable' | null
}

/**
 * Exposed by electron/preload.cjs. Every call is optional so the renderer still
 * type-checks (and degrades) outside the desktop shell.
 */
export interface LauncherBridge {
  platform?: string
  launchBuild(payload: LaunchPayload): Promise<{
    pid: number | null
    privateServer?: boolean
    matchmaking?: boolean
    joined?: string | null
  }>
  lanIp?(): Promise<string | null>
  /** where friends should connect: public mapping when available, otherwise LAN */
  publicAddress?(): Promise<{ address: string; port: number; public: boolean; method: string } | null>
  getPublicAddress?(): Promise<string>
  setPublicAddress?(value: string): Promise<{ ok: boolean; error?: string; value?: string | null }>
  closeBuild?(payload: { id: string }): Promise<{ closed: boolean }>
  syncInventory?(payload: InventoryPayload & { username: string }): Promise<InventorySyncResult>
  /** persisted account session so reinstalling keeps the player signed in */
  accountSession?: {
    read(): Promise<string | null>
    save(value: string): Promise<boolean>
    clear(): Promise<boolean>
  }
  checkBuilds?(builds: Array<{ id: string; executable: string; path: string }>): Promise<Record<string, boolean>>
  /** directly start a configured external launcher with the build folder as its target */
  launchProfileBuild?(payload: { id: string; path: string; executable: string }): Promise<{
    pid: number | null
    privateServer?: boolean
    matchmaking?: boolean
    joined?: string | null
    external?: boolean
  }>
  downloadBuild?(payload: {
    id: string
    key: string
    url: string
    sha256?: string
    fallbackUrl?: string
  }): Promise<DownloadResult>
  deleteBuild?(payload: { id: string; path: string }): Promise<{ deleted: boolean; managed: boolean; running?: boolean }>
  verifyBuild?(payload: { id: string; path: string; executable: string }): Promise<BuildVerifyReport>
  cancelDownload?(payload: { id: string }): Promise<{ cancelled: boolean }>
  pauseDownload?(payload: { id: string }): Promise<{ paused: boolean }>
  /** partial downloads left behind by a crash, quit, or network stop */
  listInterruptedDownloads?(): Promise<InterruptedDownload[]>
  onDownloadProgress?(callback: (progress: DownloadProgress) => void): () => void
  onBuildExited?(callback: (payload: BuildExitInfo) => void): () => void
  onJoinFailed?(callback: (payload: { id?: string; host: string; port: number; reason: string }) => void): () => void
  onLaunchStatus?(callback: (payload: { id?: string; message: string }) => void): () => void
  pickFolder?(): Promise<string | null>
  /** folder picker for the cloud source install directory */
  pickInstallDir?(): Promise<string | null>
  /** persisted cloud source URL, online service and install directory */
  settings?: {
    read(): Promise<{
      cloudSourceUrl?: string
      onlineServiceUrl?: string
      defaultInstallDir?: string
      hostPublicLobby?: boolean
    } | null>
    save(settings: {
      cloudSourceUrl: string
      onlineServiceUrl: string
      defaultInstallDir: string
      hostPublicLobby: boolean
    }): Promise<{
      ok: boolean
      settings?: {
        cloudSourceUrl: string
        onlineServiceUrl: string
        defaultInstallDir: string
        hostPublicLobby: boolean
      }
      error?: string
    }>
  }
  /** `%APPDATA%\VAULTED Launcher\profiles.json` */
  profiles?: {
    read(): Promise<unknown>
    save(profiles: unknown): Promise<{
      ok: boolean
      profiles?: unknown
      path?: string
      error?: string
    }>
  }
  /** native file picker for the global client executable */
  pickExecutable?(): Promise<string | null>
  /** native folder picker for the global builds root */
  pickBuildsRoot?(): Promise<string | null>
  /** CORS-free text fetch through the Electron main process */
  fetchText?(url: string, options?: { method?: 'GET' | 'POST'; body?: string }): Promise<{
    ok: boolean
    status: number
    url: string
    text: string
    error?: string
  }>
  /** configured install root where one-click downloads are unpacked */
  getBuildsRoot?(): Promise<string>
  scanBuilds?(roots?: string[]): Promise<string[]>
  checkUpdates?(): Promise<{ ok: boolean; version?: string | null; currentVersion?: string; error?: string }>
  installUpdate?(): Promise<{ ok: boolean; error?: string }>
  downloadUpdate?(): Promise<{ ok: boolean; error?: string }>
  onUpdateAvailable?(callback: (info: { version: string }) => void): () => void
  onUpdateDownloaded?(callback: (info: { version: string }) => void): () => void
  onUpdateProgress?(callback: (info: { percent: number }) => void): () => void
  onUpdateError?(callback: (info: { message: string }) => void): () => void
  session?: {
    /** synchronous, so the first render already knows the user */
    readSync(): string | null
    save(value: string): Promise<boolean>
    clear(): Promise<boolean>
  }
  openExternal?(url: string): Promise<void>
  /** launch an installed third-party project launcher; download fallback is handled by the UI */
  launchHostedProject?(id: string): Promise<{
    installed: boolean
    launched: boolean
    executable?: string
    error?: string
  }>
  /** look up a public lobby for a season in the main process */
  findHostedLobby?(id: string): Promise<{
    installed: boolean
    lobby: { id: string; name: string; version: string; author?: string; host: string; port: number } | null
    error?: string
  }>
  /** hand a public lobby id to an installed project launcher's URL protocol */
  joinHostedLobby?(id: string, lobbyId: string): Promise<{
    installed: boolean
    joined: boolean
    executable?: string
    error?: string
  }>
  /** find a bundled community provider at its standard install paths or URI handler */
  detectOnlineProvider?(id: string): Promise<OnlineProviderDetection>
  /** open the provider's official installer/direct setup flow */
  openOnlineProviderInstaller?(id: string): Promise<{
    opened: boolean
    url?: string
    name?: string
    error?: string
  }>
  /** launch an installed provider without the renderer supplying a path */
  launchOnlineProvider?(payload: {
    id: string
    providerId: string
    seasonId: string
    version: string
    path: string
  }): Promise<OnlineProviderLaunchResult>
  window?: WindowControls
}

declare global {
  interface Window {
    arc?: LauncherBridge
  }
}

export function hasNativeBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.arc?.launchBuild === 'function'
}

export function hasWindowControls(): boolean {
  return typeof window !== 'undefined' && typeof window.arc?.window?.minimize === 'function'
}

export function canDownloadBuilds(): boolean {
  return typeof window !== 'undefined' && typeof window.arc?.downloadBuild === 'function'
}

/** Electron prefixes IPC errors with boilerplate; strip it for the UI. */
export function cleanIpcError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  return new Error(cleaned || 'Something went wrong.')
}

export async function launchBuild(
  build: Build,
  username?: string,
  inventory?: InventoryPayload,
  join?: { host: string; port: number },
  fallbackToHost = false,
  runtimeProfile?: 'legacy' | 'modern',
): Promise<{ pid: number | null; privateServer?: boolean; matchmaking?: boolean; joined?: string | null }> {
  if (!hasNativeBridge()) {
    throw new Error('Launching needs the desktop app — run "npm run app".')
  }

  try {
    return await window.arc!.launchBuild({
      id: build.id,
      path: build.path,
      executable: build.executable,
      version: build.version,
      username,
      inventory,
      joinHost: join?.host,
      joinPort: join?.port,
      joinFallback: join ? fallbackToHost : undefined,
      runtimeProfile,
    })
  } catch (error) {
    throw cleanIpcError(error)
  }
}

/**
 * Mirrors the account's owned shop items into the private server profile. This
 * is intentionally best-effort outside the desktop shell; the launch payload
 * performs the same sync again before the client starts.
 */
export async function syncVaultedInventory(
  payload: InventoryPayload & { username?: string },
): Promise<InventorySyncResult> {
  if (!payload.username || typeof window === 'undefined' || !window.arc?.syncInventory) {
    return { synced: false, reason: 'desktop-only' }
  }
  try {
    return await window.arc.syncInventory({
      username: payload.username,
      items: payload.items,
      equipped: payload.equipped,
    })
  } catch (error) {
    return { synced: false, error: cleanIpcError(error).message }
  }
}

export async function closeBuildProcess(id: string): Promise<boolean> {
  if (!window.arc?.closeBuild) return false
  try {
    const result = await window.arc.closeBuild({ id })
    return Boolean(result?.closed)
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function checkInstalledBuilds(builds: Build[]): Promise<Record<string, boolean>> {
  if (!window.arc?.checkBuilds) return {}
  try {
    return await window.arc.checkBuilds(
      builds.map((build) => ({ id: build.id, executable: build.executable, path: build.path })),
    )
  } catch {
    return {}
  }
}

/** Starts an external launcher with this season's build folder as the target. */
export async function launchProfileBuild(
  build: Build,
  executablePath: string,
): Promise<{ pid: number | null; privateServer?: boolean; matchmaking?: boolean; joined?: string | null; external?: boolean }> {
  if (!window.arc?.launchProfileBuild) {
    throw new Error('Launching a configured external launcher needs the desktop app.')
  }
  try {
    return await window.arc.launchProfileBuild({
      id: build.id,
      path: build.path,
      executable: executablePath,
    })
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function detectOnlineProvider(providerId: string): Promise<OnlineProviderDetection> {
  if (!window.arc?.detectOnlineProvider) return { providerId, installed: false }
  try {
    return await window.arc.detectOnlineProvider(providerId)
  } catch (error) {
    return { providerId, installed: false, error: cleanIpcError(error).message }
  }
}

export async function openOnlineProviderInstaller(
  provider: OnlineProviderConfig,
): Promise<{ opened: boolean; url?: string; name?: string; error?: string }> {
  if (window.arc?.openOnlineProviderInstaller) {
    try {
      return await window.arc.openOnlineProviderInstaller(provider.id)
    } catch (error) {
      return { opened: false, url: provider.installerUrl, error: cleanIpcError(error).message }
    }
  }
  if (typeof window !== 'undefined' && /^https:\/\//i.test(provider.installerUrl)) {
    window.open(provider.installerUrl, '_blank', 'noopener,noreferrer')
    return { opened: true, url: provider.installerUrl, name: provider.name }
  }
  return { opened: false, url: provider.installerUrl, error: 'The installer needs the desktop app.' }
}

export async function launchOnlineProvider(
  build: Build,
  provider: OnlineProviderConfig,
): Promise<OnlineProviderLaunchResult> {
  if (!window.arc?.launchOnlineProvider) {
    throw new Error('Online community clients need the desktop app.')
  }
  try {
    return await window.arc.launchOnlineProvider({
      id: build.id,
      providerId: provider.id,
      seasonId: artKeyFor(build.season) ?? build.id,
      version: build.version,
      path: build.path,
    })
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function startDownload(
  id: string,
  key: string,
  url: string,
  sha256?: string,
  fallbackUrl?: string,
): Promise<DownloadResult> {
  if (!window.arc?.downloadBuild) {
    throw new Error('Downloads need the desktop app — run "npm run app".')
  }

  try {
    return await window.arc.downloadBuild({ id, key, url, sha256, fallbackUrl })
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function deleteBuild(id: string, path: string): Promise<{ deleted: boolean; managed: boolean; running?: boolean }> {
  if (!window.arc?.deleteBuild) return { deleted: false, managed: false }
  try {
    return await window.arc.deleteBuild({ id, path })
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function verifyBuildFiles(id: string, path: string, executable: string): Promise<BuildVerifyReport> {
  if (!window.arc?.verifyBuild) {
    throw new Error('Verify files needs the desktop app — run "npm run app".')
  }
  try {
    return await window.arc.verifyBuild({ id, path, executable })
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function cancelDownload(id: string): Promise<void> {
  try {
    await window.arc?.cancelDownload?.({ id })
  } catch {
    /* aborted anyway */
  }
}

export async function pauseDownload(id: string): Promise<boolean> {
  if (!window.arc?.pauseDownload) return false
  try {
    const result = await window.arc.pauseDownload({ id })
    return Boolean(result?.paused)
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export function subscribeDownloadProgress(callback: (progress: DownloadProgress) => void): () => void {
  return window.arc?.onDownloadProgress?.(callback) ?? (() => {})
}

export function subscribeBuildExit(callback: (payload: BuildExitInfo) => void): () => void {
  return window.arc?.onBuildExited?.(callback) ?? (() => {})
}

export function subscribeJoinFailed(
  callback: (payload: { id?: string; host: string; port: number; reason: string }) => void,
): () => void {
  return window.arc?.onJoinFailed?.(callback) ?? (() => {})
}

export async function scanInstalledBuilds(roots: string[] = []): Promise<string[]> {
  if (!window.arc?.scanBuilds) return []
  try {
    const folders = await window.arc.scanBuilds(roots.filter((root) => typeof root === 'string' && root.trim()))
    return Array.isArray(folders) ? folders.filter((folder) => typeof folder === 'string') : []
  } catch {
    return []
  }
}

export async function pickBuildFolder(): Promise<string | null> {
  if (!window.arc?.pickFolder) return null
  try {
    return await window.arc.pickFolder()
  } catch (error) {
    throw cleanIpcError(error)
  }
}

/** Folder picker for the cloud source's default install directory. */
export async function pickInstallDir(): Promise<string | null> {
  if (!window.arc?.pickInstallDir) return null
  try {
    return await window.arc.pickInstallDir()
  } catch (error) {
    throw cleanIpcError(error)
  }
}
