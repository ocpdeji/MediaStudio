// Drives the real desktop app through WebView2's DevTools protocol (dev/test builds only).
// Usage: node e2e/drive.mjs <cmd> [args]   cmds: eval <js> | shot <name> | key <key> [mods] | click <selector> | clickText <text> | type <text> | wait <ms>
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const [cmd, ...args] = process.argv.slice(2);
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null, protocolTimeout: 0 });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes("localhost:1420") || p.url().includes("tauri.localhost")) ?? pages[0];
const out = "e2e-out"; fs.mkdirSync(out, { recursive: true });
try {
  if (cmd === "evalfile") {
    const r = await page.evaluate(`(async () => { ${fs.readFileSync(args[0], "utf8")} })()`);
    console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1));
  } else if (cmd === "eval") {
    const r = await page.evaluate(`(async () => { ${args.join(" ")} })()`);
    console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1));
  } else if (cmd === "shot") {
    await page.screenshot({ path: `${out}/${args[0]}.png` }); console.log(`${out}/${args[0]}.png`);
  } else if (cmd === "key") {
    const mods = (args[1] ?? "").split("+").filter(Boolean);
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(args[0]);
    for (const m of mods.reverse()) await page.keyboard.up(m);
  } else if (cmd === "click") {
    await page.click(args.join(" "));
  } else if (cmd === "clickText") {
    const t = args.join(" ");
    const ok = await page.evaluate(t => { const el = [...document.querySelectorAll("button,.side-item,.mi,.it,.tab,.chip,label")].find(e => e.textContent?.trim().includes(t)); if (!el) return false; el.click(); return true; }, t);
    if (!ok) { console.error(`no element with text "${t}"`); process.exitCode = 2; }
  } else if (cmd === "drag") {
    const [x1, y1, x2, y2] = args.map(Number);
    await page.mouse.move(x1, y1); await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12);
    await page.mouse.up();
  } else if (cmd === "type") {
    await page.keyboard.type(args.join(" "));
  } else if (cmd === "wait") {
    await new Promise(r => setTimeout(r, +args[0]));
  } else if (cmd === "logs") {
    console.log("(console capture not persistent in this driver)");
  }
} finally { browser.disconnect(); }
