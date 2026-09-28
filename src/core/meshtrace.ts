// Spine-style mesh building: trace an outline (hull) around an image's opaque pixels with a chosen number of
// vertices, triangulate a hull with optional interior vertices (the hull edges stay edges), and find a mesh's
// own outline. Pure: images are RGBA buffers.
import { pointInPolygon, resamplePolygon, signedArea, triArea } from "./geometry.ts";
import { fitUvAffine } from "./meshedit.ts";
import { round } from "./math.ts";
import type { MeshAttachment, Tri, Vec2 } from "./types.ts";
import type { MeshGeometry } from "./meshedit.ts";

export interface TraceOptions {
  /** Hull vertices wanted (4..200). Default 20. */
  detail?: number;
  /** 0..100: how far the hull follows dents and gaps between pieces (0 = convex, 100 = tight). Default 50. */
  concavity?: number;
  /** Alpha (0..255) above which a pixel counts. Default 8. */
  alphaThreshold?: number;
  /** Extra room around the art, in pixels. Default 0. */
  padding?: number;
  /** Least room kept between the art and the outline where it comes closest (corners). Default: padding. */
  minMargin?: number;
}

/** Chamfer (3-4) distance, in pixels, from every pixel to the nearest pixel where `inside` is 1. */
function distanceTo(inside: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = inside[i] ? 0 : INF;
  const a = 1;
  const b = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Connected components (8-neighbour) of a mask: a label per pixel (0 = empty) and the count. */
function components(mask: Uint8Array, w: number, h: number): { label: Int32Array; count: number } {
  const label = new Int32Array(w * h);
  let count = 0;
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    count++;
    label[s] = count;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && !label[j]) {
            label[j] = count;
            stack.push(j);
          }
        }
      }
    }
  }
  return { label, count };
}

/** Outer boundary of the one component in `mask` (Moore-neighbour tracing): pixel centers, in order. */
function traceBoundary(mask: Uint8Array, w: number, h: number): Vec2[] {
  let start = -1;
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  // neighbours clockwise (y down), starting west
  const dirs: Vec2[] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const sx = start % w;
  const sy = (start - sx) / w;
  const out: Vec2[] = [[sx, sy]];
  let cx = sx;
  let cy = sy;
  let back = 0; // we entered the start pixel from the west (scan order)
  for (let guard = 0; guard < w * h * 4; guard++) {
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (at(nx, ny)) {
        back = (d + 4) % 8;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found || (cx === sx && cy === sy)) break;
    out.push([cx, cy]);
  }
  return out;
}

