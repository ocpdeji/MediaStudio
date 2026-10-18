// Video effects (GLSL). Each body implements `vec4 effect(vec2 uv)`; helpers: pick(), noise(), hash(), luma(),
// u_time (seconds into the clip), u_prog (0..1 through the clip), u_size (px), u_p[0..1] (parameters).
// Parameters are listed per effect and map in order to u_p[0].x, .y, .z, .w, u_p[1].x …

export interface EffectParam { key: string; label: string; min: number; max: number; def: number; step?: number }
export interface EffectDef { id: string; name: string; cat: string; glsl: string; params: EffectParam[]; passes?: "blur" | "glow" | "tilt" | "soft" }

const P = (key: string, label: string, min: number, max: number, def: number, step?: number): EffectParam => ({ key, label, min, max, def, step });
const SPEED = P("speed", "Speed", 0.1, 4, 1, 0.1);
const STR = P("strength", "Strength", 0, 1, 0.6, 0.01);

export const EFFECT_CATS = ["Basic", "Retro", "Party", "Dream", "Distort", "Lens", "Weather", "Light", "Split"];

export const EFFECTS: EffectDef[] = [
  // ---------------- Basic
  { id: "blur", name: "Blur", cat: "Basic", passes: "blur", params: [P("radius", "Radius", 1, 60, 16, 1)], glsl: `vec4 effect(vec2 uv){ return pick(uv); }` },
  { id: "zoomBlur", name: "Zoom blur", cat: "Basic", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 c = vec2(0.5); vec4 a = vec4(0.0); float s = u_p[0].x * 0.15;
    for (int i = 0; i < 24; i++) { float t = float(i) / 23.0; a += pick(c + (uv - c) * (1.0 - s * t)); } return a / 24.0; }` },
  { id: "motionBlur", name: "Motion blur", cat: "Basic", params: [STR, P("angle", "Angle", 0, 360, 0, 1)], glsl: `vec4 effect(vec2 uv){ float a = radians(u_p[0].y); vec2 d = vec2(cos(a), sin(a)) * u_p[0].x * 0.04; vec4 acc = vec4(0.0);
    for (int i = 0; i < 24; i++) { acc += pick(uv + d * (float(i) / 23.0 - 0.5)); } return acc / 24.0; }` },
  { id: "shake", name: "Shake", cat: "Basic", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ float t = u_time * 18.0 * u_p[0].y; vec2 o = (vec2(noise(vec2(t, 1.7)), noise(vec2(3.1, t))) - 0.5) * 0.06 * u_p[0].x;
    vec2 p = (uv - 0.5) * (1.0 - 0.06 * u_p[0].x) + 0.5 + o; return pick(p); }` },
  { id: "zoomPulse", name: "Zoom pulse", cat: "Basic", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ float z = 1.0 + 0.08 * u_p[0].x * (0.5 + 0.5 * sin(u_time * 6.28 * u_p[0].y)); return pick((uv - 0.5) / z + 0.5); }` },
  { id: "flash", name: "Flash", cat: "Basic", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float f = pow(max(0.0, sin(u_time * 6.28 * u_p[0].y)), 8.0) * u_p[0].x; return vec4(mix(c.rgb, vec3(c.a), f), c.a); }` },
  { id: "blackFlash", name: "Black flash", cat: "Basic", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float f = pow(max(0.0, sin(u_time * 6.28 * u_p[0].y)), 6.0) * u_p[0].x; return vec4(c.rgb * (1.0 - f), c.a); }` },
  { id: "fadeWhite", name: "White fade in", cat: "Basic", params: [P("dur", "Length", 0.05, 1, 0.3, 0.05)], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float f = 1.0 - smoothstep(0.0, u_p[0].x, u_prog); return vec4(mix(c.rgb, vec3(c.a), f), c.a); }` },
  { id: "fadeBlack", name: "Black fade out", cat: "Basic", params: [P("dur", "Length", 0.05, 1, 0.3, 0.05)], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float f = smoothstep(1.0 - u_p[0].x, 1.0, u_prog); return vec4(c.rgb * (1.0 - f), c.a); }` },
  { id: "pixelate", name: "Pixelate", cat: "Basic", params: [P("size", "Block size", 2, 80, 18, 1)], glsl: `vec4 effect(vec2 uv){ vec2 b = u_p[0].x / u_size; return pick((floor(uv / b) + 0.5) * b); }` },
  { id: "vignette", name: "Vignette", cat: "Basic", params: [STR], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float v = 1.0 - smoothstep(0.3, 0.9, length((uv - 0.5) * vec2(1.2, 1.0))) * u_p[0].x; return vec4(c.rgb * v, c.a); }` },
  { id: "letterbox", name: "Cinematic bars", cat: "Basic", params: [P("size", "Bar size", 0.02, 0.3, 0.12, 0.01)], glsl: `vec4 effect(vec2 uv){ float s = u_p[0].x * smoothstep(0.0, 0.15, u_prog); vec4 c = pick(uv); return (uv.y < s || uv.y > 1.0 - s) ? vec4(0, 0, 0, 1) : c; }` },
  // ---------------- Split
  { id: "mirror", name: "Mirror", cat: "Split", params: [], glsl: `vec4 effect(vec2 uv){ return pick(vec2(uv.x > 0.5 ? 1.0 - uv.x : uv.x, uv.y)); }` },
  { id: "mirrorV", name: "Mirror vertical", cat: "Split", params: [], glsl: `vec4 effect(vec2 uv){ return pick(vec2(uv.x, uv.y > 0.5 ? 1.0 - uv.y : uv.y)); }` },
  { id: "split2", name: "Split 2", cat: "Split", params: [], glsl: `vec4 effect(vec2 uv){ return pick(vec2(uv.x, fract(uv.y * 2.0) * 0.5 + 0.25)); }` },
  { id: "split3", name: "Split 3", cat: "Split", params: [], glsl: `vec4 effect(vec2 uv){ return pick(vec2(uv.x, fract(uv.y * 3.0) / 3.0 + 1.0 / 3.0)); }` },
  { id: "split4", name: "Split 4", cat: "Split", params: [], glsl: `vec4 effect(vec2 uv){ return pickWrap(uv * 2.0); }` },
  { id: "split9", name: "Split 9", cat: "Split", params: [], glsl: `vec4 effect(vec2 uv){ return pickWrap(uv * 3.0); }` },
  { id: "kaleido", name: "Kaleidoscope", cat: "Split", params: [P("seg", "Segments", 3, 16, 6, 1), SPEED], glsl: `vec4 effect(vec2 uv){ vec2 p = uv - 0.5; p.x *= u_size.x / u_size.y; float r = length(p); float a = atan(p.y, p.x) + u_time * 0.3 * u_p[0].y;
    float s = 6.28318 / u_p[0].x; a = mod(a, s); a = abs(a - s * 0.5); p = vec2(cos(a), sin(a)) * r; p.x /= u_size.x / u_size.y; return pick(p + 0.5); }` },
  // ---------------- Retro
  { id: "vhs", name: "VHS", cat: "Retro", params: [STR], glsl: `vec4 effect(vec2 uv){ float s = u_p[0].x; float line = floor(uv.y * u_size.y / 3.0); float j = (hash(vec2(line, floor(u_time * 24.0))) - 0.5) * 0.012 * s;
    j += step(0.985, hash(vec2(floor(u_time * 8.0), 2.0))) * sin(uv.y * 40.0 + u_time * 10.0) * 0.02 * s;
    vec2 p = uv + vec2(j, 0.0); float r = pick(p + vec2(0.004 * s, 0.0)).r, g = pick(p).g, b = pick(p - vec2(0.004 * s, 0.0)).b;
    vec3 c = vec3(r, g, b) * (0.9 + 0.1 * sin(uv.y * u_size.y * 1.5)); c += (hash(uv * u_size + u_time) - 0.5) * 0.12 * s; c = mix(c, c * vec3(1.05, 0.98, 1.08), s);
    return vec4(c, pick(uv).a); }` },
  { id: "oldFilm", name: "Old film", cat: "Retro", params: [STR], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float l = luma(c.rgb); vec3 sep = vec3(l) * vec3(1.07, 0.95, 0.78);
    float fl = 0.92 + 0.08 * noise(vec2(u_time * 18.0, 0.0)); float scratch = step(0.997, hash(vec2(floor(uv.x * 400.0), floor(u_time * 12.0)))) * 0.4;
    float gr = (hash(uv * u_size + floor(u_time * 24.0)) - 0.5) * 0.18; float v = 1.0 - smoothstep(0.35, 0.85, length(uv - 0.5));
    vec3 o = (sep * fl + gr + scratch) * v; return vec4(mix(c.rgb, o, u_p[0].x), c.a); }` },
  { id: "crt", name: "CRT", cat: "Retro", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 p = uv * 2.0 - 1.0; p *= 1.0 + 0.08 * u_p[0].x * dot(p, p); p = p * 0.5 + 0.5;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return vec4(0, 0, 0, 1); vec3 c = pick(p).rgb; c *= 0.85 + 0.15 * sin(p.y * u_size.y * 3.14159);
    c *= 1.0 - smoothstep(0.6, 1.1, length(uv - 0.5) * 1.4); return vec4(c, 1.0); }` },
  { id: "scanlines", name: "Scanlines", cat: "Retro", params: [STR], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float s = 0.5 + 0.5 * sin(uv.y * u_size.y * 1.6 - u_time * 6.0); return vec4(c.rgb * (1.0 - s * 0.35 * u_p[0].x), c.a); }` },
  { id: "sepia", name: "Sepia", cat: "Retro", params: [STR], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); vec3 s = vec3(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131))); return vec4(mix(c.rgb, min(s, vec3(c.a)), u_p[0].x), c.a); }` },
  { id: "bw", name: "Black & white", cat: "Retro", params: [P("contrast", "Contrast", 0, 1, 0.4, 0.01)], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float l = luma(c.rgb); l = (l - 0.5 * c.a) * (1.0 + u_p[0].x) + 0.5 * c.a; return vec4(vec3(clamp(l, 0.0, c.a)), c.a); }` },
  { id: "eightBit", name: "8-bit", cat: "Retro", params: [P("size", "Pixel size", 2, 40, 8, 1)], glsl: `vec4 effect(vec2 uv){ vec2 b = u_p[0].x / u_size; vec4 c = pick((floor(uv / b) + 0.5) * b); return vec4(floor(c.rgb * 5.0 + 0.5) / 5.0, c.a); }` },
  { id: "grain", name: "Film grain", cat: "Retro", params: [STR], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float g = (hash(uv * u_size + fract(u_time * 7.13) * 100.0) - 0.5) * 0.35 * u_p[0].x; return vec4(clamp(c.rgb + g * c.a, 0.0, 1.0), c.a); }` },
  // ---------------- Party
  { id: "rgbSplit", name: "RGB split", cat: "Party", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ float o = 0.012 * u_p[0].x * (0.6 + 0.4 * sin(u_time * 5.0 * u_p[0].y)); return vec4(pick(uv + vec2(o, 0)).r, pick(uv).g, pick(uv - vec2(o, 0)).b, pick(uv).a); }` },
  { id: "glitch", name: "Glitch", cat: "Party", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ float t = floor(u_time * 14.0 * u_p[0].y); float band = floor(uv.y * 18.0); float on = step(0.75, hash(vec2(band, t)));
    vec2 p = uv + vec2((hash(vec2(t, band)) - 0.5) * 0.12 * u_p[0].x * on, 0.0); float o = 0.01 * u_p[0].x * on;
    vec4 c = vec4(pick(p + vec2(o, 0)).r, pick(p).g, pick(p - vec2(o, 0)).b, pick(p).a);
    if (hash(vec2(t, 9.0)) > 0.9) c.rgb = c.a - c.rgb; return c; }` },
  { id: "strobe", name: "Strobe", cat: "Party", params: [SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); return mod(floor(u_time * 12.0 * u_p[0].x), 2.0) > 0.5 ? vec4(min(c.rgb * 1.8, vec3(c.a)), c.a) : vec4(c.rgb * 0.6, c.a); }` },
  { id: "colorCycle", name: "Color cycle", cat: "Party", params: [SPEED], glsl: `vec3 h(vec3 c, float a){ const vec3 k = vec3(0.57735); float ca = cos(a); return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca); }
    vec4 effect(vec2 uv){ vec4 c = pick(uv); return vec4(clamp(h(c.rgb, u_time * 2.0 * u_p[0].x), 0.0, c.a), c.a); }` },
  { id: "neon", name: "Neon edges", cat: "Party", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec2 px = 1.0 / u_size; float gx = luma(pick(uv + vec2(px.x, 0)).rgb) - luma(pick(uv - vec2(px.x, 0)).rgb); float gy = luma(pick(uv + vec2(0, px.y)).rgb) - luma(pick(uv - vec2(0, px.y)).rgb);
    float e = clamp(length(vec2(gx, gy)) * 6.0, 0.0, 1.0); vec3 col = 0.5 + 0.5 * cos(u_time * u_p[0].y * 2.0 + uv.xyx * 4.0 + vec3(0, 2, 4)); vec4 c = pick(uv);
    return vec4(mix(c.rgb * (1.0 - u_p[0].x * 0.8), col, e), c.a); }` },
  { id: "rainbow", name: "Rainbow sweep", cat: "Party", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); vec3 r = 0.5 + 0.5 * cos(6.28 * (uv.x + uv.y * 0.5 - u_time * 0.3 * u_p[0].y) + vec3(0, 2.09, 4.18)); return vec4(mix(c.rgb, (1.0 - (1.0 - c.rgb) * (1.0 - r * c.a)), u_p[0].x * 0.6), c.a); }` },
  { id: "invert", name: "Invert", cat: "Party", params: [], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); return vec4(c.a - c.rgb, c.a); }` },
  { id: "posterize", name: "Posterize", cat: "Party", params: [P("levels", "Levels", 2, 12, 4, 1)], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); return vec4(floor(c.rgb * u_p[0].x + 0.5) / u_p[0].x, c.a); }` },
  // ---------------- Dream
  { id: "glow", name: "Glow", cat: "Dream", passes: "glow", params: [STR, P("radius", "Radius", 2, 40, 14, 1)], glsl: `vec4 effect(vec2 uv){ return pick(uv); }` },
  { id: "softFocus", name: "Soft focus", cat: "Dream", passes: "soft", params: [STR], glsl: `vec4 effect(vec2 uv){ return pick(uv); }` },
  { id: "haze", name: "Dreamy haze", cat: "Dream", params: [STR], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); vec3 b = (pick(uv + vec2(0.004, 0.0)).rgb + pick(uv - vec2(0.004, 0.0)).rgb + pick(uv + vec2(0, 0.006)).rgb + pick(uv - vec2(0, 0.006)).rgb) * 0.25;
    vec3 h = 1.0 - (1.0 - c.rgb) * (1.0 - b * 0.6); h = mix(vec3(luma(h)), h, 0.75) * vec3(1.05, 0.97, 1.04) + 0.04; return vec4(mix(c.rgb, min(h, vec3(c.a)), u_p[0].x), c.a); }` },
  { id: "lightLeak", name: "Light leak", cat: "Dream", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float t = u_time * 0.4 * u_p[0].y;
    vec2 a = vec2(0.15 + 0.3 * sin(t), 0.2 + 0.2 * cos(t * 1.3)), b = vec2(0.85 - 0.25 * cos(t * 0.7), 0.75 + 0.2 * sin(t * 0.9));
    vec3 l = vec3(1.0, 0.55, 0.2) * exp(-6.0 * length(uv - a)) + vec3(1.0, 0.3, 0.45) * exp(-7.0 * length(uv - b));
    return vec4(min(vec3(c.a), 1.0 - (1.0 - c.rgb) * (1.0 - l * u_p[0].x)), c.a); }` },
  { id: "sparkle", name: "Sparkles", cat: "Dream", params: [STR, P("density", "Density", 5, 60, 25, 1)], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); vec2 g = uv * vec2(u_size.x / u_size.y, 1.0) * u_p[0].y; vec2 id = floor(g), f = fract(g) - 0.5;
    vec2 o = vec2(hash(id), hash(id + 7.0)) - 0.5; float tw = pow(0.5 + 0.5 * sin(u_time * 6.0 + hash(id + 3.0) * 60.0), 6.0);
    vec2 d = abs(f - o * 0.7); float s = (0.002 / (d.x * d.y + 0.001)) * 0.02 + 0.015 / (length(f - o * 0.7) + 0.02) * 0.02; s *= tw * step(0.55, hash(id + 1.3));
    return vec4(min(c.rgb + vec3(1.0, 0.95, 0.85) * s * u_p[0].x, vec3(max(c.a, s))), max(c.a, min(1.0, s))); }` },
  { id: "bokeh", name: "Bokeh", cat: "Dream", params: [STR], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); vec3 add = vec3(0.0); vec2 ar = vec2(u_size.x / u_size.y, 1.0);
    for (int i = 0; i < 14; i++) { float fi = float(i); vec2 p = vec2(hash(vec2(fi, 1.0)), fract(hash(vec2(fi, 2.0)) - u_time * 0.03 * (0.5 + hash(vec2(fi, 3.0)))));
      float r = 0.03 + 0.06 * hash(vec2(fi, 4.0)); float d = length((uv - p) * ar); add += (0.5 + 0.5 * cos(fi + vec3(0, 2, 4))) * smoothstep(r, r * 0.8, d) * 0.25; }
    return vec4(min(vec3(c.a), c.rgb + add * u_p[0].x), c.a); }` },
  // ---------------- Distort
  { id: "wave", name: "Wave", cat: "Distort", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ return pick(uv + vec2(sin(uv.y * 18.0 + u_time * 4.0 * u_p[0].y), cos(uv.x * 14.0 + u_time * 3.0 * u_p[0].y)) * 0.012 * u_p[0].x); }` },
  { id: "swirl", name: "Swirl", cat: "Distort", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 p = uv - 0.5; float r = length(p); float a = u_p[0].x * 4.0 * max(0.0, 0.5 - r) * (0.5 + 0.5 * sin(u_time)); float s = sin(a), c = cos(a); return pick(vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5); }` },
  { id: "fisheye", name: "Fisheye", cat: "Distort", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 p = uv * 2.0 - 1.0; float r = length(p); float k = u_p[0].x * 0.6; vec2 q = p * (1.0 - k + k * r * r); return pick(q * 0.5 + 0.5); }` },
  { id: "ripple", name: "Water ripple", cat: "Distort", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec2 p = uv - 0.5; float r = length(p); vec2 d = p / max(r, 1e-4) * sin(r * 60.0 - u_time * 8.0 * u_p[0].y) * 0.006 * u_p[0].x; return pick(uv + d); }` },
  { id: "pinch", name: "Pinch", cat: "Distort", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 p = uv - 0.5; float r = length(p); float k = 1.0 - u_p[0].x * 0.5 * smoothstep(0.5, 0.0, r); return pick(p * k + 0.5); }` },
  { id: "heat", name: "Heat haze", cat: "Distort", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 d = vec2(noise(uv * 18.0 + vec2(0, u_time * 2.0)), noise(uv * 18.0 + vec2(4.0, u_time * 2.3))) - 0.5; return pick(uv + d * 0.012 * u_p[0].x); }` },
  { id: "wobble", name: "Jelly", cat: "Distort", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec2 p = uv - 0.5; float t = u_time * 6.0 * u_p[0].y; p *= vec2(1.0 + sin(t) * 0.04 * u_p[0].x, 1.0 - sin(t) * 0.04 * u_p[0].x); p.x += sin(p.y * 10.0 + t) * 0.01 * u_p[0].x; return pick(p + 0.5); }` },
  // ---------------- Lens
  { id: "chroma", name: "Chromatic aberration", cat: "Lens", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 d = (uv - 0.5) * 0.02 * u_p[0].x; return vec4(pick(uv + d).r, pick(uv).g, pick(uv - d).b, pick(uv).a); }` },
  { id: "tiltShift", name: "Tilt-shift", cat: "Lens", passes: "tilt", params: [STR, P("pos", "Focus position", 0, 1, 0.5, 0.01)], glsl: `vec4 effect(vec2 uv){ return pick(uv); }` },
  { id: "flare", name: "Lens flare", cat: "Lens", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); vec2 ar = vec2(u_size.x / u_size.y, 1.0); vec2 l = vec2(0.2 + 0.6 * (0.5 + 0.5 * sin(u_time * 0.5 * u_p[0].y)), 0.25);
    vec2 d = (uv - l) * ar; float f = 0.02 / (length(d) + 0.02) + 0.004 / (abs(d.y) + 0.004) * smoothstep(0.6, 0.0, abs(d.x)) * 0.4;
    vec2 g = (0.5 - l) * 2.0; float ghost = smoothstep(0.06, 0.0, length((uv - (l + g * 0.6)) * ar)) * 0.3 + smoothstep(0.03, 0.0, length((uv - (l + g * 0.9)) * ar)) * 0.4;
    vec3 add = vec3(1.0, 0.85, 0.6) * f + vec3(0.6, 0.8, 1.0) * ghost; return vec4(min(vec3(c.a), c.rgb + add * u_p[0].x), c.a); }` },
  { id: "sketch", name: "Pencil sketch", cat: "Lens", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 px = 1.0 / u_size; float gx = luma(pick(uv + vec2(px.x, 0)).rgb) - luma(pick(uv - vec2(px.x, 0)).rgb); float gy = luma(pick(uv + vec2(0, px.y)).rgb) - luma(pick(uv - vec2(0, px.y)).rgb);
    float e = 1.0 - clamp(length(vec2(gx, gy)) * 4.0 * (0.5 + u_p[0].x), 0.0, 1.0); vec4 c = pick(uv); return vec4(vec3(e) * c.a, c.a); }` },
  { id: "cartoon", name: "Cartoon", cat: "Lens", params: [STR], glsl: `vec4 effect(vec2 uv){ vec2 px = 1.0 / u_size; vec4 c = pick(uv); float gx = luma(pick(uv + vec2(px.x, 0)).rgb) - luma(pick(uv - vec2(px.x, 0)).rgb); float gy = luma(pick(uv + vec2(0, px.y)).rgb) - luma(pick(uv - vec2(0, px.y)).rgb);
    float e = smoothstep(0.08, 0.2, length(vec2(gx, gy)) * u_p[0].x * 2.0); vec3 q = floor(c.rgb * 6.0 + 0.5) / 6.0; return vec4(q * (1.0 - e), c.a); }` },
  { id: "halftone", name: "Comic dots", cat: "Lens", params: [P("size", "Dot size", 3, 30, 9, 1)], glsl: `vec4 effect(vec2 uv){ vec2 g = uv * u_size / u_p[0].x; vec2 f = fract(g) - 0.5; vec4 c = pick((floor(g) + 0.5) * u_p[0].x / u_size);
    float r = sqrt(1.0 - luma(c.rgb)) * 0.6; float d = smoothstep(r, r - 0.08, length(f)); return vec4(mix(vec3(1.0), c.rgb * 1.2, d) * c.a, c.a); }` },
  // ---------------- Weather
  { id: "rain", name: "Rain", cat: "Weather", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); vec2 g = vec2(uv.x * 120.0, uv.y * 4.0 + u_time * 6.0 * u_p[0].y); vec2 id = floor(g); float r = hash(vec2(id.x, 3.0));
    float y = fract(g.y + r * 10.0); float drop = smoothstep(0.0, 0.05, y) * smoothstep(0.35, 0.05, y) * step(0.6, hash(vec2(id.x, floor(g.y + r * 10.0)))) * smoothstep(0.5, 0.0, abs(fract(g.x) - 0.5));
    vec3 o = mix(c.rgb, c.rgb * 0.85 + 0.05, u_p[0].x * 0.6) + drop * 0.35 * u_p[0].x; return vec4(min(o, vec3(c.a)), c.a); }` },
  { id: "snow", name: "Snow", cat: "Weather", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float s = 0.0; vec2 ar = vec2(u_size.x / u_size.y, 1.0);
    for (int L = 0; L < 3; L++) { float fl = float(L); float sc = 10.0 + fl * 12.0; vec2 g = uv * ar * sc + vec2(sin(u_time * 0.5 + fl) * 0.5, -u_time * (0.8 + fl * 0.4) * u_p[0].y);
      vec2 id = floor(g), f = fract(g) - 0.5; vec2 o = vec2(hash(id + fl), hash(id + fl + 9.0)) - 0.5; s += smoothstep(0.08 - fl * 0.02, 0.0, length(f - o * 0.6)) * step(0.4, hash(id + 2.0 + fl)); }
    return vec4(min(vec3(c.a + s), c.rgb + s * u_p[0].x), min(1.0, c.a + s * u_p[0].x)); }` },
  { id: "fog", name: "Fog", cat: "Weather", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float n = noise(uv * 3.0 + vec2(u_time * 0.08 * u_p[0].y, 0.0)) * 0.6 + noise(uv * 7.0 - vec2(u_time * 0.05, 0.0)) * 0.4;
    return vec4(mix(c.rgb, vec3(0.85) * c.a, n * u_p[0].x * 0.75), c.a); }` },
  // ---------------- Light
  { id: "sweep", name: "Light sweep", cat: "Light", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float x = fract(u_time * 0.35 * u_p[0].y) * 2.0 - 0.5; float d = abs(uv.x + uv.y * 0.4 - x); float b = smoothstep(0.08, 0.0, d) * u_p[0].x;
    return vec4(min(vec3(c.a), c.rgb + b * c.a), c.a); }` },
  { id: "flicker", name: "Flicker", cat: "Light", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float f = 1.0 - u_p[0].x * 0.6 * step(0.7, noise(vec2(u_time * 20.0 * u_p[0].y, 1.0))); return vec4(c.rgb * f, c.a); }` },
  { id: "spotlight", name: "Spotlight", cat: "Light", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); vec2 ar = vec2(u_size.x / u_size.y, 1.0); vec2 p = vec2(0.5 + 0.3 * sin(u_time * 0.8 * u_p[0].y), 0.5 + 0.15 * cos(u_time * 0.6 * u_p[0].y));
    float l = smoothstep(0.45, 0.1, length((uv - p) * ar)); return vec4(c.rgb * mix(1.0, 0.15 + 1.1 * l, u_p[0].x), c.a); }` },
  { id: "duotone", name: "Duotone", cat: "Light", params: [STR], glsl: `vec4 effect(vec2 uv){ vec4 c = pick(uv); float l = luma(c.rgb / max(c.a, 1e-4)); vec3 d = mix(vec3(0.13, 0.05, 0.38), vec3(1.0, 0.55, 0.35), l); return vec4(mix(c.rgb, d * c.a, u_p[0].x), c.a); }` },
  { id: "rgbShake", name: "Beat shake", cat: "Party", params: [STR, SPEED], glsl: `vec4 effect(vec2 uv){ float b = pow(max(0.0, sin(u_time * 6.28 * u_p[0].y)), 12.0); float z = 1.0 + 0.06 * b * u_p[0].x; vec2 p = (uv - 0.5) / z + 0.5; float o = 0.015 * b * u_p[0].x;
    return vec4(pick(p + vec2(o, 0)).r, pick(p).g, pick(p - vec2(o, 0)).b, pick(p).a); }` },
];

export const effectById = (id: string) => EFFECTS.find(e => e.id === id);
export function effectParams(def: EffectDef, params?: Record<string, number>): number[] {
  const v = [0, 0, 0, 0, 0, 0, 0, 0];
  def.params.forEach((p, i) => { v[i] = params?.[p.key] ?? p.def; });
  return v;
}
