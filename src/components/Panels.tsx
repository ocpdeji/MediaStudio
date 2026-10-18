import { Fragment, useEffect, useMemo, useState } from "react";
import * as I from "lucide-react";
import { api, Detail, errText, Query } from "../lib/api";
import { DEFAULT_QUERY, useStore, Workspace } from "../lib/store";
import { aspect, fmtDate, fmtDur, fmtSize, fps } from "../lib/format";
import { addFolder, runCmd, setField } from "../lib/actions";
import { ColorPicker, confirmAsk, promptAsk, Stars, useMenu } from "./ui";

// ================================================================ top bar
export function TopBar() {
  const { workspace, open, query, setQuery, layout, setLayout, editIds } = useStore();
  const [text, setText] = useState(query.text ?? "");
  useEffect(() => { const t = setTimeout(() => { if (text !== query.text) setQuery({ text }); }, 180); return () => clearTimeout(t); }, [text]); // eslint-disable-line
  useEffect(() => { const f = () => document.getElementById("global-search")?.focus(); window.addEventListener("msp-focus-search", f); return () => window.removeEventListener("msp-focus-search", f); }, []);
  const tab = (w: Workspace, label: string, icon: React.ReactNode, title: string) =>
    <button className={`tab ${workspace === w ? "on" : ""}`} title={title} onClick={() => open(w, w === "library" ? [] : editIds.length ? editIds : useStore.getState().targetIds())}>{icon}{label}</button>;
  return (
    <header className="topbar">
      <button className="brand" style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit", font: "inherit" }} title="Home — projects" onClick={() => open("home")}><span className="logo" />Media Studio Pro</button>
      <nav className="tabs">
        {tab("library", "Library", <I.LayoutGrid size={15} />, "Browse & review (Ctrl+1)")}
        {tab("image", "Image", <I.SlidersHorizontal size={15} />, "Image editor (Ctrl+2)")}
        {tab("video", "Video editor", <I.Clapperboard size={15} />, "New editor project from the selected media (Ctrl+3)")}
        {tab("enhance", "Enhance", <I.Sparkles size={15} />, "AI upscaling & enhancement (Ctrl+4)")}
      </nav>
      <span className="grow" />
      {workspace === "library" && <div className="search"><I.Search size={15} />
        <input id="global-search" className="input" placeholder="Search names, folders, tags, notes…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { setText(""); (e.target as HTMLInputElement).blur(); } }} spellCheck={false} /></div>}
      <span className="grow" />
      <button className="btn ghost" onClick={() => useStore.setState({ palette: true })} title="Command palette">Commands <span className="kbd">Ctrl K</span></button>
      <button className="btn ghost icon" onClick={() => setLayout({ theme: layout.theme === "dark" ? "light" : "dark" })} title="Light / dark theme">{layout.theme === "dark" ? <I.Moon size={16} /> : <I.Sun size={16} />}</button>
      <button className="btn ghost icon" onClick={() => runCmd("app.settings")} title="Settings & diagnostics (Ctrl+,)"><I.Settings size={16} /></button>
      <button className="btn primary" onClick={() => addFolder()} title="Add a folder to the library (Ctrl+O)"><I.FolderPlus size={15} /> Add folder</button>
    </header>
  );
}

// ================================================================ sidebar
type Node = { name: string; path: string; count: number; total: number; children: Node[] };
function buildTree(folders: [string, number][]): Node[] {
  const root: Node = { name: "", path: "", count: 0, total: 0, children: [] };
  for (const [f, n] of folders) {
    let cur = root; const parts = f.split("/");
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let c = cur.children.find(x => x.name === p);
      if (!c) { c = { name: p, path, count: 0, total: 0, children: [] }; cur.children.push(c); }
      c.total += n; if (i === parts.length - 1) c.count += n; cur = c;
    });
  }
  return root.children;
}

