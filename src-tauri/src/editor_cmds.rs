//! Commands for the timeline editor (projects, media, export sessions, AI, stock, fonts).
use crate::{byok, db, editmedia, jobs, models, projects, render, speech, AppState};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Response, AppHandle, Manager, State};

type R<T> = Result<T, String>;
fn e2s<E: std::fmt::Display>(e: E) -> String { e.to_string() }

// ---------------------------------------------------------------- read access control

/// Paths the UI may read through `read_range` / waveform / filmstrip: library folders, the cache, the projects
/// folder and files the user explicitly imported (dialog or drag & drop) or that a project references.
#[derive(Default)]
pub struct Allow { roots: Vec<String>, files: HashSet<String> }

fn norm(p: &Path) -> String {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s).replace('/', "\\").to_lowercase()
}
impl Allow {
    pub fn add_root(&mut self, p: &Path) { let n = norm(p); if !self.roots.contains(&n) { self.roots.push(n); } }
    pub fn add_file(&mut self, p: &Path) { self.files.insert(norm(p)); }
    pub fn check(&self, p: &Path) -> R<PathBuf> {
        let n = norm(p);
        if self.files.contains(&n) || self.roots.iter().any(|r| n.starts_with(&format!("{}\\", r.trim_end_matches('\\'))) || &n == r) { return Ok(p.to_path_buf()); }
        Err("Media Studio Pro doesn't have access to this file. Import it again (Media → Import).".into())
    }
}
pub type AllowState = Mutex<Allow>;

pub fn allow_path(app: &AppHandle, p: &Path) { allow_file(app, p) }
fn allow_file(app: &AppHandle, p: &Path) {
    app.state::<AllowState>().lock().unwrap().add_file(p);
    let _ = app.asset_protocol_scope().allow_file(p);
}
fn checked(app: &AppHandle, path: &str) -> R<PathBuf> { app.state::<AllowState>().lock().unwrap().check(Path::new(path)) }

// ---------------------------------------------------------------- projects

#[tauri::command]
pub fn projects_list(s: State<AppState>) -> Vec<projects::Meta> { projects::list(&s.projects_root) }
#[tauri::command]
pub fn projects_dir(s: State<AppState>) -> String { s.projects_root.to_string_lossy().into_owned() }
#[tauri::command]
pub fn project_create(s: State<AppState>, name: String, data: Value) -> R<projects::Meta> { std::fs::create_dir_all(&s.projects_root).map_err(e2s)?; projects::create(&s.projects_root, &name, &data) }
#[tauri::command]
pub fn project_load(app: AppHandle, s: State<AppState>, id: String) -> R<Value> {
    let v = projects::load(&s.projects_root, &id)?;
    for p in projects::media_paths(&v) { allow_file(&app, Path::new(&p)); }
    Ok(v)
}
#[tauri::command]
pub async fn project_save(app: AppHandle, id: String, data: Value) -> R<projects::Meta> {
    tauri::async_runtime::spawn_blocking(move || { let s = app.state::<AppState>(); projects::save(&s.projects_root, &id, &data) }).await.map_err(e2s)?
}
#[tauri::command]
pub fn project_rename(s: State<AppState>, id: String, name: String) -> R<projects::Meta> { projects::rename(&s.projects_root, &id, &name) }
#[tauri::command]
pub fn project_duplicate(s: State<AppState>, id: String) -> R<projects::Meta> { projects::duplicate(&s.projects_root, &id) }
#[tauri::command]
pub fn project_delete(s: State<AppState>, ids: Vec<String>) -> R<usize> { let mut n = 0; for id in ids { projects::delete(&s.projects_root, &id)?; n += 1; } Ok(n) }
#[tauri::command]
pub fn project_cover(s: State<AppState>, request: tauri::ipc::Request) -> R<String> {
    let tauri::ipc::InvokeBody::Raw(b) = request.body() else { return Err("expected image bytes".into()) };
    let id = request.headers().get("x-project").and_then(|v| v.to_str().ok()).ok_or("missing project")?;
    projects::set_cover(&s.projects_root, id, b)
}
#[tauri::command]
pub fn project_reveal(s: State<AppState>, id: String) -> R<()> { projects::valid_id(&id)?; crate::ops::reveal(&s.projects_root.join(&id).join("project.json")) }
#[tauri::command]
pub fn project_assets_dir(s: State<AppState>, id: String) -> R<String> { projects::assets_dir(&s.projects_root, &id).map(|p| p.to_string_lossy().into_owned()) }

