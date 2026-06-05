$ErrorActionPreference = "Stop"
$SrcTauriDir = Join-Path $PSScriptRoot ".."
$SrcTauriDir = (Resolve-Path $SrcTauriDir).Path
$BinariesDir = Join-Path $SrcTauriDir "binaries"

New-Item -ItemType Directory -Force -Path $BinariesDir | Out-Null

# tauri_build::build() validates resources during cargo compilation.
# Create a placeholder so it passes, then replace with the real binary after.
$DestExe = Join-Path $BinariesDir "wasapi-capture.exe"
if (-not (Test-Path $DestExe)) {
    [System.IO.File]::WriteAllBytes($DestExe, @())
    Write-Host "Created placeholder at $DestExe"
}

Write-Host "Building wasapi-capture..."
Set-Location $SrcTauriDir
cargo build --release --bin wasapi-capture
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$BuiltExe = Join-Path $SrcTauriDir "target" "release" "wasapi-capture.exe"
Copy-Item $BuiltExe $DestExe -Force
Write-Host "Done: $DestExe ($('{0:N1}' -f ((Get-Item $DestExe).Length / 1MB)) MB)"
