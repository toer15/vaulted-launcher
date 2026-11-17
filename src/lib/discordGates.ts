import type { DiscordGate, DiscordGateVerification } from '../types'

const STORAGE_KEY = 'vaulted.discordGates.v1'

/**
 * Discord unlocks are community-specific and intentionally local to this PC.
 * A malformed/stale entry is ignored so it cannot lock or unlock the wrong
 * season after a catalog update.
 */
export function loadDiscordGateVerifications(): Record<string, DiscordGateVerification> {
  let parsed: unknown
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const result: Record<string, DiscordGateVerification> = {}
  for (const [providerId, value] of Object.entries(parsed)) {
    if (!providerId || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Partial<DiscordGateVerification>
    if (typeof entry.verifiedAt !== 'number' || !Number.isFinite(entry.verifiedAt)) continue
    if (entry.providerId && entry.providerId !== providerId) continue
    result[providerId] = {
      providerId,
      verifiedAt: entry.verifiedAt,
      ...(typeof entry.guildId === 'string' ? { guildId: entry.guildId } : {}),
      ...(typeof entry.guildName === 'string' ? { guildName: entry.guildName } : {}),
      ...(typeof entry.memberCount === 'number' ? { memberCount: entry.memberCount } : {}),
    }
  }
  return result
}

export function saveDiscordGateVerifications(
  value: Record<string, DiscordGateVerification>,
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    /* a full/sandboxed localStorage must not block Play */
  }
}

export function isDiscordGateVerified(
  verifications: Record<string, DiscordGateVerification>,
  gate: Pick<DiscordGate, 'providerId' | 'guildId'> | null | undefined,
): boolean {
  if (!gate) return false
  const verified = verifications[gate.providerId]
  if (!verified) return false
  // A community can rotate/repurpose an invite. Do not keep an unlock from a
  // different guild after the trusted catalog has pinned a new one.
  return !(gate.guildId && verified.guildId && gate.guildId !== verified.guildId)
}

/** Prefer the first community that has not been unlocked yet. */
export function nextDiscordGate(
  gates: DiscordGate[] | undefined,
  verifications: Record<string, DiscordGateVerification>,
): DiscordGate | null {
  const list = Array.isArray(gates) ? gates : []
  return list.find((gate) => !gate.statusOnly && !isDiscordGateVerified(verifications, gate)) ?? null
}