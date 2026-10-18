// Transition catalogue from the MIT-licensed gl-transitions collection (GLSL ES 3.00 builds), grouped like CapCut.
import meta from "gl-transitions/gl-transitions.json";

const bodies = import.meta.glob("/node_modules/gl-transitions/glsl3/*.glsl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export interface TransitionDef { id: string; name: string; cat: string; glsl: string; params: Record<string, { type: string; v: number | boolean | number[] }>; author: string; license: string }

const NAMES: Record<string, string> = {
  fade: "Mix", fadecolor: "Black fade", fadegrayscale: "Gray fade", dissolve: "Dissolve", crosswarp: "Cross warp", CrossZoom: "Cross zoom", SimpleZoom: "Zoom in", SimpleZoomOut: "Zoom out", ZoomInCircles: "Zoom circles",
  directional: "Slide", "directional-easing": "Smooth slide", directionalwipe: "Wipe", wipeLeft: "Wipe left", wipeRight: "Wipe right", wipeUp: "Wipe up", wipeDown: "Wipe down", Slides: "Slides", swap: "Swap", cube: "Cube", doorway: "Doorway",
  circleopen: "Circle open", circle: "Circle", heart: "Heart", StarWipe: "Star", Radial: "Clock", angular: "Angular", pinwheel: "Pinwheel", windowslice: "Blinds", windowblinds: "Window blinds", GlitchDisplace: "Glitch", GlitchMemories: "Glitch memories",
  Mosaic: "Mosaic", pixelize: "Pixelate", burn: "Burn", FilmBurn: "Film burn", Overexposure: "Flash", ripple: "Ripple", Swirl: "Swirl", WaterDrop: "Water drop", Dreamy: "Dreamy", DreamyZoom: "Dreamy zoom", colorphase: "Color phase",
  morph: "Morph", perlin: "Perlin", kaleidoscope: "Kaleidoscope", flyeye: "Fly eye", squeeze: "Squeeze", BookFlip: "Page flip", InvertedPageCurl: "Page curl", Bounce: "Bounce", rotate_scale_fade: "Rotate & fade", RotateScaleVanish: "Spin out",
  LinearBlur: "Blur", DefocusBlur: "Defocus", TVStatic: "TV static", old_tv_lost_signal: "Lost signal", static_wipe: "Static wipe", hexagonalize: "Hexagons", polar_function: "Polar", cannabisleaf: "Leaf", tangentMotionBlur: "Motion blur",
};
const human = (s: string) => NAMES[s] ?? s.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^\w/, c => c.toUpperCase());

function categorize(name: string, tags: string[]): string {
  const t = (tags.join(" ") + " " + name).toLowerCase();
  if (/glitch|static|noise|tv|signal|datamosh|digital/.test(t)) return "Glitch";
  if (/3d|cube|flip|page|fold|door|rotate|perspective|book|revolve|roll/.test(t)) return "3D";
  if (/zoom|scale/.test(t)) return "Zoom";
  if (/slide|wipe|push|directional|swap|split|translation/.test(t)) return "Slide";
  if (/circle|heart|star|shape|rect|polka|hex|square|leaf|bow|diamond|grid|chess|tile|puzzle|mosaic|pixel|block/.test(t)) return "Shape";
  if (/burn|light|flash|exposure|glow|film/.test(t)) return "Light";
  if (/blur|warp|swirl|ripple|water|wave|distort|morph|kaleido|twist|wind/.test(t)) return "Distort";
  return "Basic";
}

const EXCLUDE = new Set(["displacement", "luma"]); // need external textures

export const TRANSITIONS: TransitionDef[] = (meta as any[])
  .filter(m => !m.textures?.length && !EXCLUDE.has(m.name) && bodies[`/node_modules/gl-transitions/glsl3/${m.name}.glsl`])
  .map(m => ({
    id: m.name, name: human(m.name), cat: m.name === "fade" || m.name === "fadecolor" || m.name === "dissolve" ? "Basic" : categorize(m.name, m.tags ?? []),
    glsl: bodies[`/node_modules/gl-transitions/glsl3/${m.name}.glsl`],
    params: Object.fromEntries(Object.entries(m.paramsTypes ?? {}).map(([k, type]) => [k, { type: type as string, v: (m.defaultParams ?? {})[k] }])),
    author: m.author, license: m.license,
  }))
  .sort((a, b) => (a.cat === b.cat ? a.name.localeCompare(b.name) : 0));

export const TRANSITION_CATS = ["Basic", "Slide", "Zoom", "Light", "Glitch", "Shape", "3D", "Distort"];
export const transitionById = (id: string) => TRANSITIONS.find(t => t.id === id);
/** CapCut favourites shown first in the panel. */
export const FEATURED = ["fade", "fadecolor", "dissolve", "CrossZoom", "SimpleZoom", "directional", "wipeLeft", "Overexposure", "GlitchMemories", "cube", "circleopen", "LinearBlur", "Swirl", "pixelize", "DreamyZoom", "FilmBurn"];
