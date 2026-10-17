//! Typed export specs → FFmpeg argument vectors. Nothing here is a shell string; user text never enters a
//! filtergraph (titles are written to files and referenced by relative name).
use crate::media::{self, Probe};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// ---------------------------------------------------------------- presets & capabilities

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct Preset {
    pub container: String, pub vcodec: String, pub crf: u32, pub bitrate_kbps: Option<u32>,
    pub width: Option<u32>, pub height: Option<u32>, pub fit: String, pub fps_num: Option<i64>, pub fps_den: Option<i64>,
    pub acodec: String, pub abitrate_kbps: u32, pub hw: String, pub strip_metadata: bool, pub speed: String,
}
impl Default for Preset {
    fn default() -> Self { Preset { container: "mp4".into(), vcodec: "h264".into(), crf: 20, bitrate_kbps: None, width: None, height: None, fit: "contain".into(),
        fps_num: None, fps_den: None, acodec: "aac".into(), abitrate_kbps: 192, hw: "auto".into(), strip_metadata: false, speed: "medium".into() } }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Caps { pub encoders: Vec<String>, pub hw_verified: Vec<String>, pub hwaccels: Vec<String>, pub version: String }
static CAPS: OnceLock<Caps> = OnceLock::new();

pub fn caps() -> &'static Caps {
    CAPS.get_or_init(|| {
        let Ok(ff) = media::ffmpeg_path() else { return Caps::default() };
        let run = |a: &[&str]| media::run_capture(ff, &a.iter().map(|s| s.to_string()).collect::<Vec<_>>()).map(|o| String::from_utf8_lossy(&o).into_owned()).unwrap_or_default();
        let version = run(&["-hide_banner", "-version"]).lines().next().unwrap_or("").to_string();
        let enc_txt = run(&["-hide_banner", "-encoders"]);
        let encoders: Vec<String> = enc_txt.lines().filter_map(|l| { let p: Vec<&str> = l.split_whitespace().collect(); (p.len() > 1 && p[0].len() == 6).then(|| p[1].to_string()) }).collect();
        let hwaccels = run(&["-hide_banner", "-hwaccels"]).lines().skip(1).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        // An encoder being compiled in doesn't mean the GPU/driver supports it: verify with a tiny encode.
        let mut hw_verified = vec![];
        for e in ["h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf"] {
            if !encoders.iter().any(|x| x == e) { continue; }
            let ok = media::run_capture(ff, &["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.2", "-c:v", e, "-f", "null", "-"].iter().map(|s| s.to_string()).collect::<Vec<_>>()).is_ok();
            if ok { hw_verified.push(e.to_string()); }
        }
        Caps { encoders, hw_verified, hwaccels, version }
    })
}

