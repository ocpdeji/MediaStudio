//! File operations: validated names, batch rename (preview → apply → undo), recycle-bin delete,
//! atomic output writes that never overwrite silently, and Explorer integration.
use crate::db::{self, now_ms, AssetRow};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];

/// Validate a single Windows file name (not a path).
pub fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty() || name.trim().is_empty() { return Err("empty name".into()); }
    if name.len() > 240 { return Err("name too long".into()); }
    if let Some(c) = name.chars().find(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (*c as u32) < 32) { return Err(format!("invalid character '{c}'")); }
    if name.ends_with('.') || name.ends_with(' ') { return Err("cannot end with a dot or space".into()); }
    let stem = name.split('.').next().unwrap_or("").to_lowercase();
    if stem.trim().is_empty() { return Err("empty name".into()); }
    if RESERVED.contains(&stem.trim()) { return Err(format!("'{stem}' is reserved by Windows")); }
    Ok(())
}

pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') { Some(i) if i > 0 => (&name[..i], &name[i + 1..]), _ => (name, "") }
}

/// First free "name.ext", "name_2.ext", "name_3.ext"… in `dir`.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() { return p; }
    let (s, e) = split_ext(name);
    for n in 2.. { let c = dir.join(if e.is_empty() { format!("{s}_{n}") } else { format!("{s}_{n}.{e}") }); if !c.exists() { return c; } }
    unreachable!()
}

// ---------------------------------------------------------------- batch rename

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct RenameSpec { pub pattern: String, pub find: String, pub replace: String, pub start: i64, pub pad: usize, pub case: String, pub spaces: String, pub prefix: String, pub suffix: String }

#[derive(Serialize, Clone, Debug)]
pub struct Proposal { pub id: i64, pub folder: String, pub old_name: String, pub new_name: String, pub error: Option<String> }

