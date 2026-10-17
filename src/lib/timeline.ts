// Timeline domain model. All times are integer microseconds; frame rate is rational (num/den).
// Pure functions: every edit returns a new Project so undo/redo is just snapshot history.

export type ClipKind = "video" | "image" | "audio" | "text" | "color";
export interface Transform { x: number; y: number; scale: number; opacity: number; rotation: number }
export interface TextSpec { content: string; size: number; color: string; x: number; y: number; box_color?: string | null; bold?: boolean }
export interface Adjust { brightness: number; contrast: number; saturation: number; temperature: number }
export interface Clip {
  id: string; kind: ClipKind; asset_id?: number | null; path?: string | null; name?: string;
  start_us: number; in_us: number; out_us: number; source_us?: number | null; // source_us = full source length (bounds trims)
  speed: number; volume: number; fade_in_us: number; fade_out_us: number; transition: "none" | "dissolve" | "fade"; transition_us: number;
  fit: "contain" | "cover" | "fill"; transform: Transform; adjust: Adjust; text?: TextSpec | null; color?: string | null;
}
export interface Track { id: string; kind: "video" | "audio"; name: string; muted: boolean; hidden: boolean; locked: boolean; volume: number; clips: Clip[] }
export interface Project { version: 1; name: string; width: number; height: number; fps_num: number; fps_den: number; background: string; tracks: Track[] }

let seq = 0;
export const uid = (p = "c") => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const defaultTransform = (): Transform => ({ x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 });
export const defaultAdjust = (): Adjust => ({ brightness: 0, contrast: 1, saturation: 1, temperature: 6500 });

export function newProject(over: Partial<Project> = {}): Project {
  return {
    version: 1, name: "Untitled project", width: 1920, height: 1080, fps_num: 30, fps_den: 1, background: "#000000",
    tracks: [
      { id: uid("t"), kind: "video", name: "V2", muted: false, hidden: false, locked: false, volume: 1, clips: [] },
      { id: uid("t"), kind: "video", name: "V1", muted: false, hidden: false, locked: false, volume: 1, clips: [] },
      { id: uid("t"), kind: "audio", name: "A1", muted: false, hidden: false, locked: false, volume: 1, clips: [] },
    ],
    ...over,
  };
}
// Tracks are stored top→bottom for display; rendering composites bottom→top.
export const renderOrder = (p: Project): Project => ({ ...p, tracks: [...p.tracks.filter(t => t.kind === "video")].reverse().concat(p.tracks.filter(t => t.kind === "audio")) });

export const clipLen = (c: Clip) => Math.round((c.out_us - c.in_us) / (c.speed > 0 ? c.speed : 1));
export const clipEnd = (c: Clip) => c.start_us + clipLen(c);
export const duration = (p: Project) => Math.max(0, ...p.tracks.flatMap(t => t.clips.map(clipEnd)));
export const frameUs = (p: Pick<Project, "fps_num" | "fps_den">) => (1e6 * p.fps_den) / p.fps_num;
/** Snap to the nearest frame boundary (exact rational math, result is an integer µs). */
export const toFrame = (us: number, p: Pick<Project, "fps_num" | "fps_den">) => Math.round(Math.round((us * p.fps_num) / (1e6 * p.fps_den)) * (1e6 * p.fps_den) / p.fps_num);

export function findClip(p: Project, id: string): { track: Track; clip: Clip; ti: number; ci: number } | null {
  for (let ti = 0; ti < p.tracks.length; ti++) { const ci = p.tracks[ti].clips.findIndex(c => c.id === id); if (ci >= 0) return { track: p.tracks[ti], clip: p.tracks[ti].clips[ci], ti, ci }; }
  return null;
}
const mapClip = (p: Project, id: string, f: (c: Clip, t: Track) => Clip): Project =>
  ({ ...p, tracks: p.tracks.map(t => ({ ...t, clips: t.clips.map(c => (c.id === id ? f(c, t) : c)) })) });
const sortClips = (cs: Clip[]) => [...cs].sort((a, b) => a.start_us - b.start_us);

export function overlaps(t: Track, start: number, end: number, ignore?: string) {
  return t.clips.some(c => c.id !== ignore && start < clipEnd(c) && end > c.start_us);
}
/** First free position ≥ `at` on a track where a clip of `len` fits. */
export function freeSlot(t: Track, at: number, len: number, ignore?: string) {
  let s = Math.max(0, at);
  for (const c of sortClips(t.clips)) { if (c.id === ignore) continue; if (s < clipEnd(c) && s + len > c.start_us) s = clipEnd(c); }
  return s;
}

