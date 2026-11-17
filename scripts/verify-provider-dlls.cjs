#!/usr/bin/env node
'use strict'

/**
 * Packaging gate: every bundled provider must have its configured redirect DLL
 * on disk, non-empty, and capable of receiving the provider's -backend= URL.
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(
  process.argv.find((arg) => arg.startsWith('--providers-dir='))?.split('=')[1] ||
    path.join(__dirname, '..', 'resources', 'providers'),
)
const expectedIds = ['neo', 'era', 'ezfn', 'ezfn-hybrid', 'reboot']
const problems = []
const rows = []

for (const id of expectedIds) {
  const directory = path.join(root, id)
  const configPath = path.join(directory, 'provider.json')
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    problems.push(`${id}: provider.json is missing or invalid (${error instanceof Error ? error.message : error})`)
    continue
  }

  if (config.id !== id) problems.push(`${id}: provider.json id is ${JSON.stringify(config.id)}`)
  const dllName = typeof config.redirectDllName === 'string' ? config.redirectDllName : ''
  if (!/^[^\\/:*?"<>|]+\.dll$/i.test(dllName) || path.basename(dllName) !== dllName) {
    problems.push(`${id}: redirectDllName is missing or unsafe`)
    continue
  }

  const dllPath = path.join(directory, dllName)
  let data
  try {
    data = fs.readFileSync(dllPath)
  } catch {
    problems.push(`${id}: ${dllName} is missing`)
    continue
  }
  if (data.length === 0) {
    problems.push(`${id}: ${dllName} is empty`)
    continue
  }
  if (data[0] !== 0x4d || data[1] !== 0x5a) {
    problems.push(`${id}: ${dllName} is not a PE binary`)
    continue
  }
  if (!data.includes(Buffer.from('-backend=', 'utf16le'))) {
    problems.push(`${id}: ${dllName} has no -backend= support`)
    continue
  }

  const hash = crypto.createHash('sha256').update(data).digest('hex')
  if (config.redirectDllSha256 && String(config.redirectDllSha256).toLowerCase() !== hash) {
    problems.push(`${id}: ${dllName} checksum does not match provider.json`)
    continue
  }
  rows.push({ id, dllName, bytes: data.length, sha256: hash })

  const gameServerDllName = typeof config.gameServerDllName === 'string' ? config.gameServerDllName : ''
  if (gameServerDllName) {
    if (!/^[^\\/:*?"<>|]+\.dll$/i.test(gameServerDllName) || path.basename(gameServerDllName) !== gameServerDllName) {
      problems.push(`${id}: gameServerDllName is unsafe`)
      continue
    }
    const gameServerCandidates = [
      path.join(directory, gameServerDllName),
      path.join(root, 'runtime', gameServerDllName),
    ]
    const gameServerPath = gameServerCandidates.find((candidate) => fs.existsSync(candidate))
    if (!gameServerPath) {
      problems.push(`${id}: ${gameServerDllName} is missing from the provider and shared runtime`)
      continue
    }
    const gameServerData = fs.readFileSync(gameServerPath)
    if (gameServerData.length === 0 || gameServerData[0] !== 0x4d || gameServerData[1] !== 0x5a) {
      problems.push(`${id}: ${gameServerDllName} is not a non-empty PE binary`)
      continue
    }
    const gameServerHash = crypto.createHash('sha256').update(gameServerData).digest('hex')
    if (config.gameServerDllSha256 && String(config.gameServerDllSha256).toLowerCase() !== gameServerHash) {
      problems.push(`${id}: ${gameServerDllName} checksum does not match provider.json`)
      continue
    }
    rows.push({ id: `${id}/server`, dllName: gameServerDllName, bytes: gameServerData.length, sha256: gameServerHash })
  }
}

// The shared legacy redirect must ship beside Tellurium; v1.x-v3.x launches
// select it by version at runtime.
const cobaltPath = path.join(root, 'runtime', 'Cobalt.dll')
try {
  const data = fs.readFileSync(cobaltPath)
  if (data.length === 0 || data[0] !== 0x4d || data[1] !== 0x5a) {
    problems.push('runtime/Cobalt.dll is not a non-empty PE binary')
  } else if (!data.includes(Buffer.from('-backend=', 'utf16le'))) {
    problems.push('runtime/Cobalt.dll has no -backend= support')
  } else if (!data.includes(Buffer.from('HOOK_READY'))) {
    problems.push('runtime/Cobalt.dll has no hook-ready marker')
  } else {
    rows.push({
      id: 'legacy',
      dllName: 'Cobalt.dll',
      bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
    })
  }
} catch {
  problems.push('runtime/Cobalt.dll is missing')
}

for (const row of rows) {
  console.log(`${row.id.padEnd(12)} ${String(row.bytes).padStart(6)} bytes  ${row.sha256}  ${row.dllName}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`ERROR: ${problem}`)
  process.exitCode = 1
} else {
  console.log(`provider DLL checks passed (${rows.length} DLLs across ${expectedIds.length} providers)`)
}
