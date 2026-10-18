import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ArrowLeftToLine, ArrowRightToLine, AudioLines, Bookmark, Copy, Crop, Eye, EyeOff, FlipHorizontal2, Image as ImageIcon, Layers, Lock, Magnet, Minus, MousePointer2, Music, Plus,
  Redo2, RotateCw, Rewind, Scissors, Snowflake, Sparkles, SquareSplitHorizontal, Trash2, Type, Undo2, Unlock, Video, Volume2, VolumeX, Wand2, ZoomIn,
} from "lucide-react";
import { useMenu } from "../../components/ui";
import { ed, Filmstrip } from "../api";
import {
  addClips, Clip, deleteClips, duplicateClip, end, findClip, frameUs, moveClip, nextAdjacent, Project, SEC, snap, sourceTime, splitAt, srcSpan, toFrame, Track, trackFor, trimClip, trimToPlayhead, uid, updateClip, updateTrack, US,
} from "../model";
import { clipForMedia, ensureReversed, importPaths, notify, useEd } from "../store";
import { tc } from "./Player";
import { RecordButton } from "./Record";

const LANE_H: Record<string, number> = { main: 66, video: 54, audio: 48, text: 32, effect: 30, filter: 30, adjust: 30 };
export const laneH = (t: Track) => (t.main ? LANE_H.main : LANE_H[t.kind] ?? 40);
const COLORS: Record<string, string> = { video: "var(--c-video)", image: "var(--c-image)", audio: "var(--c-audio)", text: "var(--c-text)", caption: "var(--c-caption)", sticker: "var(--c-sticker)", effect: "var(--c-effect)", filter: "var(--c-filter)", adjust: "var(--c-adjust)", color: "var(--c-color)" };

// ---------------------------------------------------------------- media visuals (cached per file)
const strips = new Map<string, Promise<Filmstrip | null>>();
const waves = new Map<string, Promise<Uint8Array | null>>();
function stripFor(path: string, dur: number, w: number, h: number) { let s = strips.get(path); if (!s) { s = ed.filmstrip(path, dur, w, h).catch(() => null); strips.set(path, s); } return s; }
function waveFor(path: string) { let s = waves.get(path); if (!s) { s = ed.waveform(path).then(b => new Uint8Array(b)).catch(() => null); waves.set(path, s); } return s; }
export function useStrip(path: string | undefined, dur: number, w: number, h: number) {
  const [fs, setFs] = useState<Filmstrip | null>(null);
  useEffect(() => { let ok = true; if (path) void stripFor(path, dur, w, h).then(f => { if (ok) setFs(f); }); return () => { ok = false; }; }, [path, dur, w, h]);
  return fs;
}

