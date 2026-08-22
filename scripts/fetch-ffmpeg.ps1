# Fetches a static FFmpeg (GPL build) and places the sidecar binaries where Tauri expects them.
# Run from the project root:  pwsh scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = "Stop"

$binDir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
$zip = Join-Path $binDir "ffmpeg.zip"
$tmp = Join-Path $binDir "ffmpeg-extracted"

Write-Host "Downloading FFmpeg..."
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

Write-Host "Extracting..."
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive -Path $zip -DestinationPath $tmp -Force

# BtbN zip nests everything under a single top-level folder.
$top = Get-ChildItem -Directory $tmp | Select-Object -First 1
$bin = Join-Path $top.FullName "bin"

# Plain names; the app resolves the binary at runtime (next to the exe, in the
# resource dir, or on the system PATH).
Copy-Item (Join-Path $bin "ffmpeg.exe")  (Join-Path $binDir "ffmpeg.exe")  -Force
Copy-Item (Join-Path $bin "ffprobe.exe") (Join-Path $binDir "ffprobe.exe") -Force

# Also place them next to the compiled binary so `npm run tauri dev` / build
# find ffmpeg via the "next to the executable" lookup.
$targetDir = Join-Path $PSScriptRoot "..\src-tauri\target"
foreach ($profile in @("debug", "release")) {
    $dest = Join-Path $targetDir $profile
    if (Test-Path $dest) {
        Copy-Item (Join-Path $bin "ffmpeg.exe")  (Join-Path $dest "ffmpeg.exe")  -Force
        Copy-Item (Join-Path $bin "ffprobe.exe") (Join-Path $dest "ffprobe.exe") -Force
    }
}

Remove-Item -Recurse -Force $tmp
Write-Host "Done. Binaries at $binDir (and next to built executables)"
