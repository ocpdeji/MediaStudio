import { create } from "zustand";
import { api, Asset, errText, JobRow, Library, Query } from "./api";

export type Workspace = "library" | "image" | "video" | "enhance";
export interface Toast { id: number; text: string; kind: "info" | "ok" | "error"; action?: { label: string; run: () => void } }
export interface Layout { mode: "grid" | "list"; thumb: number; sidebar: number; viewer: number; inspector: number; showInspector: boolean; showSidebar: boolean; loupe: boolean; theme: "dark" | "light" }

export const DEFAULT_QUERY: Query = { text: "", kinds: [], rejected: "hide", sort: "name", desc: false, recursive: true, folder: null, library_id: null, collection_id: null, tag_ids: [], colors: [], min_rating: 0, orientation: "" };
const DEFAULT_LAYOUT: Layout = { mode: "grid", thumb: 165, sidebar: 230, viewer: 520, inspector: 290, showInspector: true, showSidebar: true, loupe: false, theme: "dark" };

interface S {
  ready: boolean;
  libraries: Library[]; tags: [number, string, number][]; collections: [number, string, number][]; searches: [number, string, Query][];
  query: Query; assets: Asset[]; loading: boolean; scanning: Record<number, number>;
  selected: Set<number>; focus: number | null; anchor: number | null;
  layout: Layout; workspace: Workspace; editIds: number[]; compare: number[] | null;
  jobs: JobRow[]; toasts: Toast[]; palette: boolean; dialog: null | { kind: string; ids?: number[] };
  init(): Promise<void>;
  refresh(): Promise<void>;
  refreshMeta(): Promise<void>;
  setQuery(q: Partial<Query>, replace?: boolean): void;
  setLayout(l: Partial<Layout>): void;
  select(id: number, mode?: "set" | "toggle" | "range"): void;
  selectAll(): void; invertSelection(): void; clearSelection(): void;
  targetIds(): number[];
  focusAsset(): Asset | undefined;
  move(delta: number): void;
  toast(text: string, kind?: Toast["kind"], action?: Toast["action"]): void;
  dismiss(id: number): void;
  open(ws: Workspace, ids?: number[]): void;
  setDialog(d: S["dialog"]): void;
  patchAssets(ids: number[], patch: Partial<Asset>): void;
  upsertJob(j: JobRow): void;
}

/** Editors register a guard so switching workspace never silently discards unsaved work. */
let leaveGuard: (() => Promise<boolean>) | null = null;
export const setLeaveGuard = (g: (() => Promise<boolean>) | null) => { leaveGuard = g; };
let toastSeq = 0;
let saveTimer: number | undefined;
let refreshSeq = 0;

export const useStore = create<S>((set, get) => ({
  ready: false, libraries: [], tags: [], collections: [], searches: [], query: DEFAULT_QUERY, assets: [], loading: false, scanning: {},
  selected: new Set(), focus: null, anchor: null, layout: DEFAULT_LAYOUT, workspace: "library", editIds: [], compare: null,
  jobs: [], toasts: [], palette: false, dialog: null,

  async init() {
    const s = await api.settings().catch(() => ({} as Record<string, any>));
    const layout = { ...DEFAULT_LAYOUT, ...(s["ui.layout"] || {}), loupe: false };
    const query = { ...DEFAULT_QUERY, ...(s["ui.query"] || {}), text: "" };
    set({ layout, query, ready: true });
    document.documentElement.dataset.theme = layout.theme;
    await Promise.all([get().refreshMeta(), get().refresh(), api.jobs().then(jobs => set({ jobs })).catch(() => {})]);
  },
  async refreshMeta() {
    const [libraries, tags, collections, searches] = await Promise.all([api.listLibraries(), api.listTags(), api.listCollections(), api.savedSearches("list")]);
    set({ libraries, tags, collections, searches });
  },
  async refresh() {
    const my = ++refreshSeq;
    set({ loading: true });
    try {
      const assets = await api.query(get().query);
      if (my !== refreshSeq) return; // a newer query superseded this one
      const ids = new Set(assets.map(a => a.id));
      const selected = new Set([...get().selected].filter(i => ids.has(i)));
      let focus = get().focus; if (focus == null || !ids.has(focus)) focus = assets[0]?.id ?? null;
      set({ assets, selected, focus, loading: false });
    } catch (e) { set({ loading: false }); get().toast(errText(e), "error"); }
  },
  setQuery(q, replace) {
    const query = replace ? { ...DEFAULT_QUERY, ...q } : { ...get().query, ...q };
    set({ query });
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { const { text, ...rest } = query; void text; api.setSetting("ui.query", rest).catch(() => {}); }, 600);
    get().refresh();
  },
  setLayout(l) {
    const layout = { ...get().layout, ...l };
    set({ layout });
    document.documentElement.dataset.theme = layout.theme;
    const { loupe, ...persist } = layout; void loupe;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => api.setSetting("ui.layout", persist).catch(() => {}), 500);
  },
  select(id, mode = "set") {
    const { selected, assets, anchor } = get();
    if (mode === "toggle") { const s = new Set(selected); if (!s.size && get().focus != null && get().focus !== id) s.add(get().focus!); s.has(id) ? s.delete(id) : s.add(id); set({ selected: s, focus: id, anchor: id }); return; }
    if (mode === "range" && anchor != null) {
      const a = assets.findIndex(x => x.id === anchor), b = assets.findIndex(x => x.id === id);
      if (a >= 0 && b >= 0) { const s = new Set(selected); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(assets[i].id); set({ selected: s, focus: id }); return; }
    }
    set({ selected: new Set(), focus: id, anchor: id });
  },
  selectAll() { set({ selected: new Set(get().assets.map(a => a.id)) }); },
  invertSelection() { const s = get().selected; set({ selected: new Set(get().assets.filter(a => !s.has(a.id)).map(a => a.id)) }); },
  clearSelection() { set({ selected: new Set() }); },
  targetIds() { const { selected, focus, assets } = get(); if (selected.size) return assets.filter(a => selected.has(a.id)).map(a => a.id); return focus != null ? [focus] : []; },
  focusAsset() { const { focus, assets } = get(); return assets.find(a => a.id === focus); },
  move(delta) {
    const { assets, focus } = get(); if (!assets.length) return;
    const i = assets.findIndex(a => a.id === focus);
    const n = Math.min(assets.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
    set({ focus: assets[n].id, anchor: assets[n].id });
  },
  toast(text, kind = "info", action) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-4), { id, text, kind, action }] });
    window.setTimeout(() => get().dismiss(id), kind === "error" ? 9000 : action ? 8000 : 3500);
  },
  dismiss(id) { set({ toasts: get().toasts.filter(t => t.id !== id) }); },
  open(workspace, ids) {
    const go = () => set({ workspace, editIds: ids ?? get().targetIds() });
    if (leaveGuard && (workspace !== get().workspace || (ids && ids.join() !== get().editIds.join()))) { const g = leaveGuard; g().then(ok => { if (ok) { leaveGuard = null; go(); } }); return; }
    go();
  },
  setDialog(dialog) { set({ dialog }); },
  patchAssets(ids, patch) { const s = new Set(ids); set({ assets: get().assets.map(a => (s.has(a.id) ? { ...a, ...patch } : a)) }); },
  upsertJob(j) { const jobs = get().jobs; const i = jobs.findIndex(x => x.id === j.id); set({ jobs: i >= 0 ? jobs.map(x => (x.id === j.id ? j : x)) : [j, ...jobs] }); },
}));
