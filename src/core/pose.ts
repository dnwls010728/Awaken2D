import { localTime, sampleTrack } from "./animation.ts";

/** Spine models evaluate bezier eases like the Spine runtime (see easeValue). */
export const spineCurves = (model: Model) => model.target === "spine";
import { applyIkConstraints } from "./ik.ts";
import { live2dFrame, partOpacities } from "./live2d.ts";
import { poseParts, settledPose } from "./live2dpose.ts";
import { paramValues, restVertices } from "./params.ts";
import type { ParamValues } from "./params.ts";
import { IDENTITY, apply, fromTRS, invert, lerp, mul, parseColor } from "./math.ts";
import { SpineState, needsSpineUpdate, spineUpdate } from "./spine.ts";
import type { SpineSkeleton } from "./spine.ts";
import type { Mat, RGBA } from "./math.ts";
import type { BlendMode, DeformKey, RGB, DrawOrderKey, Inherit, MeshAttachment, Model, PathAttachment, Slider, Vec2, VertexOffsets } from "./types.ts";

export interface BonePose {
  id: string;
  parent: string | null;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX?: number;
  shearY?: number;
  /** Spine inherit mode, when not "normal". */
  inherit?: Inherit;
  length: number;
  world: Mat;
}

export interface SlotPose {
  id: string;
  bone: string;
  attachment: string | null;
  color: RGBA;
  blend: BlendMode;
  clip?: string | string[];
  clipInvert?: boolean;
  cull?: boolean;
  /** Spine two-color tint dark color (slots with `dark`). */
  dark?: RGB;
}

export interface Pose {
  animation: string | null;
  time: number;
  /** Bones in parent-before-child order. */
  bones: BonePose[];
  byId: Map<string, BonePose>;
  /** Slots in draw order. */
  slots: SlotPose[];
  /** Parameter values used for this pose (absent for the raw setup/bind pose). */
  params?: ParamValues;
  /** Live2D part opacities set by the animation (others use the part's default). */
  parts?: Record<string, number>;
  /** Bones that are off (Spine skin bones the active skin does not list): their slots are not drawn. */
  inactive?: Set<string>;
  /** Other animations posed on top by Spine sliders (their deform keys are mixed in by poseDeform). */
  layers?: Array<{ animation: string; time: number; mix: number; additive: boolean }>;
}

const orderCache = new WeakMap<Model["bones"], { ids: string[]; parents: Array<string | null>; order: string[] }>();

/** Parent-before-child bone order. Throws on unknown parents or cycles. */
export function boneOrder(model: Model): string[] {
  // poses are computed many times per model (physics steps, sampling): reuse the order while the bone list is
  // unchanged (checked, since ops edit the array in place)
  const hit = orderCache.get(model.bones);
  if (hit && hit.ids.length === model.bones.length && model.bones.every((b, i) => b.id === hit.ids[i] && b.parent === hit.parents[i])) {
    return hit.order;
  }
  const order = computeBoneOrder(model);
  orderCache.set(model.bones, { ids: model.bones.map((b) => b.id), parents: model.bones.map((b) => b.parent), order });
  return order;
}

function computeBoneOrder(model: Model): string[] {
  const byId = new Map(model.bones.map((b) => [b.id, b]));
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const visit = (id: string, trail: string[]) => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) throw new Error(`bone hierarchy cycle: ${[...trail, id].join(" -> ")}`);
    const b = byId.get(id);
    if (!b) throw new Error(`unknown bone "${id}"`);
    state.set(id, 1);
    if (b.parent !== null) {
      if (!byId.has(b.parent)) throw new Error(`bone "${id}" has unknown parent "${b.parent}"`);
      visit(b.parent, [...trail, id]);
    }
    state.set(id, 2);
    order.push(id);
  };
  for (const b of model.bones) visit(b.id, []);
  return order;
}

const mixNum = (a: number, b: number, f: number) => lerp(a, b, f);
const mixVec = (a: Vec2, b: Vec2, f: number): Vec2 => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
const mixColor = (a: RGBA, b: RGBA, f: number): RGBA => [
  lerp(a[0], b[0], f),
  lerp(a[1], b[1], f),
  lerp(a[2], b[2], f),
  lerp(a[3], b[3], f),
];
const stepAny = <T>(a: T) => a;

