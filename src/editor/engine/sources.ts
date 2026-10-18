// Frame sources for the compositor.
//  - PreviewSources: <video>/<audio> elements kept in sync with the playhead (hardware decoding, smooth playback,
//    real audio through Web Audio so volume > 100%, fades and keyframes work live).
//  - ExportSources: frame-exact decoding with WebCodecs (mediabunny), one decoder stream per clip.
import { convertFileSrc } from "@tauri-apps/api/core";
import { ALL_FORMATS, Input, UrlSource, VideoSample, VideoSampleSink } from "mediabunny";
import { Clip, end, hasAudio, keyValue, MediaRef, Project, sourceTime, US } from "../model";
import type { Frame, FrameProvider } from "./compositor";

export const fileUrl = (p: string) => convertFileSrc(p);

/** The file a clip actually decodes: reversed/stabilized derivatives, else the original if the WebView can decode it, else the optimized copy. */
export function videoPath(c: Clip, m: MediaRef): string | null {
  if (c.reverse) return m.reversed ?? null;
  if (c.stabilize && m.stabilized?.[String(c.stabilize)]) return m.stabilized[String(c.stabilize)];
  return m.playable ? m.path : m.optimized ?? null;
}
/** Time in the decoded file for a clip's source time (reversed files run backwards). */
export function fileTime(c: Clip, m: MediaRef, srcUs: US): US { return c.reverse ? Math.max(0, m.duration - srcUs) : srcUs; }

export const fxKey = (fx: Clip["fx"]) => (fx ? JSON.stringify([fx.voice || "", !!fx.denoise, !!fx.normalize, !!fx.enhance]) : "");
export const hasFx = (fx: Clip["fx"]) => !!fx && (!!fx.voice && fx.voice !== "none" || fx.denoise || fx.normalize || fx.enhance);

// ---------------------------------------------------------------- images

export class ImageCache {
  private m = new Map<string, { bmp: ImageBitmap | null; p: Promise<void>; failed?: boolean }>();
  constructor(public onLoad?: () => void) {}
  get(path: string): Frame | null {
    const e = this.m.get(path);
    if (!e) { void this.load(path); return null; }
    return e.bmp ? { src: e.bmp, w: e.bmp.width, h: e.bmp.height, ver: path } : null;
  }
  load(path: string): Promise<void> {
    const hit = this.m.get(path); if (hit) return hit.p;
    const e: { bmp: ImageBitmap | null; p: Promise<void>; failed?: boolean } = { bmp: null, p: Promise.resolve() };
    e.p = (async () => {
      try {
        const r = await fetch(fileUrl(path)); if (!r.ok) throw new Error(String(r.status));
        e.bmp = await createImageBitmap(await r.blob(), { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "none" });
        this.onLoad?.();
      } catch { e.failed = true; }
    })();
    this.m.set(path, e); return e.p;
  }
  ensure(paths: string[]) { return Promise.all(paths.map(p => this.load(p))); }
  drop(path: string) { const e = this.m.get(path); e?.bmp?.close(); this.m.delete(path); }
  clear() { for (const e of this.m.values()) e.bmp?.close(); this.m.clear(); }
}

// ---------------------------------------------------------------- preview

interface El { v: HTMLVideoElement; path: string; seeks: number; gain?: GainNode; node?: MediaElementAudioSourceNode; audioOnly?: boolean }

export class PreviewSources implements FrameProvider {
  private els = new Map<string, El>();
  private fxEls = new Map<string, El>();
  private matteEls = new Map<string, El>();
  images: ImageCache;
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  playing = false;
  masterVolume = 1;
  constructor(private redraw: () => void) { this.images = new ImageCache(redraw); }

  private ctx() {
    if (!this.ac) { this.ac = new AudioContext({ latencyHint: "interactive" }); this.master = this.ac.createGain(); this.master.connect(this.ac.destination); }
    if (this.ac.state === "suspended") void this.ac.resume();
    return this.ac;
  }

