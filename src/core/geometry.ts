import { distToSegment, round } from "./math.ts";
import type { Tri, Vec2 } from "./types.ts";

export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function triArea(a: Vec2, b: Vec2, c: Vec2): number {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToPolygonEdge(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, segments = 24): Vec2[] {
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as Vec2;
  });
}

/** Resamples a closed polygon so no edge is longer than `spacing`, keeping the original corners. */
export function resamplePolygon(poly: Vec2[], spacing: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / spacing - 1e-9));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Bowyer-Watson Delaunay triangulation. Triangles are returned counter-clockwise. */
export function delaunay(points: Vec2[]): Tri[] {
  if (points.length < 3) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const d = Math.max(maxX - minX, maxY - minY, 1) * 20;
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const pts: Vec2[] = [...points, [mx - d, my - d], [mx + d, my - d], [mx, my + d]];
  const n = points.length;

  interface T {
    v: Tri;
    cx: number;
    cy: number;
    r2: number;
  }
  const make = (a: number, b: number, c: number): T => {
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const [cx, cy] = pts[c];
    const dd = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(dd) < 1e-12) return { v: [a, b, c], cx: 0, cy: 0, r2: Infinity };
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / dd;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / dd;
    return { v: [a, b, c], cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };

  let tris: T[] = [make(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i];
    const bad: T[] = [];
    const keep: T[] = [];
    for (const t of tris) {
      const inside = t.r2 === Infinity || (px - t.cx) ** 2 + (py - t.cy) ** 2 < t.r2 * (1 - 1e-12);
      (inside ? bad : keep).push(t);
    }
    const edges = new Map<string, [number, number]>();
    for (const t of bad) {
      for (const [a, b] of [
        [t.v[0], t.v[1]],
        [t.v[1], t.v[2]],
        [t.v[2], t.v[0]],
      ]) {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [a, b]);
      }
    }
    for (const [a, b] of edges.values()) keep.push(make(a, b, i));
    tris = keep;
  }
  const out: Tri[] = [];
  for (const t of tris) {
    if (t.v.some((v) => v >= n)) continue;
    const [a, b, c] = t.v;
    const area = triArea(pts[a], pts[b], pts[c]);
    if (Math.abs(area) < 1e-9) continue;
    out.push(area > 0 ? [a, b, c] : [a, c, b]);
  }
  return out;
}

export interface MeshData {
  vertices: Vec2[];
  triangles: Tri[];
}

/** Regular grid mesh over a rectangle (x, y is the bottom-left corner, +y up). */
export function meshFromRect(x: number, y: number, w: number, h: number, cols = 1, rows = 1): MeshData {
  cols = Math.max(1, Math.floor(cols));
  rows = Math.max(1, Math.floor(rows));
  const vertices: Vec2[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) vertices.push([round(x + (w * c) / cols), round(y + (h * r) / rows)]);
  }
  const triangles: Tri[] = [];
  const idx = (c: number, r: number) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      triangles.push([idx(c, r), idx(c + 1, r), idx(c + 1, r + 1)]);
      triangles.push([idx(c, r), idx(c + 1, r + 1), idx(c, r + 1)]);
    }
  }
  return { vertices, triangles };
}

/**
 * Mesh filling a simple polygon: boundary resampled at `spacing`, interior grid points
 * at `spacing`, Delaunay triangulated, triangles outside the polygon dropped.
 */
export function meshFromPolygon(poly: Vec2[], spacing?: number): MeshData {
  if (poly.length < 3) throw new Error("polygon needs at least 3 points");
  const ring = signedArea(poly) < 0 ? [...poly].reverse() : poly;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const s = spacing && spacing > 0 ? spacing : Math.max(maxX - minX, maxY - minY) / 4;
  const boundary = resamplePolygon(ring, s);
  const points: Vec2[] = boundary.map(([x, y]) => [round(x), round(y)]);
  for (let y = minY + s / 2; y < maxY; y += s) {
    for (let x = minX + s / 2; x < maxX; x += s) {
      const p: Vec2 = [round(x), round(y)];
      if (pointInPolygon(p, ring) && distToPolygonEdge(p, ring) > s * 0.4) points.push(p);
    }
  }
  const tris = delaunay(points).filter(([a, b, c]) => {
    const cen: Vec2 = [(points[a][0] + points[b][0] + points[c][0]) / 3, (points[a][1] + points[b][1] + points[c][1]) / 3];
    return pointInPolygon(cen, ring);
  });
  return { vertices: points, triangles: tris };
}

export interface WeightBone {
  id: string;
  start: Vec2;
  end: Vec2;
}

/**
 * Inverse-distance weights to bone segments. Keeps the `maxInfluences` closest bones
 * per vertex, normalized, rounded to 4 decimals.
 */
export function autoWeights(
  vertices: Vec2[],
  bones: WeightBone[],
  maxInfluences = 2,
  power = 3,
): Array<Array<[string, number]>> {
  if (bones.length === 0) throw new Error("autoWeights needs at least one bone");
  return vertices.map((v) => {
    const scored = bones
      .map((b) => ({ id: b.id, d: distToSegment(v, b.start, b.end) }))
      .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, maxInfluences));
    const raw = scored.map((s) => 1 / Math.max(s.d, 1e-3) ** power);
    const sum = raw.reduce((a, b) => a + b, 0);
    const out: Array<[string, number]> = [];
    let acc = 0;
    scored.forEach((s, i) => {
      const w = round(raw[i] / sum, 4);
      if (w >= 0.01) {
        out.push([s.id, w]);
        acc += w;
      }
    });
    // push rounding residue onto the dominant bone so weights sum to exactly 1
    out[0][1] = round(out[0][1] + (1 - acc), 4);
    return out;
  });
}

/**
 * Grid mesh covering only the cells that contain solid pixels. Handles concave shapes, holes and
 * several islands in one layer. Returns pixel-space vertices (y down) and triangles.
 */
export function alphaGridMesh(rgba: Uint8Array, w: number, h: number, spacing: number, threshold: number): { vertices: Vec2[]; triangles: Tri[] } {
  const cols = Math.max(1, Math.ceil(w / spacing));
  const rows = Math.max(1, Math.ceil(h / spacing));
  const cw = w / cols;
  const ch = h / rows;
  // A cell is kept when a solid pixel lies inside it or within 1px of its border: texture filtering spreads
  // each pixel about a pixel outward, and cutting that off shows up as jagged, dashed edges on fine meshes.
  const solid = new Uint8Array(cols * rows);
  const mark = (px: number, py: number) => {
    const c = Math.floor(px / cw);
    const r = Math.floor(py / ch);
    if (c >= 0 && r >= 0 && c < cols && r < rows) solid[r * cols + c] = 1;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] <= threshold) continue;
      for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) mark(Math.min(w - 1e-6, Math.max(0, x + 0.5 + dx)), Math.min(h - 1e-6, Math.max(0, y + 0.5 + dy)));
    }
  }
  const index = new Map<number, number>();
  const vertices: Vec2[] = [];
  const vid = (c: number, r: number) => {
    const key = r * (cols + 1) + c;
    let i = index.get(key);
    if (i === undefined) {
      i = vertices.length;
      index.set(key, i);
      vertices.push([round(c * cw, 3), round(r * ch, 3)]);
    }
    return i;
  };
  const triangles: Tri[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!solid[r * cols + c]) continue;
      const a = vid(c, r);
      const b = vid(c + 1, r);
      const d = vid(c + 1, r + 1);
      const e = vid(c, r + 1);
      triangles.push([a, b, d], [a, d, e]);
    }
  }
  return { vertices, triangles };
}
