import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as I from "lucide-react";
import { api, Asset, errText } from "../lib/api";
import { setLeaveGuard, useStore } from "../lib/store";
import { clamp, extOf, fmtSize, stem } from "../lib/format";
import * as P from "../lib/imageproc";
import { History } from "../lib/timeline";
import { confirmAsk, Slider } from "../components/ui";

type Tool = "adjust" | "crop" | "retouch" | "transform" | "layers";
type Blend = "source-over" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "soft-light" | "hard-light" | "difference" | "color" | "luminosity";
interface Layer { id: string; kind: "text" | "image"; name: string; visible: boolean; opacity: number; blend: Blend; x: number; y: number; scale: number; rotation: number;
  text?: { content: string; size: number; color: string; font: string; weight: number; shadow: boolean; bg: string | null }; img?: ImageBitmap | HTMLCanvasElement }
interface Snap { doc: HTMLCanvasElement; adj: P.Adjustments; layers: Layer[] }
const ASPECTS: [string, number | "orig" | 0][] = [["Free", 0], ["Original", "orig"], ["1:1", 1], ["4:5", 4 / 5], ["9:16", 9 / 16], ["16:9", 16 / 9], ["4:3", 4 / 3], ["3:4", 3 / 4], ["3:2", 3 / 2], ["2:3", 2 / 3], ["21:9", 21 / 9]];
let lid = 0;

async function decodeAsset(a: Asset): Promise<HTMLCanvasElement> {
  const toCanvas = (b: ImageBitmap) => { const c = P.mkCanvas(b.width, b.height); c.getContext("2d")!.drawImage(b, 0, 0); return c; };
  try { const buf = await api.readMedia(a.id); return toCanvas(await createImageBitmap(new Blob([buf]))); }
  catch { // formats the web engine can't decode (TIFF, some HEIC…): let FFmpeg rasterise a full-resolution PNG
    const p = await api.captureFrame(a.id, 0, true); const buf = await api.readCacheFile(p); return toCanvas(await createImageBitmap(new Blob([buf], { type: "image/png" })));
  }
}

function layerBox(l: Layer, x?: CanvasRenderingContext2D) {
  if (l.kind === "image" && l.img) return { w: l.img.width * l.scale, h: l.img.height * l.scale };
  const t = l.text!; const c = x ?? P.mkCanvas(1, 1).getContext("2d")!;
  c.font = `${t.weight} ${t.size * l.scale}px ${t.font}`;
  const lines = t.content.split("\n"); const w = Math.max(...lines.map(s => c.measureText(s).width)); return { w: w + t.size * l.scale * 0.4, h: lines.length * t.size * l.scale * 1.2 + t.size * l.scale * 0.2 };
}
function drawLayers(x: CanvasRenderingContext2D, layers: Layer[], k: number) {
  for (const l of layers) {
    if (!l.visible) continue;
    x.save(); x.globalAlpha = l.opacity; x.globalCompositeOperation = l.blend;
    x.translate(l.x * k, l.y * k); x.rotate((l.rotation * Math.PI) / 180);
    if (l.kind === "image" && l.img) { const w = l.img.width * l.scale * k, h = l.img.height * l.scale * k; x.drawImage(l.img, -w / 2, -h / 2, w, h); }
    else if (l.text) {
      const t = l.text, size = t.size * l.scale * k; x.font = `${t.weight} ${size}px ${t.font}`; x.textAlign = "center"; x.textBaseline = "middle";
      const lines = t.content.split("\n"), lh = size * 1.2, h0 = -((lines.length - 1) * lh) / 2;
      if (t.bg) { const b = layerBox(l, x); x.fillStyle = t.bg; x.fillRect((-b.w * k) / 2, (-b.h * k) / 2, b.w * k, b.h * k); }
      if (t.shadow) { x.shadowColor = "rgba(0,0,0,.65)"; x.shadowBlur = size * 0.15; x.shadowOffsetY = size * 0.04; }
      x.fillStyle = t.color; lines.forEach((s, i) => x.fillText(s, 0, h0 + i * lh));
    }
    x.restore();
  }
}

export function ImageEditor() {
  const { editIds, assets, open } = useStore();
  const [asset, setAsset] = useState<Asset | null>(null);
  useEffect(() => {
    const id = editIds.find(i => { const a = assets.find(x => x.id === i); return !a || a.kind === "image" || a.kind === "raw"; });
    if (id == null) return setAsset(null);
    const a = assets.find(x => x.id === id);
    if (a) setAsset(a); else api.detail(id).then(d => setAsset(d.asset)).catch(() => setAsset(null));
  }, [editIds]); // eslint-disable-line
  if (!asset) return <div className="empty" style={{ margin: "auto" }}><span className="hero-icon"><I.SlidersHorizontal size={30} /></span><h2>Image editor</h2>Select an image in the Library and press <span className="kbd">E</span> — or right-click → Edit.
    <div style={{ marginTop: 14 }}><button className="btn primary" onClick={() => open("library", [])}>Go to Library</button></div></div>;
  return <Editor key={asset.id} asset={asset} />;
}

