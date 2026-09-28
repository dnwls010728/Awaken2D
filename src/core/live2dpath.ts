// Deformation paths on Live2D art meshes (Cubism's "deformation path" tool): an editing aid. A path is a curve through
// control points pinned inside mesh triangles, so it follows the mesh in every keyform; vertices bound to it (at a
// position along the curve, with an influence) are carried along when a control point is dragged. What it did is
// stored in the keyforms, so the rig poses without it. Pure and browser-safe.
import type { Live2DPath, Vec2 } from "./types.ts";

/** Control points of a path for the given vertex positions (any space: they are blended from the pinning triangles). */
export function pathPoints(path: Live2DPath, verts: ArrayLike<Vec2>): Vec2[] {
  return path.points.map((p) => {
    let x = 0;
    let y = 0;
    for (let k = 0; k < 3; k++) {
      const v = verts[p.tri[k]];
      if (!v) continue;
      x += v[0] * p.w[k];
      y += v[1] * p.w[k];
    }
    return [x, y] as Vec2;
  });
}

/** A point of segment i (control point i to i + 1) at s in 0..1: chordal Catmull-Rom (ends and corners mirror). */
function segmentPoint(ctrl: Vec2[], corners: boolean[], closed: boolean, i: number, s: number): Vec2 {
  const n = ctrl.length;
  const at = (k: number) => ctrl[((k % n) + n) % n];
  const p1 = at(i);
  const p2 = at(i + 1);
  const mirror = (a: Vec2, b: Vec2): Vec2 => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const p0 = corners[i] || (!closed && i === 0) ? mirror(p1, p2) : at(i - 1);
  const p3 = corners[(i + 1) % n] || (!closed && i + 1 === n - 1) ? mirror(p2, p1) : at(i + 2);
  const d = (a: Vec2, b: Vec2) => Math.max(1e-9, Math.hypot(b[0] - a[0], b[1] - a[1]));
  const t1 = d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * s;
  const L = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => [((tb - u) * a[0] + (u - ta) * b[0]) / (tb - ta), ((tb - u) * a[1] + (u - ta) * b[1]) / (tb - ta)];
  const a1 = L(p0, p1, 0, t1);
  const a2 = L(p1, p2, t1, t2);
  const a3 = L(p2, p3, t2, t3);
  return L(L(a1, a2, 0, t2), L(a2, a3, t1, t3), t1, t2);
}

/**
 * Point and unit direction of the curve at t (control point index + fraction). The curve is a chordal Catmull-Rom
 * spline through the control points: it matches the curve points Cubism stores for bound vertices within a pixel
 * (median; work/tools/path-curve-check.ts).
 */
export function pathAt(ctrl: Vec2[], t: number, closed = false, corners: boolean[] = []): { p: Vec2; dir: Vec2 } {
  const n = ctrl.length;
  if (!n) return { p: [0, 0], dir: [1, 0] };
  if (n === 1) return { p: ctrl[0], dir: [1, 0] };
  const segs = closed ? n : n - 1;
  const tc = Math.min(Math.max(t, 0), segs);
  const i = Math.min(Math.floor(tc), segs - 1);
  const s = tc - i;
  const p = segmentPoint(ctrl, corners, closed, i, s);
  const e = 1e-4;
  const q0 = segmentPoint(ctrl, corners, closed, i, Math.max(0, s - e));
  const q1 = segmentPoint(ctrl, corners, closed, i, Math.min(1, s + e));
  let dx = q1[0] - q0[0];
  let dy = q1[1] - q0[1];
  let len = Math.hypot(dx, dy);
  if (len < 1e-12) {
    const b = ctrl[(i + 1) % n];
    dx = b[0] - ctrl[i][0];
    dy = b[1] - ctrl[i][1];
    len = Math.hypot(dx, dy) || 1;
  }
  return { p, dir: [dx / len, dy / len] };
}

