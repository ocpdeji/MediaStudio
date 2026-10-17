import { useCallback, useEffect, useRef, useState } from "react";
import * as I from "lucide-react";
import { api, Asset, Detail, errText, fileUrl, thumbUrl } from "../lib/api";
import { useStore } from "../lib/store";
import { clamp, fmtSize, timecode } from "../lib/format";
import { setField } from "../lib/actions";
import { Stars } from "./ui";

// shared zoom state so compare panes can pan/zoom together
type Z = { s: number; x: number; y: number; fit: boolean };
type ZoomBus = { z: Z | null; listeners: Set<(z: Z, from: number) => void> };
const zoomBus: ZoomBus = { z: null, listeners: new Set() };

function ImagePane({ a, sync, paneId, label }: { a: Asset; sync: boolean; paneId: number; label?: string }) {
  const ref = useRef<HTMLDivElement>(null), img = useRef<HTMLImageElement>(null);
  const z = useRef<Z>({ s: 1, x: 0, y: 0, fit: true });
  const [, force] = useState(0);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState(false);
  const apply = useCallback((broadcast = true) => {
    const i = img.current; if (!i) return;
    i.style.transform = `translate(${z.current.x}px,${z.current.y}px) scale(${z.current.s})`;
    force(n => n + 1);
    if (sync && broadcast) zoomBus.listeners.forEach(l => l(z.current, paneId));
  }, [sync, paneId]);
  const fit = useCallback(() => {
    const el = ref.current, i = img.current; if (!el || !i || !i.naturalWidth) return;
    const s = Math.min(el.clientWidth / i.naturalWidth, el.clientHeight / i.naturalHeight, 4);
    z.current = { s, x: (el.clientWidth - i.naturalWidth * s) / 2, y: (el.clientHeight - i.naturalHeight * s) / 2, fit: true }; apply();
  }, [apply]);
  const zoomAt = (cx: number, cy: number, ns: number) => { const c = z.current; ns = clamp(ns, 0.02, 40); z.current = { s: ns, x: cx - (cx - c.x) * (ns / c.s), y: cy - (cy - c.y) * (ns / c.s), fit: false }; apply(); };
  useEffect(() => { setReady(false); setErr(false); }, [a.id]);
  useEffect(() => { const ro = new ResizeObserver(() => z.current.fit && fit()); if (ref.current) ro.observe(ref.current); return () => ro.disconnect(); }, [fit]);
  useEffect(() => {
    if (!sync) return;
    const l = (nz: Z, from: number) => { if (from === paneId) return; const i = img.current, el = ref.current; if (!i || !el) return;
      if (nz.fit) { fit(); return; } z.current = { ...nz }; apply(false); };
    zoomBus.listeners.add(l); return () => { zoomBus.listeners.delete(l); };
  }, [sync, paneId, fit, apply]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input,textarea,select") || useStore.getState().workspace !== "library" || useStore.getState().dialog || useStore.getState().palette || paneId !== 0) return;
      const el = ref.current; if (!el) return; const cx = el.clientWidth / 2, cy = el.clientHeight / 2;
      if (e.key === "+" || e.key === "=") zoomAt(cx, cy, z.current.s * 1.25); else if (e.key === "-") zoomAt(cx, cy, z.current.s / 1.25); else if (e.key === "z") (z.current.fit ? zoomAt(cx, cy, 1) : fit()); else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });
  const src = a.ext === "svg" || ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "ico", "jfif"].includes(a.ext) ? fileUrl(a.path) : thumbUrl(a);
  return (
    <div className="vpane" ref={ref} style={{ cursor: "grab" }}
      onWheel={e => { const r = ref.current!.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, z.current.s * Math.exp(-e.deltaY * 0.0015)); }}
      onDoubleClick={e => { const r = ref.current!.getBoundingClientRect(); z.current.fit ? zoomAt(e.clientX - r.left, e.clientY - r.top, z.current.s < 1 ? 1 : z.current.s * 2) : fit(); }}
      onPointerDown={e => { if (e.button !== 0) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); let lx = e.clientX, ly = e.clientY;
        const mv = (ev: PointerEvent) => { z.current = { ...z.current, x: z.current.x + ev.clientX - lx, y: z.current.y + ev.clientY - ly, fit: false }; lx = ev.clientX; ly = ev.clientY; apply(); };
        const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); }}>
      {label && <div className="vlabel">{label}</div>}
      <img ref={img} className="zimg" src={src} alt={a.name} draggable={false} style={{ visibility: ready ? "visible" : "hidden" }} onLoad={() => { setReady(true); fit(); }} onError={() => setErr(true)} />
      {err && <div className="overlay-msg"><I.ImageOff size={28} />This image format can’t be displayed directly.{a.ext !== "svg" && <img src={thumbUrl(a)} style={{ maxWidth: "90%", maxHeight: "70%" }} alt="" />}<span className="hint">Showing the generated preview instead.</span></div>}
      {ready && paneId === 0 && <div className="vlabel" style={{ left: "auto", right: 10 }}>{Math.round(z.current.s * 100)}%{z.current.fit ? " · fit" : ""}</div>}
    </div>
  );
}

