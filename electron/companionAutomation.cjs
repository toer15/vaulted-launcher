'use strict'

const { execFile } = require('node:child_process')

/**
 * Companion launchers (Reboot, …) expose no CLI or URL to start the game, so
 * VAULTED triggers the launcher's own Play button and its automatic game
 * server prompt. This only sends a real mouse click to that launcher's window
 * after confirming it is the foreground window; it never types, clicks another
 * app, or bypasses the launcher's own backend/DLL handshake.
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
using System.Runtime.InteropServices;
public class VaultedCompanionClick {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool set);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
"@
`

function clickScript(pid, { xRatio, yRatio, yFromBottom }) {
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  const vertical =
    Number.isFinite(yRatio) && yRatio > 0
      ? `$rect.Top + [int]($ht * ${Number(yRatio)})`
      : `$rect.Top + $ht - ${Math.max(1, Math.floor(Number(yFromBottom) || 53))}`
  return `
${WINDOW_TYPES}
[void][VaultedCompanionClick]::SetProcessDPIAware()
$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue
if (-not $p) { 'NO_PROCESS'; exit 1 }
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { 'NO_WINDOW'; exit 2 }
function Invoke-VaultedClick([int]$cx, [int]$cy) {
  $old = New-Object VaultedCompanionClick+POINT
  [void][VaultedCompanionClick]::GetCursorPos([ref]$old)
  [void][VaultedCompanionClick]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 150
  [VaultedCompanionClick]::mouse_event([VaultedCompanionClick]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 70
  [VaultedCompanionClick]::mouse_event([VaultedCompanionClick]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 250
  [void][VaultedCompanionClick]::SetCursorPos($old.X, $old.Y)
}
function Get-VaultedForegroundPid {
  $fgPid = 0
  [void][VaultedCompanionClick]::GetWindowThreadProcessId([VaultedCompanionClick]::GetForegroundWindow(), [ref]$fgPid)
  return $fgPid
}
[void][VaultedCompanionClick]::ShowWindow($h, 9)
# Raise above every other window first: a launcher opened behind the app that
# requested it would otherwise receive the click only after losing it once.
[void][VaultedCompanionClick]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0043)
[void][VaultedCompanionClick]::SetWindowPos($h, [IntPtr]::new(-2), 0, 0, 0, 0, 0x0043)
$fgPid = 0
$fgThread = [VaultedCompanionClick]::GetWindowThreadProcessId([VaultedCompanionClick]::GetForegroundWindow(), [ref]$fgPid)
$dummy = 0
$targetThread = [VaultedCompanionClick]::GetWindowThreadProcessId($h, [ref]$dummy)
[void][VaultedCompanionClick]::AttachThreadInput([uint32]$fgThread, [uint32]$targetThread, $true)
[void][VaultedCompanionClick]::BringWindowToTop($h)
[void][VaultedCompanionClick]::SetForegroundWindow($h)
[void][VaultedCompanionClick]::SetFocus($h)
[void][VaultedCompanionClick]::AttachThreadInput([uint32]$fgThread, [uint32]$targetThread, $false)
Start-Sleep -Milliseconds 350
$rect = New-Object VaultedCompanionClick+RECT
[void][VaultedCompanionClick]::GetWindowRect($h, [ref]$rect)
$w = $rect.Right - $rect.Left
$ht = $rect.Bottom - $rect.Top
if ($w -lt 200 -or $ht -lt 200) { 'BAD_RECT'; exit 4 }
if ((Get-VaultedForegroundPid) -ne ${safePid}) {
  # Windows' foreground lock can still refuse SetForegroundWindow. Minimizing
  # and restoring grants the launcher the foreground, then the click is
  # delivered to it, not to whatever window happened to be on top.
  [void][VaultedCompanionClick]::ShowWindow($h, 6)
  Start-Sleep -Milliseconds 250
  [void][VaultedCompanionClick]::ShowWindow($h, 9)
  [void][VaultedCompanionClick]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 600
}
if ((Get-VaultedForegroundPid) -ne ${safePid}) { "NOT_FOCUSED:$(Get-VaultedForegroundPid):$($h)"; exit 3 }
$x = $rect.Left + [int]($w * ${Number(xRatio)})
$y = ${vertical}
Invoke-VaultedClick $x $y
'CLICKED'
`
}

/**
 * Sample one window-relative pixel. Reboot's primary dialog button is teal, so
 * checking it tells VAULTED whether the automatic-server prompt is really up
 * before it clicks; on the Play page that point is an ordinary settings row.
 */
