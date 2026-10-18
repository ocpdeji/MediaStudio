// Export: frame-exact GPU rendering → YUV → native FFmpeg encoder (NVENC/QSV/AMF/x264/x265/ProRes/AV1),
// with an audio mix rendered by FFmpeg from a typed plan.
import { invoke } from "@tauri-apps/api/core";
import { Clip, duration, end, frameTime, hasAudio, keyValue, Project, srcOffset, srcSpan, US } from "../model";
import { Compositor } from "./compositor";
import { ExportSources, fxKey, hasFx } from "./sources";

export interface AudioSeg { path: string; src_in_us: number; src_out_us: number; start_us: number; speed: number; keep_pitch: boolean; volume: [number, number][]; fade_in_us: number; fade_out_us: number }
export interface AudioPlan { segs: AudioSeg[]; duration_us: number }

/** Build the FFmpeg audio mix: one segment per audible clip (speed curves become 16 constant-speed pieces). */
export function audioPlan(p: Project, range?: [US, US]): AudioPlan {
  const segs: AudioSeg[] = [];
  const r0 = range?.[0] ?? 0, r1 = range?.[1] ?? duration(p);
  for (const tr of p.tracks) {
    if (tr.mute) continue;
    for (const c of tr.clips) {
      if (c.mute || !hasAudio(p, c) || (c.volume ?? 1) <= 0) continue;
      if (end(c) <= r0 || c.start >= r1) continue;
      const m = p.media[c.media!];
      const fxPath = hasFx(c.fx) ? m.audiofx?.[fxKey(c.fx)] : undefined;
      // reversed clips use the reversed file (its time runs from the end of the original backwards)
      const path = fxPath && !c.reverse ? fxPath : c.reverse ? m.reversed ?? null : m.path;
      if (!path) continue;
      const pieces = c.curve ? 16 : 1;
      for (let i = 0; i < pieces; i++) {
        const l0 = (c.dur * i) / pieces, l1 = (c.dur * (i + 1)) / pieces;
        const s0 = srcOffset(c, l0), s1 = srcOffset(c, l1);
        let a = (c.in ?? 0) + s0, b = (c.in ?? 0) + s1;
        if (c.reverse) { const span = srcSpan(c); a = m.duration - ((c.in ?? 0) + span - s0); b = m.duration - ((c.in ?? 0) + span - s1); }
        const start = c.start + l0;
        // clip the segment to the export range
        const cut0 = Math.max(0, r0 - start), cut1 = Math.max(0, start + (l1 - l0) - r1);
        const sp = (b - a) / Math.max(1, l1 - l0);
        const vol: [number, number][] = [];
        const base = c.volume ?? 1;
        const keys = c.keys?.volume;
        const sampleVol = (local: number) => {
          let v = base * keyValue(keys, local, 1);
          if (c.fadeIn && local < c.fadeIn && pieces > 1) v *= Math.max(0, local / c.fadeIn);
          if (c.fadeOut && local > c.dur - c.fadeOut && pieces > 1) v *= Math.max(0, (c.dur - local) / c.fadeOut);
          return v;
        };
        if (keys?.length || pieces > 1) { const n = keys?.length ? 24 : 2; for (let j = 0; j <= n; j++) { const ll = l0 + cut0 + ((l1 - l0 - cut0 - cut1) * j) / n; vol.push([Math.round(ll - (l0 + cut0)), sampleVol(ll)]); } }
        else vol.push([0, base]);
        segs.push({
          path, src_in_us: Math.round(a + cut0 * sp), src_out_us: Math.round(b - cut1 * sp), start_us: Math.round(start + cut0 - r0), speed: sp, keep_pitch: c.keepPitch ?? true, volume: vol,
          fade_in_us: pieces === 1 ? Math.max(0, (c.fadeIn ?? 0) - cut0) : 0, fade_out_us: pieces === 1 ? Math.max(0, (c.fadeOut ?? 0) - cut1) : 0,
        });
      }
    }
  }
  return { segs: segs.filter(s => s.src_out_us > s.src_in_us), duration_us: Math.max(0, r1 - r0) };
}

export interface ExportOptions {
  width: number; height: number; fps_num: number; fps_den: number;
  preset: { container: string; vcodec: string; crf: number; bitrate_kbps: number | null; acodec: string; abitrate_kbps: number; hw: string; speed: string; strip_metadata: boolean };
  outDir: string; name: string; range?: [US, US];
}
export interface ExportProgress { stage: "prepare" | "audio" | "video" | "finish"; frame: number; frames: number; fps: number; eta: number; encoder?: string; pct?: number }

