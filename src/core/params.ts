// Live2D-style parameters: evaluating parameter values and everything they drive (bone offsets, slot tint and
// attachment, blend shapes, warp deformers), plus generators that turn intent ("close the eye", "turn the head")
// into keyform data so agents never have to write per-vertex numbers.
import { sampleTrack } from "./animation.ts";
import { live2dFrame, live2dVertices } from "./live2d.ts";
import { DEG, lerp, parseColor } from "./math.ts";
import type { RGBA } from "./math.ts";
import type { Animation, Combo, ComboKey, MeshAttachment, Model, ParamKey, Parameter, Vec2, VertexOffsets, Warp } from "./types.ts";

export type ParamValues = Record<string, number>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Parameter values at time t: explicit overrides, else the animation's param track, else the default. */
export function paramValues(model: Model, anim: Animation | undefined, t: number, overrides?: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const p of model.parameters ?? []) {
    let v = p.default;
    const keys = anim?.params?.[p.id];
    if (keys?.length) v = sampleTrack(keys, t, lerp)!;
    if (overrides && typeof overrides[p.id] === "number") v = overrides[p.id];
    out[p.id] = clamp(v, Math.min(p.min, p.max), Math.max(p.min, p.max));
  }
  return out;
}

/** Piecewise-linear sample of a parameter key track (keys sorted by `at`), clamped at the ends. */
export function sampleParam<T>(keys: ParamKey<T>[] | undefined, x: number, mix: (a: T, b: T, f: number) => T): T | undefined {
  if (!keys?.length) return undefined;
  if (x <= keys[0].at) return keys[0].v;
  const last = keys[keys.length - 1];
  if (x >= last.at) return last.v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].at <= x) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.at - a.at;
  return mix(a.v, b.v, span > 0 ? (x - a.at) / span : 1);
}

/** Stepped sample: the last key with at <= x (or the first key). */
export function stepParam<T>(keys: ParamKey<T>[] | undefined, x: number): T | undefined {
  if (!keys?.length) return undefined;
  let v = keys[0].v;
  for (const k of keys) if (k.at <= x + 1e-9) v = k.v;
  return v;
}

/**
 * Keyforms of a combination and their blend weights for the given values. Each axis is the keyed values plus
 * the parameter's default (missing grid points are "no change"); values are clamped to the grid and blended
 * multilinearly between the surrounding grid points.
 */
export function comboWeights(model: Model, combo: Combo, values: ParamValues): Array<[ComboKey, number]> {
  const dims = combo.params.length;
  if (!dims || !combo.keys.length) return [];
  const loc: Array<{ lo: number; hi: number; f: number }> = [];
  for (let d = 0; d < dims; d++) {
    const p = findParameter(model, combo.params[d]);
    if (!p) return [];
    const axis = [...new Set([p.default, ...combo.keys.map((k) => k.at[d])])].sort((a, b) => a - b);
    const v = clamp(values[p.id] ?? p.default, axis[0], axis[axis.length - 1]);
    let i = 0;
    while (i < axis.length - 2 && axis[i + 1] <= v) i++;
    const lo = axis[i];
    const hi = axis[Math.min(i + 1, axis.length - 1)];
    loc.push({ lo, hi, f: hi > lo ? (v - lo) / (hi - lo) : 0 });
  }
  const out: Array<[ComboKey, number]> = [];
  for (let corner = 0; corner < 1 << dims; corner++) {
    let weight = 1;
    const at: number[] = [];
    for (let d = 0; d < dims; d++) {
      const high = (corner >> d) & 1;
      weight *= high ? loc[d].f : 1 - loc[d].f;
      at.push(high ? loc[d].hi : loc[d].lo);
    }
    if (weight <= 1e-9) continue;
    const key = combo.keys.find((k) => k.at.length === dims && k.at.every((x, d) => Math.abs(x - at[d]) < 1e-9));
    if (key) out.push([key, weight]);
  }
  return out;
}

const mixNum = (a: number, b: number, f: number) => lerp(a, b, f);
const mixVec = (a: Vec2, b: Vec2, f: number): Vec2 => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];

export interface BoneOffsets {
  rotate: number;
  translate: Vec2;
  scale: Vec2;
}

