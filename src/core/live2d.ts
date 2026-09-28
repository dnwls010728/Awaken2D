// Live2D (Cubism) rig evaluation: keyform blending over parameters, the deformer tree (warp / rotation), glue,
// opacity and colors down the tree, and draw-order groups. Mirrors the Cubism Core's behavior (checked against the
// official core); see Live2DRig in types.ts for the data.
import type {
  Deformer,
  DrawOrderGroup,
  KeyformGrid,
  Live2DBlendShape,
  Live2DMesh,
  Live2DRig,
  MeshAttachment,
  Model,
  Parameter,
  RGB,
  RotationKeyform,
  Vec2,
  WarpDeformer,
  WarpKeyform,
} from "./types.ts";
import type { ParamValues } from "./params.ts";

const ONE: RGB = [1, 1, 1];
const ZERO: RGB = [0, 0, 0];

export interface Live2DMeshState {
  part: string | null;
  /** Final positions in canvas units, x, y flat. */
  points: Float64Array;
  opacity: number;
  drawOrder: number;
  multiply: RGB;
  screen: RGB;
  enabled: boolean;
}

export interface RotationState {
  x: number;
  y: number;
  /** Degrees, without the base angle. */
  angle: number;
  scale: number;
  reflectX: boolean;
  reflectY: boolean;
}

export interface Live2DDeformerState {
  enabled: boolean;
  opacity: number;
  multiply: RGB;
  screen: RGB;
  /** Accumulated scale handed to children (rotation deformers multiply their own). */
  scale: number;
  /** Warp: lattice in canvas units (after the parents). */
  grid?: Float64Array;
  /** Rotation: transform in canvas units (after the parents; scale is the accumulated one). */
  rotation?: RotationState;
}

export interface Live2DFrame {
  meshes: Map<string, Live2DMeshState>;
  deformers: Map<string, Live2DDeformerState>;
  /** Attachment ids of Live2D meshes in render order (back to front), drawn ones only. */
  order: string[];
}

// ---------- keyform blending

interface Blend {
  /** [form index, weight] */
  terms: Array<[number, number]>;
  /** A bound parameter left the keyed range (the object is not drawn, as in Cubism). */
  outside: boolean;
}

function keySegment(keys: number[], v: number): [number, number] {
  const last = keys.length - 1;
  if (last <= 0 || v <= keys[0]) return [0, 0];
  if (v >= keys[last]) return [last - 1, 1];
  let upper = 1;
  while (upper < last && keys[upper] <= v) upper++;
  const a = keys[upper - 1];
  const b = keys[upper];
  return [upper - 1, b > a ? (v - a) / (b - a) : 0];
}

/** Blend weights of a keyform grid for the parameter values (multilinear between the surrounding grid points). */
export function gridBlend(grid: KeyformGrid, values: ParamValues, eps: (param: string) => number = () => 1e-3): Blend {
  const n = grid.params.length;
  if (!n) return { terms: [[0, 1]], outside: false };
  let base = 0;
  let stride = 1;
  let outside = false;
  const fs: number[] = [];
  const strides: number[] = [];
  for (let i = 0; i < n; i++) {
    const keys = grid.keys[i];
    let v = values[grid.params[i]] ?? 0;
    const e = eps(grid.params[i]);
    // a value within the parameter's precision of a key sits on it (Cubism snaps)
    for (const k of keys) if (Math.abs(v - k) < e) v = k;
    if (keys.length === 1 ? v <= keys[0] - e || v >= keys[0] + e : v < keys[0] - e || v >= keys[keys.length - 1] + e) outside = true;
    const [lower, f] = keySegment(keys, v);
    fs.push(f);
    strides.push(stride);
    base += lower * stride;
    stride *= keys.length;
  }
  const terms: Array<[number, number]> = [];
  for (let corner = 0; corner < 1 << n; corner++) {
    let w = 1;
    let index = base;
    for (let i = 0; i < n; i++) {
      if (corner & (1 << i)) {
        index += strides[i];
        w *= fs[i];
      } else w *= 1 - fs[i];
    }
    if (w !== 0) terms.push([index, w]);
  }
  return { terms, outside };
}

/** Number of forms a grid needs (product of the key counts). */
export function gridSize(grid: KeyformGrid): number {
  return grid.keys.reduce((n, k) => n * k.length, 1);
}

function blendNum(terms: Array<[number, number]>, get: (i: number) => number): number {
  let s = 0;
  for (const [i, w] of terms) s += get(i) * w;
  return s;
}

function blendRGB(terms: Array<[number, number]>, get: (i: number) => RGB | undefined, def: RGB): RGB {
  const out: RGB = [0, 0, 0];
  for (const [i, w] of terms) {
    const c = get(i) ?? def;
    out[0] += c[0] * w;
    out[1] += c[1] * w;
    out[2] += c[2] * w;
  }
  return out;
}

function blendPoints(terms: Array<[number, number]>, get: (i: number) => number[], n: number): Float64Array {
  const out = new Float64Array(n);
  for (const [i, w] of terms) {
    const p = get(i);
    const m = Math.min(n, p.length);
    for (let k = 0; k < m; k++) out[k] += p[k] * w;
  }
  return out;
}

// ---------- blend shapes (Cubism 4.2+)

/** Piecewise-linear weight of a blend-shape constraint at a value (clamped outside its points). */
function constraintWeight(values: Array<[number, number]>, x: number): number {
  if (!values.length) return 1;
  if (x <= values[0][0]) return values[0][1];
  const last = values[values.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < values.length; i++) {
    const [k1, w1] = values[i];
    if (x <= k1) {
      const [k0, w0] = values[i - 1];
      return k1 > k0 ? w0 + ((w1 - w0) * (x - k0)) / (k1 - k0) : w1;
    }
  }
  return last[1];
}

/**
 * The differences an object's blend shapes add at these parameter values: [form, weight] pairs, the forms around each
 * blend-shape parameter's value (clamped to its keys) weighted by the interpolation and the constraints.
 */
function blendShapeTerms<F>(shapes: Live2DBlendShape<F>[] | undefined, params: Map<string, Parameter>, v: ParamValues): Array<[F, number]> {
  if (!shapes?.length) return [];
  const out: Array<[F, number]> = [];
  for (const s of shapes) {
    const keys = params.get(s.param)?.blendShape?.keys;
    if (!keys?.length) continue;
    let w = 1;
    for (const c of s.constraints ?? []) w = Math.min(w, constraintWeight(c.values, v[c.param] ?? 0));
    if (!w) continue;
    const [lower, f] = keySegment(keys, v[s.param] ?? 0);
    if (f < 1 && s.forms[lower] !== undefined) out.push([s.forms[lower], w * (1 - f)]);
    if (f > 0 && s.forms[lower + 1] !== undefined) out.push([s.forms[lower + 1], w * f]);
  }
  return out;
}

const addNum = <F>(terms: Array<[F, number]>, get: (f: F) => number | undefined): number => {
  let s = 0;
  for (const [f, w] of terms) s += (get(f) ?? 0) * w;
  return s;
};

/** Adds the blend-shape color differences; like the core, the result stays within 0..1. */
function addRGB<F>(out: RGB, terms: Array<[F, number]>, get: (f: F) => RGB | undefined): RGB {
  if (!terms.length) return out;
  for (const [f, w] of terms) {
    const c = get(f);
    if (!c) continue;
    out[0] += c[0] * w;
    out[1] += c[1] * w;
    out[2] += c[2] * w;
  }
  for (let i = 0; i < 3; i++) out[i] = Math.min(1, Math.max(0, out[i]));
  return out;
}

function addPoints<F>(out: Float64Array, terms: Array<[F, number]>, get: (f: F) => number[]): void {
  for (const [f, w] of terms) {
    const p = get(f);
    const m = Math.min(out.length, p.length);
    for (let k = 0; k < m; k++) out[k] += p[k] * w;
  }
}

// ---------- deformers

const cellInterp = (bilinear: boolean, tx: number, ty: number, bl: Vec2, br: Vec2, tl: Vec2, tr: Vec2): Vec2 => {
  if (bilinear) {
    const nx = 1 - tx;
    const ny = 1 - ty;
    return [
      bl[0] * nx * ny + br[0] * tx * ny + tl[0] * nx * ty + tr[0] * tx * ty,
      bl[1] * nx * ny + br[1] * tx * ny + tl[1] * nx * ty + tr[1] * tx * ty,
    ];
  }
  if (tx + ty > 1) {
    const nx = 1 - tx;
    const ny = 1 - ty;
    return [tr[0] + (tl[0] - tr[0]) * nx + (br[0] - tr[0]) * ny, tr[1] + (tl[1] - tr[1]) * nx + (br[1] - tr[1]) * ny];
  }
  return [bl[0] + (br[0] - bl[0]) * tx + (tl[0] - bl[0]) * ty, bl[1] + (br[1] - bl[1]) * tx + (tl[1] - bl[1]) * ty];
};

