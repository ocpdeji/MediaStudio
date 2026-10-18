// Text templates, caption styles and starter templates (all generated, no copyrighted assets).
import { Clip, defTextStyle, newProject, Project, SEC, TextStyle, uid } from "./model";

export interface TextPreset { id: string; name: string; style: Partial<TextStyle>; animIn?: string; animLoop?: string; sample?: string }
const S = (o: Partial<TextStyle>) => o;
const shadow = (on = true, color = "#000000", blur = 12, y = 3, opacity = 0.55) => ({ on, color, blur, x: 0, y, opacity });
const stroke = (on = true, color = "#000000", width = 6) => ({ on, color, width });
const bg = (on = true, color = "#000000", opacity = 0.6, radius = 12, padding = 18) => ({ on, color, opacity, radius, padding });
const grad = (from: string, to: string, angle = 90) => ({ on: true, from, to, angle });

export const TEXT_PRESETS: TextPreset[] = [
  { id: "default", name: "Default", style: S({}) },
  { id: "bold", name: "Bold title", style: S({ font: "Anton", size: 120, caseMode: "upper", letterSpacing: 2 }) },
  { id: "outline", name: "Outline", style: S({ font: "Bebas Neue", size: 130, color: "#ffffff", stroke: stroke(true, "#000000", 10), shadow: shadow(false) }) },
  { id: "yellowPop", name: "Yellow pop", style: S({ font: "Luckiest Guy", size: 110, color: "#ffe14d", stroke: stroke(true, "#111111", 12), shadow: shadow(true, "#000000", 0, 8, 0.9) }), animIn: "pop" },
  { id: "neon", name: "Neon", style: S({ font: "Righteous", size: 100, color: "#ffffff", shadow: { on: true, color: "#ff2ad0", blur: 30, x: 0, y: 0, opacity: 1 } }), animLoop: "flickerLoop" },
  { id: "neonBlue", name: "Neon blue", style: S({ font: "Righteous", size: 100, color: "#e6fbff", shadow: { on: true, color: "#00c8ff", blur: 32, x: 0, y: 0, opacity: 1 } }) },
  { id: "gradient", name: "Gradient", style: S({ font: "Montserrat", size: 110, gradient: grad("#ffd54a", "#ff4a8c"), shadow: shadow(true, "#000000", 18, 4, 0.4) }) },
  { id: "sunset", name: "Sunset", style: S({ font: "Kanit", size: 110, gradient: grad("#ff7a18", "#af002d", 0), stroke: stroke(true, "#ffffff", 4) }) },
  { id: "boxed", name: "Boxed", style: S({ font: "Poppins", size: 64, background: bg(true, "#000000", 0.75, 14, 20), shadow: shadow(false) }) },
  { id: "boxWhite", name: "White box", style: S({ font: "Poppins", size: 64, color: "#111111", background: bg(true, "#ffffff", 0.95, 10, 18), shadow: shadow(false) }) },
  { id: "boxRed", name: "Red label", style: S({ font: "Oswald", size: 70, caseMode: "upper", background: bg(true, "#e0202e", 1, 4, 16), shadow: shadow(false) }) },
  { id: "cinematic", name: "Cinematic", style: S({ font: "Playfair Display", size: 84, bold: false, letterSpacing: 10, caseMode: "upper", shadow: shadow(true, "#000000", 20, 0, 0.6) }), animIn: "fade" },
  { id: "script", name: "Script", style: S({ font: "Pacifico", size: 110, bold: false, shadow: shadow(true, "#000000", 10, 4, 0.5) }) },
  { id: "handwritten", name: "Handwritten", style: S({ font: "Dancing Script", size: 120, color: "#fff5d6" }) },
  { id: "marker", name: "Marker", style: S({ font: "Permanent Marker", size: 100, color: "#ffffff", stroke: stroke(true, "#000000", 5) }) },
  { id: "comic", name: "Comic", style: S({ font: "Bangers", size: 120, color: "#ffef00", stroke: stroke(true, "#000000", 10), shadow: shadow(true, "#e8003b", 0, 10, 1) }), animIn: "bounce" },
  { id: "retro", name: "Retro", style: S({ font: "Lobster", size: 110, color: "#ffcf5a", stroke: stroke(true, "#7a2000", 6), shadow: shadow(true, "#2b0000", 0, 10, 1) }) },
  { id: "tech", name: "Tech", style: S({ font: "Russo One", size: 96, color: "#9fffcb", letterSpacing: 4, shadow: { on: true, color: "#00ff88", blur: 18, x: 0, y: 0, opacity: 0.8 } }), animIn: "typewriter" },
  { id: "minimal", name: "Minimal", style: S({ font: "Inter", size: 58, bold: false, letterSpacing: 2, shadow: shadow(false) }) },
  { id: "lowerThird", name: "Lower third", style: S({ font: "Montserrat", size: 54, align: "left", background: bg(true, "#1c6cff", 0.95, 6, 16), shadow: shadow(false) }), animIn: "wipeRight" },
  { id: "subtitle", name: "Subtitle", style: S({ font: "Roboto", size: 52, bold: false, background: bg(true, "#000000", 0.55, 6, 10), shadow: shadow(false) }) },
  { id: "headline", name: "Headline", style: S({ font: "Archivo Black", size: 110, caseMode: "upper", color: "#ffffff", shadow: shadow(true, "#000000", 0, 10, 0.7) }), animIn: "slideUp" },
  { id: "teko", name: "Sport", style: S({ font: "Teko", size: 150, caseMode: "upper", italic: true, color: "#ffffff", stroke: stroke(true, "#ff3b00", 6) }) },
  { id: "soft", name: "Soft pastel", style: S({ font: "Comfortaa", size: 86, color: "#ffd1f0", shadow: shadow(true, "#7a3ab0", 16, 2, 0.8) }) },
];

