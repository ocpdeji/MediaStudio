# Builds a portable ZIP from the release build: MediaStudioPro.exe + ffmpeg/ + notices.
# Run after `npm run tauri build`. Note: settings and the catalogue still live in %APPDATA%\com.mediastudiopro.app.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot
$rel = Join-Path $root "src-tauri\target\release"
$ver = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version
$stage = Join-Path $rel "portable\MediaStudioPro-$ver-portable"
Remove-Item (Join-Path $rel "portable") -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage "ffmpeg") | Out-Null
Copy-Item (Join-Path $rel "MediaStudioPro.exe") $stage
Copy-Item (Join-Path $root "src-tauri\bin\DirectML.dll") $stage
Copy-Item (Join-Path $root "src-tauri\ffmpeg\*") (Join-Path $stage "ffmpeg")
Copy-Item (Join-Path $root "THIRD_PARTY_NOTICES.md"), (Join-Path $root "README.md") $stage
"Media Studio Pro $ver (portable)`r`nRun MediaStudioPro.exe. Requires Windows 10/11 with the WebView2 runtime (built into Windows 11).`r`nYour catalogue and settings are stored in %APPDATA%\com.mediastudiopro.app; thumbnails in %LOCALAPPDATA%\com.mediastudiopro.app." | Set-Content (Join-Path $stage "PORTABLE.txt")
$zip = Join-Path $rel "bundle\MediaStudioPro-$ver-portable-x64.zip"
New-Item -ItemType Directory -Force (Split-Path $zip) | Out-Null
Compress-Archive -Path $stage -DestinationPath $zip -Force
Get-Item $zip | Select-Object FullName, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