function VideoPane({ a, detail, sync, paneId, label }: { a: Asset; detail: Detail | null; sync: boolean; paneId: number; label?: string }) {
  const v = useRef<HTMLVideoElement>(null), box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0), [dur, setDur] = useState((a.duration_ms ?? 0) / 1000), [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState<string | null>(null), [buffering, setBuffering] = useState(false);
  const [rate, setRate] = useState(1), [loop, setLoop] = useState(true);
  const [muted, setMuted] = useState(() => localStorage.getItem("msp.muted") !== "0"), [vol, setVol] = useState(() => +(localStorage.getItem("msp.vol") ?? 1));
  const [useProxy, setUseProxy] = useState<string | null>(null);
  const fpsN = a.fps_num ?? 30, fpsD = a.fps_den ?? 1, frame = fpsD / fpsN;
  useEffect(() => { setFailed(null); setUseProxy(null); setT(0); setPlaying(false); }, [a.id]);
  useEffect(() => { if (detail?.proxy && failed) { setUseProxy(detail.proxy); setFailed(null); } }, [detail?.proxy, failed]);
  useEffect(() => { try { localStorage.setItem("msp.muted", muted ? "1" : "0"); localStorage.setItem("msp.vol", String(vol)); } catch { /* storage unavailable */ } if (v.current) { v.current.muted = muted; v.current.volume = vol; } }, [muted, vol]);
  useEffect(() => { if (v.current) v.current.playbackRate = rate; }, [rate]);
  useEffect(() => {
    if (!sync) return;
    const h = (e: Event) => { const d = (e as CustomEvent).detail; if (d.from === paneId || !v.current) return; if (d.op === "play") v.current.play().catch(() => {}); if (d.op === "pause") v.current.pause(); if (d.op === "seek") v.current.currentTime = d.t; };
    window.addEventListener("msp-sync", h); return () => window.removeEventListener("msp-sync", h);
  }, [sync, paneId]);
  const bc = (op: string, tt?: number) => sync && window.dispatchEvent(new CustomEvent("msp-sync", { detail: { op, t: tt, from: paneId } }));
  const toggle = () => { const el = v.current; if (!el) return; if (el.paused) { el.play().catch(e => setFailed(String(e))); bc("play"); } else { el.pause(); bc("pause"); } };
  const seek = (s: number) => { const el = v.current; if (!el) return; el.currentTime = clamp(s, 0, el.duration || dur); setT(el.currentTime); bc("seek", el.currentTime); };
  const stepF = (n: number) => { v.current?.pause(); seek((v.current?.currentTime ?? 0) + n * frame); };
  useEffect(() => {
    if (paneId !== 0) return;
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input,textarea,select") || useStore.getState().workspace !== "library" || useStore.getState().dialog || useStore.getState().palette) return;
      const el = v.current; if (!el) return;
      const m: Record<string, () => void> = { " ": toggle, k: toggle, j: () => seek(el.currentTime - 5), l: () => seek(el.currentTime + 5), ",": () => stepF(-1), ".": () => stepF(1), m: () => setMuted(x => !x),
        "[": () => setRate(r => Math.max(0.25, r / 1.5)), "]": () => setRate(r => Math.min(4, r * 1.5)), Home: () => seek(0), End: () => seek(dur) };
      const f = m[e.key]; if (f) { e.preventDefault(); e.stopPropagation(); f(); }
    };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  });
  const st = useStore.getState();
  const capture = async (clip: boolean) => {
    try {
      const p = await api.captureFrame(a.id, Math.round((v.current?.currentTime ?? 0) * 1e6), clip);
      if (clip) { const buf = await api.readCacheFile(p); await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([buf], { type: "image/png" }) })]); st.toast("Frame copied to clipboard", "ok"); }
      else { st.toast(`Frame saved: ${p.split(/[\\/]/).pop()}`, "ok"); st.refresh(); }
    } catch (e) { st.toast(errText(e), "error"); }
  };
  const proxy = async () => { await api.enqueue({ type: "proxy", asset_id: a.id }, `Proxy · ${a.name}`); st.toast("Creating a compatible preview proxy — it will load automatically when ready."); };
  const src = useProxy ? fileUrl(useProxy) : fileUrl(a.path);
  const isAudio = a.kind === "audio";
  return (
    <div className="vpane" style={{ display: "flex", flexDirection: "column" }} ref={box}>
      {label && <div className="vlabel">{label}</div>}
      <div style={{ flex: 1, position: "relative", minHeight: 0, background: isAudio ? `#0b0b0c url("${thumbUrl(a)}") center/90% 70% no-repeat` : "#000" }} onClick={toggle}>
        <video ref={v} src={src} autoPlay={!isAudio && paneId === 0} loop={loop} muted={muted} playsInline preload="auto" style={isAudio ? { opacity: 0, position: "absolute" } : {}}
          onLoadedMetadata={e => { const el = e.currentTarget; setDur(el.duration); el.volume = vol; el.playbackRate = rate; if (!isAudio && a.width && el.videoWidth === 0) setFailed("This file’s video codec can’t be decoded by the preview engine."); }}
          onTimeUpdate={e => setT(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onWaiting={() => setBuffering(true)} onPlaying={() => setBuffering(false)} onCanPlay={() => setBuffering(false)}
          onError={() => setFailed(`The preview engine can’t play this ${a.ext.toUpperCase()} file${detail?.vcodec ? ` (${detail.vcodec})` : ""}.`)} />
        {buffering && !failed && <div className="overlay-msg" style={{ background: "transparent" }}><I.Loader2 className="spin" size={28} /></div>}
        {failed && <div className="overlay-msg" onClick={e => e.stopPropagation()}><I.FileVideo size={30} /><b>{failed}</b>
          <span className="hint" style={{ color: "#bbb" }}>Common for HEVC/H.265 without the Windows extension, ProRes, some MKV/AVI/MXF files. The original is fine — only the preview is affected.</span>
          {detail?.proxy ? <button className="btn primary" onClick={() => { setUseProxy(detail.proxy); setFailed(null); }}>Play the proxy</button> : <button className="btn primary" onClick={proxy}><I.Gauge size={15} /> Create preview proxy</button>}
        </div>}
        {useProxy && <div className="vlabel" style={{ top: "auto", bottom: 10 }}>Playing proxy (preview quality)</div>}
      </div>
      <div className="transport">
        <button className="btn ghost icon sm" onClick={toggle} title="Play / pause (Space)">{playing ? <I.Pause size={16} /> : <I.Play size={16} />}</button>
        <button className="btn ghost icon sm" onClick={() => stepF(-1)} title="Previous frame (,)"><I.ChevronLeft size={16} /></button>
        <button className="btn ghost icon sm" onClick={() => stepF(1)} title="Next frame (.)"><I.ChevronRight size={16} /></button>
        <span className="mono num" title={`${(fpsN / fpsD).toFixed(3)} fps`}>{timecode(t * 1e6, fpsN, fpsD)}</span>
        <Scrub t={t} dur={dur || 1} onSeek={seek} />
        <span className="mono num dim">{timecode(dur * 1e6, fpsN, fpsD)}</span>
        <select className="input" style={{ height: 24, width: 74, padding: "0 4px" }} value={rate} onChange={e => setRate(+e.target.value)} title="Speed ([ / ])">
          {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map(r => <option key={r} value={r}>{r}×</option>)}{![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].includes(rate) && <option value={rate}>{rate.toFixed(2)}×</option>}</select>
        <button className={`btn ghost icon sm ${loop ? "on" : ""}`} onClick={() => setLoop(x => !x)} title="Loop"><I.Repeat size={15} /></button>
        <button className="btn ghost icon sm" onClick={() => setMuted(x => !x)} title="Mute (M)">{muted ? <I.VolumeX size={15} /> : <I.Volume2 size={15} />}</button>
        <input type="range" min={0} max={1} step={0.05} value={vol} onChange={e => { setVol(+e.target.value); setMuted(false); }} style={{ width: 70 }} aria-label="Volume" />
        {!isAudio && <><button className="btn ghost icon sm" onClick={() => capture(false)} title="Save this exact frame as PNG next to the file (FFmpeg)"><I.Camera size={15} /></button>
          <button className="btn ghost icon sm" onClick={() => capture(true)} title="Copy this frame to the clipboard"><I.ClipboardCopy size={15} /></button></>}
        <button className="btn ghost icon sm" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : box.current?.requestFullscreen())} title="Fullscreen"><I.Maximize size={15} /></button>
      </div>
    </div>
  );
}