/** Ramer-Douglas-Peucker on an open polyline. */
function rdp(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1;
    let bestD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Visvalingam-Whyatt on a closed ring down to `n` points; returns the indices kept (in order). */
function simplifyRing(ring: Vec2[], n: number): number[] {
  const idx = ring.map((_, i) => i);
  const area = (i: number) => {
    const k = idx.length;
    const a = ring[idx[(i - 1 + k) % k]];
    const b = ring[idx[i]];
    const c = ring[idx[(i + 1) % k]];
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  };
  while (idx.length > n) {
    let best = 0;
    let bestA = Infinity;
    for (let i = 0; i < idx.length; i++) {
      const v = area(i);
      if (v < bestA) {
        bestA = v;
        best = i;
      }
    }
    idx.splice(best, 1);
  }
  return idx;
}

const segmentsCross = (p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2) => {
  const d = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

/** True when no two non-adjacent edges of the ring cross. */
export function isSimplePolygon(poly: Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * Traces a hull around the opaque pixels of an image: a simple polygon (pixel coordinates, y down, counter-clockwise
 * on screen) with about `detail` vertices that encloses every opaque pixel (plus `padding`). Pieces closer than the
 * concavity allows are wrapped together; far-apart pieces are wrapped by their convex hull.
 */
export function traceHull(rgba: Uint8Array, width: number, height: number, opts: TraceOptions = {}): Vec2[] {
  const detail = Math.max(3, Math.min(200, Math.round(opts.detail ?? 20)));
  const concavity = Math.max(0, Math.min(100, opts.concavity ?? 50));
  const threshold = opts.alphaThreshold ?? 8;
  const padding = Math.max(0, opts.padding ?? 0);
  // closing radius: concavity 100 hugs the art, 0 fills every dent (a convex-ish hull)
  const maxDim = Math.max(width, height);
  let radius = Math.round(((100 - concavity) / 100) ** 2 * maxDim * 0.3) + 1;
  const margin = Math.ceil(padding) + 2;
  let solidCount = 0;
  const trace = (r: number): Vec2[] | null => {
    const m = margin + r;
    const w = width + m * 2;
    const h = height + m * 2;
    const solid = new Uint8Array(w * h);
    solidCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (rgba[(y * width + x) * 4 + 3] > threshold) {
          solid[(y + m) * w + x + m] = 1;
          solidCount++;
        }
      }
    }
    if (!solidCount) return [];
    // grow by padding + r, then shrink by r: a closing that also pads
    const toSolid = distanceTo(solid, w, h);
    const grown = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) grown[i] = toSolid[i] <= padding + r ? 1 : 0;
    let mask = grown;
    if (r > 0) {
      const outside = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) outside[i] = grown[i] ? 0 : 1;
      const toOutside = distanceTo(outside, w, h);
      mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) mask[i] = grown[i] && toOutside[i] > r ? 1 : 0;
      // closing must not lose art: keep the padded art itself
      for (let i = 0; i < w * h; i++) if (toSolid[i] <= padding) mask[i] = 1;
    }
    const { label, count } = components(mask, w, h);
    if (count !== 1) return null;
    for (let i = 0; i < w * h; i++) mask[i] = label[i] ? 1 : 0;
    return traceBoundary(mask, w, h).map(([x, y]) => [x - m + 0.5, y - m + 0.5] as Vec2);
  };
  let boundary: Vec2[] | null = null;
  for (let tries = 0; tries < 6 && !boundary; tries++) {
    boundary = trace(radius);
    radius = Math.ceil(radius * 1.8) + 2;
  }
  if (boundary && !boundary.length) throw new Error("the image has no pixels above the alpha threshold");
  let ring: Vec2[];
  if (!boundary) {
    // pieces too far apart: their convex hull (of every opaque pixel's corners)
    const pts: Vec2[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3] > threshold) pts.push([x, y], [x + 1, y + 1], [x + 1, y], [x, y + 1]);
    ring = convexHull(pts);
  } else {
    // RDP on a closed ring: split at the point farthest from the start, simplify both halves
    let far = 0;
    boundary.forEach((p, i) => {
      if (Math.hypot(p[0] - boundary![0][0], p[1] - boundary![0][1]) > Math.hypot(boundary![far][0] - boundary![0][0], boundary![far][1] - boundary![0][1])) far = i;
    });
    ring = [...rdp(boundary.slice(0, far + 1), 0.7).slice(0, -1), ...rdp([...boundary.slice(far), boundary[0]], 0.7).slice(0, -1)];
  }
  if (signedArea(ring) > 0) ring.reverse(); // counter-clockwise on screen (y down) = negative area
  // every solid pixel's corners must end up inside: collect them once (the boundary pixels suffice)
  const corners: Vec2[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] <= threshold) continue;
      const edge = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx < 0 || ny < 0 || nx >= width || ny >= height || rgba[(ny * width + nx) * 4 + 3] <= threshold;
      });
      if (edge) corners.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
    }
  }
  let hull = ring.length > detail ? simplifyRing(ring, detail).map((i) => ring[i]) : ring;
  const minMargin = Math.max(0, opts.minMargin ?? padding);
  hull = enclose(hull, corners, minMargin);
  if (!isSimplePolygon(hull)) {
    // the pushed-out edges crossed: fall back to fewer, larger steps
    hull = enclose(simplifyRing(ring, Math.max(3, Math.round(detail * 0.6))).map((i) => ring[i]), corners, minMargin);
    if (!isSimplePolygon(hull)) hull = enclose(convexHull(corners), corners, minMargin);
  }
  // stay on the image: past its border the texture would repeat its edge pixels
  const clampX = (v: number) => Math.max(0, Math.min(width, v));
  const clampY = (v: number) => Math.max(0, Math.min(height, v));
  return hull.map(([x, y]) => [round(clampX(x), 2), round(clampY(y), 2)] as Vec2);
}

/** Andrew's monotone chain (counter-clockwise on screen, y down). */
function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return signedArea(hull) > 0 ? hull.reverse() : hull;
}

/**
 * Pushes each edge of a counter-clockwise (screen) polygon outward just far enough that every point lies inside,
 * plus `extra`; corners become the crossings of neighbouring edges (clamped where edges are nearly parallel).
 */
