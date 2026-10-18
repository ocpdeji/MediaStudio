// AI background removal ("Remove BG"), run on the GPU through WebGPU (WASM fallback).
//  - Video: Robust Video Matting, frame by frame with its recurrent state, written as a grayscale matte video.
//  - Photos: IS-Net (any subject) when installed, otherwise RVM on a single frame.
// The matte is stored in the cache and used by the compositor as an alpha mask (preview and export).
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import * as ort from "onnxruntime-web/webgpu";
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from "mediabunny";
import { ed } from "../api";
import { fileUrl } from "../engine/sources";
import { notify, patchMedia, useEd, watchJob } from "../store";

// Release builds serve the runtime from /ort (copied at build time); the dev server forbids importing /public
// modules, so development loads it straight from the package.
ort.env.wasm.wasmPaths = import.meta.env.DEV ? "/node_modules/onnxruntime-web/dist/" : "/ort/";
ort.env.logLevel = "error";

const useMatte = create<{ m: Record<string, { progress: number; label: string }> }>(() => ({ m: {} }));
const setState = (mid: string, v: { progress: number; label: string } | null) => {
  const m = { ...useMatte.getState().m }; if (v) m[mid] = v; else delete m[mid]; useMatte.setState({ m });
};
export const matteState = (mid: string) => useMatte(s => s.m[mid]);

const sessions = new Map<string, Promise<ort.InferenceSession>>();
/** Which inference backend the last model loaded on (shown in progress labels). */
export let backend = "", backendError = "";
/** Stage timings of the last video cutout (ms, summed). */
export const perf = { prep: 0, run: 0, push: 0 };
async function session(id: string, gpuOutputs: string[] = []) {
  let s = sessions.get(id);
  if (!s) {
    s = (async () => {
      const buf = await invoke<ArrayBuffer>("model_bytes", { id: id.replace(/-video$/, "") });
      try { const s = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ["webgpu"], graphOptimizationLevel: "all", preferredOutputLocation: Object.fromEntries(gpuOutputs.map(o => [o, "gpu-buffer"])) as any }); backend = "GPU (WebGPU)"; return s; }
      catch (e) { backendError = String(e); backend = "CPU"; return ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ["wasm"] }); }
    })();
    sessions.set(id, s);
    s.catch(() => sessions.delete(id));
  }
  return s;
}

/** Make sure a model is installed; installs it (as a visible job) if needed. */
async function needModel(id: string, label: string, mid: string): Promise<boolean> {
  const st = await ed.models(); const m = st.find(x => x.id === id);
  if (m?.installed) return true;
  setState(mid, { progress: 0, label: `Downloading ${label} (${Math.round(m?.mb ?? 0)} MB)…` });
  const job = await ed.installModel(id);
  return new Promise(res => watchJob(job, {
    progress: p => setState(mid, { progress: p, label: `Downloading ${label}… ${Math.round(p * 100)}%` }),
    done: () => res(true), fail: e => { setState(mid, null); notify(`Model download failed: ${e}`); res(false); },
  }));
}

let running = new Set<string>();
export async function ensureMatte(mid: string, force = false) {
  const st = useEd.getState(); const m = st.p?.media[mid];
  if (!m || running.has(mid) || (m.matte && !force)) return;
  running.add(mid);
  try {
    if (m.kind === "image") await imageMatte(mid);
    else await videoMatte(mid);
  } catch (e) { notify(`Background removal failed: ${e instanceof Error ? e.message : e}`); }
  finally { running.delete(mid); setState(mid, null); }
}

