// Color picker for the editor: a swatch that opens a popover with a saturation / value square, hue and alpha
// bars, old / new preview, HEX and RGBA fields, preset and recent colors, and the eyedropper (where the browser has one).
// Dragging previews (onInput); releasing a bar, a field edit or a swatch click commits (onChange). Esc cancels.
import { el } from "./dialog.ts";

export interface ColorSwatchOptions {
  /** "#rrggbb" or "#rrggbbaa". */
  value: string;
  /** Show the alpha bar and field (colors written as #rrggbbaa when not opaque). */
  alpha: boolean;
  title?: string;
  /** While dragging (preview). */
  onInput?: (hex: string) => void;
  /** Committed value. */
  onChange: (hex: string) => void;
}

type HSVA = { h: number; s: number; v: number; a: number };

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

export function parseHex(hex: string): { r: number; g: number; b: number; a: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

export function formatHex(r: number, g: number, b: number, a = 1, withAlpha = true): string {
  const x = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  const aa = Math.round(clamp(a) * 255);
  return `#${x(r)}${x(g)}${x(b)}${withAlpha && aa < 255 ? x(aa) : ""}`;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return { r: f(5), g: f(3), b: f(1) };
}

const PRESETS = ["#ffffff", "#000000", "#808080", "#ff4d4d", "#ff9f40", "#ffd84d", "#5cd65c", "#40c4ff", "#4d79ff", "#b35cff", "#ff66c4", "#8b5a2b"];
const RECENT_KEY = "awaken2d.recentColors";
const recentColors = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const pushRecent = (hex: string) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([hex, ...recentColors().filter((c) => c !== hex)].slice(0, 12)));
  } catch {
    /* storage unavailable */
  }
};

let closeOpen: (() => void) | null = null;

/** A swatch button that opens the picker. */
export function colorSwatch(o: ColorSwatchOptions): HTMLElement {
  let value = o.value;
  const fill = el("span", { class: "cp-fill" });
  const btn = el("button", { type: "button", class: "cp-swatch", title: o.title ?? "Pick a color" }, fill);
  const paint = () => {
    fill.style.background = cssColor(value);
  };
  paint();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPicker(btn, value, o.alpha, (hex, commit) => {
      value = hex;
      paint();
      if (commit) o.onChange(hex);
      else o.onInput?.(hex);
    });
  });
  return btn;
}

