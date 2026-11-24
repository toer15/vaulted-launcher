import { artKeyFor } from './art'
import type {
  AutoFixProgress,
  AutoFixRepairResult,
  AutoFixScanResult,
  Build,
  BuildExitInfo,
  BuildVerifyReport,
  GlobalBackend,
  ProviderBuild,
  OnlineProviderConfig,
  ProviderAuthStatus,
  ProviderLiveStatus,
  ShopEquipped,
  ShopItemType,
} from '../types'
import type { CommunityServer, CommunityServerQuery, CommunityServerResult } from './network'

export interface ProviderLauncherStatus {
  providerId: string
  pid: number
  startedAt: string
}

export interface ProviderLauncherExit {
  providerId: string
  pid: number
  reason: string
}

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
      /** set to join a friend's lobby instead of starting a host */
  joinHost?: string
  joinPort?: number
  /** only automatic public-lobby joins are allowed to fall back to hosting */
  joinFallback?: boolean
  /** pre-assigned runtime for this build, from the season manifest */
  runtimeProfile?: 'legacy' | 'modern'
  /** request bot fill; main writes it only when the active runtime declares support */
  botFill?: boolean
}

export interface WindowControls {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
}

export interface OnlineProviderLaunchResult {
  installed: boolean
  launched: boolean
  providerId?: string
  name?: string
  pid?: number | null
  hookVerified?: boolean
  external?: boolean
  provider?: string
  error?: string
}

export interface ProviderPrepareResult {
  ok: boolean
  providerId: string
  label?: string
  cached?: boolean
  external?: boolean
  /** DLLs staged and verified by this prepare/download step. */
  dlls?: string[]
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
  phase: 'downloading' | 'verifying' | 'extracting' | 'runtime'
}

export interface ProviderRuntimeStatus {
  providerId: string
  required: boolean
  label: string
  installed: boolean
}

/** One installer the player downloaded from a community Discord. */
export interface CommunityLauncherCandidate {
  name: string
  path: string
  size: number
  modifiedAt: string
  kind: string
}

export interface CommunityLauncherScan {
  safe: boolean
  reason?: string
  name?: string
  size?: number
  sha256?: string
  defender?: 'clean' | 'threats' | 'unavailable'
}

export interface CommunityLauncherStatus {
  providerId: string
  installed: boolean
  executableName?: string
  installerName?: string
  sha256?: string
  defender?: string
  installedAt?: string
}

export interface ProviderLauncherDetection {
  providerId: string
  label: string
  installed: boolean
}

export interface ProviderRuntimeProgress {
  providerId: string
  label?: string
  /** `dlls` stages the redirect/runtime DLLs during the launcher download. */
  phase: 'downloading' | 'dlls' | 'installing' | 'done' | 'error'
  percent: number | null
  received: number
  total: number
  etaSeconds: number | null
  bytesPerSecond: number | null
  error?: string
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
  /** archive was checked against every expected provider manifest file */
  manifestVerified?: boolean
  manifestFiles?: number
  manifestBytes?: number
  /** signed desktop runtime prepared alongside the season build */
  runtimeVersion?: string
  runtimeInstalled?: boolean
  runtimeInstaller?: string
  runtimeExecutable?: string
  runtimeError?: string
}

