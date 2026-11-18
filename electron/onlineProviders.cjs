'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

/**
 * Provider connection profiles are shipped beside the app:
 *
 *   resources/providers/<id>/provider.json
 *   resources/providers/runtime/<redirectDllName>
 *
 * A provider may still ship its own DLL beside provider.json; otherwise the
 * shared runtime's Tellurium build is used. Every redirect DLL must support
 * the -backend= launch option so its target comes from provider.json rather
 * than a compile-time URL. Chapter 1 builds before the Curl HTTP stack used
 * by modern clients need the Cobalt legacy redirect instead.
 */
const BUNDLED_MANIFEST = require('../src/assets/builds.json')
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/i
const SAFE_DLL_NAME = /^[^\\/:*?"<>|]+\.dll$/i
const SAFE_EXE_NAME = /^[^\\/:*?"<>|]+\.exe$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LEGACY_REDIRECT_DLL = 'Cobalt.dll'
const LEGACY_REDIRECT_SHA256 = '21b5e00f886ad4732a0a6eb989c192cd1583524be170c4068c1ef865c1ca6e3f'
const LEGACY_SEASON = /^ch1-s(?:1|2|3)$/i

function parseHttpUrl(value, originOnly = false) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null
    if (originOnly && (url.search || (url.pathname && url.pathname !== '/'))) return null
    return url
  } catch {
    return null
  }
}

function parseWssUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search) return null
    if (url.pathname && url.pathname !== '/') return null
    return url
  } catch {
    return null
  }
}

function safeApiPath(value, fallback) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  return /^\/[A-Za-z0-9/_-]{1,200}$/.test(candidate) ? candidate : fallback
}

function parseOAuth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const authorizeUrl = parseHttpUrl(raw.authorizeUrl)
  const tokenUrl = parseHttpUrl(raw.tokenUrl)
  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : ''
  if (!authorizeUrl || !tokenUrl || !/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) return null
  const fixedRedirect = raw.fixedRedirect === true
  // Retrac's current public client redirects to its desktop scheme. Only
  // fixed-redirect OAuth clients may use a non-HTTP callback.
  let redirectUri = parseHttpUrl(raw.redirectUri)
  if (!redirectUri && fixedRedirect && typeof raw.redirectUri === 'string') {
    try {
      const candidate = new URL(raw.redirectUri.trim())
      if (
        /^[a-z][a-z0-9+.-]*:$/.test(candidate.protocol) &&
        candidate.hostname === 'callback' &&
        !candidate.username &&
        !candidate.password &&
        !candidate.search &&
        !candidate.hash
      ) {
        redirectUri = candidate
      }
    } catch {
      redirectUri = null
    }
  }
  if (raw.redirectUri && !redirectUri) return null
  const buildIds = {}
  if (raw.buildIds && typeof raw.buildIds === 'object' && !Array.isArray(raw.buildIds)) {
    for (const [season, buildId] of Object.entries(raw.buildIds)) {
      if (/^ch\d{1,2}(?:-s\d{1,2}|-remix|-mini\d+)$/.test(season) && UUID.test(String(buildId))) {
        buildIds[season] = String(buildId)
      }
    }
  }
  const methods = {}
  if (raw.methods && typeof raw.methods === 'object' && !Array.isArray(raw.methods)) {
    for (const method of ['discord', 'google']) {
      const endpoint = raw.methods[method]
      if (typeof endpoint !== 'string') continue
      const candidate = endpoint.trim()
      if (/^\/[A-Za-z0-9/_-]{1,200}$/.test(candidate)) methods[method] = candidate
    }
  }

  return {
    authorizeUrl: authorizeUrl.toString(),
    tokenUrl: tokenUrl.toString(),
    clientId,
    scope: typeof raw.scope === 'string' ? raw.scope.trim().slice(0, 256) : 'launcher.all',
    methods,
    buildIds,
    redirectUri: redirectUri ? redirectUri.toString() : '',
    fixedRedirect,
    tokenFormat: raw.tokenFormat === 'json' ? 'json' : 'form',
  }
}

function parseDeepLink(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const scheme = typeof raw.scheme === 'string' ? raw.scheme.trim().toLowerCase() : ''
  const authorizeUrl = parseHttpUrl(raw.authorizeUrl)
  const tokenParam = typeof raw.tokenParam === 'string' ? raw.tokenParam.trim() : ''
  const refreshParam = typeof raw.refreshParam === 'string' ? raw.refreshParam.trim() : ''
  if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme) || !authorizeUrl) return null
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(tokenParam)) return null
  if (refreshParam && !/^[A-Za-z0-9._-]{1,40}$/.test(refreshParam)) return null
  return {
    scheme,
    authorizeUrl: authorizeUrl.toString(),
    tokenParam,
    refreshParam,
  }
}

function parseEmbeddedWeb(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const loginUrl = parseHttpUrl(raw.loginUrl)
  const callbackUrl = parseHttpUrl(raw.callbackUrl)
  const tokenParam = typeof raw.tokenParam === 'string' ? raw.tokenParam.trim() : ''
  const refreshParam = typeof raw.refreshParam === 'string' ? raw.refreshParam.trim() : ''
  if (!loginUrl || !callbackUrl) return null
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(tokenParam)) return null
  if (refreshParam && !/^[A-Za-z0-9._-]{1,40}$/.test(refreshParam)) return null
  return {
    loginUrl: loginUrl.toString(),
    callbackUrl: callbackUrl.toString(),
    tokenParam,
    refreshParam,
  }
}

