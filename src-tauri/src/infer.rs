//! Native AI inference (ONNX Runtime + DirectML on any DirectX 12 GPU, CPU fallback):
//! background removal (RVM video matting, IS-Net image cutout) and vocal isolation (MDX-Net).
//! Frames and audio stream through FFmpeg pipes; nothing leaves the PC. ONNX Runtime telemetry is disabled.
use crate::{media, models};
use ort::{ep, session::Session, value::Tensor};
use rustfft::{num_complex::Complex32, FftPlanner};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

type R<T> = Result<T, String>;
fn e2s<E: std::fmt::Display>(e: E) -> String { e.to_string() }

static ENV: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();
fn env() -> R<&'static ort::environment::Environment> {
    ENV.get_or_init(|| ort::init().with_name("MediaStudioPro").with_telemetry(false).build().map_err(e2s)).as_ref().map_err(|e| format!("AI runtime unavailable: {e}"))
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Mutex<Session>>>>> = OnceLock::new();
static BACKEND: Mutex<String> = Mutex::new(String::new());
pub fn backend() -> String { BACKEND.lock().unwrap().clone() }

/// Load a model once (DirectML GPU first, CPU fallback) and reuse it.
fn session(data: &Path, id: &str) -> R<Arc<Mutex<Session>>> {
    let map = SESSIONS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(s) = map.lock().unwrap().get(id) { return Ok(s.clone()); }
    let path = models::path_of(data, id).ok_or_else(|| format!("The AI model isn't installed. Open AI models & keys and install “{}”.", models::def(id).map(|d| d.name).unwrap_or(id)))?;
    let env = env()?;
    let build = |gpu: bool| -> R<Session> {
        let mut b = Session::builder(env).map_err(e2s)?;
        // DirectML needs memory patterns and parallel execution off
        if gpu { b = b.with_execution_providers([ep::DirectML::default().build().error_on_failure()]).map_err(e2s)?.with_memory_pattern(false).map_err(e2s)?.with_parallel_execution(false).map_err(e2s)?; }
        b.commit_from_file(&path).map_err(e2s)
    };
    let s = match build(true) {
        Ok(s) => { *BACKEND.lock().unwrap() = "GPU (DirectML)".into(); s }
        Err(e) => {
            eprintln!("DirectML unavailable ({e}); using CPU");
            *BACKEND.lock().unwrap() = "CPU".into();
            build(false).map_err(|e| format!("Could not load the AI model: {e}"))?
        }
    };
    let s = Arc::new(Mutex::new(s));
    map.lock().unwrap().insert(id.into(), s.clone());
    Ok(s)
}

fn even(v: u32) -> u32 { (v.max(16) / 2) * 2 }
pub fn fit(w: u32, h: u32, max: u32) -> (u32, u32) { let s = (max as f64 / w.max(h) as f64).min(1.0); (even((w as f64 * s).round() as u32), even((h as f64 * s).round() as u32)) }

// ---------------------------------------------------------------- RVM (video matting)

