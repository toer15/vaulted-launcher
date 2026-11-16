#!/usr/bin/env node
'use strict'

/**
 * End-to-end provider repair test.
 *
 * This deliberately uses the real onlineProviders module, a temporary packaged
 * providers tree with no per-provider DLLs, and a temporary APPDATA location.
 * The only DLL available is the validated shared runtime copy, so the repair
 * must copy that bundled file into the per-user provider folders. Network access
 * is replaced with a throwing fetch to prove repair never relies on a URL.
 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.join(__dirname, '..')
const providerIds = ['reboot', 'neo', 'era', 'ezfn', 'ezfn-hybrid']
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-provider-repair-'))
const packageRoot = path.join(temporaryRoot, 'package')
const appDataRoot = path.join(temporaryRoot, 'appdata')
const packagedProviders = path.join(packageRoot, 'providers')
const packagedRuntime = path.join(packagedProviders, 'runtime')
const bundledDll = fs.readFileSync(path.join(projectRoot, 'resources', 'providers', 'runtime', 'Tellurium.dll'))
const expectedHash = crypto.createHash('sha256').update(bundledDll).digest('hex')

function targetPath(id) {
  return path.join(appDataRoot, 'VAULTED Launcher', 'providers', id, 'Tellurium.dll')
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function preparePackagedTree() {
  fs.mkdirSync(packagedRuntime, { recursive: true })
  fs.copyFileSync(
    path.join(projectRoot, 'resources', 'providers', 'runtime.json'),
    path.join(packagedProviders, 'runtime.json'),
  )
  fs.copyFileSync(
    path.join(projectRoot, 'resources', 'providers', 'runtime', 'Tellurium.dll'),
    path.join(packagedRuntime, 'Tellurium.dll'),
  )
  fs.copyFileSync(
    path.join(projectRoot, 'resources', 'providers', 'runtime', 'VaultedInjector.exe'),
    path.join(packagedRuntime, 'VaultedInjector.exe'),
  )
  for (const id of providerIds) {
    const directory = path.join(packagedProviders, id)
    fs.mkdirSync(directory, { recursive: true })
    fs.copyFileSync(
      path.join(projectRoot, 'resources', 'providers', id, 'provider.json'),
      path.join(directory, 'provider.json'),
    )
  }
}

async function main() {
  preparePackagedTree()
  process.resourcesPath = packageRoot
  process.env.APPDATA = appDataRoot
  global.fetch = () => {
    throw new Error('provider repair must not use the network')
  }

  const {
    ensureProviderRedirects,
    providerDllPath,
    providerProfile,
    providerRuntime,
    redirectDllMatchesProfile,
  } = require('../electron/onlineProviders.cjs')

  const first = await ensureProviderRedirects()
  assert.deepEqual(first.errors, [])
  assert.deepEqual(first.checked.sort(), [...providerIds].sort())
  assert.deepEqual(first.repaired.sort(), [...providerIds].sort())

  for (const id of providerIds) {
    const profile = providerProfile(id)
    assert.equal('redirectDllUrl' in profile, false, `${id}: provider still carries a download URL`)
    assert.equal('redirectDllFallbackUrls' in profile, false, `${id}: provider still carries fallback URLs`)
    const target = targetPath(id)
    assert.equal(fs.existsSync(target), true, `${id}: repaired DLL was not written`)
    assert.equal(fileHash(target), expectedHash, `${id}: repaired DLL has the wrong hash`)
    assert.equal(redirectDllMatchesProfile(target, profile), true, `${id}: repaired DLL is not valid`)

    // This is the path the provider launcher actually uses: user repair folder
    // before the packaged/shared fallback.
    assert.equal(providerDllPath(profile), path.resolve(target), `${id}: launch path is not the repaired DLL`)
    const runtime = providerRuntime(profile)
    assert.equal(runtime.dll, path.resolve(target), `${id}: runtime DLL path is not the repaired DLL`)
    assert.equal(fs.existsSync(runtime.injector), true, `${id}: repaired runtime injector is missing`)
    assert.equal(
      fs.readFileSync(runtime.dll).includes(Buffer.from('-backend=', 'utf16le')),
      true,
      `${id}: repaired DLL cannot receive -backend=`,
    )
  }

  // A second run should accept the already repaired targets without a copy or
  // network attempt.
  const second = await ensureProviderRedirects()
  assert.deepEqual(second.errors, [])
  assert.deepEqual(second.repaired.sort(), [...providerIds].sort())

  // Prove checksum validation is part of repair. Corrupt the only bundled
  // source while keeping a PE header and -backend= marker; repair must refuse
  // it rather than accepting a usable-looking DLL.
  for (const id of providerIds) fs.rmSync(path.dirname(targetPath(id)), { recursive: true, force: true })
  fs.writeFileSync(
    path.join(packagedRuntime, 'Tellurium.dll'),
    Buffer.concat([Buffer.from('MZ'), Buffer.from('-backend=', 'utf16le')]),
  )
  const rejected = await ensureProviderRedirects()
  assert.equal(rejected.repaired.length, 0)
  assert.equal(rejected.errors.length, providerIds.length)
  for (const id of providerIds) {
    assert.equal(fs.existsSync(targetPath(id)), false, `${id}: invalid bundled DLL was accepted`)
    assert.match(rejected.errors.find((item) => item.id === id)?.error || '', /checksum|missing/i)
  }

  console.log('provider repair end-to-end passed: bundled validated DLL copied for 5/5 providers; no network used')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })
