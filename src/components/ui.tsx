import { ReactNode, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { X } from "lucide-react";
import type { Color } from "../lib/api";

export const COLORS: Color[] = ["red", "orange", "yellow", "green", "blue", "purple"];

export function Dialog({ title, icon, children, footer, onClose, size }: { title: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; size?: "wide" | "narrow" }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog ${size ?? ""}`} role="dialog" aria-modal="true">
        <div className="dialog-h">{icon}{title}<span className="grow" /><button className="btn ghost icon sm" onClick={onClose} title="Close (Esc)"><X size={16} /></button></div>
        <div className="dialog-b">{children}</div>
        {footer && <div className="dialog-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Stars({ value, onChange, size = 18 }: { value: number; onChange: (v: number) => void; size?: number }) {
  return <span className="stars" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map(n =>
    <button key={n} className={n <= value ? "on" : ""} style={{ fontSize: size }} aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => onChange(n === value ? 0 : n)}>★</button>)}</span>;
}

export function ColorPicker({ value, onChange }: { value: Color | null; onChange: (c: Color | null) => void }) {
  return <span className="colors">{COLORS.map(c => <button key={c} title={c} aria-label={`${c} label`} className={value === c ? "on" : ""} style={{ background: `var(--c-${c})` }} onClick={() => onChange(value === c ? null : c)} />)}</span>;
}

export function Slider({ label, value, min, max, step = 1, onChange, onCommit, format, reset }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: () => void; format?: (v: number) => string; reset?: number }) {
  return (
    <div className="slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} onPointerUp={onCommit} onKeyUp={onCommit} aria-label={label} />
      <span className="v" title="Double-click to reset" onDoubleClick={() => { if (reset !== undefined) { onChange(reset); onCommit?.(); } }}>{format ? format(value) : value}</span>
    </div>
  );
}

/** Drag-to-resize helper for panels. */
export function Splitter({ value, onChange, min, max, invert }: { value: number; onChange: (v: number) => void; min: number; max: number; invert?: boolean }) {
  const [drag, setDrag] = useState(false);
  return <div className={`splitter ${drag ? "drag" : ""}`} role="separator" aria-orientation="vertical"
    onPointerDown={e => {
      const x0 = e.clientX, v0 = value; setDrag(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => onChange(Math.min(max, Math.max(min, v0 + (invert ? x0 - ev.clientX : ev.clientX - x0))));
      const up = () => { setDrag(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    }} />;
}

// ------------------------------------------------------------------ context menu
export interface MenuItem { label?: string; icon?: ReactNode; keys?: string; run?: () => void; disabled?: boolean; sep?: boolean; hidden?: boolean }
interface MenuS { at: { x: number; y: number } | null; items: MenuItem[]; show(x: number, y: number, items: MenuItem[]): void; hide(): void }
export const useMenu = create<MenuS>(set => ({ at: null, items: [], show: (x, y, items) => set({ at: { x, y }, items }), hide: () => set({ at: null }) }));

export function ContextMenu() {
  const { at, items, hide } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!at) return;
    const r = ref.current?.getBoundingClientRect();
    setPos({ x: Math.min(at.x, innerWidth - (r?.width ?? 240) - 8), y: Math.min(at.y, innerHeight - (r?.height ?? 300) - 8) });
    const close = () => hide();
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    window.addEventListener("mousedown", close); window.addEventListener("blur", close); window.addEventListener("keydown", k);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("blur", close); window.removeEventListener("keydown", k); };
  }, [at, hide]);
  if (!at) return null;
  return (
    <div className="menu" ref={ref} style={{ left: pos.x || at.x, top: pos.y || at.y }} onMouseDown={e => e.stopPropagation()} role="menu">
      {items.filter(i => !i.hidden).map((it, i) => it.sep ? <div key={i} className="ms" /> :
        <div key={i} role="menuitem" className={`mi ${it.disabled ? "dis" : ""}`} onClick={() => { hide(); it.run?.(); }}>{it.icon}{it.label}{it.keys && <span className="k">{it.keys}</span>}</div>)}
    </div>
  );
}

// ------------------------------------------------------------------ prompt / confirm (in-app, keyboard friendly)
interface AskS { req: null | { title: string; body?: ReactNode; input?: string; okLabel?: string; danger?: boolean; resolve: (v: string | null) => void }; ask(o: Omit<NonNullable<AskS["req"]>, "resolve">): Promise<string | null> }
export const useAsk = create<AskS>(set => ({ req: null, ask: o => new Promise(resolve => set({ req: { ...o, resolve } })) }));
export const confirmAsk = (title: string, body?: ReactNode, okLabel = "OK", danger = false) => useAsk.getState().ask({ title, body, okLabel, danger }).then(v => v !== null);
export const promptAsk = (title: string, input = "", body?: ReactNode) => useAsk.getState().ask({ title, body, input });

export function AskHost() {
  const req = useAsk(s => s.req);
  const [v, setV] = useState("");
  useEffect(() => { if (req) setV(req.input ?? ""); }, [req]);
  if (!req) return null;
  const done = (r: string | null) => { useAsk.setState({ req: null }); req.resolve(r); };
  return (
    <Dialog title={req.title} size="narrow" onClose={() => done(null)} footer={<>
      <button className="btn" onClick={() => done(null)}>Cancel</button>
      <button className={`btn primary ${req.danger ? "danger" : ""}`} autoFocus={req.input === undefined} onClick={() => done(req.input !== undefined ? v : "ok")}>{req.okLabel ?? "OK"}</button></>}>
      {req.body && <div className="hint" style={{ marginBottom: 10 }}>{req.body}</div>}
      {req.input !== undefined && <input className="input" style={{ width: "100%" }} autoFocus value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === "Enter") done(v); }} onFocus={e => e.target.select()} />}
    </Dialog>
  );
}
