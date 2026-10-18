import { useEffect, useRef, useState } from "react";
import { open as openDlg } from "@tauri-apps/plugin-dialog";
import { videoDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Download, FolderOpen, Loader2, X } from "lucide-react";
import { ed } from "../api";
import { audioPlan, encSize, exportVideo, ExportCancelled, ExportProgress, notReady } from "../engine/exporter";
import { duration, Project } from "../model";
import { captionList, toSrt } from "../ai/captions";
import { ensureCubeLuts } from "./previewBridge";
import { useEd } from "../store";

const RES: [string, number][] = [["480p", 480], ["720p", 720], ["1080p", 1080], ["2K", 1440], ["4K", 2160], ["8K", 4320]];
const QUAL: Record<string, number> = { lower: 26, recommended: 20, higher: 16 };
const s2 = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const p = useEd(s => s.p)! as Project;
  const [name, setName] = useState(p.name.replace(/[<>:"/\\|?*]/g, "_"));
  const [dir, setDir] = useState("");
  const short = Math.min(p.width, p.height);
  const [res, setRes] = useState(RES.reduce((b, r) => (Math.abs(r[1] - short) < Math.abs(b - short) ? r[1] : b), 1080));
  const [fps, setFps] = useState(`${p.fps_num}/${p.fps_den}`);
  const [codec, setCodec] = useState("h264"); const [qual, setQual] = useState("recommended");
  const [video, setVideo] = useState(true); const [audioOnly, setAudioOnly] = useState(false); const [afmt, setAfmt] = useState("mp3"); const [subs, setSubs] = useState(false);
  const [prog, setProg] = useState<ExportProgress | null>(null); const [done, setDone] = useState<string[] | null>(null); const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { void videoDir().then(d => setDir(d)).catch(() => {}); }, []);
  const pending = notReady(p);
  const dur = duration(p);
  const scale = res / short;
  const [W, H] = encSize(Math.round(p.width * scale), Math.round(p.height * scale));
  const [fn, fd] = fps.split("/").map(Number);
  const ext = codec === "prores" ? "mov" : "mp4";

  const run = async () => {
    setErr(null); setDone(null);
    const outs: string[] = [];
    const ac = new AbortController(); abort.current = ac;
    try {
      await ensureCubeLuts(p);
      if (video && !audioOnly) {
        setProg({ stage: "prepare", frame: 0, frames: 1, fps: 0, eta: 0 });
        const out = await exportVideo(p, { width: W, height: H, fps_num: fn, fps_den: fd, outDir: dir, name: `${name}.${ext}`,
          preset: { container: ext, vcodec: codec, crf: codec === "prores" ? 0 : QUAL[qual] + (codec === "hevc" ? 2 : codec === "av1" ? 8 : 0), bitrate_kbps: null, acodec: codec === "prores" ? "pcm" : "aac", abitrate_kbps: 256, hw: "auto", speed: qual === "higher" ? "slow" : "medium", strip_metadata: false } },
          setProg, ac.signal);
        outs.push(out);
      }
      if (audioOnly) { setProg({ stage: "audio", frame: 0, frames: 1, fps: 0, eta: 0 }); outs.push(await ed.renderAudio(audioPlan(p), dir, `${name}.${afmt}`)); }
      if (subs && captionList(p).length) { const f = `${dir}\\${name}.srt`; await ed.saveTextAs(f, toSrt(p)); outs.push(f); }
      setDone(outs);
    } catch (e) { if (!(e instanceof ExportCancelled)) setErr(e instanceof Error ? e.message : String(e)); }
    finally { setProg(null); abort.current = null; }
  };

  const busy = !!prog;
  const pct = prog ? (prog.stage === "video" ? prog.frame / prog.frames : prog.stage === "audio" ? (prog.pct ?? 0) * 0.05 : prog.stage === "finish" ? 1 : 0) : 0;
  return (
    <div className="ed-modal" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="ed-dialog">
        <div className="hd"><Download size={16} />Export<span style={{ flex: 1 }} />{!busy && <button className="eb icon sm" onClick={onClose}><X size={16} /></button>}</div>
        <div className="bd">
          {done ? <div style={{ textAlign: "center", padding: 20 }}>
            <CheckCircle2 size={44} color="#5be3a0" /><h3>Export complete</h3>
            {done.map(f => <div key={f} className="ed-note" style={{ wordBreak: "break-all" }}>{f}</div>)}
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
              <button className="eb solid" onClick={() => invoke("reveal_path", { path: done[0] }).catch(() => {})}><FolderOpen size={14} />Show in folder</button>
              <button className="eb solid" onClick={() => invoke("open_path_default", { path: done[0] }).catch(() => {})}>Play</button>
            </div>
          </div> : busy ? <div style={{ padding: "18px 6px" }}>
            <div style={{ marginBottom: 8, fontWeight: 600 }}>{prog!.stage === "prepare" ? "Preparing…" : prog!.stage === "audio" ? "Mixing audio…" : prog!.stage === "finish" ? "Finishing & checking the file…" : `Rendering ${prog!.frame} / ${prog!.frames} frames`}</div>
            <div className="ed-bar"><div style={{ width: `${Math.round(pct * 100)}%` }} /></div>
            <div className="ed-note">{prog!.stage === "video" ? `${prog!.fps.toFixed(1)} fps · about ${s2(prog!.eta)} left · ${prog!.encoder ?? ""}` : ""}</div>
          </div> : <div className="ed-form">
            <label>Title</label><input value={name} onChange={e => setName(e.target.value)} />
            <label>Export to</label><div style={{ display: "flex", gap: 6 }}><input value={dir} onChange={e => setDir(e.target.value)} style={{ flex: 1 }} /><button className="eb solid sm" onClick={async () => { const d = await openDlg({ directory: true }); if (typeof d === "string") setDir(d); }}><FolderOpen size={14} /></button></div>
            <label><input type="checkbox" checked={video} onChange={e => { setVideo(e.target.checked); if (e.target.checked) setAudioOnly(false); }} /> Video</label><span />
            {video && <>
              <label>Resolution</label><select value={res} onChange={e => setRes(+e.target.value)}>{RES.map(([l, v]) => <option key={v} value={v}>{l}</option>)}</select>
              <label>Size</label><span className="ed-note" style={{ margin: 0 }}>{W} × {H} · {(dur / 1e6).toFixed(1)} s</span>
              <label>Quality</label><select value={qual} onChange={e => setQual(e.target.value)}><option value="lower">Smaller file</option><option value="recommended">Recommended</option><option value="higher">Higher quality</option></select>
              <label>Codec</label><select value={codec} onChange={e => setCodec(e.target.value)}><option value="h264">H.264 (plays everywhere)</option><option value="hevc">HEVC / H.265 (smaller)</option><option value="av1">AV1 (smallest)</option><option value="prores">ProRes 422 HQ (.mov, editing)</option></select>
              <label>Frame rate</label><select value={fps} onChange={e => setFps(e.target.value)}>{["24000/1001", "24/1", "25/1", "30000/1001", "30/1", "50/1", "60/1"].map(f => <option key={f} value={f}>{(+f.split("/")[0] / +f.split("/")[1]).toFixed(f.includes("1001") ? 3 : 0)} fps</option>)}</select>
            </>}
            <label><input type="checkbox" checked={audioOnly} onChange={e => { setAudioOnly(e.target.checked); if (e.target.checked) setVideo(false); }} /> Audio only</label>
            {audioOnly ? <select value={afmt} onChange={e => setAfmt(e.target.value)}><option value="mp3">MP3</option><option value="wav">WAV</option><option value="m4a">AAC (M4A)</option><option value="flac">FLAC</option></select> : <span />}
            <label><input type="checkbox" checked={subs} onChange={e => setSubs(e.target.checked)} disabled={!captionList(p).length} /> Captions (.srt)</label><span className="ed-note" style={{ margin: 0 }}>{captionList(p).length ? `${captionList(p).length} captions` : "No captions in this project"}</span>
          </div>}
          {err && <div className="ed-note" style={{ color: "#ff9a9a", whiteSpace: "pre-wrap" }}>Export failed: {err}</div>}
          {!busy && !done && pending.length > 0 && <div className="ed-note" style={{ color: "#f6b73c" }}><Loader2 size={12} className="spin" /> Waiting for {pending.length} clip{pending.length > 1 ? "s" : ""} to finish preparing (see the timeline). Export unlocks automatically.</div>}
          {!busy && !done && dur <= 0 && <div className="ed-note">The timeline is empty.</div>}
        </div>
        <div className="ft">
          {busy ? <button className="eb solid" onClick={() => abort.current?.abort()}>Cancel</button>
            : done ? <button className="eb primary" onClick={onClose}>Done</button>
            : <><button className="eb" onClick={onClose}>Cancel</button><button className="eb primary" disabled={!dir || !name.trim() || dur <= 0 || pending.length > 0 || (!video && !audioOnly)} onClick={run}><Download size={14} />Export</button></>}
        </div>
      </div>
    </div>
  );
}
