// Colour filters as 33³ 3D LUTs, generated from small colour recipes (no bundled image assets), plus .cube import.
export const LUT_N = 33;
type RGB = [number, number, number];
type Op = (c: RGB) => RGB;

const cl = (v: number) => Math.min(1, Math.max(0, v));
const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hexc = (h: string): RGB => { const n = parseInt(h.replace("#", ""), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

const ops = {
  temp: (t: number): Op => c => [cl(c[0] + t * 0.08), c[1], cl(c[2] - t * 0.08)],
  tint: (t: number): Op => c => [c[0], cl(c[1] + t * 0.06), c[2]],
  sat: (s: number): Op => c => { const l = lum(c); return [cl(l + (c[0] - l) * s), cl(l + (c[1] - l) * s), cl(l + (c[2] - l) * s)]; },
  contrast: (k: number): Op => c => c.map(v => cl((v - 0.5) * k + 0.5)) as RGB,
  scurve: (k: number): Op => c => c.map(v => { const s = v * v * (3 - 2 * v); return cl(v + (s - v) * k); }) as RGB,
  bright: (b: number): Op => c => c.map(v => cl(v + b)) as RGB,
  gamma: (g: number): Op => c => c.map(v => Math.pow(cl(v), g)) as RGB,
  fade: (f: number): Op => c => c.map(v => f + v * (1 - f * 1.4)) as RGB,
  lift: (col: string, amt: number): Op => c => { const l = lum(c), w = (1 - l) * (1 - l); const k = hexc(col); return mixc(c, [cl(c[0] + (k[0] - 0.5) * amt * w), cl(c[1] + (k[1] - 0.5) * amt * w), cl(c[2] + (k[2] - 0.5) * amt * w)], 1); },
  gain: (col: string, amt: number): Op => c => { const l = lum(c), w = l * l; const k = hexc(col); return [cl(c[0] + (k[0] - 0.5) * amt * w), cl(c[1] + (k[1] - 0.5) * amt * w), cl(c[2] + (k[2] - 0.5) * amt * w)]; },
  mono: (r = 0.3, g = 0.59, b = 0.11): Op => c => { const v = cl(c[0] * r + c[1] * g + c[2] * b); return [v, v, v]; },
  tone: (col: string, amt: number): Op => c => { const k = hexc(col); const l = lum(c); return mixc(c, [cl(l * k[0] * 1.6), cl(l * k[1] * 1.6), cl(l * k[2] * 1.6)], amt); },
  chan: (r: number, g: number, b: number): Op => c => [cl(c[0] * r), cl(c[1] * g), cl(c[2] * b)],
  hueShift: (deg: number): Op => c => {
    const a = (deg * Math.PI) / 180, s = Math.sin(a), k = Math.cos(a), [r, g, b] = c;
    return [cl(r * (0.299 + 0.701 * k + 0.168 * s) + g * (0.587 - 0.587 * k + 0.33 * s) + b * (0.114 - 0.114 * k - 0.497 * s)),
      cl(r * (0.299 - 0.299 * k - 0.328 * s) + g * (0.587 + 0.413 * k + 0.035 * s) + b * (0.114 - 0.114 * k + 0.292 * s)),
      cl(r * (0.299 - 0.3 * k + 1.25 * s) + g * (0.587 - 0.588 * k - 1.05 * s) + b * (0.114 + 0.886 * k - 0.203 * s))];
  },
  crush: (b: number): Op => c => c.map(v => cl((v - b) / (1 - b))) as RGB,
  selSat: (hueCenter: number, width: number, s: number): Op => c => {
    const mx = Math.max(...c), mn = Math.min(...c), d = mx - mn; if (d < 1e-4) return c;
    let h = mx === c[0] ? ((c[1] - c[2]) / d) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4; h = (h * 60 + 360) % 360;
    const dist = Math.min(Math.abs(h - hueCenter), 360 - Math.abs(h - hueCenter)); const w = Math.max(0, 1 - dist / width);
    return ops.sat(1 + (s - 1) * w)(c);
  },
};

export interface FilterDef { id: string; name: string; cat: string; ops: Op[]; swatch: string }
const F = (id: string, name: string, cat: string, swatch: string, ...o: Op[]): FilterDef => ({ id, name, cat, ops: o, swatch });

export const FILTER_CATS = ["Featured", "Life", "Film", "Retro", "B&W", "Food", "Nature", "Night", "Style"];
export const FILTERS: FilterDef[] = [
  F("vivid", "Vivid", "Featured", "#ff7a59", ops.sat(1.35), ops.scurve(0.35)),
  F("clear", "Clear", "Featured", "#9ad1ff", ops.contrast(1.08), ops.sat(1.12), ops.temp(-0.2)),
  F("warm", "Warm", "Featured", "#ffb266", ops.temp(0.6), ops.sat(1.08)),
  F("cool", "Cool", "Featured", "#6fb5ff", ops.temp(-0.6), ops.tint(-0.1)),
  F("tealOrange", "Teal & orange", "Featured", "#1f9aa8", ops.lift("#1e8f9c", 0.55), ops.gain("#ffa25a", 0.45), ops.scurve(0.3), ops.sat(1.1)),
  F("cinema", "Cinematic", "Film", "#3a6f7a", ops.lift("#205a6a", 0.45), ops.gain("#f5b27a", 0.3), ops.contrast(1.12), ops.sat(0.88), ops.fade(0.03)),
  F("kodak", "Portra", "Film", "#e8b08a", ops.temp(0.25), ops.lift("#a0703a", 0.2), ops.scurve(0.25), ops.sat(0.95), ops.fade(0.04)),
  F("fuji", "Superia", "Film", "#7fb48a", ops.tint(0.15), ops.lift("#3a8a5a", 0.25), ops.scurve(0.3), ops.sat(1.05)),
  F("cinestill", "Cinestill", "Film", "#ff6f6f", ops.temp(-0.2), ops.gain("#ff8a7a", 0.4), ops.scurve(0.35), ops.fade(0.05)),
  F("bleach", "Bleach bypass", "Film", "#9aa3a8", ops.sat(0.45), ops.contrast(1.3), ops.bright(-0.02)),
  F("matte", "Matte", "Film", "#a89a8a", ops.fade(0.09), ops.sat(0.9), ops.scurve(0.15)),
  F("fresh", "Fresh", "Life", "#7fe0b5", ops.bright(0.03), ops.sat(1.15), ops.temp(-0.15), ops.tint(0.05)),
  F("bright", "Bright", "Life", "#fff2a8", ops.gamma(0.85), ops.sat(1.05)),
  F("soft", "Soft", "Life", "#f3d1d8", ops.fade(0.05), ops.contrast(0.9), ops.temp(0.15)),
  F("peach", "Peach", "Life", "#ffc0a0", ops.temp(0.35), ops.tint(-0.1), ops.gain("#ffb0a0", 0.3), ops.sat(1.05)),
  F("pink", "Pink", "Life", "#ff9ac6", ops.gain("#ff8ac0", 0.5), ops.lift("#c060a0", 0.15)),
  F("portrait", "Portrait", "Life", "#f0b89a", ops.selSat(25, 40, 0.9), ops.temp(0.15), ops.bright(0.03), ops.contrast(0.95)),
  F("retro70", "1970s", "Retro", "#d49a4a", ops.temp(0.5), ops.lift("#a06030", 0.35), ops.fade(0.08), ops.sat(0.8)),
  F("polaroid", "Polaroid", "Retro", "#d8c8a0", ops.fade(0.07), ops.lift("#6a8aa0", 0.3), ops.gain("#ffe0a0", 0.3), ops.contrast(0.95)),
  F("vhsColor", "VHS colour", "Retro", "#b46aa0", ops.hueShift(-6), ops.lift("#4a2a6a", 0.4), ops.sat(1.2), ops.fade(0.05)),
  F("faded", "Faded", "Retro", "#b8b0a0", ops.fade(0.12), ops.sat(0.7)),
  F("sepiaF", "Sepia", "Retro", "#a0784a", ops.tone("#c09060", 0.85)),
  F("lomo", "Lomo", "Retro", "#d0a030", ops.scurve(0.6), ops.sat(1.3), ops.lift("#205050", 0.3)),
  F("bwClassic", "Classic", "B&W", "#888888", ops.mono(), ops.scurve(0.25)),
  F("bwHigh", "High contrast", "B&W", "#222222", ops.mono(0.4, 0.5, 0.1), ops.contrast(1.45)),
  F("bwSoft", "Soft mono", "B&W", "#bbbbbb", ops.mono(), ops.fade(0.08)),
  F("noir", "Noir", "B&W", "#111111", ops.mono(0.5, 0.45, 0.05), ops.crush(0.06), ops.scurve(0.5)),
  F("selenium", "Selenium", "B&W", "#7a6a7a", ops.mono(), ops.tone("#a08aa0", 0.4)),
  F("tasty", "Tasty", "Food", "#ff9a3a", ops.temp(0.4), ops.sat(1.3), ops.contrast(1.08)),
  F("crisp", "Crisp", "Food", "#ffd45a", ops.sat(1.2), ops.scurve(0.4), ops.bright(0.02)),
  F("delicious", "Delicious", "Food", "#ff6a4a", ops.selSat(15, 60, 1.4), ops.temp(0.25)),
  F("green", "Lush", "Nature", "#3ab05a", ops.selSat(110, 50, 1.45), ops.contrast(1.05)),
  F("ocean", "Ocean", "Nature", "#2a8ad0", ops.selSat(210, 50, 1.4), ops.temp(-0.25)),
  F("golden", "Golden hour", "Nature", "#ffb43a", ops.temp(0.7), ops.gain("#ffc06a", 0.4), ops.sat(1.1)),
  F("autumn", "Autumn", "Nature", "#d06a2a", ops.hueShift(-12), ops.temp(0.4), ops.sat(1.15)),
  F("moody", "Moody", "Night", "#2a3a4a", ops.bright(-0.06), ops.sat(0.75), ops.lift("#2a4a6a", 0.4), ops.contrast(1.1)),
  F("neonNight", "Neon night", "Night", "#a03aff", ops.lift("#3a1a8a", 0.5), ops.gain("#ff4ac0", 0.35), ops.sat(1.3), ops.contrast(1.1)),
  F("midnight", "Midnight", "Night", "#1a2a5a", ops.temp(-0.7), ops.bright(-0.05), ops.sat(0.85)),
  F("cyber", "Cyberpunk", "Style", "#ff2ad0", ops.lift("#00a0c0", 0.5), ops.gain("#ff40c0", 0.5), ops.contrast(1.15), ops.sat(1.2)),
  F("pastel", "Pastel", "Style", "#c0e0ff", ops.fade(0.1), ops.sat(0.8), ops.bright(0.05)),
  F("dramatic", "Dramatic", "Style", "#5a3a2a", ops.scurve(0.7), ops.sat(0.85), ops.crush(0.03)),
  F("hdr", "HDR look", "Style", "#ffaa00", ops.scurve(0.5), ops.sat(1.35), ops.contrast(1.1)),
  F("dune", "Desert", "Style", "#e0a060", ops.temp(0.55), ops.tint(-0.05), ops.sat(0.85), ops.fade(0.04)),
  F("matrix", "Matrix", "Style", "#2aff6a", ops.chan(0.85, 1.1, 0.8), ops.lift("#1a6a2a", 0.3), ops.contrast(1.1)),
];

export const filterById = (id: string) => FILTERS.find(f => f.id === id);

/** Imported .cube LUTs (id "cube:<path>"), shared by the preview and export compositors. */
export const CUSTOM_LUTS: Record<string, Uint8Array> = {};
const cache = new Map<string, Uint8Array>();
export function lutData(id: string): Uint8Array | null {
  if (CUSTOM_LUTS[id]) return CUSTOM_LUTS[id];
  const hit = cache.get(id); if (hit) return hit;
  const def = filterById(id); if (!def) return null;
  const N = LUT_N, out = new Uint8Array(N * N * N * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    let c: RGB = [r / (N - 1), g / (N - 1), b / (N - 1)];
    for (const o of def.ops) c = o(c);
    const i = ((b * N + g) * N + r) * 4;
    out[i] = Math.round(cl(c[0]) * 255); out[i + 1] = Math.round(cl(c[1]) * 255); out[i + 2] = Math.round(cl(c[2]) * 255); out[i + 3] = 255;
  }
  cache.set(id, out); return out;
}

/** Parse an Adobe/Resolve .cube 3D LUT and resample it to 33³. */
export function parseCube(text: string): Uint8Array {
  let size = 0; let dmin: RGB = [0, 0, 0], dmax: RGB = [1, 1, 1]; const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "LUT_3D_SIZE") size = parseInt(parts[1], 10);
    else if (parts[0] === "DOMAIN_MIN") dmin = parts.slice(1, 4).map(Number) as RGB;
    else if (parts[0] === "DOMAIN_MAX") dmax = parts.slice(1, 4).map(Number) as RGB;
    else if (parts[0] === "LUT_1D_SIZE") throw new Error("1D LUTs are not supported — use a 3D .cube file");
    else if (/^[-+0-9.eE]/.test(parts[0]) && parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (size < 2 || size > 256) throw new Error("This .cube file has no valid LUT_3D_SIZE");
  if (vals.length < size * size * size * 3) throw new Error("This .cube file is incomplete");
  const at = (r: number, g: number, b: number): RGB => { const i = ((b * size + g) * size + r) * 3; return [vals[i], vals[i + 1], vals[i + 2]]; };
  const sample = (c: RGB): RGB => {
    const p = c.map((v, k) => cl((v - dmin[k]) / Math.max(1e-6, dmax[k] - dmin[k])) * (size - 1));
    const i0 = p.map(Math.floor), f = p.map((v, k) => v - i0[k]), i1 = i0.map(v => Math.min(size - 1, v + 1));
    let out: RGB = [0, 0, 0];
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
      const v = at(dx ? i1[0] : i0[0], dy ? i1[1] : i0[1], dz ? i1[2] : i0[2]);
      out = [out[0] + v[0] * w, out[1] + v[1] * w, out[2] + v[2] * w];
    }
    return out;
  };
  const N = LUT_N, data = new Uint8Array(N * N * N * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const c = sample([dmin[0] + (r / (N - 1)) * (dmax[0] - dmin[0]), dmin[1] + (g / (N - 1)) * (dmax[1] - dmin[1]), dmin[2] + (b / (N - 1)) * (dmax[2] - dmin[2])]);
    const i = ((b * N + g) * N + r) * 4;
    data[i] = Math.round(cl(c[0]) * 255); data[i + 1] = Math.round(cl(c[1]) * 255); data[i + 2] = Math.round(cl(c[2]) * 255); data[i + 3] = 255;
  }
  return data;
}

/** Identity LUT (used when no filter is set so the sampler is always valid). */
export function identityLut(): Uint8Array {
  const N = LUT_N, out = new Uint8Array(N * N * N * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) { const i = ((b * N + g) * N + r) * 4; out[i] = (r * 255) / (N - 1); out[i + 1] = (g * 255) / (N - 1); out[i + 2] = (b * 255) / (N - 1); out[i + 3] = 255; }
  return out;
}