/** Maps a point of a warp's 0..1 square through its lattice (with Cubism's extrapolation outside it). */
export function warpPoint(grid: ArrayLike<number>, cols: number, rows: number, bilinear: boolean, px: number, py: number): Vec2 {
  const stride = cols + 1;
  const g = (i: number): Vec2 => [grid[i * 2], grid[i * 2 + 1]];
  const gx = px * cols;
  const gy = py * rows;
  if (px >= 0 && px < 1 && py >= 0 && py < 1) {
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const i = ix + iy * stride;
    return cellInterp(bilinear, gx - ix, gy - iy, g(i), g(i + 1), g(i + stride), g(i + stride + 1));
  }
  // outside: the lattice's corners define a parallelogram the far field follows; in between (-2..3) the edge cells
  // blend into it
  const c00 = g(0);
  const c10 = g(cols);
  const c01 = g(rows * stride);
  const c11 = g(cols + rows * stride);
  const d1: Vec2 = [c11[0] - c00[0], c11[1] - c00[1]];
  const d2: Vec2 = [c10[0] - c01[0], c10[1] - c01[1]];
  const vx: Vec2 = [(d1[0] + d2[0]) / 2, (d1[1] + d2[1]) / 2];
  const vy: Vec2 = [(d1[0] - d2[0]) / 2, (d1[1] - d2[1]) / 2];
  const cx = (c00[0] + c10[0] + c01[0] + c11[0]) / 4;
  const cy = (c00[1] + c10[1] + c01[1] + c11[1]) / 4;
  const ox = cx - d1[0] * 0.5;
  const oy = cy - d1[1] * 0.5;
  const P = (u: number, v: number): Vec2 => [ox + vx[0] * u + vy[0] * v, oy + vx[1] * u + vy[1] * v];
  if (!(px >= -2 && px <= 3 && py >= -2 && py <= 3)) return P(px, py);
  const rs = (t: number, lo: number, hi: number) => (t - lo) / (hi - lo);
  const xi = px >= 1 ? 2 : px >= 0 ? 1 : 0;
  const yi = py >= 1 ? 2 : py >= 0 ? 1 : 0;
  const ax = Math.min(Math.max(Math.floor(gx), 0), cols - 1);
  const ay = Math.min(Math.max(Math.floor(gy), 0), rows - 1);
  switch (xi + yi * 3) {
    case 7:
      return cellInterp(false, gx - ax, rs(py, 1, 3), g(ax + rows * stride), g(ax + 1 + rows * stride), P(ax / cols, 3), P((ax + 1) / cols, 3));
    case 1:
      return cellInterp(false, gx - ax, rs(py, -2, 0), P(ax / cols, -2), P((ax + 1) / cols, -2), g(ax), g(ax + 1));
    case 3:
      return cellInterp(false, rs(px, -2, 0), gy - ay, P(-2, ay / rows), g(ay * stride), P(-2, (ay + 1) / rows), g((ay + 1) * stride));
    case 5:
      return cellInterp(false, rs(px, 1, 3), gy - ay, g(cols + ay * stride), P(3, ay / rows), g(cols + (ay + 1) * stride), P(3, (ay + 1) / rows));
    case 6:
      return cellInterp(false, rs(px, -2, 0), rs(py, 1, 3), P(-2, 1), g(rows * stride), P(-2, 3), P(0, 3));
    case 8:
      return cellInterp(false, rs(px, 1, 3), rs(py, 1, 3), g(cols + rows * stride), P(3, 1), P(1, 3), P(3, 3));
    case 0:
      return cellInterp(false, rs(px, -2, 0), rs(py, -2, 0), P(-2, -2), P(0, -2), P(-2, 0), g(0));
    default:
      return cellInterp(false, rs(px, 1, 3), rs(py, -2, 0), P(1, -2), P(3, -2), g(cols), P(3, 0));
  }
}

/** Maps a point of a rotation deformer's local frame to its parent's space. */
export function rotationPoint(r: RotationState, baseAngle: number, px: number, py: number): Vec2 {
  const a = ((baseAngle + r.angle) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = px * r.scale * (r.reflectX ? -1 : 1);
  const y = py * r.scale * (r.reflectY ? -1 : 1);
  return [r.x + c * x - s * y, r.y + s * x + c * y];
}

/** How much a parent mapping turns the local "down" direction at a point (degrees): a child rotation deformer's angle correction. */
export function turnAt(ox: number, oy: number, step: number, map: (x: number, y: number) => Vec2): number {
  const o = map(ox, oy);
  for (let i = 0; i < 10; i++) {
    const d = step * 0.1 ** i;
    for (const sign of [1, -1]) {
      const p = map(ox, oy - d * sign);
      const rx = p[0] - o[0];
      const ry = p[1] - o[1];
      if (Number.isFinite(rx) && Number.isFinite(ry) && (rx || ry)) {
        // angle from (0, -sign) to (rx, ry)
        const dx = 0;
        const dy = -sign;
        return (Math.atan2(dx * ry - dy * rx, dx * rx + dy * ry) * 180) / Math.PI;
      }
    }
  }
  return 0;
}

// ---------- the frame

const frameCache = new WeakMap<object, { rig: Live2DRig; attachments: Model["attachments"]; frame: Live2DFrame }>();

/** Live2D meshes of the model: attachment id -> attachment (with live2d). */
export function live2dMeshes(model: Model): Array<[string, MeshAttachment & { live2d: Live2DMesh }]> {
  return Object.entries(model.attachments).filter((e): e is [string, MeshAttachment & { live2d: Live2DMesh }] => !!e[1].live2d);
}

/**
 * Evaluates the Live2D rig for parameter values. Cached per values object. Mesh opacities leave out the parts'
 * opacity (animated separately, see partOpacities).
 */
export function live2dFrame(model: Model, values: ParamValues): Live2DFrame {
  const rig = model.live2d;
  const hit = frameCache.get(values);
  if (hit && hit.rig === rig && hit.attachments === model.attachments) return hit.frame;
  const frame = computeFrame(model, values);
  frameCache.set(values, { rig: rig!, attachments: model.attachments, frame });
  return frame;
}

/** Effective part opacities (own, times the parents'): overrides (e.g. animated), else 1 for visible parts, 0 for hidden. */
export function partOpacities(rig: Live2DRig, overrides?: Record<string, number>): Map<string, number> {
  const byId = new Map(rig.parts.map((p) => [p.id, p]));
  const out = new Map<string, number>();
  const visit = (id: string, depth: number): number => {
    const hit = out.get(id);
    if (hit !== undefined) return hit;
    const p = byId.get(id);
    if (!p) return 1;
    const own = Math.min(1, Math.max(0, overrides?.[id] ?? (p.visible === false ? 0 : 1)));
    const v = own * (p.parent && depth < 64 ? visit(p.parent, depth + 1) : 1);
    out.set(id, v);
    return v;
  };
  for (const p of rig.parts) visit(p.id, 0);
  return out;
}

function computeFrame(model: Model, values: ParamValues): Live2DFrame {
  const rig: Live2DRig = model.live2d ?? { canvas: { width: 0, height: 0, originX: 0, originY: 0, pixelsPerUnit: 1 }, parts: [], deformers: [] };
  const params = new Map((model.parameters ?? []).map((p) => [p.id, p]));
  const eps = (id: string) => 0.1 ** (params.get(id)?.decimals ?? 3);
  // clamped values (repeat parameters are used as they are)
  const v: ParamValues = {};
  for (const [id, p] of params) {
    const x = values[id] ?? p.default;
    v[id] = p.repeat ? x : Math.min(Math.max(x, Math.min(p.min, p.max)), Math.max(p.min, p.max));
  }

  // parts: enabled down the tree, opacity multiplied down, draw orders
  const partById = new Map(rig.parts.map((p) => [p.id, p]));
  const partEnabled = new Map<string, boolean>();
  const partDrawOrder = new Map<string, number>();
  const visitPart = (id: string, depth = 0): void => {
    if (partEnabled.has(id)) return;
    const p = partById.get(id)!;
    if (p.parent && partById.has(p.parent) && depth < rig.parts.length) visitPart(p.parent, depth + 1);
    const b = gridBlend(p.grid, v, eps);
    const parentOn = !p.parent || partEnabled.get(p.parent) !== false;
    partEnabled.set(id, !p.disabled && !b.outside && parentOn);
    partDrawOrder.set(id, blendNum(b.terms, (i) => p.drawOrders[i] ?? 500) + addNum(blendShapeTerms(p.blendShapes, params, v), (x) => x));
  };
  for (const p of rig.parts) visitPart(p.id);

  // deformers, parents first
  const deformers = new Map<string, Live2DDeformerState>();
  const defById = new Map(rig.deformers.map((d) => [d.id, d]));
  const done = new Set<string>();
  const visitDeformer = (d: Deformer): void => {
    if (done.has(d.id)) return;
    done.add(d.id); // (also stops parent cycles; validation reports them)
    const parent = d.parent ? defById.get(d.parent) : undefined;
    if (parent) visitDeformer(parent);
    const ps = parent ? deformers.get(parent.id) : undefined;
    const b = gridBlend(d.grid, v, eps);
    const enabled = !d.disabled && !b.outside && (!d.part || partEnabled.get(d.part) !== false) && (!ps || ps.enabled);
    const bs = blendShapeTerms<WarpKeyform | RotationKeyform>(d.blendShapes, params, v);
    const opacity = (blendNum(b.terms, (i) => d.forms[i]?.opacity ?? 1) + addNum(bs, (f) => f.opacity)) * (ps?.opacity ?? 1);
    const ownMul = addRGB(blendRGB(b.terms, (i) => d.forms[i]?.multiply, ONE), bs, (f) => f.multiply);
    const ownScr = addRGB(blendRGB(b.terms, (i) => d.forms[i]?.screen, ZERO), bs, (f) => f.screen);
    const multiply = ps ? mulRGB(ps.multiply, ownMul) : ownMul;
    const screen = ps ? screenRGB(ps.screen, ownScr) : ownScr;
    if (d.type === "warp") {
      const n = (d.cols + 1) * (d.rows + 1) * 2;
      const grid = blendPoints(b.terms, (i) => d.forms[i]?.points ?? [], n);
      addPoints(grid, bs, (f) => (f as WarpKeyform).points);
      if (ps && parent) mapPoints(parent, ps, grid);
      deformers.set(d.id, { enabled, opacity, multiply, screen, scale: ps?.scale ?? 1, grid });
    } else {
      const forms = d.forms;
      const rs = bs as Array<[RotationKeyform, number]>;
      const r: RotationState = {
        x: blendNum(b.terms, (i) => forms[i]?.x ?? 0) + addNum(rs, (f) => f.x),
        y: blendNum(b.terms, (i) => forms[i]?.y ?? 0) + addNum(rs, (f) => f.y),
        angle: blendNum(b.terms, (i) => forms[i]?.angle ?? 0) + addNum(rs, (f) => f.angle),
        scale: blendNum(b.terms, (i) => forms[i]?.scale ?? 1) + addNum(rs, (f) => f.scale),
        // reflection is not interpolated: the first surrounding form decides
        reflectX: !!forms[b.terms[0]?.[0] ?? 0]?.reflectX,
        reflectY: !!forms[b.terms[0]?.[0] ?? 0]?.reflectY,
      };
      if (ps && parent) {
        const map = (x: number, y: number) => mapPoint(parent, ps, x, y);
        r.angle += turnAt(r.x, r.y, parent.type === "warp" ? 0.1 : 10, map);
        const o = map(r.x, r.y);
        r.x = o[0];
        r.y = o[1];
        r.scale *= ps.scale;
      }
      deformers.set(d.id, { enabled, opacity, multiply, screen, scale: r.scale, rotation: r });
    }
  };
  for (const d of rig.deformers) visitDeformer(d);

  // art meshes
  const meshes = new Map<string, Live2DMeshState>();
  for (const [id, att] of live2dMeshes(model)) {
    const m = att.live2d;
    const b = gridBlend(m.grid, v, eps);
    const parent = m.deformer ? defById.get(m.deformer) : undefined;
    const ps = parent ? deformers.get(parent.id) : undefined;
    const bs = blendShapeTerms(m.blendShapes, params, v);
    const points = blendPoints(b.terms, (i) => m.forms[i]?.points ?? [], m.forms[0]?.points.length ?? att.vertices.length * 2);
    addPoints(points, bs, (f) => f.points);
    if (parent && ps) mapPoints(parent, ps, points);
    const ownMul = addRGB(blendRGB(b.terms, (i) => m.forms[i]?.multiply, ONE), bs, (f) => f.multiply);
    const ownScr = addRGB(blendRGB(b.terms, (i) => m.forms[i]?.screen, ZERO), bs, (f) => f.screen);
    const opacity = (blendNum(b.terms, (i) => m.forms[i]?.opacity ?? 1) + addNum(bs, (f) => f.opacity)) * (ps?.opacity ?? 1);
    meshes.set(id, {
      part: m.part,
      points,
      opacity,
      drawOrder: blendNum(b.terms, (i) => m.forms[i]?.drawOrder ?? 500) + addNum(bs, (f) => f.drawOrder),
      multiply: ps ? mulRGB(ps.multiply, ownMul) : ownMul,
      screen: ps ? screenRGB(ps.screen, ownScr) : ownScr,
      enabled: !m.disabled && !b.outside && (!m.part || partEnabled.get(m.part) !== false) && (!ps || ps.enabled),
    });
  }

  // glue, in order, on the canvas-space results
  for (const g of rig.glue ?? []) {
    const a = meshes.get(g.a);
    const bm = meshes.get(g.b);
    if (!a || !bm) continue;
    const bsI = blendShapeTerms(g.blendShapes, params, v);
    let intensity = blendNum(gridBlend(g.grid, v, eps).terms, (i) => g.intensity[i] ?? 0) + addNum(bsI, (x) => x);
    if (bsI.length) intensity = Math.min(1, Math.max(0, intensity));
    for (let k = 0; k + 1 < g.pairs.length; k += 2) {
      const ia = g.pairs[k] * 2;
      const ib = g.pairs[k + 1] * 2;
      const ax = a.points[ia];
      const ay = a.points[ia + 1];
      const bx = bm.points[ib];
      const by = bm.points[ib + 1];
      a.points[ia] += (bx - ax) * g.weights[k] * intensity;
      a.points[ia + 1] += (by - ay) * g.weights[k] * intensity;
      bm.points[ib] += (ax - bx) * g.weights[k + 1] * intensity;
      bm.points[ib + 1] += (ay - by) * g.weights[k + 1] * intensity;
    }
  }

  return { meshes, deformers, order: renderOrder(model, rig, meshes, partEnabled, partDrawOrder) };
}

const mulRGB = (a: RGB, b: RGB): RGB => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const screenRGB = (a: RGB, b: RGB): RGB => [a[0] + b[0] - a[0] * b[0], a[1] + b[1] - a[1] * b[1], a[2] + b[2] - a[2] * b[2]];

function mapPoint(d: Deformer, s: Live2DDeformerState, x: number, y: number): Vec2 {
  if (d.type === "warp") return warpPoint(s.grid!, d.cols, d.rows, !!d.bilinear, x, y);
  return rotationPoint(s.rotation!, d.baseAngle, x, y);
}

function mapPoints(d: Deformer, s: Live2DDeformerState, pts: Float64Array): void {
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const q = mapPoint(d, s, pts[i], pts[i + 1]);
    pts[i] = q[0];
    pts[i + 1] = q[1];
  }
}

/** The draw-order groups of a rig (a default single group over every Live2D mesh when it has none). */
export function drawOrderGroups(model: Model, rig: Live2DRig = model.live2d!): DrawOrderGroup[] {
  if (rig.drawOrderGroups?.length) return rig.drawOrderGroups;
  const live = new Set(live2dMeshes(model).map(([id]) => id));
  const items = model.slots.filter((s) => s.attachment && live.has(s.attachment)).map((s) => ({ slot: s.id }));
  return [{ min: 0, max: 1000, items }];
}

function renderOrder(
  model: Model,
  rig: Live2DRig,
  meshes: Map<string, Live2DMeshState>,
  partEnabled: Map<string, boolean>,
  partDrawOrder: Map<string, number>,
): string[] {
  const groups = drawOrderGroups(model, rig);
  const slotAtt = new Map(model.slots.map((s) => [s.id, s.attachment]));
  const out: string[] = [];
  const emit = (gi: number, depth: number): void => {
    const g = groups[gi];
    if (!g || depth > groups.length) return;
    const keyed = g.items.map((it, j) => {
      let order: number | undefined;
      if ("slot" in it) {
        const m = meshes.get(slotAtt.get(it.slot) ?? "");
        order = m?.enabled ? Math.floor(m.drawOrder + 1e-3) : undefined;
      } else order = partEnabled.get(it.part) ? Math.floor((partDrawOrder.get(it.part) ?? 500) + 1e-3) : undefined;
      const o = Math.min(Math.max(order ?? g.min, g.min), g.max);
      return { it, j, o };
    });
    // integer draw orders (the Core truncates its float blend; the tolerance absorbs float noise), ties keep the list order
    keyed.sort((a, b) => a.o - b.o || a.j - b.j);
    for (const { it } of keyed) {
      if ("slot" in it) {
        const att = slotAtt.get(it.slot);
        const m = att ? meshes.get(att) : undefined;
        if (att && m && m.enabled && m.opacity !== 0) out.push(att);
      } else emit(it.group, depth + 1);
    }
  };
  emit(0, 0);
  return out;
}

/** World (pixels, +y up) position of a point of the rig's canvas space (moc units, +y down like Cubism's data). */
export function canvasToWorld(rig: Live2DRig, x: number, y: number): Vec2 {
  const s = rig.canvas.pixelsPerUnit || 1;
  return [x * s, -y * s];
}

/** A Live2D mesh's world-space vertices for a frame. */
export function live2dVertices(model: Model, frame: Live2DFrame, attachmentId: string): Vec2[] | undefined {
  const m = frame.meshes.get(attachmentId);
  if (!m) return undefined;
  const s = model.live2d?.canvas.pixelsPerUnit || 1;
  const out: Vec2[] = new Array(m.points.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = [m.points[i * 2] * s, -m.points[i * 2 + 1] * s];
  return out;
}

/** Deformers and glue of a frame in world space (what the editor and the renderer draw as guides). */
export interface Live2DGuides {
  warps: Array<{ id: string; cols: number; rows: number; points: Vec2[]; hidden: boolean }>;
  /** Rotation deformers: origin, and the unit direction of the deformer's "up" (its handle). */
  rotations: Array<{ id: string; origin: Vec2; up: Vec2; hidden: boolean }>;
  /** Glue: the glued vertex pairs of its two meshes. */
  glue: Array<{ id: string; a: string; b: string; lines: Array<[Vec2, Vec2]> }>;
}

/** World-space guides for the deformers and glue of a Live2D frame; deformers switched off (disabled, outside their keys) are left out. */
export function live2dGuides(model: Model, frame: Live2DFrame): Live2DGuides {
  const rig = model.live2d;
  const out: Live2DGuides = { warps: [], rotations: [], glue: [] };
  if (!rig) return out;
  const s = rig.canvas.pixelsPerUnit || 1;
  const world = (x: number, y: number): Vec2 => [x * s, -y * s];
  for (const d of rig.deformers) {
    const st = frame.deformers.get(d.id);
    if (!st?.enabled) continue;
    if (d.type === "warp" && st.grid) {
      const points: Vec2[] = [];
      for (let i = 0; i < st.grid.length; i += 2) points.push(world(st.grid[i], st.grid[i + 1]));
      out.warps.push({ id: d.id, cols: d.cols, rows: d.rows, points, hidden: !!d.hidden });
    } else if (d.type === "rotation" && st.rotation) {
      const o = rotationPoint(st.rotation, d.baseAngle, 0, 0);
      // the handle points along the deformer's local "up" (-y in canvas space)
      const t = rotationPoint(st.rotation, d.baseAngle, 0, -1);
      const dx = (t[0] - o[0]) * s;
      const dy = -(t[1] - o[1]) * s;
      const len = Math.hypot(dx, dy) || 1;
      out.rotations.push({ id: d.id, origin: world(o[0], o[1]), up: [dx / len, dy / len], hidden: !!d.hidden });
    }
  }
  for (const g of rig.glue ?? []) {
    const a = frame.meshes.get(g.a);
    const b = frame.meshes.get(g.b);
    if (!a || !b) continue;
    const lines: Array<[Vec2, Vec2]> = [];
    for (let i = 0; i + 1 < g.pairs.length; i += 2) {
      const ia = g.pairs[i] * 2;
      const ib = g.pairs[i + 1] * 2;
      lines.push([world(a.points[ia], a.points[ia + 1]), world(b.points[ib], b.points[ib + 1])]);
    }
    out.glue.push({ id: g.id, a: g.a, b: g.b, lines });
  }
  return out;
}

export type { RotationKeyform, WarpDeformer };
