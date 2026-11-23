'use strict'

const { execFile } = require('node:child_process')

/**
 * Companion launchers expose no CLI or URL to start the game, so VAULTED
 * triggers their own Play button. Everything here is invisible: the launcher
 * window is moved outside every monitor and hidden with ShowWindow(SW_HIDE),
 * then mouse messages are posted directly to its Flutter view. The player never
 * sees a third-party window, the cursor never moves, and the launcher is never
 * brought to the foreground.
 */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runPowerShell(script, timeout = 20_000) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(String(script), 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout },
      (error, stdout) => {
        resolve({ error, output: String(stdout || '').trim() })
      },
    )
  })
}

const WINDOW_TYPES = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VaultedHiddenWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
function Find-VaultedTopWindow([int]$targetPid) {
  $script:foundTop = [IntPtr]::Zero
  $cb = [VaultedHiddenWindow+EnumProc]{
    param($h, $l)
    $owner = [uint32]0
    [void][VaultedHiddenWindow]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq $targetPid) { $script:foundTop = $h; return $false }
    return $true
  }
  [void][VaultedHiddenWindow]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:foundTop
}
function Hide-VaultedTopWindow([IntPtr]$top) {
  # Outside every monitor first, then remove it from the desktop/taskbar.
  [void][VaultedHiddenWindow]::SetWindowPos($top, [IntPtr]::Zero, -20000, -20000, 0, 0, 0x0001 -bor 0x0004)
  [void][VaultedHiddenWindow]::ShowWindow($top, 0)
}
function Find-VaultedView([IntPtr]$top) {
  $script:foundView = [IntPtr]::Zero
  $cb = [VaultedHiddenWindow+EnumProc]{
    param($h, $l)
    $name = New-Object System.Text.StringBuilder 128
    [void][VaultedHiddenWindow]::GetClassName($h, $name, 128)
    if ($name.ToString() -eq 'FLUTTERVIEW') { $script:foundView = $h; return $false }
    return $true
  }
  [void][VaultedHiddenWindow]::EnumChildWindows($top, $cb, [IntPtr]::Zero)
  return $script:foundView
}
function Send-VaultedClick([IntPtr]$view, [int]$x, [int]$y) {
  $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xffff))
  [void][VaultedHiddenWindow]::PostMessage($view, 0x0200, [IntPtr]::Zero, $lp)
  [void][VaultedHiddenWindow]::PostMessage($view, 0x0201, [IntPtr]1, $lp)
  Start-Sleep -Milliseconds 70
  [void][VaultedHiddenWindow]::PostMessage($view, 0x0202, [IntPtr]::Zero, $lp)
}
`

function hideScript(pid) {
  return `
${WINDOW_TYPES}
$p = Get-Process -Id ${Math.max(1, Math.floor(Number(pid) || 0))} -ErrorAction SilentlyContinue
if (-not $p) { 'NO_PROCESS'; exit 1 }
$top = Find-VaultedTopWindow ${Math.max(1, Math.floor(Number(pid) || 0))}
if ($top -eq [IntPtr]::Zero) { 'NO_WINDOW'; exit 2 }
Hide-VaultedTopWindow $top
'HIDDEN'
`
}

function clickScript(pid, xRatio, yRatio, fromBottom) {
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  const vertical =
    Number.isFinite(fromBottom) && fromBottom > 0
      ? '$height - ' + Math.floor(fromBottom)
      : '[int]($height * ' + Number(yRatio) + ')'
  return `
${WINDOW_TYPES}
$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue
if (-not $p) { 'NO_PROCESS'; exit 1 }
$top = Find-VaultedTopWindow ${safePid}
if ($top -eq [IntPtr]::Zero) { 'NO_WINDOW'; exit 2 }
# Hide before every interaction so the launcher can never flash on screen.
Hide-VaultedTopWindow $top
$view = Find-VaultedView $top
if ($view -eq [IntPtr]::Zero) { 'NO_VIEW'; exit 3 }
$rect = New-Object VaultedHiddenWindow+RECT
[void][VaultedHiddenWindow]::GetClientRect($view, [ref]$rect)
$width = $rect.R - $rect.L
$height = $rect.B - $rect.T
if ($width -lt 200 -or $height -lt 200) { 'BAD_RECT'; exit 4 }
$x = [int]($width * ${Number(xRatio)})
$y = ${vertical}
Send-VaultedClick $view $x $y
'CLICKED'
`
}

async function hideCompanionLauncher(pid) {
  if (process.platform !== 'win32') return false
  const { output } = await runPowerShell(hideScript(pid), 10_000)
  return output === 'HIDDEN'
}

/** Click the hidden launcher's bottom full-width Play/Close button. */
async function clickCompanionPlayButton(pid, options = {}) {
  if (process.platform !== 'win32') return { clicked: false, error: 'unsupported platform' }
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 8
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 1_000
  let last = 'NO_WINDOW'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { output, error } = await runPowerShell(clickScript(pid, 0.5, 0, 53))
    if (output === 'CLICKED') return { clicked: true }
    if (output === 'NO_PROCESS') return { clicked: false, error: 'the launcher closed' }
    last = output || (error ? error.message : 'unknown error')
    await delay(waitMs)
  }
  return { clicked: false, error: last }
}

module.exports = {
  clickCompanionPlayButton,
  hideCompanionLauncher,
  delay,
  runPowerShell,
}
