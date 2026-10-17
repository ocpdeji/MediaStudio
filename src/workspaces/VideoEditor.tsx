import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as I from "lucide-react";
import { api, Asset, defaultPreset, errText, fileUrl, Preset, thumbUrl } from "../lib/api";
import { setLeaveGuard, useStore } from "../lib/store";
import { clamp, dirname, fmtDur, timecode } from "../lib/format";
import * as T from "../lib/timeline";
import { confirmAsk, Dialog, Slider } from "../components/ui";
import { OutDir, PresetPicker } from "../components/Dialogs";

const AUTOSAVE = "msp.autosave";
const RES: [string, number, number][] = [["1080p 16:9", 1920, 1080], ["4K UHD 16:9", 3840, 2160], ["720p 16:9", 1280, 720], ["Vertical 9:16", 1080, 1920], ["Square 1:1", 1080, 1080], ["Portrait 4:5", 1080, 1350]];
const FPS: [string, number, number][] = [["23.976", 24000, 1001], ["24", 24, 1], ["25", 25, 1], ["29.97", 30000, 1001], ["30", 30, 1], ["50", 50, 1], ["59.94", 60000, 1001], ["60", 60, 1]];

function clipFromAsset(a: Asset, p: T.Project): T.Clip {
  const dur = (a.duration_ms ?? 0) * 1000;
  if (a.kind === "video") return T.makeClip("video", { asset_id: a.id, path: a.path, name: a.name, out_us: dur || 5e6, source_us: dur || null });
  if (a.kind === "audio") return T.makeClip("audio", { asset_id: a.id, path: a.path, name: a.name, out_us: dur || 5e6, source_us: dur || null });
  return T.makeClip("image", { asset_id: a.id, path: a.path, name: a.name, out_us: T.toFrame(5e6, p) });
}

