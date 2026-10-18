// Project model for the CapCut-style editor. Pure data + pure functions (unit-tested); all times are integer
// microseconds on the timeline. Frame rates are rational. Positions are fractions of the canvas so a project
// can change aspect ratio or export size without moving things.

export type US = number;
export const SEC = 1_000_000;

export type Ease = "linear" | "in" | "out" | "inOut" | "hold";
export interface Key { t: US; v: number; e?: Ease }
export const KEY_PROPS = ["x", "y", "scale", "rotation", "opacity", "volume", "brightness", "contrast", "saturation", "exposure", "temperature", "blur"] as const;
export type KeyProp = (typeof KEY_PROPS)[number];

export interface MediaRef {
  id: string; path: string; name: string; kind: "video" | "image" | "audio";
  duration: US; width: number; height: number; fps_num: number; fps_den: number;
  has_audio: boolean; has_video: boolean; playable: boolean; optimized?: string | null; reason?: string | null;
  size: number; mtime: number;
  /** Derived files made by background jobs (all in the cache). */
  reversed?: string | null; stabilized?: Record<string, string>; audiofx?: Record<string, string>; matte?: string | null;
  missing?: boolean;
}

export interface Transform { x: number; y: number; scale: number; scaleX: number; scaleY: number; rotation: number; flipH: boolean; flipV: boolean }
export interface Adjust {
  exposure: number; brightness: number; contrast: number; saturation: number; vibrance: number; temperature: number; tint: number;
  highlights: number; shadows: number; hue: number; sharpen: number; vignette: number; grain: number; fade: number;
}
export const ADJUST_KEYS: (keyof Adjust)[] = ["exposure", "brightness", "contrast", "saturation", "vibrance", "temperature", "tint", "highlights", "shadows", "hue", "sharpen", "vignette", "grain", "fade"];
export interface Crop { l: number; t: number; r: number; b: number }
export type MaskShape = "none" | "linear" | "mirror" | "circle" | "rect" | "heart" | "star";
export interface Mask { shape: MaskShape; x: number; y: number; w: number; h: number; rotation: number; feather: number; invert: boolean; round: number }
export interface Chroma { on: boolean; color: string; strength: number; shadow: number }
export interface Anim { id: string; dur: US }
export interface AudioFx { voice: string; denoise: boolean; normalize: boolean; enhance: boolean }
export interface TextStyle {
  text: string; font: string; size: number; color: string; bold: boolean; italic: boolean; underline: boolean;
  align: "left" | "center" | "right"; lineHeight: number; letterSpacing: number; maxWidth: number; caseMode: "none" | "upper" | "lower";
  stroke: { on: boolean; color: string; width: number };
  shadow: { on: boolean; color: string; blur: number; x: number; y: number; opacity: number };
  background: { on: boolean; color: string; opacity: number; radius: number; padding: number };
  gradient: { on: boolean; from: string; to: string; angle: number };
  /** Caption word highlight (karaoke) colour. */
  highlight: string; highlightMode: "none" | "color" | "box" | "scale" | "reveal";
}
export interface Word { t0: US; t1: US; text: string }

export type ClipType = "video" | "image" | "color" | "text" | "caption" | "sticker" | "audio" | "effect" | "filter" | "adjust";
export interface Clip {
  id: string; type: ClipType; start: US; dur: US; name?: string;
  media?: string; in?: US; speed?: number; curve?: { id: string; pts: [number, number][] } | null; reverse?: boolean; keepPitch?: boolean;
  transform?: Transform; opacity?: number; blend?: string; crop?: Crop | null; mask?: Mask | null; chroma?: Chroma | null;
  adjust?: Partial<Adjust>; filter?: { id: string; amount: number } | null; effects?: { id: string; params?: Record<string, number> }[];
  animIn?: Anim | null; animOut?: Anim | null; animLoop?: Anim | null;
  transition?: { id: string; dur: US } | null;
  keys?: Partial<Record<KeyProp, Key[]>>;
  volume?: number; fadeIn?: US; fadeOut?: US; mute?: boolean; fx?: AudioFx | null;
  cutout?: boolean; stabilize?: number;
  text?: TextStyle; words?: Word[];
  sticker?: { emoji?: string; shape?: string; color?: string; media?: string };
  color?: string;
  effect?: { id: string; params?: Record<string, number> };
  linkGroup?: string;
}
export type TrackKind = "video" | "audio" | "text" | "effect" | "filter" | "adjust";
export interface Track { id: string; kind: TrackKind; main?: boolean; name?: string; mute?: boolean; hide?: boolean; lock?: boolean; clips: Clip[] }
export interface Marker { id: string; t: US; color: string; label: string }
export interface Background { type: "color" | "blur" | "image"; color: string; blur: number; image?: string | null }
export interface Project {
  format: "media-studio-project"; version: 2; id: string; name: string;
  width: number; height: number; fps_num: number; fps_den: number; ratio: string;
  background: Background; media: Record<string, MediaRef>; tracks: Track[]; markers: Marker[];
  magnet: boolean; snap: boolean; captionStyle?: Partial<TextStyle>; created?: number; modified?: number;
}

