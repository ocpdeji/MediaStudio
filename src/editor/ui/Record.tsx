import { useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { ed } from "../api";
import { addClips, uid } from "../model";
import { importPaths, notify, useEd } from "../store";

/** Record a voiceover from the microphone straight onto an audio track at the playhead. */
export function RecordButton() {
  const [rec, setRec] = useState<{ start: number; t: number } | null>(null);
  const mr = useRef<MediaRecorder | null>(null);
  const [secs, setSecs] = useState(0);
  const start = async () => {
    const id = useEd.getState().id; if (!id) return;
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return notify(`Microphone unavailable: ${e}. Check Windows Settings → Privacy → Microphone.`); }
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm" });
    r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const at = useEd.getState().t;
    r.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      try {
        const bytes = new Uint8Array(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
        if (bytes.length < 500) return notify("Recording was empty", "info");
        const path = await ed.writeAsset(id, `voiceover-${Date.now()}.webm`, bytes);
        const [mid] = await importPaths([path]);
        const m = useEd.getState().p?.media[mid]; if (!m) return;
        useEd.getState().commit(pp => addClips(pp, [{ id: uid(), type: "audio", start: at, dur: Math.max(100_000, m.duration), media: mid, in: 0, speed: 1, volume: 1, name: "Voiceover" }], { at, toMain: false }));
        notify("Voiceover added", "ok");
      } catch (e) { notify(`Saving the recording failed: ${e}`); }
    };
    r.start(250); mr.current = r;
    const s0 = Date.now(); setRec({ start: s0, t: at }); setSecs(0);
    useEd.getState().setPlaying(true);
    const iv = window.setInterval(() => { if (!mr.current) { clearInterval(iv); return; } setSecs(Math.floor((Date.now() - s0) / 1000)); }, 250);
  };
  const stop = () => { mr.current?.stop(); mr.current = null; setRec(null); useEd.getState().setPlaying(false); };
  return rec
    ? <button className="eb sm" style={{ color: "#ff5c6c" }} title="Stop recording" onClick={stop}><Square size={13} fill="currentColor" />Rec {secs}s</button>
    : <button className="eb icon sm" title="Record voiceover" onClick={start}><Mic size={15} /></button>;
}