function enclose(poly: Vec2[], points: Vec2[], extra: number): Vec2[] {
  const n = poly.length;
  if (n < 3) return poly;
  const orient = signedArea(poly) > 0 ? 1 : -1;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // outward normal for this orientation (y down)
    const nx = (orient * (b[1] - a[1])) / len;
    const ny = (orient * -(b[0] - a[0])) / len;
    return { a, b, nx, ny, off: 0 };
  });
  // each point belongs to the edge it is closest to (by distance to the segment)
  for (const p of points) {
    let best = 0;
    let bestD = Infinity;
    lines.forEach((l, i) => {
      const dx = l.b[0] - l.a[0];
      const dy = l.b[1] - l.a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - l.a[0]) * dx + (p[1] - l.a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(p[0] - (l.a[0] + dx * t), p[1] - (l.a[1] + dy * t));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const l = lines[best];
    const out = (p[0] - l.a[0]) * l.nx + (p[1] - l.a[1]) * l.ny + extra;
    if (out > l.off) l.off = out;
  }
  for (const l of lines) l.off += 0.25;
  const outPoly: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n];
    const l2 = lines[i];
    const v = poly[i];
    // l1 moved: points q with (q - a1) . n1 = off1; same for l2
    const c1 = l1.a[0] * l1.nx + l1.a[1] * l1.ny + l1.off;
    const c2 = l2.a[0] * l2.nx + l2.a[1] * l2.ny + l2.off;
    const det = l1.nx * l2.ny - l1.ny * l2.nx;
    let p: Vec2;
    const far = Math.max(l1.off, l2.off);
    if (Math.abs(det) > 1e-3) {
      p = [(c1 * l2.ny - l1.ny * c2) / det, (l1.nx * c2 - c1 * l2.nx) / det];
      if (Math.hypot(p[0] - v[0], p[1] - v[1]) > far * 3 + 4) p = null as unknown as Vec2;
    } else p = null as unknown as Vec2;
    if (!p) {
      const mx = l1.nx + l2.nx;
      const my = l1.ny + l2.ny;
      const ml = Math.hypot(mx, my) || 1;
      p = [v[0] + (mx / ml) * far, v[1] + (my / ml) * far];
    }
    outPoly.push(p);
  }
  return outPoly;
}

/** Ear clipping of a simple polygon (any orientation). Returns index triangles. */
export function earClip(poly: Vec2[]): Tri[] {
  const n = poly.length;
  if (n < 3) return [];
  const ccw = signedArea(poly) > 0;
  const idx = poly.map((_, i) => i);
  const tris: Tri[] = [];
  // tolerances scaled to the polygon: points on a straight run (outlines resampled along long edges) are collinear
  let span = 0;
  for (const p of poly) span = Math.max(span, Math.abs(p[0] - poly[0][0]), Math.abs(p[1] - poly[0][1]));
  const eps = Math.max(1e-12, span * span * 1e-9);
  const cross = (u: Vec2, v: Vec2, w: Vec2) => ((v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])) * (ccw ? 1 : -1);
  // an ear: a convex corner with no other point strictly inside (a point on its edge, e.g. the next point of a
  // straight run, does not block it)
  let guard = 0;
  const clipAt = (i: number) => {
    tris.push([idx[(i - 1 + idx.length) % idx.length], idx[i], idx[(i + 1) % idx.length]]);
    idx.splice(i, 1);
  };
  const ear = (i: number, e: number) => {
    const ia = idx[(i - 1 + idx.length) % idx.length];
    const ib = idx[i];
    const ic = idx[(i + 1) % idx.length];
    const [a, b, c] = [poly[ia], poly[ib], poly[ic]];
    if (cross(a, b, c) <= e) return false;
    return !idx.some((j) => j !== ia && j !== ib && j !== ic && cross(a, b, poly[j]) > e && cross(b, c, poly[j]) > e && cross(c, a, poly[j]) > e);
  };
  while (idx.length > 3 && guard++ < n * n) {
    // the best-shaped ear (area against its edge lengths): first-found ears fan into long slivers across the shape
    let at = -1;
    let bestShape = -Infinity;
    for (let i = 0; i < idx.length; i++) {
      if (!ear(i, eps)) continue;
      const a = poly[idx[(i - 1 + idx.length) % idx.length]];
      const b = poly[idx[i]];
      const c = poly[idx[(i + 1) % idx.length]];
      const d2 = (p: Vec2, q: Vec2) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      const shape = cross(a, b, c) / (d2(a, b) + d2(b, c) + d2(c, a));
      if (shape > bestShape) {
        bestShape = shape;
        at = i;
      }
    }
    // a thin leftover (nearly collinear points): any strictly convex ear, else the most convex corner, so every
    // vertex still ends up in a triangle
    if (at < 0) at = idx.findIndex((_, i) => ear(i, 0));
    if (at < 0) {
      let best = -Infinity;
      idx.forEach((ib, i) => {
        const c = cross(poly[idx[(i - 1 + idx.length) % idx.length]], poly[ib], poly[idx[(i + 1) % idx.length]]);
        if (c > best) {
          best = c;
          at = i;
        }
      });
    }
    clipAt(at);
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  // flat triangles (a point on the segment between the other two, from straight runs): flip the long edge with the
  // triangle across it, (a, b, c) + (a, c, d) -> (a, b, d) + (b, c, d)
  const area = (t: Tri) => Math.abs(cross(poly[t[0]], poly[t[1]], poly[t[2]]));
  for (let pass = 0; pass < tris.length; pass++) {
    let fixed = false;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      if (area(t) > eps) continue;
      // the middle point is the one between the other two
      const d2 = (p: number, q: number) => (poly[p][0] - poly[q][0]) ** 2 + (poly[p][1] - poly[q][1]) ** 2;
      const k = [0, 1, 2].reduce((best, j) => (d2(t[(j + 1) % 3], t[(j + 2) % 3]) > d2(t[(best + 1) % 3], t[(best + 2) % 3]) ? j : best), 0);
      const b = t[k];
      const a = t[(k + 1) % 3];
      const c = t[(k + 2) % 3];
      const j = tris.findIndex((u, q) => q !== i && u.includes(a) && u.includes(c));
      if (j < 0) continue;
      const d = tris[j].find((v) => v !== a && v !== c)!;
      const t1: Tri = [a, b, d];
      const t2: Tri = [b, c, d];
      if (area(t1) <= eps || area(t2) <= eps) continue;
      tris[i] = t1;
      tris[j] = t2;
      fixed = true;
    }
    if (!fixed) break;
  }
  return tris;
}

