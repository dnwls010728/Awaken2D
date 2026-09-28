// Live2D parameters: their values at a time (animation tracks, overrides, defaults) and the rest vertices they
// give art meshes (keyforms and deformers, see live2d.ts).
import { sampleTrack } from "./animation.ts";
import { live2dFrame, live2dVertices } from "./live2d.ts";
import { DEG, lerp } from "./math.ts";
import type { Animation, MeshAttachment, Model, Parameter, Vec2, VertexOffsets } from "./types.ts";

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

/**
 * Setup-space vertices of an attachment for the given parameter values: Live2D art meshes come from their
 * keyforms and deformers; anything else keeps its vertices (the original array).
 */
export function restVertices(model: Model, attachmentId: string, att: MeshAttachment, values: ParamValues): Vec2[] {
  if (!att.live2d || !model.live2d) return att.vertices;
  return live2dVertices(model, live2dFrame(model, values), attachmentId) ?? att.vertices;
}

export function findParameter(model: Model, id: string): Parameter | undefined {
  return model.parameters?.find((p) => p.id === id);
}

// ---------- shape generators (deform keys: intent -> vertex offsets, so agents never write per-vertex numbers)

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

/** Sparse form of dense offsets, dropping points that do not move. */
export function toSparse(offsets: Vec2[], eps = 1e-4): VertexOffsets {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const out: VertexOffsets = [];
  offsets.forEach(([dx, dy], i) => {
    if (Math.abs(dx) > eps || Math.abs(dy) > eps) out.push([i, r(dx), r(dy)]);
  });
  return out;
}
