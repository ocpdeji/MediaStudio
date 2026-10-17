import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as I from "lucide-react";
import { Asset, fileUrl, thumbUrl } from "../lib/api";
import { useStore } from "../lib/store";
import { fmtDate, fmtDur, fmtSize } from "../lib/format";
import { commands, runCmd } from "../lib/actions";
import { useMenu } from "./ui";

export const gridInfo = { cols: 1, rows: 1 };
const GAP = 10, PAD = 12, META = 50;

const KindIcon = ({ k, size = 22 }: { k: string; size?: number }) =>
  k === "video" ? <I.Film size={size} /> : k === "audio" ? <I.AudioLines size={size} /> : k === "raw" ? <I.Aperture size={size} /> : <I.Image size={size} />;

export const Thumb = memo(function Thumb({ a, className }: { a: Asset; className?: string }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [a.id, a.mtime]);
  if (a.missing) return <div className="ph"><I.FileWarning size={22} />Missing</div>;
  if (err) return <div className="ph"><KindIcon k={a.kind} />{a.ext.toUpperCase()}</div>;
  const src = a.ext === "svg" ? fileUrl(a.path) : thumbUrl(a);
  return <img className={className} src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setErr(true)} />;
});

function badges(a: Asset) {
  const res = a.width && a.height ? `${a.width}×${a.height}` : "";
  return (<>
    {a.kind !== "image" && <span className="badge tl">{a.kind === "video" ? "VIDEO" : a.kind.toUpperCase()}</span>}
    {(a.rating > 0 || a.favorite) && <span className="badge tr">{a.favorite ? "♥ " : ""}{"★".repeat(a.rating)}</span>}
    {(a.duration_ms || res) && <span className="badge br">{a.duration_ms && a.kind !== "image" ? fmtDur(a.duration_ms) : res}</span>}
  </>);
}