// ------------------------------------------------------------------ ids & defaults

let seq = 0;
export const uid = (p = "c") => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export const RATIOS: Record<string, [number, number] | null> = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:3": [1440, 1080], "3:4": [1080, 1440], "4:5": [1080, 1350], "21:9": [2560, 1080], "2:1": [2160, 1080], "2.35:1": [2538, 1080], original: null };

export const defTransform = (): Transform => ({ x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false });
export const defTextStyle = (over: Partial<TextStyle> = {}): TextStyle => ({
  text: "Text", font: "Montserrat", size: 72, color: "#ffffff", bold: true, italic: false, underline: false, align: "center", lineHeight: 1.15, letterSpacing: 0, maxWidth: 0.86, caseMode: "none",
  stroke: { on: false, color: "#000000", width: 6 }, shadow: { on: true, color: "#000000", blur: 12, x: 0, y: 3, opacity: 0.55 },
  background: { on: false, color: "#000000", opacity: 0.6, radius: 12, padding: 18 }, gradient: { on: false, from: "#ffd54a", to: "#ff5a8c", angle: 90 },
  highlight: "#ffe14d", highlightMode: "none", ...over,
});

export function newProject(name = "Untitled", ratio = "16:9", fps = 30): Project {
  const r = RATIOS[ratio] ?? [1920, 1080];
  return {
    format: "media-studio-project", version: 2, id: "", name, width: r[0], height: r[1], fps_num: fps, fps_den: 1, ratio,
    background: { type: "blur", color: "#000000", blur: 40 }, media: {},
    tracks: [{ id: uid("t"), kind: "video", main: true, name: "Main", clips: [] }], markers: [], magnet: true, snap: true,
  };
}

// ------------------------------------------------------------------ time helpers

export const fps = (p: Pick<Project, "fps_num" | "fps_den">) => p.fps_num / p.fps_den;
/** Nearest frame boundary — exact rational arithmetic, no accumulated float drift. */
export function toFrame(us: US, p: Pick<Project, "fps_num" | "fps_den">): US {
  const f = Math.round((us * p.fps_num) / (SEC * p.fps_den));
  return Math.round((f * SEC * p.fps_den) / p.fps_num);
}
export const frameUs = (p: Pick<Project, "fps_num" | "fps_den">) => (SEC * p.fps_den) / p.fps_num;
export const frameCount = (p: Project) => Math.max(0, Math.round((duration(p) * p.fps_num) / (SEC * p.fps_den)));
export const frameTime = (p: Pick<Project, "fps_num" | "fps_den">, f: number): US => Math.round((f * SEC * p.fps_den) / p.fps_num);

export const end = (c: Clip) => c.start + c.dur;
export function duration(p: Project): US { let d = 0; for (const t of p.tracks) for (const c of t.clips) d = Math.max(d, end(c)); return d; }

