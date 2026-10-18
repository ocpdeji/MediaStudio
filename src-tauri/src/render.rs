//! Export pipeline for the editor. The UI renders every frame with the same GPU compositor as the preview,
//! converts it to YUV 4:2:0 on the GPU and streams it here; FFmpeg encodes it (NVENC / QSV / AMF / x264 / x265 /
//! ProRes / AV1) together with an audio mix built from a typed plan. Nothing user-typed enters a filtergraph:
//! only numbers are formatted into filters, paths are passed as `-i` arguments.
use crate::export::{self, Preset};
use crate::media;
use crate::ops;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------- audio plan

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct AudioSeg {
    pub path: String,
    pub src_in_us: i64, pub src_out_us: i64,
    pub start_us: i64,
    pub speed: f64,
    pub keep_pitch: bool,
    /// (time from segment start on the timeline in µs, linear gain). Empty = 1.0.
    pub volume: Vec<(i64, f64)>,
    pub fade_in_us: i64, pub fade_out_us: i64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct AudioPlan { pub segs: Vec<AudioSeg>, pub duration_us: i64 }

fn secs(us: i64) -> String { format!("{:.6}", us as f64 / 1e6) }
fn num(v: f64) -> String { if v.is_finite() { format!("{v:.6}") } else { "0".into() } }

/// Piecewise-linear gain expression of `t` (seconds) for FFmpeg's `volume=…:eval=frame`.
pub fn volume_expr(kf: &[(i64, f64)]) -> String {
    let mut k: Vec<(f64, f64)> = kf.iter().map(|(t, v)| (*t as f64 / 1e6, v.clamp(0.0, 16.0))).collect();
    k.sort_by(|a, b| a.0.total_cmp(&b.0));
    match k.len() { 0 => return "1".into(), 1 => return num(k[0].1), _ => {} }
    let mut e = num(k[k.len() - 1].1);
    for i in (0..k.len() - 1).rev() {
        let ((t0, v0), (t1, v1)) = (k[i], k[i + 1]);
        let seg = if (t1 - t0).abs() < 1e-9 { num(v1) } else { format!("{}+({})*(t-{})/{}", num(v0), num(v1 - v0), num(t0), num(t1 - t0)) };
        e = format!("if(lt(t,{}),{},{})", num(t1), seg, e);
    }
    format!("if(lt(t,{}),{},{})", num(k[0].0), num(k[0].1), e)
}

/// FFmpeg args that render the mix to `out` (codec chosen from the extension).
pub fn build_mix(plan: &AudioPlan, out: &Path) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut a = s(&["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error"]);
    let dur = plan.duration_us.max(40_000);
    let segs: Vec<&AudioSeg> = plan.segs.iter().filter(|g| g.src_out_us > g.src_in_us && g.start_us < dur && Path::new(&g.path).is_file()).collect();
    let mut fc = vec![];
    // a silent bed guarantees the exact output length even if nothing plays at the start or end
    a.extend(s(&["-f", "lavfi", "-t", &secs(dur), "-i", "anullsrc=r=48000:cl=stereo"]));
    let mut labels = vec!["[0:a]".to_string()];
    for (i, g) in segs.iter().enumerate() {
        let n = i + 1;
        a.extend(s(&["-ss", &secs(g.src_in_us.max(0)), "-t", &secs(g.src_out_us - g.src_in_us), "-i", &g.path]));
        let speed = if g.speed > 0.0 && g.speed.is_finite() { g.speed.clamp(0.05, 100.0) } else { 1.0 };
        let mut f = vec!["aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo".to_string(), "asetpts=PTS-STARTPTS".to_string()];
        if (speed - 1.0).abs() > 1e-6 {
            if g.keep_pitch { f.extend(export::atempo_chain(speed)); } else { f.push(format!("asetrate={}", num(48000.0 * speed))); f.push("aresample=48000".into()); }
        }
        let len = ((g.src_out_us - g.src_in_us) as f64 / speed) as i64;
        if !g.volume.is_empty() { f.push(format!("volume='{}':eval=frame", volume_expr(&g.volume))); }
        if g.fade_in_us > 0 { f.push(format!("afade=t=in:st=0:d={}", secs(g.fade_in_us.min(len)))); }
        if g.fade_out_us > 0 { let d = g.fade_out_us.min(len); f.push(format!("afade=t=out:st={}:d={}", secs((len - d).max(0)), secs(d))); }
        let ms = (g.start_us.max(0) as f64 / 1000.0).round() as i64;
        if ms > 0 { f.push(format!("adelay=delays={ms}:all=1")); }
        fc.push(format!("[{n}:a]{}[s{n}]", f.join(",")));
        labels.push(format!("[s{n}]"));
    }
    fc.push(format!("{}amix=inputs={}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.98:level=disabled,atrim=0:{}[mix]", labels.join(""), labels.len(), secs(dur)));
    a.extend(["-filter_complex".into(), fc.join(";"), "-map".into(), "[mix]".into()]);
    let ext = out.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    a.extend(match ext.as_str() {
        "mp3" => s(&["-c:a", "libmp3lame", "-b:a", "320k"]),
        "m4a" | "aac" => s(&["-c:a", "aac", "-b:a", "256k"]),
        "flac" => s(&["-c:a", "flac"]),
        "opus" | "ogg" => s(&["-c:a", "libopus", "-b:a", "192k"]),
        _ => s(&["-c:a", "pcm_s16le"]),
    });
    a.extend(s(&["-ar", "48000"]));
    a.push(out.to_string_lossy().into_owned());
    a
}

