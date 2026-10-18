import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errText, JobRow } from "./lib/api";
import { useStore } from "./lib/store";
import { addFolder, runCmd, setField } from "./lib/actions";
import { gridInfo, Browser } from "./components/Browser";
import { FilterBar, Inspector, JobsDrawer, Sidebar, StatusBar, TopBar } from "./components/Panels";
import { Slideshow, Viewer } from "./components/Viewer";
import { AudioDialog, CommandPalette, ContactDialog, ConvertDialog, HelpDialog, ImagesDialog, JoinDialog, QuickDialog, RenameDialog, SettingsDialog, SimilarDialog, Toasts, Tour } from "./components/Dialogs";
import { AskHost, ContextMenu, Splitter } from "./components/ui";
import { ImageEditor } from "./workspaces/ImageEditor";
import { Home } from "./editor/ui/Home";
import { Editor } from "./editor/ui/Editor";
import { editorJobEvent, setNotifier, useEd } from "./editor/store";
import { ed } from "./editor/api";
import { newProject } from "./editor/model";
import { Enhance } from "./workspaces/Enhance";

function LibraryWorkspace() {
  const { layout, setLayout } = useStore();
  return (
    <div className="workspace">
      {layout.showSidebar && <><div style={{ width: layout.sidebar, display: "flex", flex: "none" }}><Sidebar /></div><Splitter value={layout.sidebar} min={180} max={420} onChange={v => setLayout({ sidebar: v })} /></>}
      {!layout.loupe && <div className="browser grow"><FilterBar /><Browser /></div>}
      {!layout.loupe && <Splitter value={layout.viewer} min={300} max={1400} invert onChange={v => setLayout({ viewer: v })} />}
      <div style={{ width: layout.loupe ? undefined : `min(${layout.viewer}px, 46%)`, flex: layout.loupe ? 1 : "none", display: "flex", flexDirection: "column", minWidth: 0 }}><Viewer /></div>
      {layout.showInspector && <><Splitter value={layout.inspector} min={240} max={520} invert onChange={v => setLayout({ inspector: v })} /><div style={{ width: layout.inspector, display: "flex", flex: "none" }}><Inspector /></div></>}
    </div>
  );
}

function DialogHost() {
  const { dialog, setDialog } = useStore();
  if (!dialog) return null;
  const close = () => setDialog(null);
  const ids = dialog.ids ?? [];
  switch (dialog.kind) {
    case "rename": return <RenameDialog ids={ids} onClose={close} />;
    case "quick": return <QuickDialog ids={ids} onClose={close} />;
    case "join": return <JoinDialog ids={ids} onClose={close} />;
    case "convert": return <ConvertDialog ids={ids} onClose={close} />;
    case "audio": return <AudioDialog ids={ids} onClose={close} />;
    case "images": return <ImagesDialog ids={ids} onClose={close} />;
    case "contact": return <ContactDialog ids={ids} onClose={close} />;
    case "similar": return <SimilarDialog onClose={close} />;
    case "settings": return <SettingsDialog onClose={close} />;
    case "help": return <HelpDialog onClose={close} />;
    case "jobs": return <JobsDrawer onClose={close} />;
    case "slideshow": return <Slideshow onClose={close} />;
    case "tour": return <Tour onClose={close} />;
    default: return null;
  }
}