export interface CaptionStyle { id: string; name: string; style: Partial<TextStyle>; anim?: string; words?: number }
export const CAPTION_STYLES: CaptionStyle[] = [
  { id: "hormozi", name: "Bold yellow", style: S({ font: "Montserrat", size: 78, caseMode: "upper", color: "#ffffff", stroke: stroke(true, "#000000", 10), shadow: shadow(true, "#000000", 6, 6, 0.9), highlight: "#ffe14d", highlightMode: "color" }), words: 3 },
  { id: "box", name: "Word box", style: S({ font: "Poppins", size: 70, color: "#ffffff", stroke: stroke(true, "#000000", 6), highlight: "#7c3aed", highlightMode: "box" }), words: 3 },
  { id: "pop", name: "Pop karaoke", style: S({ font: "Luckiest Guy", size: 80, color: "#ffffff", stroke: stroke(true, "#000000", 10), highlight: "#22e36b", highlightMode: "scale" }), words: 2 },
  { id: "reveal", name: "Word by word", style: S({ font: "Anton", size: 86, caseMode: "upper", color: "#ffffff", stroke: stroke(true, "#000000", 8), highlightMode: "reveal" }), words: 4 },
  { id: "classic", name: "Classic subtitle", style: S({ font: "Roboto", size: 54, bold: false, color: "#ffffff", background: bg(true, "#000000", 0.6, 6, 10), shadow: shadow(false), highlightMode: "none" }), words: 8 },
  { id: "clean", name: "Clean white", style: S({ font: "Inter", size: 60, color: "#ffffff", shadow: shadow(true, "#000000", 14, 3, 0.8), highlightMode: "none" }), words: 6 },
  { id: "neonCap", name: "Neon", style: S({ font: "Righteous", size: 72, color: "#ffffff", shadow: { on: true, color: "#00e5ff", blur: 26, x: 0, y: 0, opacity: 1 }, highlight: "#ff3df2", highlightMode: "color" }), words: 3 },
  { id: "red", name: "Red highlight", style: S({ font: "Oswald", size: 80, caseMode: "upper", color: "#ffffff", stroke: stroke(true, "#000000", 8), highlight: "#ff3040", highlightMode: "color" }), words: 3 },
  { id: "gradientCap", name: "Gradient", style: S({ font: "Kanit", size: 76, gradient: grad("#7af7ff", "#c86bff"), stroke: stroke(true, "#120030", 6), highlightMode: "none" }), words: 4 },
  { id: "typewriterCap", name: "Typewriter", style: S({ font: "Russo One", size: 60, color: "#eaffea", background: bg(true, "#000000", 0.7, 6, 12), highlightMode: "none" }), anim: "typewriter", words: 6 },
  { id: "lower", name: "Lowercase calm", style: S({ font: "Comfortaa", size: 62, caseMode: "lower", color: "#ffffff", shadow: shadow(true, "#000000", 12, 2, 0.7), highlight: "#ffc6e8", highlightMode: "color" }), words: 4 },
  { id: "comicCap", name: "Comic", style: S({ font: "Bangers", size: 86, color: "#ffef00", stroke: stroke(true, "#000000", 10), highlight: "#ff3b6b", highlightMode: "scale" }), words: 2 },
];

