#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file))
const hash = (file) => crypto.createHash('sha256').update(read(file)).digest('hex')

const telluriumFiles = [
  'runtime/Tellurium.dll',
  'resources/providers/runtime/Tellurium.dll',
  'resources/providers/era/Tellurium.dll',
  'resources/providers/ezfn/Tellurium.dll',
  'resources/providers/ezfn-hybrid/Tellurium.dll',
  'resources/providers/reboot/Tellurium.dll',
]
const redirectHash = hash(telluriumFiles[0])
for (const file of telluriumFiles) {
  assert.equal(hash(file), redirectHash, `${file} does not match the bundled redirect DLL`)
}

const profileFiles = [
  'resources/providers/provider.json',
  'resources/providers/era/provider.json',
  'resources/providers/ezfn/provider.json',
  'resources/providers/ezfn-hybrid/provider.json',
  'resources/providers/reboot/provider.json',
]
for (const file of profileFiles) {
  const profile = JSON.parse(read(file))
  const configured =
    profile?.runtime?.redirectDllSha256 ?? profile?.redirectDllSha256 ?? ''
  assert.equal(configured.toLowerCase(), redirectHash, `${file} has a stale redirect hash`)
}

const tellurium = read('runtime/Tellurium.dll')
assert.ok(tellurium.includes(Buffer.from('-backend=', 'utf16le')), 'Tellurium has no -backend= support')
assert.ok(tellurium.includes(Buffer.from('HOOK_READY')), 'Tellurium has no hook-ready marker')

const cobalt = read('resources/providers/runtime/Cobalt.dll')
assert.ok(cobalt.includes(Buffer.from('-backend=', 'utf16le')), 'Cobalt has no -backend= support')
assert.ok(cobalt.includes(Buffer.from('HOOK_READY')), 'Cobalt has no hook-ready marker')

const injectorFile = 'runtime/VaultedInjector.exe'
const providerInjectorFile = 'resources/providers/runtime/VaultedInjector.exe'
assert.equal(
  hash(providerInjectorFile),
  hash(injectorFile),
  'the shared provider runtime has a stale VaultedInjector.exe',
)

const injector = read(injectorFile)
for (const marker of ['HOOK_VERIFIED', 'MODULE_VERIFIED', 'VAULTED_HOOK_TOKEN', 'FORWARDED=']) {
  assert.ok(
    injector.includes(Buffer.from(marker, 'utf16le')) || injector.includes(Buffer.from(marker)),
    `VaultedInjector.exe is missing ${marker}`,
  )
}

const injectorSource = fs.readFileSync(path.join(root, 'runtime/injector.cs'), 'utf8')
assert.match(injectorSource, /CREATE_SUSPENDED \| CREATE_UNICODE_ENVIRONMENT/)
assert.match(injectorSource, /FORWARDED=/)
assert.match(injectorSource, /AUTH_PASSWORD=.*\[redacted\]/s)
const injectIndex = injectorSource.indexOf('InjectIntoProcess(process.dwProcessId, dllPath, false)')
const resumeIndex = injectorSource.indexOf('ResumeThread(process.hThread)', injectIndex)
assert.ok(injectIndex > 0, 'injector does not inject the game process')
assert.ok(resumeIndex > injectIndex, 'injector resumes the game before injecting the redirect DLL')

const hooks = fs.readFileSync(path.join(root, 'resources/tellurium/Tellurium/Hooks.cpp'), 'utf8')
const patchfinder = fs.readFileSync(path.join(root, 'resources/tellurium/Tellurium/Patchfinder.cpp'), 'utf8')
const options = fs.readFileSync(path.join(root, 'resources/tellurium/Tellurium/Options.h'), 'utf8')
assert.match(options, /URLSet = Tellurium__URLSet::All/)
assert.match(patchfinder, /bool Tellurium::PE::IsImageReady/)
assert.match(hooks, /WriteHookMarker\("ready"/)

console.log(
  'redirect runtime checks passed: early suspended injection, hook-ready verification, all-request redirect, and provider DLL hashes',
)