export function Timeline() {
  const p = useEd(s => s.p)!;
  const sel = useEd(s => s.sel), zoom = useEd(s => s.zoom), playing = useEd(s => s.playing), canUndo = useEd(s => s.canUndo), canRedo = useEd(s => s.canRedo);
  const lanes = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, w: 1000, y: 0 });
  const [snapX, setSnapX] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ track: string | null; t: US } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pxPerUs = zoom / SEC;
  const dur = Math.max(p.tracks.reduce((m, t) => Math.max(m, ...t.clips.map(end), 0), 0), 10 * SEC);
  const totalW = Math.max(view.w, (dur + 30 * SEC) * pxPerUs);
  const xOf = (t: US) => t * pxPerUs;
  const tOf = (x: number) => Math.max(0, x / pxPerUs);

  useLayoutEffect(() => {
    const el = lanes.current!; const ro = new ResizeObserver(() => setView(v => ({ ...v, w: el.clientWidth }))); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep the playhead in view while playing
  const t = useEd(s => s.t);
  useEffect(() => {
    const el = lanes.current; if (!el || !playing) return;
    const x = xOf(t); if (x > el.scrollLeft + el.clientWidth - 60) el.scrollLeft = x - 80; else if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
  }, [t, playing]); // eslint-disable-line

  // ctrl+wheel zooms around the pointer
  useEffect(() => {
    const el = lanes.current!; const w = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) { if (e.shiftKey) { el.scrollLeft += e.deltaY; e.preventDefault(); } return; }
      e.preventDefault();
      const r = el.getBoundingClientRect(), mx = e.clientX - r.left + el.scrollLeft, tm = mx / (useEd.getState().zoom / SEC);
      const nz = Math.max(4, Math.min(1200, useEd.getState().zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
      useEd.getState().setZoom(nz); requestAnimationFrame(() => { el.scrollLeft = tm * (nz / SEC) - (e.clientX - r.left); });
    };
    el.addEventListener("wheel", w, { passive: false }); return () => el.removeEventListener("wheel", w);
  }, []);

  const cmd = useCommands();
  const fit = () => { const el = lanes.current!; const d = Math.max(1 * SEC, p.tracks.reduce((m, tr) => Math.max(m, ...tr.clips.map(end), 0), 0)); useEd.getState().setZoom(((el.clientWidth - 60) / d) * SEC); el.scrollLeft = 0; };

  // ---- scrub on the ruler / empty lane space
  const scrub = (e: React.PointerEvent) => {
    const el = lanes.current!; const r = el.getBoundingClientRect();
    const set = (cx: number) => { const tt = tOf(cx - r.left + el.scrollLeft); useEd.getState().seek(p.snap ? snap(useEd.getState().p!, tt, 6 / pxPerUs, []) : tt); };
    useEd.getState().setPlaying(false); set(e.clientX);
    const mv = (ev: PointerEvent) => set(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };

  // ---- marquee select on empty lane area
  const laneDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".ed-clip,.ed-trans")) return;
    const el = lanes.current!; const r = el.getBoundingClientRect();
    const x0 = e.clientX - r.left + el.scrollLeft, y0 = e.clientY - r.top + el.scrollTop;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      const x1 = ev.clientX - r.left + el.scrollLeft, y1 = ev.clientY - r.top + el.scrollTop;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 5) return; moved = true;
      setMarquee({ x0, y0, x1, y1 });
      const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
      const ids: string[] = []; let y = 26;
      for (const tr of useEd.getState().p!.tracks) { const h = laneH(tr); if (y + h > ay && y < by) for (const c of tr.clips) if (xOf(end(c)) > ax && xOf(c.start) < bx) ids.push(c.id); y += h; }
      useEd.getState().select(ids, ev.ctrlKey ? "add" : "set");
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); setMarquee(null);
      if (!moved) { useEd.getState().select([]); useEd.getState().setPlaying(false); useEd.getState().seek(tOf(ev.clientX - r.left + el.scrollLeft)); }
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };

  // ---- drag & drop from the media / assets panels
  const laneAt = (clientY: number): Track | null => {
    const el = lanes.current!; const y = clientY - el.getBoundingClientRect().top + el.scrollTop - 26;
    let acc = 0; for (const tr of p.tracks) { const h = laneH(tr); if (y >= acc && y < acc + h) return tr; acc += h; } return null;
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-msp")) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    const el = lanes.current!; const tt = tOf(e.clientX - el.getBoundingClientRect().left + el.scrollLeft);
    const tr = laneAt(e.clientY);
    setDrop({ track: tr?.id ?? null, t: snap(p, tt, 8 / pxPerUs) });
  };
  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData("application/x-msp"); setDrop(null); if (!raw) return; e.preventDefault();
    const el = lanes.current!; const tt = snap(p, tOf(e.clientX - el.getBoundingClientRect().left + el.scrollLeft), 8 / pxPerUs);
    const tr = laneAt(e.clientY);
    const item = JSON.parse(raw) as { clip?: Clip; media?: string; transition?: string };
    if (item.transition) {
      // dropped on a cut: attach to the clip ending nearest the drop point
      if (!tr) return;
      const a = tr.clips.filter(c => nextAdjacent(tr, c)).sort((x, y) => Math.abs(end(x) - tt) - Math.abs(end(y) - tt))[0];
      if (a) useEd.getState().commit(pp => updateClip(pp, a.id, { transition: { id: item.transition!, dur: Math.min(a.dur, nextAdjacent(tr, a)!.dur, 600_000) } }));
      return;
    }
    let clip = item.clip ? { ...item.clip, id: uid() } : null;
    if (item.media) { const m = p.media[item.media]; if (m) clip = clipForMedia(m); }
    if (!clip) return;
    const kind = trackFor(clip.type);
    const toMain = !!tr?.main && kind === "video";
    const target = tr && tr.kind === kind ? tr.id : undefined;
    useEd.getState().commit(pp => addClips(pp, [clip!], { at: tt, trackId: target, toMain: toMain || (kind === "video" && !target && !pp.tracks.find(x => x.main)?.clips.length) }));
    useEd.getState().select([clip.id]);
  };

  // ---- clip drag (move / trim)
  const dragClip = (e: React.PointerEvent, c: Clip, mode: "move" | "l" | "r") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = useEd.getState();
    if (e.ctrlKey || e.metaKey) { st.select([c.id], "toggle"); return; }
    if (e.shiftKey) { st.select([c.id], "add"); return; }
    if (!st.sel.includes(c.id)) st.select([c.id]);
    const p0 = st.p!, f0 = findClip(p0, c.id); if (!f0 || f0.track.lock) return;
    const el = lanes.current!; const r = el.getBoundingClientRect();
    const x0 = e.clientX; let moved = false;
    const tol = 8 / pxPerUs;
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0; if (!moved && Math.abs(dx) < 3) return; moved = true;
      const dt = dx / pxPerUs;
      if (mode === "move") {
        let ns = c.start + dt;
        const s1 = p0.snap ? snap(p0, ns, tol, [c.id], [useEd.getState().t]) : ns, s2 = p0.snap ? snap(p0, ns + c.dur, tol, [c.id], [useEd.getState().t]) - c.dur : ns;
        if (s1 !== ns) { ns = s1; setSnapX(xOf(s1)); } else if (s2 !== ns) { ns = s2; setSnapX(xOf(s2 + c.dur)); } else setSnapX(null);
        const over = laneAt(ev.clientY);
        const target = over && over.kind === f0.track.kind ? over.id : f0.track.id;
        st.live(() => moveClip(p0, c.id, ns, target));
      } else {
        let nt = mode === "l" ? c.start + dt : end(c) + dt;
        const s = p0.snap ? snap(p0, nt, tol, [c.id], [useEd.getState().t]) : nt; if (s !== nt) { nt = s; setSnapX(xOf(s)); } else setSnapX(null);
        st.live(() => trimClip(p0, c.id, mode === "l" ? "start" : "end", nt));
      }
      if (ev.clientX > r.right - 30) el.scrollLeft += 12; else if (ev.clientX < r.left + 30) el.scrollLeft -= 12;
    };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); setSnapX(null); if (moved) st.endLive(); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };

  const menu = (e: React.MouseEvent, c: Clip) => {
    e.preventDefault(); e.stopPropagation();
    if (!useEd.getState().sel.includes(c.id)) useEd.getState().select([c.id]);
    const isAv = c.type === "video" || c.type === "audio";
    useMenu.getState().show(e.clientX, e.clientY, [
      { label: "Split", keys: "Ctrl+B", icon: <Scissors size={14} />, run: cmd.split },
      { label: "Delete", keys: "Del", icon: <Trash2 size={14} />, run: cmd.del },
      { label: "Duplicate", keys: "Ctrl+D", icon: <Copy size={14} />, run: cmd.duplicate },
      { label: "Copy", keys: "Ctrl+C", run: cmd.copy }, { label: "Paste at playhead", keys: "Ctrl+V", run: cmd.paste, disabled: !clipboard.length },
      { sep: true },
      { label: "Extract audio", icon: <Music size={14} />, run: cmd.extractAudio, hidden: c.type !== "video" },
      { label: c.reverse ? "Un-reverse" : "Reverse", icon: <Rewind size={14} />, run: cmd.reverse, hidden: c.type !== "video" },
      { label: "Freeze frame", icon: <Snowflake size={14} />, run: cmd.freeze, hidden: c.type !== "video" },
      { label: "Mirror", icon: <FlipHorizontal2 size={14} />, run: cmd.mirror, hidden: !["video", "image", "sticker", "text"].includes(c.type) },
      { label: "Rotate 90°", icon: <RotateCw size={14} />, run: cmd.rotate, hidden: !["video", "image", "sticker", "text"].includes(c.type) },
      { label: c.mute ? "Unmute clip" : "Mute clip", icon: <VolumeX size={14} />, run: () => useEd.getState().commit(pp => updateClip(pp, c.id, { mute: !c.mute })), hidden: !isAv },
      { label: "Speed 2×", run: () => cmd.speed(2), hidden: !isAv }, { label: "Speed 0.5×", run: () => cmd.speed(0.5), hidden: !isAv },
      { sep: true },
      { label: "Add transition", icon: <Sparkles size={14} />, run: () => useEd.getState().setLeft("transitions"), hidden: c.type !== "video" && c.type !== "image" },
      { label: "Add marker", keys: "M", icon: <Bookmark size={14} />, run: cmd.marker },
    ]);
  };

  // ---- layout
  let y = 0;
  const rows = p.tracks.map(tr => { const r = { tr, y, h: laneH(tr) }; y += r.h; return r; });
  const totalH = y;
  const vis0 = view.x - 200, vis1 = view.x + view.w + 200;

  return (
    <div className="ed-tl">
      <div className="ed-tbar">
        <button className="eb icon sm on" title="Select (V)"><MousePointer2 size={15} /></button>
        <button className="eb icon sm" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => useEd.getState().undo()}><Undo2 size={15} /></button>
        <button className="eb icon sm" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => useEd.getState().redo()}><Redo2 size={15} /></button>
        <span className="sep" />
        <button className="eb icon sm" title="Split (Ctrl+B)" onClick={cmd.split}><Scissors size={15} /></button>
        <button className="eb icon sm" title="Delete left of playhead (Q)" disabled={!sel.length} onClick={() => cmd.trimTo("left")}><ArrowLeftToLine size={15} /></button>
        <button className="eb icon sm" title="Delete right of playhead (W)" disabled={!sel.length} onClick={() => cmd.trimTo("right")}><ArrowRightToLine size={15} /></button>
        <button className="eb icon sm" title="Delete (Del)" disabled={!sel.length} onClick={cmd.del}><Trash2 size={15} /></button>
        <span className="sep" />
        <button className="eb icon sm" title="Freeze frame" disabled={!sel.length} onClick={cmd.freeze}><Snowflake size={15} /></button>
        <button className="eb icon sm" title="Reverse" disabled={!sel.length} onClick={cmd.reverse}><Rewind size={15} /></button>
        <button className="eb icon sm" title="Mirror" disabled={!sel.length} onClick={cmd.mirror}><FlipHorizontal2 size={15} /></button>
        <button className="eb icon sm" title="Rotate 90°" disabled={!sel.length} onClick={cmd.rotate}><RotateCw size={15} /></button>
        <button className="eb icon sm" title="Crop" disabled={!sel.length} onClick={() => window.dispatchEvent(new CustomEvent("msp-inspector", { detail: "crop" }))}><Crop size={15} /></button>
        <button className="eb icon sm" title="Add marker (M)" onClick={cmd.marker}><Bookmark size={15} /></button>
        <span style={{ flex: 1 }} />
        <RecordButton />
        <span className="sep" />
        <button className={`eb icon sm ${p.magnet ? "on" : ""}`} title="Main track magnet: keep the main track gap-free" onClick={() => useEd.getState().commit(pp => ({ ...pp, magnet: !pp.magnet }))}><Magnet size={15} /></button>
        <button className={`eb icon sm ${p.snap ? "on" : ""}`} title="Auto snapping (S)" onClick={() => useEd.getState().commit(pp => ({ ...pp, snap: !pp.snap }))}><SquareSplitHorizontal size={15} /></button>
        <span className="sep" />
        <button className="eb icon sm" title="Zoom out (−)" onClick={() => useEd.getState().setZoom(zoom / 1.4)}><Minus size={15} /></button>
        <input type="range" min={0} max={100} value={Math.round((Math.log(zoom / 4) / Math.log(300)) * 100)} onChange={e => useEd.getState().setZoom(4 * Math.pow(300, +e.target.value / 100))} style={{ width: 110 }} aria-label="Timeline zoom" />
        <button className="eb icon sm" title="Zoom in (+)" onClick={() => useEd.getState().setZoom(zoom * 1.4)}><Plus size={15} /></button>
        <button className="eb sm" title="Zoom to fit (Shift+Z)" onClick={fit}><ZoomIn size={14} />Fit</button>
      </div>
      <div className="ed-tbody">
        <div className="ed-heads" style={{ paddingTop: 26 }} ref={el => { if (el) el.scrollTop = view.y; }}>
          {rows.map(({ tr, h }) => <TrackHead key={tr.id} tr={tr} h={h} />)}
        </div>
        <div className="ed-lanes" ref={lanes} onScroll={e => { const el = e.currentTarget; setView({ x: el.scrollLeft, w: el.clientWidth, y: el.scrollTop }); }}
          onDragOver={onDragOver} onDragLeave={() => setDrop(null)} onDrop={onDrop}>
          <div style={{ width: totalW, position: "relative", minHeight: "100%" }}>
            <Ruler p={p} pxPerUs={pxPerUs} x0={view.x} w={view.w} total={totalW} onDown={scrub} />
            <div style={{ position: "relative", height: Math.max(totalH, 60) }} onPointerDown={laneDown}>
              {rows.map(({ tr, y: ty, h }) => (
                <div key={tr.id} className={`ed-lane ${tr.main ? "main" : ""} ${drop?.track === tr.id ? "drop" : ""}`} style={{ position: "absolute", left: 0, right: 0, top: ty, height: h, opacity: tr.hide ? 0.45 : 1 }}>
                  {tr.clips.map((c, i) => {
                    const x = xOf(c.start), w = Math.max(2, xOf(c.dur));
                    if (x + w < vis0 || x > vis1) return null;
                    const nx = tr.clips[i + 1];
                    return <ClipView key={c.id} p={p} c={c} tr={tr} x={x} w={w} h={h} sel={sel.includes(c.id)} pxPerUs={pxPerUs} vis0={vis0} vis1={vis1}
                      onDown={(e, m) => dragClip(e, c, m)} onMenu={e => menu(e, c)}
                      transitionBtn={(tr.kind === "video") && nx && Math.abs(nx.start - end(c)) <= 1000} />;
                  })}
                </div>
              ))}
              {!p.tracks.some(tr => tr.clips.length) && <div className="ed-tl-empty"><Layers size={18} />Drag media here, or click + on any item to add it at the playhead</div>}
              {drop && <div className="ed-snapline" style={{ left: xOf(drop.t) }} />}
              {snapX != null && <div className="ed-snapline" style={{ left: snapX }} />}
              {marquee && <div className="ed-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1) - 26, width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
            </div>
            <Playhead pxPerUs={pxPerUs} />
          </div>
        </div>
      </div>
    </div>
  );
}

