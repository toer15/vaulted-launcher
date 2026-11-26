'use strict'

const { execFile, spawn } = require('node:child_process')

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
      if ($area -gt $script:foundArea) { $script:foundArea = $area; $script:foundTop = $h }
    }
    return $true
  }
  [void][VaultedHiddenWindow]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:foundTop
}
function Find-VaultedVisibleTopWindow([int]$targetPid) {
  # Electron owns hidden helper windows as well as the real app window; centring
  # on one of those would put the popup in the wrong place.
  $script:foundVisible = [IntPtr]::Zero
  $script:visibleArea = 0
  $cb = [VaultedHiddenWindow+EnumProc]{
    param($h, $l)
    $owner = [uint32]0
    [void][VaultedHiddenWindow]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq $targetPid -and [VaultedHiddenWindow]::IsWindowVisible($h)) {
      $r = New-Object VaultedHiddenWindow+RECT
      [void][VaultedHiddenWindow]::GetWindowRect($h, [ref]$r)
      $area = ($r.R - $r.L) * ($r.B - $r.T)
      if ($area -gt $script:visibleArea) { $script:visibleArea = $area; $script:foundVisible = $h }
    }
    return $true
  }
  [void][VaultedHiddenWindow]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:foundVisible
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
# Show it off every monitor, give the renderer time to build its compositor,
# then force a real resize and repaint before the player sees it.
[void][VaultedHiddenWindow]::ShowWindow($top, 4)
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
'SHOWN'
`
}

function popupScript(pid, ownerPid, width, height) {
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  const safeOwnerPid = Math.max(1, Math.floor(Number(ownerPid) || 0))
  const safeWidth = Math.max(380, Math.min(900, Math.floor(Number(width) || 560)))
  const safeHeight = Math.max(420, Math.min(1000, Math.floor(Number(height) || 760)))
  return `