/**
 * Triangulates a hull (a simple polygon) with extra points inside it: every hull edge stays an edge, the inside
 * is Delaunay where the hull allows (edge flips). Vertices are the hull first, then the inner points that fell
 * inside. Triangles are counter-clockwise in the points' own orientation (+y up callers get CCW).
 */
export function triangulateHull(hull: Vec2[], inner: Vec2[] = []): { vertices: Vec2[]; triangles: Tri[]; used: number[] } {
  const vertices: Vec2[] = [...hull];
  const tris: Tri[] = earClip(hull);
  /** Indices into `inner` of the points that became vertices (in vertex order after the hull). */
  const used: number[] = [];
  const orient = (t: Tri) => triArea(vertices[t[0]], vertices[t[1]], vertices[t[2]]);
  const isHullEdge = (a: number, b: number) => a < hull.length && b < hull.length && (Math.abs(a - b) === 1 || Math.abs(a - b) === hull.length - 1);
  const inCircle = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
    // > 0 when d is inside the circumcircle of the counter-clockwise triangle abc
    const ax = a[0] - d[0];
    const ay = a[1] - d[1];
    const bx = b[0] - d[0];
    const by = b[1] - d[1];
    const cx = c[0] - d[0];
    const cy = c[1] - d[1];
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  };
  const ccwTri = (t: Tri): Tri => (orient(t) < 0 ? [t[0], t[2], t[1]] : t);
  for (let i = 0; i < tris.length; i++) tris[i] = ccwTri(tris[i]);
  /** Flips non-hull edges until the triangulation is (constrained) Delaunay. */
  const legalize = () => {
    for (let pass = 0; pass < 50; pass++) {
      let flipped = false;
      for (let i = 0; i < tris.length; i++) {
        for (let e = 0; e < 3; e++) {
          const a = tris[i][e];
          const b = tris[i][(e + 1) % 3];
          const c = tris[i][(e + 2) % 3];
          if (isHullEdge(a, b)) continue;
          const j = tris.findIndex((t, k) => k !== i && t.includes(a) && t.includes(b));
          if (j < 0) continue;
          const d = tris[j].find((v) => v !== a && v !== b)!;
          if (inCircle(vertices[a], vertices[b], vertices[c], vertices[d]) <= 1e-9) continue;
          // the flipped pair must stay valid (convex quad)
          const t1 = ccwTri([c, a, d]);
          const t2 = ccwTri([c, d, b]);
          if (Math.abs(orient(t1)) < 1e-9 || Math.abs(orient(t2)) < 1e-9) continue;
          if (!segmentsCross(vertices[a], vertices[b], vertices[c], vertices[d])) continue;
          tris[i] = t1;
          tris[j] = t2;
          flipped = true;
        }
      }
      if (!flipped) break;
    }
  };
  legalize();
  for (const [pi, p] of inner.entries()) {
    if (!pointInPolygon(p, hull)) continue;
    if (vertices.some((v) => Math.hypot(v[0] - p[0], v[1] - p[1]) < 1e-6)) continue;
    const t = tris.findIndex(([a, b, c]) => {
      const s = (u: Vec2, v: Vec2) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
      return s(vertices[a], vertices[b]) >= -1e-9 && s(vertices[b], vertices[c]) >= -1e-9 && s(vertices[c], vertices[a]) >= -1e-9;
    });
    if (t < 0) continue;
    const k = vertices.length;
    const [a, b, c] = tris[t];
    // on an edge: split the triangles on both sides of it (no T-junction); on a hull edge the hull gains nothing
    const sides: Array<[number, number, number]> = [[a, b, c], [b, c, a], [c, a, b]];
    const onEdge = sides.find(([u, v]) => Math.abs((vertices[v][0] - vertices[u][0]) * (p[1] - vertices[u][1]) - (vertices[v][1] - vertices[u][1]) * (p[0] - vertices[u][0])) < 1e-9 * (1 + Math.hypot(vertices[v][0] - vertices[u][0], vertices[v][1] - vertices[u][1])));
    if (onEdge && isHullEdge(onEdge[0], onEdge[1])) continue;
    vertices.push(p);
    used.push(pi);
    if (onEdge) {
      const [u, v, w] = onEdge;
      const n = tris.findIndex((tri, q) => q !== t && tri.includes(u) && tri.includes(v));
      const other = n >= 0 ? tris[n].find((x) => x !== u && x !== v)! : -1;
      const repl: Tri[] = [[u, k, w], [k, v, w]];
      if (n >= 0) repl.push([v, k, other], [k, u, other]);
      for (const q of [t, n].filter((q) => q >= 0).sort((x, y) => y - x)) tris.splice(q, 1);
      tris.push(...repl.map(ccwTri));
    } else tris.splice(t, 1, [a, b, k], [b, c, k], [c, a, k]);
  }
  legalize();
  return { vertices, triangles: tris.filter((t) => Math.abs(orient(t)) > 1e-9), used };
}

