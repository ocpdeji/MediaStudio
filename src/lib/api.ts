// Typed wrappers around the native command API. The UI never touches the filesystem or shell directly.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export type Kind = "image" | "video" | "audio" | "raw";
export type Color = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export interface Library { id: number; path: string; name: string; added_at: number; last_scan: number | null; count: number; missing: number; online: boolean }
export interface Asset {
  id: number; library_id: number; path: string; rel: string; folder: string; name: string; ext: string; kind: Kind;
  size: number; mtime: number; width: number | null; height: number | null; duration_ms: number | null;
  fps_num: number | null; fps_den: number | null; has_audio: boolean | null; rating: number; favorite: boolean; rejected: boolean;
  color: Color | null; missing: boolean; probed: boolean; capture_time: number | null;
}
export interface Query {
  text?: string; kinds?: string[]; exts?: string[]; library_id?: number | null; folder?: string | null; recursive?: boolean;
  min_rating?: number; unrated_only?: boolean; favorites_only?: boolean; rejected?: "hide" | "only" | "any"; colors?: string[];
  tag_ids?: number[]; collection_id?: number | null; size_min?: number | null; size_max?: number | null; width_min?: number | null; height_min?: number | null;
  dur_min_ms?: number | null; dur_max_ms?: number | null; orientation?: "" | "landscape" | "portrait" | "square";
  mtime_from?: number | null; mtime_to?: number | null; missing_only?: boolean; sort?: string; desc?: boolean; limit?: number;
}
export interface Detail {
  asset: Asset; notes: string | null; tags: [number, string][]; collections: [number, string][]; streams: any; exif: [string, string][];
  probe_error: string | null; proxy: string | null; vcodec: string | null; acodec: string | null; bitrate: number | null;
}
export interface Proposal { id: number; folder: string; old_name: string; new_name: string; error: string | null }
export interface RenameSpec { pattern: string; find: string; replace: string; start: number; pad: number; case: string; spaces: string; prefix: string; suffix: string }
export interface JobRow { id: number; kind: string; title: string; status: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted"; progress: number; error: string | null; result: { outputs: string[]; notes: string[] } | null; created_at: number; started_at: number | null; finished_at: number | null }

export interface Preset {
  container: string; vcodec: string; crf: number; bitrate_kbps?: number | null; width?: number | null; height?: number | null; fit: string;
  fps_num?: number | null; fps_den?: number | null; acodec: string; abitrate_kbps: number; hw: string; strip_metadata: boolean; speed: string;
}
export interface Rect { x: number; y: number; w: number; h: number }
export interface QuickEdit {
  in_us?: number | null; out_us?: number | null; crop?: Rect | null; rotate?: number; flip_h?: boolean; flip_v?: boolean; delogo?: Rect[]; blur_regions?: Rect[];
  speed?: number; volume?: number; mute?: boolean; fade_in_us?: number; fade_out_us?: number; brightness?: number; contrast?: number; saturation?: number;
  normalize_audio?: boolean; lossless_cut?: boolean;
}
export type JobSpec =
  | { type: "quick"; asset_id: number; edit: QuickEdit; preset: Preset; out_dir: string | null; name: string }
  | { type: "join"; asset_ids: number[]; mode: string; preset: Preset; out_dir: string | null; name: string }
  | { type: "extract_audio"; asset_id: number; format: string; edit: QuickEdit; out_dir: string | null; name: string }
  | { type: "proxy"; asset_id: number }
  | { type: "render"; project: any; preset: Preset; range: [number, number] | null; out_dir: string; name: string }
  | { type: "convert"; asset_ids: number[]; preset: Preset; out_dir: string | null; suffix: string }
  | { type: "image_batch"; asset_ids: number[]; ops: ImageOps; out_dir: string | null }
  | { type: "copy_to"; asset_ids: number[]; dest: string; mode: "copy" | "move" }
  | { type: "upscale"; asset_id: number; scale: number; model: string; cpu: boolean; out_dir: string | null }
  | { type: "hashes"; asset_ids: number[] };
export interface ImageOps { resize_long?: number | null; scale_pct?: number | null; rotate?: number; flip_h?: boolean; flip_v?: boolean; format?: string; quality?: number; suffix?: string }

export const PRESETS: Record<string, { label: string; hint: string; p: Partial<Preset> }> = {
  source: { label: "Match source (H.264)", hint: "Same size & frame rate, high quality", p: {} },
  web: { label: "Web optimized", hint: "1080p H.264, smaller files", p: { height: 1080, width: 1920, crf: 23, abitrate_kbps: 160 } },
  archive: { label: "High-quality archive", hint: "H.265, visually lossless", p: { vcodec: "hevc", crf: 18, abitrate_kbps: 256 } },
  vertical: { label: "Vertical 9:16 (Reels/Shorts/TikTok)", hint: "1080×1920", p: { width: 1080, height: 1920, fit: "cover", crf: 21 } },
  square: { label: "Square 1:1", hint: "1080×1080", p: { width: 1080, height: 1080, fit: "cover", crf: 21 } },
  landscape: { label: "Landscape 16:9 1080p", hint: "1920×1080", p: { width: 1920, height: 1080, fit: "contain", crf: 21 } },
  uhd: { label: "4K UHD", hint: "3840×2160 H.265", p: { width: 3840, height: 2160, vcodec: "hevc", crf: 20 } },
  prores: { label: "ProRes 422 HQ (.mov)", hint: "Editing intermediate, very large", p: { container: "mov", vcodec: "prores", acodec: "pcm" } },
  webm: { label: "WebM (VP9)", hint: "Open format for the web", p: { container: "webm", vcodec: "vp9", acodec: "opus", crf: 32 } },
};
export const defaultPreset = (over: Partial<Preset> = {}): Preset => ({ container: "mp4", vcodec: "h264", crf: 20, fit: "contain", acodec: "aac", abitrate_kbps: 192, hw: "auto", strip_metadata: false, speed: "medium", ...over });

export const api = {
  appInfo: () => invoke<any>("app_info"),
  listLibraries: () => invoke<Library[]>("list_libraries"),
  addLibrary: (path: string) => invoke<number>("add_library", { path }),
  removeLibrary: (id: number) => invoke<void>("remove_library", { id }),
  rescan: (id: number) => invoke<void>("rescan_library", { id }),
  folders: (id: number) => invoke<[string, number][]>("library_folders", { id }),
  query: (q: Query) => invoke<Asset[]>("query_assets", { q }),
  detail: (id: number) => invoke<Detail>("asset_detail", { id }),
  setField: (ids: number[], field: "rating" | "favorite" | "rejected" | "color" | "notes", value: unknown) => invoke<number>("set_field", { ids, field, value }),
  listTags: () => invoke<[number, string, number][]>("list_tags"),
  tag: (ids: number[], name: string, remove = false) => invoke<void>("tag_assets", { ids, name, remove }),
  listCollections: () => invoke<[number, string, number][]>("list_collections"),
  collection: (action: "create" | "rename" | "delete" | "add" | "remove", id: number | null, name: string | null, ids: number[] = []) => invoke<number>("collection_edit", { action, id, name, ids }),
  savedSearches: (action: "list" | "save" | "delete", id?: number, name?: string, query?: Query) => invoke<[number, string, Query][]>("saved_searches", { action, id: id ?? null, name: name ?? null, query: query ?? null }),
  similar: (ids: number[], threshold: number) => invoke<number[][]>("similar_groups", { ids, threshold }),
  renamePreview: (ids: number[], spec: RenameSpec) => invoke<Proposal[]>("rename_preview", { ids, spec }),
  renameApply: (renames: [number, string][]) => invoke<{ batch: string; renamed: number; errors: string[] }>("rename_apply", { renames }),
  renameUndo: (batch: string) => invoke<{ renamed: number }>("rename_undo", { batch }),
  recycle: (ids: number[]) => invoke<number>("recycle", { ids }),
  reveal: (id: number) => invoke<void>("reveal", { id }),
  captureFrame: (id: number, time_us: number, to_cache = false) => invoke<string>("capture_frame", { id, timeUs: time_us, toCache: to_cache }),
  previewQuick: (id: number, edit: QuickEdit, time_us: number) => invoke<ArrayBuffer>("preview_quick", { id, edit, timeUs: time_us }),
  readCacheFile: (path: string) => invoke<ArrayBuffer>("read_cache_file", { path }),
  readMedia: (id: number) => invoke<ArrayBuffer>("read_media", { id }),
  saveOutput: (bytes: Uint8Array, dest: { asset?: number; dir?: string }, name: string, overwrite = false) =>
    invoke<string>("save_output", bytes, { headers: { "x-name": encodeURIComponent(name), ...(dest.asset != null ? { "x-asset": String(dest.asset) } : {}), ...(dest.dir ? { "x-dir": encodeURIComponent(dest.dir) } : {}), ...(overwrite ? { "x-overwrite": "1" } : {}) } }),
  writeText: (path: string, contents: string, kind: "manifest" | "project") => invoke<void>("write_text_file", { path, contents, kind }),
  readProject: (path: string) => invoke<any>("read_project", { path }),
  recentProjects: () => invoke<string[]>("recent_projects"),
  resolveMedia: (path: string) => invoke<Asset | null>("resolve_media", { path }),
  enqueue: (spec: JobSpec, title: string) => invoke<number>("enqueue_job", { spec, title }),
  jobs: () => invoke<JobRow[]>("list_jobs"),
  cancelJob: (id: number) => invoke<void>("cancel_job", { id }),
  retryJob: (id: number) => invoke<number>("retry_job", { id }),
  clearJobs: () => invoke<number>("clear_jobs"),
  settings: () => invoke<Record<string, any>>("get_settings"),
  setSetting: (key: string, value: unknown) => invoke<void>("set_setting", { key, value }),
  cacheInfo: () => invoke<{ thumbs: number; proxies: number; path: string }>("cache_info"),
  clearCache: (which: "thumbs" | "proxies") => invoke<number>("clear_cache", { which }),
  diagnostics: () => invoke<any>("diagnostics"),
  aiStatus: () => invoke<{ installed: boolean; path: string | null; models: string[]; size_mb: number; download_mb: number; url: string; license: string }>("ai_status"),
  aiInstall: () => invoke<void>("ai_install"),
};

export const thumbUrl = (a: Pick<Asset, "id" | "mtime" | "size">) => `${convertFileSrc(String(a.id), "thumb")}?v=${a.mtime}-${a.size}`;
export const fileUrl = (path: string) => convertFileSrc(path);
export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
