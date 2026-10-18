// Copies the onnxruntime-web WebAssembly/WebGPU runtime into public/ort (served locally; no CDN).
import fs from "node:fs";
const src = "node_modules/onnxruntime-web/dist", dst = "public/ort";
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) if (/^ort-wasm-simd-threaded\.(jsep|asyncify)\.(mjs|wasm)$/.test(f)) { const a = `${src}/${f}`, b = `${dst}/${f}`; if (!fs.existsSync(b) || fs.statSync(b).size !== fs.statSync(a).size) fs.copyFileSync(a, b); }
