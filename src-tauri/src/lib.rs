//! Media Studio Pro — native core. The UI talks to this only through the commands registered below.
mod ai;
mod byok;
mod db;
mod editmedia;
mod editor_cmds;
mod export;
mod jobs;
mod media;
mod models;
mod ops;
mod projects;
mod render;
mod scan;
mod speech;
mod thumbs;

use db::{now_ms, Query};
use rusqlite::{params, types::Value, Connection};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};

type R<T> = Result<T, String>;
fn e2s<E: std::fmt::Display>(e: E) -> String { e.to_string() }

pub struct AppState {
    db: Mutex<Connection>,
    db_path: PathBuf,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    thumbs: thumbs::Pool,
    jobs: jobs::Jobs,
    probe_signal: Arc<(Mutex<bool>, Condvar)>,
    renders: render::Sessions,
    projects_root: PathBuf,
}
impl AppState {
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> { self.db.lock().unwrap_or_else(|p| p.into_inner()) }
    fn wake_prober(&self) { let (m, cv) = &*self.probe_signal; *m.lock().unwrap() = true; cv.notify_all(); }
}

// ================================================================ libraries

#[tauri::command]
fn list_libraries(s: State<AppState>) -> R<Vec<db::Library>> { db::list_libraries(&s.conn()).map_err(e2s) }

#[tauri::command]
fn add_library(app: AppHandle, s: State<AppState>, path: String) -> R<i64> {
    let p = PathBuf::from(&path);
    if !p.is_dir() { return Err("That folder does not exist or is not accessible.".into()); }
    let p = dunce_canon(&p);
    let ps = p.to_string_lossy().into_owned();
    let id = {
        let mut c = s.conn();
        let libs = db::list_libraries(&c).map_err(e2s)?;
        if let Some(l) = libs.iter().find(|l| p.starts_with(&l.path)) { return Err(format!("This folder is already part of the library “{}”.", l.name)); }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| ps.clone());
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(e2s)?;
        tx.execute("INSERT INTO libraries(path,name,added_at) VALUES(?,?,?)", params![ps, name, now_ms()]).map_err(e2s)?;
        let id = tx.last_insert_rowid();
        // a parent folder absorbs libraries that were inside it (annotations kept)
        for inner in libs.iter().filter(|l| Path::new(&l.path).starts_with(&p)) {
            tx.execute("UPDATE assets SET library_id=? WHERE library_id=?", params![id, inner.id]).map_err(e2s)?;
            tx.execute("DELETE FROM libraries WHERE id=?", [inner.id]).map_err(e2s)?;
        }
        tx.commit().map_err(e2s)?;
        id
    };
    let _ = app.asset_protocol_scope().allow_directory(&p, true);
    app.state::<editor_cmds::AllowState>().lock().unwrap().add_root(&p);
    start_scan(app, id, p);
    Ok(id)
}

fn dunce_canon(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") { if !rest.starts_with("UNC") { return PathBuf::from(rest); } }
    c
}

#[tauri::command]
fn remove_library(s: State<AppState>, id: i64) -> R<()> {
    s.conn().execute("DELETE FROM libraries WHERE id=?", [id]).map(|_| ()).map_err(e2s) // catalogue only; files untouched
}

#[tauri::command]
fn rescan_library(app: AppHandle, s: State<AppState>, id: i64) -> R<()> {
    let path: String = s.conn().query_row("SELECT path FROM libraries WHERE id=?", [id], |r| r.get(0)).map_err(e2s)?;
    if !Path::new(&path).is_dir() { return Err(format!("“{path}” is offline or was removed. Reconnect the drive and try again.")); }
    start_scan(app, id, PathBuf::from(path));
    Ok(())
}

fn start_scan(app: AppHandle, id: i64, root: PathBuf) {
    std::thread::spawn(move || {
        let st = app.state::<AppState>();
        let excluded: Vec<String> = db::get_setting(&st.conn(), "library.excluded").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        let _ = app.emit("scan", json!({"library_id": id, "found": 0, "done": false}));
        let (found, errors) = scan::walk(&root, &excluded, |n| { let _ = app.emit("scan", json!({"library_id": id, "found": n, "done": false})); });
        let mut c = match db::open(&st.db_path) { Ok(c) => c, Err(e) => { let _ = app.emit("scan", json!({"library_id": id, "error": e.to_string(), "done": true})); return; } };
        match scan::reconcile(&mut c, id, found) {
            Ok(mut stats) => { stats.errors = errors; let _ = app.emit("scan", &stats); }
            Err(e) => { let _ = app.emit("scan", json!({"library_id": id, "error": e.to_string(), "done": true})); }
        }
        let _ = app.emit("library-changed", ());
        st.wake_prober();
    });
}

