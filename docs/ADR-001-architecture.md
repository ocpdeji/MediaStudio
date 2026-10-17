# ADR-001 — Architecture for Media Studio Pro

Status: accepted · Date: 2026-10-17

## Context

The starting point is `legacy/media-previewer.html` (≈120 KB single-file app): folder browsing, thumbnails,
filter/sort, ratings, compare, slideshow, snapshots, a canvas image editor (crop, adjust, transform,
patch-based watermark removal), a MediaRecorder-based trim/join/delogo exporter, batch rename and
reject-to-folder. Its hard limits are browser limits: real-time re-encoding, codec support only for what
Chromium decodes, no catalogue, no background jobs, no OS integration.

Build machine: Windows 11, Rust 1.98, Node 25, VS Build Tools 2026, WebView2 155, FFmpeg 9 (Gyan full),
NVIDIA RTX 4060 Ti + Intel iGPU.

## Decision

**Tauri 2 + React 19 + TypeScript (UI) · Rust (domain, filesystem, catalogue, jobs) · SQLite (catalogue) ·
FFmpeg/FFprobe as an out-of-process media engine · optional Real-ESRGAN (ncnn/Vulkan) for AI upscaling.**

| Option | Verdict |
|---|---|
| Tauri 2 + React + Rust | **Chosen.** ~10 MB shell (WebView2 is already on Windows 11), Rust gives safe, typed native commands, cheap threads for scanning/thumbnails/jobs, per-user NSIS installer without admin. Lets us reuse the proven canvas editors from the legacy app. |
| Electron | Works, but ships a second Chromium (~150 MB) and Node's fs/child_process are easier to misuse from the UI. No capability it gives us that Tauri lacks for this app. |
| .NET WPF/WinUI | Best native video surfaces, but we'd rewrite every working UI piece and lose the web-canvas editors. Slower iteration. |

### Media engine

FFmpeg is the authoritative decoder/encoder for everything heavy: probing, video thumbnails, proxies,
trim/join/convert/extract, timeline render, delogo, scaling. It runs as a child process with an **argument
vector** (never a shell string), `CREATE_NO_WINDOW`, `-progress pipe:1` for progress, and is killed on
cancel. Text for titles is passed through a temp file (`textfile=`) — never interpolated into filter strings.

Preview playback uses WebView2's decoders (H.264, VP8/9, AV1, HEVC where the OS has the extension).
When the webview can't decode a file, the user is offered a one-click **H.264 proxy** (cached) — the
original is never touched.

### Data

- SQLite (`rusqlite`, bundled) in `%APPDATA%/com.mediastudiopro.app/catalog.db`, WAL mode, versioned
  migrations via `PRAGMA user_version`.
- Thumbnails are JPEG files in the app cache dir keyed by `hash(path, size, mtime)` — invalidated
  automatically when the source changes; bounded and clearable. Never stored as BLOBs.
- Annotations (ratings, flags, colour labels, tags, notes, collections) live only in the catalogue;
  source files are never modified by annotation.
- Projects (timeline edits) are versioned JSON files (`*.msproj`) referencing media by absolute path
  plus library-relative path for relinking.

### Security boundaries

- The UI has **no** shell or generic fs access. Only named Tauri commands with validated inputs.
- The asset protocol scope starts empty and is extended at runtime only to library roots the user
  added through a native dialog, plus the app cache.
- Output writes go through one function: validate name → write to temp → atomic rename, refuse to
  overwrite unless the call explicitly says so (and the UI confirmed).
- Deletes go to the Windows Recycle Bin (`trash` crate). There is no permanent-delete command.
- SVG is rendered only via `<img>` (scripts don't execute there); thumbnails are rasterized by the UI.
- No network access except the optional, user-confirmed AI model download.

### Time representation

Timeline positions/durations are **integer microseconds** (`i64`). Project frame rate is a rational
(`num/den`); edits snap to frame boundaries computed from the rational, so there is no float drift.

## Consequences

- Preview of multi-track timelines in the webview is an approximation (HTML video + canvas compositing);
  the FFmpeg render is authoritative. The UI says so.
- Frame stepping uses the stream's real frame rate from ffprobe, but HTML video seeking is not
  guaranteed frame-exact; frame capture of the exact frame is done by FFmpeg when exactness matters.
- Bundled FFmpeg is a GPL build ⇒ ship its licence + source offer (`THIRD_PARTY_NOTICES.md`).