// ---------------------------------------------------------------- frame sessions

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct RenderSpec {
    pub width: u32, pub height: u32, pub fps_num: i64, pub fps_den: i64, pub frames: i64,
    /// "yuv420p" (export) or "gray" (background-removal mattes)
    pub input: String,
    pub out_dir: String, pub name: String,
    pub preset: Preset,
    pub audio: Option<AudioPlan>,
    /// Write straight to `out_dir/name` in the cache (mattes) instead of a unique user-facing name.
    pub internal: bool,
}
impl Default for RenderSpec {
    fn default() -> Self { RenderSpec { width: 1920, height: 1080, fps_num: 30, fps_den: 1, frames: 0, input: "yuv420p".into(), out_dir: String::new(), name: "export.mp4".into(), preset: Preset::default(), audio: None, internal: false } }
}

pub struct Session {
    child: Child, stdin: Option<ChildStdin>, tmp: PathBuf, dir: PathBuf, name: String, internal: bool,
    frame_bytes: usize, frames: i64, written: i64, duration_us: i64, err: Arc<Mutex<String>>, audio_tmp: Option<PathBuf>,
}

#[derive(Default)]
pub struct Sessions { map: Mutex<HashMap<u64, Arc<Mutex<Session>>>>, seq: AtomicU64 }

impl Sessions {
    pub fn get(&self, id: u64) -> Result<Arc<Mutex<Session>>, String> { self.map.lock().unwrap().get(&id).cloned().ok_or_else(|| "This export is no longer running.".to_string()) }
    fn insert(&self, s: Session) -> u64 { let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1; self.map.lock().unwrap().insert(id, Arc::new(Mutex::new(s))); id }
    fn remove(&self, id: u64) -> Option<Arc<Mutex<Session>>> { self.map.lock().unwrap().remove(&id) }
}