/**
 * A Discord invite is public metadata, never an OAuth secret. Accept either a
 * full Discord invite URL or a bare vanity code, and keep it constrained to
 * Discord's two invite hosts so the renderer can open it safely.
 */
function parseLauncherMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const label =
    typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, 48)
      : ''
  if (!label) return null
  const installedExecutables = Array.isArray(raw.installedExecutables)
    ? raw.installedExecutables
        .filter(
          (value) =>
            typeof value === 'string' &&
            /^%(?:LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))%[\\/][A-Za-z0-9 ._\\/-]+\.exe$/i.test(
              value.trim(),
            ) &&
            !value.includes('..'),
        )
        .map((value) => value.trim().slice(0, 260))
    : []
  const executableNames = Array.isArray(raw.executableNames)
    ? raw.executableNames
        .filter(
          (value) =>
            typeof value === 'string' &&
            SAFE_EXE_NAME.test(value.trim()) &&
            path.basename(value.trim()) === value.trim(),
        )
        .map((value) => value.trim().slice(0, 128))
    : []
  const installRoots = Array.isArray(raw.installRoots)
    ? raw.installRoots
        .filter(
          (value) =>
            typeof value === 'string' &&
            /^%(?:LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))%(?:[\\/][A-Za-z0-9 ._-]+){0,4}$/i.test(
              value.trim(),
            ) &&
            !value.includes('..'),
        )
        .map((value) => value.trim().slice(0, 260))
    : []
  if (installedExecutables.length === 0 && (executableNames.length === 0 || installRoots.length === 0)) {
    return null
  }
  const processName =
    typeof raw.processName === 'string' && SAFE_EXE_NAME.test(raw.processName.trim())
      ? raw.processName.trim()
      : executableNames[0] || path.basename(installedExecutables[0] || '') || ''
  if (!processName) return null
  return {
    label,
    installedExecutables,
    executableNames,
    installRoots,
    processName,
  }
}