#[tauri::command]
fn library_folders(s: State<AppState>, id: i64) -> R<Vec<(String, i64)>> { db::folders(&s.conn(), id).map_err(e2s) }

// ================================================================ assets

#[tauri::command]
fn query_assets(s: State<AppState>, q: Query) -> R<Vec<db::AssetRow>> { db::query_assets(&s.conn(), &q).map_err(e2s) }

#[derive(Serialize)]
struct Detail { asset: db::AssetRow, notes: Option<String>, tags: Vec<(i64, String)>, collections: Vec<(i64, String)>, streams: Option<serde_json::Value>, exif: Vec<(String, String)>, probe_error: Option<String>, proxy: Option<String>, vcodec: Option<String>, acodec: Option<String>, bitrate: Option<i64> }

#[tauri::command]
async fn asset_detail(app: AppHandle, id: i64) -> R<Detail> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let (asset, notes, tags, cols, perr, vc, ac, br) = {
            let c = s.conn();
            let a = db::get_asset(&c, id).map_err(e2s)?.ok_or("Not found")?;
            let (notes, perr, vc, ac, br): (Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>) =
                c.query_row("SELECT notes,probe_error,vcodec,acodec,bitrate FROM assets WHERE id=?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(e2s)?;
            let tags = c.prepare("SELECT t.id,t.name FROM tags t JOIN asset_tags x ON x.tag_id=t.id WHERE x.asset_id=? ORDER BY t.name").and_then(|mut st| st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()).map_err(e2s)?;
            let cols = c.prepare("SELECT c.id,c.name FROM collections c JOIN collection_items i ON i.collection_id=c.id WHERE i.asset_id=?").and_then(|mut st| st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()).map_err(e2s)?;
            (a, notes, tags, cols, perr, vc, ac, br)
        };
        let p = Path::new(&asset.path);
        let streams = if asset.kind == "video" || asset.kind == "audio" { media::ffprobe_json(p).ok() } else { None };
        let exif = if asset.kind == "image" || asset.kind == "raw" { media::read_exif_fields(p) } else { vec![] };
        let proxy = s.cache_dir.join("proxies").join(format!("{}.mp4", thumbs::key(&asset.path, asset.size, asset.mtime, 0)));
        let proxy = proxy.is_file().then(|| proxy.to_string_lossy().into_owned());
        Ok(Detail { asset, notes, tags, collections: cols, streams, exif, probe_error: perr, proxy, vcodec: vc, acodec: ac, bitrate: br })
    }).await.map_err(e2s)?
}

#[tauri::command]
fn set_field(s: State<AppState>, ids: Vec<i64>, field: String, value: serde_json::Value) -> R<usize> {
    let v = match (field.as_str(), &value) {
        ("rating", serde_json::Value::Number(n)) => Value::Integer(n.as_i64().unwrap_or(0).clamp(0, 5)),
        ("favorite" | "rejected", serde_json::Value::Bool(b)) => Value::Integer(*b as i64),
        ("color", serde_json::Value::String(c)) if ["red", "orange", "yellow", "green", "blue", "purple"].contains(&c.as_str()) => Value::Text(c.clone()),
        ("color", serde_json::Value::Null) => Value::Null,
        ("notes", serde_json::Value::String(n)) => Value::Text(n.chars().take(10_000).collect()),
        _ => return Err(format!("Invalid value for {field}")),
    };
    db::set_field_many(&mut s.conn(), &ids, &field, v).map_err(e2s)
}