export const isVisual = (c: Clip) => ["video", "image", "color", "text", "caption", "sticker"].includes(c.type);
export const hasSource = (c: Clip) => c.type === "video" || c.type === "image" || c.type === "audio";
export const hasAudio = (p: Project, c: Clip) => (c.type === "video" || c.type === "audio") && !!c.media && !!p.media[c.media]?.has_audio;
export const trackFor = (t: ClipType): TrackKind => (t === "video" || t === "image" || t === "color" ? "video" : t === "audio" ? "audio" : t === "effect" ? "effect" : t === "filter" ? "filter" : t === "adjust" ? "adjust" : "text");

// ------------------------------------------------------------------ speed (constant or curve)

/** Source microseconds consumed by the first `local` µs of the clip. */
export function srcOffset(c: Clip, local: US): US {
  const s = c.speed ?? 1;
  if (!c.curve || c.curve.pts.length < 2) return local * s;
  // integrate the curve (x: 0..1 of clip, y: speed multiplier), normalised so the total equals dur*speed
  const n = 64, pts = c.curve.pts;
  const at = (x: number) => { for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-9, x1 - x0); } return pts[pts.length - 1][1]; };
  let total = 0; const acc: number[] = [0];
  for (let i = 0; i < n; i++) { total += (at(i / n) + at((i + 1) / n)) / 2 / n; acc.push(total); }
  const x = Math.max(0, Math.min(1, local / Math.max(1, c.dur)));
  const i = Math.min(n - 1, Math.floor(x * n)), frac = x * n - i;
  const part = acc[i] + (acc[i + 1] - acc[i]) * frac;
  return (part / Math.max(1e-9, total)) * c.dur * s;
}
/** Total source span a clip uses. */
export const srcSpan = (c: Clip): US => (c.type === "video" || c.type === "audio" ? Math.round(c.dur * (c.speed ?? 1)) : c.dur);
/** Source time (µs) for a timeline time; handles reverse (source read backwards from the clip's out point). */
export function sourceTime(c: Clip, t: US): US {
  const local = t - c.start;
  const off = srcOffset(c, local);
  const inn = c.in ?? 0;
  return c.reverse ? inn + srcSpan(c) - off : inn + off;
}

export const CURVES: Record<string, { label: string; pts: [number, number][] }> = {
  montage: { label: "Montage", pts: [[0, 1], [0.3, 1.6], [0.5, 0.4], [0.7, 1.6], [1, 1]] },
  hero: { label: "Hero", pts: [[0, 1.6], [0.35, 1.6], [0.5, 0.25], [0.65, 1.6], [1, 1.6]] },
  bullet: { label: "Bullet", pts: [[0, 1.4], [0.4, 1.4], [0.5, 0.15], [0.6, 1.4], [1, 1.4]] },
  jump: { label: "Jump cut", pts: [[0, 1], [0.45, 1], [0.5, 3], [0.55, 1], [1, 1]] },
  flashIn: { label: "Flash in", pts: [[0, 3], [0.3, 1], [1, 1]] },
  flashOut: { label: "Flash out", pts: [[0, 1], [0.7, 1], [1, 3]] },
  rampUp: { label: "Ramp up", pts: [[0, 0.5], [1, 2.5]] },
  rampDown: { label: "Ramp down", pts: [[0, 2.5], [1, 0.5]] },
};

// ------------------------------------------------------------------ keyframes

const easeFn = (e: Ease | undefined, x: number) => e === "in" ? x * x * x : e === "out" ? 1 - Math.pow(1 - x, 3) : e === "inOut" ? (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2) : x;
/** Value of a keyframed property at local time `local`, or `base` when the property has no keys. */
export function keyValue(keys: Key[] | undefined, local: US, base: number): number {
  if (!keys || !keys.length) return base;
  if (local <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1]; if (local >= last.t) return last.v;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (local <= b.t) { if (a.e === "hold") return a.v; const x = (local - a.t) / Math.max(1, b.t - a.t); return a.v + (b.v - a.v) * easeFn(a.e, x); }
  }
  return last.v;
}
export function setKey(keys: Key[] | undefined, t: US, v: number, e: Ease = "inOut"): Key[] {
  const k = (keys ?? []).filter(x => Math.abs(x.t - t) > 1000);
  k.push({ t, v, e }); k.sort((a, b) => a.t - b.t); return k;
}
export const removeKey = (keys: Key[] | undefined, t: US): Key[] => (keys ?? []).filter(x => Math.abs(x.t - t) > 1000);
export const keyAt = (keys: Key[] | undefined, t: US) => (keys ?? []).find(x => Math.abs(x.t - t) <= 1000);