${WINDOW_TYPES}
$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue
if (-not $p) { 'NO_PROCESS'; exit 1 }
$top = Find-VaultedTopWindow ${safePid}
if ($top -eq [IntPtr]::Zero) { 'NO_WINDOW'; exit 2 }
$owner = Find-VaultedVisibleTopWindow ${safeOwnerPid}
if ($owner -eq [IntPtr]::Zero) { $owner = Find-VaultedTopWindow ${safeOwnerPid} }
# A sign-in window belongs to VAULTED, so keep it a small popup centred on the
# app instead of a full-size launcher window in the taskbar.
if ($owner -ne [IntPtr]::Zero) {
  [void][VaultedHiddenWindow]::SetWindowLongPtr($top, -8, $owner)
  $ex = [VaultedHiddenWindow]::GetWindowLong($top, -20)
  if ($ex -ne 0) {
    $popupStyle = (($ex -bor 0x00000080) -band (-bnot 0x00040000))
    [void][VaultedHiddenWindow]::SetWindowLong($top, -20, $popupStyle)
  }
}
$w = ${safeWidth}
$h = ${safeHeight}
$x = 140
$y = 90
if ($owner -ne [IntPtr]::Zero) {
  $ownerRect = New-Object VaultedHiddenWindow+RECT
  if ([VaultedHiddenWindow]::GetWindowRect($owner, [ref]$ownerRect)) {
    $ow = $ownerRect.R - $ownerRect.L
    $oh = $ownerRect.B - $ownerRect.T
    if ($ow -gt 200 -and $oh -gt 200 -and $ownerRect.L -gt -10000) {
      if ($w -gt ($ow - 120)) { $w = [Math]::Max(420, $ow - 120) }
      if ($h -gt ($oh - 80)) { $h = [Math]::Max(480, $oh - 80) }
      $x = $ownerRect.L + [int](($ow - $w) / 2)
      $y = $ownerRect.T + [int](($oh - $h) / 2)
    }
  }
}
[void][VaultedHiddenWindow]::ShowWindow($top, 9)
[void][VaultedHiddenWindow]::SetWindowPos($top, [IntPtr]::Zero, $x, $y, $w, $h, 0x0020 -bor 0x0040)
[void][VaultedHiddenWindow]::SetForegroundWindow($top)
# A launcher that loads its page after opening can resize itself once more.
Start-Sleep -Milliseconds 800
$after = New-Object VaultedHiddenWindow+RECT
if ([VaultedHiddenWindow]::GetWindowRect($top, [ref]$after)) {
  if ((($after.R - $after.L) -ne $w) -or (($after.B - $after.T) -ne $h)) {
    [void][VaultedHiddenWindow]::SetWindowPos($top, [IntPtr]::Zero, $x, $y, $w, $h, 0x0040)
  }
}
'SHOWN_POPUP'
`
}

function fastenerScript(pid, ownerPid, width, height) {
  const safePid = Math.max(1, Math.floor(Number(pid) || 0))
  const safeOwnerPid = Math.max(1, Math.floor(Number(ownerPid) || 0))
  const safeWidth = Math.max(380, Math.min(900, Math.floor(Number(width) || 560)))
  const safeHeight = Math.max(420, Math.min(1000, Math.floor(Number(height) || 760)))
  return `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class VaultedFastener
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    public delegate IntPtr WndProcDelegate(IntPtr h, uint m, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct WNDCLASSEX { public uint cbSize; public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName; public IntPtr hIconSm; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassEx(ref WNDCLASSEX wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

    static IntPtr found;
    static long bestArea;
    static WndProcDelegate overlayProc = OverlayProc;
    static bool classReady;
    static IntPtr moduleHandle;
    static IntPtr overlayOwner;

    static IntPtr OverlayProc(IntPtr h, uint m, IntPtr w, IntPtr l)
    {
        return DefWindowProc(h, m, w, l);
    }

    static IntPtr FindTop(uint target, bool visibleOnly)
    {
        found = IntPtr.Zero;
        bestArea = 0;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == target && (!visibleOnly || IsWindowVisible(h)))
            {
                RECT r;
                GetWindowRect(h, out r);
                long a = (long)(r.R - r.L) * (r.B - r.T);
                if (a > bestArea) { bestArea = a; found = h; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // A nearly invisible strip sitting on the popup's title bar. It swallows the
    // mouse-down that would start a drag, so the window cannot be moved at all.
    static IntPtr CreateOverlay(IntPtr owner)
    {
        if (moduleHandle == IntPtr.Zero) moduleHandle = GetModuleHandle(null);
        if (!classReady)
        {
            WNDCLASSEX wc = new WNDCLASSEX();
            wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(overlayProc);
            wc.hInstance = moduleHandle;
            wc.lpszClassName = "VaultedFastenerOverlay";
            RegisterClassEx(ref wc);
            classReady = true;
        }
        IntPtr h = CreateWindowEx(0x00080000 | 0x00000080 | 0x08000000, "VaultedFastenerOverlay", "", 0x80000000, 0, 0, 100, 48, IntPtr.Zero, IntPtr.Zero, moduleHandle, IntPtr.Zero);
        if (h == IntPtr.Zero) return IntPtr.Zero;
        SetLayeredWindowAttributes(h, 0, 1, 2);
        SetWindowLongPtr(h, -8, owner);
        ShowWindow(h, 4);
        return h;
    }

    public static void Run(uint launcherPid, uint ownerPid, int width, int height)
    {
        bool seen = false;
        IntPtr overlay = IntPtr.Zero;
        while (true)
        {
            IntPtr top = FindTop(launcherPid, true);
            if (top == IntPtr.Zero) top = FindTop(launcherPid, false);
            if (top == IntPtr.Zero)
            {
                if (seen) break;
                Thread.Sleep(200);
                continue;
            }
            seen = true;
            IntPtr owner = FindTop(ownerPid, true);
            if (owner == IntPtr.Zero) owner = FindTop(ownerPid, false);
            if (owner == IntPtr.Zero) break;
            RECT o;
            if (!GetWindowRect(owner, out o)) break;
            int ow = o.R - o.L;
            int oh = o.B - o.T;
            RECT c;
            if (!GetWindowRect(top, out c)) break;
            // Launchers often replace their startup window with the real one;
            // an overlay owned by the old window dies with it, so re-attach.
            if (overlay != IntPtr.Zero && (overlayOwner != top || !IsWindow(overlay)))
            {
                if (IsWindow(overlay)) DestroyWindow(overlay);
                overlay = IntPtr.Zero;
            }
            if (overlay == IntPtr.Zero && IsWindowVisible(top))
            {
                overlay = CreateOverlay(top);
                overlayOwner = top;
            }
            if (overlay != IntPtr.Zero)
            {
                IntPtr fg = GetForegroundWindow();
                uint fgPid;
                GetWindowThreadProcessId(fg, out fgPid);
                bool active = fgPid == launcherPid || fgPid == ownerPid;
                // The launcher raises itself while starting up, so keep the
                // strip at the top of the normal windows while either window
                // is in front; hide it entirely when another app takes focus
                // so it never swallows clicks meant for that app.
                ShowWindow(overlay, active ? 4 : 0);
                if (active)
                {
                    SetWindowPos(overlay, IntPtr.Zero, c.L, c.T, Math.Max(1, c.R - c.L), 48, 0x0010 | 0x0040);
                }
                else
                {
                    SetWindowPos(overlay, IntPtr.Zero, c.L, c.T, Math.Max(1, c.R - c.L), 48, 0x0004 | 0x0010);
                }
            }
            if (ow > 300 && oh > 300 && o.L > -10000)
            {
                int w = Math.Min(width, Math.Max(420, ow - 120));
                int h = Math.Min(height, Math.Max(480, oh - 80));
                int x = o.L + (ow - w) / 2;
                int y = o.T + (oh - h) / 2;
                bool moved = Math.Abs(c.L - x) > 1 || Math.Abs(c.T - y) > 1;
                bool resized = Math.Abs((c.R - c.L) - w) > 1 || Math.Abs((c.B - c.T) - h) > 1;
                if (moved || resized)
                {
                    bool dragging = (GetAsyncKeyState(0x01) & 0x8000) != 0;
                    if (moved && dragging)
                    {
                        PostMessage(top, 0x001F, IntPtr.Zero, IntPtr.Zero);
                        PostMessage(top, 0x0202, IntPtr.Zero, IntPtr.Zero);
                    }
                    SetWindowPos(top, IntPtr.Zero, x, y, w, h, 0x0004 | 0x0010);
                }
            }
            MSG msg;
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            Thread.Sleep(8);
        }
        if (overlay != IntPtr.Zero) DestroyWindow(overlay);
    }
}
'@
[VaultedFastener]::Run(${safePid}, ${safeOwnerPid}, ${safeWidth}, ${safeHeight})
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
foreach ($id in @(${clean.join(',')})) {
  $top = Find-VaultedTopWindow $id
  if ($top -eq [IntPtr]::Zero) { continue }
  $r = New-Object VaultedHiddenWindow+RECT
  [void][VaultedHiddenWindow]::GetWindowRect($top, [ref]$r)
  $area = ($r.R - $r.L) * ($r.B - $r.T)
  if ($area -gt $bestArea) { $bestArea = $area; $bestPid = $id }
}
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

/**
 * Reveal a launcher's own sign-in page as a small popup owned by VAULTED: it
 * opens centred over the app, stays above it, skips the taskbar, and vanishes
 * with the app. Used only for the pre-download sign-in, never for Play.
 */
async function showCompanionLauncherPopup(pid, ownerPid, options = {}) {
  if (process.platform !== 'win32') return false
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 12
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 500
  const script = popupScript(pid, ownerPid, options.width, options.height)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { output } = await runPowerShell(script, 15_000)
    if (output === 'SHOWN_POPUP') return true
    if (output === 'NO_PROCESS') return false
    await delay(waitMs)
  }
  return false
}

/**
 * Keep a sign-in popup fastened to VAULTED. The loop lives in one hidden
 * PowerShell process and exits by itself when either window closes, so the
 * player cannot drag, resize or park the launcher anywhere else.
 */
function startCompanionLauncherFastener(pid, ownerPid, options = {}) {
  if (process.platform !== 'win32') return null
  const script = fastenerScript(pid, ownerPid, options.width, options.height)
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64')
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: 'ignore' },
    )
    child.on('error', () => {})
    child.unref()
    return child.pid || null
  } catch {
    return null
  }
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
  fastenerScript,
  hideCompanionLauncher,
  showCompanionLauncher,
  showCompanionLauncherOffscreen,
  showCompanionLauncherPopup,
  startCompanionLauncherFastener,
  warmCompanionLauncherWindow,
  findCompanionWindowPid,
  delay,
  runPowerShell,
}
