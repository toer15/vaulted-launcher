import type { Build } from '../types'

export interface LaunchPayload {
  id?: string
  path: string
  executable: string
  version: string
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
  phase: 'downloading' | 'extracting'
}

export interface DownloadResult {
  filePath: string
  executable: string | null
  folder: string
}

/**
 * Exposed by electron/preload.cjs. Every call is optional so the renderer still
 * type-checks (and degrades) outside the desktop shell.
 */
export interface LauncherBridge {
  platform?: string
  launchBuild(payload: LaunchPayload): Promise<{ pid: number | null }>
  closeBuild?(payload: { id: string }): Promise<{ closed: boolean }>
  checkBuilds?(builds: Array<{ id: string; executable: string }>): Promise<Record<string, boolean>>
  downloadBuild?(payload: { id: string; key: string; url: string }): Promise<DownloadResult>
  cancelDownload?(payload: { id: string }): Promise<{ cancelled: boolean }>
  onDownloadProgress?(callback: (progress: DownloadProgress) => void): () => void
  onBuildExited?(callback: (payload: { id: string }) => void): () => void
  pickFolder?(): Promise<string | null>
  scanBuilds?(): Promise<string[]>
  checkUpdates?(): Promise<{ ok: boolean; error?: string }>
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

export async function launchBuild(build: Build): Promise<{ pid: number | null }> {
  if (!hasNativeBridge()) {
    throw new Error('Launching needs the desktop app — run "npm run app".')
  }

  try {
    return await window.arc!.launchBuild({
      id: build.id,
      path: build.path,
      executable: build.executable,
      version: build.version,
    })
  } catch (error) {
    throw cleanIpcError(error)
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

export async function startDownload(id: string, key: string, url: string): Promise<DownloadResult> {
  if (!window.arc?.downloadBuild) {
    throw new Error('Downloads need the desktop app — run "npm run app".')
  }

  try {
    return await window.arc.downloadBuild({ id, key, url })
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