// ---------------------------------------------------------------- media

#[derive(Serialize)]
pub struct ImportResult { pub ok: Vec<editmedia::MediaInfo>, pub errors: Vec<String> }

#[tauri::command]
pub async fn editor_import(app: AppHandle, paths: Vec<String>) -> R<ImportResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.state::<AppState>().cache_dir.clone();
        let mut res = ImportResult { ok: vec![], errors: vec![] };
        let mut files: Vec<PathBuf> = vec![];
        for p in paths.iter().take(2000) {
            let pb = PathBuf::from(p);
            if pb.is_dir() { for e in walkdir::WalkDir::new(&pb).max_depth(3).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()) { let ext = e.path().extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default(); if crate::media::classify(&ext).is_some() { files.push(e.into_path()); } } }
            else { files.push(pb); }
        }
        for f in files.into_iter().take(2000) {
            match editmedia::info(&cache, &f) { Ok(i) => { allow_file(&app, &f); if let Some(o) = &i.optimized { allow_file(&app, Path::new(o)); } res.ok.push(i) } Err(e) => res.errors.push(format!("{}: {e}", f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())) }
        }
        Ok(res)
    }).await.map_err(e2s)?
}

#[tauri::command]
pub async fn editor_info(app: AppHandle, path: String) -> R<editmedia::MediaInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = checked(&app, &path)?;
        let i = editmedia::info(&app.state::<AppState>().cache_dir, &p)?;
        if let Some(o) = &i.optimized { allow_file(&app, Path::new(o)); }
        Ok(i)
    }).await.map_err(e2s)?
}

/// Queue an optimized copy (deduplicated: an existing queued/running job for the same file is returned).
#[tauri::command]
pub fn editor_optimize(app: AppHandle, s: State<AppState>, path: String) -> R<i64> {
    let p = checked(&app, &path)?;
    let c = s.conn();
    let spec = jobs::JobSpec::Optimize { path: p.to_string_lossy().into_owned() };
    let pj = serde_json::to_string(&spec).map_err(e2s)?;
    if let Ok(id) = c.query_row("SELECT id FROM jobs WHERE params=? AND status IN ('queued','running') LIMIT 1", [&pj], |r| r.get::<_, i64>(0)) { return Ok(id); }
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    s.jobs.enqueue(&c, spec, format!("Prepare for editing: {name}"))
}

#[tauri::command]
pub async fn editor_waveform(app: AppHandle, path: String) -> R<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = checked(&app, &path)?;
        let md = std::fs::metadata(&p).map_err(e2s)?;
        editmedia::waveform(&app.state::<AppState>().cache_dir, &p, md.len(), editmedia::mtime_ms(&md)).map(Response::new)
    }).await.map_err(e2s)?
}

#[tauri::command]
pub async fn editor_filmstrip(app: AppHandle, path: String, duration_us: i64, width: i64, height: i64) -> R<editmedia::Filmstrip> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = checked(&app, &path)?;
        let md = std::fs::metadata(&p).map_err(e2s)?;
        let f = editmedia::filmstrip(&app.state::<AppState>().cache_dir, &p, md.len(), editmedia::mtime_ms(&md), duration_us, width, height)?;
        Ok(f)
    }).await.map_err(e2s)?
}

