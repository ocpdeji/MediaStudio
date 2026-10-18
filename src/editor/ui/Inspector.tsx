import { ReactNode, useEffect, useMemo, useState } from "react";
import { Bold, Diamond, Italic, RotateCcw, Trash2, Underline } from "lucide-react";
import { ANIMS } from "../engine/anim";
import { EFFECTS, effectById } from "../engine/effects";
import { FILTERS, filterById } from "../engine/luts";
import { BLEND_LABELS, BLEND_MODES } from "../engine/shaders";
import { TRANSITIONS, transitionById } from "../engine/transitions";
import { ed } from "../api";
import {
  Adjust, ADJUST_KEYS, Clip, CURVES, defTextStyle, defTransform, findClip, frameUs, keyAt, KeyProp, keyValue, MaskShape, nextAdjacent, Project, RATIOS, removeKey, SEC, setKey, setSpeed, srcSpan, TextStyle, updateClip,
} from "../model";
import { BUNDLED_FONTS, CAPTION_STYLES, TEXT_PRESETS } from "../presets";
import { ensureAudioFx, ensureStabilized, notify, useEd } from "../store";
import { ensureMatte, matteState } from "../ai/cutout";

// ---------------------------------------------------------------- small controls

function useClip(): { p: Project; c: Clip | null } {
  const p = useEd(s => s.p)!, sel = useEd(s => s.sel);
  const c = sel.length === 1 ? findClip(p, sel[0])?.clip ?? null : null;
  return { p, c };
}
const live = (id: string, patch: Partial<Clip> | ((c: Clip) => Partial<Clip>)) => useEd.getState().live(pp => updateClip(pp, id, patch));
const commit = (id: string, patch: Partial<Clip> | ((c: Clip) => Partial<Clip>)) => useEd.getState().commit(pp => updateClip(pp, id, patch));
const end = () => useEd.getState().endLive();

export function Row({ label, value, min, max, step = 1, onChange, fmt, reset, kf, unit }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; fmt?: (v: number) => string; reset?: number; kf?: ReactNode; unit?: string }) {
  const [txt, setTxt] = useState<string | null>(null);
  return (
    <div className="ed-row">
      <span onDoubleClick={() => { if (reset !== undefined) { onChange(reset); end(); } }} title={reset !== undefined ? "Double-click to reset" : undefined}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={Math.max(min, Math.min(max, value))} onChange={e => onChange(+e.target.value)} onPointerUp={end} onKeyUp={end} aria-label={label} />
      <input className="val" value={txt ?? (fmt ? fmt(value) : `${Math.round(value * 100) / 100}${unit ?? ""}`)} onFocus={() => setTxt(String(Math.round(value * 1000) / 1000))} onChange={e => setTxt(e.target.value)}
        onBlur={() => { const v = parseFloat(txt ?? ""); if (Number.isFinite(v)) { onChange(Math.max(min * 10 - 1e9 > 0 ? min : -1e9, v)); end(); } setTxt(null); }} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      <span>{kf}</span>
    </div>
  );
}

/** Value + keyframe toggle for an animatable property. */
function KRow({ c, prop, label, base, min, max, step, toUi = (v: number) => v, fromUi = (v: number) => v, setBase, fmt, reset }: {
  c: Clip; prop: KeyProp; label: string; base: number; min: number; max: number; step?: number; toUi?: (v: number) => number; fromUi?: (v: number) => number; setBase: (v: number) => Partial<Clip>; fmt?: (v: number) => string; reset?: number;
}) {
  const t = useEd(s => s.t);
  const local = Math.max(0, Math.min(c.dur, t - c.start));
  const keys = c.keys?.[prop];
  const v = keyValue(keys, local, base);
  const on = !!keyAt(keys, local);
  const inRange = t >= c.start && t <= c.start + c.dur;
  const set = (ui: number) => {
    const nv = fromUi(ui);
    if (keys?.length) live(c.id, cc => ({ keys: { ...cc.keys, [prop]: setKey(cc.keys?.[prop], local, nv) } }));
    else live(c.id, setBase(nv));
  };
  const toggle = () => {
    if (!inRange) return notify("Move the playhead inside the clip to add a keyframe", "info");
    commit(c.id, cc => ({ keys: { ...cc.keys, [prop]: on ? removeKey(cc.keys?.[prop], local) : setKey(cc.keys?.[prop], local, v) } }));
  };
  return <Row label={label} value={toUi(v)} min={min} max={max} step={step} onChange={set} fmt={fmt} reset={reset}
    kf={<button className={`ed-kf ${on ? "on" : keys?.length ? "has" : ""}`} title={on ? "Remove keyframe" : "Add keyframe at playhead"} onClick={toggle}><Diamond size={12} fill={on ? "currentColor" : "none"} /></button>} />;
}