export class ExportCancelled extends Error { constructor() { super("Export cancelled"); } }

/** Make the size encoder-friendly: width multiple of 8 (GPU YUV packing), height even. */
export function encSize(w: number, h: number): [number, number] { return [Math.max(16, Math.round(w / 8) * 8), Math.max(16, Math.round(h / 2) * 2)]; }

export async function exportVideo(p: Project, o: ExportOptions, onProgress: (x: ExportProgress) => void, signal: AbortSignal): Promise<string> {
  const [W, H] = encSize(o.width, o.height);
  const r0 = o.range?.[0] ?? 0, r1 = o.range?.[1] ?? duration(p);
  const proj = { ...p, fps_num: o.fps_num, fps_den: o.fps_den };
  const f0 = Math.ceil((r0 * o.fps_num) / (1e6 * o.fps_den) - 1e-6), f1 = Math.floor((r1 * o.fps_num) / (1e6 * o.fps_den) - 1e-6) + 1;
  const frames = Math.max(1, f1 - f0);
  onProgress({ stage: "prepare", frame: 0, frames, fps: 0, eta: 0 });
  await document.fonts.ready;
  await loadFonts(p);
  const canvas = new OffscreenCanvas(W, H);
  const comp = new Compositor(canvas);
  const src = new ExportSources();
  let session: number | null = null;
  const unl: (() => void)[] = [];
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unl.push(await listen<number>("render-audio", e => onProgress({ stage: "audio", frame: 0, frames, fps: 0, eta: 0, pct: e.payload })));
    const audio = o.preset.acodec === "none" ? null : audioPlan(p, [r0, r1]);
    const started = await invoke<{ id: number; encoder: string }>("render_start", {
      spec: { width: W, height: H, fps_num: o.fps_num, fps_den: o.fps_den, frames, input: "yuv420p", out_dir: o.outDir, name: o.name, preset: { ...o.preset, fit: "contain" }, audio, internal: false },
    });
    session = started.id;
    if (signal.aborted) throw new ExportCancelled();
    const bufs = [new Uint8Array((W * H * 3) / 2), new Uint8Array((W * H * 3) / 2)];
    const sends: (Promise<unknown> | null)[] = [null, null];
    src.plan(p, Array.from({ length: frames }, (_, i) => frameTime(proj, f0 + i)));
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new ExportCancelled();
      const t = frameTime(proj, f0 + i);
      await src.prefetch(p, i);
      const tgt = comp.render(p, t, src, W, H);
      const slot = i % 2;
      if (sends[slot]) await sends[slot];
      comp.readYUV(tgt, W, H, bufs[slot]);
      comp.release(tgt);
      sends[slot] = invoke("render_push", bufs[slot], { headers: { "x-session": String(session) } });
      if (i % 3 === 0 || i === frames - 1) {
        const el = (performance.now() - t0) / 1000, fps = (i + 1) / Math.max(0.001, el);
        onProgress({ stage: "video", frame: i + 1, frames, fps, eta: (frames - i - 1) / Math.max(0.1, fps), encoder: started.encoder });
      }
    }
    await Promise.all(sends.filter(Boolean));
    onProgress({ stage: "finish", frame: frames, frames, fps: 0, eta: 0, encoder: started.encoder });
    const out = await invoke<string>("render_finish", { id: session });
    session = null;
    return out;
  } finally {
    unl.forEach(u => u());
    if (session != null) await invoke("render_cancel", { id: session }).catch(() => {});
    await src.dispose();
    comp.dispose();
  }
}

/** Load every font used by text in the project so the export never falls back to a default face. */
export async function loadFonts(p: Project) {
  const fams = new Set<string>();
  for (const tr of p.tracks) for (const c of tr.clips) if (c.text?.font) fams.add(`${c.text.italic ? "italic " : ""}${c.text.bold ? 800 : 400} 40px "${c.text.font}"`);
  await Promise.all([...fams].map(f => document.fonts.load(f).catch(() => [])));
}

/** Clip count that still needs preparation (optimized copies, reversed files…) before export. */
export function notReady(p: Project): Clip[] {
  const out: Clip[] = [];
  for (const tr of p.tracks) for (const c of tr.clips) {
    const m = c.media ? p.media[c.media] : undefined; if (!m) continue;
    if (c.type === "video" && (c.reverse ? !m.reversed : c.stabilize ? !m.stabilized?.[String(c.stabilize)] : !m.playable && !m.optimized)) out.push(c);
    if (c.cutout && !m.matte) out.push(c);
  }
  return out;
}