async function imageMatte(mid: string) {
  const m = useEd.getState().p!.media[mid];
  const models = await ed.models();
  const useIs = models.find(x => x.id === "isnet")?.installed || !models.find(x => x.id === "rvm")?.installed;
  const id = useIs ? "isnet" : "rvm";
  if (!(await needModel(id, useIs ? "image cutout model" : "matting model", mid))) return;
  setState(mid, { progress: 0.2, label: "Finding the subject…" });
  const bmp = await createImageBitmap(await (await fetch(fileUrl(m.playable ? m.path : m.optimized ?? m.path))).blob(), { imageOrientation: "from-image" });
  const W = bmp.width, H = bmp.height;
  let alpha: Float32Array, aw: number, ah: number;
  const sess = await session(id);
  if (useIs) {
    const S = 1024; const cv = new OffscreenCanvas(S, S); const g = cv.getContext("2d")!; g.drawImage(bmp, 0, 0, S, S);
    const px = g.getImageData(0, 0, S, S).data; const inp = new Float32Array(3 * S * S);
    for (let i = 0; i < S * S; i++) { inp[i] = px[i * 4] / 255 - 0.5; inp[S * S + i] = px[i * 4 + 1] / 255 - 0.5; inp[2 * S * S + i] = px[i * 4 + 2] / 255 - 0.5; }
    const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", inp, [1, 3, S, S]) });
    const o = out[sess.outputNames[0]].data as Float32Array; let lo = Infinity, hi = -Infinity;
    for (const v of o) { if (v < lo) lo = v; if (v > hi) hi = v; }
    alpha = o.map(v => (v - lo) / Math.max(1e-6, hi - lo)); aw = S; ah = S;
  } else {
    const [w, h] = fitSize(W, H, 1280);
    const r = await rvmFrame(sess, bmp, w, h, null, ratioFor(w, h));
    alpha = r.pha; aw = w; ah = h;
  }
  setState(mid, { progress: 0.8, label: "Saving cutout…" });
  const small = new OffscreenCanvas(aw, ah); const sg = small.getContext("2d")!; const id8 = sg.createImageData(aw, ah);
  for (let i = 0; i < aw * ah; i++) { const v = Math.round(Math.max(0, Math.min(1, alpha[i])) * 255); id8.data[i * 4] = v; id8.data[i * 4 + 1] = v; id8.data[i * 4 + 2] = v; id8.data[i * 4 + 3] = 255; }
  sg.putImageData(id8, 0, 0);
  const full = new OffscreenCanvas(W, H); const fg = full.getContext("2d")!; fg.imageSmoothingQuality = "high"; fg.drawImage(small, 0, 0, W, H);
  const png = new Uint8Array(await (await full.convertToBlob({ type: "image/png" })).arrayBuffer());
  const pid = useEd.getState().id!;
  const path = await ed.writeAsset(pid, `matte-${mid}-${Date.now()}.png`, png);
  patchMedia(mid, { matte: path });
  notify("Background removed", "ok");
}

const fitSize = (w: number, h: number, max: number): [number, number] => { const s = Math.min(1, max / Math.max(w, h)); let W = Math.round((w * s) / 8) * 8, H = Math.round((h * s) / 2) * 2; W = Math.max(16, W); H = Math.max(16, H); return [W, H]; };
// RVM guidance: internal resolution ~200–270 px on the short side (0.375 for 720p, 0.25 for 1080p)
const ratioFor = (w: number, h: number) => Math.max(0.1, Math.min(1, 216 / Math.min(w, h)));

type Rec = { r1: ort.Tensor; r2: ort.Tensor; r3: ort.Tensor; r4: ort.Tensor };
const zeroRec = (): Rec => { const z = () => new ort.Tensor("float32", new Float32Array(1), [1, 1, 1, 1]); return { r1: z(), r2: z(), r3: z(), r4: z() }; };

/** Pixels → planar float RGB input for RVM. */
function toInput(g: OffscreenCanvasRenderingContext2D, W: number, H: number): Float32Array {
  const px = g.getImageData(0, 0, W, H).data; const n = W * H; const inp = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { inp[i] = px[j] / 255; inp[n + i] = px[j + 1] / 255; inp[2 * n + i] = px[j + 2] / 255; }
  return inp;
}
async function rvmRun(sess: ort.InferenceSession, inp: Float32Array, W: number, H: number, rec: Rec, ratio: number) {
  const out = await sess.run({ src: new ort.Tensor("float32", inp, [1, 3, H, W]), r1i: rec.r1, r2i: rec.r2, r3i: rec.r3, r4i: rec.r4, downsample_ratio: new ort.Tensor("float32", new Float32Array([ratio]), [1]) });
  return { pha: out.pha.data as Float32Array, rec: { r1: out.r1o, r2: out.r2o, r3: out.r3o, r4: out.r4o } };
}
/** Diagnostics: average ms per RVM inference at a given size (development builds call this from tests). */
export async function benchRvm(W: number, H: number, ratio: number, n = 8) {
  const sess = await session("rvm-video", ["r1o", "r2o", "r3o", "r4o"]); let rec = zeroRec(); const inp = new Float32Array(3 * W * H);
  let t0 = 0; for (let i = 0; i < n + 2; i++) { if (i === 2) t0 = performance.now(); const r = await rvmRun(sess, inp, W, H, rec, ratio); if (i) for (const x of [rec.r1, rec.r2, rec.r3, rec.r4]) x.dispose(); rec = r.rec; }
  return (performance.now() - t0) / n;
}
async function rvmFrame(sess: ort.InferenceSession, src: CanvasImageSource, W: number, H: number, rec: Rec | null, ratio: number) {
  const cv = new OffscreenCanvas(W, H); const g = cv.getContext("2d", { willReadFrequently: true })!; g.drawImage(src, 0, 0, W, H);
  return rvmRun(sess, toInput(g, W, H), W, H, rec ?? zeroRec(), ratio);
}

