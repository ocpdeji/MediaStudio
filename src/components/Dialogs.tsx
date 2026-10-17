import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as I from "lucide-react";
import { api, Asset, defaultPreset, errText, fileUrl, Preset, PRESETS, Proposal, QuickEdit, Rect, RenameSpec, thumbUrl } from "../lib/api";
import { useStore } from "../lib/store";
import { clamp, fmtDur, fmtSize, stem, timecode } from "../lib/format";
import { commands } from "../lib/actions";
import { Dialog, Slider } from "./ui";
import { Scrub } from "./Viewer";
import { mkCanvas, toBlob } from "../lib/imageproc";

const st = () => useStore.getState();
const pick = (ids: number[] | undefined) => { const s = new Set(ids ?? []); return st().assets.filter(a => s.has(a.id)); };

// ---------------------------------------------------------------- shared bits
export function OutDir({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (<div className="row">
    <select className="input grow" value={value ? "c" : "s"} onChange={async e => { if (e.target.value === "s") onChange(null); else { const d = await openDialog({ directory: true, title: "Output folder" }); if (d && !Array.isArray(d)) onChange(d); } }}>
      <option value="s">Same folder as the source</option><option value="c">{value ?? "Choose a folder…"}</option></select>
    <button className="btn" onClick={async () => { const d = await openDialog({ directory: true, title: "Output folder" }); if (d && !Array.isArray(d)) onChange(d); }}><I.FolderOpen size={14} /></button>
  </div>);
}

export function PresetPicker({ value, onChange, allowCopy }: { value: Preset; onChange: (p: Preset) => void; allowCopy?: boolean }) {
  const [key, setKey] = useState("source");
  const [adv, setAdv] = useState(false);
  const set = (p: Partial<Preset>) => onChange({ ...value, ...p });
  return (<>
    <div className="field"><label>Preset</label>
      <select className="input" value={key} onChange={e => { setKey(e.target.value); onChange(defaultPreset({ ...PRESETS[e.target.value].p, hw: value.hw })); }}>
        {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label} — {p.hint}</option>)}</select></div>
    <div className="field"><label>Encoder</label><div className="row">
      <select className="input" value={value.hw} onChange={e => set({ hw: e.target.value })} title="GPU encoders are faster; CPU encoders compress better">
        <option value="auto">Auto (GPU if available)</option><option value="none">CPU only (best compression)</option><option value="nvenc">NVIDIA NVENC</option><option value="qsv">Intel Quick Sync</option><option value="amf">AMD AMF</option></select>
      <button className={`btn sm ${adv ? "on" : ""}`} onClick={() => setAdv(!adv)}>Advanced</button></div></div>
    {adv && <>
      <div className="field"><label>Video codec</label><select className="input" value={value.vcodec} onChange={e => set({ vcodec: e.target.value })}>
        <option value="h264">H.264</option><option value="hevc">H.265 / HEVC</option><option value="av1">AV1</option><option value="vp9">VP9</option><option value="prores">ProRes 422 HQ</option>{allowCopy && <option value="copy">Copy (no re-encode)</option>}</select></div>
      <div className="field"><label>Container</label><select className="input" value={value.container} onChange={e => set({ container: e.target.value })}><option value="mp4">MP4</option><option value="mov">MOV</option><option value="mkv">MKV</option><option value="webm">WebM</option></select></div>
      <div className="field"><label>Quality</label><div className="row"><select className="input" value={value.bitrate_kbps ? "b" : "q"} onChange={e => set({ bitrate_kbps: e.target.value === "b" ? 8000 : null })}><option value="q">Constant quality</option><option value="b">Target bitrate</option></select>
        {value.bitrate_kbps ? <><input className="input num-in" type="number" value={value.bitrate_kbps} onChange={e => set({ bitrate_kbps: +e.target.value })} /> kbps</> : <><input type="range" min={14} max={36} value={value.crf} onChange={e => set({ crf: +e.target.value })} /><span className="num dim">CRF {value.crf} {value.crf <= 18 ? "(near-lossless)" : value.crf >= 28 ? "(small)" : ""}</span></>}</div></div>
      <div className="field"><label>Size</label><div className="row"><input className="input num-in" type="number" placeholder="width" value={value.width ?? ""} onChange={e => set({ width: e.target.value ? +e.target.value : null })} />×<input className="input num-in" type="number" placeholder="height" value={value.height ?? ""} onChange={e => set({ height: e.target.value ? +e.target.value : null })} />
        <select className="input" value={value.fit} onChange={e => set({ fit: e.target.value })}><option value="contain">Fit (letterbox / pillarbox)</option><option value="cover">Fill (crop edges)</option><option value="stretch">Stretch</option></select></div></div>
      <div className="field"><label>Frame rate</label><select className="input" value={value.fps_num ? `${value.fps_num}/${value.fps_den}` : ""} onChange={e => { const [n, d] = e.target.value.split("/").map(Number); set(e.target.value ? { fps_num: n, fps_den: d } : { fps_num: null, fps_den: null }); }}>
        <option value="">Same as source</option>{["24000/1001", "24/1", "25/1", "30000/1001", "30/1", "50/1", "60000/1001", "60/1"].map(f => <option key={f} value={f}>{(+f.split("/")[0] / +f.split("/")[1]).toFixed(3).replace(/\.?0+$/, "")} fps</option>)}</select></div>
      <div className="field"><label>Audio</label><div className="row"><select className="input" value={value.acodec} onChange={e => set({ acodec: e.target.value })}><option value="aac">AAC</option><option value="opus">Opus</option><option value="mp3">MP3</option><option value="pcm">PCM (WAV)</option><option value="copy">Copy</option><option value="none">No audio</option></select>
        <select className="input" value={value.abitrate_kbps} onChange={e => set({ abitrate_kbps: +e.target.value })}>{[96, 128, 160, 192, 256, 320].map(b => <option key={b} value={b}>{b} kbps</option>)}</select></div></div>
      <div className="field"><label>Privacy</label><label className="check"><input type="checkbox" checked={value.strip_metadata} onChange={e => set({ strip_metadata: e.target.checked })} /> Strip metadata (GPS, device, dates) from the output</label></div>
    </>}
  </>);
}

const ext = (p: Preset) => (p.container === "webm" ? "webm" : p.container === "mov" ? "mov" : p.container === "mkv" ? "mkv" : "mp4");
async function enqueue(spec: Parameters<typeof api.enqueue>[0], title: string, close: () => void) {
  try { await api.enqueue(spec, title); st().toast("Added to the job queue — you can keep working.", "ok", { label: "Show jobs", run: () => st().setDialog({ kind: "jobs" }) }); close(); }
  catch (e) { st().toast(errText(e), "error"); }
}

