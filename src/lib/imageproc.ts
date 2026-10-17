// CPU image processing for the image workspace. Operates on full-resolution canvases (no repeated JPEG
// round-trips): the editor keeps an RGBA working copy and encodes exactly once on export.

export const mkCanvas = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
export const cloneCanvas = (src: HTMLCanvasElement) => { const c = mkCanvas(src.width, src.height); c.getContext("2d")!.drawImage(src, 0, 0); return c; };
export const ctx2d = (c: HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: true })!;
export const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error("Encoding failed"))), type, q));

// ------------------------------------------------------------------ adjustments

export interface Adjustments {
  exposure: number; brightness: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number;
  saturation: number; vibrance: number; temperature: number; tint: number; gamma: number;
  sharpen: number; denoise: number; blur: number; vignette: number; grayscale: boolean;
}
export const ADJ_DEFAULT: Adjustments = { exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0, gamma: 1, sharpen: 0, denoise: 0, blur: 0, vignette: 0, grayscale: false };
export const ADJ_SLIDERS: { key: keyof Adjustments; label: string; min: number; max: number; step: number; group: string }[] = [
  { key: "exposure", label: "Exposure", min: -3, max: 3, step: 0.05, group: "Light" },
  { key: "brightness", label: "Brightness", min: -100, max: 100, step: 1, group: "Light" },
  { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, group: "Light" },
  { key: "highlights", label: "Highlights", min: -100, max: 100, step: 1, group: "Light" },
  { key: "shadows", label: "Shadows", min: -100, max: 100, step: 1, group: "Light" },
  { key: "whites", label: "Whites (levels)", min: -100, max: 100, step: 1, group: "Light" },
  { key: "blacks", label: "Blacks (levels)", min: -100, max: 100, step: 1, group: "Light" },
  { key: "gamma", label: "Midtones (gamma)", min: 0.3, max: 3, step: 0.01, group: "Light" },
  { key: "temperature", label: "Temperature", min: -100, max: 100, step: 1, group: "Color" },
  { key: "tint", label: "Tint", min: -100, max: 100, step: 1, group: "Color" },
  { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, group: "Color" },
  { key: "vibrance", label: "Vibrance", min: -100, max: 100, step: 1, group: "Color" },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100, step: 1, group: "Detail" },
  { key: "denoise", label: "Noise reduction", min: 0, max: 100, step: 1, group: "Detail" },
  { key: "blur", label: "Blur", min: 0, max: 30, step: 0.5, group: "Detail" },
  { key: "vignette", label: "Vignette", min: -100, max: 100, step: 1, group: "Effects" },
];
export const isDefault = (a: Adjustments) => (Object.keys(ADJ_DEFAULT) as (keyof Adjustments)[]).every(k => a[k] === ADJ_DEFAULT[k]);

/** Apply adjustments to `src`, producing a canvas of size w×h. `scale` = output px per source px (for blur radius). */
export function applyAdjustments(src: CanvasImageSource & { width: number; height: number }, w: number, h: number, a: Adjustments, scale = 1): HTMLCanvasElement {
  const c = mkCanvas(w, h), x = ctx2d(c);
  x.imageSmoothingQuality = "high";
  if (a.blur > 0) x.filter = `blur(${a.blur * scale}px)`;
  x.drawImage(src, 0, 0, c.width, c.height);
  x.filter = "none";
  const W = c.width, H = c.height;
  const id = x.getImageData(0, 0, W, H), d = id.data;
  if (a.denoise > 0) denoise(d, W, H, a.denoise / 100);
  const exp = Math.pow(2, a.exposure), con = 1 + a.contrast / 100, bri = a.brightness / 250;
  const t = a.temperature / 100, ti = a.tint / 100;
  const wr = 1 + t * 0.18, wb = 1 - t * 0.18, wg = 1 - ti * 0.15;
  const black = Math.max(0, -a.blacks) / 400 - Math.max(0, a.blacks) / 400, white = 1 - a.whites / 400;
  const hl = a.highlights / 100, sh = a.shadows / 100, sat = 1 + a.saturation / 100, vib = a.vibrance / 100, ig = 1 / a.gamma;
  const vig = a.vignette / 100, cx = W / 2, cy = H / 2, maxd = Math.hypot(cx, cy);
  const lut = new Float32Array(256); for (let i = 0; i < 256; i++) lut[i] = i / 255;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    const i = (y * W + xx) * 4;
    let r = lut[d[i]] * exp * wr, g = lut[d[i + 1]] * exp * wg, b = lut[d[i + 2]] * exp * wb;
    // levels + gamma
    r = (r - black) / (white - black); g = (g - black) / (white - black); b = (b - black) / (white - black);
    if (ig !== 1) { r = r > 0 ? Math.pow(r, ig) : r; g = g > 0 ? Math.pow(g, ig) : g; b = b > 0 ? Math.pow(b, ig) : b; }
    // highlights / shadows (luminance-weighted)
    let L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (hl || sh) {
      const lc = Math.min(1, Math.max(0, L));
      const delta = hl * 0.45 * lc * lc + sh * 0.45 * (1 - lc) * (1 - lc);
      r += delta; g += delta; b += delta;
    }
    r = (r - 0.5) * con + 0.5 + bri; g = (g - 0.5) * con + 0.5 + bri; b = (b - 0.5) * con + 0.5 + bri;
    L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (a.grayscale) { r = g = b = L; }
    else {
      let s = sat;
      if (vib) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); s *= 1 + vib * (1 - Math.min(1, (mx - mn) * 2)); }
      if (s !== 1) { r = L + (r - L) * s; g = L + (g - L) * s; b = L + (b - L) * s; }
    }
    if (vig) { const k = Math.hypot(xx - cx, y - cy) / maxd; const f = 1 - vig * k * k * 0.9; r *= f; g *= f; b *= f; }
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
  }
  if (a.sharpen > 0) sharpen(d, W, H, a.sharpen / 100);
  x.putImageData(id, 0, 0);
  return c;
}