/// Byte range of an allowed media file (the export decoder's input). `end` is exclusive.
#[tauri::command]
pub async fn read_range(app: AppHandle, path: String, start: u64, end: u64) -> R<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let p = checked(&app, &path)?;
        if end <= start || end - start > 64 * 1_048_576 { return Err("bad range".into()); }
        let mut f = std::fs::File::open(&p).map_err(e2s)?;
        let len = f.metadata().map_err(e2s)?.len();
        let end = end.min(len);
        if start >= end { return Ok(Response::new(vec![])); }
        f.seek(SeekFrom::Start(start)).map_err(e2s)?;
        let mut buf = vec![0u8; (end - start) as usize];
        f.read_exact(&mut buf).map_err(e2s)?;
        Ok(Response::new(buf))
    }).await.map_err(e2s)?
}
#[tauri::command]
pub fn file_size(app: AppHandle, path: String) -> R<u64> { let p = checked(&app, &path)?; std::fs::metadata(p).map(|m| m.len()).map_err(e2s) }

/// Frame-exact PNG of a source at `time_us` into the project's assets (freeze frame, snapshot, cover).
#[tauri::command]
pub async fn editor_frame_png(app: AppHandle, path: String, time_us: i64, project: String) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = checked(&app, &path)?;
        let dir = projects::assets_dir(&app.state::<AppState>().projects_root, &project)?;
        let stem = p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or("frame".into());
        let out = crate::ops::unique_path(&dir, &format!("{stem}_freeze_{:.2}s.png", time_us as f64 / 1e6));
        let args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-ss".into(), format!("{:.6}", time_us.max(0) as f64 / 1e6), "-i".into(), p.to_string_lossy().into_owned(), "-map".into(), "0:v:0".into(), "-frames:v".into(), "1".into(), "-y".into(), out.to_string_lossy().into_owned()];
        crate::media::run_capture(crate::media::ffmpeg_path()?, &args)?;
        if !out.is_file() { return Err("No frame at that position".into()); }
        allow_file(&app, &out);
        Ok(out.to_string_lossy().into_owned())
    }).await.map_err(e2s)?
}

/// Save bytes produced in the editor (recordings, AI-matted images) into the project's assets folder.
#[tauri::command]
pub fn project_write_asset(app: AppHandle, s: State<AppState>, request: tauri::ipc::Request) -> R<String> {
    let tauri::ipc::InvokeBody::Raw(b) = request.body() else { return Err("expected bytes".into()) };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(crate::pct_decode);
    let id = h("x-project").ok_or("missing project")?; let name = h("x-name").ok_or("missing name")?;
    let ext = Path::new(&name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["webm", "wav", "mp3", "m4a", "ogg", "png", "jpg", "jpeg", "webp", "srt", "vtt", "txt", "json", "mp4"].contains(&ext.as_str()) { return Err("Unsupported file type".into()); }
    let dir = projects::assets_dir(&s.projects_root, &id)?;
    let p = crate::ops::write_atomic(&dir, &name, b, false)?;
    allow_file(&app, &p);
    Ok(p.to_string_lossy().into_owned())
}

/// Write a text export (SRT/VTT/TXT captions, script) to a path chosen in a native save dialog.
#[tauri::command]
pub fn save_text_as(path: String, contents: String) -> R<()> {
    let p = PathBuf::from(&path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["srt", "vtt", "txt", "json", "csv", "md"].contains(&ext.as_str()) { return Err("Unsupported file type".into()); }
    let dir = p.parent().ok_or("bad path")?;
    crate::ops::write_atomic(dir, &p.file_name().unwrap().to_string_lossy(), contents.as_bytes(), true).map(|_| ())
}
#[tauri::command]
pub fn read_text_file(app: AppHandle, path: String) -> R<String> {
    let p = PathBuf::from(&path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["srt", "vtt", "txt", "cube", "msproj", "json", "lrc"].contains(&ext.as_str()) { return Err("Unsupported file type".into()); }
    let md = std::fs::metadata(&p).map_err(e2s)?; if md.len() > 50_000_000 { return Err("File is too large".into()); }
    allow_file(&app, &p);
    let b = std::fs::read(&p).map_err(e2s)?; Ok(String::from_utf8_lossy(&b).into_owned())
}

// ---------------------------------------------------------------- export sessions

#[derive(Serialize)]
pub struct Started { pub id: u64, pub encoder: String }

#[tauri::command]
pub async fn render_start(app: AppHandle, spec: render::RenderSpec) -> R<Started> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let work = s.cache_dir.join("work").join("render");
        let cancel = Arc::new(AtomicBool::new(false));
        let a2 = app.clone();
        let (id, encoder) = render::start(&s.renders, &spec, &work, &cancel, &mut |p| { let _ = tauri::Emitter::emit(&a2, "render-audio", p); })?;
        Ok(Started { id, encoder })
    }).await.map_err(e2s)?
}
#[tauri::command]
pub async fn render_push(app: AppHandle, request: tauri::ipc::Request<'_>) -> R<i64> {
    let tauri::ipc::InvokeBody::Raw(b) = request.body() else { return Err("expected frame bytes".into()) };
    let id: u64 = request.headers().get("x-session").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).ok_or("missing session")?;
    let bytes = b.clone();
    tauri::async_runtime::spawn_blocking(move || render::push(&app.state::<AppState>().renders, id, &bytes)).await.map_err(e2s)?
}
#[tauri::command]
pub async fn render_finish(app: AppHandle, id: u64) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let p = render::finish(&s.renders, id)?;
        let pb = PathBuf::from(&p);
        allow_file(&app, &pb);
        let _ = crate::scan::upsert_file(&s.conn(), &pb);
        Ok(p)
    }).await.map_err(e2s)?
}
#[tauri::command]
pub fn render_cancel(s: State<AppState>, id: u64) { render::cancel(&s.renders, id) }

