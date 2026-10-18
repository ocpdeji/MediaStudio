import { useEffect, useState } from "react";
import { Bot, CheckCircle2, Download, ExternalLink, KeyRound, Loader2, Trash2, X } from "lucide-react";
import { ed, ModelStatus, ProviderRow } from "../api";
import { notify, watchJob } from "../store";

const GROUPS: Record<string, string> = { captions: "Captions & transcription (Whisper)", voices: "Text to speech (Piper voices)", cutout: "Background removal", audio: "Audio AI", enhance: "Enhance" };

export function AiSettings({ onClose, initial = "models" }: { onClose: () => void; initial?: "models" | "keys" }) {
  const [tab, setTab] = useState(initial);
  return (
    <div className="ed-modal" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} style={{ zIndex: 70 }}>
      <div className="ed-dialog ed" style={{ position: "relative", inset: "auto", display: "flex", width: "min(860px, 95vw)", height: "min(760px, 92vh)" }}>
        <div className="hd"><Bot size={16} />AI models & keys<span style={{ flex: 1 }} /><button className="eb icon sm" onClick={onClose}><X size={16} /></button></div>
        <div className="ed-rtabs" style={{ padding: "0 16px" }}>
          <button className={`ed-rtab ${tab === "models" ? "on" : ""}`} onClick={() => setTab("models")}>Free offline models</button>
          <button className={`ed-rtab ${tab === "keys" ? "on" : ""}`} onClick={() => setTab("keys")}>Your API keys (BYOK)</button>
        </div>
        <div className="bd" style={{ flex: 1 }}>{tab === "models" ? <Models /> : <Keys />}</div>
      </div>
    </div>
  );
}

