//! SQLite catalogue: schema, migrations and typed queries.
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i32 = 1;

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE libraries(
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        added_at INTEGER NOT NULL, last_scan INTEGER, excluded TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE assets(
        id INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE, rel TEXT NOT NULL, folder TEXT NOT NULL, name TEXT NOT NULL,
        ext TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, ctime INTEGER,
        imported_at INTEGER NOT NULL,
        width INTEGER, height INTEGER, duration_ms INTEGER, fps_num INTEGER, fps_den INTEGER,
        vcodec TEXT, acodec TEXT, bitrate INTEGER, has_audio INTEGER, rotation INTEGER, capture_time INTEGER,
        probed INTEGER NOT NULL DEFAULT 0, probe_error TEXT, missing INTEGER NOT NULL DEFAULT 0, phash INTEGER,
        rating INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
        color TEXT, notes TEXT);
    CREATE INDEX ix_assets_lib ON assets(library_id);
    CREATE INDEX ix_assets_folder ON assets(folder);
    CREATE INDEX ix_assets_kind ON assets(kind);
    CREATE INDEX ix_assets_mtime ON assets(mtime);
    CREATE INDEX ix_assets_size ON assets(size);
    CREATE INDEX ix_assets_rating ON assets(rating);
    CREATE INDEX ix_assets_probed ON assets(probed) WHERE probed = 0;
    CREATE INDEX ix_assets_missing ON assets(missing);
    CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE TABLE asset_tags(
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(asset_id, tag_id));
    CREATE INDEX ix_asset_tags_tag ON asset_tags(tag_id);
    CREATE TABLE collections(id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE collection_items(
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(collection_id, asset_id));
    CREATE TABLE saved_searches(id INTEGER PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL);
    CREATE TABLE jobs(
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0, params TEXT NOT NULL, result TEXT, error TEXT,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
    CREATE INDEX ix_jobs_status ON jobs(status);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE recent_projects(path TEXT PRIMARY KEY, opened_at INTEGER NOT NULL);
    CREATE TABLE rename_log(id INTEGER PRIMARY KEY, batch TEXT NOT NULL, asset_id INTEGER, old_path TEXT NOT NULL, new_path TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX ix_rename_batch ON rename_log(batch);
    "#,
];

pub fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.busy_timeout(std::time::Duration::from_secs(10))?;
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;")?;
    Ok(c)
}

/// Apply pending migrations inside a transaction each. Returns (from, to).
pub fn migrate(c: &mut Connection) -> rusqlite::Result<(i32, i32)> {
    let from: i32 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let v = i as i32 + 1;
        if v <= from { continue; }
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", v)?;
        tx.commit()?;
    }
    Ok((from, SCHEMA_VERSION))
}

// ---------------------------------------------------------------- types

#[derive(Serialize, Clone, Debug)]
pub struct Library { pub id: i64, pub path: String, pub name: String, pub added_at: i64, pub last_scan: Option<i64>, pub count: i64, pub missing: i64, pub online: bool }

#[derive(Serialize, Clone, Debug)]
pub struct AssetRow {
    pub id: i64, pub library_id: i64, pub path: String, pub rel: String, pub folder: String, pub name: String, pub ext: String, pub kind: String,
    pub size: i64, pub mtime: i64, pub width: Option<i64>, pub height: Option<i64>, pub duration_ms: Option<i64>,
    pub fps_num: Option<i64>, pub fps_den: Option<i64>, pub has_audio: Option<bool>, pub rating: i64, pub favorite: bool, pub rejected: bool,
    pub color: Option<String>, pub missing: bool, pub probed: bool, pub capture_time: Option<i64>,
}
const ASSET_COLS: &str = "a.id,a.library_id,a.path,a.rel,a.folder,a.name,a.ext,a.kind,a.size,a.mtime,a.width,a.height,a.duration_ms,a.fps_num,a.fps_den,a.has_audio,a.rating,a.favorite,a.rejected,a.color,a.missing,a.probed,a.capture_time";
fn asset_from_row(r: &rusqlite::Row) -> rusqlite::Result<AssetRow> {
    Ok(AssetRow {
        id: r.get(0)?, library_id: r.get(1)?, path: r.get(2)?, rel: r.get(3)?, folder: r.get(4)?, name: r.get(5)?, ext: r.get(6)?, kind: r.get(7)?,
        size: r.get(8)?, mtime: r.get(9)?, width: r.get(10)?, height: r.get(11)?, duration_ms: r.get(12)?, fps_num: r.get(13)?, fps_den: r.get(14)?,
        has_audio: r.get::<_, Option<i64>>(15)?.map(|v| v != 0), rating: r.get(16)?, favorite: r.get::<_, i64>(17)? != 0, rejected: r.get::<_, i64>(18)? != 0,
        color: r.get(19)?, missing: r.get::<_, i64>(20)? != 0, probed: r.get::<_, i64>(21)? != 0, capture_time: r.get(22)?,
    })
}

#[derive(Deserialize, Serialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Query {
    pub text: String,
    pub kinds: Vec<String>,
    pub exts: Vec<String>,
    pub library_id: Option<i64>,
    pub folder: Option<String>,
    pub recursive: bool,
    pub min_rating: i64,
    pub unrated_only: bool,
    pub favorites_only: bool,
    /// "hide" (default) | "only" | "any"
    pub rejected: String,
    pub colors: Vec<String>,
    pub tag_ids: Vec<i64>,
    pub collection_id: Option<i64>,
    pub size_min: Option<i64>, pub size_max: Option<i64>,
    pub width_min: Option<i64>, pub height_min: Option<i64>,
    pub dur_min_ms: Option<i64>, pub dur_max_ms: Option<i64>,
    /// "landscape" | "portrait" | "square"
    pub orientation: String,
    pub mtime_from: Option<i64>, pub mtime_to: Option<i64>,
    pub missing_only: bool,
    pub sort: String,
    pub desc: bool,
    pub limit: Option<i64>,
}