function defaultLauncherMetadata(name, label) {
  const clean = (value) =>
    String(value || '')
      .replace(/[^A-Za-z0-9 ._-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const bases = [...new Set([clean(label), clean(name)].filter(Boolean))]
  const names = []
  for (const base of bases) {
    for (const candidate of [base, `${base} Launcher`, base.replace(/\s+/g, ''), `${base.replace(/\s+/g, '')}Launcher`]) {
      const fileName = `${candidate}.exe`
      if (SAFE_EXE_NAME.test(fileName) && !names.includes(fileName)) names.push(fileName)
    }
  }
  if (names.length === 0) return null
  const display = bases[0] || 'Companion'
  const installedExecutables = [
    `%LOCALAPPDATA%/Programs/${display}/${display}.exe`,
    `%LOCALAPPDATA%/Programs/${display} Launcher/${display} Launcher.exe`,
    `%LOCALAPPDATA%/Programs/${display}/${display} Launcher.exe`,
    `%PROGRAMFILES%/${display}/${display}.exe`,
  ]
  return {
    label: `${display} Launcher`,
    installedExecutables,
    executableNames: names.slice(0, 8),
    installRoots: ['%LOCALAPPDATA%/Programs', '%PROGRAMFILES%'],
    processName: names[0],
  }
}

function parseExeRuntimeMetadata(raw) {
  const downloadUrl = parseHttpUrl(raw.downloadUrl)
  if (!downloadUrl || downloadUrl.protocol !== 'https:') return null
  const downloadHosts = Array.isArray(raw.downloadHosts)
    ? [
        ...new Set(
          raw.downloadHosts
            .filter(
              (host) =>
                typeof host === 'string' &&
                /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(host.trim()),
            )
            .map((host) => host.trim().toLowerCase()),
        ),
      ]
    : []
  if (downloadHosts.length === 0 || downloadHosts.length > 8) return null
  const host = downloadUrl.hostname.toLowerCase()
  if (!downloadHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return null
  }
  const version =
    typeof raw.version === 'string' ? raw.version.trim().slice(0, 64) : ''
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) return null
  const label =
    typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, 48)
      : 'Companion Launcher'
  const installerName =
    typeof raw.installerName === 'string' ? raw.installerName.trim().slice(0, 128) : ''
  if (!/^[^\\/:*?"<>|]+\.exe$/i.test(installerName)) return null
  const signerSubject =
    typeof raw.signerSubject === 'string' ? raw.signerSubject.trim().slice(0, 256) : ''
  // An unsigned installer may only be run after the player sees and confirms
  // the official installer UI. This is deliberately opt-in per provider.
  if (!signerSubject && raw.allowUnsigned !== true) return null
  if (raw.interactive === false) return null
  const installedExecutables = Array.isArray(raw.installedExecutables)
    ? raw.installedExecutables
        .filter(
          (value) =>
            typeof value === 'string' &&
            /^%(?:LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))%[\\/][A-Za-z0-9 ._\\/-]+\.exe$/i.test(
              value.trim(),
            ) &&
            !value.includes('..'),
        )
        .map((value) => value.trim().slice(0, 260))
    : []
  const executableNames = Array.isArray(raw.executableNames)
    ? raw.executableNames
        .filter(
          (value) =>
            typeof value === 'string' &&
            SAFE_EXE_NAME.test(value.trim()) &&
            path.basename(value.trim()) === value.trim(),
        )
        .map((value) => value.trim().slice(0, 128))
    : []
  const installRoots = Array.isArray(raw.installRoots)
    ? raw.installRoots
        .filter(
          (value) =>
            typeof value === 'string' &&
            /^%(?:LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))%(?:[\\/][A-Za-z0-9 ._-]+){0,4}$/i.test(
              value.trim(),
            ) &&
            !value.includes('..'),
        )
        .map((value) => value.trim().slice(0, 260))
    : []
  if (installedExecutables.length === 0 && (executableNames.length === 0 || installRoots.length === 0)) {
    return null
  }
  const launchArgs = Array.isArray(raw.launchArgs)
    ? raw.launchArgs
        .filter((value) => typeof value === 'string' && /^-[^\s"'`]{1,160}$/.test(value.trim()))
        .map((value) => value.trim())
    : []
  const processName =
    typeof raw.processName === 'string' && SAFE_EXE_NAME.test(raw.processName.trim())
      ? raw.processName.trim()
      : executableNames[0] || path.basename(installedExecutables[0] || '') || ''
  if (!processName) return null
  return {
    kind: 'exe',
    label,
    version,
    downloadUrl: downloadUrl.toString(),
    downloadHosts,
    installerName,
    allowUnsigned: !signerSubject,
    interactive: true,
    autoInstall: raw.autoInstall !== false,
    installedExecutables,
    executableNames,
    installRoots,
    signerSubject,
    manifestIds: {},
    launchArgs,
    processName,
  }
}

function parseRuntimeMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.kind === 'exe') return parseExeRuntimeMetadata(raw)
  if (raw.kind !== 'msi') return null
  const versionUrl = parseHttpUrl(raw.versionUrl)
  if (!versionUrl || versionUrl.protocol !== 'https:') return null
  const downloadHosts = Array.isArray(raw.downloadHosts)
    ? [...new Set(raw.downloadHosts.filter((host) => typeof host === 'string' && /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(host.trim())).map((host) => host.trim().toLowerCase()))]
    : []
  if (downloadHosts.length === 0 || downloadHosts.length > 8) return null
  const label =
    typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, 48)
      : 'Companion Launcher'
  const signerSubject =
    typeof raw.signerSubject === 'string' ? raw.signerSubject.trim().slice(0, 256) : ''
  const installerName =
    typeof raw.installerName === 'string' ? raw.installerName.trim().slice(0, 128) : ''
  if (!signerSubject || !/^[^\\/:*?"<>|]+\.msi$/i.test(installerName)) return null
  const installedExecutables = Array.isArray(raw.installedExecutables)
    ? raw.installedExecutables
        .filter(
          (value) =>
            typeof value === 'string' &&
            /^%(?:LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))%[\\/][A-Za-z0-9 ._\\/-]+\.exe$/i.test(value.trim()) &&
            !value.includes('..'),
        )
        .map((value) => value.trim().slice(0, 260))
    : []
  if (installedExecutables.length === 0) return null
  const manifestIds = {}
  if (raw.manifestIds && typeof raw.manifestIds === 'object' && !Array.isArray(raw.manifestIds)) {
    for (const [version, manifestId] of Object.entries(raw.manifestIds)) {
      if (!/^\d{1,2}\.\d{1,2}$/.test(version)) continue
      if (
        typeof manifestId !== 'string' ||
        !/^\+\+Fortnite\+Release-[A-Za-z0-9.]+-CL-\d+-Windows$/.test(manifestId.trim())
      ) {
        continue
      }
      manifestIds[version] = manifestId.trim()
    }
  }
  const launchArgs = Array.isArray(raw.launchArgs)
    ? raw.launchArgs
        .filter((value) => typeof value === 'string' && /^-[^\s"'`]{1,160}$/.test(value.trim()))
        .map((value) => value.trim())
    : []
  const processName =
    typeof raw.processName === 'string' && SAFE_EXE_NAME.test(raw.processName.trim())
      ? raw.processName.trim()
      : ''
  if (!processName || Object.keys(manifestIds).length === 0 || launchArgs.length === 0) return null
  return {
    kind: 'msi',
    label,
    versionUrl: versionUrl.toString(),
    downloadHosts,
    signerSubject,
    installerName,
    autoInstall: raw.autoInstall !== false,
    installedExecutables,
    manifestIds,
    launchArgs,
    processName,
  }
}

function parseDiscordGate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const configured = typeof raw.inviteUrl === 'string' ? raw.inviteUrl.trim() : ''
  const code = configured || (typeof raw.invite === 'string' ? raw.invite.trim() : '')
  if (!code) return null
  const candidate = /^[A-Za-z0-9-]{2,64}$/.test(code) ? `https://discord.gg/${code}` : code
  let inviteUrl
  try {
    inviteUrl = new URL(candidate)
  } catch {
    return null
  }
  if (inviteUrl.protocol !== 'https:' || inviteUrl.username || inviteUrl.password || inviteUrl.search || inviteUrl.hash) {
    return null
  }
  const host = inviteUrl.hostname.toLowerCase()
  const invitePath = inviteUrl.pathname.replace(/^\/+|\/+$/g, '')
  const validInvite =
    host === 'discord.gg' && /^[A-Za-z0-9-]{2,64}$/.test(invitePath)
  const validDiscovery =
    host === 'discord.com' && /^(?:invite\/[A-Za-z0-9-]{2,64}|servers\/[A-Za-z0-9-]+)$/.test(invitePath)
  if (!validInvite && !validDiscovery) return null
  const guildId = typeof raw.guildId === 'string' ? raw.guildId.trim() : ''
  if (guildId && !/^\d{15,22}$/.test(guildId)) return null
  return {
    inviteUrl: inviteUrl.toString(),
    ...(guildId ? { guildId } : {}),
    ...(raw.statusOnly === true ? { statusOnly: true } : {}),
    label:
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim().slice(0, 48)
        : 'Discord',
  }
}

const PROVIDERS = new Map()
for (const season of Object.values(BUNDLED_MANIFEST.seasons || {})) {
  for (const provider of [season?.onlineProvider, ...(Array.isArray(season?.onlineProviders) ? season.onlineProviders : [])]) {
    if (!provider || typeof provider.id !== 'string' || !SAFE_PROVIDER_ID.test(provider.id)) continue
    if (!PROVIDERS.has(provider.id)) {
      PROVIDERS.set(provider.id, {
        id: provider.id,
        name: typeof provider.name === 'string' ? provider.name : provider.id,
        label: typeof provider.label === 'string' ? provider.label : provider.id,
      })
    }
  }
}

function providerRoot() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'providers') : ''
  if (packaged && fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', 'resources', 'providers')
}