#[tauri::command]
fn list_tags(s: State<AppState>) -> R<Vec<(i64, String, i64)>> {
    s.conn().prepare("SELECT t.id,t.name,(SELECT COUNT(*) FROM asset_tags x WHERE x.tag_id=t.id) FROM tags t ORDER BY t.name COLLATE NOCASE")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect()).map_err(e2s)
}
#[tauri::command]
fn tag_assets(s: State<AppState>, ids: Vec<i64>, name: String, remove: bool) -> R<()> {
    let name = name.trim(); if name.is_empty() || name.len() > 64 { return Err("Tag names must be 1–64 characters".into()); }
    let mut c = s.conn(); let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(e2s)?;
    tx.execute("INSERT OR IGNORE INTO tags(name) VALUES(?)", [name]).map_err(e2s)?;
    let tid: i64 = tx.query_row("SELECT id FROM tags WHERE name=?", [name], |r| r.get(0)).map_err(e2s)?;
    for id in ids { if remove { tx.execute("DELETE FROM asset_tags WHERE asset_id=? AND tag_id=?", [id, tid]) } else { tx.execute("INSERT OR IGNORE INTO asset_tags VALUES(?,?)", [id, tid]) }.map_err(e2s)?; }
    tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM asset_tags)", []).map_err(e2s)?;
    tx.commit().map_err(e2s)
}

#[tauri::command]
fn list_collections(s: State<AppState>) -> R<Vec<(i64, String, i64)>> {
    s.conn().prepare("SELECT c.id,c.name,(SELECT COUNT(*) FROM collection_items i WHERE i.collection_id=c.id) FROM collections c ORDER BY c.name COLLATE NOCASE")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect()).map_err(e2s)
}
#[tauri::command]
fn collection_edit(s: State<AppState>, action: String, id: Option<i64>, name: Option<String>, ids: Vec<i64>) -> R<i64> {
    let mut c = s.conn(); let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(e2s)?;
    let cid = match action.as_str() {
        "create" => { let n = name.unwrap_or_default(); let n = n.trim(); if n.is_empty() { return Err("Name required".into()); }
            tx.execute("INSERT INTO collections(name,created_at) VALUES(?,?)", params![n, now_ms()]).map_err(e2s)?; tx.last_insert_rowid() }
        "rename" => { let id = id.ok_or("id")?; tx.execute("UPDATE collections SET name=? WHERE id=?", params![name.unwrap_or_default().trim(), id]).map_err(e2s)?; id }
        "delete" => { let id = id.ok_or("id")?; tx.execute("DELETE FROM collections WHERE id=?", [id]).map_err(e2s)?; id }
        "add" | "remove" => id.ok_or("id")?,
        _ => return Err("bad action".into()),
    };
    for a in ids {
        if action == "remove" { tx.execute("DELETE FROM collection_items WHERE collection_id=? AND asset_id=?", [cid, a]).map_err(e2s)?; }
        else if action != "delete" { tx.execute("INSERT OR IGNORE INTO collection_items(collection_id,asset_id,position) VALUES(?,?,?)", params![cid, a, now_ms()]).map_err(e2s)?; }
    }
    tx.commit().map_err(e2s)?;
    Ok(cid)
}

#[tauri::command]
fn saved_searches(s: State<AppState>, action: String, id: Option<i64>, name: Option<String>, query: Option<serde_json::Value>) -> R<Vec<(i64, String, serde_json::Value)>> {
    let c = s.conn();
    match action.as_str() {
        "save" => { c.execute("INSERT INTO saved_searches(name,query) VALUES(?,?)", params![name.unwrap_or_else(|| "Search".into()), query.unwrap_or_default().to_string()]).map_err(e2s)?; }
        "delete" => { c.execute("DELETE FROM saved_searches WHERE id=?", [id.unwrap_or(0)]).map_err(e2s)?; }
        _ => {}
    }
    c.prepare("SELECT id,name,query FROM saved_searches ORDER BY name").and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default())))?.collect()).map_err(e2s)
}

/// Groups of visually similar images (approximate: 64-bit dHash, Hamming distance ≤ threshold).
#[tauri::command]
fn similar_groups(s: State<AppState>, ids: Vec<i64>, threshold: u32) -> R<Vec<Vec<i64>>> {
    let c = s.conn();
    let mut items: Vec<(i64, u64)> = vec![];
    for id in &ids { if let Ok(Some(h)) = c.query_row("SELECT phash FROM assets WHERE id=?", [id], |r| r.get::<_, Option<i64>>(0)) { items.push((*id, h as u64)); } }
    let mut parent: Vec<usize> = (0..items.len()).collect();
    fn find(p: &mut Vec<usize>, i: usize) -> usize { if p[i] != i { let r = find(p, p[i]); p[i] = r; } p[i] }
    for i in 0..items.len() { for j in i + 1..items.len() { if (items[i].1 ^ items[j].1).count_ones() <= threshold.min(20) { let (a, b) = (find(&mut parent, i), find(&mut parent, j)); parent[a] = b; } } }
    let mut groups: HashMap<usize, Vec<i64>> = HashMap::new();
    for i in 0..items.len() { let r = find(&mut parent, i); groups.entry(r).or_default().push(items[i].0); }
    let mut v: Vec<Vec<i64>> = groups.into_values().filter(|g| g.len() > 1).collect();
    v.sort_by_key(|g| std::cmp::Reverse(g.len()));
    Ok(v)
}

