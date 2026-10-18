import { ReactNode, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  AudioLines, Bot, Captions, Clapperboard, Download, Film, FolderOpen, Image as ImageIcon, LayoutTemplate, Loader2, Mic2, Music, Palette, Plus, Scissors, Search, SlidersHorizontal, Smile, Sparkles,
  Type, Upload, Wand2, Waves,
} from "lucide-react";
import { ed, StockItem } from "../api";
import { addClips, Clip, end, findClip, mainTrack, MediaRef, nextAdjacent, SEC, uid, updateClip } from "../model";
import { clipForMedia, importPaths, LeftTab, notify, useEd, watchJob } from "../store";
import { EFFECT_CATS, EFFECTS } from "../engine/effects";
import { FILTER_CATS, FILTERS, parseCube } from "../engine/luts";
import { FEATURED, TRANSITION_CATS, TRANSITIONS } from "../engine/transitions";
import { EMOJI_SETS, SHAPES } from "../engine/text";
import { CAPTION_STYLES, TEMPLATES, TEXT_PRESETS, textClip } from "../presets";
import { autoCaptions, parseSubs, removeSilences, subsToClips, toSrt, toTxt, toVtt, translateCaptions, placeCaptions } from "../ai/captions";
import { ensureMatte } from "../ai/cutout";
import { fileUrl } from "../engine/sources";
import { useStrip } from "./Timeline";
import { previewComp } from "./previewBridge";

const TABS: [LeftTab, string, ReactNode][] = [
  ["media", "Media", <Film size={18} />], ["audio", "Audio", <Music size={18} />], ["text", "Text", <Type size={18} />], ["stickers", "Stickers", <Smile size={18} />],
  ["effects", "Effects", <Sparkles size={18} />], ["transitions", "Transitions", <Clapperboard size={18} />], ["captions", "Captions", <Captions size={18} />],
  ["filters", "Filters", <Palette size={18} />], ["adjust", "Adjustment", <SlidersHorizontal size={18} />], ["templates", "Templates", <LayoutTemplate size={18} />], ["ai", "AI", <Bot size={18} />],
];

