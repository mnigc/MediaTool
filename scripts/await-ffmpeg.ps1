# Watches the FFmpeg download, then extracts and runs a headless validation.
$ErrorActionPreference = "Stop"
$log = Join-Path $PSScriptRoot "verify.log"
function Log($m) { $m | Out-File -Append -FilePath $log; Write-Host $m }

try {
  Log "=== watcher started ($(Get-Date)) ==="
  Log "waiting for curl download to finish..."
  while (Get-Process -Name curl -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 5
  }
  Log "download process gone ($(Get-Date))"

  $binDir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
  $zip = Join-Path $binDir "ffmpeg.zip"
  if (-not (Test-Path $zip)) { throw "ffmpeg.zip not found at $zip" }

  $tmp = Join-Path $binDir "ffmpeg-extracted"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $top = Get-ChildItem -Directory $tmp | Select-Object -First 1
  $bin = Join-Path $top.FullName "bin"
  Copy-Item (Join-Path $bin "ffmpeg.exe")  (Join-Path $binDir "ffmpeg.exe")  -Force
  Copy-Item (Join-Path $bin "ffprobe.exe") (Join-Path $binDir "ffprobe.exe") -Force

  $ff = Join-Path $binDir "ffmpeg.exe"
  $probe = Join-Path $binDir "ffprobe.exe"
  Log "=== version ==="
  & $ff -version 2>&1 | Select-Object -First 1 | ForEach-Object { Log $_ }
  Log "=== encoders ==="
  & $ff -hide_banner -encoders 2>&1 | Select-String -Pattern "libx264|libvpx-vp9|libmp3lame|libopus|aac|av1|webp" | ForEach-Object { Log $_.Line }

  Log "=== functional test ==="
  $tmpd = Join-Path $env:TEMP "mediapress_test"
  if (-not (Test-Path $tmpd)) { New-Item -ItemType Directory -Force -Path $tmpd | Out-Null }
  $src = Join-Path $tmpd "src.mp4"
  & $ff -y -f lavfi -i testsrc=duration=2:size=320x240:rate=25 -pix_fmt yuv420p $src 2>&1 | Out-Null
  if (-not (Test-Path $src)) { throw "could not generate source video" }
  Log "source: $((Get-Item $src).Length) bytes"

  $outV = Join-Path $tmpd "out.mp4"
  & $ff -nostats -y -i $src -vf scale=-2:240 -c:v libx264 -crf 28 -preset medium -c:a aac -b:a 128k -progress pipe:1 $outV 2>&1 | Out-Null
  Log "video(x264): $((Test-Path $outV) ? 'OK' : 'FAILED') size=$((Get-Item $outV).Length)"

  $outI = Join-Path $tmpd "out.webp"
  & $ff -y -i $src -frames:v 1 -quality 80 $outI 2>&1 | Out-Null
  Log "image(webp): $((Test-Path $outI) ? 'OK' : 'FAILED')"

  $outA = Join-Path $tmpd "out.mp3"
  & $ff -y -i $src -vn -c:a libmp3lame -b:a 128k $outA 2>&1 | Out-Null
  Log "audio(mp3): $((Test-Path $outA) ? 'OK' : 'FAILED')"

  Log "=== probe ==="
  & $probe -v quiet -print_format json -show_format -show_streams $src 2>&1 | Select-Object -First 6 | ForEach-Object { Log $_ }

  Log "=== verification finished ($(Get-Date)) ==="
} catch {
  Log "ERROR: $_"
}
