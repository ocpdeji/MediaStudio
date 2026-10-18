# Copies the DirectML runtime (Microsoft redistributable, used by ONNX Runtime for GPU AI) next to the bundle
# resources. Run after the first `cargo build` (which downloads it into the ort cache).
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot
$dst = Join-Path $root "src-tauri\bin"
New-Item -ItemType Directory -Force $dst | Out-Null
$src = Get-ChildItem "$env:LOCALAPPDATA\ort.pyke.io\dfbin" -Recurse -Filter DirectML.dll | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $src) { throw "DirectML.dll not found - run 'cargo build' in src-tauri first." }
Copy-Item $src.FullName (Join-Path $dst "DirectML.dll") -Force
Get-Item (Join-Path $dst "DirectML.dll") | Select-Object FullName, Length