/// Build WHERE clause + params from a query. Only whitelisted columns ever reach SQL text.
pub fn build_where(q: &Query) -> (String, Vec<Value>) {
    let mut w: Vec<String> = vec![];
    let mut p: Vec<Value> = vec![];
    for term in q.text.split_whitespace() {
        let like = format!("%{}%", term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        w.push("(a.rel LIKE ? ESCAPE '\\' OR a.notes LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM asset_tags at JOIN tags t ON t.id=at.tag_id WHERE at.asset_id=a.id AND t.name LIKE ? ESCAPE '\\'))".into());
        p.push(Value::Text(like.clone())); p.push(Value::Text(like.clone())); p.push(Value::Text(like));
    }
    let list = |w: &mut Vec<String>, p: &mut Vec<Value>, col: &str, vals: &Vec<String>| {
        if vals.is_empty() { return; }
        w.push(format!("{col} IN ({})", vec!["?"; vals.len()].join(",")));
        p.extend(vals.iter().map(|v| Value::Text(v.to_lowercase())));
    };
    list(&mut w, &mut p, "a.kind", &q.kinds);
    list(&mut w, &mut p, "a.ext", &q.exts);
    if let Some(l) = q.library_id { w.push("a.library_id = ?".into()); p.push(Value::Integer(l)); }
    if let Some(f) = &q.folder {
        if q.recursive && !f.is_empty() {
            w.push("(a.folder = ? OR substr(a.folder, 1, ?) = ?)".into());
            let pre = format!("{f}/");
            p.push(Value::Text(f.clone())); p.push(Value::Integer(pre.chars().count() as i64)); p.push(Value::Text(pre));
        } else if !q.recursive { w.push("a.folder = ?".into()); p.push(Value::Text(f.clone())); }
    }
    if q.unrated_only { w.push("a.rating = 0".into()); }
    else if q.min_rating > 0 { w.push("a.rating >= ?".into()); p.push(Value::Integer(q.min_rating)); }
    if q.favorites_only { w.push("a.favorite = 1".into()); }
    match q.rejected.as_str() { "only" => w.push("a.rejected = 1".into()), "any" => {}, _ => w.push("a.rejected = 0".into()) }
    if !q.colors.is_empty() {
        w.push(format!("a.color IN ({})", vec!["?"; q.colors.len()].join(",")));
        p.extend(q.colors.iter().map(|c| Value::Text(c.clone())));
    }
    for t in &q.tag_ids { w.push("EXISTS(SELECT 1 FROM asset_tags x WHERE x.asset_id=a.id AND x.tag_id=?)".into()); p.push(Value::Integer(*t)); }
    if let Some(c) = q.collection_id { w.push("EXISTS(SELECT 1 FROM collection_items ci WHERE ci.asset_id=a.id AND ci.collection_id=?)".into()); p.push(Value::Integer(c)); }
    let mut range = |col: &str, op: &str, v: Option<i64>| if let Some(v) = v { w.push(format!("{col} {op} ?")); p.push(Value::Integer(v)); };
    range("a.size", ">=", q.size_min); range("a.size", "<=", q.size_max);
    range("a.width", ">=", q.width_min); range("a.height", ">=", q.height_min);
    range("a.duration_ms", ">=", q.dur_min_ms); range("a.duration_ms", "<=", q.dur_max_ms);
    range("a.mtime", ">=", q.mtime_from); range("a.mtime", "<=", q.mtime_to);
    match q.orientation.as_str() {
        "landscape" => w.push("a.width > a.height".into()),
        "portrait" => w.push("a.width < a.height".into()),
        "square" => w.push("a.width = a.height".into()),
        _ => {}
    }
    if q.missing_only { w.push("a.missing = 1".into()); }
    let clause = if w.is_empty() { String::new() } else { format!("WHERE {}", w.join(" AND ")) };
    (clause, p)
}

fn sort_sql(sort: &str) -> &'static str {
    match sort {
        "mtime" => "a.mtime", "size" => "a.size", "duration" => "COALESCE(a.duration_ms,-1)", "width" => "COALESCE(a.width,-1)",
        "height" => "COALESCE(a.height,-1)", "resolution" => "COALESCE(a.width*a.height,-1)", "aspect" => "COALESCE(CAST(a.width AS REAL)/NULLIF(a.height,0),-1)",
        "rating" => "a.rating", "type" => "a.kind, a.ext", "capture" => "COALESCE(a.capture_time, a.mtime)", "imported" => "a.imported_at", "ctime" => "COALESCE(a.ctime,a.mtime)",
        _ => "",
    }
}

