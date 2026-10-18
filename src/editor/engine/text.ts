// Text, caption and sticker rasterisation (Canvas 2D → texture). Sizes are relative to a 1080-px reference so
// text looks identical in the small preview and the full-resolution export.
import type { TextStyle, Word } from "../model";
import type { CharAnim } from "./anim";

export interface Raster { canvas: OffscreenCanvas; w: number; h: number; key: string; animated: boolean }

const caseOf = (s: string, m: TextStyle["caseMode"]) => (m === "upper" ? s.toUpperCase() : m === "lower" ? s.toLowerCase() : s);
const fontStr = (st: TextStyle, px: number) => `${st.italic ? "italic " : ""}${st.bold ? 800 : 400} ${px}px "${st.font}", "Segoe UI", "Segoe UI Emoji", sans-serif`;
const rgba = (hex: string, a: number) => { const n = parseInt((hex || "#000000").replace("#", "").padEnd(6, "0").slice(0, 6), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

interface Glyph { ch: string; x: number; line: number; w: number; word: number }

function layout(ctx: OffscreenCanvasRenderingContext2D, text: string, maxW: number) {
  const lines: { text: string; words: number[] }[] = [];
  let wordIdx = 0;
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/).filter(x => x.length);
    let cur = "", ids: number[] = [];
    for (const w of words) {
      if (/^\s+$/.test(w)) { if (cur) cur += w; continue; }
      const trial = cur ? cur + w : w;
      if (cur && ctx.measureText(trial).width > maxW) { lines.push({ text: cur.trimEnd(), words: ids }); cur = w; ids = [wordIdx]; }
      else { cur = trial; ids.push(wordIdx); }
      wordIdx++;
    }
    lines.push({ text: cur.trimEnd(), words: ids });
  }
  return lines;
}

/** Index of the active caption word at `local`, or -1. */
export function activeWord(words: Word[] | undefined, local: number) {
  if (!words?.length) return -1;
  for (let i = 0; i < words.length; i++) if (local >= words[i].t0 && local < (words[i + 1]?.t0 ?? words[i].t1)) return i;
  return local >= words[words.length - 1].t1 ? words.length : -1;
}

