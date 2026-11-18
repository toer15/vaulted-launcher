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

// discord.com is the canonical host, but its WAF intermittently answers API
// requests from desktop clients with HTTP 429 (Cloudflare 1015). The legacy
// discordapp.com host serves the same public invite endpoint and keeps the gate
// working without weakening the guild-id check.
const DISCORD_ENDPOINTS = [
  'https://discord.com/api/v10',
  'https://discordapp.com/api/v9',
  'https://discord.com/api/v9',
]
const DISCORD_TIMEOUT_MS = 8_000
const DISCORD_HEADERS = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  origin: 'https://discord.com',
  referer: 'https://discord.com/',
}

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
  const fetchImpl = options.fetchImpl || fetch
  let lastFailure = null
  try {
    for (const endpoint of DISCORD_ENDPOINTS) {
      try {
        const response = await fetchImpl(
          `${endpoint}/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`,
          {
            method: 'GET',
            headers: DISCORD_HEADERS,
            cache: 'no-store',
            signal: controller.signal,
          },
        )
        const payload = await response.json().catch(() => null)
        if (response.ok && payload?.guild?.id) {
          const guildId = String(payload.guild.id)
          if (gate.guildId && guildId !== gate.guildId) {
            throw new Error('The Discord invite points at a different server than this season expects.')
          }
          const memberCount = Number(payload.approximate_member_count)
          return {
            ok: true,
            providerId: gate.providerId,
            guildId,
            guildName:
              typeof payload.guild.name === 'string' ? payload.guild.name.slice(0, 120) : gate.label,
            ...(Number.isFinite(memberCount) && memberCount >= 0
              ? { memberCount: Math.floor(memberCount) }
              : {}),
            inviteUrl: gate.inviteUrl,
            verifiedAt: Date.now(),
          }
        }
        lastFailure = {
          status: Number(response.status) || 0,
          message:
            payload && typeof payload.message === 'string' && payload.message.trim()
              ? payload.message.trim().slice(0, 120)
              : '',
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        // A different server is a security failure, not a retryable endpoint
        // failure, so stop immediately and keep the guild identity pinned.
        if (error instanceof Error && /different server/i.test(error.message)) throw error
        lastFailure = { status: 0, message: error instanceof Error ? error.message : '' }
      }
    }

    if (lastFailure?.status === 404) {
      throw new Error(
        'That Discord invite is expired or unavailable. Open the invite again or pick another season.',
      )
    }
    const detail = lastFailure?.message ? ` (${lastFailure.message})` : ''
    throw new Error(
      `Discord could not verify this community${detail}. Check your connection and try again.`,
    )
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