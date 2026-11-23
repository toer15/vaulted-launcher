import type {
  AutoFixProgress,
  AutoFixRepairResult,
  AutoFixScanResult,
} from '../types'

export interface AutoFixTarget {
  id: string
  path: string
  executable: string
  providerId?: string
  seasonId?: string
}

export async function scanAutoFix(
  target: AutoFixTarget,
  deep = true,
): Promise<AutoFixScanResult> {
  if (!window.arc?.autoFix?.scan) {
    throw new Error('Auto-Fix needs the desktop app. Run "npm run app".')
  }
  return window.arc.autoFix.scan({ ...target, deep })
}

export async function repairAutoFix(
  target: AutoFixTarget,
  options: { forceLauncher?: boolean } = {},
): Promise<AutoFixRepairResult> {
  if (!window.arc?.autoFix?.repair) {
    throw new Error('Auto-Fix needs the desktop app. Run "npm run app".')
  }
  return window.arc.autoFix.repair({ ...target, ...options })
}

export function subscribeAutoFixProgress(
  callback: (progress: AutoFixProgress) => void,
): () => void {
  return window.arc?.autoFix?.onProgress?.(callback) ?? (() => {})
}
