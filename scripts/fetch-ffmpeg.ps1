# Fetches static FFmpeg/FFprobe builds for the host platform and places the
# sidecar binaries where Tauri expects them (src-tauri/binaries). Sources:
#   windows: BtbN win64 GPL builds           -> ffmpeg.exe / ffprobe.exe
#   linux:   johnvansickle.com amd64 static  -> ffmpeg / ffprobe
#   macos:   evermeet.cx (x86_64) + osxexperts.net (arm64) combined with lipo
#            into a universal binary so one DMG covers Intel and Apple Silicon.
# Run from the project root:  pwsh scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = "Stop"

$binDir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$os = "windows"
if (Test-Path variable:IsWindows) {
    if ($IsMacOS) { $os = "macos" }
    elseif ($IsLinux) { $os = "linux" }
    elseif (-not $IsWindows) { throw "Unsupported platform" }
}

function Find-Binary([string]$dir, [string]$name) {
    $hit = Get-ChildItem -File -Recurse -Path $dir -Filter "$name*" |
        Where-Object { $_.Name -ieq $name } | Select-Object -First 1
    if (-not $hit) {
        # Some archives nest the binary under a versioned name (e.g. ffmpeg-9.0.1).
        $hit = Get-ChildItem -File -Recurse -Path $dir -Filter "$name*" | Select-Object -First 1
    }
    if (-not $hit) { throw "Binary '$name' not found under $dir" }
    return $hit.FullName
}

function Save-Binary([string]$src, [string]$dest) {
    Copy-Item $src $dest -Force
    if ($os -ne "windows") { chmod +x $dest }
    Write-Host "  -> $dest"
}

function Reset-Tmp([string]$tmp) {
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
}

if ($os -eq "windows") {
    $url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    $zip = Join-Path $binDir "ffmpeg.zip"
    $tmp = Join-Path $binDir "ffmpeg-extracted"

    Write-Host "Downloading FFmpeg..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

    Write-Host "Extracting..."
    Reset-Tmp $tmp
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    # BtbN zip nests everything under a single top-level folder.
    $top = Get-ChildItem -Directory $tmp | Select-Object -First 1
    $bin = Join-Path $top.FullName "bin"

    # Plain names; the app resolves the binary at runtime (next to the exe, in the
    # resource dir, or on the system PATH).
    Save-Binary (Join-Path $bin "ffmpeg.exe")  (Join-Path $binDir "ffmpeg.exe")
    Save-Binary (Join-Path $bin "ffprobe.exe") (Join-Path $binDir "ffprobe.exe")

    Remove-Item -Recurse -Force $tmp
}
elseif ($os -eq "linux") {
    $url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    $tar = Join-Path $binDir "ffmpeg.tar.xz"
    $tmp = Join-Path $binDir "ffmpeg-extracted"

    Write-Host "Downloading FFmpeg (linux amd64 static)..."
    Invoke-WebRequest -Uri $url -OutFile $tar -UseBasicParsing

    Write-Host "Extracting..."
    Reset-Tmp $tmp
    tar -xf $tar -C $tmp

    Save-Binary (Find-Binary $tmp "ffmpeg")  (Join-Path $binDir "ffmpeg")
    Save-Binary (Find-Binary $tmp "ffprobe") (Join-Path $binDir "ffprobe")

    Remove-Item -Recurse -Force $tmp
}
else {
    # macOS: universal sidecar = x86_64 (evermeet.cx) + arm64 (osxexperts.net).
    $archives = @(
        @{ Url = "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip";  Name = "ffmpeg";  File = "ffmpeg-x64.zip" },
        @{ Url = "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"; Name = "ffprobe"; File = "ffprobe-x64.zip" },
        @{ Url = "https://www.osxexperts.net/ffmpeg9arm.zip";         Name = "ffmpeg";  File = "ffmpeg-arm64.zip" },
        @{ Url = "https://www.osxexperts.net/ffprobe9arm.zip";        Name = "ffprobe"; File = "ffprobe-arm64.zip" }
    )
    $x64 = @{}
    $arm = @{}
    foreach ($a in $archives) {
        $zip = Join-Path $binDir $a.File
        $tmp = Join-Path $binDir ("ffmpeg-extracted-" + $a.File)

        Write-Host "Downloading $($a.Name) [$($a.File)]..."
        Invoke-WebRequest -Uri $a.Url -OutFile $zip -UseBasicParsing

        Reset-Tmp $tmp
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $bin = Find-Binary $tmp $a.Name
        if ($a.File -like "*x64*") { $x64[$a.Name] = $bin } else { $arm[$a.Name] = $bin }
    }

    foreach ($name in @("ffmpeg", "ffprobe")) {
        $out = Join-Path $binDir $name
        Write-Host "Building universal $name..."
        lipo -create $x64[$name] $arm[$name] -output $out
        chmod +x $out
        # Ad-hoc signature: Apple Silicon refuses to run unsigned binaries.
        codesign --force --sign - $out
        Write-Host "  -> $out"
    }
}

# Also place them next to the compiled binary so `npm run tauri dev` / build
# find ffmpeg via the "next to the executable" lookup.
$exeExt = if ($os -eq "windows") { ".exe" } else { "" }
$targetDir = Join-Path $PSScriptRoot "..\src-tauri\target"
foreach ($profile in @("debug", "release")) {
    $dest = Join-Path $targetDir $profile
    if (Test-Path $dest) {
        Save-Binary (Join-Path $binDir "ffmpeg$exeExt")  (Join-Path $dest "ffmpeg$exeExt")
        Save-Binary (Join-Path $binDir "ffprobe$exeExt") (Join-Path $dest "ffprobe$exeExt")
    }
}

Write-Host "Done. Binaries at $binDir (and next to built executables)"