export interface PoseOptions {
  /**
   * Apply IK constraints. Off by default: the raw setup pose is the skinning bind pose and the
   * frame of reference for editing. Everything that shows or checks a pose turns it on.
   */
  constraints?: boolean;
  /**
   * Evaluate parameters (with these overrides; {} = animation values or defaults). Off (undefined) for the raw
   * setup pose, which is the skinning bind pose.
   */
  params?: ParamValues;
  /** Skip slot evaluation (colors, attachments): for intermediate physics steps that only need bones. */
  bonesOnly?: boolean;
  /**
   * Spine physics: the simulation state to use ("update" steps it to state.time, "pose" only applies it).
   * Without it Spine physics constraints do nothing (PoseSimulator provides it).
   */
  spine?: { state: SpineState; physics: "update" | "pose" };
}

/**
 * The attachment a slot shows for an attachment key (setup or keyed): the active skin's attachment for that
 * placeholder, else the key itself when it is an attachment id, else nothing.
 */
export function resolveAttachment(model: Model, slot: string, key: string | null): string | null {
  if (key === null) return null;
  const skin = model.skin ? model.skins?.[model.skin] : undefined;
  const mapped = skin?.attachments[slot]?.[key];
  if (mapped !== undefined) return mapped;
  if (model.attachments[key] || model.pathAttachments?.[key] || model.clippings?.[key] || model.boundingBoxes?.[key]) return key;
  // a placeholder only some skin defines: the default skin's entry, if any
  const def = model.skins?.default?.attachments[slot]?.[key];
  return def ?? null;
}

/** Recomputes world matrices from local transforms (bones must be in parent-before-child order). */
export function updateWorld(pose: Pose): void {
  for (const p of pose.bones) {
    const local = fromTRS(p.x, p.y, p.rotation, p.scaleX, p.scaleY, p.shearX, p.shearY);
    p.world = p.parent === null ? local : mul(pose.byId.get(p.parent)!.world, local);
  }
}

