'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Auto-Fix filesystem helpers.
 *
 * Only files VAULTED itself creates are ever candidates: interrupted-download
 * fragments (`*.part`, `*.tmp`, `*.crdownload`, …), stale lock files and
 * completed archives whose contents are already extracted. Game data, save
 * files, repair backups (`.vaulted-previous`) and anything unrecognised are
 * left untouched.
 */

const TEMP_FILE_RE = /(?:\.(?:part|partial|tmp|temp|crdownload|download|!ut|aria2)|\.part\.json)$/i
const ARCHIVE_RE = /\.(?:zip|rar|7z|iso|tar|gz|tgz|001|002|003)$/i
const REPAIR_BACKUP = '.vaulted-previous'

function isTempFile(name) {
  return TEMP_FILE_RE.test(String(name || ''))
}

/** Lock files are always opt-in by exact name so game data is never matched. */
function isLockFile(name) {
  const lower = String(name || '').toLowerCase()
  return (
    lower.endsWith('.lock') ||
    lower.endsWith('.lck') ||
    lower === 'lockfile' ||
    lower === '.lock' ||
    lower === '.vaulted-lock' ||
    lower === 'vaulted.lock' ||
    lower === 'fortnite.lock'
  )
}

function isCompleteArchive(name) {
  return ARCHIVE_RE.test(String(name || '').toLowerCase())
}

const CORE_CONTENT_RE = /\.(?:exe|dll|pak|ucas|utoc|sig)$/i

/**
 * Verify findings that must not make Auto-Fix re-download a whole season:
 * cleanup-owned fragments, cosmetic CMS caches, intentional placeholders and
 * empty non-content files (logs, cache images, replay placeholders).
 */
function isOptionalVerifyIssue(relative, kind) {
  const normalized = String(relative || '').replace(/\\/g, '/').toLowerCase()
  if (!normalized) return false
  if (normalized.includes('/persistentdownloaddir/')) return true
  if (normalized.endsWith('/packagedreplays/placeholder.txt')) return true
  if (kind === 'temp') return true
  if (kind === 'empty' && !CORE_CONTENT_RE.test(normalized)) return true
  return false
}

function insideRepairBackup(relative) {
  return String(relative || '')
    .split(path.sep)
    .some((part) => part.toLowerCase().includes(REPAIR_BACKUP))
}

/**
 * Read-only scan of one season folder.
 *
 * @returns {{ temp: Array<{path:string,relative:string,size:number}>, locks: Array<{path:string,relative:string,size:number,ageMs:number}>, archives: Array<{path:string,relative:string,size:number}> }}
 */
function scanLooseFiles(root, options = {}) {
  const result = { temp: [], locks: [], archives: [] }
  const base = typeof root === 'string' ? path.resolve(root) : ''
  if (!base) return result
  let rootStat
  try {
    rootStat = fs.statSync(base)
  } catch {
    return result
  }
  if (!rootStat.isDirectory()) return result

  const now = typeof options.now === 'number' ? options.now : Date.now()
  // The pre-launch check only needs the season root and its first level; a
  // deep Auto-Fix scan can look through the whole client tree.
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(0, options.maxDepth) : 6
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, options.maxEntries) : 80_000
  let visited = 0
  const stack = [{ folder: base, depth: 0 }]
  while (stack.length > 0 && visited < maxEntries) {
    const { folder: current, depth } = stack.pop()
    visited += 1
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const relative = path.relative(base, full)
      if (insideRepairBackup(relative)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ folder: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue

      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      const record = { path: full, relative, size: stat.size }
      if (isTempFile(entry.name)) {
        result.temp.push(record)
        continue
      }
      if (isLockFile(entry.name)) {
        result.locks.push({ ...record, ageMs: Math.max(0, now - stat.mtimeMs) })
        continue
      }
      if (isCompleteArchive(entry.name)) result.archives.push(record)
    }
  }
  for (const list of Object.values(result)) {
    list.sort((left, right) => left.relative.localeCompare(right.relative))
  }
  return result
}

/**
 * Remove interrupted-download fragments and stale locks. A recent lock is kept
 * because another VAULTED operation may still own it.
 *
 * @returns {{ removed: string[], kept: string[], freedBytes: number }}
 */
function removeLooseFiles(root, options = {}) {
  const removed = []
  const kept = []
  let freedBytes = 0
  const base = typeof root === 'string' ? path.resolve(root) : ''
  if (!base) return { removed, kept, freedBytes }
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const minAgeMs = Number.isFinite(options.minAgeMs) ? Math.max(0, options.minAgeMs) : 60_000
  const scan = scanLooseFiles(base, {
    now,
    maxDepth: Number.isFinite(options.maxDepth) ? options.maxDepth : 6,
    maxEntries: Number.isFinite(options.maxEntries) ? options.maxEntries : 120_000,
  })

  for (const file of scan.temp) {
    try {
      fs.rmSync(file.path, { force: true, maxRetries: 2, retryDelay: 100 })
      freedBytes += file.size
      removed.push(file.relative)
    } catch {
      kept.push(file.relative)
    }
  }
  for (const file of scan.locks) {
    if (file.ageMs < minAgeMs) {
      kept.push(file.relative)
      continue
    }
    try {
      fs.rmSync(file.path, { force: true, maxRetries: 2, retryDelay: 100 })
      freedBytes += file.size
      removed.push(file.relative)
    } catch {
      kept.push(file.relative)
    }
  }
  if (options.includeArchives === true) {
    for (const file of scan.archives) {
      try {
        fs.rmSync(file.path, { force: true, maxRetries: 2, retryDelay: 100 })
        freedBytes += file.size
        removed.push(file.relative)
      } catch {
        kept.push(file.relative)
      }
    }
  }
  return { removed, kept, freedBytes }
}

module.exports = {
  ARCHIVE_RE,
  TEMP_FILE_RE,
  isOptionalVerifyIssue,
  isCompleteArchive,
  isLockFile,
  isTempFile,
  removeLooseFiles,
  scanLooseFiles,
}
