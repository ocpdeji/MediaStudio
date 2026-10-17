//! Catalogue and installer for the free, offline AI components. Each entry is downloaded only when the user
//! asks (Settings → AI models, or "Download" next to a feature), streamed to disk with resume support, size
//! checked, and archives are unpacked with path-traversal protection.
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct File { pub url: &'static str, pub dest: &'static str, pub unzip: bool, pub mb: f64 }
pub struct Def {
    pub id: &'static str, pub group: &'static str, pub name: &'static str, pub desc: &'static str, pub license: &'static str,
    pub dir: &'static str, pub marker: &'static str, pub files: &'static [File], pub recommended: bool,
}

const HF_W: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
macro_rules! voice { ($id:literal, $name:literal, $path:literal, $file:literal, $mb:literal) => {
    Def { id: $id, group: "voices", name: $name, desc: "Offline neural text-to-speech voice (Piper).", license: "See the voice's model card (most are CC BY / MIT)", dir: "piper-voices", marker: concat!($file, ".onnx"),
        files: &[File { url: concat!("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/", $path, $file, ".onnx"), dest: concat!("piper-voices/", $file, ".onnx"), unzip: false, mb: $mb },
                 File { url: concat!("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/", $path, $file, ".onnx.json"), dest: concat!("piper-voices/", $file, ".onnx.json"), unzip: false, mb: 0.01 }], recommended: true }
} }

