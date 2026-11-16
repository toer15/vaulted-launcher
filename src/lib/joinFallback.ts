/**
 * Coordinates automatic public-lobby joins and the one local-host fallback
 * that is allowed when such a join fails after the client has launched.
 *
 * Two things need to be true at once:
 *  - a join failure may close the failed client and start the local host only
 *    once, even if main emits a duplicate failure;
 *  - the original launch call can resolve after that fallback has started. Its
 *    completion must be ignored rather than restoring "running/joined" state or
 *    starting a second host.
 */

export type LaunchKind = 'join' | 'host'

export interface JoinFailurePayload {
  id?: string
  host: string
  port: number
  reason: string
}

interface CurrentLaunch {
  id: string
  kind: LaunchKind
  token: number
}

export class LaunchAttemptTracker {
  private sequence = 0
  private current: CurrentLaunch | null = null

  start(id: string, kind: LaunchKind): number {
    const token = ++this.sequence
    this.current = { id, kind, token }
    return token
  }

  /**
   * A completion is allowed to update the UI only while it still belongs to the
   * latest launch attempt. Starting the fallback or another launch supersedes
   * it immediately.
   */
  isCurrent(token: number): boolean {
    return this.current?.token === token
  }

  /**
   * Apply a launch completion only if its attempt is still current. App uses
   * this for the post-await running-state update; the integration simulation
   * calls the same method, so a late launch cannot silently overwrite the
   * fallback through a test-only mirror of the guard.
   */
  commitIfCurrent(token: number, apply: () => void): boolean {
    if (!this.isCurrent(token)) return false
    apply()
    return true
  }

  /**
   * Claim the one fallback for the current automatic join. Claiming clears the
   * attempt before the asynchronous close begins, so a duplicate event cannot
   * claim it again and a late completion from the failed launch is stale.
   */
  claimJoinFallback(id?: string): boolean {
    const current = this.current
    if (!current || current.kind !== 'join') return false
    if (id && current.id !== id) return false
    this.current = null
    return true
  }
}

/**
 * Serializes lobby removal and lets the fallback wait for a stop queued by the
 * failed join. A token identifies the launch that requested the stop; if that
 * launch is superseded before the queued work runs, no request is sent.
 */
export interface HostingStopQueueOptions {
  stop(): Promise<unknown>
  isCurrent(token: number): boolean
}

export class HostingStopQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly options: HostingStopQueueOptions

  constructor(options: HostingStopQueueOptions) {
    this.options = options
  }

  stopFor(token?: number): Promise<void> {
    const next = this.tail
      .catch(() => {})
      .then(async () => {
        if (token !== undefined && !this.options.isCurrent(token)) return
        await this.options.stop().catch(() => {})
      })
    this.tail = next
    return next
  }

  /** Wait for every stop requested before this call. */
  wait(): Promise<void> {
    return this.tail.catch(() => {})
  }
}

export interface JoinFallbackHooks {
  /** Close the client that failed to join. Errors are deliberately ignored. */
  closeFailedClient(): Promise<unknown>
  /** Clear the failed join state and stop advertising the old lobby. */
  prepareHost(): void | Promise<void>
  /** Explain the fallback to the player before the new launch starts. */
  announce(): void
  /** Launch the selected season without a join target. */
  startHost(): Promise<void>
}

/**
 * Run the real close -> prepare -> announce -> force-host sequence.
 *
 * Returns false when this is not the current automatic join or when its one
 * fallback was already claimed. The exactly-once claim happens before any await,
 * so concurrent duplicate events cannot both start a host.
 */
export async function runJoinFallback(
  attempts: LaunchAttemptTracker,
  payload: JoinFailurePayload,
  hooks: JoinFallbackHooks,
): Promise<boolean> {
  if (!attempts.claimJoinFallback(payload.id)) return false

  try {
    await hooks.closeFailedClient()
  } catch {
    // The failed client may already have exited.
  }

  await hooks.prepareHost()
  hooks.announce()
  await hooks.startHost()
  return true
}
