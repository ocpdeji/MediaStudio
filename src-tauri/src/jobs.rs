//! Persistent job queue: queued → running → done | failed | cancelled (| interrupted after a crash/exit).
use crate::db::{self, now_ms};
use crate::export::{self, Built, JoinInput, Preset, Project, QuickEdit};
use crate::{ai, media, ops, scan, thumbs};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ImageOps { pub resize_long: Option<u32>, pub scale_pct: Option<f64>, pub rotate: i32, pub flip_h: bool, pub flip_v: bool, pub format: String, pub quality: u8, pub suffix: String }

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JobSpec {
    Quick { asset_id: i64, edit: QuickEdit, preset: Preset, out_dir: Option<String>, name: String },
    Join { asset_ids: Vec<i64>, mode: String, preset: Preset, out_dir: Option<String>, name: String },
    ExtractAudio { asset_id: i64, format: String, edit: QuickEdit, out_dir: Option<String>, name: String },
    Proxy { asset_id: i64 },
    Render { project: Project, preset: Preset, range: Option<(i64, i64)>, out_dir: String, name: String },
    Convert { asset_ids: Vec<i64>, preset: Preset, out_dir: Option<String>, suffix: String },
    ImageBatch { asset_ids: Vec<i64>, ops: ImageOps, out_dir: Option<String> },
    CopyTo { asset_ids: Vec<i64>, dest: String, mode: String },
    Upscale { asset_id: i64, scale: u32, model: String, cpu: bool, out_dir: Option<String> },
    Hashes { asset_ids: Vec<i64> },
}
impl JobSpec {
    fn kind(&self) -> &'static str {
        match self { JobSpec::Quick { .. } => "export", JobSpec::Join { .. } => "join", JobSpec::ExtractAudio { .. } => "audio", JobSpec::Proxy { .. } => "proxy", JobSpec::Render { .. } => "render",
            JobSpec::Convert { .. } => "convert", JobSpec::ImageBatch { .. } => "images", JobSpec::CopyTo { .. } => "copy", JobSpec::Upscale { .. } => "upscale", JobSpec::Hashes { .. } => "analyse" }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct JobRow { pub id: i64, pub kind: String, pub title: String, pub status: String, pub progress: f64, pub error: Option<String>, pub result: Option<serde_json::Value>, pub created_at: i64, pub started_at: Option<i64>, pub finished_at: Option<i64> }

fn row(r: &rusqlite::Row) -> rusqlite::Result<JobRow> {
    let res: Option<String> = r.get(6)?;
    Ok(JobRow { id: r.get(0)?, kind: r.get(1)?, title: r.get(2)?, status: r.get(3)?, progress: r.get(4)?, error: r.get(5)?, result: res.and_then(|s| serde_json::from_str(&s).ok()),
        created_at: r.get(7)?, started_at: r.get(8)?, finished_at: r.get(9)? })
}
const COLS: &str = "id,kind,title,status,progress,error,result,created_at,started_at,finished_at";

pub fn list(c: &Connection, limit: i64) -> rusqlite::Result<Vec<JobRow>> {
    let mut st = c.prepare(&format!("SELECT {COLS} FROM jobs ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, id DESC LIMIT ?"))?;
    let v = st.query_map([limit], row)?.collect(); v
}
fn get(c: &Connection, id: i64) -> Option<JobRow> { c.query_row(&format!("SELECT {COLS} FROM jobs WHERE id=?"), [id], row).optional().ok().flatten() }

#[derive(Serialize, Default)]
struct Outcome { outputs: Vec<String>, notes: Vec<String>, batch: Option<String> }

pub struct Ctx { pub app: AppHandle, pub db_path: PathBuf, pub cache_dir: PathBuf, pub data_dir: PathBuf }

#[derive(Clone)]
pub struct Jobs { inner: Arc<Inner> }
struct Inner { ctx: Ctx, cancels: Mutex<HashMap<i64, Arc<AtomicBool>>>, signal: (Mutex<bool>, Condvar), concurrency: AtomicUsize, running: AtomicUsize }

impl Jobs {
    pub fn start(ctx: Ctx, concurrency: usize) -> Jobs {
        if let Ok(c) = db::open(&ctx.db_path) {
            let _ = c.execute("UPDATE jobs SET status='interrupted', error='The app closed while this job was running. Retry to run it again.', finished_at=? WHERE status='running'", [now_ms()]);
        }
        let j = Jobs { inner: Arc::new(Inner { ctx, cancels: Mutex::new(HashMap::new()), signal: (Mutex::new(false), Condvar::new()), concurrency: AtomicUsize::new(concurrency.clamp(1, 8)), running: AtomicUsize::new(0) }) };
        let me = j.clone();
        std::thread::spawn(move || me.dispatch());
        j
    }
    pub fn set_concurrency(&self, n: usize) { self.inner.concurrency.store(n.clamp(1, 8), Ordering::Relaxed); self.wake(); }
    fn wake(&self) { let (m, cv) = &self.inner.signal; *m.lock().unwrap() = true; cv.notify_all(); }

