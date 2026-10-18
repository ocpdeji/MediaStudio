# ADR-002 — Editor engine (v0.2)

## Context
v0.1's timeline previewed with HTML video + canvas and exported with an FFmpeg filtergraph. Two renderers drifted
apart, effects/keyframes/text animations were impossible to keep identical, and HEVC sources (the common case for
AI-generated and phone footage) did not play at all in WebView2 on machines without the HEVC extension.

## Decisions
1. **One compositor for preview and export.** A WebGL2 compositor (`src/editor/engine`) renders every frame: layer
   pass (transform, crop, colour grade, LUT, chroma key, masks, matte), separable blur, W3C blend modes, 62 effect
   shaders, 123 gl-transitions, canvas-rendered text/stickers. Preview runs at display size; export at full size.
2. **Export = GPU frames → native encoder.** Frames are converted to BT.709 YUV 4:2:0 on the GPU, read back,
   double-buffered and streamed over raw IPC into an FFmpeg process (NVENC/QSV/AMF verified at start-up, x264/x265/
   SVT-AV1/ProRes fallback). Audio is mixed separately by FFmpeg from a typed plan (only numbers enter filters).
3. **Frame-exact decoding for export** with WebCodecs (mediabunny). The export schedule is planned up front and each
   clip gets one decoder stream fed its complete timestamp list (the decoder reads ahead; feeding timestamps one at a
   time deadlocks). Preview uses `<video>` elements for smooth hardware playback with Web Audio for gain/fades.
4. **Optimized media.** Sources the WebView can't decode (HEVC, ProRes, 10-bit H.264, AC-3, AVI/MXF…) get a cached
   GPU-encoded H.264 copy (same resolution, 1 s GOP). The library viewer uses the same copies automatically.
5. **Native AI.** WebGPU ONNX Runtime produced numerically wrong mattes for RVM (alpha mean 0.09 vs 0.35 on CPU) and
   ran at ~4 fps, so inference moved to Rust: ONNX Runtime + DirectML (any DX12 GPU), CPU fallback, telemetry off.
   Video matting streams FFmpeg rgb24 → RVM (recurrent state) → gray matte video (~20 fps debug build, 720p).
   Vocal isolation implements the UVR MDX-Net STFT pipeline (n_fft 7680, hop 1024, 3072 bins × 256 frames).
6. **Captions** use whisper.cpp with DTW token alignment (`-dtw <model> -nfa`; DTW is skipped while flash attention
   is on) for word-exact karaoke captions, transcribing the rendered timeline mix so cuts and speed changes are
   respected.
7. **Projects** live in `Documents\Media Studio Pro\Projects\<id>` (`project.json`, `meta.json`, `cover.jpg`,
   `assets/`, `backups/`), autosaved after every change, with fallback to the newest readable backup.
8. **Jobs** run in lanes (interactive "prepare", network "download", heavy "main") so a preview never waits behind a
   model download or an export. Write transactions are `BEGIN IMMEDIATE` to avoid SQLITE_BUSY upgrade failures.

## Consequences
- Preview and export look the same by construction; new effects are one GLSL function.
- First use of an HEVC clip costs a short GPU transcode (~1 s for 15 s of 720p on an RTX 4060 Ti).
- The installer grows by DirectML.dll (18 MB); ONNX Runtime is linked statically.
