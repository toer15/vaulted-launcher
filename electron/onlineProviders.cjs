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
 * than a compile-time URL.
 */
const BUNDLED_MANIFEST = require('../src/assets/builds.json')
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/i
const SAFE_DLL_NAME = /^[^\\/:*?"<>|]+\.dll$/i
const SAFE_EXE_NAME = /^[^\\/:*?"<>|]+\.exe$/i

const PROVIDERS = new Map()
for (const season of Object.values(BUNDLED_MANIFEST.seasons || {})) {
  const provider = season && season.onlineProvider
  if (!provider || typeof provider.id !== 'string' || !SAFE_PROVIDER_ID.test(provider.id)) continue
  if (!PROVIDERS.has(provider.id)) {
    PROVIDERS.set(provider.id, {
      id: provider.id,
      name: typeof provider.name === 'string' ? provider.name : provider.id,
      label: typeof provider.label === 'string' ? provider.label : provider.id,
    })
  }
}

function providerRoot() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'providers') : ''
  if (packaged && fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', 'resources', 'providers')
}

/** Repair destination for an installed app whose packaged resources are read-only. */
function userProviderRoot() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'VAULTED Launcher', 'providers')
}

function providerForId(id) {
  return PROVIDERS.get(String(id || '')) || null
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
  const configPath = path.join(root, 'provider.json')
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
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
  const redirectDllName = typeof raw?.redirectDllName === 'string' ? raw.redirectDllName.trim() : ''
  if (!SAFE_DLL_NAME.test(redirectDllName) || path.basename(redirectDllName) !== redirectDllName) {
    throw new Error(`The ${provider.name} provider has no valid redirect DLL name.`)
  }

  const configuredSha = typeof raw?.redirectDllSha256 === 'string' ? raw.redirectDllSha256.trim() : ''
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

/** The injector plus redirect DLL used for one bundled provider launch. */
function providerRuntime(profile) {
  const shared = sharedRuntimeConfig()
  return {
    injector: path.join(shared.root, shared.injector),
    dll: providerDllPath(profile),
    root: shared.root,
    configPath: shared.configPath,
  }
}

module.exports = {
  ensureProviderRedirects,
  providerDllPath,
  providerForId,
  providerProfile,
  providerRoot,
  providerRuntime,
  redirectDllMatchesProfile,
  redirectSupportsBackendParameter,
  runtimeConfig,
  sharedRuntimeRoot,
  userProviderRoot,
}
