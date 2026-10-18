# Media Studio Pro

A CapCut-style video editor and media library for Windows that runs **entirely on your PC** — no account, no
watermark, no upload. Free offline AI (captions, background removal, voiceovers, vocal isolation, noise reduction)
plus *bring-your-own-key* access to cloud AI (OpenAI, Gemini, Claude, Kling, Veo, Sora, ElevenLabs …).

**Architecture:** Tauri 2 (Rust) + React/TypeScript · WebGL2 compositor shared by preview and export · FFmpeg
(NVENC/QSV/AMF/x264/x265/ProRes/AV1) · ONNX Runtime + DirectML for on-device AI · whisper.cpp · Piper · SQLite.
See [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md) and [docs/ADR-002-editor-engine.md](docs/ADR-002-editor-engine.md).

## Install

| | |
|---|---|
| **Installer (recommended)** | `Media Studio Pro_<ver>_x64-setup.exe` — installs for your user only (no admin), adds Start-menu/desktop shortcuts and an uninstaller, and keeps one fixed location so updates replace the app cleanly. |
| **Portable** | Unzip `MediaStudioPro-<ver>-portable-x64.zip` anywhere (USB drive too) and run `MediaStudioPro.exe`. Same app; no shortcuts or uninstaller. |

Both include FFmpeg and the DirectML GPU runtime. Projects and settings are shared between them
(`Documents\Media Studio Pro\Projects`, `%APPDATA%\com.mediastudiopro.app`). Windows 11 already has WebView2.
The installer isn't code-signed yet, so SmartScreen may say “Windows protected your PC” → **More info → Run anyway**.

## Editor (CapCut layout)

**Home** — Create project (name + ratio 16:9 / 9:16 / 1:1 / 4:5 / 21:9 …), project grid with covers, search, sort,
rename (double-click the name), duplicate, delete to Recycle Bin, show in folder, templates. Autosave every second
with rolling backups; damaged project files fall back to the last good backup.

**Left panel tabs** — Media (import, your library, free stock from Pexels/Pixabay) · Audio (16 built-in sound
effects, Freesound, Jamendo music, text-to-speech, extract audio) · Text (24 styled presets, templates) · Stickers
(emoji sets, shapes, your PNG/GIF) · Effects (62 GPU effects in 9 groups) · Transitions (123) · Captions · Filters
(44 looks + import `.cube` LUTs) · Adjustment layers · Templates · AI.

**Player** — live GPU preview of the exact export, drag / scale / rotate layers on the canvas with centre snapping,
SMPTE timecode, frame stepping, ratio switcher, full screen.

**Properties (right)** — Video: transform with keyframes, opacity & 14 blend modes, crop with ratio presets, six mask
shapes (feather, invert), chroma key with spill suppression, AI background removal, stabilise, per-clip effects ·
Audio: volume (keyframes, up to +12 dB), fades, noise reduction, voice enhance, loudness normalise, 24 voice
changers, AI voice isolation / karaoke · Speed: 0.1–100×, speed curves (montage, hero, bullet, ramps), keep pitch ·
Animation: 29 in/out + 10 loop animations, letter-by-letter text animations · Adjust: exposure, contrast, highlights,
shadows, temperature, tint, saturation, vibrance, hue, sharpen, vignette, grain, fade, filter intensity · Text: any
installed or bundled font, size, colour, gradient, stroke, shadow/glow, background box, spacing, case, presets ·
Captions: word highlight (colour, box, pop, reveal), apply style/position to all.

**Timeline** — magnetic main track, overlays, text/sticker, effect, filter, adjustment and audio tracks; thumbnail
strips and waveforms; drag to move/trim with snapping; split (Ctrl+B), delete left/right of playhead (Q/W), ripple
delete, duplicate, copy/paste, freeze frame, reverse, mirror, rotate, markers, extract audio, voiceover recording,
marquee select, Ctrl+wheel zoom, lock/hide/mute tracks, 300-step undo.

**Export** — what you see is what you get (same GPU renderer), frame-exact decoding, 480p–8K, 24–60 fps, H.264 / HEVC
/ AV1 / ProRes, three quality levels, hardware encoding (NVENC/QSV/AMF verified at start-up), audio-only (MP3/WAV/
M4A/FLAC) and SRT/VTT/TXT captions. Every file is checked with ffprobe before success is reported.