struct Rvm { sess: Arc<Mutex<Session>>, rec: Vec<(Vec<i64>, Vec<f32>)>, ratio: f32 }
impl Rvm {
    fn new(data: &Path, w: u32, h: u32) -> R<Rvm> {
        // RVM guidance: internal resolution ~200–270 px on the short side
        Ok(Rvm { sess: session(data, "rvm")?, rec: vec![(vec![1, 1, 1, 1], vec![0.0]); 4], ratio: (216.0 / w.min(h) as f32).clamp(0.1, 1.0) })
    }
    /// RGB24 frame → alpha (0..1), keeping the recurrent state between frames.
    fn frame(&mut self, rgb: &[u8], w: u32, h: u32) -> R<Vec<f32>> {
        let n = (w * h) as usize;
        let mut inp = vec![0f32; 3 * n];
        for i in 0..n { inp[i] = rgb[i * 3] as f32 / 255.0; inp[n + i] = rgb[i * 3 + 1] as f32 / 255.0; inp[2 * n + i] = rgb[i * 3 + 2] as f32 / 255.0; }
        let t = |shape: Vec<i64>, d: Vec<f32>| Tensor::from_array((shape, d)).map_err(e2s);
        let mut s = self.sess.lock().unwrap();
        let out = s.run(ort::inputs![
            "src" => t(vec![1, 3, h as i64, w as i64], inp)?,
            "r1i" => t(self.rec[0].0.clone(), self.rec[0].1.clone())?, "r2i" => t(self.rec[1].0.clone(), self.rec[1].1.clone())?,
            "r3i" => t(self.rec[2].0.clone(), self.rec[2].1.clone())?, "r4i" => t(self.rec[3].0.clone(), self.rec[3].1.clone())?,
            "downsample_ratio" => t(vec![1], vec![self.ratio])?,
        ]).map_err(|e| format!("Background removal failed: {e}"))?;
        for (i, k) in ["r1o", "r2o", "r3o", "r4o"].iter().enumerate() {
            let (shape, d) = out[*k].try_extract_tensor::<f32>().map_err(e2s)?;
            self.rec[i] = (shape.iter().copied().collect(), d.to_vec());
        }
        let (_, pha) = out["pha"].try_extract_tensor::<f32>().map_err(e2s)?;
        Ok(pha.to_vec())
    }
}

/// Video → grayscale matte video (same duration and frame rate) in `out`.
pub fn matte_video(data: &Path, src: &Path, src_w: u32, src_h: u32, fps_num: i64, fps_den: i64, duration_us: i64, out: &Path, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64, &str)) -> R<()> {
    let (w, h) = fit(src_w, src_h, 960);
    let frames = ((duration_us as f64 / 1e6) * fps_num as f64 / fps_den.max(1) as f64).ceil().max(1.0) as u64;
    let mut rvm = Rvm::new(data, w, h)?;
    let ff = media::ffmpeg_path()?;
    let rate = format!("{fps_num}/{}", fps_den.max(1));
    let mut dec = media::command(ff).args(["-hide_banner", "-nostdin", "-loglevel", "error", "-i", &src.to_string_lossy(), "-map", "0:v:0",
        "-vf", &format!("scale={w}:{h}:flags=bilinear,format=rgb24"), "-fps_mode", "cfr", "-r", &rate, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("Could not start FFmpeg: {e}"))?;
    let tmp = out.with_extension("partial.mp4");
    let mut enc = media::command(ff).args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", &format!("{w}x{h}"), "-framerate", &rate, "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "fast", "-crf", "10", "-pix_fmt", "yuv420p", "-g", "30", &tmp.to_string_lossy()])
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Could not start FFmpeg: {e}"))?;
    let mut rd = dec.stdout.take().unwrap();
    let mut wr = enc.stdin.take().unwrap();
    let fb = (w * h * 3) as usize;
    let mut rgb = vec![0u8; fb];
    let mut gray = vec![0u8; (w * h) as usize];
    let t0 = std::time::Instant::now();
    let mut done = 0u64;
    let res = (|| -> R<()> {
        while done < frames {
            if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
            // the last decoded frame is repeated if the stream is a little shorter than its metadata says
            let got = rd.read_exact(&mut rgb).is_ok();
            if got || done > 0 {
                if got { let a = rvm.frame(&rgb, w, h)?; for (g, v) in gray.iter_mut().zip(a) { *g = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8; } }
            }
            wr.write_all(&gray).map_err(|e| format!("Encoder stopped: {e}"))?;
            done += 1;
            if done % 5 == 0 || done == frames {
                let fps = done as f64 / t0.elapsed().as_secs_f64().max(0.001);
                progress(done as f64 / frames as f64, &format!("{:.1} fps on {}", fps, backend()));
            }
        }
        Ok(())
    })();
    drop(wr); let _ = dec.kill(); let _ = dec.wait();
    let st = enc.wait().map_err(e2s)?;
    if let Err(e) = res { let _ = std::fs::remove_file(&tmp); return Err(e); }
    if !st.success() { let mut s = String::new(); if let Some(mut e) = enc.stderr.take() { let _ = e.read_to_string(&mut s); } let _ = std::fs::remove_file(&tmp); return Err(format!("Encoding the matte failed: {}", media::last_lines(&s, 4))); }
    std::fs::rename(&tmp, out).map_err(e2s)?;
    Ok(())
}

