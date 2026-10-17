export const fmtSize = (b: number) => !b ? "0 KB" : b >= 1073741824 ? (b / 1073741824).toFixed(2) + " GB" : b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
export const fmtDur = (ms: number | null | undefined) => {
  if (ms == null || !isFinite(ms)) return "";
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
};
/** SMPTE-style timecode HH:MM:SS:FF from microseconds and a rational frame rate. */
export const timecode = (us: number, fpsNum = 30, fpsDen = 1) => {
  const fps = fpsNum / fpsDen;
  const totalFrames = Math.floor((us / 1e6) * fps + 1e-6);
  const nominal = Math.round(fps);
  const f = totalFrames % nominal, s = Math.floor(totalFrames / nominal);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(f)}`;
};
export const fmtSec = (us: number) => (us / 1e6).toFixed(2) + "s";
export const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
export const aspect = (w: number, h: number) => { const g = gcd(w, h) || 1; return `${w / g}:${h / g}`; };
export const fps = (n: number | null, d: number | null) => (n && d ? +(n / d).toFixed(3) : null);
export const stem = (n: string) => n.replace(/\.[^.]+$/, "");
export const extOf = (n: string) => (n.match(/\.([^.]+)$/) || [, ""])[1]!.toLowerCase();
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