export function Scrub({ t, dur, onSeek, inT, outT }: { t: number; dur: number; onSeek: (s: number) => void; inT?: number; outT?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const at = (x: number) => { const r = ref.current!.getBoundingClientRect(); return clamp((x - r.left) / r.width, 0, 1) * dur; };
  const p = clamp(t / dur, 0, 1) * 100;
  return (
    <div className="scrub" ref={ref} onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); onSeek(at(e.clientX));
      const mv = (ev: PointerEvent) => onSeek(at(ev.clientX)); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); }}>
      <div className="track" />
      {inT != null && outT != null && <div className="range" style={{ left: `${(inT / dur) * 100}%`, width: `${((outT - inT) / dur) * 100}%` }} />}
      <div className="fill" style={{ width: `${p}%` }} /><div className="knob" style={{ left: `${p}%` }} />
    </div>
  );
}

export function Viewer() {
  const { assets, focus, compare } = useStore();
  const a = assets.find(x => x.id === focus);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sync, setSync] = useState(true);
  useEffect(() => {
    if (!a) return setDetail(null);
    let live = true; api.detail(a.id).then(d => live && setDetail(d)).catch(() => live && setDetail(null));
    const h = () => api.detail(a.id).then(d => live && setDetail(d)).catch(() => {});
    window.addEventListener("msp-job-done", h);
    return () => { live = false; window.removeEventListener("msp-job-done", h); };
  }, [a?.id, a?.mtime]); // eslint-disable-line
  const cmp = compare?.map(id => assets.find(x => x.id === id)).filter(Boolean) as Asset[] | undefined;
  if (cmp && cmp.length > 1) return (
    <div className="viewer">
      <div className="vbar"><I.Columns2 size={15} /><b>Compare {cmp.length}</b><span className="dim">Pick the keeper: rate or reject each one.</span><span className="grow" />
        <label className="check"><input type="checkbox" checked={sync} onChange={e => setSync(e.target.checked)} /> Sync zoom & playback</label>
        <button className="btn sm" onClick={() => useStore.setState({ compare: null })}><I.X size={14} /> Exit compare</button></div>
      <div className="viewer-stage">{cmp.map((x, i) => (
        <div key={x.id} className="vpane" style={{ display: "flex", flexDirection: "column" }}>
          {x.kind === "image" || x.kind === "raw" ? <ImagePane a={x} sync={sync} paneId={i} label={x.name} /> : <VideoPane a={x} detail={null} sync={sync} paneId={i} label={x.name} />}
          <div className="vbar" style={{ justifyContent: "space-between" }}>
            <span className="dim num">{x.width}×{x.height} · {fmtSize(x.size)}</span>
            <Stars value={x.rating} onChange={v => setField("rating", v, [x.id])} size={16} />
            <button className={`btn sm ${x.rejected ? "danger on" : ""}`} onClick={() => setField("rejected", !x.rejected, [x.id])}><I.Ban size={13} /> Reject</button>
          </div></div>))}</div>
    </div>);
  if (!a) return <div className="viewer"><div className="empty"><I.MousePointerClick size={30} /><h2>Nothing selected</h2>Click a thumbnail to preview it here.</div></div>;
  return (
    <div className="viewer">
      <div className="viewer-stage">
        {a.missing ? <div className="empty"><I.FileWarning size={30} /><h2>File is missing</h2>{a.path}<br />It was moved, renamed outside the app, or its drive is offline. Ratings and tags are kept; rescan after reconnecting.</div>
          : a.kind === "video" || a.kind === "audio" ? <VideoPane a={a} detail={detail} sync={false} paneId={0} /> : <ImagePane a={a} sync={false} paneId={0} />}
      </div>
    </div>
  );
}