function sharpen(d: Uint8ClampedArray, W: number, H: number, amt: number) {
  const s = amt * 1.4, o = new Uint8ClampedArray(d), r = W * 4;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) d[i + c] = o[i + c] * (1 + 4 * s) - s * (o[i + c - 4] + o[i + c + 4] + o[i + c - r] + o[i + c + r]);
  }
}
/** Edge-preserving smoothing: 3×3 neighbourhood mean, weighted by colour similarity (bilateral-lite). */
function denoise(d: Uint8ClampedArray, W: number, H: number, amt: number) {
  const o = new Uint8ClampedArray(d), sig = 8 + amt * 40, inv = 1 / (2 * sig * sig);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4;
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const j = i + (dy * W + dx) * 4;
      const dr = o[j] - o[i], dg = o[j + 1] - o[i + 1], db = o[j + 2] - o[i + 2];
      const w = Math.exp(-(dr * dr + dg * dg + db * db) * inv);
      sr += o[j] * w; sg += o[j + 1] * w; sb += o[j + 2] * w; sw += w;
    }
    d[i] = o[i] + (sr / sw - o[i]) * Math.min(1, amt * 1.5); d[i + 1] = o[i + 1] + (sg / sw - o[i + 1]) * Math.min(1, amt * 1.5); d[i + 2] = o[i + 2] + (sb / sw - o[i + 2]) * Math.min(1, amt * 1.5);
  }
}

// ------------------------------------------------------------------ geometry