function FolderNode({ n, depth, lib }: { n: Node; depth: number; lib: number }) {
  const { query, setQuery } = useStore();
  const [open, setOpen] = useState(depth < 1);
  const on = query.library_id === lib && query.folder === n.path;
  return (<>
    <div className={`side-item ${on ? "on" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setQuery({ library_id: lib, folder: n.path, recursive: true, collection_id: null })} title={n.path}>
      {n.children.length ? <span onClick={e => { e.stopPropagation(); setOpen(!open); }} style={{ display: "flex" }}>{open ? <I.ChevronDown size={14} /> : <I.ChevronRight size={14} />}</span> : <span style={{ width: 14 }} />}
      <I.Folder size={15} /><span className="ellipsis">{n.name}</span><span className="count">{n.total}</span>
    </div>
    {open && n.children.map(c => <FolderNode key={c.path} n={c} depth={depth + 1} lib={lib} />)}
  </>);
}

function LibraryBlock({ id, name, path, count, missing, online }: { id: number; name: string; path: string; count: number; missing: number; online: boolean }) {
  const [folders, setFolders] = useState<[string, number][]>([]);
  const { scanning, setQuery, query, toast, refreshMeta } = useStore();
  const show = useMenu(s => s.show);
  useEffect(() => { api.folders(id).then(setFolders).catch(() => {}); }, [id, count, scanning[id]]);
  const tree = useMemo(() => buildTree(folders), [folders]);
  const top = tree[0];
  return (<div onContextMenu={e => { e.preventDefault(); show(e.clientX, e.clientY, [
    { label: "Rescan folder", icon: <I.RefreshCw size={15} />, run: () => api.rescan(id).catch(err => toast(errText(err), "error")) },
    { label: "Show missing files", icon: <I.FileWarning size={15} />, run: () => setQuery({ library_id: id, folder: null, missing_only: true, rejected: "any" }) },
    { sep: true },
    { label: "Remove from library…", icon: <I.Unlink size={15} />, run: async () => { if (await confirmAsk(`Remove “${name}” from the library?`, "Only the catalogue entry (ratings, tags, notes) is removed. Your files are not touched.", "Remove")) { await api.removeLibrary(id); await refreshMeta(); useStore.getState().setQuery({ library_id: null, folder: null }); } } },
  ]); }}>
    {top ? <FolderNode n={top} depth={0} lib={id} /> :
      <div className={`side-item ${query.library_id === id ? "on" : ""}`} onClick={() => setQuery({ library_id: id, folder: null })} title={path}><I.HardDrive size={15} /><span className="ellipsis">{name}</span><span className="count">{count}</span></div>}
    {!online && <div className="side-item" style={{ color: "var(--warn)" }} title={path}><I.WifiOff size={14} /> Offline — reconnect drive</div>}
    {scanning[id] !== undefined && <div className="side-item dim"><I.Loader2 size={14} className="spin" /> Scanning… {scanning[id] || ""}</div>}
    {missing > 0 && <div className="side-item" style={{ color: "var(--warn)" }} onClick={() => setQuery({ library_id: id, folder: null, missing_only: true, rejected: "any" })}><I.FileWarning size={14} /> {missing} missing</div>}
  </div>);
}

export function Sidebar() {
  const { libraries, collections, tags, searches, query, setQuery, refreshMeta, toast } = useStore();
  const show = useMenu(s => s.show);
  const smart = (label: string, icon: React.ReactNode, q: Partial<Query>, active: boolean) =>
    <div className={`side-item ${active ? "on" : ""}`} onClick={() => setQuery(q, true)}>{icon}<span>{label}</span></div>;
  const isAll = !query.library_id && !query.collection_id && !query.favorites_only && !query.min_rating && !query.kinds?.length && query.rejected === "hide" && !query.missing_only && !query.tag_ids?.length;
  return (
    <aside className="sidebar">
      <div className="side-h">Library</div>
      {smart("All media", <I.Library size={15} />, {}, isAll)}
      {smart("Videos", <I.Film size={15} />, { kinds: ["video"] }, query.kinds?.join() === "video" && !query.library_id)}
      {smart("Images", <I.Image size={15} />, { kinds: ["image", "raw"] }, query.kinds?.join() === "image,raw" && !query.library_id)}
      {smart("Audio", <I.AudioLines size={15} />, { kinds: ["audio"] }, query.kinds?.join() === "audio")}
      {smart("Favourites", <I.Heart size={15} />, { favorites_only: true }, !!query.favorites_only)}
      {smart("Rated 4★ and up", <I.Star size={15} />, { min_rating: 4, sort: "rating", desc: true }, query.min_rating === 4)}
      {smart("Rejected", <I.Ban size={15} />, { rejected: "only" }, query.rejected === "only")}
      {smart("Recently modified", <I.Clock size={15} />, { sort: "mtime", desc: true, mtime_from: Date.now() - 7 * 864e5 }, !!query.mtime_from && query.sort === "mtime")}
      <div className="side-h">Folders <button className="btn ghost icon sm" title="Add folder" onClick={() => addFolder()}><I.Plus size={14} /></button></div>
      {libraries.map(l => <LibraryBlock key={l.id} {...l} />)}
      {!libraries.length && <div className="side-item dim" onClick={() => addFolder()}><I.FolderPlus size={15} /> Add your first folder</div>}
      <div className="side-h">Collections <button className="btn ghost icon sm" title="New collection" onClick={async () => { const n = await promptAsk("New collection"); if (n?.trim()) { await api.collection("create", null, n.trim()); refreshMeta(); } }}><I.Plus size={14} /></button></div>
      {collections.map(([id, name, n]) => <div key={id} className={`side-item ${query.collection_id === id ? "on" : ""}`} onClick={() => setQuery({ collection_id: id }, true)}
        onContextMenu={e => { e.preventDefault(); show(e.clientX, e.clientY, [
          { label: "Add selection to this collection", icon: <I.Plus size={15} />, run: async () => { const ids = useStore.getState().targetIds(); await api.collection("add", id, null, ids); refreshMeta(); toast(`Added ${ids.length}`, "ok"); } },
          { label: "Remove selection from collection", icon: <I.Minus size={15} />, run: async () => { await api.collection("remove", id, null, useStore.getState().targetIds()); refreshMeta(); useStore.getState().refresh(); } },
          { label: "Rename…", icon: <I.Pencil size={15} />, run: async () => { const nn = await promptAsk("Rename collection", name); if (nn?.trim()) { await api.collection("rename", id, nn.trim()); refreshMeta(); } } },
          { label: "Delete collection", icon: <I.Trash2 size={15} />, run: async () => { if (await confirmAsk(`Delete collection “${name}”?`, "Only the collection is deleted — files are not affected.", "Delete", true)) { await api.collection("delete", id, null); refreshMeta(); } } }]); }}>
        <I.FolderHeart size={15} /><span className="ellipsis">{name}</span><span className="count">{n}</span></div>)}
      {!collections.length && <div className="side-item faint" style={{ cursor: "default" }}>Right-click files → Add to collection</div>}
      {tags.length > 0 && <><div className="side-h">Tags</div>
        <div className="taglist" style={{ padding: "2px 8px" }}>{tags.map(([id, name, n]) => <span key={id} className={`chip ${query.tag_ids?.includes(id) ? "on" : ""}`}
          onClick={() => setQuery({ tag_ids: query.tag_ids?.includes(id) ? query.tag_ids.filter(t => t !== id) : [...(query.tag_ids ?? []), id] })}>#{name} <span className="faint">{n}</span></span>)}</div></>}
      <div className="side-h">Saved searches <button className="btn ghost icon sm" title="Save current filters" onClick={async () => { const n = await promptAsk("Save current search as"); if (n?.trim()) { await api.savedSearches("save", undefined, n.trim(), useStore.getState().query); refreshMeta(); } }}><I.Plus size={14} /></button></div>
      {searches.map(([id, name, q]) => <div key={id} className="side-item" onClick={() => setQuery({ ...DEFAULT_QUERY, ...q }, true)}
        onContextMenu={e => { e.preventDefault(); show(e.clientX, e.clientY, [{ label: "Delete saved search", icon: <I.Trash2 size={15} />, run: async () => { await api.savedSearches("delete", id); refreshMeta(); } }]); }}><I.BookmarkCheck size={15} /><span className="ellipsis">{name}</span></div>)}
    </aside>
  );
}

// ================================================================ browser filter bar
export function FilterBar() {
  const { query, setQuery, layout, setLayout, assets, selected } = useStore();
  const [more, setMore] = useState(false);
  const kinds = (k: string[]) => setQuery({ kinds: query.kinds?.join() === k.join() ? [] : k });
  return (<>
    <div className="browser-bar">
      <div className="seg">
        <button className={`btn sm ${!query.kinds?.length ? "on" : ""}`} onClick={() => setQuery({ kinds: [] })}>All</button>
        <button className={`btn sm ${query.kinds?.join() === "video" ? "on" : ""}`} onClick={() => kinds(["video"])}>Video</button>
        <button className={`btn sm ${query.kinds?.join() === "image,raw" ? "on" : ""}`} onClick={() => kinds(["image", "raw"])}>Images</button>
        <button className={`btn sm ${query.kinds?.join() === "audio" ? "on" : ""}`} onClick={() => kinds(["audio"])}>Audio</button>
      </div>
      <select className="input" style={{ height: 26 }} value={query.unrated_only ? -1 : query.min_rating ?? 0} title="Rating filter" onChange={e => { const v = +e.target.value; setQuery(v < 0 ? { unrated_only: true, min_rating: 0 } : { unrated_only: false, min_rating: v }); }}>
        <option value={0}>Any rating</option>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{"★".repeat(n)}{n < 5 ? "+" : ""}</option>)}<option value={-1}>Unrated</option></select>
      <span className="colors" title="Colour label filter">{(["red", "orange", "yellow", "green", "blue", "purple"] as const).map(c => <button key={c} className={query.colors?.includes(c) ? "on" : ""} style={{ background: `var(--c-${c})`, width: 14, height: 14 }}
        onClick={() => setQuery({ colors: query.colors?.includes(c) ? query.colors.filter(x => x !== c) : [...(query.colors ?? []), c] })} aria-label={`Filter ${c}`} />)}</span>
      <button className={`chip ${more ? "on" : ""}`} onClick={() => setMore(!more)}><I.Filter size={12} /> More filters</button>
      <span className="grow" />
      <select className="input" style={{ height: 26 }} value={query.sort} onChange={e => setQuery({ sort: e.target.value })} title="Sort by">
        {[["name", "Name"], ["folder", "Folder"], ["type", "Type"], ["mtime", "Date modified"], ["ctime", "Date created"], ["capture", "Capture date"], ["imported", "Import date"], ["size", "File size"], ["duration", "Duration"], ["resolution", "Resolution"], ["width", "Width"], ["height", "Height"], ["aspect", "Aspect ratio"], ["rating", "Rating"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <button className="btn ghost icon sm" onClick={() => setQuery({ desc: !query.desc })} title={query.desc ? "Descending" : "Ascending"}>{query.desc ? <I.ArrowDownWideNarrow size={15} /> : <I.ArrowUpNarrowWide size={15} />}</button>
      <span className="sep" />
      <div className="seg"><button className={`btn sm icon ${layout.mode === "grid" ? "on" : ""}`} onClick={() => setLayout({ mode: "grid" })} title="Grid (G)"><I.LayoutGrid size={14} /></button>
        <button className={`btn sm icon ${layout.mode === "list" ? "on" : ""}`} onClick={() => setLayout({ mode: "list" })} title="List (G)"><I.List size={14} /></button></div>
      {layout.mode === "grid" && <input type="range" min={110} max={420} value={layout.thumb} onChange={e => setLayout({ thumb: +e.target.value })} style={{ width: 90 }} title="Thumbnail size" aria-label="Thumbnail size" />}
      <span className="dim num" style={{ fontSize: 12 }}>{selected.size ? `${selected.size} / ` : ""}{assets.length}</span>
    </div>
    {more && <div className="browser-bar">
      <select className="input" style={{ height: 26 }} value={query.orientation ?? ""} onChange={e => setQuery({ orientation: e.target.value as Query["orientation"] })}><option value="">Any orientation</option><option value="landscape">Landscape</option><option value="portrait">Portrait</option><option value="square">Square</option></select>
      <select className="input" style={{ height: 26 }} value={query.width_min ?? ""} onChange={e => setQuery({ width_min: e.target.value ? +e.target.value : null })}><option value="">Any resolution</option><option value="1280">≥ 1280 px wide</option><option value="1920">≥ 1920 (HD)</option><option value="3840">≥ 3840 (4K)</option></select>
      <select className="input" style={{ height: 26 }} value={query.dur_max_ms ?? query.dur_min_ms ?? ""} onChange={e => { const v = e.target.value; setQuery(v === "" ? { dur_min_ms: null, dur_max_ms: null } : +v > 0 ? { dur_max_ms: +v, dur_min_ms: null } : { dur_min_ms: -v, dur_max_ms: null }); }}>
        <option value="">Any duration</option><option value={10000}>Under 10 s</option><option value={60000}>Under 1 min</option><option value={-60000}>Over 1 min</option><option value={-600000}>Over 10 min</option></select>
      <select className="input" style={{ height: 26 }} value={query.size_min ?? ""} onChange={e => setQuery({ size_min: e.target.value ? +e.target.value : null })}><option value="">Any file size</option><option value={10485760}>≥ 10 MB</option><option value={104857600}>≥ 100 MB</option><option value={1073741824}>≥ 1 GB</option></select>
      <select className="input" style={{ height: 26 }} value={query.mtime_from ? String(Math.round((Date.now() - query.mtime_from) / 864e5)) : ""} onChange={e => setQuery({ mtime_from: e.target.value ? Date.now() - +e.target.value * 864e5 : null })}><option value="">Any date</option><option value="1">Last 24 h</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="365">Last year</option></select>
      <input className="input" style={{ height: 26, width: 140 }} placeholder="Extensions: mp4 png" defaultValue={query.exts?.join(" ")} onKeyDown={e => { if (e.key === "Enter") setQuery({ exts: (e.target as HTMLInputElement).value.toLowerCase().split(/[\s,.]+/).filter(Boolean) }); }} />
      <label className="check"><input type="checkbox" checked={!!query.favorites_only} onChange={e => setQuery({ favorites_only: e.target.checked })} /> Favourites</label>
      <select className="input" style={{ height: 26 }} value={query.rejected} onChange={e => setQuery({ rejected: e.target.value as Query["rejected"] })}><option value="hide">Hide rejected</option><option value="any">Show rejected</option><option value="only">Only rejected</option></select>
      <label className="check"><input type="checkbox" checked={!!query.missing_only} onChange={e => setQuery({ missing_only: e.target.checked })} /> Missing files</label>
      <button className="btn sm ghost" onClick={() => setQuery({ ...DEFAULT_QUERY, sort: query.sort, desc: query.desc }, true)}>Reset</button>
    </div>}
  </>);
}

// ================================================================ inspector
export function Inspector() {
  const { focus, assets, selected, toast, refreshMeta } = useStore();
  const a = assets.find(x => x.id === focus);
  const [d, setD] = useState<Detail | null>(null);
  const [notes, setNotes] = useState("");
  const [tag, setTag] = useState("");
  const load = () => a && api.detail(a.id).then(x => { setD(x); setNotes(x.notes ?? ""); }).catch(() => setD(null));
  useEffect(() => { setD(null); load(); }, [a?.id, a?.mtime]); // eslint-disable-line
  const ids = selected.size ? [...selected] : a ? [a.id] : [];
  if (!a) return <aside className="inspector"><div className="empty">No file selected</div></aside>;
  const streams: any[] = d?.streams?.streams ?? [];
  const v = streams.find(s => s.codec_type === "video" && s.disposition?.attached_pic !== 1), au = streams.filter(s => s.codec_type === "audio"), subs = streams.filter(s => s.codec_type === "subtitle");
  const fmt = d?.streams?.format;
  const rows: [string, React.ReactNode][] = [
    ["Name", a.name], ["Folder", a.folder], ["Type", `${a.kind} · ${a.ext.toUpperCase()}`], ["File size", `${fmtSize(a.size)}`],
    ...(a.width ? [["Dimensions", `${a.width} × ${a.height} (${aspect(a.width, a.height!)})`] as [string, string]] : []),
    ...(a.duration_ms ? [["Duration", fmtDur(a.duration_ms) + ` (${(a.duration_ms / 1000).toFixed(2)} s)`] as [string, string]] : []),
    ...(fps(a.fps_num, a.fps_den) ? [["Frame rate", `${fps(a.fps_num, a.fps_den)} fps (${a.fps_num}/${a.fps_den})`] as [string, string]] : []),
    ...(v ? [["Video", `${v.codec_long_name ?? v.codec_name}${v.profile ? ` · ${v.profile}` : ""} · ${v.pix_fmt ?? ""}${v.color_transfer && /smpte2084|arib-std-b67/.test(v.color_transfer) ? " · HDR" : ""}`] as [string, string]] : []),
    ...au.map((s, i) => [`Audio ${au.length > 1 ? i + 1 : ""}`, `${s.codec_name} · ${s.sample_rate ? +s.sample_rate / 1000 + " kHz" : ""} · ${s.channel_layout ?? s.channels + " ch"}${s.tags?.language ? ` · ${s.tags.language}` : ""}`] as [string, string]),
    ...(subs.length ? [["Subtitles", subs.map(s => `${s.codec_name}${s.tags?.language ? ` (${s.tags.language})` : ""}`).join(", ")] as [string, string]] : []),
    ...(fmt?.bit_rate ? [["Bitrate", `${(+fmt.bit_rate / 1e6).toFixed(2)} Mb/s`] as [string, string]] : []),
    ...(fmt?.format_long_name ? [["Container", fmt.format_long_name] as [string, string]] : []),
    ["Modified", fmtDate(a.mtime)], ...(a.capture_time ? [["Captured", fmtDate(a.capture_time)] as [string, string]] : []),
  ];
  return (
    <aside className="inspector">
      <div className="sec">
        <div className="sec-h">{ids.length > 1 ? `${ids.length} selected` : "Review"}</div>
        <div className="row" style={{ justifyContent: "space-between" }}><Stars value={ids.length > 1 ? 0 : a.rating} onChange={v => setField("rating", v, ids)} />
          <div className="row" style={{ gap: 4 }}>
            <button className={`btn icon sm ${a.favorite ? "on" : ""}`} title="Favourite (F)" onClick={() => setField("favorite", !a.favorite, ids)}><I.Heart size={14} fill={a.favorite ? "currentColor" : "none"} /></button>
            <button className={`btn icon sm ${a.rejected ? "on danger" : ""}`} title="Reject (X)" onClick={() => setField("rejected", !a.rejected, ids)}><I.Ban size={14} /></button></div></div>
        <div className="row" style={{ marginTop: 10 }}><span className="dim" style={{ width: 56 }}>Label</span><ColorPicker value={a.color} onChange={c => setField("color", c, ids)} /></div>
        <div className="row" style={{ marginTop: 10, alignItems: "flex-start" }}><span className="dim" style={{ width: 56, paddingTop: 3 }}>Tags</span>
          <div className="taglist grow">{d?.tags.map(([id, n]) => <span key={id} className="tag">#{n}<button onClick={async () => { await api.tag(ids, n, true); load(); refreshMeta(); }} aria-label={`Remove tag ${n}`}><I.X size={11} /></button></span>)}
            <input className="input" style={{ height: 22, width: 90, fontSize: 12 }} placeholder="+ tag" value={tag} onChange={e => setTag(e.target.value)}
              onKeyDown={async e => { if (e.key === "Enter" && tag.trim()) { try { await api.tag(ids, tag.trim()); setTag(""); load(); refreshMeta(); } catch (err) { toast(errText(err), "error"); } } }} /></div></div>
        {ids.length <= 1 && <textarea className="input" rows={2} placeholder="Review notes…" style={{ width: "100%", marginTop: 10 }} value={notes} onChange={e => setNotes(e.target.value)}
          onBlur={() => notes !== (d?.notes ?? "") && api.setField([a.id], "notes", notes).then(() => d && setD({ ...d, notes }))} />}
      </div>
      <div className="sec"><div className="sec-h">File</div>
        <dl className="kv">{rows.map(([k, v], i) => <Fragment key={i}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        {d?.probe_error && <div className="err-box" style={{ marginTop: 8 }}>Metadata could not be read: {d.probe_error}</div>}
        <div className="row" style={{ marginTop: 10, gap: 6 }}><button className="btn sm" onClick={() => runCmd("file.reveal")}><I.FolderOpen size={13} /> Show in Explorer</button>
          <button className="btn sm" onClick={() => navigator.clipboard.writeText(a.path).then(() => toast("Path copied", "ok"))}><I.Copy size={13} /> Copy path</button></div>
      </div>
      {!!d?.exif.length && <div className="sec"><div className="sec-h">Camera (EXIF)</div><dl className="kv">{d.exif.map(([k, v]) => <Fragment key={k}><dt>{k.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd>{v}</dd></Fragment>)}</dl>
        {d.exif.some(([k]) => k.startsWith("GPS")) && <div className="warn-box" style={{ marginTop: 8 }}>This photo contains GPS location. Exports from the image editor don’t include metadata.</div>}</div>}
      {!!d?.collections.length && <div className="sec"><div className="sec-h">In collections</div><div className="taglist">{d.collections.map(([id, n]) => <span key={id} className="tag" style={{ paddingRight: 8 }}>{n}</span>)}</div></div>}
    </aside>
  );
}

// ================================================================ status bar & jobs
export function StatusBar() {
  const { assets, selected, jobs, setDialog, focus, scanning } = useStore();
  const running = jobs.filter(j => j.status === "running"), queued = jobs.filter(j => j.status === "queued");
  const failed = jobs.filter(j => j.status === "failed" && j.finished_at && Date.now() - j.finished_at < 36e5).length;
  const a = assets.find(x => x.id === focus);
  const bytes = useMemo(() => (selected.size ? assets.filter(x => selected.has(x.id)) : assets).reduce((s, x) => s + x.size, 0), [assets, selected]);
  const scans = Object.keys(scanning).length;
  return (
    <footer className="statusbar">
      <span className="num">{selected.size ? `${selected.size} selected of ${assets.length}` : `${assets.length} items`} · {fmtSize(bytes)}</span>
      {a && <span className="ellipsis dim" style={{ maxWidth: "40vw" }}>{a.rel}</span>}
      <span className="grow" />
      {scans > 0 && <span className="row"><I.Loader2 size={13} className="spin" /> Indexing</span>}
      <span className="jobs-pill" onClick={() => setDialog({ kind: "jobs" })} title="Jobs (Ctrl+J)">
        {running.length ? <><I.Loader2 size={13} className="spin" />{running[0].title.slice(0, 40)}<span className="mini-bar"><div style={{ width: `${running[0].progress * 100}%` }} /></span>{Math.round(running[0].progress * 100)}%{queued.length ? ` +${queued.length}` : ""}</>
          : <><I.ListChecks size={13} />Jobs{queued.length ? ` (${queued.length} queued)` : ""}</>}
        {failed > 0 && <span style={{ color: "var(--bad)" }}>· {failed} failed</span>}
      </span>
    </footer>
  );
}

export function JobsDrawer({ onClose }: { onClose: () => void }) {
  const { jobs, toast } = useStore();
  const act = (p: Promise<unknown>) => p.catch(e => toast(errText(e), "error"));
  return (
    <div className="drawer" role="dialog" aria-label="Jobs">
      <div className="dialog-h"><I.ListChecks size={17} /> Jobs <span className="grow" />
        <button className="btn sm" onClick={() => act(api.clearJobs().then(() => api.jobs()).then(j => useStore.setState({ jobs: j })))}>Clear finished</button>
        <button className="btn ghost icon sm" onClick={onClose}><I.X size={16} /></button></div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {!jobs.length && <div className="empty">No jobs yet. Exports, conversions, proxies and AI processing run here in the background.</div>}
        {jobs.map(j => (
          <div key={j.id} className="job">
            <div className="row"><b className="ellipsis grow" title={j.title}>{j.title}</b><span className={`status-tag ${j.status}`}>{j.status}</span></div>
            {(j.status === "running" || j.status === "queued") && <div className="row"><div className="progress grow"><div style={{ width: `${j.progress * 100}%` }} /></div><span className="num dim" style={{ fontSize: 12 }}>{Math.round(j.progress * 100)}%</span>
              {j.started_at && j.progress > 0.03 && <span className="dim num" style={{ fontSize: 11 }}>~{Math.max(0, Math.round(((Date.now() - j.started_at) / j.progress - (Date.now() - j.started_at)) / 1000))}s left</span>}</div>}
            {j.error && <div className="err-box">{j.error}</div>}
            {j.result?.notes?.map((n, i) => <div key={i} className="hint">• {n}</div>)}
            {j.result?.outputs?.map(o => <div key={o} className="hint ellipsis" title={o}>→ {o}</div>)}
            <div className="row" style={{ gap: 6 }}>
              {(j.status === "running" || j.status === "queued") && <button className="btn sm" onClick={() => act(api.cancelJob(j.id))}><I.Square size={12} /> Cancel</button>}
              {["failed", "cancelled", "interrupted"].includes(j.status) && <button className="btn sm" onClick={() => act(api.retryJob(j.id))}><I.RotateCw size={12} /> Retry</button>}
              <span className="dim" style={{ fontSize: 11, marginLeft: "auto" }}>{fmtDate(j.created_at)}{j.finished_at && j.started_at ? ` · ${((j.finished_at - j.started_at) / 1000).toFixed(1)} s` : ""}</span>
            </div>
          </div>))}
      </div>
    </div>
  );
}
