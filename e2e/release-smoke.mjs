// Smoke test of a RELEASE build through the UI only (no dev hooks): open the first project, export it, report.
// Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222, then: node e2e/release-smoke.mjs
import puppeteer from "puppeteer-core";
import fs from "node:fs";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null, protocolTimeout: 0 });
const page = (await browser.pages())[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = [];
await page.click(".home-card .im"); await sleep(5000);
out.push(`editor open: ${!!(await page.$(".ed-timeline, .ed-tl"))}`);
await page.evaluate(() => document.querySelector(".ed-play")?.click()); await sleep(2500);
await page.screenshot({ path: "e2e-out/rel_editor.png" });
await page.evaluate(() => document.querySelector(".ed-play")?.click());
await page.keyboard.down("Control"); await page.keyboard.press("e"); await page.keyboard.up("Control"); await sleep(1500);
const dir = await page.evaluate(() => document.querySelector(".ed-dialog .ed-form input:nth-of-type(1)") ? [...document.querySelectorAll(".ed-dialog .ed-form input")].map(i => i.value) : null);
out.push(`export dialog fields: ${JSON.stringify(dir)}`);
await page.evaluate(() => [...document.querySelectorAll(".ed-dialog .ft .eb.primary")].find(b => /Export/.test(b.textContent))?.click());
const t0 = Date.now();
let txt = "";
while (Date.now() - t0 < 600000) { await sleep(3000); txt = await page.evaluate(() => document.querySelector(".ed-dialog .bd")?.innerText ?? ""); if (/complete|failed/i.test(txt)) break; }
out.push(`export result after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${txt.replace(/\s+/g, " ").slice(0, 300)}`);
await page.screenshot({ path: "e2e-out/rel_export.png" });
console.log(out.join("\n"));
fs.writeFileSync("e2e-out/release-smoke.txt", out.join("\n"));
browser.disconnect();