export function VideoEditor() {
  const { editIds, assets, toast } = useStore();
  const hist = useRef(new T.History<T.Project>(T.newProject()));
  const [proj, setProjState] = useState<T.Project>(hist.current.present);
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState(80);
  const [snapOn, setSnapOn] = useState(true);
  const [range, setRange] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [bin, setBin] = useState<Asset[]>([]);
  const [binQ, setBinQ] = useState("");
  const [dialog, setDialog] = useState<null | "export" | "settings" | "relink">(null);
  const [missing, setMissing] = useState<T.Clip[]>([]);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const dur = T.duration(proj);

  const push = useCallback((p: T.Project) => { if (p === hist.current.present) return; hist.current.push(p); setProjState(p); setDirty(true); }, []);
  const live = useCallback((p: T.Project) => { setProjState(p); }, []);
  const commitLive = useCallback(() => { setProjState(cur => { if (cur !== hist.current.present) { hist.current.push(cur); setDirty(true); } return cur; }); }, []);
  const undo = () => { if (hist.current.undo()) { setProjState(hist.current.present); setDirty(true); } };
  const redo = () => { if (hist.current.redo()) { setProjState(hist.current.present); setDirty(true); } };

  // ---------------------------------------------------------- bootstrap from library selection + crash recovery
  useEffect(() => {
    const raw = localStorage.getItem(AUTOSAVE);
    const fromLib = editIds.map(id => assets.find(a => a.id === id)).filter((a): a is Asset => !!a && a.kind !== "raw");
    setBin(b => { const ids = new Set(b.map(x => x.id)); return [...b, ...fromLib.filter(a => !ids.has(a.id))]; });
    (async () => {
      if (raw) {
        try {
          const s = JSON.parse(raw);
          if (s.dirty && (await confirmAsk("Recover unsaved timeline?", `An unsaved project “${s.project?.name}” from ${new Date(s.at).toLocaleString()} was found (the app may have closed unexpectedly).`, "Recover"))) {
            const p = T.parseProject({ format: "media-studio-project", version: 1, project: s.project }); hist.current = new T.History(p); setProjState(p); setPath(s.path ?? null); setDirty(true); return;
          }
        } catch { /* ignore broken autosave */ }
        localStorage.removeItem(AUTOSAVE);
      }
      if (fromLib.length && !hist.current.present.tracks.some(tr => tr.clips.length)) {
        let p = hist.current.present;
        const v = fromLib.find(a => a.kind === "video");
        if (v?.width && v.height && v.fps_num && v.fps_den) p = { ...p, width: v.width, height: v.height, fps_num: v.fps_num, fps_den: v.fps_den, name: v.name.replace(/\.[^.]+$/, "") };
        const v1 = p.tracks.filter(tr => tr.kind === "video").slice(-1)[0].id, a1 = p.tracks.find(tr => tr.kind === "audio")!.id;
        for (const a of fromLib) p = T.addClip(p, a.kind === "audio" ? a1 : v1, clipFromAsset(a, p));
        hist.current = new T.History(p); setProjState(p); setDirty(fromLib.length > 0);
      }
    })();
  }, []); // eslint-disable-line
  useEffect(() => { const id = setTimeout(() => { try { localStorage.setItem(AUTOSAVE, JSON.stringify({ project: proj, path, at: Date.now(), dirty })); } catch { /* quota */ } }, 1500); return () => clearTimeout(id); }, [proj, path, dirty]);
  useEffect(() => { setLeaveGuard(dirty && proj.tracks.some(tr => tr.clips.length) ? () => confirmAsk("Leave the timeline?", "The project has unsaved changes. It’s kept in autosave and can be recovered, but saving is recommended.", "Leave") : null); return () => setLeaveGuard(null); }, [dirty, proj]);

  // ---------------------------------------------------------- save / open
  const saveProject = async (as = false) => {
    let p = path;
    if (!p || as) { p = await saveDialog({ title: "Save project", defaultPath: `${proj.name}.msproj`, filters: [{ name: "Media Studio project", extensions: ["msproj"] }] }); if (!p) return; }
    try { await api.writeText(p, T.serialize(proj), "project"); setPath(p); setDirty(false); localStorage.setItem(AUTOSAVE, JSON.stringify({ project: proj, path: p, at: Date.now(), dirty: false })); toast("Project saved", "ok"); }
    catch (e) { toast(errText(e), "error"); }
  };
  const openProject = async (file?: string) => {
    if (dirty && proj.tracks.some(tr => tr.clips.length) && !(await confirmAsk("Open another project?", "Unsaved changes to the current timeline will be lost.", "Open"))) return;
    const f = file ?? (await openDialog({ title: "Open project", filters: [{ name: "Media Studio project", extensions: ["msproj"] }] }));
    if (!f || Array.isArray(f)) return;
    try {
      let p = T.parseProject(await api.readProject(f));
      const miss: T.Clip[] = [];
      for (const tr of p.tracks) for (const c of tr.clips) {
        if (!c.path) continue;
        const a = await api.resolveMedia(c.path);
        if (a && a.path !== c.path) p = T.updateClip(p, c.id, { path: a.path, asset_id: a.id });
        else if (a) p = T.updateClip(p, c.id, { asset_id: a.id }); else miss.push(c);
      }
      hist.current = new T.History(p); setProjState(p); setPath(f); setDirty(false); setSel(null); setT(0);
      if (miss.length) { setMissing(miss); setDialog("relink"); }
    } catch (e) { toast(errText(e), "error"); }
  };
  const newProject = async () => {
    if (dirty && proj.tracks.some(tr => tr.clips.length) && !(await confirmAsk("Start a new project?", "Unsaved changes to the current timeline will be lost.", "New project"))) return;
    hist.current = new T.History(T.newProject()); setProjState(hist.current.present); setPath(null); setDirty(false); setSel(null); setT(0); localStorage.removeItem(AUTOSAVE);
  };

  // ---------------------------------------------------------- editing helpers
  const selClip = sel ? T.findClip(proj, sel) : null;
  const firstTrack = (kind: "video" | "audio") => (kind === "video" ? proj.tracks.filter(x => x.kind === "video").slice(-1)[0] : proj.tracks.find(x => x.kind === "audio"))!;
  const addAsset = (a: Asset, trackId?: string, at?: number) => {
    const c = clipFromAsset(a, proj);
    const tr = trackId ? proj.tracks.find(x => x.id === trackId) : firstTrack(c.kind === "audio" ? "audio" : "video");
    if (!tr) return;
    if ((tr.kind === "audio") !== (c.kind === "audio")) return toast(c.kind === "audio" ? "Audio clips go on audio tracks (A1, A2…)" : "Video & images go on video tracks (V1, V2…)");
    if (tr.locked) return toast("That track is locked");
    push(T.addClip(proj, tr.id, c, at)); setSel(c.id);
  };
  const addSynthetic = (kind: "text" | "color") => {
    const top = proj.tracks.find(x => x.kind === "video")!;
    const c = kind === "text" ? T.makeClip("text", { name: "Title", out_us: 4e6, text: { content: "Your title", size: 96, color: "#ffffff", x: 0.5, y: 0.85, box_color: null } })
      : T.makeClip("color", { name: "Colour", out_us: 3e6, color: "#000000" });
    push(T.addClip(proj, top.id, c, t)); setSel(c.id);
  };
  const split = () => { if (!sel) return toast("Select a clip, then split at the playhead (S)"); push(T.splitClip(proj, sel, t)); };
  const del = (ripple: boolean) => { if (!sel) return; push(T.deleteClip(proj, sel, ripple)); setSel(null); };
  const freeze = async () => {
    if (!selClip || selClip.clip.kind !== "video" || !selClip.clip.asset_id) return toast("Select a video clip and put the playhead on the frame to freeze");
    const c = selClip.clip; if (t <= c.start_us || t >= T.clipEnd(c)) return toast("Move the playhead inside the selected clip");
    try {
      const local = c.in_us + Math.round((t - c.start_us) * c.speed);
      const png = await api.captureFrame(c.asset_id!, local, true);
      let p = T.splitClip(proj, c.id, t);
      const len = 2_000_000, tr = selClip.track;
      p = { ...p, tracks: p.tracks.map(x => (x.id === tr.id ? { ...x, clips: x.clips.map(k => (k.start_us >= t ? { ...k, start_us: k.start_us + len } : k)) } : x)) };
      const still = T.makeClip("image", { path: png, name: "Freeze frame", out_us: len });
      p = T.addClip(p, tr.id, still, t); push(p); setSel(still.id); toast("Inserted a 2 s freeze frame", "ok");
    } catch (e) { toast(errText(e), "error"); }
  };

  // ---------------------------------------------------------- playback clock
  const tRef = useRef(t); tRef.current = t;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now(), raf = 0;
    const end = range.out ?? dur;
    const tick = (now: number) => { const nt = tRef.current + (now - last) * 1000; last = now; if (nt >= end) { setT(end); setPlaying(false); return; } setT(nt); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, dur, range.out]);
  const togglePlay = () => { if (!playing && t >= (range.out ?? dur) - 1000) setT(range.in ?? 0); setPlaying(p => !p); };

  // ---------------------------------------------------------- keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (useStore.getState().workspace !== "video" || useStore.getState().dialog || dialog) return;
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase(), fr = T.frameUs(proj);
      if (mod && key === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
      if (mod && key === "y") { e.preventDefault(); return redo(); }
      if (mod && key === "s") { e.preventDefault(); return saveProject(e.shiftKey); }
      if (mod && key === "o") { e.preventDefault(); return openProject(); }
      if (mod && key === "d") { e.preventDefault(); if (sel) push(T.duplicateClip(proj, sel)); return; }
      if (mod) return;
      const m: Record<string, () => void> = {
        " ": togglePlay, k: togglePlay, s: split, delete: () => del(e.shiftKey), backspace: () => del(true),
        arrowleft: () => { setPlaying(false); setT(x => Math.max(0, T.toFrame(x - (e.shiftKey ? 1e6 : fr), proj))); }, arrowright: () => { setPlaying(false); setT(x => T.toFrame(x + (e.shiftKey ? 1e6 : fr), proj)); },
        home: () => setT(0), end: () => setT(dur), i: () => setRange(r => ({ ...r, in: t })), o: () => setRange(r => ({ ...r, out: t })), x: () => setRange({ in: null, out: null }),
        "=": () => setPps(p => Math.min(800, p * 1.25)), "+": () => setPps(p => Math.min(800, p * 1.25)), "-": () => setPps(p => Math.max(4, p / 1.25)), escape: () => setSel(null),
      };
      if (m[key]) { e.preventDefault(); m[key](); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  const binList = useMemo(() => { const q = binQ.toLowerCase(); const src = binQ ? assets.filter(a => a.kind !== "raw") : bin; return src.filter(a => a.name.toLowerCase().includes(q)).slice(0, 300); }, [bin, assets, binQ]);
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto minmax(200px, 1fr) minmax(230px, 40%)", gridTemplateColumns: "minmax(0, 1fr)", height: "100%", minHeight: 0, minWidth: 0 }}>
      <div className="toolbar">
        <I.Clapperboard size={16} /><b className="ellipsis" style={{ maxWidth: 240 }}>{proj.name}{dirty ? " •" : ""}</b>
        <span className="dim num">{proj.width}×{proj.height} · {(proj.fps_num / proj.fps_den).toFixed(3).replace(/\.?0+$/, "")} fps · {fmtDur(dur / 1000)}</span>
        <span className="sep" />
        <button className="btn sm ghost" onClick={newProject}><I.FilePlus size={14} /> New</button>
        <button className="btn sm ghost" onClick={() => openProject()} title="Ctrl+O"><I.FolderOpen size={14} /> Open</button>
        <button className="btn sm ghost" onClick={() => saveProject()} title="Ctrl+S"><I.Save size={14} /> Save</button>
        <button className="btn sm ghost" onClick={() => saveProject(true)}>Save as…</button>
        <button className="btn sm ghost" onClick={() => setDialog("settings")}><I.Settings2 size={14} /> Project settings</button>
        <span className="sep" />
        <button className="btn ghost icon sm" onClick={undo} disabled={!hist.current.canUndo} title="Undo (Ctrl+Z)"><I.Undo2 size={15} /></button>
        <button className="btn ghost icon sm" onClick={redo} disabled={!hist.current.canRedo} title="Redo (Ctrl+Y)"><I.Redo2 size={15} /></button>
        <span className="grow" />
        <button className="btn primary" disabled={dur <= 0} onClick={() => setDialog("export")}><I.Download size={15} /> Export video</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 300px", minHeight: 0, minWidth: 0 }}>
        <aside className="sidebar" style={{ borderRight: "1px solid var(--line)", padding: 8 }}>
          <div className="side-h" style={{ paddingTop: 2 }}>Media <span className="row" style={{ gap: 2 }}>
            <button className="btn ghost sm" title="Add the Library selection" onClick={() => { const ids = new Set(bin.map(b => b.id)); const add = useStore.getState().assets.filter(a => useStore.getState().selected.has(a.id) && !ids.has(a.id) && a.kind !== "raw"); setBin([...bin, ...add]); toast(add.length ? `Added ${add.length} to the bin` : "Select files in the Library first"); }}><I.Plus size={13} /> Library selection</button></span></div>
          <input className="input" style={{ width: "100%", marginBottom: 6 }} placeholder="Search whole library…" value={binQ} onChange={e => setBinQ(e.target.value)} />
          {binList.map(a => <div key={a.id} className="side-item" style={{ height: 46 }} draggable onDragStart={e => e.dataTransfer.setData("text/msp-asset", String(a.id))} onDoubleClick={() => addAsset(a)} title="Drag to the timeline or double-click to append">
            <img src={thumbUrl(a)} style={{ width: 56, height: 36, objectFit: "contain", background: "#000", borderRadius: 4, flex: "none" }} alt="" draggable={false} />
            <div className="grow" style={{ minWidth: 0 }}><div className="ellipsis" style={{ fontSize: 12 }}>{a.name}</div><div className="dim" style={{ fontSize: 11 }}>{a.kind} {a.duration_ms ? "· " + fmtDur(a.duration_ms) : ""}</div></div>
            <button className="btn ghost icon sm" onClick={() => addAsset(a)} title="Append to timeline"><I.Plus size={13} /></button></div>)}
          {!binList.length && <div className="hint" style={{ padding: 8 }}>Select clips in the Library and click “Library selection”, or search your whole library above. Drag items onto the tracks below.</div>}
          <div className="hsep" />
          <div className="side-item" onClick={() => addSynthetic("text")}><I.Type size={15} /> Add title / text</div>
          <div className="side-item" onClick={() => addSynthetic("color")}><I.Square size={15} /> Add colour card</div>
        </aside>
        <Monitor proj={proj} t={t} playing={playing} />
        <ClipInspector proj={proj} sel={sel} push={push} live={live} commitLive={commitLive} t={t} freeze={freeze} />
      </div>
      <Timeline proj={proj} t={t} setT={tt => { setPlaying(false); setT(tt); }} pps={pps} setPps={setPps} sel={sel} setSel={setSel} push={push} live={live} commitLive={commitLive}
        snapOn={snapOn} setSnapOn={setSnapOn} snapLine={snapLine} setSnapLine={setSnapLine} range={range} setRange={setRange} playing={playing} togglePlay={togglePlay}
        split={split} del={del} addAsset={addAsset} dur={dur} />
      {dialog === "export" && <ExportTimeline proj={proj} range={range} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <ProjectSettings proj={proj} onApply={p => { push(p); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog === "relink" && <Dialog title={`${missing.length} media file(s) are missing`} icon={<I.FileWarning size={18} />} onClose={() => setDialog(null)} footer={<button className="btn primary" onClick={() => setDialog(null)}>Done</button>}>
        <div className="hint" style={{ marginBottom: 10 }}>These files were moved or are on a drive that isn’t connected. Relink each to its new location (the timeline keeps your edits).</div>
        {missing.map(c => <div key={c.id} className="row" style={{ padding: "5px 0", borderBottom: "1px solid var(--line)" }}><I.FileX size={15} /><span className="ellipsis grow" title={c.path ?? ""}>{c.path}</span>
          <button className="btn sm" onClick={async () => { const f = await openDialog({ title: `Locate ${c.name ?? c.path}` }); if (!f || Array.isArray(f)) return; const a = await api.resolveMedia(f);
            push(T.updateClip(hist.current.present, c.id, { path: f, asset_id: a?.id ?? null })); setMissing(m => m.filter(x => x.id !== c.id)); if (!a) toast("Relinked. Add that folder to the library for preview playback.", "info"); }}>Relink…</button></div>)}
        {!missing.length && <div className="hint">All media relinked.</div>}
      </Dialog>}
    </div>
  );
}

// ================================================================ preview monitor (approximate compositor; FFmpeg render is authoritative)
function Monitor({ proj, t, playing }: { proj: T.Project; t: number; playing: boolean }) {
  const box = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const pool = useRef(new Map<string, HTMLVideoElement>());
  const imgs = useRef(new Map<string, HTMLImageElement>());
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [, bump] = useState(0);
  useEffect(() => { const ro = new ResizeObserver(() => { const el = box.current; if (!el) return; const s = Math.min((el.clientWidth - 24) / proj.width, (el.clientHeight - 60) / proj.height); setSize({ w: Math.max(32, proj.width * s), h: Math.max(18, proj.height * s) }); }); if (box.current) ro.observe(box.current); return () => ro.disconnect(); }, [proj.width, proj.height]);
  // keep one media element per audio/video clip; drop elements for removed clips
  useEffect(() => {
    const want = new Set<string>();
    for (const tr of proj.tracks) for (const c of tr.clips) {
      if ((c.kind === "video" || c.kind === "audio") && c.path) {
        want.add(c.id);
        if (!pool.current.has(c.id)) { const v = document.createElement("video"); v.src = fileUrl(c.path); v.preload = "auto"; v.playsInline = true; v.onseeked = v.onloadeddata = () => bump(n => n + 1); pool.current.set(c.id, v); }
      }
      if (c.kind === "image" && c.path && !imgs.current.has(c.path)) { const im = new Image(); im.src = fileUrl(c.path); im.onload = () => bump(n => n + 1); imgs.current.set(c.path, im); }
    }
    for (const [id, v] of pool.current) if (!want.has(id)) { v.pause(); v.removeAttribute("src"); v.load(); pool.current.delete(id); }
  }, [proj]);
  useEffect(() => () => { for (const v of pool.current.values()) { v.pause(); v.removeAttribute("src"); v.load(); } }, []);
  // drive media elements + draw
  useEffect(() => {
    const allClips = proj.tracks.flatMap(tr => tr.clips.map(c => ({ c, tr })));
    for (const { c, tr } of allClips) {
      const v = pool.current.get(c.id); if (!v) continue;
      const pre = c.transition === "dissolve" ? c.transition_us : 0;
      const active = t >= c.start_us - pre && t < T.clipEnd(c);
      const local = (c.in_us + (t - c.start_us) * c.speed) / 1e6;
      if (!active) { if (!v.paused) v.pause(); continue; }
      v.muted = tr.muted || c.volume === 0; v.volume = clamp(c.volume * (tr.volume || 1), 0, 1); v.playbackRate = clamp(c.speed, 0.0625, 16);
      if (playing) { if (Math.abs(v.currentTime - local) > 0.25) v.currentTime = Math.max(0, local); if (v.paused) v.play().catch(() => {}); }
      else { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - local) > 0.02) v.currentTime = Math.max(0, local); }
    }
    const c = cv.current; if (!c) return;
    const k = devicePixelRatio || 1; c.width = Math.round(size.w * k); c.height = Math.round(size.h * k);
    const x = c.getContext("2d")!; const s = (size.w * k) / proj.width; x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = proj.background; x.fillRect(0, 0, c.width, c.height);
    for (const { clip, local_us } of T.activeAt(proj, t)) {
      const len = T.clipLen(clip), pre = clip.transition === "dissolve" ? clip.transition_us : 0, since = t - (clip.start_us - pre), until = T.clipEnd(clip) - t;
      let alpha = clip.transform.opacity;
      const fi = clip.transition !== "none" ? Math.max(clip.transition_us, clip.fade_in_us) : clip.fade_in_us;
      if (fi > 0 && since < fi) alpha *= since / fi;
      if (clip.fade_out_us > 0 && until < clip.fade_out_us) alpha *= until / clip.fade_out_us;
      void len; void local_us;
      x.save(); x.globalAlpha = clamp(alpha, 0, 1);
      const a = clip.adjust; x.filter = `brightness(${100 + a.brightness * 100}%) contrast(${a.contrast * 100}%) saturate(${a.saturation * 100}%)` + (Math.abs(a.temperature - 6500) > 1 ? ` sepia(${clamp((6500 - a.temperature) / 9000, 0, 0.4)})` : "");
      const W = proj.width * s, H = proj.height * s;
      let src: CanvasImageSource | null = null, sw = 0, sh = 0;
      if (clip.kind === "video") { const v = pool.current.get(clip.id); if (v && v.readyState >= 2) { src = v; sw = v.videoWidth; sh = v.videoHeight; } }
      if (clip.kind === "image" && clip.path) { const im = imgs.current.get(clip.path); if (im?.complete && im.naturalWidth) { src = im; sw = im.naturalWidth; sh = im.naturalHeight; } }
      if (src && sw && sh) {
        const sc = clip.transform.scale; const tw = W * sc, th = H * sc;
        let dw = tw, dh = th;
        if (clip.fit === "contain") { const r = Math.min(tw / sw, th / sh); dw = sw * r; dh = sh * r; } else if (clip.fit === "cover") { const r = Math.max(tw / sw, th / sh); dw = sw * r; dh = sh * r; }
        x.translate(W / 2 + clip.transform.x * W, H / 2 + clip.transform.y * H); x.rotate((clip.transform.rotation * Math.PI) / 180);
        if (clip.fit === "cover") { x.beginPath(); x.rect(-tw / 2, -th / 2, tw, th); x.clip(); }
        x.drawImage(src, -dw / 2, -dh / 2, dw, dh);
      } else if (clip.kind === "color") { x.fillStyle = clip.color ?? "#000"; x.fillRect(0, 0, W, H); }
      else if (clip.kind === "text" && clip.text) {
        const tx = clip.text, size2 = (tx.size * H) / 1080; x.font = `600 ${size2}px "Segoe UI"`; x.textBaseline = "top";
        const lines = tx.content.split("\n"), lh = size2 * 1.2, tw = Math.max(...lines.map(l => x.measureText(l).width)), th = lines.length * lh;
        const px = (W - tw) * tx.x, py = (H - th) * tx.y;
        if (tx.box_color) { x.fillStyle = tx.box_color + "99"; x.fillRect(px - size2 / 3, py - size2 / 3, tw + (2 * size2) / 3, th + (2 * size2) / 3); }
        x.fillStyle = tx.color || "#fff"; lines.forEach((l, i) => x.fillText(l, px, py + i * lh));
      }
      x.restore();
    }
  });
  return (
    <div ref={box} style={{ background: "#0b0b0d", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 0, minHeight: 0, overflow: "hidden", position: "relative" }}>
      <canvas ref={cv} style={{ width: size.w, height: size.h, boxShadow: "0 0 0 1px #222" }} />
      <div className="row" style={{ marginTop: 8, color: "#ccc" }}><span className="mono num">{timecode(t, proj.fps_num, proj.fps_den)}</span><span className="dim" style={{ fontSize: 11 }}>Preview is approximate — the export is rendered exactly by FFmpeg.</span></div>
    </div>
  );
}

