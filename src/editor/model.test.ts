import { describe, expect, it } from "vitest";
import {
  addClips, Clip, CURVES, deleteClips, duplicateClip, end, findClip, History, keyValue, mainTrack, MediaRef, moveClip, newProject, nextAdjacent, Project, SEC,
  setKey, setSpeed, snap, sourceTime, splitAt, srcOffset, srcSpan, toFrame, trimClip, trimToPlayhead, updateClip, validate,
} from "./model";

const media = (id: string, dur = 10 * SEC): MediaRef => ({ id, path: `C:\\m\\${id}.mp4`, name: id, kind: "video", duration: dur, width: 1920, height: 1080, fps_num: 30, fps_den: 1, has_audio: true, has_video: true, playable: true, size: 1, mtime: 1 });
const vclip = (m: string, dur = 2 * SEC, inn = 0): Clip => ({ id: "", type: "video", start: 0, dur, media: m, in: inn, speed: 1 });
function proj(): Project { const p = newProject("t"); p.media = { a: media("a"), b: media("b"), c: media("c") }; return p; }
const main = (p: Project) => mainTrack(p).clips;

describe("timeline model", () => {
  it("snaps to exact NTSC frame boundaries without drift", () => {
    const p = { fps_num: 30000, fps_den: 1001 };
    expect(toFrame(1_001_000, p)).toBe(1_001_000); // frame 30
    const f = toFrame(3600 * SEC, p);
    expect(Math.abs(f - 3600 * SEC)).toBeLessThan(40_000);
    expect(toFrame(f, p)).toBe(f);
  });

  it("appends to the magnetic main track without gaps and inserts at clip boundaries", () => {
    let p = addClips(proj(), [vclip("a"), vclip("b", 3 * SEC)]);
    expect(main(p).map(c => [c.media, c.start])).toEqual([["a", 0], ["b", 2 * SEC]]);
    p = addClips(p, [vclip("c", SEC)], { at: 0.5 * SEC }); // nearest boundary at/after 0.5 s is 0
    expect(main(p).map(c => c.media)).toEqual(["c", "a", "b"]);
    expect(main(p).map(c => c.start)).toEqual([0, SEC, 3 * SEC]);
  });

  it("places overlays and text on new tracks above main, audio below", () => {
    let p = addClips(proj(), [vclip("a")]);
    p = addClips(p, [{ id: "", type: "video", start: 0, dur: SEC, media: "b" }], { at: 0, toMain: false });
    p = addClips(p, [{ id: "", type: "text", start: 0, dur: SEC }], { at: 0 });
    p = addClips(p, [{ id: "", type: "audio", start: 0, dur: SEC, media: "c" }], { at: 0 });
    expect(p.tracks.map(t => t.kind + (t.main ? "*" : ""))).toEqual(["text", "video", "video*", "audio"]);
  });

  it("splits preserving source continuity, including speed and reverse", () => {
    let p = addClips(proj(), [{ ...vclip("a", 4 * SEC, SEC), speed: 2 }]);
    const id = main(p)[0].id;
    p = splitAt(p, 1.5 * SEC);
    const [a, b] = main(p);
    expect(a.dur + b.dur).toBe(4 * SEC);
    expect(sourceTime(a, end(a) - 1)).toBeCloseTo(sourceTime(b, b.start), -1);
    expect(b.in).toBe(SEC + 3 * SEC);
    expect(a.id).toBe(id);
    // reversed: the right part reads the earliest source
    let r = addClips(proj(), [{ ...vclip("a", 4 * SEC, 2 * SEC), reverse: true }]);
    r = splitAt(r, SEC);
    const [ra, rb] = main(r);
    expect(sourceTime(ra, 0)).toBe(6 * SEC);
    expect(sourceTime(rb, rb.start)).toBeCloseTo(sourceTime(ra, end(ra)), -1);
    expect(sourceTime(rb, end(rb))).toBe(2 * SEC);
  });

  it("splits keyframes and caption words at the cut", () => {
    let p = addClips(proj(), [{ ...vclip("a", 4 * SEC), keys: { opacity: [{ t: 0, v: 0, e: "linear" }, { t: 4 * SEC, v: 1, e: "linear" }] }, words: [{ t0: 0, t1: SEC, text: "a" }, { t0: 1.5 * SEC, t1: 2.5 * SEC, text: "b" }, { t0: 3 * SEC, t1: 3.5 * SEC, text: "c" }] }]);
    p = splitAt(p, 2 * SEC);
    const [a, b] = main(p);
    expect(keyValue(a.keys!.opacity, 2 * SEC, 1)).toBeCloseTo(0.5);
    expect(keyValue(b.keys!.opacity, 0, 1)).toBeCloseTo(0.5);
    expect(keyValue(b.keys!.opacity, 2 * SEC, 1)).toBeCloseTo(1);
    expect(a.words!.map(w => w.text)).toEqual(["a", "b"]);
    expect(b.words!.map(w => [w.text, w.t0])).toEqual([["b", 0], ["c", SEC]]);
  });

  it("trims within source bounds and neighbours; ripple closes gaps on main", () => {
    let p = addClips(proj(), [vclip("a", 2 * SEC, SEC), vclip("b", 2 * SEC)]);
    const [a, b] = main(p);
    p = trimClip(p, a.id, "start", -5 * SEC); // can only extend back to source 0
    expect(main(p)[0].in).toBe(0); expect(main(p)[0].dur).toBe(3 * SEC);
    p = trimClip(p, a.id, "end", 100 * SEC); // limited by media duration 10 s
    expect(main(p)[0].dur).toBe(10 * SEC);
    expect(findClip(p, b.id)!.clip.start).toBe(10 * SEC);
    p = deleteClips(p, [a.id]);
    expect(main(p).map(c => [c.id, c.start])).toEqual([[b.id, 0]]);
  });

  it("delete left/right of the playhead (Q/W)", () => {
    let p = addClips(proj(), [vclip("a", 4 * SEC), vclip("b", 2 * SEC)]);
    const [a] = main(p);
    p = trimToPlayhead(p, [a.id], SEC, "left");
    expect(main(p)[0].dur).toBe(3 * SEC); expect(main(p)[0].in).toBe(SEC); expect(main(p)[1].start).toBe(3 * SEC);
    p = trimToPlayhead(p, [a.id], 2 * SEC, "right");
    expect(main(p)[0].dur).toBe(2 * SEC);
  });

  it("speed changes duration but keeps the source span; curves integrate to the full span", () => {
    let p = addClips(proj(), [vclip("a", 4 * SEC), vclip("b")]);
    const a = main(p)[0];
    p = setSpeed(p, a.id, 2);
    expect(main(p)[0].dur).toBe(2 * SEC); expect(srcSpan(main(p)[0])).toBe(4 * SEC); expect(main(p)[1].start).toBe(2 * SEC);
    const c: Clip = { ...vclip("a", 4 * SEC), curve: { id: "montage", pts: CURVES.montage.pts } };
    expect(srcOffset(c, c.dur)).toBeCloseTo(4 * SEC, -2);
    let prev = -1; for (let t = 0; t <= c.dur; t += 100_000) { const s = srcOffset(c, t); expect(s).toBeGreaterThanOrEqual(prev); prev = s; }
  });

  it("main-track move reorders; overlay moves reject overlaps", () => {
    let p = addClips(proj(), [vclip("a"), vclip("b"), vclip("c")]);
    const [a, , c] = main(p);
    p = moveClip(p, c.id, 0);
    expect(main(p).map(x => x.media)).toEqual(["c", "a", "b"]);
    p = addClips(p, [{ ...vclip("a"), id: "o1" }], { at: 0, toMain: false });
    p = addClips(p, [{ ...vclip("b"), id: "o2" }], { at: 3 * SEC, toMain: false });
    const ov = p.tracks.find(t => t.kind === "video" && !t.main)!;
    expect(ov.clips.length).toBe(2);
    const before = JSON.stringify(p);
    p = moveClip(p, "o2", SEC); // would overlap o1
    expect(JSON.stringify(p)).toBe(before);
    void a;
  });

  it("transitions only exist between adjacent clips and are clamped", () => {
    let p = addClips(proj(), [vclip("a", 2 * SEC), vclip("b", 0.5 * SEC)]);
    const [a] = main(p);
    p = updateClip(p, a.id, { transition: { id: "fade", dur: SEC } });
    p = updateClip(p, a.id, { dur: 2 * SEC }); // triggers clamp
    expect(findClip(p, a.id)!.clip.transition!.dur).toBe(0.5 * SEC);
    expect(nextAdjacent(mainTrack(p), findClip(p, a.id)!.clip)).toBeTruthy();
    p = deleteClips(p, [main(p)[1].id]);
    expect(findClip(p, a.id)!.clip.transition).toBeNull();
  });

  it("keyframes interpolate with easing and hold", () => {
    let k = setKey(undefined, 0, 0, "linear"); k = setKey(k, SEC, 10, "hold"); k = setKey(k, 2 * SEC, 20);
    expect(keyValue(k, 0.5 * SEC, 99)).toBeCloseTo(5);
    expect(keyValue(k, 1.5 * SEC, 99)).toBe(10);
    expect(keyValue(k, 5 * SEC, 99)).toBe(20);
    expect(keyValue(undefined, 0, 7)).toBe(7);
    expect(setKey(k, SEC, 3).length).toBe(3);
  });

  it("snaps to edges and markers; duplicates; history", () => {
    let p = addClips(proj(), [vclip("a", 2 * SEC)]);
    p.markers = [{ id: "m", t: 5 * SEC, color: "red", label: "" }];
    expect(snap(p, 2.05 * SEC, 0.1 * SEC)).toBe(2 * SEC);
    expect(snap(p, 4.95 * SEC, 0.1 * SEC)).toBe(5 * SEC);
    p = duplicateClip(p, main(p)[0].id);
    expect(main(p).length).toBe(2); expect(main(p)[1].start).toBe(2 * SEC);
    const h = new History<number>(); h.push(1); h.push(2);
    expect(h.undo(3)).toBe(2); expect(h.undo(2)).toBe(1); expect(h.redo(1)).toBe(2);
  });

  it("validates project files", () => {
    expect(() => validate({ format: "x" })).toThrow();
    expect(() => validate({ ...newProject(), version: 1 })).toThrow();
    const p = validate(JSON.parse(JSON.stringify({ ...newProject(), tracks: [{ id: "t", kind: "video", clips: [{ id: "x", type: "video", start: 0, dur: -1 }] }] })));
    expect(p.tracks[0].main).toBe(true); expect(p.tracks[0].clips.length).toBe(0);
  });
});
