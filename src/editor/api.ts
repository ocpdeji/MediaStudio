// Typed wrappers for the editor's native commands.
import { invoke } from "@tauri-apps/api/core";

export interface ProjectMeta { id: string; name: string; created: number; modified: number; duration_us: number; width: number; height: number; clips: number; cover: string | null; size: number }
export interface MediaInfo {
  path: string; name: string; kind: "video" | "image" | "audio"; ext: string; size: number; mtime: number; duration_us: number; width: number; height: number; fps_num: number; fps_den: number;
  has_audio: boolean; has_video: boolean; vcodec: string | null; acodec: string | null; pix_fmt: string | null; playable: boolean; reason: string | null; optimized: string | null;
}
export interface Filmstrip { path: string; cols: number; count: number; interval_us: number; tw: number; th: number }
export interface ModelStatus { id: string; group: string; name: string; desc: string; license: string; mb: number; installed: boolean; recommended: boolean }
export interface ProviderRow { id: string; name: string; caps: string[]; base: string; model: string; image_model: string; video_model: string; tts_model: string; needs_key: boolean; key_url: string; note: string; has_key: boolean; cfg: { base: string; model: string; image_model: string; video_model: string; tts_model: string } }
export interface StockItem { id: string; kind: string; title: string; thumb: string; preview: string; url: string; duration: number; width: number; height: number; author: string; license: string }
export interface FontFile { family: string; style: string; path: string }

export const ed = {
  projects: () => invoke<ProjectMeta[]>("projects_list"),
  projectsDir: () => invoke<string>("projects_dir"),
  create: (name: string, data: unknown) => invoke<ProjectMeta>("project_create", { name, data }),
  load: (id: string) => invoke<any>("project_load", { id }),
  save: (id: string, data: unknown) => invoke<ProjectMeta>("project_save", { id, data }),
  rename: (id: string, name: string) => invoke<ProjectMeta>("project_rename", { id, name }),
  duplicate: (id: string) => invoke<ProjectMeta>("project_duplicate", { id }),
  remove: (ids: string[]) => invoke<number>("project_delete", { ids }),
  cover: (id: string, jpeg: Uint8Array) => invoke<string>("project_cover", jpeg, { headers: { "x-project": id } }),
  reveal: (id: string) => invoke<void>("project_reveal", { id }),
  assetsDir: (id: string) => invoke<string>("project_assets_dir", { id }),
  writeAsset: (id: string, name: string, bytes: Uint8Array) => invoke<string>("project_write_asset", bytes, { headers: { "x-project": id, "x-name": encodeURIComponent(name) } }),
  import: (paths: string[]) => invoke<{ ok: MediaInfo[]; errors: string[] }>("editor_import", { paths }),
  info: (path: string) => invoke<MediaInfo>("editor_info", { path }),
  optimize: (path: string) => invoke<number>("editor_optimize", { path }),
  waveform: (path: string) => invoke<ArrayBuffer>("editor_waveform", { path }),
  filmstrip: (path: string, duration_us: number, width: number, height: number) => invoke<Filmstrip>("editor_filmstrip", { path, durationUs: duration_us, width, height }),
  framePng: (path: string, time_us: number, project: string) => invoke<string>("editor_frame_png", { path, timeUs: time_us, project }),
  saveTextAs: (path: string, contents: string) => invoke<void>("save_text_as", { path, contents }),
  readText: (path: string) => invoke<string>("read_text_file", { path }),
  renderAudio: (plan: unknown, out_dir: string, name: string) => invoke<string>("render_audio", { plan, outDir: out_dir, name }),
  voices: () => invoke<[string, string][]>("voice_effects"),
  models: () => invoke<ModelStatus[]>("models_status"),
  installModel: (id: string) => invoke<number>("model_install", { id }),
  removeModel: (id: string) => invoke<void>("model_remove", { id }),
  speechVoices: () => invoke<{ id: string; name: string; installed: boolean }[]>("speech_voices"),
  providers: () => invoke<ProviderRow[]>("byok_providers"),
  setProvider: (id: string, key: string | null, cfg: ProviderRow["cfg"] | null) => invoke<void>("byok_set", { id, key, cfg }),
  chat: (provider: string, system: string, prompt: string) => invoke<string>("ai_chat", { provider, system, prompt }),
  stock: (provider: string, kind: string, query: string, page = 1) => invoke<StockItem[]>("stock_search", { provider, kind, query, page }),
  fonts: () => invoke<FontFile[]>("system_fonts"),
  env: () => invoke<{ projects: string; cache: string; stock: string; hw: string[] }>("editor_env"),
  enqueue: (spec: unknown, title: string) => invoke<number>("enqueue_job", { spec, title }),
  cancelJob: (id: number) => invoke<void>("cancel_job", { id }),
  readCache: (path: string) => invoke<ArrayBuffer>("read_cache_file", { path }),
};