const Playhead = memo(function Playhead({ pxPerUs }: { pxPerUs: number }) {
  const t = useEd(s => s.t);
  return <div className="ed-playhead" style={{ left: t * pxPerUs }} />;
});

function TrackHead({ tr, h }: { tr: Track; h: number }) {
  const set = (patch: Partial<Track>) => useEd.getState().commit(pp => updateTrack(pp, tr.id, patch));
  const Icon = tr.kind === "audio" ? Music : tr.kind === "text" ? Type : tr.kind === "effect" ? Wand2 : tr.kind === "filter" ? Sparkles : tr.kind === "adjust" ? AudioLines : tr.main ? Video : ImageIcon;
  return (
    <div className={`ed-head ${tr.main ? "main" : ""}`} style={{ height: h }} title={tr.main ? "Main track" : `${tr.kind} track`}>
      <Icon size={13} style={{ margin: "0 3px", flex: "none", color: tr.main ? "var(--e-acc)" : undefined }} />
      <span style={{ flex: 1 }} />
      <button className="eb icon sm" title={tr.lock ? "Unlock track" : "Lock track"} onClick={() => set({ lock: !tr.lock })}>{tr.lock ? <Lock size={12} /> : <Unlock size={12} />}</button>
      {tr.kind !== "audio" && <button className="eb icon sm" title={tr.hide ? "Show track" : "Hide track"} onClick={() => set({ hide: !tr.hide })}>{tr.hide ? <EyeOff size={12} /> : <Eye size={12} />}</button>}
      {(tr.kind === "audio" || tr.kind === "video") && <button className="eb icon sm" title={tr.mute ? "Unmute track" : "Mute track"} onClick={() => set({ mute: !tr.mute })}>{tr.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>}
    </div>
  );
}

function Ruler({ p, pxPerUs, x0, w, total, onDown }: { p: Project; pxPerUs: number; x0: number; w: number; total: number; onDown: (e: React.PointerEvent) => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current!; const dpr = devicePixelRatio || 1; const W = Math.ceil(w + 2);
    c.width = W * dpr; c.height = 26 * dpr; c.style.width = `${W}px`; c.style.height = "26px"; c.style.left = `${x0}px`;
    const g = c.getContext("2d")!; g.scale(dpr, dpr); g.clearRect(0, 0, W, 26);
    const steps = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const pxs = pxPerUs * SEC; const major = steps.find(s => s * pxs >= 90) ?? 600; const minor = major / 5;
    g.fillStyle = "#6e6e78"; g.strokeStyle = "#3a3a40"; g.font = "10px Segoe UI"; g.textBaseline = "top";
    const t0 = Math.floor(x0 / pxs / minor) * minor;
    for (let t = t0; t * pxs < x0 + W; t += minor) {
      const x = Math.round(t * pxs - x0) + 0.5; const isMaj = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.beginPath(); g.moveTo(x, isMaj ? 14 : 20); g.lineTo(x, 26); g.stroke();
      if (isMaj) g.fillText(tc(t * SEC, p), x + 3, 3);
    }
    for (const m of p.markers) { const x = m.t * pxPerUs - x0; g.fillStyle = m.color; g.beginPath(); g.moveTo(x - 4, 12); g.lineTo(x + 4, 12); g.lineTo(x + 4, 18); g.lineTo(x, 23); g.lineTo(x - 4, 18); g.fill(); }
  }, [p, pxPerUs, x0, w]);
  return <div className="ed-ruler" style={{ width: total }} onPointerDown={onDown}><canvas ref={cv} /></div>;
}

