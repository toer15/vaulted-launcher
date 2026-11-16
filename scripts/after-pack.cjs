'use strict'

const path = require('node:path')
const { required, verifyRuntime } = require('./verify-runtime.cjs')

/**
 * electron-builder runs this after it copies extraResources into appOutDir and
 * before it creates the NSIS installer. The source guard alone cannot catch a
 * bad extraResources mapping or a file omitted while packaging.
 */
module.exports = async function afterPack(context) {
  const appOutDir = context?.appOutDir
  if (!appOutDir) throw new Error('Release guard: afterPack did not provide appOutDir.')

  const runtimeDir = path.join(appOutDir, 'resources', 'runtime')
  const problems = verifyRuntime(runtimeDir)

  if (problems.length > 0) {
    throw new Error(
      [
        `Release guard: packaged runtime is incomplete at ${runtimeDir}.`,
        'Refusing to build an installer that would break every season launch:',
        ...problems.map((problem) => `  - ${problem}`),
      ].join('\n'),
    )
  }

  console.log(
    `Release guard: packaged runtime verified — ${required.length} required files present in ${runtimeDir}`,
  )
}
