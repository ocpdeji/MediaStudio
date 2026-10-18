import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, Bot, Check, ChevronDown, CloudUpload, Download, Home, Keyboard, Loader2, Redo2, Undo2 } from "lucide-react";
import "./editor.css";
import { useEd, importPaths, saveNow, notify } from "../store";
import { duration, frameUs, SEC } from "../model";
import { LeftPanel } from "./LeftPanel";
import { Player, requestCover } from "./Player";
import { Inspector } from "./Inspector";
import { Timeline, useCommands } from "./Timeline";
import { ExportDialog } from "./ExportDialog";
import { AiSettings } from "./AiSettings";
import { ensureCubeLuts } from "./previewBridge";
import { ed } from "../api";

const LAYOUT_KEY = "msp.editor.layout";
function loadLayout(): { left: number; right: number; tl: number } { try { return { left: 420, right: 320, tl: 300, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") }; } catch { return { left: 420, right: 320, tl: 300 }; } }

export function Editor({ onHome }: { onHome: () => void }) {
  const p = useEd(s => s.p);
  const save = useEd(s => s.save), canUndo = useEd(s => s.canUndo), canRedo = useEd(s => s.canRedo);
  const [lay, setLay] = useState(loadLayout);
  const [exp, setExp] = useState(false);
  const [ai, setAi] = useState<null | "models" | "keys">(null);
  const [menu, setMenu] = useState(false);
  const [keys, setKeys] = useState(false);
  const cmd = useCommands();
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(lay)); } catch { /* */ } }, [lay]);
  useEffect(() => { if (p) { void ensureCubeLuts(p); getCurrentWindow().setTitle(`${p.name} — Media Studio Pro`).catch(() => {}); } }, [p?.id, p?.name]); // eslint-disable-line
  // cover thumbnail for the Home screen, refreshed periodically
  useEffect(() => { const iv = window.setInterval(requestCover, 25_000); const t = window.setTimeout(requestCover, 3000); return () => { clearInterval(iv); clearTimeout(t); }; }, []);
  useEffect(() => { const h = () => setAi("keys"); window.addEventListener("msp-ai-settings", h); return () => window.removeEventListener("msp-ai-settings", h); }, []);

  // drop files from Explorer into the project
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(e => { if (e.payload.type === "drop" && e.payload.paths.length) void importPaths(e.payload.paths).then(ids => ids.length && notify(`Imported ${ids.length} item${ids.length > 1 ? "s" : ""}`, "ok")); });
    return () => { void un.then(f => f()); };
  }, []);

  // keyboard shortcuts (CapCut-compatible where possible)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (exp || ai) return;
      const tgt = e.target as HTMLElement;
      if (tgt.closest("input,textarea,select,[contenteditable]")) { if (e.key === "Escape") tgt.blur(); return; }
      const st = useEd.getState(); if (!st.p) return;
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      const run = (f: () => void) => { e.preventDefault(); f(); };
      if (mod && key === "z") return run(() => (e.shiftKey ? st.redo() : st.undo()));
      if (mod && key === "y") return run(() => st.redo());
      if (mod && key === "b") return run(cmd.split);
      if (mod && key === "d") return run(cmd.duplicate);
      if (mod && key === "c") return run(cmd.copy);
      if (mod && key === "v") return run(cmd.paste);
      if (mod && key === "a") return run(() => st.select(st.p!.tracks.flatMap(t => t.clips.map(c => c.id))));
      if (mod && key === "s") return run(() => { void saveNow(); notify("Saved", "ok"); });
      if (mod && key === "e") return run(() => setExp(true));
      if (mod) return;
      const fu = frameUs(st.p);
      switch (e.key) {
        case " ": return run(() => st.setPlaying(!st.playing));
        case "ArrowLeft": return run(() => { st.setPlaying(false); st.seek(st.t - (e.shiftKey ? SEC : fu)); });
        case "ArrowRight": return run(() => { st.setPlaying(false); st.seek(st.t + (e.shiftKey ? SEC : fu)); });
        case "Home": return run(() => st.seek(0));
        case "End": return run(() => st.seek(duration(st.p!)));
        case "Delete": case "Backspace": return run(cmd.del);
        case "Escape": return run(() => st.select([]));
      }
      if (key === "q") return run(() => cmd.trimTo("left"));
      if (key === "w") return run(() => cmd.trimTo("right"));
      if (key === "m") return run(cmd.marker);
      if (key === "s" && !e.shiftKey) return run(() => st.commit(pp => ({ ...pp, snap: !pp.snap })));
      if (key === "+" || key === "=") return run(() => st.setZoom(st.zoom * 1.3));
      if (key === "-") return run(() => st.setZoom(st.zoom / 1.3));
      if (key === "?") return run(() => setKeys(true));
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [exp, ai, cmd]);

  if (!p) return <div className="ed" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}><Loader2 className="spin" /></div>;

  const drag = (k: "left" | "right" | "tl", sign: 1 | -1, axis: "x" | "y") => (e: React.PointerEvent) => {
    const s0 = axis === "x" ? e.clientX : e.clientY, v0 = lay[k];
    const mv = (ev: PointerEvent) => setLay(l => ({ ...l, [k]: Math.max(k === "tl" ? 160 : 260, Math.min(k === "tl" ? innerHeight - 260 : 760, v0 + sign * ((axis === "x" ? ev.clientX : ev.clientY) - s0))) }));
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
  const home = async () => { useEd.getState().setPlaying(false); await saveNow(); requestCover(); await new Promise(r => setTimeout(r, 120)); await useEd.getState().close(); onHome(); };

  return (
    <div className="ed" style={{ ["--tl-h" as any]: `${lay.tl}px` }}>
      <div className="ed-top" style={{ position: "relative" }}>
        <div style={{ position: "relative" }}>
          <button className="eb sm" onClick={() => setMenu(!menu)}>Menu<ChevronDown size={13} /></button>
          {menu && <div className="menu" style={{ position: "absolute", top: 32, left: 0, minWidth: 230, zIndex: 40 }} onMouseLeave={() => setMenu(false)}>
            {([["Home (projects)", home], ["Save now", () => { void saveNow(); notify("Saved", "ok"); }, "Ctrl+S"], ["Export…", () => setExp(true), "Ctrl+E"],
              ["Show project folder", () => ed.reveal(p.id)], ["AI models…", () => setAi("models")], ["AI keys (BYOK)…", () => setAi("keys")], ["Keyboard shortcuts", () => setKeys(true), "?"]] as [string, () => void, string?][])
              .map(([l, f, kk]) => <div key={l} className="mi" onClick={() => { setMenu(false); f(); }}>{l}{kk && <span className="k">{kk}</span>}</div>)}
          </div>}
        </div>
        <button className="eb icon sm" title="Home" onClick={home}><Home size={15} /></button>
        <span className="save">{save === "saved" ? <><Check size={13} />Auto-saved</> : save === "saving" ? <><Loader2 size={13} className="spin" />Saving…</> : save === "error" ? <span style={{ color: "#ff8a8a", display: "flex", gap: 4 }}><AlertTriangle size={13} />Save failed — retrying</span> : <><CloudUpload size={13} />Unsaved</>}</span>
        <button className="eb icon sm" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => useEd.getState().undo()}><Undo2 size={15} /></button>
        <button className="eb icon sm" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => useEd.getState().redo()}><Redo2 size={15} /></button>
        <div className="name"><input value={p.name} aria-label="Project name" onChange={e => useEd.getState().live(pp => ({ ...pp, name: e.target.value }))} onBlur={e => { if (!e.target.value.trim()) useEd.getState().live(pp => ({ ...pp, name: "Untitled" })); useEd.getState().endLive(); }} onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></div>
        <span style={{ flex: 1 }} />
        <button className="eb sm" title="AI models & keys" onClick={() => setAi("models")}><Bot size={15} />AI</button>
        <button className="eb icon sm" title="Shortcuts (?)" onClick={() => setKeys(true)}><Keyboard size={15} /></button>
        <button className="eb primary" onClick={() => setExp(true)}><Download size={15} />Export</button>
      </div>
      <div className="ed-main" style={{ ["--left-w" as any]: `${lay.left}px`, ["--right-w" as any]: `${lay.right}px` }}>
        <LeftPanel />
        <div className="ed-split" onPointerDown={drag("left", 1, "x")} />
        <Player />
        <div className="ed-split" onPointerDown={drag("right", -1, "x")} />
        <Inspector />
      </div>
      <div className="ed-hsplit" onPointerDown={drag("tl", -1, "y")} />
      <Timeline />
      {exp && <ExportDialog onClose={() => setExp(false)} />}
      {ai && <AiSettings initial={ai} onClose={() => setAi(null)} />}
      {keys && <Shortcuts onClose={() => setKeys(false)} />}
    </div>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [["Space", "Play / pause"], ["← / →", "Previous / next frame (Shift: 1 second)"], ["Home / End", "Start / end"], ["Ctrl+B", "Split at playhead"], ["Q / W", "Delete left / right of playhead"], ["Delete", "Delete (main track closes the gap)"],
    ["Ctrl+C / Ctrl+V", "Copy / paste at playhead"], ["Ctrl+D", "Duplicate"], ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"], ["Ctrl+A", "Select all"], ["M", "Add marker"], ["S", "Toggle snapping"], ["+ / − / Ctrl+wheel", "Zoom timeline"], ["Shift+wheel", "Scroll timeline"],
    ["Ctrl+S", "Save"], ["Ctrl+E", "Export"], ["Double-click text", "Edit text"], ["Drag in player", "Move · corners scale · top handle rotates (Shift snaps 15°, Alt disables centre snap)"]];
  return <div className="ed-modal" onMouseDown={e => e.target === e.currentTarget && onClose()}><div className="ed-dialog" style={{ width: 560 }}><div className="hd"><Keyboard size={16} />Keyboard shortcuts</div>
    <div className="bd"><div className="ed-form">{rows.map(([k, v]) => <><kbd key={k} className="ekbd" style={{ fontSize: 12, padding: "2px 6px", justifySelf: "start" }}>{k}</kbd><span key={v}>{v}</span></>)}</div></div>
    <div className="ft"><button className="eb primary" onClick={onClose}>Close</button></div></div></div>;
}
