'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * These are the launchers VAULTED is allowed to start. The renderer only sends
 * a project id, never a path, so a catalog entry cannot turn into arbitrary
 * process execution.
 */
const PROJECTS = {
  echo: {
    displayNames: ['Project Echo', 'Echo Launcher', 'Echo'],
    executableNames: ['Project Echo.exe', 'Echo Launcher.exe', 'Echo.exe'],
    installDirs: ['Project Echo', 'Echo Launcher', 'Echo'],
  },
  legacy: {
    displayNames: ['Project Legacy', 'Legacy Launcher', 'Legacy'],
    executableNames: ['Project Legacy.exe', 'Legacy Launcher.exe', 'Legacy.exe'],
    installDirs: ['Project Legacy', 'Legacy Launcher', 'Legacy'],
  },
  era: {
    displayNames: ['Project Era', 'Era Launcher', 'Era'],
    executableNames: ['EraLauncher.exe', 'Era Launcher.exe', 'Project Era.exe', 'Era.exe'],
    installDirs: ['Project Era', 'Era Launcher', 'Era'],
  },
  ezfn: {
    displayNames: ['EZFN OGFN Launcher', 'EZFN Launcher', 'EZFN'],
    executableNames: ['EZFN OGFN Launcher.exe', 'EZFN Launcher.exe', 'EZFN.exe'],
    installDirs: ['EZFN OGFN Launcher', 'EZFN Launcher', 'EZFN'],
  },
  neo: {
    displayNames: ['Project Neo', 'Neo Launcher', 'Neo'],
    executableNames: ['Project Neo.exe', 'Neo Launcher.exe', 'NeoLauncher.exe', 'Neo.exe'],
    installDirs: ['Project Neo', 'Neo Launcher', 'Neo'],
  },
  'ezfn-hybrid': {
    displayNames: ['EZFN Hybrid', 'EZFN Hybrid Launcher'],
    executableNames: ['EZFN Hybrid.exe', 'EZFNHybrid.exe', 'EZFN Hybrid Launcher.exe'],
    installDirs: ['EZFN Hybrid', 'EZFN Hybrid Launcher'],
  },
  stellar: {
    displayNames: ['Stellar Launcher', 'Stellar'],
    executableNames: ['Stellar Launcher.exe', 'Stellar.exe'],
    installDirs: ['Stellar Launcher', 'Stellar'],
  },
  slurp: {
    displayNames: ['Project Slurp', 'Slurp Launcher', 'Slurp'],
    executableNames: ['Project Slurp.exe', 'Slurp Launcher.exe', 'Slurp.exe'],
    installDirs: ['Project Slurp', 'Slurp Launcher', 'Slurp'],
  },
  pulse: {
    displayNames: ['Pulse Launcher', 'Project Pulse', 'Pulse'],
    executableNames: ['Pulse.exe', 'Pulse Launcher.exe'],
    installDirs: ['Pulse Launcher', 'Project Pulse', 'Pulse'],
  },
  eon: {
    displayNames: ['Eon Launcher', 'Project Eon', 'Eon'],
    executableNames: ['Eon Launcher.exe', 'Eon-Launcher.exe', 'Eon.exe'],
    installDirs: ['Eon Launcher', 'Project Eon', 'Eon FN', 'Eon'],
  },
  retrac: {
    displayNames: ['Retrac Launcher', 'Retrac'],
    executableNames: ['Retrac Launcher.exe', 'Retrac.exe'],
    installDirs: ['Retrac Launcher', 'Retrac'],
  },
  reboot: {
    displayNames: ['Reboot Launcher', 'Project Reboot', 'Reboot'],
    executableNames: ['Reboot Launcher.exe', 'reboot_launcher.exe', 'Reboot.exe'],
    installDirs: ['Reboot Launcher', 'Project Reboot', 'Reboot'],
  },
  fortmp: {
    displayNames: ['FortMP Launcher', 'FortMP'],
    executableNames: ['FortMP Launcher.exe', 'FortMP.exe'],
    installDirs: ['FortMP Launcher', 'FortMP'],
  },
}

const ALIASES = {
  'era-rotation': 'era',
  'era-s9': 'era',
  'reboot-c1s9': 'reboot',
  'reboot-c2s1': 'reboot',
  'reboot-c2s5': 'reboot',
  'reboot-c2s7': 'reboot',
}