const ClipView = memo(function ClipView({ p, c, tr, x, w, h, sel, pxPerUs, vis0, vis1, onDown, onMenu, transitionBtn }: {
  p: Project; c: Clip; tr: Track; x: number; w: number; h: number; sel: boolean; pxPerUs: number; vis0: number; vis1: number;
  onDown: (e: React.PointerEvent, m: "move" | "l" | "r") => void; onMenu: (e: React.MouseEvent) => void; transitionBtn: boolean;
}) {
  const m = c.media ? p.media[c.media] : undefined;
  const prep = useEd(s => (c.media ? Object.entries(s.prep).find(([k]) => k.startsWith(c.media + ":"))?.[1] : undefined));
  const showStrip = (c.type === "video" || c.type === "image") && m && h >= 48;
  const stripPath = m ? (m.kind === "image" ? m.path : m.optimized && !m.playable ? m.optimized : m.path) : undefined;
  const fs = useStrip(showStrip && m?.kind === "video" ? stripPath : undefined, m?.duration ?? 0, m?.width ?? 16, m?.height ?? 9);
  const label = c.name || (m?.name ?? c.text?.text ?? c.effect?.id ?? c.filter?.id ?? c.type);
  const tags: string[] = [];
  if ((c.speed ?? 1) !== 1 || c.curve) tags.push(c.curve ? "curve" : `${Math.round((c.speed ?? 1) * 100) / 100}×`);
  if (c.reverse) tags.push("rev"); if (c.mute) tags.push("muted"); if (c.effects?.length) tags.push(`fx ${c.effects.length}`); if (c.filter) tags.push("filter"); if (c.fx && (c.fx.voice || c.fx.denoise)) tags.push("voice");
  if (c.cutout) tags.push("cutout"); if (c.animIn || c.animOut || c.animLoop) tags.push("anim");
  const keyTimes = useMemo(() => [...new Set(Object.values(c.keys ?? {}).flatMap(ks => ks!.map(k => k.t)))], [c.keys]);
  // visible slice of the clip, for tiles and waveform
  const v0 = Math.max(0, vis0 - x), v1 = Math.min(w, vis1 - x);
  return (
    <div className={`ed-clip ${sel ? "sel" : ""}`} style={{ left: x, width: w, background: COLORS[c.type], opacity: m?.missing ? 0.5 : 1 }}
      onPointerDown={e => onDown(e, "move")} onContextMenu={onMenu} title={m?.missing ? `Missing file: ${m.path}` : label}>
      {showStrip && m!.kind === "image" && stripPath && <div style={{ position: "absolute", left: 0, right: 0, top: 3, bottom: 3, backgroundImage: `url("${convertFileSrc(stripPath)}")`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x", opacity: 0.92, pointerEvents: "none" }} />}
      {showStrip && fs && <Tiles fs={fs} c={c} m={m!} x0={v0} x1={v1} h={h - 6} pxPerUs={pxPerUs} isImage={m!.kind === "image"} />}
      {(c.type === "audio" || (c.type === "video" && m?.has_audio && h >= 48)) && m && <Wave path={m.path} c={c} x0={v0} x1={v1} h={c.type === "audio" ? h - 22 : 16} bottom={c.type !== "audio"} pxPerUs={pxPerUs} mediaDur={m.duration} />}
      {c.type === "color" && <div style={{ position: "absolute", inset: 0, background: c.color }} />}
      <div className="nm">{c.type === "text" || c.type === "caption" ? <Type size={11} /> : null}<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>{tags.map(t => <span key={t} className="tag">{t}</span>)}</div>
      {keyTimes.map(kt => <div key={kt} className="kfd" style={{ left: kt * pxPerUs }} />)}
      {prep && <div className="prep">{prep.kind === "optimize" ? "Preparing" : prep.kind === "reverse" ? "Reversing" : "Processing"} {Math.round(prep.progress * 100)}%</div>}
      {!tr.lock && <><div className="trim l" onPointerDown={e => { e.stopPropagation(); onDown(e, "l"); }} /><div className="trim r" onPointerDown={e => { e.stopPropagation(); onDown(e, "r"); }} /></>}
      {transitionBtn && <TransitionBtn c={c} />}
    </div>
  );
});

function TransitionBtn({ c }: { c: Clip }) {
  return <div className={`ed-trans ${c.transition ? "" : "add"}`} style={{ left: "100%" }} title={c.transition ? `Transition: ${c.transition.id} (${(c.transition.dur / SEC).toFixed(1)} s) — click to edit` : "Add transition"}
    onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); useEd.getState().select([c.id]); useEd.getState().setLeft("transitions"); if (c.transition) window.dispatchEvent(new CustomEvent("msp-inspector", { detail: "transition" })); }}>
    {c.transition ? <Sparkles size={12} /> : <Plus size={12} />}
  </div>;
}