// ================================================================ file operations

#[tauri::command]
fn rename_preview(s: State<AppState>, ids: Vec<i64>, spec: ops::RenameSpec) -> R<Vec<ops::Proposal>> { ops::preview(&s.conn(), &ids, &spec).map_err(e2s) }
#[tauri::command]
fn rename_apply(s: State<AppState>, renames: Vec<(i64, String)>) -> R<ops::RenameResult> { ops::apply(&mut s.conn(), &renames) }
#[tauri::command]
fn rename_undo(s: State<AppState>, batch: String) -> R<ops::RenameResult> { ops::undo(&mut s.conn(), &batch) }
#[tauri::command]
fn recycle(s: State<AppState>, ids: Vec<i64>) -> R<usize> { ops::recycle(&s.conn(), &ids) }
#[tauri::command]
fn reveal(s: State<AppState>, id: i64) -> R<()> {
    let a = db::get_asset(&s.conn(), id).map_err(e2s)?.ok_or("Not found")?;
    ops::reveal(Path::new(&a.path))
}

/// Raw bytes of a media file for the in-app editors (keeps canvases same-origin and untainted).
#[tauri::command]
async fn read_media(app: AppHandle, id: i64) -> R<Response> {
    let path = { let s = app.state::<AppState>(); db::get_asset(&s.conn(), id).map_err(e2s)?.ok_or("Not found")?.path };
    let md = std::fs::metadata(&path).map_err(e2s)?;
    if md.len() > 1_500_000_000 { return Err("File is too large to open in the editor".into()); }
    tauri::async_runtime::spawn_blocking(move || std::fs::read(&path).map(Response::new).map_err(e2s)).await.map_err(e2s)?
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes(); let mut out = Vec::with_capacity(b.len()); let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]); i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Save bytes produced by an editor. Headers: x-asset (save next to this asset) or x-dir (a folder chosen in
/// a native dialog), x-name, x-overwrite ("1" only after the user confirmed replacing the original).
#[tauri::command]
fn save_output(s: State<AppState>, request: tauri::ipc::Request) -> R<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected binary body".into()) };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(pct_decode);
    let name = h("x-name").ok_or("missing name")?;
    let overwrite = h("x-overwrite").as_deref() == Some("1");
    let dir = if let Some(id) = h("x-asset").and_then(|v| v.parse::<i64>().ok()) {
        let a = db::get_asset(&s.conn(), id).map_err(e2s)?.ok_or("Not found")?;
        if overwrite && a.name != name { return Err("Overwrite target mismatch".into()); }
        Path::new(&a.path).parent().ok_or("no folder")?.to_path_buf()
    } else if let Some(d) = h("x-dir") { if overwrite { return Err("Overwrite is only allowed for the source file".into()); } PathBuf::from(d) } else { return Err("missing destination".into()) };
    let p = ops::write_atomic(&dir, &name, bytes, overwrite)?;
    let _ = scan::upsert_file(&s.conn(), &p);
    Ok(p.to_string_lossy().into_owned())
}