/// Choose the concrete encoder for a preset. Returns (codec args, human label).
pub fn video_codec_args(p: &Preset, caps: &Caps) -> Result<(Vec<String>, String), String> {
    let has = |e: &str| caps.encoders.iter().any(|x| x == e);
    let hw = |base: &str| -> Option<String> {
        let order: &[&str] = match p.hw.as_str() { "none" | "software" => &[], "nvenc" => &["nvenc"], "qsv" => &["qsv"], "amf" => &["amf"], _ => &["nvenc", "qsv", "amf"] };
        order.iter().map(|v| format!("{base}_{v}")).find(|e| caps.hw_verified.contains(e))
    };
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let rate = |args: &mut Vec<String>, crf_flag: &str| {
        if let Some(b) = p.bitrate_kbps { args.extend(s(&["-b:v", &format!("{b}k"), "-maxrate", &format!("{}k", b * 3 / 2), "-bufsize", &format!("{}k", b * 2)])); }
        else { args.extend([crf_flag.to_string(), p.crf.to_string()]); }
    };
    let (mut a, label) = match p.vcodec.as_str() {
        "copy" => return Ok((s(&["-c:v", "copy"]), "stream copy".into())),
        "h264" | "hevc" | "av1" => {
            let base = p.vcodec.as_str();
            if let Some(e) = hw(base) {
                let mut a = s(&["-c:v", &e]);
                if e.ends_with("nvenc") { a.extend(s(&["-preset", "p5", "-rc", "vbr"])); rate(&mut a, "-cq"); if p.bitrate_kbps.is_none() { a.extend(s(&["-b:v", "0"])); } }
                else if e.ends_with("qsv") { rate(&mut a, "-global_quality"); }
                else { a.extend(s(&["-rc", "cqp"])); a.extend(s(&["-qp_i", &p.crf.to_string(), "-qp_p", &p.crf.to_string()])); }
                (a, format!("{e} (GPU)"))
            } else {
                let sw = match base { "h264" => "libx264", "hevc" => "libx265", _ => "libsvtav1" };
                if !has(sw) { return Err(format!("This FFmpeg build has no {sw} encoder")); }
                let mut a = s(&["-c:v", sw]);
                let speed = if base == "av1" { match p.speed.as_str() { "fast" => "10", "slow" => "4", _ => "7" } } else { match p.speed.as_str() { "fast" => "veryfast", "slow" => "slow", _ => "medium" } };
                a.extend(s(&["-preset", speed])); rate(&mut a, "-crf");
                if base == "hevc" { a.extend(s(&["-tag:v", "hvc1"])); }
                (a, format!("{sw} (CPU)"))
            }
        }
        "vp9" => { let mut a = s(&["-c:v", "libvpx-vp9", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2"]); rate(&mut a, "-crf"); if p.bitrate_kbps.is_none() { a.extend(s(&["-b:v", "0"])); } (a, "libvpx-vp9 (CPU)".into()) }
        "prores" => (s(&["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0"]), "ProRes 422 HQ".into()),
        other => return Err(format!("Unknown video codec '{other}'")),
    };
    if p.vcodec != "prores" { a.extend(s(&["-pix_fmt", "yuv420p"])); } else { a.extend(s(&["-pix_fmt", "yuv422p10le"])); }
    Ok((a, label))
}

pub fn audio_codec_args(p: &Preset) -> Vec<String> {
    let b = format!("{}k", p.abitrate_kbps.clamp(32, 512));
    match p.acodec.as_str() {
        "none" => vec!["-an".into()],
        "copy" => vec!["-c:a".into(), "copy".into()],
        "opus" => vec!["-c:a".into(), "libopus".into(), "-b:a".into(), b],
        "mp3" => vec!["-c:a".into(), "libmp3lame".into(), "-b:a".into(), b],
        "pcm" => vec!["-c:a".into(), "pcm_s16le".into()],
        "flac" => vec!["-c:a".into(), "flac".into()],
        _ => vec!["-c:a".into(), "aac".into(), "-b:a".into(), b, "-ar".into(), "48000".into()],
    }
}

fn container_args(p: &Preset) -> Vec<String> {
    let mut a = vec![];
    if p.container == "mp4" || p.container == "mov" { a.extend(["-movflags".to_string(), "+faststart".to_string()]); }
    if p.strip_metadata { a.extend(["-map_metadata".to_string(), "-1".to_string(), "-map_chapters".to_string(), "-1".to_string()]); }
    a
}

/// Scale (+pad / crop) to target, preserving aspect unless fit == "stretch".
pub fn fit_filter(w: u32, h: u32, fit: &str, bg: &str) -> String {
    let (w, h) = (w & !1, h & !1);
    match fit {
        "cover" => format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"),
        "stretch" => format!("scale={w}:{h},setsar=1"),
        _ => format!("scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={bg},setsar=1"),
    }
}

/// atempo only accepts 0.5–2.0 (older builds) — chain factors.
pub fn atempo_chain(speed: f64) -> Vec<String> {
    let mut s = speed.clamp(0.0625, 16.0); let mut v = vec![];
    while s > 2.0 { v.push("atempo=2.0".to_string()); s /= 2.0; }
    while s < 0.5 { v.push("atempo=0.5".to_string()); s /= 0.5; }
    if (s - 1.0).abs() > 1e-6 { v.push(format!("atempo={s:.6}")); }
    v
}

fn secs(us: i64) -> String { format!("{:.6}", us as f64 / 1e6) }
fn even(v: i64) -> i64 { (v.max(2) / 2) * 2 }

// ---------------------------------------------------------------- quick (single clip) edits

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default)]
pub struct Rect { pub x: i64, pub y: i64, pub w: i64, pub h: i64 }

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct QuickEdit {
    pub in_us: Option<i64>, pub out_us: Option<i64>, pub crop: Option<Rect>, pub rotate: i32, pub flip_h: bool, pub flip_v: bool,
    pub delogo: Vec<Rect>, pub blur_regions: Vec<Rect>, pub speed: f64, pub volume: f64, pub mute: bool, pub fade_in_us: i64, pub fade_out_us: i64,
    pub brightness: f64, pub contrast: f64, pub saturation: f64, pub normalize_audio: bool, pub lossless_cut: bool,
}
impl Default for QuickEdit {
    fn default() -> Self { QuickEdit { in_us: None, out_us: None, crop: None, rotate: 0, flip_h: false, flip_v: false, delogo: vec![], blur_regions: vec![], speed: 1.0, volume: 1.0,
        mute: false, fade_in_us: 0, fade_out_us: 0, brightness: 0.0, contrast: 1.0, saturation: 1.0, normalize_audio: false, lossless_cut: false } }
}

/// Clamp a rectangle so delogo accepts it (needs ≥1px margin inside the frame).
pub fn clamp_rect(r: Rect, w: i64, h: i64, margin: i64) -> Option<Rect> {
    let x = r.x.clamp(margin, (w - margin - 2).max(margin)); let y = r.y.clamp(margin, (h - margin - 2).max(margin));
    let rw = r.w.min(w - margin - x).max(0); let rh = r.h.min(h - margin - y).max(0);
    (rw >= 2 && rh >= 2).then_some(Rect { x, y, w: rw, h: rh })
}

pub struct Built { pub args: Vec<String>, pub duration_us: i64, pub notes: Vec<String> }

pub fn build_quick(src: &Path, probe: &Probe, e: &QuickEdit, p: &Preset, caps: &Caps, out: &Path) -> Result<Built, String> {
    let dur_total = probe.duration_ms.unwrap_or(0) * 1000;
    let a_in = e.in_us.unwrap_or(0).clamp(0, dur_total.max(0));
    let a_out = e.out_us.unwrap_or(dur_total).clamp(a_in, dur_total.max(a_in));
    let src_dur = (a_out - a_in).max(0);
    if src_dur <= 0 { return Err("The selected range is empty".into()); }
    let speed = if e.speed > 0.0 { e.speed.clamp(0.0625, 16.0) } else { 1.0 };
    let out_dur = (src_dur as f64 / speed) as i64;
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut args = s(&["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error"]);
    let mut notes = vec![];
    let has_video = probe.width.is_some();
    let ss = secs(a_in);
    if e.lossless_cut {
        args.extend(s(&["-ss", &ss, "-i", &src.to_string_lossy(), "-t", &secs(src_dur), "-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero"]));
        args.extend(container_args(p));
        args.push(out.to_string_lossy().into_owned());
        notes.push("Lossless cut: no re-encoding, so the cut snaps to the nearest keyframe.".into());
        return Ok(Built { args, duration_us: src_dur, notes });
    }
    args.extend(s(&["-ss", &ss, "-t", &secs(src_dur), "-i", &src.to_string_lossy()]));
    let vf = if has_video { quick_vf(probe, e, p, speed, out_dur) } else { vec![] };
    let mut af: Vec<String> = vec![];
    let audio = probe.has_audio && !e.mute && p.acodec != "none";
    if audio {
        af.extend(atempo_chain(speed));
        if (e.volume - 1.0).abs() > 1e-6 { af.push(format!("volume={:.3}", e.volume.clamp(0.0, 8.0))); }
        if e.normalize_audio { af.push("loudnorm=I=-16:TP=-1.5:LRA=11".into()); }
        if e.fade_in_us > 0 { af.push(format!("afade=t=in:st=0:d={}", secs(e.fade_in_us))); }
        if e.fade_out_us > 0 { af.push(format!("afade=t=out:st={}:d={}", secs((out_dur - e.fade_out_us).max(0)), secs(e.fade_out_us))); }
    } else if probe.has_audio { notes.push("Audio removed (muted).".into()); }
    finish_quick(args, vf, af, audio, has_video, p, caps, out, notes, out_dur)
}

/// The video filter chain for a quick edit (shared by export and the single-frame preview).
pub fn quick_vf(probe: &Probe, e: &QuickEdit, p: &Preset, speed: f64, out_dur: i64) -> Vec<String> {
    let mut vf: Vec<String> = vec![];
    {
        let (sw, sh) = (probe.width.unwrap_or(0), probe.height.unwrap_or(0));
        for r in &e.delogo { if let Some(r) = clamp_rect(*r, sw, sh, 1) { vf.push(format!("delogo=x={}:y={}:w={}:h={}", r.x, r.y, r.w, r.h)); } }
        for r in &e.blur_regions { if let Some(r) = clamp_rect(*r, sw, sh, 0) {
            vf.push(format!("split[m{0}][b{0}];[b{0}]crop={1}:{2}:{3}:{4},boxblur=10:2[bb{0}];[m{0}][bb{0}]overlay={3}:{4}", vf.len(), r.w, r.h, r.x, r.y)); } }
        if let Some(c) = e.crop { if let Some(c) = clamp_rect(c, sw, sh, 0) { vf.push(format!("crop={}:{}:{}:{}", even(c.w), even(c.h), c.x, c.y)); } }
        if e.brightness != 0.0 || e.contrast != 1.0 || e.saturation != 1.0 { vf.push(format!("eq=brightness={:.3}:contrast={:.3}:saturation={:.3}", e.brightness.clamp(-1.0, 1.0), e.contrast.clamp(0.0, 3.0), e.saturation.clamp(0.0, 3.0))); }
        match e.rotate.rem_euclid(360) { 90 => vf.push("transpose=1".into()), 180 => vf.push("transpose=1,transpose=1".into()), 270 => vf.push("transpose=2".into()), _ => {} }
        if e.flip_h { vf.push("hflip".into()); }
        if e.flip_v { vf.push("vflip".into()); }
        if (speed - 1.0).abs() > 1e-6 { vf.push(format!("setpts=PTS/{speed:.6}")); }
        if let (Some(w), Some(h)) = (p.width, p.height) { vf.push(fit_filter(w, h, &p.fit, "black")); }
        if let (Some(n), Some(d)) = (p.fps_num, p.fps_den) { vf.push(format!("fps={n}/{d}")); }
        if e.fade_in_us > 0 { vf.push(format!("fade=t=in:st=0:d={}", secs(e.fade_in_us))); }
        if e.fade_out_us > 0 { vf.push(format!("fade=t=out:st={}:d={}", secs((out_dur - e.fade_out_us).max(0)), secs(e.fade_out_us))); }
        vf.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".into());
    }
    vf
}

/// One frame at `t_us` rendered through the same filters as the export (no fades/speed) → PNG.
pub fn build_quick_preview(src: &Path, probe: &Probe, e: &QuickEdit, t_us: i64, out: &Path) -> Vec<String> {
    let e2 = QuickEdit { fade_in_us: 0, fade_out_us: 0, speed: 1.0, ..e.clone() };
    let vf = quick_vf(probe, &e2, &Preset::default(), 1.0, 0);
    ["-hide_banner", "-loglevel", "error", "-y", "-ss", &secs(t_us.max(0)), "-i", &src.to_string_lossy(), "-filter_complex", &format!("[0:v:0]{}[v]", vf.join(",")), "-map", "[v]", "-frames:v", "1", &out.to_string_lossy()]
        .iter().map(|s| s.to_string()).collect()
}

#[allow(clippy::too_many_arguments)]
fn finish_quick(mut args: Vec<String>, vf: Vec<String>, af: Vec<String>, audio: bool, has_video: bool, p: &Preset, caps: &Caps, out: &Path, mut notes: Vec<String>, out_dur: i64) -> Result<Built, String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    if has_video {
        args.extend(s(&["-filter_complex", &format!("[0:v:0]{}[v]", vf.join(",")), "-map", "[v]"]));
        let (va, label) = video_codec_args(p, caps)?; args.extend(va); notes.push(format!("Video: {label}"));
    }
    if audio {
        if af.is_empty() { args.extend(s(&["-map", "0:a:0"])); } else { args.extend(s(&["-filter_complex", &format!("[0:a:0]{}[a]", af.join(",")), "-map", "[a]"])); }
        args.extend(audio_codec_args(p));
    } else { args.push("-an".into()); }
    if p.container != "mp4" || !has_video { } else { args.extend(s(&["-map", "0:s?", "-c:s", "mov_text"])); }
    args.extend(container_args(p));
    args.push(out.to_string_lossy().into_owned());
    // multiple -filter_complex are not allowed: merge them
    Ok(Built { args: merge_filter_complex(args), duration_us: out_dur, notes })
}

