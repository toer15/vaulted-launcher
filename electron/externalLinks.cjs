'use strict'

/**
 * The only external links VAULTED opens itself: a community's verified Discord
 * invite. Everything else stays copy-only. The URL is parsed and pinned to a
 * Discord host before the OS sees it, so a corrupt catalog entry can never hand
 * `javascript:`, a loopback page, or a credential-bearing URL to the shell.
 */

const DISCORD_HOSTS = new Set([
  'discord.gg',
  'discord.com',
  'ptb.discord.com',
  'canary.discord.com',
  'discordapp.com',
])

/** discord.gg/<code>, discord.com/invite/<code> — nothing else is openable. */
const INVITE_PATH = /^\/(?:invite\/)?[A-Za-z0-9-]{2,64}\/?$/

/** Canonical invite URL, or null when the value is not a Discord invite. */
function safeDiscordInvite(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 2048) return null
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (url.port) return null
  if (!DISCORD_HOSTS.has(url.hostname.toLowerCase())) return null
  if (!INVITE_PATH.test(url.pathname)) return null
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Open the community invite in the player's Discord app through the OS.
 * `options.shell` is Electron's shell, injected so tests stay offline.
 */
async function openDiscordInvite(value, options = {}) {
  const safe = safeDiscordInvite(value)
  if (!safe) {
    throw new Error('VAULTED only opens a verified Discord invite link.')
  }
  const shell = options.shell
  if (!shell || typeof shell.openExternal !== 'function') {
    throw new Error('This build cannot open links on this PC.')
  }
  await shell.openExternal(safe)
  return { opened: true, url: safe }
}

module.exports = { DISCORD_HOSTS, openDiscordInvite, safeDiscordInvite }