/// Image → matte PNG (IS-Net for any subject when installed, otherwise RVM for people).
pub fn matte_image(data: &Path, src: &Path, out: &Path) -> R<()> {
    let img = image::ImageReader::open(src).map_err(e2s)?.with_guessed_format().map_err(e2s)?.decode().map_err(|e| format!("Can't decode the image: {e}"))?;
    let (iw, ih) = (img.width(), img.height());
    let alpha: image::GrayImage = if models::path_of(data, "isnet").is_some() {
        const S: u32 = 1024;
        let small = img.resize_exact(S, S, image::imageops::FilterType::Triangle).to_rgb8();
        let n = (S * S) as usize; let mut inp = vec![0f32; 3 * n];
        for (i, p) in small.pixels().enumerate() { inp[i] = p[0] as f32 / 255.0 - 0.5; inp[n + i] = p[1] as f32 / 255.0 - 0.5; inp[2 * n + i] = p[2] as f32 / 255.0 - 0.5; }
        let sess = session(data, "isnet")?; let mut s = sess.lock().unwrap();
        let name = s.inputs()[0].name().to_string(); let oname = s.outputs()[0].name().to_string();
        let out_v = s.run(ort::inputs![name.as_str() => Tensor::from_array((vec![1i64, 3, S as i64, S as i64], inp)).map_err(e2s)?]).map_err(|e| format!("Cutout failed: {e}"))?;
        let (_, a) = out_v[oname.as_str()].try_extract_tensor::<f32>().map_err(e2s)?;
        let (lo, hi) = a.iter().fold((f32::MAX, f32::MIN), |(l, h), v| (l.min(*v), h.max(*v)));
        let g = image::GrayImage::from_fn(S, S, |x, y| image::Luma([(((a[(y * S + x) as usize] - lo) / (hi - lo).max(1e-6)) * 255.0) as u8]));
        image::imageops::resize(&g, iw, ih, image::imageops::FilterType::CatmullRom)
    } else {
        let (w, h) = fit(iw, ih, 1280);
        let rgb = img.resize_exact(w, h, image::imageops::FilterType::Triangle).to_rgb8();
        let mut rvm = Rvm::new(data, w, h)?;
        let mut a = vec![]; for _ in 0..3 { a = rvm.frame(rgb.as_raw(), w, h)?; } // let the recurrent state settle
        let g = image::GrayImage::from_fn(w, h, |x, y| image::Luma([(a[(y * w + x) as usize].clamp(0.0, 1.0) * 255.0) as u8]));
        image::imageops::resize(&g, iw, ih, image::imageops::FilterType::CatmullRom)
    };
    alpha.save_with_format(out, image::ImageFormat::Png).map_err(e2s)
}

// ---------------------------------------------------------------- MDX-Net vocal isolation

const SR: usize = 44100;
const N_FFT: usize = 7680;
const HOP: usize = 1024;
const DIM_T: usize = 256;
const DIM_F: usize = 3072;
const COMPENSATE: f32 = 1.021;