  private el(key: string, path: string, map = this.els, audioOnly = false): El {
    let e = map.get(key);
    if (e && e.path === path) return e;
    if (e) { e.v.pause(); e.v.removeAttribute("src"); e.v.load(); try { e.node?.disconnect(); } catch { /* */ } map.delete(key); }
    const v = document.createElement(audioOnly ? "audio" : "video") as HTMLVideoElement;
    v.crossOrigin = "anonymous"; v.preload = "auto"; v.playsInline = true; v.muted = false; (v as any).preservesPitch = true;
    v.src = fileUrl(path);
    const ne: El = { v, path, seeks: 0, audioOnly };
    v.addEventListener("seeked", () => { ne.seeks++; this.redraw(); });
    v.addEventListener("loadeddata", () => { ne.seeks++; this.redraw(); });
    v.addEventListener("error", () => this.redraw());
    map.set(key, ne); return ne;
  }

  private connectAudio(e: El) {
    if (e.gain) return e.gain;
    try { const ac = this.ctx(); e.node = ac.createMediaElementSource(e.v); e.gain = ac.createGain(); e.node.connect(e.gain); e.gain.connect(this.master!); }
    catch { /* Web Audio unavailable: fall back to element volume */ }
    return e.gain;
  }

  /** Bring every element in line with the playhead. Called each frame while playing and on every scrub. */
  sync(p: Project, t: US, playing: boolean) {
    this.playing = playing;
    if (this.master) this.master.gain.value = this.masterVolume;
    const live = new Set<string>(), liveFx = new Set<string>();
    const fr = (1e6 * p.fps_den) / p.fps_num;
    for (const tr of p.tracks) for (const c of tr.clips) {
      if (c.type !== "video" && c.type !== "audio") continue;
      const m = c.media ? p.media[c.media] : undefined; if (!m) continue;
      const near = t >= c.start - 3e6 && t < end(c) + 0.5e6;
      if (!near) continue;
      const active = t >= c.start && t < end(c);
      const path = c.type === "audio" ? (m.playable ? m.path : m.optimized) : videoPath(c, m);
      if (!path) continue;
      const fxPath = hasFx(c.fx) ? m.audiofx?.[fxKey(c.fx)] : undefined;
      const wantAudio = !tr.mute && !c.mute && hasAudio(p, c) && !(c.reverse && false);
      const e = this.el(c.id, path, this.els, c.type === "audio");
      live.add(c.id);
      const st = Math.min(m.duration, Math.max(0, sourceTime(c, Math.max(c.start, Math.min(end(c) - 1, t)))));
      const ft = fileTime(c, m, st) / 1e6;
      const rate = c.curve ? 1 : Math.max(0.0625, Math.min(16, c.speed ?? 1));
      // audio: separate processed element when the clip has voice/denoise effects
      let audioEl: El = e;
      if (fxPath) { audioEl = this.el(c.id, fxPath, this.fxEls, true); liveFx.add(c.id); e.v.muted = true; } else e.v.muted = false;
      const local = t - c.start;
      let vol = (c.volume ?? 1) * keyValue(c.keys?.volume, local, 1);
      if (c.fadeIn && local < c.fadeIn) vol *= Math.max(0, local / c.fadeIn);
      if (c.fadeOut && local > c.dur - c.fadeOut) vol *= Math.max(0, (c.dur - local) / c.fadeOut);
      if (!wantAudio || !active || c.reverse) vol = 0;
      const g = playing ? this.connectAudio(audioEl) : audioEl.gain;
      if (g) { g.gain.value = vol; audioEl.v.volume = 1; } else audioEl.v.volume = Math.max(0, Math.min(1, vol));
      for (const x of audioEl === e ? [e] : [e, audioEl]) {
        const xt = x === audioEl && fxPath ? st / 1e6 : ft;
        x.v.playbackRate = c.reverse ? 1 : rate;
        if (playing && active && !c.curve && !c.reverse) {
          if (Math.abs(x.v.currentTime - xt) > 0.2 || x.v.seeking) { if (!x.v.seeking) x.v.currentTime = xt; }
          if (x.v.paused) void x.v.play().catch(() => {});
        } else {
          if (!x.v.paused) x.v.pause();
          // seek precisely (to the middle of the frame) when scrubbing / paused / reversed / curve playback
          if (Math.abs(x.v.currentTime - xt) > fr / 2e6 && !x.v.seeking) x.v.currentTime = xt + 0.0005;
        }
      }
    }
    for (const [k, e] of this.els) if (!live.has(k)) { e.v.pause(); if (!this.near(p, k, t)) { e.v.removeAttribute("src"); e.v.load(); this.els.delete(k); } }
    for (const [k, e] of this.fxEls) if (!liveFx.has(k)) { e.v.pause(); this.fxEls.delete(k); e.v.removeAttribute("src"); e.v.load(); }
    for (const [k, e] of this.matteEls) if (!live.has(k)) { e.v.pause(); if (!this.near(p, k, t)) { this.matteEls.delete(k); e.v.removeAttribute("src"); e.v.load(); } }
  }
  private near(p: Project, id: string, t: US) { for (const tr of p.tracks) for (const c of tr.clips) if (c.id === id) return t >= c.start - 8e6 && t < end(c) + 8e6; return false; }