function Editor({ asset }: { asset: Asset }) {
  const toast = useStore(s => s.toast);
  const stage = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const original = useRef<HTMLCanvasElement | null>(null);
  const hist = useRef<History<Snap> | null>(null);
  const [snap, setSnapState] = useState<Snap | null>(null);
  const [adjLive, setAdjLive] = useState<P.Adjustments>(P.ADJ_DEFAULT);
  const [tool, setTool] = useState<Tool>("adjust");
  const view = useRef({ s: 1, ox: 0, oy: 0, fitted: true });
  const [, redraw] = useState(0);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [aspect, setAspect] = useState<number | "orig" | 0>(0);
  const [straight, setStraight] = useState(0);
  const [brush, setBrush] = useState(40), [brushMode, setBrushMode] = useState<"brush" | "box">("brush"), [method, setMethod] = useState<P.RemoveMethod>("smart");
  const mask = useRef<HTMLCanvasElement | null>(null), maskTint = useRef<HTMLCanvasElement | null>(null);
  const [maskEmpty, setMaskEmpty] = useState(true);
  const cloneSrc = useRef<{ x: number; y: number } | null>(null), cloneOff = useRef<{ ox: number; oy: number } | null>(null);
  const [compare, setCompare] = useState(false), [split, setSplit] = useState(0.5);
  const [selLayer, setSelLayer] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const [fmt, setFmt] = useState(() => ({ jpg: "jpeg", jpeg: "jpeg", jfif: "jpeg", webp: "webp" } as Record<string, string>)[asset.ext] ?? "png");
  const [quality, setQuality] = useState(92);
  const [name, setName] = useState(`${stem(asset.name)}_edit`);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<any>(null);
  const space = useRef(false);
  const previewCache = useRef<{ key: string; c: HTMLCanvasElement } | null>(null);
  const docId = useRef(0);

  const commit = useCallback((next: Partial<Snap>) => {
    const h = hist.current!; const cur = h.present; const s: Snap = { ...cur, ...next };
    if (next.doc) docId.current++;
    h.push(s); setSnapState(s); setSaved(false);
    if (next.adj) setAdjLive(next.adj);
  }, []);

  // ---------------------------------------------------------- load
  useEffect(() => {
    let live = true;
    decodeAsset(asset).then(c => { if (!live) return; original.current = c; hist.current = new History<Snap>({ doc: c, adj: P.ADJ_DEFAULT, layers: [] }, 40); setSnapState(hist.current.present); setLoading(false); })
      .catch(e => { toast(`Could not open image: ${errText(e)}`, "error"); setLoading(false); });
    return () => { live = false; };
  }, [asset.id]); // eslint-disable-line
  useEffect(() => { setLeaveGuard(saved ? null : () => confirmAsk("Discard unsaved image edits?", "Your changes to this image haven’t been saved.", "Discard", true)); return () => setLeaveGuard(null); }, [saved]);

  const doc = snap?.doc;
  const fit = useCallback(() => {
    const el = stage.current; if (!el || !doc) return;
    const s = Math.min((el.clientWidth - 40) / doc.width, (el.clientHeight - 40) / doc.height, 8);
    view.current = { s, ox: (el.clientWidth - doc.width * s) / 2, oy: (el.clientHeight - doc.height * s) / 2, fitted: true }; redraw(n => n + 1);
  }, [doc]);
  useEffect(() => { fit(); }, [doc?.width, doc?.height, fit]);
  useEffect(() => { const ro = new ResizeObserver(() => { const c = cv.current, el = stage.current; if (!c || !el) return; const d = devicePixelRatio || 1; c.width = el.clientWidth * d; c.height = el.clientHeight * d; if (view.current.fitted) fit(); else redraw(n => n + 1); }); if (stage.current) ro.observe(stage.current); return () => ro.disconnect(); }, [fit]);

  // ---------------------------------------------------------- render
  const preview = useCallback((d: HTMLCanvasElement, adj: P.Adjustments) => {
    if (P.isDefault(adj)) return d;
    const k = Math.min(1, (Math.max(view.current.s, 0.05) * (devicePixelRatio || 1) * 1.2), 2400 / Math.max(d.width, d.height));
    const w = Math.round(d.width * Math.min(1, k)), h = Math.round(d.height * Math.min(1, k));
    const key = `${docId.current}|${w}|${JSON.stringify(adj)}`;
    if (previewCache.current?.key !== key) previewCache.current = { key, c: P.applyAdjustments(d, w, h, adj, w / d.width) };
    return previewCache.current.c;
  }, []);
  useEffect(() => {
    const c = cv.current; if (!c || !snap) return;
    const raf = requestAnimationFrame(() => {
      const x = c.getContext("2d")!, k = devicePixelRatio || 1, { s, ox, oy } = view.current, d = snap.doc, dw = d.width * s, dh = d.height * s;
      x.setTransform(k, 0, 0, k, 0, 0); x.clearRect(0, 0, c.width, c.height); x.imageSmoothingQuality = "high"; x.imageSmoothingEnabled = s < 2;
      x.drawImage(preview(d, adjLive), ox, oy, dw, dh);
      x.save(); x.beginPath(); x.rect(ox, oy, dw, dh); x.clip(); x.translate(ox, oy); drawLayers(x, snap.layers, s); x.restore();
      if (compare && original.current) {
        const sx = ox + dw * split; x.save(); x.beginPath(); x.rect(ox, oy, dw * split, dh); x.clip();
        x.drawImage(original.current, 0, 0, original.current.width, original.current.height, ox, oy, dw, dh); x.restore();
        x.fillStyle = "rgba(0,0,0,.65)"; x.font = "12px Segoe UI"; x.fillRect(ox + 8, oy + 8, 52, 20); x.fillRect(ox + dw - 52, oy + 8, 44, 20); x.fillStyle = "#fff"; x.fillText("Before", ox + 14, oy + 22); x.fillText("After", ox + dw - 46, oy + 22);
        x.fillStyle = "#fff"; x.fillRect(sx - 1, oy, 2, dh);
      }
      if (tool === "retouch" && mask.current && !maskEmpty) { x.globalAlpha = 0.5; x.drawImage(maskTint.current!, ox, oy, dw, dh); x.globalAlpha = 1; }
      if (drag.current?.type === "box" && drag.current.r) { const r = drag.current.r; x.strokeStyle = "#ff3b5c"; x.setLineDash([5, 4]); x.strokeRect(ox + r.x * s, oy + r.y * s, r.w * s, r.h * s); x.setLineDash([]); }
      if (tool === "crop" && crop) {
        const rx = ox + crop.x * s, ry = oy + crop.y * s, rw = crop.w * s, rh = crop.h * s;
        x.fillStyle = "rgba(0,0,0,.6)"; x.beginPath(); x.rect(ox, oy, dw, dh); x.rect(rx, ry, rw, rh); x.fill("evenodd");
        x.strokeStyle = "rgba(255,255,255,.35)"; x.lineWidth = 1; x.beginPath();
        for (let i = 1; i < 3; i++) { x.moveTo(rx + (rw * i) / 3, ry); x.lineTo(rx + (rw * i) / 3, ry + rh); x.moveTo(rx, ry + (rh * i) / 3); x.lineTo(rx + rw, ry + (rh * i) / 3); }
        x.stroke(); x.strokeStyle = "#fff"; x.lineWidth = 2; x.strokeRect(rx, ry, rw, rh);
        const lbl = `${Math.round(crop.w)} × ${Math.round(crop.h)}`; x.font = "12px Segoe UI"; const tw = x.measureText(lbl).width + 12; x.fillStyle = "rgba(0,0,0,.75)"; x.fillRect(rx, Math.max(0, ry - 22), tw, 20); x.fillStyle = "#fff"; x.fillText(lbl, rx + 6, Math.max(0, ry - 22) + 14);
      }
      if (tool === "layers" && selLayer) { const l = snap.layers.find(q => q.id === selLayer); if (l) { const b = layerBox(l); x.save(); x.translate(ox + l.x * s, oy + l.y * s); x.rotate((l.rotation * Math.PI) / 180); x.strokeStyle = "#6aa8ff"; x.setLineDash([5, 4]); x.strokeRect((-b.w * s) / 2, (-b.h * s) / 2, b.w * s, b.h * s); x.restore(); } }
      if (tool === "retouch" && cursor.current && brushMode === "brush") { x.beginPath(); x.arc(cursor.current.x, cursor.current.y, brush / 2, 0, Math.PI * 2); x.strokeStyle = "#fff"; x.lineWidth = 1.5; x.stroke(); x.strokeStyle = "#000"; x.lineWidth = 0.5; x.stroke(); }
      if (tool === "retouch" && method === "clone" && cloneSrc.current) { const p = cloneSrc.current; x.strokeStyle = "#38c98a"; x.lineWidth = 2; x.beginPath(); x.moveTo(ox + p.x * s - 8, oy + p.y * s); x.lineTo(ox + p.x * s + 8, oy + p.y * s); x.moveTo(ox + p.x * s, oy + p.y * s - 8); x.lineTo(ox + p.x * s, oy + p.y * s + 8); x.stroke(); }
    });
    return () => cancelAnimationFrame(raf);
  });

  // ---------------------------------------------------------- pointer
  const pt = (e: React.PointerEvent | React.WheelEvent) => { const r = cv.current!.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top; return { sx, sy, x: (sx - view.current.ox) / view.current.s, y: (sy - view.current.oy) / view.current.s }; };
  const ensureMask = () => { if (!doc) return; if (!mask.current || mask.current.width !== doc.width || mask.current.height !== doc.height) { mask.current = P.mkCanvas(doc.width, doc.height); maskTint.current = P.mkCanvas(doc.width, doc.height); setMaskEmpty(true); } };
  const tint = () => { const t = maskTint.current!.getContext("2d")!; t.globalCompositeOperation = "copy"; t.drawImage(mask.current!, 0, 0); t.globalCompositeOperation = "source-in"; t.fillStyle = "#ff2d55"; t.fillRect(0, 0, t.canvas.width, t.canvas.height); t.globalCompositeOperation = "source-over"; };
  const paint = (a: { x: number; y: number }, b: { x: number; y: number }) => { const x = mask.current!.getContext("2d")!; x.strokeStyle = "#fff"; x.lineCap = x.lineJoin = "round"; x.lineWidth = brush / view.current.s; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x + 0.01, b.y); x.stroke(); setMaskEmpty(false); tint(); };
  const ar = () => (aspect === "orig" && doc ? doc.width / doc.height : (aspect as number));
  const cropFrom = (x0: number, y0: number, x1: number, y1: number) => {
    const W = doc!.width, H = doc!.height; x1 = clamp(x1, 0, W); y1 = clamp(y1, 0, H); let w = x1 - x0, h = y1 - y0; const r = ar();
    if (r) { if (Math.abs(w) / r > Math.abs(h)) h = Math.sign(h || 1) * Math.abs(w) / r; else w = Math.sign(w || 1) * Math.abs(h) * r;
      const mw = w < 0 ? x0 : W - x0, mh = h < 0 ? y0 : H - y0, k = Math.min(1, w ? mw / Math.abs(w) : 1, h ? mh / Math.abs(h) : 1); w *= k; h *= k; }
    return { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.abs(w), h: Math.abs(h) };
  };
  const cropMax = (a0 = aspect) => { if (!doc) return; const W = doc.width, H = doc.height, r = a0 === "orig" ? W / H : (a0 as number); let w = W, h = H; if (r) { if (W / H > r) w = H * r; else h = W / r; } setCrop({ x: (W - w) / 2, y: (H - h) / 2, w, h }); };
  const hitLayer = (x: number, y: number) => [...(snap?.layers ?? [])].reverse().find(l => { if (!l.visible) return false; const b = layerBox(l); return Math.abs(x - l.x) <= b.w / 2 && Math.abs(y - l.y) <= b.h / 2; });

  const onDown = (e: React.PointerEvent) => {
    if (!doc) return; (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = pt(e);
    if (compare && Math.abs(p.sx - (view.current.ox + doc.width * view.current.s * split)) < 10) { drag.current = { type: "split" }; return; }
    if (e.button === 1 || e.button === 2 || space.current || tool === "adjust" || tool === "transform") { drag.current = { type: "pan", sx: p.sx, sy: p.sy, ox: view.current.ox, oy: view.current.oy }; return; }
    if (tool === "crop") {
      if (crop && p.x > crop.x && p.x < crop.x + crop.w && p.y > crop.y && p.y < crop.y + crop.h) drag.current = { type: "cropmove", dx: p.x - crop.x, dy: p.y - crop.y };
      else { const x0 = clamp(p.x, 0, doc.width), y0 = clamp(p.y, 0, doc.height); drag.current = { type: "crop", x0, y0 }; setCrop({ x: x0, y: y0, w: 0, h: 0 }); }
    } else if (tool === "retouch") {
      if (method === "clone" && e.altKey) { cloneSrc.current = { x: p.x, y: p.y }; cloneOff.current = null; redraw(n => n + 1); return; }
      if (method === "clone" && !cloneSrc.current) { toast("Alt+click to choose the clone source first"); return; }
      ensureMask();
      if (method === "clone" && cloneSrc.current && !cloneOff.current) cloneOff.current = { ox: Math.round(cloneSrc.current.x - p.x), oy: Math.round(cloneSrc.current.y - p.y) };
      if (brushMode === "brush") { drag.current = { type: "paint", last: p }; paint(p, p); } else drag.current = { type: "box", x0: p.x, y0: p.y, r: null };
    } else if (tool === "layers") {
      const l = hitLayer(p.x, p.y) ?? snap!.layers.find(q => q.id === selLayer);
      if (l) { setSelLayer(l.id); drag.current = { type: "layer", id: l.id, dx: p.x - l.x, dy: p.y - l.y, start: snap!.layers }; }
    }
    redraw(n => n + 1);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = pt(e); cursor.current = { x: p.sx, y: p.sy };
    const g = drag.current;
    if (g?.type === "pan") { view.current = { ...view.current, ox: g.ox + p.sx - g.sx, oy: g.oy + p.sy - g.sy, fitted: false }; }
    else if (g?.type === "split" && doc) setSplit(clamp((p.sx - view.current.ox) / (doc.width * view.current.s), 0, 1));
    else if (g?.type === "crop") setCrop(cropFrom(g.x0, g.y0, p.x, p.y));
    else if (g?.type === "cropmove" && crop && doc) setCrop({ ...crop, x: clamp(p.x - g.dx, 0, doc.width - crop.w), y: clamp(p.y - g.dy, 0, doc.height - crop.h) });
    else if (g?.type === "paint") { paint(g.last, p); g.last = p; }
    else if (g?.type === "box") g.r = { x: Math.min(g.x0, p.x), y: Math.min(g.y0, p.y), w: Math.abs(p.x - g.x0), h: Math.abs(p.y - g.y0) };
    else if (g?.type === "layer") { setSnapState(s => s && ({ ...s, layers: s.layers.map(l => (l.id === g.id ? { ...l, x: p.x - g.dx, y: p.y - g.dy } : l)) })); g.moved = true; }
    redraw(n => n + 1);
  };
  const onUp = () => {
    const g = drag.current; drag.current = null; if (!g) return;
    if (g.type === "box" && g.r && g.r.w > 1 && g.r.h > 1) { const x = mask.current!.getContext("2d")!; x.fillStyle = "#fff"; x.fillRect(g.r.x, g.r.y, g.r.w, g.r.h); setMaskEmpty(false); tint(); }
    if (g.type === "crop" && crop && (crop.w < 4 || crop.h < 4)) setCrop(null);
    if (g.type === "layer" && g.moved) { const layers = snap!.layers; hist.current!.present = { ...hist.current!.present, layers: g.start }; commit({ layers }); }
    redraw(n => n + 1);
  };
  const onWheel = (e: React.WheelEvent) => { const p = pt(e), v = view.current, ns = clamp(v.s * Math.exp(-e.deltaY * 0.0015), 0.02, 40); view.current = { s: ns, ox: p.sx - (p.sx - v.ox) * (ns / v.s), oy: p.sy - (p.sy - v.oy) * (ns / v.s), fitted: false }; redraw(n => n + 1); };

  // ---------------------------------------------------------- operations
  const run = async (label: string, f: () => void | Promise<void>) => { setBusy(label); await new Promise(r => setTimeout(r, 30)); try { await f(); } catch (e) { toast(errText(e), "error"); } finally { setBusy(null); } };
  const applyRetouch = () => run("Reconstructing…", () => {
    if (!mask.current || maskEmpty || !doc) return toast("Paint over the area first");
    const d = P.cloneCanvas(doc), W = d.width, H = d.height, x = P.ctx2d(d);
    if (method === "blur" || method === "pixelate") {
      const fx = P.mkCanvas(W, H), fc = fx.getContext("2d")!;
      if (method === "blur") { fc.filter = `blur(${Math.max(6, Math.min(W, H) / 120)}px)`; fc.drawImage(d, 0, 0); fc.filter = "none"; }
      else { const k = Math.max(6, Math.round(Math.min(W, H) / 90)), sm = P.mkCanvas(W / k, H / k); sm.getContext("2d")!.drawImage(d, 0, 0, sm.width, sm.height); fc.imageSmoothingEnabled = false; fc.drawImage(sm, 0, 0, W, H); }
      fc.globalCompositeOperation = "destination-in"; fc.drawImage(mask.current, 0, 0); x.drawImage(fx, 0, 0);
    } else {
      const m = mask.current.getContext("2d")!.getImageData(0, 0, W, H).data;
      P.reconstruct(x, W, H, m, method === "smooth" ? "smooth" : "smart", method === "clone" ? cloneOff.current ?? undefined : undefined);
    }
    commit({ doc: d }); mask.current.getContext("2d")!.clearRect(0, 0, W, H); setMaskEmpty(true); cloneOff.current = null;
  });
  const applyCrop = () => { if (!crop || !doc) return; const c = P.mkCanvas(crop.w, crop.h); c.getContext("2d")!.drawImage(doc, Math.round(crop.x), Math.round(crop.y), Math.round(crop.w), Math.round(crop.h), 0, 0, c.width, c.height); commit({ doc: c, layers: snap!.layers.map(l => ({ ...l, x: l.x - crop.x, y: l.y - crop.y })) }); setCrop(null); };
  const applyStraighten = () => run("Straightening…", () => { if (!doc || !straight) return; commit({ doc: P.straighten(doc, straight) }); setStraight(0); });
  const geo = (f: (d: HTMLCanvasElement) => HTMLCanvasElement) => doc && commit({ doc: f(doc) });
  const [rw, setRw] = useState(0), [rh, setRh] = useState(0), [lock, setLock] = useState(true), [cw, setCw] = useState(0), [ch, setCh] = useState(0), [anchor, setAnchor] = useState({ x: 0.5, y: 0.5 }), [fill, setFill] = useState<string | null>("#ffffff");
  useEffect(() => { if (doc) { setRw(doc.width); setRh(doc.height); setCw(doc.width); setCh(doc.height); } }, [doc?.width, doc?.height]); // eslint-disable-line
  const undo = () => { if (hist.current?.undo()) { docId.current++; setSnapState(hist.current.present); setAdjLive(hist.current.present.adj); setSaved(false); } };
  const redo = () => { if (hist.current?.redo()) { docId.current++; setSnapState(hist.current.present); setAdjLive(hist.current.present.adj); setSaved(false); } };
  const addText = () => { if (!doc) return; const l: Layer = { id: `l${++lid}`, kind: "text", name: "Text", visible: true, opacity: 1, blend: "source-over", x: doc.width / 2, y: doc.height * 0.85, scale: 1, rotation: 0, text: { content: "Your text", size: Math.round(doc.height / 14), color: "#ffffff", font: "Segoe UI", weight: 700, shadow: true, bg: null } }; commit({ layers: [...snap!.layers, l] }); setSelLayer(l.id); setTool("layers"); };
  const addImageLayer = async (f?: File) => { if (!doc || !f) return; const b = await createImageBitmap(f); const sc = Math.min(1, (doc.width * 0.4) / b.width); const l: Layer = { id: `l${++lid}`, kind: "image", name: f.name, visible: true, opacity: 1, blend: "source-over", x: doc.width / 2, y: doc.height / 2, scale: sc, rotation: 0, img: b }; commit({ layers: [...snap!.layers, l] }); setSelLayer(l.id); setTool("layers"); };
  const patchLayer = (id: string, p: Partial<Layer> | ((l: Layer) => Partial<Layer>), live = false) => {
    const next = snap!.layers.map(l => (l.id === id ? { ...l, ...(typeof p === "function" ? p(l) : p) } : l));
    if (live) setSnapState({ ...snap!, layers: next }); else commit({ layers: next });
  };
  const moveLayer = (id: string, d: number) => { const ls = [...snap!.layers]; const i = ls.findIndex(l => l.id === id), j = i + d; if (j < 0 || j >= ls.length) return; [ls[i], ls[j]] = [ls[j], ls[i]]; commit({ layers: ls }); };

  const renderFinal = async () => {
    const s = hist.current!.present; const d = s.doc;
    const base = P.isDefault(adjLive) ? P.cloneCanvas(d) : P.applyAdjustments(d, d.width, d.height, adjLive, 1);
    drawLayers(base.getContext("2d")!, s.layers, 1);
    if (fmt === "jpeg") { const c = P.mkCanvas(base.width, base.height), x = c.getContext("2d")!; x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(base, 0, 0); return c; }
    return base;
  };
  const save = (mode: "copy" | "as" | "overwrite") => run("Encoding…", async () => {
    let fileExt = fmt === "jpeg" ? "jpg" : fmt, f = fmt, target: { asset?: number; dir?: string } = { asset: asset.id }, fname = `${name.trim() || "edited"}.${fileExt}`, overwrite = false;
    if (mode === "overwrite") {
      const e0 = extOf(asset.name), map: Record<string, string> = { jpg: "jpeg", jpeg: "jpeg", jfif: "jpeg", png: "png", webp: "webp" };
      if (!map[e0]) return toast(`Overwriting .${e0} isn’t supported — save a copy instead`, "error");
      if (!(await confirmAsk(`Replace the original “${asset.name}”?`, "The original file will be overwritten with the edited image. This cannot be undone from inside the app.", "Overwrite", true))) return;
      f = map[e0]; fileExt = e0; fname = asset.name; overwrite = true;
    }
    if (mode === "as") { const dir = await openDialog({ directory: true, title: "Save edited image to…" }); if (!dir || Array.isArray(dir)) return; target = { dir }; }
    const c = await renderFinal();
    const blob = await P.toBlob(c, `image/${f}`, quality / 100);
    const path = await api.saveOutput(new Uint8Array(await blob.arrayBuffer()), target, fname, overwrite);
    setSaved(true); toast(`Saved ${path.split(/[\\/]/).pop()} · ${fmtSize(blob.size)} · ${c.width}×${c.height}`, "ok"); useStore.getState().refresh(); void fileExt;
  });

  // ---------------------------------------------------------- keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (useStore.getState().workspace !== "image" || useStore.getState().dialog) return;
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      if (mod && key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && key === "y") { e.preventDefault(); redo(); return; }
      if (mod && key === "s") { e.preventDefault(); save(e.shiftKey ? "as" : "copy"); return; }
      if (mod) return;
      if (e.key === " ") { space.current = true; e.preventDefault(); return; }
      const m: Record<string, () => void> = { a: () => setTool("adjust"), c: () => { setTool("crop"); }, r: () => setTool("retouch"), t: () => setTool("transform"), l: () => setTool("layers"), "0": fit, "\\": () => setCompare(x => !x),
        "[": () => setBrush(b => clamp(b - 5, 4, 300)), "]": () => setBrush(b => clamp(b + 5, 4, 300)), enter: () => (tool === "crop" ? applyCrop() : tool === "retouch" ? applyRetouch() : undefined),
        delete: () => { if (tool === "layers" && selLayer) { commit({ layers: snap!.layers.filter(l => l.id !== selLayer) }); setSelLayer(null); } } };
      if (m[key]) { e.preventDefault(); m[key](); }
    };
    const ku = (e: KeyboardEvent) => { if (e.key === " ") space.current = false; };
    window.addEventListener("keydown", k); window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", k); window.removeEventListener("keyup", ku); };
  });

  const groups = useMemo(() => [...new Set(P.ADJ_SLIDERS.map(s => s.group))], []);
  const sel = snap?.layers.find(l => l.id === selLayer);
  const T = (t: Tool, label: string, icon: React.ReactNode, keyHint: string) => <button className={`btn sm ${tool === t ? "on" : ""}`} onClick={() => setTool(t)} title={`${label} (${keyHint})`}>{icon}{label}</button>;
  return (
    <div className="editor">
      <div className="editor-main">
        <div className="toolbar">
          {T("adjust", "Adjust", <I.SlidersHorizontal size={14} />, "A")}{T("crop", "Crop", <I.Crop size={14} />, "C")}{T("retouch", "Retouch", <I.Eraser size={14} />, "R")}{T("transform", "Transform", <I.RotateCw size={14} />, "T")}{T("layers", "Layers & text", <I.Layers size={14} />, "L")}
          <span className="sep" />
          <button className="btn ghost icon sm" onClick={undo} disabled={!hist.current?.canUndo} title="Undo (Ctrl+Z)"><I.Undo2 size={15} /></button>
          <button className="btn ghost icon sm" onClick={redo} disabled={!hist.current?.canRedo} title="Redo (Ctrl+Y)"><I.Redo2 size={15} /></button>
          <button className={`btn sm ${compare ? "on" : ""}`} onClick={() => setCompare(!compare)} title="Before / after (\)"><I.SplitSquareHorizontal size={14} /> Before/after</button>
          <button className="btn ghost sm" onClick={fit} title="Fit (0)">Fit</button>
          <button className="btn ghost sm" onClick={() => { const el = stage.current!; const v = view.current; const ns = 1, cx = el.clientWidth / 2, cy = el.clientHeight / 2; view.current = { s: ns, ox: cx - (cx - v.ox) * (ns / v.s), oy: cy - (cy - v.oy) * (ns / v.s), fitted: false }; redraw(n => n + 1); }}>100%</button>
          <span className="grow" />
          <span className="dim num">{doc ? `${doc.width} × ${doc.height}` : ""} · {Math.round(view.current.s * 100)}%</span>
          <span className="sep" />
          <span className="dim ellipsis" style={{ maxWidth: 260 }} title={asset.path}>{asset.name}{!saved && " •"}</span>
        </div>
        <div className="editor-stage" ref={stage}>
          <canvas ref={cv} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => { cursor.current = null; redraw(n => n + 1); }} onWheel={onWheel} onContextMenu={e => e.preventDefault()}
            style={{ cursor: tool === "crop" || (tool === "retouch" && brushMode === "box") ? "crosshair" : tool === "retouch" ? "none" : tool === "layers" ? "move" : "grab" }} />
          {(loading || busy) && <div className="overlay-msg"><I.Loader2 className="spin" size={28} />{busy ?? "Opening full-resolution image…"}</div>}
        </div>
      </div>
      <aside className="editor-side">
        {tool === "adjust" && <>{groups.map(g => <div key={g} className="sec"><div className="sec-h">{g}</div>
          {P.ADJ_SLIDERS.filter(s => s.group === g).map(s => <Slider key={s.key} label={s.label} min={s.min} max={s.max} step={s.step} value={adjLive[s.key] as number}
            onChange={v => setAdjLive({ ...adjLive, [s.key]: v })} onCommit={() => commit({ adj: adjLive })} reset={P.ADJ_DEFAULT[s.key] as number} format={v => (s.step < 1 ? v.toFixed(2) : String(v))} />)}</div>)}
          <div className="sec"><label className="check"><input type="checkbox" checked={adjLive.grayscale} onChange={e => { const a = { ...adjLive, grayscale: e.target.checked }; setAdjLive(a); commit({ adj: a }); }} /> Black & white</label>
            <div className="row" style={{ marginTop: 10 }}><button className="btn sm" onClick={() => commit({ adj: P.ADJ_DEFAULT })}>Reset adjustments</button><span className="hint">Double-click a value to reset it</span></div>
            <div className="hint" style={{ marginTop: 8 }}>Adjustments are non-destructive: they stay editable until you save, and are applied once at full resolution on export.</div></div></>}
        {tool === "crop" && <div className="sec"><div className="sec-h">Crop</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>{ASPECTS.map(([l, v]) => <button key={l} className={`btn sm ${aspect === v ? "on" : ""}`} onClick={() => { setAspect(v); cropMax(v); }}>{l}</button>)}</div>
          <div className="hint" style={{ margin: "8px 0" }}>Drag on the image to draw; drag inside to move. Enter applies.</div>
          <div className="dim num">{crop ? `${Math.round(crop.w)} × ${Math.round(crop.h)} px` : "No crop area"}</div>
          <div className="row" style={{ marginTop: 8 }}><button className="btn primary sm" disabled={!crop} onClick={applyCrop}>Apply crop</button><button className="btn sm" onClick={() => cropMax()}>Select all</button><button className="btn sm ghost" onClick={() => setCrop(null)}>Clear</button></div>
          <div className="hsep" /><div className="sec-h">Straighten</div>
          <Slider label="Angle" min={-45} max={45} step={0.1} value={straight} onChange={setStraight} format={v => v.toFixed(1) + "°"} reset={0} />
          <button className="btn sm" disabled={!straight} onClick={applyStraighten}>Apply straighten (auto-crop)</button></div>}
        {tool === "retouch" && <div className="sec"><div className="sec-h">Remove objects, watermarks & blemishes</div>
          <div className="seg"><button className={`btn sm ${brushMode === "brush" ? "on" : ""}`} onClick={() => setBrushMode("brush")}><I.Brush size={13} /> Brush</button><button className={`btn sm ${brushMode === "box" ? "on" : ""}`} onClick={() => setBrushMode("box")}><I.Square size={13} /> Box</button></div>
          <Slider label="Brush size" min={4} max={300} value={brush} onChange={setBrush} />
          <div className="field" style={{ gridTemplateColumns: "100px 1fr" }}><label>Method</label><select className="input" value={method} onChange={e => { setMethod(e.target.value as P.RemoveMethod); cloneSrc.current = null; cloneOff.current = null; }}>
            <option value="smart">Smart fill — texture from nearby</option><option value="smooth">Smooth fill — for soft areas</option><option value="clone">Clone / heal from a source</option><option value="blur">Blur (cover up)</option><option value="pixelate">Pixelate (cover up)</option></select></div>
          <div className="hint">{method === "clone" ? "Alt+click to set the source, then paint over the target. The copied texture is blended seamlessly into its new surroundings." : method === "blur" || method === "pixelate" ? "Covers the area — the original content is obscured, not reconstructed." : "Paint over the object plus a small margin, then press Remove (Enter). The area is synthesised from its surroundings — hidden content is never recovered. Work in small passes for the best result."}</div>
          <div className="row" style={{ marginTop: 10 }}><button className="btn primary" disabled={maskEmpty} onClick={applyRetouch}>Remove</button><button className="btn sm ghost" onClick={() => { mask.current?.getContext("2d")!.clearRect(0, 0, mask.current.width, mask.current.height); setMaskEmpty(true); redraw(n => n + 1); }}>Clear selection</button></div>
          <div className="hint" style={{ marginTop: 10 }}>Only remove watermarks from images you own or are authorised to edit.</div></div>}
        {tool === "transform" && doc && <>
          <div className="sec"><div className="sec-h">Rotate & flip</div><div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
            <button className="btn sm" onClick={() => geo(d => P.rotateCanvas(d, -90))}><I.RotateCcw size={13} /> 90°</button><button className="btn sm" onClick={() => geo(d => P.rotateCanvas(d, 90))}><I.RotateCw size={13} /> 90°</button>
            <button className="btn sm" onClick={() => geo(d => P.rotateCanvas(d, 180))}>180°</button><button className="btn sm" onClick={() => geo(d => P.flipCanvas(d, "h"))}><I.FlipHorizontal size={13} /> Flip H</button><button className="btn sm" onClick={() => geo(d => P.flipCanvas(d, "v"))}><I.FlipVertical size={13} /> Flip V</button></div></div>
          <div className="sec"><div className="sec-h">Resize (image size)</div>
            <div className="row">W <input className="input num-in" type="number" value={rw} onChange={e => { setRw(+e.target.value); if (lock) setRh(Math.round((+e.target.value * doc.height) / doc.width)); }} /> H <input className="input num-in" type="number" value={rh} onChange={e => { setRh(+e.target.value); if (lock) setRw(Math.round((+e.target.value * doc.width) / doc.height)); }} />
              <label className="check"><input type="checkbox" checked={lock} onChange={e => setLock(e.target.checked)} /> lock</label></div>
            <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 6 }}>{[0.25, 0.5, 0.75, 2].map(f => <button key={f} className="btn sm" onClick={() => { setRw(Math.round(doc.width * f)); setRh(Math.round(doc.height * f)); }}>{f * 100}%</button>)}
              {[1080, 2048, 3840].map(l => <button key={l} className="btn sm" onClick={() => { const s = l / Math.max(doc.width, doc.height); setRw(Math.round(doc.width * s)); setRh(Math.round(doc.height * s)); }}>{l} long</button>)}</div>
            <button className="btn primary sm" style={{ marginTop: 8 }} disabled={!(rw > 0 && rh > 0) || (rw === doc.width && rh === doc.height) || rw > 16384 || rh > 16384} onClick={() => run("Resampling…", () => geo(d => P.resizeCanvas(d, rw, rh)))}>Apply resize</button>
            <div className="hint" style={{ marginTop: 6 }}>Conventional high-quality resampling. For AI super-resolution use the Enhance workspace.</div></div>
          <div className="sec"><div className="sec-h">Canvas size</div>
            <div className="row">W <input className="input num-in" type="number" value={cw} onChange={e => setCw(+e.target.value)} /> H <input className="input num-in" type="number" value={ch} onChange={e => setCh(+e.target.value)} /></div>
            <div className="row" style={{ marginTop: 6 }}><span className="dim">Anchor</span><div style={{ display: "grid", gridTemplateColumns: "repeat(3,18px)", gap: 2 }}>{[0, 0.5, 1].flatMap(y => [0, 0.5, 1].map(x => <button key={`${x}${y}`} className={`btn icon sm ${anchor.x === x && anchor.y === y ? "on" : ""}`} style={{ width: 18, height: 18 }} onClick={() => setAnchor({ x, y })} />))}</div>
              <span className="dim">Fill</span><input type="color" value={fill ?? "#ffffff"} onChange={e => setFill(e.target.value)} disabled={fill === null} /><label className="check"><input type="checkbox" checked={fill === null} onChange={e => setFill(e.target.checked ? null : "#ffffff")} /> transparent</label></div>
            <button className="btn primary sm" style={{ marginTop: 8 }} disabled={!(cw > 0 && ch > 0) || (cw === doc.width && ch === doc.height)} onClick={() => geo(d => P.canvasSize(d, cw, ch, anchor, fill))}>Apply canvas size</button></div></>}
        {tool === "layers" && snap && <div className="sec"><div className="sec-h">Layers <span className="row" style={{ gap: 4 }}><button className="btn sm" onClick={addText}><I.Type size={13} /> Text</button>
          <label className="btn sm"><I.ImagePlus size={13} /> Image<input type="file" accept="image/*" hidden onChange={e => addImageLayer(e.target.files?.[0])} /></label></span></div>
          {[...snap.layers].reverse().map(l => <div key={l.id} className={`side-item ${selLayer === l.id ? "on" : ""}`} onClick={() => setSelLayer(l.id)}>
            <button className="btn ghost icon sm" onClick={e => { e.stopPropagation(); patchLayer(l.id, { visible: !l.visible }); }}>{l.visible ? <I.Eye size={13} /> : <I.EyeOff size={13} />}</button>
            {l.kind === "text" ? <I.Type size={14} /> : <I.Image size={14} />}<span className="ellipsis grow">{l.kind === "text" ? l.text!.content.split("\n")[0] : l.name}</span>
            <button className="btn ghost icon sm" onClick={e => { e.stopPropagation(); moveLayer(l.id, 1); }} title="Bring forward"><I.ChevronUp size={13} /></button><button className="btn ghost icon sm" onClick={e => { e.stopPropagation(); moveLayer(l.id, -1); }} title="Send backward"><I.ChevronDown size={13} /></button></div>)}
          <div className="side-item" style={{ cursor: "default" }}><I.Image size={14} /><span className="dim">Background (photo)</span></div>
          {!snap.layers.length && <div className="hint">Add text (titles, captions, your own watermark) or image overlays (logos, stickers). Drag on the canvas to position.</div>}
          {sel && <div style={{ marginTop: 10 }}>
            {sel.kind === "text" && <><textarea className="input" rows={2} style={{ width: "100%" }} value={sel.text!.content} onChange={e => patchLayer(sel.id, l => ({ text: { ...l.text!, content: e.target.value } }), true)} onBlur={() => commit({ layers: snap.layers })} />
              <div className="row" style={{ margin: "6px 0" }}><select className="input grow" value={sel.text!.font} onChange={e => patchLayer(sel.id, l => ({ text: { ...l.text!, font: e.target.value } }))}>{["Segoe UI", "Arial", "Georgia", "Times New Roman", "Consolas", "Impact", "Comic Sans MS", "Trebuchet MS", "Verdana"].map(f => <option key={f}>{f}</option>)}</select>
                <input type="color" value={sel.text!.color} onChange={e => patchLayer(sel.id, l => ({ text: { ...l.text!, color: e.target.value } }))} />
                <button className={`btn icon sm ${sel.text!.weight >= 700 ? "on" : ""}`} onClick={() => patchLayer(sel.id, l => ({ text: { ...l.text!, weight: l.text!.weight >= 700 ? 400 : 700 } }))}><I.Bold size={13} /></button>
                <button className={`btn icon sm ${sel.text!.shadow ? "on" : ""}`} title="Shadow" onClick={() => patchLayer(sel.id, l => ({ text: { ...l.text!, shadow: !l.text!.shadow } }))}><I.Sun size={13} /></button>
                <button className={`btn icon sm ${sel.text!.bg ? "on" : ""}`} title="Background box" onClick={() => patchLayer(sel.id, l => ({ text: { ...l.text!, bg: l.text!.bg ? null : "rgba(0,0,0,0.55)" } }))}><I.RectangleHorizontal size={13} /></button></div>
              <Slider label="Size" min={8} max={Math.max(400, Math.round((doc?.height ?? 1000) / 3))} value={sel.text!.size} onChange={v => patchLayer(sel.id, l => ({ text: { ...l.text!, size: v } }), true)} onCommit={() => commit({ layers: snap.layers })} /></>}
            {sel.kind === "image" && <Slider label="Scale" min={0.02} max={4} step={0.01} value={sel.scale} onChange={v => patchLayer(sel.id, { scale: v }, true)} onCommit={() => commit({ layers: snap.layers })} format={v => Math.round(v * 100) + "%"} />}
            <Slider label="Opacity" min={0} max={1} step={0.01} value={sel.opacity} onChange={v => patchLayer(sel.id, { opacity: v }, true)} onCommit={() => commit({ layers: snap.layers })} format={v => Math.round(v * 100) + "%"} />
            <Slider label="Rotation" min={-180} max={180} value={sel.rotation} onChange={v => patchLayer(sel.id, { rotation: v }, true)} onCommit={() => commit({ layers: snap.layers })} format={v => v + "°"} reset={0} />
            <div className="field" style={{ gridTemplateColumns: "100px 1fr" }}><label>Blend</label><select className="input" value={sel.blend} onChange={e => patchLayer(sel.id, { blend: e.target.value as Blend })}>{["source-over", "multiply", "screen", "overlay", "soft-light", "hard-light", "darken", "lighten", "difference", "color", "luminosity"].map(b => <option key={b} value={b}>{b === "source-over" ? "Normal" : b}</option>)}</select></div>
            <button className="btn sm danger" onClick={() => { commit({ layers: snap.layers.filter(l => l.id !== sel.id) }); setSelLayer(null); }}><I.Trash2 size={13} /> Delete layer</button></div>}
          <div className="hint" style={{ marginTop: 10 }}>Layer masks aren’t available in this version.</div></div>}
        <div className="sec"><div className="sec-h">Export</div>
          <div className="field" style={{ gridTemplateColumns: "70px 1fr" }}><label>Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} /></div>
          <div className="field" style={{ gridTemplateColumns: "70px 1fr" }}><label>Format</label><select className="input" value={fmt} onChange={e => setFmt(e.target.value)}><option value="png">PNG (lossless)</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></div>
          {fmt !== "png" && <Slider label="Quality" min={50} max={100} value={quality} onChange={setQuality} />}
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            <button className="btn primary" onClick={() => save("copy")} disabled={!!busy || loading} title="Save a new file next to the original (Ctrl+S)"><I.Save size={14} /> Save copy</button>
            <button className="btn" onClick={() => save("as")} disabled={!!busy || loading} title="Choose a folder (Ctrl+Shift+S)">Save to…</button>
            <button className="btn danger" onClick={() => save("overwrite")} disabled={!!busy || loading}>Overwrite original…</button></div>
          <div className="hint" style={{ marginTop: 8 }}>Encoded once from the full-resolution working copy. Existing files are never replaced unless you choose Overwrite. Exports don’t include camera metadata (EXIF/GPS).</div>
        </div>
      </aside>
    </div>
  );
}