export interface ProviderSyncResult {
  folder: string
  executable: string
  buildId: string
  buildName: string
  buildVersion: string
  files: number
  totalBytes: number
  downloadedBytes: number
  reusedBytes: number
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
    /** The local host failed before a client was launched. */
    localHostUnavailable?: boolean
    reason?: string
  }>
  lanIp?(): Promise<string | null>
  /** where friends should connect: public mapping when available, otherwise LAN */
  publicAddress?(): Promise<{ address: string; port: number; public: boolean; method: string } | null>
  /** live population written by the injected server during a hosted match */
  sessionStatus?(): Promise<{
    players: number
    humans: number
    bots: number
    phase: number
    updated: string
  } | null>
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
  /**
   * The real build inside an installed folder (Engine/Build/Build.version or
   * the shipping executable's FileVersion), so a season re-versioned from 3.0
   * to 3.6 cannot keep launching an old folder.
   */
  detectBuildVersion?(folder: string): Promise<{
    version: string
    changelist: number | null
    source: string
  }>
  /** open a verified community Discord invite through the OS */
  openDiscordInvite?(url: string): Promise<{ opened: boolean; url: string }>
  /**
   * Discord-hosted seasons are downloaded from the community itself. These
   * find a client build already sitting in Downloads and unpack it into the
   * season's existing folder, so the community's own file is what runs.
   */
  findSeasonArchives?(payload: {
    buildPath: string
    version: string
  }): Promise<Array<{ name: string; path: string; size: number; modifiedAt: string }>>
  importSeasonArchive?(payload: {
    buildId: string
    buildPath: string
    version: string
    archivePath: string
  }): Promise<{ ok: boolean; executable: string; root: string; archive: string }>
  downloadBuild?(payload: {
    id: string
    key: string
    url: string
    sha256?: string
    fallbackUrl?: string
    /** allow replacing an installed season folder with a provider repair archive */
    repair?: boolean
    /** folder name to prefer when an old nested build is also present */
    preferredFolder?: string
    /** validate every extracted file against this provider build manifest */
    providerId?: string
    seasonId?: string
    buildId?: string
    validateProvider?: boolean
  }): Promise<DownloadResult>
  /** download/repair a season from its provider's live chunk manifest */
  syncProviderBuild?(payload: {
    id: string
    key: string
    providerId: string
    seasonId: string
    buildId?: string
  }): Promise<ProviderSyncResult>
  deleteBuild?(payload: { id: string; path: string }): Promise<{ deleted: boolean; managed: boolean; running?: boolean }>
  cleanupBuildStorage?(): Promise<{ folders: string[]; freedBytes: number; removed: string[] }>
  verifyBuild?(payload: { id: string; path: string; executable: string }): Promise<BuildVerifyReport>
  /** Auto-Fix scan/repair for a downloaded season */
  autoFix?: {
    scan(payload: {
      id: string
      path: string
      executable: string
      providerId?: string
      seasonId?: string
      deep?: boolean
    }): Promise<AutoFixScanResult>
    repair(payload: {
      id: string
      path: string
      executable: string
      providerId?: string
      seasonId?: string
      forceLauncher?: boolean
    }): Promise<AutoFixRepairResult>
    onProgress(callback: (progress: AutoFixProgress) => void): () => void
  }
  cancelDownload?(payload: { id: string }): Promise<{ cancelled: boolean }>
  pauseDownload?(payload: { id: string }): Promise<{ paused: boolean }>
  /** partial downloads left behind by a crash, quit, or network stop */
  listInterruptedDownloads?(): Promise<InterruptedDownload[]>
  onDownloadProgress?(callback: (progress: DownloadProgress) => void): () => void
  onBuildExited?(callback: (payload: BuildExitInfo) => void): () => void
  onProviderLauncherExited?(callback: (payload: ProviderLauncherExit) => void): () => void
  /** main observed the season launcher's real game process */
  onCompanionGameStarted?(callback: (payload: { providerId: string; pid: number }) => void): () => void
  /** the launcher opened but Fortnite never started (firewall prompt, closed, …) */
  onCompanionGameTimeout?(callback: (payload: { providerId: string; message: string }) => void): () => void
  /** main's in-session heartbeat could not keep the account session alive */
  onProviderSessionExpired?(callback: (payload: {
    providerId: string
    label: string
    message: string
  }) => void): () => void
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
  /** pick and verify an existing Fortnite build folder */
  linkBuildFolder?(): Promise<
    { ok: true; folder: string; executable: string } | { ok: false; error: string } | null
  >
  /** total bytes on disk for an installed build */
  buildSize?(folder: string): Promise<number | null>
  /** open an installed build in Windows Explorer */
  openBuildFolder?(folder: string): Promise<{ ok: boolean; error?: string }>
  /** CORS-free text fetch through the Electron main process */
  fetchText?(url: string, options?: { method?: 'GET' | 'POST'; body?: string }): Promise<{
    ok: boolean
    status: number
    url: string
    text: string
    error?: string
  }>
  /** configured public community directories, resolved in the main process */
  fetchCommunityServers?(query: CommunityServerQuery): Promise<CommunityServerResult>
  /** live global OGFN backends from resources/providers/provider.json */
  providerCatalog?(): Promise<GlobalBackend[]>
  /** Detect an installed community launcher without downloading anything. */
  providerLauncherDetect?(providerId: string): Promise<ProviderLauncherDetection | null>
  /** Verify the public invite for a Discord-gated community. */
  discordGateVerify?(providerId: string): Promise<{
    ok: boolean
    providerId: string
    guildId: string
    guildName?: string
    memberCount?: number
    inviteUrl: string
    verifiedAt: number
  }>
  /** Open a validated Discord invite in the user's Discord/browser. */
  /** health and population sampled from the configured global backends */
  providerLiveStatus?(): Promise<Record<string, ProviderLiveStatus>>
  /** repair the bundled, hash-checked provider files before one-click launch */
  providerPrepare?(providerId: string): Promise<ProviderPrepareResult>
  /** live provider builds for providers with runtime season discovery */
  providerBuilds?(providerId: string): Promise<ProviderBuild[]>
  /** native provider account link for global_live backends */
  providerAuth?: {
    status(): Promise<Record<string, ProviderAuthStatus>>
    login(providerId: string, method?: 'discord' | 'google'): Promise<ProviderAuthStatus>
    /** silent rotating refresh; throws a re-auth marker when rejected */
    refresh?(providerId: string): Promise<ProviderAuthStatus & { refreshed?: boolean }>
    /** explicit account verification; never invoked by Play */
    verifyAccount?(
      providerId: string,
      options?: { seasonId?: string; version?: string },
    ): Promise<{ code: string; expiresIn: number; buildId: string; buildName: string }>
    logout(providerId: string): Promise<ProviderAuthStatus>
    /** main broadcasts a provider-wide status after any account link change */
    onProviderAuthChanged?(callback: (status: ProviderAuthStatus) => void): () => void
  }
  /** validate and measure a public manual game-server address */
  probeServer?(payload: { host: string; port: number }): Promise<{
    reachable: boolean
    pingMs?: number
    host?: string
    port?: number
    method?: 'tcp' | 'icmp'
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
  /** open a signed third-party launcher that owns its own anticheat/runtime */
  openProviderLauncher?(
    providerId: string,
    options?: {
      version?: string
      gameVersion?: string
      name?: string
      folder?: string
      executable?: string
    },
  ): Promise<{
    opened: boolean
    path?: string
    url?: string
    error?: string
    args?: string[]
    version?: string
    pid?: number | null
    tracked?: boolean
    /** main is starting the launcher's own game and will report the real PID */
    waitingForGame?: boolean
    /** the community step is required because no launcher is installed */
    community?: boolean
    /** invite the in-app community dialog can show; never opened by VAULTED */
    inviteUrl?: string
  }>
  stopProviderLauncher?(providerId: string): Promise<{ stopped: boolean }>
  providerLauncherStatus?(): Promise<ProviderLauncherStatus[]>
  providerRuntimeStatus?(providerId: string): Promise<ProviderRuntimeStatus | null>
  installProviderRuntime?(providerId: string): Promise<{
    ok: boolean
    providerId: string
    label: string
    version: string
    installed: boolean
    /** DLLs staged and verified during the launcher download step. */
    dlls?: string[]
  }>
  onRuntimeProgress?(callback: (progress: ProviderRuntimeProgress) => void): () => void
  /** launch a downloaded season through its bundled provider profile */
  launchOnlineProvider?(payload: {
    id: string
    providerId: string
    seasonId: string
    version: string
    buildFolderPath: string
    /** connected VAULTED account, used for companion launches without a provider code */
    username?: string
    joinHost?: string
    joinPort?: number
  }): Promise<OnlineProviderLaunchResult>
  /** Discord-community launchers the player downloads and imports by hand */
  communityLauncher?: {
    candidates(): Promise<CommunityLauncherCandidate[]>
    scan(providerId: string, file: string): Promise<CommunityLauncherScan>
    import(
      providerId: string,
      file: string,
    ): Promise<{
      ok: boolean
      executableName?: string
      defender?: string
      sha256?: string
    }>
    status(providerId: string): Promise<CommunityLauncherStatus | null>
    forget(providerId: string): Promise<{ cleared: boolean }>
    pick(): Promise<string | null>
  }
  /** absolute path for a file dropped onto the window (Electron webUtils) */
  pathForFile?(file: File): string
  window?: WindowControls
}