// ---------------------------------------------------------------- rename
export function RenameDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const single = ids.length === 1;
  const first = pick(ids)[0];
  const [spec, setSpec] = useState<RenameSpec>({ pattern: single && first ? stem(first.name) : "{name}", find: "", replace: "", start: 1, pad: 2, case: "", spaces: "", prefix: "", suffix: "" });
  const [rows, setRows] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setTimeout(() => api.renamePreview(ids, spec).then(setRows).catch(e => st().toast(errText(e), "error")), 120); return () => clearTimeout(t); }, [spec, ids]);
  const bad = rows.filter(r => r.error).length, changed = rows.filter(r => r.new_name !== r.old_name).length;
  const set = (p: Partial<RenameSpec>) => setSpec({ ...spec, ...p });
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.renameApply(rows.filter(x => x.new_name !== x.old_name).map(x => [x.id, x.new_name]));
      st().toast(`Renamed ${r.renamed} file(s)${r.errors.length ? ` — ${r.errors.length} failed:\n${r.errors.slice(0, 3).join("\n")}` : ""}`, r.errors.length ? "error" : "ok",
        { label: "Undo", run: () => api.renameUndo(r.batch).then(() => { st().toast("Rename undone", "ok"); st().refresh(); }).catch(e => st().toast(errText(e), "error")) });
      await st().refresh(); onClose();
    } catch (e) { st().toast(errText(e), "error"); } finally { setBusy(false); }
  };
  return (
    <Dialog title={single ? "Rename file" : `Batch rename ${ids.length} files`} icon={<I.TextCursorInput size={18} />} size="wide" onClose={onClose}
      footer={<><span className="dim grow">{bad ? <span style={{ color: "var(--bad)" }}>{bad} conflict(s) — fix them to continue</span> : `${changed} of ${rows.length} will change · extensions are kept`}</span>
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!!bad || !changed || busy} onClick={apply}>{busy ? "Renaming…" : "Rename"}</button></>}>
      <div className="field"><label>Name pattern</label><input className="input" autoFocus value={spec.pattern} onChange={e => set({ pattern: e.target.value })} spellCheck={false} onKeyDown={e => { if (e.key === "Enter" && !bad && changed) apply(); }} /></div>
      <div className="field"><label /><div className="hint">Tokens: <code>{"{name}"}</code> original name · <code>{"{n}"}</code> counter · <code>{"{date}"}</code> capture/modified date · <code>{"{folder}"}</code> · <code>{"{w}"}</code>×<code>{"{h}"}</code> · <code>{"{ext}"}</code></div></div>
      <div className="field"><label>Prefix / suffix</label><div className="row"><input className="input grow" placeholder="prefix" value={spec.prefix} onChange={e => set({ prefix: e.target.value })} /><input className="input grow" placeholder="suffix" value={spec.suffix} onChange={e => set({ suffix: e.target.value })} /></div></div>
      <div className="field"><label>Find / replace</label><div className="row"><input className="input grow" placeholder="find" value={spec.find} onChange={e => set({ find: e.target.value })} /><input className="input grow" placeholder="replace with" value={spec.replace} onChange={e => set({ replace: e.target.value })} /></div></div>
      <div className="field"><label>Numbering</label><div className="row">start <input className="input num-in" type="number" value={spec.start} onChange={e => set({ start: +e.target.value })} /> digits <input className="input num-in" type="number" min={1} max={8} value={spec.pad} onChange={e => set({ pad: +e.target.value })} />
        <select className="input" value={spec.case} onChange={e => set({ case: e.target.value })}><option value="">Keep case</option><option value="lower">lower case</option><option value="upper">UPPER CASE</option><option value="title">Title Case</option></select>
        <select className="input" value={spec.spaces} onChange={e => set({ spaces: e.target.value })}><option value="">Keep spaces</option><option value="_">Spaces → _</option><option value="-">Spaces → -</option><option value="none">Remove spaces</option></select></div></div>
      <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid var(--line)", borderRadius: 6 }}>
        <table className="table"><thead><tr><th>Current name</th><th /><th>New name</th></tr></thead><tbody>
          {rows.map(r => <tr key={r.id} className={r.error ? "bad" : r.new_name === r.old_name ? "same" : ""}><td>{r.old_name}</td><td>→</td><td>{r.new_name}{r.error && <b> — {r.error}</b>}</td></tr>)}</tbody></table></div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- quick video tools (trim · crop · remove logo · speed · export)
