// Auto captions (Whisper on the timeline mix), SRT/VTT import & export, translation with BYOK models,
// and silence removal.
import { invoke } from "@tauri-apps/api/core";
import { ed } from "../api";
import { audioPlan } from "../engine/exporter";
import { Clip, defTextStyle, deleteClips, duration, end, findClip, mainTrack, Project, splitAt, uid, US } from "../model";
import { CaptionStyle, captionClips } from "../presets";
import { notify, useEd, watchJob } from "../store";

export interface Segment { start_us: number; end_us: number; text: string; words: { start_us: number; end_us: number; text: string }[] }

/** Put caption clips on a fresh text track at the top (replacing older auto captions when asked). */
export function placeCaptions(p: Project, clips: Clip[], replace: boolean): Project {
  let q = p;
  if (replace) q = deleteClips(q, q.tracks.flatMap(t => t.clips.filter(c => c.type === "caption").map(c => c.id)));
  q = structuredClone(q);
  q.tracks.unshift({ id: uid("t"), kind: "text", name: "Captions", clips });
  return q;
}

/** Transcribe the timeline's audio mix (so cuts, speed and mutes are respected); times are timeline µs. */
export async function transcribeTimeline(o: { language: string; model: string; translate: boolean; onProgress: (p: number, label: string) => void }): Promise<{ language: string; segments: Segment[] }> {
  const { p } = useEd.getState(); if (!p) throw new Error("No project open");
  const plan = audioPlan(p);
  if (!plan.segs.length) throw new Error("There's no audio on the timeline to transcribe.");
  const env = await ed.env();
  o.onProgress(0.02, "Mixing the timeline audio…");
  const wav = await ed.renderAudio(plan, `${env.cache}\\speech`, `mix-${Date.now()}.wav`);
  const job = await ed.enqueue({ type: "transcribe", spec: { path: wav, in_us: 0, out_us: 0, language: o.language, translate: o.translate, model: o.model, offset_us: 0 } }, "Transcribe");
  return new Promise((resolve, reject) => watchJob(job, {
    progress: pr => o.onProgress(0.05 + pr * 0.9, pr < 0.1 ? "Preparing speech…" : `Transcribing… ${Math.round(pr * 100)}%`),
    fail: e => reject(new Error(e)),
    done: async out => { try { resolve(JSON.parse(new TextDecoder().decode(await ed.readCache(out[0])))); } catch (e) { reject(e); } },
  }));
}

export async function autoCaptions(o: { language: string; model: string; translate: boolean; style: CaptionStyle; replace: boolean; onProgress: (p: number, label: string) => void }): Promise<number> {
  const j = await transcribeTimeline(o);
  const p = useEd.getState().p!;
  const clips = captionClips(j.segments, o.style, p.height > p.width ? 0.18 : 0.32);
  useEd.getState().commit(pp => placeCaptions(pp, clips, o.replace));
  o.onProgress(1, `Added ${clips.length} captions (${j.language})`);
  return clips.length;
}

// ---------------------------------------------------------------- SRT / VTT

const ts = (us: US, sep = ",") => { const ms = Math.max(0, Math.round(us / 1000)); const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`; };
export function captionList(p: Project): Clip[] { return p.tracks.flatMap(t => t.clips.filter(c => c.type === "caption" || (c.type === "text" && t.name === "Captions"))).sort((a, b) => a.start - b.start); }
export function toSrt(p: Project) { return captionList(p).map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(end(c))}\n${c.text?.text ?? ""}\n`).join("\n"); }
export function toVtt(p: Project) { return "WEBVTT\n\n" + captionList(p).map(c => `${ts(c.start, ".")} --> ${ts(end(c), ".")}\n${c.text?.text ?? ""}\n`).join("\n"); }
export function toTxt(p: Project) { return captionList(p).map(c => c.text?.text ?? "").join("\n"); }