export default function App() {
  const { ready, workspace, init } = useStore();

  useEffect(() => {
    init().then(() => { try { if (!localStorage.getItem("msp.tour")) useStore.getState().setDialog({ kind: "tour" }); } catch { /* ignore */ } });
    let refreshT: number | undefined;
    const soon = (ms = 400) => { clearTimeout(refreshT); refreshT = window.setTimeout(() => useStore.getState().refresh(), ms); };
    const uns = [
      listen<any>("scan", e => {
        const p = e.payload, s = useStore.getState();
        if (p.done) {
          const { [p.library_id]: _, ...rest } = s.scanning; void _; useStore.setState({ scanning: rest });
          if (p.error) s.toast(`Scan failed: ${p.error}`, "error");
          else if (p.added || p.changed || p.missing || p.moved) s.toast(`Scan complete: ${p.added} new · ${p.changed} changed · ${p.moved} moved · ${p.missing} missing`, "ok");
          s.refresh(); s.refreshMeta();
        } else useStore.setState({ scanning: { ...s.scanning, [p.library_id]: p.found } });
      }),
      listen("library-changed", () => { soon(); useStore.getState().refreshMeta(); }),
      listen("assets-probed", () => soon(1200)),
      listen<JobRow>("job", e => {
        const s = useStore.getState(), prev = s.jobs.find(j => j.id === e.payload.id), j = e.payload;
        s.upsertJob(j);
        editorJobEvent(j);
        if (prev?.status !== j.status) {
          if (j.status === "done") {
            window.dispatchEvent(new Event("msp-job-done"));
            // the editor reports its own background work (prepare, captions…) in context
            const quiet = j.kind === "prepare" || (["audiofx", "reverse", "stabilize", "download", "captions", "voiceover", "ai", "stock"].includes(j.kind) && s.workspace === "editor");
            const out = j.result?.outputs?.[0];
            if (!quiet) s.toast(`Finished: ${j.title}${j.result?.notes?.length ? "\n" + j.result.notes.slice(0, 2).join("\n") : ""}`, "ok", out ? { label: "Show file", run: () => api.resolveMedia(out).then(a => (a ? api.reveal(a.id) : undefined)).catch(err => s.toast(errText(err), "error")) } : undefined);
          } else if (j.status === "failed") s.toast(`Failed: ${j.title}\n${j.error ?? ""}`, "error", { label: "Details", run: () => s.setDialog({ kind: "jobs" }) });
        }
      }),
      getCurrentWebview().onDragDropEvent(e => { if (e.payload.type === "drop") for (const p of e.payload.paths) void addFolder(p); }),
    ];
    return () => { uns.forEach(u => u.then(f => f())); };
  }, []); // eslint-disable-line

  useEffect(() => { if (workspace !== "editor" && workspace !== "home") getCurrentWindow().setTitle(`Media Studio Pro — ${{ library: "Library", image: "Photo editor", video: "Video editor", enhance: "Enhance" }[workspace]}`).catch(() => {}); }, [workspace]);

  // "Video editor" from the library: new project with the selected media
  useEffect(() => {
    if (workspace !== "video") return;
    const s = useStore.getState(); const paths = s.assets.filter(a => s.editIds.includes(a.id)).map(a => a.path);
    (async () => {
      const m = await ed.create(`Project ${new Date().toLocaleDateString()}`, newProject("Untitled"));
      await useEd.getState().open(m.id);
      useStore.setState({ workspace: "editor" });
      if (paths.length) { const { importPaths } = await import("./editor/store"); await importPaths(paths, true); }
    })().catch(e => { s.toast(errText(e), "error"); useStore.setState({ workspace: "home" }); });
  }, [workspace]);
  useEffect(() => { setNotifier((text, kind) => useStore.getState().toast(text, kind)); const h = () => useStore.getState().open("enhance", []); window.addEventListener("msp-open-enhance", h); return () => window.removeEventListener("msp-open-enhance", h); }, []);

  // global shortcuts (library workspace; editors handle their own)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey, key = e.key;
      if (s.workspace === "editor" && !(mod && key.toLowerCase() === "j")) return;
      if (mod && key.toLowerCase() === "k") { e.preventDefault(); useStore.setState({ palette: !s.palette }); return; }
      if (mod && ["1", "2", "3", "4"].includes(key)) { e.preventDefault(); s.open((["library", "image", "video", "enhance"] as const)[+key - 1], s.workspace === "library" ? s.targetIds() : s.editIds); return; }
      if (mod && key.toLowerCase() === "j") { e.preventDefault(); s.setDialog(s.dialog?.kind === "jobs" ? null : { kind: "jobs" }); return; }
      if (mod && key === ",") { e.preventDefault(); s.setDialog({ kind: "settings" }); return; }
      if (s.workspace === "editor" || s.workspace === "home") return;
      if (s.palette || (s.dialog && s.dialog.kind !== "jobs") || s.workspace !== "library") return;
      if ((e.target as HTMLElement).closest("input,textarea,select,[contenteditable]")) return;
      const run = (id: string) => { e.preventDefault(); runCmd(id); };
      if (mod) {
        const m: Record<string, string> = { a: "sel.all", o: "folder.add", e: "file.reveal", b: "view.sidebar", f: "" };
        const kk = key.toLowerCase();
        if (kk === "f") { e.preventDefault(); window.dispatchEvent(new Event("msp-focus-search")); return; }
        if (kk === "c") return run(e.shiftKey ? "copy.paths" : "copy.names");
        if (kk === "i" && e.shiftKey) return run("sel.invert");
        if (m[kk]) return run(m[kk]);
        return;
      }
      const cols = s.layout.mode === "grid" && !s.layout.loupe ? gridInfo.cols : 1;
      const nav = (d: number) => { e.preventDefault(); const before = s.focus; s.move(d); if (e.shiftKey && before != null) { const after = useStore.getState().focus!; useStore.setState({ anchor: before }); useStore.getState().select(after, "range"); } };
      switch (key) {
        case "ArrowRight": return nav(1); case "ArrowLeft": return nav(-1);
        case "ArrowDown": return nav(cols); case "ArrowUp": return nav(-cols);
        case "PageDown": return nav(cols * gridInfo.rows); case "PageUp": return nav(-cols * gridInfo.rows);
        case "Home": e.preventDefault(); return s.move(-1e9); case "End": e.preventDefault(); return s.move(1e9);
        case "Enter": return run("loupe");
        case "Escape": if (s.layout.loupe) s.setLayout({ loupe: false }); else if (s.compare) useStore.setState({ compare: null }); else s.clearSelection(); return;
        case "Delete": return run("file.recycle");
        case "F2": return run("file.rename");
        case "F5": return run("folder.rescan");
        case "?": return run("app.help");
        case "/": e.preventDefault(); window.dispatchEvent(new Event("msp-focus-search")); return;
      }
      const kk = key.toLowerCase();
      if (/^[0-5]$/.test(key)) { e.preventDefault(); setField("rating", +key); return; }
      if (/^[6-9]$/.test(key)) { e.preventDefault(); const c = (["red", "orange", "yellow", "green"] as const)[+key - 6]; setField("color", s.focusAsset()?.color === c ? null : c); return; }
      const m: Record<string, string> = { f: "fav", x: "reject", c: "compare", p: "slideshow", g: "view.grid", i: "view.inspector", t: "tag", e: "edit.open" };
      if (m[kk]) return run(m[kk]);
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);

  if (!ready) return <div className="empty" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>Loading…</div>;
  const openProject = async (id: string) => { try { await useEd.getState().open(id); useStore.setState({ workspace: "editor" }); } catch (e) { useStore.getState().toast(errText(e), "error"); } };
  if (workspace === "home" || workspace === "editor" || workspace === "video") return (
    <>
      {workspace === "editor" ? <Editor onHome={() => useStore.setState({ workspace: "home" })} /> : <Home onOpen={openProject} onWorkspace={w => useStore.getState().open(w, [])} />}
      <DialogHost /><ContextMenu /><AskHost /><Toasts />
    </>
  );
  return (
    <div className="app" onContextMenu={e => { if (!(e.target as HTMLElement).closest("input,textarea")) e.preventDefault(); }}>
      <TopBar />
      <main style={{ minHeight: 0, display: "flex" }}>
        <div className="grow" style={{ display: "flex", minWidth: 0 }}>
          {workspace === "library" && <LibraryWorkspace />}
          {workspace === "image" && <div className="grow"><ImageEditor /></div>}
          {workspace === "enhance" && <div className="grow"><Enhance /></div>}
        </div>
      </main>
      <StatusBar />
      <DialogHost /><CommandPalette /><ContextMenu /><AskHost /><Toasts />
    </div>
  );
}