export function rotateCanvas(d: HTMLCanvasElement, deg: number) {
  const r = (deg * Math.PI) / 180, sw = Math.abs(Math.sin(r)), cw = Math.abs(Math.cos(r));
  const c = mkCanvas(d.width * cw + d.height * sw, d.width * sw + d.height * cw), x = c.getContext("2d")!;
  x.translate(c.width / 2, c.height / 2); x.rotate(r); x.drawImage(d, -d.width / 2, -d.height / 2);
  return c;
}
/** Straighten: rotate by a small angle and crop to the largest axis-aligned rectangle with no empty corners. */
export function straighten(d: HTMLCanvasElement, deg: number) {
  const r = Math.abs((deg * Math.PI) / 180), W = d.width, H = d.height;
  const sin = Math.sin(r), cos = Math.cos(r);
  // largest rectangle of the same aspect ratio inside the rotated image
  const k = Math.min(W / (W * cos + H * sin), H / (W * sin + H * cos));
  const rot = rotateCanvas(d, deg), cw = W * k, ch = H * k;
  const c = mkCanvas(cw, ch); c.getContext("2d")!.drawImage(rot, (rot.width - cw) / 2, (rot.height - ch) / 2, cw, ch, 0, 0, c.width, c.height);
  return c;
}
export function flipCanvas(d: HTMLCanvasElement, dir: "h" | "v") {
  const c = mkCanvas(d.width, d.height), x = c.getContext("2d")!;
  if (dir === "h") { x.translate(d.width, 0); x.scale(-1, 1); } else { x.translate(0, d.height); x.scale(1, -1); }
  x.drawImage(d, 0, 0); return c;
}
/** High-quality resampling: successive halving then a final high-quality pass. */
export function resizeCanvas(d: HTMLCanvasElement, w: number, h: number) {
  let src = d;
  while (src.width / 2 >= w && src.height / 2 >= h) { const t = mkCanvas(src.width / 2, src.height / 2), tx = t.getContext("2d")!; tx.imageSmoothingQuality = "high"; tx.drawImage(src, 0, 0, t.width, t.height); src = t; }
  const c = mkCanvas(w, h), x = c.getContext("2d")!; x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
export function canvasSize(d: HTMLCanvasElement, w: number, h: number, anchor: { x: number; y: number }, fill: string | null) {
  const c = mkCanvas(w, h), x = c.getContext("2d")!;
  if (fill) { x.fillStyle = fill; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(d, Math.round((c.width - d.width) * anchor.x), Math.round((c.height - d.height) * anchor.y));
  return c;
}

// ------------------------------------------------------------------ reconstruction (watermark / object removal)

/** Multi-scale membrane interpolation: fills unknown pixels (M=1) smoothly from the known boundary. */
export function harmonicFill(chs: Float32Array[], M: Uint8Array, w: number, h: number) {
  const n = w * h; let any = false;
  for (let i = 0; i < n; i++) if (M[i]) { any = true; break; }
  if (!any) return;
  if (w <= 3 || h <= 3) {
    for (const ch of chs) { let s = 0, k = 0; for (let i = 0; i < n; i++) if (!M[i]) { s += ch[i]; k++; } const m = k ? s / k : 0; for (let i = 0; i < n; i++) if (M[i]) ch[i] = m; }
  } else {
    const w2 = (w + 1) >> 1, h2 = (h + 1) >> 1, n2 = w2 * h2;
    const c2 = chs.map(() => new Float32Array(n2)), cnt = new Uint8Array(n2), M2 = new Uint8Array(n2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (M[i]) continue; const j = (y >> 1) * w2 + (x >> 1); cnt[j]++; for (let c = 0; c < chs.length; c++) c2[c][j] += chs[c][i]; }
    for (let j = 0; j < n2; j++) { if (cnt[j]) for (let c = 0; c < chs.length; c++) c2[c][j] /= cnt[j]; else M2[j] = 1; }
    harmonicFill(c2, M2, w2, h2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!M[i]) continue; const j = (y >> 1) * w2 + (x >> 1); for (let c = 0; c < chs.length; c++) chs[c][i] = c2[c][j]; }
  }
  const unk: number[] = []; for (let i = 0; i < n; i++) if (M[i]) unk.push(i);
  for (let it = 0; it < 28; it++) for (const i of unk) {
    const x = i % w, y = (i / w) | 0;
    for (const ch of chs) { let s = 0, k = 0; if (x > 0) { s += ch[i - 1]; k++; } if (x < w - 1) { s += ch[i + 1]; k++; } if (y > 0) { s += ch[i - w]; k++; } if (y < h - 1) { s += ch[i + w]; k++; } ch[i] = s / k; }
  }
}
export function dilate(M: Uint8Array, w: number, h: number, r: number) {
  let a = M;
  for (let k = 0; k < r; k++) {
    const b = new Uint8Array(a);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (a[i]) continue; if ((x > 0 && a[i - 1]) || (x < w - 1 && a[i + 1]) || (y > 0 && a[i - w]) || (y < h - 1 && a[i + w])) b[i] = 1; }
    a = b;
  }
  return a;
}
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