/// Audio-only export (MP3 / WAV / M4A / FLAC) of the timeline mix.
#[tauri::command]
pub async fn render_audio(app: AppHandle, plan: render::AudioPlan, out_dir: String, name: String) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::ops::validate_filename(&name)?;
        let dir = PathBuf::from(&out_dir);
        let cache = app.state::<AppState>().cache_dir.clone();
        if dir.starts_with(&cache) { let _ = std::fs::create_dir_all(&dir); }
        if !dir.is_dir() { return Err("Output folder does not exist".into()); }
        let target = crate::ops::unique_path(&dir, &name);
        let (stem, ext) = crate::ops::split_ext(target.file_name().unwrap().to_str().unwrap_or("audio.mp3"));
        let tmp = dir.join(format!("{stem}.partial.{ext}"));
        let cancel = Arc::new(AtomicBool::new(false));
        crate::export::run_ffmpeg(&render::build_mix(&plan, &tmp), plan.duration_us, None, &cancel, &mut |_| {}).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
        crate::export::validate_output(&tmp, plan.duration_us).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
        std::fs::rename(&tmp, &target).map_err(e2s)?;
        allow_file(&app, &target);
        Ok(target.to_string_lossy().into_owned())
    }).await.map_err(e2s)?
}

/// Built-in sound effects, synthesised once with FFmpeg into the cache (no third-party samples).
#[tauri::command]
pub async fn sfx_library(app: AppHandle) -> R<Vec<(String, String)>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.state::<AppState>().cache_dir.join("sfx");
        std::fs::create_dir_all(&dir).map_err(e2s)?;
        const L: &[(&str, &str, &str)] = &[
            ("whoosh", "Whoosh", "anoisesrc=d=0.8:c=pink:a=0.6,highpass=f='300',lowpass=f=4000,afade=t=in:d=0.35,afade=t=out:st=0.35:d=0.45,aphaser=speed=2"),
            ("swoosh", "Swoosh (fast)", "anoisesrc=d=0.4:c=white:a=0.5,bandpass=f=2500:w=1800,afade=t=in:d=0.12,afade=t=out:st=0.12:d=0.28"),
            ("pop", "Pop", "sine=f=900:d=0.09,afade=t=out:d=0.09,volume=0.8"),
            ("click", "Click", "sine=f=2400:d=0.02,afade=t=out:d=0.02"),
            ("ding", "Ding", "sine=f=1318:d=1.2,afade=t=out:d=1.2,aecho=0.6:0.4:60:0.3"),
            ("chime", "Chime", "sine=f=880:d=0.9[a];sine=f=1320:d=0.9[b];[a][b]amix=inputs=2,afade=t=out:d=0.9"),
            ("riser", "Riser", "sine=f=200:d=2,vibrato=f=12:d=0.3,asetrate=48000*1.0,afade=t=in:d=1.8,afade=t=out:st=1.85:d=0.15,aphaser"),
            ("boom", "Boom (impact)", "sine=f=55:d=1.4,afade=t=out:d=1.4,volume=1.6,acrusher=bits=10:mix=0.2"),
            ("hit", "Cinematic hit", "anoisesrc=d=1:c=brown:a=0.9,lowpass=f=300,afade=t=out:d=1,volume=2"),
            ("glitch", "Glitch", "anoisesrc=d=0.5:c=white:a=0.6,acrusher=bits=4:samples=12:mix=1,tremolo=f=30:d=0.9"),
            ("typing", "Typing", "anoisesrc=d=1.5:c=white:a=0.4,highpass=f=2000,tremolo=f=12:d=1,afade=t=out:st=1.3:d=0.2"),
            ("shutter", "Camera shutter", "anoisesrc=d=0.12:c=white:a=0.7,highpass=f=1500,afade=t=out:d=0.12"),
            ("notify", "Notification", "sine=f=1046:d=0.15[a];sine=f=1568:d=0.25[b];[a][b]concat=n=2:v=0:a=1,afade=t=out:st=0.2:d=0.2"),
            ("wrong", "Wrong buzzer", "sine=f=140:d=0.6,acrusher=bits=6:mix=0.5,afade=t=out:st=0.45:d=0.15"),
            ("heartbeat", "Heartbeat", "sine=f=50:d=0.15,afade=t=out:d=0.15,apad=pad_dur=0.12[a];sine=f=48:d=0.15,afade=t=out:d=0.15,apad=pad_dur=0.6[b];[a][b]concat=n=2:v=0:a=1,volume=2"),
            ("drumroll", "Drum roll", "anoisesrc=d=2:c=pink:a=0.6,lowpass=f=900,tremolo=f=18:d=0.8,afade=t=in:d=1.5"),
        ];
        let mut out = vec![];
        for (id, name, graph) in L {
            let f = dir.join(format!("{id}.wav"));
            if !f.is_file() {
                let args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-f".into(), "lavfi".into(), "-i".into(), graph.to_string(), "-ar".into(), "48000".into(), "-ac".into(), "2".into(), "-y".into(), f.to_string_lossy().into_owned()];
                if crate::media::run_capture(crate::media::ffmpeg_path()?, &args).is_err() { continue; }
            }
            allow_file(&app, &f);
            out.push((name.to_string(), f.to_string_lossy().into_owned()));
        }
        Ok(out)
    }).await.map_err(e2s)?
}