export function computePose(model: Model, animation: string | null = null, time = 0, opts: PoseOptions = {}): Pose {
  const anim = animation ? model.animations?.[animation] : undefined;
  if (animation && !anim) throw new Error(`unknown animation "${animation}"`);
  const t = anim ? localTime(anim, time) : 0;
  const order = boneOrder(model);
  const src = new Map(model.bones.map((b) => [b.id, b]));
  const values = opts.params ? paramValues(model, anim, t, opts.params) : undefined;
  const byId = new Map<string, BonePose>();
  const bones: BonePose[] = [];
  for (const id of order) {
    const b = src.get(id)!;
    const tl = anim?.bones?.[id];
    const rot = sampleTrack(tl?.rotate, t, mixNum, spineCurves(model)) ?? 0;
    let tr = sampleTrack(tl?.translate, t, mixVec, spineCurves(model)) ?? [0, 0];
    let sc = sampleTrack(tl?.scale, t, mixVec, spineCurves(model)) ?? [1, 1];
    let sh = tl?.shear?.length ? sampleTrack(tl.shear, t, mixVec, spineCurves(model))! : null;
    if (tl && (tl.translateX || tl.translateY || tl.scaleX || tl.scaleY || tl.shearX || tl.shearY)) {
      // single-axis tracks replace their axis
      const axis = (keys: typeof tl.translateX, v: number) => sampleTrack(keys, t, mixNum, spineCurves(model)) ?? v;
      tr = [axis(tl.translateX, tr[0]), axis(tl.translateY, tr[1])];
      sc = [axis(tl.scaleX, sc[0]), axis(tl.scaleY, sc[1])];
      if (tl.shearX || tl.shearY || sh) sh = [axis(tl.shearX, sh?.[0] ?? 0), axis(tl.shearY, sh?.[1] ?? 0)];
    }
    const inherit = tl?.inherit?.length ? sampleTrack(tl.inherit, t, stepAny, spineCurves(model))! : (b.inherit ?? "normal");
    const p: BonePose = {
      id,
      parent: b.parent,
      x: b.x + tr[0],
      y: b.y + tr[1],
      rotation: b.rotation + rot,
      scaleX: b.scaleX * sc[0],
      scaleY: b.scaleY * sc[1],
      length: b.length,
      world: IDENTITY,
    };
    const shx = (b.shearX ?? 0) + (sh?.[0] ?? 0);
    const shy = (b.shearY ?? 0) + (sh?.[1] ?? 0);
    if (shx || shy) {
      p.shearX = shx;
      p.shearY = shy;
    }
    if (inherit !== "normal") p.inherit = inherit;
    const local = fromTRS(p.x, p.y, p.rotation, p.scaleX, p.scaleY, shx, shy);
    p.world = b.parent === null ? local : mul(byId.get(b.parent)!.world, local);
    byId.set(id, p);
    bones.push(p);
  }
  const slots: SlotPose[] = opts.bonesOnly ? [] : model.slots.map((s) => {
    const tl = anim?.slots?.[s.id];
    const att = tl?.attachment?.length ? sampleTrack(tl.attachment, t, stepAny, spineCurves(model)) : undefined;
    let color = parseColor(s.color);
    if (tl?.color?.length) {
      const keys = tl.color.map((k) => ({ ...k, v: parseColor(k.v) }));
      color = sampleTrack(keys, t, mixColor, spineCurves(model))!;
    }
    let dark: RGB | undefined;
    if (s.dark || tl?.dark?.length) {
      const d = tl?.dark?.length ? sampleTrack(tl.dark.map((k) => ({ ...k, v: parseColor(k.v) })), t, mixColor, spineCurves(model))! : parseColor(s.dark!);
      dark = [d[0], d[1], d[2]];
    }
    return {
      id: s.id,
      bone: s.bone,
      attachment: resolveAttachment(model, s.id, att !== undefined ? att : s.attachment),
      color,
      blend: s.blend ?? "normal",
      ...(s.clip ? { clip: s.clip } : {}),
      ...(s.clipInvert ? { clipInvert: true } : {}),
      ...(s.cull ? { cull: true } : {}),
      ...(dark ? { dark } : {}),
    };
  });
  let parts: Record<string, number> | undefined;
  if (model.live2d && anim?.partOpacity) {
    for (const [id, keys] of Object.entries(anim.partOpacity)) {
      const v = sampleTrack(keys, t, mixNum, spineCurves(model));
      if (v !== undefined) (parts ??= {})[id] = v;
    }
  }
  if (model.live2d?.pose?.groups.length) {
    // pose groups: the animated values pick the shown part (settled here; PoseSimulator fades like Cubism)
    const grouped = poseParts(model);
    const animated = parts;
    parts = Object.fromEntries(Object.entries(animated ?? {}).filter(([id]) => !grouped.has(id)));
    for (const [id, v] of settledPose(model.live2d.pose, animated)) parts[id] = v;
  }
  const ordered = anim?.drawOrder?.length && slots.length ? applyDrawOrder(slots, anim.drawOrder, t) : slots;
  const pose: Pose = { animation: anim ? animation : null, time: t, bones, byId, slots: ordered, ...(values ? { params: values } : {}), ...(parts ? { parts } : {}) };
  if (needsSpineUpdate(model)) spinePose(model, pose, opts);
  else if (opts.constraints && model.ik?.length) applyIkConstraints(model.ik, pose, anim?.ik, t);
  return pose;
}

const setupCache = new WeakMap<Model, { bones: Model["bones"]; pose: Pose }>();
/** The raw setup pose (skinning bind pose), cached while the bone list is the same array. */
function setupPoseOf(model: Model): Pose {
  const hit = setupCache.get(model);
  if (hit && hit.bones === model.bones) return hit.pose;
  const pose = computePose(model);
  setupCache.set(model, { bones: model.bones, pose });
  return pose;
}

