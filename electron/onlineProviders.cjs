'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { findInstalledLauncher } = require('./hostedLaunchers.cjs')

/**
 * The provider metadata lives in the bundled season manifest. Keeping the
 * catalog there means a season can add a community provider without a second
 * list getting out of sync, while this module still owns all path/registry
 * validation so a remote manifest can never cause arbitrary process execution.
 */
const BUNDLED_MANIFEST = require('../src/assets/builds.json')

const PROVIDERS = new Map()
for (const season of Object.values(BUNDLED_MANIFEST.seasons || {})) {
  const provider = season && season.onlineProvider
  if (!provider || typeof provider.id !== 'string') continue
  if (!PROVIDERS.has(provider.id)) PROVIDERS.set(provider.id, provider)
}

function providerForId(id) {
  return PROVIDERS.get(String(id || '')) || null
}

function expandPath(value) {
  return String(value || '').replace(/%([^%]+)%/g, (_match, name) => {
    // Windows environment variables are case-insensitive; process.env lookups
    // vary by Node/Electron version, so try the common spellings too.
    return (
      process.env[name] ||
      process.env[String(name).toUpperCase()] ||
      process.env[String(name).toLowerCase()] ||
      ''
    )
  })
}

function isFile(value) {
  if (!value || !path.isAbsolute(value) || !/\.exe$/i.test(value)) return false
  try {
    return fs.statSync(value).isFile()
  } catch {
    return false
  }
}

function directNames(provider) {
  const names = Array.isArray(provider.executableNames) ? provider.executableNames : []
  return names.filter((name) => typeof name === 'string' && /\.exe$/i.test(name))
}

function directoryNames(provider) {
  const names = Array.isArray(provider.installDirNames) ? provider.installDirNames : []
  return names.filter((name) => typeof name === 'string' && name.trim())
}

function sameName(left, right) {
  return String(left || '').toLowerCase().replace(/\.lnk$/i, '').trim() ===
    String(right || '').toLowerCase().replace(/\.lnk$/i, '').trim()
}

function findExecutableIn(folder, provider, depth = 0) {
  if (depth > 3) return null

  for (const name of directNames(provider)) {
    const candidate = path.join(folder, name)
    if (isFile(candidate)) return candidate
  }

  let entries
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const child = path.join(folder, entry.name)
    for (const name of directNames(provider)) {
      const candidate = path.join(child, name)
      if (isFile(candidate)) return candidate
    }
    const nested = findExecutableIn(child, provider, depth + 1)
    if (nested) return nested
  }

  return null
}

function installRoots() {
  const local = process.env.LOCALAPPDATA
  const roaming = process.env.APPDATA
  return [
    local ? path.join(local, 'Programs') : null,
    local,
    roaming ? path.join(roaming, 'Programs') : null,
    roaming,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
  ].filter((root, index, all) => root && all.indexOf(root) === index)
}

function findProviderExecutable(provider, options = {}) {
  const explicitPaths = Array.isArray(provider.installPaths) ? provider.installPaths : []
  for (const template of explicitPaths) {
    const candidate = expandPath(template)
    if (isFile(candidate)) return candidate
  }

  const names = directoryNames(provider)
  for (const root of installRoots()) {
    for (const name of names) {
      const candidate = findExecutableIn(path.join(root, name), provider)
      if (candidate) return candidate
    }

    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!names.some((name) => sameName(entry.name, name))) continue
      const candidate = findExecutableIn(path.join(root, entry.name), provider)
      if (candidate) return candidate
    }
  }

  // Reuse the general launcher catalog for Start-menu shortcuts and unusual
  // per-user install roots. The manifest paths above remain the primary source.
  return findInstalledLauncher(provider.id, options)
}

/** Read the executable registered for a provider URI without invoking the URI. */
function protocolExecutable(provider) {
  if (process.platform !== 'win32') return null
  const uri = String(provider.protocolUri || '')
  const scheme = uri.replace(/:\/\/.*$/, '').replace(/[^a-z0-9+.-]/gi, '')
  if (!scheme) return null

  for (const root of ['HKCU\\Software\\Classes', 'HKCR']) {
    try {
      const output = execFileSync(
        'reg.exe',
        ['query', `${root}\\${scheme}\\shell\\open\\command`, '/ve'],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
      const command = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /REG_(?:EXPAND_)?SZ/i.test(line))
      if (!command) continue

      const quoted = command.match(/"([^"]+\.exe)"/i)
      const bare = command.match(/([A-Za-z]:\\[^\s"]+\.exe)/i)
      const executable = quoted?.[1] || bare?.[1]
      if (isFile(executable)) return executable
    } catch {
      /* scheme is not registered */
    }
  }

  return null
}

function detectProvider(id, options = {}) {
  const provider = providerForId(id)
  if (!provider) return { installed: false, error: 'Unknown online provider.' }

  const executable = findProviderExecutable(provider, options)
  const registered = protocolExecutable(provider)
  const viaProtocol = !executable && Boolean(registered)
  return {
    providerId: provider.id,
    name: provider.name,
    label: provider.label || provider.name,
    installed: Boolean(executable || registered),
    executable: executable || registered || null,
    protocolRegistered: Boolean(registered),
    viaProtocol,
    installerUrl: provider.installerUrl,
  }
}

async function openInstaller(id, shell) {
  const provider = providerForId(id)
  if (!provider) return { opened: false, error: 'Unknown online provider.' }
  if (typeof provider.installerUrl !== 'string' || !/^https:\/\//i.test(provider.installerUrl)) {
    return { opened: false, error: 'The provider does not have a secure installer URL.' }
  }
  if (!shell || typeof shell.openExternal !== 'function') {
    return { opened: false, url: provider.installerUrl, error: 'Opening the installer needs the desktop app.' }
  }

  try {
    await shell.openExternal(provider.installerUrl)
    return { opened: true, url: provider.installerUrl, name: provider.name }
  } catch (error) {
    return {
      opened: false,
      url: provider.installerUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

module.exports = {
  detectProvider,
  openInstaller,
  providerForId,
  protocolExecutable,
}