export function QuickDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const items = pick(ids).filter(a => a.kind === "video" || a.kind === "audio");
  const [idx, setIdx] = useState(0);
  const a = items[idx];
  const v = useRef<HTMLVideoElement>(null), stage = useRef<HTMLDivElement>(null);
  const dur = (a?.duration_ms ?? 0) / 1000;
  const [t, setT] = useState(0);
  const [e, setE] = useState<QuickEdit>({ in_us: 0, out_us: (a?.duration_ms ?? 0) * 1000, delogo: [], blur_regions: [], speed: 1, volume: 1, rotate: 0, brightness: 0, contrast: 1, saturation: 1, fade_in_us: 0, fade_out_us: 0 });
  const [tool, setTool] = useState<"delogo" | "blur" | "crop">("delogo");
  const [preset, setPreset] = useState<Preset>(defaultPreset());
  const [name, setName] = useState(a ? `${stem(a.name)}_edit` : "export");
  const [out, setOut] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null), [pbusy, setPbusy] = useState(false);
  const [vr, setVr] = useState({ x: 0, y: 0, w: 1, h: 1, s: 1 });
  const [draft, setDraft] = useState<Rect | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const layoutVideo = () => { const el = v.current, box = stage.current; if (!el || !box || !el.videoWidth) return; const s = Math.min(box.clientWidth / el.videoWidth, box.clientHeight / el.videoHeight);
    setVr({ s, w: el.videoWidth * s, h: el.videoHeight * s, x: (box.clientWidth - el.videoWidth * s) / 2, y: (box.clientHeight - el.videoHeight * s) / 2 }); };
  useEffect(() => { const ro = new ResizeObserver(layoutVideo); if (stage.current) ro.observe(stage.current); return () => ro.disconnect(); }, []);
  if (!a) return <Dialog title="Quick edit" onClose={onClose}><div className="empty">Select a video or audio file first.</div></Dialog>;
  const isVideo = a.kind === "video";
  const set = (p: Partial<QuickEdit>) => setE({ ...e, ...p });
  const toSrc = (cx: number, cy: number) => ({ x: Math.round((cx - vr.x) / vr.s), y: Math.round((cy - vr.y) / vr.s) });
  const rects: { r: Rect; kind: string; i: number }[] = [...(e.delogo ?? []).map((r, i) => ({ r, kind: "delogo", i })), ...(e.blur_regions ?? []).map((r, i) => ({ r, kind: "blur", i })), ...(e.crop ? [{ r: e.crop, kind: "crop", i: 0 }] : [])];
  const inUs = e.in_us ?? 0, outUs = e.out_us ?? dur * 1e6, len = (outUs - inUs) / (e.speed || 1);
  const doPreview = async () => {
    setPbusy(true);
    try { const buf = await api.previewQuick(a.id, e, Math.round(t * 1e6)); if (preview) URL.revokeObjectURL(preview); setPreview(URL.createObjectURL(new Blob([buf], { type: "image/png" }))); }
    catch (err) { st().toast(errText(err), "error"); } finally { setPbusy(false); }
  };
  const run = () => enqueue({ type: "quick", asset_id: a.id, edit: e, preset: e.lossless_cut ? { ...preset, vcodec: "copy", acodec: "copy" } : preset, out_dir: out, name: `${name}.${e.lossless_cut ? a.ext : ext(preset)}` }, `Export · ${a.name}`, onClose);
  const fr = (a.fps_den ?? 1) / (a.fps_num ?? 30);
  return (
    <Dialog title={<>Quick edit & export <span className="dim" style={{ fontWeight: 400 }}>· {a.name}</span></>} icon={<I.Scissors size={18} />} size="wide" onClose={onClose}
      footer={<><span className="dim grow num">Output ≈ {fmtDur(len / 1000)} · {e.lossless_cut ? "lossless cut" : "re-encoded"} · original is never modified</span>
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={run} disabled={len <= 0}><I.Download size={15} /> Export</button></>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16 }}>
        <div className="col" style={{ gap: 8 }}>
          {items.length > 1 && <div className="row"><span className="dim">Clip</span><select className="input" value={idx} onChange={ev => { setIdx(+ev.target.value); const n = items[+ev.target.value]; setName(`${stem(n.name)}_edit`); setE({ ...e, in_us: 0, out_us: (n.duration_ms ?? 0) * 1000, delogo: [], blur_regions: [], crop: null }); }}>{items.map((x, i) => <option key={x.id} value={i}>{x.name}</option>)}</select><span className="hint">Settings apply to this clip.</span></div>}
          <div ref={stage} style={{ position: "relative", height: 380, background: "#000", borderRadius: 8, overflow: "hidden", cursor: isVideo ? "crosshair" : "default" }}
            onPointerDown={ev => { if (!isVideo || preview) return; const b = stage.current!.getBoundingClientRect(); const p0 = toSrc(ev.clientX - b.left, ev.clientY - b.top); (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
              const mv = (m: PointerEvent) => { const p = toSrc(m.clientX - b.left, m.clientY - b.top); setDraft({ x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) }); };
              const up = (m: PointerEvent) => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); const p = toSrc(m.clientX - b.left, m.clientY - b.top);
                const r = { x: Math.max(0, Math.min(p0.x, p.x)), y: Math.max(0, Math.min(p0.y, p.y)), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) }; setDraft(null);
                if (r.w < 6 || r.h < 6) { const el = v.current!; el.paused ? el.play() : el.pause(); return; }
                if (tool === "crop") set({ crop: r }); else if (tool === "delogo") set({ delogo: [...(e.delogo ?? []), r] }); else set({ blur_regions: [...(e.blur_regions ?? []), r] }); };
              window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); }}>
            <video ref={v} src={fileUrl(a.path)} style={{ width: "100%", height: "100%", objectFit: "contain", display: preview ? "none" : "block", opacity: isVideo ? 1 : 0 }} onLoadedMetadata={layoutVideo} onTimeUpdate={ev => setT(ev.currentTarget.currentTime)} />
            {!isVideo && <div className="overlay-msg" style={{ background: `url("${thumbUrl(a)}") center/80% 60% no-repeat` }} />}
            {preview && <img src={preview} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} alt="Preview" />}
            {!preview && rects.map(({ r, kind, i }) => <div key={kind + i} style={{ position: "absolute", left: vr.x + r.x * vr.s, top: vr.y + r.y * vr.s, width: r.w * vr.s, height: r.h * vr.s, border: `2px ${kind === "crop" ? "solid #fff" : "dashed"} ${kind === "delogo" ? "#ffcc00" : kind === "blur" ? "#6aa8ff" : "#fff"}`, boxShadow: kind === "crop" ? "0 0 0 9999px rgba(0,0,0,.55)" : "none", pointerEvents: "none" }} />)}
            {draft && <div style={{ position: "absolute", left: vr.x + draft.x * vr.s, top: vr.y + draft.y * vr.s, width: draft.w * vr.s, height: draft.h * vr.s, border: "2px dashed #fff", pointerEvents: "none" }} />}
            {preview && <div className="vlabel">Preview of the processed frame (FFmpeg) — <a style={{ color: "var(--accent)", cursor: "pointer" }} onClick={() => setPreview(null)}>back to video</a></div>}
          </div>
          <div className="transport" style={{ borderRadius: 8 }}>
            <button className="btn ghost icon sm" onClick={() => { const el = v.current!; el.paused ? el.play() : el.pause(); }}><I.Play size={15} /></button>
            <button className="btn ghost icon sm" onClick={() => { v.current!.currentTime -= fr; }} title="Previous frame"><I.ChevronLeft size={15} /></button>
            <button className="btn ghost icon sm" onClick={() => { v.current!.currentTime += fr; }} title="Next frame"><I.ChevronRight size={15} /></button>
            <span className="mono num">{timecode(t * 1e6, a.fps_num ?? 30, a.fps_den ?? 1)}</span>
            <Scrub t={t} dur={dur || 1} onSeek={s => { if (v.current) v.current.currentTime = s; setT(s); setPreview(null); }} inT={inUs / 1e6} outT={outUs / 1e6} />
            <button className="btn sm" onClick={() => set({ in_us: Math.min(Math.round(t * 1e6), outUs - 100_000) })} title="Set In at playhead">[ In</button>
            <button className="btn sm" onClick={() => set({ out_us: Math.max(Math.round(t * 1e6), inUs + 100_000) })} title="Set Out at playhead">Out ]</button>
          </div>
          {isVideo && <div className="row">
            <div className="seg"><button className={`btn sm ${tool === "delogo" ? "on" : ""}`} onClick={() => setTool("delogo")}><I.Eraser size={13} /> Remove logo</button>
              <button className={`btn sm ${tool === "blur" ? "on" : ""}`} onClick={() => setTool("blur")}><I.Droplets size={13} /> Blur area</button>
              <button className={`btn sm ${tool === "crop" ? "on" : ""}`} onClick={() => setTool("crop")}><I.Crop size={13} /> Crop</button></div>
            <span className="hint grow">Drag on the video to draw. Click without dragging to play/pause.</span>
            <button className="btn sm" disabled={pbusy} onClick={doPreview}>{pbusy ? <I.Loader2 size={13} className="spin" /> : <I.Eye size={13} />} Preview frame</button>
            <button className="btn sm ghost" onClick={() => { set({ delogo: [], blur_regions: [], crop: null }); setPreview(null); }}>Clear areas</button></div>}
          {isVideo && <div className="hint">“Remove logo” reconstructs the area from its surroundings (FFmpeg delogo) — it works best on small, static marks over simple backgrounds; nothing hidden is recovered. Only use it on media you own or are authorised to edit.</div>}
        </div>
        <div>
          <div className="field"><label>Range</label><span className="num">{fmtDur(inUs / 1000)} – {fmtDur(outUs / 1000)}</span></div>
          <div className="field"><label>Cut mode</label><label className="check"><input type="checkbox" checked={!!e.lossless_cut} onChange={ev => set({ lossless_cut: ev.target.checked })} /> Lossless (fast, keyframe-accurate only, no effects)</label></div>
          {!e.lossless_cut && <>
            {isVideo && <><Slider label="Speed" min={0.25} max={4} step={0.05} value={e.speed ?? 1} onChange={x => set({ speed: x })} format={x => x.toFixed(2) + "×"} reset={1} />
              <div className="field"><label>Rotate / flip</label><div className="row"><select className="input" value={e.rotate} onChange={ev => set({ rotate: +ev.target.value })}><option value={0}>0°</option><option value={90}>90° ↻</option><option value={180}>180°</option><option value={270}>90° ↺</option></select>
                <label className="check"><input type="checkbox" checked={!!e.flip_h} onChange={ev => set({ flip_h: ev.target.checked })} /> H</label><label className="check"><input type="checkbox" checked={!!e.flip_v} onChange={ev => set({ flip_v: ev.target.checked })} /> V</label></div></div>
              <Slider label="Brightness" min={-0.5} max={0.5} step={0.01} value={e.brightness ?? 0} onChange={x => set({ brightness: x })} reset={0} />
              <Slider label="Contrast" min={0.5} max={2} step={0.01} value={e.contrast ?? 1} onChange={x => set({ contrast: x })} reset={1} />
              <Slider label="Saturation" min={0} max={2.5} step={0.01} value={e.saturation ?? 1} onChange={x => set({ saturation: x })} reset={1} /></>}
            <Slider label="Fade in" min={0} max={5} step={0.1} value={(e.fade_in_us ?? 0) / 1e6} onChange={x => set({ fade_in_us: x * 1e6 })} format={x => x.toFixed(1) + "s"} reset={0} />
            <Slider label="Fade out" min={0} max={5} step={0.1} value={(e.fade_out_us ?? 0) / 1e6} onChange={x => set({ fade_out_us: x * 1e6 })} format={x => x.toFixed(1) + "s"} reset={0} />
            <Slider label="Volume" min={0} max={3} step={0.05} value={e.volume ?? 1} onChange={x => set({ volume: x })} format={x => Math.round(x * 100) + "%"} reset={1} />
            <div className="field"><label>Audio</label><div className="row"><label className="check"><input type="checkbox" checked={!!e.mute} onChange={ev => set({ mute: ev.target.checked })} /> Mute</label><label className="check"><input type="checkbox" checked={!!e.normalize_audio} onChange={ev => set({ normalize_audio: ev.target.checked })} /> Normalize loudness</label></div></div>
            <div className="hsep" /><PresetPicker value={preset} onChange={setPreset} />
          </>}
          <div className="hsep" />
          <div className="field"><label>File name</label><div className="row"><input className="input grow" value={name} onChange={ev => setName(ev.target.value)} /><span className="dim">.{e.lossless_cut ? a.ext : ext(preset)}</span></div></div>
          <div className="field"><label>Save to</label><OutDir value={out} onChange={setOut} /></div>
          <div className="hint">If a file with this name exists, a numbered copy is created — nothing is overwritten.</div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- join