/** Points on a grid of `spacing` inside the hull, at least half a step from its edges ("Generate"). */
export function interiorPoints(hull: Vec2[], spacing: number): Vec2[] {
  if (!(spacing > 0)) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of hull) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const out: Vec2[] = [];
  const n = hull.length;
  const edgeDist = (p: Vec2) => {
    let d = Infinity;
    for (let i = 0; i < n; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      d = Math.min(d, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)));
    }
    return d;
  };
  // staggered rows give nicer triangles than a square grid
  const rowH = spacing * 0.866;
  let row = 0;
  for (let y = minY + rowH / 2; y < maxY; y += rowH, row++) {
    for (let x = minX + (row % 2 ? spacing : spacing / 2); x < maxX; x += spacing) {
      const p: Vec2 = [round(x, 3), round(y, 3)];
      if (pointInPolygon(p, hull) && edgeDist(p) > spacing * 0.5) out.push(p);
    }
  }
  return out;
}

/**
 * Outline loops of a mesh (edges used by one triangle), each as vertex indices in order, largest area first.
 */
export function meshOutline(vertices: Vec2[], triangles: Tri[]): number[][] {
  const count = new Map<string, number>();
  const dir = new Map<string, [number, number]>();
  for (const [a, b, c] of triangles) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      count.set(key, (count.get(key) ?? 0) + 1);
      dir.set(key, [p, q]);
    }
  }
  const next = new Map<number, number>();
  for (const [key, n] of count) if (n === 1) next.set(dir.get(key)![0], dir.get(key)![1]);
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const s of next.keys()) {
    if (seen.has(s)) continue;
    const loop: number[] = [];
    let v: number | undefined = s;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  const area = (l: number[]) => Math.abs(signedArea(l.map((i) => vertices[i])));
  return loops.sort((a, b) => area(b) - area(a));
}

export interface TraceMeshOptions extends TraceOptions {
  /** Spacing (image pixels) of interior vertices; 0 or absent = the hull only. */
  interior?: number;
  /**
   * Only this part of the image (pixels), e.g. a mesh's own area on a shared texture page. Default: the part its
   * current UVs cover when that is less than the whole image, else the whole image.
   */
  region?: { x: number; y: number; width: number; height: number };
}

/**
 * Spine's "Trace": a new mesh for an image attachment from a hull traced around its opaque pixels (and interior
 * vertices at `interior` spacing). Placement comes from the mesh's current UV mapping, so the art stays put.
 */