export function textClip(text: string, preset: TextPreset | null, over: Partial<Clip> = {}): Clip {
  return { id: uid(), type: "text", start: 0, dur: 3 * SEC, name: text.slice(0, 40), text: defTextStyle({ ...preset?.style, text }), transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false },
    animIn: preset?.animIn ? { id: preset.animIn, dur: 500_000 } : null, animLoop: preset?.animLoop ? { id: preset.animLoop, dur: 1_000_000 } : null, ...over };
}

/** Group whisper words into caption clips of `max` words (breaking at long pauses and sentence ends). */
export function captionClips(segments: { start_us: number; end_us: number; text: string; words: { start_us: number; end_us: number; text: string }[] }[], st: CaptionStyle, y = 0.32): Clip[] {
  const out: Clip[] = [];
  const max = st.words ?? 4;
  for (const s of segments) {
    const ws = s.words.length ? s.words : [{ start_us: s.start_us, end_us: s.end_us, text: s.text }];
    let group: typeof ws = [];
    const flush = () => {
      if (!group.length) return;
      const t0 = group[0].start_us, t1 = Math.max(group[group.length - 1].end_us, t0 + 300_000);
      out.push({ id: uid(), type: "caption", start: t0, dur: t1 - t0, name: group.map(w => w.text).join(" "),
        text: defTextStyle({ ...st.style, text: group.map(w => w.text).join(" ") }), words: group.map(w => ({ t0: w.start_us - t0, t1: w.end_us - t0, text: w.text })),
        transform: { x: 0, y, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false }, animIn: st.anim ? { id: st.anim, dur: Math.min(600_000, t1 - t0) } : null });
      group = [];
    };
    for (const w of ws) {
      const gap = group.length ? w.start_us - group[group.length - 1].end_us : 0;
      if (group.length >= max || gap > 700_000) flush();
      group.push(w);
      if (/[.!?…]$/.test(w.text)) flush();
    }
    flush();
  }
  // no overlaps on the caption track
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length - 1; i++) if (out[i].start + out[i].dur > out[i + 1].start) out[i].dur = Math.max(100_000, out[i + 1].start - out[i].start);
  return out;
}

export interface Template { id: string; name: string; desc: string; ratio: string; build: () => Project }
const T = (id: string, name: string, desc: string, ratio: string, build: (p: Project) => void): Template => ({ id, name, desc, ratio, build: () => { const p = newProject(name, ratio); build(p); return p; } });
const txt = (p: Project, text: string, preset: string, start: number, dur: number, y: number, extra: Partial<Clip> = {}) => {
  let tr = p.tracks.find(t => t.kind === "text" && t.clips.every(c => c.start + c.dur <= start || c.start >= start + dur));
  if (!tr) { tr = { id: uid("t"), kind: "text", clips: [] }; p.tracks.unshift(tr); }
  const pr = TEXT_PRESETS.find(x => x.id === preset) ?? null;
  tr.clips.push(textClip(text, pr, { start, dur, transform: { x: 0, y, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false }, ...extra }));
};
const color = (p: Project, c: string, dur: number) => { p.tracks.find(t => t.main)!.clips.push({ id: uid(), type: "color", start: p.tracks.find(t => t.main)!.clips.reduce((m, x) => Math.max(m, x.start + x.dur), 0), dur, color: c }); };