/** Runs the Spine update (inherit modes, constraints) over the animated local poses and stores the result. */
function spinePose(model: Model, pose: Pose, opts: PoseOptions): void {
  const locals = new Map<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number; shearX: number; shearY: number; inherit: Inherit }>();
  for (const b of pose.bones) {
    locals.set(b.id, { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY, shearX: b.shearX ?? 0, shearY: b.shearY ?? 0, inherit: b.inherit ?? "normal" });
  }
  const layers: NonNullable<Pose["layers"]> = [];
  const constraints = !!opts.constraints;
  const { sk, inactive } = spineUpdate({
    model,
    locals,
    animation: pose.animation,
    time: pose.time,
    constraints,
    state: opts.spine?.state,
    physics: opts.spine?.physics,
    pathVertices: (slot, skel) => {
      const sp = pose.slots.find((x) => x.id === slot);
      const att = sp?.attachment ? model.pathAttachments?.[sp.attachment] : undefined;
      if (!att) return null;
      return { att, world: pathWorld(model, pose, sp!.attachment!, att, skel, sp!.bone) };
    },
    applySlider: (skel, slider, time, mix) => {
      applySliderBones(model, skel, slider, time, mix);
      layers.push({ animation: slider.animation, time, mix, additive: !!slider.additive });
    },
  });
  for (const p of pose.bones) {
    const b = sk.byId.get(p.id)!;
    p.x = b.x;
    p.y = b.y;
    p.rotation = b.rotation;
    p.scaleX = b.scaleX;
    p.scaleY = b.scaleY;
    if (b.shearX || b.shearY) {
      p.shearX = b.shearX;
      p.shearY = b.shearY;
    } else {
      delete p.shearX;
      delete p.shearY;
    }
    p.world = [b.a, b.c, b.b, b.d, b.worldX, b.worldY];
  }
  if (inactive.size) {
    pose.inactive = inactive;
    for (const s of pose.slots) if (inactive.has(s.bone)) s.attachment = null;
  }
  if (layers.length) {
    pose.layers = layers;
    // the sliders' slot keys: color mixed from the current color, attachments set
    for (const l of layers) {
      const a = model.animations?.[l.animation];
      for (const s of pose.slots) {
        const tl = a?.slots?.[s.id];
        if (!tl) continue;
        if (tl.color?.length) {
          const c = sampleTrack(tl.color.map((k) => ({ ...k, v: parseColor(k.v) })), l.time, mixColor, spineCurves(model))!;
          s.color = s.color.map((v, i) => v + (c[i] - v) * l.mix) as RGBA;
        }
        if (tl.dark?.length) {
          const c = sampleTrack(tl.dark.map((k) => ({ ...k, v: parseColor(k.v) })), l.time, mixColor, spineCurves(model))!;
          const from = s.dark ?? [0, 0, 0];
          s.dark = from.map((v, i) => v + (c[i] - v) * l.mix) as RGB;
        }
        if (tl.attachment?.length && l.time >= tl.attachment[0].t) s.attachment = resolveAttachment(model, s.id, sampleTrack(tl.attachment, l.time, stepAny, spineCurves(model))!);
      }
    }
  }
}

/** A slider's animation on the bones' local poses, mixed from their current values (Spine's MixFrom.current). */
function applySliderBones(model: Model, sk: SpineSkeleton, slider: Slider, time: number, alpha: number): void {
  const anim = model.animations?.[slider.animation];
  const add = !!slider.additive;
  const src = new Map(model.bones.map((b) => [b.id, b]));
  const rel = (current: number, setup: number, value: number) => current + (add ? value : value + setup - current) * alpha;
  const scale = (current: number, setup: number, curve: number) => {
    const value = curve * setup;
    if (alpha === 1 && !add) return value;
    if (add) return current + (value - setup) * alpha;
    const base = Math.abs(current) * Math.sign(value);
    return base + (value - base) * alpha;
  };
  for (const [id, tl] of Object.entries(anim?.bones ?? {})) {
    const b = sk.byId.get(id);
    const setup = src.get(id);
    if (!b || !setup || !b.active) continue;
    const r = sampleTrack(tl.rotate, time, mixNum, spineCurves(model));
    if (r !== undefined) b.rotation = rel(b.rotation, setup.rotation, r);
    const tr = sampleTrack(tl.translate, time, mixVec, spineCurves(model));
    if (tr) {
      b.x = rel(b.x, setup.x, tr[0]);
      b.y = rel(b.y, setup.y, tr[1]);
    }
    const sc = sampleTrack(tl.scale, time, mixVec, spineCurves(model));
    if (sc) {
      b.scaleX = scale(b.scaleX, setup.scaleX, sc[0]);
      b.scaleY = scale(b.scaleY, setup.scaleY, sc[1]);
    }
    const sh = sampleTrack(tl.shear, time, mixVec, spineCurves(model));
    if (sh) {
      b.shearX = rel(b.shearX, setup.shearX ?? 0, sh[0]);
      b.shearY = rel(b.shearY, setup.shearY ?? 0, sh[1]);
    }
  }
}