function uniquePaths(values) {
  const seen = new Set()
  return values.filter((value) => {
    if (typeof value !== 'string' || !value) return false
    const key = path.resolve(value).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function installRoots() {
  const local = process.env.LOCALAPPDATA
  const roaming = process.env.APPDATA
  return uniquePaths([
    local ? path.join(local, 'Programs') : null,
    local,
    roaming ? path.join(roaming, 'Programs') : null,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
  ])
}

function startMenuRoots() {
  const roaming = process.env.APPDATA
  const programData = process.env.ProgramData
  return uniquePaths([
    roaming ? path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    programData ? path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
  ])
}

function nameMatches(value, names) {
  const lower = String(value).toLowerCase().replace(/\.lnk$/i, '').trim()
  if (!lower) return false
  return names.some((name) => {
    const candidate = name.toLowerCase()
    if (lower === candidate) return true
    // A single generic word ("Pulse", "Era") must match exactly; otherwise a
    // backup folder like "Pulse Launcher.old" would be mistaken for an install.
    if (!candidate.includes(' ')) return false
    return lower.startsWith(`${candidate} `) || lower.endsWith(` ${candidate}`) || lower.includes(` ${candidate} `)
  })
}

function isUsableExecutable(file) {
  if (!/\.exe$/i.test(file)) return false
  const basename = path.basename(file).toLowerCase()
  if (/^(unins|uninstall|update|setup|install|repair)/.test(basename)) return false
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Bounded search inside one project directory, not across whole drives. */
function findExecutable(root, executableNames, depth = 0) {
  if (depth > 3) return null

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }

  for (const name of executableNames) {
    const direct = path.join(root, name)
    if (isUsableExecutable(direct)) return direct
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const nested = path.join(root, entry.name)
    for (const name of executableNames) {
      const candidate = path.join(nested, name)
      if (isUsableExecutable(candidate)) return candidate
    }
    const deeper = findExecutable(nested, executableNames, depth + 1)
    if (deeper) return deeper
  }

  return null
}

function findInInstallRoots(project) {
  for (const root of installRoots()) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!nameMatches(entry.name, project.installDirs)) continue
      const executable = findExecutable(path.join(root, entry.name), project.executableNames)
      if (executable) return executable
    }

    for (const dirName of project.installDirs) {
      const directDir = path.join(root, dirName)
      const executable = findExecutable(directDir, project.executableNames)
      if (executable) return executable
    }

    for (const executableName of project.executableNames) {
      const directExecutable = path.join(root, executableName)
      if (isUsableExecutable(directExecutable)) return directExecutable
    }
  }

  return null
}

function findInStartMenu(project, shell) {
  if (!shell || typeof shell.readShortcutLink !== 'function' || process.platform !== 'win32') return null

  const walk = (dir, depth) => {
    if (depth > 6) return null
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const nested = walk(full, depth + 1)
        if (nested) return nested
        continue
      }
      if (!/\.lnk$/i.test(entry.name)) continue
      if (!nameMatches(entry.name, [...project.displayNames, ...project.installDirs])) continue
      try {
        const shortcut = shell.readShortcutLink(full)
        const target = shortcut?.target
        if (typeof target === 'string' && isUsableExecutable(target)) return target
      } catch {
        /* corrupt or inaccessible shortcut */
      }
    }

    return null
  }

  for (const root of startMenuRoots()) {
    const executable = walk(root, 0)
    if (executable) return executable
  }

  return null
}

function findInstalledLauncher(id, options = {}) {
  const key = ALIASES[id] ?? id
  const project = PROJECTS[key]
  if (!project) return null

  return findInInstallRoots(project) ?? findInStartMenu(project, options.shell)
}

function startDetached(executable, args = []) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      child = spawn(executable, args, {
        cwd: path.dirname(executable),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (error) {
      resolve({ launched: false, error: error instanceof Error ? error.message : String(error) })
      return
    }

    timer = setTimeout(() => {
      try {
        child.unref()
      } catch {
        /* already gone */
      }
      finish({ launched: true, executable })
    }, 1500)

    child.once('error', (error) => {
      finish({ launched: false, error: error instanceof Error ? error.message : String(error) })
    })
    child.once('spawn', () => {
      try {
        child.unref()
      } catch {
        /* already gone */
      }
      finish({ launched: true, executable })
    })
  })
}

async function playHostedProject(id, options = {}) {
  const executable = findInstalledLauncher(String(id ?? ''), options)
  if (!executable) return { installed: false, launched: false }

  const result = await startDetached(executable)
  return {
    installed: true,
    launched: result.launched,
    executable: result.executable ?? executable,
    ...(result.error ? { error: result.error } : {}),
  }
}

const REBOOT_LOBBY_ID = /^[A-Za-z0-9_-]{1,80}$/

/**
 * Pass a public lobby URL to Reboot as its launch argument. This works even
 * before Reboot has registered its Reboot:// protocol, and avoids opening an
 * arbitrary URL from the renderer.
 */
async function joinHostedLobby(id, lobbyId, options = {}) {
  const key = ALIASES[String(id ?? '')] ?? String(id ?? '')
  const lobby = String(lobbyId ?? '')
  if (key !== 'reboot' || !REBOOT_LOBBY_ID.test(lobby)) {
    return { installed: false, joined: false, error: 'Invalid hosted lobby request.' }
  }

  const executable = findInstalledLauncher(key, options)
  if (!executable) return { installed: false, joined: false }

  const result = await startDetached(executable, [`Reboot://${lobby}`])
  return {
    installed: true,
    joined: result.launched,
    executable: result.executable ?? executable,
    ...(result.error ? { error: result.error } : {}),
  }
}

module.exports = { findInstalledLauncher, joinHostedLobby, playHostedProject }
