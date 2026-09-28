import type { Vec2 } from "./types.ts";

/** 2D affine matrix [a, b, c, d, tx, ty]: x' = a*x + c*y + tx, y' = b*x + d*y + ty. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const DEG = Math.PI / 180;

export function fromTRS(x: number, y: number, rotationDeg: number, scaleX: number, scaleY: number, shearX = 0, shearY = 0): Mat {
  if (shearX || shearY) {
    // Spine's local matrix: each axis rotated by rotation + its shear
    const rx = (rotationDeg + shearX) * DEG;
    const ry = (rotationDeg + 90 + shearY) * DEG;
    return [Math.cos(rx) * scaleX, Math.sin(rx) * scaleX, Math.cos(ry) * scaleY, Math.sin(ry) * scaleY, x, y];
  }
  const r = rotationDeg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, x, y];
}

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Mat): Mat {
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error("matrix is not invertible (zero scale?)");
  return [d / det, -b / det, -c / det, a / det, (c * ty - d * tx) / det, (b * tx - a * ty) / det];
}

export function apply(m: Mat, x: number, y: number): Vec2 {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** World rotation of the matrix's local x axis in degrees. */
export function angleOf(m: Mat): number {
  return Math.atan2(m[1], m[0]) / DEG;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export type RGBA = [number, number, number, number];

const colorCache = new Map<string, RGBA>();

/** Parses "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" into 0..1 floats (memoized: poses parse every slot color). */
export function parseColor(s: string): RGBA {
  const hit = colorCache.get(s);
  if (hit) return [hit[0], hit[1], hit[2], hit[3]];
  const c = parseColorUncached(s);
  if (colorCache.size > 4096) colorCache.clear();
  colorCache.set(s, c);
  return [c[0], c[1], c[2], c[3]];
}

function parseColorUncached(s: string): RGBA {
  const m = /^#([0-9a-f]{3,8})$/i.exec(s.trim());
  if (!m) throw new Error(`invalid color "${s}" (expected #rrggbb or #rrggbbaa)`);
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) throw new Error(`invalid color "${s}"`);
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
}

export function formatColor(c: RGBA): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return "#" + h(c[0]) + h(c[1]) + h(c[2]) + (c[3] < 1 ? h(c[3]) : "");
}

export function isColor(s: unknown): boolean {
  if (typeof s !== "string") return false;
  try {
    parseColor(s);
    return true;
  } catch {
    return false;
  }
}