/** World positions of a path attachment's vertices for the bones being updated (with its deform keys). */
function pathWorld(model: Model, pose: Pose, id: string, att: PathAttachment, sk: SpineSkeleton, slotBone: string): Vec2[] {
  const setup = setupPoseOf(model);
  const keys = pose.animation ? model.animations?.[pose.animation]?.deform?.[id] : undefined;
  // Spine's own per-influence deltas when the keys carry them (exact), else setup-space offsets
  const local = keys?.length ? localDeform(keys, att as unknown as MeshAttachment, pose.time) : null;
  let rest = att.vertices;
  if (keys?.length && !local) {
    const d = sampleTrack(keys.map((k) => ({ ...k, v: denseDeform(k.v, att.vertices.length) })), pose.time, (a, b, f) => {
      const out = new Float64Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f;
      return out;
    }, true)!;
    rest = rest.map((v, i) => [v[0] + d[i * 2], v[1] + d[i * 2 + 1]]);
  }
  const inv = new Map<string, Mat>();
  const invSetup = (bone: string) => {
    let m = inv.get(bone);
    if (!m) inv.set(bone, (m = invert(setup.byId.get(bone)!.world)));
    return m;
  };
  const binds = att.binds && att.binds.length === att.weights.reduce((n, w) => n + Math.max(1, w.length), 0) * 2 ? att.binds : null;
  let f = 0;
  return rest.map((v, i) => {
    let infl = att.weights[i];
    if (!infl?.length) infl = [[slotBone, 1]];
    let x = 0;
    let y = 0;
    for (const [bone, w] of infl) {
      const b = sk.byId.get(bone)!;
      // the vertex in the bone's space (Spine's bind position), plus the deform delta there
      let bx: number;
      let by: number;
      if (binds) {
        bx = binds[f] + (v[0] - att.vertices[i][0]);
        by = binds[f + 1] + (v[1] - att.vertices[i][1]);
        if (!(v[0] === att.vertices[i][0] && v[1] === att.vertices[i][1])) {
          // setup-space offsets turn into the bone's space
          const m = invSetup(bone);
          const ox = v[0] - att.vertices[i][0];
          const oy = v[1] - att.vertices[i][1];
          bx = binds[f] + m[0] * ox + m[2] * oy;
          by = binds[f + 1] + m[1] * ox + m[3] * oy;
        }
      } else {
        const m = invSetup(bone);
        bx = m[0] * v[0] + m[2] * v[1] + m[4];
        by = m[1] * v[0] + m[3] * v[1] + m[5];
      }
      if (local) {
        bx += local[f];
        by += local[f + 1];
      }
      f += 2;
      x += (b.a * bx + b.b * by + b.worldX) * w;
      y += (b.c * bx + b.d * by + b.worldY) * w;
    }
    return [x, y] as Vec2;
  });
}

/** Reorders slots by the draw-order key in effect at time t (stepped; Spine's offset algorithm). */
export function applyDrawOrder<T extends { id: string }>(slots: T[], keys: DrawOrderKey[], t: number): T[] {
  let key: DrawOrderKey | undefined;
  for (const k of keys) if (k.t <= t + 1e-9 && (!key || k.t >= key.t)) key = k;
  if (!key || !key.offsets.length) return slots;
  const index = new Map(slots.map((s, i) => [s.id, i]));
  const out: Array<T | undefined> = new Array(slots.length);
  const moved = new Set<string>();
  const entries = key.offsets.filter(([id]) => index.has(id)).sort((a, b) => index.get(a[0])! - index.get(b[0])!);
  for (const [id, off] of entries) {
    let at = Math.max(0, Math.min(slots.length - 1, index.get(id)! + off));
    while (out[at] !== undefined && at < slots.length - 1) at++;
    while (out[at] !== undefined && at > 0) at--;
    out[at] = slots[index.get(id)!];
    moved.add(id);
  }
  let fill = 0;
  for (const s of slots) {
    if (moved.has(s.id)) continue;
    while (out[fill] !== undefined) fill++;
    out[fill] = s;
  }
  return out as T[];
}

/** World position of a bone's origin and tip. */
export function boneEnds(p: BonePose): { start: Vec2; end: Vec2 } {
  return { start: apply(p.world, 0, 0), end: apply(p.world, p.length, 0) };
}

/**
 * Linear blend skinning. Vertices are authored in setup-pose world space, so each
 * bone contributes (poseWorld * inverse(setupWorld)) * vertex.
 */
