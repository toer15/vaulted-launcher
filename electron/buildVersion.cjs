'use strict'

/**
 * Reading the real build a folder contains.
 *
 * A season card says "3.6", but the folder on disk may still hold 3.0 from an
 * earlier download. The folder name cannot answer this — it is the season key
 * ("ch1-s3") — so the client's own markers are read instead:
 *
 *   1. Engine/Build/Build.version (UE4 JSON: MajorVersion/MinorVersion/Changelist)
 *   2. the shipping executable's FileVersion ("3.6.0" / "++Fortnite+Release-3.6-CL-4019403")
 *
 * Nothing here blocks: a missing or unreadable marker returns an empty version
 * and callers treat that as "unknown" rather than a mismatch.
 */

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const VERSION_MARKERS = [
  path.join('Engine', 'Build', 'Build.version'),
  path.join('Build', 'Build.version'),
]

const CLIENT_EXECUTABLES = [
  path.join('FortniteGame', 'Binaries', 'Win64', 'FortniteClient-Win64-Shipping.exe'),
  path.join('FortniteGame', 'Binaries', 'Win64', 'FortniteClient-Win64-Shipping_EAC.exe'),
  path.join('FortniteGame', 'Binaries', 'Win64', 'FortniteLauncher.exe'),
]

/** Major.minor of any version string; "3.6.0-CL-4019403" and "3.6" both give "3.6". */
function versionKey(value) {
  const match = String(value || '').match(/(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?(?!\d)/)
  return match ? `${Number(match[1])}.${Number(match[2])}` : null
}

/** Changelist from "…-CL-4019403" or "++Fortnite+Release-3.6-CL-4019403". */
function changelist(value) {
  const match = String(value || '').match(/CL-(\d{5,})/i)
  return match ? Number(match[1]) : null
}

async function readVersionMarker(root) {
  for (const relative of VERSION_MARKERS) {
    const file = path.join(root, relative)
    let raw
    try {
      raw = await fs.promises.readFile(file, 'utf8')
    } catch {
      continue
    }
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      continue
    }
    const major = Number(data?.MajorVersion)
    const minor = Number(data?.MinorVersion)
    if (!Number.isInteger(major) || !Number.isInteger(minor)) continue
    return {
      version: `${major}.${minor}`,
      changelist: Number(data?.Changelist) || null,
      source: relative,
    }
  }
  return null
}

/** FileVersion of a Windows executable; empty string when unavailable. */
function fileVersion(file) {
  if (process.platform !== 'win32') return Promise.resolve('')
  const quote = (value) => String(value).replace(/'/g, "''")
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${quote(file)}').VersionInfo.FileVersion`,
      ],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => resolve(error ? '' : String(stdout || '').trim()),
    )
  })
}

/**
 * The season folder plus any single nested folder that is not the game itself:
 * an archive may unpack to `ch1-s3\FortniteGame\…` or `ch1-s3\3.6\FortniteGame\…`.
 */
async function candidateRoots(folder) {
  const roots = [folder]
  let entries = []
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true })
  } catch {
    return roots
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (/^(?:FortniteGame|Engine|Content|Binaries)$/i.test(entry.name)) continue
    roots.push(path.join(folder, entry.name))
  }
  return roots
}

/** The real build version inside an installed folder, or an empty record. */
async function detectBuildVersion(folder) {
  const empty = { version: '', changelist: null, source: '' }
  if (typeof folder !== 'string' || !folder.trim()) return empty
  const root = path.resolve(folder)
  try {
    const stat = await fs.promises.stat(root)
    if (!stat.isDirectory()) return empty
  } catch {
    return empty
  }

  for (const candidate of await candidateRoots(root)) {
    const marker = await readVersionMarker(candidate)
    if (marker) return marker
    for (const relative of CLIENT_EXECUTABLES) {
      const exe = path.join(candidate, relative)
      try {
        await fs.promises.access(exe)
      } catch {
        continue
      }
      const raw = await fileVersion(exe)
      const version = versionKey(raw)
      if (version) return { version, changelist: changelist(raw), source: relative }
    }
  }
  return empty
}

module.exports = {
  CLIENT_EXECUTABLES,
  VERSION_MARKERS,
  candidateRoots,
  changelist,
  detectBuildVersion,
  versionKey,
}
