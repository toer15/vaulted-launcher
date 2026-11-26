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
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr r, IntPtr hrgn, uint flags);
}
"@
function Find-VaultedTopWindow([int]$targetPid) {
  $script:foundTop = [IntPtr]::Zero
  $script:foundArea = 0
  $cb = [VaultedHiddenWindow+EnumProc]{
    param($h, $l)
    $owner = [uint32]0
    [void][VaultedHiddenWindow]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq $targetPid) {
      $r = New-Object VaultedHiddenWindow+RECT
      [void][VaultedHiddenWindow]::GetWindowRect($h, [ref]$r)
      $area = ($r.R - $r.L) * ($r.B - $r.T)
      # A Tauri/WebView app owns helper windows too; always pick its real one.
      # A minimized window reports a tiny (sometimes zero) rect, so never drop
      # the only window a process has just because its area looks small.
      if ($area -gt $script:foundArea -or $script:foundTop -eq [IntPtr]::Zero) {
        $script:foundArea = [Math]::Max($script:foundArea, $area)
        $script:foundTop = $h
      }
    }
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

function warmScript(pid, width, height, settleMs) {
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  const safeWidth = Math.max(380, Math.min(1600, Math.floor(Number(width) || 1200)))
  const safeHeight = Math.max(420, Math.min(1200, Math.floor(Number(height) || 800)))
  const settle = Math.max(600, Math.min(4000, Math.floor(Number(settleMs) || 1800)))
  return `
${WINDOW_TYPES}
$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue
if (-not $p) { 'NO_PROCESS'; exit 1 }
$top = Find-VaultedTopWindow ${safePid}
if ($top -eq [IntPtr]::Zero) { 'NO_WINDOW'; exit 2 }
# A window hidden before its WebView painted stays black when first revealed.
# SW_RESTORE (not SW_SHOW) also brings back an adopted launcher the player left
# minimized in the taskbar. Show it off every monitor, give the renderer time
# to build its compositor, then force a real resize and repaint.
[void][VaultedHiddenWindow]::ShowWindow($top, 9)
[void][VaultedHiddenWindow]::SetWindowPos($top, [IntPtr]::Zero, -20000, -20000, ${safeWidth}, ${safeHeight}, 0x0010 -bor 0x0040)
Start-Sleep -Milliseconds ${settle}
[void][VaultedHiddenWindow]::SetWindowPos($top, [IntPtr]::Zero, -20000, -20000, ${safeWidth + 1}, ${safeHeight + 1}, 0x0010 -bor 0x0040)
Start-Sleep -Milliseconds 250
[void][VaultedHiddenWindow]::SetWindowPos($top, [IntPtr]::Zero, -20000, -20000, ${safeWidth}, ${safeHeight}, 0x0010 -bor 0x0040)
[void][VaultedHiddenWindow]::RedrawWindow($top, [IntPtr]::Zero, [IntPtr]::Zero, 0x0001 -bor 0x0004 -bor 0x0080 -bor 0x0100 -bor 0x0400)
Start-Sleep -Milliseconds 250
'WARMED'
`
}

function showScript(pid) {
  return `
${WINDOW_TYPES}
$p = Get-Process -Id ${Math.max(1, Math.floor(Number(pid) || 0))} -ErrorAction SilentlyContinue
if (-not $p) { 'NO_PROCESS'; exit 1 }
$top = Find-VaultedTopWindow ${Math.max(1, Math.floor(Number(pid) || 0))}
if ($top -eq [IntPtr]::Zero) { 'NO_WINDOW'; exit 2 }
# A previous session may have left the window off-screen; put it back on it.
[void][VaultedHiddenWindow]::ShowWindow($top, 9)
# HWND_TOP + SWP_SHOWWINDOW, never HWND_TOPMOST: this explicit community
# launch is the one moment the player must see and use the launcher.
[void][VaultedHiddenWindow]::SetWindowPos($top, [IntPtr]::Zero, 120, 80, 1200, 800, 0x0040)
[void][VaultedHiddenWindow]::SetForegroundWindow($top)
# An adopted launcher can stay minimized or refuse to restore; report that so
# the caller retries instead of claiming a sign-in window nobody can see.
Start-Sleep -Milliseconds 200
if ([VaultedHiddenWindow]::IsIconic($top) -or -not [VaultedHiddenWindow]::IsWindowVisible($top)) { 'NOT_VISIBLE'; exit 3 }
'SHOWN'
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

/**
 * Let a launcher that was started hidden initialize its WebView while it is
 * still off every monitor. Without this the first reveal is an all-black
 * window with only the native title bar.
 */
async function warmCompanionLauncherWindow(pid, options = {}) {
  if (process.platform !== 'win32') return false
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 10
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 350
  const width = Number(options.width) || 1200
  const height = Number(options.height) || 800
  const settleMs = Number(options.settleMs) || 1800
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { output } = await runPowerShell(warmScript(pid, width, height, settleMs), 12_000)
    if (output === 'WARMED') return true
    if (output === 'NO_PROCESS') return false
    await delay(waitMs)
  }
  return false
}

/**
 * A launcher such as Era owns several helper processes; only one owns the real
 * top-level window. Pick that PID so a sign-in popup is not sent to a helper
 * that has no window to reveal.
 */
async function findCompanionWindowPid(pids) {
  if (process.platform !== 'win32') return 0
  const clean = [...new Set((Array.isArray(pids) ? pids : [pids]).map((value) => Math.floor(Number(value) || 0)))].filter(
    (value) => value > 0,
  )
  if (clean.length === 0) return 0
  const script = `
${WINDOW_TYPES}
$bestPid = 0
$bestArea = 0
$firstPid = 0
foreach ($id in @(${clean.join(',')})) {
  $top = Find-VaultedTopWindow $id
  if ($top -eq [IntPtr]::Zero) { continue }
  if ($firstPid -eq 0) { $firstPid = $id }
  $r = New-Object VaultedHiddenWindow+RECT
  [void][VaultedHiddenWindow]::GetWindowRect($top, [ref]$r)
  $area = ($r.R - $r.L) * ($r.B - $r.T)
  if ($area -gt $bestArea) { $bestArea = $area; $bestPid = $id }
}
# A minimized window can report a zero rect; it is still the launcher's window.
if ($bestPid -eq 0) { $bestPid = $firstPid }
$bestPid
`
  const { output } = await runPowerShell(script, 8_000)
  const pid = Number(String(output || '').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : 0
}

async function hideCompanionLauncher(pid) {
  if (process.platform !== 'win32') return false
  const { output } = await runPowerShell(hideScript(pid), 10_000)
  return output === 'HIDDEN'
}

/**
 * Make a launcher window rendered but keep it off every monitor. WebView2 builds
 * no accessibility tree for a hidden window, but Eon's only launch API is its
 * Play button in that tree. Showing it off-screen lets UI Automation find and
 * invoke the button without the player seeing a flash of the launcher.
 */
async function showCompanionLauncherOffscreen(pid, options = {}) {
  if (process.platform !== 'win32') return false
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 8
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 350
  const script = `
${WINDOW_TYPES}
$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue
if (-not $p) { 'NO_PROCESS'; exit 1 }
$top = Find-VaultedTopWindow ${safePid}
if ($top -eq [IntPtr]::Zero) { 'NO_WINDOW'; exit 2 }
[void][VaultedHiddenWindow]::ShowWindow($top, 4)
[void][VaultedHiddenWindow]::SetWindowPos($top, [IntPtr]::Zero, -20000, -20000, 1200, 800, 0x0010 -bor 0x0040)
'SHOWN_OFFSCREEN'
`
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { output } = await runPowerShell(script, 10_000)
    if (output === 'SHOWN_OFFSCREEN') return true
    if (output === 'NO_PROCESS') return false
    await delay(waitMs)
  }
  return false
}

/**
 * Bring a launcher window back on screen. A community launcher needs its own
 * sign-in/Play UI the first time, and an earlier hidden session can leave the
 * saved window position off every monitor, so show and reposition it.
 */
async function showCompanionLauncher(pid, options = {}) {
  if (process.platform !== 'win32') return false
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 12
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 500
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { output } = await runPowerShell(showScript(pid), 10_000)
    if (output === 'SHOWN') return true
    if (output === 'NO_PROCESS') return false
    await delay(waitMs)
  }
  return false
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
  showCompanionLauncher,
  showCompanionLauncherOffscreen,
  warmCompanionLauncherWindow,
  findCompanionWindowPid,
  delay,
  runPowerShell,
}