export function parseSubs(text: string): Segment[] {
  const out: Segment[] = [];
  const t = (s: string) => { const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})|(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s); if (!m) return NaN; if (m[1]) return ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4].padEnd(3, "0")) * 1000; return ((+m[5] * 60 + +m[6]) * 1000 + +m[7].padEnd(3, "0")) * 1000; };
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean); const i = lines.findIndex(l => l.includes("-->")); if (i < 0) continue;
    const [a, b] = lines[i].split("-->"); const s = t(a), e = t(b); if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const txt = lines.slice(i + 1).join("\n").replace(/<[^>]+>/g, "").trim(); if (!txt) continue;
    out.push({ start_us: s, end_us: Math.max(e, s + 100_000), text: txt, words: [] });
  }
  return out;
}
export function subsToClips(segs: Segment[], st: CaptionStyle, y: number): Clip[] {
  return segs.map(s => ({ id: uid(), type: "caption" as const, start: s.start_us, dur: s.end_us - s.start_us, name: s.text.slice(0, 40), text: defTextStyle({ ...st.style, text: s.text }),
    transform: { x: 0, y, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false } }));
}

// ---------------------------------------------------------------- translation (any BYOK chat provider, incl. local Ollama)

export async function translateCaptions(provider: string, language: string): Promise<number> {
  const p = useEd.getState().p!; const caps = captionList(p); if (!caps.length) throw new Error("There are no captions to translate.");
  const sys = `You translate video subtitles into ${language}. Keep meaning, tone and brevity. Reply ONLY with the same numbered lines in the format "N|translation", one per line, same count and order. Do not add commentary.`;
  const out = new Map<number, string>();
  for (let i = 0; i < caps.length; i += 60) {
    const chunk = caps.slice(i, i + 60);
    const res = await ed.chat(provider, sys, chunk.map((c, k) => `${i + k + 1}|${(c.text?.text ?? "").replace(/\n/g, " ")}`).join("\n"));
    for (const line of res.split(/\r?\n/)) { const m = /^\s*(\d+)\s*[|:.)-]\s*(.+)$/.exec(line); if (m) out.set(+m[1], m[2].trim()); }
  }
  if (!out.size) throw new Error("The model's answer couldn't be read. Try another model.");
  useEd.getState().commit(pp => {
    const q = structuredClone(pp);
    caps.forEach((c, i) => { const t = out.get(i + 1); if (!t) return; const f = findClip(q, c.id); if (f?.clip.text) { f.clip.text.text = t; f.clip.words = undefined; f.clip.name = t.slice(0, 40); } });
    return q;
  });
  return out.size;
}

// ---------------------------------------------------------------- remove silences (main track)

export async function removeSilences(noiseDb = -38, minUs = 600_000, padUs = 120_000): Promise<number> {
  const st = useEd.getState(); const p = st.p!; const m = mainTrack(p);
  let q = p; let removed = 0;
  // collect silent ranges on the timeline from each main-track clip's source
  const cuts: [US, US][] = [];
  for (const c of m.clips) {
    if (c.type !== "video" && c.type !== "audio" || !c.media || c.reverse || c.curve) continue;
    const media = p.media[c.media]; if (!media?.has_audio) continue;
    const sil = await invoke<[number, number][]>("detect_silence", { path: media.path, noiseDb, minUs });
    const sp = c.speed ?? 1, inn = c.in ?? 0;
    for (const [a, b] of sil) {
      const ta = c.start + (a - inn) / sp + padUs, tb = c.start + (b - inn) / sp - padUs;
      const s = Math.max(c.start, ta), e = Math.min(end(c), tb);
      if (e - s >= minUs / 2) cuts.push([s, e]);
    }
  }
  if (!cuts.length) return 0;
  // split at every cut boundary, then delete the pieces inside the cuts (magnet closes the gaps)
  cuts.sort((a, b) => b[0] - a[0]);
  for (const [s, e] of cuts) {
    q = splitAt(q, s, mainTrack(q).clips.filter(c => c.start < s && s < end(c)).map(c => c.id));
    q = splitAt(q, e, mainTrack(q).clips.filter(c => c.start < e && e < end(c)).map(c => c.id));
    const kill = mainTrack(q).clips.filter(c => c.start >= s - 1000 && end(c) <= e + 1000).map(c => c.id);
    if (kill.length) { q = deleteClips(q, kill); removed++; }
  }
  st.commit(() => q);
  notify(`Removed ${removed} silent part${removed === 1 ? "" : "s"} · new length ${(duration(q) / 1e6).toFixed(1)} s`, "ok");
  return removed;
}