export function renderText(st: TextStyle, W: number, H: number, opts: { words?: Word[]; local?: number; char?: CharAnim | null } = {}): Raster {
  const k = Math.min(W, H) / 1080;
  const px = Math.max(4, st.size * k);
  const text = caseOf(st.text || " ", st.caseMode);
  const karaoke = !!opts.words?.length && st.highlightMode !== "none";
  const aw = karaoke ? activeWord(opts.words, opts.local ?? 0) : -1;
  const animated = karaoke || !!opts.char;
  const key = JSON.stringify([st, W, H, aw, opts.char ? [opts.char.mode, Math.round(opts.char.k * 120), Math.round(opts.char.t * 30)] : 0]);

  const meas = new OffscreenCanvas(8, 8).getContext("2d")!;
  meas.font = fontStr(st, px);
  (meas as any).letterSpacing = `${st.letterSpacing * k}px`;
  const lines = layout(meas, text, Math.max(px * 2, st.maxWidth * W));
  const lh = px * st.lineHeight;
  const widths = lines.map(l => meas.measureText(l.text).width);
  const bw = Math.max(1, ...widths), bh = lines.length * lh;
  const strokeW = st.stroke.on ? st.stroke.width * k : 0;
  const pad = Math.ceil((st.background.on ? st.background.padding * k : 0) + strokeW + (st.shadow.on ? st.shadow.blur * k + Math.max(Math.abs(st.shadow.x), Math.abs(st.shadow.y)) * k : 0) + px * (animated ? 0.6 : 0.15));
  const cw = Math.ceil(bw + pad * 2), ch = Math.ceil(bh + pad * 2);
  const cv = new OffscreenCanvas(Math.max(2, cw), Math.max(2, ch));
  const ctx = cv.getContext("2d")!;
  ctx.font = meas.font; (ctx as any).letterSpacing = (meas as any).letterSpacing;
  ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;

  if (st.background.on) {
    const p = st.background.padding * k, r = st.background.radius * k;
    ctx.fillStyle = rgba(st.background.color, st.background.opacity);
    ctx.beginPath(); (ctx as any).roundRect(pad - p, pad - p, bw + p * 2, bh + p * 2, r); ctx.fill();
  }

  // glyph positions (only needed for per-word/char effects)
  const glyphs: Glyph[] = [];
  const lineX = (i: number) => (st.align === "left" ? pad : st.align === "right" ? pad + bw - widths[i] : pad + (bw - widths[i]) / 2);
  if (animated) {
    lines.forEach((l, li) => {
      let wi = 0, inWord = false;
      for (let i = 0; i < l.text.length; i++) {
        const c = l.text[i]; const isSpace = /\s/.test(c);
        if (!isSpace && !inWord) { inWord = true; } if (isSpace && inWord) { inWord = false; wi++; }
        glyphs.push({ ch: c, x: lineX(li) + ctx.measureText(l.text.slice(0, i)).width, line: li, w: ctx.measureText(c).width, word: l.words[Math.min(wi, l.words.length - 1)] ?? 0 });
      }
    });
  }

  const fill = () => {
    if (st.gradient.on) {
      const a = (st.gradient.angle * Math.PI) / 180, cx = cw / 2, cy = ch / 2, r = Math.max(bw, bh) / 2;
      const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.addColorStop(0, st.gradient.from); g.addColorStop(1, st.gradient.to); return g;
    }
    return st.color;
  };
  const shadowOn = () => { if (st.shadow.on) { ctx.shadowColor = rgba(st.shadow.color, st.shadow.opacity); ctx.shadowBlur = st.shadow.blur * k; ctx.shadowOffsetX = st.shadow.x * k; ctx.shadowOffsetY = st.shadow.y * k; } };
  const shadowOff = () => { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; };
  const y0 = (li: number) => pad + li * lh + lh / 2;

  if (!animated) {
    lines.forEach((l, li) => {
      const x = lineX(li), y = y0(li);
      ctx.textAlign = "left";
      if (strokeW > 0) { shadowOn(); ctx.strokeStyle = st.stroke.color; ctx.lineWidth = strokeW * 2; ctx.strokeText(l.text, x, y); shadowOff(); }
      else shadowOn();
      ctx.fillStyle = fill(); ctx.fillText(l.text, x, y); shadowOff();
      if (st.underline) { ctx.fillRect(x, y + px * 0.45, widths[li], Math.max(1, px * 0.06)); }
    });
    return { canvas: cv, w: cw, h: ch, key, animated };
  }

  // per-glyph pass (karaoke + character animations)
  const n = glyphs.length || 1;
  const wordsTotal = Math.max(1, ...glyphs.map(g => g.word + 1));
  const ca = opts.char;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 0 && strokeW <= 0 && !st.shadow.on) continue;
    glyphs.forEach((g, gi) => {
      if (/\s/.test(g.ch)) return;
      let alpha = 1, dy = 0, sc = 1;
      if (ca) {
        const order = ca.mode === "wordPop" ? g.word / wordsTotal : gi / n;
        const span = ca.mode === "wordPop" ? 1 / wordsTotal : Math.max(0.08, 3 / n);
        const local = Math.max(0, Math.min(1, (ca.k - order * (1 - span)) / span));
        switch (ca.mode) {
          case "typewriter": alpha = ca.k * n >= gi + 1 ? 1 : 0; break;
          case "wordPop": sc = local < 1 ? 0.4 + 0.75 * local - (local > 0.7 ? (local - 0.7) * 0.5 : 0) : 1; alpha = local > 0 ? 1 : 0; break;
          case "letterFade": alpha = local; break;
          case "letterDrop": alpha = local; dy = -(1 - local) * px * 1.2; break;
          case "letterRise": alpha = local; dy = (1 - local) * px * 1.2; break;
          case "letterZoom": alpha = local; sc = 0.2 + 0.8 * local; break;
          case "wave": dy = Math.sin(ca.t * 6 + gi * 0.55) * px * 0.18; break;
          case "bounceLoop": dy = -Math.abs(Math.sin(ca.t * 4 + gi * 0.4)) * px * 0.25; break;
          case "flicker": alpha = Math.sin(ca.t * 30 + gi * 7.3) > 0.85 ? 0.3 : 1; break;
        }
      }
      let color: string | CanvasGradient = fill();
      if (karaoke && aw >= 0) {
        const wi = g.word;
        if (st.highlightMode === "color" && wi === aw) color = st.highlight;
        if (st.highlightMode === "scale" && wi === aw) { sc *= 1.18; color = st.highlight; }
        if (st.highlightMode === "reveal" && wi > aw) alpha *= 0.0;
        if (st.highlightMode === "box" && wi === aw && pass === 0 && gi === glyphs.findIndex(x => x.word === wi && !/\s/.test(x.ch))) {
          const ws = glyphs.filter(x => x.word === wi && !/\s/.test(x.ch)); const x0 = ws[0].x, x1 = ws[ws.length - 1].x + ws[ws.length - 1].w;
          ctx.fillStyle = st.highlight; ctx.beginPath(); (ctx as any).roundRect(x0 - px * 0.12, y0(g.line) - px * 0.62, x1 - x0 + px * 0.24, px * 1.2, px * 0.18); ctx.fill();
        }
      }
      if (alpha <= 0.001) return;
      ctx.save(); ctx.globalAlpha = alpha;
      const cx = g.x + g.w / 2, cy = y0(g.line) + dy;
      ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.textAlign = "center";
      if (pass === 0) { shadowOn(); if (strokeW > 0) { ctx.strokeStyle = st.stroke.color; ctx.lineWidth = strokeW * 2; ctx.strokeText(g.ch, 0, 0); } else { ctx.fillStyle = color; ctx.fillText(g.ch, 0, 0); } shadowOff(); }
      else { ctx.fillStyle = color; ctx.fillText(g.ch, 0, 0); }
      ctx.restore();
    });
  }
  return { canvas: cv, w: cw, h: ch, key, animated };
}

