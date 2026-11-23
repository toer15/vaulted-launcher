#!/usr/bin/env node
'use strict'

/**
 * Full-library online audit.
 *
 *   npm run audit:seasons
 *   npm run audit:seasons -- --json
 *   npm run audit:seasons -- --offline   (no network; useful in CI)
 *
 * Every bundled season is classified from evidence, not from a Discord invite:
 *
 *   MANAGED      a hosted backend VAULTED can sign in to (Era / Stellar /
 *                EZFN / Retrac) whose live status probe answered.
 *   LAUNCHER     an external project that ships its own companion launcher and
 *                whose live status probe answered. VAULTED opens that project's
 *                launcher; it never injects into it.
 *   UNAVAILABLE  no verified launcher and no live server. The card must show
 *                ONLINE UNAVAILABLE and must not download/start the season.
 *
 * A Discord gate is an install/community step. It is never counted as online
 * evidence, which is what previously made the dead SunSet Ch1 S3 route green.
 *
 * The audit fails when any route is banned, local/loopback, removed, missing
 * from the catalog, or points at an unsafe launcher download URL.
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const builds = JSON.parse(fs.readFileSync(path.join(root, 'src', 'assets', 'builds.json'), 'utf8'))
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'resources', 'providers', 'provider.json'), 'utf8'),
)
const { fetchProviderLiveStatuses } = require(path.join(root, 'electron', 'providerStatus.cjs'))

const EXPECTED_SEASONS = 43
// Project Neo itself is a verified launcher again (2026-11-23); only the old
// removed Neo/Neonite backend routes stay banned.
const REMOVED_PROVIDERS = new Set(['neo-official', 'neonite'])
// Reboot always starts its embedded LawinServer on loopback; it is not a public
// online route even when it joins a community game server. Echo's installer was
// confirmed malicious and must never be routed again.
const BANNED_PROVIDERS = new Set([
  'reboot',
  'reboot-official',
  'echo',
  // Defender: Trojan:Win32/Suschil!rfn in the official installer (2026-11-23).
  'legacy-official',
])
const LOOPBACK = /(?:^|[/:@])(?:127\.0\.0\.1|localhost|\[::1\])(?:[/:]|$)/i
const MANAGED_MODES = new Set(['global_live'])

function routesFor(season) {
  const routes = [season.onlineProvider, ...(season.onlineProviders || [])].filter(
    (entry) => entry && typeof entry.id === 'string',
  )
  const unique = new Map()
  for (const route of routes) if (!unique.has(route.id)) unique.set(route.id, route)
  return [...unique.values()]
}

function entryFor(id) {
  return catalog.providers.find((provider) => provider.id === id)
}

/**
 * A live sample only counts for the season the project actually hosts. Projects
 * that rotate publish their current season, so the card for any other season
 * stays unavailable instead of inheriting the badge.
 */
function routeLiveForSeason(season, provider, status) {
  if (!status || status.online !== true) return false
  const liveSeasonId = status.liveSeasonId
  if (provider?.liveSeason && liveSeasonId && liveSeasonId !== season.id) return false
  return true
}

function hasCompanionLauncher(provider) {
  // directLaunch means VAULTED joins a live public server itself; it is not a
  // launcher whose website/Discord can prove the server is up. A `launcher`
  // block is detection metadata only; an installable runtime is the evidence.
  return Boolean(provider?.runtime)
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    if (LOOPBACK.test(value)) return null
    return url
  } catch {
    return null
  }
}

function launcherIsSafe(season, provider) {
  const runtime = provider?.runtime
  if (!runtime) return true
  const urls = [runtime.downloadUrl, runtime.versionUrl].filter(Boolean)
  if (urls.length === 0) return true
  for (const value of urls) {
    const url = safeHttpsUrl(value)
    if (!url) {
      return `${season.id} routes ${provider.id} through an unsafe launcher URL (${value})`
    }
    if (Array.isArray(runtime.downloadHosts) && runtime.downloadHosts.length > 0) {
      const host = url.hostname.toLowerCase()
      const allowed = runtime.downloadHosts.some((candidate) =>
        String(candidate).toLowerCase() === host,
      )
      // A version API legitimately lives on a different service host; its
      // installer URL is resolved through that API and the download host is
      // still enforced by providerRuntime. Static installers must match.
      if (!allowed && !runtime.versionUrl) {
        return `${season.id} routes ${provider.id} through ${host}, outside its downloadHosts allowlist`
      }
    }
  }
  return true
}