export function Slideshow({ onClose }: { onClose: () => void }) {
  const { assets, focus } = useStore();
  const [i, setI] = useState(() => Math.max(0, assets.findIndex(a => a.id === focus)));
  const [sec, setSec] = useState(4), [paused, setPaused] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const a = assets[i];
  useEffect(() => { ref.current?.requestFullscreen().catch(() => {}); const f = () => { if (!document.fullscreenElement) onClose(); }; document.addEventListener("fullscreenchange", f); return () => document.removeEventListener("fullscreenchange", f); }, [onClose]);
  useEffect(() => { if (paused || !a || a.kind === "video") return; const t = setTimeout(() => setI(x => (x + 1) % assets.length), sec * 1000); return () => clearTimeout(t); }, [i, paused, sec, a, assets.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === "ArrowRight") setI(x => (x + 1) % assets.length); else if (e.key === "ArrowLeft") setI(x => (x - 1 + assets.length) % assets.length); else if (e.key === " ") setPaused(p => !p); else if (e.key === "Escape") { document.exitFullscreen().catch(() => {}); onClose(); } };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  }, [assets.length, onClose]);
  if (!a) return null;
  return (
    <div ref={ref} style={{ position: "fixed", inset: 0, background: "#000", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {a.kind === "video" ? <video key={a.id} src={fileUrl(a.path)} autoPlay muted style={{ maxWidth: "100%", maxHeight: "100%" }} onEnded={() => setI(x => (x + 1) % assets.length)} onError={() => setI(x => (x + 1) % assets.length)} />
        : <img key={a.id} src={["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "svg"].includes(a.ext) ? fileUrl(a.path) : thumbUrl(a)} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} alt="" />}
      <div style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,.6)", color: "#ddd", padding: "6px 14px", borderRadius: 20, display: "flex", gap: 12, alignItems: "center", fontSize: 12 }}>
        <span>{i + 1} / {assets.length}</span><span>{a.name}</span>
        <button className="btn ghost sm" onClick={() => setPaused(p => !p)}>{paused ? <I.Play size={13} /> : <I.Pause size={13} />}</button>
        <select className="input" style={{ height: 24 }} value={sec} onChange={e => setSec(+e.target.value)}>{[2, 3, 4, 6, 8, 12].map(s => <option key={s} value={s}>{s}s</option>)}</select>
        <span className="dim">← → · Space · Esc</span>
      </div>
    </div>
  );
}
