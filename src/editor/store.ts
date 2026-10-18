// Editor state: the open project, playhead, selection, undo history, autosave and background preparation of media.
import { create } from "zustand";
import { ed, MediaInfo } from "./api";
import { addClips, Clip, duration, History, MediaRef, Project, toFrame, uid, US, validate } from "./model";
import { fxKey, hasFx } from "./engine/sources";

export type LeftTab = "media" | "audio" | "text" | "stickers" | "effects" | "transitions" | "captions" | "filters" | "adjust" | "templates" | "ai";

interface ES {
  id: string | null; p: Project | null; t: US; playing: boolean; sel: string[]; zoom: number; scroll: number;
  left: LeftTab; save: "saved" | "saving" | "dirty" | "error"; saveError: string | null; savedAt: number; canUndo: boolean; canRedo: boolean;
  prep: Record<string, { kind: string; job: number; progress: number }>; // media id → running preparation
  open(id: string): Promise<void>;
  close(): Promise<void>;
  commit(f: (p: Project) => Project): void;
  live(f: (p: Project) => Project): void;
  endLive(): void;
  undo(): void; redo(): void;
  seek(t: US): void; setPlaying(b: boolean): void;
  select(ids: string[], mode?: "set" | "toggle" | "add"): void;
  setLeft(t: LeftTab): void;
  setZoom(z: number): void;
}

const history = new History<Project>(300);
let liveBase: Project | null = null;
let saveTimer: number | undefined;
/** Derived media files (optimized/reversed/…) are not part of undo history: re-applied after every change. */
const derived: Record<string, Partial<MediaRef>> = {};
function withDerived(p: Project): Project {
  let changed = false; const media = { ...p.media };
  for (const [id, d] of Object.entries(derived)) if (media[id]) {
    const m = media[id];
    const next = { ...m, ...d, stabilized: { ...m.stabilized, ...d.stabilized }, audiofx: { ...m.audiofx, ...d.audiofx } };
    if (JSON.stringify(next) !== JSON.stringify(m)) { media[id] = next; changed = true; }
  }
  return changed ? { ...p, media } : p;
}

export const useEd = create<ES>((set, get) => ({
  id: null, p: null, t: 0, playing: false, sel: [], zoom: 80, scroll: 0, left: "media",
  save: "saved", saveError: null, savedAt: 0, canUndo: false, canRedo: false, prep: {},

  async open(id) {
    const raw = await ed.load(id);
    let p: Project;
    if (raw?.version === 1 || !raw?.version) p = upgradeV1(raw, id); else p = validate(raw);
    p.id = id;
    history.clear(); for (const k of Object.keys(derived)) delete derived[k];
    set({ id, p, t: 0, playing: false, sel: [], save: "saved", saveError: null, canUndo: false, canRedo: false, prep: {}, scroll: 0 });
    void refreshMedia();
  },
  async close() {
    const { id, p, save } = get();
    if (id && p && save !== "saved") { clearTimeout(saveTimer); await ed.save(id, p).catch(() => {}); }
    set({ id: null, p: null, playing: false, sel: [] });
  },
  commit(f) {
    const p = get().p; if (!p) return;
    const base = liveBase ?? p;
    const n = withDerived(f(p));
    if (n === p) return;
    if (!liveBase) history.push(base);
    liveBase = null;
    set({ p: n, canUndo: history.canUndo, canRedo: history.canRedo });
    scheduleSave();
  },
  live(f) {
    const p = get().p; if (!p) return;
    if (!liveBase) liveBase = p;
    set({ p: withDerived(f(p)) });
  },
  endLive() {
    if (!liveBase) return;
    const p = get().p!;
    if (JSON.stringify(liveBase) !== JSON.stringify(p)) { history.push(liveBase); scheduleSave(); }
    liveBase = null;
    set({ canUndo: history.canUndo, canRedo: history.canRedo });
  },
  undo() { const p = get().p; if (!p) return; const q = history.undo(p); if (q) { set({ p: withDerived(q), canUndo: history.canUndo, canRedo: history.canRedo, sel: get().sel.filter(id => q.tracks.some(t => t.clips.some(c => c.id === id))) }); scheduleSave(); } },
  redo() { const p = get().p; if (!p) return; const q = history.redo(p); if (q) { set({ p: withDerived(q), canUndo: history.canUndo, canRedo: history.canRedo }); scheduleSave(); } },
  seek(t) { const p = get().p; if (!p) return; set({ t: Math.max(0, Math.min(Math.max(duration(p), 0), toFrame(t, p))) }); },
  setPlaying(b) { set({ playing: b }); },
  select(ids, mode = "set") {
    const cur = get().sel;
    if (mode === "toggle") set({ sel: ids.reduce((s, id) => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]), cur) });
    else if (mode === "add") set({ sel: [...new Set([...cur, ...ids])] });
    else set({ sel: ids });
  },
  setLeft(left) { set({ left }); },
  setZoom(z) { set({ zoom: Math.max(4, Math.min(1200, z)) }); },
}));