/// Silent intervals (µs) in a file's audio, for "remove silences".
#[tauri::command]
pub async fn detect_silence(app: AppHandle, path: String, noise_db: f64, min_us: i64) -> R<Vec<(i64, i64)>> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = checked(&app, &path)?;
        let nd = noise_db.clamp(-80.0, -10.0); let md = (min_us.max(100_000) as f64) / 1e6;
        let args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-i".into(), p.to_string_lossy().into_owned(), "-map".into(), "0:a:0".into(), "-af".into(), format!("silencedetect=noise={nd:.1}dB:d={md:.3}"), "-f".into(), "null".into(), "-".into()];
        let o = crate::media::command(crate::media::ffmpeg_path()?).args(&args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).output().map_err(e2s)?;
        let txt = String::from_utf8_lossy(&o.stderr);
        let mut v = vec![]; let mut start: Option<f64> = None;
        for l in txt.lines() {
            if let Some(i) = l.find("silence_start: ") { start = l[i + 15..].split_whitespace().next().and_then(|x| x.parse().ok()); }
            if let Some(i) = l.find("silence_end: ") { if let (Some(s), Some(e)) = (start.take(), l[i + 13..].split_whitespace().next().and_then(|x| x.parse::<f64>().ok())) { v.push(((s.max(0.0) * 1e6) as i64, (e * 1e6) as i64)); } }
        }
        Ok(v)
    }).await.map_err(e2s)?
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> R<()> { let p = checked(&app, &path)?; crate::ops::reveal(&p) }
#[tauri::command]
pub fn open_path_default(app: AppHandle, path: String) -> R<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = checked(&app, &path)?;
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(e2s)
}

