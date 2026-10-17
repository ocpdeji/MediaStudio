//! Thumbnail cache + generator. Thumbnails are JPEG files keyed by (path, size, mtime, edge) so a changed
//! source automatically gets a new key. Requests are served LIFO so whatever is on screen right now wins.
use crate::media;
use image::{imageops::FilterType, DynamicImage, GenericImageView};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

pub const EDGE: u32 = 480;

pub fn key(path: &str, size: i64, mtime: i64, edge: u32) -> String {
    let mut h = DefaultHasher::new();
    (path.to_lowercase(), size, mtime, edge, 2u8).hash(&mut h);
    format!("{:016x}", h.finish())
}
pub fn cache_file(dir: &Path, key: &str) -> PathBuf { dir.join(&key[..2]).join(format!("{key}.jpg")) }

/// 64-bit difference hash on a 9x8 greyscale image — approximate visual similarity (Hamming distance).
pub fn dhash(img: &DynamicImage) -> u64 {
    let g = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut h = 0u64;
    for y in 0..8 { for x in 0..8 { h = (h << 1) | (g.get_pixel(x, y)[0] < g.get_pixel(x + 1, y)[0]) as u64; } }
    h
}

fn apply_orientation(img: DynamicImage, o: u32) -> DynamicImage {
    match o { 2 => img.fliph(), 3 => img.rotate180(), 4 => img.flipv(), 5 => img.rotate90().fliph(), 6 => img.rotate90(), 7 => img.rotate270().fliph(), 8 => img.rotate270(), _ => img }
}

fn ffmpeg_frame(src: &Path, out: &Path, kind: &str, duration_ms: Option<i64>, edge: u32) -> Result<(), String> {
    let ff = media::ffmpeg_path()?;
    let scale = format!("scale='min({edge},iw)':'min({edge},ih)':force_original_aspect_ratio=decrease");
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into()];
    match kind {
        "audio" => {
            a.extend(["-i".into(), src.to_string_lossy().into_owned(), "-filter_complex".into(),
                format!("showwavespic=s={edge}x{}:colors=0x5aa9ff:split_channels=0,format=yuvj420p", edge * 5 / 8), "-frames:v".into(), "1".into()]);
        }
        "video" => {
            let ss = duration_ms.map(|d| (d as f64 / 1000.0 * 0.1).min(5.0)).unwrap_or(0.0);
            a.extend(["-ss".into(), format!("{ss:.3}"), "-i".into(), src.to_string_lossy().into_owned(), "-map".into(), "0:v:0".into(),
                "-vf".into(), format!("{scale},format=yuvj420p"), "-frames:v".into(), "1".into()]);
        }
        _ => a.extend(["-i".into(), src.to_string_lossy().into_owned(), "-vf".into(), format!("{scale},format=yuvj420p"), "-frames:v".into(), "1".into()]),
    }
    a.extend(["-q:v".into(), "4".into(), out.to_string_lossy().into_owned()]);
    media::run_capture(ff, &a).map(|_| ())?;
    if out.is_file() { Ok(()) } else { Err("FFmpeg produced no frame".into()) }
}

/// Generate a thumbnail into the cache. Returns the cache path and (for images) a perceptual hash.
pub fn generate(dir: &Path, src: &Path, kind: &str, size: i64, mtime: i64, duration_ms: Option<i64>, edge: u32) -> Result<(PathBuf, Option<u64>), String> {
    let k = key(&src.to_string_lossy(), size, mtime, edge);
    let out = cache_file(dir, &k);
    if out.is_file() { return Ok((out, None)); }
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = out.with_extension("tmp.jpg");
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut ph = None;
    let native = kind == "image" && matches!(ext.as_str(), "jpg" | "jpeg" | "jfif" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "ico");
    let decoded = if native { image::ImageReader::open(src).map_err(|e| e.to_string()).and_then(|r| r.with_guessed_format().map_err(|e| e.to_string())).and_then(|r| r.decode().map_err(|e| e.to_string())) } else { Err(String::new()) };
    match decoded {
        Ok(img) => {
            let o = media::read_exif_basic(src).and_then(|x| x.0).unwrap_or(1);
            let t = apply_orientation(img.thumbnail(edge, edge), o);
            ph = Some(dhash(&t));
            let (w, h) = t.dimensions();
            let rgb = DynamicImage::ImageRgb8(t.to_rgb8());
            let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 82).encode_image(&rgb).map_err(|e| format!("encode {w}x{h}: {e}"))?;
        }
        Err(_) => {
            ffmpeg_frame(src, &tmp, kind, duration_ms, edge)?;
            if kind == "image" || kind == "raw" { if let Ok(i) = image::open(&tmp) { ph = Some(dhash(&i)); } }
        }
    }
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok((out, ph))
}

pub fn dir_size(dir: &Path) -> u64 {
    walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()
}

/// Trim the cache to `max_bytes`, deleting least-recently-modified files first. Never touches anything else.
pub fn trim_cache(dir: &Path, max_bytes: u64) -> u64 {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "jpg"))
        .filter_map(|e| { let m = e.metadata().ok()?; Some((m.modified().ok()?, m.len(), e.into_path())) }).collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    let mut freed = 0;
    for (_, len, p) in files { if total <= max_bytes { break; } if std::fs::remove_file(&p).is_ok() { total -= len; freed += len; } }
    freed
}

// ---------------------------------------------------------------- worker pool

pub struct Task { pub run: Box<dyn FnOnce() + Send> }
#[derive(Clone)]
pub struct Pool { inner: Arc<(Mutex<Vec<Task>>, Condvar)> }
impl Pool {
    pub fn new(workers: usize) -> Self {
        let p = Pool { inner: Arc::new((Mutex::new(Vec::new()), Condvar::new())) };
        for _ in 0..workers.max(1) {
            let q = p.inner.clone();
            std::thread::spawn(move || loop {
                let task = { let (m, cv) = &*q; let mut g = m.lock().unwrap(); while g.is_empty() { g = cv.wait(g).unwrap(); } g.pop() };
                if let Some(t) = task { let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(t.run)); }
            });
        }
        p
    }
    /// LIFO: newest request first. The queue is bounded — the oldest (off-screen) requests are dropped.
    pub fn push(&self, t: Task) {
        let (m, cv) = &*self.inner;
        let mut g = m.lock().unwrap();
        g.push(t);
        if g.len() > 2000 { let drop_n = g.len() - 2000; g.drain(0..drop_n); }
        cv.notify_one();
    }
    pub fn pending(&self) -> usize { self.inner.0.lock().unwrap().len() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn key_changes_with_source() {
        assert_ne!(key("a", 1, 1, EDGE), key("a", 1, 2, EDGE));
        assert_eq!(key("C:/A.jpg", 1, 1, EDGE), key("c:/a.jpg", 1, 1, EDGE));
    }
    #[test] fn native_thumbnail_and_hash() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("big ünicode.png");
        let img = image::RgbImage::from_fn(2000, 1000, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        img.save(&src).unwrap();
        let (out, ph) = generate(&d.path().join("cache"), &src, "image", 1, 1, None, EDGE).unwrap();
        let t = image::open(&out).unwrap();
        assert_eq!(t.dimensions(), (480, 240)); // aspect preserved, never stretched
        assert!(ph.is_some());
        // cached second time
        let (out2, ph2) = generate(&d.path().join("cache"), &src, "image", 1, 1, None, EDGE).unwrap();
        assert_eq!(out, out2); assert!(ph2.is_none());
        assert!(trim_cache(&d.path().join("cache"), 0) > 0);
    }
}
