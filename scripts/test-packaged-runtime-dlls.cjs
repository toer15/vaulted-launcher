#!/usr/bin/env node
'use strict'

/**
 * Packaged DLL integrity regression.
 *
 * Run after electron-builder has produced release/win-unpacked. The test points
 * onlineProviders.cjs at that packaged resources tree and exercises the same
 * providerRuntime/redirectDllMatchesProfile checks the launcher uses at Play.
 * It also verifies every bundled Tellurium/Cobalt copy against the integrity
 * manifest, so a rebuilt DLL cannot ship with a stale checksum.
 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.join(__dirname, '..')
const flag = process.argv.find((arg) => arg.startsWith('--resources-dir='))
const resourcesRoot = path.resolve(
  flag ? flag.slice('--resources-dir='.length) : path.join(projectRoot, 'release', 'win-unpacked', 'resources'),
)
const providersRoot = path.join(resourcesRoot, 'providers')

if (!fs.existsSync(providersRoot)) {
  console.error(`Packaged providers folder is missing: ${providersRoot}`)
  process.exit(2)
}

const temporaryAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-packaged-dlls-'))
// Keep providerDllPath away from this PC's real %APPDATA% repairs.
process.env.APPDATA = temporaryAppData
Object.defineProperty(process, 'resourcesPath', {
  value: resourcesRoot,
  configurable: true,
})

const {
  providerCatalog,
  providerProfile,
  providerRoot,
  providerRuntime,
  providerUsesLegacyRedirect,
  redirectDllMatchesProfile,
  redirectSupportsBackendParameter,
} = require('../electron/onlineProviders.cjs')

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (entry.isFile()) files.push(full)
  }
  return files
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function main() {
  const manifest = readJson(path.join(providersRoot, 'provider.json'))
  const runtimeManifest = readJson(path.join(providersRoot, 'runtime.json'))
  const tellurium = path.join(providersRoot, 'runtime', 'Tellurium.dll')
  const cobalt = path.join(providersRoot, 'runtime', 'Cobalt.dll')
  const telluriumHash = hash(tellurium)
  const cobaltHash = hash(cobalt)

  assert.equal(path.resolve(providerRoot()), path.resolve(providersRoot), 'providerRoot did not resolve the packaged tree')
  assert.equal(
    manifest.runtime?.redirectDllSha256,
    telluriumHash,
    'provider.json Tellurium checksum does not match the packaged DLL',
  )
  assert.equal(
    manifest.runtime?.legacyRedirectDllName,
    'Cobalt.dll',
    'provider.json has no legacy Cobalt manifest entry',
  )
  assert.equal(
    manifest.runtime?.legacyRedirectDllSha256,
    cobaltHash,
    'provider.json Cobalt checksum does not match the packaged DLL',
  )
  assert.ok(runtimeManifest.dlls?.includes('Cobalt.dll'), 'runtime.json does not list Cobalt.dll')
  assert.ok(
    runtimeManifest.licenses?.includes('Cobalt-LICENSE.txt'),
    'runtime.json does not list the Cobalt license',
  )
  assert.ok(fs.existsSync(path.join(providersRoot, 'runtime', 'Cobalt-LICENSE.txt')), 'Cobalt license is missing')

  assert.equal(providerUsesLegacyRedirect('3.0', 'ch1-s3'), true)
  assert.equal(providerUsesLegacyRedirect('14.60', 'ch2-s4'), false)

  const providers = providerCatalog().filter((provider) => provider.mode !== 'external')
  assert.ok(providers.length >= 6, 'packaged provider catalog is unexpectedly small')

  let modernChecked = 0
  let legacyChecked = 0
  for (const provider of providers) {
    const profile = providerProfile(provider.id)

    const modern = providerRuntime(profile)
    assert.ok(fs.existsSync(modern.dll), `${provider.id}: modern redirect DLL is missing`)
    assert.equal(
      redirectDllMatchesProfile(modern.dll, modern.profile),
      true,
      `${provider.id}: modern redirect DLL failed its runtime checksum check`,
    )
    assert.equal(
      redirectSupportsBackendParameter(modern.dll),
      true,
      `${provider.id}: modern redirect DLL has no -backend= support`,
    )
    modernChecked += 1

    const legacy = providerRuntime(profile, { legacy: true })
    assert.equal(path.basename(legacy.dll), 'Cobalt.dll', `${provider.id}: legacy launch did not select Cobalt`)
    assert.equal(
      legacy.profile.redirectDllSha256,
      cobaltHash,
      `${provider.id}: legacy profile carries the wrong Cobalt checksum`,
    )
    assert.equal(
      redirectDllMatchesProfile(legacy.dll, legacy.profile),
      true,
      `${provider.id}: legacy redirect DLL failed its runtime checksum check`,
    )
    assert.equal(
      redirectSupportsBackendParameter(legacy.dll),
      true,
      `${provider.id}: legacy redirect DLL has no -backend= support`,
    )
    // This is the exact 1.0.112 regression: Cobalt must not be checked against
    // the provider's modern Tellurium profile.
    assert.equal(
      redirectDllMatchesProfile(legacy.dll, profile),
      false,
      `${provider.id}: test fixture no longer distinguishes Cobalt from Tellurium`,
    )
    legacyChecked += 1
  }

  const dlls = walk(resourcesRoot).filter((file) => /\.dll$/i.test(file))
  const telluriumCopies = dlls.filter((file) => path.basename(file).toLowerCase() === 'tellurium.dll')
  const cobaltCopies = dlls.filter((file) => path.basename(file).toLowerCase() === 'cobalt.dll')
  assert.ok(telluriumCopies.length > 0, 'no Tellurium.dll was packaged')
  assert.ok(cobaltCopies.length > 0, 'no Cobalt.dll was packaged')
  for (const file of telluriumCopies) {
    assert.equal(hash(file), telluriumHash, `${path.relative(resourcesRoot, file)} has a stale Tellurium checksum`)
  }
  for (const file of cobaltCopies) {
    assert.equal(hash(file), cobaltHash, `${path.relative(resourcesRoot, file)} has a stale Cobalt checksum`)
  }

  // Lock the launch wiring that caused the 1.0.112 failure.
  const mainSource = fs.readFileSync(path.join(projectRoot, 'electron', 'main.cjs'), 'utf8')
  assert.match(
    mainSource,
    /redirectDllMatchesProfile\(redirectDll, runtime\.profile\)/,
    'provider launch still validates the selected DLL against the wrong profile',
  )
  assert.match(
    mainSource,
    /redirectDllMatchesProfile\(runtime\.dll, runtime\.profile\)/,
    'provider preparation still validates the selected DLL against the wrong profile',
  )

  console.log(
    `packaged DLL integrity passed: ${modernChecked} modern + ${legacyChecked} Cobalt profiles, ` +
      `${telluriumCopies.length} Tellurium and ${cobaltCopies.length} Cobalt copies match the manifest`,
  )
}

try {
  main()
} finally {
  fs.rmSync(temporaryAppData, { recursive: true, force: true })
}