pub fn query_assets(c: &Connection, q: &Query) -> rusqlite::Result<Vec<AssetRow>> {
    let (wh, p) = build_where(q);
    let order = sort_sql(&q.sort);
    let dir = if q.desc { "DESC" } else { "ASC" };
    let sql = if order.is_empty() { format!("SELECT {ASSET_COLS} FROM assets a {wh}") }
              else { format!("SELECT {ASSET_COLS} FROM assets a {wh} ORDER BY {order} {dir}, a.rel COLLATE NOCASE") };
    let mut st = c.prepare_cached(&sql)?;
    let mut rows: Vec<AssetRow> = st.query_map(params_from_iter(p), asset_from_row)?.collect::<Result<_, _>>()?;
    if order.is_empty() {
        // natural, case-insensitive ordering for name / folder (SQLite has no natural collation)
        let key_folder = q.sort == "folder";
        rows.sort_by(|a, b| {
            let o = if key_folder { natural_cmp(&a.folder, &b.folder).then_with(|| natural_cmp(&a.name, &b.name)) }
                    else { natural_cmp(&a.name, &b.name).then_with(|| natural_cmp(&a.folder, &b.folder)) };
            if q.desc { o.reverse() } else { o }
        });
    }
    if let Some(l) = q.limit { rows.truncate(l.max(0) as usize); }
    Ok(rows)
}

/// Natural, case-insensitive string comparison ("img2" < "img10").
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ia, mut ib) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new(); while let Some(&c) = ia.peek() { if c.is_ascii_digit() { na.push(c); ia.next(); } else { break; } }
                let mut nb = String::new(); while let Some(&c) = ib.peek() { if c.is_ascii_digit() { nb.push(c); ib.next(); } else { break; } }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb)).then_with(|| na.len().cmp(&nb.len()));
                if o != Ordering::Equal { return o; }
            }
            (Some(x), Some(y)) => {
                let o = x.to_lowercase().cmp(y.to_lowercase());
                if o != Ordering::Equal { return o; }
                ia.next(); ib.next();
            }
        }
    }
}

pub fn get_asset(c: &Connection, id: i64) -> rusqlite::Result<Option<AssetRow>> {
    c.query_row(&format!("SELECT {ASSET_COLS} FROM assets a WHERE a.id=?"), [id], asset_from_row).optional()
}
pub fn assets_by_ids(c: &Connection, ids: &[i64]) -> rusqlite::Result<Vec<AssetRow>> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids { if let Some(a) = get_asset(c, *id)? { out.push(a); } }
    Ok(out)
}

pub fn list_libraries(c: &Connection) -> rusqlite::Result<Vec<Library>> {
    let mut st = c.prepare("SELECT l.id,l.path,l.name,l.added_at,l.last_scan,(SELECT COUNT(*) FROM assets a WHERE a.library_id=l.id AND a.missing=0),(SELECT COUNT(*) FROM assets a WHERE a.library_id=l.id AND a.missing=1) FROM libraries l ORDER BY l.name COLLATE NOCASE")?;
    let v = st.query_map([], |r| {
        let path: String = r.get(1)?;
        Ok(Library { online: Path::new(&path).is_dir(), id: r.get(0)?, path, name: r.get(2)?, added_at: r.get(3)?, last_scan: r.get(4)?, count: r.get(5)?, missing: r.get(6)? })
    })?.collect();
    v
}