/// Write a text file (selection manifest / project) to a path the user picked in a native save dialog.
#[tauri::command]
fn write_text_file(path: String, contents: String, kind: String) -> R<()> {
    let p = PathBuf::from(&path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let ok = match kind.as_str() { "manifest" => ["csv", "txt", "json"].contains(&ext.as_str()), "project" => ext == "msproj", _ => false };
    if !ok { return Err("Unsupported file type".into()); }
    let dir = p.parent().ok_or("bad path")?;
    ops::write_atomic(dir, &p.file_name().unwrap().to_string_lossy(), contents.as_bytes(), true).map(|_| ())
}
#[tauri::command]
fn read_project(s: State<AppState>, path: String) -> R<serde_json::Value> {
    if !path.to_lowercase().ends_with(".msproj") { return Err("Not a Media Studio project".into()); }
    let txt = std::fs::read_to_string(&path).map_err(e2s)?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| format!("Project file is damaged: {e}"))?;
    if v["format"] != "media-studio-project" { return Err("Not a Media Studio project".into()); }
    let _ = s.conn().execute("INSERT INTO recent_projects(path,opened_at) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET opened_at=excluded.opened_at", params![path, now_ms()]);
    Ok(v)
}
#[tauri::command]
fn recent_projects(s: State<AppState>) -> R<Vec<String>> {
    s.conn().prepare("SELECT path FROM recent_projects ORDER BY opened_at DESC LIMIT 12").and_then(|mut st| st.query_map([], |r| r.get(0))?.collect()).map_err(e2s)
}
/// Find assets by path / file name — used to relink missing project media.
#[tauri::command]
fn resolve_media(s: State<AppState>, path: String) -> R<Option<db::AssetRow>> {
    let c = s.conn();
    if let Ok(id) = c.query_row("SELECT id FROM assets WHERE path=? AND missing=0", [&path], |r| r.get::<_, i64>(0)) { return db::get_asset(&c, id).map_err(e2s); }
    let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match c.query_row("SELECT id FROM assets WHERE name=? COLLATE NOCASE AND missing=0 LIMIT 1", [&name], |r| r.get::<_, i64>(0)) { Ok(id) => db::get_asset(&c, id).map_err(e2s), Err(_) => Ok(None) }
}

/// Frame-exact capture with FFmpeg (decodes from the source, not from the preview). Saves a PNG next to the
/// source unless `to_cache` is set, in which case it goes to the cache (for clipboard copies).
#[tauri::command]
async fn capture_frame(app: AppHandle, id: i64, time_us: i64, to_cache: bool) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let a = db::get_asset(&s.conn(), id).map_err(e2s)?.ok_or("Not found")?;
        let src = PathBuf::from(&a.path);
        let (stem, _) = ops::split_ext(&a.name);
        let name = format!("{stem}_{:.3}s.png", time_us as f64 / 1e6);
        ops::validate_filename(&name)?;
        let dir = if to_cache { let d = s.cache_dir.join("frames"); std::fs::create_dir_all(&d).map_err(e2s)?; d } else { src.parent().ok_or("no folder")?.to_path_buf() };
        let out = ops::unique_path(&dir, &name);
        let tmp = dir.join(format!(".{}.png", now_ms()));
        let args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-ss".into(), format!("{:.6}", time_us.max(0) as f64 / 1e6), "-i".into(), a.path.clone(),
            "-map".into(), "0:v:0".into(), "-frames:v".into(), "1".into(), "-y".into(), tmp.to_string_lossy().into_owned()];
        media::run_capture(media::ffmpeg_path()?, &args)?;
        if !tmp.is_file() { return Err("No frame at that position".into()); }
        std::fs::rename(&tmp, &out).map_err(e2s)?;
        if !to_cache { let _ = scan::upsert_file(&s.conn(), &out); }
        Ok(out.to_string_lossy().into_owned())
    }).await.map_err(e2s)?
}
/// Render one frame through the quick-edit filter chain (delogo, crop, colour…) for an honest preview.
#[tauri::command]
async fn preview_quick(app: AppHandle, id: i64, edit: export::QuickEdit, time_us: i64) -> R<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let a = db::get_asset(&s.conn(), id).map_err(e2s)?.ok_or("Not found")?;
        let src = PathBuf::from(&a.path);
        let probe = media::ffprobe_json(&src).map(|j| media::parse_probe(&j))?;
        let d = s.cache_dir.join("frames"); std::fs::create_dir_all(&d).map_err(e2s)?;
        let out = d.join(format!("preview-{}.png", now_ms()));
        media::run_capture(media::ffmpeg_path()?, &export::build_quick_preview(&src, &probe, &edit, time_us, &out))?;
        let b = std::fs::read(&out).map_err(e2s)?; let _ = std::fs::remove_file(&out);
        Ok(Response::new(b))
    }).await.map_err(e2s)?
}
#[tauri::command]
async fn read_cache_file(app: AppHandle, path: String) -> R<Response> {
    let cache = app.state::<AppState>().cache_dir.clone();
    let p = PathBuf::from(&path);
    if !dunce_canon(&p).starts_with(dunce_canon(&cache)) { return Err("Not a cache file".into()); }
    tauri::async_runtime::spawn_blocking(move || std::fs::read(&p).map(Response::new).map_err(e2s)).await.map_err(e2s)?
}

