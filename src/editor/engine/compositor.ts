// Renders one frame of a project. The same code drives the live preview and the export, so what you see is what
// you get (the preview just runs at a lower resolution and takes frames from <video> elements).
import { Adjust, ADJUST_KEYS, Clip, end, KeyProp, keyValue, MediaRef, nextAdjacent, Project, sourceTime, Track, US } from "../model";
import { animAt } from "./anim";
import { EffectDef, effectById, effectParams } from "./effects";
import { GL, hex, Target, Uniforms } from "./gl";
import { identityLut, lutData, LUT_N } from "./luts";
import * as S from "./shaders";
import { renderSticker, renderText } from "./text";
import { transitionById } from "./transitions";

export interface Frame { src: TexImageSource; w: number; h: number; rot?: number; ver?: string }
export interface FrameProvider {
  /** Frame of a video clip at source time `srcUs` (already resolved for reverse/stabilize). */
  video(c: Clip, m: MediaRef, srcUs: US): Frame | null;
  image(path: string): Frame | null;
  /** Background-removal matte for a clip (grayscale, same timing as the source). */
  matte?(c: Clip, m: MediaRef, srcUs: US): Frame | null;
  /** Called once per rendered frame so providers can release frames they no longer need. */
  endFrame?(): void;
}

const MASKS: Record<string, number> = { none: 0, linear: 1, mirror: 2, circle: 3, rect: 4, heart: 5, star: 6 };
const MIXBLUR = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D u_a, u_b; uniform vec2 u_size; uniform float u_mode, u_amt, u_pos;
void main(){ vec2 uv = gl_FragCoord.xy / u_size; vec4 a = texture(u_a, uv), b = texture(u_b, uv);
  if (u_mode < 0.5) o = mix(a, b, u_amt);
  else if (u_mode < 1.5) o = vec4(min(vec3(1.0), a.rgb + b.rgb * u_amt), min(1.0, a.a + b.a * u_amt));
  else o = mix(a, b, smoothstep(0.06, 0.32, abs(uv.y - u_pos)) * u_amt); }`;

export class Compositor {
  readonly gl: GL;
  private tex = new Map<string, { t: WebGLTexture; key: string; w: number; h: number }>();
  private luts = new Map<string, WebGLTexture>();
  private idLut: WebGLTexture;
  private yuvBuf: Uint8Array | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = new GL(canvas);
    this.idLut = this.gl.texture3D(LUT_N, identityLut());
  }

  private lut(id?: string | null): WebGLTexture | null {
    if (!id) return null;
    const hit = this.luts.get(id); if (hit) return hit;
    const d = lutData(id); if (!d) return null;
    const t = this.gl.texture3D(LUT_N, d); this.luts.set(id, t); return t;
  }
  dropLut(id: string) { const t = this.luts.get(id); if (t) { this.gl.gl.deleteTexture(t); this.luts.delete(id); } }

  /** Upload (or reuse) a texture for a cache key; `version` changes force a re-upload. */
  private texFor(key: string, version: string, f: Frame, mip: boolean) {
    let e = this.tex.get(key);
    if (!e) { e = { t: this.gl.texture(), key: "", w: 0, h: 0 }; this.tex.set(key, e); }
    if (e.key !== version) { const [w, h] = this.gl.upload(e.t, f.src, mip); e.w = w; e.h = h; e.key = version; }
    return e;
  }
  forget(prefix: string) { for (const [k, v] of this.tex) if (k.startsWith(prefix)) { this.gl.gl.deleteTexture(v.t); this.tex.delete(k); } }

  // ---------------------------------------------------------------- frame

  render(p: Project, t: US, src: FrameProvider, W: number, H: number): Target {
    const g = this.gl;
    let acc = g.target(W, H); g.clear(acc, [0, 0, 0, 1]);
    // canvas background behind the main track
    const main = p.tracks.find(tr => tr.main);
    const mc = main?.clips.find(c => c.start <= t && t < end(c));
    if (mc && !main!.hide) acc = this.background(p, mc, t, src, acc, W, H);
    for (let i = p.tracks.length - 1; i >= 0; i--) {
      const tr = p.tracks[i];
      if (tr.hide || tr.kind === "audio") continue;
      if (tr.kind === "effect" || tr.kind === "filter" || tr.kind === "adjust") {
        for (const c of tr.clips) if (c.start <= t && t < end(c)) acc = this.trackFx(tr, c, t, acc, W, H);
        continue;
      }
      acc = this.track(p, tr, t, src, acc, W, H);
    }
    src.endFrame?.();
    return acc;
  }

  private background(p: Project, c: Clip, t: US, src: FrameProvider, acc: Target, W: number, H: number): Target {
    const g = this.gl, bg = p.background;
    if (bg.type === "color") { g.run("solid", S.SOLID, acc, { u_color: hex(bg.color) }); return acc; }
    let f: Frame | null = null;
    if (bg.type === "image" && bg.image) f = src.image(bg.image);
    else if (c.type === "video" && c.media && p.media[c.media]) f = src.video(c, p.media[c.media], this.srcTime(p, c, t));
    else if (c.type === "image" && c.media && p.media[c.media]) f = src.image(this.mediaPath(p.media[c.media]));
    if (!f) return acc;
    const e = this.texFor(`bg:${c.id}`, `${f.ver ?? t}:${bg.type}`, f, false);
    const sw = Math.max(64, Math.round(W / 6)), sh = Math.max(64, Math.round(H / 6));
    const small = g.target(sw, sh), tmp = g.target(sw, sh);
    g.run("cover", S.COVER, small, { u_size: [sw, sh], u_srcSize: [e.w, e.h], i_rot: { i: f.rot ?? 0 } }, [{ name: "u_tex", tex: e.t }]);
    if (bg.type === "blur") {
      const r = Math.max(1, (bg.blur / 100) * 24);
      g.run("blur", S.BLUR, tmp, { u_size: [sw, sh], u_dir: [1, 0], u_radius: r }, [{ name: "u_tex", tex: small.tex }]);
      g.run("blur", S.BLUR, small, { u_size: [sw, sh], u_dir: [0, 1], u_radius: r }, [{ name: "u_tex", tex: tmp.tex }]);
    }
    g.run("copy", S.COPY, acc, { u_size: [W, H], u_opacity: 1 }, [{ name: "u_tex", tex: small.tex }]);
    g.release(small); g.release(tmp);
    return acc;
  }

  mediaPath(m: MediaRef) { return m.optimized && !m.playable ? m.optimized : m.path; }
  srcTime(p: Project, c: Clip, t: US): US {
    const m = c.media ? p.media[c.media] : undefined;
    const s = sourceTime(c, t);
    return Math.max(0, Math.min((m?.duration ?? s) - 1, s));
  }

  private track(p: Project, tr: Track, t: US, src: FrameProvider, acc: Target, W: number, H: number): Target {
    const g = this.gl;
    // transitions: window centred on the cut between adjacent clips
    for (const a of tr.clips) {
      if (!a.transition) continue;
      const b = nextAdjacent(tr, a); if (!b) continue;
      const d = a.transition.dur, cut = end(a);
      if (t >= cut - d / 2 && t < cut + d / 2) {
        const la = this.layer(p, a, t, src, W, H), lb = this.layer(p, b, t, src, W, H);
        const def = transitionById(a.transition.id);
        const out = g.target(W, H);
        if (def && la && lb) {
          const u: Uniforms = { u_size: [W, H], progress: (t - (cut - d / 2)) / d, ratio: W / H };
          for (const [k, prm] of Object.entries(def.params)) {
            if (prm.v === undefined) continue;
            u[k] = prm.type === "int" || prm.type === "bool" ? { i: Number(prm.v) } : prm.type.startsWith("ivec") ? { i: prm.v as number[] } : (prm.v as number | number[]);
          }
          try { g.run(`tr:${def.id}`, S.transitionShader(def.glsl), out, u, [{ name: "u_from", tex: la.tex }, { name: "u_to", tex: lb.tex }]); }
          catch (e) { console.warn("transition failed", def.id, e); g.run("copy", S.COPY, out, { u_size: [W, H], u_opacity: 1 }, [{ name: "u_tex", tex: (t < cut ? la : lb).tex }]); }
        } else {
          const one = la ?? lb; if (one) g.run("copy", S.COPY, out, { u_size: [W, H], u_opacity: 1 }, [{ name: "u_tex", tex: one.tex }]); else g.clear(out);
        }
        g.release(la); g.release(lb);
        return this.blend(acc, out, "normal", W, H);
      }
    }
    for (const c of tr.clips) {
      if (c.start > t || t >= end(c)) continue;
      const l = this.layer(p, c, t, src, W, H);
      if (l) acc = this.blend(acc, l, c.blend ?? "normal", W, H);
    }
    return acc;
  }

  private blend(acc: Target, layer: Target, mode: string, W: number, H: number): Target {
    const g = this.gl, out = g.target(W, H);
    g.run("blend", S.BLEND, out, { u_size: [W, H], i_mode: { i: Math.max(0, S.BLEND_MODES.indexOf(mode)) }, u_opacity: 1 }, [{ name: "u_dst", tex: acc.tex }, { name: "u_src", tex: layer.tex }]);
    g.release(acc); g.release(layer);
    return out;
  }

  /** Render one clip as a canvas-sized premultiplied layer (or null when nothing is visible/ready). */
  layer(p: Project, c: Clip, t: US, src: FrameProvider, W: number, H: number): Target | null {
    const g = this.gl;
    const local = Math.max(0, Math.min(c.dur, t - c.start));
    const k = (prop: KeyProp, base: number) => keyValue(c.keys?.[prop], local, base);
    const { s: an, char } = animAt(c, local);
    let f: Frame | null = null, ver = "", tkey = c.id, mip = false;
    let matte: Frame | null = null;
    const m = c.media ? p.media[c.media] : undefined;
    if (c.type === "video") {
      if (!m) return null;
      const st = this.srcTime(p, c, t);
      f = src.video(c, m, st); ver = f?.ver ?? `v${st}`;
      if (c.cutout && m.matte && src.matte) matte = src.matte(c, m, st);
    } else if (c.type === "image") {
      if (!m) return null;
      const path = this.mediaPath(m);
      f = src.image(path); tkey = `img:${path}`; ver = "1"; mip = true;
      if (c.cutout && m.matte) matte = src.image(m.matte);
    } else if (c.type === "text" || c.type === "caption") {
      if (!c.text) return null;
      const r = renderText(c.text, W, H, { words: c.words, local, char });
      f = { src: r.canvas, w: r.w, h: r.h }; ver = r.key;
    } else if (c.type === "sticker") {
      if (c.sticker?.media && p.media[c.sticker.media]) { f = src.image(this.mediaPath(p.media[c.sticker.media])); tkey = `img:${p.media[c.sticker.media].path}`; ver = "1"; mip = true; }
      else { const r = renderSticker(c.sticker ?? { emoji: "⭐" }, 512); f = { src: r.canvas, w: r.w, h: r.h }; ver = r.key; tkey = `stk:${r.key}`; mip = true; }
    } else if (c.type === "color") {
      const cv = new OffscreenCanvas(2, 2); const x = cv.getContext("2d")!; x.fillStyle = c.color ?? "#000000"; x.fillRect(0, 0, 2, 2);
      f = { src: cv, w: 2, h: 2 }; ver = c.color ?? ""; tkey = `col:${c.color}`;
    }
    if (!f) return null;
    const e = this.texFor(tkey, ver, f, mip);
    const rot = f.rot ?? 0;
    const sw = rot % 2 ? e.h : e.w, sh = rot % 2 ? e.w : e.h;
    const cr = c.crop ?? { l: 0, t: 0, r: 0, b: 0 };
    const cw = Math.max(1, sw * (1 - cr.l - cr.r)), ch = Math.max(1, sh * (1 - cr.t - cr.b));
    // base box: media fits the canvas; text keeps its raster size; stickers are 30% of the short side; colour fills
    let bw: number, bh: number;
    if (c.type === "text" || c.type === "caption") { bw = cw; bh = ch; }
    else if (c.type === "sticker") { const s = Math.min(W, H) * 0.3; bw = s * (cw / Math.max(cw, ch)); bh = s * (ch / Math.max(cw, ch)); }
    else if (c.type === "color") { bw = W; bh = H; }
    else { const fit = Math.min(W / cw, H / ch); bw = cw * fit; bh = ch * fit; }
    const tf = c.transform ?? { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false };
    const scale = k("scale", tf.scale) * an.scale;
    const sx = bw * scale * tf.scaleX * an.sx * (tf.flipH ? -1 : 1), sy = bh * scale * tf.scaleY * an.sy * (tf.flipV ? -1 : 1);
    if (Math.abs(sx) < 0.5 || Math.abs(sy) < 0.5) return null;
    const cx = W / 2 + (k("x", tf.x) + an.dx) * W, cy = H / 2 + (k("y", tf.y) + an.dy) * H;
    const th = ((k("rotation", tf.rotation) + an.rot) * Math.PI) / 180, a = Math.cos(th), b = Math.sin(th);
    const inv = [a / sx, -b / sy, 0, b / sx, a / sy, 0, -(a * cx + b * cy) / sx, (b * cx - a * cy) / sy, 1];
    const opacity = Math.max(0, Math.min(1, k("opacity", c.opacity ?? 1) * an.opacity));
    if (opacity <= 0.001) return null;
    // colour: per-clip adjust + keyed overrides
    const adj: Partial<Adjust> = { ...(c.adjust ?? {}) };
    for (const kp of ["brightness", "contrast", "saturation", "exposure", "temperature"] as const) if (c.keys?.[kp]?.length) adj[kp] = k(kp, adj[kp] ?? 0);
    const mk = c.mask && c.mask.shape !== "none" ? c.mask : null;
    const key = c.chroma?.on ? c.chroma : null;
    const lut = this.lut(c.filter?.id);
    const out = g.target(W, H);
    let me: { t: WebGLTexture } | null = null;
    if (matte) me = this.texFor(`matte:${c.id}`, ver, matte, false);
    g.run("layer", S.LAYER, out, {
      u_srcSize: [e.w, e.h], u_inv: inv, u_box: [Math.abs(sx), Math.abs(sy)], u_crop: [cr.l, cr.t, cr.r, cr.b], i_rot: { i: rot }, u_opacity: opacity,
      u_adj: adjUniform(adj, local / 1e6), u_lutAmt: lut ? Math.max(0, Math.min(1, (c.filter?.amount ?? 100) / 100)) : 0, u_sharpen: Math.max(0, (adj.sharpen ?? 0) / 100),
      u_key: key ? [...hex(key.color).slice(0, 3), 1] : [0, 0, 0, 0], u_keyP: key ? [key.strength / 100, key.shadow / 100] : [0, 0],
      i_mask: { i: mk ? MASKS[mk.shape] ?? 0 : 0 }, u_mask: mk ? [mk.x, mk.y, mk.w, mk.h] : [0, 0, 1, 1], u_maskP: mk ? [(mk.rotation * Math.PI) / 180, Math.max(0.0005, mk.feather / 100 * 0.25), mk.invert ? 1 : 0, mk.round / 100] : [0, 0, 0, 0],
      u_reveal: an.reveal, u_useMatte: me ? 1 : 0,
    }, [{ name: "u_src", tex: e.t }, { name: "u_lut", tex: lut ?? this.idLut, target: g.gl.TEXTURE_3D }, { name: "u_matte", tex: me?.t ?? e.t }]);
    let res = out;
    const blur = k("blur", 0) + an.blur;
    if (blur > 0.3) res = this.blurPass(res, (blur * Math.min(W, H)) / 1080, W, H);
    for (const fx of c.effects ?? []) { const d = effectById(fx.id); if (d) res = this.effect(d, fx.params, res, local, c.dur, W, H); }
    return res;
  }

  private blurPass(src: Target, r: number, W: number, H: number): Target {
    const g = this.gl, tmp = g.target(W, H), out = g.target(W, H);
    g.run("blur", S.BLUR, tmp, { u_size: [W, H], u_dir: [1, 0], u_radius: r }, [{ name: "u_tex", tex: src.tex }]);
    g.run("blur", S.BLUR, out, { u_size: [W, H], u_dir: [0, 1], u_radius: r }, [{ name: "u_tex", tex: tmp.tex }]);
    g.release(tmp); g.release(src);
    return out;
  }

  effect(d: EffectDef, params: Record<string, number> | undefined, src: Target, local: US, dur: US, W: number, H: number): Target {
    const g = this.gl, pv = effectParams(d, params), sc = Math.min(W, H) / 1080;
    if (d.passes === "blur") return this.blurPass(src, pv[0] * sc, W, H);
    if (d.passes) {
      const keep = g.target(W, H);
      g.run("copy", S.COPY, keep, { u_size: [W, H], u_opacity: 1 }, [{ name: "u_tex", tex: src.tex }]);
      const bl = this.blurPass(src, (d.passes === "glow" ? pv[1] : d.passes === "soft" ? 10 : 14) * sc, W, H);
      const out = g.target(W, H);
      const mode = d.passes === "glow" ? 1 : d.passes === "tilt" ? 2 : 0;
      g.run("mixblur", MIXBLUR, out, { u_size: [W, H], u_mode: mode, u_amt: d.passes === "soft" ? pv[0] * 0.6 : pv[0], u_pos: pv[1] }, [{ name: "u_a", tex: keep.tex }, { name: "u_b", tex: bl.tex }]);
      g.release(keep); g.release(bl);
      return out;
    }
    const out = g.target(W, H);
    try {
      g.run(`fx:${d.id}`, S.effectShader(d.glsl), out, { u_size: [W, H], u_time: local / 1e6, u_prog: Math.max(0, Math.min(1, local / Math.max(1, dur))), u_amount: 1, u_p: pv }, [{ name: "u_tex", tex: src.tex }]);
    } catch (e) { console.warn("effect failed", d.id, e); g.run("copy", S.COPY, out, { u_size: [W, H], u_opacity: 1 }, [{ name: "u_tex", tex: src.tex }]); }
    g.release(src);
    return out;
  }

  private trackFx(tr: Track, c: Clip, t: US, acc: Target, W: number, H: number): Target {
    const g = this.gl, local = t - c.start;
    if (tr.kind === "effect" && c.effect) { const d = effectById(c.effect.id); return d ? this.effect(d, c.effect.params, acc, local, c.dur, W, H) : acc; }
    const out = g.target(W, H);
    if (tr.kind === "filter" && c.filter) {
      const lut = this.lut(c.filter.id); if (!lut) { g.release(out); return acc; }
      g.run("grade", S.GRADE, out, { u_size: [W, H], u_adj: adjUniform({}, 0), u_lutAmt: Math.max(0, Math.min(1, c.filter.amount / 100)), u_amount: 1 }, [{ name: "u_tex", tex: acc.tex }, { name: "u_lut", tex: lut, target: g.gl.TEXTURE_3D }]);
    } else if (tr.kind === "adjust") {
      const adj: Partial<Adjust> = { ...(c.adjust ?? {}) };
      for (const kp of ["brightness", "contrast", "saturation", "exposure", "temperature"] as const) if (c.keys?.[kp]?.length) adj[kp] = keyValue(c.keys[kp], local, adj[kp] ?? 0);
      g.run("grade", S.GRADE, out, { u_size: [W, H], u_adj: adjUniform(adj, local / 1e6), u_lutAmt: 0, u_amount: 1 }, [{ name: "u_tex", tex: acc.tex }, { name: "u_lut", tex: this.idLut, target: g.gl.TEXTURE_3D }]);
    } else { g.release(out); return acc; }
    g.release(acc);
    return out;
  }

  // ---------------------------------------------------------------- output

  present(t: Target, cw: number, ch: number) {
    const g = this.gl;
    g.run("present", S.PRESENT, null, {}, [{ name: "u_tex", tex: t.tex }], [cw, ch]);
  }

  /** Convert to planar YUV 4:2:0 (BT.709 limited) on the GPU and read it back. W must be a multiple of 8. */
  readYUV(t: Target, W: number, H: number, into?: Uint8Array): Uint8Array {
    const g = this.gl, size = (W * H * 3) / 2;
    if (!into && (!this.yuvBuf || this.yuvBuf.length !== size)) this.yuvBuf = new Uint8Array(size);
    const buf = into ?? this.yuvBuf!;
    const ty = g.target(W / 4, H), tu = g.target(W / 8, H / 2), tv = g.target(W / 8, H / 2);
    g.run("yuvY", S.YUV_Y, ty, { u_size: [W, H] }, [{ name: "u_tex", tex: t.tex }]);
    g.run("yuvUV", S.YUV_UV, tu, { u_size: [W, H], u_v: 0 }, [{ name: "u_tex", tex: t.tex }]);
    g.run("yuvUV", S.YUV_UV, tv, { u_size: [W, H], u_v: 1 }, [{ name: "u_tex", tex: t.tex }]);
    g.readInto(ty, W / 4, H, buf.subarray(0, W * H));
    g.readInto(tu, W / 8, H / 2, buf.subarray(W * H, W * H + (W * H) / 4));
    g.readInto(tv, W / 8, H / 2, buf.subarray(W * H + (W * H) / 4));
    g.release(ty); g.release(tu); g.release(tv);
    return buf;
  }
  readGray(t: Target, W: number, H: number): Uint8Array {
    const g = this.gl, buf = new Uint8Array(W * H), ty = g.target(W / 4, H);
    g.run("gray", S.GRAY, ty, { u_size: [W, H] }, [{ name: "u_tex", tex: t.tex }]);
    g.readInto(ty, W / 4, H, buf); g.release(ty);
    return buf;
  }
  release(t: Target) { this.gl.release(t); }
  dispose() { for (const v of this.tex.values()) this.gl.gl.deleteTexture(v.t); this.tex.clear(); for (const t of this.luts.values()) this.gl.gl.deleteTexture(t); this.gl.dispose(); }
}

export function adjUniform(a: Partial<Adjust>, time: number): Float32Array {
  const v = (k: keyof Adjust) => (a[k] ?? 0) / 100;
  return new Float32Array([v("exposure"), v("brightness"), v("contrast"), v("saturation"), v("vibrance"), v("temperature"), v("tint"), v("highlights"), v("shadows"), v("hue"), v("sharpen"), v("vignette"), v("grain"), v("fade"), time, 0]);
}
export const hasAdjust = (a?: Partial<Adjust>) => !!a && ADJUST_KEYS.some(k => (a[k] ?? 0) !== 0);
