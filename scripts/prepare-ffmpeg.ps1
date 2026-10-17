# Copies ffmpeg.exe + ffprobe.exe (and the build's licence files) into src-tauri/ffmpeg so the installer
# bundles them. By default it uses the FFmpeg found on PATH; pass -Source to use a different (e.g. smaller
# "essentials" or LGPL) build. Always check the licence of the exact build you ship.
param([string]$Source = "")
$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "..\src-tauri\ffmpeg"
if (-not $Source) {
  $cmd = Get-Command ffmpeg -ErrorAction Stop
  $item = Get-Item $cmd.Source
  $Source = Split-Path ($(if ($item.LinkType) { $item.Target } else { $item.FullName }))
}
foreach ($exe in "ffmpeg.exe", "ffprobe.exe") { if (-not (Test-Path (Join-Path $Source $exe))) { throw "$exe not found in $Source" } }
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $Source "ffmpeg.exe"), (Join-Path $Source "ffprobe.exe") $dest -Force
$root = Split-Path $Source
foreach ($f in "LICENSE", "LICENSE.txt", "README.txt") { $p = Join-Path $root $f; if (Test-Path $p) { Copy-Item $p (Join-Path $dest "FFMPEG-$f") -Force } }
$ver = (& (Join-Path $dest "ffmpeg.exe") -hide_banner -version | Select-Object -First 1)
$cfg = (& (Join-Path $dest "ffmpeg.exe") -hide_banner -buildconf | Select-String "enable-gpl|enable-version3|enable-nonfree" | ForEach-Object { $_.ToString().Trim() }) -join ", "
"$ver`r`nLicence-relevant configure flags: $cfg`r`nSource: https://ffmpeg.org/download.html (and the build provider's source archive)" | Set-Content (Join-Path $dest "FFMPEG-BUILD-INFO.txt")
if ($cfg -match "nonfree") { Write-Warning "This FFmpeg build is NON-FREE and must not be redistributed. Use a GPL or LGPL build instead." }
Get-ChildItem $dest | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