function Sec({ title, children, right, on, onToggle }: { title: string; children?: ReactNode; right?: ReactNode; on?: boolean; onToggle?: (v: boolean) => void }) {
  return <div className="ed-sec"><div className="t">{onToggle && <input type="checkbox" checked={!!on} onChange={e => onToggle(e.target.checked)} />}{title}<span className="grow" />{right}</div>{(!onToggle || on) && children}</div>;
}
function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return <div className="ed-seg">{options.map(([v, l]) => <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}</div>;
}
function Color({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input type="color" className="ed-colorin" value={value} onChange={e => onChange(e.target.value)} onBlur={end} />;
}
const pct = (v: number) => `${Math.round(v * 100)}%`;
const db = (g: number) => (g <= 0.0001 ? "−∞" : `${(20 * Math.log10(g)).toFixed(1)}dB`);

// ---------------------------------------------------------------- main

export function Inspector() {
  const { p, c } = useClip();
  const sel = useEd(s => s.sel);
  const tabs = useMemo(() => tabsFor(c), [c?.type]); // eslint-disable-line
  const [tab, setTab] = useState(tabs[0]?.[0] ?? "project");
  const [sub, setSub] = useState("basic");
  useEffect(() => { if (!tabs.some(t => t[0] === tab)) setTab(tabs[0]?.[0] ?? "project"); }, [tabs]); // eslint-disable-line
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent).detail; if (d === "crop") { setTab("video"); setSub("crop"); } if (d === "transition") { setTab("video"); setSub("basic"); } if (d === "text") setTab("text"); };
    window.addEventListener("msp-inspector", h); return () => window.removeEventListener("msp-inspector", h);
  }, []);
  if (sel.length > 1) return <div className="ed-right"><div className="ed-rtabs"><button className="ed-rtab on">{sel.length} clips</button></div><div className="ed-rbody"><MultiSel ids={sel} /></div></div>;
  return (
    <div className="ed-right">
      <div className="ed-rtabs">{(c ? tabs : [["project", "Project"]] as [string, string][]).map(([k, l]) => <button key={k} className={`ed-rtab ${(c ? tab : "project") === k ? "on" : ""}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="ed-rbody">
        {!c && <ProjectTab p={p} />}
        {c && tab === "video" && <VideoTab p={p} c={c} sub={sub} setSub={setSub} />}
        {c && tab === "audio" && <AudioTab p={p} c={c} />}
        {c && tab === "speed" && <SpeedTab p={p} c={c} />}
        {c && tab === "anim" && <AnimTab c={c} />}
        {c && tab === "adjust" && <AdjustTab c={c} />}
        {c && tab === "text" && <TextTab c={c} />}
        {c && tab === "captions" && <CaptionTab p={p} c={c} />}
        {c && tab === "effect" && <EffectClipTab c={c} />}
        {c && tab === "filter" && <FilterClipTab c={c} />}
        {c && tab === "sticker" && <StickerTab c={c} />}
      </div>
    </div>
  );
}

function tabsFor(c: Clip | null): [string, string][] {
  if (!c) return [["project", "Project"]];
  switch (c.type) {
    case "video": return [["video", "Video"], ["audio", "Audio"], ["speed", "Speed"], ["anim", "Animation"], ["adjust", "Adjust"]];
    case "image": return [["video", "Image"], ["anim", "Animation"], ["adjust", "Adjust"]];
    case "audio": return [["audio", "Audio"], ["speed", "Speed"]];
    case "text": return [["text", "Text"], ["anim", "Animation"], ["video", "Transform"]];
    case "caption": return [["text", "Text"], ["captions", "Captions"], ["anim", "Animation"], ["video", "Transform"]];
    case "sticker": return [["sticker", "Sticker"], ["video", "Transform"], ["anim", "Animation"]];
    case "color": return [["video", "Color"], ["anim", "Animation"], ["adjust", "Adjust"]];
    case "effect": return [["effect", "Effect"]];
    case "filter": return [["filter", "Filter"]];
    case "adjust": return [["adjust", "Adjust"]];
  }
}

function MultiSel({ ids }: { ids: string[] }) {
  return <>
    <div className="ed-note">{ids.length} clips selected. Settings below apply to all of them.</div>
    <Sec title="Quick actions">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button className="eb sm solid" onClick={() => useEd.getState().commit(pp => ids.reduce((q, id) => updateClip(q, id, { mute: true }), pp))}>Mute all</button>
        <button className="eb sm solid" onClick={() => useEd.getState().commit(pp => ids.reduce((q, id) => updateClip(q, id, { mute: false }), pp))}>Unmute all</button>
        <button className="eb sm solid" onClick={() => useEd.getState().commit(pp => ids.reduce((q, id) => { const f = findClip(q, id); return f && (f.clip.type === "video" || f.clip.type === "image") && f.track.main ? updateClip(q, id, { transition: nextAdjacent(f.track, f.clip) ? { id: "fade", dur: 500_000 } : null }) : q; }, pp))}>Add Mix transitions</button>
        <button className="eb sm solid" onClick={() => useEd.getState().commit(pp => ids.reduce((q, id) => updateClip(q, id, { transition: null }), pp))}>Remove transitions</button>
        <button className="eb sm solid" onClick={() => useEd.getState().commit(pp => ids.reduce((q, id) => updateClip(q, id, { fadeIn: 300_000, fadeOut: 300_000 }), pp))}>Audio fade in/out</button>
      </div>
    </Sec>
  </>;
}

// ---------------------------------------------------------------- project

function ProjectTab({ p }: { p: Project }) {
  const set = (patch: Partial<Project>) => useEd.getState().commit(pp => ({ ...pp, ...patch }));
  const fpsList: [number, number, string][] = [[24000, 1001, "23.976"], [24, 1, "24"], [25, 1, "25"], [30000, 1001, "29.97"], [30, 1, "30"], [50, 1, "50"], [60, 1, "60"]];
  return <>
    <Sec title="Project">
      <div className="ed-row two"><span>Name</span><input value={p.name} onChange={e => useEd.getState().live(pp => ({ ...pp, name: e.target.value }))} onBlur={end} /></div>
      <div className="ed-row two"><span>Ratio</span><select value={p.ratio} onChange={e => { const r = e.target.value, wh = RATIOS[r] ?? [p.width, p.height]; set({ ratio: r, width: wh[0], height: wh[1] }); }}>{Object.keys(RATIOS).map(r => <option key={r} value={r}>{r}</option>)}</select></div>
      <div className="ed-row two"><span>Resolution</span><span>{p.width} × {p.height}</span></div>
      <div className="ed-row two"><span>Frame rate</span><select value={`${p.fps_num}/${p.fps_den}`} onChange={e => { const [n, d] = e.target.value.split("/").map(Number); set({ fps_num: n, fps_den: d }); }}>{fpsList.map(([n, d, l]) => <option key={l} value={`${n}/${d}`}>{l} fps</option>)}</select></div>
    </Sec>
    <Sec title="Background (canvas)">
      <div className="ed-note">Fills empty areas when a clip doesn't cover the frame (CapCut “Canvas”).</div>
      <Seg value={p.background.type} options={[["blur", "Blur"], ["color", "Colour"], ["image", "Image"]]} onChange={v => set({ background: { ...p.background, type: v } })} />
      {p.background.type === "blur" && <Row label="Blur" value={p.background.blur} min={0} max={100} onChange={v => useEd.getState().live(pp => ({ ...pp, background: { ...pp.background, blur: v } }))} />}
      {p.background.type === "color" && <div className="ed-row two" style={{ marginTop: 10 }}><span>Colour</span><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{["#000000", "#ffffff", "#111827", "#1e3a8a", "#7c3aed", "#db2777", "#f59e0b", "#10b981"].map(col =>
        <button key={col} className="ed-swatch" style={{ background: col, outline: p.background.color === col ? "2px solid var(--e-acc)" : undefined }} onClick={() => set({ background: { ...p.background, color: col } })} />)}<Color value={p.background.color} onChange={v => useEd.getState().live(pp => ({ ...pp, background: { ...pp.background, color: v } }))} /></div></div>}
      {p.background.type === "image" && <div style={{ marginTop: 8 }}><button className="eb sm solid" onClick={async () => {
        const { open } = await import("@tauri-apps/plugin-dialog"); const f = await open({ filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }] }); if (typeof f !== "string") return;
        const r = await ed.import([f]); if (r.ok[0]) set({ background: { ...p.background, image: r.ok[0].path } });
      }}>Choose image…</button> <span className="ed-note">{p.background.image?.split(/[\\/]/).pop()}</span></div>}
    </Sec>
    <Sec title="Timeline">
      <label className="ed-row two"><span>Main magnet</span><input type="checkbox" checked={p.magnet} onChange={e => set({ magnet: e.target.checked })} /></label>
      <label className="ed-row two"><span>Snapping</span><input type="checkbox" checked={p.snap} onChange={e => set({ snap: e.target.checked })} /></label>
    </Sec>
    <div className="ed-note">Select a clip on the timeline to edit it. Tip: double-click text in the player to edit it.</div>
  </>;
}

// ---------------------------------------------------------------- video / image / transform

function VideoTab({ p, c, sub, setSub }: { p: Project; c: Clip; sub: string; setSub: (s: string) => void }) {
  const isMedia = c.type === "video" || c.type === "image";
  const subs: [string, string][] = isMedia ? [["basic", "Basic"], ["cutout", "Remove BG"], ["mask", "Mask"], ["crop", "Crop"], ["chroma", "Chroma key"]] : [["basic", "Basic"]];
  const f = findClip(p, c.id);
  const next = f ? nextAdjacent(f.track, c) : undefined;
  const tf = c.transform ?? defTransform();
  const setTf = (k: keyof typeof tf, v: number | boolean) => live(c.id, cc => ({ transform: { ...(cc.transform ?? defTransform()), [k]: v } }));
  return <>
    {subs.length > 1 && <div className="ed-sub" style={{ padding: "0 0 8px" }}>{subs.map(([k, l]) => <button key={k} className={sub === k ? "on" : ""} onClick={() => setSub(k)}>{l}</button>)}</div>}
    {sub === "basic" && <>
      {c.type === "color" && <Sec title="Colour"><div className="ed-row two"><span>Fill</span><Color value={c.color ?? "#000000"} onChange={v => live(c.id, { color: v })} /></div></Sec>}
      {c.transition && next && <Sec title="Transition" right={<button className="eb icon sm" title="Remove transition" onClick={() => commit(c.id, { transition: null })}><Trash2 size={13} /></button>}>
        <div className="ed-row two"><span>Type</span><select value={c.transition.id} onChange={e => commit(c.id, { transition: { ...c.transition!, id: e.target.value } })}>{TRANSITIONS.map(t => <option key={t.id} value={t.id}>{t.cat} · {t.name}</option>)}</select></div>
        <Row label="Duration" value={c.transition.dur / SEC} min={0.1} max={Math.min(c.dur, next.dur) / SEC} step={0.05} unit="s" onChange={v => live(c.id, { transition: { ...c.transition!, dur: Math.round(v * SEC) } })} />
        <button className="eb sm solid" onClick={() => useEd.getState().commit(pp => { let q = pp; for (const tr of q.tracks) if (tr.id === f!.track.id) for (const x of tr.clips) if (nextAdjacent(tr, x)) q = updateClip(q, x.id, { transition: { ...c.transition!, dur: Math.min(c.transition!.dur, x.dur, nextAdjacent(tr, x)!.dur) } }); return q; })}>Apply to all cuts on this track</button>
      </Sec>}
      <Sec title="Transform" right={<button className="eb icon sm" title="Reset transform" onClick={() => commit(c.id, { transform: defTransform(), keys: { ...c.keys, x: undefined, y: undefined, scale: undefined, rotation: undefined } })}><RotateCcw size={13} /></button>}>
        <KRow c={c} prop="scale" label="Scale" base={tf.scale} min={1} max={500} toUi={v => v * 100} fromUi={v => v / 100} fmt={v => `${Math.round(v)}%`} setBase={v => ({ transform: { ...tf, scale: v } })} reset={100} />
        <KRow c={c} prop="x" label="Position X" base={tf.x} min={-p.width} max={p.width} toUi={v => v * p.width} fromUi={v => v / p.width} fmt={v => `${Math.round(v)}`} setBase={v => ({ transform: { ...tf, x: v } })} reset={0} />
        <KRow c={c} prop="y" label="Position Y" base={tf.y} min={-p.height} max={p.height} toUi={v => v * p.height} fromUi={v => v / p.height} fmt={v => `${Math.round(v)}`} setBase={v => ({ transform: { ...tf, y: v } })} reset={0} />
        <KRow c={c} prop="rotation" label="Rotate" base={tf.rotation} min={-360} max={360} fmt={v => `${Math.round(v)}°`} setBase={v => ({ transform: { ...tf, rotation: v } })} reset={0} />
        <Row label="Stretch X" value={tf.scaleX * 100} min={10} max={300} fmt={v => `${Math.round(v)}%`} onChange={v => setTf("scaleX", v / 100)} reset={100} />
        <Row label="Stretch Y" value={tf.scaleY * 100} min={10} max={300} fmt={v => `${Math.round(v)}%`} onChange={v => setTf("scaleY", v / 100)} reset={100} />
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <button className={`eb sm solid ${tf.flipH ? "on" : ""}`} onClick={() => commit(c.id, { transform: { ...tf, flipH: !tf.flipH } })}>Flip ↔</button>
          <button className={`eb sm solid ${tf.flipV ? "on" : ""}`} onClick={() => commit(c.id, { transform: { ...tf, flipV: !tf.flipV } })}>Flip ↕</button>
          <button className="eb sm solid" title="Fill the canvas" onClick={() => { const m = c.media ? p.media[c.media] : null; if (!m) return; const s = Math.max(p.width / m.width, p.height / m.height) / Math.min(p.width / m.width, p.height / m.height); commit(c.id, { transform: { ...tf, scale: s, x: 0, y: 0 } }); }}>Fill</button>
          <button className="eb sm solid" onClick={() => commit(c.id, { transform: { ...tf, scale: 1, x: 0, y: 0 } })}>Fit</button>
        </div>
      </Sec>
      <Sec title="Blend">
        <KRow c={c} prop="opacity" label="Opacity" base={c.opacity ?? 1} min={0} max={100} toUi={v => v * 100} fromUi={v => v / 100} fmt={v => `${Math.round(v)}%`} setBase={v => ({ opacity: v })} reset={100} />
        <div className="ed-row two"><span>Mode</span><select value={c.blend ?? "normal"} onChange={e => commit(c.id, { blend: e.target.value })}>{BLEND_MODES.map(m => <option key={m} value={m}>{BLEND_LABELS[m]}</option>)}</select></div>
        <KRow c={c} prop="blur" label="Blur" base={0} min={0} max={60} setBase={v => ({ keys: { ...c.keys, blur: setKey(c.keys?.blur, 0, v) } })} />
      </Sec>
      {c.type === "video" && <Sec title="Stabilize" on={!!c.stabilize} onToggle={v => { commit(c.id, { stabilize: v ? 2 : 0 }); if (v && c.media) ensureStabilized(c.media, 2); }}>
        <Seg value={String(c.stabilize ?? 2)} options={[["1", "Light"], ["2", "Recommended"], ["3", "Strong"]]} onChange={v => { commit(c.id, { stabilize: +v }); if (c.media) ensureStabilized(c.media, +v); }} />
        <div className="ed-note">Analyses camera shake with FFmpeg vid.stab (runs in the background, preview updates when done).</div>
      </Sec>}
      {c.type === "video" && <ClipEffects c={c} />}
    </>}
    {sub === "crop" && <CropSec c={c} />}
    {sub === "mask" && <MaskSec c={c} />}
    {sub === "chroma" && <ChromaSec c={c} />}
    {sub === "cutout" && <CutoutSec p={p} c={c} />}
  </>;
}

function ClipEffects({ c }: { c: Clip }) {
  if (!c.effects?.length) return <Sec title="Effects"><div className="ed-note">Add effects from the Effects tab (drop them on the clip or select the clip and click an effect).</div></Sec>;
  return <Sec title="Effects">
    {c.effects.map((fx, i) => { const d = effectById(fx.id); if (!d) return null; return <div key={i} style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}><b style={{ flex: 1 }}>{d.name}</b><button className="eb icon sm" title="Remove" onClick={() => commit(c.id, cc => ({ effects: cc.effects!.filter((_, j) => j !== i) }))}><Trash2 size={13} /></button></div>
      {d.params.map(pr => <Row key={pr.key} label={pr.label} value={fx.params?.[pr.key] ?? pr.def} min={pr.min} max={pr.max} step={pr.step ?? 0.01} onChange={v => live(c.id, cc => ({ effects: cc.effects!.map((x, j) => (j === i ? { ...x, params: { ...x.params, [pr.key]: v } } : x)) }))} reset={pr.def} />)}
    </div>; })}
  </Sec>;
}

function CropSec({ c }: { c: Clip }) {
  const cr = c.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const set = (k: keyof typeof cr, v: number) => live(c.id, cc => { const o = { ...(cc.crop ?? { l: 0, t: 0, r: 0, b: 0 }), [k]: v / 100 }; if (o.l + o.r > 0.95) o[k] = 0.95 - (k === "l" ? o.r : k === "r" ? o.l : 0); if (o.t + o.b > 0.95) o[k] = 0.95 - (k === "t" ? o.b : k === "b" ? o.t : 0); return { crop: o }; });
  const ratio = (rw: number, rh: number) => {
    const m = c.media ? useEd.getState().p!.media[c.media] : null; if (!m) return;
    const sw = m.width, sh = m.height, target = rw / rh;
    if (sw / sh > target) { const w = (sh * target) / sw; commit(c.id, { crop: { l: (1 - w) / 2, r: (1 - w) / 2, t: 0, b: 0 } }); }
    else { const h = sw / target / sh; commit(c.id, { crop: { t: (1 - h) / 2, b: (1 - h) / 2, l: 0, r: 0 } }); }
  };
  return <Sec title="Crop" right={<button className="eb icon sm" title="Reset" onClick={() => commit(c.id, { crop: null })}><RotateCcw size={13} /></button>}>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>{[[16, 9], [9, 16], [1, 1], [4, 3], [3, 4], [4, 5], [21, 9]].map(([a, b]) => <button key={`${a}${b}`} className="eb sm solid" onClick={() => ratio(a, b)}>{a}:{b}</button>)}</div>
    <Row label="Left" value={cr.l * 100} min={0} max={95} onChange={v => set("l", v)} unit="%" reset={0} />
    <Row label="Right" value={cr.r * 100} min={0} max={95} onChange={v => set("r", v)} unit="%" reset={0} />
    <Row label="Top" value={cr.t * 100} min={0} max={95} onChange={v => set("t", v)} unit="%" reset={0} />
    <Row label="Bottom" value={cr.b * 100} min={0} max={95} onChange={v => set("b", v)} unit="%" reset={0} />
  </Sec>;
}

const MASKS: [MaskShape, string][] = [["none", "None"], ["linear", "Linear"], ["mirror", "Mirror"], ["circle", "Circle"], ["rect", "Rectangle"], ["heart", "Heart"], ["star", "Star"]];
function MaskSec({ c }: { c: Clip }) {
  const m = c.mask ?? { shape: "none" as MaskShape, x: 0, y: 0, w: 0.6, h: 0.6, rotation: 0, feather: 5, invert: false, round: 0 };
  const set = (patch: Partial<typeof m>) => live(c.id, { mask: { ...m, ...patch } });
  return <Sec title="Mask">
    <div className="ed-tiles" style={{ marginBottom: 10 }}>{MASKS.map(([k, l]) => <button key={k} className={m.shape === k ? "on" : ""} onClick={() => commit(c.id, { mask: k === "none" ? null : { ...m, shape: k } })}>{l}</button>)}</div>
    {m.shape !== "none" && <>
      <Row label="Position X" value={m.x * 100} min={-50} max={50} onChange={v => set({ x: v / 100 })} reset={0} />
      <Row label="Position Y" value={m.y * 100} min={-50} max={50} onChange={v => set({ y: v / 100 })} reset={0} />
      {m.shape !== "linear" && <><Row label="Width" value={m.w * 100} min={1} max={150} onChange={v => set({ w: v / 100 })} reset={60} />
        <Row label="Height" value={m.h * 100} min={1} max={150} onChange={v => set({ h: v / 100 })} reset={60} /></>}
      <Row label="Rotate" value={m.rotation} min={-180} max={180} onChange={v => set({ rotation: v })} unit="°" reset={0} />
      <Row label="Feather" value={m.feather} min={0} max={100} onChange={v => set({ feather: v })} reset={5} />
      {m.shape === "rect" && <Row label="Round" value={m.round} min={0} max={100} onChange={v => set({ round: v })} reset={0} />}
      <label className="ed-row two"><span>Invert</span><input type="checkbox" checked={m.invert} onChange={e => commit(c.id, { mask: { ...m, invert: e.target.checked } })} /></label>
    </>}
  </Sec>;
}

function ChromaSec({ c }: { c: Clip }) {
  const k = c.chroma ?? { on: false, color: "#00ff00", strength: 40, shadow: 20 };
  return <Sec title="Chroma key" on={k.on} onToggle={v => commit(c.id, { chroma: { ...k, on: v } })}>
    <div className="ed-row two"><span>Key colour</span><div style={{ display: "flex", gap: 6 }}>{["#00ff00", "#00b140", "#0047bb"].map(col => <button key={col} className="ed-swatch" style={{ background: col, outline: k.color === col ? "2px solid var(--e-acc)" : undefined }} onClick={() => commit(c.id, { chroma: { ...k, color: col } })} />)}<Color value={k.color} onChange={v => live(c.id, { chroma: { ...k, color: v } })} /></div></div>
    <Row label="Strength" value={k.strength} min={0} max={100} onChange={v => live(c.id, { chroma: { ...k, strength: v } })} reset={40} />
    <Row label="Edge" value={k.shadow} min={0} max={100} onChange={v => live(c.id, { chroma: { ...k, shadow: v } })} reset={20} />
  </Sec>;
}

function CutoutSec({ p, c }: { p: Project; c: Clip }) {
  const m = c.media ? p.media[c.media] : undefined;
  const st = matteState(c.media ?? "");
  return <Sec title="Remove background" on={!!c.cutout} onToggle={v => { commit(c.id, { cutout: v }); if (v && c.media && !m?.matte) void ensureMatte(c.media); }}>
    <div className="ed-note">AI cutout with Robust Video Matting (people) or IS-Net (objects in photos). Runs on your GPU, no green screen needed. Files stay on this PC.</div>
    {st && <div><div className="ed-bar"><div style={{ width: `${Math.round(st.progress * 100)}%` }} /></div><div className="ed-note">{st.label}</div></div>}
    {m?.matte && <div className="ed-note" style={{ color: "#5be3a0" }}>Cutout ready.</div>}
    {c.media && <button className="eb sm solid" onClick={() => ensureMatte(c.media!, true)}>Re-run cutout</button>}
  </Sec>;
}

// ---------------------------------------------------------------- audio

function AudioTab({ p, c }: { p: Project; c: Clip }) {
  const [voices, setVoices] = useState<[string, string][]>([]);
  useEffect(() => { ed.voices().then(setVoices).catch(() => {}); }, []);
  const m = c.media ? p.media[c.media] : undefined;
  const fx = c.fx ?? { voice: "", denoise: false, normalize: false, enhance: false };
  const setFx = (patch: Partial<typeof fx>) => { const n = { ...fx, ...patch }; commit(c.id, { fx: n }); if (c.media) ensureAudioFx(c.media, n); };
  if (m && !m.has_audio) return <div className="ed-note">This clip has no audio.</div>;
  const prep = useEd.getState().prep;
  const processing = Object.entries(prep).some(([k]) => k.startsWith(`${c.media}:fx`));
  return <>
    <Sec title="Basic">
      <KRow c={c} prop="volume" label="Volume" base={c.volume ?? 1} min={0} max={400} toUi={v => v * 100} fromUi={v => v / 100} fmt={v => db(v / 100)} setBase={v => ({ volume: v })} reset={100} />
      <Row label="Fade in" value={(c.fadeIn ?? 0) / SEC} min={0} max={Math.min(10, c.dur / SEC)} step={0.1} unit="s" onChange={v => live(c.id, { fadeIn: Math.round(v * SEC) })} reset={0} />
      <Row label="Fade out" value={(c.fadeOut ?? 0) / SEC} min={0} max={Math.min(10, c.dur / SEC)} step={0.1} unit="s" onChange={v => live(c.id, { fadeOut: Math.round(v * SEC) })} reset={0} />
      <label className="ed-row two"><span>Mute</span><input type="checkbox" checked={!!c.mute} onChange={e => commit(c.id, { mute: e.target.checked })} /></label>
    </Sec>
    <Sec title="Enhance">
      <label className="ed-row two"><span>Reduce noise</span><input type="checkbox" checked={fx.denoise} onChange={e => setFx({ denoise: e.target.checked })} /></label>
      <label className="ed-row two"><span>Enhance voice</span><input type="checkbox" checked={fx.enhance} onChange={e => setFx({ enhance: e.target.checked })} /></label>
      <label className="ed-row two"><span>Normalize loudness</span><input type="checkbox" checked={fx.normalize} onChange={e => setFx({ normalize: e.target.checked })} /></label>
      {processing && <div className="ed-note">Processing audio… the preview switches to the processed sound when it's ready.</div>}
    </Sec>
    <Sec title="Voice changer">
      <div className="ed-tiles">{[["", "None"] as [string, string], ...voices].map(([id, name]) => <button key={id || "none"} className={fx.voice === id ? "on" : ""} onClick={() => setFx({ voice: id })}>{name}</button>)}</div>
    </Sec>
  </>;
}

// ---------------------------------------------------------------- speed

function SpeedTab({ p, c }: { p: Project; c: Clip }) {
  const [mode, setMode] = useState<"normal" | "curve">(c.curve ? "curve" : "normal");
  const s = c.speed ?? 1;
  const toUi = (v: number) => Math.log(v) / Math.log(100) * 50 + 50; // 0.01..100 log
  const fromUi = (u: number) => Math.pow(100, (u - 50) / 50);
  return <>
    <Seg value={mode} options={[["normal", "Normal"], ["curve", "Curve"]]} onChange={setMode} />
    {mode === "normal" && <Sec title="Speed">
      <Row label="Speed" value={toUi(s)} min={toUi(0.1)} max={100} step={0.5} fmt={u => `${fromUi(u).toFixed(2)}×`} onChange={u => useEd.getState().live(pp => setSpeed(pp, c.id, Math.round(fromUi(u) * 100) / 100))} reset={50} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{[0.25, 0.5, 1, 1.5, 2, 3, 5, 10].map(v => <button key={v} className={`eb sm solid ${Math.abs(s - v) < 0.001 && !c.curve ? "on" : ""}`} onClick={() => useEd.getState().commit(pp => setSpeed(updateClip(pp, c.id, { curve: null }), c.id, v))}>{v}×</button>)}</div>
      <div className="ed-row two" style={{ marginTop: 10 }}><span>Duration</span><span>{(c.dur / SEC).toFixed(2)} s (source {(srcSpan(c) / SEC).toFixed(2)} s)</span></div>
      <label className="ed-row two"><span>Keep pitch</span><input type="checkbox" checked={c.keepPitch ?? true} onChange={e => commit(c.id, { keepPitch: e.target.checked })} /></label>
    </Sec>}
    {mode === "curve" && <Sec title="Speed curve">
      <div className="ed-tiles">{[["none", "None"] as [string, string], ...Object.entries(CURVES).map(([k, v]) => [k, v.label] as [string, string])].map(([k, l]) =>
        <button key={k} className={(c.curve?.id ?? "none") === k ? "on" : ""} onClick={() => commit(c.id, { curve: k === "none" ? null : { id: k, pts: CURVES[k].pts } })}>{l}</button>)}</div>
      <div className="ed-note">Curves ramp the speed smoothly over the clip (preview plays curves by seeking; export is frame-exact).</div>
    </Sec>}
    <div className="ed-note">Frame: {(frameUs(p) / 1000).toFixed(2)} ms.</div>
  </>;
}

// ---------------------------------------------------------------- animation

function AnimTab({ c }: { c: Clip }) {
  const [kind, setKind] = useState<"in" | "out" | "loop">("in");
  const isText = c.type === "text" || c.type === "caption";
  const list = ANIMS.filter(a => a.kinds.includes(kind) && (!a.text || isText));
  const cur = kind === "in" ? c.animIn : kind === "out" ? c.animOut : c.animLoop;
  const key = kind === "in" ? "animIn" : kind === "out" ? "animOut" : "animLoop";
  return <>
    <Seg value={kind} options={[["in", "In"], ["out", "Out"], ["loop", "Combo / loop"]]} onChange={setKind} />
    <div className="ed-tiles" style={{ marginTop: 10 }}>
      <button className={!cur ? "on" : ""} onClick={() => commit(c.id, { [key]: null } as Partial<Clip>)}>None</button>
      {list.map(a => <button key={a.id} className={cur?.id === a.id ? "on" : ""} onClick={() => commit(c.id, { [key]: { id: a.id, dur: cur?.dur ?? (kind === "loop" ? SEC : Math.min(600_000, c.dur / 2)) } } as Partial<Clip>)}>{a.name}</button>)}
    </div>
    {cur && <Sec title={kind === "loop" ? "Speed" : "Duration"}>
      <Row label={kind === "loop" ? "Cycle" : "Duration"} value={cur.dur / SEC} min={0.1} max={kind === "loop" ? 5 : Math.max(0.1, c.dur / SEC)} step={0.05} unit="s" onChange={v => live(c.id, { [key]: { ...cur, dur: Math.round(v * SEC) } } as Partial<Clip>)} />
    </Sec>}
  </>;
}

// ---------------------------------------------------------------- adjust (colour)

const ADJ_LABEL: Record<keyof Adjust, string> = { exposure: "Exposure", brightness: "Brightness", contrast: "Contrast", saturation: "Saturation", vibrance: "Vibrance", temperature: "Temperature", tint: "Tint", highlights: "Highlights", shadows: "Shadows", hue: "Hue", sharpen: "Sharpen", vignette: "Vignette", grain: "Grain", fade: "Fade" };
function AdjustTab({ c }: { c: Clip }) {
  const a = c.adjust ?? {};
  const keyed: Partial<Record<keyof Adjust, KeyProp>> = { brightness: "brightness", contrast: "contrast", saturation: "saturation", exposure: "exposure", temperature: "temperature" };
  return <>
    {c.type !== "adjust" && <Sec title="Filter" right={c.filter && <button className="eb icon sm" title="Remove filter" onClick={() => commit(c.id, { filter: null })}><Trash2 size={13} /></button>}>
      <div className="ed-row two"><span>Filter</span><select value={c.filter?.id ?? ""} onChange={e => commit(c.id, { filter: e.target.value ? { id: e.target.value, amount: c.filter?.amount ?? 100 } : null })}><option value="">None</option>{FILTERS.map(f => <option key={f.id} value={f.id}>{f.cat} · {f.name}</option>)}</select></div>
      {c.filter && <Row label="Intensity" value={c.filter.amount} min={0} max={100} onChange={v => live(c.id, { filter: { ...c.filter!, amount: v } })} reset={100} />}
    </Sec>}
    <Sec title="Adjust" right={<button className="eb icon sm" title="Reset all" onClick={() => commit(c.id, { adjust: {} })}><RotateCcw size={13} /></button>}>
      {ADJUST_KEYS.map(k => keyed[k]
        ? <KRow key={k} c={c} prop={keyed[k]!} label={ADJ_LABEL[k]} base={a[k] ?? 0} min={k === "sharpen" || k === "grain" || k === "fade" ? 0 : -100} max={100} setBase={v => ({ adjust: { ...a, [k]: v } })} reset={0} />
        : <Row key={k} label={ADJ_LABEL[k]} value={a[k] ?? 0} min={k === "sharpen" || k === "grain" || k === "fade" ? 0 : -100} max={100} onChange={v => live(c.id, cc => ({ adjust: { ...cc.adjust, [k]: v } }))} reset={0} />)}
    </Sec>
  </>;
}

// ---------------------------------------------------------------- text

let fontCache: string[] | null = null;
function useFonts() {
  const [f, setF] = useState<string[]>(fontCache ?? BUNDLED_FONTS);
  useEffect(() => {
    if (fontCache) return;
    ed.fonts().then(list => {
      const sys = [...new Set(list.map(x => x.family))];
      // register system fonts so canvas can use them
      for (const x of list) { try { const ff = new FontFace(x.family, `url("${encodeURI(convertSrc(x.path))}")`, { weight: /bold|black|heavy/i.test(x.style) ? "700 900" : "100 600", style: /italic|oblique/i.test(x.style) ? "italic" : "normal" }); document.fonts.add(ff); } catch { /* */ } }
      fontCache = [...BUNDLED_FONTS, ...sys.filter(s => !BUNDLED_FONTS.includes(s))]; setF(fontCache);
    }).catch(() => {});
  }, []);
  return f;
}
import { convertFileSrc as convertSrc } from "@tauri-apps/api/core";

function TextTab({ c }: { c: Clip }) {
  const fonts = useFonts();
  const st = c.text ?? defTextStyle();
  const setT = (patch: Partial<TextStyle>, now = false) => (now ? commit : live)(c.id, cc => ({ text: { ...(cc.text ?? defTextStyle()), ...patch }, name: patch.text !== undefined ? patch.text.slice(0, 40) : cc.name }));
  const ta = useRefFocus();
  return <>
    <Sec title="Text">
      <textarea ref={ta} value={st.text} rows={3} style={{ width: "100%", resize: "vertical" }} onChange={e => setT({ text: e.target.value })} onBlur={end} />
      <div className="ed-row two"><span>Font</span><select value={st.font} onChange={e => { setT({ font: e.target.value }, true); void document.fonts.load(`800 40px "${e.target.value}"`).then(() => window.dispatchEvent(new Event("msp-redraw"))); }} style={{ fontFamily: st.font }}>
        {fonts.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}</select></div>
      <Row label="Size" value={st.size} min={8} max={400} onChange={v => setT({ size: v })} reset={72} />
      <div className="ed-row two"><span>Style</span><div style={{ display: "flex", gap: 4 }}>
        <button className={`eb icon sm solid ${st.bold ? "on" : ""}`} onClick={() => setT({ bold: !st.bold }, true)}><Bold size={14} /></button>
        <button className={`eb icon sm solid ${st.italic ? "on" : ""}`} onClick={() => setT({ italic: !st.italic }, true)}><Italic size={14} /></button>
        <button className={`eb icon sm solid ${st.underline ? "on" : ""}`} onClick={() => setT({ underline: !st.underline }, true)}><Underline size={14} /></button>
        <Seg value={st.caseMode} options={[["none", "Aa"], ["upper", "AA"], ["lower", "aa"]]} onChange={v => setT({ caseMode: v }, true)} />
      </div></div>
      <div className="ed-row two"><span>Align</span><Seg value={st.align} options={[["left", "Left"], ["center", "Center"], ["right", "Right"]]} onChange={v => setT({ align: v }, true)} /></div>
      <div className="ed-row two"><span>Colour</span><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{["#ffffff", "#000000", "#ffe14d", "#ff3b6b", "#22d3ee", "#22e36b", "#a855f7", "#ff8a00"].map(col =>
        <button key={col} className="ed-swatch" style={{ background: col, outline: st.color === col ? "2px solid var(--e-acc)" : undefined }} onClick={() => setT({ color: col, gradient: { ...st.gradient, on: false } }, true)} />)}<Color value={st.color} onChange={v => setT({ color: v })} /></div></div>
      <Row label="Letter spacing" value={st.letterSpacing} min={-10} max={60} onChange={v => setT({ letterSpacing: v })} reset={0} />
      <Row label="Line height" value={st.lineHeight * 100} min={70} max={250} onChange={v => setT({ lineHeight: v / 100 })} unit="%" reset={115} />
      <Row label="Max width" value={st.maxWidth * 100} min={10} max={100} onChange={v => setT({ maxWidth: v / 100 })} unit="%" reset={86} />
    </Sec>
    <Sec title="Stroke" on={st.stroke.on} onToggle={v => setT({ stroke: { ...st.stroke, on: v } }, true)}>
      <div className="ed-row two"><span>Colour</span><Color value={st.stroke.color} onChange={v => setT({ stroke: { ...st.stroke, color: v } })} /></div>
      <Row label="Width" value={st.stroke.width} min={1} max={40} onChange={v => setT({ stroke: { ...st.stroke, width: v } })} />
    </Sec>
    <Sec title="Background" on={st.background.on} onToggle={v => setT({ background: { ...st.background, on: v } }, true)}>
      <div className="ed-row two"><span>Colour</span><Color value={st.background.color} onChange={v => setT({ background: { ...st.background, color: v } })} /></div>
      <Row label="Opacity" value={st.background.opacity * 100} min={0} max={100} onChange={v => setT({ background: { ...st.background, opacity: v / 100 } })} unit="%" />
      <Row label="Round" value={st.background.radius} min={0} max={80} onChange={v => setT({ background: { ...st.background, radius: v } })} />
      <Row label="Padding" value={st.background.padding} min={0} max={80} onChange={v => setT({ background: { ...st.background, padding: v } })} />
    </Sec>
    <Sec title="Shadow / glow" on={st.shadow.on} onToggle={v => setT({ shadow: { ...st.shadow, on: v } }, true)}>
      <div className="ed-row two"><span>Colour</span><Color value={st.shadow.color} onChange={v => setT({ shadow: { ...st.shadow, color: v } })} /></div>
      <Row label="Blur" value={st.shadow.blur} min={0} max={80} onChange={v => setT({ shadow: { ...st.shadow, blur: v } })} />
      <Row label="Distance" value={st.shadow.y} min={-40} max={40} onChange={v => setT({ shadow: { ...st.shadow, y: v } })} />
      <Row label="Opacity" value={st.shadow.opacity * 100} min={0} max={100} onChange={v => setT({ shadow: { ...st.shadow, opacity: v / 100 } })} unit="%" />
    </Sec>
    <Sec title="Gradient" on={st.gradient.on} onToggle={v => setT({ gradient: { ...st.gradient, on: v } }, true)}>
      <div className="ed-row two"><span>Colours</span><div style={{ display: "flex", gap: 6 }}><Color value={st.gradient.from} onChange={v => setT({ gradient: { ...st.gradient, from: v } })} /><Color value={st.gradient.to} onChange={v => setT({ gradient: { ...st.gradient, to: v } })} /></div></div>
      <Row label="Angle" value={st.gradient.angle} min={0} max={360} onChange={v => setT({ gradient: { ...st.gradient, angle: v } })} unit="°" />
    </Sec>
    <Sec title="Presets">
      <div className="ed-tiles">{TEXT_PRESETS.map(pr => <button key={pr.id} onClick={() => commit(c.id, cc => ({ text: { ...defTextStyle(pr.style), text: cc.text?.text ?? "Text", highlight: cc.text?.highlight ?? "#ffe14d", highlightMode: cc.text?.highlightMode ?? "none" } }))} style={{ fontFamily: pr.style.font, fontSize: 12 }}>{pr.name}</button>)}</div>
    </Sec>
  </>;
}
import { useRef } from "react";
function useRefFocus() {
  const r = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const h = () => { r.current?.focus(); r.current?.select(); }; window.addEventListener("msp-edit-text", h); return () => window.removeEventListener("msp-edit-text", h); }, []);
  return r;
}

function CaptionTab({ p, c }: { p: Project; c: Clip }) {
  const st = c.text ?? defTextStyle();
  const all = p.tracks.flatMap(t => t.clips.filter(x => x.type === "caption"));
  const applyAll = (patch: (s: TextStyle) => TextStyle) => useEd.getState().commit(pp => all.reduce((q, x) => updateClip(q, x.id, cc => ({ text: patch(cc.text ?? defTextStyle()) })), pp));
  return <>
    <Sec title="Word highlight">
      <Seg value={st.highlightMode} options={[["none", "Off"], ["color", "Colour"], ["box", "Box"], ["scale", "Pop"], ["reveal", "Reveal"]]} onChange={v => commit(c.id, { text: { ...st, highlightMode: v } })} />
      <div className="ed-row two" style={{ marginTop: 8 }}><span>Highlight</span><Color value={st.highlight} onChange={v => live(c.id, { text: { ...st, highlight: v } })} /></div>
      <div className="ed-note">{c.words?.length ? `${c.words.length} timed words.` : "No word timings (typed caption) — highlight follows the clip evenly."}</div>
    </Sec>
    <Sec title={`All captions (${all.length})`}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="eb sm solid" onClick={() => applyAll(s => ({ ...st, text: s.text }))}>Apply this style to all</button>
        <button className="eb sm solid" onClick={() => useEd.getState().commit(pp => all.reduce((q, x) => updateClip(q, x.id, { transform: { ...(x.transform ?? defTransform()), x: c.transform?.x ?? 0, y: c.transform?.y ?? 0, scale: c.transform?.scale ?? 1 } }), pp))}>Apply position to all</button>
      </div>
      <div className="ed-tiles" style={{ marginTop: 10 }}>{CAPTION_STYLES.map(cs => <button key={cs.id} style={{ fontFamily: cs.style.font }} onClick={() => applyAll(s => ({ ...defTextStyle(cs.style), text: s.text }))}>{cs.name}</button>)}</div>
    </Sec>
  </>;
}

function StickerTab({ c }: { c: Clip }) {
  return <Sec title="Sticker">
    {c.sticker?.shape && <div className="ed-row two"><span>Colour</span><Color value={c.sticker.color ?? "#ffd23f"} onChange={v => live(c.id, { sticker: { ...c.sticker, color: v } })} /></div>}
    <KRow c={c} prop="opacity" label="Opacity" base={c.opacity ?? 1} min={0} max={100} toUi={v => v * 100} fromUi={v => v / 100} fmt={v => `${Math.round(v)}%`} setBase={v => ({ opacity: v })} reset={100} />
    <div className="ed-note">Move, scale and rotate the sticker directly in the player.</div>
  </Sec>;
}

function EffectClipTab({ c }: { c: Clip }) {
  const d = c.effect ? effectById(c.effect.id) : undefined;
  return <Sec title={d?.name ?? "Effect"}>
    <div className="ed-row two"><span>Effect</span><select value={c.effect?.id ?? ""} onChange={e => commit(c.id, { effect: { id: e.target.value }, name: effectById(e.target.value)?.name })}>{EFFECTS.map(x => <option key={x.id} value={x.id}>{x.cat} · {x.name}</option>)}</select></div>
    {d?.params.map(pr => <Row key={pr.key} label={pr.label} value={c.effect?.params?.[pr.key] ?? pr.def} min={pr.min} max={pr.max} step={pr.step ?? 0.01} onChange={v => live(c.id, cc => ({ effect: { ...cc.effect!, params: { ...cc.effect!.params, [pr.key]: v } } }))} reset={pr.def} />)}
    <div className="ed-note">Effect clips apply to everything on the tracks below them, for as long as the clip lasts.</div>
  </Sec>;
}

function FilterClipTab({ c }: { c: Clip }) {
  const f = c.filter ? filterById(c.filter.id) : undefined;
  return <Sec title={f?.name ?? "Filter"}>
    <div className="ed-row two"><span>Filter</span><select value={c.filter?.id ?? ""} onChange={e => commit(c.id, { filter: { id: e.target.value, amount: c.filter?.amount ?? 100 }, name: filterById(e.target.value)?.name })}>{FILTERS.map(x => <option key={x.id} value={x.id}>{x.cat} · {x.name}</option>)}</select></div>
    {c.filter && <Row label="Intensity" value={c.filter.amount} min={0} max={100} onChange={v => live(c.id, { filter: { ...c.filter!, amount: v } })} reset={100} />}
  </Sec>;
}

void transitionById; void pct;
