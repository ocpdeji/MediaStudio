// Clip/text animations (CapCut "Animation" tab): In, Out and Loop presets evaluated per frame.
export interface AnimState { dx: number; dy: number; scale: number; sx: number; sy: number; rot: number; opacity: number; blur: number; reveal: [number, number, number, number] }
export const neutral = (): AnimState => ({ dx: 0, dy: 0, scale: 1, sx: 1, sy: 1, rot: 0, opacity: 1, blur: 0, reveal: [0, 0, 1, 1] });

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeIn = (x: number) => x * x * x;
const back = (x: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const bounceOut = (x: number) => { const n = 7.5625, d = 2.75; if (x < 1 / d) return n * x * x; if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75; if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375; return n * (x -= 2.625 / d) * x + 0.984375; };
const elastic = (x: number) => x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;

/** `k` = how far the clip is from its resting state: 1 at the very start of an In / end of an Out, 0 at rest.
 *  `dir` = +1 for In, −1 for Out (for animations that keep moving in the same direction). */
type Fn = (s: AnimState, k: number, e: number, dir: number) => void;
export interface AnimDef { id: string; name: string; kinds: ("in" | "out" | "loop")[]; text?: boolean; fn?: Fn; loop?: (s: AnimState, t: number, speed: number) => void; char?: string }

const A = (id: string, name: string, fn: Fn, text = false): AnimDef => ({ id, name, kinds: ["in", "out"], fn, text });
const L = (id: string, name: string, loop: (s: AnimState, t: number, sp: number) => void): AnimDef => ({ id, name, kinds: ["loop"], loop });
const C = (id: string, name: string, char: string, kinds: ("in" | "out" | "loop")[] = ["in", "out"]): AnimDef => ({ id, name, kinds, text: true, char });

export const ANIMS: AnimDef[] = [
  A("fade", "Fade", (s, k) => { s.opacity *= 1 - k; }),
  A("zoomIn", "Zoom in", (s, k) => { s.scale *= 1 - 0.6 * k; s.opacity *= 1 - k * 0.6; }),
  A("zoomOut", "Zoom out", (s, k) => { s.scale *= 1 + 0.8 * k; s.opacity *= 1 - k * 0.8; }),
  A("slideLeft", "Slide left", (s, k, _e, d) => { s.dx += d > 0 ? k * 1.0 : -k * 1.0; }),
  A("slideRight", "Slide right", (s, k, _e, d) => { s.dx += d > 0 ? -k * 1.0 : k * 1.0; }),
  A("slideUp", "Slide up", (s, k, _e, d) => { s.dy += d > 0 ? k * 1.0 : -k * 1.0; }),
  A("slideDown", "Slide down", (s, k, _e, d) => { s.dy += d > 0 ? -k * 1.0 : k * 1.0; }),
  A("rotate", "Rotate", (s, k) => { s.rot += k * 180; s.opacity *= 1 - k; }),
  A("spin", "Spin", (s, k) => { s.rot += k * 360; s.scale *= 1 - 0.7 * k; }),
  A("pop", "Pop", (s, _k, e) => { const v = back(e); s.scale *= Math.max(0, v); s.opacity *= Math.min(1, e * 3); }),
  A("bounce", "Bounce", (s, _k, e, d) => { s.dy += (1 - bounceOut(e)) * -0.5 * d; s.opacity *= Math.min(1, e * 4); }),
  A("elastic", "Elastic", (s, _k, e) => { s.scale *= elastic(e); }),
  A("drop", "Drop", (s, k, _e, d) => { s.dy += -k * 0.6 * d; s.opacity *= 1 - k; }),
  A("rise", "Rise", (s, k, _e, d) => { s.dy += k * 0.4 * d; s.opacity *= 1 - k; }),
  A("swing", "Swing", (s, k) => { s.rot += Math.sin(k * 9) * 25 * k; s.opacity *= 1 - k * 0.5; }),
  A("flipH", "Flip", (s, k) => { s.sx *= Math.cos(k * Math.PI / 2); }),
  A("flipV", "Flip vertical", (s, k) => { s.sy *= Math.cos(k * Math.PI / 2); }),
  A("blur", "Blur", (s, k) => { s.blur += k * 30; s.opacity *= 1 - k * 0.5; }),
  A("zoomBlur", "Zoom & blur", (s, k) => { s.blur += k * 24; s.scale *= 1 + 0.4 * k; s.opacity *= 1 - k; }),
  A("wipeLeft", "Wipe left", (s, k) => { s.reveal[2] = 1 - k; }),
  A("wipeRight", "Wipe right", (s, k) => { s.reveal[0] = k; }),
  A("wipeUp", "Wipe up", (s, k) => { s.reveal[1] = k; }),
  A("wipeDown", "Wipe down", (s, k) => { s.reveal[3] = 1 - k; }),
  A("openH", "Open", (s, k) => { s.reveal[0] = k / 2; s.reveal[2] = 1 - k / 2; }),
  A("shake", "Shake", (s, k) => { s.dx += Math.sin(k * 40) * 0.04 * k; s.rot += Math.sin(k * 33) * 6 * k; }),
  A("squeeze", "Squeeze", (s, k) => { s.sx *= 1 - k; s.sy *= 1 + k * 0.4; }),
  A("stretch", "Stretch", (s, k) => { s.sy *= 1 - k; s.sx *= 1 + k * 0.4; }),
  A("twist", "Twist", (s, k) => { s.rot += k * 90; s.scale *= 1 - 0.5 * k; s.opacity *= 1 - k; }),
  A("roll", "Roll in", (s, k, _e, d) => { s.dx += k * 1.0 * d; s.rot += k * 360 * d; }),
  // per-character text animations
  C("typewriter", "Typewriter", "typewriter"),
  C("wordPop", "Word pop", "wordPop"),
  C("letterFade", "Letter fade", "letterFade"),
  C("letterDrop", "Letter drop", "letterDrop"),
  C("letterRise", "Letter rise", "letterRise"),
  C("letterZoom", "Letter zoom", "letterZoom"),
  C("waveText", "Wave", "wave", ["loop"]),
  C("bounceText", "Letter bounce", "bounceLoop", ["loop"]),
  C("shineText", "Flicker letters", "flicker", ["loop"]),
  // loops
  L("pulse", "Pulse", (s, t, sp) => { s.scale *= 1 + 0.06 * Math.sin(t * Math.PI * 2 * sp); }),
  L("float", "Float", (s, t, sp) => { s.dy += Math.sin(t * Math.PI * sp) * 0.025; }),
  L("swingLoop", "Swing", (s, t, sp) => { s.rot += Math.sin(t * Math.PI * 2 * sp * 0.6) * 8; }),
  L("shakeLoop", "Shake", (s, t, sp) => { s.dx += Math.sin(t * 50 * sp) * 0.008; s.dy += Math.cos(t * 43 * sp) * 0.008; }),
  L("spinLoop", "Spin", (s, t, sp) => { s.rot += (t * 120 * sp) % 360; }),
  L("heartbeat", "Heartbeat", (s, t, sp) => { const x = (t * sp) % 1; s.scale *= 1 + 0.12 * (Math.exp(-Math.pow((x - 0.1) * 14, 2)) + 0.7 * Math.exp(-Math.pow((x - 0.32) * 14, 2))); }),
  L("wobble", "Wobble", (s, t, sp) => { s.sx *= 1 + 0.06 * Math.sin(t * 7 * sp); s.sy *= 1 - 0.06 * Math.sin(t * 7 * sp); }),
  L("flickerLoop", "Flicker", (s, t, sp) => { s.opacity *= Math.sin(t * 40 * sp) > 0.6 ? 0.55 : 1; }),
  L("zoomLoop", "Slow zoom (Ken Burns)", (s, t, sp) => { s.scale *= 1 + 0.04 * t * sp; }),
  L("bounceLoop", "Bounce", (s, t, sp) => { s.dy -= Math.abs(Math.sin(t * Math.PI * sp)) * 0.04; }),
];
export const animById = (id?: string | null) => (id ? ANIMS.find(a => a.id === id) : undefined);

export interface CharAnim { mode: string; k: number; phase: "in" | "out" | "loop"; t: number }

/** Combined state for a clip at `local` µs. Returns the state plus an optional per-character text animation. */
export function animAt(c: { dur: number; animIn?: { id: string; dur: number } | null; animOut?: { id: string; dur: number } | null; animLoop?: { id: string; dur: number } | null }, local: number): { s: AnimState; char: CharAnim | null } {
  const s = neutral(); let char: CharAnim | null = null;
  const din = Math.min(c.animIn?.dur ?? 0, c.dur), dout = Math.min(c.animOut?.dur ?? 0, c.dur - din);
  const lp = animById(c.animLoop?.id);
  if (lp) {
    const sp = 1_000_000 / Math.max(100_000, c.animLoop!.dur || 1_000_000);
    if (lp.loop) lp.loop(s, local / 1e6, sp);
    if (lp.text && lp.char) char = { mode: lp.char, k: 0, phase: "loop", t: (local / 1e6) * sp };
  }
  const ai = animById(c.animIn?.id);
  if (ai && din > 0 && local < din) {
    const e = Math.max(0, Math.min(1, local / din));
    if (ai.fn) ai.fn(s, 1 - easeOut(e), e, 1);
    if (ai.char) char = { mode: ai.char, k: e, phase: "in", t: local / 1e6 };
  }
  const ao = animById(c.animOut?.id);
  if (ao && dout > 0 && local > c.dur - dout) {
    const e = Math.max(0, Math.min(1, (local - (c.dur - dout)) / dout));
    if (ao.fn) ao.fn(s, easeIn(e), 1 - e, -1);
    if (ao.char) char = { mode: ao.char, k: 1 - e, phase: "out", t: local / 1e6 };
  }
  return { s, char };
}
