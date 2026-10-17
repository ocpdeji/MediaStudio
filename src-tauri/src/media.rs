//! Media engine: locating FFmpeg/FFprobe, argument-safe process spawning, probing and classification.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "jfif", "png", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "heif", "svg", "ico"];
pub const VIDEO_EXT: &[&str] = &["mp4", "mov", "mkv", "webm", "m4v", "avi", "mxf", "mts", "m2ts", "ts", "wmv", "flv", "3gp", "ogv", "mpg", "mpeg"];
pub const AUDIO_EXT: &[&str] = &["wav", "mp3", "aac", "flac", "m4a", "ogg", "opus", "wma", "aiff", "aif"];
pub const RAW_EXT: &[&str] = &["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf"];

/// Classify a file by extension. Returns "image" | "video" | "audio" | "raw" or None for unsupported files.
pub fn classify(ext: &str) -> Option<&'static str> {
    let e = ext.to_ascii_lowercase();
    if IMAGE_EXT.contains(&e.as_str()) { Some("image") }
    else if VIDEO_EXT.contains(&e.as_str()) { Some("video") }
    else if AUDIO_EXT.contains(&e.as_str()) { Some("audio") }
    else if RAW_EXT.contains(&e.as_str()) { Some("raw") }
    else { None }
}

#[derive(Clone, Debug, Serialize)]
pub struct Tools { pub ffmpeg: Option<PathBuf>, pub ffprobe: Option<PathBuf>, pub source: String }

static TOOLS: OnceLock<Tools> = OnceLock::new();

/// Resolve FFmpeg: bundled `resources/ffmpeg/` first, then next to the executable, then PATH.
pub fn init_tools(resource_dir: Option<PathBuf>) -> &'static Tools {
    TOOLS.get_or_init(|| {
        let mut cands: Vec<(PathBuf, &str)> = vec![];
        if let Some(r) = resource_dir { cands.push((r.join("ffmpeg"), "bundled")); }
        if let Ok(exe) = std::env::current_exe() { if let Some(d) = exe.parent() { cands.push((d.join("ffmpeg"), "app folder")); } }
        for (dir, src) in cands {
            let (a, b) = (dir.join("ffmpeg.exe"), dir.join("ffprobe.exe"));
            if a.is_file() && b.is_file() { return Tools { ffmpeg: Some(a), ffprobe: Some(b), source: src.into() }; }
        }
        let find = |n: &str| -> Option<PathBuf> {
            let path = std::env::var_os("PATH")?;
            std::env::split_paths(&path).map(|p| p.join(format!("{n}.exe"))).find(|p| p.is_file())
        };
        let (a, b) = (find("ffmpeg"), find("ffprobe"));
        let source = if a.is_some() { "system PATH" } else { "not found" };
        Tools { ffmpeg: a, ffprobe: b, source: source.into() }
    })
}
pub fn tools() -> &'static Tools { TOOLS.get().expect("tools initialised") }

pub fn ffmpeg_path() -> Result<&'static Path, String> {
    tools().ffmpeg.as_deref().ok_or_else(|| "FFmpeg was not found. Reinstall Media Studio Pro or put ffmpeg.exe on PATH.".into())
}
pub fn ffprobe_path() -> Result<&'static Path, String> {
    tools().ffprobe.as_deref().ok_or_else(|| "FFprobe was not found. Reinstall Media Studio Pro or put ffprobe.exe on PATH.".into())
}

/// Build a command with no console window. Arguments are passed as a vector — never through a shell.
pub fn command(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.stdin(Stdio::null());
    c
}

pub fn run_capture(exe: &Path, args: &[String]) -> Result<Vec<u8>, String> {
    let out = command(exe).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(last_lines(&err, 6));
    }
    Ok(out.stdout)
}

pub fn last_lines(s: &str, n: usize) -> String {
    let v: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    v[v.len().saturating_sub(n)..].join("\n")
}

#[derive(Default, Debug, Clone, Serialize)]
pub struct Probe {
    pub width: Option<i64>, pub height: Option<i64>, pub duration_ms: Option<i64>,
    pub fps_num: Option<i64>, pub fps_den: Option<i64>, pub vcodec: Option<String>, pub acodec: Option<String>,
    pub bitrate: Option<i64>, pub has_audio: bool, pub rotation: Option<i64>, pub capture_time: Option<i64>,
    pub pix_fmt: Option<String>,
}

/// Parse "30000/1001" style rationals. Returns None for 0/0.
pub fn parse_rational(s: &str) -> Option<(i64, i64)> {
    let (a, b) = s.split_once('/')?;
    let (a, b) = (a.trim().parse::<i64>().ok()?, b.trim().parse::<i64>().ok()?);
    if a <= 0 || b <= 0 { None } else { Some((a, b)) }
}

pub fn ffprobe_json(path: &Path) -> Result<serde_json::Value, String> {
    let args = vec!["-v".into(), "error".into(), "-print_format".into(), "json".into(), "-show_format".into(), "-show_streams".into(), "-show_chapters".into(), path.to_string_lossy().into_owned()];
    let out = run_capture(ffprobe_path()?, &args)?;
    serde_json::from_slice(&out).map_err(|e| format!("Unreadable ffprobe output: {e}"))
}