let catalogCache = null

/**
 * The central provider.json is the source of truth for global backends. It is
 * deliberately separate from the per-provider folder so new projects can be
 * added without duplicating a redirect DLL or a launch profile.
 */
function catalogData() {
  if (catalogCache) return catalogCache
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(path.join(providerRoot(), 'provider.json'), 'utf8'))
  } catch {
    raw = null
  }
  const runtime = raw?.runtime && typeof raw.runtime === 'object' ? raw.runtime : {}
  const defaults = {
    redirectDllName:
      typeof runtime.redirectDllName === 'string' && SAFE_DLL_NAME.test(runtime.redirectDllName)
        ? runtime.redirectDllName
        : 'Tellurium.dll',
    redirectDllSha256: /^[a-f0-9]{64}$/i.test(runtime.redirectDllSha256 || '')
      ? String(runtime.redirectDllSha256).toLowerCase()
      : '',
    legacyRedirectDllName:
      typeof runtime.legacyRedirectDllName === 'string' &&
      SAFE_DLL_NAME.test(runtime.legacyRedirectDllName)
        ? runtime.legacyRedirectDllName
        : LEGACY_REDIRECT_DLL,
    legacyRedirectDllSha256: /^[a-f0-9]{64}$/i.test(runtime.legacyRedirectDllSha256 || '')
      ? String(runtime.legacyRedirectDllSha256).toLowerCase()
      : LEGACY_REDIRECT_SHA256,
  }
  const providers = []
  for (const entry of Array.isArray(raw?.providers) ? raw.providers : []) {
    if (!entry || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const backendUrl = typeof entry.backendUrl === 'string' ? entry.backendUrl.trim() : ''
    if (!id || !SAFE_PROVIDER_ID.test(id) || !name || !label || !backendUrl) continue
    try {
      const parsed = new URL(backendUrl)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue
      if (parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) continue
    } catch {
      continue
    }
    const seasons = Array.isArray(entry.seasons)
      ? [
          ...new Set(
            entry.seasons.filter(
              (season) =>
                typeof season === 'string' && /^ch\d{1,2}(?:-s\d{1,2}|-remix|-mini\d+)$/.test(season),
            ),
          ),
        ]
      : []
    const oauth = entry.auth === 'oauth' ? parseOAuth(entry.oauth) : null
    const deeplink = entry.auth === 'deeplink' ? parseDeepLink(entry.deeplink) : null
    const embeddedWeb = entry.auth === 'embedded_web' ? parseEmbeddedWeb(entry.embeddedWeb) : null
    let auth = 'none'
    if (entry.auth === 'oauth' && oauth) auth = 'oauth'
    else if (entry.auth === 'deeplink' && deeplink) auth = 'deeplink'
    else if (entry.auth === 'embedded_web' && embeddedWeb) auth = 'embedded_web'
    else if (entry.auth === 'exchangeCode') auth = 'exchangeCode'
    const mode =
      entry.mode === 'external'
        ? 'external'
        : auth !== 'none' && entry.mode === 'global_live'
          ? 'global_live'
          : 'download'
    const launchKind =
      mode === 'external' ? (entry.launchKind === 'discord' ? 'discord' : 'official') : undefined
    const apiBaseUrl = parseHttpUrl(entry.apiBaseUrl, true)
    const statusUrl = parseHttpUrl(entry.statusUrl)
    const launchUrl = parseHttpUrl(entry.launchUrl) || parseHttpUrl(entry.website)
    const population =
      entry.population &&
      entry.population.kind === 'discord' &&
      typeof entry.population.invite === 'string' &&
      /^[A-Za-z0-9-]{2,64}$/.test(entry.population.invite.trim())
        ? {
            kind: 'discord',
            invite: entry.population.invite.trim(),
            label:
              typeof entry.population.label === 'string' && entry.population.label.trim()
                ? entry.population.label.trim().slice(0, 32)
                : 'Discord',
          }
        : undefined

    // A provider can use Discord either through its own OAuth broker (Era),
    // directly through Discord's authorize endpoint (Stellar), or through a
    // fixed custom-scheme client (Retrac). Keep that capability separate from
    // `auth` so the renderer can ask only for Discord-backed seasons.
    let discordAuthorize = false
    if (oauth?.methods?.discord) discordAuthorize = true
    if (deeplink?.authorizeUrl) {
      try {
        discordAuthorize = new URL(deeplink.authorizeUrl).hostname === 'discord.com'
      } catch {
        discordAuthorize = false
      }
    }
    const discordAuth = entry.discordAuth === true || discordAuthorize
    const parsedDiscordGate = parseDiscordGate(entry.discordGate)
    const runtimeMetadata = parseRuntimeMetadata(entry.runtime)
    const launcherMetadata =
      parseLauncherMetadata(entry.launcher) ||
      (mode === 'external' && launchKind === 'discord'
        ? defaultLauncherMetadata(name, label)
        : null)

    providers.push({
      id,
      name,
      label,
      backendUrl: new URL(backendUrl).origin,
      website: typeof entry.website === 'string' ? entry.website.trim() : '',
      signInUrl: typeof entry.signInUrl === 'string' ? entry.signInUrl.trim() : '',
      auth,
      discordAuth,
      discordGate: parsedDiscordGate
        ? { providerId: id, ...parsedDiscordGate }
        : undefined,
      runtime: runtimeMetadata,
      launcher: launcherMetadata,
      mode,
      external: mode === 'external' || entry.external === true,
      launchKind,
      launchUrl: launchUrl ? launchUrl.toString() : '',
      oauth,
      deeplink,
      embeddedWeb,
      launchHandshakePending: entry.launchHandshakePending === true,
      statusUrl: statusUrl ? statusUrl.toString() : '',
      population,
      apiBaseUrl: apiBaseUrl ? apiBaseUrl.origin : '',
      realtimeUrl: parseWssUrl(entry.realtimeUrl)?.origin || '',
      buildsPath: safeApiPath(entry.buildsPath, '/launcher/v1/builds'),
      exchangeCodePath: safeApiPath(entry.exchangeCodePath, '/launcher/v1/game/exchange-code'),
      profilePath: safeApiPath(entry.profilePath, ''),
      verificationUrl:
        typeof entry.verificationUrl === 'string' ? entry.verificationUrl.trim() : '',
      global: entry.global !== false,
      dynamicSeasons: entry.dynamicSeasons === true,
      seasons,
      redirectDllName:
        typeof entry.redirectDllName === 'string' && SAFE_DLL_NAME.test(entry.redirectDllName)
          ? entry.redirectDllName
          : defaults.redirectDllName,
      redirectDllSha256: /^[a-f0-9]{64}$/i.test(entry.redirectDllSha256 || '')
        ? String(entry.redirectDllSha256).toLowerCase()
        : defaults.redirectDllSha256,
    })
  }
  catalogCache = { defaults, providers }
  return catalogCache
}

