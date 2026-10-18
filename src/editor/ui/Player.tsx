import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { Compositor } from "../engine/compositor";
import { PreviewSources } from "../engine/sources";
import { animAt } from "../engine/anim";
import { renderText } from "../engine/text";
import { useEd, saveNow } from "../store";
import { ed } from "../api";
import { Clip, duration, end, findClip, frameUs, isVisual, keyValue, Project, RATIOS, SEC, toFrame, US } from "../model";

export const tc = (us: US, p: Pick<Project, "fps_num" | "fps_den">) => {
  const fps = p.fps_num / p.fps_den, f = Math.round((us / SEC) * fps), fr = Math.max(1, Math.round(fps));
  const s = Math.floor(f / fr), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? String(h).padStart(2, "0") + ":" : ""}${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}:${String(f % fr).padStart(2, "0")}`;
};

// One compositor + preview source set per editor session (shared with cover capture).
let comp: Compositor | null = null;
let sources: PreviewSources | null = null;
let redrawFn: () => void = () => {};
export const previewSources = () => sources;
export const requestRedraw = () => redrawFn();

/** Box of a visual clip in canvas pixels (centre, size, rotation) — mirrors the compositor maths. */
export function clipBox(p: Project, c: Clip, t: US, W: number, H: number): { cx: number; cy: number; w: number; h: number; rot: number } | null {
  if (!isVisual(c)) return null;
  const local = Math.max(0, Math.min(c.dur, t - c.start));
  const k = (prop: "x" | "y" | "scale" | "rotation", base: number) => keyValue(c.keys?.[prop], local, base);
  const { s: an, char } = animAt(c, local);
  let cw = 0, ch = 0;
  if (c.type === "text" || c.type === "caption") { if (!c.text) return null; const r = renderText(c.text, W, H, { words: c.words, local, char }); cw = r.w; ch = r.h; }
  else if (c.type === "sticker") { const s = Math.min(W, H) * 0.3; cw = s; ch = s; }
  else if (c.type === "color") { cw = W; ch = H; }
  else {
    const m = c.media ? p.media[c.media] : undefined; if (!m) return null;
    const cr = c.crop ?? { l: 0, t: 0, r: 0, b: 0 };
    const sw = Math.max(1, (m.width || 16) * (1 - cr.l - cr.r)), sh = Math.max(1, (m.height || 9) * (1 - cr.t - cr.b));
    const fit = Math.min(W / sw, H / sh); cw = sw * fit; ch = sh * fit;
  }
  const tf = c.transform ?? { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false };
  const sc = k("scale", tf.scale) * an.scale;
  return { cx: W / 2 + (k("x", tf.x) + an.dx) * W, cy: H / 2 + (k("y", tf.y) + an.dy) * H, w: Math.abs(cw * sc * tf.scaleX * an.sx), h: Math.abs(ch * sc * tf.scaleY * an.sy), rot: k("rotation", tf.rotation) + an.rot };
}

export function Player() {
  const p = useEd(s => s.p)!;
  const t = useEd(s => s.t), playing = useEd(s => s.playing), sel = useEd(s => s.sel), prep = useEd(s => s.prep);
  const stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360, x: 0, y: 0 });
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const raf = useRef(0), clock = useRef({ t0: 0, at: 0 });
  const pending = useRef(false);

  // fit the canvas into the stage at the project's aspect ratio
  useLayoutEffect(() => {
    const el = stage.current; if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect(); const pad = 16;
      const s = Math.min((r.width - pad * 2) / p.width, (r.height - pad * 2) / p.height);
      const w = Math.max(32, Math.floor(p.width * s)), h = Math.max(18, Math.floor(p.height * s));
      setSize({ w, h, x: Math.floor((r.width - w) / 2), y: Math.floor((r.height - h) / 2) });
    };
    fit(); const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
  }, [p.width, p.height]);

  // compositor lifetime
  useEffect(() => {
    const cv = canvas.current!;
    try { comp = new Compositor(cv); } catch (e) { setErr(String(e)); return; }
    sources = new PreviewSources(() => redrawFn());
    return () => { cancelAnimationFrame(raf.current); sources?.dispose(); comp?.dispose(); comp = null; sources = null; };
  }, []);

  const draw = (tt: US) => {
    const c = comp, s = sources, cv = canvas.current; if (!c || !s || !cv) return;
    const st = useEd.getState(), proj = st.p; if (!proj) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    // render at display resolution (never above the project's), even width for the shaders
    let W = Math.min(proj.width, Math.round(size.w * dpr)), H = Math.round((W * proj.height) / proj.width);
    W = Math.max(16, W - (W % 2)); H = Math.max(16, H - (H % 2));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; c.gl.trim(W, H); }
    s.masterVolume = muted ? 0 : 1;
    s.sync(proj, tt, st.playing);
    try {
      const target = c.render(proj, tt, s, W, H);
      c.present(target, W, H); c.release(target);
      if (wantCover) captureCover(cv, tt);
      setErr(null);
    } catch (e) { setErr(String(e)); }
  };
  redrawFn = () => { if (pending.current) return; pending.current = true; requestAnimationFrame(() => { pending.current = false; if (!useEd.getState().playing) draw(useEd.getState().t); }); };

  // repaint on any change while paused
  useEffect(() => { if (!playing) redrawFn(); }, [p, t, size, playing, muted]); // eslint-disable-line

  // playback clock
  useEffect(() => {
    if (!playing) { sources?.pauseAll(); return; }
    const st = useEd.getState(); const d = duration(st.p!);
    if (st.t >= d - frameUs(st.p!)) useEd.setState({ t: 0 });
    clock.current = { t0: useEd.getState().t, at: performance.now() };
    let last = 0;
    const tick = (now: number) => {
      const s = useEd.getState(); if (!s.playing || !s.p) return;
      const tt = clock.current.t0 + (now - clock.current.at) * 1000;
      const dd = duration(s.p);
      if (tt >= dd) { useEd.setState({ playing: false, t: toFrame(dd, s.p) }); draw(dd - 1); return; }
      draw(tt);
      if (now - last > 30) { useEd.setState({ t: tt }); last = now; }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]); // eslint-disable-line

  // re-anchor the clock when the user seeks during playback
  useEffect(() => { if (playing && Math.abs(t - (clock.current.t0 + (performance.now() - clock.current.at) * 1000)) > 250_000) clock.current = { t0: t, at: performance.now() }; }, [t, playing]);

  const dur = duration(p);
  const selClip = sel.length === 1 ? findClip(p, sel[0])?.clip : undefined;
  const showBox = selClip && isVisual(selClip) && selClip.type !== "color" && t >= selClip.start && t < end(selClip) && !playing;
  const box = showBox ? clipBox(p, selClip!, t, size.w, size.h) : null;
  const waiting = Object.values(prep).filter(x => x.kind === "optimize");

  const dragBox = (e: React.PointerEvent, mode: "move" | "scale" | "rot") => {
    if (!selClip || !box) return;
    e.stopPropagation(); e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    const tf0 = { ...(selClip.transform ?? { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false }) };
    const rect = stage.current!.getBoundingClientRect();
    const cx = rect.left + size.x + box.cx, cy = rect.top + size.y + box.cy;
    const d0 = Math.hypot(x0 - cx, y0 - cy), a0 = Math.atan2(y0 - cy, x0 - cx);
    const local = t - selClip.start, keyed = (k: "x" | "y" | "scale" | "rotation") => !!selClip.keys?.[k]?.length;
    const move = (ev: PointerEvent) => {
      useEd.getState().live(pp => {
        const f = findClip(pp, selClip.id); if (!f) return pp;
        const c = { ...f.clip, transform: { ...tf0 }, keys: { ...f.clip.keys } };
        const set = (k: "x" | "y" | "scale" | "rotation", v: number) => {
          if (keyed(k)) { const ks = (c.keys![k] ?? []).filter(x => Math.abs(x.t - local) > 1000); ks.push({ t: local, v, e: "inOut" }); ks.sort((a, b) => a.t - b.t); c.keys![k] = ks; }
          else (c.transform as any)[k] = v;
        };
        if (mode === "move") {
          let nx = tf0.x + (ev.clientX - x0) / size.w, ny = tf0.y + (ev.clientY - y0) / size.h;
          const sv = Math.abs(nx) < 6 / size.w, sh = Math.abs(ny) < 6 / size.h;
          if (sv && !ev.altKey) nx = 0; if (sh && !ev.altKey) ny = 0;
          setGuides({ v: sv, h: sh });
          set("x", nx); set("y", ny);
        } else if (mode === "scale") {
          const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
          set("scale", Math.max(0.02, Math.min(20, tf0.scale * (d / Math.max(4, d0)))));
        } else {
          let r = tf0.rotation + ((Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0) * 180) / Math.PI;
          if (!ev.shiftKey) { const snapR = Math.round(r / 45) * 45; if (Math.abs(r - snapR) < 4) r = snapR; } else r = Math.round(r / 15) * 15;
          set("rotation", Math.round(r * 10) / 10);
        }
        const tracks = pp.tracks.map(tr => tr.id === f.track.id ? { ...tr, clips: tr.clips.map(x => (x.id === c.id ? c : x)) } : tr);
        return { ...pp, tracks };
      });
    };
    const up = () => { setGuides({ v: false, h: false }); useEd.getState().endLive(); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  // click on the canvas selects the top-most visual clip under the pointer
  const pick = (e: React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect(); const x = e.clientX - rect.left, y = e.clientY - rect.top;
    for (const tr of p.tracks) {
      if (tr.hide || tr.kind !== "video" && tr.kind !== "text") continue;
      for (const c of tr.clips) {
        if (c.start > t || t >= end(c) || c.type === "color") continue;
        const b = clipBox(p, c, t, size.w, size.h); if (!b) continue;
        const a = (-b.rot * Math.PI) / 180, dx = x - b.cx, dy = y - b.cy;
        const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
        if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) { useEd.getState().select([c.id]); return; }
      }
    }
    useEd.getState().select([]);
  };

  const step = (n: number) => { useEd.getState().setPlaying(false); useEd.getState().seek(t + n * frameUs(p)); };
  return (
    <div className="ed-player">
      <div className="ed-player-h"><span>Player</span><span style={{ flex: 1 }} />
        <span className="ed-pill">{p.width}×{p.height} · {Math.round((p.fps_num / p.fps_den) * 100) / 100} fps</span>
      </div>
      <div className="ed-stage" ref={stage} onMouseDown={e => { if (e.target === stage.current) useEd.getState().select([]); }}>
        <canvas ref={canvas} className="view" style={{ left: size.x, top: size.y, width: size.w, height: size.h }} onMouseDown={pick} onDoubleClick={() => { if (selClip?.type === "text" || selClip?.type === "caption") window.dispatchEvent(new Event("msp-edit-text")); }} />
        {box && (
          <div className="ed-overlay" style={{ left: size.x, top: size.y, width: size.w, height: size.h }}>
            <div className="ed-box" style={{ left: box.cx - box.w / 2, top: box.cy - box.h / 2, width: box.w, height: box.h, transform: `rotate(${box.rot}deg)` }} onPointerDown={e => dragBox(e, "move")}
              onDoubleClick={() => { if (selClip?.type === "text" || selClip?.type === "caption") window.dispatchEvent(new Event("msp-edit-text")); }}>
              {[[0, 0], [100, 0], [0, 100], [100, 100]].map(([x, y], i) => <div key={i} className="h" style={{ left: `${x}%`, top: `${y}%`, cursor: i === 0 || i === 3 ? "nwse-resize" : "nesw-resize" }} onPointerDown={e => dragBox(e, "scale")} />)}
              <div className="h rot" style={{ left: "50%", top: -22 }} title="Rotate (Shift: 15° steps)" onPointerDown={e => dragBox(e, "rot")} />
            </div>
            {guides.v && <div className="ed-guide" style={{ left: size.w / 2, top: 0, bottom: 0, width: 1 }} />}
            {guides.h && <div className="ed-guide" style={{ top: size.h / 2, left: 0, right: 0, height: 1 }} />}
          </div>
        )}
        {err && <div className="ed-wait" style={{ color: "#ff8a8a" }}>Preview error: {err}</div>}
        {!err && waiting.length > 0 && !p.tracks.every(tr => tr.clips.every(c => !c.media || p.media[c.media]?.playable || p.media[c.media]?.optimized)) && (
          <div className="ed-wait"><div style={{ fontSize: 13, color: "#ddd" }}>Preparing {waiting.length} clip{waiting.length > 1 ? "s" : ""} for smooth editing…</div>
            <div className="ed-bar" style={{ width: 220 }}><div style={{ width: `${Math.round((waiting.reduce((a, b) => a + b.progress, 0) / waiting.length) * 100)}%` }} /></div>
            <div style={{ fontSize: 11 }}>HEVC / ProRes / other formats get a hardware-encoded H.264 copy once (kept in the cache).</div></div>
        )}
      </div>
      <div className="ed-transport">
        <div className="ed-tc"><b>{tc(t, p)}</b> <span>/ {tc(dur, p)}</span></div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button className="eb icon" title="Previous frame (←)" onClick={() => step(-1)}><SkipBack size={15} /></button>
          <button className="ed-play" title="Play / pause (Space)" onClick={() => useEd.getState().setPlaying(!playing)}>{playing ? <Pause size={16} /> : <Play size={16} style={{ marginLeft: 2 }} />}</button>
          <button className="eb icon" title="Next frame (→)" onClick={() => step(1)}><SkipForward size={15} /></button>
        </div>
        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
          <button className="eb icon sm" title={muted ? "Unmute preview" : "Mute preview"} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
          <RatioMenu />
          <button className="eb icon sm" title="Full screen preview" onClick={() => stage.current?.requestFullscreen?.()}><Maximize2 size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function RatioMenu() {
  const p = useEd(s => s.p)!;
  const [open, setOpen] = useState(false);
  const setRatio = (r: string) => {
    setOpen(false);
    useEd.getState().commit(pp => {
      let wh = RATIOS[r];
      if (!wh) { const m = Object.values(pp.media).find(x => x.kind !== "audio" && x.width > 0); wh = m ? [m.width - (m.width % 2), m.height - (m.height % 2)] : [1920, 1080]; }
      return { ...pp, ratio: r, width: wh[0], height: wh[1] };
    });
  };
  return (
    <div style={{ position: "relative" }}>
      <button className="eb sm solid" onClick={() => setOpen(!open)} title="Aspect ratio">{p.ratio === "original" ? "Original" : p.ratio}</button>
      {open && <div className="menu" style={{ position: "absolute", right: 0, bottom: 34, top: "auto", minWidth: 170, zIndex: 20 }} onMouseLeave={() => setOpen(false)}>
        {Object.keys(RATIOS).map(r => <div key={r} className={`mi ${p.ratio === r ? "on" : ""}`} onClick={() => setRatio(r)}>{r === "original" ? "Original (first clip)" : r}
          <span className="k">{RATIOS[r] ? `${RATIOS[r]![0]}×${RATIOS[r]![1]}` : ""}</span></div>)}
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- project cover (thumbnail on the Home screen)
let wantCover = false, coverAt = 0;
export function requestCover() { wantCover = true; requestRedraw(); }
function captureCover(cv: HTMLCanvasElement, tt: US) {
  const { id, p } = useEd.getState(); if (!id || !p || !p.tracks.some(t => t.clips.length)) { wantCover = false; return; }
  if (Date.now() - coverAt < 20_000) { wantCover = false; return; }
  wantCover = false; coverAt = Date.now(); void tt;
  const w = 480, h = Math.round((480 * cv.height) / cv.width);
  const c2 = document.createElement("canvas"); c2.width = w; c2.height = h;
  c2.getContext("2d")!.drawImage(cv, 0, 0, w, h);
  c2.toBlob(b => { if (b) b.arrayBuffer().then(buf => ed.cover(id, new Uint8Array(buf))).catch(() => {}); }, "image/jpeg", 0.82);
  void saveNow;
}