export function JoinDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const [list, setList] = useState(pick(ids).filter(a => a.kind === "video"));
  const [mode, setMode] = useState("auto"), [preset, setPreset] = useState(defaultPreset()), [out, setOut] = useState<string | null>(null);
  const [name, setName] = useState(list[0] ? `${stem(list[0].name)}_joined` : "joined");
  const same = list.every(a => a.width === list[0]?.width && a.height === list[0]?.height && a.fps_num === list[0]?.fps_num && a.fps_den === list[0]?.fps_den && a.has_audio === list[0]?.has_audio);
  const total = list.reduce((s, a) => s + (a.duration_ms ?? 0), 0);
  const mv = (i: number, d: number) => { const n = [...list]; [n[i], n[i + d]] = [n[i + d], n[i]]; setList(n); };
  return (
    <Dialog title={`Join ${list.length} clips`} icon={<I.Combine size={18} />} onClose={onClose}
      footer={<><span className="dim grow">Total {fmtDur(total)}</span><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={list.length < 2} onClick={() => enqueue({ type: "join", asset_ids: list.map(a => a.id), mode, preset, out_dir: out, name: `${name}.${mode === "auto" && same ? list[0].ext : ext(preset)}` }, `Join ${list.length} clips`, onClose)}><I.Combine size={15} /> Join</button></>}>
      <div style={{ border: "1px solid var(--line)", borderRadius: 8, marginBottom: 12 }}>{list.map((a, i) => <div key={a.id} className="row" style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>
        <span className="dim num" style={{ width: 18 }}>{i + 1}</span><img src={thumbUrl(a)} style={{ width: 54, height: 32, objectFit: "contain", background: "#000", borderRadius: 4 }} alt="" />
        <span className="ellipsis grow">{a.name}</span><span className="dim num">{a.width}×{a.height} · {a.fps_num && a.fps_den ? (a.fps_num / a.fps_den).toFixed(2) : "?"} fps · {fmtDur(a.duration_ms)}{a.has_audio === false ? " · no audio" : ""}</span>
        <button className="btn ghost icon sm" disabled={i === 0} onClick={() => mv(i, -1)}><I.ArrowUp size={14} /></button><button className="btn ghost icon sm" disabled={i === list.length - 1} onClick={() => mv(i, 1)}><I.ArrowDown size={14} /></button>
        <button className="btn ghost icon sm" onClick={() => setList(list.filter(x => x.id !== a.id))}><I.X size={14} /></button></div>)}</div>
      <div className={same ? "hint" : "warn-box"} style={{ marginBottom: 12 }}>{same ? "These clips look compatible — they can probably be joined losslessly (no re-encoding). The codec check happens when the job runs." : "Clips differ in resolution, frame rate or audio — they’ll be re-encoded to match the first clip. Clips without audio get silence so sync is kept."}</div>
      <div className="field"><label>Mode</label><select className="input" value={mode} onChange={e => setMode(e.target.value)}><option value="auto">Automatic (lossless when possible)</option><option value="reencode">Always re-encode</option><option value="copy">Lossless only (fail if incompatible)</option></select></div>
      {mode !== "copy" && <PresetPicker value={preset} onChange={setPreset} />}
      <div className="field"><label>File name</label><input className="input" value={name} onChange={e => setName(e.target.value)} /></div>
      <div className="field"><label>Save to</label><OutDir value={out} onChange={setOut} /></div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- batch convert / audio / images
export function ConvertDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const items = pick(ids).filter(a => a.kind === "video" || a.kind === "audio");
  const [preset, setPreset] = useState(defaultPreset({ crf: 23 })), [out, setOut] = useState<string | null>(null), [suffix, setSuffix] = useState("_converted");
  return (
    <Dialog title={`Convert / compress ${items.length} file(s)`} icon={<I.FileVideo size={18} />} onClose={onClose}
      footer={<><span className="dim grow">{fmtSize(items.reduce((s, a) => s + a.size, 0))} of source media</span><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!items.length} onClick={() => enqueue({ type: "convert", asset_ids: items.map(a => a.id), preset, out_dir: out, suffix }, `Convert ${items.length} file(s)`, onClose)}>Convert</button></>}>
      <PresetPicker value={preset} onChange={setPreset} />
      <div className="field"><label>Name suffix</label><input className="input" value={suffix} onChange={e => setSuffix(e.target.value)} /></div>
      <div className="field"><label>Save to</label><OutDir value={out} onChange={setOut} /></div>
      <div className="hint">Files are processed one after another in a background job; failures are reported per file and don’t stop the batch.</div>
    </Dialog>
  );
}