export function makeClip(kind: ClipKind, over: Partial<Clip> = {}): Clip {
  const base: Clip = { id: uid(), kind, start_us: 0, in_us: 0, out_us: 5_000_000, speed: 1, volume: 1, fade_in_us: 0, fade_out_us: 0, transition: "none", transition_us: 500_000,
    fit: "contain", transform: defaultTransform(), adjust: defaultAdjust(), text: null, color: null, source_us: null };
  return { ...base, ...over };
}

export function addClip(p: Project, trackId: string, clip: Clip, at?: number): Project {
  const t = p.tracks.find(t => t.id === trackId); if (!t || t.locked) return p;
  const len = clipLen(clip);
  // appending butts exactly against the previous clip (no frame-rounding gap); explicit positions snap to frames
  const start = freeSlot(t, at === undefined ? Math.max(0, ...t.clips.map(clipEnd)) : toFrame(at, p), len);
  return { ...p, tracks: p.tracks.map(x => (x.id === trackId ? { ...x, clips: sortClips([...x.clips, { ...clip, start_us: start }]) } : x)) };
}

/** Move a clip (optionally to another compatible track). Refuses overlaps — returns the project unchanged. */
export function moveClip(p: Project, id: string, start: number, toTrackId?: string): Project {
  const f = findClip(p, id); if (!f || f.track.locked) return p;
  const dest = p.tracks.find(t => t.id === (toTrackId ?? f.track.id)); if (!dest || dest.locked) return p;
  const audioClip = f.clip.kind === "audio";
  if ((dest.kind === "audio") !== audioClip) return p;
  const s = Math.max(0, toFrame(start, p));
  if (overlaps(dest, s, s + clipLen(f.clip), id)) return p;
  const moved = { ...f.clip, start_us: s };
  return { ...p, tracks: p.tracks.map(t => {
    let clips = t.clips.filter(c => c.id !== id);
    if (t.id === dest.id) clips = sortClips([...clips, moved]);
    return { ...t, clips };
  }) };
}

/** Trim an edge to timeline position `at`, respecting source bounds and neighbours. */
export function trimClip(p: Project, id: string, edge: "start" | "end", at: number): Project {
  const f = findClip(p, id); if (!f || f.track.locked) return p;
  const c = f.clip, sp = c.speed > 0 ? c.speed : 1, minLen = frameUs(p);
  const prevEnd = Math.max(0, ...f.track.clips.filter(x => x.id !== id && clipEnd(x) <= c.start_us).map(clipEnd));
  const nextStart = Math.min(Infinity, ...f.track.clips.filter(x => x.id !== id && x.start_us >= clipEnd(c)).map(x => x.start_us));
  const bounded = c.kind === "video" || c.kind === "audio";
  at = toFrame(at, p);
  return mapClip(p, id, c => {
    if (edge === "start") {
      let s = Math.min(Math.max(at, prevEnd), clipEnd(c) - minLen);
      let inUs = c.in_us + Math.round((s - c.start_us) * sp);
      if (bounded && inUs < 0) { s -= Math.round(inUs / sp); inUs = 0; }
      if (!bounded) inUs = Math.max(0, inUs);
      return { ...c, start_us: s, in_us: inUs };
    }
    let e = Math.max(Math.min(at, nextStart), c.start_us + minLen);
    let out = c.in_us + Math.round((e - c.start_us) * sp);
    if (bounded && c.source_us != null && out > c.source_us) out = c.source_us;
    return { ...c, out_us: out };
  });
}

export function splitClip(p: Project, id: string, at: number): Project {
  const f = findClip(p, id); if (!f || f.track.locked) return p;
  const c = f.clip; at = toFrame(at, p);
  if (at <= c.start_us + frameUs(p) / 2 || at >= clipEnd(c) - frameUs(p) / 2) return p;
  const cut = c.in_us + Math.round((at - c.start_us) * (c.speed > 0 ? c.speed : 1));
  const a: Clip = { ...c, out_us: cut, fade_out_us: 0 };
  const b: Clip = { ...c, id: uid(), start_us: at, in_us: cut, fade_in_us: 0, transition: "none" };
  return { ...p, tracks: p.tracks.map(t => (t.id === f.track.id ? { ...t, clips: sortClips(t.clips.flatMap(x => (x.id === id ? [a, b] : [x]))) } : t)) };
}

export function deleteClip(p: Project, id: string, ripple = false): Project {
  const f = findClip(p, id); if (!f || f.track.locked) return p;
  const len = clipLen(f.clip), end = clipEnd(f.clip);
  return { ...p, tracks: p.tracks.map(t => t.id !== f.track.id ? t : { ...t, clips: t.clips.filter(c => c.id !== id).map(c => (ripple && c.start_us >= end ? { ...c, start_us: c.start_us - len } : c)) }) };
}

export function duplicateClip(p: Project, id: string): Project {
  const f = findClip(p, id); if (!f) return p;
  return addClip(p, f.track.id, { ...f.clip, id: uid() }, clipEnd(f.clip));
}