export function Browser() {
  const { assets, layout, selected, focus, select, loading, query, setQuery } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 800, h: 600, top: 0 });
  const showMenu = useMenu(s => s.show);

  useLayoutEffect(() => {
    const el = ref.current!; const ro = new ResizeObserver(() => setVp(v => ({ ...v, w: el.clientWidth, h: el.clientHeight }))); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const list = layout.mode === "list";
  const tw = layout.thumb, th = Math.round(tw * 0.68), ch = th + META;
  const cols = list ? 1 : Math.max(1, Math.floor((vp.w - PAD * 2 + GAP) / (tw + GAP)));
  const cw = list ? vp.w : Math.floor((vp.w - PAD * 2 - GAP * (cols - 1)) / cols);
  const rowH = list ? 46 : ch + GAP;
  const head = list ? 30 : 0;
  const rows = Math.ceil(assets.length / cols);
  gridInfo.cols = cols; gridInfo.rows = Math.max(1, Math.floor(vp.h / rowH));
  const first = Math.max(0, Math.floor((vp.top - head) / rowH) - 2), last = Math.min(rows, Math.ceil((vp.top + vp.h) / rowH) + 2);

  // keep the focused item in view when it changes (keyboard navigation)
  useEffect(() => {
    const i = assets.findIndex(a => a.id === focus); const el = ref.current; if (i < 0 || !el) return;
    const top = head + Math.floor(i / cols) * rowH + (list ? 0 : PAD), bottom = top + (list ? rowH : ch);
    if (top < el.scrollTop + head) el.scrollTop = top - head - (list ? 0 : PAD);
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + PAD;
  }, [focus]); // eslint-disable-line

  const click = (a: Asset, e: React.MouseEvent) => select(a.id, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "set");
  const menu = (a: Asset, e: React.MouseEvent) => {
    e.preventDefault();
    if (!selected.has(a.id)) select(a.id);
    setTimeout(() => {
      const pick = (id: string) => { const c = commands.find(x => x.id === id)!; return { label: c.label, icon: c.icon, keys: c.keys, run: () => runCmd(id), disabled: c.when ? !c.when() : false }; };
      showMenu(e.clientX, e.clientY, [pick("edit.open"), pick("video.export"), pick("ai.enhance"), { sep: true }, pick("rate.5"), pick("fav"), pick("reject"), pick("tag"), pick("collection"), pick("compare"),
        { sep: true }, pick("file.rename"), pick("copy.names"), pick("copy.paths"), pick("file.reveal"), pick("file.copyto"), pick("file.moveto"), { sep: true }, pick("batch.convert"), pick("batch.images"), pick("batch.audio"), { sep: true }, pick("file.recycle")]);
    });
  };
  const sortBy = (s: string) => setQuery(query.sort === s ? { desc: !query.desc } : { sort: s, desc: false });

  const items = [];
  for (let r = first; r < last; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, a = assets[i]; if (!a) break;
    const cls = `${selected.has(a.id) ? "sel" : ""} ${focus === a.id ? "focus" : ""} ${a.rejected ? "reject" : ""}`;
    if (list) {
      items.push(<div key={a.id} className={`list-row ${cls}`} style={{ top: head + r * rowH, height: rowH }} onClick={e => click(a, e)} onDoubleClick={() => runCmd("loupe")} onContextMenu={e => menu(a, e)} title={a.path}>
        <Thumb a={a} /><span className="ellipsis" style={{ color: "var(--text)" }}>{a.color && <span className={`dot ${a.color}`} style={{ marginRight: 6 }} />}{a.name}</span>
        <span>{a.ext.toUpperCase()}</span><span className="num">{a.width ? `${a.width}×${a.height}` : ""}</span><span className="num">{fmtDur(a.duration_ms)}</span>
        <span className="num">{fmtSize(a.size)}</span><span className="num">{fmtDate(a.mtime)}</span><span style={{ color: "var(--star)" }}>{"★".repeat(a.rating)}</span></div>);
    } else {
      items.push(<div key={a.id} className={`card ${cls}`} style={{ left: PAD + c * (cw + GAP), top: PAD + r * rowH, width: cw, height: ch }}
        onClick={e => click(a, e)} onDoubleClick={() => runCmd("loupe")} onContextMenu={e => menu(a, e)} title={a.rel}>
        <div className="th" style={{ height: th }}><Thumb a={a} />{badges(a)}{selected.has(a.id) && <span className="selmark"><I.Check size={13} strokeWidth={3} /></span>}</div>
        <div className="meta"><div className="nm">{a.name.replace(/\.[^.]+$/, "")}</div>
          <div className="sub">{a.color && <span className={`dot ${a.color}`} />}<span>{a.ext.toUpperCase()}</span><span>·</span><span>{fmtSize(a.size)}</span>{a.missing && <span style={{ color: "var(--bad)" }}>· missing</span>}</div></div>
      </div>);
    }
  }
  const total = list ? head + rows * rowH : PAD * 2 + rows * rowH;
  return (
    <div className="grid-scroll" ref={ref} tabIndex={0} onScroll={e => setVp(v => ({ ...v, top: (e.target as HTMLElement).scrollTop }))}
      onContextMenu={e => { if (e.target === e.currentTarget) e.preventDefault(); }}>
      {list && <div className="list-row list-head" style={{ position: "sticky", top: 0 }}>
        <span /><span onClick={() => sortBy("name")}>Name</span><span onClick={() => sortBy("type")}>Type</span><span onClick={() => sortBy("resolution")}>Size px</span>
        <span onClick={() => sortBy("duration")}>Length</span><span onClick={() => sortBy("size")}>File size</span><span onClick={() => sortBy("mtime")}>Modified</span><span onClick={() => sortBy("rating")}>Rating</span></div>}
      <div style={{ height: total, position: "relative" }}>{items}</div>
      {!assets.length && !loading && <EmptyBrowser />}
    </div>
  );
}

function EmptyBrowser() {
  const { libraries, query, setQuery } = useStore();
  const filtered = !!(query.text || query.kinds?.length || query.min_rating || query.favorites_only || query.colors?.length || query.collection_id || query.tag_ids?.length);
  if (!libraries.length) return (
    <div className="empty" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
      <span className="hero-icon"><I.FolderOpen size={30} /></span><h2>Bring in your media</h2>
      <div>Add a folder of photos, videos or audio. Files stay where they are — Media Studio Pro only builds a catalogue.</div>
      <button className="btn primary" style={{ marginTop: 16 }} onClick={() => runCmd("folder.add")}><I.FolderPlus size={16} /> Add folder</button>
      <div className="hint" style={{ marginTop: 10 }}>…or drag a folder onto this window</div>
    </div>);
  return (
    <div className="empty" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
      <I.SearchX size={34} /><h2>Nothing here</h2>
      <div>{filtered ? "No files match the current filters." : "This location has no supported media yet (or it is still being scanned)."}</div>
      {filtered && <button className="btn" style={{ marginTop: 12 }} onClick={() => setQuery({ text: "", kinds: [], min_rating: 0, favorites_only: false, colors: [], collection_id: null, tag_ids: [], unrated_only: false, orientation: "", rejected: "hide" })}>Clear filters</button>}
    </div>);
}
