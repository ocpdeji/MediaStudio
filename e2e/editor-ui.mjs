// End-to-end UI test of the editor with real mouse/keyboard input (dev build with remote debugging on :9222).
// Usage: node e2e/editor-ui.mjs   — expects a project named "E2E Test" (created by earlier e2e steps).
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null, protocolTimeout: 0 });
const page = (await browser.pages()).find(p => p.url().includes("localhost:1420")) ?? (await browser.pages())[0];
const results = [];
const check = (name, ok, info = "") => { results.push(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`); };
const state = () => page.evaluate(() => { const p = window.__t.es.useEd.getState().p; return { tracks: p.tracks.map(t => ({ kind: t.kind, main: !!t.main, clips: t.clips.map(c => ({ id: c.id, type: c.type, start: c.start, dur: c.dur })) })) }; });
const box = sel => page.evaluate(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }, sel);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const drag = async (x1, y1, x2, y2) => { await page.mouse.move(x1, y1); await page.mouse.down(); for (let i = 1; i <= 15; i++) await page.mouse.move(x1 + ((x2 - x1) * i) / 15, y1 + ((y2 - y1) * i) / 15); await page.mouse.up(); await sleep(300); };

try {
  await page.evaluate(async () => {
    localStorage.setItem("msp.tour", "1");
    const { es, api, ls } = window.__t;
    const pr = (await api.ed.projects()).find(x => x.name === "E2E Test");
    await es.useEd.getState().open(pr.id);
    ls.useStore.setState({ workspace: "editor", dialog: null });
    es.useEd.getState().setZoom(60);
  });
  await sleep(2500);

  // 1) trim: drag the right edge of the 2nd main-track clip left by 120 px
  let s0 = await state();
  const main0 = s0.tracks.find(t => t.main).clips;
  const clipSel = `.ed-lane.main .ed-clip:nth-of-type(2)`;
  await page.click(clipSel); await sleep(200);
  const b = await box(`${clipSel} .trim.r`);
  await drag(b.x + 4, b.y + b.h / 2, b.x + 4 - 120, b.y + b.h / 2);
  let s1 = await state();
  const d0 = main0[1].dur, d1 = s1.tracks.find(t => t.main).clips[1].dur;
  check("drag right edge trims the clip", d1 < d0 - 1_500_000 && d1 > d0 - 2_500_000, `${(d0 / 1e6).toFixed(2)}s → ${(d1 / 1e6).toFixed(2)}s`);
  check("magnet closes the gap after trim", s1.tracks.find(t => t.main).clips[2].start === main0[1].start + d1);

  // 2) undo restores
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control"); await sleep(300);
  let s2 = await state();
  check("Ctrl+Z restores the trim", s2.tracks.find(t => t.main).clips[1].dur === d0);

  // 3) split with Ctrl+B at the playhead (middle of clip 2)
  const mid = main0[1].start + d0 / 2;
  await page.evaluate(t => window.__t.es.useEd.getState().seek(t), mid);
  await page.click(clipSel); await sleep(150);
  await page.keyboard.down("Control"); await page.keyboard.press("b"); await page.keyboard.up("Control"); await sleep(300);
  let s3 = await state();
  check("Ctrl+B splits the selected clip", s3.tracks.find(t => t.main).clips.length === main0.length + 1);

  // 4) move a text clip right by dragging its body
  const tb = await page.evaluate(() => { const el = [...document.querySelectorAll(".ed-clip")].find(e => e.textContent.includes("Hello CapCut")); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const before = (await state()).tracks.flatMap(t => t.clips).find(c => c.type === "text");
  await drag(tb.x + tb.w / 2, tb.y + tb.h / 2, tb.x + tb.w / 2 + 90, tb.y + tb.h / 2);
  const after = (await state()).tracks.flatMap(t => t.clips).find(c => c.id === before.id);
  check("dragging a text clip moves it", after.start > before.start + 1_000_000, `${(before.start / 1e6).toFixed(2)}s → ${(after.start / 1e6).toFixed(2)}s`);

  // 5) Q / W delete left/right of the playhead on the selected clip
  const target = (await state()).tracks.find(t => t.main).clips[0];
  await page.evaluate((id, t) => { const s = window.__t.es.useEd.getState(); s.select([id]); s.seek(t); }, target.id, target.start + 2_000_000);
  await page.keyboard.press("w"); await sleep(250);
  const w = (await state()).tracks.find(t => t.main).clips[0];
  check("W deletes right of the playhead", Math.abs(w.dur - 2_000_000) < 40_000, `${(w.dur / 1e6).toFixed(2)}s`);
  await page.evaluate(() => window.__t.es.useEd.getState().seek(1_000_000));
  await page.keyboard.press("q"); await sleep(250);
  const q = (await state()).tracks.find(t => t.main).clips[0];
  check("Q deletes left of the playhead", Math.abs(q.dur - 1_000_000) < 40_000 && q.start === 0, `${(q.dur / 1e6).toFixed(2)}s`);

  // 6) undo everything back (history depth)
  for (let i = 0; i < 6; i++) { await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control"); await sleep(120); }
  const back = (await state()).tracks.find(t => t.main).clips.map(c => c.dur);
  check("undo history returns to the original edit", JSON.stringify(back) === JSON.stringify(main0.map(c => c.dur)));

  // 7) no runtime errors surfaced as error toasts
  const errs = await page.evaluate(() => window.__t.ls.useStore.getState().toasts.filter(t => t.kind === "error").map(t => t.text));
  check("no error toasts", errs.length === 0, errs.join(" | "));
} catch (e) { check("test run", false, String(e)); }
console.log(results.join("\n"));
console.log(results.every(r => r.startsWith("PASS")) ? "\nALL PASSED" : "\nSOME FAILED");
browser.disconnect();
