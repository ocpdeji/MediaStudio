//! Editor media: probing for the timeline, "optimized media" (browser-decodable copies of HEVC / ProRes /
//! AC-3 … sources, kept in the cache), audio waveforms and timeline filmstrips.
use crate::media::{self, Probe};
use crate::thumbs;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Serialize, Clone, Debug, Default)]
pub struct MediaInfo {
    pub path: String, pub name: String, pub kind: String, pub ext: String, pub size: u64, pub mtime: i64,
    pub duration_us: i64, pub width: i64, pub height: i64, pub fps_num: i64, pub fps_den: i64,
    pub has_audio: bool, pub has_video: bool, pub vcodec: Option<String>, pub acodec: Option<String>, pub pix_fmt: Option<String>,
    /// The WebView can decode the original directly (preview and export).
    pub playable: bool,
    /// Why an optimized copy is needed (shown to the user).
    pub reason: Option<String>,
    pub optimized: Option<String>,
}

const WEB_IMAGE: &[&str] = &["jpg", "jpeg", "jfif", "png", "webp", "gif", "bmp", "avif", "ico"];
const WEB_AUDIO_EXT: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "weba"];
const WEB_VCODEC: &[&str] = &["h264", "vp8", "vp9", "av1"];
const WEB_ACODEC: &[&str] = &["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8"];
const WEB_CONTAINER: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv"];

pub fn mtime_ms(md: &std::fs::Metadata) -> i64 { md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0) }

/// Decide whether the WebView (Chromium) can decode a source, and if not, why.
pub fn playability(kind: &str, ext: &str, p: &Probe) -> (bool, Option<String>) {
    match kind {
        "image" => if WEB_IMAGE.contains(&ext) { (true, None) } else { (false, Some(format!("{} images are converted for editing", ext.to_uppercase()))) },
        "audio" => {
            let ok_codec = p.acodec.as_deref().map(|c| WEB_ACODEC.contains(&c)).unwrap_or(false);
            if WEB_AUDIO_EXT.contains(&ext) && ok_codec { (true, None) } else { (false, Some(format!("{} audio is converted for playback", p.acodec.clone().unwrap_or(ext.into()).to_uppercase()))) }
        }
        _ => {
            let vc = p.vcodec.as_deref().unwrap_or("");
            if !WEB_CONTAINER.contains(&ext) { return (false, Some(format!("{} files are converted for smooth editing", ext.to_uppercase()))); }
            if !WEB_VCODEC.contains(&vc) { return (false, Some(format!("{} video can't be decoded by the preview engine; an H.264 copy is made automatically", vc.to_uppercase()))); }
            if vc == "h264" { if let Some(pf) = &p.pix_fmt { if !matches!(pf.as_str(), "yuv420p" | "yuvj420p") { return (false, Some(format!("H.264 {pf} (10-bit / 4:2:2) is converted for the preview engine"))); } } }
            if p.has_audio { if let Some(ac) = &p.acodec { if !WEB_ACODEC.contains(&ac.as_str()) { return (false, Some(format!("{} audio is converted for playback", ac.to_uppercase()))); } } }
            (true, None)
        }
    }
}

pub fn optimized_path(cache: &Path, path: &str, size: u64, mtime: i64, kind: &str) -> PathBuf {
    let ext = match kind { "image" => "png", "audio" => "m4a", _ => "mp4" };
    cache.join("optimized").join(format!("{}.{ext}", thumbs::key(path, size as i64, mtime, 1)))
}

pub fn info(cache: &Path, path: &Path) -> Result<MediaInfo, String> {
    let md = std::fs::metadata(path).map_err(|_| format!("File not found: {}", path.display()))?;
    if !md.is_file() { return Err(format!("Not a file: {}", path.display())); }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let kind = media::classify(&ext).ok_or_else(|| format!("Unsupported file type: .{ext}"))?;
    let kind = if kind == "raw" { "image" } else { kind };
    let ps = path.to_string_lossy().into_owned();
    let probe = if kind == "image" && ext != "gif" { media::probe_image(path).or_else(|_| media::ffprobe_json(path).map(|j| media::parse_probe(&j)))? }
                else { media::ffprobe_json(path).map(|j| media::parse_probe(&j)).map_err(|e| format!("Can't read this file: {e}"))? };
    let (playable, reason) = playability(kind, &ext, &probe);
    let mtime = mtime_ms(&md);
    let opt = optimized_path(cache, &ps, md.len(), mtime, kind);
    let kind = if kind == "image" && ext == "gif" && probe.duration_ms.unwrap_or(0) > 0 { "image" } else { kind };
    Ok(MediaInfo {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: ps, kind: kind.into(), ext, size: md.len(), mtime,
        duration_us: if kind == "image" { 0 } else { probe.duration_ms.unwrap_or(0) * 1000 },
        width: probe.width.unwrap_or(0), height: probe.height.unwrap_or(0),
        fps_num: probe.fps_num.unwrap_or(30), fps_den: probe.fps_den.unwrap_or(1),
        has_audio: probe.has_audio, has_video: probe.vcodec.is_some() || kind == "image",
        vcodec: probe.vcodec.clone(), acodec: probe.acodec.clone(), pix_fmt: probe.pix_fmt.clone(),
        playable, reason, optimized: opt.is_file().then(|| opt.to_string_lossy().into_owned()),
    })
}

