//! Persistent job queue: queued → running → done | failed | cancelled (| interrupted after a crash/exit).
use crate::db::{self, now_ms};
use crate::export::{self, Built, JoinInput, Preset, Project, QuickEdit};
use crate::{ai, byok, editmedia, media, models, ops, projects, render, scan, speech, thumbs};
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
    // ---- editor
    Optimize { path: String },
    AudioFx { path: String, fx: render::AudioFx },
    Reverse { path: String },
    Stabilize { path: String, strength: u32 },
    Transcribe { spec: speech::TranscribeSpec },
    InstallModel { id: String },
    Tts { provider: String, voice: String, text: String, speed: f64, project: String },
    AiImage { provider: String, prompt: String, aspect: String, project: String },
    AiVideo { provider: String, prompt: String, aspect: String, seconds: u32, image: Option<String>, project: String },
    StockDownload { url: String, name: String },
}
impl JobSpec {
    fn kind(&self) -> &'static str {
        match self { JobSpec::Quick { .. } => "export", JobSpec::Join { .. } => "join", JobSpec::ExtractAudio { .. } => "audio", JobSpec::Proxy { .. } => "proxy", JobSpec::Render { .. } => "render",
            JobSpec::Convert { .. } => "convert", JobSpec::ImageBatch { .. } => "images", JobSpec::CopyTo { .. } => "copy", JobSpec::Upscale { .. } => "upscale", JobSpec::Hashes { .. } => "analyse",
            JobSpec::Optimize { .. } => "prepare", JobSpec::AudioFx { .. } => "audiofx", JobSpec::Reverse { .. } => "reverse", JobSpec::Stabilize { .. } => "stabilize",
            JobSpec::Transcribe { .. } => "captions", JobSpec::InstallModel { .. } => "download", JobSpec::Tts { .. } => "voiceover", JobSpec::AiImage { .. } | JobSpec::AiVideo { .. } => "ai", JobSpec::StockDownload { .. } => "stock" }
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

pub struct Ctx { pub app: AppHandle, pub db_path: PathBuf, pub cache_dir: PathBuf, pub data_dir: PathBuf, pub projects_root: PathBuf }

#[derive(Clone)]
pub struct Jobs { inner: Arc<Inner> }
struct Inner { ctx: Ctx, cancels: Mutex<HashMap<i64, Arc<AtomicBool>>>, signal: (Mutex<bool>, Condvar), concurrency: AtomicUsize, running: AtomicUsize, lanes: Mutex<HashMap<&'static str, usize>> }

fn lane(kind: &str) -> &'static str { match kind { "prepare" => "prepare", "download" | "stock" => "download", _ => "main" } }

impl Jobs {
    pub fn start(ctx: Ctx, concurrency: usize) -> Jobs {
        if let Ok(c) = db::open(&ctx.db_path) {
            let _ = c.execute("UPDATE jobs SET status='interrupted', error='The app closed while this job was running. Retry to run it again.', finished_at=? WHERE status='running'", [now_ms()]);
        }
        let j = Jobs { inner: Arc::new(Inner { ctx, cancels: Mutex::new(HashMap::new()), signal: (Mutex::new(false), Condvar::new()), concurrency: AtomicUsize::new(concurrency.clamp(1, 8)), running: AtomicUsize::new(0), lanes: Mutex::new(HashMap::new()) }) };
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
            // Separate lanes so a preview never waits behind a 500 MB model download or a long export:
            // "prepare" (interactive previews) and "download" (network-bound) have their own slots.
            loop {
                let cap = |lane: &str| match lane { "prepare" => 2, "download" => 2, _ => self.inner.concurrency.load(Ordering::Relaxed) };
                let busy = self.inner.lanes.lock().unwrap().clone();
                let queued: Vec<(i64, String, String)> = c.prepare("SELECT id,params,kind FROM jobs WHERE status='queued' ORDER BY CASE kind WHEN 'prepare' THEN 0 ELSE 1 END, id LIMIT 200")
                    .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect()).unwrap_or_default();
                let Some((id, p, kind)) = queued.into_iter().find(|(_, _, k)| { let l = lane(k); busy.get(l).copied().unwrap_or(0) < cap(l) }) else { break };
                if c.execute("UPDATE jobs SET status='running', started_at=?, progress=0 WHERE id=? AND status='queued'", params![now_ms(), id]).unwrap_or(0) == 0 { continue; }
                let l = lane(&kind);
                *self.inner.lanes.lock().unwrap().entry(l).or_insert(0) += 1;
                self.inner.running.fetch_add(1, Ordering::SeqCst);
                let flag = Arc::new(AtomicBool::new(false));
                self.inner.cancels.lock().unwrap().insert(id, flag.clone());
                let me = self.clone();
                std::thread::spawn(move || {
                    me.run(id, &p, flag);
                    me.inner.running.fetch_sub(1, Ordering::SeqCst);
                    if let Some(n) = me.inner.lanes.lock().unwrap().get_mut(l) { *n = n.saturating_sub(1); }
                    me.inner.cancels.lock().unwrap().remove(&id); me.wake();
                });
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
            JobSpec::Optimize { path } => {
                let src = PathBuf::from(path);
                let info = editmedia::info(&ctx.cache_dir, &src)?;
                let target = editmedia::optimized_path(&ctx.cache_dir, &info.path, info.size, info.mtime, &info.kind);
                if !target.is_file() {
                    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
                    let ext = target.extension().unwrap().to_string_lossy().into_owned();
                    let tmp = target.with_extension(format!("partial.{ext}"));
                    check_space(target.parent().unwrap(), info.size * 3 + 50 * 1_048_576)?;
                    let args = editmedia::optimize_args(&src, &info, &tmp, &caps.hw_verified);
                    let r = export::run_ffmpeg(&args, info.duration_us.max(1), None, cancel, progress);
                    // a GPU encoder can fail on unusual sizes — retry once on the CPU
                    let r = match r { Err(e) if e != "cancelled" && args.iter().any(|a| a.contains("nvenc") || a.contains("qsv") || a.contains("amf")) => export::run_ffmpeg(&editmedia::optimize_args(&src, &info, &tmp, &[]), info.duration_us.max(1), None, cancel, progress), x => x };
                    r.inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
                    if info.kind != "image" { export::validate_output(&tmp, info.duration_us).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?; }
                    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
                }
                crate::editor_cmds::allow_path(&ctx.app, &target);
                out.outputs.push(target.to_string_lossy().into_owned());
                if let Some(r) = info.reason { out.notes.push(r); }
            }
            JobSpec::AudioFx { path, fx } => {
                let src = PathBuf::from(path);
                let md = std::fs::metadata(&src).map_err(|_| format!("Source file is missing: {path}"))?;
                let tag = fnv(&serde_json::to_string(fx).unwrap_or_default());
                let target = ctx.cache_dir.join("audiofx").join(format!("{}-{tag:016x}.m4a", thumbs::key(path, md.len() as i64, editmedia::mtime_ms(&md), 4)));
                if !target.is_file() {
                    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
                    let rnn = models::path_of(&ctx.data_dir, "rnnoise");
                    let tmp = target.with_extension("partial.m4a");
                    let args = render::audiofx_args(&src, fx, rnn.is_some(), &tmp)?;
                    let dur = probe_of(&src).ok().and_then(|p| p.duration_ms).unwrap_or(0) * 1000;
                    export::run_ffmpeg(&args, dur.max(1), rnn.as_deref().and_then(|p| p.parent()), cancel, progress).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
                    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
                    if fx.denoise && rnn.is_none() { out.notes.push("Used FFmpeg's built-in noise reduction. Install the RNNoise model in Settings → AI models for better results.".into()); }
                }
                crate::editor_cmds::allow_path(&ctx.app, &target);
                out.outputs.push(target.to_string_lossy().into_owned());
            }
            JobSpec::Reverse { path } => {
                let src = PathBuf::from(path);
                let info = editmedia::info(&ctx.cache_dir, &src)?;
                let target = ctx.cache_dir.join("reversed").join(format!("{}.mp4", thumbs::key(&info.path, info.size as i64, info.mtime, 5)));
                if !target.is_file() {
                    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
                    reverse_video(&src, &info, &work, &target, caps, cancel, progress)?;
                }
                crate::editor_cmds::allow_path(&ctx.app, &target);
                out.outputs.push(target.to_string_lossy().into_owned());
            }
            JobSpec::Stabilize { path, strength } => {
                let src = PathBuf::from(path);
                let info = editmedia::info(&ctx.cache_dir, &src)?;
                let s = (*strength).clamp(1, 3);
                let target = ctx.cache_dir.join("stabilized").join(format!("{}-s{s}.mp4", thumbs::key(&info.path, info.size as i64, info.mtime, 6)));
                if !target.is_file() {
                    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
                    if !caps.encoders.is_empty() && !export::has_filter("vidstabdetect") { return Err("This FFmpeg build has no stabilizer (libvidstab)".into()); }
                    let p1: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-vf", &format!("vidstabdetect=shakiness={}:accuracy=15:result=t.trf", 4 + s * 2), "-f", "null", "-"].iter().map(|s| s.to_string()).collect();
                    export::run_ffmpeg(&p1, info.duration_us.max(1), Some(&work), cancel, &mut |p| progress(p * 0.5))?;
                    let tmp = target.with_extension("partial.mp4");
                    let mut p2: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-map", "0:a:0?",
                        "-vf", &format!("vidstabtransform=input=t.trf:smoothing={}:optzoom=1:interpol=bicubic,unsharp=5:5:0.6:3:3:0.3,format=yuv420p", [10, 20, 35][s as usize - 1])].iter().map(|s| s.to_string()).collect();
                    let (va, _) = export::video_codec_args(&export::Preset { crf: 18, ..Default::default() }, caps)?;
                    p2.extend(va); p2.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), "-movflags".into(), "+faststart".into(), tmp.to_string_lossy().into_owned()]);
                    export::run_ffmpeg(&p2, info.duration_us.max(1), Some(&work), cancel, &mut |p| progress(0.5 + p * 0.5)).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
                    export::validate_output(&tmp, info.duration_us).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
                    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
                }
                crate::editor_cmds::allow_path(&ctx.app, &target);
                out.outputs.push(target.to_string_lossy().into_owned());
            }
            JobSpec::Transcribe { spec } => {
                let (segs, lang) = speech::transcribe(&ctx.data_dir, &work, spec, cancel, progress)?;
                if segs.is_empty() { return Err("No speech was detected in this audio.".into()); }
                let dir = ctx.cache_dir.join("transcripts"); std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let f = dir.join(format!("job{id}.json"));
                std::fs::write(&f, serde_json::to_vec(&serde_json::json!({"language": lang, "segments": segs})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                out.outputs.push(f.to_string_lossy().into_owned());
                out.notes.push(format!("{} caption lines · language: {lang}", segs.len()));
            }
            JobSpec::InstallModel { id: mid } => {
                out.notes.push(models::install(&ctx.data_dir, mid, cancel, progress)?);
            }
            JobSpec::Tts { provider, voice, text, speed, project } => {
                let dir = projects::assets_dir(&ctx.projects_root, project)?;
                let stamp = db::now_ms();
                let p = if provider == "piper" {
                    let f = ops::unique_path(&dir, &format!("voiceover-{stamp}.wav"));
                    speech::piper(&ctx.data_dir, voice, text, *speed, &f)?; f
                } else {
                    let conn = byok::connect(provider, &crate::editor_cmds::byok_cfg(c, provider))?;
                    let g = byok::tts(&conn, text, voice)?;
                    ops::write_atomic(&dir, &format!("voiceover-{stamp}.{}", g.ext), &g.bytes, false)?
                };
                crate::editor_cmds::allow_path(&ctx.app, &p);
                out.outputs.push(p.to_string_lossy().into_owned());
            }
            JobSpec::AiImage { provider, prompt, aspect, project } => {
                let conn = byok::connect(provider, &crate::editor_cmds::byok_cfg(c, provider))?;
                let g = byok::image(&conn, prompt, aspect, cancel, progress)?;
                let dir = projects::assets_dir(&ctx.projects_root, project)?;
                let p = ops::write_atomic(&dir, &format!("ai-image-{}.{}", db::now_ms(), g.ext), &g.bytes, false)?;
                crate::editor_cmds::allow_path(&ctx.app, &p);
                out.outputs.push(p.to_string_lossy().into_owned());
            }
            JobSpec::AiVideo { provider, prompt, aspect, seconds, image, project } => {
                let conn = byok::connect(provider, &crate::editor_cmds::byok_cfg(c, provider))?;
                let img = image.as_ref().map(PathBuf::from);
                let g = byok::video(&conn, prompt, aspect, *seconds, img.as_deref(), cancel, progress)?;
                let dir = projects::assets_dir(&ctx.projects_root, project)?;
                let p = ops::write_atomic(&dir, &format!("ai-video-{}.{}", db::now_ms(), g.ext), &g.bytes, false)?;
                crate::editor_cmds::allow_path(&ctx.app, &p);
                out.outputs.push(p.to_string_lossy().into_owned());
            }
            JobSpec::StockDownload { url, name } => {
                let dir = ctx.projects_root.parent().map(|p| p.join("Stock")).ok_or("no stock folder")?;
                let safe: String = name.chars().map(|ch| if "<>:\"/\\|?*".contains(ch) || ch.is_control() { '_' } else { ch }).collect::<String>().trim().trim_end_matches('.').chars().take(120).collect();
                let safe = if ops::validate_filename(&safe).is_ok() { safe } else { format!("stock-{}.bin", db::now_ms()) };
                let p = byok::download_to(url, &dir, &safe, cancel)?;
                crate::editor_cmds::allow_path(&ctx.app, &p);
                out.outputs.push(p.to_string_lossy().into_owned());
            }
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&work);
    result.map(|_| out)
}