#[tauri::command]
pub fn voice_effects() -> Vec<(&'static str, &'static str)> { render::VOICES.to_vec() }

// ---------------------------------------------------------------- AI models & speech

#[tauri::command]
pub fn models_status(s: State<AppState>) -> Vec<models::Status> { models::status(&s.data_dir) }
#[tauri::command]
pub fn model_install(s: State<AppState>, id: String) -> R<i64> {
    let d = models::def(&id).ok_or("Unknown model")?;
    let c = s.conn();
    let spec = jobs::JobSpec::InstallModel { id: id.clone() };
    let pj = serde_json::to_string(&spec).map_err(e2s)?;
    if let Ok(j) = c.query_row("SELECT id FROM jobs WHERE params=? AND status IN ('queued','running') LIMIT 1", [&pj], |r| r.get::<_, i64>(0)) { return Ok(j); }
    s.jobs.enqueue(&c, spec, format!("Download {}", d.name))
}
/// Bytes of an installed ONNX model (background removal, vocal separation) for in-app GPU inference.
#[tauri::command]
pub async fn model_bytes(app: AppHandle, id: String) -> R<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = app.state::<AppState>().data_dir.clone();
        let d = models::def(&id).ok_or("Unknown model")?;
        if !d.marker.ends_with(".onnx") { return Err("Not an ONNX model".into()); }
        let p = models::path_of(&data, &id).ok_or_else(|| format!("{} isn't installed. Install it in Settings → AI models.", d.name))?;
        std::fs::read(p).map(Response::new).map_err(e2s)
    }).await.map_err(e2s)?
}
#[tauri::command]
pub fn model_remove(s: State<AppState>, id: String) -> R<()> { models::remove(&s.data_dir, &id) }
#[tauri::command]
pub fn speech_voices(s: State<AppState>) -> Vec<speech::Voice> { speech::voices(&s.data_dir) }

// ---------------------------------------------------------------- BYOK

