// Compiles every GPU program (core passes, all effects, all transitions) inside the app's WebView.
// Usage (dev app running with remote debugging): node e2e/shaders.mjs
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null, protocolTimeout: 0 });
const page = (await browser.pages()).find(p => p.url().includes("localhost:1420"));
const r = await page.evaluate(async () => {
  const S = await import("/src/editor/engine/shaders.ts");
  const E = await import("/src/editor/engine/effects.ts");
  const T = await import("/src/editor/engine/transitions.ts");
  const { GL } = await import("/src/editor/engine/gl.ts");
  const gl = new GL(new OffscreenCanvas(64, 64));
  const fail = [];
  const tryc = (k, src) => { try { gl.program(k, src); } catch (e) { fail.push(k + ": " + String(e).slice(0, 200)); } };
  for (const [k, src] of Object.entries({ layer: S.LAYER, blend: S.BLEND, grade: S.GRADE, blur: S.BLUR, copy: S.COPY, cover: S.COVER, solid: S.SOLID, present: S.PRESENT, y: S.YUV_Y, uv: S.YUV_UV, gray: S.GRAY })) tryc(k, src);
  for (const e of E.EFFECTS) tryc("fx:" + e.id, S.effectShader(e.glsl));
  for (const t of T.TRANSITIONS) tryc("tr:" + t.id, S.transitionShader(t.glsl));
  return { effects: E.EFFECTS.length, transitions: T.TRANSITIONS.length, fail };
});
console.log(`${r.effects} effects, ${r.transitions} transitions, ${r.fail.length} failures`); r.fail.forEach(f => console.log("FAIL " + f));
browser.disconnect();
process.exitCode = r.fail.length ? 1 : 0;
