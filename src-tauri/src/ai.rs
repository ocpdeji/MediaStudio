//! Optional AI upscaling via Real-ESRGAN (ncnn + Vulkan: NVIDIA, AMD and Intel GPUs; CPU fallback with -g -1).
//! Nothing is downloaded unless the user explicitly asks for it in Settings → AI.
use crate::{db, export, media, ops};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const URL: &str = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip";
pub const APPROX_MB: u64 = 45;
pub const LICENSE: &str = "Real-ESRGAN: BSD-3-Clause (Xintao Wang). ncnn: BSD-3-Clause (Tencent).";

pub fn root(data: &Path) -> PathBuf { data.join("models").join("realesrgan") }
pub fn exe(data: &Path) -> Option<PathBuf> {
    walkdir::WalkDir::new(root(data)).max_depth(3).into_iter().filter_map(|e| e.ok()).find(|e| e.file_name().eq_ignore_ascii_case("realesrgan-ncnn-vulkan.exe")).map(|e| e.into_path())
}

#[derive(Serialize)]
pub struct Status { pub installed: bool, pub path: Option<String>, pub models: Vec<String>, pub size_mb: u64, pub download_mb: u64, pub url: &'static str, pub license: &'static str }

pub fn status(data: &Path) -> Status {
    let e = exe(data);
    let models = e.as_ref().and_then(|e| e.parent().map(|d| d.join("models"))).map(|m| {
        let mut v: Vec<String> = std::fs::read_dir(m).into_iter().flatten().filter_map(|x| x.ok()).filter_map(|x| x.file_name().to_string_lossy().strip_suffix(".param").map(String::from)).collect();
        v.sort(); v
    }).unwrap_or_default();
    let size = crate::thumbs::dir_size(&root(data)) / 1_048_576;
    Status { installed: e.is_some(), path: e.map(|p| p.to_string_lossy().into_owned()), models, size_mb: size, download_mb: APPROX_MB, url: URL, license: LICENSE }
}

/// Download + unpack. Rejects zip entries that would escape the target folder.
pub fn install(data: &Path, progress: &mut dyn FnMut(f64)) -> Result<(), String> {
    let dir = root(data);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let resp = ureq::get(URL).call().map_err(|e| format!("Download failed: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(APPROX_MB * 1_048_576);
    let mut r = resp.into_reader();
    let mut buf = Vec::with_capacity(total as usize);
    let mut chunk = [0u8; 65536];
    loop {
        let n = r.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        progress((buf.len() as f64 / total as f64).min(0.95));
    }
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(buf)).map_err(|e| format!("Bad archive: {e}"))?;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { continue };
        let target = dir.join(rel);
        if f.is_dir() { std::fs::create_dir_all(&target).map_err(|e| e.to_string())?; continue; }
        if let Some(p) = target.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        let mut o = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut o).map_err(|e| e.to_string())?;
    }
    progress(1.0);
    exe(data).map(|_| ()).ok_or_else(|| "Archive did not contain realesrgan-ncnn-vulkan.exe".into())
}

fn count_files(d: &Path) -> usize { std::fs::read_dir(d).map(|r| r.count()).unwrap_or(0) }

/// Run a child process, killing it on cancel; `tick` is called ~4×/s while it runs.
fn run_cancellable(mut cmd: std::process::Command, cancel: &Arc<AtomicBool>, tick: &mut dyn FnMut()) -> Result<(), String> {
    let mut child = cmd.stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let mut err = child.stderr.take().unwrap();
    let t = std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
    let status = loop {
        if cancel.load(Ordering::Relaxed) { let _ = child.kill(); let _ = child.wait(); return Err("cancelled".into()); }
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? { break s; }
        tick(); std::thread::sleep(std::time::Duration::from_millis(250));
    };
    let e = t.join().unwrap_or_default();
    if !status.success() {
        let msg = media::last_lines(&e, 5);
        return Err(if msg.to_lowercase().contains("vulkan") || msg.contains("gpu") { format!("GPU (Vulkan) error — try the CPU option or update your graphics driver.\n{msg}") } else { msg });
    }
    Ok(())
}

