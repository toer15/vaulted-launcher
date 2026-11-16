import { DEFAULT_ONLINE_SERVICE_URL } from './onlineService'

/** Cloud source settings persisted in settings.json and mirrored to localStorage. */
export interface CloudSettings {
  /** direct manifest.json URL or storage bucket base URL */
  cloudSourceUrl: string
  /** HTTP(S) or WS(S) lobby/matchmaking service */
  onlineServiceUrl: string
  /** where downloaded seasons are unpacked; empty means the app default */
  defaultInstallDir: string
  /** register locally hosted sessions in the lobby list */
  hostPublicLobby: boolean
}

export const FALLBACK_INSTALL_DIR = '%APPDATA%\\VAULTED Launcher\\builds'
const CLOUD_SETTINGS_KEY = 'vaulted.cloud-source.v1'

function normalize(value: unknown, fallbackInstallDir = FALLBACK_INSTALL_DIR): CloudSettings {
  const raw = (value ?? {}) as {
    cloudSourceUrl?: unknown
    onlineServiceUrl?: unknown
    defaultInstallDir?: unknown
    hostPublicLobby?: unknown
  }
  return {
    cloudSourceUrl: typeof raw.cloudSourceUrl === 'string' ? raw.cloudSourceUrl.trim() : '',
    onlineServiceUrl:
      typeof raw.onlineServiceUrl === 'string'
        ? raw.onlineServiceUrl.trim()
        : DEFAULT_ONLINE_SERVICE_URL,
    defaultInstallDir:
      typeof raw.defaultInstallDir === 'string' && raw.defaultInstallDir.trim()
        ? raw.defaultInstallDir.trim()
        : fallbackInstallDir,
    hostPublicLobby: raw.hostPublicLobby !== false,
  }
}

export function readLocalCloudSettings(): CloudSettings {
  try {
    const raw = localStorage.getItem(CLOUD_SETTINGS_KEY)
    return normalize(raw ? JSON.parse(raw) : null)
  } catch {
    return normalize(null)
  }
}

export function saveLocalCloudSettings(settings: CloudSettings): CloudSettings {
  const next = normalize(settings)
  try {
    localStorage.setItem(CLOUD_SETTINGS_KEY, JSON.stringify(next))
  } catch {
    /* storage disabled — settings.json still holds the real copy */
  }
  return next
}

/** Native settings.json wins; localStorage is only the browser-preview fallback. */
export async function loadCloudSettings(): Promise<CloudSettings> {
  const local = readLocalCloudSettings()
  try {
    const native = await window.arc?.settings?.read?.()
    if (native) return saveLocalCloudSettings(normalize(native, local.defaultInstallDir))
  } catch {
    /* keep the local copy */
  }
  return local
}

/** Saves to settings.json and returns the canonical settings (including defaults). */
export async function persistCloudSettings(settings: CloudSettings): Promise<CloudSettings> {
  const next = normalize(settings)
  const bridge = window.arc?.settings
  if (bridge?.save) {
    const result = await bridge.save(next)
    if (!result?.ok) throw new Error(result?.error || 'Could not save the cloud source settings.')
    return saveLocalCloudSettings(normalize(result.settings ?? next, next.defaultInstallDir))
  }
  return saveLocalCloudSettings(next)
}