for (const entry of catalogData().providers) {
  const current = PROVIDERS.get(entry.id)
  PROVIDERS.set(entry.id, {
    id: entry.id,
    name: entry.name || current?.name || entry.id,
    label: entry.label || current?.label || entry.id,
  })
}

/** Sanitised catalog consumed by the renderer and the provider launch path. */
function providerCatalog() {
  return [...catalogData().providers.map((entry) => ({
    id: entry.id,
    name: entry.name,
    label: entry.label,
    backendUrl: entry.backendUrl,
    website: entry.website,
    signInUrl: entry.signInUrl,
    auth: entry.auth,
    discordAuth: entry.discordAuth === true,
    discordGate: entry.discordGate,
    mode: entry.mode,
    external: entry.external === true,
    runtime: entry.runtime ? { required: true, label: entry.runtime.label } : undefined,
    launcher: entry.launcher,
    launchKind: entry.launchKind,
    launchUrl: entry.launchUrl,
    launchHandshakePending: entry.launchHandshakePending,
    statusUrl: entry.statusUrl,
    population: entry.population,
    global: entry.global,
    dynamicSeasons: entry.dynamicSeasons,
    supportedSeasons: entry.seasons,
  })), ...localProviderCatalog()]
}

/**
 * Bundled local launchers (Reboot, Neo, EZFN Hybrid) are not global backends,
 * but the renderer still needs their names and season mappings so every card
 * can show a real launcher instead of a dead "unsupported" state. The launch
 * path reads the same profile folder; no credentials are exposed here.
 */