/** The curve as a polyline (for drawing). */
export function pathPolyline(path: Live2DPath, ctrl: Vec2[], steps = 12): Vec2[] {
  const corners = path.points.map((p) => !!p.corner);
  const segs = path.closed ? ctrl.length : ctrl.length - 1;
  const out: Vec2[] = [];
  for (let k = 0; k <= segs * steps; k++) out.push(pathAt(ctrl, k / steps, path.closed, corners).p);
  return out;
}

/**
 * Moving control point `index` to `to`: the new positions of the bound vertices ([vertex, x, y]), each carried with the
 * curve (kept at its offset in the curve's frame at its position along it) by its influence. `verts` and `to` are in
 * the same space.
 */
export function pathMoves(path: Live2DPath, verts: ArrayLike<Vec2>, index: number, to: Vec2): Array<[number, number, number]> {
  const corners = path.points.map((p) => !!p.corner);
  const before = pathPoints(path, verts);
  const after = before.map((p, i) => (i === index ? to : p));
  const out: Array<[number, number, number]> = [];
  for (const b of path.bind) {
    const v = verts[b.vertex];
    if (!v) continue;
    const f0 = pathAt(before, b.t, path.closed, corners);
    const f1 = pathAt(after, b.t, path.closed, corners);
    const rx = v[0] - f0.p[0];
    const ry = v[1] - f0.p[1];
    // offset in the old frame (along, across), placed in the new one
    const u = rx * f0.dir[0] + ry * f0.dir[1];
    const w = -rx * f0.dir[1] + ry * f0.dir[0];
    const nx = f1.p[0] + u * f1.dir[0] - w * f1.dir[1];
    const ny = f1.p[1] + u * f1.dir[1] + w * f1.dir[0];
    const k = b.weight;
    if (Math.abs(nx - v[0]) < 1e-9 && Math.abs(ny - v[1]) < 1e-9) continue;
    out.push([b.vertex, v[0] + (nx - v[0]) * k, v[1] + (ny - v[1]) * k]);
  }
  return out;
}

/**
 * Renumbers the vertices of paths after vertices were removed / reordered (`map[old] = new`, -1 = removed): a path
 * that loses a pinning vertex is dropped, bound vertices that are gone are unbound.
 */
export function remapPaths(paths: Live2DPath[] | undefined, map: ArrayLike<number>): Live2DPath[] | undefined {
  if (!paths?.length) return paths;
  const out: Live2DPath[] = [];
  for (const p of paths) {
    if (p.points.some((q) => q.tri.some((i) => (map[i] ?? -1) < 0))) continue;
    out.push({
      ...p,
      points: p.points.map((q) => ({ ...q, tri: q.tri.map((i) => map[i]) as [number, number, number] })),
      bind: p.bind.filter((b) => (map[b.vertex] ?? -1) >= 0).map((b) => ({ ...b, vertex: map[b.vertex] })),
    });
  }
  return out.length ? out : undefined;
}

/** Throws when paths do not fit a mesh of `vertexCount` vertices. */
export function checkPaths(paths: Live2DPath[], vertexCount: number): void {
  const idx = (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < vertexCount;
  paths.forEach((p, k) => {
    if (!Array.isArray(p?.points) || p.points.length < 2) throw new Error(`path ${k}: points needs at least two control points`);
    for (const q of p.points) {
      if (!Array.isArray(q.tri) || q.tri.length !== 3 || !q.tri.every(idx)) throw new Error(`path ${k}: tri must be three vertex indices of the mesh`);
      if (!Array.isArray(q.w) || q.w.length !== 3 || !q.w.every((x) => Number.isFinite(x))) throw new Error(`path ${k}: w must be three weights`);
    }
    if (!Array.isArray(p.bind)) throw new Error(`path ${k}: bind must be a list`);
    const segs = p.closed ? p.points.length : p.points.length - 1;
    for (const b of p.bind) {
      if (!idx(b.vertex)) throw new Error(`path ${k}: bound vertex ${b.vertex} is not a vertex of the mesh`);
      if (!(b.t >= 0 && b.t <= segs)) throw new Error(`path ${k}: t must be within 0..${segs}`);
      if (!(b.weight >= 0 && b.weight <= 1)) throw new Error(`path ${k}: weight must be within 0..1`);
    }
  });
}