async function videoMatte(mid: string) {
  if (!(await needModel("rvm", "video matting model", mid))) return;
  const m = useEd.getState().p!.media[mid];
  const path = m.playable ? m.path : m.optimized;
  if (!path) throw new Error("The clip is still being prepared — try again in a moment.");
  setState(mid, { progress: 0, label: "Loading model…" });
  const sess = await session("rvm-video", ["r1o", "r2o", "r3o", "r4o"]);
  const input = new Input({ source: new UrlSource(fileUrl(path)), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack(); if (!track) throw new Error("No video track");
  const sink = new VideoSampleSink(track); const offset = await track.getFirstTimestamp();
  // the matte is a soft alpha mask: 960 px is plenty (it's scaled smoothly to the clip) and ~2× faster than 1280
  const [W, H] = fitSize(m.width, m.height, 960);
  const fps = m.fps_num / m.fps_den, frames = Math.max(1, Math.ceil((m.duration / 1e6) * fps));
  const env = await ed.env();
  const name = `${mid}-${m.size}-${m.mtime}.mp4`;
  const s = await invoke<{ id: number }>("render_start", { spec: { width: W, height: H, fps_num: m.fps_num, fps_den: m.fps_den, frames, input: "gray", out_dir: `${env.cache}\\mattes`, name, audio: null, internal: true } });
  let rec = zeroRec(); const ratio = ratioFor(W, H); perf.prep = perf.run = perf.push = 0;
  const grays = [new Uint8Array(W * H), new Uint8Array(W * H)];
  const cv = new OffscreenCanvas(W, H); const g = cv.getContext("2d", { willReadFrequently: true })!;
  const t0 = performance.now(); let i = 0;
  const times = function* () { for (let k = 0; k < frames; k++) yield offset + (k * m.fps_den) / m.fps_num + 1e-6; };
  const it = sink.samplesAtTimestamps(times())[Symbol.asyncIterator]();
  // pipeline: decode + convert frame i+1 on the CPU while the GPU runs frame i; pushes stream to the encoder
  const prep = async (): Promise<Float32Array | null> => {
    const r = await it.next(); if (r.done) return null;
    if (r.value) { g.clearRect(0, 0, W, H); r.value.draw(g, 0, 0, W, H); r.value.close(); }
    const tp = performance.now(); const x = toInput(g, W, H); perf.prep += performance.now() - tp; return x;
  };
  const push = (b: Uint8Array) => invoke("render_push", b, { headers: { "x-session": String(s.id) } });
  let pushing: Promise<unknown> = Promise.resolve();
  try {
    let next = prep();
    while (true) {
      const inp = await next; if (!inp) break;
      next = prep();
      const ta = performance.now();
      const r = await rvmRun(sess, inp, W, H, rec, ratio);
      // recurrent state stays on the GPU between frames; free the previous one
      if (i > 0) for (const x of [rec.r1, rec.r2, rec.r3, rec.r4]) x.dispose();
      rec = r.rec; perf.run += performance.now() - ta;
      await pushing;
      const gray = grays[i % 2];
      for (let k = 0; k < W * H; k++) { const v = r.pha[k]; gray[k] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0; }
      pushing = push(gray);
      i++;
      if (i % 5 === 0) { const fpsDone = i / ((performance.now() - t0) / 1000); setState(mid, { progress: i / frames, label: `Removing background… ${Math.round((i / frames) * 100)}% · ${fpsDone.toFixed(1)} fps on ${backend} · ${Math.max(0, Math.round((frames - i) / Math.max(0.1, fpsDone)))} s left` }); }
    }
    await pushing;
    while (i < frames) { await push(grays[(i + 1) % 2]); i++; }
    const out = await invoke<string>("render_finish", { id: s.id });
    patchMedia(mid, { matte: out });
    notify("Background removed", "ok");
  } catch (e) { await invoke("render_cancel", { id: s.id }).catch(() => {}); throw e; }
  finally { input.dispose(); }
}