function cssColor(hex: string): string {
  const c = parseHex(hex) ?? { r: 255, g: 255, b: 255, a: 1 };
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

function openPicker(anchor: HTMLElement, start: string, withAlpha: boolean, emit: (hex: string, commit: boolean) => void): void {
  closeOpen?.();
  const c0 = parseHex(start) ?? { r: 255, g: 255, b: 255, a: 1 };
  const col: HSVA = { ...rgbToHsv(c0.r, c0.g, c0.b), a: withAlpha ? c0.a : 1 };
  const original = formatHex(c0.r, c0.g, c0.b, col.a, withAlpha);
  const hex = () => {
    const { r, g, b } = hsvToRgb(col.h, col.s, col.v);
    return formatHex(r, g, b, col.a, withAlpha);
  };

  const sv = el("div", { class: "cp-sv" });
  const svKnob = el("div", { class: "cp-knob" });
  sv.append(svKnob);
  const hue = el("div", { class: "cp-bar cp-hue" });
  const hueKnob = el("div", { class: "cp-bar-knob" });
  hue.append(hueKnob);
  const alpha = el("div", { class: "cp-bar cp-alpha" });
  const alphaFill = el("div", { class: "cp-alpha-fill" });
  const alphaKnob = el("div", { class: "cp-bar-knob" });
  alpha.append(alphaFill, alphaKnob);
  const oldSw = el("div", { class: "cp-prev old", title: `Before: ${original} (click to go back)` });
  const newSw = el("div", { class: "cp-prev new", title: "New" });
  const hexIn = el("input", { class: "cp-hex", spellcheck: false, title: withAlpha ? "#rrggbb or #rrggbbaa" : "#rrggbb" }) as HTMLInputElement;
  const num = (label: string, max: number, title: string) => {
    const i = el("input", { type: "number", min: "0", max: String(max), step: "1", title }) as HTMLInputElement;
    return { i, wrap: el("label", { class: "cp-num" }, i, el("span", {}, label)) };
  };
  const R = num("R", 255, "Red 0-255");
  const G = num("G", 255, "Green 0-255");
  const B = num("B", 255, "Blue 0-255");
  const A = num("A%", 100, "Opacity 0-100 %");

  const update = (from?: "hex" | "rgb") => {
    const { r, g, b } = hsvToRgb(col.h, col.s, col.v);
    const pure = hsvToRgb(col.h, 1, 1);
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, rgb(${pure.r}, ${pure.g}, ${pure.b}))`;
    svKnob.style.left = `${col.s * 100}%`;
    svKnob.style.top = `${(1 - col.v) * 100}%`;
    svKnob.style.background = `rgb(${r}, ${g}, ${b})`;
    hueKnob.style.left = `${(col.h / 360) * 100}%`;
    alphaFill.style.background = `linear-gradient(to right, rgba(${r}, ${g}, ${b}, 0), rgb(${r}, ${g}, ${b}))`;
    alphaKnob.style.left = `${col.a * 100}%`;
    // an inset shadow paints over the checkerboard, so transparency shows through
    newSw.style.boxShadow = `inset 0 0 0 40px rgba(${r}, ${g}, ${b}, ${col.a})`;
    if (from !== "hex") hexIn.value = hex();
    if (from !== "rgb") {
      R.i.value = String(Math.round(r));
      G.i.value = String(Math.round(g));
      B.i.value = String(Math.round(b));
      A.i.value = String(Math.round(col.a * 100));
    }
  };
  const send = (commit: boolean, from?: "hex" | "rgb") => {
    update(from);
    emit(hex(), commit);
    if (commit) pushRecent(hex());
  };
  const setHex = (v: string, commit = true) => {
    const c = parseHex(v);
    if (!c) return false;
    Object.assign(col, rgbToHsv(c.r, c.g, c.b));
    if (withAlpha) col.a = c.a;
    send(commit);
    return true;
  };

  // drags: preview while moving, commit on release
  const drag = (area: HTMLElement, at: (x: number, y: number) => void) => {
    area.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try {
        area.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      const move = (ev: PointerEvent) => {
        const r = area.getBoundingClientRect();
        at(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height));
        send(false);
      };
      const up = (ev: PointerEvent) => {
        area.removeEventListener("pointermove", move);
        area.removeEventListener("pointerup", up);
        area.removeEventListener("pointercancel", up);
        move(ev);
        send(true);
      };
      area.addEventListener("pointermove", move);
      area.addEventListener("pointerup", up);
      area.addEventListener("pointercancel", up);
      move(e);
    });
  };
  drag(sv, (x, y) => ((col.s = x), (col.v = 1 - y)));
  drag(hue, (x) => (col.h = Math.min(359.999, x * 360)));
  drag(alpha, (x) => (col.a = x));

  hexIn.addEventListener("change", () => {
    if (!setHex(hexIn.value)) hexIn.classList.add("bad");
    else hexIn.classList.remove("bad");
  });
  for (const f of [R, G, B, A]) {
    f.i.addEventListener("change", () => {
      const r = clamp(Number(R.i.value) || 0, 0, 255);
      const g = clamp(Number(G.i.value) || 0, 0, 255);
      const b = clamp(Number(B.i.value) || 0, 0, 255);
      Object.assign(col, rgbToHsv(r, g, b));
      if (withAlpha) col.a = clamp((Number(A.i.value) || 0) / 100);
      send(true, "rgb");
    });
  }
  oldSw.addEventListener("click", () => setHex(original));

  const swatches = (colors: string[]) =>
    el("div", { class: "cp-swatches" }, ...colors.map((c) => el("button", { type: "button", class: "cp-chip", title: c, style: `--c:${cssColor(c)}`, onclick: () => setHex(withAlpha ? c : c.slice(0, 7)) })));
  const recent = recentColors();
  const eye = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  const eyeBtn = eye
    ? el("button", {
        type: "button",
        class: "cp-eye",
        title: "Pick a color from the screen",
        onclick: async () => {
          try {
            const r = await new eye().open();
            const c = parseHex(r.sRGBHex);
            if (c) setHex(formatHex(c.r, c.g, c.b, col.a, withAlpha));
          } catch {
            /* cancelled */
          }
        },
      }, "💧")
    : null;

  const pop = el(
    "div",
    { class: "cp-pop", role: "dialog" },
    sv,
    el("div", { class: "cp-row" }, el("div", { class: "cp-bars" }, hue, ...(withAlpha ? [alpha] : [])), el("div", { class: "cp-prevs" }, oldSw, newSw)),
    el("div", { class: "cp-row cp-fields" }, hexIn, ...(eyeBtn ? [eyeBtn] : [])),
    el("div", { class: "cp-row cp-fields" }, R.wrap, G.wrap, B.wrap, ...(withAlpha ? [A.wrap] : [])),
    el("div", { class: "cp-label" }, "Presets"),
    swatches(PRESETS),
    ...(recent.length ? [el("div", { class: "cp-label" }, "Recent"), swatches(recent)] : []),
  );
  oldSw.style.boxShadow = `inset 0 0 0 40px ${cssColor(original)}`;
  update();
  document.body.append(pop);
  // place under the swatch, kept on screen
  const a = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(innerWidth - pr.width - 4, a.left))}px`;
  pop.style.top = `${a.bottom + pr.height + 6 <= innerHeight ? a.bottom + 4 : Math.max(4, a.top - pr.height - 4)}px`;

  // editor shortcuts stay quiet while typing here
  pop.addEventListener("keydown", (e) => e.stopPropagation());
  const close = () => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    closeOpen = null;
  };
  const outside = (e: Event) => {
    if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // cancel: back to the color it had when opened
      if (hex() !== original) setHex(original);
      close();
    } else if (e.key === "Enter" && pop.contains(e.target as Node)) {
      (e.target as HTMLElement).blur?.();
      close();
    }
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
  });
  closeOpen = close;
}
