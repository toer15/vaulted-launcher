import type { Build } from '../types'

// the library carries every season, not just the handful of demo builds
const STORAGE_KEY = 'vaulted.launcher.v1'

export interface PersistedState {
  builds: Build[]
  activeId: string | null
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as PersistedState
    if (!Array.isArray(parsed.builds)) return null

    return {
      builds: parsed.builds,
      activeId: parsed.activeId ?? parsed.builds[0]?.id ?? null,
    }
  } catch {
    return null
  }
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* storage full / disabled — the launcher still works for this session */
  }
}