// ================================================================ jobs

#[tauri::command]
fn enqueue_job(s: State<AppState>, spec: jobs::JobSpec, title: String) -> R<i64> { let c = s.conn(); s.jobs.enqueue(&c, spec, title) }
#[tauri::command]
fn list_jobs(s: State<AppState>) -> R<Vec<jobs::JobRow>> { jobs::list(&s.conn(), 200).map_err(e2s) }
#[tauri::command]
fn cancel_job(s: State<AppState>, id: i64) -> R<()> { let c = s.conn(); s.jobs.cancel(&c, id) }
#[tauri::command]
fn retry_job(s: State<AppState>, id: i64) -> R<i64> { let c = s.conn(); s.jobs.retry(&c, id) }
#[tauri::command]
fn clear_jobs(s: State<AppState>) -> R<usize> { s.conn().execute("DELETE FROM jobs WHERE status IN ('done','failed','cancelled','interrupted')", []).map_err(e2s) }

// ================================================================ settings, cache, diagnostics, AI

#[tauri::command]
fn get_settings(s: State<AppState>) -> R<HashMap<String, serde_json::Value>> {
    let c = s.conn();
    c.prepare("SELECT key,value FROM settings").and_then(|mut st| st.query_map([], |r| Ok((r.get::<_, String>(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or(serde_json::Value::Null))))?.collect()).map_err(e2s)
}
#[tauri::command]
fn set_setting(s: State<AppState>, key: String, value: serde_json::Value) -> R<()> {
    if key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') { return Err("bad key".into()); }
    if key == "jobs.concurrency" { if let Some(n) = value.as_u64() { s.jobs.set_concurrency(n as usize); } }
    db::set_setting(&s.conn(), &key, &value.to_string()).map_err(e2s)
}

#[tauri::command]
async fn cache_info(app: AppHandle) -> R<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        Ok(json!({ "thumbs": thumbs::dir_size(&s.cache_dir.join("thumbs")), "proxies": thumbs::dir_size(&s.cache_dir.join("proxies")), "path": s.cache_dir }))
    }).await.map_err(e2s)?
}
#[tauri::command]
fn clear_cache(s: State<AppState>, which: String) -> R<u64> {
    let d = match which.as_str() { "thumbs" => s.cache_dir.join("thumbs"), "proxies" => s.cache_dir.join("proxies"), _ => return Err("bad cache".into()) };
    let size = thumbs::dir_size(&d);
    let _ = std::fs::remove_dir_all(&d); // cache folders only — never user media
    if which == "thumbs" { let _ = s.conn().execute("UPDATE assets SET phash=NULL", []); }
    Ok(size)
}

#[tauri::command]
async fn diagnostics(app: AppHandle) -> R<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let caps = export::caps();
        let (assets, missing, unprobed, failed): (i64, i64, i64, i64) = s.conn().query_row("SELECT COUNT(*), SUM(missing), SUM(probed=0), SUM(probe_error IS NOT NULL) FROM assets", [], |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0), r.get::<_, Option<i64>>(2)?.unwrap_or(0), r.get::<_, Option<i64>>(3)?.unwrap_or(0)))).unwrap_or_default();
        let schema: i64 = s.conn().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
        let recent_failures = s.conn().prepare("SELECT title, error, finished_at FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 5")
            .and_then(|mut st| st.query_map([], |r| Ok(json!({"title": r.get::<_, String>(0)?, "error": r.get::<_, Option<String>>(1)?, "at": r.get::<_, Option<i64>>(2)?})))?.collect::<Result<Vec<_>, _>>()).unwrap_or_default();
        let os = std::process::Command::new("cmd").args(["/C", "ver"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let free = fs4::available_space(&s.data_dir).ok();
        Ok(json!({
            "app_version": app.package_info().version.to_string(), "os": os, "arch": std::env::consts::ARCH,
            "ffmpeg": { "source": media::tools().source, "found": media::tools().ffmpeg.is_some(), "version": caps.version },
            "hw_encoders": caps.hw_verified, "hwaccels": caps.hwaccels,
            "software_encoders": caps.encoders.iter().filter(|e| ["libx264","libx265","libsvtav1","libvpx-vp9","prores_ks","aac","libopus","libmp3lame","flac"].contains(&e.as_str())).collect::<Vec<_>>(),
            "ai": ai::status(&s.data_dir),
            "database": { "schema_version": schema, "assets": assets, "missing": missing, "pending_metadata": unprobed, "metadata_errors": failed },
            "thumbnail_queue": s.thumbs.pending(),
            "data_dir_free_bytes": free, "recent_failures": recent_failures,
        }))
    }).await.map_err(e2s)?
}

