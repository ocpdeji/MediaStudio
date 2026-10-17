import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ReactNode } from "react";
import * as I from "lucide-react";
import { api, Asset, Color, errText } from "./api";
import { useStore } from "./store";
import { confirmAsk, promptAsk } from "../components/ui";

const st = () => useStore.getState();
const ids = () => st().targetIds();
const sel = (): Asset[] => { const s = new Set(ids()); return st().assets.filter(a => s.has(a.id)); };
const need = (n = 1) => ids().length >= n;

export async function addFolder(path?: string) {
  const p = path ?? (await openDialog({ directory: true, multiple: false, title: "Add a folder to the library" }));
  if (!p || Array.isArray(p)) return;
  try { await api.addLibrary(p); st().toast(`Scanning “${p.split(/[\\/]/).pop()}”…`); await st().refreshMeta(); }
  catch (e) { st().toast(errText(e), "error"); }
}

export async function setField(field: "rating" | "favorite" | "rejected" | "color", value: unknown, idsIn = ids()) {
  if (!idsIn.length) return;
  try {
    await api.setField(idsIn, field, value);
    st().patchAssets(idsIn, { [field]: value } as Partial<Asset>);
    if (field === "rejected" && value && st().query.rejected !== "any") { st().toast(`Rejected ${idsIn.length} — hidden from view`, "info", { label: "Undo", run: () => setField("rejected", false, idsIn).then(() => st().refresh()) }); st().refresh(); }
    if (field === "rating") st().toast(value ? "★".repeat(value as number) : "Rating cleared");
  } catch (e) { st().toast(errText(e), "error"); }
}

async function copy(text: string, what: string) { await navigator.clipboard.writeText(text); st().toast(`Copied ${what}`, "ok"); }

export async function recycle() {
  const a = sel(); if (!a.length) return;
  const ok = await confirmAsk(`Move ${a.length} file${a.length > 1 ? "s" : ""} to the Recycle Bin?`, <>The file{a.length > 1 ? "s are" : " is"} removed from disk and the library. You can restore {a.length > 1 ? "them" : "it"} from the Windows Recycle Bin.<br /><br /><b>{a.slice(0, 5).map(x => x.name).join(", ")}{a.length > 5 ? ` and ${a.length - 5} more` : ""}</b></>, "Move to Recycle Bin", true);
  if (!ok) return;
  try { const n = await api.recycle(a.map(x => x.id)); st().toast(`Moved ${n} file(s) to the Recycle Bin`, "ok"); await st().refresh(); await st().refreshMeta(); }
  catch (e) { st().toast(errText(e), "error"); }
}

export async function exportManifest() {
  const a = sel(); if (!a.length) return;
  const path = await saveDialog({ title: "Export selection manifest", defaultPath: "selection.csv", filters: [{ name: "CSV", extensions: ["csv"] }, { name: "JSON", extensions: ["json"] }] });
  if (!path) return;
  const rows = a.map(x => ({ name: x.name, path: x.path, kind: x.kind, size: x.size, width: x.width, height: x.height, duration_ms: x.duration_ms, rating: x.rating, color: x.color, favorite: x.favorite }));
  const body = path.toLowerCase().endsWith(".json") ? JSON.stringify(rows, null, 2)
    : [Object.keys(rows[0]).join(","), ...rows.map(r => Object.values(r).map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))].join("\r\n");
  try { await api.writeText(path, body, "manifest"); st().toast(`Manifest saved (${a.length} items)`, "ok"); } catch (e) { st().toast(errText(e), "error"); }
}

export async function copyTo(mode: "copy" | "move") {
  const a = ids(); if (!a.length) return;
  const dest = await openDialog({ directory: true, title: mode === "copy" ? "Copy selected files to…" : "Move selected files to…" });
  if (!dest || Array.isArray(dest)) return;
  if (mode === "move" && !(await confirmAsk(`Move ${a.length} file(s) to “${dest}”?`, "Originals are moved (not copied). Existing files with the same name are never overwritten — new names get a _2 suffix.", "Move"))) return;
  await api.enqueue({ type: "copy_to", asset_ids: a, dest, mode }, `${mode === "copy" ? "Copy" : "Move"} ${a.length} file(s) → ${dest.split(/[\\/]/).pop()}`);
  st().toast("Added to the job queue");
}

export async function addTag() {
  const a = ids(); if (!a.length) return;
  const name = await promptAsk(`Add a tag to ${a.length} item(s)`, "", "Tags are stored in the catalogue — your files are not modified.");
  if (!name?.trim()) return;
  try { await api.tag(a, name.trim()); st().toast(`Tagged “${name.trim()}”`, "ok"); await st().refreshMeta(); } catch (e) { st().toast(errText(e), "error"); }
}