function localProviderCatalog() {
  const root = providerRoot()
  const globalIds = new Set(catalogData().providers.map((entry) => entry.id))
  const entries = []
  let children = []
  try {
    children = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const child of children) {
    if (!child.isDirectory() || child.name === 'runtime' || globalIds.has(child.name)) continue
    const id = child.name
    if (!SAFE_PROVIDER_ID.test(id)) continue
    const raw = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, id, 'provider.json'), 'utf8'))
      } catch {
        return null
      }
    })()
    if (!raw || raw.id !== id) continue
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    const backendUrl = typeof raw.backendUrl === 'string' ? raw.backendUrl.trim() : ''
    if (!name || !label || !backendUrl) continue
    let origin
    try {
      const parsed = new URL(backendUrl)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue
      origin = parsed.origin
    } catch {
      continue
    }
    const seasons = new Set()
    for (const season of Object.values(BUNDLED_MANIFEST.seasons || {})) {
      for (const provider of [
        season?.onlineProvider,
        ...(Array.isArray(season?.onlineProviders) ? season.onlineProviders : []),
      ]) {
        if (provider?.id === id) seasons.add(season.id)
      }
    }
    entries.push({
      id,
      name,
      label,
      backendUrl: origin,
      website: typeof raw.website === 'string' ? raw.website.trim() : '',
      signInUrl: '',
      auth: 'none',
      mode: 'download',
      launchHandshakePending: false,
      statusUrl: '',
      population: undefined,
      global: false,
      dynamicSeasons: false,
      supportedSeasons: [...seasons],
    })
  }
  return entries
}

/** Repair destination for an installed app whose packaged resources are read-only. */
function userProviderRoot() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'VAULTED Launcher', 'providers')
}

function providerForId(id) {
  return PROVIDERS.get(String(id || '')) || null
}

/** Documented release/runtime metadata for a catalog provider, if any. */
function providerRuntimeMetadata(id) {
  const key = String(id || '').trim().toLowerCase()
  const entry = catalogData().providers.find((provider) => provider.id === key)
  return entry?.runtime ?? null
}

/**
 * Open-source injector/redirect components are shipped both in
 * providers/runtime and in the full runtime folder. Provider launches use the
 * shared injector and Tellurium build from here.
 */
function sharedRuntimeRoot() {
  const insideProviders = path.join(providerRoot(), 'runtime')
  if (fs.existsSync(insideProviders)) return insideProviders
  const packaged = path.join(providerRoot(), '..', 'runtime')
  if (fs.existsSync(packaged)) return packaged
  return path.join(providerRoot(), '..', '..', 'runtime')
}

function runtimeConfig() {
  const configPath = path.join(providerRoot(), 'runtime.json')
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    throw new Error('The bundled open-source runtime profile is missing. Reinstall VAULTED.')
  }
}

function sharedRuntimeConfig() {
  const raw = runtimeConfig()
  const configPath = path.join(providerRoot(), 'runtime.json')
  const injector = typeof raw?.injector === 'string' ? raw.injector.trim() : ''
  if (!SAFE_EXE_NAME.test(injector) || path.basename(injector) !== injector) {
    throw new Error('The bundled open-source runtime has no valid injector.')
  }
  return { injector, root: sharedRuntimeRoot(), configPath }
}

/**
 * Read and validate one bundled provider profile. Throws a user-actionable
 * error instead of silently falling back to an external launcher.
 */