/// FFmpeg accepts a single -filter_complex. Merge repeated ones with ';'.
pub fn merge_filter_complex(args: Vec<String>) -> Vec<String> {
    let mut graphs = vec![]; let mut out = vec![]; let mut it = args.into_iter(); let mut insert_at = None;
    while let Some(a) = it.next() {
        if a == "-filter_complex" { if let Some(g) = it.next() { if insert_at.is_none() { insert_at = Some(out.len()); } graphs.push(g); } }
        else { out.push(a); }
    }
    if let Some(i) = insert_at { out.insert(i, graphs.join(";")); out.insert(i, "-filter_complex".into()); }
    out
}

// ---------------------------------------------------------------- join

pub struct JoinInput { pub path: PathBuf, pub probe: Probe }

/// Can these be concatenated without re-encoding?
pub fn concat_compatible(v: &[JoinInput]) -> Result<(), String> {
    let f = &v[0].probe;
    for i in v.iter().skip(1) {
        let p = &i.probe;
        if p.vcodec != f.vcodec { return Err(format!("different video codecs ({:?} vs {:?})", f.vcodec, p.vcodec)); }
        if (p.width, p.height) != (f.width, f.height) { return Err(format!("different resolutions ({}x{} vs {}x{})", f.width.unwrap_or(0), f.height.unwrap_or(0), p.width.unwrap_or(0), p.height.unwrap_or(0))); }
        if (p.fps_num, p.fps_den) != (f.fps_num, f.fps_den) { return Err("different frame rates".into()); }
        if p.has_audio != f.has_audio || p.acodec != f.acodec { return Err("different audio layouts/codecs".into()); }
        if p.pix_fmt != f.pix_fmt { return Err("different pixel formats".into()); }
    }
    Ok(())
}