function scheduleSave() {
  useEd.setState({ save: "dirty" });
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 900);
}
export async function saveNow() {
  const { id, p } = useEd.getState(); if (!id || !p) return;
  clearTimeout(saveTimer);
  useEd.setState({ save: "saving" });
  try { await ed.save(id, { ...p, modified: Date.now() }); useEd.setState({ save: "saved", saveError: null, savedAt: Date.now() }); }
  catch (e) { useEd.setState({ save: "error", saveError: String(e) }); }
}

// ---------------------------------------------------------------- media & jobs

type JobCb = { done: (outputs: string[], notes: string[]) => void; fail?: (err: string) => void; progress?: (p: number) => void };
const jobCbs = new Map<number, JobCb>();
export function watchJob(id: number, cb: JobCb) { jobCbs.set(id, cb); }
/** Called by the app's global job listener. */
export function editorJobEvent(j: { id: number; status: string; progress: number; error: string | null; result: { outputs: string[]; notes: string[] } | null }) {
  const cb = jobCbs.get(j.id); if (!cb) return;
  if (j.status === "running" || j.status === "queued") { cb.progress?.(j.progress); return; }
  jobCbs.delete(j.id);
  if (j.status === "done") cb.done(j.result?.outputs ?? [], j.result?.notes ?? []);
  else cb.fail?.(j.error ?? j.status);
}

export function patchMedia(mid: string, d: Partial<MediaRef>) {
  derived[mid] = { ...derived[mid], ...d, stabilized: { ...derived[mid]?.stabilized, ...d.stabilized }, audiofx: { ...derived[mid]?.audiofx, ...d.audiofx } };
  const p = useEd.getState().p; if (p) useEd.setState({ p: withDerived(p) });
  scheduleSave();
}
function runPrep(mid: string, kind: string, job: Promise<number>, onDone: (out: string) => void, onFail?: (e: string) => void) {
  const key = `${mid}:${kind}`;
  if (useEd.getState().prep[key]) return;
  job.then(id => {
    useEd.setState({ prep: { ...useEd.getState().prep, [key]: { kind, job: id, progress: 0 } } });
    watchJob(id, {
      progress: pr => useEd.setState({ prep: { ...useEd.getState().prep, [key]: { kind, job: id, progress: pr } } }),
      done: out => { const prep = { ...useEd.getState().prep }; delete prep[key]; useEd.setState({ prep }); if (out[0]) onDone(out[0]); },
      fail: e => { const prep = { ...useEd.getState().prep }; delete prep[key]; useEd.setState({ prep }); onFail?.(e); },
    });
  }).catch(e => onFail?.(String(e)));
}

export function ensurePlayable(mid: string) {
  const m = useEd.getState().p?.media[mid]; if (!m || m.playable || m.optimized) return;
  runPrep(mid, "optimize", ed.optimize(m.path), out => patchMedia(mid, { optimized: out }), e => notify(`Couldn't prepare “${m.name}”: ${e}`));
}
export function ensureReversed(mid: string) {
  const m = useEd.getState().p?.media[mid]; if (!m || m.reversed) return;
  runPrep(mid, "reverse", ed.enqueue({ type: "reverse", path: m.path }, `Reverse ${m.name}`), out => patchMedia(mid, { reversed: out }), e => notify(`Reverse failed: ${e}`));
}
export function ensureStabilized(mid: string, level: number) {
  const m = useEd.getState().p?.media[mid]; if (!m || m.stabilized?.[String(level)]) return;
  runPrep(mid, `stab${level}`, ed.enqueue({ type: "stabilize", path: m.path, strength: level }, `Stabilize ${m.name}`), out => patchMedia(mid, { stabilized: { [String(level)]: out } }), e => notify(`Stabilize failed: ${e}`));
}
export function ensureAudioFx(mid: string, fx: Clip["fx"]) {
  const m = useEd.getState().p?.media[mid]; if (!m || !hasFx(fx)) return;
  const k = fxKey(fx); if (m.audiofx?.[k]) return;
  runPrep(mid, `fx${k}`, ed.enqueue({ type: "audio_fx", path: m.path, fx: { voice: fx!.voice || "", denoise: !!fx!.denoise, normalize: !!fx!.normalize, enhance: !!fx!.enhance } }, `Audio effects: ${m.name}`),
    out => patchMedia(mid, { audiofx: { [k]: out } }), e => notify(`Audio processing failed: ${e}`));
}

/** Check derived files still exist and queue anything missing (after opening a project). */
async function refreshMedia() {
  const p = useEd.getState().p; if (!p) return;
  for (const m of Object.values(p.media)) {
    try {
      const i = await ed.info(m.path);
      patchMedia(m.id, { playable: i.playable, optimized: i.optimized, reason: i.reason, missing: false });
      if (!i.playable && !i.optimized) ensurePlayable(m.id);
    } catch { patchMedia(m.id, { missing: true }); }
  }
  for (const tr of p.tracks) for (const c of tr.clips) {
    if (!c.media) continue;
    if (c.reverse) ensureReversed(c.media);
    if (c.stabilize) ensureStabilized(c.media, c.stabilize);
    if (hasFx(c.fx)) ensureAudioFx(c.media, c.fx);
  }
}

