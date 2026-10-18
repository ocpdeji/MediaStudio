//! Library scanning (new / changed / missing / moved detection) and background metadata probing.
use crate::db::{self, now_ms};
use crate::media;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

const SKIP_DIRS: &[&str] = &["$recycle.bin", "system volume information", "node_modules", ".git", "_rejected"];

#[derive(Serialize, Clone, Debug, Default)]
pub struct ScanStats { pub library_id: i64, pub found: usize, pub added: usize, pub changed: usize, pub missing: usize, pub moved: usize, pub restored: usize, pub errors: usize, pub done: bool }

pub struct Found { pub path: String, pub rel: String, pub folder: String, pub name: String, pub ext: String, pub kind: &'static str, pub size: i64, pub mtime: i64, pub ctime: Option<i64> }

/// Forward-slash relative path; folder includes the library root name so trees read naturally.
pub fn rel_parts(root: &Path, p: &Path) -> Option<(String, String, String)> {
    let rel = p.strip_prefix(root).ok()?;
    let root_name = root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| root.to_string_lossy().trim_end_matches(['\\', '/']).replace(':', ""));
    let rel_s = rel.to_string_lossy().replace('\\', "/");
    let full = format!("{root_name}/{rel_s}");
    let (folder, name) = full.rsplit_once('/').map(|(a, b)| (a.to_string(), b.to_string()))?;
    Some((full, folder, name))
}

fn to_ms(t: std::io::Result<std::time::SystemTime>) -> Option<i64> { t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64) }

pub fn stat_file(root: &Path, p: &Path) -> Option<Found> {
    let ext = p.extension()?.to_string_lossy().to_lowercase();
    let kind = media::classify(&ext)?;
    let md = std::fs::metadata(p).ok()?;
    if !md.is_file() { return None; }
    let (rel, folder, name) = rel_parts(root, p)?;
    Some(Found { path: p.to_string_lossy().into_owned(), rel, folder, name, ext, kind, size: md.len() as i64, mtime: to_ms(md.modified()).unwrap_or(0), ctime: to_ms(md.created()) })
}

pub fn walk(root: &Path, excluded: &[String], mut on_progress: impl FnMut(usize)) -> (Vec<Found>, usize) {
    let mut out = vec![];
    let mut errors = 0;
    let ex: Vec<String> = excluded.iter().map(|s| s.to_lowercase()).collect();
    let it = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        if e.depth() == 0 || !e.file_type().is_dir() { return true; }
        let n = e.file_name().to_string_lossy().to_lowercase();
        !(n.starts_with('.') || SKIP_DIRS.contains(&n.as_str()) || ex.contains(&n))
    });
    for e in it {
        match e {
            Ok(e) if e.file_type().is_file() => { if let Some(f) = stat_file(root, e.path()) { out.push(f); if out.len() % 500 == 0 { on_progress(out.len()); } } }
            Ok(_) => {}
            Err(_) => errors += 1,
        }
    }
    (out, errors)
}

/// Reconcile a walk with the catalogue. Annotations survive moves: a new file with the same name+size as a
/// file that went missing inherits its rating/flags/tags/collections.
pub fn reconcile(c: &mut Connection, lib_id: i64, found: Vec<Found>) -> rusqlite::Result<ScanStats> {
    let mut st = ScanStats { library_id: lib_id, found: found.len(), ..Default::default() };
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut existing: HashMap<String, (i64, i64, i64, bool)> = HashMap::new();
    {
        let mut q = tx.prepare("SELECT id,path,size,mtime,missing FROM assets WHERE library_id=?")?;
        for r in q.query_map([lib_id], |r| Ok((r.get::<_, String>(1)?, (r.get(0)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? != 0))))? { let (k, v) = r?; existing.insert(k.to_lowercase(), v); }
    }
    let now = now_ms();
    let mut seen = std::collections::HashSet::new();
    let mut new_files = vec![];
    {
        let mut upd = tx.prepare("UPDATE assets SET size=?,mtime=?,probed=0,probe_error=NULL,missing=0,phash=NULL WHERE id=?")?;
        let mut restore = tx.prepare("UPDATE assets SET missing=0 WHERE id=?")?;
        for f in found {
            let key = f.path.to_lowercase();
            if let Some(&(id, size, mtime, missing)) = existing.get(&key) {
                seen.insert(key);
                if size != f.size || mtime != f.mtime { upd.execute(params![f.size, f.mtime, id])?; st.changed += 1; }
                else if missing { restore.execute([id])?; st.restored += 1; }
            } else { new_files.push(f); }
        }
    }
    // files that disappeared
    let gone: Vec<i64> = existing.iter().filter(|(k, v)| !seen.contains(*k) && !v.3).map(|(_, v)| v.0).collect();
    { let mut m = tx.prepare("UPDATE assets SET missing=1 WHERE id=?")?; for id in &gone { m.execute([id])?; } }
    st.missing = gone.len();
    {
        let mut ins = tx.prepare("INSERT INTO assets(library_id,path,rel,folder,name,ext,kind,size,mtime,ctime,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")?;
        let mut find_moved = tx.prepare("SELECT id FROM assets WHERE missing=1 AND name=? COLLATE NOCASE AND size=? LIMIT 1")?;
        let mut mv = tx.prepare("UPDATE assets SET library_id=?,path=?,rel=?,folder=?,name=?,mtime=?,missing=0 WHERE id=?")?;
        for f in new_files {
            let moved: Option<i64> = find_moved.query_row(params![f.name, f.size], |r| r.get(0)).ok();
            if let Some(id) = moved {
                mv.execute(params![lib_id, f.path, f.rel, f.folder, f.name, f.mtime, id])?; st.moved += 1;
                if st.missing > 0 { st.missing -= 1; }
            } else {
                ins.execute(params![lib_id, f.path, f.rel, f.folder, f.name, f.ext, f.kind, f.size, f.mtime, f.ctime, now])?; st.added += 1;
            }
        }
    }
    tx.execute("UPDATE libraries SET last_scan=? WHERE id=?", params![now, lib_id])?;
    tx.commit()?;
    st.done = true;
    Ok(st)
}