pub fn parse_probe(j: &serde_json::Value) -> Probe {
    let mut p = Probe::default();
    let empty = vec![];
    let streams = j["streams"].as_array().unwrap_or(&empty);
    if let Some(v) = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1) {
        p.width = v["width"].as_i64(); p.height = v["height"].as_i64();
        p.vcodec = v["codec_name"].as_str().map(String::from);
        p.pix_fmt = v["pix_fmt"].as_str().map(String::from);
        let fr = v["avg_frame_rate"].as_str().and_then(parse_rational).or_else(|| v["r_frame_rate"].as_str().and_then(parse_rational));
        if let Some((n, d)) = fr { p.fps_num = Some(n); p.fps_den = Some(d); }
        // rotation: side data (newer FFmpeg) or legacy tag
        let rot = v["side_data_list"].as_array().and_then(|l| l.iter().find_map(|sd| sd["rotation"].as_i64()))
            .or_else(|| v["tags"]["rotate"].as_str().and_then(|s| s.parse().ok()));
        p.rotation = rot;
        if let Some(r) = rot { if r.abs() % 180 == 90 { std::mem::swap(&mut p.width, &mut p.height); } }
    }
    if let Some(a) = streams.iter().find(|s| s["codec_type"] == "audio") { p.has_audio = true; p.acodec = a["codec_name"].as_str().map(String::from); }
    let f = &j["format"];
    p.duration_ms = f["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).map(|d| (d * 1000.0).round() as i64);
    p.bitrate = f["bit_rate"].as_str().and_then(|b| b.parse().ok());
    p.capture_time = f["tags"]["creation_time"].as_str().and_then(parse_iso_ms);
    p
}

/// Minimal ISO-8601 → epoch ms (UTC), e.g. "2024-05-01T10:20:30.000000Z".
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 19 { return None; }
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    Some((days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se) * 1000)
}
/// EXIF "YYYY:MM:DD HH:MM:SS" (local time, treated as naive) → epoch ms.
pub fn parse_exif_ms(s: &str) -> Option<i64> { parse_iso_ms(&s.replacen(':', "-", 2)) }
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Fast image probing: header-only dimensions + EXIF (orientation, capture date). Falls back to ffprobe.
pub fn probe_image(path: &Path) -> Result<Probe, String> {
    let mut p = Probe::default();
    match imagesize::size(path) {
        Ok(sz) => { p.width = Some(sz.width as i64); p.height = Some(sz.height as i64); }
        Err(_) => { if tools().ffprobe.is_some() { return ffprobe_json(path).map(|j| parse_probe(&j)); } return Err("Unreadable image header".into()); }
    }
    if let Some((orient, date)) = read_exif_basic(path) {
        if matches!(orient, Some(5..=8)) { std::mem::swap(&mut p.width, &mut p.height); }
        p.rotation = orient.map(|o| o as i64);
        p.capture_time = date;
    }
    Ok(p)
}

pub fn read_exif_basic(path: &Path) -> Option<(Option<u32>, Option<i64>)> {
    let file = std::fs::File::open(path).ok()?;
    let ex = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)).ok()?;
    let orient = ex.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0));
    let date = ex.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string()).and_then(|s| parse_exif_ms(&s));
    Some((orient, date))
}

/// Human-readable EXIF fields for the inspector (only fields that actually exist).
pub fn read_exif_fields(path: &Path) -> Vec<(String, String)> {
    let Ok(file) = std::fs::File::open(path) else { return vec![] };
    let Ok(ex) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)) else { return vec![] };
    use exif::Tag as T;
    let wanted = [T::Make, T::Model, T::LensModel, T::DateTimeOriginal, T::ExposureTime, T::FNumber, T::PhotographicSensitivity, T::FocalLength,
        T::FocalLengthIn35mmFilm, T::ExposureBiasValue, T::Flash, T::WhiteBalance, T::MeteringMode, T::Orientation, T::ColorSpace, T::Software, T::Artist, T::Copyright,
        T::GPSLatitude, T::GPSLatitudeRef, T::GPSLongitude, T::GPSLongitudeRef, T::GPSAltitude];
    let mut out = vec![];
    for t in wanted {
        if let Some(f) = ex.get_field(t, exif::In::PRIMARY) {
            out.push((t.to_string(), f.display_value().with_unit(&ex).to_string().trim_matches('"').to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn classify_ext() {
        assert_eq!(classify("JPG"), Some("image"));
        assert_eq!(classify("mkv"), Some("video"));
        assert_eq!(classify("flac"), Some("audio"));
        assert_eq!(classify("txt"), None);
    }
    #[test] fn rationals() {
        assert_eq!(parse_rational("30000/1001"), Some((30000, 1001)));
        assert_eq!(parse_rational("0/0"), None);
        assert_eq!(parse_rational("abc"), None);
    }
    #[test] fn iso_dates() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2024-02-29T12:00:00.000Z"), Some(1_709_208_000_000));
        assert_eq!(parse_exif_ms("2024:02:29 12:00:00"), Some(1_709_208_000_000));
    }
    #[test] fn probe_parsing_rotation_and_fps() {
        let j: serde_json::Value = serde_json::from_str(r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"30000/1001","side_data_list":[{"rotation":-90}]},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"12.345","bit_rate":"5000000"}}"#).unwrap();
        let p = parse_probe(&j);
        assert_eq!((p.width, p.height), (Some(1080), Some(1920)));
        assert_eq!((p.fps_num, p.fps_den), (Some(30000), Some(1001)));
        assert_eq!(p.duration_ms, Some(12345));
        assert!(p.has_audio);
        assert_eq!(p.acodec.as_deref(), Some("aac"));
    }
}