**HEVC / iPhone / ProRes footage** — anything the preview engine can't decode gets a one-time GPU-encoded H.264 working
copy automatically (in the cache); exports still read the original.

## AI

| Feature | Engine | Where it runs |
|---|---|---|
| Auto captions, transcripts, translation to English | whisper.cpp (Base / Small / Large-v3 Turbo) with word-exact DTW timing | Your GPU (CUDA) or CPU |
| Translate captions to any language, AI scripts | Any chat model with your key — or free local Ollama / LM Studio | Your choice |
| Remove background (video / photo) | Robust Video Matting · IS-Net | Your GPU (DirectML) |
| Vocal isolation / remove vocals | MDX-Net (UVR Voc FT) | Your GPU (DirectML) |
| Voiceovers | Piper (11 free voices) · OpenAI · ElevenLabs | Offline or your key |
| Noise reduction | RNNoise | Offline |
| Remove silences | FFmpeg silence detection | Offline |
| AI images | OpenAI GPT-Image · Gemini Imagen · Flux (Replicate / fal) | Your key |
| AI video | Kling (Replicate / fal) · Google Veo · OpenAI Sora | Your key |
| Upscale 2–4× | Real-ESRGAN | Your GPU (Vulkan) |

Free models download from **Home → AI models & keys** (one click: “Download all”) or on first use. API keys are
stored in **Windows Credential Manager**, never in project files, and are sent only to that provider.

## Media library

Add folders (files stay where they are), virtualised grid/list, ratings, flags, colour labels, tags, collections,
smart filters, duplicate finder, compare, slideshow, batch rename/convert, quick trim & logo removal, photo editor
and Enhance workspace.

## Keyboard (editor)

`Space` play · `←/→` frame (Shift: 1 s) · `Ctrl+B` split · `Q`/`W` delete left/right · `Del` delete · `Ctrl+C/V`
copy/paste · `Ctrl+D` duplicate · `Ctrl+Z / Ctrl+Shift+Z` undo/redo · `M` marker · `S` snapping · `+/−` zoom ·
`Ctrl+S` save · `Ctrl+E` export · `?` all shortcuts.

## Build from source

Requirements: Node 20+, Rust stable (MSVC), Visual Studio C++ Build Tools, FFmpeg on PATH (or pass `-Source`).

```powershell
npm install
node scripts/fetch-fonts.mjs                                            # bundled OFL/Apache fonts (once)
powershell -ExecutionPolicy Bypass -File scripts\prepare-ffmpeg.ps1    # FFmpeg + licence into the bundle
cd src-tauri; cargo build; cd ..                                        # downloads ONNX Runtime/DirectML
powershell -ExecutionPolicy Bypass -File scripts\prepare-runtime.ps1   # DirectML.dll into the bundle
npm run tauri dev                                                       # development
npm run tauri build                                                     # → src-tauri\target\release\bundle\nsis\*.exe
powershell -ExecutionPolicy Bypass -File scripts\package-portable.ps1  # → portable ZIP
```

## Tests

```powershell
cd src-tauri; cargo test     # 43 Rust tests: projects, playability, optimize args, audio mix, voice FX, Whisper parsing,
                             # model catalogue/unzip safety, BYOK host allow-list, file-access allow-list, STFT round-trip,
                             # real FFmpeg pipeline (trim/delogo/join/render/audio/cancel) …
npx vitest run               # 26 tests: timeline model (frame maths, split/trim/ripple, speed curves, keyframes, transitions…)
node e2e/editor-ui.mjs       # real mouse/keyboard editing in the running dev app
node e2e/shaders.mjs         # compiles all 62 effects + 123 transitions on the GPU
```

## Known limitations

- Live preview of speed **curves** and **reversed** clips seeks frame by frame (smooth on short clips); export is exact.
- Background removal is tuned for people in video (RVM); for objects use photos (IS-Net) or chroma key.
- Cloud AI quality, price and content rules are the provider's; generation can take minutes for video.
- Stock/music items may require credit or be non-commercial — the licence is shown when you add them.
- Not yet: multi-camera, nested sequences, motion tracking, beat detection, AI avatars/lip-sync (available through
  Replicate/fal models with your key), cloud collaboration (by design: everything stays local).
- Unsigned installer (SmartScreen warning on first run).
