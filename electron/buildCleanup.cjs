'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Conservative cleanup for VAULTED-managed season folders.
 *
 * The automatic pass is allowed to remove downloaded archives once a complete
 * client exists. It only removes a second client tree when profiles.json has a
 * live executable pointing at the selected tree and the other tree is
 * incomplete. Two complete clients, a missing/stale profile, and every
 * `.vaulted-previous` repair backup are left untouched.
 */

const DEFAULT_CLIENT_EXE = 'fortniteclient-win64-shipping.exe'

function pathIsInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function samePath(left, right) {
  if (!left || !right) return false
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function hasClientFolder(folder, clientExe = DEFAULT_CLIENT_EXE) {
  return fs.existsSync(path.join(folder, 'FortniteGame', 'Binaries', 'Win64', clientExe))
}

function hasGamePaks(folder) {
  try {
    return fs
      .readdirSync(path.join(folder, 'FortniteGame', 'Content', 'Paks'))
      .some((name) => name.toLowerCase().endsWith('.pak'))
  } catch {
    return false
  }
}

function isCompleteClient(folder, clientExe = DEFAULT_CLIENT_EXE) {
  return hasClientFolder(folder, clientExe) && hasGamePaks(folder)
}

/** Find build roots, including a version folder nested under a season. */
function clientRootsWithin(root, clientExe = DEFAULT_CLIENT_EXE) {
  const roots = []
  const seen = new Set()
  const visit = (folder, depth) => {
    if (depth > 3) return
    const resolved = path.resolve(folder)
    const key = resolved.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)

    if (hasClientFolder(resolved, clientExe)) roots.push(resolved)

    let entries
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name.toLowerCase()
      if (name === 'fortnitegame' || name === 'engine' || name.startsWith('.')) continue
      visit(path.join(resolved, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  return roots
}

async function pathBytes(target) {
  let bytes = 0
  const stack = [path.resolve(target)]
  while (stack.length > 0) {
    const current = stack.pop()
    let stat
    try {
      stat = await fs.promises.lstat(current)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      let entries
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) stack.push(path.join(current, entry.name))
      continue
    }
    bytes += stat.size
  }
  return bytes
}

function isCompletedArchive(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.part')) return false
  return /(?:^|\.)(?:zip|rar|7z|iso|tar|gz|tgz|001|002|003)$/i.test(lower)
}

async function removeArchiveFiles(root, removed) {
  let freedBytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile() || !isCompletedArchive(entry.name)) continue
      const relative = path.relative(root, full)
      if (
        relative
          .split(path.sep)
          .some((part) => part.toLowerCase().includes('.vaulted-previous'))
      ) {
        continue
      }
      try {
        const stat = await fs.promises.stat(full)
        await fs.promises.rm(full, { force: true, maxRetries: 2, retryDelay: 100 })
        freedBytes += stat.size
        removed.push(full)
      } catch {
        /* a file in use is retried on the next launch */
      }
    }
  }
  return freedBytes
}

function profileActiveRoot(profile) {
  if (!profile || typeof profile !== 'object') return null
  if (typeof profile.executablePath === 'string' && fs.existsSync(profile.executablePath)) {
    const match = profile.executablePath.match(
      /^(.*?)[\\/]FortniteGame[\\/]Binaries[\\/]Win64[\\/][^\\/]+$/i,
    )
    return match ? path.resolve(match[1]) : path.dirname(path.resolve(profile.executablePath))
  }
  return null
}

/**
 * @param {object} options
 * @param {string} options.targetDir season folder
 * @param {string} [options.buildsRoot] managed builds root
 * @param {object|null} [options.profile] profiles.json entry for this season
 * @param {string} [options.canonicalHint] executable root just installed/verified
 * @param {string} [options.clientExe]
 */
async function cleanupManagedBuild({
  targetDir,
  buildsRoot = '',
  profile = null,
  canonicalHint = '',
  clientExe = DEFAULT_CLIENT_EXE,
}) {
  const root = path.resolve(targetDir)
  if (
    buildsRoot &&
    !pathIsInside(root, buildsRoot) &&
    !samePath(root, buildsRoot)
  ) {
    return null
  }

  const roots = clientRootsWithin(root, clientExe)
  if (roots.length === 0) return null

  const profileRoot = profileActiveRoot(profile)
  const hinted = canonicalHint ? path.resolve(canonicalHint) : ''
  const completeRoots = roots
    .filter((candidate) => isCompleteClient(candidate, clientExe))
    .sort((a, b) => a.length - b.length)
  const canonical =
    completeRoots.find((candidate) => samePath(candidate, hinted)) ||
    completeRoots.find((candidate) => samePath(candidate, profileRoot)) ||
    completeRoots[0]

  if (!canonical) return null

  // A hint can be newer than profiles.json. In that case the profile may be
  // stale, so never delete another client tree; only the archive is safe.
  const profileIsFresh = Boolean(profileRoot && samePath(canonical, profileRoot))
  const removed = []
  let freedBytes = 0

  if (profileIsFresh) {
    for (const candidate of roots) {
      if (samePath(candidate, canonical)) continue
      // Repair backups are never automatic cleanup targets.
      if (path.basename(candidate).toLowerCase().includes('.vaulted-previous')) continue
      // Never remove a parent that contains the selected install.
      if (pathIsInside(canonical, candidate)) continue
      // Two complete clients are ambiguous. Preserve both.
      if (isCompleteClient(candidate, clientExe)) continue
      try {
        const bytes = await pathBytes(candidate)
        await fs.promises.rm(candidate, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        })
        freedBytes += bytes
        removed.push(candidate)
      } catch {
        /* locked files are left for a later cleanup */
      }
    }
  }

  // Archives are no longer needed once a complete selected client exists.
  // Repair backups (`.vaulted-previous`) are intentionally never touched.
  freedBytes += await removeArchiveFiles(root, removed).catch(() => 0)

  return { folder: canonical, freedBytes, removed, profileIsFresh }
}

module.exports = {
  DEFAULT_CLIENT_EXE,
  cleanupManagedBuild,
  clientRootsWithin,
  hasClientFolder,
  hasGamePaks,
  isCompleteClient,
  pathIsInside,
  pathBytes,
}