  video(c: Clip, m: MediaRef, srcUs: US): Frame | null {
    const path = videoPath(c, m); if (!path) return null;
    const e = this.els.get(c.id) ?? this.el(c.id, path);
    if (e.path !== path) return null;
    if (e.v.readyState < 2 || !e.v.videoWidth) return null;
    void srcUs;
    return { src: e.v, w: e.v.videoWidth, h: e.v.videoHeight, ver: this.playing ? `p${e.v.currentTime}` : `s${e.seeks}:${e.v.currentTime}` };
  }
  image(path: string) { return this.images.get(path); }
  matte(c: Clip, m: MediaRef, srcUs: US): Frame | null {
    if (!m.matte) return null;
    const e = this.el(c.id, m.matte, this.matteEls);
    const t = fileTime(c, m, srcUs) / 1e6;
    if (!this.playing || e.v.paused) { if (Math.abs(e.v.currentTime - t) > 0.02 && !e.v.seeking) e.v.currentTime = t + 0.0005; }
    const main = this.els.get(c.id);
    if (this.playing && main && !main.v.paused) { if (Math.abs(e.v.currentTime - main.v.currentTime) > 0.1) e.v.currentTime = main.v.currentTime; e.v.playbackRate = main.v.playbackRate; e.v.muted = true; if (e.v.paused) void e.v.play().catch(() => {}); }
    if (e.v.readyState < 2) return null;
    return { src: e.v, w: e.v.videoWidth, h: e.v.videoHeight, ver: `m${e.seeks}:${e.v.currentTime}` };
  }
  /** True while any active element is still seeking (used to delay a scrub frame instead of flashing black). */
  busy() { for (const e of this.els.values()) if (e.v.seeking) return true; return false; }
  pauseAll() { for (const e of [...this.els.values(), ...this.fxEls.values(), ...this.matteEls.values()]) e.v.pause(); }
  dispose() {
    for (const e of [...this.els.values(), ...this.fxEls.values(), ...this.matteEls.values()]) { e.v.pause(); e.v.removeAttribute("src"); e.v.load(); }
    this.els.clear(); this.fxEls.clear(); this.matteEls.clear(); this.images.clear(); void this.ac?.close(); this.ac = null;
  }
}


// ---------------------------------------------------------------- export (frame-exact)

/** A decoded source a frame needs: clip key, file and time in that file (seconds). */
interface Need { key: string; path: string; t: number }

/** Every decoded video/matte frame needed to render timeline time `t` (incl. transition partners). */
export function needsAt(p: Project, t: US): Need[] {
  const out: Need[] = [];
  for (const tr of p.tracks) {
    if (tr.hide || tr.kind === "audio") continue;
    for (const c of tr.clips) {
      if (c.type !== "video") continue;
      const inT = t >= c.start && t < end(c);
      const tr2 = !!c.transition && t >= end(c) - c.transition.dur / 2 && t < end(c) + c.transition.dur / 2;
      const prevTr = tr.clips.some(a => a.transition && Math.abs(end(a) - c.start) <= 1000 && t >= c.start - a.transition.dur / 2 && t < c.start + a.transition.dur / 2);
      if (!(inT || tr2 || prevTr)) continue;
      const m = c.media ? p.media[c.media] : undefined; if (!m) continue;
      const path = videoPath(c, m); if (!path) throw new Error(`“${m.name}” isn't ready for export yet (still being prepared).`);
      const ft = fileTime(c, m, Math.max(0, Math.min(m.duration - 1, sourceTime(c, t)))) / 1e6;
      out.push({ key: c.id, path, t: ft });
      if (c.cutout && m.matte) out.push({ key: `matte:${c.id}`, path: m.matte, t: ft });
    }
  }
  return out;
}

interface Stream { gen: AsyncGenerator<VideoSample | null> | null; path: string; ts: number[]; idx: number; frame: Frame | null; rot: number }