function providerProfile(id) {
  const provider = providerForId(id)
  if (!provider) throw new Error('That online provider is not in the bundled catalog.')

  const root = path.join(providerRoot(), provider.id)
  const localConfigPath = path.join(root, 'provider.json')
  let raw = null
  let configPath = localConfigPath
  try {
    raw = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'))
  } catch {
    const catalogEntry = catalogData().providers.find((entry) => entry.id === provider.id)
    if (catalogEntry) {
      raw = catalogEntry
      configPath = path.join(providerRoot(), 'provider.json')
    }
  }
  if (!raw) {
    throw new Error(`The ${provider.name} provider profile is missing. Reinstall VAULTED.`)
  }

  const configuredBackend = typeof raw?.backendUrl === 'string' ? raw.backendUrl.trim() : ''
  let backend
  try {
    backend = new URL(configuredBackend)
  } catch {
    throw new Error(`The ${provider.name} provider has no valid backend URL.`)
  }
  if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password) {
    throw new Error(`The ${provider.name} provider backend URL must use http(s) without credentials.`)
  }
  if (backend.search || backend.hash || (backend.pathname && backend.pathname !== '/')) {
    throw new Error(
      `The ${provider.name} provider backend URL must be an origin only (for example https://api.example.com); paths, queries and fragments are not used by the redirect DLL.`,
    )
  }
  const backendUrl = backend.origin
  const catalogEntry = catalogData().providers.find((entry) => entry.id === provider.id)
  const localEntry = catalogEntry ? null : localProviderCatalog().find((entry) => entry.id === provider.id)
  const redirectDllName =
    typeof raw?.redirectDllName === 'string' && raw.redirectDllName.trim()
      ? raw.redirectDllName.trim()
      : catalogEntry?.redirectDllName || catalogData().defaults.redirectDllName
  if (!SAFE_DLL_NAME.test(redirectDllName) || path.basename(redirectDllName) !== redirectDllName) {
    throw new Error(`The ${provider.name} provider has no valid redirect DLL name.`)
  }

  const configuredSha =
    typeof raw?.redirectDllSha256 === 'string' && raw.redirectDllSha256.trim()
      ? raw.redirectDllSha256.trim()
      : catalogEntry?.redirectDllSha256 || catalogData().defaults.redirectDllSha256
  const gameServerDllName = typeof raw?.gameServerDllName === 'string' ? raw.gameServerDllName.trim() : ''
  if (gameServerDllName && (!SAFE_DLL_NAME.test(gameServerDllName) || path.basename(gameServerDllName) !== gameServerDllName)) {
    throw new Error(`The ${provider.name} provider has no valid game server DLL name.`)
  }
  const configuredGameServerSha =
    typeof raw?.gameServerDllSha256 === 'string' ? raw.gameServerDllSha256.trim() : ''

  return {
    ...provider,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : provider.name,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : provider.label,
    backendUrl,
    redirectDllName,
    redirectDllSha256: /^[a-f0-9]{64}$/i.test(configuredSha) ? configuredSha.toLowerCase() : '',
    gameServerDllName,
    gameServerDllSha256: /^[a-f0-9]{64}$/i.test(configuredGameServerSha)
      ? configuredGameServerSha.toLowerCase()
      : '',
    root,
    configPath,
    auth: catalogEntry?.auth || (raw?.auth === 'exchangeCode' ? 'exchangeCode' : 'none'),
    discordAuth: catalogEntry?.discordAuth === true,
    discordGate:
      catalogEntry?.discordGate ||
      (() => {
        const gate = parseDiscordGate(raw?.discordGate)
        return gate ? { providerId: provider.id, ...gate } : undefined
      })(),
    launchHandshakePending: catalogEntry?.launchHandshakePending === true,
    statusUrl: catalogEntry?.statusUrl || '',
    mode:
      catalogEntry?.mode ||
      (raw?.mode === 'global_live' && raw?.auth === 'oauth' ? 'global_live' : 'download'),
    external: (catalogEntry?.mode || raw?.mode) === 'external' || catalogEntry?.external === true,
    launchKind: catalogEntry?.launchKind || (raw?.launchKind === 'discord' ? 'discord' : undefined),
    launchUrl:
      parseHttpUrl(catalogEntry?.launchUrl)?.toString() ||
      parseHttpUrl(catalogEntry?.website)?.toString() ||
      '',
    oauth: catalogEntry?.oauth || parseOAuth(raw?.oauth),
    deeplink: catalogEntry?.deeplink || null,
    embeddedWeb: catalogEntry?.embeddedWeb || null,
    apiBaseUrl: catalogEntry?.apiBaseUrl || parseHttpUrl(raw?.apiBaseUrl, true)?.origin || '',
    realtimeUrl: parseWssUrl(raw?.realtimeUrl)?.origin || catalogEntry?.realtimeUrl || '',
    buildsPath: catalogEntry?.buildsPath || safeApiPath(raw?.buildsPath, '/launcher/v1/builds'),
    exchangeCodePath:
      catalogEntry?.exchangeCodePath ||
      safeApiPath(raw?.exchangeCodePath, '/launcher/v1/game/exchange-code'),
    profilePath: catalogEntry?.profilePath || safeApiPath(raw?.profilePath, ''),
    verificationUrl:
      (typeof raw?.verificationUrl === 'string' && raw.verificationUrl.trim()) ||
      catalogEntry?.verificationUrl ||
      '',
    signInUrl:
      (typeof raw?.signInUrl === 'string' && raw.signInUrl.trim()) || catalogEntry?.signInUrl || '',
    website: (typeof raw?.website === 'string' && raw.website.trim()) || catalogEntry?.website || '',
    supportedSeasons: catalogEntry?.seasons || localEntry?.supportedSeasons || [],
    dynamicSeasons: catalogEntry?.dynamicSeasons === true,
    global: catalogEntry?.global === true,
  }
}

function usableDll(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size < 2) return false
    const header = Buffer.alloc(2)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, header, 0, 2, 0)
    } finally {
      fs.closeSync(fd)
    }
    return header.toString('ascii') === 'MZ'
  } catch {
    return false
  }
}

/**
 * The backend-parameter build of Tellurium advertises `-backend=` as a UTF-16
 * string. Check the binary before injecting it so a stale provider DLL fails
 * with an actionable message instead of silently logging in to 127.0.0.1.
 */
function redirectSupportsBackendParameter(file) {
  try {
    return fs.readFileSync(file).includes(Buffer.from('-backend=', 'utf16le'))
  } catch {
    return false
  }
}

function redirectDllIsUsable(file) {
  return usableDll(file) && redirectSupportsBackendParameter(file)
}

function redirectDllHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