/** Combined bone offsets of all parameters. */
export function paramBoneOffsets(model: Model, values: ParamValues): Map<string, BoneOffsets> {
  const out = new Map<string, BoneOffsets>();
  for (const p of model.parameters ?? []) {
    const x = values[p.id] ?? p.default;
    for (const [bone, tl] of Object.entries(p.bones ?? {})) {
      let o = out.get(bone);
      if (!o) out.set(bone, (o = { rotate: 0, translate: [0, 0], scale: [1, 1] }));
      o.rotate += sampleParam(tl.rotate, x, mixNum) ?? 0;
      const tr = sampleParam(tl.translate, x, mixVec);
      if (tr) o.translate = [o.translate[0] + tr[0], o.translate[1] + tr[1]];
      const sc = sampleParam(tl.scale, x, mixVec);
      if (sc) o.scale = [o.scale[0] * sc[0], o.scale[1] * sc[1]];
    }
  }
  for (const c of model.combos ?? []) {
    for (const [key, wt] of comboWeights(model, c, values)) {
      for (const [bone, e] of Object.entries(key.bones ?? {})) {
        let o = out.get(bone);
        if (!o) out.set(bone, (o = { rotate: 0, translate: [0, 0], scale: [1, 1] }));
        o.rotate += (e.rotate ?? 0) * wt;
        if (e.translate) o.translate = [o.translate[0] + e.translate[0] * wt, o.translate[1] + e.translate[1] * wt];
        if (e.scale) o.scale = [o.scale[0] * (1 + (e.scale[0] - 1) * wt), o.scale[1] * (1 + (e.scale[1] - 1) * wt)];
      }
    }
  }
  return out;
}

export interface SlotEffects {
  color?: RGBA;
  attachment?: string | null;
}

/** Combined slot effects of all parameters: tints multiply, the last parameter that switches an attachment wins. */
export function paramSlotEffects(model: Model, values: ParamValues): Map<string, SlotEffects> {
  const out = new Map<string, SlotEffects>();
  for (const p of model.parameters ?? []) {
    const x = values[p.id] ?? p.default;
    for (const [slot, tl] of Object.entries(p.slots ?? {})) {
      const e = out.get(slot) ?? {};
      if (tl.color?.length) {
        const keys = tl.color.map((k) => ({ at: k.at, v: parseColor(k.v) }));
        const c = sampleParam(keys, x, (a, b, f) => a.map((v, i) => lerp(v, b[i], f)) as RGBA)!;
        e.color = e.color ? (e.color.map((v, i) => v * c[i]) as RGBA) : c;
      }
      const att = stepParam(tl.attachment, x);
      if (att !== undefined) e.attachment = att;
      out.set(slot, e);
    }
  }
  return out;
}

// ---------- geometry

const denseCache = new WeakMap<object, Float64Array>();

/** Dense [dx0, dy0, dx1, dy1, ...] for sparse vertex offsets (cached per keyform). */
function denseOffsets(offsets: VertexOffsets, n: number): Float64Array {
  let d = denseCache.get(offsets);
  if (!d || d.length !== n * 2) {
    d = new Float64Array(n * 2);
    for (const [i, dx, dy] of offsets) {
      if (i >= 0 && i < n) {
        d[i * 2] += dx;
        d[i * 2 + 1] += dy;
      }
    }
    denseCache.set(offsets, d);
  }
  return d;
}

/** Adds the keyform interpolated at x (between the two surrounding keys) into acc. */
function accumulateKeyed<T extends object>(keys: ParamKey<T>[], x: number, dense: (v: T) => Float64Array, acc: Float64Array): void {
  if (!keys.length) return;
  let a = keys[0];
  let b = keys[0];
  let f = 0;
  if (x >= keys[keys.length - 1].at) a = b = keys[keys.length - 1];
  else if (x > keys[0].at) {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].at <= x) i++;
    a = keys[i];
    b = keys[i + 1];
    f = b.at > a.at ? (x - a.at) / (b.at - a.at) : 1;
  }
  const da = dense(a.v);
  const db = dense(b.v);
  for (let i = 0; i < acc.length; i++) acc[i] += da[i] * (1 - f) + db[i] * f;
}

/** Control-point grid of a warp in setup space (row-major from the bottom row). */
export function warpGrid(w: Warp): Vec2[] {
  const pts: Vec2[] = [];
  for (let j = 0; j <= w.rows; j++) {
    for (let i = 0; i <= w.cols; i++) pts.push([w.rect.x + (w.rect.width * i) / w.cols, w.rect.y + (w.rect.height * j) / w.rows]);
  }
  return pts;
}