export function meshFromTrace(att: MeshAttachment, rgba: Uint8Array, width: number, height: number, opts: TraceMeshOptions = {}): MeshGeometry {
  if (!att.uvs?.length) throw new Error("the mesh has no image UVs to place a new mesh with");
  const toWorld = fitUvAffine(att.uvs, att.vertices);
  if (!toWorld) throw new Error("cannot derive the image placement from the current UVs (degenerate mesh)");
  const r = opts.region ?? uvRegion(att.uvs, width, height);
  let data = rgba;
  if (r.x !== 0 || r.y !== 0 || r.width !== width || r.height !== height) {
    data = new Uint8Array(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) data.set(rgba.subarray(((y + r.y) * width + r.x) * 4, ((y + r.y) * width + r.x + r.width) * 4), y * r.width * 4);
  }
  const hull = traceHull(data, r.width, r.height, opts);
  const { vertices: px, triangles } = triangulateHull(hull, interiorPoints(hull, opts.interior ?? 0));
  return placeGeometry(px.map(([x, y]) => [x + r.x, y + r.y] as Vec2), triangles, width, height, toWorld);
}

/** Pixel rectangle a mesh's UVs cover (grown by 2 px); the whole image when that is most of it. */
export function uvRegion(uvs: Vec2[], width: number, height: number): { x: number; y: number; width: number; height: number } {
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const [u, v] of uvs) {
    u0 = Math.min(u0, u);
    v0 = Math.min(v0, v);
    u1 = Math.max(u1, u);
    v1 = Math.max(v1, v);
  }
  const x = Math.max(0, Math.floor(u0 * width) - 2);
  const y = Math.max(0, Math.floor(v0 * height) - 2);
  const w = Math.min(width, Math.ceil(u1 * width) + 2) - x;
  const h = Math.min(height, Math.ceil(v1 * height) + 2) - y;
  if (w <= 0 || h <= 0 || w * h > width * height * 0.9) return { x: 0, y: 0, width, height };
  return { x, y, width: w, height: h };
}

/** Pixel-space geometry (y down) placed in the world through the image's UV mapping; triangles made CCW in world. */
function placeGeometry(px: Vec2[], triangles: Tri[], width: number, height: number, toWorld: (uv: Vec2) => Vec2): MeshGeometry {
  const uvs = px.map(([x, y]) => [round(x / width, 5), round(y / height, 5)] as Vec2);
  const vertices = uvs.map((uv) => toWorld(uv).map((v) => round(v)) as Vec2);
  const tris = triangles.map((t): Tri => (triArea(vertices[t[0]], vertices[t[1]], vertices[t[2]]) < 0 ? [t[0], t[2], t[1]] : t));
  return { vertices, uvs, triangles: tris };
}

/**
 * Spine's "Generate": keeps the mesh's outline (its largest loop) and fills it with vertices at `spacing` world
 * units; the old interior vertices are dropped. UVs follow the image mapping of the current mesh.
 */
export function meshFillInterior(att: MeshAttachment, spacing: number): MeshGeometry {
  const loops = meshOutline(att.vertices, att.triangles);
  if (!loops.length) throw new Error("the mesh has no outline");
  const loop = loops[0];
  const hull = loop.map((i) => att.vertices[i]);
  const { vertices, triangles } = triangulateHull(hull, interiorPoints(hull, spacing));
  let uvs: Vec2[] | undefined;
  if (att.uvs?.length) {
    const toUv = fitUvAffine(att.vertices, att.uvs);
    if (!toUv) throw new Error("cannot derive the image mapping of this mesh");
    // hull vertices keep their exact UVs, new ones follow the mapping
    uvs = vertices.map((p, i) => (i < loop.length ? att.uvs![loop[i]] : (toUv(p).map((v) => round(v, 5)) as Vec2)));
  }
  const tris = triangles.map((t): Tri => (triArea(vertices[t[0]], vertices[t[1]], vertices[t[2]]) < 0 ? [t[0], t[2], t[1]] : t));
  return { vertices: vertices.map(([x, y]) => [round(x), round(y)] as Vec2), ...(uvs ? { uvs } : {}), triangles: tris };
}

/** Spine's "Reset": a 4-vertex rectangle over the whole image (UV 0..1), placed by the current mapping. */
export function meshReset(att: MeshAttachment): MeshGeometry {
  if (!att.uvs?.length) throw new Error("the mesh has no image UVs");
  const toWorld = fitUvAffine(att.uvs, att.vertices);
  if (!toWorld) throw new Error("cannot derive the image placement from the current UVs (degenerate mesh)");
  return placeGeometry([[0, 0], [1, 0], [1, 1], [0, 1]], [[0, 1, 2], [0, 2, 3]], 1, 1, toWorld);
}

/**
 * A new outline vertex at `p` (outside or on the mesh): inserted into the outline loop at the nearest edge, the
 * mesh re-triangulated with its inner vertices kept. Returns the geometry and the new vertex index.
 */