#[derive(Serialize)]
pub struct ProviderRow { #[serde(flatten)] pub p: byok::Provider, pub has_key: bool, pub cfg: byok::Cfg }

pub fn byok_cfg(c: &rusqlite::Connection, id: &str) -> byok::Cfg { db::get_setting(c, &format!("byok.{id}")).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default() }

#[tauri::command]
pub async fn byok_providers(app: AppHandle) -> R<Vec<ProviderRow>> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>(); let c = s.conn();
        Ok(byok::PROVIDERS.iter().map(|p| ProviderRow { p: p.clone(), has_key: !p.needs_key || byok::has_key(p.id), cfg: byok_cfg(&c, p.id) }).collect())
    }).await.map_err(e2s)?
}
#[tauri::command]
pub fn byok_set(s: State<AppState>, id: String, key: Option<String>, cfg: Option<byok::Cfg>) -> R<()> {
    byok::provider(&id)?;
    if let Some(k) = key { byok::set_key(&id, &k)?; }
    if let Some(cfg) = cfg {
        for v in [&cfg.base, &cfg.model, &cfg.image_model, &cfg.video_model, &cfg.tts_model] { if v.len() > 300 || v.chars().any(|c| c.is_control()) { return Err("Invalid setting".into()); } }
        db::set_setting(&s.conn(), &format!("byok.{id}"), &serde_json::to_string(&cfg).map_err(e2s)?).map_err(e2s)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn ai_chat(app: AppHandle, provider: String, system: String, prompt: String) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = { let s = app.state::<AppState>(); let c = s.conn(); byok_cfg(&c, &provider) };
        let conn = byok::connect(&provider, &cfg)?;
        byok::chat(&conn, &system, &prompt)
    }).await.map_err(e2s)?
}
#[tauri::command]
pub async fn stock_search(provider: String, kind: String, query: String, page: u32) -> R<Vec<byok::StockItem>> {
    tauri::async_runtime::spawn_blocking(move || byok::stock_search(&provider, &kind, &query, page)).await.map_err(e2s)?
}

// ---------------------------------------------------------------- fonts

#[derive(Serialize, Clone)]
pub struct FontFile { pub family: String, pub style: String, pub path: String }

/// Installed fonts (system + per-user), with family names read from each font's name table.
#[tauri::command]
pub async fn system_fonts(app: AppHandle) -> R<Vec<FontFile>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dirs = vec![PathBuf::from(std::env::var("WINDIR").unwrap_or("C:\\Windows".into())).join("Fonts")];
        if let Ok(l) = std::env::var("LOCALAPPDATA") { dirs.push(PathBuf::from(l).join("Microsoft\\Windows\\Fonts")); }
        let mut out = vec![];
        for d in dirs {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            let _ = app.asset_protocol_scope().allow_directory(&d, false);
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                if !["ttf", "otf"].contains(&ext.as_str()) { continue; }
                let Ok(b) = std::fs::read(&p) else { continue };
                let Ok(face) = ttf_parser::Face::parse(&b, 0) else { continue };
                let name = |id: u16| face.names().into_iter().filter(|n| n.name_id == id && n.is_unicode()).find_map(|n| n.to_string());
                let fam = name(16).or_else(|| name(1)); let sub = name(17).or_else(|| name(2)).unwrap_or("Regular".into());
                if let Some(f) = fam { out.push(FontFile { family: f, style: sub, path: p.to_string_lossy().into_owned() }); }
            }
        }
        out.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()).then(a.style.cmp(&b.style)));
        out.dedup_by(|a, b| a.family == b.family && a.style == b.style);
        Ok(out)
    }).await.map_err(e2s)?
}

#[tauri::command]
pub fn editor_env(s: State<AppState>) -> Value {
    json!({ "projects": s.projects_root, "cache": s.cache_dir, "stock": s.projects_root.parent().map(|p| p.join("Stock")), "hw": crate::export::caps().hw_verified })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn allowlist_scopes_reads() {
        let t = tempfile::tempdir().unwrap();
        let lib = t.path().join("Lib"); std::fs::create_dir_all(lib.join("sub")).unwrap();
        let inside = lib.join("sub").join("a.mp4"); std::fs::write(&inside, b"x").unwrap();
        let sibling = t.path().join("Library2.mp4"); std::fs::write(&sibling, b"x").unwrap();
        let other = t.path().join("secret.txt"); std::fs::write(&other, b"x").unwrap();
        let mut a = Allow::default(); a.add_root(&lib);
        assert!(a.check(&inside).is_ok());
        assert!(a.check(&other).is_err());
        assert!(a.check(&sibling).is_err(), "a prefix match on the folder name must not grant access");
        assert!(a.check(&lib.join("sub").join("..").join("..").join("secret.txt")).is_err(), "traversal is resolved before checking");
        a.add_file(&other); assert!(a.check(&other).is_ok());
    }
}