export async function addToCollection(id?: number) {
  const a = ids(); if (!a.length) return;
  try {
    let cid = id;
    if (cid == null) { const name = await promptAsk("New collection", "", `Create a collection with ${a.length} item(s). Collections are virtual — files stay where they are.`); if (!name?.trim()) return; cid = await api.collection("create", null, name.trim()); }
    await api.collection("add", cid, null, a); await st().refreshMeta(); st().toast(`Added ${a.length} to collection`, "ok");
  } catch (e) { st().toast(errText(e), "error"); }
}

export async function queueSimple(kind: "proxy" | "hashes") {
  const a = sel(); if (!a.length) return;
  if (kind === "proxy") { for (const x of a.filter(x => x.kind === "video")) await api.enqueue({ type: "proxy", asset_id: x.id }, `Proxy · ${x.name}`); st().toast("Proxy generation queued"); }
  else { await api.enqueue({ type: "hashes", asset_ids: a.filter(x => x.kind === "image").map(x => x.id) }, `Analyse ${a.length} image(s) for similarity`); }
}

export function editSelection() {
  const a = sel(); if (!a.length) return;
  if (a.length === 1 && (a[0].kind === "image" || a[0].kind === "raw")) return st().open("image", [a[0].id]);
  if (a.some(x => x.kind === "video" || x.kind === "audio") || a.length > 1) return st().open("video", a.map(x => x.id));
}

export interface Command { id: string; label: string; group: string; keys?: string; icon?: ReactNode; when?: () => boolean; run: () => void | Promise<void> }