export function AudioDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const items = pick(ids).filter(a => (a.kind === "video" && a.has_audio !== false) || a.kind === "audio");
  const [fmt, setFmt] = useState("mp3"), [norm, setNorm] = useState(false), [fi, setFi] = useState(0), [fo, setFo] = useState(0), [vol, setVol] = useState(1), [out, setOut] = useState<string | null>(null);
  const go = async () => { for (const a of items) await api.enqueue({ type: "extract_audio", asset_id: a.id, format: fmt, edit: { normalize_audio: norm, fade_in_us: fi * 1e6, fade_out_us: fo * 1e6, volume: vol }, out_dir: out, name: `${stem(a.name)}.${fmt === "aac" ? "m4a" : fmt}` }, `Audio · ${a.name}`); st().toast(`Queued ${items.length} audio export(s)`, "ok"); onClose(); };
  return (
    <Dialog title={`Extract / convert audio (${items.length})`} icon={<I.Music size={18} />} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!items.length} onClick={go}>Extract</button></>}>
      {items.length < ids.length && <div className="warn-box" style={{ marginBottom: 10 }}>{ids.length - items.length} selected file(s) have no audio and will be skipped.</div>}
      <div className="field"><label>Format</label><select className="input" value={fmt} onChange={e => setFmt(e.target.value)}><option value="mp3">MP3 (256 kbps)</option><option value="aac">AAC / M4A</option><option value="wav">WAV (PCM 16-bit)</option><option value="flac">FLAC (lossless)</option><option value="opus">Opus</option></select></div>
      <Slider label="Volume" min={0} max={3} step={0.05} value={vol} onChange={setVol} format={x => Math.round(x * 100) + "%"} reset={1} />
      <Slider label="Fade in" min={0} max={10} step={0.1} value={fi} onChange={setFi} format={x => x.toFixed(1) + "s"} reset={0} />
      <Slider label="Fade out" min={0} max={10} step={0.1} value={fo} onChange={setFo} format={x => x.toFixed(1) + "s"} reset={0} />
      <div className="field"><label>Loudness</label><label className="check"><input type="checkbox" checked={norm} onChange={e => setNorm(e.target.checked)} /> Normalize to −16 LUFS (EBU R128)</label></div>
      <div className="field"><label>Save to</label><OutDir value={out} onChange={setOut} /></div>
    </Dialog>
  );
}

export function ImagesDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const items = pick(ids).filter(a => a.kind === "image" && a.ext !== "svg");
  const [mode, setMode] = useState("long"), [long, setLong] = useState(1920), [pct, setPct] = useState(50), [rot, setRot] = useState(0), [fh, setFh] = useState(false), [fv, setFv] = useState(false);
  const [fmt, setFmt] = useState("keep"), [q, setQ] = useState(90), [suffix, setSuffix] = useState("_edit"), [out, setOut] = useState<string | null>(null);
  return (
    <Dialog title={`Batch process ${items.length} image(s)`} icon={<I.Images size={18} />} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!items.length} onClick={() => enqueue({ type: "image_batch", asset_ids: items.map(a => a.id), ops: { resize_long: mode === "long" ? long : null, scale_pct: mode === "pct" ? pct : null, rotate: rot, flip_h: fh, flip_v: fv, format: fmt, quality: q, suffix }, out_dir: out }, `Process ${items.length} image(s)`, onClose)}>Process</button></>}>
      <div className="field"><label>Resize</label><div className="row"><select className="input" value={mode} onChange={e => setMode(e.target.value)}><option value="none">Keep size</option><option value="long">Long edge</option><option value="pct">Percent</option></select>
        {mode === "long" && <><input className="input num-in" type="number" value={long} onChange={e => setLong(+e.target.value)} /> px</>}{mode === "pct" && <><input className="input num-in" type="number" value={pct} onChange={e => setPct(+e.target.value)} /> %</>}<span className="hint">Lanczos3 resampling</span></div></div>
      <div className="field"><label>Rotate / flip</label><div className="row"><select className="input" value={rot} onChange={e => setRot(+e.target.value)}><option value={0}>No rotation</option><option value={90}>90° ↻</option><option value={180}>180°</option><option value={270}>90° ↺</option></select>
        <label className="check"><input type="checkbox" checked={fh} onChange={e => setFh(e.target.checked)} /> Flip H</label><label className="check"><input type="checkbox" checked={fv} onChange={e => setFv(e.target.checked)} /> Flip V</label></div></div>
      <div className="field"><label>Format</label><div className="row"><select className="input" value={fmt} onChange={e => setFmt(e.target.value)}><option value="keep">Same as source</option><option value="jpg">JPEG</option><option value="png">PNG</option><option value="webp">WebP (lossless)</option><option value="tif">TIFF</option></select>
        {fmt === "jpg" && <><span className="dim">quality</span><input className="input num-in" type="number" min={30} max={100} value={q} onChange={e => setQ(+e.target.value)} /></>}</div></div>
      <div className="field"><label>Name suffix</label><input className="input" value={suffix} onChange={e => setSuffix(e.target.value)} /></div>
      <div className="field"><label>Save to</label><OutDir value={out} onChange={setOut} /></div>
      <div className="hint">EXIF orientation is applied. Output files don’t carry the original metadata (location/camera data is not copied).</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- contact sheet (rendered locally from cached thumbnails)