function Tiles({ fs, c, m, x0, x1, h, pxPerUs, isImage }: { fs: Filmstrip; c: Clip; m: { duration: number }; x0: number; x1: number; h: number; pxPerUs: number; isImage: boolean }) {
  const scale = h / fs.th, tw = fs.tw * scale, url = convertFileSrc(fs.path);
  const first = Math.floor(x0 / tw), last = Math.ceil(x1 / tw);
  const out = [];
  for (let i = first; i < last; i++) {
    let idx = 0;
    if (!isImage) { const local = (i * tw + tw / 2) / pxPerUs; const st = Math.max(0, Math.min(m.duration - 1, sourceTime(c, c.start + local))); idx = Math.max(0, Math.min(fs.count - 1, Math.floor(st / fs.interval_us))); }
    out.push(<div key={i} style={{ position: "absolute", left: i * tw, top: 3, width: tw, height: h, backgroundImage: `url("${url}")`, backgroundSize: `${fs.cols * tw}px auto`, backgroundPosition: `${-(idx % fs.cols) * tw}px ${-Math.floor(idx / fs.cols) * h}px`, opacity: 0.92, pointerEvents: "none" }} />);
  }
  return <>{out}</>;
}

function Wave({ path, c, x0, x1, h, bottom, pxPerUs, mediaDur }: { path: string; c: Clip; x0: number; x1: number; h: number; bottom: boolean; pxPerUs: number; mediaDur: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  useEffect(() => { let ok = true; void waveFor(path).then(w => { if (ok) setPeaks(w); }); return () => { ok = false; }; }, [path]);
  useEffect(() => {
    const el = cv.current; if (!el || !peaks) return;
    const W = Math.max(1, Math.ceil(x1 - x0)); el.width = W; el.height = Math.max(4, h);
    const g = el.getContext("2d")!; g.clearRect(0, 0, W, h); g.fillStyle = bottom ? "rgba(140,255,200,.55)" : "rgba(170,255,210,.8)";
    const vol = Math.min(2, c.volume ?? 1);
    for (let x = 0; x < W; x++) {
      const local = (x0 + x) / pxPerUs;
      const st = Math.max(0, Math.min(mediaDur - 1, sourceTime(c, c.start + local)));
      const i = Math.floor(st / 10_000); const v = (peaks[i] ?? 0) / 255 * vol;
      const bh = Math.min(h, Math.max(1, v * h));
      if (bottom) g.fillRect(x, h - bh, 1, bh); else g.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [peaks, x0, x1, h, c, pxPerUs, bottom, mediaDur]);
  return <canvas ref={cv} style={{ position: "absolute", left: x0, bottom: bottom ? 2 : 4, height: h, width: Math.max(1, x1 - x0), pointerEvents: "none" }} />;
}

// ---------------------------------------------------------------- commands shared by toolbar, menu and keyboard

let clipboard: Clip[] = [];

export function useCommands() {
  return useMemo(() => {
    const st = () => useEd.getState();
    const sel = () => st().sel, p = () => st().p!;
    const firstSel = () => sel().map(id => findClip(p(), id)).find(Boolean);
    return {
      split() {
        const s = sel(), t = st().t;
        const ids = s.length ? s : p().tracks.flatMap(tr => tr.clips.filter(c => !tr.lock && c.start < t && t < end(c)).map(c => c.id));
        if (!ids.length) return notify("Move the playhead over a clip to split it", "info");
        st().commit(pp => splitAt(pp, t, ids));
      },
      del() { const s = sel(); if (!s.length) return; st().commit(pp => deleteClips(pp, s)); st().select([]); },
      trimTo(side: "left" | "right") { const s = sel(); if (!s.length) return; st().commit(pp => trimToPlayhead(pp, s, st().t, side)); },
      duplicate() { const s = sel(); if (!s.length) return; st().commit(pp => s.reduce((acc, id) => duplicateClip(acc, id), pp)); },
      copy() { clipboard = sel().map(id => findClip(p(), id)?.clip).filter(Boolean).map(c => structuredClone(c!)); if (clipboard.length) notify(`Copied ${clipboard.length} clip${clipboard.length > 1 ? "s" : ""}`, "info"); },
      paste() {
        if (!clipboard.length) return;
        const t0 = Math.min(...clipboard.map(c => c.start));
        const clips = clipboard.map(c => ({ ...structuredClone(c), id: uid(), start: st().t + (c.start - t0), transition: null }));
        st().commit(pp => clips.reduce((acc, c) => addClips(acc, [c], { at: c.start, toMain: false }), pp));
        st().select(clips.map(c => c.id));
      },
      reverse() {
        const f = firstSel(); if (!f || f.clip.type !== "video" || !f.clip.media) return notify("Select a video clip to reverse", "info");
        const on = !f.clip.reverse; ensureReversed(f.clip.media);
        st().commit(pp => updateClip(pp, f.clip.id, { reverse: on }));
        if (on && !p().media[f.clip.media].reversed) notify("Reversing… the clip updates when it's ready (jobs panel shows progress).", "info");
      },
      mirror() { for (const id of sel()) st().commit(pp => updateClip(pp, id, c => ({ transform: { ...(c.transform ?? defTf()), flipH: !(c.transform?.flipH) } }))); },
      rotate() { for (const id of sel()) st().commit(pp => updateClip(pp, id, c => ({ transform: { ...(c.transform ?? defTf()), rotation: ((c.transform?.rotation ?? 0) + 90) % 360 } }))); },
      speed(s: number) { for (const id of sel()) st().commit(pp => { const f = findClip(pp, id); if (!f) return pp; const span = srcSpan(f.clip); return updateClip(pp, id, { speed: s, curve: null, dur: Math.max(frameUs(pp), Math.round(span / s)) }); }); },
      marker() { st().commit(pp => ({ ...pp, markers: [...pp.markers.filter(m => Math.abs(m.t - st().t) > 1000), { id: uid("k"), t: toFrame(st().t, pp), color: "#ff9b45", label: "" }] })); },
      async freeze() {
        const f = firstSel(); const t = st().t, id = st().id;
        if (!f || f.clip.type !== "video" || !f.clip.media || !id || t <= f.clip.start || t >= end(f.clip)) return notify("Put the playhead over a selected video clip to freeze that frame", "info");
        const m = p().media[f.clip.media];
        try {
          const png = await ed.framePng(m.path, sourceTime(f.clip, t), id);
          const [mid] = await importPaths([png]);
          st().commit(pp => {
            let q = splitAt(pp, t, [f.clip.id]);
            const img: Clip = { id: uid(), type: "image", start: t, dur: 3 * SEC, media: mid, in: 0, name: "Freeze frame", transform: f.clip.transform, crop: f.clip.crop, adjust: f.clip.adjust, filter: f.clip.filter };
            if (f.track.main && q.magnet) q = addClips(q, [img], { at: t, toMain: true });
            else { q = structuredClone(q); const tr = q.tracks.find(x => x.id === f.track.id)!; for (const c of tr.clips) if (c.start >= t) c.start += img.dur; tr.clips.push(img); tr.clips.sort((a, b) => a.start - b.start); }
            return q;
          });
        } catch (e) { notify(`Freeze frame failed: ${e}`); }
      },
      extractAudio() {
        const f = firstSel(); if (!f || f.clip.type !== "video" || !f.clip.media) return;
        const c = f.clip; const a: Clip = { id: uid(), type: "audio", start: c.start, dur: c.dur, media: c.media, in: c.in, speed: c.speed, curve: c.curve, volume: c.volume ?? 1, fadeIn: c.fadeIn, fadeOut: c.fadeOut, fx: c.fx, name: `Audio – ${p().media[c.media!].name}` };
        st().commit(pp => addClips(updateClip(pp, c.id, { mute: true }), [a], { at: c.start, toMain: false }));
      },
    };
  }, []);
}
const defTf = () => ({ x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false });