function pixelScript(pid, xRatio, yRatio) {
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  return `
${WINDOW_TYPES}
Add-Type -AssemblyName System.Drawing
[void][VaultedCompanionClick]::SetProcessDPIAware()
$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue
if (-not $p) { 'NO_PROCESS'; exit 1 }
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { 'NO_WINDOW'; exit 2 }
$rect = New-Object VaultedCompanionClick+RECT
[void][VaultedCompanionClick]::GetWindowRect($h, [ref]$rect)
$w = $rect.Right - $rect.Left
$ht = $rect.Bottom - $rect.Top
if ($w -lt 200 -or $ht -lt 200) { 'BAD_RECT'; exit 4 }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$c = $bmp.GetPixel([int]($w * ${Number(xRatio)}), [int]($ht * ${Number(yRatio)}))
"$($c.R),$($c.G),$($c.B)"
$g.Dispose()
$bmp.Dispose()
`
}

function parseRgb(output) {
  const match = String(output || '').match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/)
  if (!match) return null
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
}

function isTeal({ r, g, b }) {
  // fluent_ui primary button (#00b7c3) with room for JPEG/AA noise.
  return r < 100 && g > 120 && b > 130 && Math.abs(g - b) < 70
}

async function clickAt(pid, coords, options = {}) {
  if (process.platform !== 'win32') return { clicked: false, error: 'unsupported platform' }
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 6
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 1_500
  let last = 'NO_WINDOW'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { output, error } = await runPowerShell(clickScript(pid, coords))
    if (output === 'CLICKED') return { clicked: true }
    if (output === 'NO_PROCESS') return { clicked: false, error: 'the launcher closed' }
    last = output || (error ? error.message : 'unknown error')
    await delay(waitMs)
  }
  return { clicked: false, error: last }
}

/** Click the launcher's bottom full-width Play button once its window is up. */
async function clickCompanionPlayButton(pid, options = {}) {
  const xRatio = Number.isFinite(options.xRatio) ? options.xRatio : 0.5
  const yFromBottom = Number.isFinite(options.yFromBottom) ? options.yFromBottom : 53
  return clickAt(pid, { xRatio, yFromBottom }, options)
}

/**
 * Dismiss Reboot's "start a game server" prompt with Ignore, but only when its
 * teal Start server button is actually visible. Ignore launches the client and
 * connects to online servers; Start server instead opens a multi-gigabyte
 * server download dialog. Returns `{ skipped: true }` on a normal Play page so
 * VAULTED never clicks an unrelated settings row.
 */
async function dismissCompanionServerPrompt(pid, options = {}) {
  if (process.platform !== 'win32') return { clicked: false, error: 'unsupported platform' }
  // The teal primary button only exists while the modal is up. Sample just
  // below its top edge so anti-aliasing on the border cannot read as dark.
  const { output } = await runPowerShell(pixelScript(pid, 0.571, 0.6))
  const color = parseRgb(output)
  if (!color || !isTeal(color)) return { clicked: false, skipped: true }
  return clickAt(pid, { xRatio: 0.43, yRatio: 0.584 }, options)
}

module.exports = {
  clickCompanionPlayButton,
  dismissCompanionServerPrompt,
  delay,
  isTeal,
  parseRgb,
  runPowerShell,
}