/// FFmpeg arguments for an optimized copy. Video: same resolution (max 4K), CFR, H.264 4:2:0 with a 1 s GOP for
/// fast seeking; audio AAC 48 kHz stereo. If only the audio is the problem the video stream is copied.
pub fn optimize_args(src: &Path, info: &MediaInfo, out: &Path, hw: &[String]) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut a = s(&["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error", "-i", &src.to_string_lossy()]);
    match info.kind.as_str() {
        "image" => { a.extend(s(&["-frames:v", "1", "-update", "1"])); }
        "audio" => { a.extend(s(&["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart"])); }
        _ => {
            a.extend(s(&["-map", "0:v:0", "-map", "0:a:0?", "-dn", "-sn", "-map_chapters", "-1"]));
            let vc = info.vcodec.as_deref().unwrap_or("");
            let video_ok = WEB_VCODEC.contains(&vc) && (vc != "h264" || matches!(info.pix_fmt.as_deref(), Some("yuv420p" | "yuvj420p") | None)) && WEB_CONTAINER.contains(&info.ext.as_str());
            if video_ok {
                a.extend(s(&["-c:v", "copy"]));
            } else {
                let fps = if info.fps_den > 0 { info.fps_num as f64 / info.fps_den as f64 } else { 30.0 };
                let fps = if fps.is_finite() && fps > 1.0 && fps <= 240.0 { fps } else { 30.0 };
                let gop = (fps.round() as i64).max(1).to_string();
                a.extend(s(&["-vf", "scale='min(3840,iw)':-2:flags=lanczos,format=yuv420p", "-fps_mode", "cfr", "-r", &format!("{}/{}", info.fps_num.max(1), info.fps_den.max(1))]));
                if hw.iter().any(|e| e == "h264_nvenc") { a.extend(s(&["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-g", &gop, "-bf", "2"])); }
                else if hw.iter().any(|e| e == "h264_qsv") { a.extend(s(&["-c:v", "h264_qsv", "-global_quality", "20", "-g", &gop])); }
                else if hw.iter().any(|e| e == "h264_amf") { a.extend(s(&["-c:v", "h264_amf", "-rc", "cqp", "-qp_i", "19", "-qp_p", "21", "-g", &gop])); }
                else { a.extend(s(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", &gop])); }
                a.extend(s(&["-profile:v", "high"]));
            }
            a.extend(s(&["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart"]));
        }
    }
    a.push(out.to_string_lossy().into_owned());
    a
}

/// Peak envelope, 100 values per second, each 0–255 (|sample| max). Cached as raw bytes.
pub fn waveform(cache: &Path, path: &Path, size: u64, mtime: i64) -> Result<Vec<u8>, String> {
    let ps = path.to_string_lossy().into_owned();
    let f = cache.join("waves").join(format!("{}.bin", thumbs::key(&ps, size as i64, mtime, 2)));
    if let Ok(b) = std::fs::read(&f) { return Ok(b); }
    let args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", &ps, "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"].iter().map(|s| s.to_string()).collect();
    let mut child = media::command(media::ffmpeg_path()?).args(&args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().unwrap();
    let mut peaks = Vec::new();
    let mut buf = vec![0u8; 160 * 64];
    let (mut cur, mut n) = (0i32, 0usize);
    let mut carry: Option<u8> = None;
    loop {
        let r = out.read(&mut buf).map_err(|e| e.to_string())?;
        if r == 0 { break; }
        let mut i = 0;
        let mut bytes: Vec<u8> = Vec::with_capacity(r + 1);
        if let Some(c) = carry.take() { bytes.push(c); }
        bytes.extend_from_slice(&buf[..r]);
        while i + 1 < bytes.len() {
            let v = i16::from_le_bytes([bytes[i], bytes[i + 1]]) as i32;
            cur = cur.max(v.abs()); n += 1;
            if n == 80 { peaks.push(((cur as f64 / 32768.0).sqrt() * 255.0).min(255.0) as u8); cur = 0; n = 0; }
            i += 2;
        }
        if i < bytes.len() { carry = Some(bytes[i]); }
    }
    let _ = child.wait();
    if n > 0 { peaks.push(((cur as f64 / 32768.0).sqrt() * 255.0).min(255.0) as u8); }
    if peaks.is_empty() { return Err("This file has no readable audio".into()); }
    let _ = std::fs::create_dir_all(f.parent().unwrap());
    let _ = std::fs::write(&f, &peaks);
    Ok(peaks)
}

#[derive(Serialize, Clone, Debug)]
pub struct Filmstrip { pub path: String, pub cols: u32, pub count: u32, pub interval_us: i64, pub tw: u32, pub th: u32 }

/// A sprite sheet of evenly spaced frames for the timeline (cached).
pub fn filmstrip(cache: &Path, path: &Path, size: u64, mtime: i64, duration_us: i64, w: i64, h: i64) -> Result<Filmstrip, String> {
    let th: u32 = 72;
    let tw: u32 = if w > 0 && h > 0 { (((th as f64 * w as f64 / h as f64) / 2.0).round() as u32 * 2).clamp(32, 256) } else { 128 };
    let dur_s = (duration_us as f64 / 1e6).max(0.04);
    let count: u32 = ((dur_s / 0.5).ceil() as u32).clamp(1, 400);
    let interval = dur_s / count as f64;
    let cols = count.min(20);
    let rows = count.div_ceil(cols);
    let ps = path.to_string_lossy().into_owned();
    let f = cache.join("strips").join(format!("{}.jpg", thumbs::key(&ps, size as i64, mtime, 7)));
    let fs = Filmstrip { path: f.to_string_lossy().into_owned(), cols, count, interval_us: (interval * 1e6) as i64, tw, th };
    if f.is_file() { return Ok(fs); }
    std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = f.with_extension("partial.jpg");
    let vf = format!("fps=1/{interval:.6}:start_time=0:round=near,scale={tw}:{th}:force_original_aspect_ratio=increase,crop={tw}:{th},tile={cols}x{rows}");
    // Keyframe-only decoding is much faster on long files but leaves gaps when keyframes are sparse (HEVC often has
    // one every 5–10 s), so it's only used for long sources where one tile per keyframe is acceptable.
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into()];
    if dur_s > 600.0 { args.extend(["-skip_frame".into(), "nokey".into()]); }
    args.extend(["-i".into(), ps.clone(), "-map".into(), "0:v:0".into(), "-vf".into(), vf, "-frames:v".into(), "1".into(), "-q:v".into(), "5".into(), "-y".into(), tmp.to_string_lossy().into_owned()]);
    media::run_capture(media::ffmpeg_path()?, &args)?;
    if !tmp.is_file() { return Err("Could not build the timeline thumbnails".into()); }
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())?;
    Ok(fs)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pr(vc: &str, pf: &str, ac: Option<&str>) -> Probe { Probe { vcodec: Some(vc.into()), pix_fmt: Some(pf.into()), has_audio: ac.is_some(), acodec: ac.map(String::from), ..Default::default() } }
    #[test] fn playability_rules() {
        assert!(playability("video", "mp4", &pr("h264", "yuv420p", Some("aac"))).0);
        assert!(!playability("video", "mp4", &pr("hevc", "yuv420p", Some("aac"))).0, "HEVC needs an optimized copy");
        assert!(!playability("video", "mp4", &pr("h264", "yuv420p10le", None)).0, "10-bit H.264 is not decodable");
        assert!(!playability("video", "mov", &pr("prores", "yuv422p10le", None)).0);
        assert!(!playability("video", "mp4", &pr("h264", "yuv420p", Some("ac3"))).0, "AC-3 audio needs conversion");
        assert!(!playability("video", "avi", &pr("h264", "yuv420p", None)).0);
        assert!(playability("video", "webm", &pr("vp9", "yuv420p", Some("opus"))).0);
        assert!(playability("image", "png", &Probe::default()).0);
        assert!(!playability("image", "heic", &Probe::default()).0);
    }
    #[test] fn optimize_copies_video_when_only_audio_is_bad() {
        let i = MediaInfo { kind: "video".into(), ext: "mp4".into(), vcodec: Some("h264".into()), pix_fmt: Some("yuv420p".into()), acodec: Some("ac3".into()), fps_num: 30, fps_den: 1, ..Default::default() };
        let a = optimize_args(Path::new("in.mp4"), &i, Path::new("o.mp4"), &[]);
        let j = a.join(" "); assert!(j.contains("-c:v copy") && j.contains("-c:a aac"), "{j}");
        let i2 = MediaInfo { vcodec: Some("hevc".into()), ..i };
        let j2 = optimize_args(Path::new("in.mp4"), &i2, Path::new("o.mp4"), &["h264_nvenc".into()]).join(" ");
        assert!(j2.contains("h264_nvenc") && j2.contains("format=yuv420p") && j2.contains("-r 30/1"), "{j2}");
    }
}
