// Software rasterizer: premultiplied float canvas for meshes, 8-bit overlay drawing for debug graphics.
import type { RGBA } from "../core/math.ts";
import { GLYPH_H, glyph } from "./font.ts";
import type { RGBAImage } from "./png.ts";

export interface FloatCanvas {
  width: number;
  height: number;
  /** Premultiplied RGBA floats. */
  data: Float32Array;
}

export function createCanvas(width: number, height: number): FloatCanvas {
  return { width, height, data: new Float32Array(width * height * 4) };
}

type Pt = [number, number];

/**
 * Fills a triangle given in pixel coordinates. `shade` receives barycentric weights for
 * vertices 0,1,2 and writes a premultiplied color into `out`. Uses a consistent tie rule
 * so shared edges are drawn exactly once.
 */
export type Blend = "normal" | "multiply" | "screen" | "additive";

export function fillTriangle(
  c: FloatCanvas,
  p0: Pt,
  p1: Pt,
  p2: Pt,
  shade: (w0: number, w1: number, w2: number, out: RGBA) => void,
  blend: Blend = "normal",
  /** Per-pixel coverage (0..1, canvas-sized) multiplied into the colour: clipping masks. */
  mask?: Float32Array,
): void {
  let area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (Math.abs(area) < 1e-12) return;
  let a = p0;
  let b = p1;
  let cc = p2;
  let swapped = false;
  if (area < 0) {
    b = p2;
    cc = p1;
    area = -area;
    swapped = true;
  }
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], cc[0])));
  const maxX = Math.min(c.width - 1, Math.ceil(Math.max(a[0], b[0], cc[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], cc[1])));
  const maxY = Math.min(c.height - 1, Math.ceil(Math.max(a[1], b[1], cc[1])));
  if (minX > maxX || minY > maxY) return;
  const edge = (u: Pt, v: Pt, x: number, y: number) => (v[0] - u[0]) * (y - u[1]) - (v[1] - u[1]) * (x - u[0]);
  const owns = (u: Pt, v: Pt) => {
    const dy = v[1] - u[1];
    return dy > 0 || (dy === 0 && v[0] - u[0] < 0);
  };
  const t0 = owns(b, cc);
  const t1 = owns(cc, a);
  const t2 = owns(a, b);
  const col: RGBA = [0, 0, 0, 0];
  const d = c.data;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const e0 = edge(b, cc, px, py);
      const e1 = edge(cc, a, px, py);
      const e2 = edge(a, b, px, py);
      if (e0 < 0 || e1 < 0 || e2 < 0) continue;
      if ((e0 === 0 && !t0) || (e1 === 0 && !t1) || (e2 === 0 && !t2)) continue;
      const w0 = e0 / area;
      const w1 = e1 / area;
      const w2 = e2 / area;
      if (swapped) shade(w0, w2, w1, col);
      else shade(w0, w1, w2, col);
      const i = (y * c.width + x) * 4;
      if (mask) {
        const m = mask[y * c.width + x];
        if (m <= 0) continue;
        col[0] *= m;
        col[1] *= m;
        col[2] *= m;
        col[3] *= m;
      }
      const inv = 1 - col[3];
      if (blend === "normal") {
        d[i] = col[0] + d[i] * inv;
        d[i + 1] = col[1] + d[i + 1] * inv;
        d[i + 2] = col[2] + d[i + 2] * inv;
      } else if (blend === "multiply") {
        const dinv = 1 - d[i + 3];
        for (let k = 0; k < 3; k++) d[i + k] = col[k] * d[i + k] + col[k] * dinv + d[i + k] * inv;
      } else if (blend === "screen") {
        for (let k = 0; k < 3; k++) d[i + k] = col[k] + d[i + k] - col[k] * d[i + k];
      } else {
        for (let k = 0; k < 3; k++) d[i + k] = col[k] + d[i + k];
      }
      d[i + 3] = blend === "additive" ? Math.min(1, col[3] + d[i + 3]) : col[3] + d[i + 3] * inv;
    }
  }
}

/** Bilinear sample of a straight-alpha image, returned premultiplied (0..1). */
export function sampleTexture(img: RGBAImage, u: number, v: number, out: RGBA): void {
  const x = u * img.width - 0.5;
  const y = v * img.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      if (w === 0) continue;
      const sx = Math.min(img.width - 1, Math.max(0, x0 + i));
      const sy = Math.min(img.height - 1, Math.max(0, y0 + j));
      const k = (sy * img.width + sx) * 4;
      const a = (img.data[k + 3] / 255) * w;
      out[0] += (img.data[k] / 255) * a;
      out[1] += (img.data[k + 1] / 255) * a;
      out[2] += (img.data[k + 2] / 255) * a;
      out[3] += a;
    }
  }
}