pub fn concat_list_line(p: &Path) -> String { format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''")) }

pub fn build_join(inputs: &[JoinInput], mode: &str, p: &Preset, caps: &Caps, work: &Path, out: &Path) -> Result<Built, String> {
    if inputs.len() < 2 { return Err("Select at least two clips to join".into()); }
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let total: i64 = inputs.iter().map(|i| i.probe.duration_ms.unwrap_or(0) * 1000).sum();
    let mut args = s(&["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error"]);
    let compat = concat_compatible(inputs);
    let mut notes = vec![];
    if mode != "reencode" && compat.is_ok() {
        let list = work.join("concat.txt");
        std::fs::write(&list, inputs.iter().map(|i| concat_list_line(&i.path)).collect::<String>()).map_err(|e| e.to_string())?;
        args.extend(s(&["-f", "concat", "-safe", "0", "-i", &list.to_string_lossy(), "-map", "0", "-c", "copy"]));
        args.extend(container_args(p)); args.push(out.to_string_lossy().into_owned());
        notes.push("All clips match — joined without re-encoding (fast, lossless).".into());
        return Ok(Built { args, duration_us: total, notes });
    }
    if mode == "copy" { return Err(format!("Can't join without re-encoding: {}", compat.unwrap_err())); }
    if let Err(why) = compat { notes.push(format!("Re-encoding because the clips have {why}.")); }
    let first = &inputs[0].probe;
    let w = p.width.map(|v| v as i64).or(first.width).unwrap_or(1920);
    let h = p.height.map(|v| v as i64).or(first.height).unwrap_or(1080);
    let (fn_, fd) = (p.fps_num.or(first.fps_num).unwrap_or(30), p.fps_den.or(first.fps_den).unwrap_or(1));
    let mut graph = vec![]; let mut pairs = String::new();
    for (i, inp) in inputs.iter().enumerate() {
        args.extend(s(&["-i", &inp.path.to_string_lossy()]));
        graph.push(format!("[{i}:v:0]{},fps={fn_}/{fd},format=yuv420p[v{i}]", fit_filter(w as u32, h as u32, "contain", "black")));
        if inp.probe.has_audio { graph.push(format!("[{i}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]")); }
        else { graph.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={}[a{i}]", secs(inp.probe.duration_ms.unwrap_or(0) * 1000))); notes.push(format!("{} has no audio — silence inserted.", inp.path.file_name().unwrap_or_default().to_string_lossy())); }
        pairs.push_str(&format!("[v{i}][a{i}]"));
    }
    graph.push(format!("{pairs}concat=n={}:v=1:a=1[v][a]", inputs.len()));
    args.extend(s(&["-filter_complex", &graph.join(";"), "-map", "[v]", "-map", "[a]"]));
    let (va, label) = video_codec_args(p, caps)?; args.extend(va); notes.push(format!("Video: {label}"));
    args.extend(audio_codec_args(&Preset { acodec: if p.acodec == "copy" || p.acodec == "none" { "aac".into() } else { p.acodec.clone() }, ..p.clone() }));
    args.extend(container_args(p)); args.push(out.to_string_lossy().into_owned());
    Ok(Built { args, duration_us: total, notes })
}

// ---------------------------------------------------------------- audio

pub fn build_extract_audio(src: &Path, probe: &Probe, format: &str, e: &QuickEdit, out: &Path) -> Result<Built, String> {
    if !probe.has_audio { return Err("This file has no audio stream".into()); }
    let dur = probe.duration_ms.unwrap_or(0) * 1000;
    let a_in = e.in_us.unwrap_or(0).clamp(0, dur); let a_out = e.out_us.unwrap_or(dur).clamp(a_in, dur);
    let len = a_out - a_in;
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut args = s(&["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error", "-ss", &secs(a_in), "-t", &secs(len), "-i", &src.to_string_lossy(), "-vn", "-map", "0:a:0"]);
    let mut af = vec![];
    if (e.volume - 1.0).abs() > 1e-6 { af.push(format!("volume={:.3}", e.volume.clamp(0.0, 8.0))); }
    if e.normalize_audio { af.push("loudnorm=I=-16:TP=-1.5:LRA=11".into()); }
    if e.fade_in_us > 0 { af.push(format!("afade=t=in:st=0:d={}", secs(e.fade_in_us))); }
    if e.fade_out_us > 0 { af.push(format!("afade=t=out:st={}:d={}", secs((len - e.fade_out_us).max(0)), secs(e.fade_out_us))); }
    if !af.is_empty() { args.extend(s(&["-af", &af.join(",")])); }
    let codec = match format { "wav" => "pcm", "mp3" => "mp3", "flac" => "flac", "opus" => "opus", _ => "aac" };
    args.extend(audio_codec_args(&Preset { acodec: codec.into(), abitrate_kbps: 256, ..Default::default() }));
    args.push(out.to_string_lossy().into_owned());
    Ok(Built { args, duration_us: len, notes: vec![] })
}

pub fn build_proxy(src: &Path, probe: &Probe, out: &Path) -> Built {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut args = s(&["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error", "-i", &src.to_string_lossy(), "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale='min(1280,iw)':-2,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "15", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]);
    args.push(out.to_string_lossy().into_owned());
    Built { args, duration_us: probe.duration_ms.unwrap_or(0) * 1000, notes: vec![] }
}

// ---------------------------------------------------------------- timeline render

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct Transform { pub x: f64, pub y: f64, pub scale: f64, pub opacity: f64, pub rotation: f64 }
impl Default for Transform { fn default() -> Self { Transform { x: 0.0, y: 0.0, scale: 1.0, opacity: 1.0, rotation: 0.0 } } }

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct TextSpec { pub content: String, pub size: f64, pub color: String, pub x: f64, pub y: f64, pub box_color: Option<String>, pub bold: bool }

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct Adjust { pub brightness: f64, pub contrast: f64, pub saturation: f64, pub temperature: f64 }
impl Default for Adjust { fn default() -> Self { Adjust { brightness: 0.0, contrast: 1.0, saturation: 1.0, temperature: 6500.0 } } }

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct Clip {
    pub id: String, pub kind: String, pub asset_id: Option<i64>, pub path: Option<String>,
    pub start_us: i64, pub in_us: i64, pub out_us: i64, pub speed: f64, pub volume: f64,
    pub fade_in_us: i64, pub fade_out_us: i64, pub transition: String, pub transition_us: i64,
    pub fit: String, pub transform: Transform, pub adjust: Adjust, pub text: Option<TextSpec>, pub color: Option<String>, pub crop: Option<Rect>,
}
impl Default for Clip {
    fn default() -> Self { Clip { id: String::new(), kind: "video".into(), asset_id: None, path: None, start_us: 0, in_us: 0, out_us: 0, speed: 1.0, volume: 1.0,
        fade_in_us: 0, fade_out_us: 0, transition: "none".into(), transition_us: 0, fit: "contain".into(), transform: Transform::default(), adjust: Adjust::default(), text: None, color: None, crop: None } }
}
impl Clip {
    pub fn timeline_len(&self) -> i64 { ((self.out_us - self.in_us).max(0) as f64 / if self.speed > 0.0 { self.speed } else { 1.0 }).round() as i64 }
    pub fn end_us(&self) -> i64 { self.start_us + self.timeline_len() }
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Track { pub id: String, pub kind: String, pub name: String, pub muted: bool, pub hidden: bool, pub locked: bool, pub volume: f64, pub clips: Vec<Clip> }

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct Project { pub version: u32, pub name: String, pub width: u32, pub height: u32, pub fps_num: i64, pub fps_den: i64, pub background: String, pub tracks: Vec<Track> }
impl Default for Project { fn default() -> Self { Project { version: 1, name: "Untitled".into(), width: 1920, height: 1080, fps_num: 30, fps_den: 1, background: "#000000".into(), tracks: vec![] } } }
impl Project {
    pub fn duration_us(&self) -> i64 { self.tracks.iter().flat_map(|t| t.clips.iter()).map(|c| c.end_us()).max().unwrap_or(0) }
}

fn hex_color(s: &str) -> String {
    let v = s.trim_start_matches('#');
    if v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit()) { format!("0x{v}") } else { "0x000000".into() }
}

/// Build the render graph. Tracks are composited bottom (index 0) → top. `paths(asset_id)` resolves media.
/// `range` limits output to [start,end) on the timeline. Text files and fonts are written into `work`.
pub fn build_render(proj: &Project, resolve: &dyn Fn(&Clip) -> Option<(PathBuf, Probe)>, p: &Preset, caps: &Caps, range: Option<(i64, i64)>, work: &Path, out: &Path) -> Result<Built, String> {
    let total = proj.duration_us();
    if total <= 0 { return Err("The timeline is empty".into()); }
    let (r0, r1) = range.map(|(a, b)| (a.clamp(0, total), b.clamp(0, total))).unwrap_or((0, total));
    if r1 <= r0 { return Err("The export range is empty".into()); }
    let (w, h) = (p.width.unwrap_or(proj.width).max(16) & !1, p.height.unwrap_or(proj.height).max(16) & !1);
    let (fnum, fden) = (p.fps_num.unwrap_or(proj.fps_num).max(1), p.fps_den.unwrap_or(proj.fps_den).max(1));
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut args = s(&["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error"]);
    let mut g: Vec<String> = vec![];
    let mut notes = vec![];
    g.push(format!("color=c={}:s={w}x{h}:r={fnum}/{fden}:d={}[base0]", hex_color(&proj.background), secs(total)));
    let mut base = "base0".to_string();
    let mut audio_labels: Vec<String> = vec![];
    let mut input_idx = 0usize;
    let mut text_n = 0;
    let font_needed = proj.tracks.iter().any(|t| t.clips.iter().any(|c| c.kind == "text"));
    if font_needed {
        let font_src = ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"].iter().map(PathBuf::from).find(|p| p.is_file()).ok_or("No system font found for titles")?;
        std::fs::copy(&font_src, work.join("font.ttf")).map_err(|e| e.to_string())?;
    }
    for (ti, t) in proj.tracks.iter().enumerate() {
        for (ci, c) in t.clips.iter().enumerate() {
            let len = c.timeline_len();
            if len <= 0 { continue; }
            let lbl = format!("t{ti}c{ci}");
            // transitions overlap the previous clip on the same track
            let tr = if c.transition != "none" { c.transition_us.clamp(0, len) } else { 0 };
            let st = (c.start_us - if c.transition == "dissolve" { tr } else { 0 }).max(0);
            let src_in = (c.in_us - if c.transition == "dissolve" { (tr as f64 * c.speed) as i64 } else { 0 }).max(0);
            let shown_len = c.end_us() - st;
            let speed = if c.speed > 0.0 { c.speed } else { 1.0 };
            let src_len = ((shown_len as f64) * speed) as i64;
            let visual = t.kind != "audio" && !t.hidden && c.kind != "audio";
            match c.kind.as_str() {
                "video" | "image" | "audio" => {
                    let Some((path, probe)) = resolve(c) else { return Err(format!("Missing media for clip '{}' — relink it before exporting", c.id)); };
                    if c.kind == "image" { args.extend(s(&["-loop", "1", "-framerate", &format!("{fnum}/{fden}"), "-t", &secs(shown_len), "-i", &path.to_string_lossy()])); }
                    else { args.extend(s(&["-ss", &secs(src_in), "-t", &secs(src_len), "-i", &path.to_string_lossy()])); }
                    let ii = input_idx; input_idx += 1;
                    if visual && probe.width.is_some() {
                        let mut f = vec![format!("[{ii}:v:0]setpts=PTS-STARTPTS")];
                        if c.kind == "video" && (speed - 1.0).abs() > 1e-6 { f.push(format!("setpts=PTS/{speed:.6}")); }
                        if let Some(cr) = c.crop { f.push(format!("crop={}:{}:{}:{}", even(cr.w), even(cr.h), cr.x.max(0), cr.y.max(0))); }
                        let a = &c.adjust;
                        if a.brightness != 0.0 || a.contrast != 1.0 || a.saturation != 1.0 { f.push(format!("eq=brightness={:.3}:contrast={:.3}:saturation={:.3}", a.brightness, a.contrast, a.saturation)); }
                        if (a.temperature - 6500.0).abs() > 1.0 { f.push(format!("colortemperature=temperature={:.0}", a.temperature.clamp(1000.0, 40000.0))); }
                        let sc = c.transform.scale.clamp(0.01, 10.0);
                        let (tw, th) = (even((w as f64 * sc) as i64) as u32, even((h as f64 * sc) as i64) as u32);
                        f.push(match c.fit.as_str() {
                            "cover" => format!("scale={tw}:{th}:force_original_aspect_ratio=increase,crop={tw}:{th}"),
                            "fill" => format!("scale={tw}:{th}"),
                            _ => format!("scale={tw}:{th}:force_original_aspect_ratio=decrease"),
                        });
                        f.push(format!("fps={fnum}/{fden},format=yuva420p"));
                        if c.transform.opacity < 1.0 { f.push(format!("colorchannelmixer=aa={:.3}", c.transform.opacity.clamp(0.0, 1.0))); }
                        let fade_in = if c.transition == "dissolve" || c.transition == "fade" { tr.max(c.fade_in_us) } else { c.fade_in_us };
                        if fade_in > 0 { f.push(format!("fade=t=in:st=0:d={}:alpha=1", secs(fade_in))); }
                        if c.fade_out_us > 0 { f.push(format!("fade=t=out:st={}:d={}:alpha=1", secs((shown_len - c.fade_out_us).max(0)), secs(c.fade_out_us))); }
                        if c.transform.rotation.abs() > 0.01 { f.push(format!("rotate={:.6}:c=none:ow=rotw({:.6}):oh=roth({:.6})", c.transform.rotation.to_radians(), c.transform.rotation.to_radians(), c.transform.rotation.to_radians())); }
                        f.push(format!("setpts=PTS+{}/TB[{lbl}v]", secs(st)));
                        g.push(f.join(","));
                        let nb = format!("b{lbl}");
                        let (ox, oy) = (c.transform.x, c.transform.y);
                        g.push(format!("[{base}][{lbl}v]overlay=x=(W-w)/2+{:.1}:y=(H-h)/2+{:.1}:eof_action=pass:enable='between(t,{},{})'[{nb}]", ox * w as f64, oy * h as f64, secs(st), secs(c.end_us())));
                        base = nb;
                    }
                    let audible = !t.muted && probe.has_audio && c.kind != "image" && c.volume > 0.0;
                    if audible {
                        let mut f = vec![format!("[{ii}:a:0]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo")];
                        f.extend(atempo_chain(speed));
                        let vol = c.volume * if t.volume > 0.0 { t.volume } else { 1.0 };
                        if (vol - 1.0).abs() > 1e-6 { f.push(format!("volume={vol:.3}")); }
                        let fi = if c.transition == "dissolve" { tr.max(c.fade_in_us) } else { c.fade_in_us };
                        if fi > 0 { f.push(format!("afade=t=in:st=0:d={}", secs(fi))); }
                        if c.fade_out_us > 0 { f.push(format!("afade=t=out:st={}:d={}", secs((shown_len - c.fade_out_us).max(0)), secs(c.fade_out_us))); }
                        let ms = st / 1000;
                        f.push(format!("adelay={ms}|{ms}[{lbl}a]"));
                        g.push(f.join(","));
                        audio_labels.push(format!("[{lbl}a]"));
                    }
                }
                "text" | "color" if visual => {
                    let sl = format!("{lbl}src");
                    if c.kind == "color" {
                        g.push(format!("color=c={}:s={w}x{h}:r={fnum}/{fden}:d={},format=yuva420p[{sl}]", hex_color(c.color.as_deref().unwrap_or("#000000")), secs(shown_len)));
                    } else {
                        let tx = c.text.clone().unwrap_or_default();
                        let fname = format!("title{text_n}.txt"); text_n += 1;
                        std::fs::write(work.join(&fname), tx.content.as_bytes()).map_err(|e| e.to_string())?;
                        let size = (tx.size.max(6.0) * h as f64 / 1080.0).round() as i64;
                        let bx = tx.box_color.as_deref().map(|b| format!(":box=1:boxcolor={}@0.6:boxborderw={}", hex_color(b), size / 3)).unwrap_or_default();
                        g.push(format!("color=c=black@0:s={w}x{h}:r={fnum}/{fden}:d={},format=yuva420p,drawtext=fontfile=font.ttf:textfile={fname}:fontsize={size}:fontcolor={}:x=(w-text_w)*{:.4}:y=(h-text_h)*{:.4}:line_spacing={}{bx}[{sl}]",
                            secs(shown_len), hex_color(if tx.color.is_empty() { "#ffffff" } else { &tx.color }), tx.x.clamp(0.0, 1.0), tx.y.clamp(0.0, 1.0), size / 5));
                    }
                    let mut f = vec![format!("[{sl}]setpts=PTS-STARTPTS")];
                    if c.transform.opacity < 1.0 { f.push(format!("colorchannelmixer=aa={:.3}", c.transform.opacity.clamp(0.0, 1.0))); }
                    let fi = if c.transition != "none" { tr.max(c.fade_in_us) } else { c.fade_in_us };
                    if fi > 0 { f.push(format!("fade=t=in:st=0:d={}:alpha=1", secs(fi))); }
                    if c.fade_out_us > 0 { f.push(format!("fade=t=out:st={}:d={}:alpha=1", secs((shown_len - c.fade_out_us).max(0)), secs(c.fade_out_us))); }
                    f.push(format!("setpts=PTS+{}/TB[{lbl}v]", secs(st)));
                    g.push(f.join(","));
                    let nb = format!("b{lbl}");
                    g.push(format!("[{base}][{lbl}v]overlay=x=0:y=0:eof_action=pass:enable='between(t,{},{})'[{nb}]", secs(st), secs(c.end_us())));
                    base = nb;
                }
                _ => {}
            }
        }
    }
    let rs = secs(r0); let re = secs(r1);
    g.push(format!("[{base}]trim=start={rs}:end={re},setpts=PTS-STARTPTS,format=yuv420p[vout]"));
    let audio_out = p.acodec != "none";
    if audio_out {
        if audio_labels.is_empty() { g.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={}[aout]", secs(r1 - r0))); notes.push("Timeline has no audio — exporting silence.".into()); }
        else { g.push(format!("{}amix=inputs={}:normalize=0:dropout_transition=0,apad,atrim=start={rs}:end={re},asetpts=PTS-STARTPTS[aout]", audio_labels.join(""), audio_labels.len())); }
    }
    args.extend(s(&["-filter_complex", &g.join(";"), "-map", "[vout]"]));
    if audio_out { args.extend(s(&["-map", "[aout]"])); }
    let (va, label) = video_codec_args(p, caps)?; args.extend(va); notes.push(format!("Video: {label}"));
    args.extend(s(&["-r", &format!("{fnum}/{fden}")]));
    if audio_out { args.extend(audio_codec_args(&Preset { acodec: if p.acodec == "copy" { "aac".into() } else { p.acodec.clone() }, ..p.clone() })); }
    args.extend(container_args(p));
    args.extend(s(&["-t", &secs(r1 - r0)]));
    args.push(out.to_string_lossy().into_owned());
    Ok(Built { args, duration_us: r1 - r0, notes })
}

// ---------------------------------------------------------------- running

/// Run FFmpeg with progress (from `-progress pipe:1`) and cancellation. `cwd` lets filters use relative names.
pub fn run_ffmpeg(args: &[String], duration_us: i64, cwd: Option<&Path>, cancel: &Arc<AtomicBool>, on_progress: &mut dyn FnMut(f64)) -> Result<(), String> {
    let mut cmd = media::command(media::ffmpeg_path()?);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd { cmd.current_dir(d); }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start FFmpeg: {e}"))?;
    let err_buf = Arc::new(Mutex::new(String::new()));
    let eb = err_buf.clone();
    let mut stderr = child.stderr.take().unwrap();
    let et = std::thread::spawn(move || { let mut s = String::new(); let _ = stderr.read_to_string(&mut s); *eb.lock().unwrap() = s; });
    let stdout = child.stdout.take().unwrap();
    let child = Arc::new(Mutex::new(child));
    let watcher = { let c = child.clone(); let cancel = cancel.clone(); std::thread::spawn(move || loop {
        if cancel.load(Ordering::Relaxed) { let _ = c.lock().unwrap().kill(); return; }
        if let Ok(Some(_)) = c.lock().unwrap().try_wait() { return; }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }) };
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
            if let Ok(us) = v.trim().parse::<i64>() { if duration_us > 0 { on_progress((us as f64 / duration_us as f64).clamp(0.0, 0.999)); } }
        }
    }
    let status = loop { if let Ok(Some(s)) = child.lock().unwrap().try_wait() { break s; } std::thread::sleep(std::time::Duration::from_millis(50)); };
    let _ = watcher.join(); let _ = et.join();
    if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
    if !status.success() { let e = err_buf.lock().unwrap().clone(); return Err(if e.trim().is_empty() { format!("FFmpeg exited with {status}") } else { media::last_lines(&e, 8) }); }
    Ok(())
}

/// Confirm an output is real media with a plausible duration before reporting success.
pub fn validate_output(path: &Path, expect_us: i64) -> Result<Probe, String> {
    let md = std::fs::metadata(path).map_err(|_| "Output file was not created".to_string())?;
    if md.len() == 0 { return Err("Output file is empty".into()); }
    let p = media::ffprobe_json(path).map(|j| media::parse_probe(&j)).map_err(|e| format!("Output failed validation: {e}"))?;
    if let Some(d) = p.duration_ms { if expect_us > 2_000_000 && (d * 1000) < expect_us / 4 { return Err(format!("Output is much shorter than expected ({} ms)", d)); } }
    Ok(p)
}

pub fn used_inputs(args: &[String]) -> HashSet<String> { args.windows(2).filter(|w| w[0] == "-i").map(|w| w[1].clone()).collect() }

#[cfg(test)]
mod tests {
    use super::*;
    fn caps_sw() -> Caps { Caps { encoders: vec!["libx264".into(), "libx265".into(), "aac".into()], ..Default::default() } }
    fn probe(w: i64, h: i64, ms: i64, audio: bool) -> Probe { Probe { width: Some(w), height: Some(h), duration_ms: Some(ms), fps_num: Some(30), fps_den: Some(1), vcodec: Some("h264".into()), acodec: audio.then(|| "aac".into()), has_audio: audio, pix_fmt: Some("yuv420p".into()), ..Default::default() } }
    #[test] fn atempo() {
        let product = |v: Vec<String>| v.iter().map(|s| s.trim_start_matches("atempo=").parse::<f64>().unwrap()).product::<f64>();
        for sp in [4.0, 0.25, 3.0, 0.3, 1.5, 16.0] {
            let v = atempo_chain(sp);
            assert!(v.iter().all(|s| { let f: f64 = s[7..].parse().unwrap(); (0.5..=2.0).contains(&f) }), "{v:?}");
            assert!((product(v) - sp).abs() < 1e-4, "{sp}");
        }
        assert!(atempo_chain(1.0).is_empty());
    }
    #[test] fn delogo_clamped_inside_frame() {
        assert_eq!(clamp_rect(Rect { x: 0, y: 0, w: 50, h: 50 }, 100, 100, 1).map(|r| (r.x, r.y)), Some((1, 1)));
        let r = clamp_rect(Rect { x: 90, y: 90, w: 50, h: 50 }, 100, 100, 1).unwrap(); assert!(r.x + r.w <= 99 && r.y + r.h <= 99);
        assert!(clamp_rect(Rect { x: 0, y: 0, w: 1, h: 1 }, 100, 100, 1).is_none());
    }
    #[test] fn hw_fallback_to_software() {
        let (a, l) = video_codec_args(&Preset::default(), &caps_sw()).unwrap();
        assert!(a.contains(&"libx264".to_string()) && l.contains("CPU"));
        let mut c = caps_sw(); c.hw_verified = vec!["h264_nvenc".into()];
        assert!(video_codec_args(&Preset::default(), &c).unwrap().0.contains(&"h264_nvenc".to_string()));
        assert!(video_codec_args(&Preset { hw: "none".into(), ..Default::default() }, &c).unwrap().0.contains(&"libx264".to_string()));
    }
    #[test] fn quick_edit_args() {
        let e = QuickEdit { in_us: Some(1_000_000), out_us: Some(3_000_000), delogo: vec![Rect { x: 10, y: 10, w: 40, h: 20 }], speed: 2.0, fade_out_us: 500_000, ..Default::default() };
        let b = build_quick(Path::new("C:/in it's.mp4"), &probe(640, 360, 5000, true), &e, &Preset::default(), &caps_sw(), Path::new("C:/o.mp4")).unwrap();
        assert_eq!(b.duration_us, 1_000_000);
        let fc: Vec<_> = b.args.iter().filter(|a| *a == "-filter_complex").collect(); assert_eq!(fc.len(), 1);
        let g = &b.args[b.args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(g.contains("delogo=x=10:y=10:w=40:h=20") && g.contains("setpts=PTS/2") && g.contains("atempo=2.0"), "{g}");
        assert!(b.args.contains(&"C:/in it's.mp4".to_string()), "path passed verbatim as one argument");
    }
    #[test] fn join_copy_vs_reencode() {
        let d = tempfile::tempdir().unwrap();
        let a = JoinInput { path: "a.mp4".into(), probe: probe(640, 360, 1000, true) };
        let b = JoinInput { path: "b'.mp4".into(), probe: probe(640, 360, 1000, true) };
        let c = JoinInput { path: "c.mp4".into(), probe: probe(1280, 720, 1000, false) };
        let j = build_join(&[a, b], "auto", &Preset::default(), &caps_sw(), d.path(), Path::new("o.mp4")).unwrap();
        assert!(j.args.contains(&"concat".to_string()));
        assert!(std::fs::read_to_string(d.path().join("concat.txt")).unwrap().contains("b'\\''.mp4"));
        let a = JoinInput { path: "a.mp4".into(), probe: probe(640, 360, 1000, true) };
        let j = build_join(&[a, c], "auto", &Preset::default(), &caps_sw(), d.path(), Path::new("o.mp4")).unwrap();
        assert!(j.notes.iter().any(|n| n.contains("different resolutions")) && j.notes.iter().any(|n| n.contains("silence")));
    }
    /// Real FFmpeg run: generated sources → trim/delogo, join (copy + re-encode), timeline render, audio extract.
    #[test] fn ffmpeg_integration() {
        media::init_tools(None);
        if media::tools().ffmpeg.is_none() { eprintln!("skipped: no ffmpeg"); return; }
        let d = tempfile::tempdir().unwrap();
        let caps = caps().clone();
        let make = |name: &str, size: &str, dur: &str, audio: bool| {
            let p = d.path().join(name);
            let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", &format!("testsrc2=s={size}:r=30:d={dur}")].iter().map(|s| s.to_string()).collect();
            if audio { a.extend(["-f", "lavfi", "-i", &format!("sine=f=440:d={dur}"), "-c:a", "aac"].iter().map(|s| s.to_string())); }
            a.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest"].iter().map(|s| s.to_string()));
            a.push(p.to_string_lossy().into_owned());
            media::run_capture(media::ffmpeg_path().unwrap(), &a).unwrap();
            p
        };
        let a = make("clip a ü.mp4", "640x360", "3", true);
        let b = make("clip b.mp4", "640x360", "2", true);
        let c = make("clip c.mp4", "320x240", "2", false);
        let pr = |p: &Path| media::parse_probe(&media::ffprobe_json(p).unwrap());
        let cancel = Arc::new(AtomicBool::new(false));
        let run = |b: Built, out: &Path, cwd: Option<&Path>| { let mut last = 0.0; let mut args = b.args.clone(); let n = args.len() - 1; args[n] = out.to_string_lossy().into_owned();
            run_ffmpeg(&args, b.duration_us, cwd, &cancel, &mut |p| last = p).unwrap(); validate_output(out, b.duration_us).unwrap() };
        // trim + delogo + fade
        let e = QuickEdit { in_us: Some(500_000), out_us: Some(2_500_000), delogo: vec![Rect { x: 500, y: 300, w: 120, h: 50 }], fade_in_us: 300_000, ..Default::default() };
        let o = run(build_quick(&a, &pr(&a), &e, &Preset { hw: "none".into(), ..Default::default() }, &caps, Path::new("x")).unwrap(), &d.path().join("trim.mp4"), None);
        assert!((o.duration_ms.unwrap() - 2000).abs() < 150, "{:?}", o.duration_ms);
        // lossless join of compatible clips
        let j = build_join(&[JoinInput { path: a.clone(), probe: pr(&a) }, JoinInput { path: b.clone(), probe: pr(&b) }], "auto", &Preset::default(), &caps, d.path(), Path::new("x")).unwrap();
        assert!(j.notes[0].contains("without re-encoding"));
        let o = run(j, &d.path().join("join.mp4"), None);
        assert!((o.duration_ms.unwrap() - 5000).abs() < 200);
        // re-encode join with a silent, different-size clip
        let j = build_join(&[JoinInput { path: a.clone(), probe: pr(&a) }, JoinInput { path: c.clone(), probe: pr(&c) }], "auto", &Preset { hw: "none".into(), ..Default::default() }, &caps, d.path(), Path::new("x")).unwrap();
        let o = run(j, &d.path().join("join2.mp4"), None);
        assert_eq!((o.width, o.height), (Some(640), Some(360))); assert!(o.has_audio);
        // timeline: two tracks, title, dissolve, speed
        let mk = |id: &str, path: &Path, start: i64, inn: i64, out: i64| Clip { id: id.into(), kind: "video".into(), path: Some(path.to_string_lossy().into()), start_us: start, in_us: inn, out_us: out, ..Default::default() };
        let mut c2 = mk("2", &b, 2_000_000, 0, 2_000_000); c2.transition = "dissolve".into(); c2.transition_us = 500_000;
        let mut pip = mk("p", &c, 500_000, 0, 1_000_000); pip.transform.scale = 0.3; pip.transform.x = 0.3; pip.transform.y = -0.3; pip.speed = 0.5;
        let title = Clip { id: "t".into(), kind: "text".into(), start_us: 0, in_us: 0, out_us: 1_500_000, text: Some(TextSpec { content: "Title: it's \"ok\"".into(), size: 72.0, x: 0.5, y: 0.9, box_color: Some("#000000".into()), ..Default::default() }), ..Default::default() };
        let proj = Project { width: 640, height: 360, tracks: vec![
            Track { id: "v1".into(), kind: "video".into(), clips: vec![mk("1", &a, 0, 0, 2_000_000), c2], ..Default::default() },
            Track { id: "v2".into(), kind: "video".into(), clips: vec![pip, title], ..Default::default() }], ..Default::default() };
        let work = d.path().join("work"); std::fs::create_dir_all(&work).unwrap();
        let resolve = |cl: &Clip| cl.path.as_ref().map(|p| (PathBuf::from(p), pr(Path::new(p))));
        let built = build_render(&proj, &resolve, &Preset { hw: "none".into(), ..Default::default() }, &caps, None, &work, Path::new("x")).unwrap();
        let o = run(built, &d.path().join("render.mp4"), Some(&work));
        assert!((o.duration_ms.unwrap() - 4000).abs() < 200, "{:?}", o.duration_ms);
        assert!(o.has_audio);
        // audio extraction with fades
        let x = build_extract_audio(&a, &pr(&a), "mp3", &QuickEdit { fade_out_us: 500_000, ..Default::default() }, Path::new("x")).unwrap();
        let o = run(x, &d.path().join("a.mp3"), None);
        assert!(o.has_audio && o.width.is_none());
        assert!(build_extract_audio(&c, &pr(&c), "mp3", &QuickEdit::default(), Path::new("x")).is_err());
        // cancellation stops promptly and reports "cancelled"
        let cancel2 = Arc::new(AtomicBool::new(true));
        let mut args = build_proxy(&a, &pr(&a), Path::new("x")).args; let n = args.len() - 1; args[n] = d.path().join("p.mp4").to_string_lossy().into_owned();
        assert_eq!(run_ffmpeg(&args, 3_000_000, None, &cancel2, &mut |_| {}).unwrap_err(), "cancelled");
    }

    #[test] fn timeline_durations_and_graph() {
        let d = tempfile::tempdir().unwrap();
        let clip = |id: &str, start: i64, inn: i64, out: i64| Clip { id: id.into(), kind: "video".into(), asset_id: Some(1), start_us: start, in_us: inn, out_us: out, ..Default::default() };
        let mut b2 = clip("b", 2_000_000, 1_000_000, 3_000_000); b2.transition = "dissolve".into(); b2.transition_us = 500_000;
        let mut fast = clip("c", 4_000_000, 0, 2_000_000); fast.speed = 2.0;
        let title = Clip { id: "t".into(), kind: "text".into(), start_us: 0, in_us: 0, out_us: 1_000_000, text: Some(TextSpec { content: "Hi: it's 'quoted', [x]; ok".into(), size: 64.0, ..Default::default() }), ..Default::default() };
        let proj = Project { tracks: vec![
            Track { id: "v1".into(), kind: "video".into(), clips: vec![clip("a", 0, 0, 2_000_000), b2, fast], ..Default::default() },
            Track { id: "v2".into(), kind: "video".into(), clips: vec![title], ..Default::default() }], ..Default::default() };
        assert_eq!(proj.duration_us(), 5_000_000);
        let resolve = |_c: &Clip| Some((PathBuf::from("C:/m/a.mp4"), probe(1280, 720, 10_000, true)));
        let b = build_render(&proj, &resolve, &Preset::default(), &caps_sw(), Some((1_000_000, 4_500_000)), d.path(), Path::new("o.mp4")).unwrap();
        assert_eq!(b.duration_us, 3_500_000);
        let g = &b.args[b.args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(g.contains("textfile=title0.txt") && !g.contains("quoted"), "user text must not be in the graph");
        assert_eq!(std::fs::read_to_string(d.path().join("title0.txt")).unwrap(), "Hi: it's 'quoted', [x]; ok");
        assert!(g.contains("fade=t=in:st=0:d=0.500000:alpha=1"), "dissolve fades the incoming clip");
        assert!(g.contains("amix=inputs=3"));
    }
}