export function LeftPanel() {
  const left = useEd(s => s.left);
  return (
    <div className="ed-left">
      <div className="ed-tabs">{TABS.map(([k, l, ic]) => <button key={k} className={`ed-tab ${left === k ? "on" : ""}`} onClick={() => useEd.getState().setLeft(k)}>{ic}{l}</button>)}</div>
      <div className="ed-lbody">
        {left === "media" && <MediaPanel />}
        {left === "audio" && <AudioPanel />}
        {left === "text" && <TextPanel />}
        {left === "stickers" && <StickerPanel />}
        {left === "effects" && <EffectsPanel />}
        {left === "transitions" && <TransitionsPanel />}
        {left === "captions" && <CaptionsPanel />}
        {left === "filters" && <FiltersPanel />}
        {left === "adjust" && <AdjustPanel />}
        {left === "templates" && <TemplatesPanel />}
        {left === "ai" && <AiPanel />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

function SubNav({ items, value, onChange }: { items: [string, string][]; value: string; onChange: (v: string) => void }) {
  return <div className="ed-subnav">{items.map(([k, l]) => <button key={k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>{l}</button>)}</div>;
}
const drag = (data: object) => (e: React.DragEvent) => { e.dataTransfer.setData("application/x-msp", JSON.stringify(data)); e.dataTransfer.effectAllowed = "copy"; };
const addAtPlayhead = (clip: Clip, toMain?: boolean) => { const c = { ...clip, id: uid() }; useEd.getState().commit(p => addClips(p, [c], { at: useEd.getState().t, toMain })); useEd.getState().select([c.id]); };
const fmtDur = (us: number) => { const s = Math.round(us / 1e6); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const selClip = () => { const s = useEd.getState(); return s.sel.length === 1 ? findClip(s.p!, s.sel[0]) : null; };

async function pickFiles(kinds: "media" | "audio" | "image" = "media") {
  const ext = kinds === "audio" ? ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "aiff"] : kinds === "image" ? ["png", "jpg", "jpeg", "webp", "gif", "bmp"] :
    ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mts", "m2ts", "wmv", "flv", "3gp", "mpg", "mpeg", "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "avif", "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];
  const r = await open({ multiple: true, filters: [{ name: "Media", extensions: ext }] });
  return Array.isArray(r) ? r : r ? [r] : [];
}

// ---------------------------------------------------------------- Media

function MediaPanel() {
  const [sub, setSub] = useState("project");
  return <>
    <SubNav value={sub} onChange={setSub} items={[["project", "Import"], ["library", "Library"], ["stock", "Stock"]]} />
    <div className="ed-content">
      {sub === "project" && <ProjectMedia kind={null} />}
      {sub === "library" && <LibraryMedia />}
      {sub === "stock" && <StockPanel kinds={[["video", "Videos"], ["image", "Photos"]]} providers={["pexels", "pixabay"]} />}
    </div>
  </>;
}

function ProjectMedia({ kind }: { kind: MediaRef["kind"] | null }) {
  const p = useEd(s => s.p)!, prep = useEd(s => s.prep);
  const [busy, setBusy] = useState(false);
  const list = Object.values(p.media).filter(m => (kind ? m.kind === kind : true)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const imp = async () => { const f = await pickFiles(kind === "audio" ? "audio" : "media"); if (!f.length) return; setBusy(true); try { await importPaths(f); } finally { setBusy(false); } };
  const used = useMemo(() => new Set(p.tracks.flatMap(t => t.clips.map(c => c.media))), [p.tracks]);
  return <>
    <div className="ed-import" onClick={imp} style={{ marginBottom: 12 }}>{busy ? <Loader2 className="spin" size={22} /> : <Upload size={22} />}<b style={{ color: "#ddd" }}>Import</b><span>Videos, photos and audio — or drag files onto the window</span></div>
    {!list.length ? <div className="ed-empty">No media yet.</div> :
      <div className="ed-grid">{list.map(m => {
        const pr = Object.entries(prep).find(([k]) => k.startsWith(m.id + ":"))?.[1];
        return <MediaCard key={m.id} m={m} used={used.has(m.id)} prep={pr?.progress} onAdd={() => addAtPlayhead(clipForMedia(m))} />;
      })}</div>}
  </>;
}

function MediaCard({ m, used, prep, onAdd }: { m: MediaRef; used: boolean; prep?: number; onAdd: () => void }) {
  const fs = useStrip(m.kind === "video" ? (m.playable ? m.path : m.optimized ?? m.path) : undefined, m.duration, m.width, m.height);
  const bg = m.kind === "image" ? `url("${fileUrl(m.playable ? m.path : m.optimized ?? m.path)}") center/cover`
    : fs ? `url("${fileUrl(fs.path)}") 0 0/${fs.cols * 100}% auto` : undefined;
  return <div className="ed-card" draggable onDragStart={drag({ media: m.id })} onDoubleClick={onAdd} title={`${m.name}\n${m.width ? `${m.width}×${m.height} · ` : ""}${m.reason ?? ""}`} style={{ background: bg }}>
    {m.kind === "audio" && <AudioLines size={28} color="#5be3a0" />}
    {m.kind !== "image" && <span className="badge">{fmtDur(m.duration)}</span>}
    {used && <span className="badge" style={{ right: "auto", left: 4, background: "rgba(34,211,238,.85)", color: "#012" }}>Added</span>}
    {m.missing && <span className="warn">Missing</span>}
    {prep !== undefined && <><div className="prep" style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>Preparing {Math.round(prep * 100)}%</div><div className="prog" style={{ width: `${prep * 100}%` }} /></>}
    <div className="lbl">{m.name}</div>
    <button className="add" title="Add to timeline at the playhead" onClick={e => { e.stopPropagation(); onAdd(); }}><Plus size={14} /></button>
  </div>;
}

function LibraryMedia() {
  const [items, setItems] = useState<{ id: number; path: string; name: string; kind: string; duration_ms: number | null }[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => { invoke<any[]>("query_assets", { q: { text: q, kinds: ["video", "image", "audio"], rejected: "hide", sort: "mtime", desc: true, limit: 300, recursive: true } }).then(setItems).catch(() => setItems([])); }, [q]);
  return <>
    <div className="ed-note">Media from your Media Studio library folders. Double-click or + to use it.</div>
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}><Search size={16} style={{ marginTop: 6 }} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search library…" style={{ flex: 1 }} /></div>
    {!items.length ? <div className="ed-empty">Nothing here. Add folders in the Media library (Home → Media library).</div> :
      <div className="ed-grid">{items.map(a => <div key={a.id} className="ed-card" style={{ background: `url("${thumb(a.id)}") center/cover` }} onDoubleClick={() => void importPaths([a.path], true)} title={a.name}>
        {a.duration_ms ? <span className="badge">{fmtDur(a.duration_ms * 1000)}</span> : null}<div className="lbl">{a.name}</div>
        <button className="add" onClick={e => { e.stopPropagation(); void importPaths([a.path], true); }}><Plus size={14} /></button></div>)}</div>}
  </>;
}
import { convertFileSrc } from "@tauri-apps/api/core";
const thumb = (id: number) => convertFileSrc(String(id), "thumb");

function StockPanel({ kinds, providers }: { kinds: [string, string][]; providers: string[] }) {
  const [kind, setKind] = useState(kinds[0][0]);
  const [prov, setProv] = useState(providers[0]);
  const [q, setQ] = useState(""); const [items, setItems] = useState<StockItem[]>([]); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [dl, setDl] = useState<Record<string, number>>({});
  const search = async () => { if (!q.trim()) return; setBusy(true); setErr(null); try { setItems(await ed.stock(prov, kind, q)); } catch (e) { setErr(String(e)); setItems([]); } finally { setBusy(false); } };
  const get = async (it: StockItem) => {
    const ext = it.kind === "audio" ? "mp3" : it.kind === "image" ? (it.url.split("?")[0].split(".").pop() || "jpg").slice(0, 4) : "mp4";
    const job = await ed.enqueue({ type: "stock_download", url: it.url, name: `${prov}-${it.id}.${ext}` }, `Download ${prov} ${it.kind}`);
    setDl(d => ({ ...d, [it.id]: 0 }));
    watchJob(job, { progress: pr => setDl(d => ({ ...d, [it.id]: pr })), done: async out => { setDl(d => { const n = { ...d }; delete n[it.id]; return n; }); await importPaths(out, true); notify(`Added · ${it.license}${it.author ? ` · by ${it.author}` : ""}`, "ok"); }, fail: e => { setDl(d => { const n = { ...d }; delete n[it.id]; return n; }); notify(e); } });
  };
  return <>
    <div className="ed-chips">{providers.map(p => <button key={p} className={`ed-chip ${prov === p ? "on" : ""}`} onClick={() => setProv(p)}>{p[0].toUpperCase() + p.slice(1)}</button>)}
      {kinds.length > 1 && kinds.map(([k, l]) => <button key={k} className={`ed-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{l}</button>)}</div>
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}><input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} placeholder="Search free stock…" style={{ flex: 1 }} /><button className="eb solid sm" onClick={search}>{busy ? <Loader2 size={14} className="spin" /> : <Search size={14} />}</button></div>
    {err && <div className="ed-note" style={{ color: "#ff9a9a" }}>{err} <button className="eb sm solid" onClick={() => window.dispatchEvent(new Event("msp-ai-settings"))}>Add key</button></div>}
    {!items.length && !err && <div className="ed-empty">Free, royalty-free {kind === "audio" ? "audio" : "stock media"} from {prov}. Needs a free API key (Settings → AI & keys).</div>}
    <div className="ed-grid">{items.map(it => <div key={it.id} className="ed-card" style={{ background: it.thumb ? `url("${it.thumb}") center/cover` : undefined }} title={`${it.title}\n${it.license}${it.author ? ` · ${it.author}` : ""}`} onDoubleClick={() => get(it)}>
      {it.kind === "audio" && !it.thumb && <Music size={26} />}{it.duration ? <span className="badge">{fmtDur(it.duration * 1e6)}</span> : null}
      {dl[it.id] !== undefined && <div className="prog" style={{ width: `${Math.max(5, dl[it.id] * 100)}%` }} />}
      <div className="lbl">{it.title || it.author}</div><button className="add" onClick={e => { e.stopPropagation(); void get(it); }}><Download size={13} /></button></div>)}</div>
  </>;
}

// ---------------------------------------------------------------- Audio

function AudioPanel() {
  const [sub, setSub] = useState("sfx");
  return <>
    <SubNav value={sub} onChange={setSub} items={[["sfx", "Sound effects"], ["music", "Music"], ["tts", "Text to speech"], ["yours", "Your audio"], ["extract", "Extract audio"]]} />
    <div className="ed-content">
      {sub === "sfx" && <SfxPanel />}
      {sub === "music" && <StockPanel kinds={[["audio", "Music"]]} providers={["jamendo"]} />}
      {sub === "tts" && <TtsPanel />}
      {sub === "yours" && <ProjectMedia kind="audio" />}
      {sub === "extract" && <ExtractPanel />}
    </div>
  </>;
}

function SfxPanel() {
  const [list, setList] = useState<[string, string][]>([]);
  useEffect(() => { invoke<[string, string][]>("sfx_library").then(setList).catch(e => notify(String(e))); }, []);
  const play = (path: string) => { const a = new Audio(fileUrl(path)); a.crossOrigin = "anonymous"; void a.play(); };
  const add = async (path: string) => { const [mid] = await importPaths([path]); const m = useEd.getState().p!.media[mid]; addAtPlayhead(clipForMedia(m), false); };
  return <>
    <div className="ed-h">Built-in effects (royalty-free)</div>
    <div className="ed-grid" style={{ ["--cell" as any]: "96px" }}>{list.map(([name, path]) => <div key={path} className="ed-card tile" onClick={() => play(path)} onDoubleClick={() => add(path)} title="Click to preview, double-click to add">
      <Waves size={20} />{name}<button className="add" style={{ display: "flex" }} onClick={e => { e.stopPropagation(); void add(path); }}><Plus size={13} /></button></div>)}</div>
    <div className="ed-h" style={{ marginTop: 16 }}>Freesound library</div>
    <StockPanel kinds={[["audio", "Sounds"]]} providers={["freesound"]} />
  </>;
}

function TtsPanel() {
  const [text, setText] = useState("");
  const [voices, setVoices] = useState<{ id: string; name: string; installed: boolean }[]>([]);
  const [provs, setProvs] = useState<{ id: string; name: string; has_key: boolean }[]>([]);
  const [engine, setEngine] = useState("piper"); const [voice, setVoice] = useState(""); const [speed, setSpeed] = useState(1); const [busy, setBusy] = useState<number | null>(null);
  const load = () => { ed.speechVoices().then(v => { setVoices(v); if (!voice) setVoice(v.find(x => x.installed)?.id ?? v[0]?.id ?? ""); }); ed.providers().then(p => setProvs(p.filter(x => x.caps.includes("tts")))); };
  useEffect(load, []); // eslint-disable-line
  const go = async () => {
    const st = useEd.getState(); if (!st.id || !text.trim()) return;
    if (engine === "piper" && !voices.find(v => v.id === voice)?.installed) {
      notify("Downloading the voice first (one-time)…", "info");
      for (const id of ["piper", voice]) { const j = await ed.installModel(id); await new Promise<void>((res, rej) => watchJob(j, { done: () => res(), fail: e => rej(new Error(e)) })).catch(e => notify(String(e))); }
      load();
    }
    const job = await ed.enqueue({ type: "tts", provider: engine, voice: engine === "piper" ? voice : voice, text, speed, project: st.id }, "Text to speech");
    setBusy(0);
    watchJob(job, { progress: setBusy, done: async out => { setBusy(null); const [mid] = await importPaths(out); const m = useEd.getState().p!.media[mid]; addAtPlayhead({ ...clipForMedia(m), name: `Voice: ${text.slice(0, 24)}` }, false); }, fail: e => { setBusy(null); notify(`Text to speech failed: ${e}`); } });
  };
  return <>
    <textarea value={text} onChange={e => setText(e.target.value)} rows={6} placeholder="Type or paste a script — it becomes a voiceover on the timeline at the playhead." style={{ width: "100%", marginBottom: 8 }} />
    <div className="ed-row two"><span>Engine</span><select value={engine} onChange={e => { setEngine(e.target.value); setVoice(e.target.value === "piper" ? voices[0]?.id ?? "" : ""); }}>
      <option value="piper">Offline voices (free, Piper)</option>{provs.map(p => <option key={p.id} value={p.id} disabled={!p.has_key}>{p.name}{p.has_key ? "" : " (add key)"}</option>)}</select></div>
    {engine === "piper" ? <div className="ed-row two"><span>Voice</span><select value={voice} onChange={e => setVoice(e.target.value)}>{voices.map(v => <option key={v.id} value={v.id}>{v.name}{v.installed ? "" : " — downloads on first use"}</option>)}</select></div>
      : <div className="ed-row two"><span>Voice</span><input value={voice} onChange={e => setVoice(e.target.value)} placeholder={engine === "openai" ? "alloy, nova, shimmer, onyx…" : "voice id"} /></div>}
    {engine === "piper" && <div className="ed-row two"><span>Speed</span><input type="range" min={0.6} max={1.6} step={0.05} value={speed} onChange={e => setSpeed(+e.target.value)} /></div>}
    <button className="eb primary" style={{ width: "100%", marginTop: 8 }} disabled={!text.trim() || busy !== null} onClick={go}>{busy !== null ? <><Loader2 size={14} className="spin" />Generating…</> : <><Mic2 size={14} />Generate voiceover</>}</button>
  </>;
}

function ExtractPanel() {
  const p = useEd(s => s.p)!;
  const vids = Object.values(p.media).filter(m => m.kind === "video" && m.has_audio);
  return <>
    <div className="ed-note">Use the sound of a video as an audio clip (e.g. music from a clip). Or right-click a clip on the timeline → Extract audio.</div>
    <div className="ed-grid">{vids.map(m => <div key={m.id} className="ed-card tile" onDoubleClick={() => addAtPlayhead({ ...clipForMedia(m), type: "audio", name: `Audio – ${m.name}` }, false)}>
      <AudioLines size={22} />{m.name}<button className="add" style={{ display: "flex" }} onClick={() => addAtPlayhead({ ...clipForMedia(m), type: "audio", name: `Audio – ${m.name}` }, false)}><Plus size={13} /></button></div>)}</div>
    {!vids.length && <div className="ed-empty">Import a video with sound first.</div>}
  </>;
}

// ---------------------------------------------------------------- Text

function TextPanel() {
  const [sub, setSub] = useState("add");
  return <>
    <SubNav value={sub} onChange={setSub} items={[["add", "Add text"], ["templates", "Text templates"], ["captions", "Auto captions"]]} />
    <div className="ed-content">
      {sub === "add" && <>
        <div className="ed-card tile" style={{ aspectRatio: "auto", height: 70, marginBottom: 12 }} draggable onDragStart={drag({ clip: textClip("Default text", null) })} onClick={() => addAtPlayhead(textClip("Default text", null))}><Type size={20} />Default text<button className="add" style={{ display: "flex" }}><Plus size={13} /></button></div>
        <div className="ed-h">Styles</div>
        <div className="ed-grid" style={{ ["--cell" as any]: "110px" }}>{TEXT_PRESETS.slice(1).map(pr => <TextTile key={pr.id} pr={pr} />)}</div>
      </>}
      {sub === "templates" && <div className="ed-grid" style={{ ["--cell" as any]: "110px" }}>{TEXT_PRESETS.filter(x => x.animIn || x.animLoop).concat(TEXT_PRESETS.filter(x => !x.animIn && !x.animLoop).map(x => ({ ...x, animIn: "pop" }))).map(pr => <TextTile key={pr.id + "t"} pr={pr} />)}</div>}
      {sub === "captions" && <CaptionsBody />}
    </div>
  </>;
}
function TextTile({ pr }: { pr: (typeof TEXT_PRESETS)[number] }) {
  const s = pr.style; const c = textClip(pr.sample ?? "Your text", pr);
  return <div className="ed-card" draggable onDragStart={drag({ clip: c })} onClick={() => addAtPlayhead(c)} title={pr.name}
    style={{ fontFamily: s.font ? `"${s.font}"` : undefined, fontWeight: 800, fontSize: 17, color: s.gradient?.on ? s.gradient.from : s.color ?? "#fff",
      WebkitTextStroke: s.stroke?.on ? `1px ${s.stroke.color}` : undefined, textShadow: s.shadow?.on ? `0 0 ${Math.min(10, s.shadow.blur / 2)}px ${s.shadow.color}` : undefined, background: "#26262b" }}>
    <span style={{ background: s.background?.on ? s.background.color : undefined, padding: "1px 6px", borderRadius: 4, textTransform: s.caseMode === "upper" ? "uppercase" : undefined }}>Abc</span>
    <div className="lbl" style={{ fontFamily: "Segoe UI", fontWeight: 400, color: "#ddd", WebkitTextStroke: "0", textShadow: "none" }}>{pr.name}</div>
  </div>;
}

// ---------------------------------------------------------------- Stickers

function StickerPanel() {
  const [sub, setSub] = useState("Trending");
  const sets = Object.keys(EMOJI_SETS);
  const mk = (sk: Clip["sticker"]): Clip => ({ id: uid(), type: "sticker", start: 0, dur: 3 * SEC, sticker: sk, transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false }, name: sk?.emoji ?? sk?.shape ?? "Sticker", animIn: { id: "pop", dur: 400_000 } });
  const custom = async () => { const f = await pickFiles("image"); if (!f.length) return; const ids = await importPaths(f); for (const id of ids) addAtPlayhead({ ...mk({ media: id }), name: useEd.getState().p!.media[id].name }); };
  return <>
    <SubNav value={sub} onChange={setSub} items={[...sets.map(s => [s, s] as [string, string]), ["Shapes", "Shapes"], ["Custom", "Your stickers"]]} />
    <div className="ed-content">
      {sub === "Shapes" ? <div className="ed-grid" style={{ ["--cell" as any]: "70px" }}>{SHAPES.map(s => <div key={s} className="ed-card tile" draggable onDragStart={drag({ clip: mk({ shape: s, color: "#ffd23f" }) })} onClick={() => addAtPlayhead(mk({ shape: s, color: "#ffd23f" }))}><ShapeIcon shape={s} />{s}</div>)}</div>
        : sub === "Custom" ? <div className="ed-import" onClick={custom}><Upload size={22} />Use your own PNG / GIF / WebP as a sticker</div>
        : <div className="ed-grid" style={{ ["--cell" as any]: "52px" }}>{[...new Intl.Segmenter().segment(EMOJI_SETS[sub])].map(x => x.segment).filter(x => x.trim()).map((em, i) =>
          <div key={i} className="ed-card tile" style={{ fontSize: 28, padding: 0 }} draggable onDragStart={drag({ clip: mk({ emoji: em }) })} onClick={() => addAtPlayhead(mk({ emoji: em }))}>{em}</div>)}</div>}
    </div>
  </>;
}
function ShapeIcon({ shape }: { shape: string }) {
  const [u, setU] = useState("");
  useEffect(() => { void import("../engine/text").then(async t => { const r = t.renderSticker({ shape, color: "#ffd23f" }, 96); const b = await r.canvas.convertToBlob(); setU(URL.createObjectURL(b)); }); }, [shape]);
  return u ? <img src={u} width={34} height={34} alt="" /> : null;
}

// ---------------------------------------------------------------- Effects / Transitions / Filters / Adjust

function EffectsPanel() {
  const [cat, setCat] = useState(EFFECT_CATS[0]);
  const apply = (id: string) => {
    const f = selClip();
    if (f && (f.clip.type === "video" || f.clip.type === "image")) { useEd.getState().commit(p => updateClip(p, f.clip.id, c => ({ effects: [...(c.effects ?? []), { id }] }))); notify(`Added ${EFFECTS.find(e => e.id === id)?.name} to the selected clip`, "ok"); return; }
    addAtPlayhead({ id: "", type: "effect", start: 0, dur: 3 * SEC, effect: { id }, name: EFFECTS.find(e => e.id === id)?.name });
  };
  return <>
    <SubNav value={cat} onChange={setCat} items={EFFECT_CATS.map(c => [c, c])} />
    <div className="ed-content">
      <div className="ed-note">Click to add as an effect clip (applies to everything below it) — or select a clip first to apply it to that clip only.</div>
      <div className="ed-grid" style={{ ["--cell" as any]: "92px" }}>{EFFECTS.filter(e => e.cat === cat).map(e => <div key={e.id} className="ed-card tile" draggable onDragStart={drag({ clip: { id: "", type: "effect", start: 0, dur: 3 * SEC, effect: { id: e.id }, name: e.name } })} onClick={() => apply(e.id)}>
        <EffectThumb id={e.id} />{e.name}</div>)}</div>
    </div>
  </>;
}
function EffectThumb({ id }: { id: string }) { const u = useFxThumb("fx", id); return u ? <img src={u} style={{ width: "100%", borderRadius: 6, aspectRatio: "16/10", objectFit: "cover" }} alt="" /> : <Wand2 size={20} />; }
function useFxThumb(kind: "fx" | "flt", id: string) {
  const [u, setU] = useState<string | null>(thumbCache.get(kind + id) ?? null);
  useEffect(() => { if (u) return; let ok = true; void previewComp().thumb(kind, id).then(x => { if (x && ok) { thumbCache.set(kind + id, x); setU(x); } }); return () => { ok = false; }; }, [id, kind, u]);
  return u;
}
const thumbCache = new Map<string, string>();

function TransitionsPanel() {
  const [cat, setCat] = useState("Featured");
  const list = cat === "Featured" ? FEATURED.map(id => TRANSITIONS.find(t => t.id === id)!).filter(Boolean) : TRANSITIONS.filter(t => t.cat === cat);
  const apply = (id: string) => {
    const st = useEd.getState(), p = st.p!;
    const f = selClip();
    let target = f && nextAdjacent(f.track, f.clip) ? f : null;
    if (!target) { // the cut nearest the playhead on the main track
      const m = mainTrack(p); const c = [...m.clips].filter(x => nextAdjacent(m, x)).sort((a, b) => Math.abs(end(a) - st.t) - Math.abs(end(b) - st.t))[0];
      if (c) target = { track: m, clip: c, ti: 0, ci: 0 };
    }
    if (!target) return notify("Transitions go between two clips that touch on the same track. Add at least two clips to the main track.", "info");
    const n = nextAdjacent(target.track, target.clip)!;
    st.commit(pp => updateClip(pp, target!.clip.id, { transition: { id, dur: Math.min(target!.clip.transition?.dur ?? 500_000, target!.clip.dur, n.dur) } }));
    st.select([target.clip.id]); st.seek(end(target.clip) - 400_000);
    notify(`Transition: ${TRANSITIONS.find(t => t.id === id)?.name}`, "ok");
  };
  return <>
    <SubNav value={cat} onChange={setCat} items={[["Featured", "Featured"], ...TRANSITION_CATS.map(c => [c, c] as [string, string])]} />
    <div className="ed-content">
      <div className="ed-note">Click to apply to the selected cut (or the cut nearest the playhead). Drag onto a cut to place it. {TRANSITIONS.length} transitions.</div>
      <div className="ed-grid" style={{ ["--cell" as any]: "92px" }}>{list.map(t => <div key={t.id} className="ed-card tile" draggable onDragStart={drag({ transition: t.id })} onClick={() => apply(t.id)} title={`${t.name} — ${t.author} (${t.license})`}>
        <TransThumb id={t.id} />{t.name}</div>)}</div>
    </div>
  </>;
}
function TransThumb({ id }: { id: string }) {
  const [u, setU] = useState<string | null>(thumbCache.get("tr" + id) ?? null);
  useEffect(() => { if (u) return; let ok = true; void previewComp().thumb("tr", id).then(x => { if (x && ok) { thumbCache.set("tr" + id, x); setU(x); } }); return () => { ok = false; }; }, [id, u]);
  return u ? <img src={u} style={{ width: "100%", borderRadius: 6, aspectRatio: "16/10", objectFit: "cover" }} alt="" /> : <Clapperboard size={20} />;
}

function FiltersPanel() {
  const [cat, setCat] = useState(FILTER_CATS[0]);
  const apply = (id: string) => {
    const f = selClip();
    if (f && (f.clip.type === "video" || f.clip.type === "image")) { useEd.getState().commit(p => updateClip(p, f.clip.id, { filter: { id, amount: f.clip.filter?.amount ?? 100 } })); return; }
    addAtPlayhead({ id: "", type: "filter", start: 0, dur: 5 * SEC, filter: { id, amount: 100 }, name: FILTERS.find(x => x.id === id)?.name });
  };
  const importCube = async () => {
    const f = await open({ filters: [{ name: "3D LUT", extensions: ["cube"] }] }); if (typeof f !== "string") return;
    try {
      const data = parseCube(await ed.readText(f)); const id = `cube:${f}`;
      previewComp().addLut(id, data);
      if (!FILTERS.some(x => x.id === id)) FILTERS.push({ id, name: f.split(/[\\/]/).pop()!.replace(/\.cube$/i, ""), cat: "Featured", ops: [], swatch: "#888" });
      apply(id); notify("LUT imported", "ok");
    } catch (e) { notify(String(e)); }
  };
  return <>
    <SubNav value={cat} onChange={setCat} items={FILTER_CATS.map(c => [c, c])} />
    <div className="ed-content">
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}><div className="ed-note" style={{ flex: 1, margin: 0 }}>Select a clip to filter just that clip, or add a filter clip that colours everything below it.</div><button className="eb sm solid" onClick={importCube}><FolderOpen size={14} />Import .cube</button></div>
      <div className="ed-grid" style={{ ["--cell" as any]: "86px" }}>{FILTERS.filter(f => f.cat === cat).map(f => <div key={f.id} className="ed-card tile" draggable onDragStart={drag({ clip: { id: "", type: "filter", start: 0, dur: 5 * SEC, filter: { id: f.id, amount: 100 }, name: f.name } })} onClick={() => apply(f.id)}>
        <FilterThumb id={f.id} swatch={f.swatch} />{f.name}</div>)}</div>
    </div>
  </>;
}
function FilterThumb({ id, swatch }: { id: string; swatch: string }) { const u = useFxThumb("flt", id); return u ? <img src={u} style={{ width: "100%", borderRadius: 6, aspectRatio: "16/10", objectFit: "cover" }} alt="" /> : <div style={{ width: "100%", aspectRatio: "16/10", borderRadius: 6, background: swatch }} />; }

function AdjustPanel() {
  return <div className="ed-content">
    <div className="ed-card tile" style={{ aspectRatio: "auto", height: 80 }} onClick={() => addAtPlayhead({ id: "", type: "adjust", start: 0, dur: 5 * SEC, adjust: {}, name: "Adjustment" })} draggable onDragStart={drag({ clip: { id: "", type: "adjust", start: 0, dur: 5 * SEC, adjust: {}, name: "Adjustment" } })}>
      <SlidersHorizontal size={20} />Add adjustment layer</div>
    <div className="ed-note" style={{ marginTop: 10 }}>An adjustment layer colour-corrects everything below it for its duration — exposure, contrast, saturation, temperature, HSL-style hue, sharpen, vignette, grain and more. To adjust a single clip, select it and use the Adjust tab on the right.</div>
  </div>;
}

// ---------------------------------------------------------------- Captions

function CaptionsPanel() { return <><SubNav value="auto" onChange={() => {}} items={[["auto", "Captions"]]} /><div className="ed-content"><CaptionsBody /></div></>; }

const LANGS: [string, string][] = [["auto", "Detect automatically"], ["en", "English"], ["fr", "French"], ["es", "Spanish"], ["pt", "Portuguese"], ["de", "German"], ["it", "Italian"], ["nl", "Dutch"], ["ar", "Arabic"], ["hi", "Hindi"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["ru", "Russian"], ["tr", "Turkish"], ["yo", "Yoruba"], ["ha", "Hausa"], ["sw", "Swahili"], ["pl", "Polish"], ["id", "Indonesian"]];
function CaptionsBody() {
  const [lang, setLang] = useState("auto"); const [model, setModel] = useState(""); const [style, setStyle] = useState(CAPTION_STYLES[0].id);
  const [prog, setProg] = useState<{ p: number; label: string } | null>(null); const [replace, setReplace] = useState(true); const [translate, setTranslate] = useState(false);
  const [models, setModels] = useState<{ id: string; name: string; installed: boolean; mb: number }[]>([]);
  const [provs, setProvs] = useState<{ id: string; name: string; has_key: boolean; caps: string[] }[]>([]); const [tprov, setTprov] = useState(""); const [tlang, setTlang] = useState("French");
  const load = () => { ed.models().then(m => setModels(m.filter(x => x.group === "captions"))); ed.providers().then(p => { const c = p.filter(x => x.caps.includes("chat")); setProvs(c); setTprov(c.find(x => x.has_key)?.id ?? c[0]?.id ?? ""); }); };
  useEffect(load, []);
  const engineOk = models.some(m => (m.id === "whisper-cpu" || m.id === "whisper-cuda") && m.installed);
  const modelOk = models.some(m => m.id.startsWith("whisper-") && !m.id.includes("cpu") && !m.id.includes("cuda") && m.installed);
  const install = async (ids: string[]) => {
    for (const id of ids) { setProg({ p: 0, label: `Downloading ${models.find(m => m.id === id)?.name}…` }); const j = await ed.installModel(id);
      await new Promise<void>((res, rej) => watchJob(j, { progress: p => setProg({ p, label: `Downloading ${models.find(m => m.id === id)?.name}… ${Math.round(p * 100)}%` }), done: () => res(), fail: e => rej(new Error(e)) })); }
    setProg(null); load();
  };
  const run = async () => {
    try {
      if (!engineOk || !modelOk) await install([...(!engineOk ? ["whisper-cpu"] : []), ...(!modelOk ? ["whisper-base"] : [])]);
      const n = await autoCaptions({ language: lang, model, translate, style: CAPTION_STYLES.find(s => s.id === style)!, replace, onProgress: (p, label) => setProg({ p, label }) });
      setProg(null); notify(`Added ${n} captions`, "ok");
    } catch (e) { setProg(null); notify(`Captions failed: ${e instanceof Error ? e.message : e}`); }
  };
  const p = useEd(s => s.p)!;
  const exportSubs = async (fmt: "srt" | "vtt" | "txt") => { const { save } = await import("@tauri-apps/plugin-dialog"); const f = await save({ defaultPath: `${p.name}.${fmt}`, filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }] }); if (!f) return; await ed.saveTextAs(f, fmt === "srt" ? toSrt(p) : fmt === "vtt" ? toVtt(p) : toTxt(p)); notify("Subtitles saved", "ok"); };
  const importSubs = async () => { const f = await open({ filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }] }); if (typeof f !== "string") return; const segs = parseSubs(await ed.readText(f)); if (!segs.length) return notify("No subtitles found in that file"); useEd.getState().commit(pp => placeCaptions(pp, subsToClips(segs, CAPTION_STYLES.find(s => s.id === "classic")!, 0.36), false)); notify(`Imported ${segs.length} subtitles`, "ok"); };
  return <>
    <div className="ed-h"><Captions size={14} />Auto captions</div>
    <div className="ed-row two"><span>Language</span><select value={lang} onChange={e => setLang(e.target.value)}>{LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
    <div className="ed-row two"><span>Accuracy</span><select value={model} onChange={e => setModel(e.target.value)}><option value="">Best installed</option>{models.filter(m => !m.id.includes("cpu") && !m.id.includes("cuda")).map(m => <option key={m.id} value={m.id}>{m.name}{m.installed ? "" : ` (${Math.round(m.mb)} MB download)`}</option>)}</select></div>
    <label className="ed-row two"><span>To English</span><input type="checkbox" checked={translate} onChange={e => setTranslate(e.target.checked)} /></label>
    <label className="ed-row two"><span>Replace old</span><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} /></label>
    <div className="ed-h">Style</div>
    <div className="ed-tiles" style={{ marginBottom: 10 }}>{CAPTION_STYLES.map(s => <button key={s.id} className={style === s.id ? "on" : ""} style={{ fontFamily: s.style.font, fontWeight: 800, color: s.style.highlight && s.style.highlightMode !== "none" ? s.style.highlight : undefined }} onClick={() => setStyle(s.id)}>{s.name}</button>)}</div>
    {prog ? <div><div className="ed-bar"><div style={{ width: `${prog.p * 100}%` }} /></div><div className="ed-note">{prog.label}</div></div>
      : <button className="eb primary" style={{ width: "100%" }} onClick={run}><Captions size={14} />Generate captions</button>}
    {!engineOk && <div className="ed-note">First use downloads the free Whisper engine (8 MB) and Base model (141 MB). For best accuracy install Large-v3 Turbo + the NVIDIA engine in Settings → AI models.</div>}
    <div className="ed-h" style={{ marginTop: 16 }}>Subtitles file</div>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button className="eb sm solid" onClick={importSubs}>Import SRT/VTT</button><button className="eb sm solid" onClick={() => exportSubs("srt")}>Export SRT</button><button className="eb sm solid" onClick={() => exportSubs("vtt")}>VTT</button><button className="eb sm solid" onClick={() => exportSubs("txt")}>Transcript</button>
      <button className="eb sm solid" onClick={() => addAtPlayhead({ ...textClip("Caption", null), type: "caption", text: { ...textClip("Caption", null).text!, ...CAPTION_STYLES.find(s => s.id === style)!.style, text: "Caption" }, transform: { x: 0, y: 0.32, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false } })}>Add manual caption</button></div>
    <div className="ed-h" style={{ marginTop: 16 }}>Translate captions</div>
    <div className="ed-row two"><span>Into</span><input value={tlang} onChange={e => setTlang(e.target.value)} /></div>
    <div className="ed-row two"><span>Using</span><select value={tprov} onChange={e => setTprov(e.target.value)}>{provs.map(pv => <option key={pv.id} value={pv.id}>{pv.name}{pv.has_key ? "" : " (add key)"}</option>)}</select></div>
    <button className="eb sm solid" onClick={async () => { setProg({ p: 0.3, label: "Translating…" }); try { const n = await translateCaptions(tprov, tlang); notify(`Translated ${n} captions`, "ok"); } catch (e) { notify(String(e)); } finally { setProg(null); } }}>Translate</button>
  </>;
}

// ---------------------------------------------------------------- Templates

function TemplatesPanel() {
  const use = (id: string) => {
    const tpl = TEMPLATES.find(t => t.id === id)!; const st = useEd.getState(); const p = st.p!;
    const tp = tpl.build();
    const empty = !p.tracks.some(t => t.clips.length);
    st.commit(pp => empty ? { ...tp, id: pp.id, name: pp.name, media: pp.media } : { ...pp, tracks: [...tp.tracks.filter(t => !t.main).map(t => ({ ...t, id: uid("t") })), ...pp.tracks] });
    notify(empty ? `Template “${tpl.name}” applied — replace the placeholder colour with your media.` : `Added template layers from “${tpl.name}”.`, "ok");
  };
  return <div className="ed-content">
    <div className="ed-grid" style={{ ["--cell" as any]: "150px" }}>{TEMPLATES.map(t => <div key={t.id} className="ed-card" style={{ aspectRatio: "auto", minHeight: 110, flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", padding: 10, gap: 6 }} onClick={() => use(t.id)}>
      <b>{t.name}</b><span className="ed-pill">{t.ratio}</span><span style={{ color: "var(--e-dim)", fontSize: 11 }}>{t.desc}</span></div>)}</div>
  </div>;
}

// ---------------------------------------------------------------- AI

function AiPanel() {
  const [sub, setSub] = useState("tools");
  return <>
    <SubNav value={sub} onChange={setSub} items={[["tools", "AI tools"], ["image", "AI image"], ["video", "AI video"], ["script", "AI script"]]} />
    <div className="ed-content">
      {sub === "tools" && <AiTools go={setSub} />}
      {sub === "image" && <AiGen kind="image" />}
      {sub === "video" && <AiGen kind="video" />}
      {sub === "script" && <AiScript />}
    </div>
  </>;
}

function AiTools({ go }: { go: (s: string) => void }) {
  const st = useEd();
  const tool = (icon: ReactNode, title: string, desc: string, run: () => void) => <div className="ed-card" style={{ aspectRatio: "auto", flexDirection: "column", alignItems: "flex-start", padding: 12, gap: 6, minHeight: 92 }} onClick={run}>{icon}<b>{title}</b><span style={{ color: "var(--e-dim)", fontSize: 11 }}>{desc}</span></div>;
  const sel = () => { const f = selClip(); if (!f || !f.clip.media) { notify("Select a video or photo clip first", "info"); return null; } return f; };
  return <div className="ed-grid" style={{ ["--cell" as any]: "160px" }}>
    {tool(<Captions size={20} color="#22d3ee" />, "Auto captions", "Speech → animated captions (free, offline)", () => st.setLeft("captions"))}
    {tool(<Scissors size={20} color="#f6b73c" />, "Remove background", "Cut out people or objects — no green screen", () => { const f = sel(); if (f) { st.commit(p => updateClip(p, f.clip.id, { cutout: true })); void ensureMatte(f.clip.media!); window.dispatchEvent(new CustomEvent("msp-inspector", { detail: "cutout" })); } })}
    {tool(<Mic2 size={20} color="#5be3a0" />, "Text to speech", "Natural voiceovers from a script", () => { st.setLeft("audio"); })}
    {tool(<Waves size={20} color="#a78bfa" />, "Remove silences", "Auto-cut pauses on the main track", async () => { try { await removeSilences(); } catch (e) { notify(String(e)); } })}
    {tool(<AudioLines size={20} color="#ff8fab" />, "Reduce noise", "Clean voice for the selected clip", () => { const f = selClip(); if (!f || !f.clip.media) return notify("Select a clip with audio", "info"); st.commit(p => updateClip(p, f.clip.id, { fx: { voice: f.clip.fx?.voice ?? "", denoise: true, normalize: true, enhance: true } })); void import("../store").then(s => s.ensureAudioFx(f.clip.media!, { voice: f.clip.fx?.voice ?? "", denoise: true, normalize: true, enhance: true })); notify("Cleaning audio in the background…", "info"); })}
    {tool(<ImageIcon size={20} color="#60a5fa" />, "AI image", "Generate images (OpenAI, Gemini, Flux…)", () => go("image"))}
    {tool(<Film size={20} color="#f472b6" />, "AI video", "Text/image → video (Kling, Veo, Sora…)", () => go("video"))}
    {tool(<Type size={20} color="#34d399" />, "AI script", "Write a video script with any AI model", () => go("script"))}
    {tool(<Sparkles size={20} color="#fbbf24" />, "AI upscale", "Sharpen low-res clips 2–4× (Enhance workspace)", () => window.dispatchEvent(new Event("msp-open-enhance")))}
  </div>;
}

function AiGen({ kind }: { kind: "image" | "video" }) {
  const [provs, setProvs] = useState<{ id: string; name: string; has_key: boolean; caps: string[]; key_url: string; note: string }[]>([]);
  const [prov, setProv] = useState(""); const [prompt, setPrompt] = useState(""); const [aspect, setAspect] = useState("16:9"); const [secs, setSecs] = useState(5); const [img, setImg] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ p: number; label: string } | null>(null);
  useEffect(() => { ed.providers().then(p => { const l = p.filter(x => x.caps.includes(kind)); setProvs(l); setProv(l.find(x => x.has_key)?.id ?? l[0]?.id ?? ""); }); const r = useEd.getState().p!.ratio; setAspect(["9:16", "1:1"].includes(r) ? r : "16:9"); }, [kind]);
  const cur = provs.find(p => p.id === prov);
  const go = async () => {
    const st = useEd.getState(); if (!st.id || !prompt.trim()) return;
    const spec = kind === "image" ? { type: "ai_image", provider: prov, prompt, aspect, project: st.id } : { type: "ai_video", provider: prov, prompt, aspect, seconds: secs, image: img, project: st.id };
    const job = await ed.enqueue(spec, `AI ${kind}: ${prompt.slice(0, 40)}`);
    setBusy({ p: 0, label: "Sending to " + cur?.name });
    watchJob(job, { progress: p => setBusy({ p, label: `${cur?.name} is generating… (${kind === "video" ? "videos can take a few minutes" : "usually under a minute"})` }), done: async out => { setBusy(null); await importPaths(out, true); notify(`AI ${kind} added to the timeline`, "ok"); }, fail: e => { setBusy(null); notify(`AI ${kind} failed: ${e}`); } });
  };
  return <>
    <div className="ed-row two"><span>Provider</span><select value={prov} onChange={e => setProv(e.target.value)}>{provs.map(p => <option key={p.id} value={p.id}>{p.name}{p.has_key ? "" : " — add key"}</option>)}</select></div>
    {cur && !cur.has_key && <div className="ed-note">Add your {cur.name} key in <a href="#" onClick={e => { e.preventDefault(); window.dispatchEvent(new Event("msp-ai-settings")); }}>Settings → AI & keys</a>. {cur.note}</div>}
    <textarea rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={kind === "image" ? "A neon-lit street in Lagos at night, cinematic, rain reflections…" : "Slow dolly shot of a frog prince on a lily pad at sunrise, magical, 4k…"} style={{ width: "100%", margin: "6px 0" }} />
    <div className="ed-row two"><span>Aspect</span><select value={aspect} onChange={e => setAspect(e.target.value)}>{["16:9", "9:16", "1:1"].map(a => <option key={a}>{a}</option>)}</select></div>
    {kind === "video" && <><div className="ed-row two"><span>Length</span><select value={secs} onChange={e => setSecs(+e.target.value)}>{[4, 5, 8, 10, 12].map(s => <option key={s} value={s}>{s} s</option>)}</select></div>
      <div className="ed-row two"><span>Start image</span><div style={{ display: "flex", gap: 6, alignItems: "center" }}><button className="eb sm solid" onClick={async () => { const f = await pickFiles("image"); setImg(f[0] ?? null); }}>{img ? "Change" : "Optional…"}</button><span className="ed-note" style={{ margin: 0 }}>{img?.split(/[\\/]/).pop()}</span></div></div></>}
    {busy ? <div><div className="ed-bar"><div style={{ width: `${Math.max(5, busy.p * 100)}%` }} /></div><div className="ed-note">{busy.label}</div></div>
      : <button className="eb primary" style={{ width: "100%", marginTop: 8 }} disabled={!prompt.trim() || !cur?.has_key} onClick={go}><Sparkles size={14} />Generate {kind}</button>}
    <div className="ed-note">Generation runs on the provider's servers with your key and is billed by them. Results are saved in the project folder.</div>
  </>;
}

function AiScript() {
  const [provs, setProvs] = useState<{ id: string; name: string; has_key: boolean }[]>([]);
  const [prov, setProv] = useState(""); const [topic, setTopic] = useState(""); const [out, setOut] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { ed.providers().then(p => { const l = p.filter(x => (x as any).caps.includes("chat")); setProvs(l); setProv(l.find(x => x.has_key)?.id ?? "ollama"); }); }, []);
  const gen = async () => { setBusy(true); try { setOut(await ed.chat(prov, "You write short, punchy video scripts for social media. Output only the narration lines, one sentence per line, no headings, no stage directions.", `Write a 30-60 second video script about: ${topic}`)); } catch (e) { notify(String(e)); } finally { setBusy(false); } };
  const toText = () => {
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean); if (!lines.length) return;
    let t = useEd.getState().t;
    const clips = lines.map(l => { const dur = Math.max(1.5 * SEC, Math.min(6 * SEC, l.split(/\s+/).length * 380_000)); const c = { ...textClip(l, TEXT_PRESETS.find(x => x.id === "subtitle")!), start: t, dur, type: "caption" as const, transform: { x: 0, y: 0.32, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false } }; t += dur; return c; });
    useEd.getState().commit(p => placeCaptions(p, clips, false));
  };
  return <>
    <div className="ed-row two"><span>Model</span><select value={prov} onChange={e => setProv(e.target.value)}>{provs.map(p => <option key={p.id} value={p.id}>{p.name}{p.has_key ? "" : " — add key"}</option>)}</select></div>
    <textarea rows={3} value={topic} onChange={e => setTopic(e.target.value)} placeholder="Topic, e.g. “3 tips to grow on TikTok”" style={{ width: "100%", margin: "6px 0" }} />
    <button className="eb primary" style={{ width: "100%" }} disabled={!topic.trim() || busy} onClick={gen}>{busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}Write script</button>
    {out && <>
      <textarea rows={10} value={out} onChange={e => setOut(e.target.value)} style={{ width: "100%", marginTop: 10 }} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button className="eb sm solid" onClick={toText}>Add as captions</button><button className="eb sm solid" onClick={() => { navigator.clipboard.writeText(out); useEd.getState().setLeft("audio"); notify("Script copied — paste it into Text to speech", "info"); }}>Make voiceover</button></div>
    </>}
    <div className="ed-note">Free option: install Ollama (ollama.com) and pick “Ollama (local, free)”.</div>
  </>;
}