fn fnv(s: &str) -> u64 { s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3)) }

/// Reverse a video in 4-second chunks (FFmpeg's `reverse` buffers whole inputs in RAM), then join the reversed
/// chunks in reverse order without re-encoding.
fn reverse_video(src: &Path, info: &editmedia::MediaInfo, work: &Path, target: &Path, caps: &export::Caps, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64)) -> Result<(), String> {
    let dur = info.duration_us.max(1);
    let chunk = 4_000_000i64;
    let n = ((dur + chunk - 1) / chunk).max(1);
    let (va, _) = export::video_codec_args(&Preset { crf: 18, ..Default::default() }, caps)?;
    let mut parts = vec![];
    for k in 0..n {
        if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
        let part = work.join(format!("rev{k:05}.mp4"));
        let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-loglevel", "error"].iter().map(|s| s.to_string()).collect();
        a.extend(["-ss".into(), format!("{:.6}", (k * chunk) as f64 / 1e6), "-t".into(), format!("{:.6}", chunk as f64 / 1e6), "-i".into(), src.to_string_lossy().into_owned(), "-map".into(), "0:v:0".into()]);
        if info.has_audio { a.extend(["-map".into(), "0:a:0".into(), "-af".into(), "areverse,aformat=sample_rates=48000:channel_layouts=stereo".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]); }
        a.extend(["-vf".into(), "reverse,format=yuv420p".into()]); a.extend(va.clone());
        a.push(part.to_string_lossy().into_owned());
        let kk = k as f64; let nn = n as f64;
        export::run_ffmpeg(&a, chunk, None, cancel, &mut |p| progress(((kk + p) / nn) * 0.95))?;
        parts.push(part);
    }
    let list = work.join("rev.txt");
    std::fs::write(&list, parts.iter().rev().map(|p| export::concat_list_line(p)).collect::<String>()).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("partial.mp4");
    let a: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into(), "-loglevel".into(), "error".into(), "-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), list.to_string_lossy().into_owned(), "-c".into(), "copy".into(), "-movflags".into(), "+faststart".into(), tmp.to_string_lossy().into_owned()];
    export::run_ffmpeg(&a, dur, None, cancel, &mut |_| {}).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
    export::validate_output(&tmp, dur).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
    std::fs::rename(&tmp, target).map_err(|e| e.to_string())?;
    progress(1.0);
    Ok(())
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
