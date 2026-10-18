// Long video → Shorts: transcribe the timeline, pick the strongest self-contained moments (with an AI model if one
// is configured, otherwise by speech density), and create a 9:16 project per short with captions and a hook title.
import { ed } from "../api";
import { Clip, deleteClips, duration, end, mainTrack, Project, RATIOS, splitAt, uid } from "../model";
import { CAPTION_STYLES, captionClips, TEXT_PRESETS, textClip } from "../presets";
import { useEd } from "../store";
import { Segment, transcribeTimeline } from "./captions";

export interface Pick { start: number; end: number; title: string }

/** Heuristic picks: windows of whole sentences, 15 s–max, highest words/second, no overlaps. */
export function pickBySpeech(segs: Segment[], count: number, minUs: number, maxUs: number): Pick[] {
  const cands: (Pick & { score: number })[] = [];
  for (let i = 0; i < segs.length; i++) {
    let words = 0;
    for (let j = i; j < segs.length; j++) {
      const s = segs[i].start_us, e = segs[j].end_us; words += (segs[j].words.length || segs[j].text.split(/\s+/).length);
      if (e - s > maxUs) break;
      if (e - s >= minUs) cands.push({ start: Math.max(0, s - 200_000), end: e + 300_000, title: segs[i].text.split(/\s+/).slice(0, 6).join(" "), score: words / ((e - s) / 1e6) + (/[?!]/.test(segs[i].text) ? 0.6 : 0) });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const out: Pick[] = [];
  for (const c of cands) { if (out.length >= count) break; if (out.every(o => c.end <= o.start || c.start >= o.end)) out.push(c); }
  return out.sort((a, b) => a.start - b.start);
}

/** Ask a chat model for the best moments (returns null if the reply can't be used). */
async function pickWithAi(provider: string, segs: Segment[], count: number, minS: number, maxS: number): Promise<Pick[] | null> {
  const lines = segs.map((s, i) => `${i}|${(s.start_us / 1e6).toFixed(1)}-${(s.end_us / 1e6).toFixed(1)}|${s.text}`).join("\n");
  const sys = "You are a social media video editor. From a timestamped transcript, choose the most engaging, self-contained moments for TikTok/Reels/Shorts. Reply ONLY with JSON: [{\"from\":<first line index>,\"to\":<last line index>,\"title\":\"<punchy hook, max 6 words>\"}]";
  const r = await ed.chat(provider, sys, `Pick ${count} clips, each ${minS}-${maxS} seconds long, not overlapping.\nTranscript (index|start-end seconds|text):\n${lines}`);
  const m = r.match(/\[[\s\S]*\]/); if (!m) return null;
  try {
    const arr = JSON.parse(m[0]) as { from: number; to: number; title: string }[];
    const picks = arr.filter(x => segs[x.from] && segs[x.to] && x.to >= x.from).map(x => ({ start: Math.max(0, segs[x.from].start_us - 200_000), end: segs[x.to].end_us + 300_000, title: String(x.title ?? "").slice(0, 60) }));
    return picks.length ? picks.slice(0, count) : null;
  } catch { return null; }
}

/** Keep only [t0, t1) of a project, shifted to start at 0. */
function slice(p: Project, t0: number, t1: number): Project {
  let q = splitAt(p, t1); q = splitAt(q, t0);
  const kill = q.tracks.flatMap(t => t.clips.filter(c => end(c) <= t0 + 1000 || c.start >= t1 - 1000).map(c => c.id));
  q = deleteClips({ ...q, magnet: false }, kill);
  q = structuredClone(q);
  for (const t of q.tracks) for (const c of t.clips) c.start -= t0;
  q.markers = [];
  return q;
}

export async function makeShorts(o: { count: number; maxSec: number; provider: string | null; language: string; onProgress: (p: number, label: string) => void }): Promise<{ id: string; name: string }[]> {
  const st = useEd.getState(); const p = st.p!;
  if (duration(p) < 20_000_000) throw new Error("The timeline is shorter than 20 seconds — add a longer video first.");
  const tr = await transcribeTimeline({ language: o.language, model: "", translate: false, onProgress: (x, l) => o.onProgress(x * 0.7, l) });
  if (!tr.segments.length) throw new Error("No speech was found to choose highlights from.");
  o.onProgress(0.72, o.provider ? "Asking the AI for the best moments…" : "Finding the most engaging moments…");
  const minS = Math.min(15, o.maxSec / 2);
  let picks = o.provider ? await pickWithAi(o.provider, tr.segments, o.count, minS, o.maxSec).catch(() => null) : null;
  if (!picks) picks = pickBySpeech(tr.segments, o.count, minS * 1e6, o.maxSec * 1e6);
  if (!picks.length) throw new Error("Couldn't find suitable moments (try a shorter maximum length).");
  const [W, H] = RATIOS["9:16"]!;
  const created: { id: string; name: string }[] = [];
  for (let i = 0; i < picks.length; i++) {
    const pk = picks[i];
    o.onProgress(0.75 + (0.25 * i) / picks.length, `Creating short ${i + 1} of ${picks.length}…`);
    let q = slice(p, pk.start, pk.end);
    q = { ...q, ratio: "9:16", width: W, height: H, magnet: true, background: { type: "blur", color: "#000000", blur: 60 } };
    // fill the vertical frame with the main video (centre crop), keep captions/titles readable
    for (const c of mainTrack(q).clips) if ((c.type === "video" || c.type === "image") && c.media) {
      const m = q.media[c.media]; if (!m?.width) continue;
      const fit = Math.min(W / m.width, H / m.height), cover = Math.max(W / m.width, H / m.height);
      c.transform = { x: 0, y: 0, scale: cover / fit, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false };
    }
    q.tracks = q.tracks.filter(t => !t.clips.every(c => c.type === "caption"));
    const segs = tr.segments.filter(s => s.end_us > pk.start && s.start_us < pk.end).map(s => ({ ...s, start_us: s.start_us - pk.start, end_us: s.end_us - pk.start, words: s.words.map(w => ({ ...w, start_us: w.start_us - pk.start, end_us: w.end_us - pk.start })).filter(w => w.start_us >= 0) }));
    const caps = captionClips(segs, CAPTION_STYLES[0], 0.2);
    q.tracks.unshift({ id: uid("t"), kind: "text", name: "Captions", clips: caps });
    if (pk.title) {
      const t: Clip = textClip(pk.title.toUpperCase(), TEXT_PRESETS.find(x => x.id === "boxWhite")!, { start: 0, dur: Math.min(3_500_000, pk.end - pk.start), transform: { x: 0, y: -0.33, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false }, animIn: { id: "pop", dur: 400_000 } });
      q.tracks.unshift({ id: uid("t"), kind: "text", clips: [t] });
    }
    const name = `${p.name} – Short ${i + 1}${pk.title ? `: ${pk.title}` : ""}`.slice(0, 110);
    const meta = await ed.create(name, { ...q, name });
    created.push({ id: meta.id, name });
  }
  o.onProgress(1, `Created ${created.length} shorts`);
  return created;
}
