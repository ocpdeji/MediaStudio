import { describe, expect, it } from "vitest";
import * as T from "./timeline";
import { timecode } from "./format";

const vid = (len: number, over: Partial<T.Clip> = {}) => T.makeClip("video", { out_us: len, source_us: len, asset_id: 1, path: "a.mp4", ...over });
function base() {
  let p = T.newProject({ fps_num: 30000, fps_den: 1001 });
  const v1 = p.tracks[1].id;
  p = T.addClip(p, v1, vid(2_000_000));
  p = T.addClip(p, v1, vid(3_000_000));
  return { p, v1 };
}

describe("time math", () => {
  it("snaps to exact NTSC frame boundaries as integers", () => {
    const p = { fps_num: 30000, fps_den: 1001 };
    const f = T.toFrame(1_000_000, p);
    expect(Number.isInteger(f)).toBe(true);
    expect(Math.abs(f - 1_001_000)).toBeLessThanOrEqual(1); // 30 frames @ 29.97 = 1.001 s
    // no drift after many frames
    expect(T.toFrame(3_600_000_000, p) % 1).toBe(0);
  });
  it("formats timecode", () => {
    expect(timecode(1_500_000, 30, 1)).toBe("00:00:01:15");
    expect(timecode(3_661_000_000, 25, 1)).toBe("01:01:01:00");
  });
});

describe("edits", () => {
  it("appends clips without overlap", () => {
    const { p } = base();
    const cs = p.tracks[1].clips;
    expect(cs.map(c => c.start_us)).toEqual([0, T.clipEnd(cs[0])]);
    expect(T.duration(p)).toBe(T.clipEnd(cs[1]));
  });
  it("splits at the playhead, preserving source continuity", () => {
    const { p, v1 } = base();
    const id = p.tracks[1].clips[0].id;
    const q = T.splitClip(p, id, 1_000_000);
    const [a, b] = q.tracks.find(t => t.id === v1)!.clips;
    expect(a.out_us).toBe(b.in_us);
    expect(T.clipEnd(a)).toBe(b.start_us);
    expect(T.clipLen(a) + T.clipLen(b)).toBe(T.clipLen(p.tracks[1].clips[0]));
    expect(T.splitClip(p, id, 0)).toBe(p); // splitting at an edge is a no-op
  });
  it("ripple delete closes the gap; plain delete leaves it", () => {
    const { p } = base();
    const [a, b] = p.tracks[1].clips;
    expect(T.deleteClip(p, a.id, true).tracks[1].clips[0].start_us).toBe(0);
    expect(T.deleteClip(p, a.id, false).tracks[1].clips[0].start_us).toBe(b.start_us);
  });
  it("trims within source bounds and neighbours", () => {
    const { p } = base();
    const [a, b] = p.tracks[1].clips;
    const q = T.trimClip(p, a.id, "end", 99_000_000); // can't run into b nor past source
    expect(T.clipEnd(T.findClip(q, a.id)!.clip)).toBeLessThanOrEqual(b.start_us);
    const r = T.trimClip(p, b.id, "start", 0); // can't extend before source start or over a
    expect(T.findClip(r, b.id)!.clip.in_us).toBeGreaterThanOrEqual(0);
    expect(T.findClip(r, b.id)!.clip.start_us).toBeGreaterThanOrEqual(T.clipEnd(a));
    const s = T.trimClip(p, b.id, "start", b.start_us + 1_000_000);
    const nb = T.findClip(s, b.id)!.clip;
    expect(nb.in_us).toBeGreaterThan(0); expect(T.clipEnd(nb)).toBe(T.clipEnd(b));
  });
  it("refuses overlapping moves and audio↔video track mismatches", () => {
    const { p } = base();
    const [a, b] = p.tracks[1].clips;
    expect(T.moveClip(p, a.id, b.start_us + 10)).toBe(p);
    const audio = p.tracks[2].id;
    expect(T.moveClip(p, a.id, 0, audio)).toBe(p);
    const q = T.moveClip(p, a.id, 0, p.tracks[0].id);
    expect(q.tracks[0].clips[0].id).toBe(a.id);
  });
  it("speed changes timeline length", () => {
    const c = vid(4_000_000, { speed: 2 });
    expect(T.clipLen(c)).toBe(2_000_000);
  });
  it("snaps to edges within threshold", () => {
    const { p } = base();
    const e = T.clipEnd(p.tracks[1].clips[0]);
    expect(T.snap(p, e + 30_000, 50_000)).toBe(e);
    expect(T.snap(p, e + 90_000, 50_000)).toBe(e + 90_000);
  });
  it("respects locked tracks", () => {
    const { p, v1 } = base();
    const q = T.updateTrack(p, v1, { locked: true });
    expect(T.deleteClip(q, q.tracks[1].clips[0].id)).toBe(q);
  });
});

describe("history & files", () => {
  it("undo/redo", () => {
    const h = new T.History(1); h.push(2); h.push(3);
    expect(h.undo()).toBe(true); expect(h.present).toBe(2);
    expect(h.redo()).toBe(true); expect(h.present).toBe(3);
    h.undo(); h.push(9); expect(h.canRedo).toBe(false);
  });
  it("round-trips and validates project files", () => {
    const { p } = base();
    const back = T.parseProject(JSON.parse(T.serialize(p)));
    expect(back).toEqual(p);
    expect(() => T.parseProject({ format: "nope" })).toThrow();
    const bad = JSON.parse(T.serialize(p)); bad.project.tracks[1].clips[0].out_us = -1;
    expect(() => T.parseProject(bad)).toThrow(/invalid timing/);
  });
  it("activeAt includes dissolve pre-roll", () => {
    let { p } = base();
    const b = p.tracks[1].clips[1];
    p = T.updateClip(p, b.id, { transition: "dissolve", transition_us: 500_000 });
    expect(T.activeAt(p, b.start_us - 250_000).map(x => x.clip.id)).toContain(b.id);
  });
});