export const updateClip = (p: Project, id: string, patch: Partial<Clip>) => mapClip(p, id, c => ({ ...c, ...patch }));
export const updateTrack = (p: Project, id: string, patch: Partial<Track>) => ({ ...p, tracks: p.tracks.map(t => (t.id === id ? { ...t, ...patch } : t)) });
export function addTrack(p: Project, kind: "video" | "audio"): Project {
  const n = p.tracks.filter(t => t.kind === kind).length + 1;
  const t: Track = { id: uid("t"), kind, name: `${kind === "video" ? "V" : "A"}${n}`, muted: false, hidden: false, locked: false, volume: 1, clips: [] };
  return kind === "video" ? { ...p, tracks: [t, ...p.tracks] } : { ...p, tracks: [...p.tracks, t] };
}
export function moveTrack(p: Project, id: string, dir: -1 | 1): Project {
  const i = p.tracks.findIndex(t => t.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= p.tracks.length || p.tracks[j].kind !== p.tracks[i].kind) return p;
  const tracks = [...p.tracks]; [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  return { ...p, tracks };
}
export function removeTrack(p: Project, id: string): Project {
  const t = p.tracks.find(x => x.id === id);
  if (!t || p.tracks.filter(x => x.kind === t.kind).length <= 1) return p;
  return { ...p, tracks: p.tracks.filter(x => x.id !== id) };
}

/** Snap `us` to the nearest edge/playhead within `threshold`; returns the original value otherwise. */
export function snap(p: Project, us: number, threshold: number, extra: number[] = [], ignore?: string) {
  const pts = [0, ...extra, ...p.tracks.flatMap(t => t.clips.filter(c => c.id !== ignore).flatMap(c => [c.start_us, clipEnd(c)]))];
  let best = us, d = threshold;
  for (const x of pts) { const dd = Math.abs(x - us); if (dd < d) { d = dd; best = x; } }
  return best;
}

/** Clips visible at time t on visible tracks, bottom → top (for the preview compositor). */
export function activeAt(p: Project, t: number) {
  const out: { clip: Clip; track: Track; local_us: number }[] = [];
  for (const tr of [...p.tracks].reverse()) {
    if (tr.kind !== "video" || tr.hidden) continue;
    for (const c of tr.clips) {
      const pre = c.transition === "dissolve" ? c.transition_us : 0;
      if (t >= c.start_us - pre && t < clipEnd(c)) out.push({ clip: c, track: tr, local_us: c.in_us + Math.round((t - c.start_us) * (c.speed > 0 ? c.speed : 1)) });
    }
  }
  return out;
}

// ------------------------------------------------------------ history

export class History<T> {
  past: T[] = []; future: T[] = [];
  constructor(public present: T, private cap = 200) {}
  push(next: T) { if (next === this.present) return; this.past.push(this.present); if (this.past.length > this.cap) this.past.shift(); this.present = next; this.future = []; }
  undo() { const p = this.past.pop(); if (p === undefined) return false; this.future.push(this.present); this.present = p; return true; }
  redo() { const f = this.future.pop(); if (f === undefined) return false; this.past.push(this.present); this.present = f; return true; }
  get canUndo() { return this.past.length > 0; } get canRedo() { return this.future.length > 0; }
}

// ------------------------------------------------------------ project files

export interface ProjectFile { format: "media-studio-project"; version: 1; saved_at: number; project: Project; media: { asset_id: number | null; path: string | null; name: string }[] }

export function serialize(p: Project): string {
  const media = p.tracks.flatMap(t => t.clips).filter(c => c.path).map(c => ({ asset_id: c.asset_id ?? null, path: c.path ?? null, name: c.name ?? "" }));
  const file: ProjectFile = { format: "media-studio-project", version: 1, saved_at: Date.now(), project: p, media };
  return JSON.stringify(file, null, 1);
}

export function parseProject(v: unknown): Project {
  const f = v as ProjectFile;
  if (!f || f.format !== "media-studio-project") throw new Error("Not a Media Studio project file");
  if (f.version !== 1) throw new Error(`Unsupported project version ${f.version}`);
  const p = f.project;
  if (!p || !Array.isArray(p.tracks) || !(p.fps_num > 0) || !(p.fps_den > 0) || !(p.width > 0) || !(p.height > 0)) throw new Error("Project file is damaged");
  for (const t of p.tracks) for (const c of t.clips) {
    if (![c.start_us, c.in_us, c.out_us].every(Number.isFinite) || c.out_us <= c.in_us) throw new Error(`Clip ${c.id} has invalid timing`);
    c.transform = { ...defaultTransform(), ...c.transform }; c.adjust = { ...defaultAdjust(), ...c.adjust };
  }
  return p;
}
