import { Fragment, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bot, Captions, Clapperboard, Copy, Film, FolderOpen, Image as ImageIcon, LayoutTemplate, Library, Loader2, MoreHorizontal, Pencil, Plus, Scissors, Search, Sparkles, Trash2, Wand2, X } from "lucide-react";
import "./editor.css";
import { ed, ProjectMeta } from "../api";
import { newProject, RATIOS } from "../model";
import { TEMPLATES } from "../presets";
import { useMenu, confirmAsk } from "../../components/ui";
import { notify } from "../store";
import { AiSettings } from "./AiSettings";

const ago = (ms: number) => { const d = (Date.now() - ms) / 1000; if (d < 60) return "just now"; if (d < 3600) return `${Math.floor(d / 60)} min ago`; if (d < 86400) return `${Math.floor(d / 3600)} h ago`; return new Date(ms).toLocaleDateString(); };
const dur = (us: number) => { const s = Math.round(us / 1e6); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const mb = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);

export function Home({ onOpen, onWorkspace }: { onOpen: (id: string) => void; onWorkspace: (w: "library" | "image" | "enhance") => void }) {
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const [page, setPage] = useState<"home" | "templates">("home");
  const [q, setQ] = useState(""); const [sort, setSort] = useState<"modified" | "name" | "created">("modified");
  const [renaming, setRenaming] = useState<string | null>(null); const [newName, setNewName] = useState("");
  const [create, setCreate] = useState(false); const [ai, setAi] = useState(false);
  const load = () => ed.projects().then(setList).catch(e => { notify(String(e)); setList([]); });
  useEffect(() => { void load(); getCurrentWindow().setTitle("Media Studio Pro").catch(() => {}); }, []);
  const shown = useMemo(() => (list ?? []).filter(p => p.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true }) : (b[sort] - a[sort])), [list, q, sort]);

  const makeProject = async (name: string, ratio: string, tpl?: string) => {
    const t = tpl ? TEMPLATES.find(x => x.id === tpl) : undefined;
    const data = t ? { ...t.build(), name } : newProject(name, ratio);
    try { const m = await ed.create(name, data); onOpen(m.id); } catch (e) { notify(String(e)); }
  };
  const rename = async (id: string) => { const n = newName.trim(); setRenaming(null); if (!n) return; try { await ed.rename(id, n); void load(); } catch (e) { notify(String(e)); } };
  const del = async (p: ProjectMeta) => { if (!(await confirmAsk(`Delete “${p.name}”?`, "The project folder moves to the Recycle Bin. Your original media files are not touched.", "Delete", true))) return; try { await ed.remove([p.id]); void load(); notify("Moved to the Recycle Bin", "ok"); } catch (e) { notify(String(e)); } };
  const more = (e: React.MouseEvent, p: ProjectMeta) => { e.preventDefault(); e.stopPropagation(); useMenu.getState().show(e.clientX, e.clientY, [
    { label: "Open", icon: <Film size={14} />, run: () => onOpen(p.id) },
    { label: "Rename", icon: <Pencil size={14} />, run: () => { setRenaming(p.id); setNewName(p.name); } },
    { label: "Duplicate", icon: <Copy size={14} />, run: async () => { await ed.duplicate(p.id).catch(err => notify(String(err))); void load(); } },
    { label: "Show in folder", icon: <FolderOpen size={14} />, run: () => ed.reveal(p.id).catch(err => notify(String(err))) },
    { sep: true }, { label: "Delete", icon: <Trash2 size={14} />, run: () => del(p) },
  ]); };

  const tools: [React.ReactElement, string, string, string, () => void][] = [
    [<Captions size={20} />, "Auto captions", "Speech to animated captions", "#0ea5c4", () => setCreate(true)],
    [<Scissors size={20} />, "Remove background", "AI cutout, no green screen", "#f59e0b", () => setCreate(true)],
    [<Wand2 size={20} />, "Enhance & upscale", "AI 2–4× super resolution", "#8b5cf6", () => onWorkspace("enhance")],
    [<Library size={20} />, "Media library", "Browse, rate & organise", "#10b981", () => onWorkspace("library")],
  ];
  return (
    <div className="home">
      <nav className="home-nav">
        <div className="brand"><div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#1fc8e8,#3a7bff,#7a3aff)", display: "flex", alignItems: "center", justifyContent: "center" }}><Clapperboard size={16} color="#fff" /></div>Media Studio Pro</div>
        <button className={page === "home" ? "on" : ""} onClick={() => setPage("home")}><Film size={16} />Home</button>
        <button className={page === "templates" ? "on" : ""} onClick={() => setPage("templates")}><LayoutTemplate size={16} />Templates</button>
        <button onClick={() => onWorkspace("library")}><Library size={16} />Media library</button>
        <button onClick={() => onWorkspace("image")}><ImageIcon size={16} />Photo editor</button>
        <button onClick={() => onWorkspace("enhance")}><Sparkles size={16} />Enhance</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => setAi(true)}><Bot size={16} />AI models & keys</button>
      </nav>
      <main className="home-main">
        {page === "home" ? <>
          <div className="home-hero">
            <button className="home-create" onClick={() => setCreate(true)}><Plus size={34} />Create project</button>
            {tools.map(([ic, t, s, col, f]) => <button key={t} className="home-tool" onClick={f}><div className="ic" style={{ background: col + "26", color: col }}>{ic}</div><div><b>{t}</b><br /><small>{s}</small></div></button>)}
          </div>
          <div className="home-bar">
            <h2>Projects {list && <span style={{ color: "#777", fontWeight: 400, fontSize: 13 }}>({list.length})</span>}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#1d1d22", border: "1px solid #2a2a30", borderRadius: 8, padding: "0 8px" }}><Search size={14} color="#888" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search projects" style={{ background: "transparent", border: 0, color: "#eee", padding: "7px 2px", outline: "none", width: 180 }} /></div>
            <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} style={{ background: "#1d1d22", color: "#ddd", border: "1px solid #2a2a30", borderRadius: 8, padding: 6 }}><option value="modified">Last edited</option><option value="created">Created</option><option value="name">Name</option></select>
          </div>
          {!list ? <Loader2 className="spin" /> : !shown.length ? <div style={{ color: "#888", padding: 40, textAlign: "center" }}>{list.length ? "No projects match your search." : "No projects yet — click “Create project” to start."}</div> :
            <div className="home-grid">{shown.map(p => <div key={p.id} className="home-card" onDoubleClick={() => onOpen(p.id)} onClick={() => renaming !== p.id && onOpen(p.id)} onContextMenu={e => more(e, p)}>
              <div className="im" style={{ backgroundImage: p.cover ? `url("${convertFileSrc(p.cover)}?v=${p.modified}")` : undefined, aspectRatio: p.width && p.height ? `${Math.max(0.6, Math.min(2, p.width / p.height))}` : "16/9" }}>
                {!p.cover && <Film size={28} />}{p.duration_us > 0 && <span className="dur">{dur(p.duration_us)}</span>}
                <button className="eb icon sm more" style={{ background: "rgba(0,0,0,.6)" }} onClick={e => more(e, p)}><MoreHorizontal size={15} /></button>
              </div>
              {renaming === p.id ? <input autoFocus value={newName} onClick={e => e.stopPropagation()} onChange={e => setNewName(e.target.value)} onBlur={() => rename(p.id)} onKeyDown={e => { if (e.key === "Enter") void rename(p.id); if (e.key === "Escape") setRenaming(null); }} />
                : <div className="nm" title="Double-click the name to rename" onClick={e => e.stopPropagation()} onDoubleClick={e => { e.stopPropagation(); setRenaming(p.id); setNewName(p.name); }}>{p.name}</div>}
              <div className="sub">{p.width}×{p.height} · {ago(p.modified)} · {mb(p.size)}</div>
            </div>)}</div>}
        </> : <>
          <div className="home-bar"><h2>Templates</h2></div>
          <div className="home-grid">{TEMPLATES.map(t => <div key={t.id} className="home-card" onClick={() => void makeProject(t.name, t.ratio, t.id)}>
            <div className="im" style={{ background: "linear-gradient(135deg,#1b2a4a,#3a1b4a)", aspectRatio: t.ratio === "9:16" ? "9/16" : t.ratio === "1:1" ? "1" : "16/9", maxHeight: 260 }}><LayoutTemplate size={30} color="#9ab" /></div>
            <div className="nm">{t.name} <span style={{ color: "#888", fontWeight: 400 }}>{t.ratio}</span></div><div className="sub">{t.desc}</div></div>)}</div>
        </>}
      </main>
      {create && <CreateDialog onClose={() => setCreate(false)} onCreate={(n, r) => { setCreate(false); void makeProject(n, r); }} count={list?.length ?? 0} />}
      {ai && <AiSettings onClose={() => setAi(false)} />}
    </div>
  );
}

