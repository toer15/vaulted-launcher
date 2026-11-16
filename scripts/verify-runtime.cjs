#!/usr/bin/env node
/**
 * Release guard: extraResources copies this folder into every installer.
 * A packaging run must never produce an "update" whose runtime is incomplete,
 * because that turns every season launch into a missing-injector error.
 *
 * The default check validates the source runtime folder. The release build also
 * runs this against the packaged app's resources/runtime (see after-pack.cjs),
 * so a wrong extraResources copy cannot slip into an installer.
 */
const fs = require('node:fs')
const path = require('node:path')

const required = [
  ['VaultedInjector.exe', 'login injector'],
  ['Tellurium.dll', 'redirect DLL'],
  ['VAULTED-Server.dll', 'local server DLL'],
  ['Memory.dll', 'memory library'],
  ['matchmaker.cjs', 'matchmaker'],
  ['join-watchdog.cjs', 'join watchdog'],
  ['portmap.cjs', 'port mapper'],
  ['playlist-paths.json', 'playlist map'],
  ['VAULTED-Backend.zip', 'private-server backend'],
  [path.join('neonite-patch', 'vaulted-inventory.cjs'), 'inventory patch'],
  [path.join('neonite-patch', 'profile.js'), 'profile patch'],
  [path.join('neonite-patch', 'api', 'controllers', 'AuthController.js'), 'auth controller'],
  [path.join('neonite-patch', 'api', 'controllers', 'MatchMakingController.js'), 'matchmaking controller'],
  [path.join('neonite-patch', 'api', 'controllers', 'VaultedFriendsController.js'), 'friends controller'],
  [path.join('neonite-patch', 'config', 'matchmakingRoutes.js'), 'matchmaking routes'],
  [path.join('neonite-patch', 'config', 'vaultedFriendsRoutes.js'), 'friends routes'],
]

const defaultRoot = path.join(__dirname, '..', 'runtime')

/** Return a list of missing/empty/invalid runtime files; empty means valid. */
function verifyRuntime(root) {
  const problems = []
  for (const [name, label] of required) {
    const file = path.join(root, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) problems.push(`${name} is not a file (${label})`)
      else if (stat.size === 0) problems.push(`${name} is empty (${label})`)
    } catch {
      problems.push(`${name} is missing (${label})`)
    }
  }

  // Provider launches pass their backend with -backend=. The provider runtime
  // has its own backend-aware Tellurium; the local runtime deliberately uses
  // the stable redirect build, so only enforce this when checking that folder
  // (or when explicitly requested).
  const normalizedRoot = root.replace(/\\/g, '/')
  const requireBackend = normalizedRoot.includes('/providers/runtime') || process.argv.includes('--require-backend')
  if (requireBackend) {
    const tellurium = path.join(root, 'Tellurium.dll')
    try {
      const contents = fs.readFileSync(tellurium)
      if (!contents.includes(Buffer.from('-backend=', 'utf16le'))) {
        problems.push('Tellurium.dll does not support the -backend= launch option (rebuild with UseBackendParam=true)')
      }
    } catch {
      /* the required-file check above already reports a missing DLL */
    }
  }
  return problems
}

function main() {
  const flag = process.argv.indexOf('--runtime-dir')
  const explicitRoot = flag !== -1 ? process.argv[flag + 1] : null
  if (flag !== -1 && !explicitRoot) {
    console.error('--runtime-dir requires a folder path.')
    process.exit(2)
  }

  const root = explicitRoot ? path.resolve(explicitRoot) : defaultRoot
  const label = explicitRoot ? 'Packaged runtime' : 'Runtime'
  const problems = verifyRuntime(root)

  if (problems.length > 0) {
    console.error(`${label} is incomplete. Refusing to build an update that cannot launch:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  console.log(`${label} ready for packaging: ${required.length} required files present at ${root}`)
}

if (require.main === module) main()

module.exports = { required, verifyRuntime }