export function mediaFromInfo(i: MediaInfo): MediaRef {
  return { id: uid("m"), path: i.path, name: i.name, kind: i.kind, duration: i.kind === "image" ? 5_000_000 : i.duration_us, width: i.width, height: i.height, fps_num: i.fps_num, fps_den: i.fps_den,
    has_audio: i.has_audio, has_video: i.has_video, playable: i.playable, optimized: i.optimized, reason: i.reason, size: i.size, mtime: i.mtime };
}

/** Import files into the project's media bin (and optionally the timeline at the playhead). */
export async function importPaths(paths: string[], toTimeline = false): Promise<string[]> {
  const r = await ed.import(paths);
  const st = useEd.getState(); if (!st.p) return [];
  const existing = new Map(Object.values(st.p.media).map(m => [m.path.toLowerCase(), m.id]));
  const add: MediaRef[] = [];
  const ids: string[] = [];
  for (const i of r.ok) { const ex = existing.get(i.path.toLowerCase()); if (ex) { ids.push(ex); continue; } const m = mediaFromInfo(i); add.push(m); ids.push(m.id); }
  if (r.errors.length) notify(r.errors.slice(0, 3).join("\n"), "error");
  if (add.length || toTimeline) {
    st.commit(p => {
      let q: Project = { ...p, media: { ...p.media, ...Object.fromEntries(add.map(m => [m.id, m])) } };
      if (toTimeline) q = addClips(q, ids.map(id => clipForMedia(q.media[id])), { at: useEd.getState().t });
      return q;
    });
  }
  for (const m of add) ensurePlayable(m.id);
  // first imported video sets the project's frame rate/ratio when the timeline was empty (CapCut does the same)
  return ids;
}

export function clipForMedia(m: MediaRef, over: Partial<Clip> = {}): Clip {
  if (m.kind === "audio") return { id: uid(), type: "audio", start: 0, dur: m.duration, media: m.id, in: 0, speed: 1, volume: 1, name: m.name, ...over };
  if (m.kind === "image") return { id: uid(), type: "image", start: 0, dur: 5_000_000, media: m.id, in: 0, name: m.name, ...over };
  return { id: uid(), type: "video", start: 0, dur: m.duration, media: m.id, in: 0, speed: 1, volume: 1, name: m.name, ...over };
}

// ---------------------------------------------------------------- notifications (bridged to the app toast)

let notifier: (text: string, kind?: "info" | "ok" | "error") => void = t => console.log(t);
export const setNotifier = (f: typeof notifier) => { notifier = f; };
export const notify = (text: string, kind: "info" | "ok" | "error" = "error") => notifier(text, kind);

// ---------------------------------------------------------------- v1 timeline projects (.msproj from the previous version)

function upgradeV1(raw: any, id: string): Project {
  const p: Project = { format: "media-studio-project", version: 2, id, name: raw?.name ?? "Imported project", width: raw?.width ?? 1920, height: raw?.height ?? 1080, fps_num: raw?.fps_num ?? 30, fps_den: raw?.fps_den ?? 1, ratio: "16:9",
    background: { type: "color", color: raw?.background ?? "#000000", blur: 40 }, media: {}, tracks: [], markers: [], magnet: false, snap: true };
  let first = true;
  for (const t of raw?.tracks ?? []) {
    const kind = t.kind === "audio" ? "audio" : "video";
    const clips: Clip[] = [];
    for (const c of t.clips ?? []) {
      let mid: string | undefined;
      if (c.path) { mid = Object.values(p.media).find(m => m.path === c.path)?.id; if (!mid) { mid = uid("m"); p.media[mid] = { id: mid, path: c.path, name: c.path.split(/[\\/]/).pop(), kind: c.kind === "image" ? "image" : c.kind === "audio" ? "audio" : "video", duration: c.src_dur_us ?? c.out_us ?? 0, width: 0, height: 0, fps_num: 30, fps_den: 1, has_audio: true, has_video: c.kind !== "audio", playable: true, size: 0, mtime: 0 }; } }
      const type = c.kind === "title" ? "text" : c.kind === "color" ? "color" : c.kind === "image" ? "image" : kind === "audio" ? "audio" : "video";
      clips.push({ id: uid(), type: type as Clip["type"], start: c.start_us ?? 0, dur: Math.max(1, Math.round(((c.out_us ?? 0) - (c.in_us ?? 0)) / (c.speed || 1))), media: mid, in: c.in_us ?? 0, speed: c.speed || 1, volume: c.volume ?? 1, fadeIn: c.fade_in_us, fadeOut: c.fade_out_us, color: c.color });
    }
    p.tracks.push({ id: uid("t"), kind, main: kind === "video" && first, clips });
    if (kind === "video") first = false;
  }
  if (!p.tracks.some(t => t.main)) p.tracks.unshift({ id: uid("t"), kind: "video", main: true, clips: [] });
  return validate(p);
}
