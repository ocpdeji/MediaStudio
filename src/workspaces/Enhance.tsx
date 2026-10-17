import { useEffect, useRef, useState } from "react";
import * as I from "lucide-react";
import { api, Asset, defaultPreset, errText, fileUrl, thumbUrl } from "../lib/api";
import { useStore } from "../lib/store";
import { clamp, fmtDur, fmtSize } from "../lib/format";
import { OutDir } from "../components/Dialogs";

const MODELS = [
  { id: "realesrgan-x4plus", label: "Photo / real-world (Real-ESRGAN x4plus)", native: 4, hint: "Best for photos and live-action video. Slowest." },
  { id: "realesr-animevideov3", label: "Fast video / animation (animevideov3)", native: 0, hint: "Much faster; designed for anime/illustration, decent on clean footage." },
  { id: "realesrgan-x4plus-anime", label: "Illustration / anime stills (x4plus-anime)", native: 4, hint: "For drawings, anime and line art." },
];

export function Enhance() {
  const { editIds, assets, jobs, toast, setDialog, open } = useStore();
  const items = editIds.map(id => assets.find(a => a.id === id)).filter((a): a is Asset => !!a && (a.kind === "image" || a.kind === "video"));
  const [cur, setCur] = useState(0);
  const a = items[Math.min(cur, items.length - 1)];
  const [ai, setAi] = useState<Awaited<ReturnType<typeof api.aiStatus>> | null>(null);
  const [method, setMethod] = useState<"ai" | "classic">("ai");
  const [scale, setScale] = useState(2), [model, setModel] = useState(MODELS[0].id), [cpu, setCpu] = useState(false), [out, setOut] = useState<string | null>(null);
  const [split, setSplit] = useState(0.5);
  const [result, setResult] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => { api.aiStatus().then(setAi).catch(() => {}); }, []);
  useEffect(() => { setResult(null); }, [a?.id]);
  const mine = jobs.filter(j => (j.kind === "upscale" || j.kind === "images" || j.kind === "convert") && j.title.includes(a?.name ?? "\u0000"));
  const latest = mine[0];
  useEffect(() => { if (latest?.status === "done" && latest.result?.outputs?.[0]) setResult(latest.result.outputs[0]); }, [latest?.status]); // eslint-disable-line
  if (!a) return <div className="empty" style={{ margin: "auto" }}><span className="hero-icon"><I.Sparkles size={30} /></span><h2>Enhance</h2>Select one or more images or videos in the Library, then choose <b>AI upscale / enhance</b> (right-click or Ctrl+K).
    <div style={{ marginTop: 14 }}><button className="btn primary" onClick={() => open("library", [])}>Go to Library</button></div></div>;
  const w = a.width ?? 0, h = a.height ?? 0;
  const frames = a.kind === "video" && a.duration_ms && a.fps_num && a.fps_den ? Math.ceil((a.duration_ms / 1000) * (a.fps_num / a.fps_den)) : 0;
  const tmpGB = frames ? (frames * (w * h * 1.5 + w * h * 1.5 * scale * scale)) / 1073741824 : 0;
  const run = async () => {
    try {
      for (const x of items) {
        if (method === "ai") {
          if (!ai?.installed) { setDialog({ kind: "settings" }); toast("Install the AI upscaler first (Settings → AI models)."); return; }
          await api.enqueue({ type: "upscale", asset_id: x.id, scale, model, cpu, out_dir: out }, `AI upscale ${scale}× · ${x.name}`);
        } else if (x.kind === "image") {
          await api.enqueue({ type: "image_batch", asset_ids: [x.id], ops: { scale_pct: scale * 100, format: "png", suffix: `_${scale}x` }, out_dir: out }, `Resample ${scale}× · ${x.name}`);
        } else {
          await api.enqueue({ type: "convert", asset_ids: [x.id], preset: defaultPreset({ width: (x.width ?? 0) * scale, height: (x.height ?? 0) * scale, crf: 18 }), out_dir: out, suffix: `_${scale}x` }, `Resample ${scale}× · ${x.name}`);
        }
      }
      toast(`Queued ${items.length} job(s)`, "ok", { label: "Show jobs", run: () => setDialog({ kind: "jobs" }) });
    } catch (e) { toast(errText(e), "error"); }
  };
  const before = a.kind === "image" ? fileUrl(a.path) : thumbUrl(a);
  return (
    <div className="editor">
      <div className="editor-main">
        <div className="toolbar"><I.Sparkles size={16} /><b>Enhance</b><span className="dim">{items.length > 1 ? `${items.length} files — settings apply to all` : a.name}</span><span className="grow" />
          {items.length > 1 && <select className="input" style={{ height: 26 }} value={cur} onChange={e => setCur(+e.target.value)}>{items.map((x, i) => <option key={x.id} value={i}>{x.name}</option>)}</select>}</div>
        <div className="editor-stage" ref={stage} style={{ background: "#0b0b0d" }}
          onPointerDown={e => { if (!result) return; const r = stage.current!.getBoundingClientRect(); const mv = (ev: PointerEvent) => setSplit(clamp((ev.clientX - r.left) / r.width, 0, 1)); mv(e.nativeEvent); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); }}>
          {result && a.kind === "video" ? <video src={fileUrl(result)} controls style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
            : <>
              <img src={result ?? before} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
              {result && <img src={before} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", clipPath: `inset(0 ${100 - split * 100}% 0 0)`, imageRendering: "pixelated" }} />}
              {result && <div className="compare-split" style={{ left: `${split * 100}%` }} />}
              {result && <><div className="vlabel">Original {w}×{h}</div><div className="vlabel" style={{ left: "auto", right: 10 }}>Result</div></>}
            </>}
          {latest && (latest.status === "running" || latest.status === "queued") && <div className="overlay-msg"><I.Loader2 className="spin" size={28} />{latest.title}<div className="progress" style={{ width: 300 }}><div style={{ width: `${latest.progress * 100}%` }} /></div>{Math.round(latest.progress * 100)}%
            <button className="btn sm" onClick={() => api.cancelJob(latest.id)}>Cancel</button></div>}
          {latest?.status === "failed" && <div className="overlay-msg" style={{ top: "auto", height: "auto", bottom: 0, inset: "auto 0 0 0" }}><div className="err-box">{latest.error}</div></div>}
        </div>
        <div className="vbar"><span className="dim">{result ? "Drag across the image to compare. The result is saved as a new file." : "Run an upscale to see a before/after comparison here."}</span></div>
      </div>
      <aside className="editor-side">
        <div className="sec"><div className="sec-h">Method</div>
          <div className="seg" style={{ width: "100%" }}><button className={`btn sm grow ${method === "ai" ? "on" : ""}`} onClick={() => setMethod("ai")}><I.Sparkles size={13} /> AI super-resolution</button><button className={`btn sm grow ${method === "classic" ? "on" : ""}`} onClick={() => setMethod("classic")}>Conventional resize</button></div>
          <div className="hint" style={{ marginTop: 8 }}>{method === "ai" ? "A neural network synthesises plausible detail. Results can look sharper than the source but may invent texture — always compare." : "Lanczos interpolation: enlarges pixels smoothly. It does not add detail and is not AI."}</div></div>
        <div className="sec"><div className="sec-h">Scale</div>
          <div className="seg">{[2, 3, 4].map(s => <button key={s} className={`btn sm ${scale === s ? "on" : ""}`} disabled={method === "ai" && s === 3 && model !== "realesr-animevideov3"} onClick={() => setScale(s)}>{s}×</button>)}</div>
          <div className="dim num" style={{ marginTop: 6 }}>{w}×{h} → <b style={{ color: "var(--text)" }}>{w * scale}×{h * scale}</b></div>
          {method === "ai" && MODELS.find(m => m.id === model)!.native === 4 && scale !== 4 && <div className="hint">This model works at 4×; the result is resampled down to {scale}× (still AI-enhanced).</div>}</div>
        {method === "ai" && <div className="sec"><div className="sec-h">AI model</div>
          {ai && !ai.installed ? <><div className="warn-box">The AI upscaler isn’t installed (~{ai.download_mb} MB download, BSD-3 licence). Nothing is downloaded without your permission.</div>
            <button className="btn primary sm" style={{ marginTop: 8 }} onClick={() => setDialog({ kind: "settings" })}>Open Settings → AI models</button></> : <>
            {MODELS.map(m => <label key={m.id} className="check" style={{ alignItems: "flex-start", margin: "6px 0" }}><input type="radio" name="model" checked={model === m.id} onChange={() => { setModel(m.id); if (m.native === 4 && scale === 3) setScale(4); }} /><span><span style={{ color: "var(--text)" }}>{m.label}</span><br /><span className="hint">{m.hint}</span></span></label>)}
            <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={cpu} onChange={e => setCpu(e.target.checked)} /> Use CPU instead of GPU (very slow — only if the GPU fails)</label>
            <div className="hint" style={{ marginTop: 6 }}>Runs locally via Vulkan on NVIDIA, AMD or Intel GPUs. Speed depends heavily on the GPU and resolution — try a short clip first.</div></>}</div>}
        {a.kind === "video" && <div className="sec"><div className="sec-h">Video</div>
          <dl className="kv"><dt>Length</dt><dd>{fmtDur(a.duration_ms)} · ≈{frames.toLocaleString()} frames</dd>{method === "ai" && <><dt>Temp space</dt><dd>≈ {tmpGB.toFixed(1)} GB while processing</dd></>}</dl>
          {method === "ai" && <div className="warn-box" style={{ marginTop: 8 }}>Every frame of the whole video is upscaled (audio is kept and stays in sync). This can take a long time and needs free disk space for intermediate frames.</div>}</div>}
        <div className="sec"><div className="sec-h">Output</div><OutDir value={out} onChange={setOut} /><div className="hint" style={{ marginTop: 6 }}>Saved as a new file ({method === "ai" ? `_ai${scale}x` : `_${scale}x`}). Originals are never modified. Source: {fmtSize(a.size)}.</div></div>
        <div className="sec"><button className="btn primary" style={{ width: "100%" }} onClick={run}><I.Sparkles size={15} /> {method === "ai" ? "Upscale with AI" : "Resize"} {items.length > 1 ? `${items.length} files` : ""}</button></div>
        {mine.length > 0 && <div className="sec"><div className="sec-h">Recent results</div>{mine.slice(0, 5).map(j => <div key={j.id} className="row" style={{ fontSize: 12, padding: "3px 0" }}><span className={`status-tag ${j.status}`}>{j.status}</span><span className="ellipsis grow">{j.title}</span>
          {j.result?.outputs?.[0] && <button className="btn sm" onClick={() => setResult(j.result!.outputs[0])}>Compare</button>}</div>)}</div>}
      </aside>
    </div>
  );
}
