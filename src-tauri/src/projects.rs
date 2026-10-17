//! Editor projects: one folder per project under the projects root (default Documents\Media Studio Pro\Projects).
//! `project.json` holds the full timeline, `meta.json` a small summary for fast listing, `cover.jpg` the card
//! image and `backups/` rolling snapshots. Project ids are generated here and validated on every call.
use crate::db::now_ms;
use crate::ops;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Meta {
    pub id: String, pub name: String, pub created: i64, pub modified: i64,
    pub duration_us: i64, pub width: u32, pub height: u32, pub clips: u32,
    /// Set by `list`, never stored.
    #[serde(skip_deserializing)] pub cover: Option<String>,
    #[serde(skip_deserializing)] pub size: u64,
}

pub fn valid_id(id: &str) -> Result<(), String> {
    if id.len() < 4 || id.len() > 40 || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') { return Err("Invalid project id".into()); }
    Ok(())
}

pub fn new_id() -> String {
    let t = now_ms() as u64;
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0) as u64;
    let mut x = t ^ (n << 20) ^ (std::process::id() as u64).rotate_left(40);
    let mut s = String::new();
    for _ in 0..6 { let d = (x % 36) as u32; s.push(std::char::from_digit(d, 36).unwrap()); x /= 36; }
    format!("p{}-{}", radix36(t), s)
}
fn radix36(mut v: u64) -> String { let mut s = vec![]; while v > 0 { s.push(std::char::from_digit((v % 36) as u32, 36).unwrap()); v /= 36; } s.reverse(); s.into_iter().collect() }

pub fn clean_name(name: &str) -> Result<String, String> {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    if n.is_empty() { return Err("Project name can't be empty".into()); }
    Ok(n)
}

fn dir(root: &Path, id: &str) -> Result<PathBuf, String> { valid_id(id)?; Ok(root.join(id)) }

fn write_json(dir: &Path, name: &str, v: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    ops::write_atomic(dir, name, &bytes, true).map(|_| ())
}

fn read_meta(d: &Path) -> Option<Meta> {
    let txt = std::fs::read_to_string(d.join("meta.json")).ok()?;
    serde_json::from_str(&txt).ok()
}

fn dir_size(d: &Path) -> u64 { walkdir::WalkDir::new(d).into_iter().filter_map(|e| e.ok()).filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum() }

pub fn list(root: &Path) -> Vec<Meta> {
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    let mut v: Vec<Meta> = rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).filter_map(|e| {
        let d = e.path();
        let id = d.file_name()?.to_string_lossy().into_owned();
        if valid_id(&id).is_err() || !d.join("project.json").is_file() { return None; }
        let mut m = read_meta(&d).unwrap_or_else(|| Meta { id: id.clone(), name: id.clone(), ..Default::default() });
        m.id = id;
        let c = d.join("cover.jpg"); if c.is_file() { m.cover = Some(c.to_string_lossy().into_owned()); }
        m.size = dir_size(&d);
        Some(m)
    }).collect();
    v.sort_by(|a, b| b.modified.cmp(&a.modified));
    v
}

pub fn create(root: &Path, name: &str, data: &Value) -> Result<Meta, String> {
    let name = clean_name(name)?;
    let id = new_id();
    let d = root.join(&id);
    std::fs::create_dir_all(&d).map_err(|e| format!("Could not create the project folder: {e}"))?;
    let now = now_ms();
    let meta = Meta { id: id.clone(), name: name.clone(), created: now, modified: now, ..summary(data) };
    let mut data = data.clone();
    data["id"] = Value::String(id.clone()); data["name"] = Value::String(name);
    write_json(&d, "project.json", &data)?;
    write_json(&d, "meta.json", &meta)?;
    Ok(meta)
}

/// Summary fields are computed from the project document so the list never disagrees with the content.
fn summary(data: &Value) -> Meta {
    let mut m = Meta::default();
    m.width = data["width"].as_u64().unwrap_or(0) as u32;
    m.height = data["height"].as_u64().unwrap_or(0) as u32;
    let mut end = 0i64; let mut clips = 0u32;
    if let Some(tracks) = data["tracks"].as_array() {
        for t in tracks { if let Some(cs) = t["clips"].as_array() { for c in cs {
            clips += 1;
            let e = c["start"].as_i64().unwrap_or(0) + c["dur"].as_i64().unwrap_or(0);
            end = end.max(e);
        } } }
    }
    m.duration_us = end; m.clips = clips;
    m
}

pub fn load(root: &Path, id: &str) -> Result<Value, String> {
    let d = dir(root, id)?;
    let txt = std::fs::read_to_string(d.join("project.json")).map_err(|_| "This project could not be found. It may have been moved or deleted.".to_string())?;
    match serde_json::from_str::<Value>(&txt) {
        Ok(v) => Ok(v),
        Err(e) => {
            // fall back to the newest readable backup rather than losing the project
            for b in backups(&d) { if let Ok(t) = std::fs::read_to_string(&b) { if let Ok(v) = serde_json::from_str::<Value>(&t) { return Ok(v); } } }
            Err(format!("The project file is damaged and no backup could be read: {e}"))
        }
    }
}

fn backups(d: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(d.join("backups")).map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json")).collect()).unwrap_or_default();
    v.sort(); v.reverse(); v
}

pub fn save(root: &Path, id: &str, data: &Value) -> Result<Meta, String> {
    let d = dir(root, id)?;
    if !d.is_dir() { return Err("This project no longer exists on disk.".into()); }
    // rolling backup of the previous version, at most one every 3 minutes, keep 15
    let cur = d.join("project.json");
    let bdir = d.join("backups");
    let newest = backups(&d).first().and_then(|p| p.metadata().ok()).and_then(|m| m.modified().ok());
    let due = newest.map(|t| t.elapsed().map(|e| e.as_secs() > 180).unwrap_or(true)).unwrap_or(true);
    if due && cur.is_file() {
        let _ = std::fs::create_dir_all(&bdir);
        let _ = std::fs::copy(&cur, bdir.join(format!("project-{}.json", now_ms())));
        for old in backups(&d).into_iter().skip(15) { let _ = std::fs::remove_file(old); }
    }
    let old = read_meta(&d).unwrap_or_default();
    let name = data["name"].as_str().map(clean_name).transpose()?.unwrap_or(old.name.clone());
    let meta = Meta { id: id.into(), name, created: if old.created > 0 { old.created } else { now_ms() }, modified: now_ms(), ..summary(data) };
    write_json(&d, "project.json", data)?;
    write_json(&d, "meta.json", &meta)?;
    Ok(meta)
}

pub fn rename(root: &Path, id: &str, name: &str) -> Result<Meta, String> {
    let name = clean_name(name)?;
    let mut v = load(root, id)?;
    v["name"] = Value::String(name);
    save(root, id, &v)
}

pub fn duplicate(root: &Path, id: &str) -> Result<Meta, String> {
    let v = load(root, id)?;
    let src = dir(root, id)?;
    let base = v["name"].as_str().unwrap_or("Project");
    let m = create(root, &format!("{base} copy"), &v)?;
    let d = root.join(&m.id);
    if src.join("cover.jpg").is_file() { let _ = std::fs::copy(src.join("cover.jpg"), d.join("cover.jpg")); }
    // copy project-local generated media (TTS, recordings, AI images) so the duplicate is self-contained
    if src.join("assets").is_dir() { copy_dir(&src.join("assets"), &d.join("assets")).map_err(|e| e.to_string())?; }
    Ok(m)
}

fn copy_dir(a: &Path, b: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(b)?;
    for e in std::fs::read_dir(a)? { let e = e?; let p = e.path(); if p.is_dir() { copy_dir(&p, &b.join(e.file_name()))?; } else { std::fs::copy(&p, b.join(e.file_name()))?; } }
    Ok(())
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let d = dir(root, id)?;
    if !d.is_dir() { return Ok(()); }
    trash::delete(&d).map_err(|e| format!("Could not move the project to the Recycle Bin: {e}"))
}

pub fn set_cover(root: &Path, id: &str, jpeg: &[u8]) -> Result<String, String> {
    let d = dir(root, id)?;
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 { return Err("Cover must be a JPEG image".into()); }
    ops::write_atomic(&d, "cover.jpg", jpeg, true).map(|p| p.to_string_lossy().into_owned())
}

/// Folder for files the editor generates for this project (voiceovers, TTS, AI images, recordings).
pub fn assets_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    let d = dir(root, id)?.join("assets");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Every media path referenced by a project document (used to grant read access for its sources).
pub fn media_paths(v: &Value) -> Vec<String> {
    let mut out = vec![];
    if let Some(m) = v["media"].as_object() {
        for (_, e) in m { for k in ["path", "optimized", "mask", "processed"] { if let Some(p) = e[k].as_str() { out.push(p.to_string()); } } }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn ids_are_valid_and_unique() {
        let a = new_id(); std::thread::sleep(std::time::Duration::from_millis(2)); let b = new_id();
        assert!(valid_id(&a).is_ok(), "{a}"); assert_ne!(a, b);
        for bad in ["..", "../x", "a/b", "ABC", "p1", "C:\\x"] { assert!(valid_id(bad).is_err(), "{bad}"); }
    }
    #[test] fn lifecycle() {
        let t = tempfile::tempdir().unwrap(); let root = t.path();
        let doc = json!({"width":1920,"height":1080,"tracks":[{"clips":[{"start":0,"dur":2_000_000},{"start":2_000_000,"dur":3_000_000}]}],"media":{"m1":{"path":"C:\\v.mp4"}}});
        let m = create(root, "  My film  ", &doc).unwrap();
        assert_eq!(m.name, "My film"); assert_eq!(m.duration_us, 5_000_000); assert_eq!(m.clips, 2);
        let l = list(root); assert_eq!(l.len(), 1); assert_eq!(l[0].name, "My film");
        let r = rename(root, &m.id, "Renamed").unwrap(); assert_eq!(r.name, "Renamed");
        assert_eq!(load(root, &m.id).unwrap()["name"], "Renamed");
        let d = duplicate(root, &m.id).unwrap(); assert_eq!(d.name, "Renamed copy");
        assert_eq!(list(root).len(), 2);
        assert!(rename(root, &m.id, "   ").is_err());
        assert_eq!(media_paths(&load(root, &m.id).unwrap()), vec!["C:\\v.mp4".to_string()]);
        // damaged file falls back to the backup written by the previous save
        std::fs::write(root.join(&m.id).join("project.json"), "{broken").unwrap();
        assert_eq!(load(root, &m.id).unwrap()["width"], 1920);
        assert!(load(root, "../etc").is_err());
    }
}