// ------------------------------------------------------------------ queries

export function findClip(p: Project, id: string): { track: Track; clip: Clip; ti: number; ci: number } | null {
  for (let ti = 0; ti < p.tracks.length; ti++) { const ci = p.tracks[ti].clips.findIndex(c => c.id === id); if (ci >= 0) return { track: p.tracks[ti], clip: p.tracks[ti].clips[ci], ti, ci }; }
  return null;
}
export const mainTrack = (p: Project) => p.tracks.find(t => t.main) ?? p.tracks.find(t => t.kind === "video")!;
export const sortClips = (t: Track) => t.clips.sort((a, b) => a.start - b.start);
export const fits = (t: Track, start: US, dur: US, ignore?: string) => t.clips.every(c => c.id === ignore || end(c) <= start || c.start >= start + dur);
/** Clip on track `t` immediately after `c` (touching), for transitions. */
export const nextAdjacent = (t: Track, c: Clip) => t.clips.find(x => x.id !== c.id && Math.abs(x.start - end(c)) <= 1000);
export const activeAt = (p: Project, t: US) => p.tracks.flatMap(tr => tr.clips.filter(c => c.start <= t && t < end(c)).map(c => ({ track: tr, clip: c })));

// ------------------------------------------------------------------ edits (immutable: every function returns a new project)

const clone = <T,>(x: T): T => structuredClone(x);
function mut(p: Project, f: (q: Project) => void): Project { const q = clone(p); f(q); return q; }

/** Close gaps on the magnetic main track (CapCut behaviour). */
export function compactMain(q: Project) {
  if (!q.magnet) return;
  const m = mainTrack(q); // array order is the authority on the main track
  let t = 0;
  for (const c of m.clips) { c.start = t; t = end(c); }
}

function placeTrack(q: Project, kind: TrackKind, start: US, dur: US, prefer?: string): Track {
  if (prefer) { const t = q.tracks.find(x => x.id === prefer && x.kind === kind && !x.lock); if (t && fits(t, start, dur)) return t; }
  // overlays go above the main track; text/effects at the top; audio at the bottom (CapCut layout)
  const cands = q.tracks.filter(t => t.kind === kind && !t.main && !t.lock);
  for (const t of kind === "audio" ? cands : [...cands].reverse()) if (fits(t, start, dur)) return t;
  const t: Track = { id: uid("t"), kind, clips: [] };
  const mi = q.tracks.findIndex(x => x.main);
  if (kind === "audio") q.tracks.push(t);
  else if (kind === "video") q.tracks.splice(Math.max(0, mi), 0, t);
  else q.tracks.unshift(t);
  return t;
}

export interface AddOpts { at?: US; trackId?: string; toMain?: boolean }
/** Add clips. Main-track inserts happen at the playhead boundary (splitting nothing, pushing later clips right). */
export function addClips(p: Project, clips: Clip[], o: AddOpts = {}): Project {
  return mut(p, q => {
    let at = o.at ?? 0;
    for (const c0 of clips) {
      const c = { ...c0, id: c0.id || uid() };
      const kind = trackFor(c.type);
      if (kind === "video" && o.toMain !== false && (o.toMain || !o.trackId) && q.magnet) {
        const m = mainTrack(q); sortClips(m);
        // insert at the nearest clip boundary at or after `at`
        let idx = m.clips.findIndex(x => x.start + x.dur / 2 > at);
        if (idx < 0) idx = m.clips.length;
        c.start = idx < m.clips.length ? m.clips[idx].start : (m.clips.length ? end(m.clips[m.clips.length - 1]) : 0);
        m.clips.splice(idx, 0, c);
        compactMain(q);
        at = end(c);
      } else {
        c.start = Math.max(0, toFrame(at, q));
        const t = placeTrack(q, kind, c.start, c.dur, o.trackId);
        t.clips.push(c); sortClips(t);
        at = end(c);
      }
    }
  });
}

