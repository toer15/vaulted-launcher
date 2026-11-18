'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * Companion launchers are background plumbing. Their windows must never appear
 * over VAULTED, not while an installer auto-starts them and not while VAULTED
 * keeps one running for auth or a game handoff.
 *
 * `windowsHide` alone only suppresses a console window; a GUI process still
 * shows its own. This module hides every visible top-level window owned by the
 * matching processes through user32 ShowWindow(SW_HIDE).
 */

const SAFE_PROCESS_NAME = /^[A-Za-z0-9 ._-]{1,80}$/

const WINDOW_HIDER_PS = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VaultedWindowHider
{
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    public static void Hide(int processId)
    {
        EnumWindows((hWnd, lParam) =>
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == (uint)processId && IsWindowVisible(hWnd)) ShowWindowAsync(hWnd, 0);
            return true;
        }, IntPtr.Zero);
    }
}
'@`

function cleanProcessNames(names) {
  const list = []
  for (const value of Array.isArray(names) ? names : [names]) {
    const name = String(value || '')
      .trim()
      .replace(/\.exe$/i, '')
    if (!name || !SAFE_PROCESS_NAME.test(name)) continue
    if (!list.includes(name)) list.push(name)
  }
  return list
}

/** PowerShell that hides every visible window of the given process names. */
function hideWindowsSnippet(names, options = {}) {
  const clean = cleanProcessNames(names)
  if (clean.length === 0) return ''
  const literals = clean.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ')
  if (!options.exitWhenGone) {
    return `foreach ($target in @(${literals})) {
  Get-Process -Name $target -ErrorAction SilentlyContinue | ForEach-Object { [VaultedWindowHider]::Hide($_.Id) }
}`
  }
  // The launch watcher lives as long as the launcher does, but stops as soon as
  // the launcher exits (after it has been seen at least once).
  return `$running = @()
foreach ($target in @(${literals})) {
  $running += @(Get-Process -Name $target -ErrorAction SilentlyContinue)
}
if ($running.Count -gt 0) {
  $seenProcess = $true
  $running | ForEach-Object { [VaultedWindowHider]::Hide($_.Id) }
} elseif ($seenProcess) { break }`
}

/**
 * Keep hiding a launcher's windows for a short window after it starts. A
 * launcher can create its main window seconds after launch (after its own
 * splash/log-in check), so a single hide call is not enough.
 */
function startHiddenWindowWatcher(names, options = {}) {
  const clean = cleanProcessNames(names)
  if (clean.length === 0 || process.platform !== 'win32') return null
  const seconds = Math.min(21_600, Math.max(5, Math.round(options.seconds ?? 120)))
  const exitWhenGone = options.exitWhenGone === true
  const script = [
    WINDOW_HIDER_PS,
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$seenProcess = $false',
    `$deadline = (Get-Date).AddSeconds(${seconds})`,
    'while ((Get-Date) -lt $deadline) {',
    hideWindowsSnippet(clean, { exitWhenGone }),
    '  Start-Sleep -Milliseconds 300',
    '}',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force',
  ].join('\r\n')
  // A here-string cannot survive passing the script through -Command, so it is
  // written to a file and run with -File; the script removes itself at the end.
  const scriptPath = path.join(
    os.tmpdir(),
    `vaulted-hide-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`,
  )
  try {
    fs.writeFileSync(scriptPath, `${script}\r\n`, 'utf8')
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
      ],
      // A detached PowerShell with no console exits immediately, so the watcher
      // is a normal hidden child that Node simply stops waiting on.
      { windowsHide: true, stdio: 'ignore' },
    )
    child.once('error', () => {
      fs.promises.rm(scriptPath, { force: true }).catch(() => {})
    })
    child.unref()
    return child.pid ?? null
  } catch {
    fs.promises.rm(scriptPath, { force: true }).catch(() => {})
    return null
  }
}

module.exports = {
  WINDOW_HIDER_PS,
  cleanProcessNames,
  hideWindowsSnippet,
  startHiddenWindowWatcher,
}