export function meshAddHullVertex(att: MeshAttachment, p: Vec2): { geometry: MeshGeometry; index: number } {
  const loops = meshOutline(att.vertices, att.triangles);
  if (!loops.length) throw new Error("the mesh has no outline");
  const loop = loops[0];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = att.vertices[loop[i]];
    const b = att.vertices[loop[(i + 1) % loop.length]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const hullIdx = [...loop.slice(0, best + 1), -1, ...loop.slice(best + 1)];
  const hull = hullIdx.map((i) => (i < 0 ? p : att.vertices[i]));
  if (!isSimplePolygon(hull)) throw new Error("a vertex there would make the outline cross itself");
  const inLoop = new Set(loop);
  const innerIdx = att.vertices.map((_, i) => i).filter((i) => !inLoop.has(i));
  const { vertices, triangles, used } = triangulateHull(hull, innerIdx.map((i) => att.vertices[i]));
  // map back: hull (with the new one), then the inner vertices that were kept
  const source = [...hullIdx, ...used.map((k) => innerIdx[k])];
  let uvs: Vec2[] | undefined;
  if (att.uvs?.length) {
    const toUv = fitUvAffine(att.vertices, att.uvs);
    if (!toUv) throw new Error("cannot derive the image mapping of this mesh");
    uvs = source.map((i) => (i >= 0 ? att.uvs![i] : (toUv(p).map((v) => round(v, 5)) as Vec2)));
  }
  const tris = triangles.map((t): Tri => (triArea(vertices[t[0]], vertices[t[1]], vertices[t[2]]) < 0 ? [t[0], t[2], t[1]] : t));
  return { geometry: { vertices: vertices.map(([x, y]) => [round(x), round(y)] as Vec2), ...(uvs ? { uvs } : {}), triangles: tris }, index: hullIdx.indexOf(-1) };
}

// ---------- Cubism-style automatic mesh generation and quartering

/**
 * Cubism's Automatic Mesh Generator settings. Lengths are pixels of a 1024 texture (scaled with the texture, as
 * Cubism does): the outline sits `outerMargin` outside the art with points every `outerInterval`; an inner ring
 * `innerMargin` inside the outline follows it; inner points are `innerInterval` apart.
 */
export interface AutoMeshOptions {
  outerInterval: number;
  innerInterval: number;
  outerMargin: number;
  innerMargin: number;
  /** Least room between art and outline at tight spots (corners). Default 2. */
  minMargin?: number;
  /** Fewest outline points (3 or more). Default 4. */
  minBoundaryPoints?: number;
  /** Alpha (0..255) at or below which a pixel is transparent. Default 10. */
  alphaThreshold?: number;
  /** Multiplier for the lengths. Default: texture size / 1024 on a shared texture page, else 1. */
  textureScale?: number;
}

/** Awaken2D's presets in the spirit of Cubism's (its own numbers are not published). */
export const AUTO_MESH_PRESETS: Record<string, AutoMeshOptions> = {
  standard: { outerInterval: 20, innerInterval: 40, outerMargin: 5, innerMargin: 12, minMargin: 2, minBoundaryPoints: 4, alphaThreshold: 10 },
  "deformation-small": { outerInterval: 32, innerInterval: 70, outerMargin: 4, innerMargin: 10, minMargin: 2, minBoundaryPoints: 4, alphaThreshold: 10 },
  "deformation-large": { outerInterval: 14, innerInterval: 24, outerMargin: 6, innerMargin: 10, minMargin: 2, minBoundaryPoints: 6, alphaThreshold: 10 },
};

const perimeter = (poly: Vec2[]) => poly.reduce((s, p, i) => s + Math.hypot(poly[(i + 1) % poly.length][0] - p[0], poly[(i + 1) % poly.length][1] - p[1]), 0);

/** Distance from a point to a closed polygon's edges. */
function edgeDistance(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)));
  }
  return d;
}

/** The mesh's own part of its texture (a crop when its UVs cover less than the page). */
function regionPixels(att: MeshAttachment, rgba: Uint8Array, width: number, height: number) {
  const r = uvRegion(att.uvs!, width, height);
  let data = rgba;
  if (r.x !== 0 || r.y !== 0 || r.width !== width || r.height !== height) {
    data = new Uint8Array(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) data.set(rgba.subarray(((y + r.y) * width + r.x) * 4, ((y + r.y) * width + r.x + r.width) * 4), y * r.width * 4);
  }
  return { r, data };
}

/**
 * Cubism's Automatic Mesh Generator for an image mesh: outline, inner ring and inner points in pixel space of the
 * art (the mesh's own part of a shared texture page), placed through the mesh's current UV mapping.
 */
