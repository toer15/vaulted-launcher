#!/usr/bin/env node
'use strict'

const { readdirSync } = require('node:fs')
const { join, relative } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = join(__dirname, '..')
const targets = ['electron', 'scripts']

function cjsFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...cjsFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.cjs')) files.push(path)
  }
  return files
}

const files = targets.flatMap((target) => cjsFiles(join(root, target))).sort()
const failures = []

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push({
      file: relative(root, file),
      message: (result.stderr || result.stdout || 'Unknown syntax error').trim(),
    })
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n${failure.file}\n${failure.message}`)
  }
  console.error(`\nSyntax check failed for ${failures.length} of ${files.length} CommonJS files.`)
  process.exit(1)
}

console.log(`Syntax checks passed (${files.length} CommonJS files).`)
