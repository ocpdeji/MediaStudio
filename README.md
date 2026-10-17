# Media Studio Pro

A local-first Windows app for browsing, reviewing and editing photos, video and audio. It grew out of the
single-file `media-previewer.html` (kept in `legacy/`). No account, no cloud, no telemetry.

**Architecture:** Tauri 2 (Rust) + React/TypeScript UI · SQLite catalogue · FFmpeg media engine ·
optional Real-ESRGAN for AI upscaling. See [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md).

## Install

- **Installer:** `MediaStudioPro_<ver>_x64-setup.exe` — per-user install, no admin rights, Start-menu and
  desktop shortcuts, uninstall from *Settings → Apps*.
- **Portable:** unzip `MediaStudioPro-<ver>-portable-x64.zip` and run `MediaStudioPro.exe`.

Both include FFmpeg. Windows 11 already has the WebView2 runtime; on Windows 10 the installer fetches it.

## What it does

**Library & review**
- Add folders (button, Ctrl+O or drag onto the window); files are catalogued, never moved or copied.
- Folder tree, smart lists (videos, images, audio, favourites, 4★+, rejected, recent), collections,
  tags, saved searches.
- Background scanning detects new, changed, moved and missing files; moved files keep their ratings and tags.
- Virtualized grid/list (sizes adjustable) with cached thumbnails and audio waveforms; visible items
  load first.
- Search across names, folders, tags and notes, with filters for type, rating, colour label,
  orientation, resolution, duration, size, date, extension and missing files.
- Sort by name, folder, type, dates, size, duration, resolution, aspect ratio or rating.
- Review with ★ ratings, favourite, reject and six colour labels, plus notes. Range and multi-select,
  invert selection, compare up to 4 side by side (synced zoom/playback), slideshow.
- Similar/duplicate finder (perceptual hash; results are approximate).
- Inspector: codec, frame rate, bitrate, audio streams, subtitles, HDR flag, EXIF with a GPS warning.
- Video player with SMPTE timecode, frame stepping at the file's real frame rate, speed, loop and volume.
  It can save or copy the exact frame (via FFmpeg), and offers a one-click H.264 proxy for codecs the
  preview can't play (HEVC without the Windows extension, ProRes, some MKV/AVI/MXF files).

**Quick video tools** (right-click → *Quick trim / export / remove logo*)
- Trim with in/out points (lossless keyframe cut or re-encode), speed, rotate/flip, crop,
  brightness/contrast/saturation, fades, volume, mute, loudness normalisation.
- Logo/watermark removal: FFmpeg delogo with a real processed-frame preview. Blur-area option.
- Presets: match source, web, archive H.265, 9:16, 1:1, 16:9, 4K, ProRes, WebM. GPU encoders
  (NVENC/QSV/AMF) are used only after a real test encode succeeds.
- Join clips: lossless when they match, otherwise re-encoded with a reason given; silence is added
  for clips without audio.
- Batch convert/compress, audio extraction (MP3/AAC/WAV/FLAC/Opus), batch image
  resize/rotate/convert, contact sheets, copy/move to folder, CSV/JSON selection manifest.

**Image editor** (E on an image)
- Non-destructive adjustments: exposure, brightness, contrast, highlights, shadows, levels, gamma,
  temperature/tint, saturation, vibrance, sharpen, noise reduction, blur, vignette, black & white.
  Before/after split.
- Crop with aspect presets, straighten with auto-crop, rotate/flip, high-quality resize, canvas size.
- Retouch: Smart fill (texture-matched seamless patch), Smooth fill, Clone/heal (Alt+click source),
  Blur, Pixelate.
- Text and image layers with opacity, rotation, blend modes and ordering.
- Encoded once at full resolution as PNG/JPEG/WebP. Saving a copy is the default; overwriting the
  original needs confirmation.

**Timeline** (Ctrl+3)
- Multiple video and audio tracks, plus image, title and colour clips. Drag, trim, split, ripple delete,
  duplicate, freeze frame and snapping.
- Track lock, hide, mute and reorder; timeline zoom.
- Clip inspector: speed, volume, fades, cross-dissolve/fade transitions, fit, scale, position,
  rotation, opacity, picture-in-picture and colour.
- Integer-µs timing with exact rational frame rates; undo/redo; `.msproj` projects with relinking of
  missing media; autosave and crash recovery.
- Live preview (approximate). The export is rendered frame-exactly by FFmpeg, either the whole
  timeline or a marked range.

**Enhance**
- Conventional Lanczos resize, or AI super-resolution (Real-ESRGAN, Vulkan GPU with CPU fallback),
  2×/3×/4×, for images and full videos (every frame; audio kept).
- Before/after comparison. The model is downloaded only after you confirm in Settings.

**Jobs & safety**
- Persistent background queue with progress, ETA, cancel, retry and limited concurrency. Jobs interrupted
  by a crash are marked *interrupted*.
- Every output is checked with ffprobe before success is reported. Outputs go to temp files first, with
  unique names; nothing is overwritten silently. Deletes go to the Recycle Bin. Batch renames preview
  conflicts first and can be undone.

## Keyboard

`←→↑↓` move · `1–5` rate · `0` clear · `F` favourite · `X` reject · `6–9` colour labels · `Enter` loupe ·
`C` compare · `P` slideshow · `E` edit · `F2` rename · `Del` Recycle Bin · `Ctrl+K` command palette ·
`?` all shortcuts. In the timeline: `Space` play · `S` split · `Shift+Del` ripple delete · `I/O` export range.

## Build from source

Requirements: Node 20+, Rust (stable, MSVC), Visual Studio C++ Build Tools, FFmpeg on PATH (or pass `-Source`).

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts\prepare-ffmpeg.ps1   # copies FFmpeg + licence into the bundle
npm run tauri dev                                                     # development
npm run tauri build                                                   # → src-tauri\target\release\bundle\nsis\*.exe
powershell -ExecutionPolicy Bypass -File scripts\package-portable.ps1 # → portable ZIP
```

## Tests

```powershell
cd src-tauri; cargo test        # 25 Rust tests incl. a real FFmpeg pipeline test (trim/delogo, join, timeline render, audio, cancel)
npx vitest run                  # timeline model: frame math, split/trim/ripple, snapping, undo, project files
```

`e2e/drive.mjs` drives the real app through WebView2 DevTools for end-to-end checks. Start the dev app with
`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"`; never enable this in production.

## Known limitations (v0.1)

- The timeline preview is approximate (HTML video + canvas): transforms and colour are close, but the
  export is authoritative. Preview frame stepping isn't guaranteed frame-exact; frame capture and export are.
- No folder watching yet; use Rescan (F5) after changing files outside the app.
- Not included yet: layer masks, curves UI, keyframed animation, subtitle burn-in, audio waveform
  editing on the timeline, noise reduction for audio, background removal, face restoration,
  transcription, scene detection, RAW development (RAW files get FFmpeg/embedded previews only), HEIC
  depends on the FFmpeg build.
- Video logo removal (delogo) interpolates from the surroundings. It works on small static marks over
  simple backgrounds and can leave a soft patch on busy footage. Only edit media you own or are
  authorised to modify.
- The bundled FFmpeg is the large "full" GPL build (~217 MB per exe). Run `prepare-ffmpeg.ps1 -Source <dir>`
  with a smaller GPL/LGPL build to shrink the installer.
- The installer isn't code-signed, so Windows SmartScreen may warn on first run.