export function updateClip(p: Project, id: string, patch: Partial<Clip> | ((c: Clip) => Partial<Clip>)): Project {
  return mut(p, q => {
    const f = findClip(q, id); if (!f) return;
    const ptc = typeof patch === "function" ? patch(f.clip) : patch;
    Object.assign(f.clip, ptc);
    if ("dur" in ptc || "speed" in ptc) { clampTransition(f.track); if (f.track.main) compactMain(q); }
  });
}
export const updateClips = (p: Project, ids: string[], patch: Partial<Clip>) => ids.reduce((acc, id) => updateClip(acc, id, patch), p);

function clampTransition(t: Track) {
  for (const c of t.clips) if (c.transition) {
    const n = nextAdjacent(t, c);
    if (!n) c.transition = null; else c.transition.dur = Math.min(c.transition.dur, c.dur, n.dur);
  }
}

/** Change constant speed keeping the source span (duration changes, like CapCut). */
export function setSpeed(p: Project, id: string, speed: number): Project {
  return mut(p, q => {
    const f = findClip(q, id); if (!f) return;
    const s = Math.max(0.1, Math.min(100, speed));
    const span = srcSpan(f.clip);
    f.clip.speed = s; f.clip.dur = Math.max(frameUs(q), Math.round(span / s));
    if (!f.track.main) { const n = f.track.clips.find(x => x.start > f.clip.start && x.start < end(f.clip) && x.id !== id); if (n) f.clip.dur = n.start - f.clip.start; }
    clampTransition(f.track); if (f.track.main) compactMain(q);
  });
}

export function splitAt(p: Project, t: US, ids?: string[]): Project {
  return mut(p, q => {
    const tt = toFrame(t, q);
    for (const tr of q.tracks) {
      if (tr.lock) continue;
      const out: Clip[] = [];
      for (const c of tr.clips) {
        if ((ids && !ids.includes(c.id)) || tt <= c.start + 1000 || tt >= end(c) - 1000) { out.push(c); continue; }
        const local = tt - c.start;
        const a: Clip = { ...clone(c), dur: local, transition: null };
        const b: Clip = { ...clone(c), id: uid(), start: tt, dur: c.dur - local, animIn: null };
        a.animOut = null;
        if (hasSource(c)) {
          if (c.reverse) { b.in = c.in; a.in = (c.in ?? 0) + Math.round(srcSpan(c) - srcOffset(c, local)); }
          else b.in = (c.in ?? 0) + Math.round(srcOffset(c, local));
          if (c.curve) { a.curve = null; b.curve = null; a.speed = (srcOffset(c, local)) / Math.max(1, local); b.speed = (srcSpan(c) - srcOffset(c, local)) / Math.max(1, c.dur - local); }
        }
        if (c.words) { a.words = c.words.filter(w => w.t0 < local); b.words = c.words.filter(w => w.t1 > local).map(w => ({ ...w, t0: Math.max(0, w.t0 - local), t1: w.t1 - local })); }
        if (c.keys) { a.keys = {}; b.keys = {};
          for (const [k, ks] of Object.entries(c.keys) as [KeyProp, Key[]][]) { const mid = keyValue(ks, local, 0); a.keys[k] = [...ks.filter(x => x.t < local), { t: local, v: mid, e: "linear" }]; b.keys[k] = [{ t: 0, v: mid, e: ks.find(x => x.t > local)?.e ?? "linear" }, ...ks.filter(x => x.t > local).map(x => ({ ...x, t: x.t - local }))]; } }
        b.transition = c.transition ?? null;
        out.push(a, b);
      }
      tr.clips = out;
    }
  });
}

/** Delete clips; on the magnetic main track the gap closes (ripple). `ripple` forces ripple on any track. */
export function deleteClips(p: Project, ids: string[], ripple = false): Project {
  return mut(p, q => {
    for (const t of q.tracks) {
      if (t.lock) continue;
      const removed = t.clips.filter(c => ids.includes(c.id));
      if (!removed.length) continue;
      t.clips = t.clips.filter(c => !ids.includes(c.id));
      if (ripple && !t.main) { for (const r of removed.sort((a, b) => b.start - a.start)) for (const c of t.clips) if (c.start >= end(r)) c.start -= r.dur; }
      for (const c of t.clips) if (c.transition && !nextAdjacent(t, c)) c.transition = null;
    }
    compactMain(q);
    q.tracks = q.tracks.filter(t => t.main || t.clips.length > 0);
  });
}

