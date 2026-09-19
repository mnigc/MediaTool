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

# ── yt-dlp ─────────────────────────────────────────────────────────
# Single-file official builds; bundled so the download/record features work
# out of the box. The app's in-app updater can still replace it later.
Write-Host "Downloading yt-dlp..."
$ytdlpName = if ($os -eq "windows") { "yt-dlp.exe" } else { "yt-dlp" }
$ytdlpAsset = switch ($os) {
    "windows" { "yt-dlp.exe" }
    "macos"   { "yt-dlp_macos" }
    "linux"   { "yt-dlp_linux" }
}
$ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$ytdlpAsset"
$ytdlpTmp = Join-Path $binDir "$ytdlpName.download"
Invoke-WebRequest -Uri $ytdlpUrl -OutFile $ytdlpTmp -UseBasicParsing
Move-Item $ytdlpTmp (Join-Path $binDir $ytdlpName) -Force
if ($os -ne "windows") {
    chmod +x (Join-Path $binDir $ytdlpName)
    if ($os -eq "macos") {
        # Ad-hoc signature: Apple Silicon refuses to run unsigned binaries.
        codesign --force --sign - (Join-Path $binDir $ytdlpName)
    }
}
Write-Host "  -> $(Join-Path $binDir $ytdlpName)"

# ── streamlink ─────────────────────────────────────────────────────
# Live-recording engine, bundled so live capture works out of the box. Only
# Windows has official standalone builds (a portable embedded-Python bundle);
# elsewhere streamlink needs pip, so the app keeps recording live streams with
# yt-dlp there.
if ($os -eq "windows") {
    # Resolve the tag from the /releases/latest redirect and the asset name
    # from its expanded_assets fragment — the REST API is anonymous rate
    # limited (60 req/IP/hr) and fails the build mid-download.
    Write-Host "Downloading streamlink (portable bundle)..."
    # The redirect is read with HttpWebRequest rather than Invoke-WebRequest:
    # PS 5.1 exposes the followed target as BaseResponse.ResponseUri, while pwsh
    # 7 (what CI runs) has no such property, so $tag came back empty and the
    # expanded_assets URL 404'd.
    $req = [System.Net.HttpWebRequest]::Create("https://github.com/streamlink/windows-builds/releases/latest")
    $req.AllowAutoRedirect = $false
    $req.UserAgent = "MediaTool"
    $resp = $req.GetResponse()
    try { $location = $resp.Headers["Location"] } finally { $resp.Close() }
    $tag = ($location -replace '.*/tag/', '')
    if ($tag -notmatch '^[\w.\-]+$') { throw "No release tag in redirect target '$location'" }
    Write-Host "  latest release: $tag"
    $assetsHtml = (Invoke-WebRequest -Uri "https://github.com/streamlink/windows-builds/releases/expanded_assets/$tag" -UseBasicParsing).Content
    $assetName = [regex]::Match($assetsHtml, 'streamlink-[^"]*-x86_64\.zip').Value
    if (-not $assetName) { throw "No Windows x64 portable asset in $tag" }
    $downloadUrl = "https://github.com/streamlink/windows-builds/releases/download/$tag/$assetName"

    $zip = Join-Path $binDir "streamlink.zip"
    $tmp = Join-Path $binDir "streamlink-extracted"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zip -UseBasicParsing

    # Drop the ffmpeg the bundle carries: the app always passes --ffmpeg-ffmpeg
    # pointing at its own build, so a second copy only bloats the installer.
    # System32's bsdtar is used by name because Git's GNU tar cannot read zips.
    $bsdtar = Join-Path $env:SystemRoot "System32\tar.exe"
    Reset-Tmp $tmp
    & $bsdtar -xf $zip -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract $zip" }
    $top = Get-ChildItem -Directory $tmp | Select-Object -First 1
    $inner = Join-Path $top.FullName "ffmpeg"
    if (Test-Path $inner) { Remove-Item -Recurse -Force $inner }

    $stripped = Join-Path $binDir "streamlink-stripped.zip"
    & $bsdtar -a -cf $stripped -C $tmp $top.Name
    if ($LASTEXITCODE -ne 0) { throw "Failed to repack $zip" }
    Remove-Item -Recurse -Force $tmp
    Move-Item $stripped $zip -Force
    Write-Host ("  -> {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
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
        Save-Binary (Join-Path $binDir $ytdlpName)       (Join-Path $dest $ytdlpName)
    }
}

Write-Host "Done. Binaries at $binDir (and next to built executables)"