// ------------------------------------------------------------------ stickers

export const SHAPES = ["arrow", "arrowCurved", "circle", "ring", "star", "heart", "burst", "bubble", "bubbleThought", "check", "cross", "rect", "underline", "highlight", "sparkle", "location", "like", "subscribe"] as const;

export function renderSticker(sk: { emoji?: string; shape?: string; color?: string }, sizePx = 512): Raster {
  const cv = new OffscreenCanvas(sizePx, sizePx); const ctx = cv.getContext("2d")!;
  const s = sizePx, col = sk.color || "#ffd23f";
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (sk.emoji) {
    ctx.font = `${s * 0.82}px "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(sk.emoji, s / 2, s / 2 + s * 0.04);
  } else {
    ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = s * 0.07;
    const P = new Path2D();
    switch (sk.shape) {
      case "arrow": P.moveTo(s * 0.1, s * 0.5); P.lineTo(s * 0.75, s * 0.5); ctx.stroke(P); { const h = new Path2D(); h.moveTo(s * 0.6, s * 0.3); h.lineTo(s * 0.9, s * 0.5); h.lineTo(s * 0.6, s * 0.7); ctx.stroke(h); } break;
      case "arrowCurved": P.moveTo(s * 0.12, s * 0.75); P.quadraticCurveTo(s * 0.2, s * 0.2, s * 0.8, s * 0.3); ctx.stroke(P); { const h = new Path2D(); h.moveTo(s * 0.62, s * 0.16); h.lineTo(s * 0.84, s * 0.3); h.lineTo(s * 0.66, s * 0.48); ctx.stroke(h); } break;
      case "circle": ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.42, 0, 7); ctx.fill(); break;
      case "ring": ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.4, 0, 7); ctx.stroke(); break;
      case "rect": ctx.strokeRect(s * 0.08, s * 0.2, s * 0.84, s * 0.6); break;
      case "star": { ctx.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.2 : s * 0.46, a = -Math.PI / 2 + (i * Math.PI) / 5; ctx.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r); } ctx.closePath(); ctx.fill(); } break;
      case "sparkle": { ctx.beginPath(); for (let i = 0; i < 8; i++) { const r = i % 2 ? s * 0.08 : s * 0.46, a = -Math.PI / 2 + (i * Math.PI) / 4; ctx.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r); } ctx.closePath(); ctx.fill(); } break;
      case "heart": { ctx.beginPath(); ctx.moveTo(s / 2, s * 0.85); ctx.bezierCurveTo(s * 0.05, s * 0.55, s * 0.15, s * 0.12, s / 2, s * 0.3); ctx.bezierCurveTo(s * 0.85, s * 0.12, s * 0.95, s * 0.55, s / 2, s * 0.85); ctx.fill(); } break;
      case "burst": { ctx.beginPath(); for (let i = 0; i < 24; i++) { const r = i % 2 ? s * 0.32 : s * 0.47, a = (i * Math.PI) / 12; ctx.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r); } ctx.closePath(); ctx.fill(); } break;
      case "bubble": { ctx.beginPath(); (ctx as any).roundRect(s * 0.06, s * 0.12, s * 0.88, s * 0.56, s * 0.12); ctx.moveTo(s * 0.3, s * 0.66); ctx.lineTo(s * 0.22, s * 0.88); ctx.lineTo(s * 0.46, s * 0.66); ctx.fill(); } break;
      case "bubbleThought": { ctx.beginPath(); ctx.ellipse(s / 2, s * 0.4, s * 0.42, s * 0.28, 0, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(s * 0.28, s * 0.78, s * 0.06, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(s * 0.18, s * 0.9, s * 0.035, 0, 7); ctx.fill(); } break;
      case "check": P.moveTo(s * 0.15, s * 0.52); P.lineTo(s * 0.4, s * 0.76); P.lineTo(s * 0.86, s * 0.24); ctx.lineWidth = s * 0.12; ctx.stroke(P); break;
      case "cross": P.moveTo(s * 0.2, s * 0.2); P.lineTo(s * 0.8, s * 0.8); P.moveTo(s * 0.8, s * 0.2); P.lineTo(s * 0.2, s * 0.8); ctx.lineWidth = s * 0.12; ctx.stroke(P); break;
      case "underline": P.moveTo(s * 0.05, s * 0.6); P.quadraticCurveTo(s * 0.5, s * 0.5, s * 0.95, s * 0.58); ctx.lineWidth = s * 0.06; ctx.stroke(P); break;
      case "highlight": ctx.globalAlpha = 0.55; ctx.fillRect(s * 0.02, s * 0.35, s * 0.96, s * 0.3); break;
      case "location": { ctx.beginPath(); ctx.arc(s / 2, s * 0.38, s * 0.26, Math.PI, 0); ctx.lineTo(s / 2, s * 0.92); ctx.closePath(); ctx.fill(); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(s / 2, s * 0.38, s * 0.1, 0, 7); ctx.fill(); } break;
      case "like": { ctx.beginPath(); (ctx as any).roundRect(s * 0.08, s * 0.25, s * 0.84, s * 0.5, s * 0.25); ctx.fill(); ctx.fillStyle = "#fff"; ctx.font = `800 ${s * 0.2}px "Segoe UI", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("👍 LIKE", s / 2, s / 2); } break;
      case "subscribe": { ctx.fillStyle = "#ff0033"; ctx.beginPath(); (ctx as any).roundRect(s * 0.04, s * 0.32, s * 0.92, s * 0.36, s * 0.06); ctx.fill(); ctx.fillStyle = "#fff"; ctx.font = `800 ${s * 0.13}px "Segoe UI", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("SUBSCRIBE", s / 2, s / 2); } break;
      default: ctx.fillRect(s * 0.1, s * 0.1, s * 0.8, s * 0.8);
    }
  }
  return { canvas: cv, w: sizePx, h: sizePx, key: JSON.stringify(sk), animated: false };
}

export const EMOJI_SETS: Record<string, string> = {
  Trending: "🔥😂❤️😍🤣😭🥺✨👀💯🙌👏🎉🤯😎🥳😱🤔💀👑",
  Faces: "😀😃😄😁😆😅🤣😂🙂😉😊😇🥰😍🤩😘😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳🥸😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀☠️💩🤡👹👺👻👽👾🤖",
  Gestures: "👋🤚🖐️✋🖖👌🤌🤏✌️🤞🫰🤟🤘🤙👈👉👆🖕👇☝️👍👎✊👊🤛🤜👏🙌🫶👐🤲🤝🙏✍️💅🤳💪",
  Hearts: "❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟",
  Symbols: "✨⭐🌟💫⚡🔥💥💢💦💨🎵🎶💯✅❌❗❓⚠️🔔📌📍🏆🥇🎯💡💰💎🎁🎉🎊",
  Nature: "🌸🌺🌻🌹🌷🌼🍀🌿🌴🌵🍁🍂🌈☀️🌙⭐☁️⛈️❄️🌊🐶🐱🐭🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🦋🐝",
  Food: "🍎🍊🍋🍌🍉🍇🍓🍒🍑🥭🍍🥥🥝🍅🥑🍔🍟🍕🌭🥪🌮🍿🍩🍪🎂🍰🧁🍫🍬🍭☕🍵🥤🧋🍺🍷🍸",
  Activities: "⚽🏀🏈⚾🎾🏐🎱🏓🥊🎮🎲🎯🎳🎸🎹🥁🎤🎧🎬📷🎨🚀✈️🚗🏍️🏖️🏝️⛰️🏠",
};