declare global {
  interface Window {
    arc?: LauncherBridge
  }
}

/** Major.minor of a catalog or on-disk version; "3.6.0-CL-4019403" gives "3.6". */
function versionKeyOf(value: string | null | undefined): string | null {
  const match = String(value || '').match(/(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?(?!\d)/)
  return match ? `${Number(match[1])}.${Number(match[2])}` : null
}

/**
 * True unless both sides name a real build and those builds differ. An unknown
 * installed version (no Build.version, unreadable executable) never blocks a
 * launch on its own.
 */
export function sameBuildVersion(
  installed: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const left = versionKeyOf(installed)
  const right = versionKeyOf(expected)
  if (!left || !right) return true
  return left === right
}

/**
 * Open a community's verified Discord invite. Main re-checks the host allowlist;
 * the plain-browser build falls back to a new tab so the button still works.
 */
export async function openDiscordInvite(url: string): Promise<boolean> {
  const invite = String(url || '').trim()
  if (!/^https:\/\/discord\.(?:gg|com)\//i.test(invite)) return false
  if (typeof window === 'undefined') return false
  if (typeof window.arc?.openDiscordInvite === 'function') {
    try {
      const result = await window.arc.openDiscordInvite(invite)
      return result?.opened === true
    } catch {
      return false
    }
  }
  window.open(invite, '_blank', 'noopener,noreferrer')
  return true
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
  options: { botFill?: boolean } = {},
): Promise<{
  pid: number | null
  privateServer?: boolean
  matchmaking?: boolean
  joined?: string | null
  localHostUnavailable?: boolean
  reason?: string
}> {
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
      botFill: options.botFill === true,
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

/** Launches a downloaded season through its bundled provider profile. */
export async function launchOnlineProvider(
  build: Build,
  provider: OnlineProviderConfig,
  server?: Pick<CommunityServer, 'host' | 'port'> | null,
  username?: string,
): Promise<OnlineProviderLaunchResult> {
  if (!window.arc?.launchOnlineProvider) {
    throw new Error('Online play needs the desktop app.')
  }
  try {
    return await window.arc.launchOnlineProvider({
      id: build.id,
      providerId: provider.id,
      seasonId: artKeyFor(build.season) ?? build.id,
      version: build.version,
      buildFolderPath: build.path,
      ...(username ? { username } : {}),
      ...(server ? { joinHost: server.host, joinPort: server.port } : {}),
    })
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function syncProviderBuild(payload: {
  id: string
  key: string
  providerId: string
  seasonId: string
  buildId?: string
}): Promise<ProviderSyncResult> {
  if (!window.arc?.syncProviderBuild) {
    throw new Error('Provider build updates need the desktop app — run "npm run app".')
  }
  try {
    return await window.arc.syncProviderBuild(payload)
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
  options: {
    repair?: boolean
    preferredFolder?: string
    providerId?: string
    seasonId?: string
    buildId?: string
    validateProvider?: boolean
  } = {},
): Promise<DownloadResult> {
  if (!window.arc?.downloadBuild) {
    throw new Error('Downloads need the desktop app — run "npm run app".')
  }

  try {
    return await window.arc.downloadBuild({
      id,
      key,
      url,
      sha256,
      fallbackUrl,
      ...(options.repair ? { repair: true } : {}),
      ...(options.preferredFolder ? { preferredFolder: options.preferredFolder } : {}),
      ...(options.providerId ? { providerId: options.providerId } : {}),
      ...(options.seasonId ? { seasonId: options.seasonId } : {}),
      ...(options.buildId ? { buildId: options.buildId } : {}),
      ...(options.validateProvider ? { validateProvider: true } : {}),
    })
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function cleanupBuildStorage(): Promise<{
  folders: string[]
  freedBytes: number
  removed: string[]
}> {
  if (!window.arc?.cleanupBuildStorage) return { folders: [], freedBytes: 0, removed: [] }
  try {
    return await window.arc.cleanupBuildStorage()
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

export async function fetchProviderRuntimeStatus(
  providerId: string,
): Promise<ProviderRuntimeStatus | null> {
  if (!window.arc?.providerRuntimeStatus) return null
  try {
    return await window.arc.providerRuntimeStatus(providerId)
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function detectProviderLauncher(
  providerId: string,
): Promise<ProviderLauncherDetection | null> {
  if (!window.arc?.providerLauncherDetect) return null
  try {
    return await window.arc.providerLauncherDetect(providerId)
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function installProviderRuntime(providerId: string) {
  if (!window.arc?.installProviderRuntime) {
    throw new Error('Companion runtime installation needs the desktop app.')
  }
  try {
    return await window.arc.installProviderRuntime(providerId)
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export function subscribeProviderRuntimeProgress(
  callback: (progress: ProviderRuntimeProgress) => void,
): () => void {
  return window.arc?.onRuntimeProgress?.(callback) ?? (() => {})
}

export function subscribeBuildExit(callback: (payload: BuildExitInfo) => void): () => void {
  return window.arc?.onBuildExited?.(callback) ?? (() => {})
}

export function subscribeProviderSessionExpired(
  callback: (payload: { providerId: string; label: string; message: string }) => void,
): () => void {
  return window.arc?.onProviderSessionExpired?.(callback) ?? (() => {})
}

export function subscribeProviderLauncherExit(
  callback: (payload: ProviderLauncherExit) => void,
): () => void {
  return window.arc?.onProviderLauncherExited?.(callback) ?? (() => {})
}

export function subscribeCompanionGameStarted(
  callback: (payload: { providerId: string; pid: number }) => void,
): () => void {
  return window.arc?.onCompanionGameStarted?.(callback) ?? (() => {})
}

export function subscribeCompanionGameTimeout(
  callback: (payload: { providerId: string; message: string }) => void,
): () => void {
  return window.arc?.onCompanionGameTimeout?.(callback) ?? (() => {})
}

export async function stopProviderLauncher(providerId: string): Promise<boolean> {
  if (!window.arc?.stopProviderLauncher) return false
  try {
    const result = await window.arc.stopProviderLauncher(providerId)
    return result?.stopped === true
  } catch (error) {
    throw cleanIpcError(error)
  }
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

/** Native picker that verifies FortniteClient-Win64-Shipping.exe before linking. */
export async function pickExistingBuildFolder(): Promise<
  { ok: true; folder: string; executable: string } | { ok: false; error: string } | null
> {
  if (!window.arc?.linkBuildFolder) return null
  try {
    return await window.arc.linkBuildFolder()
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function getBuildSize(folder: string): Promise<number | null> {
  if (!window.arc?.buildSize || !folder) return null
  try {
    const size = await window.arc.buildSize(folder)
    return typeof size === 'number' && Number.isFinite(size) ? size : null
  } catch {
    return null
  }
}

export async function openBuildFolder(folder: string): Promise<{ ok: boolean; error?: string }> {
  if (!window.arc?.openBuildFolder) return { ok: false, error: 'Opening folders needs the desktop app.' }
  try {
    return await window.arc.openBuildFolder(folder)
  } catch (error) {
    return { ok: false, error: cleanIpcError(error).message }
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

/** Installers already sitting in this PC's Downloads folder. */
export async function listCommunityLauncherCandidates(): Promise<CommunityLauncherCandidate[]> {
  if (!window.arc?.communityLauncher) return []
  try {
    return await window.arc.communityLauncher.candidates()
  } catch {
    return []
  }
}

export async function fetchCommunityLauncherStatus(
  providerId: string,
): Promise<CommunityLauncherStatus | null> {
  if (!window.arc?.communityLauncher) return null
  try {
    return await window.arc.communityLauncher.status(providerId)
  } catch {
    return null
  }
}

/**
 * Scan + install one community launcher. Main refuses anything that fails the
 * SFX/dropper, Defender or local-backend gate, so an error here is the block.
 */
export async function importCommunityLauncherFile(
  providerId: string,
  file: string,
): Promise<{ ok: boolean; portable?: boolean; executableName?: string; defender?: string }> {
  if (!window.arc?.communityLauncher) {
    throw new Error('Importing a community launcher needs the desktop app.')
  }
  try {
    return await window.arc.communityLauncher.import(providerId, file)
  } catch (error) {
    throw cleanIpcError(error)
  }
}

export async function pickCommunityLauncherFile(): Promise<string | null> {
  if (!window.arc?.communityLauncher) return null
  try {
    return await window.arc.communityLauncher.pick()
  } catch (error) {
    throw cleanIpcError(error)
  }
}

/** Absolute path of a file the player dropped onto VAULTED. */
export function droppedFilePath(file: File): string {
  return window.arc?.pathForFile?.(file) || ''
}
