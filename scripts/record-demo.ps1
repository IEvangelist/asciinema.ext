<#
.SYNOPSIS
    Records a screencast of the GitHub Artifacts: Explorer workflow against a
    REAL VS Code instance — using ffmpeg gdigrab for capture and SendKeys for
    keyboard automation. The companion to scripts/demo/record-video.mjs (which
    records a fast, reproducible HTML mockup of the same workflow).

.DESCRIPTION
    Use this when you want a "real" capture — an actual VS Code window with the
    real extension installed, hitting a real GitHub PR/CI run, with real download
    progress and a real Simple Browser preview. Useful for marketing captures,
    bug reports against an upstream behavior, or sanity-checking that the demo
    mockup matches reality.

    The script:
      1. Launches VS Code in an ISOLATED profile (--user-data-dir + --extensions-dir)
         so it doesn't disrupt your day-to-day VS Code session.
      2. Installs davidpine-dev.asciinema (or the local .vsix you point it at) into
         that isolated profile.
      3. Waits for the VS Code window to be ready and brings it to the foreground.
      4. Starts ffmpeg gdigrab pinned to the VS Code window region.
      5. Drives the Command Palette → Explorer → URL paste → artifact pick →
         "Open with Simple Browser" flow via SendKeys.
      6. Holds on the preview for a few seconds, then stops ffmpeg and exits.

    Output: media/demo-real.mp4 (overwritten on each run).

.PARAMETER PrUrl
    The PR or Actions run URL the script will paste into the picker. The
    workflow must have at least one downloadable artifact for the demo to
    progress past that step. Required.

.PARAMETER VsixPath
    Optional. Path to a local .vsix to install instead of the marketplace
    build. Defaults to the marketplace publisher (davidpine-dev.asciinema).

.PARAMETER OutFile
    Optional. Output path for the recorded video. Defaults to media/demo-real.mp4.

.PARAMETER FfmpegPath
    Optional. Override the ffmpeg executable path. If omitted, the script
    expects ffmpeg on PATH (install with `winget install Gyan.FFmpeg` or
    `choco install ffmpeg`).

.PARAMETER DryRun
    Print what the script would do without launching anything. Use this to
    sanity-check the SendKeys sequence and timings.

.EXAMPLE
    pwsh -File scripts/record-demo.ps1 -PrUrl 'https://github.com/owner/repo/pull/123'

.EXAMPLE
    pwsh -File scripts/record-demo.ps1 `
        -PrUrl 'https://github.com/owner/repo/actions/runs/123456' `
        -VsixPath '.\asciinema-0.6.3.vsix' `
        -OutFile '.\media\demo-real-ci.mp4'

.NOTES
    Prerequisites:
      • Windows with PowerShell 5.1+ (or PowerShell 7+).
      • VS Code on PATH (`code` command — install from the VS Code "Command Line"
        shell command if missing).
      • ffmpeg on PATH (or pass -FfmpegPath).
      • One-time: sign in to GitHub inside the isolated VS Code profile the
        FIRST time you run this. The script pauses for 60s after launch
        specifically to let you complete the OAuth flow.
      • DO NOT touch your keyboard or mouse while the script is driving the
        recording (~45 seconds). SendKeys targets the foreground window — any
        accidental click will redirect keystrokes.

    Limitations:
      • SendKeys cannot read VS Code state. Timings are wall-clock estimates;
        you may need to tune -KeyDelay, -PaletteWait, -DownloadWait, etc. to
        match your network speed and PR artifact size.
      • If you have other "GitHub Artifacts:" commands in your palette they may
        appear in the typed-search results; the Enter press always selects the
        top match. If the dispatcher picks something other than "Explorer",
        narrow the typed text or pre-pin the command via a keybinding.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $PrUrl,

    [string] $VsixPath,
    [string] $OutFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'media/demo-real.mp4'),
    [string] $FfmpegPath = 'ffmpeg',

    [int] $KeyDelay = 60,
    [int] $PaletteWait = 800,
    [int] $UrlPasteWait = 1200,
    [int] $ArtifactPickWait = 1500,
    [int] $DownloadWait = 25000,    # network-dependent; bump for big artifacts
    [int] $OpenWithWait = 2500,
    [int] $PreviewHold = 6000,

    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$profileDir = Join-Path $env:TEMP "asciinema-ext-demo-profile"
$extDir = Join-Path $env:TEMP "asciinema-ext-demo-extensions"

function Step($msg) { Write-Host ">> $msg" -ForegroundColor Cyan }
function Note($msg) { Write-Host "   $msg" -ForegroundColor DarkGray }

Step "Preflight checks"
foreach ($exe in 'code', $FfmpegPath) {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        throw "Required executable not on PATH: $exe"
    }
}
Note "code     : $((Get-Command code).Source)"
Note "ffmpeg   : $((Get-Command $FfmpegPath).Source)"
Note "out file : $OutFile"

if ($DryRun) {
    Step "Dry run — would execute the following plan:"
    Note "1. Launch isolated VS Code: code --user-data-dir `"$profileDir`" --extensions-dir `"$extDir`""
    Note "2. Install extension: $(if ($VsixPath) { $VsixPath } else { 'davidpine-dev.asciinema (from marketplace)' })"
    Note "3. Wait 60s for window + OAuth"
    Note "4. Start ffmpeg recording -> $OutFile"
    Note "5. SendKeys flow:"
    Note "   Ctrl+Shift+P > 'GitHub Artifacts: Explorer' [Enter]"
    Note "   Wait $PaletteWait ms"
    Note "   Type PR URL [Enter]:  $PrUrl"
    Note "   Wait $UrlPasteWait ms"
    Note "   Down,Down,Up [Enter] to pick top artifact"
    Note "   Wait $DownloadWait ms for download"
    Note "   Enter to pick 'VS Code Simple Browser'"
    Note "   Wait $PreviewHold ms then stop ffmpeg"
    return
}

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    throw "VS Code CLI 'code' not found on PATH. From VS Code: F1 > 'Shell Command: Install code command in PATH'."
}