function Models() {
  const [list, setList] = useState<ModelStatus[]>([]);
  const [jobs, setJobs] = useState<Record<string, number>>({});
  const load = () => ed.models().then(setList).catch(e => notify(String(e)));
  useEffect(() => { void load(); }, []);
  const install = async (id: string) => {
    const j = await ed.installModel(id); setJobs(s => ({ ...s, [id]: 0 }));
    return new Promise<void>(res => watchJob(j, { progress: p => setJobs(s => ({ ...s, [id]: p })), done: () => { setJobs(s => { const n = { ...s }; delete n[id]; return n; }); void load(); res(); }, fail: e => { setJobs(s => { const n = { ...s }; delete n[id]; return n; }); notify(`${id}: ${e}`); res(); } }));
  };
  const missing = list.filter(m => !m.installed && m.recommended && !(m.id in jobs));
  const total = missing.reduce((a, m) => a + m.mb, 0);
  const installAll = async () => { for (const m of missing) await install(m.id); notify("All recommended models are installed", "ok"); };
  const groups = [...new Set(list.map(m => m.group))];
  return <>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <div className="ed-note" style={{ flex: 1, margin: 0 }}>Free, open-source AI that runs on this PC — no account, nothing uploaded. Download once; they're stored in your app data folder.</div>
      <button className="eb primary" disabled={!missing.length} onClick={installAll}><Download size={14} />{missing.length ? `Download all (${(total / 1024).toFixed(1)} GB)` : "All installed"}</button>
    </div>
    {groups.map(g => <div key={g} className="ed-sec">
      <div className="t">{GROUPS[g] ?? g}</div>
      {list.filter(m => m.group === g).map(m => <div key={m.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #232328" }}>
        <div><b>{m.name}</b> <span className="ed-pill">{m.mb >= 1 ? `${Math.round(m.mb)} MB` : "<1 MB"}</span><div className="ed-note" style={{ margin: "2px 0" }}>{m.desc} <span style={{ color: "#6a6a73" }}>Licence: {m.license}</span></div>
          {m.id in jobs && <div className="ed-bar" style={{ marginTop: 4 }}><div style={{ width: `${Math.max(3, jobs[m.id] * 100)}%` }} /></div>}</div>
        <div>{m.installed ? <span style={{ display: "flex", gap: 6, alignItems: "center", color: "#5be3a0" }}><CheckCircle2 size={16} />Installed<button className="eb icon sm" title="Remove" onClick={async () => { await ed.removeModel(m.id); void load(); }}><Trash2 size={13} /></button></span>
          : m.id in jobs ? <span className="ed-note"><Loader2 size={13} className="spin" /> {Math.round(jobs[m.id] * 100)}%</span>
          : <button className="eb sm solid" onClick={() => install(m.id)}><Download size={13} />Download</button>}</div>
      </div>)}
    </div>)}
  </>;
}

function Keys() {
  const [list, setList] = useState<ProviderRow[]>([]);
  const [edit, setEdit] = useState<string | null>(null);
  const [key, setKey] = useState(""); const [cfg, setCfg] = useState<ProviderRow["cfg"] | null>(null); const [test, setTest] = useState<string | null>(null);
  const load = () => ed.providers().then(setList).catch(e => notify(String(e)));
  useEffect(() => { void load(); }, []);
  const save = async (p: ProviderRow) => {
    try { await ed.setProvider(p.id, key ? key : null, cfg); setKey(""); setEdit(null); void load(); notify(`${p.name} saved`, "ok"); } catch (e) { notify(String(e)); }
  };
  const tryIt = async (p: ProviderRow) => { setTest("Testing…"); try { const r = await ed.chat(p.id, "Reply with the single word OK.", "Say OK"); setTest(`Works: “${r.trim().slice(0, 60)}”`); } catch (e) { setTest(String(e)); } };
  return <>
    <div className="ed-note">Bring your own key for cloud AI. Keys are stored in <b>Windows Credential Manager</b> (encrypted for your Windows account), never in project files, and are only sent to that provider. Local options (Ollama, LM Studio) need no key and are free.</div>
    {list.map(p => <div key={p.id} className="ed-sec">
      <div className="t"><KeyRound size={14} color={p.has_key ? "#5be3a0" : "#6a6a73"} />{p.name}<span className="ed-pill">{p.caps.join(" · ")}</span><span className="grow" />
        {p.has_key && p.needs_key && <span style={{ color: "#5be3a0", fontSize: 11.5 }}>Key saved</span>}
        <button className="eb sm solid" onClick={() => { setEdit(edit === p.id ? null : p.id); setKey(""); setCfg(p.cfg); setTest(null); }}>{edit === p.id ? "Close" : p.needs_key ? (p.has_key ? "Change" : "Add key") : "Settings"}</button></div>
      <div className="ed-note" style={{ marginTop: -4 }}>{p.note} {p.key_url && <a href="#" onClick={e => { e.preventDefault(); void import("@tauri-apps/plugin-opener").then(o => o.openUrl(p.key_url)); }}>Get a key <ExternalLink size={11} /></a>}</div>
      {edit === p.id && cfg && <div className="ed-form" style={{ marginTop: 8 }}>
        {p.needs_key && <><label>API key</label><input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={p.has_key ? "•••••• (leave empty to keep)" : "Paste key"} /></>}
        {(p.id === "custom" || p.caps.includes("chat")) && <><label>Endpoint</label><input value={cfg.base} onChange={e => setCfg({ ...cfg, base: e.target.value })} placeholder={p.base || "https://…/v1"} /></>}
        {(p.caps.includes("chat") || p.caps.includes("tts")) && <><label>{p.id === "elevenlabs" ? "Voice id" : "Model"}</label><input value={p.id === "elevenlabs" ? cfg.tts_model : cfg.model} onChange={e => setCfg(p.id === "elevenlabs" ? { ...cfg, tts_model: e.target.value } : { ...cfg, model: e.target.value })} placeholder={p.id === "elevenlabs" ? p.tts_model : p.model} /></>}
        {p.caps.includes("image") && <><label>Image model</label><input value={cfg.image_model} onChange={e => setCfg({ ...cfg, image_model: e.target.value })} placeholder={p.image_model} /></>}
        {p.caps.includes("video") && <><label>Video model</label><input value={cfg.video_model} onChange={e => setCfg({ ...cfg, video_model: e.target.value })} placeholder={p.video_model} /></>}
        {p.caps.includes("tts") && p.id === "openai" && <><label>Voice model</label><input value={cfg.tts_model} onChange={e => setCfg({ ...cfg, tts_model: e.target.value })} placeholder={p.tts_model} /></>}
        <span /><div style={{ display: "flex", gap: 6 }}>
          <button className="eb primary sm" onClick={() => save(p)}>Save</button>
          {p.caps.includes("chat") && <button className="eb sm solid" onClick={async () => { await save(p); void tryIt(p); }}>Save & test</button>}
          {p.has_key && p.needs_key && <button className="eb sm danger" onClick={async () => { await ed.setProvider(p.id, "", null); void load(); }}>Remove key</button>}
        </div>
        {test && <><span /><span className="ed-note" style={{ margin: 0 }}>{test}</span></>}
      </div>}
    </div>)}
  </>;
}