#[tauri::command]
fn ai_status(s: State<AppState>) -> ai::Status { ai::status(&s.data_dir) }
#[tauri::command]
async fn ai_install(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = app.state::<AppState>().data_dir.clone();
        let mut last = 0.0;
        ai::install(&data, &mut |p| { if p - last > 0.02 || p >= 1.0 { last = p; let _ = app.emit("ai-install", p); } })
    }).await.map_err(e2s)?
}

#[tauri::command]
fn app_info(app: AppHandle, s: State<AppState>) -> serde_json::Value {
    json!({ "version": app.package_info().version.to_string(), "ffmpeg": media::tools(), "data_dir": s.data_dir, "cache_dir": s.cache_dir })
}

// ================================================================ thumbnail protocol

fn respond(responder: tauri::UriSchemeResponder, status: u16, mime: &str, body: Vec<u8>) {
    let r = tauri::http::Response::builder().status(status).header("Content-Type", mime).header("Access-Control-Allow-Origin", "*").header("Cache-Control", "max-age=31536000, immutable").body(body).unwrap();
    responder.respond(r);
}

fn thumb_request(app: &AppHandle, uri: &str, responder: tauri::UriSchemeResponder) {
    let id: Option<i64> = uri.split('/').filter(|s| !s.is_empty()).last().and_then(|s| s.split(['?', '.']).next()).and_then(|s| s.parse().ok());
    let s = app.state::<AppState>();
    let Some(a) = id.and_then(|id| db::get_asset(&s.conn(), id).ok().flatten()) else { return respond(responder, 404, "text/plain", vec![]) };
    let dir = s.cache_dir.join("thumbs");
    let cached = thumbs::cache_file(&dir, &thumbs::key(&a.path, a.size, a.mtime, thumbs::EDGE));
    if let Ok(b) = std::fs::read(&cached) { return respond(responder, 200, "image/jpeg", b); }
    let db_path = s.db_path.clone();
    s.thumbs.push(thumbs::Task { run: Box::new(move || {
        match thumbs::generate(&dir, Path::new(&a.path), &a.kind, a.size, a.mtime, a.duration_ms, thumbs::EDGE) {
            Ok((p, ph)) => {
                if let Some(h) = ph { if let Ok(c) = db::open(&db_path) { let _ = c.execute("UPDATE assets SET phash=? WHERE id=?", params![h as i64, a.id]); } }
                match std::fs::read(&p) { Ok(b) => respond(responder, 200, "image/jpeg", b), Err(_) => respond(responder, 500, "text/plain", vec![]) }
            }
            Err(e) => respond(responder, 415, "text/plain", e.into_bytes()),
        }
    }) });
}

// ================================================================ setup