/// Folder list for the tree (distinct folders with counts) for one library.
pub fn folders(c: &Connection, library_id: i64) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut st = c.prepare("SELECT folder, COUNT(*) FROM assets WHERE library_id=? AND missing=0 GROUP BY folder")?;
    let mut v: Vec<(String, i64)> = st.query_map([library_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    v.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    Ok(v)
}

pub fn set_field_many(c: &mut Connection, ids: &[i64], field: &str, value: Value) -> rusqlite::Result<usize> {
    let col = match field { "rating" => "rating", "favorite" => "favorite", "rejected" => "rejected", "color" => "color", "notes" => "notes", _ => return Ok(0) };
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut n = 0;
    { let mut st = tx.prepare(&format!("UPDATE assets SET {col}=? WHERE id=?"))?;
      for id in ids { n += st.execute(params![value, id])?; } }
    tx.commit()?;
    Ok(n)
}

pub fn get_setting(c: &Connection, key: &str) -> Option<String> {
    c.query_row("SELECT value FROM settings WHERE key=?", [key], |r| r.get(0)).optional().ok().flatten()
}
pub fn set_setting(c: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map(|_| ())
}

pub fn db_path(app_data: &Path) -> PathBuf { app_data.join("catalog.db") }

#[cfg(test)]
mod tests {
    use super::*;
    fn mem() -> Connection { let mut c = Connection::open_in_memory().unwrap(); c.execute_batch("PRAGMA foreign_keys=ON").unwrap(); migrate(&mut c).unwrap(); c }
    fn add(c: &Connection, id: i64, rel: &str, kind: &str, size: i64, w: i64, h: i64, rating: i64) {
        let (folder, name) = rel.rsplit_once('/').unwrap_or(("", rel));
        let ext = name.rsplit_once('.').map(|x| x.1).unwrap_or("").to_lowercase();
        c.execute("INSERT INTO assets(id,library_id,path,rel,folder,name,ext,kind,size,mtime,imported_at,width,height,rating) VALUES(?,1,?,?,?,?,?,?,?,?,0,?,?,?)",
            params![id, format!("C:/lib/{rel}"), rel, folder, name, ext, kind, size, id * 10, w, h, rating]).unwrap();
    }
    fn setup() -> Connection {
        let c = mem();
        c.execute("INSERT INTO libraries(id,path,name,added_at) VALUES(1,'C:/lib','lib',0)", []).unwrap();
        add(&c, 1, "A/img10.jpg", "image", 300, 100, 50, 0);
        add(&c, 2, "A/img2.jpg", "image", 100, 50, 100, 5);
        add(&c, 3, "A/sub/clip.mp4", "video", 200, 1920, 1080, 3);
        add(&c, 4, "B/Song_final.wav", "audio", 50, 0, 0, 0);
        c
    }
    #[test] fn migrations_idempotent() { let mut c = mem(); assert_eq!(migrate(&mut c).unwrap(), (1, 1)); }
    #[test] fn natural() {
        assert_eq!(natural_cmp("img2", "img10"), Ordering::Less);
        assert_eq!(natural_cmp("IMG2", "img2"), Ordering::Equal);
        assert_eq!(natural_cmp("a01", "a1"), Ordering::Greater);
    }
    #[test] fn name_sort_is_natural() {
        let c = setup();
        let r = query_assets(&c, &Query { sort: "name".into(), ..Default::default() }).unwrap();
        let names: Vec<_> = r.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["clip.mp4", "img2.jpg", "img10.jpg", "Song_final.wav"]);
    }
    #[test] fn filters() {
        let c = setup();
        let q = |q: Query| query_assets(&c, &q).unwrap().iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(q(Query { kinds: vec!["video".into()], ..Default::default() }), [3]);
        assert_eq!(q(Query { text: "IMG jpg".into(), sort: "size".into(), ..Default::default() }), [2, 1]);
        assert_eq!(q(Query { min_rating: 3, sort: "rating".into(), desc: true, ..Default::default() }), [2, 3]);
        assert_eq!(q(Query { folder: Some("A".into()), recursive: true, sort: "size".into(), ..Default::default() }), [2, 3, 1]);
        assert_eq!(q(Query { folder: Some("A".into()), recursive: false, sort: "size".into(), ..Default::default() }), [2, 1]);
        assert_eq!(q(Query { orientation: "portrait".into(), ..Default::default() }), [2]);
        assert_eq!(q(Query { text: "song_".into(), ..Default::default() }), [4]); // '_' is literal, not wildcard
        assert_eq!(q(Query { text: "s%g".into(), ..Default::default() }), Vec::<i64>::new());
    }
    #[test] fn rejected_hidden_by_default() {
        let mut c = setup();
        set_field_many(&mut c, &[1], "rejected", Value::Integer(1)).unwrap();
        assert_eq!(query_assets(&c, &Query::default()).unwrap().len(), 3);
        assert_eq!(query_assets(&c, &Query { rejected: "only".into(), ..Default::default() }).unwrap()[0].id, 1);
        assert_eq!(set_field_many(&mut c, &[1], "path; DROP TABLE assets", Value::Null).unwrap(), 0);
    }
}