/** Delete everything left/right of the playhead within the selected clips (CapCut Q / W). */
export function trimToPlayhead(p: Project, ids: string[], t: US, side: "left" | "right"): Project {
  let q = p;
  for (const id of ids) {
    const f = findClip(q, id);
    if (!f || t <= f.clip.start + 1000 || t >= end(f.clip) - 1000) continue;
    q = trimClip(q, id, side === "left" ? "start" : "end", t);
  }
  return q;
}

/** Trim an edge. Returns the project unchanged if the edit is impossible (source bounds, neighbours). */
export function trimClip(p: Project, id: string, edge: "start" | "end", newT: US): Project {
  return mut(p, q => {
    const f = findClip(q, id); if (!f || f.track.lock) return;
    const c = f.clip, fu = frameUs(q), t = toFrame(newT, q);
    const media = c.media ? q.media[c.media] : undefined;
    const sp = c.speed ?? 1;
    const others = f.track.clips.filter(x => x.id !== id);
    if (edge === "start") {
      let ns = Math.min(t, end(c) - fu);
      const magnetic = f.track.main && q.magnet;
      if (!f.track.main) { const prev = others.filter(x => end(x) <= c.start + 1000).reduce((m, x) => Math.max(m, end(x)), 0); ns = Math.max(ns, prev); }
      // on the magnetic main track the left edge may be dragged "before" its slot: the clip grows and is re-packed
      if (!magnetic) ns = Math.max(0, ns);
      if (hasSource(c) && c.type !== "image" && !c.reverse) { const minStart = c.start - (c.in ?? 0) / sp; ns = Math.max(ns, Math.ceil(minStart)); c.in = Math.max(0, (c.in ?? 0) + Math.round((ns - c.start) * sp)); }
      if (hasSource(c) && c.type !== "image" && c.reverse && media) { const minStart = c.start - (media.duration - (c.in ?? 0) - srcSpan(c)) / sp; ns = Math.max(ns, Math.ceil(minStart)); }
      if (c.words) { const d = ns - c.start; c.words = c.words.map(w => ({ ...w, t0: w.t0 - d, t1: w.t1 - d })).filter(w => w.t1 > 0); }
      shiftKeys(c, c.start - ns);
      const e0 = end(c); c.start = ns; c.dur = e0 - ns;
    } else {
      let ne = Math.max(t, c.start + fu);
      if (!f.track.main) { const next = others.filter(x => x.start >= end(c) - 1000).reduce((m, x) => Math.min(m, x.start), Infinity); ne = Math.min(ne, next); }
      if (media && c.type !== "image" && hasSource(c)) {
        // reversed clips extend into earlier source; normal clips into later source
        const maxEnd = c.reverse ? end(c) + (c.in ?? 0) / sp : c.start + (media.duration - (c.in ?? 0)) / sp;
        ne = Math.min(ne, Math.floor(maxEnd));
      }
      const nd = Math.max(fu, ne - c.start);
      if (c.reverse && hasSource(c)) c.in = Math.max(0, (c.in ?? 0) - Math.round((nd - c.dur) * sp));
      c.dur = nd;
    }
    clampTransition(f.track);
    compactMain(q);
  });
}
function shiftKeys(c: Clip, d: US) { if (!c.keys) return; for (const k of Object.keys(c.keys) as KeyProp[]) c.keys[k] = c.keys[k]!.map(x => ({ ...x, t: x.t + d })).filter(x => x.t >= 0); }