function CreateDialog({ onClose, onCreate, count }: { onClose: () => void; onCreate: (name: string, ratio: string) => void; count: number }) {
  const [name, setName] = useState(`Project ${count + 1}`);
  const [ratio, setRatio] = useState("16:9");
  const icons: Record<string, string> = { "16:9": "YouTube / landscape", "9:16": "TikTok / Reels / Shorts", "1:1": "Instagram square", "4:5": "Instagram portrait", "4:3": "Classic", "3:4": "Portrait 3:4", "21:9": "Cinematic", "2:1": "Univisium", "2.35:1": "Anamorphic", original: "Match first clip" };
  return <div className="ed-modal" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <div className="ed-dialog" style={{ width: 620 }}>
      <div className="hd"><Plus size={16} />New project<span style={{ flex: 1 }} /><button className="eb icon sm" onClick={onClose}><X size={16} /></button></div>
      <div className="bd">
        <div className="ed-form" style={{ marginBottom: 14 }}><label>Name</label><input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim() && onCreate(name.trim(), ratio)} /></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>{Object.keys(RATIOS).map(r => {
          const wh = RATIOS[r] ?? [16, 9]; const k = Math.min(60 / wh[0], 46 / wh[1]);
          return <button key={r} onClick={() => setRatio(r)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: 10, borderRadius: 10, cursor: "pointer", background: ratio === r ? "rgba(34,211,238,.12)" : "#222226", border: `1px solid ${ratio === r ? "#22d3ee" : "#2e2e33"}`, color: "#ddd", font: "inherit" }}>
            <div style={{ height: 50, display: "flex", alignItems: "center" }}><div style={{ width: wh[0] * k, height: wh[1] * k, border: "2px solid currentColor", borderRadius: 4, borderStyle: r === "original" ? "dashed" : "solid" }} /></div>
            <b style={{ fontSize: 12 }}>{r === "original" ? "Original" : r}</b><span style={{ fontSize: 10.5, color: "#888", textAlign: "center" }}>{icons[r]}</span></button>;
        })}</div>
      </div>
      <div className="ft"><button className="eb" onClick={onClose}>Cancel</button><button className="eb primary" disabled={!name.trim()} onClick={() => onCreate(name.trim(), ratio)}>Create</button></div>
    </div>
  </div>;
}
void Fragment;
