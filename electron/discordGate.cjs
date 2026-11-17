'use strict'

/**
 * Resolve the public Discord invite behind a community gate.
 *
 * VAULTED never asks a community for a bot token. The invite endpoint proves
 * the community is still live and returns its guild identity, which is then
 * pinned by guild id when the provider config supplies one. The renderer
 * remembers the successful unlock locally; actual launch still goes through
 * the season's proven redirect/injector path.
 */

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_TIMEOUT_MS = 8_000

function inviteCode(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    return ''
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return ''
  const host = url.hostname.toLowerCase()
  const path = url.pathname.replace(/^\/+|\/+$/g, '')
  if (host === 'discord.gg' && /^[A-Za-z0-9-]{2,64}$/.test(path)) return path
  if (host === 'discord.com') {
    const match = /^invite\/([A-Za-z0-9-]{2,64})$/.exec(path)
    if (match) return match[1]
  }
  return ''
}

async function verifyDiscordCommunity(gate, options = {}) {
  const code = inviteCode(gate?.inviteUrl)
  if (!code) {
    throw new Error('This community has no usable Discord invite. Reinstall VAULTED or pick another season.')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS)
  try {
    const response = await (options.fetchImpl || fetch)(
      `${DISCORD_API}/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'VAULTED-Launcher' },
        cache: 'no-store',
        signal: controller.signal,
      },
    )
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.guild?.id) {
      const detail =
        payload && typeof payload.message === 'string' && payload.message.trim()
          ? ` (${payload.message.trim().slice(0, 120)})`
          : ''
      throw new Error(`That Discord invite is expired or unavailable${detail}. Open the invite again or pick another season.`)
    }
    const guildId = String(payload.guild.id)
    if (gate.guildId && guildId !== gate.guildId) {
      throw new Error('The Discord invite points at a different server than this season expects.')
    }
    const memberCount = Number(payload.approximate_member_count)
    return {
      ok: true,
      providerId: gate.providerId,
      guildId,
      guildName: typeof payload.guild.name === 'string' ? payload.guild.name.slice(0, 120) : gate.label,
      ...(Number.isFinite(memberCount) && memberCount >= 0
        ? { memberCount: Math.floor(memberCount) }
        : {}),
      inviteUrl: gate.inviteUrl,
      verifiedAt: Date.now(),
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Discord did not answer in time. Check your connection and try again.')
    }
    throw error instanceof Error ? error : new Error('Discord verification failed.')
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = { inviteCode, verifyDiscordCommunity }