/// Insert or refresh a single file (used after the app writes an output into a library folder).
pub fn upsert_file(c: &Connection, path: &Path) -> rusqlite::Result<Option<i64>> {
    let libs = db::list_libraries(c)?;
    let Some(lib) = libs.iter().filter(|l| path.starts_with(&l.path)).max_by_key(|l| l.path.len()) else { return Ok(None) };
    let Some(f) = stat_file(Path::new(&lib.path), path) else { return Ok(None) };
    c.execute("INSERT INTO assets(library_id,path,rel,folder,name,ext,kind,size,mtime,ctime,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, missing=0, probed=0, phash=NULL",
        params![lib.id, f.path, f.rel, f.folder, f.name, f.ext, f.kind, f.size, f.mtime, f.ctime, now_ms()])?;
    Ok(Some(c.query_row("SELECT id FROM assets WHERE path=?", [&f.path], |r| r.get(0))?))
}

/// Probe up to `batch` unprobed assets. Returns how many were processed (0 = nothing left).
pub fn probe_batch(c: &Connection, batch: usize) -> rusqlite::Result<Vec<i64>> {
    let todo: Vec<(i64, String, String)> = {
        let mut q = c.prepare("SELECT id,path,kind FROM assets WHERE probed=0 AND missing=0 ORDER BY id LIMIT ?")?;
        q.query_map([batch as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?
    };
    let mut done = vec![];
    for (id, path, kind) in todo {
        let p = PathBuf::from(&path);
        let res = match kind.as_str() {
            "image" if !path.to_lowercase().ends_with(".svg") => media::probe_image(&p),
            "image" => Ok(media::Probe::default()),
            "raw" => media::probe_image(&p),
            _ => media::ffprobe_json(&p).map(|j| media::parse_probe(&j)),
        };
        match res {
            Ok(m) => { c.execute("UPDATE assets SET width=?,height=?,duration_ms=?,fps_num=?,fps_den=?,vcodec=?,acodec=?,bitrate=?,has_audio=?,rotation=?,capture_time=?,probed=1,probe_error=NULL WHERE id=?",
                params![m.width, m.height, m.duration_ms, m.fps_num, m.fps_den, m.vcodec, m.acodec, m.bitrate, m.has_audio as i64, m.rotation, m.capture_time, id])?; }
            Err(e) => { c.execute("UPDATE assets SET probed=1,probe_error=? WHERE id=?", params![e, id])?; }
        }
        done.push(id);
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test] fn long_windows_paths_and_unicode_are_scanned() {
        let dir = tempfile::tempdir().unwrap();
        let mut deep = dir.path().join("lib");
        for i in 0..6 { deep = deep.join(format!("very_long_folder_name_number_{i}_ünïcødé_日本")); }
        fs::create_dir_all(&deep).unwrap();
        let file = deep.join(format!("{}.mp4", "long_named_file_".repeat(5)));
        fs::write(&file, b"x").unwrap();
        assert!(file.to_string_lossy().len() > 260, "path should exceed MAX_PATH: {}", file.to_string_lossy().len());
        let (found, errors) = walk(&dir.path().join("lib"), &[], |_| {});
        assert_eq!((found.len(), errors), (1, 0));
        assert!(found[0].rel.ends_with(".mp4") && found[0].folder.contains("日本"));
    }
    #[test] fn scan_add_change_missing_move_restore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Shoot ü 2024");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("a.jpg"), b"aaaa").unwrap();
        fs::write(root.join("sub/b.MP4"), b"bbbbbb").unwrap();
        fs::write(root.join("notes.txt"), b"x").unwrap();
        fs::write(root.join(".hidden/c.png"), b"c").unwrap();
        let mut c = db::open(&dir.path().join("t.db")).unwrap();
        db::migrate(&mut c).unwrap();
        c.execute("INSERT INTO libraries(id,path,name,added_at) VALUES(1,?,?,0)", params![root.to_string_lossy(), "x"]).unwrap();
        let s = reconcile(&mut c, 1, walk(&root, &[], |_| {}).0).unwrap();
        assert_eq!((s.found, s.added), (2, 2));
        let rel: String = c.query_row("SELECT rel FROM assets WHERE name='b.MP4'", [], |r| r.get(0)).unwrap();
        assert_eq!(rel, "Shoot ü 2024/sub/b.MP4");
        // rate a.jpg, then move it into sub/ → annotations follow
        c.execute("UPDATE assets SET rating=4 WHERE name='a.jpg'", []).unwrap();
        fs::rename(root.join("a.jpg"), root.join("sub/a.jpg")).unwrap();
        fs::write(root.join("sub/b.MP4"), b"changed!!").unwrap();
        let s = reconcile(&mut c, 1, walk(&root, &[], |_| {}).0).unwrap();
        assert_eq!((s.moved, s.changed, s.added, s.missing), (1, 1, 0, 0));
        let (rating, folder): (i64, String) = c.query_row("SELECT rating,folder FROM assets WHERE name='a.jpg'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((rating, folder.as_str()), (4, "Shoot ü 2024/sub"));
        // delete → missing (row kept, annotations kept)
        fs::remove_file(root.join("sub/b.MP4")).unwrap();
        let s = reconcile(&mut c, 1, walk(&root, &["SUB2".into()], |_| {}).0).unwrap();
        assert_eq!(s.missing, 1);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}