pub fn start(sessions: &Sessions, spec: &RenderSpec, work: &Path, cancel: &Arc<AtomicBool>, on_audio: &mut dyn FnMut(f64)) -> Result<(u64, String), String> {
    let (w, h) = (spec.width, spec.height);
    if w < 16 || h < 16 || w > 8192 || h > 8192 || w % 2 != 0 || h % 2 != 0 { return Err(format!("Unsupported export size {w}×{h}")); }
    if spec.fps_num <= 0 || spec.fps_den <= 0 || spec.fps_num / spec.fps_den > 240 { return Err("Unsupported frame rate".into()); }
    if spec.frames <= 0 { return Err("Nothing to export — the timeline is empty.".into()); }
    let dir = PathBuf::from(&spec.out_dir);
    if spec.internal { let _ = std::fs::create_dir_all(&dir); }
    if !dir.is_dir() { return Err(format!("Output folder does not exist: {}", spec.out_dir)); }
    ops::validate_filename(&spec.name)?;
    let duration_us = (spec.frames as f64 * 1e6 * spec.fps_den as f64 / spec.fps_num as f64).round() as i64;
    let gray = spec.input == "gray";
    // rough space check: ~ 12 Mbit/s at 1080p scaled by pixels
    let est = (w as u64 * h as u64 / 2_073_600 + 1) * 1_500_000 * (duration_us as u64 / 1_000_000 + 1);
    if let Ok(free) = fs4::available_space(&dir) { if free < est / 2 + 50 * 1_048_576 { return Err(format!("Not enough disk space in {} (about {} MB needed)", dir.display(), est / 1_048_576)); } }

    // 1) audio first (fast), so the encoder can mux it in one pass
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let audio_tmp = match (&spec.audio, gray || spec.preset.acodec == "none") {
        (Some(plan), false) => {
            let wav = work.join(format!("mix-{}.wav", crate::db::now_ms()));
            let mut p = plan.clone(); p.duration_us = duration_us;
            export::run_ffmpeg(&build_mix(&p, &wav), duration_us, None, cancel, on_audio)?;
            Some(wav)
        }
        _ => None,
    };

    // 2) the video encoder reading raw frames on stdin
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let (stem, ext) = ops::split_ext(&spec.name);
    let tmp = if spec.internal { dir.join(format!("{stem}.partial.{ext}")) } else { dir.join(format!("{stem}.partial.{ext}")) };
    let mut a = s(&["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", if gray { "gray" } else { "yuv420p" },
        "-s", &format!("{w}x{h}"), "-framerate", &format!("{}/{}", spec.fps_num, spec.fps_den)]);
    if !gray { a.extend(s(&["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"])); }
    a.extend(s(&["-i", "pipe:0"]));
    if let Some(wav) = &audio_tmp { a.extend(["-i".into(), wav.to_string_lossy().into_owned()]); }
    a.extend(s(&["-map", "0:v:0"]));
    if audio_tmp.is_some() { a.extend(s(&["-map", "1:a:0"])); }
    let encoder;
    if gray {
        a.extend(s(&["-c:v", "libx264", "-preset", "fast", "-crf", "10", "-pix_fmt", "yuv420p", "-g", "30"]));
        encoder = "libx264 (matte)".to_string();
    } else {
        let mut p = spec.preset.clone(); p.width = None; p.height = None;
        let (vargs, label) = export::video_codec_args(&p, export::caps())?;
        a.extend(vargs); encoder = label;
        if p.vcodec != "prores" { a.extend(s(&["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"])); }
        if audio_tmp.is_some() { a.extend(export::audio_codec_args(&p)); }
        if p.container == "mp4" || p.container == "mov" { a.extend(s(&["-movflags", "+faststart"])); }
    }
    a.extend(s(&["-t", &secs(duration_us)]));
    a.push(tmp.to_string_lossy().into_owned());

    let mut child = media::command(media::ffmpeg_path()?).args(&a).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Could not start FFmpeg: {e}"))?;
    let err = Arc::new(Mutex::new(String::new()));
    { let mut se = child.stderr.take().unwrap(); let eb = err.clone(); std::thread::spawn(move || { let mut s = String::new(); let _ = se.read_to_string(&mut s); *eb.lock().unwrap() = s; }); }
    let stdin = child.stdin.take();
    let frame_bytes = if gray { (w * h) as usize } else { (w * h * 3 / 2) as usize };
    let id = sessions.insert(Session { child, stdin, tmp, dir, name: spec.name.clone(), internal: spec.internal, frame_bytes, frames: spec.frames, written: 0, duration_us, err, audio_tmp });
    Ok((id, encoder))
}

pub fn push(sessions: &Sessions, id: u64, bytes: &[u8]) -> Result<i64, String> {
    let s = sessions.get(id)?;
    let mut s = s.lock().unwrap();
    if bytes.is_empty() || bytes.len() % s.frame_bytes != 0 { return Err(format!("Frame data has the wrong size ({} bytes, expected a multiple of {})", bytes.len(), s.frame_bytes)); }
    let n = (bytes.len() / s.frame_bytes) as i64;
    let Some(stdin) = s.stdin.as_mut() else { return Err("Encoder input is closed".into()) };
    if let Err(e) = stdin.write_all(bytes) {
        let msg = s.err.lock().unwrap().clone();
        return Err(if msg.trim().is_empty() { format!("The encoder stopped: {e}") } else { format!("The encoder stopped: {}", media::last_lines(&msg, 6)) });
    }
    s.written += n;
    Ok(s.written)
}