function findOffset(px: Uint8ClampedArray, W: number, H: number, M: Uint8Array, x0: number, y0: number, rw: number, rh: number) {
  const near = dilate(M, rw, rh, 4), ring: number[] = [];
  for (let i = 0; i < M.length; i++) if (near[i] && !M[i]) ring.push(i);
  if (!ring.length) return null;
  const stepS = Math.max(1, Math.floor(ring.length / 500)), rs = ring.filter((_, i) => i % stepS === 0);
  const size = Math.max(rw, rh), R = Math.round(Math.max(size * 2.5, 48)), step = Math.max(1, Math.round(size / 12));
  let best = Infinity, bo: { ox: number; oy: number } | null = null;
  const test = (ox: number, oy: number) => {
    if (x0 + ox < 0 || y0 + oy < 0 || x0 + ox + rw > W || y0 + oy + rh > H) return;
    if (Math.abs(ox) < rw && Math.abs(oy) < rh) return;
    const pen = 1 + (0.25 * Math.hypot(ox, oy)) / R, lim = best / pen;
    let ssd = 0;
    for (const k of rs) {
      const x = k % rw, y = (k / rw) | 0, a = ((y0 + y) * W + x0 + x) * 4, b = a + (oy * W + ox) * 4;
      const dr = px[a] - px[b], dg = px[a + 1] - px[b + 1], db = px[a + 2] - px[b + 2];
      ssd += dr * dr + dg * dg + db * db; if (ssd > lim) return;
    }
    ssd *= pen; if (ssd < best) { best = ssd; bo = { ox, oy }; }
  };
  for (let oy = -R; oy <= R; oy += step) for (let ox = -R; ox <= R; ox += step) test(ox, oy);
  if (bo && step > 1) { const b0 = { ...(bo as { ox: number; oy: number }) }; for (let oy = b0.oy - step; oy <= b0.oy + step; oy++) for (let ox = b0.ox - step; ox <= b0.ox + step; ox++) test(ox, oy); }
  return bo as { ox: number; oy: number } | null;
}

export type RemoveMethod = "smart" | "smooth" | "blur" | "pixelate" | "clone";

/**
 * Reconstruct the masked area of `ctx`. "smart" = seamless patch clone from the best-matching nearby area
 * (texture-preserving). "smooth" = membrane fill + matched grain. Hidden content is never "recovered" —
 * the fill is synthesized from the surroundings.
 */
export function reconstruct(ctx: CanvasRenderingContext2D, W: number, H: number, mask: Uint8ClampedArray, method: "smart" | "smooth", cloneOffset?: { ox: number; oy: number }) {
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[(y * W + x) * 4 + 3] > 16) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (bx1 < 0) return false;
  const pad = 6, x0 = Math.max(0, bx0 - pad), y0 = Math.max(0, by0 - pad), x1 = Math.min(W - 1, bx1 + pad), y1 = Math.min(H - 1, by1 + pad);
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
  let M: Uint8Array = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) M[y * rw + x] = mask[((y0 + y) * W + x0 + x) * 4 + 3] > 16 ? 1 : 0;
  M = dilate(M, rw, rh, 2);
  const full = ctx.getImageData(0, 0, W, H), px = full.data;
  const off = cloneOffset ?? (method === "smart" ? findOffset(px, W, H, M, x0, y0, rw, rh) : null);
  const n = rw * rh, chs = [0, 1, 2].map(() => new Float32Array(n));
  const at = (x: number, y: number) => ((y0 + y) * W + x0 + x) * 4;
  if (off && x0 + off.ox >= 0 && y0 + off.oy >= 0 && x0 + off.ox + rw <= W && y0 + off.oy + rh <= H) {
    const so = (off.oy * W + off.ox) * 4;
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const i = y * rw + x, a = at(x, y); for (let c = 0; c < 3; c++) chs[c][i] = M[i] ? 0 : px[a + c] - px[a + so + c]; }
    harmonicFill(chs, M, rw, rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const i = y * rw + x; if (!M[i]) continue; const a = at(x, y); for (let c = 0; c < 3; c++) px[a + c] = px[a + so + c] + chs[c][i]; }
  } else {
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const i = y * rw + x, a = at(x, y); for (let c = 0; c < 3; c++) chs[c][i] = px[a + c]; }
    let s2 = 0, k = 0;
    for (let y = 1; y < rh - 1; y++) for (let x = 1; x < rw - 1; x++) {
      const i = y * rw + x; if (M[i] || M[i - 1] || M[i + 1] || M[i - rw] || M[i + rw]) continue;
      const g = chs[1], dd = g[i] - (g[i - 1] + g[i + 1] + g[i - rw] + g[i + rw]) / 4; s2 += dd * dd; k++;
    }
    const sigma = k ? Math.min(12, Math.sqrt(s2 / k) * 0.8) : 0;
    harmonicFill(chs, M, rw, rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const i = y * rw + x; if (!M[i]) continue; const a = at(x, y), g = sigma * gauss(); for (let c = 0; c < 3; c++) px[a + c] = chs[c][i] + g; }
  }
  ctx.putImageData(full, 0, 0, x0, y0, rw, rh);
  return true;
}