/** Export decoding. The whole frame schedule is planned first, so each clip gets one decoder stream fed with its
 *  complete, ordered list of timestamps (the decoder reads ahead through that list for efficient decoding). */
export class ExportSources implements FrameProvider {
  private inputs = new Map<string, Promise<{ input: Input; sink: VideoSampleSink; offset: number; rot: number } | null>>();
  private streams = new Map<string, Stream>();
  private frameNeeds: Need[][] = [];
  private pending = new Map<string, Frame | null>();
  private finished: Stream[] = [];
  images = new ImageCache();

  private open(path: string) {
    let p = this.inputs.get(path);
    if (!p) {
      p = (async () => {
        const input = new Input({ source: new UrlSource(fileUrl(path)), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track) return null;
        if (!(await track.canDecode())) throw new Error(`Can't decode ${path.split(/[\\/]/).pop()} for export (codec ${track.codec}).`);
        const offset = await track.getFirstTimestamp();
        const rot = ((await track.getRotation()) / 90) | 0;
        return { input, sink: new VideoSampleSink(track), offset, rot };
      })();
      this.inputs.set(path, p);
    }
    return p;
  }

  /** Plan the frames to render (timeline times, in order). */
  plan(p: Project, times: US[]) {
    this.frameNeeds = times.map(t => needsAt(p, t));
    this.streams.clear();
    for (const needs of this.frameNeeds) for (const n of needs) {
      let s = this.streams.get(n.key);
      if (!s) { s = { gen: null, path: n.path, ts: [], idx: 0, frame: null, rot: 0 }; this.streams.set(n.key, s); }
      s.ts.push(n.t);
    }
  }

  private async next(key: string): Promise<Frame | null> {
    const s = this.streams.get(key)!;
    if (!s.gen) {
      const src = await this.open(s.path); if (!src) return null;
      s.rot = src.rot;
      s.gen = src.sink.samplesAtTimestamps(s.ts.map(x => src.offset + x + 1e-6));
    }
    const r = await s.gen.next();
    s.idx++;
    if (s.idx >= s.ts.length) this.finished.push(s);
    const sample = (r.done ? null : r.value) as VideoSample | null;
    if (!sample) return s.frame; // past the end of the file: hold the last frame
    if (s.frame && s.frame.ver === `x${sample.timestamp}`) { sample.close(); return s.frame; }
    // the previous frame was uploaded by the last render; release it before holding a new one
    (s.frame?.src as VideoFrame | undefined)?.close?.();
    const vf = sample.toVideoFrame();
    sample.close();
    s.frame = { src: vf, w: vf.displayWidth, h: vf.displayHeight, rot: s.rot, ver: `x${vf.timestamp}` };
    return s.frame;
  }

  /** Decode everything frame `i` of the plan needs (call in order, before the synchronous render). */
  async prefetch(p: Project, i: number) {
    for (const s of this.finished.splice(0)) { (s.frame?.src as VideoFrame | undefined)?.close?.(); s.frame = null; s.gen = null; }
    this.pending.clear();
    const jobs: Promise<unknown>[] = [];
    for (const n of this.frameNeeds[i] ?? []) jobs.push(this.next(n.key).then(f => { this.pending.set(n.key, f); }));
    for (const tr of p.tracks) for (const c of tr.clips) {
      if (c.type === "image" || (c.type === "sticker" && c.sticker?.media)) {
        const mm = c.type === "sticker" ? p.media[c.sticker!.media!] : c.media ? p.media[c.media] : undefined;
        if (mm) jobs.push(this.images.load(mm.playable ? mm.path : mm.optimized ?? mm.path));
        if (c.cutout && mm?.matte) jobs.push(this.images.load(mm.matte));
      }
    }
    const bg = p.background.type === "image" && p.background.image; if (bg) jobs.push(this.images.load(bg));
    await Promise.all(jobs);
  }

  video(c: Clip): Frame | null { return this.pending.get(c.id) ?? null; }
  matte(c: Clip): Frame | null { return this.pending.get(`matte:${c.id}`) ?? null; }
  image(path: string) { return this.images.get(path); }
  async dispose() {
    for (const s of this.streams.values()) { (s.frame?.src as VideoFrame | undefined)?.close?.(); try { await s.gen?.return(undefined); } catch { /* */ } }
    this.streams.clear();
    for (const p of this.inputs.values()) { try { (await p)?.input.dispose(); } catch { /* */ } }
    this.inputs.clear(); this.images.clear();
  }
}