pub fn finish(sessions: &Sessions, id: u64) -> Result<String, String> {
    let arc = sessions.remove(id).ok_or("This export is no longer running.")?;
    let mut s = arc.lock().unwrap();
    drop(s.stdin.take());
    let status = s.child.wait().map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    if let Some(a) = s.audio_tmp.take() { let _ = std::fs::remove_file(a); }
    if !status.success() {
        let _ = std::fs::remove_file(&s.tmp);
        let e = s.err.lock().unwrap().clone();
        return Err(if e.trim().is_empty() { format!("FFmpeg exited with {status}") } else { media::last_lines(&e, 8) });
    }
    if s.written < s.frames { let _ = std::fs::remove_file(&s.tmp); return Err(format!("Export stopped early ({} of {} frames)", s.written, s.frames)); }
    if let Err(e) = export::validate_output(&s.tmp, s.duration_us) { let _ = std::fs::remove_file(&s.tmp); return Err(e); }
    let final_path = if s.internal { let p = s.dir.join(&s.name); let _ = std::fs::remove_file(&p); p } else { ops::unique_path(&s.dir, &s.name) };
    std::fs::rename(&s.tmp, &final_path).map_err(|e| e.to_string())?;
    Ok(final_path.to_string_lossy().into_owned())
}

pub fn cancel(sessions: &Sessions, id: u64) {
    if let Some(arc) = sessions.remove(id) {
        let mut s = arc.lock().unwrap();
        drop(s.stdin.take());
        let _ = s.child.kill(); let _ = s.child.wait();
        let _ = std::fs::remove_file(&s.tmp);
        if let Some(a) = s.audio_tmp.take() { let _ = std::fs::remove_file(a); }
    }
}

// ---------------------------------------------------------------- per-clip processing (voice, denoise, reverse, stabilize)

#[derive(Deserialize, serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct AudioFx { pub voice: String, pub denoise: bool, pub normalize: bool, pub enhance: bool }

pub const VOICES: &[(&str, &str)] = &[
    ("chipmunk", "Chipmunk"), ("helium", "Helium"), ("female", "Higher pitch"), ("male", "Lower pitch"), ("deep", "Deep"), ("monster", "Monster"),
    ("robot", "Robot"), ("echo", "Echo"), ("hall", "Big hall"), ("cave", "Cave"), ("megaphone", "Megaphone"), ("telephone", "Telephone"),
    ("radio", "Radio"), ("vinyl", "Vinyl"), ("lofi", "Lo-fi"), ("underwater", "Underwater"), ("alien", "Alien"), ("vibrato", "Vibrato"),
    ("tremolo", "Tremolo"), ("chorus", "Chorus"), ("flanger", "Flanger"), ("whisper", "Breathy"), ("distorted", "Distorted"), ("walkie", "Walkie-talkie"),
];

fn pitch(f: f64) -> Vec<String> { let mut v = vec![format!("asetrate={}", num(48000.0 * f)), "aresample=48000".into()]; v.extend(export::atempo_chain(1.0 / f)); v }

pub fn voice_filters(id: &str) -> Result<Vec<String>, String> {
    let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    Ok(match id {
        "" | "none" => vec![],
        "chipmunk" => pitch(1.6), "helium" => { let mut p = pitch(1.35); p.push("highpass=f=200".into()); p }
        "female" => pitch(1.22), "male" => pitch(0.84), "deep" => pitch(0.72),
        "monster" => { let mut p = pitch(0.6); p.extend(v(&["aecho=0.8:0.7:40:0.3", "acrusher=bits=10:mix=0.25:mode=log"])); p }
        "robot" => v(&["afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75", "aecho=0.8:0.6:8:0.4"]),
        "echo" => v(&["aecho=0.8:0.88:220:0.45"]),
        "hall" => v(&["aecho=0.8:0.85:60|120|190|280:0.35|0.28|0.2|0.12"]),
        "cave" => v(&["aecho=0.8:0.9:500|1000:0.35|0.2"]),
        "megaphone" => v(&["highpass=f=600", "lowpass=f=3200", "acrusher=bits=8:mix=0.35:mode=log", "volume=1.6", "alimiter=limit=0.9"]),
        "telephone" => v(&["highpass=f=300", "lowpass=f=3400", "acompressor=threshold=0.1:ratio=6"]),
        "radio" => v(&["highpass=f=180", "lowpass=f=5000", "acompressor=threshold=0.08:ratio=8:makeup=2"]),
        "vinyl" => v(&["lowpass=f=7000", "highpass=f=60", "aphaser=type=t:speed=0.3:decay=0.2"]),
        "lofi" => v(&["lowpass=f=3800", "acrusher=bits=12:samples=2:mix=0.6", "volume=1.2"]),
        "underwater" => v(&["lowpass=f=450", "chorus=0.6:0.9:55:0.4:0.25:2"]),
        "alien" => { let mut p = pitch(1.25); p.extend(v(&["flanger=delay=4:depth=6:speed=1.2", "vibrato=f=7:d=0.4"])); p }
        "vibrato" => v(&["vibrato=f=6:d=0.5"]),
        "tremolo" => v(&["tremolo=f=6:d=0.6"]),
        "chorus" => v(&["chorus=0.5:0.9:50|60|40:0.4|0.32|0.3:0.25|0.4|0.3:2|2.3|1.3"]),
        "flanger" => v(&["flanger=delay=2:depth=4:speed=0.4"]),
        "whisper" => v(&["highpass=f=900", "afftfilt=real='hypot(re,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8", "volume=2.0"]),
        "distorted" => v(&["acrusher=bits=6:mix=0.7:mode=log", "volume=0.8"]),
        "walkie" => v(&["highpass=f=400", "lowpass=f=2800", "acrusher=bits=9:mix=0.4", "acompressor=threshold=0.05:ratio=10"]),
        other => return Err(format!("Unknown voice effect '{other}'")),
    })
}

