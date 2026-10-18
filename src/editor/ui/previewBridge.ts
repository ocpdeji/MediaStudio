// Thumbnails for effects / filters / transitions (rendered with the real compositor on a generated sample scene)
// and registration of imported .cube LUTs.
import { Compositor, FrameProvider } from "../engine/compositor";
import { CUSTOM_LUTS, parseCube } from "../engine/luts";
import { newProject, Project, SEC, uid } from "../model";
import { ed } from "../api";

function scene(variant: number): OffscreenCanvas {
  const W = 320, H = 200, c = new OffscreenCanvas(W, H), g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  if (variant === 0) { sky.addColorStop(0, "#1e5aa8"); sky.addColorStop(0.6, "#f2a35e"); sky.addColorStop(1, "#f7d08a"); }
  else { sky.addColorStop(0, "#0f2027"); sky.addColorStop(0.6, "#2c7a5b"); sky.addColorStop(1, "#a8e063"); }
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  g.fillStyle = variant === 0 ? "#ffe9a8" : "#fdfcdc"; g.beginPath(); g.arc(variant === 0 ? 230 : 80, 70, 26, 0, 7); g.fill();
  g.fillStyle = variant === 0 ? "#3d2c4f" : "#1b4332"; g.beginPath(); g.moveTo(0, 150); g.quadraticCurveTo(90, 100, 170, 140); g.quadraticCurveTo(250, 170, 320, 120); g.lineTo(320, 200); g.lineTo(0, 200); g.fill();
  g.fillStyle = variant === 0 ? "#e85d75" : "#ffb703"; g.beginPath(); g.arc(120, 130, 16, 0, 7); g.fill(); g.fillRect(108, 144, 24, 40);
  return c;
}

class Bridge {
  private comp: Compositor | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private a = scene(0); private b = scene(1);
  private get() { if (!this.comp) this.comp = new Compositor(new OffscreenCanvas(320, 200)); return this.comp; }
  thumb(kind: "fx" | "flt" | "tr", id: string): Promise<string | null> {
    const job = this.queue.then(async () => {
      try {
        const c = this.get();
        const p: Project = { ...newProject("thumb", "16:9"), width: 320, height: 200 };
        const ma = "ma", mb = "mb";
        p.media = { [ma]: { id: ma, path: "A", name: "A", kind: "image", duration: 5 * SEC, width: 320, height: 200, fps_num: 30, fps_den: 1, has_audio: false, has_video: true, playable: true, size: 0, mtime: 0 },
          [mb]: { id: mb, path: "B", name: "B", kind: "image", duration: 5 * SEC, width: 320, height: 200, fps_num: 30, fps_den: 1, has_audio: false, has_video: true, playable: true, size: 0, mtime: 0 } };
        const main = p.tracks[0];
        main.clips = [{ id: uid(), type: "image", start: 0, dur: 2 * SEC, media: ma, in: 0, filter: kind === "flt" ? { id, amount: 100 } : null, effects: kind === "fx" ? [{ id }] : [], transition: kind === "tr" ? { id, dur: SEC } : null },
          { id: uid(), type: "image", start: 2 * SEC, dur: 2 * SEC, media: mb, in: 0 }];
        p.background = { type: "color", color: "#000000", blur: 0 };
        const fp: FrameProvider = { video: () => null, image: (path: string) => ({ src: path === "A" ? this.a : this.b, w: 320, h: 200, ver: path }) };
        const t = kind === "tr" ? 2 * SEC : 0.6 * SEC;
        const tg = c.render(p, t, fp, 320, 200);
        c.present(tg, 320, 200); c.release(tg);
        const blob = await (c.gl.canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality: 0.8 });
        return URL.createObjectURL(blob);
      } catch { return null; }
    });
    this.queue = job;
    return job;
  }
  addLut(id: string, data: Uint8Array) { CUSTOM_LUTS[id] = data; }
}
let bridge: Bridge | null = null;
export const previewComp = () => (bridge ??= new Bridge());

/** Re-register `.cube` LUTs referenced by a project (filter ids "cube:<path>"). */
export async function ensureCubeLuts(p: Project) {
  const ids = new Set<string>();
  for (const t of p.tracks) for (const c of t.clips) if (c.filter?.id.startsWith("cube:")) ids.add(c.filter.id);
  for (const id of ids) if (!CUSTOM_LUTS[id]) { try { CUSTOM_LUTS[id] = parseCube(await ed.readText(id.slice(5))); } catch { /* missing file: filter is skipped */ } }
}