export function deformMesh(att: MeshAttachment, setup: Pose, pose: Pose, fallbackBone: string, rest: Vec2[] = att.vertices, local: Float64Array | null = null): Vec2[] {
  const skin = new Map<string, Mat>();
  const skinFor = (id: string): Mat | undefined => {
    let m = skin.get(id);
    if (!m) {
      const s = setup.byId.get(id);
      const p = pose.byId.get(id);
      if (!s || !p) return undefined;
      m = mul(p.world, invert(s.world));
      skin.set(id, m);
    }
    return m;
  };
  let f = 0; // index into per-influence local deltas / bind positions
  const binds = att.binds && att.binds.length === influenceCount(att) * 2 ? att.binds : null;
  return rest.map((v, i) => {
    let infl = att.weights[i];
    if (!infl || infl.length === 0) infl = [[fallbackBone, 1]];
    let x = 0;
    let y = 0;
    let total = 0;
    for (const [id, w] of infl) {
      const dx = local ? local[f] : 0;
      const dy = local ? local[f + 1] : 0;
      const bx = binds ? binds[f] : 0;
      const by = binds ? binds[f + 1] : 0;
      f += 2;
      const m = skinFor(id);
      if (!m || !(w > 0)) continue;
      let q: Vec2;
      if (binds) {
        // Spine: the posed bone carries its own bind position; setup-space offsets (shapes, deform keys) follow
        // the bone's rotation/scale since setup
        const p = pose.byId.get(id)!.world;
        const ox = v[0] - att.vertices[i][0];
        const oy = v[1] - att.vertices[i][1];
        q = [p[0] * bx + p[2] * by + p[4] + (m[0] * ox + m[2] * oy), p[1] * bx + p[3] * by + p[5] + (m[1] * ox + m[3] * oy)];
      } else q = apply(m, v[0], v[1]);
      if (dx || dy) {
        // a Spine deform delta lives in the bone's local space: the posed bone carries it
        const p = pose.byId.get(id)!.world;
        q[0] += p[0] * dx + p[2] * dy;
        q[1] += p[1] * dx + p[3] * dy;
      }
      x += q[0] * w;
      y += q[1] * w;
      total += w;
    }
    return total > 0 ? [x / total, y / total] : [v[0], v[1]];
  });
}

export interface DrawItem {
  slot: string;
  attachmentId: string;
  attachment: MeshAttachment;
  positions: Vec2[];
  /** Slot color multiplied with attachment color. */
  color: RGBA;
  blend: BlendMode;
  /** Slots whose drawn shapes mask this item (their union). */
  clip?: string[];
  /** Draw only outside the mask. */
  clipInvert?: boolean;
  /** Live2D screen color (lightens: c + s - c*s), when not black. */
  screen?: RGB;
  /** Hide back-facing triangles. */
  cull?: boolean;
  /** Spine two-color tint: the color the image's dark parts take (light parts take `color`). */
  dark?: RGB;
  /** Spine clipping: drawn only inside this world-space polygon. Items clipped by one attachment share the array. */
  clipPolygon?: Vec2[];
  /** Spine inverse clipping: drawn only outside `clipPolygon`. */
  clipOutside?: boolean;
}

const deformDense = new WeakMap<object, Float64Array>();
/** Dense offsets of one deform keyform (cached). */
function denseDeform(v: VertexOffsets, n: number): Float64Array {
  let d = deformDense.get(v);
  if (!d || d.length !== n * 2) {
    d = new Float64Array(n * 2);
    for (const [i, dx, dy] of v) {
      if (i >= 0 && i < n) {
        d[i * 2] += dx;
        d[i * 2 + 1] += dy;
      }
    }
    deformDense.set(v, d);
  }
  return d;
}

/** Number of weight influences of a mesh (the length of Spine's per-influence deform arrays, halved). */
export function influenceCount(att: MeshAttachment): number {
  return att.weights.reduce((s, w) => s + Math.max(1, w.length), 0);
}

const localDense = new WeakMap<object, Float64Array>();
/**
 * Spine-exact per-influence deform for a pose, when every key of the track carries it and it fits the mesh;
 * null otherwise (then the setup-space offsets are used).
 */
function localDeform(keys: DeformKey[], att: MeshAttachment, t: number): Float64Array | null {
  const size = influenceCount(att) * 2;
  if (!keys.every((k) => k.local && k.local.offset + k.local.values.length <= size)) return null;
  const dense = (k: DeformKey) => {
    let d = localDense.get(k.local!);
    if (!d || d.length !== size) {
      d = new Float64Array(size);
      d.set(k.local!.values, k.local!.offset);
      localDense.set(k.local!, d);
    }
    return d;
  };
  return sampleTrack(keys.map((k) => ({ ...k, v: dense(k) })), t, (a, b, f) => {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f;
    return out;
  }, true)!;
}

/**
 * Setup-space vertices of an attachment for a pose, before skinning (Live2D keyforms and deformers from parameters,
 * plus the animation's deform keys), and Spine-exact per-influence deform deltas when the track has them.
 */
export function poseDeform(model: Model, pose: Pose, attachmentId: string, att: MeshAttachment): { rest: Vec2[]; local: Float64Array | null } {
  const base = pose.params ? restVertices(model, attachmentId, att, pose.params) : att.vertices;
  if (pose.layers?.some((l) => model.animations?.[l.animation]?.deform?.[attachmentId]?.length)) {
    // sliders mix other animations' deform keys in: setup-space offsets, mixed from the current shape
    let rest = poseRestVertices(model, pose, attachmentId, att, base);
    for (const l of pose.layers) {
      const keys = model.animations?.[l.animation]?.deform?.[attachmentId];
      if (!keys?.length) continue;
      const d = sampleTrack(keys.map((k) => ({ ...k, v: denseDeform(k.v, att.vertices.length) })), l.time, (a, b, f) => {
        const out = new Float64Array(a.length);
        for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f;
        return out;
      }, spineCurves(model))!;
      rest = rest.map((v, i) => {
        const tx = l.additive ? v[0] + d[i * 2] : base[i][0] + d[i * 2];
        const ty = l.additive ? v[1] + d[i * 2 + 1] : base[i][1] + d[i * 2 + 1];
        return [v[0] + (tx - v[0]) * l.mix, v[1] + (ty - v[1]) * l.mix];
      });
    }
    return { rest, local: null };
  }
  const keys = pose.animation ? model.animations?.[pose.animation]?.deform?.[attachmentId] : undefined;
  if (!keys?.length) return { rest: base, local: null };
  const local = localDeform(keys, att, pose.time);
  if (local) return { rest: base, local };
  return { rest: poseRestVertices(model, pose, attachmentId, att, base), local: null };
}

/** Setup-space vertices of an attachment for a pose with the deform keys applied as setup-space offsets. */
export function poseRestVertices(model: Model, pose: Pose, attachmentId: string, att: MeshAttachment, base?: Vec2[]): Vec2[] {
  base ??= pose.params ? restVertices(model, attachmentId, att, pose.params) : att.vertices;
  const keys = pose.animation ? model.animations?.[pose.animation]?.deform?.[attachmentId] : undefined;
  if (!keys?.length) return base;
  const n = att.vertices.length;
  const d = sampleTrack(keys.map((k) => ({ ...k, v: denseDeform(k.v, n) })), pose.time, (a, b, f) => {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f;
    return out;
  }, spineCurves(model))!;
  return base.map((v, i) => [v[0] + d[i * 2], v[1] + d[i * 2 + 1]]);
}

/** A Spine bounding box shown by a slot, posed: world-space polygon (bones, deform keys). */
export interface PosedBoundingBox {
  slot: string;
  attachmentId: string;
  polygon: Vec2[];
  color?: string;
}

/** The bounding boxes the slots show in a pose (what a game's hit test would use), in draw order. */
export function boundingBoxPolygons(model: Model, pose: Pose, setup: Pose = computePose(model)): PosedBoundingBox[] {
  const out: PosedBoundingBox[] = [];
  if (!model.boundingBoxes) return out;
  for (const s of pose.slots) {
    const box = s.attachment ? model.boundingBoxes[s.attachment] : undefined;
    if (!box) continue;
    const att = box as unknown as MeshAttachment;
    const d = poseDeform(model, pose, s.attachment!, att);
    out.push({ slot: s.id, attachmentId: s.attachment!, polygon: deformMesh(att, setup, pose, s.bone, d.rest, d.local), ...(box.color ? { color: box.color } : {}) });
  }
  return out;
}

/** All visible meshes deformed for the pose, in draw order. */
export function drawList(model: Model, pose: Pose, setup: Pose = computePose(model)): DrawItem[] {
  const items: DrawItem[] = [];
  // Live2D meshes take their opacity, colors and draw order from the rig
  const values = model.live2d ? (pose.params ?? Object.fromEntries((model.parameters ?? []).map((p) => [p.id, p.default]))) : undefined;
  const frame = model.live2d && values ? live2dFrame(model, values) : undefined;
  const partAlpha = frame ? partOpacities(model.live2d!, pose.parts) : undefined;
  // Spine clipping: a clipping attachment clips the slots after it up to its end slot (one at a time, like Spine)
  let clipping: { polygon: Vec2[]; end?: string; inverse?: boolean } | null = null;
  const endClip = (slot: string) => {
    if (clipping && clipping.end === slot) clipping = null;
  };
  for (const s of pose.slots) {
    const clip = s.attachment ? model.clippings?.[s.attachment] : undefined;
    if (clip) {
      if (!clipping) {
        const d = poseDeform(model, pose, s.attachment!, clip as unknown as MeshAttachment);
        let polygon = deformMesh(clip as unknown as MeshAttachment, setup, pose, s.bone, d.rest, d.local);
        if (clip.convex || clip.inverse) polygon = convexHull(polygon);
        clipping = { polygon, ...(clip.end ? { end: clip.end } : {}), ...(clip.inverse ? { inverse: true } : {}) };
      }
      continue;
    }
    const att = s.attachment ? model.attachments[s.attachment] : undefined;
    if (!att || att.type !== "mesh") {
      endClip(s.id);
      continue;
    }
    const base = parseColor(att.color ?? (att.image ? "#ffffff" : "#888888"));
    const l2 = frame && att.live2d ? frame.meshes.get(s.attachment!) : undefined;
    if (frame && att.live2d && (!l2 || !l2.enabled)) continue;
    if (l2) {
      const a = l2.opacity * (l2.part ? (partAlpha!.get(l2.part) ?? 1) : 1);
      base[0] *= l2.multiply[0];
      base[1] *= l2.multiply[1];
      base[2] *= l2.multiply[2];
      base[3] *= a;
    }
    items.push({
      slot: s.id,
      attachmentId: s.attachment!,
      attachment: att,
      positions: (() => {
        const d = poseDeform(model, pose, s.attachment!, att);
        return deformMesh(att, setup, pose, s.bone, d.rest, d.local);
      })(),
      color: [base[0] * s.color[0], base[1] * s.color[1], base[2] * s.color[2], base[3] * s.color[3]],
      blend: s.blend,
      ...(s.clip ? { clip: Array.isArray(s.clip) ? s.clip : [s.clip] } : {}),
      ...(s.clip && s.clipInvert ? { clipInvert: true } : {}),
      ...(l2 && (l2.screen[0] || l2.screen[1] || l2.screen[2]) ? { screen: l2.screen } : {}),
      ...(s.cull ? { cull: true } : {}),
      ...(s.dark ? { dark: s.dark } : {}),
      ...(clipping ? { clipPolygon: (clipping as { polygon: Vec2[] }).polygon, ...((clipping as { inverse?: boolean }).inverse ? { clipOutside: true } : {}) } : {}),
    });
    endClip(s.id);
  }
  if (frame) {
    // Live2D items take the rig's draw order among the places they occupy
    const rank = new Map(frame.order.map((id, i) => [id, i]));
    const places: number[] = [];
    const live: DrawItem[] = [];
    items.forEach((it, i) => {
      if (rank.has(it.attachmentId)) {
        places.push(i);
        live.push(it);
      }
    });
    live.sort((a, b) => rank.get(a.attachmentId)! - rank.get(b.attachmentId)!);
    places.forEach((p, i) => (items[p] = live[i]));
  }
  return items;
}

/** Convex hull of a polygon (monotone chain), counter-clockwise. */
function convexHull(points: Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function extendBounds(b: Bounds, p: Vec2): void {
  if (p[0] < b.minX) b.minX = p[0];
  if (p[1] < b.minY) b.minY = p[1];
  if (p[0] > b.maxX) b.maxX = p[0];
  if (p[1] > b.maxY) b.maxY = p[1];
}

export function poseBounds(items: DrawItem[], pose: Pose, includeBones = true, into: Bounds = emptyBounds()): Bounds {
  for (const it of items) for (const p of it.positions) extendBounds(into, p);
  if (includeBones) {
    for (const b of pose.bones) {
      const e = boneEnds(b);
      extendBounds(into, e.start);
      extendBounds(into, e.end);
    }
  }
  return into;
}
