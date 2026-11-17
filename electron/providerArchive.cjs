'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PROVIDER_OVERLAY_MAX_FILES = 32
const PROVIDER_OVERLAY_MAX_BYTES = 256 * 1024 * 1024

/**
 * Decide whether the mismatches in a downloaded provider build can be repaired
 * as a bounded overlay. The limits apply before any chunk or content download
 * starts, so an archive that is too far from the live manifest is rejected
 * without spending another large download.
 */
function planProviderOverlay({
  report,
  manifest,
  maxFiles = PROVIDER_OVERLAY_MAX_FILES,
  maxBytes = PROVIDER_OVERLAY_MAX_BYTES,
} = {}) {
  if (!report?.issues?.length) return null
  if (report.issueCount > maxFiles) {
    throw new Error(
      `The downloaded archive is too incomplete to repair automatically (${report.issueCount} mismatched files). ` +
        'It was rejected before any exchange attempt.',
    )
  }

  const baseFiles = new Map(
    (Array.isArray(manifest?.files) ? manifest.files : []).map((file) => [
      String(file.path || '').toLowerCase(),
      file,
    ]),
  )
  const contentFiles = new Map(
    (Array.isArray(manifest?.contentFiles) ? manifest.contentFiles : []).map((file) => [
      `FortniteGame/Content/Paks/${file.name}`.toLowerCase(),
      file,
    ]),
  )

  const patchBase = new Map()
  const patchContent = new Map()
  let bytes = 0
  for (const issue of report.issues) {
    const key = String(issue.path || '').toLowerCase()
    const base = baseFiles.get(key)
    if (base) {
      if (!patchBase.has(key)) {
        patchBase.set(key, base)
        bytes += base.size
      }
      continue
    }
    const content = contentFiles.get(key)
    if (content && !patchContent.has(key)) {
      patchContent.set(key, content)
      bytes += content.size
    }
  }

  if (patchBase.size === 0 && patchContent.size === 0) return null
  if (bytes > maxBytes) {
    throw new Error(
      `The downloaded archive is missing ${bytes.toLocaleString()} bytes of provider files. ` +
        'It is too incomplete to patch; it was rejected before any exchange attempt.',
    )
  }

  return {
    patchBase,
    patchContent,
    bytes,
    files: patchBase.size + patchContent.size,
  }
}

/**
 * A repair retry may reuse the archive left by the previous attempt. The
 * returned entry is intentionally resolved without a source probe, so callers
 * can install the cache before touching the network.
 */
async function findCachedRepairArchive({
  targetDir,
  requestedName,
  repair,
  stat = fs.promises.stat,
} = {}) {
  if (!repair || !targetDir || !requestedName) return null
  const cached = path.join(targetDir, requestedName)
  const cachedStat = await stat(cached).catch(() => null)
  if (!cachedStat?.isFile() || cachedStat.size <= 0) return null
  return { path: cached, size: cachedStat.size }
}

/**
 * Select the source for a download. A cached repair archive is returned before
 * the probe callback can run, which is the property that keeps a retry from
 * hitting the network just to discover the archive it already has.
 */
async function selectProviderArchiveSource({
  targetDir,
  requestedName,
  repair,
  probe,
  stat = fs.promises.stat,
} = {}) {
  const cached = await findCachedRepairArchive({ targetDir, requestedName, repair, stat })
  if (cached) return { cached, probe: null }
  return {
    cached: null,
    probe: typeof probe === 'function' ? await probe() : null,
  }
}

module.exports = {
  PROVIDER_OVERLAY_MAX_BYTES,
  PROVIDER_OVERLAY_MAX_FILES,
  findCachedRepairArchive,
  planProviderOverlay,
  selectProviderArchiveSource,
}