/** Combined control-point offsets of a warp for the given parameter values, or null when nothing moves. */
export function warpOffsets(model: Model, warp: Warp, values: ParamValues): Float64Array | null {
  const n = (warp.cols + 1) * (warp.rows + 1);
  let acc: Float64Array | null = null;
  const dense = (v: Vec2[]) => {
    let d = denseCache.get(v);
    if (!d || d.length !== n * 2) {
      d = new Float64Array(n * 2);
      v.forEach((o, i) => {
        if (i < n) {
          d![i * 2] = o[0];
          d![i * 2 + 1] = o[1];
        }
      });
      denseCache.set(v, d);
    }
    return d;
  };
  for (const p of model.parameters ?? []) {
    const keys = p.warps?.[warp.id];
    if (!keys?.length) continue;
    acc ??= new Float64Array(n * 2);
    accumulateKeyed(keys, values[p.id] ?? p.default, dense, acc);
  }
  for (const c of model.combos ?? []) {
    if (!c.keys.some((k) => k.warps?.[warp.id])) continue;
    for (const [key, wt] of comboWeights(model, c, values)) {
      const v = key.warps?.[warp.id];
      if (!v) continue;
      acc ??= new Float64Array(n * 2);
      const d = dense(v);
      for (let i = 0; i < acc.length; i++) acc[i] += d[i] * wt;
    }
  }
  return acc;
}

/** Displacement of a setup-space point by a warp (bilinear in its cell; points outside take the edge value). */
export function warpDisplace(warp: Warp, off: Float64Array, p: Vec2): Vec2 {
  const u = ((p[0] - warp.rect.x) / warp.rect.width) * warp.cols;
  const v = ((p[1] - warp.rect.y) / warp.rect.height) * warp.rows;
  const ci = clamp(Math.floor(u), 0, warp.cols - 1);
  const cj = clamp(Math.floor(v), 0, warp.rows - 1);
  const fu = clamp(u - ci, 0, 1);
  const fv = clamp(v - cj, 0, 1);
  const stride = warp.cols + 1;
  const at = (i: number, j: number, k: number) => off[((cj + j) * stride + ci + i) * 2 + k];
  const d = (k: number) =>
    at(0, 0, k) * (1 - fu) * (1 - fv) + at(1, 0, k) * fu * (1 - fv) + at(0, 1, k) * (1 - fu) * fv + at(1, 1, k) * fu * fv;
  return [d(0), d(1)];
}

/**
 * Setup-space vertices of an attachment after blend shapes (all parameters) and warps (in order); Live2D meshes
 * start from their keyforms and deformers. Returns the original array when no parameter touches it.
 */
export function restVertices(model: Model, attachmentId: string, att: MeshAttachment, values: ParamValues): Vec2[] {
  if (!model.parameters?.length) return att.vertices;
  const base = att.live2d && model.live2d ? (live2dVertices(model, live2dFrame(model, values), attachmentId) ?? att.vertices) : att.vertices;
  const n = att.vertices.length;
  let acc: Float64Array | null = null;
  for (const p of model.parameters) {
    const keys = p.meshes?.[attachmentId];
    if (!keys?.length) continue;
    acc ??= new Float64Array(n * 2);
    accumulateKeyed(keys, values[p.id] ?? p.default, (v) => denseOffsets(v, n), acc);
  }
  for (const c of model.combos ?? []) {
    if (!c.keys.some((k) => k.meshes?.[attachmentId])) continue;
    for (const [key, wt] of comboWeights(model, c, values)) {
      const v = key.meshes?.[attachmentId];
      if (!v) continue;
      acc ??= new Float64Array(n * 2);
      const d = denseOffsets(v, n);
      for (let i = 0; i < acc.length; i++) acc[i] += d[i] * wt;
    }
  }
  let verts: Vec2[] = acc ? base.map((v, i) => [v[0] + acc![i * 2], v[1] + acc![i * 2 + 1]]) : base;
  for (const w of model.warps ?? []) {
    if (!w.targets.includes(attachmentId)) continue;
    const off = warpOffsets(model, w, values);
    if (!off) continue;
    verts = verts.map((v) => {
      const d = warpDisplace(w, off, v);
      return [v[0] + d[0], v[1] + d[1]];
    });
  }
  return verts;
}

// ---------- keyform generators

export interface ShapeTransform {
  /** Pivot for scale/rotate. Default: center of the affected points' bounds. */
  pivot?: Vec2;
  translate?: Vec2;
  /** Degrees counter-clockwise. */
  rotate?: number;
  /** Uniform factor or [sx, sy]. */
  scale?: number | Vec2;
  /** Only points within `radius` of `center` move, fading out smoothly toward the edge. */
  falloff?: { center?: Vec2; radius: number };
  /** Restrict to these point indices. */
  only?: number[];
}

/** Offsets that move `points` by an affine transform (optionally with a smooth radial falloff). */
export function transformOffsets(points: Vec2[], t: ShapeTransform): Vec2[] {
  const idx = t.only ?? points.map((_, i) => i);
  const sel = idx.map((i) => points[i]).filter(Boolean);
  const xs = sel.map((p) => p[0]);
  const ys = sel.map((p) => p[1]);
  const pivot = t.pivot ?? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const [sx, sy] = typeof t.scale === "number" ? [t.scale, t.scale] : (t.scale ?? [1, 1]);
  const r = (t.rotate ?? 0) * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const [tx, ty] = t.translate ?? [0, 0];
  const center = t.falloff?.center ?? pivot;
  const allowed = new Set(idx);
  return points.map((p, i) => {
    if (!allowed.has(i)) return [0, 0];
    let w = 1;
    if (t.falloff) {
      const d = Math.hypot(p[0] - center[0], p[1] - center[1]) / Math.max(t.falloff.radius, 1e-9);
      const k = clamp(1 - d, 0, 1);
      w = k * k * (3 - 2 * k);
    }
    const lx = (p[0] - pivot[0]) * sx;
    const ly = (p[1] - pivot[1]) * sy;
    const nx = pivot[0] + lx * cos - ly * sin + tx;
    const ny = pivot[1] + lx * sin + ly * cos + ty;
    return [(nx - p[0]) * w, (ny - p[1]) * w];
  });
}

export const WARP_PRESETS = ["turnX", "turnY", "shearX", "shearY", "scale", "scaleX", "scaleY", "translateX", "translateY"] as const;
export type WarpPreset = (typeof WARP_PRESETS)[number];

/**
 * Control-point offsets for common warp intents. `amount`:
 * turnX/turnY: fraction of the width/height the middle bulges toward (e.g. 0.12; negative = other way);
 * shearX/shearY: fraction of width/height the top/right edge slides; scale*: factor - 1; translate*: world units.
 */
export function warpPresetOffsets(w: Warp, preset: WarpPreset, amount: number): Vec2[] {
  const { x, y, width, height } = w.rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return warpGrid(w).map(([px, py]) => {
    const u = (px - x) / width;
    const v = (py - y) / height;
    const bu = 1 - (2 * u - 1) ** 2; // 1 in the middle column, 0 at the edges
    const bv = 1 - (2 * v - 1) ** 2;
    switch (preset) {
      case "turnX":
        return [amount * width * bu * (0.55 + 0.45 * bv), 0];
      case "turnY":
        return [0, amount * height * bv * (0.55 + 0.45 * bu)];
      case "shearX":
        return [amount * width * (v - 0.5), 0];
      case "shearY":
        return [0, amount * height * (u - 0.5)];
      case "scale":
        return [(px - cx) * amount, (py - cy) * amount];
      case "scaleX":
        return [(px - cx) * amount, 0];
      case "scaleY":
        return [0, (py - cy) * amount];
      case "translateX":
        return [amount, 0];
      case "translateY":
        return [0, amount];
    }
  }) as Vec2[];
}

/** Sparse form of dense offsets, dropping points that do not move. */
export function toSparse(offsets: Vec2[], eps = 1e-4): VertexOffsets {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const out: VertexOffsets = [];
  offsets.forEach(([dx, dy], i) => {
    if (Math.abs(dx) > eps || Math.abs(dy) > eps) out.push([i, r(dx), r(dy)]);
  });
  return out;
}

export function findParameter(model: Model, id: string): Parameter | undefined {
  return model.parameters?.find((p) => p.id === id);
}
