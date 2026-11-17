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

const {
  PROVIDER_OVERLAY_MAX_BYTES,
  PROVIDER_OVERLAY_MAX_FILES,
  findCachedRepairArchive,
  planProviderOverlay,
  selectProviderArchiveSource,
} = require('../electron/providerArchive.cjs')

const projectRoot = path.join(__dirname, '..')
// These providers ship a per-provider profile; Stellar and Retrac are defined
// only in the central catalog and reuse the shared runtime.
const localProviderIds = ['reboot', 'neo', 'era', 'ezfn', 'ezfn-hybrid']
// Stellar and Retrac reuse the shared DLL; the external projects are links to
// their own launchers/communities and deliberately have no redirect DLL.
const globalProviderIds = ['stellar']
const externalProviderIds = [
  'eon', 'hydro', 'interloop', 'crystal', 'echo', 'arc', 'retrac-official',
  'slurp', 'ambient', 'reef', 'legacy-mp', 'horizon', 'sunset', 'blue-og', 'glow',
]
const dllProviderIds = [...localProviderIds, ...globalProviderIds]
const providerIds = [...dllProviderIds, ...externalProviderIds]
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

function testProviderOverlayCaps() {
  const manifest = {
    files: [
      { path: 'FortniteGame/Content/Paks/base-a.pak', size: 1024 },
      { path: 'FortniteGame/Content/Paks/base-b.pak', size: 2048 },
    ],
    contentFiles: [{ name: 'content-a.pak', size: 512, hash: md5('content-a.pak:512') }],
  }
  const issue = (file) => ({ path: file, kind: 'missing' })
  const manyIssues = Array.from({ length: PROVIDER_OVERLAY_MAX_FILES + 1 }, (_, index) =>
    issue(`missing-${index}.pak`),
  )
  assert.throws(
    () =>
      planProviderOverlay({
        report: { issueCount: manyIssues.length, issues: manyIssues },
        manifest,
      }),
    /too incomplete/i,
    'the overlay must reject more than its file cap',
  )

  assert.throws(
    () =>
      planProviderOverlay({
        report: {
          issueCount: 2,
          issues: [
            issue('FortniteGame/Content/Paks/base-a.pak'),
            issue('FortniteGame/Content/Paks/base-b.pak'),
          ],
        },
        manifest: {
          files: [
            { path: 'FortniteGame/Content/Paks/base-a.pak', size: PROVIDER_OVERLAY_MAX_BYTES },
            { path: 'FortniteGame/Content/Paks/base-b.pak', size: 1 },
          ],
          contentFiles: [],
        },
      }),
    /too incomplete/i,
    'the overlay must reject more than its byte cap',
  )

  const atCap = planProviderOverlay({
    report: {
      issueCount: PROVIDER_OVERLAY_MAX_FILES,
      issues: Array.from({ length: PROVIDER_OVERLAY_MAX_FILES }, () =>
        issue('FortniteGame/Content/Paks/base-a.pak'),
      ),
    },
    manifest,
  })
  assert.ok(atCap, 'the overlay must allow the exact file cap')

  const plan = planProviderOverlay({
    report: {
      issueCount: 2,
      issues: [issue('FortniteGame/Content/Paks/base-a.pak'), issue('FortniteGame/Content/Paks/content-a.pak')],
    },
    manifest,
  })
  assert.ok(plan)
  assert.equal(plan.files, 2)
  assert.equal(plan.bytes, 1536)
  assert.equal(plan.patchBase.has('fortnitegame/content/paks/base-a.pak'), true)
  assert.equal(plan.patchContent.has('fortnitegame/content/paks/content-a.pak'), true)
}

async function testCachedRepairArchiveReuse() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaulted-cached-repair-'))
  const archive = path.join(root, 'cached-build.rar')
  fs.writeFileSync(archive, 'cached archive bytes')
  const previousFetch = global.fetch
  let networkCalls = 0
  global.fetch = () => {
    networkCalls += 1
    throw new Error('cached archive reuse must not use the network')
  }
  try {
    let probeCalls = 0
    const selected = await selectProviderArchiveSource({
      targetDir: root,
      requestedName: 'cached-build.rar',
      repair: true,
      probe: () => {
        probeCalls += 1
        throw new Error('cached archive reuse must not probe the network')
      },
    })
    assert.deepEqual(selected.cached, { path: archive, size: 'cached archive bytes'.length })
    assert.equal(probeCalls, 0, 'cache selection ran the network probe')

    const cached = await findCachedRepairArchive({
      targetDir: root,
      requestedName: 'cached-build.rar',
      repair: true,
    })
    assert.deepEqual(cached, { path: archive, size: 'cached archive bytes'.length })
    assert.equal(
      await findCachedRepairArchive({ targetDir: root, requestedName: 'cached-build.rar', repair: false }),
      null,
      'a non-repair download must not reuse an existing archive',
    )
    let missProbeCalls = 0
    const miss = await selectProviderArchiveSource({
      targetDir: root,
      requestedName: 'not-cached.rar',
      repair: true,
      probe: () => {
        missProbeCalls += 1
        return { supported: true, total: 5 }
      },
    })
    assert.equal(miss.cached, null)
    assert.equal(miss.probe.total, 5)
    assert.equal(missProbeCalls, 1, 'a cache miss should probe the source once')
    assert.equal(networkCalls, 0, 'cache lookup performed a network request')
  } finally {
    global.fetch = previousFetch
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex')
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
  fs.copyFileSync(
    path.join(projectRoot, 'resources', 'providers', 'provider.json'),
    path.join(packagedProviders, 'provider.json'),
  )
  for (const id of localProviderIds) {
    const directory = path.join(packagedProviders, id)
    fs.mkdirSync(directory, { recursive: true })
    fs.copyFileSync(
      path.join(projectRoot, 'resources', 'providers', id, 'provider.json'),
      path.join(directory, 'provider.json'),
    )
  }
}

async function main() {
  testProviderOverlayCaps()
  await testCachedRepairArchiveReuse()
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
  assert.deepEqual(first.repaired.sort(), [...dllProviderIds].sort())

  for (const id of dllProviderIds) {
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
  assert.deepEqual(second.repaired.sort(), [...dllProviderIds].sort())

  // Prove checksum validation is part of repair. Corrupt the only bundled
  // source while keeping a PE header and -backend= marker; repair must refuse
  // it rather than accepting a usable-looking DLL.
  for (const id of dllProviderIds) fs.rmSync(path.dirname(targetPath(id)), { recursive: true, force: true })
  fs.writeFileSync(
    path.join(packagedRuntime, 'Tellurium.dll'),
    Buffer.concat([Buffer.from('MZ'), Buffer.from('-backend=', 'utf16le')]),
  )
  const rejected = await ensureProviderRedirects()
  assert.equal(rejected.repaired.length, 0)
  assert.equal(rejected.errors.length, dllProviderIds.length)
  for (const id of dllProviderIds) {
    assert.equal(fs.existsSync(targetPath(id)), false, `${id}: invalid bundled DLL was accepted`)
    assert.match(rejected.errors.find((item) => item.id === id)?.error || '', /checksum|missing/i)
  }

  console.log(
    `provider repair end-to-end passed: overlay caps and cached archive reuse checked without network; bundled validated DLL copied for ${dllProviderIds.length}/${dllProviderIds.length} DLL providers`,
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })
