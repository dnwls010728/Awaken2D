// Edit operations for Live2D rigs (keyforms, deformers, parts) and the helpers that keep Live2D meshes consistent
// when ordinary mesh ops change them. World positions in these ops are Awaken2D world units (pixels, +y up); the
// rig stores each point in its parent deformer's space, so edits go through the parent's inverse mapping at the
// parameter values of the keyform being edited.
import { gridBlend, gridSize, live2dFrame, live2dMeshes, rotationPoint, turnAt, warpPoint } from "./live2d.ts";
import type { Live2DDeformerState, Live2DFrame, RotationState } from "./live2d.ts";
import type { ParamValues } from "./params.ts";
import type {
  Deformer,
  Key,
  KeyformGrid,
  Live2DMesh,
  Live2DRig,
  MeshAttachment,
  MeshKeyform,
  Model,
  Part,
  RGB,
  RotationDeformer,
  RotationKeyform,
  Vec2,
  WarpDeformer,
  WarpKeyform,
} from "./types.ts";

export type Live2DOp =
  | {
      op: "setKeyform";
      /** An art mesh (attachment id), deformer, part or glue id. */
      target: string;
      /** Parameter values of the keyform (a grid point); bound parameters not given use their defaults. */
      at?: Record<string, number>;
      /** Mesh vertices / warp lattice points: [index, x, y] world positions. */
      moves?: Array<[number, number, number]>;
      /** Mesh vertices / warp lattice points: [index, dx, dy] world offsets. */
      offsets?: Array<[number, number, number]>;
      /** Rotation deformer: origin (world), angle (degrees, local), scale (local). */
      origin?: Vec2;
      angle?: number;
      scale?: number;
      reflectX?: boolean;
      reflectY?: boolean;
      opacity?: number;
      drawOrder?: number;
      multiply?: RGB | null;
      screen?: RGB | null;
      /** Glue intensity. */
      intensity?: number;
    }
  | { op: "setKeyformKeys"; target: string; param: string; keys: number[] | null }
  | {
      op: "addDeformer";
      id: string;
      type: "warp" | "rotation";
      parent?: string | null;
      part?: string | null;
      /** Warp: world rectangle (default: the bounds of `children`, padded). */
      rect?: { x: number; y: number; width: number; height: number };
      cols?: number;
      rows?: number;
      bilinear?: boolean;
      /** Rotation: world origin (default: the center of `children`). */
      origin?: Vec2;
      baseAngle?: number;
      /** Art meshes (attachment ids) and deformers to move under the new deformer (their look is kept). */
      children?: string[];
    }
  | { op: "updateDeformer"; id: string; parent?: string | null; part?: string | null; bilinear?: boolean; hidden?: boolean; disabled?: boolean }
  | { op: "removeDeformer"; id: string }
  | { op: "setLive2DMesh"; attachment: string; deformer?: string | null; part?: string | null; hidden?: boolean; disabled?: boolean }
  | { op: "addPart"; id: string; parent?: string | null; name?: string; visible?: boolean }
  | { op: "updatePart"; id: string; parent?: string | null; name?: string; visible?: boolean; disabled?: boolean }
  | { op: "removePart"; id: string }
  | {
      op: "enableLive2D";
      /** Pixels per canvas unit and the canvas; default from the meshes' bounds. */
      canvas?: { width: number; height: number; originX: number; originY: number; pixelsPerUnit: number };
      /** Meshes to turn into Live2D art meshes (default: all). */
      attachments?: string[];
    }
  | { op: "setPartOpacityKeys"; animation: string; part: string; keys: Key<number>[]; mode?: "replace" | "merge" };

export const LIVE2D_OP_NAMES: Live2DOp["op"][] = [
  "setKeyform",
  "setKeyformKeys",
  "addDeformer",
  "updateDeformer",
  "removeDeformer",
  "setLive2DMesh",
  "addPart",
  "updatePart",
  "removePart",
  "enableLive2D",
  "setPartOpacityKeys",
];

const r7 = (n: number) => Math.round(n * 1e7) / 1e7;

// ---------- values, grids

export function defaultParamValues(m: Model): ParamValues {
  return Object.fromEntries((m.parameters ?? []).map((p) => [p.id, p.default]));
}

function eps(m: Model, param: string): number {
  return 0.1 ** (m.parameters?.find((p) => p.id === param)?.decimals ?? 3);
}

/** Parameter values of a grid point (other parameters at their defaults). */
export function gridPointValues(m: Model, grid: KeyformGrid, index: number): ParamValues {
  const v = defaultParamValues(m);
  let rest = index;
  grid.params.forEach((p, i) => {
    const n = grid.keys[i].length;
    v[p] = grid.keys[i][rest % n];
    rest = Math.floor(rest / n);
  });
  return v;
}

/** Index of the grid point at these values (each bound parameter must sit on one of its keys). */
export function gridIndexAt(m: Model, grid: KeyformGrid, at: Record<string, number> | undefined, what: string): number {
  const defaults = defaultParamValues(m);
  let index = 0;
  let stride = 1;
  grid.params.forEach((p, i) => {
    const v = at?.[p] ?? defaults[p];
    const k = grid.keys[i].findIndex((x) => Math.abs(x - v) < eps(m, p));
    if (k < 0) throw new Error(`${what}: parameter "${p}" is ${v}, not on a key of ${what} (keys ${grid.keys[i].join(", ")}); add the key with setKeyformKeys first`);
    index += k * stride;
    stride *= grid.keys[i].length;
  });
  return index;
}

/** Forms for a new grid, evaluated from the old grid (multilinear, as the rig itself blends). */
function resample<T>(m: Model, oldGrid: KeyformGrid, oldForms: T[], newGrid: KeyformGrid, blend: (terms: Array<[number, number]>) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < gridSize(newGrid); i++) {
    const values = gridPointValues(m, newGrid, i);
    const b = gridBlend(oldGrid, values, (p) => eps(m, p));
    out.push(blend(b.terms.filter(([k]) => k < oldForms.length)));
  }
  return out;
}

const mixNum = (terms: Array<[number, number]>, get: (i: number) => number) => terms.reduce((s, [i, w]) => s + get(i) * w, 0);
const mixPoints = (terms: Array<[number, number]>, get: (i: number) => number[]) => {
  const n = terms.length ? get(terms[0][0]).length : 0;
  const out = new Array<number>(n).fill(0);
  for (const [i, w] of terms) get(i).forEach((x, k) => (out[k] += x * w));
  return out.map(r7);
};
const mixRGB = (terms: Array<[number, number]>, get: (i: number) => RGB | undefined, def: RGB): RGB | undefined => {
  if (terms.every(([i]) => !get(i))) return undefined;
  const c: RGB = [0, 0, 0];
  for (const [i, w] of terms) {
    const x = get(i) ?? def;
    c[0] += x[0] * w;
    c[1] += x[1] * w;
    c[2] += x[2] * w;
  }
  return c.map(r7) as RGB;
};

function blendMeshForms(forms: MeshKeyform[]) {
  return (t: Array<[number, number]>): MeshKeyform => {
    const f: MeshKeyform = { points: mixPoints(t, (i) => forms[i].points) };
    const op = mixNum(t, (i) => forms[i].opacity ?? 1);
    if (Math.abs(op - 1) > 1e-9) f.opacity = r7(op);
    f.drawOrder = r7(mixNum(t, (i) => forms[i].drawOrder ?? 500));
    const mu = mixRGB(t, (i) => forms[i].multiply, [1, 1, 1]);
    const sc = mixRGB(t, (i) => forms[i].screen, [0, 0, 0]);
    if (mu) f.multiply = mu;
    if (sc) f.screen = sc;
    return f;
  };
}

function blendWarpForms(forms: WarpKeyform[]) {
  return (t: Array<[number, number]>): WarpKeyform => {
    const f: WarpKeyform = { points: mixPoints(t, (i) => forms[i].points) };
    const op = mixNum(t, (i) => forms[i].opacity ?? 1);
    if (Math.abs(op - 1) > 1e-9) f.opacity = r7(op);
    const mu = mixRGB(t, (i) => forms[i].multiply, [1, 1, 1]);
    const sc = mixRGB(t, (i) => forms[i].screen, [0, 0, 0]);
    if (mu) f.multiply = mu;
    if (sc) f.screen = sc;
    return f;
  };
}

function blendRotationForms(forms: RotationKeyform[]) {
  return (t: Array<[number, number]>): RotationKeyform => {
    const first = forms[t[0]?.[0] ?? 0];
    const f: RotationKeyform = {
      x: r7(mixNum(t, (i) => forms[i].x)),
      y: r7(mixNum(t, (i) => forms[i].y)),
      angle: r7(mixNum(t, (i) => forms[i].angle)),
      scale: r7(mixNum(t, (i) => forms[i].scale)),
      ...(first?.reflectX ? { reflectX: true } : {}),
      ...(first?.reflectY ? { reflectY: true } : {}),
    };
    const op = mixNum(t, (i) => forms[i].opacity ?? 1);
    if (Math.abs(op - 1) > 1e-9) f.opacity = r7(op);
    const mu = mixRGB(t, (i) => forms[i].multiply, [1, 1, 1]);
    const sc = mixRGB(t, (i) => forms[i].screen, [0, 0, 0]);
    if (mu) f.multiply = mu;
    if (sc) f.screen = sc;
    return f;
  };
}

// ---------- mapping between world, canvas and a deformer's space

const ppu = (m: Model) => m.live2d?.canvas.pixelsPerUnit || 1;
export const worldToCanvas = (m: Model, [x, y]: Vec2): Vec2 => [x / ppu(m), -y / ppu(m)];
export const canvasToWorldPt = (m: Model, [x, y]: Vec2): Vec2 => [x * ppu(m), -y * ppu(m)];

/** Maps a point of a deformer's space (or the canvas, for null) to the canvas, for a frame. */
export function forwardPoint(m: Model, frame: Live2DFrame, deformer: string | null, x: number, y: number): Vec2 {
  if (!deformer) return [x, y];
  const d = m.live2d!.deformers.find((q) => q.id === deformer);
  const s = frame.deformers.get(deformer);
  if (!d || !s) return [x, y];
  return d.type === "warp" ? warpPoint(s.grid!, d.cols, d.rows, !!d.bilinear, x, y) : rotationPoint(s.rotation!, d.baseAngle, x, y);
}

function inverseRotation(r: RotationState, baseAngle: number, cx: number, cy: number): Vec2 {
  const a = ((baseAngle + r.angle) * Math.PI) / 180;
  const dx = cx - r.x;
  const dy = cy - r.y;
  const lx = (Math.cos(a) * dx + Math.sin(a) * dy) / (r.scale || 1e-12);
  const ly = (-Math.sin(a) * dx + Math.cos(a) * dy) / (r.scale || 1e-12);
  return [r.reflectX ? -lx : lx, r.reflectY ? -ly : ly];
}

/** Newton's method on the warp mapping (piecewise smooth; the far field is affine, which gives the start). */
function inverseWarp(d: WarpDeformer, s: Live2DDeformerState, cx: number, cy: number): Vec2 {
  const f = (u: number, v: number) => warpPoint(s.grid!, d.cols, d.rows, !!d.bilinear, u, v);
  // start: the best of a coarse scan over the lattice
  let best: Vec2 = [0.5, 0.5];
  let bestErr = Infinity;
  for (let j = -2; j <= d.rows + 2; j++) {
    for (let i = -2; i <= d.cols + 2; i++) {
      const u = (i + 0.5) / d.cols;
      const v = (j + 0.5) / d.rows;
      const p = f(u, v);
      const e = Math.hypot(p[0] - cx, p[1] - cy);
      if (e < bestErr) {
        bestErr = e;
        best = [u, v];
      }
    }
  }
  let [u, v] = best;
  for (let it = 0; it < 60; it++) {
    const p = f(u, v);
    const ex = p[0] - cx;
    const ey = p[1] - cy;
    if (Math.hypot(ex, ey) < 1e-12) break;
    const h = 1e-6;
    const pu = f(u + h, v);
    const pv = f(u, v + h);
    const a = (pu[0] - p[0]) / h;
    const b = (pv[0] - p[0]) / h;
    const c = (pu[1] - p[1]) / h;
    const dd = (pv[1] - p[1]) / h;
    const det = a * dd - b * c;
    if (Math.abs(det) < 1e-18) break;
    let du = (dd * ex - b * ey) / det;
    let dv = (-c * ex + a * ey) / det;
    // damped step: never more than a cell at once
    const lim = 1 / Math.max(d.cols, d.rows);
    const len = Math.hypot(du, dv);
    if (len > lim) {
      du *= lim / len;
      dv *= lim / len;
    }
    u -= du;
    v -= dv;
  }
  return [u, v];
}

/** Maps a canvas point into a deformer's space (or keeps it, for the canvas), for a frame. */
export function inversePoint(m: Model, frame: Live2DFrame, deformer: string | null, cx: number, cy: number): Vec2 {
  if (!deformer) return [cx, cy];
  const d = m.live2d!.deformers.find((q) => q.id === deformer);
  const s = frame.deformers.get(deformer);
  if (!d || !s) return [cx, cy];
  return d.type === "warp" ? inverseWarp(d, s, cx, cy) : inverseRotation(s.rotation!, d.baseAngle, cx, cy);
}

/** A fresh frame at some parameter values (not cached with anything else). */
function frameAt(m: Model, values: ParamValues): Live2DFrame {
  return live2dFrame(m, { ...values });
}

// ---------- node access

type Node =
  | { kind: "mesh"; id: string; att: MeshAttachment & { live2d: Live2DMesh } }
  | { kind: "deformer"; id: string; d: Deformer }
  | { kind: "part"; id: string; p: Part }
  | { kind: "glue"; id: string; index: number };

function requireRig(m: Model): Live2DRig {
  if (!m.live2d) throw new Error("the model has no Live2D rig (enableLive2D creates one)");
  return m.live2d;
}

function findNode(m: Model, id: string): Node {
  const rig = requireRig(m);
  const att = m.attachments[id];
  if (att?.live2d) return { kind: "mesh", id, att: att as MeshAttachment & { live2d: Live2DMesh } };
  const d = rig.deformers.find((x) => x.id === id);
  if (d) return { kind: "deformer", id, d };
  const p = rig.parts.find((x) => x.id === id);
  if (p) return { kind: "part", id, p };
  const gi = (rig.glue ?? []).findIndex((g) => g.id === id);
  if (gi >= 0) return { kind: "glue", id, index: gi };
  if (att) throw new Error(`"${id}" is not a Live2D art mesh (setLive2DMesh makes it one)`);
  throw new Error(`unknown Live2D object "${id}"`);
}

/** Replaces the rig object (copy on write: applyOps may share it with the previous model). */
function ownRig(m: Model): Live2DRig {
  m.live2d = structuredClone(requireRig(m));
  return m.live2d;
}

/** Replaces an attachment object with a copy whose live2d data can be edited. */
function ownMesh(m: Model, id: string): MeshAttachment & { live2d: Live2DMesh } {
  const copy = structuredClone(m.attachments[id]) as MeshAttachment & { live2d: Live2DMesh };
  m.attachments[id] = copy;
  return copy;
}

/** World positions (setup, at the defaults) of every Live2D mesh, refreshed after rig edits. */
export function refreshLive2DVertices(m: Model, only?: string[]): void {
  if (!m.live2d) return;
  const frame = frameAt(m, defaultParamValues(m));
  for (const [id, att] of live2dMeshes(m)) {
    if (only && !only.includes(id)) continue;
    const s = frame.meshes.get(id);
    if (!s) continue;
    const verts: Vec2[] = [];
    for (let i = 0; i + 1 < s.points.length; i += 2) {
      const [x, y] = canvasToWorldPt(m, [s.points[i], s.points[i + 1]]);
      verts.push([Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
    }
    if (verts.length === att.vertices.length && verts.every((v, i) => v[0] === att.vertices[i][0] && v[1] === att.vertices[i][1])) continue;
    m.attachments[id] = { ...att, vertices: verts };
  }
}

// ---------- re-expressing a node under another parent (its look at every keyform stays)

function reparentPoints(m: Model, grid: KeyformGrid, forms: Array<{ points: number[] }>, from: string | null, to: string | null): void {
  forms.forEach((f, k) => {
    const frame = frameAt(m, gridPointValues(m, grid, k));
    for (let i = 0; i + 1 < f.points.length; i += 2) {
      const c = forwardPoint(m, frame, from, f.points[i], f.points[i + 1]);
      const l = inversePoint(m, frame, to, c[0], c[1]);
      f.points[i] = r7(l[0]);
      f.points[i + 1] = r7(l[1]);
    }
  });
}

/** The angle a parent deformer adds to a child rotation deformer at (x, y) of the parent's space. */
function turnOf(m: Model, frame: Live2DFrame, parent: string | null, x: number, y: number): number {
  if (!parent) return 0;
  const d = m.live2d!.deformers.find((q) => q.id === parent)!;
  return turnAt(x, y, d.type === "warp" ? 0.1 : 10, (px, py) => forwardPoint(m, frame, parent, px, py));
}

function reparentRotation(m: Model, d: RotationDeformer, to: string | null): void {
  d.forms.forEach((f, k) => {
    const frame = frameAt(m, gridPointValues(m, d.grid, k));
    const from = d.parent;
    const fs = from ? frame.deformers.get(from) : undefined;
    const ts = to ? frame.deformers.get(to) : undefined;
    const worldAngle = f.angle + turnOf(m, frame, from, f.x, f.y);
    const worldScale = f.scale * (fs?.scale ?? 1);
    const c = forwardPoint(m, frame, from, f.x, f.y);
    const l = inversePoint(m, frame, to, c[0], c[1]);
    f.x = r7(l[0]);
    f.y = r7(l[1]);
    f.angle = r7(worldAngle - turnOf(m, frame, to, f.x, f.y));
    f.scale = r7(worldScale / (ts?.scale ?? 1));
  });
}

function reparentNode(m: Model, node: Node, to: string | null): void {
  if (node.kind === "mesh") {
    const att = ownMesh(m, node.id);
    reparentPoints(m, att.live2d.grid, att.live2d.forms, att.live2d.deformer, to);
    att.live2d.deformer = to;
  } else if (node.kind === "deformer") {
    const d = m.live2d!.deformers.find((x) => x.id === node.id)!;
    if (d.type === "warp") reparentPoints(m, d.grid, d.forms, d.parent, to);
    else reparentRotation(m, d, to);
    d.parent = to;
  }
}

function descendsFrom(m: Model, id: string, ancestor: string): boolean {
  const byId = new Map(m.live2d!.deformers.map((d) => [d.id, d]));
  const seen = new Set<string>();
  for (let cur = byId.get(id)?.parent ?? null; cur; cur = byId.get(cur)?.parent ?? null) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) break;
    seen.add(cur);
  }
  return false;
}

/** Deformers listed parents first (the rig evaluates in that order). */
function sortDeformers(rig: Live2DRig): void {
  const byId = new Map(rig.deformers.map((d) => [d.id, d]));
  const out: Deformer[] = [];
  const seen = new Set<string>();
  const visit = (d: Deformer, depth: number) => {
    if (seen.has(d.id) || depth > rig.deformers.length) return;
    if (d.parent && byId.has(d.parent)) visit(byId.get(d.parent)!, depth + 1);
    seen.add(d.id);
    out.push(d);
  };
  for (const d of rig.deformers) visit(d, 0);
  rig.deformers = out;
}

const assertL2Id = (id: unknown, field: string) => {
  if (typeof id !== "string" || !id || /[\u0000-\u001f"\\]/.test(id) || id.trim() !== id) throw new Error(`${field} must be a non-empty id`);
  if (new TextEncoder().encode(id).length > 63) throw new Error(`${field} "${id}" is longer than Live2D's 63 bytes`);
};

// ---------- mesh helpers used by the ordinary mesh ops

/** After vertices were removed (indices of the old mesh), drops them from every keyform. */
export function removeLive2DVertices(att: MeshAttachment, removed: number[]): MeshAttachment {
  if (!att.live2d) return att;
  const gone = new Set(removed);
  const l = structuredClone(att.live2d);
  for (const f of l.forms) f.points = f.points.filter((_, k) => !gone.has(k >> 1));
  return { ...att, live2d: l };
}

function barycentric(p: Vec2, a: Vec2, b: Vec2, c: Vec2): [number, number, number] | null {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(det) < 1e-18) return null;
  const w0 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
  const w1 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
  return [w0, w1, 1 - w0 - w1];
}

/**
 * Keyforms for a mesh whose geometry was replaced: each new vertex takes, in every keyform, the barycentric blend
 * of the old triangle it lies in (found by UV when both have UVs, else by setup position). A vertex a little
 * outside the old mesh (a wider outline) follows its nearest triangle's deformation (extrapolated), so it keeps
 * its place around the art in every keyform.
 */
export function remapLive2DForms(old: MeshAttachment, next: MeshAttachment): MeshAttachment {
  if (!old.live2d) return next;
  const useUv = !!(old.uvs && next.uvs && old.uvs.length === old.vertices.length && next.uvs.length === next.vertices.length);
  const src = useUv ? old.uvs! : old.vertices;
  const dst = useUv ? next.uvs! : next.vertices;
  const weights = dst.map((p) => {
    let best: { tri: number[]; w: [number, number, number]; out: number } | null = null;
    for (const t of old.triangles) {
      const w = barycentric(p, src[t[0]], src[t[1]], src[t[2]]);
      if (!w) continue;
      const out = Math.max(0, -w[0], -w[1], -w[2]);
      if (!best || out < best.out) best = { tri: t, w, out };
      if (out === 0) break;
    }
    if (!best) {
      // no triangles: nearest old vertex
      let k = 0;
      let dmin = Infinity;
      src.forEach((q, i) => {
        const dd = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (dd < dmin) {
          dmin = dd;
          k = i;
        }
      });
      return { tri: [k, k, k], w: [1, 0, 0] as [number, number, number] };
    }
    if (best.out > 1.5) {
      // far outside: clamp to the triangle
      const w = best.w.map((x) => Math.max(0, x));
      const s = w[0] + w[1] + w[2] || 1;
      best.w = [w[0] / s, w[1] / s, w[2] / s];
    }
    return best;
  });
  const l = structuredClone(old.live2d);
  for (const f of l.forms) {
    const pts = f.points;
    f.points = weights.flatMap(({ tri, w }) => [
      r7(pts[tri[0] * 2] * w[0] + pts[tri[1] * 2] * w[1] + pts[tri[2] * 2] * w[2]),
      r7(pts[tri[0] * 2 + 1] * w[0] + pts[tri[1] * 2 + 1] * w[1] + pts[tri[2] * 2 + 1] * w[2]),
    ]);
  }
  return { ...next, live2d: l };
}

/**
 * Setup vertex moves on a Live2D mesh: every keyform moves the vertex by the same world offset (at that keyform's
 * parameter values), so the mesh keeps its motion.
 */
export function moveLive2DVertices(m: Model, id: string, old: MeshAttachment, next: MeshAttachment): MeshAttachment {
  if (!old.live2d || !m.live2d) return next;
  const moved: Array<[number, number, number]> = [];
  next.vertices.forEach((v, i) => {
    const o = old.vertices[i];
    if (o && (v[0] !== o[0] || v[1] !== o[1])) moved.push([i, v[0] - o[0], v[1] - o[1]]);
  });
  const l = structuredClone(old.live2d);
  l.forms.forEach((f, k) => {
    const frame = frameAt(m, gridPointValues(m, l.grid, k));
    for (const [i, dx, dy] of moved) {
      const c = forwardPoint(m, frame, l.deformer, f.points[i * 2], f.points[i * 2 + 1]);
      const w = canvasToWorldPt(m, c);
      const t = worldToCanvas(m, [w[0] + dx, w[1] + dy]);
      const q = inversePoint(m, frame, l.deformer, t[0], t[1]);
      f.points[i * 2] = r7(q[0]);
      f.points[i * 2 + 1] = r7(q[1]);
    }
  });
  return { ...next, live2d: l };
}

/** A plain mesh as a Live2D art mesh with one keyform at its setup shape (canvas space, no deformer). */
export function toLive2DMesh(m: Model, att: MeshAttachment): MeshAttachment {
  return {
    ...att,
    live2d: {
      deformer: null,
      part: null,
      grid: { params: [], keys: [] },
      forms: [{ points: att.vertices.flatMap((v) => worldToCanvas(m, v)).map(r7), drawOrder: 500 }],
    },
  };
}

function boundsOf(pts: Vec2[]): { x: number; y: number; width: number; height: number } | null {
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** World positions of a node at the defaults (mesh vertices, warp lattice, rotation origin). */
function worldPointsOf(m: Model, frame: Live2DFrame, id: string): Vec2[] {
  const s = frame.meshes.get(id);
  if (s) {
    const out: Vec2[] = [];
    for (let i = 0; i + 1 < s.points.length; i += 2) out.push(canvasToWorldPt(m, [s.points[i], s.points[i + 1]]));
    return out;
  }
  const d = frame.deformers.get(id);
  if (d?.grid) {
    const out: Vec2[] = [];
    for (let i = 0; i + 1 < d.grid.length; i += 2) out.push(canvasToWorldPt(m, [d.grid[i], d.grid[i + 1]]));
    return out;
  }
  if (d?.rotation) return [canvasToWorldPt(m, [d.rotation.x, d.rotation.y])];
  return [];
}

// ---------- the ops

export function applyLive2DOp(m: Model, op: Live2DOp): string {
  switch (op.op) {
    case "setKeyform": {
      const node = findNode(m, op.target);
      const vec = (list: unknown, name: string) => {
        if (list === undefined) return [];
        if (!Array.isArray(list) || !list.every((e) => Array.isArray(e) && e.length === 3 && Number.isInteger(e[0]) && e.every((n: unknown) => typeof n === "number" && Number.isFinite(n)))) {
          throw new Error(`${name} must be [index, x, y] entries`);
        }
        return list as Array<[number, number, number]>;
      };
      const moves = vec(op.moves, "moves");
      const offsets = vec(op.offsets, "offsets");
      const color = (c: unknown, name: string): RGB | null | undefined => {
        if (c === undefined || c === null) return c as null | undefined;
        if (!Array.isArray(c) || c.length !== 3 || !c.every((x) => typeof x === "number" && x >= 0 && x <= 1)) throw new Error(`${name} must be [r, g, b] in 0..1 (or null)`);
        return c as RGB;
      };
      const multiply = color(op.multiply, "multiply");
      const screen = color(op.screen, "screen");
      const num = (v: unknown, name: string, lo = -Infinity, hi = Infinity) => {
        if (v === undefined) return undefined;
        if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} must be a number in ${lo}..${hi}`);
        return v;
      };
      const opacity = num(op.opacity, "opacity", 0, 1);
      const drawOrder = num(op.drawOrder, "drawOrder", 0, 1000);
      let changed = 0;
      const movePoints = (points: number[], parent: string | null, values: ParamValues) => {
        if (!moves.length && !offsets.length) return;
        const frame = frameAt(m, values);
        const n = points.length / 2;
        const targets: Array<[number, Vec2]> = [];
        for (const [i, x, y] of moves) targets.push([i, worldToCanvas(m, [x, y])]);
        for (const [i, dx, dy] of offsets) {
          if (i < 0 || i >= n) throw new Error(`point ${i} does not exist (${n} points)`);
          const w = canvasToWorldPt(m, forwardPoint(m, frame, parent, points[i * 2], points[i * 2 + 1]));
          targets.push([i, worldToCanvas(m, [w[0] + dx, w[1] + dy])]);
        }
        for (const [i, c] of targets) {
          if (i < 0 || i >= n) throw new Error(`point ${i} does not exist (${n} points)`);
          const q = inversePoint(m, frame, parent, c[0], c[1]);
          points[i * 2] = r7(q[0]);
          points[i * 2 + 1] = r7(q[1]);
          changed++;
        }
      };
      if (node.kind === "mesh") {
        const att = ownMesh(m, node.id);
        const l = att.live2d;
        const k = gridIndexAt(m, l.grid, op.at, node.id);
        const f = l.forms[k];
        movePoints(f.points, l.deformer, gridPointValues(m, l.grid, k));
        if (opacity !== undefined) (f.opacity = opacity), changed++;
        if (drawOrder !== undefined) (f.drawOrder = drawOrder), changed++;
        if (multiply !== undefined) (multiply ? (f.multiply = multiply) : delete f.multiply), changed++;
        if (screen !== undefined) (screen ? (f.screen = screen) : delete f.screen), changed++;
        refreshLive2DVertices(m, [node.id]);
        return `set keyform ${k + 1}/${l.forms.length} of ${node.id} (${changed} change${changed === 1 ? "" : "s"})`;
      }
      if (node.kind === "deformer") {
        const rig = ownRig(m);
        const d = rig.deformers.find((x) => x.id === node.id)!;
        const k = gridIndexAt(m, d.grid, op.at, node.id);
        const values = gridPointValues(m, d.grid, k);
        if (d.type === "warp") {
          movePoints(d.forms[k].points, d.parent, values);
        } else {
          const f = d.forms[k];
          if (op.origin !== undefined) {
            if (!Array.isArray(op.origin) || op.origin.length !== 2) throw new Error("origin must be [x, y]");
            const frame = frameAt(m, values);
            const c = worldToCanvas(m, op.origin);
            const q = inversePoint(m, frame, d.parent, c[0], c[1]);
            f.x = r7(q[0]);
            f.y = r7(q[1]);
            changed++;
          }
          const angle = num(op.angle, "angle");
          const scale = num(op.scale, "scale", 1e-9);
          if (angle !== undefined) (f.angle = angle), changed++;
          if (scale !== undefined) (f.scale = scale), changed++;
          if (op.reflectX !== undefined) (op.reflectX ? (f.reflectX = true) : delete f.reflectX), changed++;
          if (op.reflectY !== undefined) (op.reflectY ? (f.reflectY = true) : delete f.reflectY), changed++;
        }
        const f = d.forms[k];
        if (opacity !== undefined) (f.opacity = opacity), changed++;
        if (multiply !== undefined) (multiply ? (f.multiply = multiply) : delete f.multiply), changed++;
        if (screen !== undefined) (screen ? (f.screen = screen) : delete f.screen), changed++;
        refreshLive2DVertices(m);
        return `set keyform ${k + 1}/${d.forms.length} of deformer ${d.id} (${changed} change${changed === 1 ? "" : "s"})`;
      }
      if (node.kind === "part") {
        const rig = ownRig(m);
        const p = rig.parts.find((x) => x.id === node.id)!;
        const k = gridIndexAt(m, p.grid, op.at, node.id);
        if (drawOrder === undefined) throw new Error("a part keyform only has drawOrder");
        p.drawOrders[k] = drawOrder;
        return `set draw order of part ${p.id} (keyform ${k + 1}/${p.drawOrders.length})`;
      }
      const rig = ownRig(m);
      const g = rig.glue![node.index];
      const k = gridIndexAt(m, g.grid, op.at, node.id);
      const intensity = num(op.intensity, "intensity", 0, 1);
      if (intensity === undefined) throw new Error("a glue keyform only has intensity");
      g.intensity[k] = intensity;
      refreshLive2DVertices(m, [g.a, g.b]);
      return `set glue ${g.id} intensity (keyform ${k + 1}/${g.intensity.length})`;
    }

    case "setKeyformKeys": {
      const node = findNode(m, op.target);
      const p = (m.parameters ?? []).find((x) => x.id === op.param);
      if (!p) throw new Error(`unknown parameter "${op.param}"`);
      let keys: number[] | null = null;
      if (op.keys !== null) {
        if (!Array.isArray(op.keys) || !op.keys.length || !op.keys.every((k) => typeof k === "number" && Number.isFinite(k))) throw new Error("keys must be a non-empty list of numbers (or null to unbind)");
        keys = [...new Set(op.keys.map((k) => Math.round(k * 1e6) / 1e6))].sort((a, b) => a - b);
        const lo = Math.min(p.min, p.max);
        const hi = Math.max(p.min, p.max);
        if (keys.some((k) => k < lo - 1e-9 || k > hi + 1e-9)) throw new Error(`keys must lie in ${lo}..${hi}`);
      }
      const regrid = (g: KeyformGrid): KeyformGrid => {
        const i = g.params.indexOf(op.param);
        const params = [...g.params];
        const ks = g.keys.map((k) => [...k]);
        if (keys === null) {
          if (i < 0) throw new Error(`"${op.target}" is not keyed on ${op.param}`);
          params.splice(i, 1);
          ks.splice(i, 1);
        } else if (i < 0) {
          params.push(op.param);
          ks.push(keys);
        } else ks[i] = keys;
        return { params, keys: ks };
      };
      let size = 0;
      if (node.kind === "mesh") {
        const att = ownMesh(m, node.id);
        const g = regrid(att.live2d.grid);
        att.live2d.forms = resample(m, att.live2d.grid, att.live2d.forms, g, blendMeshForms(att.live2d.forms));
        att.live2d.grid = g;
        size = att.live2d.forms.length;
        refreshLive2DVertices(m, [node.id]);
      } else if (node.kind === "deformer") {
        const rig = ownRig(m);
        const d = rig.deformers.find((x) => x.id === node.id)!;
        const g = regrid(d.grid);
        if (d.type === "warp") d.forms = resample(m, d.grid, d.forms, g, blendWarpForms(d.forms));
        else d.forms = resample(m, d.grid, d.forms, g, blendRotationForms(d.forms));
        d.grid = g;
        size = d.forms.length;
        refreshLive2DVertices(m);
      } else if (node.kind === "part") {
        const rig = ownRig(m);
        const pt = rig.parts.find((x) => x.id === node.id)!;
        const g = regrid(pt.grid);
        pt.drawOrders = resample(m, pt.grid, pt.drawOrders, g, (t) => r7(mixNum(t, (i) => pt.drawOrders[i])));
        pt.grid = g;
        size = pt.drawOrders.length;
      } else {
        const rig = ownRig(m);
        const gl = rig.glue![node.index];
        const g = regrid(gl.grid);
        gl.intensity = resample(m, gl.grid, gl.intensity, g, (t) => r7(mixNum(t, (i) => gl.intensity[i])));
        gl.grid = g;
        size = gl.intensity.length;
      }
      return keys === null ? `unbound ${op.target} from ${op.param} (${size} keyforms)` : `${op.target} keyed on ${op.param} at ${keys.join(", ")} (${size} keyforms)`;
    }

    case "addDeformer": {
      const rig = ownRig(m);
      assertL2Id(op.id, "id");
      if (rig.deformers.some((d) => d.id === op.id)) throw new Error(`deformer "${op.id}" exists`);
      const parent = op.parent ?? null;
      if (parent && !rig.deformers.some((d) => d.id === parent)) throw new Error(`unknown deformer "${parent}"`);
      const part = op.part ?? null;
      if (part && !rig.parts.some((p) => p.id === part)) throw new Error(`unknown part "${part}"`);
      const children = op.children ?? [];
      const frame0 = frameAt(m, defaultParamValues(m));
      const childPts: Vec2[] = [];
      for (const c of children) {
        const node = findNode(m, c);
        if (node.kind !== "mesh" && node.kind !== "deformer") throw new Error(`"${c}" is not an art mesh or deformer`);
        childPts.push(...worldPointsOf(m, frame0, c));
      }
      const values = defaultParamValues(m);
      const frame = frameAt(m, values);
      if (op.type === "warp") {
        const cols = op.cols ?? 3;
        const rows = op.rows ?? 3;
        if (!(Number.isInteger(cols) && cols >= 1 && cols <= 64 && Number.isInteger(rows) && rows >= 1 && rows <= 64)) throw new Error("cols and rows must be integers 1..64");
        let rect = op.rect;
        if (!rect) {
          const b = boundsOf(childPts);
          if (!b) throw new Error("give rect (world) or children to size the warp");
          const pad = Math.max(b.width, b.height) * 0.05 + 1;
          rect = { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
        }
        if (!(rect.width > 0 && rect.height > 0)) throw new Error("rect needs a positive size");
        // lattice rows run from the first row down the image: canvas y grows downward
        const points: number[] = [];
        for (let j = 0; j <= rows; j++) {
          for (let i = 0; i <= cols; i++) {
            const wx = rect.x + (rect.width * i) / cols;
            const wy = rect.y + rect.height - (rect.height * j) / rows;
            const c = worldToCanvas(m, [wx, wy]);
            const q = inversePoint(m, frame, parent, c[0], c[1]);
            points.push(r7(q[0]), r7(q[1]));
          }
        }
        rig.deformers.push({ id: op.id, type: "warp", parent, part, cols, rows, ...(op.bilinear !== false ? { bilinear: true } : {}), grid: { params: [], keys: [] }, forms: [{ points }] });
      } else if (op.type === "rotation") {
        let origin = op.origin;
        if (!origin) {
          const b = boundsOf(childPts);
          if (!b) throw new Error("give origin (world) or children to place the rotation deformer");
          origin = [b.x + b.width / 2, b.y + b.height / 2];
        }
        const c = worldToCanvas(m, origin);
        const q = inversePoint(m, frame, parent, c[0], c[1]);
        const ps = parent ? frame.deformers.get(parent) : undefined;
        // children's local units are pixels: the scale handed down (own times the parents') is 1 / pixelsPerUnit
        const scale = 1 / ppu(m) / (ps?.scale ?? 1);
        rig.deformers.push({
          id: op.id,
          type: "rotation",
          parent,
          part,
          baseAngle: op.baseAngle ?? 0,
          grid: { params: [], keys: [] },
          forms: [{ x: r7(q[0]), y: r7(q[1]), angle: r7(-turnOf(m, frame, parent, q[0], q[1])), scale }],
        });
      } else throw new Error('type must be "warp" or "rotation"');
      for (const c of children) {
        const node = findNode(m, c);
        if (node.kind === "deformer" && (c === op.id || descendsFrom(m, op.id, c))) throw new Error(`"${c}" cannot go under its own descendant`);
        reparentNode(m, node, op.id);
      }
      sortDeformers(rig);
      refreshLive2DVertices(m);
      return `added ${op.type} deformer ${op.id}${children.length ? ` over ${children.length} child(ren)` : ""}`;
    }

    case "updateDeformer": {
      const rig = ownRig(m);
      const d = rig.deformers.find((x) => x.id === op.id);
      if (!d) throw new Error(`unknown deformer "${op.id}"`);
      if (op.part !== undefined) {
        if (op.part !== null && !rig.parts.some((p) => p.id === op.part)) throw new Error(`unknown part "${op.part}"`);
        d.part = op.part;
      }
      if (op.bilinear !== undefined && d.type === "warp") op.bilinear ? (d.bilinear = true) : delete d.bilinear;
      if (op.hidden !== undefined) op.hidden ? (d.hidden = true) : delete d.hidden;
      if (op.disabled !== undefined) op.disabled ? (d.disabled = true) : delete d.disabled;
      if (op.parent !== undefined && op.parent !== d.parent) {
        if (op.parent !== null && !rig.deformers.some((x) => x.id === op.parent)) throw new Error(`unknown deformer "${op.parent}"`);
        if (op.parent === d.id || (op.parent && descendsFrom(m, op.parent, d.id))) throw new Error("a deformer cannot go under itself or its descendants");
        reparentNode(m, { kind: "deformer", id: d.id, d }, op.parent);
        sortDeformers(rig);
      }
      refreshLive2DVertices(m);
      return `updated deformer ${op.id}`;
    }

    case "removeDeformer": {
      const rig = ownRig(m);
      const d = rig.deformers.find((x) => x.id === op.id);
      if (!d) throw new Error(`unknown deformer "${op.id}"`);
      // children move to its parent, keeping their look
      for (const c of rig.deformers.filter((x) => x.parent === d.id)) reparentNode(m, { kind: "deformer", id: c.id, d: c }, d.parent);
      for (const [id, att] of live2dMeshes(m)) if (att.live2d.deformer === d.id) reparentNode(m, { kind: "mesh", id, att }, d.parent);
      rig.deformers = rig.deformers.filter((x) => x.id !== d.id);
      sortDeformers(rig);
      refreshLive2DVertices(m);
      return `removed deformer ${op.id}`;
    }

    case "setLive2DMesh": {
      const rig = requireRig(m);
      const cur = m.attachments[op.attachment];
      if (!cur) throw new Error(`unknown attachment "${op.attachment}"`);
      if (!cur.live2d) m.attachments[op.attachment] = toLive2DMesh(m, cur);
      const att = ownMesh(m, op.attachment);
      if (op.part !== undefined) {
        if (op.part !== null && !rig.parts.some((p) => p.id === op.part)) throw new Error(`unknown part "${op.part}"`);
        att.live2d.part = op.part;
      }
      if (op.hidden !== undefined) op.hidden ? (att.live2d.hidden = true) : delete att.live2d.hidden;
      if (op.disabled !== undefined) op.disabled ? (att.live2d.disabled = true) : delete att.live2d.disabled;
      if (op.deformer !== undefined && op.deformer !== att.live2d.deformer) {
        if (op.deformer !== null && !rig.deformers.some((x) => x.id === op.deformer)) throw new Error(`unknown deformer "${op.deformer}"`);
        reparentNode(m, { kind: "mesh", id: op.attachment, att }, op.deformer);
      }
      refreshLive2DVertices(m, [op.attachment]);
      return `updated Live2D mesh ${op.attachment}`;
    }

    case "addPart": {
      const rig = ownRig(m);
      assertL2Id(op.id, "id");
      if (rig.parts.some((p) => p.id === op.id)) throw new Error(`part "${op.id}" exists`);
      if (op.parent && !rig.parts.some((p) => p.id === op.parent)) throw new Error(`unknown part "${op.parent}"`);
      rig.parts.push({ id: op.id, parent: op.parent ?? null, ...(op.name ? { name: op.name } : {}), ...(op.visible === false ? { visible: false } : {}), grid: { params: [], keys: [] }, drawOrders: [500] });
      return `added part ${op.id}`;
    }

    case "updatePart": {
      const rig = ownRig(m);
      const p = rig.parts.find((x) => x.id === op.id);
      if (!p) throw new Error(`unknown part "${op.id}"`);
      if (op.parent !== undefined) {
        if (op.parent !== null && !rig.parts.some((x) => x.id === op.parent)) throw new Error(`unknown part "${op.parent}"`);
        for (let cur: string | null = op.parent; cur; cur = rig.parts.find((x) => x.id === cur)?.parent ?? null) {
          if (cur === p.id) throw new Error("a part cannot go under itself");
        }
        p.parent = op.parent;
      }
      if (op.name !== undefined) op.name ? (p.name = op.name) : delete p.name;
      if (op.visible !== undefined) op.visible ? delete p.visible : (p.visible = false);
      if (op.disabled !== undefined) op.disabled ? (p.disabled = true) : delete p.disabled;
      return `updated part ${op.id}`;
    }

    case "removePart": {
      const rig = ownRig(m);
      const p = rig.parts.find((x) => x.id === op.id);
      if (!p) throw new Error(`unknown part "${op.id}"`);
      for (const x of rig.parts) if (x.parent === p.id) x.parent = p.parent;
      for (const d of rig.deformers) if (d.part === p.id) d.part = p.parent;
      for (const [id, att] of live2dMeshes(m)) if (att.live2d.part === p.id) ownMesh(m, id).live2d.part = p.parent;
      rig.parts = rig.parts.filter((x) => x.id !== p.id);
      if (rig.drawOrderGroups) {
        for (const g of rig.drawOrderGroups) g.items = g.items.filter((it) => !("part" in it && it.part === p.id));
      }
      for (const a of Object.values(m.animations ?? {})) if (a.partOpacity) delete a.partOpacity[p.id];
      return `removed part ${op.id} (its contents moved to ${p.parent ?? "the root"})`;
    }

    case "enableLive2D": {
      const created = !m.live2d;
      if (!m.live2d) {
        let canvas = op.canvas;
        if (!canvas) {
          const all = Object.values(m.attachments).flatMap((a) => a.vertices);
          const b = boundsOf(all) ?? { x: -512, y: -512, width: 1024, height: 1024 };
          const pad = Math.max(b.width, b.height) * 0.05;
          const width = Math.ceil(b.width + pad * 2);
          const height = Math.ceil(b.height + pad * 2);
          canvas = { width, height, originX: -(b.x - pad), originY: b.y + b.height + pad, pixelsPerUnit: Math.max(width, height) };
        }
        if (!(canvas.pixelsPerUnit > 0)) throw new Error("canvas.pixelsPerUnit must be > 0");
        m.live2d = { canvas, parts: [], deformers: [] };
      } else ownRig(m);
      const ids = op.attachments ?? Object.keys(m.attachments);
      let n = 0;
      for (const id of ids) {
        const att = m.attachments[id];
        if (!att) throw new Error(`unknown attachment "${id}"`);
        if (att.live2d) continue;
        m.attachments[id] = toLive2DMesh(m, att);
        n++;
      }
      return `${created ? "created a Live2D rig; " : ""}${n} mesh(es) are now Live2D art meshes`;
    }

    case "setPartOpacityKeys": {
      const rig = requireRig(m);
      const anim = m.animations?.[op.animation];
      if (!anim) throw new Error(`unknown animation "${op.animation}"`);
      if (!rig.parts.some((p) => p.id === op.part)) throw new Error(`unknown part "${op.part}"`);
      if (!Array.isArray(op.keys) || !op.keys.every((k) => typeof k?.t === "number" && k.t >= 0 && typeof k.v === "number" && k.v >= 0 && k.v <= 1)) {
        throw new Error("keys must be { t, v } with v in 0..1");
      }
      const tracks = (anim.partOpacity ??= {});
      const keys = op.mode === "merge" ? [...(tracks[op.part] ?? []).filter((k) => !op.keys.some((n) => Math.abs(n.t - k.t) < 1e-6)), ...op.keys] : [...op.keys];
      keys.sort((a, b) => a.t - b.t);
      if (keys.length) tracks[op.part] = keys.map((k) => ({ t: k.t, v: k.v, ...(k.ease && k.ease !== "linear" ? { ease: k.ease } : {}) }));
      else delete tracks[op.part];
      if (!Object.keys(tracks).length) delete anim.partOpacity;
      return `set ${keys.length} opacity key(s) of part ${op.part} in ${op.animation}`;
    }
  }
}

/** Parameter id changes / removal inside the rig (grids, physics). */
export function renameLive2DParam(m: Model, from: string, to: string | null): void {
  if (!m.live2d && !Object.values(m.attachments).some((a) => a.live2d)) return;
  const fix = (g: KeyformGrid, forms: unknown[], reblend: (g2: KeyformGrid) => void) => {
    const i = g.params.indexOf(from);
    if (i < 0) return;
    if (to !== null) g.params[i] = to;
    else {
      const g2: KeyformGrid = { params: g.params.filter((_, k) => k !== i), keys: g.keys.filter((_, k) => k !== i) };
      reblend(g2);
    }
    void forms;
  };
  if (m.live2d) {
    const rig = ownRig(m);
    for (const d of rig.deformers) {
      fix(d.grid, d.forms, (g2) => {
        if (d.type === "warp") d.forms = resample(m, d.grid, d.forms, g2, blendWarpForms(d.forms));
        else d.forms = resample(m, d.grid, d.forms, g2, blendRotationForms(d.forms));
        d.grid = g2;
      });
    }
    for (const p of rig.parts) {
      fix(p.grid, p.drawOrders, (g2) => {
        p.drawOrders = resample(m, p.grid, p.drawOrders, g2, (t) => mixNum(t, (i) => p.drawOrders[i]));
        p.grid = g2;
      });
    }
    for (const g of rig.glue ?? []) {
      fix(g.grid, g.intensity, (g2) => {
        g.intensity = resample(m, g.grid, g.intensity, g2, (t) => mixNum(t, (i) => g.intensity[i]));
        g.grid = g2;
      });
    }
    if (rig.physics) {
      for (const s of rig.physics.settings) {
        if (to !== null) {
          for (const x of [...s.inputs, ...s.outputs]) if (x.param === from) x.param = to;
        } else {
          s.inputs = s.inputs.filter((x) => x.param !== from);
          s.outputs = s.outputs.filter((x) => x.param !== from);
        }
      }
      rig.physics.settings = rig.physics.settings.filter((s) => s.outputs.length);
    }
  }
  for (const [id, att] of live2dMeshes(m)) {
    if (!att.live2d.grid.params.includes(from)) continue;
    const a = ownMesh(m, id);
    fix(a.live2d.grid, a.live2d.forms, (g2) => {
      a.live2d.forms = resample(m, a.live2d.grid, a.live2d.forms, g2, blendMeshForms(a.live2d.forms));
      a.live2d.grid = g2;
    });
  }
}

/** Slot id changes / removal inside the rig (draw-order groups). */
export function renameLive2DSlot(m: Model, from: string, to: string | null): void {
  if (!m.live2d?.drawOrderGroups?.some((g) => g.items.some((it) => "slot" in it && it.slot === from))) return;
  const rig = ownRig(m);
  for (const g of rig.drawOrderGroups!) {
    g.items = g.items.flatMap((it) => ("slot" in it && it.slot === from ? (to === null ? [] : [{ slot: to }]) : [it]));
  }
}

/** Attachment removal / rename inside the rig (glue). */
export function renameLive2DAttachment(m: Model, from: string, to: string | null): void {
  if (!m.live2d?.glue?.some((g) => g.a === from || g.b === from)) return;
  const rig = ownRig(m);
  rig.glue = rig.glue!.flatMap((g) => {
    if (g.a !== from && g.b !== from) return [g];
    if (to === null) return [];
    return [{ ...g, a: g.a === from ? to : g.a, b: g.b === from ? to : g.b }];
  });
  if (!rig.glue.length) delete rig.glue;
}

export type { RotationKeyform };
