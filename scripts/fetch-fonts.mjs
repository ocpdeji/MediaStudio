// Downloads the bundled editor fonts (SIL OFL 1.1 / Apache 2.0) from the google/fonts repository into
// public/fonts and writes public/fonts/fonts.css. Run: node scripts/fetch-fonts.mjs
import fs from "node:fs";
import path from "node:path";

const BASE = "https://raw.githubusercontent.com/google/fonts/main/";
const FONTS = [
  ["Montserrat", "ofl/montserrat/Montserrat[wght].ttf", "100 900"],
  ["Poppins", "ofl/poppins/Poppins-Regular.ttf", "400"], ["Poppins", "ofl/poppins/Poppins-ExtraBold.ttf", "800"],
  ["Inter", "ofl/inter/Inter[opsz,wght].ttf", "100 900"],
  ["Roboto", "ofl/roboto/Roboto[wdth,wght].ttf", "100 900"],
  ["Anton", "ofl/anton/Anton-Regular.ttf", "100 900"],
  ["Bebas Neue", "ofl/bebasneue/BebasNeue-Regular.ttf", "100 900"],
  ["Oswald", "ofl/oswald/Oswald[wght].ttf", "200 700"],
  ["Archivo Black", "ofl/archivoblack/ArchivoBlack-Regular.ttf", "100 900"],
  ["Kanit", "ofl/kanit/Kanit-Regular.ttf", "400"], ["Kanit", "ofl/kanit/Kanit-ExtraBold.ttf", "800"],
  ["Teko", "ofl/teko/Teko[wght].ttf", "300 700"],
  ["Russo One", "ofl/russoone/RussoOne-Regular.ttf", "100 900"],
  ["Righteous", "ofl/righteous/Righteous-Regular.ttf", "100 900"],
  ["Luckiest Guy", "apache/luckiestguy/LuckiestGuy-Regular.ttf", "100 900"],
  ["Bangers", "ofl/bangers/Bangers-Regular.ttf", "100 900"],
  ["Permanent Marker", "apache/permanentmarker/PermanentMarker-Regular.ttf", "100 900"],
  ["Pacifico", "ofl/pacifico/Pacifico-Regular.ttf", "100 900"],
  ["Lobster", "ofl/lobster/Lobster-Regular.ttf", "100 900"],
  ["Dancing Script", "ofl/dancingscript/DancingScript[wght].ttf", "400 700"],
  ["Playfair Display", "ofl/playfairdisplay/PlayfairDisplay[wght].ttf", "400 900"],
  ["Comfortaa", "ofl/comfortaa/Comfortaa[wght].ttf", "300 700"],
  ["Caveat", "ofl/caveat/Caveat[wght].ttf", "400 700"],
];
const out = path.resolve("public/fonts");
fs.mkdirSync(out, { recursive: true });
let css = "/* Bundled fonts — SIL Open Font License 1.1 or Apache License 2.0 (see LICENSES.txt) */\n";
const licences = new Set();
for (const [family, rel, weight] of FONTS) {
  const file = path.basename(rel).replace(/[\[\],]/g, "_");
  const dest = path.join(out, file);
  if (!fs.existsSync(dest)) {
    const url = BASE + rel.split("/").map(encodeURIComponent).join("/");
    const r = await fetch(url);
    if (!r.ok) { console.error("FAILED", family, r.status, url); process.exitCode = 1; continue; }
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    console.log("ok", family, file, fs.statSync(dest).size);
  }
  const lw = weight.includes(" ") ? weight : weight;
  css += `@font-face{font-family:"${family}";src:url("./${file}") format("truetype");font-weight:${lw};font-style:normal;font-display:block}\n`;
  licences.add(rel.split("/").slice(0, 2).join("/"));
}
fs.writeFileSync(path.join(out, "fonts.css"), css);
let lic = "Fonts bundled with Media Studio Pro, from https://github.com/google/fonts\n\n";
for (const dir of licences) {
  for (const name of ["OFL.txt", "LICENSE.txt"]) {
    const r = await fetch(BASE + dir + "/" + name);
    if (r.ok) { lic += `===== ${dir} (${name}) =====\n${await r.text()}\n\n`; break; }
  }
}
fs.writeFileSync(path.join(out, "LICENSES.txt"), lic);
console.log("done");
