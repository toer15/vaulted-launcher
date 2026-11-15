import type { Build, BuildVerifyReport, ShopEquipped, ShopItemType } from '../types'

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
}

export interface WindowControls {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
}

export interface DownloadProgress {
  id: string
  received: number
  total: number
  /** null when the server sends no content-length */
  percent: number | null
  /** estimated seconds left, or null while the rate is unknown */
  etaSeconds: number | null
  phase: 'downloading' | 'verifying' | 'extracting'
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
  checkBuilds?(builds: Array<{ id: string; executable: string }>): Promise<Record<string, boolean>>
  downloadBuild?(payload: { id: string; key: string; url: string; sha256?: string }): Promise<DownloadResult>
  deleteBuild?(payload: { id: string; path: string }): Promise<{ deleted: boolean; managed: boolean; running?: boolean }>
  verifyBuild?(payload: { id: string; path: string; executable: string }): Promise<BuildVerifyReport>
  cancelDownload?(payload: { id: string }): Promise<{ cancelled: boolean }>
  onDownloadProgress?(callback: (progress: DownloadProgress) => void): () => void
  onBuildExited?(callback: (payload: { id: string }) => void): () => void
  onLaunchStatus?(callback: (payload: { id?: string; message: string }) => void): () => void
  pickFolder?(): Promise<string | null>
  scanBuilds?(): Promise<string[]>
  checkUpdates?(): Promise<{ ok: boolean; version?: string | null; error?: string }>
  installUpdate?(): Promise<{ ok: boolean; error?: string }>
  onUpdateAvailable?(callback: (info: { version: string }) => void): () => void
  onUpdateDownloaded?(callback: (info: { version: string }) => void): () => void
  session?: {
    /** synchronous, so the first render already knows the user */
    readSync(): string | null
    save(value: string): Promise<boolean>
    clear(): Promise<boolean>
  }
  openExternal?(url: string): Promise<void>
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
function cleanIpcError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  return new Error(cleaned || 'Something went wrong.')
}

export async function launchBuild(
  build: Build,
  username?: string,
  inventory?: InventoryPayload,
  join?: { host: string; port: number },
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
    return await window.arc.checkBuilds(builds.map((build) => ({ id: build.id, executable: build.executable })))
  } catch {
    return {}
  }
}

export async function startDownload(id: string, key: string, url: string, sha256?: string): Promise<DownloadResult> {
  if (!window.arc?.downloadBuild) {
    throw new Error('Downloads need the desktop app — run "npm run app".')
  }

  try {
    return await window.arc.downloadBuild({ id, key, url, sha256 })
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

export function subscribeDownloadProgress(callback: (progress: DownloadProgress) => void): () => void {
  return window.arc?.onDownloadProgress?.(callback) ?? (() => {})
}

export function subscribeBuildExit(callback: (payload: { id: string }) => void): () => void {
  return window.arc?.onBuildExited?.(callback) ?? (() => {})
}

export async function scanInstalledBuilds(): Promise<string[]> {
  if (!window.arc?.scanBuilds) return []
  try {
    const folders = await window.arc.scanBuilds()
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