function routeDetail(season, routes, statuses, problems) {
  for (const route of routes) {
    const id = route.id.trim().toLowerCase()
    const provider = entryFor(route.id)
    if (REMOVED_PROVIDERS.has(id)) {
      problems.push(`${season.id} still routes through the removed ${route.label || route.id} provider`)
    }
    if (BANNED_PROVIDERS.has(id)) {
      problems.push(`${season.id} still routes through banned provider ${route.label || route.id}`)
    }
    if (!provider) {
      problems.push(`${season.id} routes to ${route.id}, which is not in provider.json`)
      continue
    }
    if (provider.mode === 'local') {
      problems.push(`${season.id} routes through the local ${route.id} profile`)
    }
    for (const key of ['backendUrl', 'statusUrl', 'launch', 'launchUrl']) {
      const value = provider[key]
      if (typeof value === 'string' && LOOPBACK.test(value)) {
        problems.push(`${season.id} points ${route.id}.${key} at a loopback backend (${value})`)
      }
    }
    const launcherProblem = launcherIsSafe(season, provider)
    if (launcherProblem !== true) problems.push(launcherProblem)
  }

  const managed = routes.filter((route) => {
    const provider = entryFor(route.id)
    return provider && MANAGED_MODES.has(provider.mode)
  })
  const reachableManaged = managed.filter((route) => statuses[route.id]?.online === true)

  const external = routes.filter((route) => {
    const provider = entryFor(route.id)
    return provider?.mode === 'external' && hasCompanionLauncher(provider)
  })
  const reachableExternal = external.filter((route) =>
    routeLiveForSeason(season, entryFor(route.id), statuses[route.id]),
  )

  const unavailableRoutes = routes.filter((route) => {
    const provider = entryFor(route.id)
    if (!provider || REMOVED_PROVIDERS.has(route.id) || BANNED_PROVIDERS.has(route.id)) return false
    if (MANAGED_MODES.has(provider.mode)) return statuses[route.id]?.online !== true
    if (provider.mode === 'external') {
      return !hasCompanionLauncher(provider) || !routeLiveForSeason(season, provider, statuses[route.id])
    }
    return true
  })

  if (reachableManaged.length > 0) {
    return {
      state: 'MANAGED',
      detail: reachableManaged.map((route) => route.label || route.id).join(', '),
    }
  }
  if (reachableExternal.length > 0) {
    return {
      state: 'LAUNCHER',
      detail: reachableExternal.map((route) => route.label || route.id).join(', '),
    }
  }
  if (unavailableRoutes.length > 0) {
    const reason = unavailableRoutes
      .map((route) => {
        const provider = entryFor(route.id)
        if (!provider) return route.label || route.id
        if (provider.mode === 'external' && !hasCompanionLauncher(provider)) {
          return `${route.label || route.id} (Discord/website only)`
        }
        return `${route.label || route.id} (no live server sample)`
      })
      .join(', ')
    return { state: 'UNAVAILABLE', detail: reason }
  }
  return { state: 'UNAVAILABLE', detail: 'no public online route configured' }
}

async function main() {
  const offline = process.argv.includes('--offline')
  const json = process.argv.includes('--json')
  const problems = []
  const allSeasons = Object.values(builds.seasons)

  if (allSeasons.length !== EXPECTED_SEASONS) {
    problems.push(`expected ${EXPECTED_SEASONS} bundled seasons, found ${allSeasons.length}`)
  }

  let statuses = {}
  if (!offline) {
    try {
      statuses = await fetchProviderLiveStatuses(catalog.providers)
    } catch (error) {
      problems.push(`live status sweep failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  const rows = []
  for (const season of allSeasons) {
    const routes = routesFor(season)
    const result = routeDetail(season, routes, statuses, problems)
    rows.push({
      id: season.id,
      version: season.version,
      state: result.state,
      detail: result.detail,
      routes: routes.map((route) => route.id),
      wired: result.state !== 'UNAVAILABLE',
      discordGates: Array.isArray(season.discordGates) ? season.discordGates.length : 0,
    })
  }

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.state] = (acc[row.state] || 0) + 1
      return acc
    },
    { MANAGED: 0, LAUNCHER: 0, UNAVAILABLE: 0 },
  )

  if (json) {
    console.log(
      JSON.stringify(
        {
          expectedSeasons: EXPECTED_SEASONS,
          seasons: rows,
          counts,
          problems,
        },
        null,
        2,
      ),
    )
  } else {
    for (const row of rows) {
      console.log(
        `${row.state.padEnd(11)} ${String(row.id).padEnd(10)} ${String(row.version).padEnd(6)} ${row.detail}`,
      )
    }
    console.log(
      `\n${rows.length} seasons · ${counts.MANAGED} managed · ${counts.LAUNCHER} launcher · ${counts.UNAVAILABLE} unavailable`,
    )
    // A Discord-only route on an unavailable season is expected: it must not
    // turn the card green. Report the count so an operator can see it was
    // ignored rather than counted as a launcher.
    const gateOnly = rows.filter(
      (row) =>
        row.state === 'UNAVAILABLE' &&
        row.routes.some((id) => {
          const provider = entryFor(id)
          return provider?.mode === 'external' && !hasCompanionLauncher(provider)
        }),
    ).length
    console.log(
      `${gateOnly} dead Discord/website-only season(s) correctly locked as ONLINE UNAVAILABLE`,
    )
  }

  for (const problem of problems) console.error(`FAIL ${problem}`)
  if (problems.length > 0) {
    console.error(`\n${problems.length} route problem(s).`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
