'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { cleanupManagedBuild } = require('../electron/buildCleanup.cjs')

const CLIENT = 'FortniteClient-Win64-Shipping.exe'

function makeClient(root, { pak = true, marker = '' } = {}) {
  const bin = path.join(root, 'FortniteGame', 'Binaries', 'Win64')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, CLIENT), marker || root)
  if (pak) {
    const paks = path.join(root, 'FortniteGame', 'Content', 'Paks')
    fs.mkdirSync(paks, { recursive: true })
    fs.writeFileSync(path.join(paks, 'pakchunk0-WindowsClient.pak'), 'pak')
  }
}

function makeArchive(root) {
  fs.writeFileSync(path.join(root, '6.21.rar'), Buffer.alloc(128, 1))
}

function profileFor(executableRoot) {
  return {
    executablePath: path.join(
      executableRoot,
      'FortniteGame',
      'Binaries',
      'Win64',
      CLIENT,
    ).toLowerCase(),
  }
}

function tempSeason() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-cleanup-'))
}

async function run() {
  const cases = []

  // 1. Fresh profile, two complete clients: both must survive.
  {
    const root = tempSeason()
    const active = path.join(root, 'active')
    const duplicate = path.join(root, '6.21')
    makeClient(active)
    makeClient(duplicate)
    makeArchive(root)
    const result = await cleanupManagedBuild({
      targetDir: root,
      buildsRoot: root,
      profile: profileFor(active),
    })
    assert.ok(fs.existsSync(path.join(active, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.ok(fs.existsSync(path.join(duplicate, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.ok(
      result &&
        !result.removed.some((entry) => path.resolve(entry) === path.resolve(duplicate)),
    )
    fs.rmSync(root, { recursive: true, force: true })
    cases.push('two complete clients preserved')
  }

  // 2. Stale profile, incomplete duplicate: nothing under the season is removed,
  //    because the active install cannot be identified safely.
  {
    const root = tempSeason()
    const active = path.join(root, 'active')
    const duplicate = path.join(root, '6.21')
    makeClient(active)
    makeClient(duplicate, { pak: false })
    const result = await cleanupManagedBuild({
      targetDir: root,
      buildsRoot: root,
      profile: { executablePath: path.join(root, 'gone', 'FortniteGame', 'Binaries', 'Win64', CLIENT) },
    })
    assert.ok(fs.existsSync(path.join(active, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.ok(fs.existsSync(path.join(duplicate, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.ok(result)
    fs.rmSync(root, { recursive: true, force: true })
    cases.push('stale profile preserved every client tree')
  }

  // 3. Fresh profile, one incomplete duplicate: only that incomplete tree goes.
  {
    const root = tempSeason()
    const active = path.join(root, 'active')
    const duplicate = path.join(root, '6.21')
    makeClient(active)
    makeClient(duplicate, { pak: false })
    const result = await cleanupManagedBuild({
      targetDir: root,
      buildsRoot: root,
      profile: profileFor(active),
    })
    assert.ok(fs.existsSync(path.join(active, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.equal(fs.existsSync(duplicate), false)
    assert.ok(result && result.freedBytes > 0)
    fs.rmSync(root, { recursive: true, force: true })
    cases.push('fresh profile removed only the incomplete duplicate')
  }

  // 4. Repair backups always survive, including with a fresh complete profile.
  {
    const root = tempSeason()
    const active = path.join(root, 'active')
    const backup = path.join(root, '6.21.vaulted-previous')
    makeClient(active)
    makeClient(backup, { pak: false })
    fs.writeFileSync(path.join(backup, 'repair.rar'), Buffer.alloc(64, 2))
    const result = await cleanupManagedBuild({
      targetDir: root,
      buildsRoot: root,
      profile: profileFor(active),
    })
    assert.ok(fs.existsSync(path.join(active, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.ok(fs.existsSync(path.join(backup, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.ok(fs.existsSync(path.join(backup, 'repair.rar')))
    assert.ok(result && result.removed.every((entry) => !entry.includes('vaulted-previous')))
    fs.rmSync(root, { recursive: true, force: true })
    cases.push('repair backup preserved')
  }

  // 5. A stale profile with a newly verified hint must not remove the old tree.
  {
    const root = tempSeason()
    const old = path.join(root, 'old')
    const fresh = path.join(root, 'fresh')
    makeClient(old)
    makeClient(fresh)
    makeArchive(root)
    const result = await cleanupManagedBuild({
      targetDir: root,
      buildsRoot: root,
      profile: profileFor(old),
      canonicalHint: fresh,
    })
    assert.ok(fs.existsSync(path.join(old, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.ok(fs.existsSync(path.join(fresh, 'FortniteGame', 'Binaries', 'Win64', CLIENT)))
    assert.ok(result && result.removed.every((entry) => !entry.includes('old')))
    fs.rmSync(root, { recursive: true, force: true })
    cases.push('stale profile vs fresh hint preserved both clients')
  }

  console.log(`cleanup safety passed: ${cases.join('; ')}`)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
