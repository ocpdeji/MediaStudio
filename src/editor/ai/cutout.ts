// AI background removal and vocal isolation. Inference runs natively (ONNX Runtime + DirectML on the GPU, CPU
// fallback) as background jobs; this module installs the model if needed, queues the job and tracks progress.
import { create } from "zustand";
import { ed } from "../api";
import { addClips, Clip, uid, updateClip } from "../model";
import { importPaths, notify, patchMedia, useEd, watchJob } from "../store";

const useMatte = create<{ m: Record<string, { progress: number; label: string }> }>(() => ({ m: {} }));
const setState = (mid: string, v: { progress: number; label: string } | null) => {
  const m = { ...useMatte.getState().m }; if (v) m[mid] = v; else delete m[mid]; useMatte.setState({ m });
};
export const matteState = (mid: string) => useMatte(s => s.m[mid]);

/** Make sure a model is installed; installs it (as a visible job) if needed. */
async function needModel(id: string, label: string, key: string): Promise<boolean> {
  const st = await ed.models(); const m = st.find(x => x.id === id);
  if (m?.installed) return true;
  setState(key, { progress: 0, label: `Downloading ${label} (${Math.round(m?.mb ?? 0)} MB)…` });
  const job = await ed.installModel(id);
  return new Promise(res => watchJob(job, {
    progress: p => setState(key, { progress: p, label: `Downloading ${label}… ${Math.round(p * 100)}%` }),
    done: () => res(true), fail: e => { setState(key, null); notify(`Model download failed: ${e}`); res(false); },
  }));
}

const running = new Set<string>();
function runJob(key: string, spec: unknown, title: string, label: string): Promise<string[]> {
  return ed.enqueue(spec, title).then(job => new Promise<string[]>((res, rej) => {
    setState(key, { progress: 0, label });
    watchJob(job, { progress: p => setState(key, { progress: p, label: `${label} ${Math.round(p * 100)}%` }), done: o => { setState(key, null); res(o); }, fail: e => { setState(key, null); rej(new Error(e)); } });
  }));
}

/** Remove the background of a media item (video or photo); sets `media.matte` when done. */
export async function ensureMatte(mid: string, force = false) {
  const m = useEd.getState().p?.media[mid];
  if (!m || running.has(mid) || (m.matte && !force)) return;
  running.add(mid);
  try {
    if (!(await needModel(m.kind === "image" ? "isnet" : "rvm", m.kind === "image" ? "image cutout model" : "video matting model", mid))) return;
    const [out] = await runJob(mid, { type: "matte", path: m.path }, `Remove background: ${m.name}`, "Removing background…");
    if (out) { patchMedia(mid, { matte: out }); notify("Background removed", "ok"); }
  } catch (e) { notify(`Background removal failed: ${e instanceof Error ? e.message : e}`); }
  finally { running.delete(mid); }
}

/** Split a clip's audio into vocals / music and put the requested stem on an audio track (the clip is muted). */
export async function isolate(c: Clip, keep: "vocals" | "instrumental") {
  const st = useEd.getState(); const m = c.media ? st.p?.media[c.media] : undefined;
  if (!m || !m.has_audio) return notify("Select a clip with audio", "info");
  const key = `${m.id}:stems`;
  if (running.has(key)) return;
  running.add(key);
  try {
    if (!(await needModel("mdx-vocals", "vocal isolation model", key))) return;
    const outs = await runJob(key, { type: "separate", path: m.path }, `${keep === "vocals" ? "Isolate voice" : "Remove vocals"}: ${m.name}`, keep === "vocals" ? "Isolating voice…" : "Removing vocals…");
    const file = outs.find(o => o.endsWith(keep === "vocals" ? "-vocals.wav" : "-instrumental.wav"));
    if (!file) throw new Error("No output");
    const [sid] = await importPaths([file]);
    const a: Clip = { id: uid(), type: "audio", start: c.start, dur: c.dur, media: sid, in: c.in, speed: c.speed, curve: c.curve, keepPitch: c.keepPitch, volume: c.volume ?? 1, fadeIn: c.fadeIn, fadeOut: c.fadeOut, name: `${keep === "vocals" ? "Voice" : "Music"} – ${m.name}` };
    useEd.getState().commit(pp => addClips(updateClip(pp, c.id, { mute: true }), [a], { at: c.start, toMain: false }));
    notify(keep === "vocals" ? "Voice isolated — added on an audio track (original muted)" : "Vocals removed — instrumental added on an audio track (original muted)", "ok");
  } catch (e) { notify(`Separation failed: ${e instanceof Error ? e.message : e}`); }
  finally { running.delete(key); }
}
export const stemState = (mid: string) => useMatte(s => s.m[`${mid}:stems`]);