pub static CATALOG: &[Def] = &[
    Def { id: "whisper-cpu", group: "captions", name: "Whisper engine (CPU)", desc: "whisper.cpp speech recognition for auto captions and transcripts. Works on any PC.", license: "MIT", dir: "whisper/cpu", marker: "whisper-cli.exe",
        files: &[File { url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip", dest: "whisper/cpu", unzip: true, mb: 8.5 }], recommended: true },
    Def { id: "whisper-cuda", group: "captions", name: "Whisper engine (NVIDIA GPU)", desc: "CUDA build of whisper.cpp — 5–20× faster captions on NVIDIA GPUs. Falls back to the CPU engine automatically.", license: "MIT (CUDA runtime: NVIDIA EULA)", dir: "whisper/cuda", marker: "whisper-cli.exe",
        files: &[File { url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-11.8.0-x64.zip", dest: "whisper/cuda", unzip: true, mb: 271.6 }], recommended: true },
    Def { id: "whisper-base", group: "captions", name: "Whisper Base model", desc: "Fast, good for clear speech. 99 languages.", license: "MIT (OpenAI Whisper)", dir: "whisper", marker: "ggml-base.bin",
        files: &[File { url: concat!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/", "ggml-base.bin"), dest: "whisper/ggml-base.bin", unzip: false, mb: 141.1 }], recommended: true },
    Def { id: "whisper-small", group: "captions", name: "Whisper Small model", desc: "More accurate, still quick on a GPU.", license: "MIT (OpenAI Whisper)", dir: "whisper", marker: "ggml-small.bin",
        files: &[File { url: concat!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/", "ggml-small.bin"), dest: "whisper/ggml-small.bin", unzip: false, mb: 465.0 }], recommended: true },
    Def { id: "whisper-turbo", group: "captions", name: "Whisper Large-v3 Turbo (best)", desc: "Best accuracy, accents and noisy audio. Recommended with an NVIDIA GPU.", license: "MIT (OpenAI Whisper)", dir: "whisper", marker: "ggml-large-v3-turbo-q5_0.bin",
        files: &[File { url: concat!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/", "ggml-large-v3-turbo-q5_0.bin"), dest: "whisper/ggml-large-v3-turbo-q5_0.bin", unzip: false, mb: 547.4 }], recommended: true },
    Def { id: "piper", group: "voices", name: "Piper text-to-speech engine", desc: "Offline, natural-sounding voiceovers. Needs at least one voice below.", license: "MIT (espeak-ng data: GPL-3.0)", dir: "piper", marker: "piper.exe",
        files: &[File { url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip", dest: "piper", unzip: true, mb: 21.0 }], recommended: true },
    voice!("voice-en-us-lessac", "English (US) — Lessac, female", "en/en_US/lessac/medium/", "en_US-lessac-medium", 60.3),
    voice!("voice-en-us-ryan", "English (US) — Ryan, male (high quality)", "en/en_US/ryan/high/", "en_US-ryan-high", 115.2),
    voice!("voice-en-us-amy", "English (US) — Amy, female", "en/en_US/amy/medium/", "en_US-amy-medium", 60.3),
    voice!("voice-en-us-joe", "English (US) — Joe, male", "en/en_US/joe/medium/", "en_US-joe-medium", 60.3),
    voice!("voice-en-us-hfc-f", "English (US) — HFC, female", "en/en_US/hfc_female/medium/", "en_US-hfc_female-medium", 60.3),
    voice!("voice-en-us-hfc-m", "English (US) — HFC, male", "en/en_US/hfc_male/medium/", "en_US-hfc_male-medium", 60.3),
    voice!("voice-en-gb-alan", "English (UK) — Alan, male", "en/en_GB/alan/medium/", "en_GB-alan-medium", 60.3),
    voice!("voice-en-gb-jenny", "English (UK) — Jenny, female", "en/en_GB/jenny_dioco/medium/", "en_GB-jenny_dioco-medium", 60.3),
    voice!("voice-fr-siwis", "French — Siwis, female", "fr/fr_FR/siwis/medium/", "fr_FR-siwis-medium", 60.3),
    voice!("voice-es-davefx", "Spanish — Davefx, male", "es/es_ES/davefx/medium/", "es_ES-davefx-medium", 60.3),
    voice!("voice-de-thorsten", "German — Thorsten, male", "de/de_DE/thorsten/medium/", "de_DE-thorsten-medium", 60.3),
    Def { id: "rvm", group: "cutout", name: "Video background removal (RVM)", desc: "Robust Video Matting: removes the background behind people in videos and photos, no green screen.", license: "GPL-3.0 (Shanchuan Lin et al.)", dir: "matting", marker: "rvm_mobilenetv3_fp32.onnx",
        files: &[File { url: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx", dest: "matting/rvm_mobilenetv3_fp32.onnx", unzip: false, mb: 14.4 }], recommended: true },
    Def { id: "isnet", group: "cutout", name: "Image cutout — any subject (IS-Net)", desc: "Removes backgrounds behind objects, products and animals in photos.", license: "Apache-2.0 (Xuebin Qin)", dir: "matting", marker: "isnet-general-use.onnx",
        files: &[File { url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx", dest: "matting/isnet-general-use.onnx", unzip: false, mb: 170.0 }], recommended: true },
    Def { id: "rnnoise", group: "audio", name: "Noise reduction model (RNNoise)", desc: "Removes hum, fans, traffic and room noise from speech.", license: "BSD-3-Clause", dir: "rnnoise", marker: "sh.rnnn",
        files: &[File { url: "https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn", dest: "rnnoise/sh.rnnn", unzip: false, mb: 0.5 }], recommended: true },
    Def { id: "mdx-vocals", group: "audio", name: "Vocal isolation (MDX-Net Voc FT)", desc: "Separates vocals from music: isolate voice or remove vocals for karaoke/instrumentals.", license: "MIT (Ultimate Vocal Remover models)", dir: "separation", marker: "UVR-MDX-NET-Voc_FT.onnx",
        files: &[File { url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx", dest: "separation/UVR-MDX-NET-Voc_FT.onnx", unzip: false, mb: 63.7 }], recommended: true },
    Def { id: "realesrgan", group: "enhance", name: "AI upscaler (Real-ESRGAN)", desc: "2–4× super-resolution for photos and videos (Vulkan GPU, CPU fallback).", license: "BSD-3-Clause", dir: "realesrgan", marker: "realesrgan-ncnn-vulkan.exe",
        files: &[File { url: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip", dest: "realesrgan", unzip: true, mb: 45.0 }], recommended: true },
];
const _: &str = HF_W;

pub fn def(id: &str) -> Option<&'static Def> { CATALOG.iter().find(|d| d.id == id) }
pub fn root(data: &Path) -> PathBuf { data.join("models") }

/// Locate a file by name under a model folder (archives sometimes add a top-level directory).
pub fn find(data: &Path, dir: &str, marker: &str) -> Option<PathBuf> {
    let d = root(data).join(dir);
    let direct = d.join(marker);
    if direct.is_file() { return Some(direct); }
    walkdir::WalkDir::new(&d).max_depth(4).into_iter().filter_map(|e| e.ok()).find(|e| e.file_type().is_file() && e.file_name().eq_ignore_ascii_case(marker)).map(|e| e.into_path())
}
pub fn path_of(data: &Path, id: &str) -> Option<PathBuf> { let d = def(id)?; find(data, d.dir, d.marker) }

#[derive(Serialize)]
pub struct Status { pub id: &'static str, pub group: &'static str, pub name: &'static str, pub desc: &'static str, pub license: &'static str, pub mb: f64, pub installed: bool, pub recommended: bool }

pub fn status(data: &Path) -> Vec<Status> {
    CATALOG.iter().map(|d| Status { id: d.id, group: d.group, name: d.name, desc: d.desc, license: d.license, mb: d.files.iter().map(|f| f.mb).sum(), installed: find(data, d.dir, d.marker).is_some(), recommended: d.recommended }).collect()
}

fn agent() -> ureq::Agent { ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(20)).timeout_read(std::time::Duration::from_secs(60)).user_agent("MediaStudioPro/0.2").build() }

/// Stream a URL to `dest` (resuming a previous `.part`). Returns bytes written in total.
fn download(url: &str, dest: &Path, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    let part = dest.with_extension(format!("{}part", dest.extension().map(|e| format!("{}.", e.to_string_lossy())).unwrap_or_default()));
    if let Some(p) = dest.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = agent().get(url);
    if have > 0 { req = req.set("Range", &format!("bytes={have}-")); }
    let resp = req.call().map_err(|e| format!("Download failed ({url}): {e}"))?;
    let resumed = resp.status() == 206;
    let len: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let total = if resumed { have + len } else { len };
    let mut f = std::fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(&part).map_err(|e| e.to_string())?;
    let mut got = if resumed { have } else { 0 };
    let mut r = resp.into_reader();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
        let n = r.read(&mut buf).map_err(|e| format!("Download interrupted: {e}. Retry to resume."))?;
        if n == 0 { break; }
        f.write_all(&buf[..n]).map_err(|e| format!("Could not write the download: {e}"))?;
        got += n as u64;
        progress(got, total);
    }
    f.flush().map_err(|e| e.to_string())?; drop(f);
    if total > 0 && got != total { return Err(format!("Download incomplete ({got} of {total} bytes). Retry to resume.")); }
    if got == 0 { let _ = std::fs::remove_file(&part); return Err("The server returned an empty file".into()); }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(())
}

fn unzip(zip_path: &Path, dir: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("Bad archive: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = e.enclosed_name() else { continue }; // rejects ../ and absolute paths
        let target = dir.join(rel);
        if e.is_dir() { std::fs::create_dir_all(&target).map_err(|e| e.to_string())?; continue; }
        if let Some(p) = target.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        let mut o = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut e, &mut o).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sane(path: &Path) -> Result<(), String> {
    let mut head = [0u8; 8];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let html = head.starts_with(b"<!DOC") || head.starts_with(b"<html") || head.starts_with(b"<HTML");
    if n == 0 || html { return Err(format!("{} is not a valid model file (the server returned a web page)", path.display())); }
    if ext == "bin" && &head[..4] != b"lmgg" && &head[..4] != b"ggjt" && &head[..4] != b"GGUF" { return Err("Downloaded Whisper model has an unexpected format".into()); }
    Ok(())
}

pub fn install(data: &Path, id: &str, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64)) -> Result<String, String> {
    let d = def(id).ok_or_else(|| format!("Unknown model '{id}'"))?;
    if find(data, d.dir, d.marker).is_some() { return Ok(format!("{} is already installed", d.name)); }
    let root = root(data);
    let total_mb: f64 = d.files.iter().map(|f| f.mb).sum::<f64>().max(0.01);
    if let Ok(free) = fs4::available_space(data) { if (free as f64) < total_mb * 2.2 * 1_048_576.0 { return Err(format!("Not enough disk space to install {} (needs about {:.0} MB)", d.name, total_mb * 2.2)); } }
    let mut done_mb = 0.0;
    for f in d.files {
        let tmp_dir = root.join(".downloads");
        let dest = if f.unzip { tmp_dir.join(format!("{}.zip", d.id)) } else { root.join(f.dest) };
        let base = done_mb;
        download(f.url, &dest, cancel, &mut |got, total| {
            let frac = if total > 0 { got as f64 / total as f64 } else { 0.0 };
            progress(((base + frac * f.mb) / total_mb * 0.97).min(0.97));
        })?;
        if f.unzip { unzip(&dest, &root.join(f.dest))?; let _ = std::fs::remove_file(&dest); } else { sane(&dest).inspect_err(|_| { let _ = std::fs::remove_file(&dest); })?; }
        done_mb += f.mb;
    }
    progress(1.0);
    find(data, d.dir, d.marker).map(|p| format!("Installed {} ({})", d.name, p.display())).ok_or_else(|| format!("{} was downloaded but {} is missing from it", d.name, d.marker))
}

pub fn remove(data: &Path, id: &str) -> Result<(), String> {
    let d = def(id).ok_or("Unknown model")?;
    let root = root(data);
    for f in d.files {
        let p = root.join(f.dest);
        if f.unzip { let _ = std::fs::remove_dir_all(&p); } else { let _ = std::fs::remove_file(&p); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn catalogue_is_consistent() {
        let mut ids = std::collections::HashSet::new();
        for d in CATALOG {
            assert!(ids.insert(d.id), "duplicate {}", d.id);
            assert!(!d.files.is_empty() && d.files.iter().all(|f| f.url.starts_with("https://")), "{}", d.id);
            assert!(d.files.iter().all(|f| !f.dest.contains("..")), "{}", d.id);
        }
        assert!(def("whisper-base").is_some() && def("nope").is_none());
    }
    #[test] fn unzip_rejects_traversal() {
        let t = tempfile::tempdir().unwrap();
        let zp = t.path().join("x.zip");
        { let f = std::fs::File::create(&zp).unwrap(); let mut w = zip::ZipWriter::new(f);
          let o: zip::write::SimpleFileOptions = Default::default();
          w.start_file("../evil.txt", o).unwrap(); w.write_all(b"bad").unwrap();
          w.start_file("ok/good.txt", o).unwrap(); w.write_all(b"good").unwrap(); w.finish().unwrap(); }
        unzip(&zp, &t.path().join("out")).unwrap();
        assert!(t.path().join("out/ok/good.txt").is_file());
        assert!(!t.path().join("evil.txt").exists());
    }
}