export function meshAutoGenerate(att: MeshAttachment, rgba: Uint8Array, width: number, height: number, o: AutoMeshOptions): MeshGeometry {
  if (!att.uvs?.length) throw new Error("the mesh has no image UVs to place a new mesh with");
  const toWorld = fitUvAffine(att.uvs, att.vertices);
  if (!toWorld) throw new Error("cannot derive the image placement from the current UVs (degenerate mesh)");
  const { r, data } = regionPixels(att, rgba, width, height);
  // Cubism's lengths are pixels of a 1024 texture page; a mesh with its own image uses its pixels as they are
  const shared = r.width !== width || r.height !== height;
  const k = o.textureScale ?? (shared ? Math.max(width, height) / 1024 : 1);
  const outerI = Math.max(2, o.outerInterval * k);
  const innerI = Math.max(2, o.innerInterval * k);
  const innerM = Math.max(0, o.innerMargin * k);
  const minPts = Math.max(3, Math.round(o.minBoundaryPoints ?? 4));
  const base = { concavity: 85, alphaThreshold: o.alphaThreshold ?? 10, padding: Math.max(0, o.outerMargin * k), minMargin: Math.max(0, (o.minMargin ?? 2) * k) };
  // outline: as many points as the spacing asks for (a first fine trace measures it)
  const fine = traceHull(data, r.width, r.height, { ...base, detail: 200 });
  const want = Math.max(minPts, Math.min(200, Math.round(perimeter(fine) / outerI)));
  let outer = traceHull(data, r.width, r.height, { ...base, detail: want });
  // long straight runs get points too, so the outline bends evenly
  const split = resamplePolygon(outer, outerI * 1.5).map(([x, y]) => [Math.max(0, Math.min(r.width, x)), Math.max(0, Math.min(r.height, y))] as Vec2);
  if (isSimplePolygon(split)) outer = split;
  // inner ring: each outline point moved inward along its corner's bisector
  const n = outer.length;
  const orient = signedArea(outer) > 0 ? 1 : -1;
  const inner: Vec2[] = [];
  if (innerM > 0) {
    for (let i = 0; i < n; i++) {
      const a = outer[(i - 1 + n) % n];
      const v = outer[i];
      const b = outer[(i + 1) % n];
      const n1 = [-(v[1] - a[1]) * orient, (v[0] - a[0]) * orient];
      const n2 = [-(b[1] - v[1]) * orient, (b[0] - v[0]) * orient];
      const l1 = Math.hypot(n1[0], n1[1]) || 1;
      const l2 = Math.hypot(n2[0], n2[1]) || 1;
      const bx = n1[0] / l1 + n2[0] / l2;
      const by = n1[1] / l1 + n2[1] / l2;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-6) continue;
      const p: Vec2 = [v[0] + (bx / bl) * innerM, v[1] + (by / bl) * innerM];
      if (!pointInPolygon(p, outer) || edgeDistance(p, outer) < innerM * 0.5) continue;
      if (inner.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < outerI * 0.6)) continue;
      inner.push(p);
    }
  }
  // inner points: a grid clear of the ring
  const grid = interiorPoints(outer, innerI).filter(
    (p) => edgeDistance(p, outer) > innerM + innerI * 0.35 && !inner.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < innerI * 0.5),
  );
  const { vertices: px, triangles } = triangulateHull(outer, [...inner, ...grid]);
  return placeGeometry(px.map(([x, y]) => [x + r.x, y + r.y] as Vec2), triangles, width, height, toWorld);
}

/**
 * Cubism's Quartering: every triangle split into four through its edge midpoints (shared edges share their new
 * vertex), so the mesh bends more smoothly without changing its shape. UVs are interpolated.
 */
export function meshQuarter(att: MeshAttachment): MeshGeometry {
  const vertices = att.vertices.map((v) => [v[0], v[1]] as Vec2);
  const uvs = att.uvs?.map((v) => [v[0], v[1]] as Vec2);
  const mid = new Map<string, number>();
  const at = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let i = mid.get(key);
    if (i === undefined) {
      i = vertices.length;
      vertices.push([round((vertices[a][0] + vertices[b][0]) / 2), round((vertices[a][1] + vertices[b][1]) / 2)]);
      if (uvs) uvs.push([round((uvs[a][0] + uvs[b][0]) / 2, 5), round((uvs[a][1] + uvs[b][1]) / 2, 5)]);
      mid.set(key, i);
    }
    return i;
  };
  const triangles: Tri[] = [];
  for (const [a, b, c] of att.triangles) {
    const ab = at(a, b);
    const bc = at(b, c);
    const ca = at(c, a);
    triangles.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  }
  return { vertices, ...(uvs ? { uvs } : {}), triangles };
}