pub fn upscale(data: &Path, work: &Path, a: &db::AssetRow, scale: u32, model: &str, cpu: bool, out_dir: &Path, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64)) -> Result<PathBuf, String> {
    let bin = exe(data).ok_or("AI upscaler is not installed. Open Settings → AI to install it.")?;
    let scale = scale.clamp(2, 4);
    let native = if model.contains("animevideov3") { scale } else { 4 };
    let model_dir = bin.parent().unwrap().join("models");
    let base = |inp: &Path, outp: &Path| {
        let mut c = media::command(&bin);
        c.current_dir(bin.parent().unwrap());
        c.args(["-i", &inp.to_string_lossy(), "-o", &outp.to_string_lossy(), "-n", model, "-s", &native.to_string(), "-f", "png", "-m", &model_dir.to_string_lossy()]);
        if cpu { c.args(["-g", "-1"]); }
        c
    };
    let (stem, _) = ops::split_ext(&a.name);
    if a.kind == "image" {
        let up = work.join("up.png");
        run_cancellable(base(Path::new(&a.path), &up), cancel, &mut || {})?;
        progress(0.9);
        let mut img = image::open(&up).map_err(|e| e.to_string())?;
        if native != scale {
            let (w, h) = (a.width.unwrap_or(img.width() as i64 / native as i64) as u32 * scale, a.height.unwrap_or(img.height() as i64 / native as i64) as u32 * scale);
            img = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
        }
        let (_, bytes) = crate::jobs::encode(&img, "png", 95)?;
        return ops::write_atomic(out_dir, &format!("{stem}_ai{scale}x.png"), &bytes, false);
    }
    if a.kind != "video" { return Err("Upscaling supports images and videos".into()); }
    let pr = media::ffprobe_json(Path::new(&a.path)).map(|j| media::parse_probe(&j))?;
    let (fnum, fden) = (pr.fps_num.unwrap_or(30), pr.fps_den.unwrap_or(1));
    let frames = ((pr.duration_ms.unwrap_or(0) as f64 / 1000.0) * fnum as f64 / fden as f64).ceil() as u64;
    let (w, h) = (pr.width.unwrap_or(1280) as u64, pr.height.unwrap_or(720) as u64);
    let need = frames * (w * h * 3 / 2 + w * h * 3 * (scale * scale) as u64 / 2);
    if let Ok(free) = fs4::available_space(work) { if free < need { return Err(format!("Video upscaling needs about {} GB of temporary space; only {} GB free.", need / 1_073_741_824 + 1, free / 1_073_741_824)); } }
    let (fin, fout) = (work.join("in"), work.join("out"));
    std::fs::create_dir_all(&fin).map_err(|e| e.to_string())?; std::fs::create_dir_all(&fout).map_err(|e| e.to_string())?;
    let extract = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-i".into(), a.path.clone(), "-map".into(), "0:v:0".into(), "-fps_mode".into(), "passthrough".into(), fin.join("%08d.png").to_string_lossy().into_owned()];
    let mut c = media::command(media::ffmpeg_path()?); c.args(&extract);
    run_cancellable(c, cancel, &mut || progress((count_files(&fin) as f64 / frames.max(1) as f64 * 0.1).min(0.1)))?;
    let total = count_files(&fin).max(1);
    run_cancellable(base(&fin, &fout), cancel, &mut || progress(0.1 + 0.8 * count_files(&fout) as f64 / total as f64))?;
    let name = format!("{stem}_ai{scale}x.mp4");
    let target = ops::unique_path(out_dir, &name);
    let tmp = out_dir.join(format!("{}.partial.mp4", ops::split_ext(target.file_name().unwrap().to_str().unwrap()).0));
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into(), "-progress".into(), "pipe:1".into(), "-nostats".into(), "-loglevel".into(), "error".into(),
        "-framerate".into(), format!("{fnum}/{fden}"), "-i".into(), fout.join("%08d.png").to_string_lossy().into_owned(), "-i".into(), a.path.clone(), "-map".into(), "0:v".into(), "-map".into(), "1:a?".into()];
    let fs = if native != scale { vec!["-vf".to_string(), format!("scale={}:{}:flags=lanczos", (w * scale as u64) & !1, (h * scale as u64) & !1)] } else { vec![] };
    args.extend(fs);
    let (va, _) = export::video_codec_args(&export::Preset { crf: 17, ..Default::default() }, export::caps())?;
    args.extend(va); args.extend(["-c:a".into(), "copy".into(), "-shortest".into(), "-movflags".into(), "+faststart".into(), tmp.to_string_lossy().into_owned()]);
    let dur = pr.duration_ms.unwrap_or(0) * 1000;
    export::run_ffmpeg(&args, dur, None, cancel, &mut |p| progress(0.9 + p * 0.1)).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
    export::validate_output(&tmp, dur).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(target)
}