Step "Preparing isolated VS Code profile"
foreach ($d in $profileDir, $extDir) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
    Note "  $d"
}

Step "Installing extension into isolated profile"
$installTarget = if ($VsixPath) { (Resolve-Path $VsixPath).Path } else { 'davidpine-dev.asciinema' }
& code --extensions-dir $extDir --install-extension $installTarget --force | Out-Null

Step "Launching VS Code (isolated)"
$codeProc = Start-Process -PassThru -FilePath 'code' -ArgumentList @(
    '--user-data-dir', $profileDir,
    '--extensions-dir', $extDir,
    '--new-window',
    '--disable-workspace-trust',
    $repoRoot
)
Note "PID $($codeProc.Id) — bringing to foreground in 60s, complete GitHub OAuth if prompted"
Start-Sleep -Seconds 60

# Locate the actual VS Code main window (Start-Process returns the launcher PID; the real window
# belongs to a child process). Grab the first Code process whose MainWindowTitle references
# the workspace we just opened.
$mainProc = $null
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    $mainProc = Get-Process -Name 'Code' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -match 'asciinema' -and $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    if ($mainProc) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $mainProc) { throw "Could not locate the launched VS Code main window." }
Note "VS Code window: pid=$($mainProc.Id) title='$($mainProc.MainWindowTitle)'"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
public struct RECT { public int Left, Top, Right, Bottom; }
"@
[void][Win32]::ShowWindow($mainProc.MainWindowHandle, 9)   # SW_RESTORE
[void][Win32]::SetForegroundWindow($mainProc.MainWindowHandle)
Start-Sleep -Milliseconds 600

[RECT] $rect = New-Object RECT
[void][Win32]::GetWindowRect($mainProc.MainWindowHandle, [ref] $rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Note "Window rect: ${w}x${h} @ ($($rect.Left),$($rect.Top))"

New-Item -ItemType Directory -Path (Split-Path $OutFile) -Force | Out-Null
if (Test-Path $OutFile) { Remove-Item $OutFile }

Step "Starting ffmpeg recording"
# gdigrab with -offset_x/-offset_y + -video_size pinned to the VS Code window region.
# -framerate 30, libx264 yuv420p for broad compatibility.
$ffArgs = @(
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'gdigrab',
    '-framerate', '30',
    '-offset_x', "$($rect.Left)",
    '-offset_y', "$($rect.Top)",
    '-video_size', "${w}x${h}",
    '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-crf', '20', '-movflags', '+faststart',
    "$OutFile"
)
$ff = Start-Process -PassThru -FilePath $FfmpegPath -ArgumentList $ffArgs -WindowStyle Hidden -RedirectStandardInput 'NUL'
Note "ffmpeg pid=$($ff.Id)"
Start-Sleep -Seconds 2   # let ffmpeg warm up before we start typing

Step "Driving VS Code via SendKeys"
Add-Type -AssemblyName System.Windows.Forms

function Send-Keys([string]$keys, [int]$post = 250) {
    [void][Win32]::SetForegroundWindow($mainProc.MainWindowHandle)
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait($keys)
    Start-Sleep -Milliseconds $post
}

function Send-Text([string]$text, [int]$delayMs = $KeyDelay) {
    foreach ($ch in $text.ToCharArray()) {
        # SendKeys treats +^%~(){} as special — escape them
        $send = $ch.ToString()
        if ('+^%~(){}[]' -contains $send) { $send = "{$send}" }
        Send-Keys $send 0
        Start-Sleep -Milliseconds $delayMs
    }
}

# 1. Open command palette
Send-Keys '^+p' $PaletteWait

# 2. Type the command
Send-Text 'GitHub Artifacts: Explorer' $KeyDelay
Start-Sleep -Milliseconds 600
Send-Keys '{ENTER}' $PaletteWait

# 3. Type/paste the PR URL into the URL picker
Send-Text $PrUrl ($KeyDelay - 20)
Start-Sleep -Milliseconds 600
Send-Keys '{ENTER}' $UrlPasteWait

# 4. Top artifact already selected — press Enter
Send-Keys '{ENTER}' $ArtifactPickWait

# 5. Wait for download + extraction to complete
Note "Holding for download ($DownloadWait ms) — adjust -DownloadWait if your artifact is bigger/smaller"
Start-Sleep -Milliseconds $DownloadWait

# 6. "Open with" picker — Simple Browser is the top option
Send-Keys '{ENTER}' $OpenWithWait

# 7. Linger on the preview
Note "Holding on preview ($PreviewHold ms)"
Start-Sleep -Milliseconds $PreviewHold

Step "Stopping ffmpeg"
# ffmpeg traps 'q' on stdin for a clean shutdown. Falling back to Stop-Process on the specific PID.
try {
    # Try graceful first
    $ff.StandardInput.Write('q')
    $ff.StandardInput.Flush()
    if (-not $ff.WaitForExit(5000)) {
        Stop-Process -Id $ff.Id -Force
    }
} catch {
    Stop-Process -Id $ff.Id -Force
}

if (Test-Path $OutFile) {
    $size = (Get-Item $OutFile).Length
    Step "Recording finished — $OutFile ($([math]::Round($size/1MB,2)) MB)"
} else {
    throw "ffmpeg did not produce $OutFile"
}

Step "Closing isolated VS Code (the user can keep it open by pressing Ctrl+C now if they want to inspect)"
Start-Sleep -Seconds 2
try { $mainProc.CloseMainWindow() | Out-Null } catch { }
