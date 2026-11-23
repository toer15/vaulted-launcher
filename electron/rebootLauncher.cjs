'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Reboot Launcher stores its saved builds with GetStorage:
 *
 *   v3_game_storage.gs = {
 *     "versions": "[{\"name\":\"…\",\"gameVersion\":\"6.21\",\"location\":\"C:\\\\…\"}]",
 *     "version": "selected build name",
 *     "username": "…", "password": "…", "custom_launch_args": "…"
 *   }
 *
 * `versions` is a JSON string, not an array. VAULTED merges its managed build
 * into that list and selects it, so Play in the launcher starts the season the
 * player just chose without adding the folder by hand.
 */

function parseSavedBuilds(storage) {
  try {
    const parsed = JSON.parse(String(storage?.versions ?? '[]'))
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : []
  } catch {
    return []
  }
}

function samePath(left, right) {
  if (!left || !right) return false
  return path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase()
}

/** Merge one VAULTED build into Reboot's storage, preserving the user's builds. */
function mergeSavedBuild(storage, build) {
  const next = storage && typeof storage === 'object' && !Array.isArray(storage) ? { ...storage } : {}
  const versions = parseSavedBuilds(next)
  const location = path.resolve(String(build?.location || ''))
  const gameVersion = String(build?.gameVersion || '').trim()
  const name = String(build?.name || '').trim() || `VAULTED ${gameVersion}`.trim()
  const entry = { name, gameVersion, location }

  const index = versions.findIndex(
    (item) => samePath(item?.location, location) || String(item?.name || '') === name,
  )
  const added = index < 0
  if (added) versions.push(entry)
  else versions[index] = { ...versions[index], ...entry }

  next.versions = JSON.stringify(versions)
  next.version = name
  if (typeof next.username !== 'string' || !next.username) next.username = 'Player'
  if (typeof next.password !== 'string') next.password = ''
  if (typeof next.custom_launch_args !== 'string') next.custom_launch_args = ''
  return { storage: next, entry, added, versions }
}

/** The `settings` folder lives beside the installed launcher executable. */
function storageFileForLauncher(executable) {
  if (!executable) return ''
  return path.join(path.dirname(String(executable)), 'settings', 'v3_game_storage.gs')
}

function readStorage(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Write the merged build before the launcher starts. Returns `ok:false` with a
 * reason instead of throwing so a launcher handoff is never blocked by config.
 */
function writeSavedBuild({ executable, name, gameVersion, location }) {
  const file = storageFileForLauncher(executable)
  if (!file) return { ok: false, error: 'The companion launcher is not installed.' }
  if (!location) return { ok: false, error: 'This season has no install folder yet.' }
  try {
    const merged = mergeSavedBuild(readStorage(file), { name, gameVersion, location })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const text = JSON.stringify(merged.storage)
    fs.writeFileSync(file, text)
    // Reboot keeps a `.bak` next to the live storage; keep it in sync so a
    // launcher recovery does not restore an older build list.
    try {
      fs.writeFileSync(file.replace(/\.gs$/i, '.bak'), text)
    } catch {
      /* the live file is what the launcher reads */
    }
    return { ok: true, file, entry: merged.entry, added: merged.added }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

module.exports = {
  mergeSavedBuild,
  parseSavedBuilds,
  readStorage,
  storageFileForLauncher,
  writeSavedBuild,
}