struct Stft { fwd: Arc<dyn rustfft::Fft<f32>>, inv: Arc<dyn rustfft::Fft<f32>>, win: Vec<f32> }
impl Stft {
    fn new() -> Stft {
        let mut p = FftPlanner::new();
        let win = (0..N_FFT).map(|n| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / N_FFT as f32).cos()).collect();
        Stft { fwd: p.plan_fft_forward(N_FFT), inv: p.plan_fft_inverse(N_FFT), win }
    }
    /// Centered STFT (reflect padding) of `x` (length (DIM_T-1)*HOP) → DIM_T frames × (N_FFT/2+1) bins.
    fn forward(&self, x: &[f32]) -> Vec<Vec<Complex32>> {
        let pad = N_FFT / 2; let n = x.len();
        let at = |i: isize| -> f32 { let mut j = i - pad as isize; if j < 0 { j = -j; } if j >= n as isize { j = 2 * (n as isize - 1) - j; } x[j.clamp(0, n as isize - 1) as usize] };
        (0..DIM_T).map(|t| {
            let mut buf: Vec<Complex32> = (0..N_FFT).map(|k| Complex32::new(at((t * HOP + k) as isize) * self.win[k], 0.0)).collect();
            self.fwd.process(&mut buf); buf.truncate(N_FFT / 2 + 1); buf
        }).collect()
    }
    /// Inverse of `forward` (overlap-add with window-square normalisation, centre padding removed).
    fn inverse(&self, spec: &[Vec<Complex32>], len: usize) -> Vec<f32> {
        let total = (DIM_T - 1) * HOP + N_FFT;
        let mut out = vec![0f32; total]; let mut norm = vec![0f32; total];
        for (t, frame) in spec.iter().enumerate() {
            let mut buf = vec![Complex32::new(0.0, 0.0); N_FFT];
            for k in 0..=N_FFT / 2 { buf[k] = frame[k]; if k > 0 && k < N_FFT / 2 { buf[N_FFT - k] = frame[k].conj(); } }
            self.inv.process(&mut buf);
            for k in 0..N_FFT { let i = t * HOP + k; out[i] += buf[k].re / N_FFT as f32 * self.win[k]; norm[i] += self.win[k] * self.win[k]; }
        }
        let pad = N_FFT / 2;
        (0..len).map(|i| { let v = norm[i + pad]; if v > 1e-8 { out[i + pad] / v } else { 0.0 } }).collect()
    }
}