// ================================================================ clip inspector
function ClipInspector({ proj, sel, push, live, commitLive, t, freeze }: { proj: T.Project; sel: string | null; push: (p: T.Project) => void; live: (p: T.Project) => void; commitLive: () => void; t: number; freeze: () => void }) {
  const f = sel ? T.findClip(proj, sel) : null;
  if (!f) return <aside className="inspector"><div className="empty"><I.MousePointerClick size={26} /><h2 style={{ fontSize: 15 }}>No clip selected</h2>Click a clip on the timeline to edit its timing, look, sound and transitions.</div></aside>;
  const c = f.clip;
  const up = (p: Partial<T.Clip>, isLive = false) => (isLive ? live : push)(T.updateClip(proj, c.id, p));
  const tr = (p: Partial<T.Transform>, isLive = false) => up({ transform: { ...c.transform, ...p } }, isLive);
  const ad = (p: Partial<T.Adjust>, isLive = false) => up({ adjust: { ...c.adjust, ...p } }, isLive);
  const fps = [proj.fps_num, proj.fps_den] as const;
  const visual = c.kind !== "audio";
  return (
    <aside className="inspector">
      <div className="sec"><div className="sec-h">{c.kind} clip</div>
        <div className="ellipsis" title={c.path ?? ""}>{c.name ?? c.kind}</div>
        <dl className="kv" style={{ marginTop: 8 }}><dt>Start</dt><dd className="mono">{timecode(c.start_us, ...fps)}</dd><dt>Duration</dt><dd className="mono">{timecode(T.clipLen(c), ...fps)}</dd>
          {(c.kind === "video" || c.kind === "audio") && <><dt>Source in/out</dt><dd className="mono">{timecode(c.in_us, ...fps)} – {timecode(c.out_us, ...fps)}</dd></>}</dl>
        {(c.kind === "image" || c.kind === "text" || c.kind === "color") && <Slider label="Duration (s)" min={0.2} max={60} step={0.1} value={(c.out_us - c.in_us) / 1e6} onChange={v => up({ out_us: c.in_us + T.toFrame(v * 1e6, proj) }, true)} onCommit={commitLive} />}
        {c.kind === "video" && <button className="btn sm" style={{ marginTop: 6 }} onClick={freeze} disabled={t <= c.start_us || t >= T.clipEnd(c)}><I.Snowflake size={13} /> Freeze frame at playhead (2 s)</button>}
      </div>
      {(c.kind === "video" || c.kind === "audio") && <div className="sec"><div className="sec-h">Speed & sound</div>
        <Slider label="Speed" min={0.25} max={4} step={0.05} value={c.speed} onChange={v => up({ speed: v }, true)} onCommit={commitLive} format={v => v.toFixed(2) + "×"} reset={1} />
        <Slider label="Volume" min={0} max={2} step={0.01} value={c.volume} onChange={v => up({ volume: v }, true)} onCommit={commitLive} format={v => Math.round(v * 100) + "%"} reset={1} /></div>}
      <div className="sec"><div className="sec-h">Fades & transition</div>
        <Slider label="Fade in" min={0} max={5} step={0.05} value={c.fade_in_us / 1e6} onChange={v => up({ fade_in_us: v * 1e6 }, true)} onCommit={commitLive} format={v => v.toFixed(2) + "s"} reset={0} />
        <Slider label="Fade out" min={0} max={5} step={0.05} value={c.fade_out_us / 1e6} onChange={v => up({ fade_out_us: v * 1e6 }, true)} onCommit={commitLive} format={v => v.toFixed(2) + "s"} reset={0} />
        <div className="field" style={{ gridTemplateColumns: "100px 1fr" }}><label>Transition in</label><select className="input" value={c.transition} onChange={e => up({ transition: e.target.value as T.Clip["transition"] })}>
          <option value="none">None (cut)</option><option value="dissolve">Cross-dissolve</option><option value="fade">Fade in</option></select></div>
        {c.transition !== "none" && <Slider label="Length" min={0.1} max={3} step={0.05} value={c.transition_us / 1e6} onChange={v => up({ transition_us: v * 1e6 }, true)} onCommit={commitLive} format={v => v.toFixed(2) + "s"} />}
        {c.transition === "dissolve" && <div className="hint">Dissolves overlap the end of the previous clip on this track.</div>}</div>
      {visual && c.kind !== "text" && c.kind !== "color" && <div className="sec"><div className="sec-h">Frame & position</div>
        <div className="field" style={{ gridTemplateColumns: "100px 1fr" }}><label>Fit</label><select className="input" value={c.fit} onChange={e => up({ fit: e.target.value as T.Clip["fit"] })}><option value="contain">Fit (letterbox)</option><option value="cover">Fill (crop)</option><option value="fill">Stretch</option></select></div>
        <Slider label="Scale" min={0.05} max={3} step={0.01} value={c.transform.scale} onChange={v => tr({ scale: v }, true)} onCommit={commitLive} format={v => Math.round(v * 100) + "%"} reset={1} />
        <Slider label="Position X" min={-1} max={1} step={0.005} value={c.transform.x} onChange={v => tr({ x: v }, true)} onCommit={commitLive} format={v => v.toFixed(2)} reset={0} />
        <Slider label="Position Y" min={-1} max={1} step={0.005} value={c.transform.y} onChange={v => tr({ y: v }, true)} onCommit={commitLive} format={v => v.toFixed(2)} reset={0} />
        <Slider label="Rotation" min={-180} max={180} value={c.transform.rotation} onChange={v => tr({ rotation: v }, true)} onCommit={commitLive} format={v => v + "°"} reset={0} />
        <Slider label="Opacity" min={0} max={1} step={0.01} value={c.transform.opacity} onChange={v => tr({ opacity: v }, true)} onCommit={commitLive} format={v => Math.round(v * 100) + "%"} reset={1} />
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}><button className="btn sm" onClick={() => up({ transform: { ...c.transform, scale: 0.33, x: 0.3, y: -0.3 } })}>Picture-in-picture</button><button className="btn sm" onClick={() => up({ transform: T.defaultTransform() })}>Reset</button></div></div>}
      {visual && c.kind !== "text" && c.kind !== "color" && <div className="sec"><div className="sec-h">Colour</div>
        <Slider label="Brightness" min={-0.5} max={0.5} step={0.01} value={c.adjust.brightness} onChange={v => ad({ brightness: v }, true)} onCommit={commitLive} reset={0} />
        <Slider label="Contrast" min={0.5} max={2} step={0.01} value={c.adjust.contrast} onChange={v => ad({ contrast: v }, true)} onCommit={commitLive} reset={1} />
        <Slider label="Saturation" min={0} max={2.5} step={0.01} value={c.adjust.saturation} onChange={v => ad({ saturation: v }, true)} onCommit={commitLive} reset={1} />
        <Slider label="Temperature" min={2000} max={12000} step={50} value={c.adjust.temperature} onChange={v => ad({ temperature: v }, true)} onCommit={commitLive} format={v => v + "K"} reset={6500} /></div>}
      {c.kind === "text" && c.text && <div className="sec"><div className="sec-h">Title</div>
        <textarea className="input" rows={3} style={{ width: "100%" }} value={c.text.content} onChange={e => up({ text: { ...c.text!, content: e.target.value } }, true)} onBlur={commitLive} />
        <Slider label="Size" min={16} max={300} value={c.text.size} onChange={v => up({ text: { ...c.text!, size: v } }, true)} onCommit={commitLive} />
        <Slider label="Horizontal" min={0} max={1} step={0.01} value={c.text.x} onChange={v => up({ text: { ...c.text!, x: v } }, true)} onCommit={commitLive} />
        <Slider label="Vertical" min={0} max={1} step={0.01} value={c.text.y} onChange={v => up({ text: { ...c.text!, y: v } }, true)} onCommit={commitLive} />
        <div className="row"><span className="dim">Colour</span><input type="color" value={c.text.color} onChange={e => up({ text: { ...c.text!, color: e.target.value } })} />
          <label className="check"><input type="checkbox" checked={!!c.text.box_color} onChange={e => up({ text: { ...c.text!, box_color: e.target.checked ? "#000000" : null } })} /> Background box</label></div></div>}
      {c.kind === "color" && <div className="sec"><div className="sec-h">Colour card</div><input type="color" value={c.color ?? "#000000"} onChange={e => up({ color: e.target.value })} /></div>}
      <div className="sec"><button className="btn sm danger" onClick={() => push(T.deleteClip(proj, c.id, false))}><I.Trash2 size={13} /> Delete clip</button></div>
    </aside>
  );
}