function redirectDllMatchesProfile(file, profile) {
  if (!redirectDllIsUsable(file)) return false
  const expected =
    profile && typeof profile.redirectDllSha256 === 'string' ? profile.redirectDllSha256.toLowerCase() : ''
  return !expected || redirectDllHash(file) === expected
}

function providerDllPath(profile) {
  const local = path.join(profile.root, profile.redirectDllName)
  const installed = path.join(userProviderRoot(), profile.id, profile.redirectDllName)
  const shared = path.join(sharedRuntimeRoot(), profile.redirectDllName)
  for (const candidate of [local, installed, shared]) {
    if (redirectDllMatchesProfile(candidate, profile)) return candidate
  }
  // report the provider-local path for a precise error
  return local
}

function copyRedirectDll(source, target, expectedSha256) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.copyFileSync(source, temporary)
    if (!redirectDllIsUsable(temporary)) throw new Error('The bundled redirect DLL is not usable.')
    if (expectedSha256 && redirectDllHash(temporary) !== expectedSha256) {
      throw new Error('The bundled redirect DLL checksum did not match.')
    }
    fs.rmSync(target, { force: true })
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

let providerRepairPromise = null

/**
 * Make every provider's redirect DLL present without asking the player to find
 * or drop a file. The validated DLL bundled with the launcher is the only
 * repair source: there is deliberately no network fallback, so a dead release
 * URL can never leave a repair half-finished.
 */
function ensureProviderRedirects() {
  if (providerRepairPromise) return providerRepairPromise

  providerRepairPromise = (async () => {
    const report = { checked: [], repaired: [], errors: [] }
    for (const id of PROVIDERS.keys()) {
      report.checked.push(id)
      let profile
      try {
        profile = providerProfile(id)
      } catch (error) {
        report.errors.push({ id, error: error instanceof Error ? error.message : String(error) })
        continue
      }
      // External launchers use their own signed official launcher; VAULTED
      // never injects a redirect DLL for them.
      if (profile.mode === 'external') continue

      const local = path.join(profile.root, profile.redirectDllName)
      if (redirectDllMatchesProfile(local, profile)) continue

      const target = path.join(userProviderRoot(), profile.id, profile.redirectDllName)
      if (redirectDllMatchesProfile(target, profile)) {
        report.repaired.push(profile.id)
        continue
      }

      const bundledCandidates = [
        path.join(providerRoot(), 'runtime', profile.redirectDllName),
        path.join(providerRoot(), '..', 'runtime', profile.redirectDllName),
        path.join(providerRoot(), '..', '..', 'runtime', profile.redirectDllName),
        path.join(sharedRuntimeRoot(), profile.redirectDllName),
      ]
      const bundled = [...new Set(bundledCandidates.map((candidate) => path.resolve(candidate)))]
        .find((candidate) => redirectDllMatchesProfile(candidate, profile))
      if (!bundled) {
        report.errors.push({
          id: profile.id,
          error: `${profile.redirectDllName} is missing from the bundled providers or does not match its checksum. Reinstall VAULTED.`,
        })
        continue
      }

      try {
        copyRedirectDll(bundled, target, profile.redirectDllSha256)
        report.repaired.push(profile.id)
      } catch (error) {
        report.errors.push({ id: profile.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return report
  })().finally(() => {
    providerRepairPromise = null
  })

  return providerRepairPromise
}

/** Cobalt replaces Tellurium for Chapter 1 builds that predate its signatures. */
function legacyRedirectProfile(profile) {
  const defaults = catalogData().defaults
  return {
    ...profile,
    redirectDllName: defaults.legacyRedirectDllName,
    redirectDllSha256: defaults.legacyRedirectDllSha256,
  }
}

function legacyRedirectDllPath() {
  return providerDllPath(
    legacyRedirectProfile({
      id: 'legacy',
      root: sharedRuntimeRoot(),
    }),
  )
}

/**
 * v1.x-v3.x clients hook through Cobalt. The version is authoritative; the
 * season id covers a freshly downloaded card whose version has not been
 * written back to the library yet.
 */
function providerUsesLegacyRedirect(version, seasonId = '') {
  const major = Number.parseInt(String(version || '').split('.')[0], 10)
  if (Number.isInteger(major) && major > 0) return major <= 3
  return LEGACY_SEASON.test(String(seasonId || '').trim())
}

/** The injector plus redirect DLL used for one bundled provider launch. */
function providerRuntime(profile, options = {}) {
  const shared = sharedRuntimeConfig()
  const selected = options.legacy === true ? legacyRedirectProfile(profile) : profile
  return {
    injector: path.join(shared.root, shared.injector),
    dll: providerDllPath(selected),
    // The checksum check must use the profile that selected this DLL.
    profile: selected,
    legacy: options.legacy === true,
    root: shared.root,
    configPath: shared.configPath,
  }
}

module.exports = {
  providerRuntimeMetadata,
  ensureProviderRedirects,
  legacyRedirectDllPath,
  providerCatalog,
  providerDllPath,
  providerForId,
  providerProfile,
  providerRoot,
  providerRuntime,
  providerUsesLegacyRedirect,
  redirectDllMatchesProfile,
  redirectSupportsBackendParameter,
  runtimeConfig,
  sharedRuntimeRoot,
  userProviderRoot,
}
