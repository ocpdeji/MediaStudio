// GLSL programs. All outputs are premultiplied RGBA; canvas pixels are gl_FragCoord with y downwards.

const HEAD = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 v_uv; out vec4 o;
`;

/** Shared colour pipeline: adjustments + LUT. `adj` layout (vec4 ×4):
 *  [exposure, brightness, contrast, saturation] [vibrance, temperature, tint, highlights] [shadows, hue, sharpen, vignette] [grain, fade, time, unused]
 *  Values are −1…1 (UI −100…100 / 100). */
export const COLOR_FN = `
uniform vec4 u_adj[4];
uniform sampler3D u_lut; uniform float u_lutAmt;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec3 hueRot(vec3 c, float a){ float s = sin(a), k = cos(a); mat3 m = mat3(
  0.299+0.701*k+0.168*s, 0.587-0.587*k+0.330*s, 0.114-0.114*k-0.497*s,
  0.299-0.299*k-0.328*s, 0.587+0.413*k+0.035*s, 0.114-0.114*k+0.292*s,
  0.299-0.300*k+1.250*s, 0.587-0.588*k-1.050*s, 0.114+0.886*k-0.203*s); return clamp(c * m, 0.0, 1.0); }
vec3 grade(vec3 c, vec2 vigUv, vec2 grainPx){
  vec4 a = u_adj[0], b = u_adj[1], d = u_adj[2], e = u_adj[3];
  c *= exp2(a.x * 2.0);
  c += a.y * 0.25;
  float l = luma(c);
  c += (smoothstep(0.45, 1.0, l)) * b.w * 0.35;
  c += (1.0 - smoothstep(0.0, 0.55, l)) * d.x * 0.35;
  c = (c - 0.5) * (1.0 + a.z * (a.z > 0.0 ? 1.0 : 0.85)) + 0.5;
  c.r += b.y * 0.12; c.b -= b.y * 0.12; c.g += b.z * 0.10;
  l = luma(c);
  float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  c = mix(vec3(l), c, 1.0 + a.w + b.x * (1.0 - sat));
  if (abs(d.y) > 0.001) c = hueRot(clamp(c, 0.0, 1.0), d.y * 3.14159);
  c = mix(c, vec3(0.08) + c * 0.84, e.y * 0.8);
  if (d.w != 0.0) { float r = length((vigUv - 0.5) * vec2(1.0, 1.0)); c *= 1.0 - d.w * smoothstep(0.25, 0.85, r) * 0.9; }
  if (e.x > 0.0) c += (hash(grainPx + e.z * 61.0) - 0.5) * e.x * 0.25;
  c = clamp(c, 0.0, 1.0);
  if (u_lutAmt > 0.0) c = mix(c, texture(u_lut, c * (32.0 / 33.0) + 0.5 / 33.0).rgb, u_lutAmt);
  return c;
}`;

export const LAYER = HEAD + COLOR_FN + `
uniform sampler2D u_src; uniform vec2 u_srcSize;
uniform sampler2D u_matte; uniform float u_useMatte;
uniform mat3 u_inv;          // canvas px -> local box coords (-0.5..0.5)
uniform vec2 u_box;          // box size in canvas px (for edge antialiasing)
uniform vec4 u_crop;         // l, t, r, b (fractions of the source)
uniform float i_rot;         // source rotation (0,1,2,3 quarter turns clockwise)
uniform float u_opacity;
uniform vec4 u_key; uniform vec2 u_keyP;  // chroma colour + on; strength, shadow
uniform float i_mask; uniform vec4 u_mask; uniform vec4 u_maskP; // shape; cx,cy,w,h (local); rot, feather, invert, round
uniform vec4 u_reveal;       // visible local rect l,t,r,b in 0..1 (wipes)
uniform float u_sharpen;
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdHeart(vec2 p){ p.y = -p.y + 0.25; p.x = abs(p.x); if (p.y + p.x > 1.0) return sqrt(dot(p - vec2(0.25, 0.75), p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot(p - vec2(0.0, 1.0), p - vec2(0.0, 1.0)), dot(p - 0.5 * max(p.x + p.y, 0.0), p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y); }
float sdStar(vec2 p, float r){ const vec2 k1 = vec2(0.809016994, -0.587785252); const vec2 k2 = vec2(-k1.x, k1.y); p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1; p -= 2.0 * max(dot(k2, p), 0.0) * k2; p.x = abs(p.x); p.y -= r; vec2 ba = 0.5 * r * vec2(-k1.y, k1.x) - vec2(0, r);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r); return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y); }
float maskAlpha(vec2 l){
  if (i_mask < 0.5) return 1.0;
  vec2 p = l - u_mask.xy; float a = -u_maskP.x; p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
  float f = max(u_maskP.y, 0.0005); float d;
  if (i_mask < 1.5) d = p.y;                                        // linear
  else if (i_mask < 2.5) d = abs(p.y) - u_mask.w * 0.5;              // mirror (band)
  else if (i_mask < 3.5) d = length(p / (u_mask.zw * 0.5)) - 1.0;    // circle / ellipse
  else if (i_mask < 4.5) d = sdBox(p, u_mask.zw * 0.5, u_maskP.w * min(u_mask.z, u_mask.w) * 0.5); // rectangle
  else if (i_mask < 5.5) d = sdHeart(p / (u_mask.zw * 0.62) + vec2(0.0, 0.42)) * 0.3; // heart
  else d = sdStar(p / (u_mask.zw * 0.5), 0.8) * 0.5;                 // star
  float m = 1.0 - smoothstep(-f, f, d);
  return u_maskP.z > 0.5 ? 1.0 - m : m;
}
vec2 rotUv(vec2 uv){ if (i_rot < 0.5) return uv; if (i_rot < 1.5) return vec2(uv.y, 1.0 - uv.x); if (i_rot < 2.5) return 1.0 - uv; return vec2(1.0 - uv.y, uv.x); }
void main(){
  vec3 lp = u_inv * vec3(gl_FragCoord.xy, 1.0);
  vec2 l = lp.xy;                         // -0.5..0.5 inside the box
  vec2 edge = (0.5 - abs(l)) * u_box;     // distance to the box edge in px
  float cov = clamp(min(edge.x, edge.y) + 0.5, 0.0, 1.0);
  vec2 luv = l + 0.5;
  if (cov <= 0.0 || luv.x < u_reveal.x || luv.y < u_reveal.y || luv.x > u_reveal.z || luv.y > u_reveal.w) { o = vec4(0.0); return; }
  vec2 uv = u_crop.xy + luv * (1.0 - u_crop.xy - u_crop.zw);
  vec2 suv = rotUv(uv);
  vec4 s = texture(u_src, suv);
  if (u_sharpen > 0.0) {
    vec2 px = 1.0 / u_srcSize;
    vec3 bl = (texture(u_src, suv + vec2(px.x, 0)).rgb + texture(u_src, suv - vec2(px.x, 0)).rgb + texture(u_src, suv + vec2(0, px.y)).rgb + texture(u_src, suv - vec2(0, px.y)).rgb) * 0.25;
    s.rgb = clamp(s.rgb + (s.rgb - bl) * u_sharpen * 2.5, 0.0, 1.0);
  }
  float alpha = s.a;
  if (u_useMatte > 0.5) alpha *= texture(u_matte, suv).r;
  if (u_key.w > 0.5) {
    vec3 kc = u_key.rgb;
    float cb = (s.b - luma(s.rgb)) * 0.564, cr = (s.r - luma(s.rgb)) * 0.713;
    float kb = (kc.b - luma(kc)) * 0.564, kr = (kc.r - luma(kc)) * 0.713;
    float dist = distance(vec2(cb, cr), vec2(kb, kr));
    float t = mix(0.02, 0.32, u_keyP.x);
    float k = smoothstep(t, t + 0.06 + u_keyP.y * 0.1, dist);
    alpha *= k;
    // spill suppression
    if (kc.g > kc.r && kc.g > kc.b) s.g = mix(s.g, min(s.g, max(s.r, s.b) + 0.04), u_keyP.x);
    else if (kc.b > kc.r && kc.b > kc.g) s.b = mix(s.b, min(s.b, max(s.r, s.g) + 0.04), u_keyP.x);
  }
  vec3 c = grade(s.rgb, luv, gl_FragCoord.xy);
  float a = alpha * cov * maskAlpha(l) * u_opacity;
  o = vec4(c * a, a);
}`;

/** W3C separable blend modes on premultiplied colours. */
export const BLEND = HEAD + `
uniform sampler2D u_dst, u_src; uniform vec2 u_size; uniform float i_mode; uniform float u_opacity;
vec3 B(vec3 cs, vec3 cb, float m){
  if (m < 0.5) return cs;
  if (m < 1.5) return cs * cb;                                              // multiply
  if (m < 2.5) return cs + cb - cs * cb;                                    // screen
  if (m < 3.5) return mix(2.0 * cs * cb, 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb), step(0.5, cb)); // overlay
  if (m < 4.5) return min(cs, cb);                                          // darken
  if (m < 5.5) return max(cs, cb);                                          // lighten
  if (m < 6.5) return min(vec3(1.0), cb / max(1.0 - cs, 1e-4));             // color dodge
  if (m < 7.5) return 1.0 - min(vec3(1.0), (1.0 - cb) / max(cs, 1e-4));     // color burn
  if (m < 8.5) return mix(2.0 * cs * cb, 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb), step(0.5, cs)); // hard light
  if (m < 9.5) { vec3 d = mix(sqrt(cb), ((16.0 * cb - 12.0) * cb + 4.0) * cb, step(cb, vec3(0.25)));
    return mix(cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb), cb + (2.0 * cs - 1.0) * (d - cb), step(0.5, cs)); } // soft light
  if (m < 10.5) return abs(cs - cb);                                        // difference
  if (m < 11.5) return cs + cb - 2.0 * cs * cb;                             // exclusion
  if (m < 12.5) return min(vec3(1.0), cs + cb);                             // add (linear dodge)
  return max(vec3(0.0), cs + cb - 1.0);                                     // linear burn
}
void main(){
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 d = texture(u_dst, uv), s = texture(u_src, uv) * u_opacity;
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0), cb = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 co = s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * clamp(B(cs, cb, i_mode), 0.0, 1.0);
  o = vec4(co, s.a + d.a * (1.0 - s.a));
}`;
export const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "colorDodge", "colorBurn", "hardLight", "softLight", "difference", "exclusion", "add", "linearBurn"];
export const BLEND_LABELS: Record<string, string> = { normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken", lighten: "Lighten", colorDodge: "Color dodge", colorBurn: "Color burn", hardLight: "Hard light", softLight: "Soft light", difference: "Difference", exclusion: "Exclusion", add: "Add", linearBurn: "Linear burn" };

/** Full-canvas colour grade (adjustment & filter tracks). */
export const GRADE = HEAD + COLOR_FN + `
uniform sampler2D u_tex; uniform vec2 u_size; uniform float u_amount;
void main(){ vec2 uv = gl_FragCoord.xy / u_size; vec4 s = texture(u_tex, uv); vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 g = grade(c, uv, gl_FragCoord.xy); o = vec4(mix(c, g, u_amount) * s.a, s.a); }`;

/** Separable gaussian (premultiplied). */
export const BLUR = HEAD + `
uniform sampler2D u_tex; uniform vec2 u_size; uniform vec2 u_dir; uniform float u_radius;
void main(){
  vec2 uv = gl_FragCoord.xy / u_size; vec4 acc = vec4(0.0); float wsum = 0.0;
  float sigma = max(u_radius / 2.5, 0.5);
  for (int i = -12; i <= 12; i++) { float x = float(i) * u_radius / 12.0; float w = exp(-x * x / (2.0 * sigma * sigma)); acc += texture(u_tex, uv + u_dir * x / u_size) * w; wsum += w; }
  o = acc / wsum;
}`;

export const COPY = HEAD + `uniform sampler2D u_tex; uniform vec2 u_size; uniform float u_opacity;
void main(){ o = texture(u_tex, gl_FragCoord.xy / u_size) * u_opacity; }`;

/** Draw a texture scaled to cover the canvas (canvas background "blur"). */
export const COVER = HEAD + `uniform sampler2D u_tex; uniform vec2 u_size; uniform vec2 u_srcSize; uniform float i_rot;
vec2 rotUv(vec2 uv){ if (i_rot < 0.5) return uv; if (i_rot < 1.5) return vec2(uv.y, 1.0 - uv.x); if (i_rot < 2.5) return 1.0 - uv; return vec2(1.0 - uv.y, uv.x); }
void main(){ vec2 uv = gl_FragCoord.xy / u_size; float ca = u_size.x / u_size.y, sa = u_srcSize.x / u_srcSize.y;
  vec2 s = ca > sa ? vec2(1.0, sa / ca) : vec2(ca / sa, 1.0); vec2 p = (uv - 0.5) * s + 0.5; o = vec4(texture(u_tex, rotUv(p)).rgb, 1.0); }`;

export const SOLID = HEAD + `uniform vec4 u_color; void main(){ o = vec4(u_color.rgb * u_color.a, u_color.a); }`;

/** Present the (top-down) canvas texture on screen, flattening onto black. */
export const PRESENT = HEAD + `uniform sampler2D u_tex; void main(){ vec4 s = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y)); o = vec4(s.rgb + (1.0 - s.a) * vec3(0.0), 1.0); }`;

/** RGB → BT.709 limited-range YUV 4:2:0, 4 samples per RGBA texel. */
export const YUV_Y = HEAD + `uniform sampler2D u_tex; uniform vec2 u_size;
float Y(vec3 c){ return 16.0 / 255.0 + (219.0 / 255.0) * dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 at(float x, float y){ vec4 s = texture(u_tex, (vec2(x, y) + 0.5) / u_size); return s.rgb + (1.0 - s.a) * vec3(0.0); }
void main(){ float x = floor(gl_FragCoord.x) * 4.0, y = floor(gl_FragCoord.y);
  o = vec4(Y(at(x, y)), Y(at(x + 1.0, y)), Y(at(x + 2.0, y)), Y(at(x + 3.0, y))); }`;
export const YUV_UV = HEAD + `uniform sampler2D u_tex; uniform vec2 u_size; uniform float u_v;
vec3 at(float x, float y){ vec4 s = texture(u_tex, (vec2(x, y) + 0.5) / u_size); return s.rgb; }
float C(float cx, float cy){ vec3 c = (at(cx * 2.0, cy * 2.0) + at(cx * 2.0 + 1.0, cy * 2.0) + at(cx * 2.0, cy * 2.0 + 1.0) + at(cx * 2.0 + 1.0, cy * 2.0 + 1.0)) * 0.25;
  float u = -0.1146 * c.r - 0.3854 * c.g + 0.5 * c.b; float v = 0.5 * c.r - 0.4542 * c.g - 0.0458 * c.b;
  return 128.0 / 255.0 + (224.0 / 255.0) * (u_v > 0.5 ? v : u); }
void main(){ float x = floor(gl_FragCoord.x) * 4.0, y = floor(gl_FragCoord.y);
  o = vec4(C(x, y), C(x + 1.0, y), C(x + 2.0, y), C(x + 3.0, y)); }`;
/** Matte (alpha) → gray plane, 4 samples per texel. */
export const GRAY = HEAD + `uniform sampler2D u_tex; uniform vec2 u_size;
float A(float x, float y){ return texture(u_tex, (vec2(x, y) + 0.5) / u_size).r; }
void main(){ float x = floor(gl_FragCoord.x) * 4.0, y = floor(gl_FragCoord.y); o = vec4(A(x, y), A(x + 1.0, y), A(x + 2.0, y), A(x + 3.0, y)); }`;

/** Wrap a gl-transitions GLSL3 body. Their uv is bottom-up, ours top-down. */
export function transitionShader(body: string) {
  return HEAD + `uniform sampler2D u_from, u_to; uniform vec2 u_size; uniform float progress; uniform float ratio;
vec4 getFromColor(vec2 uv){ return texture(u_from, vec2(uv.x, 1.0 - uv.y)); }
vec4 getToColor(vec2 uv){ return texture(u_to, vec2(uv.x, 1.0 - uv.y)); }
${body}
void main(){ vec2 fc = gl_FragCoord.xy / u_size; o = transition(vec2(fc.x, 1.0 - fc.y)); }`;
}

/** Wrap an effect body `vec4 effect(vec2 uv)` with helpers (sample(), u_time, u_p[], u_amount, u_prog). */
export function effectShader(body: string) {
  return HEAD + `uniform sampler2D u_tex; uniform vec2 u_size; uniform float u_time, u_amount, u_prog; uniform vec4 u_p[2];
vec4 pick(vec2 uv){ return texture(u_tex, clamp(uv, 0.0, 1.0)); }
vec4 pickWrap(vec2 uv){ return texture(u_tex, fract(uv)); }
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
${body}
void main(){ vec2 uv = gl_FragCoord.xy / u_size; vec4 src = texture(u_tex, uv); vec4 e = effect(uv); o = mix(src, e, clamp(u_amount, 0.0, 1.0)); }`;
}