// ================================================================ timeline
function Timeline(props: { proj: T.Project; t: number; setT: (t: number) => void; pps: number; setPps: (f: (p: number) => number) => void; sel: string | null; setSel: (s: string | null) => void;
  push: (p: T.Project) => void; live: (p: T.Project) => void; commitLive: () => void; snapOn: boolean; setSnapOn: (b: boolean) => void; snapLine: number | null; setSnapLine: (n: number | null) => void;
  range: { in: number | null; out: number | null }; setRange: (r: { in: number | null; out: number | null }) => void; playing: boolean; togglePlay: () => void; split: () => void; del: (r: boolean) => void; addAsset: (a: Asset, track?: string, at?: number) => void; dur: number }) {
  const { proj, t, setT, pps, setPps, sel, setSel, push, live, commitLive, snapOn, setSnapOn, snapLine, setSnapLine, range, setRange, playing, togglePlay, split, del, addAsset, dur } = props;
  const body = useRef<HTMLDivElement>(null);
  const toX = (us: number) => (us / 1e6) * pps;
  const fromX = (x: number) => Math.max(0, (x / pps) * 1e6);
  const width = Math.max(toX(Math.max(dur, 30e6)) + 400, 1200);
  const snapTo = (us: number, ignore?: string) => { if (!snapOn) { setSnapLine(null); return us; } const s = T.snap(proj, us, (10 / pps) * 1e6, [t, ...(range.in != null ? [range.in] : []), ...(range.out != null ? [range.out] : [])], ignore); setSnapLine(s !== us ? s : null); return s; };
  const laneAt = (clientY: number) => { const el = document.elementsFromPoint(window.innerWidth / 2, clientY).find(e => (e as HTMLElement).dataset?.track) as HTMLElement | undefined; return el?.dataset.track; };
  const startDrag = (e: React.PointerEvent, c: T.Clip, mode: "move" | "l" | "r") => {
    e.stopPropagation(); setSel(c.id); const f = T.findClip(proj, c.id); if (!f || f.track.locked) return;
    const x0 = e.clientX, base = proj; (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => {
      const delta = ((ev.clientX - x0) / pps) * 1e6;
      if (mode === "move") {
        const len = T.clipLen(c); let ns = c.start_us + delta;
        const s1 = snapTo(ns, c.id); if (s1 !== ns) ns = s1; else ns = snapTo(ns + len, c.id) - len; // snap either edge
        const lane = laneAt(ev.clientY) ?? f.track.id;
        const moved = T.moveClip(base, c.id, ns, lane); if (moved !== base) live(moved);
      } else live(T.trimClip(base, c.id, mode === "l" ? "start" : "end", snapTo(mode === "l" ? c.start_us + delta : T.clipEnd(c) + delta, c.id)));
    };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); setSnapLine(null); commitLive(); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
  const scrub = (e: React.PointerEvent) => {
    const r = body.current!.getBoundingClientRect(), left = r.left + 150 - body.current!.scrollLeft;
    const at = (cx: number) => T.toFrame(fromX(cx - left), proj);
    setT(at(e.clientX)); (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => setT(at(ev.clientX)); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
  // auto-scroll to keep the playhead visible while playing
  useEffect(() => { const el = body.current; if (!el || !playing) return; const x = toX(t) + 150; if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 200; }, [t, playing]); // eslint-disable-line
  const step = pps >= 200 ? 1 : pps >= 60 ? 2 : pps >= 25 ? 5 : pps >= 10 ? 10 : 30;
  const ticks = []; for (let s = 0; s * pps < width; s += step) ticks.push(s);
  const trackH = (tr: T.Track) => (tr.kind === "audio" ? 44 : 54);
  return (
    <div className="tl">
      <div className="tl-tools">
        <button className="btn ghost icon sm" onClick={togglePlay} title="Play / pause (Space)">{playing ? <I.Pause size={15} /> : <I.Play size={15} />}</button>
        <span className="mono num" style={{ minWidth: 92 }}>{timecode(t, proj.fps_num, proj.fps_den)}</span>
        <span className="sep" />
        <button className="btn ghost sm" onClick={split} title="Split at playhead (S)"><I.Scissors size={14} /> Split</button>
        <button className="btn ghost sm" onClick={() => del(false)} disabled={!sel} title="Delete (Del)"><I.Trash2 size={14} /> Delete</button>
        <button className="btn ghost sm" onClick={() => del(true)} disabled={!sel} title="Ripple delete (Shift+Del)"><I.ArrowLeftToLine size={14} /> Ripple delete</button>
        <button className="btn ghost sm" onClick={() => sel && push(T.duplicateClip(proj, sel))} disabled={!sel} title="Duplicate (Ctrl+D)"><I.Copy size={14} /> Duplicate</button>
        <span className="sep" />
        <button className={`btn ghost sm ${snapOn ? "on" : ""}`} onClick={() => setSnapOn(!snapOn)} title="Snapping"><I.Magnet size={14} /> Snap</button>
        <button className="btn ghost sm" onClick={() => setRange({ ...range, in: t })} title="Export range in (I)">[ In</button>
        <button className="btn ghost sm" onClick={() => setRange({ ...range, out: t })} title="Export range out (O)">Out ]</button>
        {(range.in != null || range.out != null) && <button className="btn ghost sm" onClick={() => setRange({ in: null, out: null })} title="Clear range (X)">Clear range</button>}
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => push(T.addTrack(proj, "video"))}><I.Plus size={13} /> Video track</button>
        <button className="btn ghost sm" onClick={() => push(T.addTrack(proj, "audio"))}><I.Plus size={13} /> Audio track</button>
        <I.ZoomOut size={14} /><input type="range" min={4} max={800} value={pps} onChange={e => setPps(() => +e.target.value)} style={{ width: 110 }} aria-label="Timeline zoom" /><I.ZoomIn size={14} />
      </div>
      <div className="tl-body" ref={body} onWheel={e => { if (e.ctrlKey) { e.preventDefault(); setPps(p => clamp(p * Math.exp(-e.deltaY * 0.002), 4, 800)); } }}>
        <div className="tl-heads">
          <div className="tl-ruler" style={{ position: "sticky", top: 0 }} />
          {proj.tracks.map(tr => <div key={tr.id} className={`tl-head ${tr.kind}`} style={{ height: trackH(tr) }}>
            <b style={{ width: 26 }}>{tr.name}</b>
            <button className={`btn ghost icon sm ${tr.locked ? "on" : ""}`} title="Lock" onClick={() => push(T.updateTrack(proj, tr.id, { locked: !tr.locked }))}>{tr.locked ? <I.Lock size={12} /> : <I.Unlock size={12} />}</button>
            {tr.kind === "video" ? <button className={`btn ghost icon sm ${tr.hidden ? "on" : ""}`} title="Hide" onClick={() => push(T.updateTrack(proj, tr.id, { hidden: !tr.hidden }))}>{tr.hidden ? <I.EyeOff size={12} /> : <I.Eye size={12} />}</button> : null}
            <button className={`btn ghost icon sm ${tr.muted ? "on" : ""}`} title="Mute" onClick={() => push(T.updateTrack(proj, tr.id, { muted: !tr.muted }))}>{tr.muted ? <I.VolumeX size={12} /> : <I.Volume2 size={12} />}</button>
            <button className="btn ghost icon sm" title="Move up" onClick={() => push(T.moveTrack(proj, tr.id, -1))}><I.ChevronUp size={12} /></button>
            <button className="btn ghost icon sm" title="Remove track (needs at least one of each kind)" onClick={() => push(T.removeTrack(proj, tr.id))}><I.X size={12} /></button>
          </div>)}
        </div>
        <div style={{ position: "relative", width }}>
          <div className="tl-ruler" style={{ width }} onPointerDown={scrub}>
            {ticks.map(s => <span key={s}><span className="tick" style={{ left: s * pps, height: 8 }} /><span className="lbl" style={{ left: s * pps }}>{s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`}</span></span>)}
            {range.in != null && range.out != null && range.out > range.in && <div style={{ position: "absolute", top: 0, bottom: 0, left: toX(range.in), width: toX(range.out - range.in), background: "rgba(106,168,255,.25)", borderLeft: "2px solid var(--accent)", borderRight: "2px solid var(--accent)" }} />}
          </div>
          {proj.tracks.map(tr => <div key={tr.id} data-track={tr.id} className={`tl-lane ${tr.kind} ${tr.locked ? "locked" : ""}`} style={{ height: trackH(tr), opacity: tr.hidden ? 0.45 : 1 }}
            onPointerDown={e => { if (e.target === e.currentTarget) setSel(null); }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const id = +e.dataTransfer.getData("text/msp-asset"); const a = useStore.getState().assets.find(x => x.id === id); if (!a) return;
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); addAsset(a, tr.id, snapTo(fromX(e.clientX - r.left))); setSnapLine(null); }}>
            {tr.clips.map(c => {
              const pre = c.transition === "dissolve" ? c.transition_us : 0;
              return <div key={c.id} className={`tl-clip ${c.kind} ${sel === c.id ? "sel" : ""}`} style={{ left: toX(c.start_us), width: Math.max(4, toX(T.clipLen(c))) }}
                onPointerDown={e => startDrag(e, c, "move")} title={`${c.name ?? c.kind} · ${fmtDur(T.clipLen(c) / 1000)}${c.speed !== 1 ? ` · ${c.speed}×` : ""}`}>
                {c.asset_id && (c.kind === "video" || c.kind === "audio" || c.kind === "image") && <div className="filmstrip" style={{ backgroundImage: `url("${thumbUrl({ id: c.asset_id, mtime: 0, size: 0 })}")`, backgroundSize: c.kind === "audio" ? "100% 100%" : "auto 100%" }} />}
                {pre > 0 && <div className="tr" style={{ width: Math.min(toX(pre), toX(T.clipLen(c))) }} />}
                <span className="cn">{c.kind === "text" ? `T  ${c.text?.content.split("\n")[0]}` : c.name ?? c.kind}{c.speed !== 1 ? ` · ${c.speed.toFixed(2)}×` : ""}</span>
                <div className="h l" onPointerDown={e => startDrag(e, c, "l")} /><div className="h r" onPointerDown={e => startDrag(e, c, "r")} />
              </div>;
            })}
          </div>)}
          <div className="tl-playhead" style={{ left: toX(t) }} />
          {snapLine != null && <div className="tl-snap" style={{ left: toX(snapLine) }} />}
        </div>
      </div>
    </div>
  );
}

// ================================================================ dialogs
function ProjectSettings({ proj, onApply, onClose }: { proj: T.Project; onApply: (p: T.Project) => void; onClose: () => void }) {
  const [p, setP] = useState(proj);
  return (
    <Dialog title="Project settings" icon={<I.Settings2 size={18} />} size="narrow" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onApply(p)}>Apply</button></>}>
      <div className="field"><label>Name</label><input className="input" value={p.name} onChange={e => setP({ ...p, name: e.target.value })} /></div>
      <div className="field"><label>Resolution</label><select className="input" value={`${p.width}x${p.height}`} onChange={e => { const [w, h] = e.target.value.split("x").map(Number); setP({ ...p, width: w, height: h }); }}>
        {RES.map(([l, w, h]) => <option key={l} value={`${w}x${h}`}>{l} ({w}×{h})</option>)}{!RES.some(r => r[1] === p.width && r[2] === p.height) && <option value={`${p.width}x${p.height}`}>Custom {p.width}×{p.height}</option>}</select></div>
      <div className="field"><label>Custom size</label><div className="row"><input className="input num-in" type="number" value={p.width} onChange={e => setP({ ...p, width: clamp(+e.target.value & ~1, 16, 7680) })} />×<input className="input num-in" type="number" value={p.height} onChange={e => setP({ ...p, height: clamp(+e.target.value & ~1, 16, 7680) })} /></div></div>
      <div className="field"><label>Frame rate</label><select className="input" value={`${p.fps_num}/${p.fps_den}`} onChange={e => { const [n, d] = e.target.value.split("/").map(Number); setP({ ...p, fps_num: n, fps_den: d }); }}>
        {FPS.map(([l, n, d]) => <option key={l} value={`${n}/${d}`}>{l} fps</option>)}</select></div>
      <div className="field"><label>Background</label><input type="color" value={p.background} onChange={e => setP({ ...p, background: e.target.value })} /></div>
      <div className="hint">Clips keep their positions; the frame rate affects snapping and the exported video.</div>
    </Dialog>
  );
}

function ExportTimeline({ proj, range, onClose }: { proj: T.Project; range: { in: number | null; out: number | null }; onClose: () => void }) {
  const firstPath = proj.tracks.flatMap(t => t.clips).find(c => c.path)?.path;
  const [preset, setPreset] = useState<Preset>(defaultPreset({ width: proj.width, height: proj.height, fps_num: proj.fps_num, fps_den: proj.fps_den }));
  const [name, setName] = useState(proj.name.replace(/[\\/:*?"<>|]/g, "_") || "export");
  const [out, setOut] = useState<string | null>(firstPath ? dirname(firstPath) : null);
  const hasRange = range.in != null && range.out != null && range.out > range.in;
  const [useRange, setUseRange] = useState(hasRange);
  const total = T.duration(proj), len = useRange && hasRange ? range.out! - range.in! : total;
  const go = async () => {
    if (!out) return useStore.getState().toast("Choose an output folder", "error");
    try {
      await api.enqueue({ type: "render", project: T.renderOrder(proj), preset, range: useRange && hasRange ? [range.in!, range.out!] : null, out_dir: out, name: `${name}.${preset.container === "webm" ? "webm" : preset.container === "mov" ? "mov" : preset.container === "mkv" ? "mkv" : "mp4"}` }, `Render · ${proj.name}`);
      useStore.getState().toast("Rendering in the background — see Jobs for progress.", "ok", { label: "Show jobs", run: () => useStore.getState().setDialog({ kind: "jobs" }) }); onClose();
    } catch (e) { useStore.getState().toast(errText(e), "error"); }
  };
  return (
    <Dialog title="Export timeline" icon={<I.Download size={18} />} onClose={onClose} footer={<><span className="dim grow num">{fmtDur(len / 1000)} · {preset.width ?? proj.width}×{preset.height ?? proj.height}</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={len <= 0}>Render</button></>}>
      {hasRange && <div className="field"><label>Range</label><label className="check"><input type="checkbox" checked={useRange} onChange={e => setUseRange(e.target.checked)} /> Only the marked range ({fmtDur((range.out! - range.in!) / 1000)})</label></div>}
      <PresetPicker value={preset} onChange={p => setPreset({ ...p, width: p.width ?? proj.width, height: p.height ?? proj.height })} />
      <div className="field"><label>File name</label><input className="input" value={name} onChange={e => setName(e.target.value)} /></div>
      <div className="field"><label>Save to</label><OutDir value={out} onChange={setOut} /></div>
      <div className="hint">Rendered frame-exactly by FFmpeg at {(proj.fps_num / proj.fps_den).toFixed(3).replace(/\.?0+$/, "")} fps. Existing files are never overwritten — a numbered name is used instead.</div>
    </Dialog>
  );
}