/// Args to process a whole source's audio into `out` (m4a). `rnn_dir` holds the RNNoise model `sh.rnnn`.
pub fn audiofx_args(src: &Path, fx: &AudioFx, has_rnn: bool, out: &Path) -> Result<Vec<String>, String> {
    let mut f = vec!["aformat=sample_rates=48000:channel_layouts=stereo".to_string()];
    if fx.denoise { if has_rnn { f.push("arnndn=m=sh.rnnn:mix=0.95".into()); } else { f.push("afftdn=nr=18:nf=-35".into()); } }
    if fx.enhance { f.extend(["highpass=f=80".to_string(), "equalizer=f=3500:t=q:w=1.2:g=3".into(), "equalizer=f=250:t=q:w=1:g=-2".into(), "acompressor=threshold=0.125:ratio=3:attack=10:release=150:makeup=1.5".into()]); }
    f.extend(voice_filters(&fx.voice)?);
    if fx.normalize { f.push("loudnorm=I=-16:TP=-1.5:LRA=11".into()); }
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut a = s(&["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error", "-i", &src.to_string_lossy(), "-map", "0:a:0", "-vn", "-af", &f.join(","), "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart"]);
    a.push(out.to_string_lossy().into_owned());
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn volume_expression_is_piecewise_linear() {
        assert_eq!(volume_expr(&[]), "1");
        assert_eq!(volume_expr(&[(0, 0.5)]), "0.500000");
        let e = volume_expr(&[(1_000_000, 0.0), (0, 1.0)]);
        assert!(e.starts_with("if(lt(t,0.000000),1.000000,if(lt(t,1.000000),1.000000+(-1.000000)*(t-0.000000)/1.000000,0.000000))"), "{e}");
    }
    #[test] fn mix_has_bed_and_numeric_filters_only() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("a b'c.wav"); std::fs::write(&src, b"x").unwrap();
        let plan = AudioPlan { duration_us: 5_000_000, segs: vec![AudioSeg { path: src.to_string_lossy().into(), src_in_us: 1_000_000, src_out_us: 3_000_000, start_us: 500_000, speed: 2.0, keep_pitch: true, volume: vec![(0, 1.0), (500_000, 0.2)], fade_in_us: 100_000, fade_out_us: 0 }] };
        let a = build_mix(&plan, &t.path().join("o.wav"));
        let fc = &a[a.iter().position(|x| x == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("atempo=2.0") || fc.contains("atempo=2.000000"), "{fc}");
        assert!(fc.contains("adelay=delays=500:all=1") && fc.contains("amix=inputs=2"), "{fc}");
        assert!(!fc.contains("a b'c"), "paths must never enter the filtergraph");
        assert!(a.iter().any(|x| x.ends_with("a b'c.wav")));
    }
    #[test] fn voices_build() {
        for (id, _) in VOICES { assert!(voice_filters(id).is_ok(), "{id}"); }
        assert!(voice_filters("x;rm").is_err());
        let a = audiofx_args(Path::new("in.mp4"), &AudioFx { voice: "robot".into(), denoise: true, normalize: true, enhance: false }, true, Path::new("o.m4a")).unwrap();
        let af = &a[a.iter().position(|x| x == "-af").unwrap() + 1];
        assert!(af.contains("arnndn=m=sh.rnnn") && af.contains("loudnorm"), "{af}");
    }
}