/// Separate `src` into vocals and instrumental WAV files (44.1 kHz stereo).
pub fn separate(data: &Path, src: &Path, out_vocals: &Path, out_instr: &Path, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64, &str)) -> R<()> {
    let sess = session(data, "mdx-vocals")?;
    let ff = media::ffmpeg_path()?;
    let o = media::command(ff).args(["-hide_banner", "-nostdin", "-loglevel", "error", "-i", &src.to_string_lossy(), "-map", "0:a:0", "-ac", "2", "-ar", "44100", "-f", "f32le", "-"])
        .stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(e2s)?;
    if !o.status.success() { return Err(format!("Couldn't read the audio: {}", media::last_lines(&String::from_utf8_lossy(&o.stderr), 3))); }
    let samples: Vec<f32> = o.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let len = samples.len() / 2;
    if len < SR / 10 { return Err("The audio is too short to separate.".into()); }
    let ch: [Vec<f32>; 2] = [(0..len).map(|i| samples[i * 2]).collect(), (0..len).map(|i| samples[i * 2 + 1]).collect()];
    let chunk = HOP * (DIM_T - 1); let trim = N_FFT / 2; let gsz = chunk - 2 * trim;
    let pad_end = gsz + trim - (len % gsz);
    let padded: Vec<Vec<f32>> = ch.iter().map(|c| { let mut v = vec![0f32; trim]; v.extend_from_slice(c); v.extend(std::iter::repeat(0.0).take(pad_end)); v }).collect();
    let segments = (padded[0].len() - 2 * trim) / gsz;
    let stft = Stft::new();
    let mut voc: [Vec<f32>; 2] = [Vec::with_capacity(len + gsz), Vec::with_capacity(len + gsz)];
    let mut s = sess.lock().unwrap();
    let iname = s.inputs()[0].name().to_string(); let oname = s.outputs()[0].name().to_string();
    let t0 = std::time::Instant::now();
    for seg in 0..segments {
        if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
        let st = seg * gsz;
        let specs: Vec<Vec<Vec<Complex32>>> = (0..2).map(|c| stft.forward(&padded[c][st..st + chunk])).collect();
        // [1, 4, DIM_F, DIM_T]: ch0 re, ch0 im, ch1 re, ch1 im
        let mut inp = vec![0f32; 4 * DIM_F * DIM_T];
        for c in 0..2 { for f in 0..DIM_F { for t in 0..DIM_T {
            let v = specs[c][t][f];
            inp[((c * 2) * DIM_F + f) * DIM_T + t] = v.re; inp[((c * 2 + 1) * DIM_F + f) * DIM_T + t] = v.im;
        } } }
        let out = s.run(ort::inputs![iname.as_str() => Tensor::from_array((vec![1i64, 4, DIM_F as i64, DIM_T as i64], inp)).map_err(e2s)?]).map_err(|e| format!("Vocal separation failed: {e}"))?;
        let (_, y) = out[oname.as_str()].try_extract_tensor::<f32>().map_err(e2s)?;
        for c in 0..2 {
            let spec: Vec<Vec<Complex32>> = (0..DIM_T).map(|t| (0..=N_FFT / 2).map(|f| if f < DIM_F { Complex32::new(y[((c * 2) * DIM_F + f) * DIM_T + t], y[((c * 2 + 1) * DIM_F + f) * DIM_T + t]) } else { Complex32::new(0.0, 0.0) }).collect()).collect();
            let wave = stft.inverse(&spec, chunk);
            voc[c].extend_from_slice(&wave[trim..trim + gsz]);
        }
        let p = (seg + 1) as f64 / segments as f64;
        let eta = t0.elapsed().as_secs_f64() / p * (1.0 - p);
        progress(p * 0.95, &format!("Separating… {} · ~{:.0} s left", backend(), eta));
    }
    drop(s);
    let write = |path: &Path, f: &dyn Fn(usize, usize) -> f32| -> R<()> {
        let mut pcm = Vec::with_capacity(len * 8);
        for i in 0..len { for c in 0..2 { pcm.extend_from_slice(&f(c, i).clamp(-1.0, 1.0).to_le_bytes()); } }
        let tmp = path.with_extension("partial.wav");
        let mut enc = media::command(ff).args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "f32le", "-ar", "44100", "-ac", "2", "-i", "pipe:0", "-c:a", "pcm_s16le", &tmp.to_string_lossy()])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(e2s)?;
        enc.stdin.take().unwrap().write_all(&pcm).map_err(e2s)?;
        if !enc.wait().map_err(e2s)?.success() { return Err("Writing the separated audio failed".into()); }
        std::fs::rename(&tmp, path).map_err(e2s)
    };
    write(out_vocals, &|c, i| voc[c][i] * COMPENSATE)?;
    write(out_instr, &|c, i| ch[c][i] - voc[c][i] * COMPENSATE)?;
    progress(1.0, "Done");
    Ok(())
}

pub fn cache_name(src: &Path, tag: &str) -> PathBuf {
    let md = std::fs::metadata(src).ok();
    let key = crate::thumbs::key(&src.to_string_lossy(), md.as_ref().map(|m| m.len() as i64).unwrap_or(0), md.as_ref().map(crate::editmedia::mtime_ms).unwrap_or(0), 9);
    PathBuf::from(format!("{key}-{tag}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn stft_roundtrip_is_lossless() {
        let n = (DIM_T - 1) * HOP;
        let x: Vec<f32> = (0..n).map(|i| ((i as f32 * 0.013).sin() * 0.6 + (i as f32 * 0.0007).cos() * 0.3)).collect();
        let s = Stft::new();
        let y = s.inverse(&s.forward(&x), n);
        let err = x.iter().zip(&y).skip(N_FFT).take(n - 2 * N_FFT).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(err < 1e-3, "max error {err}");
    }
    #[test] fn fit_keeps_even_sizes() { assert_eq!(fit(1920, 1080, 960), (960, 540)); assert_eq!(fit(1280, 720, 960), (960, 540)); assert_eq!(fit(500, 300, 960), (500, 300)); }
}