export function ContactDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const items = pick(ids);
  const [cols, setCols] = useState(Math.min(6, Math.ceil(Math.sqrt(items.length)))), [cell, setCell] = useState(320), [labels, setLabels] = useState(true), [title, setTitle] = useState("Contact sheet"), [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const rows = Math.ceil(items.length / cols), pad = 16, lh = labels ? 34 : 0, th = Math.round(cell * 0.66), head = title ? 56 : 0;
      const c = mkCanvas(pad + cols * (cell + pad), head + pad + rows * (th + lh + pad)), x = c.getContext("2d")!;
      x.fillStyle = "#16171a"; x.fillRect(0, 0, c.width, c.height);
      if (title) { x.fillStyle = "#fff"; x.font = "600 26px Segoe UI"; x.fillText(title, pad, 38); x.fillStyle = "#999"; x.font = "14px Segoe UI"; x.fillText(`${items.length} items · ${new Date().toLocaleDateString()}`, pad + x.measureText(title).width + 16 + 0, 38); }
      const load = (a: Asset) => new Promise<HTMLImageElement | null>(r => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => r(im); im.onerror = () => r(null); im.src = thumbUrl(a); });
      for (let i = 0; i < items.length; i++) {
        const a = items[i], cx = pad + (i % cols) * (cell + pad), cy = head + pad + Math.floor(i / cols) * (th + lh + pad);
        x.fillStyle = "#0b0b0c"; x.fillRect(cx, cy, cell, th);
        const im = await load(a);
        if (im) { const s = Math.min(cell / im.width, th / im.height); x.drawImage(im, cx + (cell - im.width * s) / 2, cy + (th - im.height * s) / 2, im.width * s, im.height * s); }
        if (labels) { x.fillStyle = "#e6e6e6"; x.font = "13px Segoe UI"; let n = a.name; while (x.measureText(n).width > cell && n.length > 4) n = n.slice(0, -2); x.fillText(n === a.name ? n : n + "…", cx, cy + th + 16);
          x.fillStyle = "#8a8f98"; x.font = "11px Segoe UI"; x.fillText([a.width ? `${a.width}×${a.height}` : "", a.duration_ms ? fmtDur(a.duration_ms) : "", a.rating ? "★".repeat(a.rating) : ""].filter(Boolean).join("  ·  "), cx, cy + th + 30); }
      }
      const blob = await toBlob(c, "image/jpeg", 0.9);
      const dir = await openDialog({ directory: true, title: "Save contact sheet to…" });
      if (!dir || Array.isArray(dir)) return;
      const p = await api.saveOutput(new Uint8Array(await blob.arrayBuffer()), { dir }, `${title.replace(/[\\/:*?"<>|]/g, "_") || "contact-sheet"}.jpg`);
      st().toast(`Contact sheet saved: ${p}`, "ok"); onClose(); st().refresh();
    } catch (e) { st().toast(errText(e), "error"); } finally { setBusy(false); }
  };
  return (
    <Dialog title={`Contact sheet (${items.length})`} icon={<I.Grid3x3 size={18} />} size="narrow" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={make}>{busy ? "Rendering…" : "Create & save…"}</button></>}>
      <div className="field"><label>Title</label><input className="input" value={title} onChange={e => setTitle(e.target.value)} /></div>
      <div className="field"><label>Columns</label><input className="input num-in" type="number" min={1} max={20} value={cols} onChange={e => setCols(clamp(+e.target.value, 1, 20))} /></div>
      <div className="field"><label>Cell width</label><input className="input num-in" type="number" min={120} max={480} value={cell} onChange={e => setCell(clamp(+e.target.value, 120, 480))} /></div>
      <div className="field"><label>Labels</label><label className="check"><input type="checkbox" checked={labels} onChange={e => setLabels(e.target.checked)} /> File names and details</label></div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- similar / duplicates
export function SimilarDialog({ onClose }: { onClose: () => void }) {
  const { assets, jobs } = useStore();
  const imgs = useMemo(() => assets.filter(a => a.kind === "image"), [assets]);
  const [th, setTh] = useState(6), [groups, setGroups] = useState<number[][] | null>(null), [job, setJob] = useState<number | null>(null);
  const find = () => api.similar(imgs.map(a => a.id), th).then(setGroups).catch(e => st().toast(errText(e), "error"));
  const analyse = async () => { const id = await api.enqueue({ type: "hashes", asset_ids: imgs.map(a => a.id) }, `Analyse ${imgs.length} image(s) for similarity`); setJob(id); };
  const j = jobs.find(x => x.id === job);
  useEffect(() => { if (j?.status === "done") find(); }, [j?.status]); // eslint-disable-line
  const byId = new Map(assets.map(a => [a.id, a]));
  return (
    <Dialog title="Similar & duplicate images" icon={<I.ScanSearch size={18} />} size="wide" onClose={onClose}
      footer={<><span className="hint grow">Similarity uses a perceptual hash — it’s approximate: review before deleting anything.</span><button className="btn" onClick={onClose}>Close</button></>}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span>{imgs.length} images in the current view</span>
        <button className="btn" onClick={analyse} disabled={j?.status === "running" || j?.status === "queued"}>{j && (j.status === "running" || j.status === "queued") ? <><I.Loader2 size={14} className="spin" /> Analysing {Math.round(j.progress * 100)}%</> : "1. Analyse images"}</button>
        <span className="dim">Strictness</span><input type="range" min={0} max={16} value={th} onChange={e => setTh(+e.target.value)} /><span className="num dim" style={{ width: 90 }}>{th <= 2 ? "near-identical" : th <= 8 ? "similar" : "loose"}</span>
        <button className="btn primary" onClick={find}>2. Find groups</button>
      </div>
      {groups && !groups.length && <div className="empty">No similar groups found. Run “Analyse” first if you haven’t, or loosen the strictness.</div>}
      {groups?.map((g, gi) => <div key={gi} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
        <div className="row" style={{ marginBottom: 8 }}><b>Group {gi + 1}</b><span className="dim">{g.length} images</span><span className="grow" />
          <button className="btn sm" onClick={() => { useStore.setState({ selected: new Set(g), focus: g[0], compare: g.slice(0, 4) }); onClose(); }}><I.Columns2 size={13} /> Compare</button>
          <button className="btn sm" onClick={() => { useStore.setState({ selected: new Set(g), focus: g[0] }); onClose(); }}>Select</button></div>
        <div className="row" style={{ flexWrap: "wrap" }}>{g.map(id => { const a = byId.get(id); return a ? <div key={id} style={{ width: 150 }} title={a.path}><img src={thumbUrl(a)} style={{ width: 150, height: 100, objectFit: "contain", background: "#000", borderRadius: 6 }} alt="" /><div className="ellipsis hint">{a.name}</div><div className="hint num">{a.width}×{a.height} · {fmtSize(a.size)}{a.rating ? " · " + "★".repeat(a.rating) : ""}</div></div> : null; })}</div>
      </div>)}
    </Dialog>
  );
}

