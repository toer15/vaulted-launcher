#!/usr/bin/env node
'use strict'

/**
 * Season-level online audit.
 *
 *   npm run audit:seasons
 *
 * For every bundled season it prints the route VAULTED can actually launch:
 *
 *   - MANAGED   a hosted backend VAULTED can sign in to (Era, Stellar, EZFN,
 *               Retrac) and whose health probe answered.
 *   - LAUNCHER  an external project that hosts the season itself; VAULTED can
 *               only open that project's launcher, never inject into it.
 *   - UNAVAILABLE  no real server VAULTED can join. The card shows
 *               ONLINE UNAVAILABLE instead of starting a local lobby.
 *
 * It fails when a season still points at a removed provider (Neo / Neonite) or
 * at a loopback backend, so no local lobby can ever come back as a season route.
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const builds = JSON.parse(fs.readFileSync(path.join(root, 'src', 'assets', 'builds.json'), 'utf8'))
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'resources', 'providers', 'provider.json'), 'utf8'),
)
const { fetchProviderLiveStatuses } = require(path.join(root, 'electron', 'providerStatus.cjs'))

const REMOVED_PROVIDERS = new Set(['neo', 'neo-official', 'neonite'])
// Reboot always starts its embedded LawinServer on loopback; it is not a
// public online route even when it joins a community game server.
const BANNED_PROVIDERS = new Set(['reboot', 'reboot-official'])
const LOOPBACK = /(?:^|[/:@])(?:127\.0\.0\.1|localhost|\[::1\])(?:[/:]|$)/i
const MANAGED_MODES = new Set(['local', 'global_live'])

function routesFor(season) {
  const routes = [season.onlineProvider, ...(season.onlineProviders || [])].filter(
    (entry) => entry && typeof entry.id === 'string',
  )
  const unique = new Map()
  for (const route of routes) if (!unique.has(route.id)) unique.set(route.id, route)
  return [...unique.values()]
}

async function main() {
  const problems = []
  for (const season of Object.values(builds.seasons)) {
    for (const route of routesFor(season)) {
      if (REMOVED_PROVIDERS.has(route.id.trim().toLowerCase())) {
        problems.push(`${season.id} still routes through the removed ${route.label || route.id} provider`)
      }
      if (BANNED_PROVIDERS.has(route.id.trim().toLowerCase())) {
        problems.push(`${season.id} still routes through banned LawinServer launcher ${route.label || route.id}`)
      }
      const catalogEntry = catalog.providers.find((provider) => provider.id === route.id)
      for (const key of ['backendUrl', 'statusUrl']) {
        const value = catalogEntry?.[key]
        if (typeof value === 'string' && LOOPBACK.test(value)) {
          problems.push(`${season.id} points ${route.id}.${key} at a loopback backend (${value})`)
        }
      }
    }
  }

  const statuses = await fetchProviderLiveStatuses(catalog.providers)
  const rows = []
  for (const season of Object.values(builds.seasons)) {
    const routes = routesFor(season)
    const managed = routes.filter((route) => {
      const entry = catalog.providers.find((provider) => provider.id === route.id)
      return entry && MANAGED_MODES.has(entry.mode) && entry.auth && entry.auth !== 'none'
    })
    const reachableManaged = managed.filter(
      (route) => statuses[route.id]?.online === true,
    )
    const external = routes.filter((route) => {
      const entry = catalog.providers.find((provider) => provider.id === route.id)
      return entry?.mode === 'external'
    })
    const reachableExternal = external.filter((route) => statuses[route.id]?.online === true)
    const gates = Array.isArray(season.discordGates) ? season.discordGates.length : 0
    let state = 'UNAVAILABLE'
    let detail = 'no real server VAULTED can join'
    if (reachableManaged.length > 0) {
      state = 'MANAGED'
      detail = reachableManaged.map((route) => route.label || route.id).join(', ')
    } else if (reachableExternal.length > 0 || gates > 0) {
      state = 'LAUNCHER'
      detail = [
        ...reachableExternal.map((route) => route.label || route.id),
        ...(gates > 0 ? ['Discord gate'] : []),
      ].join(', ')
    } else if (managed.length > 0) {
      detail = `${managed.map((route) => route.label || route.id).join(', ')} health check failed`
    } else if (external.length > 0) {
      detail = `${external.map((route) => route.label || route.id).join(', ')} not reachable`
    }
    rows.push({ season, state, detail })
  }

  for (const { season, state, detail } of rows) {
    console.log(
      `${state.padEnd(11)} ${String(season.id).padEnd(10)} ${String(season.version).padEnd(6)} ${detail}`,
    )
  }
  const counts = rows.reduce((acc, row) => {
    acc[row.state] = (acc[row.state] || 0) + 1
    return acc
  }, {})
  console.log(
    `\n${rows.length} seasons · ${counts.MANAGED || 0} managed · ${counts.LAUNCHER || 0} launcher · ${counts.UNAVAILABLE || 0} unavailable`,
  )

  for (const problem of problems) console.error(`FAIL ${problem}`)
  if (problems.length > 0) {
    console.error(`\n${problems.length} season route problem(s).`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
