#!/usr/bin/env node
'use strict'

/**
 * Live catalog audit. Run it from the repository root:
 *
 *   npm run audit:providers
 *
 * It is intentionally not part of `npm run dist`: packaging must stay
 * deterministic and offline-safe. The audit checks every public route that the
 * renderer can open, plus Discord invite metadata (guild id, name, members)
 * for every configured gate.
 */

const fs = require('node:fs')
const path = require('node:path')

const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'resources', 'providers', 'provider.json'), 'utf8'),
)
const TIMEOUT_MS = 15_000
const ROUTE_KEYS = ['website', 'backendUrl', 'statusUrl', 'launchUrl']

function routeList() {
  const seen = new Set()
  const routes = []
  for (const provider of catalog.providers || []) {
    for (const key of ROUTE_KEYS) {
      const value = typeof provider[key] === 'string' ? provider[key].trim() : ''
      if (!/^https?:\/\//i.test(value) || seen.has(value)) continue
      // discord.com/ is only a host placeholder for Discord-only providers.
      if (/^https:\/\/discord\.com\/?$/i.test(value)) continue
      seen.add(value)
      routes.push({ providerId: provider.id, key, url: value })
    }
  }
  return routes
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkRoute(route) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(route.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 VAULTED-Launcher provider audit' },
    })
    // 401/403/429 mean a protected page exists. 404/410 and any 5xx mean the
    // route is gone or broken and must not remain in the catalog.
    const ok = response.status < 500 && ![404, 410].includes(response.status)
    return { ...route, status: response.status, ok, finalUrl: response.url }
  } catch (error) {
    return {
      ...route,
      status: null,
      ok: false,
      error: error?.cause?.code || error?.name || String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

function inviteCode(url) {
  const match = String(url).match(/discord(?:\.gg|\.com\/invite)\/([A-Za-z0-9-]{2,64})/i)
  return match ? match[1] : ''
}

async function checkInvite(provider) {
  const gate = provider.discordGate
  if (!gate?.inviteUrl) return null
  const code = inviteCode(gate.inviteUrl)
  if (!code) return { ...provider, ok: false, error: 'no invite code' }
  try {
    let response = await fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    let payload = await response.json()
    if (response.status === 429) {
      await sleep(Math.max(2000, Number(payload?.retry_after) * 1000 || 3000))
      response = await fetch(
        `https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      )
      payload = await response.json()
    }
    const guildId = String(payload?.guild?.id || '')
    const configuredId = String(gate.guildId || '')
    // Discord rate-limits its public invite lookup per IP. A 429 (or an empty
    // payload with no guild and no message) is not evidence that the invite is
    // dead, so it must not fail the catalog audit.
    if (response.status === 429 || (!guildId && !payload?.message)) {
      return { providerId: provider.id, code, ok: true, skipped: 'Discord rate limit' }
    }
    const ok =
      response.ok &&
      Boolean(payload?.guild?.name) &&
      (!configuredId || configuredId === guildId)
    return {
      providerId: provider.id,
      code,
      ok,
      guild: payload?.guild?.name || '',
      guildId,
      members: payload?.approximate_member_count,
      online: payload?.approximate_presence_count,
      error: ok ? '' : payload?.message || `guild id mismatch (${configuredId} vs ${guildId})`,
    }
  } catch (error) {
    return { providerId: provider.id, code, ok: false, error: error?.message || String(error) }
  }
}

async function main() {
  const routes = routeList()
  const routeResults = []
  for (const route of routes) routeResults.push(await checkRoute(route))
  const inviteResults = []
  for (const provider of catalog.providers || []) {
    if (!provider.discordGate?.inviteUrl) continue
    // Discord's public invite lookup is rate limited per IP. Leave a gap so a
    // full-catalog audit does not turn a healthy community into a false fail.
    await sleep(1200)
    const result = await checkInvite(provider)
    if (result) inviteResults.push(result)
  }

  for (const result of routeResults) {
    const status = result.status === null ? result.error : result.status
    console.log(`${result.ok ? 'OK  ' : 'FAIL'} ${status}\t${result.providerId}\t${result.key}\t${result.url}`)
  }
  for (const result of inviteResults) {
    console.log(
      `${result.skipped ? 'SKIP' : result.ok ? 'OK  ' : 'FAIL'} invite\t${result.providerId}\t${result.code}\t${
        result.skipped || result.guild || result.error
      }${result.members !== undefined ? ` (${result.members} members, ${result.online ?? 0} online)` : ''}`,
    )
  }

  const failures = [
    ...routeResults.filter((result) => !result.ok),
    ...inviteResults.filter((result) => !result.ok),
  ]
  console.log(
    `\n${catalog.providers?.length || 0} providers · ${routeResults.length} routes · ${inviteResults.length} Discord gates · ${failures.length} failed`,
  )
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