fn iso_date(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468; let era = z.div_euclid(146_097); let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1; let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn compute_name(spec: &RenameSpec, a: &AssetRow, index: usize) -> String {
    let (stem, ext) = split_ext(&a.name);
    let pat = if spec.pattern.is_empty() { "{name}" } else { &spec.pattern };
    let n = (spec.start + index as i64).to_string();
    let num = format!("{:0>width$}", n, width = spec.pad.clamp(1, 8));
    let mut s = pat.replace("{name}", stem).replace("{n}", &num).replace("{date}", &iso_date(a.capture_time.unwrap_or(a.mtime)))
        .replace("{folder}", a.folder.rsplit('/').next().unwrap_or("")).replace("{ext}", &ext.to_lowercase())
        .replace("{w}", &a.width.map(|w| w.to_string()).unwrap_or_default()).replace("{h}", &a.height.map(|h| h.to_string()).unwrap_or_default());
    if !spec.find.is_empty() { s = s.replace(&spec.find, &spec.replace); }
    s = format!("{}{}{}", spec.prefix, s, spec.suffix);
    s = match spec.case.as_str() {
        "lower" => s.to_lowercase(), "upper" => s.to_uppercase(),
        "title" => { let mut out = String::new(); let mut up = true; for c in s.chars() { if up && c.is_alphabetic() { out.extend(c.to_uppercase()); up = false; } else { out.extend(c.to_lowercase()); } if c.is_whitespace() || c == '_' || c == '-' { up = true; } } out }
        _ => s,
    };
    s = match spec.spaces.as_str() { "_" => s.split_whitespace().collect::<Vec<_>>().join("_"), "-" => s.split_whitespace().collect::<Vec<_>>().join("-"), "none" => s.split_whitespace().collect(), _ => s };
    let s = s.trim().to_string();
    if ext.is_empty() { s } else { format!("{s}.{ext}") }
}

/// Validate proposed names against Windows rules, each other, and files already on disk.
pub fn check(items: &mut [Proposal], paths: &HashMap<i64, PathBuf>) {
    let olds: HashSet<String> = items.iter().filter_map(|p| paths.get(&p.id)).map(|p| p.to_string_lossy().to_lowercase()).collect();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for p in items.iter() { if let Some(src) = paths.get(&p.id) { *seen.entry(src.with_file_name(&p.new_name).to_string_lossy().to_lowercase()).or_default() += 1; } }
    for p in items.iter_mut() {
        let Some(src) = paths.get(&p.id) else { p.error = Some("missing from catalogue".into()); continue };
        if let Err(e) = validate_filename(&p.new_name) { p.error = Some(e); continue; }
        let target = src.with_file_name(&p.new_name);
        let tk = target.to_string_lossy().to_lowercase();
        if seen.get(&tk).copied().unwrap_or(0) > 1 { p.error = Some("duplicate name in this batch".into()); continue; }
        if !src.exists() { p.error = Some("source file is missing".into()); continue; }
        let case_only = tk == src.to_string_lossy().to_lowercase();
        if !case_only && target.exists() && !olds.contains(&tk) { p.error = Some("a file with this name already exists".into()); }
    }
}

pub fn preview(c: &Connection, ids: &[i64], spec: &RenameSpec) -> rusqlite::Result<Vec<Proposal>> {
    let assets = db::assets_by_ids(c, ids)?;
    let mut items: Vec<Proposal> = assets.iter().enumerate().map(|(i, a)| Proposal { id: a.id, folder: a.folder.clone(), old_name: a.name.clone(), new_name: compute_name(spec, a, i), error: None }).collect();
    let paths: HashMap<i64, PathBuf> = assets.iter().map(|a| (a.id, PathBuf::from(&a.path))).collect();
    check(&mut items, &paths);
    Ok(items)
}

#[derive(Serialize, Debug)]
pub struct RenameResult { pub batch: String, pub renamed: usize, pub errors: Vec<String> }

/// Apply renames. Uses a two-phase (temp names) strategy when names in the batch swap or chain.
pub fn apply(c: &mut Connection, renames: &[(i64, String)]) -> Result<RenameResult, String> {
    let ids: Vec<i64> = renames.iter().map(|r| r.0).collect();
    let assets = db::assets_by_ids(c, &ids).map_err(|e| e.to_string())?;
    let paths: HashMap<i64, PathBuf> = assets.iter().map(|a| (a.id, PathBuf::from(&a.path))).collect();
    let mut items: Vec<Proposal> = renames.iter().map(|(id, n)| Proposal { id: *id, folder: String::new(), old_name: String::new(), new_name: n.clone(), error: None }).collect();
    check(&mut items, &paths);
    if let Some(bad) = items.iter().find(|p| p.error.is_some()) { return Err(format!("{}: {}", bad.new_name, bad.error.clone().unwrap())); }
    let jobs: Vec<(i64, PathBuf, PathBuf)> = items.iter().map(|p| { let s = paths[&p.id].clone(); let t = s.with_file_name(&p.new_name); (p.id, s, t) }).filter(|(_, s, t)| s != t).collect();
    let olds: HashSet<String> = jobs.iter().map(|j| j.1.to_string_lossy().to_lowercase()).collect();
    let chained = jobs.iter().any(|j| olds.contains(&j.2.to_string_lossy().to_lowercase()) && j.1.to_string_lossy().to_lowercase() != j.2.to_string_lossy().to_lowercase());
    let batch = format!("r{}", now_ms());
    let mut done: Vec<(i64, PathBuf, PathBuf)> = vec![];
    let mut errors = vec![];
    if chained {
        let mut staged = vec![];
        for (i, (id, s, t)) in jobs.iter().enumerate() {
            let tmp = s.with_file_name(format!(".msp-rename-{}-{i}.tmp", now_ms()));
            match std::fs::rename(s, &tmp) { Ok(_) => staged.push((*id, s.clone(), tmp, t.clone())), Err(e) => { errors.push(format!("{}: {e}", s.display())); break; } }
        }
        for (id, s, tmp, t) in staged {
            match std::fs::rename(&tmp, &t) { Ok(_) => done.push((id, s, t)), Err(e) => { let _ = std::fs::rename(&tmp, &s); errors.push(format!("{}: {e}", t.display())); } }
        }
    } else {
        for (id, s, t) in jobs { match std::fs::rename(&s, &t) { Ok(_) => done.push((id, s, t)), Err(e) => errors.push(format!("{}: {e}", s.display())) } }
    }
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    // park paths first so swapped/chained names never violate the UNIQUE(path) constraint mid-update
    for (id, _, _) in &done { tx.execute("UPDATE assets SET path='<renaming>'||id WHERE id=?", [id]).map_err(|e| e.to_string())?; }
    for (id, s, t) in &done {
        let name = t.file_name().unwrap().to_string_lossy().into_owned();
        tx.execute("UPDATE assets SET path=?, name=?, rel=substr(rel,1,length(rel)-length(name))||? WHERE id=?", params![t.to_string_lossy(), name, name, id]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO rename_log(batch,asset_id,old_path,new_path,at) VALUES(?,?,?,?,?)", params![batch, id, s.to_string_lossy(), t.to_string_lossy(), now_ms()]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(RenameResult { batch, renamed: done.len(), errors })
}

pub fn undo(c: &mut Connection, batch: &str) -> Result<RenameResult, String> {
    let rows: Vec<(i64, String, String)> = {
        let mut st = c.prepare("SELECT asset_id,old_path,new_path FROM rename_log WHERE batch=? ORDER BY id DESC").map_err(|e| e.to_string())?;
        st.query_map([batch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect()
    };
    if rows.is_empty() { return Err("Nothing to undo for this batch".into()); }
    let renames: Vec<(i64, String)> = rows.iter().map(|(id, old, _)| (*id, Path::new(old).file_name().unwrap().to_string_lossy().into_owned())).collect();
    let r = apply(c, &renames)?;
    c.execute("DELETE FROM rename_log WHERE batch=?", [batch]).map_err(|e| e.to_string())?;
    Ok(r)
}

// ---------------------------------------------------------------- delete / write / reveal

/// Move files to the Windows Recycle Bin and drop them from the catalogue. Nothing is permanently deleted.
pub fn recycle(c: &Connection, ids: &[i64]) -> Result<usize, String> {
    let assets = db::assets_by_ids(c, ids).map_err(|e| e.to_string())?;
    let existing: Vec<&AssetRow> = assets.iter().filter(|a| Path::new(&a.path).exists()).collect();
    if !existing.is_empty() { trash::delete_all(existing.iter().map(|a| &a.path)).map_err(|e| format!("Recycle Bin: {e}"))?; }
    for a in &assets { c.execute("DELETE FROM assets WHERE id=?", [a.id]).map_err(|e| e.to_string())?; }
    Ok(assets.len())
}

/// Atomic write: temp file in the same folder → rename. Refuses to overwrite unless `overwrite`.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8], overwrite: bool) -> Result<PathBuf, String> {
    validate_filename(name)?;
    if !dir.is_dir() { return Err(format!("Folder does not exist: {}", dir.display())); }
    let target = if overwrite { dir.join(name) } else { unique_path(dir, name) };
    if let Ok(free) = fs4::available_space(dir) { if free < bytes.len() as u64 + 16 * 1024 * 1024 { return Err("Not enough free disk space".into()); } }
    let tmp = dir.join(format!(".{}.msp-tmp", now_ms()));
    std::fs::write(&tmp, bytes).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })?;
    std::fs::rename(&tmp, &target).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })?;
    Ok(target)
}

pub fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let p = path.to_string_lossy();
        if p.contains('"') { return Err("invalid path".into()); }
        std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{p}\"")).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn asset(id: i64, path: &Path) -> AssetRow {
        AssetRow { id, library_id: 1, path: path.to_string_lossy().into(), rel: format!("lib/{}", path.file_name().unwrap().to_string_lossy()), folder: "lib".into(),
            name: path.file_name().unwrap().to_string_lossy().into(), ext: "jpg".into(), kind: "image".into(), size: 1, mtime: 1_709_208_000_000, width: Some(10), height: Some(20),
            duration_ms: None, fps_num: None, fps_den: None, has_audio: None, rating: 0, favorite: false, rejected: false, color: None, missing: false, probed: true, capture_time: None }
    }
    #[test] fn filenames() {
        assert!(validate_filename("ok name.jpg").is_ok());
        assert!(validate_filename("CON.jpg").is_err());
        assert!(validate_filename("a:b.jpg").is_err());
        assert!(validate_filename("trailing.").is_err());
        assert!(validate_filename("ünïcødé 日本.png").is_ok());
    }
    #[test] fn compute() {
        let a = asset(1, Path::new("C:/x/My Shot.JPG"));
        let s = RenameSpec { pattern: "{date}_{name}_{n}".into(), start: 7, pad: 3, spaces: "_".into(), case: "lower".into(), ..Default::default() };
        assert_eq!(compute_name(&s, &a, 0), "2024-02-29_my_shot_007.JPG");
        let s = RenameSpec { pattern: "{name}".into(), find: "Shot".into(), replace: "Take".into(), prefix: "A ".into(), ..Default::default() };
        assert_eq!(compute_name(&s, &a, 0), "A My Take.JPG");
    }
    fn setup(names: &[&str]) -> (tempfile::TempDir, Connection) {
        let d = tempfile::tempdir().unwrap();
        let mut c = Connection::open_in_memory().unwrap(); db::migrate(&mut c).unwrap();
        c.execute("INSERT INTO libraries(id,path,name,added_at) VALUES(1,?,'lib',0)", [d.path().to_string_lossy()]).unwrap();
        for (i, n) in names.iter().enumerate() {
            let p = d.path().join(n); std::fs::write(&p, n.as_bytes()).unwrap();
            c.execute("INSERT INTO assets(id,library_id,path,rel,folder,name,ext,kind,size,mtime,imported_at) VALUES(?,1,?,?,'lib',?,'jpg','image',1,0,0)",
                params![i as i64 + 1, p.to_string_lossy(), format!("lib/{n}"), n]).unwrap();
        }
        (d, c)
    }
    #[test] fn collisions_detected_before_writing() {
        let (d, c) = setup(&["a.jpg", "b.jpg", "c.jpg"]);
        std::fs::write(d.path().join("taken.jpg"), b"x").unwrap();
        let p = preview(&c, &[1, 2], &RenameSpec { pattern: "same".into(), ..Default::default() }).unwrap();
        assert!(p.iter().all(|x| x.error.as_deref() == Some("duplicate name in this batch")));
        let p = preview(&c, &[1], &RenameSpec { pattern: "taken".into(), ..Default::default() }).unwrap();
        assert_eq!(p[0].error.as_deref(), Some("a file with this name already exists"));
        let p = preview(&c, &[3], &RenameSpec { pattern: "C".into(), ..Default::default() }).unwrap();
        assert!(p[0].error.is_none(), "case-only rename allowed");
    }
    #[test] fn swap_chain_apply_and_undo() {
        let (d, mut c) = setup(&["a.jpg", "b.jpg"]);
        let r = apply(&mut c, &[(1, "b.jpg".into()), (2, "a.jpg".into())]).unwrap();
        assert_eq!(r.renamed, 2);
        assert_eq!(std::fs::read(d.path().join("b.jpg")).unwrap(), b"a.jpg");
        assert_eq!(std::fs::read(d.path().join("a.jpg")).unwrap(), b"b.jpg");
        let name: String = c.query_row("SELECT name FROM assets WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "b.jpg");
        undo(&mut c, &r.batch).unwrap();
        assert_eq!(std::fs::read(d.path().join("a.jpg")).unwrap(), b"a.jpg");
        assert!(apply(&mut c, &[(1, "bad|name.jpg".into())]).is_err());
    }
    #[test] fn atomic_write_never_overwrites_by_default() {
        let d = tempfile::tempdir().unwrap();
        let a = write_atomic(d.path(), "out.png", b"1", false).unwrap();
        let b = write_atomic(d.path(), "out.png", b"2", false).unwrap();
        assert_eq!(b.file_name().unwrap(), "out_2.png");
        assert_eq!(std::fs::read(&a).unwrap(), b"1");
        write_atomic(d.path(), "out.png", b"3", true).unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), b"3");
        assert!(write_atomic(d.path(), "../escape.png", b"x", false).is_err());
    }
}
