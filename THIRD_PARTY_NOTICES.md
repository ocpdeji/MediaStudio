# Third-party notices — Media Studio Pro

Media Studio Pro is distributed together with, or can optionally download, the components below. Each is
the property of its respective authors and is used under its own licence.

## Bundled with the installer

| Component | Use | Licence |
|---|---|---|
| **FFmpeg / FFprobe** (Gyan.dev "full" build, configured `--enable-gpl --enable-version3`) | Media decoding, encoding, probing, thumbnails, optimized media, export | **GNU GPL v3**. The full licence text is in `ffmpeg/FFMPEG-LICENSE`; build details in `ffmpeg/FFMPEG-BUILD-INFO.txt`. Corresponding source: https://ffmpeg.org/download.html and https://www.gyan.dev/ffmpeg/builds/ . On request we will provide the exact corresponding source for three years from distribution. FFmpeg runs as a separate program. |
| **ONNX Runtime** (via the `ort` crate) | On-device AI inference (background removal, vocal isolation) | MIT (Microsoft); `ort`: MIT / Apache-2.0 |
| **DirectML** (`DirectML.dll`) | GPU acceleration for ONNX Runtime on DirectX 12 hardware | Microsoft DirectML redistributable licence |
| Tauri, tao, wry | Desktop shell | MIT / Apache-2.0 |
| Microsoft Edge WebView2 Runtime | UI rendering (part of Windows 11; installer bootstraps it if missing) | Microsoft Software Licence |
| React, React DOM, zustand | UI | MIT |
| lucide-react | Icons | ISC |
| **mediabunny** | Frame-exact video decoding for export (WebCodecs) | MPL-2.0 (unmodified) |
| **gl-transitions** | 123 GLSL transitions | MIT (individual authors credited in the app; 2 transitions BSD) |
| Fonts: Montserrat, Poppins, Inter, Roboto, Anton, Bebas Neue, Oswald, Archivo Black, Kanit, Teko, Russo One, Righteous, Bangers, Pacifico, Lobster, Dancing Script, Playfair Display, Comfortaa, Caveat | Text & captions | SIL Open Font License 1.1 (full texts in `fonts/LICENSES.txt`) |
| Fonts: Luckiest Guy, Permanent Marker | Text & captions | Apache License 2.0 |
| SQLite (via rusqlite, bundled) | Catalogue database | Public domain (rusqlite: MIT) |
| image-rs, imagesize, kamadak-exif, rustfft, walkdir, serde, thiserror, fs4, trash, ureq, zip, keyring, ttf-parser | Images, EXIF, DSP, filesystem, Recycle Bin, downloads, Credential Manager, fonts | MIT / Apache-2.0 / BSD-2-Clause |

## Optional — downloaded only when you choose (Home → AI models & keys, or on first use of a feature)

| Component | Use | Licence |
|---|---|---|
| whisper.cpp (CPU and CUDA builds) | Speech recognition for captions | MIT (CUDA runtime DLLs: NVIDIA EULA) |
| OpenAI Whisper models (ggml base / small / large-v3-turbo) | Captions | MIT |
| Piper TTS engine | Offline voiceovers | MIT (espeak-ng data: GPL-3.0) |
| Piper voices | Offline voiceovers | Per voice model card (CC BY 4.0 / CC0 / MIT …) |
| Robust Video Matting (RVM) | Video background removal | GPL-3.0 (Shanchuan Lin et al.) |
| IS-Net general-use | Image cutout | Apache-2.0 (Xuebin Qin) |
| RNNoise model (somnolent-hogwash) | Noise reduction | BSD-3-Clause |
| UVR MDX-Net Voc FT | Vocal isolation | MIT (Ultimate Vocal Remover) |
| Real-ESRGAN ncnn Vulkan + models | AI super-resolution | BSD-3-Clause |

## Cloud services you connect yourself (BYOK)

OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, ElevenLabs, Replicate, fal.ai,
Pexels, Pixabay, Freesound and Jamendo are used only when you add your own key. Their terms apply to what you
generate or download; stock and music items show their licence (some Freesound/Jamendo items require credit or are
non-commercial). Keys are stored in Windows Credential Manager and are never written to project files.

## Codecs and patents

H.264 / H.265 encoding uses libx264 / libx265 in the bundled FFmpeg (GPL) or your GPU's hardware encoder
(NVENC / Quick Sync / AMF). Some codecs may be subject to patent licensing in some countries; you are responsible
for complying with the rules that apply to your use. HEVC sources are converted to an H.264 working copy for the
preview engine (the original file is never changed).
