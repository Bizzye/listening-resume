# download-deps-win.ps1
# Downloads Node.js and FFmpeg for Windows bundling.
# Run this before `pnpm tauri build` on Windows.

param(
    [string]$NodeVersion = "22.16.0",
    [string]$FfmpegVersion = "7.1"
)

$ErrorActionPreference = "Stop"
$ResourceDir = Join-Path $PSScriptRoot ".." "resources"
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
$FfmpegExe = Join-Path $BinDir "ffmpeg.exe"
if (-Not (Test-Path $FfmpegExe)) {
    Write-Host "Downloading FFmpeg $FfmpegVersion..."
    $ffmpegZip = Join-Path $env:TEMP "ffmpeg.zip"
    $ffmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n$FfmpegVersion-latest-win64-gpl-$FfmpegVersion.zip"
    # Use the essentials build which is smaller
    $ffmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip -UseBasicParsing
    
    Write-Host "Extracting ffmpeg.exe..."
    $extractDir = Join-Path $env:TEMP "ffmpeg-extract"
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    Expand-Archive -Path $ffmpegZip -DestinationPath $extractDir
    
    # Find ffmpeg.exe inside extracted folder
    $found = Get-ChildItem -Path $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if ($found) {
        Copy-Item $found.FullName $FfmpegExe
        Write-Host "FFmpeg extracted to $FfmpegExe"
    } else {
        throw "ffmpeg.exe not found in archive"
    }
    
    # Cleanup
    Remove-Item -Force $ffmpegZip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
} else {
    Write-Host "FFmpeg already exists at $FfmpegExe"
}

Write-Host ""
Write-Host "Done! Binaries are in: $BinDir"
Write-Host "  - node.exe   ($(("{0:N1}" -f ((Get-Item $NodeExe).Length / 1MB))) MB)"
Write-Host "  - ffmpeg.exe ($(("{0:N1}" -f ((Get-Item $FfmpegExe).Length / 1MB))) MB)"
