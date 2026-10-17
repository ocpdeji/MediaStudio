# Third-party notices — Media Studio Pro

Media Studio Pro is distributed together with, or can optionally download, the components below. Each is
the property of its respective authors and is used under its own licence.

## Bundled with the installer

| Component | Use | Licence |
|---|---|---|
| **FFmpeg / FFprobe** (Gyan.dev "full" build 9.0.2, configured `--enable-gpl --enable-version3`) | Media decoding, encoding, probing, thumbnails, proxies, export | **GNU GPL v3**. The full licence text is in `ffmpeg/FFMPEG-LICENSE`; build details in `ffmpeg/FFMPEG-BUILD-INFO.txt`. Corresponding source: https://ffmpeg.org/download.html and the build provider's source archives at https://www.gyan.dev/ffmpeg/builds/ . On request we will provide the exact corresponding source for three years from distribution. FFmpeg runs as a separate program; Media Studio Pro calls it as an external tool. |
| Tauri, tao, wry | Desktop shell | MIT / Apache-2.0 |
| Microsoft Edge WebView2 Runtime | UI rendering (part of Windows 11; installer bootstraps it if missing) | Microsoft Software Licence |
| React, React DOM | UI | MIT |
| zustand | UI state | MIT |
| lucide-react | Icons | ISC |
| SQLite (via rusqlite, bundled) | Catalogue database | Public domain (rusqlite: MIT) |
| image-rs (`image`), `imagesize`, `kamadak-exif` | Thumbnails, image decode/encode, EXIF | MIT / Apache-2.0, BSD-2-Clause |
| walkdir, serde, serde_json, thiserror, fs4, trash, ureq, zip | Filesystem, serialisation, Recycle Bin, download | MIT / Apache-2.0 |

## Optional — downloaded only after you click “Download & install” (Settings → AI models)

| Component | Use | Licence |
|---|---|---|
| Real-ESRGAN ncnn Vulkan (`realesrgan-ncnn-vulkan`, v0.2.5.0) and its models | AI image/video super-resolution | BSD-3-Clause (Xintao Wang) |
| ncnn | Neural network inference | BSD-3-Clause (Tencent) |

## Codecs and patents

H.264 / H.265 encoding uses the libx264 / libx265 encoders in the bundled FFmpeg (GPL) or your GPU’s
hardware encoder (NVENC / Quick Sync / AMF) through its driver. Some codecs may be subject to patent
licensing in some countries; you are responsible for complying with the rules that apply to your use.
HEVC *playback inside the preview* depends on Windows’ own HEVC extension; when it is missing the app
creates an H.264 preview proxy instead (the original file is never changed).