export const commands: Command[] = [
  { id: "folder.add", group: "Library", label: "Add folder to library…", keys: "Ctrl+O", icon: <I.FolderPlus size={15} />, run: () => addFolder() },
  { id: "folder.rescan", group: "Library", label: "Rescan all folders", keys: "F5", icon: <I.RefreshCw size={15} />, run: async () => { for (const l of st().libraries) await api.rescan(l.id).catch(e => st().toast(errText(e), "error")); } },
  { id: "rate.0", group: "Review", label: "Clear rating", keys: "0", when: need, run: () => setField("rating", 0) },
  ...[1, 2, 3, 4, 5].map(n => ({ id: `rate.${n}`, group: "Review", label: `Rate ${"★".repeat(n)}`, keys: String(n), when: () => need(), run: () => setField("rating", n) })),
  { id: "fav", group: "Review", label: "Toggle favourite", keys: "F", icon: <I.Heart size={15} />, when: need, run: () => setField("favorite", !st().focusAsset()?.favorite) },
  { id: "reject", group: "Review", label: "Toggle reject flag", keys: "X", icon: <I.Ban size={15} />, when: need, run: () => setField("rejected", !st().focusAsset()?.rejected) },
  ...(["red", "orange", "yellow", "green", "blue", "purple"] as Color[]).map((c, i) => ({ id: `color.${c}`, group: "Review", label: `Colour label: ${c}`, keys: i < 4 ? String(6 + i) : undefined, when: () => need(), run: () => setField("color", st().focusAsset()?.color === c ? null : c) })),
  { id: "compare", group: "Review", label: "Compare selected side by side", keys: "C", icon: <I.Columns2 size={15} />, when: () => need(2), run: () => useStore.setState({ compare: ids().slice(0, 4) }) },
  { id: "similar", group: "Review", label: "Find similar / duplicate images…", icon: <I.ScanSearch size={15} />, run: () => st().setDialog({ kind: "similar" }) },
  { id: "slideshow", group: "Review", label: "Slideshow", keys: "P", icon: <I.Presentation size={15} />, run: () => st().setDialog({ kind: "slideshow" }) },
  { id: "loupe", group: "View", label: "Toggle large preview (loupe)", keys: "Enter", icon: <I.Maximize2 size={15} />, run: () => st().setLayout({ loupe: !st().layout.loupe }) },
  { id: "view.grid", group: "View", label: "Grid / list view", keys: "G", icon: <I.LayoutGrid size={15} />, run: () => st().setLayout({ mode: st().layout.mode === "grid" ? "list" : "grid" }) },
  { id: "view.inspector", group: "View", label: "Show / hide inspector", keys: "I", icon: <I.PanelRight size={15} />, run: () => st().setLayout({ showInspector: !st().layout.showInspector }) },
  { id: "view.sidebar", group: "View", label: "Show / hide sidebar", keys: "Ctrl+B", icon: <I.PanelLeft size={15} />, run: () => st().setLayout({ showSidebar: !st().layout.showSidebar }) },
  { id: "view.theme", group: "View", label: "Switch light / dark theme", icon: <I.SunMoon size={15} />, run: () => st().setLayout({ theme: st().layout.theme === "dark" ? "light" : "dark" }) },
  { id: "sel.all", group: "Selection", label: "Select all", keys: "Ctrl+A", run: () => st().selectAll() },
  { id: "sel.invert", group: "Selection", label: "Invert selection", keys: "Ctrl+Shift+I", run: () => st().invertSelection() },
  { id: "sel.none", group: "Selection", label: "Clear selection", keys: "Esc", run: () => st().clearSelection() },
  { id: "copy.names", group: "Selection", label: "Copy file names", keys: "Ctrl+C", icon: <I.Copy size={15} />, when: need, run: () => copy(sel().map(a => a.name).join("\n"), `${ids().length} name(s)`) },
  { id: "copy.paths", group: "Selection", label: "Copy full paths", keys: "Ctrl+Shift+C", when: need, run: () => copy(sel().map(a => a.path).join("\n"), `${ids().length} path(s)`) },
  { id: "manifest", group: "Selection", label: "Export selection manifest (CSV/JSON)…", icon: <I.FileSpreadsheet size={15} />, when: need, run: exportManifest },
  { id: "tag", group: "Selection", label: "Add tag…", keys: "T", icon: <I.Tag size={15} />, when: need, run: addTag },
  { id: "collection", group: "Selection", label: "Add to new collection…", icon: <I.FolderHeart size={15} />, when: need, run: () => addToCollection() },
  { id: "file.rename", group: "File", label: "Rename / batch rename…", keys: "F2", icon: <I.TextCursorInput size={15} />, when: need, run: () => st().setDialog({ kind: "rename", ids: ids() }) },
  { id: "file.reveal", group: "File", label: "Show in File Explorer", keys: "Ctrl+E", icon: <I.FolderOpen size={15} />, when: need, run: () => api.reveal(ids()[0]).catch(e => st().toast(errText(e), "error")) },
  { id: "file.copyto", group: "File", label: "Copy selected to folder…", icon: <I.CopyPlus size={15} />, when: need, run: () => copyTo("copy") },
  { id: "file.moveto", group: "File", label: "Move selected to folder…", icon: <I.FolderInput size={15} />, when: need, run: () => copyTo("move") },
  { id: "file.recycle", group: "File", label: "Move to Recycle Bin…", keys: "Delete", icon: <I.Trash2 size={15} />, when: need, run: recycle },
  { id: "edit.open", group: "Edit", label: "Edit (image editor / timeline)", keys: "E", icon: <I.Wand2 size={15} />, when: need, run: editSelection },
  { id: "edit.timeline", group: "Edit", label: "New timeline from selection", icon: <I.Film size={15} />, when: need, run: () => st().open("video", ids()) },
  { id: "video.export", group: "Edit", label: "Quick trim / export / remove logo…", icon: <I.Scissors size={15} />, when: () => sel().some(a => a.kind === "video" || a.kind === "audio"), run: () => st().setDialog({ kind: "quick", ids: ids() }) },
  { id: "video.join", group: "Edit", label: "Join clips…", icon: <I.Combine size={15} />, when: () => sel().filter(a => a.kind === "video").length >= 2, run: () => st().setDialog({ kind: "join", ids: ids() }) },
  { id: "batch.convert", group: "Batch", label: "Convert / compress video & audio…", icon: <I.FileVideo size={15} />, when: () => sel().some(a => a.kind === "video" || a.kind === "audio"), run: () => st().setDialog({ kind: "convert", ids: ids() }) },
  { id: "batch.audio", group: "Batch", label: "Extract audio…", icon: <I.Music size={15} />, when: () => sel().some(a => a.kind === "video"), run: () => st().setDialog({ kind: "audio", ids: ids() }) },
  { id: "batch.images", group: "Batch", label: "Batch resize / rotate / convert images…", icon: <I.Images size={15} />, when: () => sel().some(a => a.kind === "image"), run: () => st().setDialog({ kind: "images", ids: ids() }) },
  { id: "batch.contact", group: "Batch", label: "Contact sheet…", icon: <I.Grid3x3 size={15} />, when: () => need(2), run: () => st().setDialog({ kind: "contact", ids: ids() }) },
  { id: "batch.proxy", group: "Batch", label: "Generate playback proxies", icon: <I.Gauge size={15} />, when: () => sel().some(a => a.kind === "video"), run: () => queueSimple("proxy") },
  { id: "ai.enhance", group: "AI", label: "AI upscale / enhance…", icon: <I.Sparkles size={15} />, when: need, run: () => st().open("enhance", ids()) },
  { id: "app.jobs", group: "App", label: "Show jobs", keys: "Ctrl+J", icon: <I.ListChecks size={15} />, run: () => st().setDialog({ kind: "jobs" }) },
  { id: "app.settings", group: "App", label: "Settings & diagnostics", keys: "Ctrl+,", icon: <I.Settings size={15} />, run: () => st().setDialog({ kind: "settings" }) },
  { id: "app.help", group: "App", label: "Keyboard shortcuts", keys: "?", icon: <I.Keyboard size={15} />, run: () => st().setDialog({ kind: "help" }) },
  { id: "app.tour", group: "App", label: "Show welcome tour", icon: <I.GraduationCap size={15} />, run: () => st().setDialog({ kind: "tour" }) },
];
export const cmd = (id: string) => commands.find(c => c.id === id)!;
export const runCmd = (id: string) => { const c = cmd(id); if (!c.when || c.when()) void c.run(); };