export const TEMPLATES: Template[] = [
  T("intro", "YouTube intro", "Animated channel title on a gradient background — replace the background with your clip.", "16:9", p => {
    color(p, "#1b1036", 4 * SEC);
    txt(p, "YOUR CHANNEL", "headline", 0, 4 * SEC, -0.04, { animIn: { id: "zoomBlur", dur: 600_000 }, animOut: { id: "fade", dur: 400_000 } });
    txt(p, "new video every week", "minimal", 600_000, 3.4 * SEC, 0.12, { animIn: { id: "slideUp", dur: 500_000 } });
    p.tracks.unshift({ id: uid("t"), kind: "effect", clips: [{ id: uid(), type: "effect", start: 0, dur: 4 * SEC, effect: { id: "lightLeak" }, name: "Light leak" }] });
  }),
  T("shorts", "Vertical short with captions", "9:16 layout with a hook title. Add your clip, then Captions → Auto captions.", "9:16", p => {
    color(p, "#101010", 5 * SEC);
    txt(p, "WAIT FOR IT…", "yellowPop", 0, 2.5 * SEC, -0.32, { animIn: { id: "pop", dur: 400_000 } });
  }),
  T("quote", "Quote card", "Square quote with a soft gradient — great for Instagram.", "1:1", p => {
    color(p, "#2b2d42", 6 * SEC);
    txt(p, "“Creativity is intelligence having fun.”", "cinematic", 0, 6 * SEC, -0.05, { animIn: { id: "fade", dur: 800_000 } });
    txt(p, "— Albert Einstein", "minimal", 1 * SEC, 5 * SEC, 0.16, { animIn: { id: "fade", dur: 600_000 } });
  }),
  T("lower", "Interview lower third", "Name + title lower third over your interview footage.", "16:9", p => {
    color(p, "#000000", 6 * SEC);
    txt(p, "Jane Doe", "lowerThird", 500_000, 5 * SEC, 0.3, { transform: { x: -0.28, y: 0.3, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false } });
    txt(p, "Founder & CEO", "minimal", 700_000, 4.8 * SEC, 0.37, { transform: { x: -0.3, y: 0.38, scale: 0.8, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false } });
  }),
  T("slideshow", "Photo slideshow", "Add photos to the main track; transitions and a slow zoom are applied per photo.", "16:9", p => {
    txt(p, "Our memories", "script", 0, 3 * SEC, 0, { animIn: { id: "fade", dur: 800_000 }, animOut: { id: "fade", dur: 600_000 } });
    color(p, "#000000", 3 * SEC);
  }),
  T("tiktok", "TikTok hook + CTA", "Hook at the start and a follow call-to-action at the end.", "9:16", p => {
    color(p, "#0f0f0f", 8 * SEC);
    txt(p, "3 things nobody tells you", "boxWhite", 0, 3 * SEC, -0.3, { animIn: { id: "wipeRight", dur: 400_000 } });
    txt(p, "Follow for part 2 👉", "comic", 6 * SEC, 2 * SEC, 0.25, { animIn: { id: "bounce", dur: 500_000 }, animLoop: { id: "pulse", dur: 800_000 } });
  }),
  T("countdown", "Countdown 3-2-1", "Big animated countdown.", "16:9", p => {
    color(p, "#111111", 3 * SEC);
    ["3", "2", "1"].forEach((n, i) => txt(p, n, "bold", i * SEC, SEC, 0, { animIn: { id: "zoomOut", dur: 300_000 }, text: defTextStyleSized(n, 300) }));
  }),
  T("trailer", "Cinematic trailer titles", "Letterboxed trailer titles with film look.", "21:9", p => {
    color(p, "#000000", 9 * SEC);
    txt(p, "THIS SUMMER", "cinematic", 0.5 * SEC, 2.5 * SEC, 0, { animIn: { id: "fade", dur: 700_000 }, animOut: { id: "fade", dur: 500_000 } });
    txt(p, "ONE STORY", "cinematic", 3.5 * SEC, 2.5 * SEC, 0, { animIn: { id: "fade", dur: 700_000 }, animOut: { id: "fade", dur: 500_000 } });
    txt(p, "CHANGES EVERYTHING", "cinematic", 6.5 * SEC, 2.5 * SEC, 0, { animIn: { id: "zoomBlur", dur: 700_000 } });
    p.tracks.unshift({ id: uid("t"), kind: "filter", clips: [{ id: uid(), type: "filter", start: 0, dur: 9 * SEC, filter: { id: "cinema", amount: 80 }, name: "Cinematic" }] });
  }),
];
function defTextStyleSized(text: string, size: number): TextStyle { return { ...defTextStyle({ ...TEXT_PRESETS.find(x => x.id === "bold")!.style, text }), size }; }

/** Fonts bundled with the app (SIL Open Font License / Apache 2.0). */
export const BUNDLED_FONTS = ["Montserrat", "Poppins", "Inter", "Roboto", "Anton", "Bebas Neue", "Oswald", "Archivo Black", "Kanit", "Teko", "Russo One", "Righteous", "Luckiest Guy", "Bangers", "Permanent Marker", "Pacifico", "Lobster", "Dancing Script", "Playfair Display", "Comfortaa", "Caveat"];