/** Box-filters a supersampled canvas down and composites it over `background` (null = transparent). */
export function resolveCanvas(c: FloatCanvas, factor: number, background: RGBA | null): RGBAImage {
  const w = Math.floor(c.width / factor);
  const h = Math.floor(c.height / factor);
  const out = new Uint8Array(w * h * 4);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) {
          const k = ((y * factor + j) * c.width + x * factor + i) * 4;
          r += c.data[k];
          g += c.data[k + 1];
          b += c.data[k + 2];
          a += c.data[k + 3];
        }
      }
      r /= n;
      g /= n;
      b /= n;
      a /= n;
      if (background) {
        const inv = 1 - a;
        r += background[0] * background[3] * inv;
        g += background[1] * background[3] * inv;
        b += background[2] * background[3] * inv;
        a += background[3] * inv;
      }
      const o = (y * w + x) * 4;
      const ua = a > 1e-6 ? 1 / a : 0;
      out[o] = clamp8(r * ua);
      out[o + 1] = clamp8(g * ua);
      out[o + 2] = clamp8(b * ua);
      out[o + 3] = clamp8(a);
    }
  }
  return { width: w, height: h, data: out };
}

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

// ---------- 8-bit overlay drawing (straight alpha, "over" blending)

export function blendPixel(img: RGBAImage, x: number, y: number, col: RGBA, coverage = 1): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const a = col[3] * coverage;
  if (a <= 0) return;
  const k = (y * img.width + x) * 4;
  const d = img.data;
  const da = d[k + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  for (let c = 0; c < 3; c++) d[k + c] = clamp8((col[c] * a + (d[k + c] / 255) * da * (1 - a)) / oa);
  d[k + 3] = clamp8(oa);
}

export function drawLine(img: RGBAImage, x0: number, y0: number, x1: number, y1: number, width: number, col: RGBA): void {
  const r = width / 2 + 1;
  const minX = Math.floor(Math.min(x0, x1) - r);
  const maxX = Math.ceil(Math.max(x0, x1) + r);
  const minY = Math.floor(Math.min(y0, y1) - r);
  const maxY = Math.ceil(Math.max(y0, y1) + r);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  for (let y = Math.max(0, minY); y <= Math.min(img.height - 1, maxY); y++) {
    for (let x = Math.max(0, minX); x <= Math.min(img.width - 1, maxX); x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
      const cov = Math.max(0, Math.min(1, width / 2 + 0.5 - d));
      if (cov > 0) blendPixel(img, x, y, col, cov);
    }
  }
}

export function drawDisc(img: RGBAImage, cx: number, cy: number, radius: number, col: RGBA): void {
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, radius + 0.5 - d));
      if (cov > 0) blendPixel(img, x, y, col, cov);
    }
  }
}

export function fillRect(img: RGBAImage, x: number, y: number, w: number, h: number, col: RGBA): void {
  for (let j = Math.max(0, y); j < Math.min(img.height, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(img.width, x + w); i++) blendPixel(img, i, j, col);
  }
}

/**
 * Draws text with its top-left at (x, y). `bg` fills a box behind it; `halo` outlines each glyph
 * instead, which keeps the art underneath readable.
 */
export function drawText(img: RGBAImage, x: number, y: number, text: string, col: RGBA, scale = 1, bg?: RGBA, halo?: RGBA): void {
  x = Math.round(x);
  y = Math.round(y);
  if (bg) fillRect(img, x - 2, y - 2, (text.length * 6 - 1) * scale + 4, GLYPH_H * scale + 4, bg);
  if (halo) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
      drawText(img, x + dx, y + dy, text, halo, scale);
    }
  }
  let cx = x;
  for (const ch of text) {
    const g = glyph(ch);
    for (let r = 0; r < g.length; r++) {
      for (let c = 0; c < g[r].length; c++) {
        if (g[r][c]) fillRect(img, cx + c * scale, y + r * scale, scale, scale, col);
      }
    }
    cx += 6 * scale;
  }
}

export function blit(dst: RGBAImage, src: RGBAImage, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (dy * dst.width + dx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = src.data[s + 3];
    }
  }
}