fn prober(app: AppHandle) {
    let st = app.state::<AppState>();
    let sig = st.probe_signal.clone();
    let Ok(c) = db::open(&st.db_path) else { return };
    loop {
        match scan::probe_batch(&c, 24) {
            Ok(done) if !done.is_empty() => { let _ = app.emit("assets-probed", done.len()); continue; }
            _ => {}
        }
        let (m, cv) = &*sig; let g = m.lock().unwrap(); let (mut g, _) = cv.wait_timeout(g, std::time::Duration::from_secs(30)).unwrap(); *g = false;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let uri = req.uri().to_string();
            std::thread::spawn(move || thumb_request(&app, &uri, responder));
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&data_dir)?; std::fs::create_dir_all(&cache_dir)?;
            media::init_tools(app.path().resource_dir().ok());
            let db_path = db::db_path(&data_dir);
            let mut conn = db::open(&db_path)?;
            db::migrate(&mut conn)?;
            let concurrency = db::get_setting(&conn, "jobs.concurrency").and_then(|v| v.parse().ok()).unwrap_or(2);
            let thumb_workers = db::get_setting(&conn, "thumbs.workers").and_then(|v| v.parse().ok())
                .unwrap_or_else(|| std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(2, 6)).unwrap_or(3));
            // trim the thumbnail cache to its budget at startup (background)
            let max_mb: u64 = db::get_setting(&conn, "cache.max_mb").and_then(|v| v.parse().ok()).unwrap_or(2048);
            { let d = cache_dir.join("thumbs"); std::thread::spawn(move || thumbs::trim_cache(&d, max_mb * 1_048_576)); }
            let libs = db::list_libraries(&conn)?;
            let scope = app.asset_protocol_scope();
            for l in &libs { let _ = scope.allow_directory(&l.path, true); }
            let _ = scope.allow_directory(cache_dir.join("proxies"), false);
            let projects_root = db::get_setting(&conn, "projects.dir").and_then(|v| serde_json::from_str::<String>(&v).ok()).map(PathBuf::from)
                .unwrap_or_else(|| app.path().document_dir().unwrap_or_else(|_| data_dir.clone()).join("Media Studio Pro").join("Projects"));
            let _ = std::fs::create_dir_all(&projects_root);
            let stock = projects_root.parent().map(|p| p.join("Stock")).unwrap_or_else(|| projects_root.join("Stock"));
            let _ = scope.allow_directory(&projects_root, true);
            let _ = scope.allow_directory(&stock, true);
            let _ = scope.allow_directory(&cache_dir, true);
            let mut allow = editor_cmds::Allow::default();
            for l in &libs { allow.add_root(Path::new(&l.path)); }
            for d in [&cache_dir, &projects_root, &stock] { allow.add_root(d); }
            app.manage::<editor_cmds::AllowState>(Mutex::new(allow));
            let jobs = jobs::Jobs::start(jobs::Ctx { app: app.handle().clone(), db_path: db_path.clone(), cache_dir: cache_dir.clone(), data_dir: data_dir.clone(), projects_root: projects_root.clone() }, concurrency);
            app.manage(AppState { db: Mutex::new(conn), db_path, data_dir, cache_dir, thumbs: thumbs::Pool::new(thumb_workers), jobs, probe_signal: Arc::new((Mutex::new(false), Condvar::new())), renders: render::Sessions::default(), projects_root });
            let h = app.handle().clone();
            std::thread::spawn(move || prober(h));
            let h = app.handle().clone();
            std::thread::spawn(move || { let _ = export::caps(); let _ = h.emit("caps-ready", ()); });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_libraries, add_library, remove_library, rescan_library, library_folders,
            query_assets, asset_detail, set_field, list_tags, tag_assets, list_collections, collection_edit, saved_searches, similar_groups,
            rename_preview, rename_apply, rename_undo, recycle, reveal, read_media, capture_frame, read_cache_file, preview_quick, save_output, write_text_file, read_project, recent_projects, resolve_media,
            enqueue_job, list_jobs, cancel_job, retry_job, clear_jobs,
            get_settings, set_setting, cache_info, clear_cache, diagnostics, ai_status, ai_install, app_info,
            editor_cmds::projects_list, editor_cmds::projects_dir, editor_cmds::project_create, editor_cmds::project_load, editor_cmds::project_save, editor_cmds::project_rename,
            editor_cmds::project_duplicate, editor_cmds::project_delete, editor_cmds::project_cover, editor_cmds::project_reveal, editor_cmds::project_assets_dir, editor_cmds::project_write_asset,
            editor_cmds::editor_import, editor_cmds::editor_info, editor_cmds::editor_optimize, editor_cmds::editor_waveform, editor_cmds::editor_filmstrip, editor_cmds::read_range, editor_cmds::file_size,
            editor_cmds::editor_frame_png, editor_cmds::save_text_as, editor_cmds::read_text_file, editor_cmds::render_start, editor_cmds::render_push, editor_cmds::render_finish, editor_cmds::render_cancel,
            editor_cmds::render_audio, editor_cmds::voice_effects, editor_cmds::reveal_path, editor_cmds::open_path_default, editor_cmds::sfx_library, editor_cmds::detect_silence, editor_cmds::models_status, editor_cmds::model_install, editor_cmds::model_remove, editor_cmds::model_bytes, editor_cmds::speech_voices,
            editor_cmds::byok_providers, editor_cmds::byok_set, editor_cmds::ai_chat, editor_cmds::stock_search, editor_cmds::system_fonts, editor_cmds::editor_env
        ])
        .run(tauri::generate_context!())
        .expect("error while running Media Studio Pro");
}