/** Move a clip to a new start (and optionally another track). On the main track this reorders (insert). */
export function moveClip(p: Project, id: string, start: US, trackId?: string): Project {
  return mut(p, q => {
    const f = findClip(q, id); if (!f || f.track.lock) return;
    const c = f.clip;
    const target = trackId ? q.tracks.find(t => t.id === trackId) : f.track;
    if (!target || target.lock || target.kind !== f.track.kind && !(target.kind === "video" && f.track.kind === "video")) return;
    if (target.kind !== trackFor(c.type)) return;
    const s = Math.max(0, toFrame(start, q));
    if (target.main && q.magnet) {
      f.track.clips.splice(f.ci, 1);
      sortClips(target);
      let idx = target.clips.findIndex(x => x.start + x.dur / 2 > s); if (idx < 0) idx = target.clips.length;
      target.clips.splice(idx, 0, c);
      c.transition = null;
      compactMain(q);
    } else {
      if (!fits(target, s, c.dur, c.id)) return;
      f.track.clips.splice(f.ci, 1);
      c.start = s; target.clips.push(c); sortClips(target);
      if (f.track.main) compactMain(q);
    }
    for (const t of q.tracks) clampTransition(t);
    q.tracks = q.tracks.filter(t => t.main || t.clips.length > 0 || t.id === target.id);
  });
}

export function duplicateClip(p: Project, id: string): Project {
  const f = findClip(p, id); if (!f) return p;
  const c = { ...structuredClone(f.clip), id: uid(), transition: null };
  if (f.track.main) return addClips(p, [c], { at: end(f.clip) + 1 });
  return addClips(p, [c], { at: end(f.clip), toMain: false });
}

export function addTrack(p: Project, kind: TrackKind): Project { return mut(p, q => { placeTrack(q, kind, 0, Number.MAX_SAFE_INTEGER / 4); }); }
export function updateTrack(p: Project, id: string, patch: Partial<Track>): Project { return mut(p, q => { const t = q.tracks.find(x => x.id === id); if (t) Object.assign(t, patch); }); }

/** Snap `t` to clip edges, markers and the playhead within `tol` µs. */
export function snap(p: Project, t: US, tol: US, ignore: string[] = [], extra: US[] = []): US {
  if (!p.snap) return t;
  let best = t, bd = tol;
  const consider = (x: US) => { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } };
  consider(0); extra.forEach(consider); p.markers.forEach(m => consider(m.t));
  for (const tr of p.tracks) for (const c of tr.clips) if (!ignore.includes(c.id)) { consider(c.start); consider(end(c)); }
  return best;
}

/** Frame-exact media-time grid for a clip that may not start on a frame boundary. */
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ history

export class History<T> {
  private past: T[] = []; private future: T[] = [];
  constructor(private limit = 200) {}
  push(prev: T) { this.past.push(prev); if (this.past.length > this.limit) this.past.shift(); this.future = []; }
  undo(cur: T): T | null { const p = this.past.pop(); if (p === undefined) return null; this.future.push(cur); return p; }
  redo(cur: T): T | null { const n = this.future.pop(); if (n === undefined) return null; this.past.push(cur); return n; }
  get canUndo() { return this.past.length > 0; } get canRedo() { return this.future.length > 0; }
  clear() { this.past = []; this.future = []; }
}

// ------------------------------------------------------------------ validation (loading project files)

export function validate(raw: any): Project {
  if (!raw || raw.format !== "media-studio-project") throw new Error("Not a Media Studio project");
  if (raw.version !== 2) throw new Error(`Unsupported project version ${raw.version}`);
  const p = raw as Project;
  if (!(p.width >= 16 && p.height >= 16 && p.width <= 8192 && p.height <= 8192)) throw new Error("Invalid project size");
  if (!(p.fps_num > 0 && p.fps_den > 0)) throw new Error("Invalid frame rate");
  if (!Array.isArray(p.tracks)) throw new Error("Project has no tracks");
  p.media ??= {}; p.markers ??= []; p.background ??= { type: "blur", color: "#000000", blur: 40 };
  p.magnet ??= true; p.snap ??= true;
  if (!p.tracks.some(t => t.main)) { const v = p.tracks.find(t => t.kind === "video"); if (v) v.main = true; else p.tracks.push({ id: uid("t"), kind: "video", main: true, clips: [] }); }
  for (const t of p.tracks) { t.clips = (t.clips ?? []).filter(c => Number.isFinite(c.start) && Number.isFinite(c.dur) && c.dur > 0); sortClips(t); }
  return p;
}