    pub fn enqueue(&self, c: &Connection, spec: JobSpec, title: String) -> Result<i64, String> {
        let params_json = serde_json::to_string(&spec).map_err(|e| e.to_string())?;
        c.execute("INSERT INTO jobs(kind,title,status,params,created_at) VALUES(?,?,'queued',?,?)", params![spec.kind(), title, params_json, now_ms()]).map_err(|e| e.to_string())?;
        let id = c.last_insert_rowid();
        if let Some(r) = get(c, id) { let _ = self.inner.ctx.app.emit("job", r); }
        self.wake();
        Ok(id)
    }
    pub fn cancel(&self, c: &Connection, id: i64) -> Result<(), String> {
        let n = c.execute("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status='queued'", params![now_ms(), id]).map_err(|e| e.to_string())?;
        if n == 0 { if let Some(f) = self.inner.cancels.lock().unwrap().get(&id) { f.store(true, Ordering::Relaxed); } }
        if let Some(r) = get(c, id) { let _ = self.inner.ctx.app.emit("job", r); }
        Ok(())
    }
    pub fn retry(&self, c: &Connection, id: i64) -> Result<i64, String> {
        let (p, title): (String, String) = c.query_row("SELECT params,title FROM jobs WHERE id=?", [id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        let spec: JobSpec = serde_json::from_str(&p).map_err(|e| e.to_string())?;
        self.enqueue(c, spec, title)
    }

    fn dispatch(&self) {
        loop {
            { let (m, cv) = &self.inner.signal; let g = m.lock().unwrap(); let (mut g, _) = cv.wait_timeout(g, std::time::Duration::from_millis(1000)).unwrap(); *g = false; }
            let Ok(c) = db::open(&self.inner.ctx.db_path) else { continue };
            while self.inner.running.load(Ordering::SeqCst) < self.inner.concurrency.load(Ordering::Relaxed) {
                let next: Option<(i64, String)> = c.query_row("SELECT id,params FROM jobs WHERE status='queued' ORDER BY id LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
                let Some((id, p)) = next else { break };
                if c.execute("UPDATE jobs SET status='running', started_at=?, progress=0 WHERE id=? AND status='queued'", params![now_ms(), id]).unwrap_or(0) == 0 { continue; }
                self.inner.running.fetch_add(1, Ordering::SeqCst);
                let flag = Arc::new(AtomicBool::new(false));
                self.inner.cancels.lock().unwrap().insert(id, flag.clone());
                let me = self.clone();
                std::thread::spawn(move || { me.run(id, &p, flag); me.inner.running.fetch_sub(1, Ordering::SeqCst); me.inner.cancels.lock().unwrap().remove(&id); me.wake(); });
            }
        }
    }

    fn run(&self, id: i64, params_json: &str, cancel: Arc<AtomicBool>) {
        let ctx = &self.inner.ctx;
        let Ok(c) = db::open(&ctx.db_path) else { return };
        if let Some(r) = get(&c, id) { let _ = ctx.app.emit("job", r); }
        let mut last = std::time::Instant::now();
        let app = ctx.app.clone();
        let dbp = ctx.db_path.clone();
        let mut progress = move |p: f64| {
            if last.elapsed().as_millis() < 250 { return; }
            last = std::time::Instant::now();
            if let Ok(c) = db::open(&dbp) { let _ = c.execute("UPDATE jobs SET progress=? WHERE id=?", params![p, id]); if let Some(r) = get(&c, id) { let _ = app.emit("job", r); } }
        };
        let res = serde_json::from_str::<JobSpec>(params_json).map_err(|e| e.to_string()).and_then(|spec| execute(ctx, &c, id, &spec, &cancel, &mut progress));
        let now = now_ms();
        match res {
            Ok(out) => { let _ = c.execute("UPDATE jobs SET status='done', progress=1, result=?, finished_at=? WHERE id=?", params![serde_json::to_string(&out).unwrap_or_default(), now, id]); }
            Err(e) if cancel.load(Ordering::Relaxed) || e == "cancelled" => { let _ = c.execute("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=?", params![now, id]); }
            Err(e) => { let _ = c.execute("UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?", params![e, now, id]); }
        }
        if let Some(r) = get(&c, id) { let _ = ctx.app.emit("job", r); }
        let _ = ctx.app.emit("library-changed", ());
    }
}

// ---------------------------------------------------------------- execution

fn asset(c: &Connection, id: i64) -> Result<db::AssetRow, String> {
    let a = db::get_asset(c, id).map_err(|e| e.to_string())?.ok_or("Media is no longer in the catalogue")?;
    if !Path::new(&a.path).is_file() { return Err(format!("Source file is missing: {}", a.path)); }
    Ok(a)
}
fn out_dir_for(a: &db::AssetRow, out_dir: &Option<String>) -> Result<PathBuf, String> {
    let d = match out_dir { Some(d) if !d.is_empty() => PathBuf::from(d), _ => Path::new(&a.path).parent().map(Path::to_path_buf).ok_or("No folder")? };
    if !d.is_dir() { return Err(format!("Output folder does not exist: {}", d.display())); }
    Ok(d)
}
fn probe_of(path: &Path) -> Result<media::Probe, String> { media::ffprobe_json(path).map(|j| media::parse_probe(&j)) }

fn check_space(dir: &Path, need: u64) -> Result<(), String> {
    if let Ok(free) = fs4::available_space(dir) { if free < need { return Err(format!("Not enough disk space in {} (need ≈{} MB, {} MB free)", dir.display(), need / 1_048_576, free / 1_048_576)); } }
    Ok(())
}

/// Run a built FFmpeg command into `<dir>/<name>`: temp ".partial" file → validate → unique final name.
fn ffmpeg_to(c: &Connection, built: Built, dir: &Path, name: &str, work: Option<&Path>, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64), out: &mut Outcome, est_bytes: u64) -> Result<PathBuf, String> {
    ops::validate_filename(name)?;
    check_space(dir, est_bytes + 50 * 1_048_576)?;
    let final_path = ops::unique_path(dir, name);
    let (stem, ext) = ops::split_ext(final_path.file_name().unwrap().to_str().unwrap_or("out.mp4"));
    let tmp = dir.join(format!("{stem}.partial.{ext}"));
    let tmp_s = tmp.to_string_lossy().into_owned();
    let mut args = built.args; let last = args.len() - 1; args[last] = tmp_s;
    let r = export::run_ffmpeg(&args, built.duration_us, work, cancel, progress);
    if let Err(e) = r { let _ = std::fs::remove_file(&tmp); return Err(e); }
    if let Err(e) = export::validate_output(&tmp, built.duration_us) { let _ = std::fs::remove_file(&tmp); return Err(e); }
    let final_path = ops::unique_path(dir, final_path.file_name().unwrap().to_str().unwrap());
    std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
    let _ = scan::upsert_file(c, &final_path);
    out.outputs.push(final_path.to_string_lossy().into_owned());
    out.notes.extend(built.notes);
    Ok(final_path)
}

fn est(bitrate_kbps: Option<u32>, us: i64) -> u64 { (bitrate_kbps.unwrap_or(12_000) as u64 * 1000 / 8) * (us.max(0) as u64 / 1_000_000 + 1) }

fn execute(ctx: &Ctx, c: &Connection, id: i64, spec: &JobSpec, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64)) -> Result<Outcome, String> {
    let caps = export::caps();
    let mut out = Outcome::default();
    let work = ctx.cache_dir.join("work").join(format!("job{id}"));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        match spec {
            JobSpec::Quick { asset_id, edit, preset, out_dir, name } => {
                let a = asset(c, *asset_id)?; let dir = out_dir_for(&a, out_dir)?;
                let pr = probe_of(Path::new(&a.path))?;
                let b = export::build_quick(Path::new(&a.path), &pr, edit, preset, caps, Path::new("out"))?;
                let e = est(preset.bitrate_kbps, b.duration_us);
                ffmpeg_to(c, b, &dir, name, None, cancel, progress, &mut out, e)?;
            }
            JobSpec::Join { asset_ids, mode, preset, out_dir, name } => {
                let mut inputs = vec![];
                for i in asset_ids { let a = asset(c, *i)?; inputs.push(JoinInput { probe: probe_of(Path::new(&a.path))?, path: a.path.into() }); }
                let first = asset(c, asset_ids[0])?; let dir = out_dir_for(&first, out_dir)?;
                let b = export::build_join(&inputs, mode, preset, caps, &work, Path::new("out"))?;
                let e = est(preset.bitrate_kbps, b.duration_us);
                ffmpeg_to(c, b, &dir, name, None, cancel, progress, &mut out, e)?;
            }
            JobSpec::ExtractAudio { asset_id, format, edit, out_dir, name } => {
                let a = asset(c, *asset_id)?; let dir = out_dir_for(&a, out_dir)?;
                let pr = probe_of(Path::new(&a.path))?;
                let b = export::build_extract_audio(Path::new(&a.path), &pr, format, edit, Path::new("out"))?;
                ffmpeg_to(c, b, &dir, name, None, cancel, progress, &mut out, 0)?;
            }
            JobSpec::Proxy { asset_id } => {
                let a = asset(c, *asset_id)?;
                let pr = probe_of(Path::new(&a.path))?;
                let dir = ctx.cache_dir.join("proxies"); std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let name = format!("{}.mp4", thumbs::key(&a.path, a.size, a.mtime, 0));
                let target = dir.join(&name);
                if !target.is_file() {
                    let tmp = dir.join(format!("{name}.partial.mp4"));
                    let b = export::build_proxy(Path::new(&a.path), &pr, &tmp);
                    export::run_ffmpeg(&b.args, b.duration_us, None, cancel, progress).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
                    export::validate_output(&tmp, b.duration_us)?;
                    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
                }
                out.outputs.push(target.to_string_lossy().into_owned());
                out.notes.push("Proxy stored in the cache (the original is untouched).".into());
            }
            JobSpec::Render { project, preset, range, out_dir, name } => {
                let dir = PathBuf::from(out_dir); if !dir.is_dir() { return Err(format!("Output folder does not exist: {out_dir}")); }
                let mut cache: HashMap<String, media::Probe> = HashMap::new();
                let resolve = |cl: &export::Clip| -> Option<(PathBuf, media::Probe)> {
                    let path = match (cl.asset_id, &cl.path) {
                        (Some(id), _) => db::get_asset(c, id).ok().flatten().map(|a| PathBuf::from(a.path)).filter(|p| p.is_file()).or_else(|| cl.path.as_ref().map(PathBuf::from)),
                        (None, Some(p)) => Some(PathBuf::from(p)), _ => None };
                    let path = path.filter(|p| p.is_file())?;
                    let pr = probe_of(&path).ok()?;
                    Some((path, pr))
                };
                let _ = &mut cache;
                let b = export::build_render(project, &resolve, preset, caps, *range, &work, Path::new("out"))?;
                let e = est(preset.bitrate_kbps, b.duration_us);
                ffmpeg_to(c, b, &dir, name, Some(&work), cancel, progress, &mut out, e)?;
            }
            JobSpec::Convert { asset_ids, preset, out_dir, suffix } => {
                let n = asset_ids.len().max(1) as f64;
                for (i, aid) in asset_ids.iter().enumerate() {
                    if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
                    let a = match asset(c, *aid) { Ok(a) => a, Err(e) => { out.notes.push(e); continue; } };
                    let dir = out_dir_for(&a, out_dir)?;
                    let pr = probe_of(Path::new(&a.path))?;
                    let (stem, _) = ops::split_ext(&a.name);
                    let ext = match preset.container.as_str() { "audio" => "m4a", x => x };
                    let name = format!("{stem}{suffix}.{ext}");
                    let b = export::build_quick(Path::new(&a.path), &pr, &QuickEdit::default(), preset, caps, Path::new("out"))?;
                    let e = est(preset.bitrate_kbps, b.duration_us);
                    let mut sub = |p: f64| progress((i as f64 + p) / n);
                    if let Err(e) = ffmpeg_to(c, b, &dir, &name, None, cancel, &mut sub, &mut out, e) { if e == "cancelled" { return Err(e); } out.notes.push(format!("{}: {e}", a.name)); }
                }
            }
            JobSpec::ImageBatch { asset_ids, ops: o, out_dir } => {
                let n = asset_ids.len().max(1) as f64;
                for (i, aid) in asset_ids.iter().enumerate() {
                    if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
                    let a = match asset(c, *aid) { Ok(a) => a, Err(e) => { out.notes.push(e); continue; } };
                    match image_op(c, &a, o, out_dir) { Ok(p) => out.outputs.push(p), Err(e) => out.notes.push(format!("{}: {e}", a.name)) }
                    progress((i + 1) as f64 / n);
                }
            }
            JobSpec::CopyTo { asset_ids, dest, mode } => {
                let d = PathBuf::from(dest); if !d.is_dir() { return Err(format!("Destination does not exist: {dest}")); }
                let n = asset_ids.len().max(1) as f64;
                for (i, aid) in asset_ids.iter().enumerate() {
                    if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
                    let a = match asset(c, *aid) { Ok(a) => a, Err(e) => { out.notes.push(e); continue; } };
                    let target = ops::unique_path(&d, &a.name);
                    let r = if mode == "move" { std::fs::rename(&a.path, &target).or_else(|_| std::fs::copy(&a.path, &target).and_then(|_| std::fs::remove_file(&a.path))) } else { std::fs::copy(&a.path, &target).map(|_| ()) };
                    match r { Ok(_) => { out.outputs.push(target.to_string_lossy().into_owned()); if mode == "move" { let _ = c.execute("DELETE FROM assets WHERE id=?", [a.id]); } let _ = scan::upsert_file(c, &target); } Err(e) => out.notes.push(format!("{}: {e}", a.name)) }
                    progress((i + 1) as f64 / n);
                }
            }
            JobSpec::Upscale { asset_id, scale, model, cpu, out_dir } => {
                let a = asset(c, *asset_id)?; let dir = out_dir_for(&a, out_dir)?;
                let p = ai::upscale(&ctx.data_dir, &work, &a, *scale, model, *cpu, &dir, cancel, progress)?;
                let _ = scan::upsert_file(c, &p);
                out.outputs.push(p.to_string_lossy().into_owned());
                out.notes.push(format!("AI upscaled {scale}× with {model}"));
            }
            JobSpec::Hashes { asset_ids } => {
                let n = asset_ids.len().max(1) as f64;
                let tdir = ctx.cache_dir.join("thumbs");
                for (i, aid) in asset_ids.iter().enumerate() {
                    if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
                    if let Ok(a) = asset(c, *aid) {
                        let k = thumbs::key(&a.path, a.size, a.mtime, thumbs::EDGE);
                        let cached = thumbs::cache_file(&tdir, &k);
                        let h = if cached.is_file() { image::open(&cached).ok().map(|i| thumbs::dhash(&i)) }
                                else { thumbs::generate(&tdir, Path::new(&a.path), &a.kind, a.size, a.mtime, a.duration_ms, thumbs::EDGE).ok().and_then(|(_, h)| h) };
                        if let Some(h) = h { let _ = c.execute("UPDATE assets SET phash=? WHERE id=?", params![h as i64, a.id]); }
                    }
                    progress((i + 1) as f64 / n);
                }
            }
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&work);
    result.map(|_| out)
}

fn image_op(c: &Connection, a: &db::AssetRow, o: &ImageOps, out_dir: &Option<String>) -> Result<String, String> {
    let dir = out_dir_for(a, out_dir)?;
    let mut img = image::ImageReader::open(&a.path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?.decode().map_err(|e| format!("can't decode: {e}"))?;
    if let Some((Some(orient), _)) = media::read_exif_basic(Path::new(&a.path)) {
        img = match orient { 2 => img.fliph(), 3 => img.rotate180(), 4 => img.flipv(), 5 => img.rotate90().fliph(), 6 => img.rotate90(), 7 => img.rotate270().fliph(), 8 => img.rotate270(), _ => img };
    }
    let (w, h) = (img.width(), img.height());
    let target = if let Some(l) = o.resize_long { let s = l as f64 / w.max(h) as f64; Some(((w as f64 * s).round() as u32, (h as f64 * s).round() as u32)) }
                 else { o.scale_pct.filter(|p| (*p - 100.0).abs() > 0.01).map(|p| ((w as f64 * p / 100.0).round() as u32, (h as f64 * p / 100.0).round() as u32)) };
    if let Some((tw, th)) = target { img = img.resize_exact(tw.max(1), th.max(1), image::imageops::FilterType::Lanczos3); }
    img = match o.rotate.rem_euclid(360) { 90 => img.rotate90(), 180 => img.rotate180(), 270 => img.rotate270(), _ => img };
    if o.flip_h { img = img.fliph(); } if o.flip_v { img = img.flipv(); }
    let (stem, ext0) = ops::split_ext(&a.name);
    let fmt = if o.format.is_empty() || o.format == "keep" { ext0.to_lowercase() } else { o.format.clone() };
    let (ext, bytes) = encode(&img, &fmt, o.quality)?;
    let name = format!("{stem}{}.{ext}", if o.suffix.is_empty() { "_edit" } else { &o.suffix });
    let p = ops::write_atomic(&dir, &name, &bytes, false)?;
    let _ = scan::upsert_file(c, &p);
    Ok(p.to_string_lossy().into_owned())
}

pub fn encode(img: &image::DynamicImage, fmt: &str, quality: u8) -> Result<(&'static str, Vec<u8>), String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let ext = match fmt {
        "jpg" | "jpeg" | "jfif" => { let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8()); image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality.clamp(30, 100)).encode_image(&rgb).map_err(|e| e.to_string())?; "jpg" }
        "webp" => { img.write_to(&mut buf, image::ImageFormat::WebP).map_err(|e| e.to_string())?; "webp" }
        "bmp" => { img.write_to(&mut buf, image::ImageFormat::Bmp).map_err(|e| e.to_string())?; "bmp" }
        "tif" | "tiff" => { img.write_to(&mut buf, image::ImageFormat::Tiff).map_err(|e| e.to_string())?; "tif" }
        _ => { img.write_to(&mut buf, image::ImageFormat::Png).map_err(|e| e.to_string())?; "png" }
    };
    Ok((ext, buf.into_inner()))
}
