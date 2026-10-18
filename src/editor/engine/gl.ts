// Minimal WebGL2 toolkit for the compositor. Convention: every texture/target stores images top row first, and
// shaders address canvas pixels with gl_FragCoord (y grows downwards). Only `present` flips for the screen.

export interface Target { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }
export type UVal = number | number[] | Float32Array | boolean | { i: number | number[] };
export type Uniforms = Record<string, UVal>;
export interface TexBinding { name: string; tex: WebGLTexture; target?: number }

export const VERT = `#version 300 es
in vec2 a; out vec2 v_uv;
void main(){ v_uv = a; gl_Position = vec4(a * 2.0 - 1.0, 0.0, 1.0); }`;

export class GL {
  gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private progs = new Map<string, { p: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> }>();
  private pool: Target[] = [];
  private live = new Set<Target>();
  lost = false;

  constructor(public canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: "high-performance" }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available — update your graphics driver.");
    this.gl = gl;
    (canvas as HTMLCanvasElement).addEventListener?.("webglcontextlost", e => { e.preventDefault(); this.lost = true; });
    const buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!; gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
  }

  program(key: string, frag: string) {
    const hit = this.progs.get(key); if (hit) return hit;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(`Shader ${key}: ${log}`); }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, "a"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program ${key}: ${gl.getProgramInfoLog(p)}`);
    const e = { p, loc: new Map<string, WebGLUniformLocation | null>() };
    this.progs.set(key, e); return e;
  }

  texture(filter: "linear" | "nearest" | "mip" = "linear"): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter === "nearest" ? gl.NEAREST : filter === "mip" ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === "nearest" ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Upload an image/video/canvas/VideoFrame; returns its pixel size. Mipmaps when it will be shrunk a lot. */
  upload(tex: WebGLTexture, src: TexImageSource, mip = false): [number, number] {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const [w, h] = sizeOf(src);
    if (mip) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return [w, h];
  }

  target(w: number, h: number): Target {
    const i = this.pool.findIndex(t => t.w === w && t.h === h);
    if (i >= 0) { const t = this.pool.splice(i, 1)[0]; this.live.add(t); return t; }
    const gl = this.gl, tex = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fb, w, h }; this.live.add(t); return t;
  }
  release(t: Target | null | undefined) { if (t && this.live.delete(t)) this.pool.push(t); }
  /** Free pooled targets of other sizes (after a resolution change). */
  trim(keepW: number, keepH: number) {
    const gl = this.gl;
    this.pool = this.pool.filter(t => { const keep = (t.w === keepW && t.h === keepH) || (t.w * 4 === keepW) || (t.w * 8 === keepW); if (!keep) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); } return keep; });
  }

  clear(t: Target | null, rgba: [number, number, number, number] = [0, 0, 0, 0]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : (this.canvas as HTMLCanvasElement).width, t ? t.h : (this.canvas as HTMLCanvasElement).height);
    gl.clearColor(...rgba); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Run a fragment program into `out` (null = the canvas). */
  run(key: string, frag: string, out: Target | null, u: Uniforms, tex: TexBinding[] = [], viewport?: [number, number]) {
    const gl = this.gl, pr = this.program(key, frag);
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    const [w, h] = viewport ?? (out ? [out.w, out.h] : [(this.canvas as HTMLCanvasElement).width, (this.canvas as HTMLCanvasElement).height]);
    gl.viewport(0, 0, w, h);
    tex.forEach((b, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(b.target ?? gl.TEXTURE_2D, b.tex); this.set(pr, b.name, i, true); });
    for (const [k, v] of Object.entries(u)) this.set(pr, k, v);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private set(pr: { p: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> }, name: string, v: UVal, sampler = false) {
    const gl = this.gl;
    let l = pr.loc.get(name);
    if (l === undefined) { l = gl.getUniformLocation(pr.p, name); pr.loc.set(name, l); }
    if (l === null) return;
    if (sampler || typeof v === "boolean") { gl.uniform1i(l, Number(v)); return; }
    if (typeof v === "object" && "i" in v) {
      const a = Array.isArray(v.i) ? v.i.map(Math.round) : [Math.round(v.i)];
      if (a.length === 1) gl.uniform1i(l, a[0]); else if (a.length === 2) gl.uniform2iv(l, a); else if (a.length === 3) gl.uniform3iv(l, a); else gl.uniform4iv(l, a);
      return;
    }
    if (typeof v === "number") { gl.uniform1f(l, v); return; }
    const a = v as number[] | Float32Array;
    if (name.startsWith("i_")) { if (a.length === 1) gl.uniform1i(l, a[0]); return; }
    switch (a.length) {
      case 2: gl.uniform2fv(l, a); break; case 3: gl.uniform3fv(l, a); break; case 4: gl.uniform4fv(l, a); break;
      case 9: gl.uniformMatrix3fv(l, false, a); break; default: gl.uniform4fv(l, a); // vec4 arrays
    }
  }

  readInto(t: Target, w: number, h: number, buf: Uint8Array) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  }

  texture3D(size: number, data: Uint8Array): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return t;
  }

  dispose() {
    const gl = this.gl;
    for (const t of [...this.pool, ...this.live]) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    for (const { p } of this.progs.values()) gl.deleteProgram(p);
    this.pool = []; this.live.clear(); this.progs.clear();
  }
}

export function sizeOf(src: TexImageSource): [number, number] {
  const s = src as any;
  if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame) return [src.displayWidth, src.displayHeight];
  if (s.videoWidth !== undefined) return [s.videoWidth, s.videoHeight];
  if (s.naturalWidth !== undefined) return [s.naturalWidth, s.naturalHeight];
  return [s.width, s.height];
}

export const hex = (c: string, a = 1): [number, number, number, number] => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(c?.trim() ?? "");
  if (!m) return [0, 0, 0, a];
  let h = m[1]; if (h.length === 3) h = h.split("").map(x => x + x).join("");
  const n = parseInt(h, 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};