// ---------------------------------------------------------------- settings & diagnostics
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState("general");
  const [s, setS] = useState<Record<string, any>>({});
  const [diag, setDiag] = useState<any>(null), [cache, setCache] = useState<any>(null), [ai, setAi] = useState<any>(null), [aiP, setAiP] = useState<number | null>(null);
  const { layout, setLayout } = useStore();
  const load = () => { api.settings().then(setS); api.cacheInfo().then(setCache); api.aiStatus().then(setAi); };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (tab === "diag" && !diag) api.diagnostics().then(setDiag).catch(e => setDiag({ error: errText(e) })); }, [tab, diag]);
  useEffect(() => { let un: (() => void) | undefined; import("@tauri-apps/api/event").then(m => m.listen<number>("ai-install", e => setAiP(e.payload)).then(u => (un = u))); return () => un?.(); }, []);
  const save = (k: string, v: unknown) => { setS({ ...s, [k]: v }); api.setSetting(k, v).catch(e => st().toast(errText(e), "error")); };
  const install = async () => {
    setAiP(0);
    try { await api.aiInstall(); st().toast("AI upscaler installed", "ok"); load(); } catch (e) { st().toast(errText(e), "error"); } finally { setAiP(null); }
  };
  const report = () => JSON.stringify({ ...diag, recent_failures: diag?.recent_failures?.map((f: any) => ({ ...f, error: String(f.error ?? "").replace(/[A-Z]:\\[^\s"']+/g, "<path>") })) }, null, 2);
  const T = (id: string, l: string) => <button className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{l}</button>;
  return (
    <Dialog title="Settings" icon={<I.Settings size={18} />} size="wide" onClose={onClose}>
      <div className="tabs" style={{ marginBottom: 14 }}>{T("general", "General")}{T("perf", "Performance")}{T("library", "Library")}{T("ai", "AI models")}{T("diag", "Diagnostics")}{T("about", "About & licences")}</div>
      {tab === "general" && <>
        <div className="field"><label>Theme</label><div className="seg"><button className={`btn sm ${layout.theme === "dark" ? "on" : ""}`} onClick={() => setLayout({ theme: "dark" })}>Dark</button><button className={`btn sm ${layout.theme === "light" ? "on" : ""}`} onClick={() => setLayout({ theme: "light" })}>Light</button></div></div>
        <div className="field"><label>Thumbnail size</label><input type="range" min={110} max={420} value={layout.thumb} onChange={e => setLayout({ thumb: +e.target.value })} /></div>
        <div className="field"><label>Default encoder</label><select className="input" value={s["export.hw"] ?? "auto"} onChange={e => save("export.hw", e.target.value)}><option value="auto">Auto (GPU when verified)</option><option value="none">CPU only</option></select></div>
        <div className="field"><label>Welcome tour</label><button className="btn sm" onClick={() => { onClose(); st().setDialog({ kind: "tour" }); }}>Show again</button></div>
      </>}
      {tab === "perf" && <>
        <div className="field"><label>Parallel jobs</label><div className="row"><input className="input num-in" type="number" min={1} max={8} value={s["jobs.concurrency"] ?? 2} onChange={e => save("jobs.concurrency", clamp(+e.target.value, 1, 8))} /><span className="hint">Exports/conversions running at once. 1–2 is best for GPU encoding.</span></div></div>
        <div className="field"><label>Thumbnail workers</label><div className="row"><input className="input num-in" type="number" min={1} max={12} value={s["thumbs.workers"] ?? ""} placeholder="auto" onChange={e => save("thumbs.workers", clamp(+e.target.value, 1, 12))} /><span className="hint">Applies after restart.</span></div></div>
        <div className="field"><label>Thumbnail cache limit</label><div className="row"><input className="input num-in" type="number" min={256} step={256} value={s["cache.max_mb"] ?? 2048} onChange={e => save("cache.max_mb", Math.max(256, +e.target.value))} /> MB <span className="hint">Oldest thumbnails are removed at startup when over the limit.</span></div></div>
        <div className="field"><label>Cache usage</label><div className="row">{cache ? <>Thumbnails {fmtSize(cache.thumbs)} · Proxies {fmtSize(cache.proxies)}</> : "…"}
          <button className="btn sm" onClick={async () => { const n = await api.clearCache("thumbs"); st().toast(`Cleared ${fmtSize(n)} of thumbnails`, "ok"); load(); }}>Clear thumbnails</button>
          <button className="btn sm" onClick={async () => { const n = await api.clearCache("proxies"); st().toast(`Cleared ${fmtSize(n)} of proxies`, "ok"); load(); }}>Clear proxies</button></div></div>
        <div className="hint">Clearing caches never touches your original files.</div>
      </>}
      {tab === "library" && <>
        <div className="field"><label>Excluded folder names</label><input className="input" placeholder="e.g. cache, proxies, render" defaultValue={(s["library.excluded"] ?? []).join(", ")} onBlur={e => save("library.excluded", e.target.value.split(",").map(x => x.trim()).filter(Boolean))} /></div>
        <div className="hint">Hidden folders, system folders and “_rejected” are always skipped. Rescan a folder after changing this. Folder watching is not enabled in this version — use Rescan (F5) after adding files outside the app.</div>
      </>}
      {tab === "ai" && ai && <>
        <div className="sec" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
          <div className="row"><I.Sparkles size={18} /><b>Real-ESRGAN upscaler</b><span className={`status-tag ${ai.installed ? "done" : ""}`}>{ai.installed ? "installed" : "not installed"}</span></div>
          <p className="hint">AI image & video super-resolution (2× / 4×). Runs locally on the GPU via Vulkan (NVIDIA, AMD and Intel), with a slower CPU fallback. {ai.license}</p>
          {ai.installed ? <><div className="hint">Models: {ai.models.join(", ")} · {ai.size_mb} MB on disk</div><div className="hint mono">{ai.path}</div></>
            : <><div className="warn-box">Downloads about {ai.download_mb} MB from GitHub ({ai.url}). Nothing is downloaded until you click the button.</div>
              <div className="row" style={{ marginTop: 10 }}><button className="btn primary" disabled={aiP !== null} onClick={install}>{aiP !== null ? `Downloading ${Math.round(aiP * 100)}%` : "Download & install"}</button>{aiP !== null && <div className="progress grow"><div style={{ width: `${aiP * 100}%` }} /></div>}</div></>}
        </div>
        <div className="hint" style={{ marginTop: 10 }}>Background removal, face restoration, frame interpolation and transcription are not included in this version.</div>
      </>}
      {tab === "diag" && (diag ? <>
        <dl className="kv" style={{ gridTemplateColumns: "190px 1fr" }}>
          <dt>App version</dt><dd>{diag.app_version}</dd><dt>Windows</dt><dd>{diag.os} ({diag.arch})</dd>
          <dt>FFmpeg</dt><dd>{diag.ffmpeg?.found ? `${diag.ffmpeg.version} — ${diag.ffmpeg.source}` : <span style={{ color: "var(--bad)" }}>Not found — video features unavailable</span>}</dd>
          <dt>GPU encoders (verified)</dt><dd>{diag.hw_encoders?.length ? diag.hw_encoders.join(", ") : "none — CPU encoding will be used"}</dd>
          <dt>Hardware decoders</dt><dd>{diag.hwaccels?.join(", ")}</dd><dt>CPU encoders</dt><dd>{diag.software_encoders?.join(", ")}</dd>
          <dt>AI upscaler</dt><dd>{diag.ai?.installed ? "installed" : "not installed"}</dd>
          <dt>Catalogue</dt><dd>schema v{diag.database?.schema_version} · {diag.database?.assets} assets · {diag.database?.missing} missing · {diag.database?.pending_metadata} awaiting metadata · {diag.database?.metadata_errors} unreadable</dd>
          <dt>Thumbnail queue</dt><dd>{diag.thumbnail_queue}</dd><dt>Free disk (app data)</dt><dd>{diag.data_dir_free_bytes ? fmtSize(diag.data_dir_free_bytes) : "?"}</dd>
          <dt>Recent failures</dt><dd>{diag.recent_failures?.length ? diag.recent_failures.map((f: any, i: number) => <div key={i}>{f.title}: {f.error}</div>) : "none"}</dd>
        </dl>
        <div className="row" style={{ marginTop: 12 }}><button className="btn" onClick={() => navigator.clipboard.writeText(report()).then(() => st().toast("Diagnostic report copied (paths redacted, no media names)", "ok"))}><I.Copy size={14} /> Copy diagnostic report</button>
          <span className="hint">Nothing is uploaded — review and share the report yourself if you need support.</span></div></> : <div className="empty"><I.Loader2 className="spin" /> Collecting diagnostics…</div>)}
      {tab === "about" && <div className="hint" style={{ lineHeight: 1.8 }}>
        <b style={{ color: "var(--text)" }}>Media Studio Pro 0.1</b> — local-first media library and editor. No account, no telemetry, no uploads.<br />
        Built with Tauri (MIT/Apache-2.0), React (MIT), SQLite (public domain), image-rs (MIT/Apache-2.0), lucide (ISC).<br />
        Media engine: FFmpeg (GPL build when bundled — see THIRD_PARTY_NOTICES.md and https://ffmpeg.org for source).<br />
        Optional: Real-ESRGAN ncnn Vulkan (BSD-3-Clause).</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- help, palette, toasts, tour
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const groups = [...new Set(commands.filter(c => c.keys).map(c => c.group))];
  const extra: [string, string][] = [["←→↑↓", "Move through items"], ["Ctrl/Shift+click", "Multi / range select"], ["Space / K", "Play / pause video"], ["J / L", "Back / forward 5 s"], [", / .", "Previous / next frame"], ["[ / ]", "Slower / faster"], ["+ / − / Z", "Zoom image / toggle 100%"], ["Ctrl+K", "Command palette"], ["Ctrl+F or /", "Search"], ["Ctrl+1…4", "Switch workspace"]];
  return (
    <Dialog title="Keyboard shortcuts" icon={<I.Keyboard size={18} />} size="wide" onClose={onClose}>
      <div style={{ columns: 2, columnGap: 28 }}>
        <div style={{ breakInside: "avoid", marginBottom: 14 }}><div className="sec-h">Navigation & playback</div>{extra.map(([k, l]) => <div key={k} className="row" style={{ justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid var(--line)" }}><span>{l}</span><span className="kbd">{k}</span></div>)}</div>
        {groups.map(g => <div key={g} style={{ breakInside: "avoid", marginBottom: 14 }}><div className="sec-h">{g}</div>{commands.filter(c => c.keys && c.group === g).map(c => <div key={c.id} className="row" style={{ justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid var(--line)" }}><span>{c.label}</span><span className="kbd">{c.keys}</span></div>)}</div>)}
      </div>
    </Dialog>
  );
}

export function CommandPalette() {
  const open = useStore(s => s.palette);
  const [q, setQ] = useState(""), [i, setI] = useState(0);
  useEffect(() => { if (open) { setQ(""); setI(0); } }, [open]);
  if (!open) return null;
  const close = () => useStore.setState({ palette: false });
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = commands.filter(c => terms.every(t => (c.label + " " + c.group).toLowerCase().includes(t)));
  const run = (c = list[i]) => { if (!c) return; close(); if (c.when && !c.when()) { st().toast(`“${c.label}” needs a selection first`, "info"); return; } void c.run(); };
  return (<>
    <div className="backdrop" style={{ background: "rgba(0,0,0,.3)" }} onMouseDown={close} />
    <div className="palette" role="dialog" aria-label="Command palette">
      <input autoFocus placeholder="Type a command…" value={q} onChange={e => { setQ(e.target.value); setI(0); }}
        onKeyDown={e => { if (e.key === "ArrowDown") { e.preventDefault(); setI(Math.min(list.length - 1, i + 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setI(Math.max(0, i - 1)); } else if (e.key === "Enter") run(); else if (e.key === "Escape") close(); }} />
      <div className="items">{list.map((c, k) => <div key={c.id} className={`it ${k === i ? "on" : ""}`} onMouseEnter={() => setI(k)} onClick={() => run(c)} style={{ opacity: c.when && !c.when() ? 0.5 : 1 }}>
        {c.icon ?? <I.ChevronRight size={15} />}<span>{c.label}</span><span className="dim" style={{ fontSize: 11 }}>{c.group}</span>{c.keys && <span className="k kbd">{c.keys}</span>}</div>)}
        {!list.length && <div className="hint" style={{ padding: 12 }}>No matching commands.</div>}</div>
    </div>
  </>);
}

export function Toasts() {
  const { toasts, dismiss } = useStore();
  return <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>
    <span className="grow">{t.text}</span>{t.action && <button className="btn sm" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
    <button className="btn ghost icon sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><I.X size={13} /></button></div>)}</div>;
}

const TOUR = [
  { t: "Welcome to Media Studio Pro", b: "A fast, local library and editor for your photos, videos and audio. Your files stay where they are — the app builds a private catalogue on this PC." },
  { t: "1 · Add a folder", b: "Use “Add folder” (top right) or drag a folder onto the window. Thumbnails and metadata are generated in the background while you work." },
  { t: "2 · Review fast", b: "Arrow keys to move, 1–5 to rate, F favourite, X reject, Enter for a big preview, C to compare picks side by side. Right-click anything for more." },
  { t: "3 · Edit & export", b: "E opens the image editor or the timeline. Quick edit trims, removes logos and exports videos without leaving the library. All exports run as background jobs." },
  { t: "4 · Find anything", b: "Ctrl+K opens the command palette — every feature is searchable there. Press ? for all shortcuts." },
];
export function Tour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const done = () => { try { localStorage.setItem("msp.tour", "1"); } catch { /* ignore */ } onClose(); };
  return (
    <div className="backdrop"><div className="dialog narrow" role="dialog">
      <div className="dialog-b" style={{ padding: 26 }}>
        <span className="hero-icon">{[<I.Sparkles key={0} size={30} />, <I.FolderPlus key={1} size={30} />, <I.Star key={2} size={30} />, <I.Scissors key={3} size={30} />, <I.Command key={4} size={30} />][i]}</span>
        <h2 style={{ margin: "16px 0 6px" }}>{TOUR[i].t}</h2><div className="hint" style={{ fontSize: 13.5 }}>{TOUR[i].b}</div>
      </div>
      <div className="dialog-f"><span className="dim grow">{i + 1} / {TOUR.length}</span><button className="btn ghost" onClick={done}>Skip</button>
        {i < TOUR.length - 1 ? <button className="btn primary" autoFocus onClick={() => setI(i + 1)}>Next</button> : <button className="btn primary" autoFocus onClick={done}>Get started</button>}</div>
    </div></div>
  );
}
export { Fragment };
