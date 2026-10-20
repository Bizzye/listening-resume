# download-deps-win.ps1
# Downloads Node.js and FFmpeg for Windows bundling.
# Run this before `pnpm tauri build` on Windows.

param(
    # Must match the ABI of the better-sqlite3 prebuild fetched by apps/gui/scripts/native-abi.mjs.
    [string]$NodeVersion = "22.16.0"
)

$ErrorActionPreference = "Stop"
$ResourceDir = Join-Path (Join-Path $PSScriptRoot "..") "resources"
$BinDir = Join-Path $ResourceDir "bin"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# --- Node.js ---
$NodeExe = Join-Path $BinDir "node.exe"
if (-Not (Test-Path $NodeExe)) {
    Write-Host "Downloading Node.js v$NodeVersion..."
    $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/win-x64/node.exe"
    Invoke-WebRequest -Uri $nodeUrl -OutFile $NodeExe -UseBasicParsing
    Write-Host "Node.js downloaded to $NodeExe"
} else {
    Write-Host "Node.js already exists at $NodeExe"
}

# --- FFmpeg ---
# Only ffmpeg.exe is bundled (file import conversion). Playback is an HTML <audio> element fed by
# the server's Range-capable WAV stream, so ffplay is no longer needed.
$FfmpegExe = Join-Path $BinDir "ffmpeg.exe"
if (-Not (Test-Path $FfmpegExe)) {
    Write-Host "Downloading FFmpeg (gyan.dev release essentials)..."
    $ffmpegZip = Join-Path $env:TEMP "ffmpeg.zip"
    $ffmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip -UseBasicParsing

    Write-Host "Extracting ffmpeg.exe..."
    $extractDir = Join-Path $env:TEMP "ffmpeg-extract"
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    Expand-Archive -Path $ffmpegZip -DestinationPath $extractDir

    $found = Get-ChildItem -Path $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if (-Not $found) { throw "ffmpeg.exe not found in archive" }
    Copy-Item $found.FullName $FfmpegExe
    Write-Host "ffmpeg.exe extracted to $BinDir"

    Remove-Item -Force $ffmpegZip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
} else {
    Write-Host "FFmpeg already exists at $FfmpegExe"
}

# Drop a stale ffplay.exe left by older versions of this script so it isn't bundled.
Remove-Item -Force (Join-Path $BinDir "ffplay.exe") -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done! Binaries are in: $BinDir"
Write-Host "  - node.exe   ($(("{0:N1}" -f ((Get-Item $NodeExe).Length / 1MB))) MB)"
Write-Host "  - ffmpeg.exe ($(("{0:N1}" -f ((Get-Item $FfmpegExe).Length / 1MB))) MB)"
