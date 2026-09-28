// Spine skeleton update, by the rules of the Spine 4.3 runtime: bone inherit modes and the IK, transform, path,
// physics and slider constraints, updated in Spine's order (each constraint after the bones it reads, the bones it
// changes updated again after it). computePose uses it for models that need it (see needsSpineUpdate); models
// without Spine-only features keep the plain FK + IK path. The math follows the runtime step for step so imported
// Spine data poses the same (checked against the official runtime by work/tools/spine-rt-compare.ts).
import { localTime, sampleTrack } from "./animation.ts";
import type {
  Bone,
  IkConstraint,
  Inherit,
  Model,
  PathAttachment,
  PathConstraint,
  Slider,
  SpinePhysics,
  SpinePhysicsSetting,
  TransformConstraint,
  TransformProperty,
  Vec2,
} from "./types.ts";

// the runtime's float constants (degRad is derived from PI = 3.1415927, not Math.PI)
const PI = 3.1415927;
const PI2 = PI * 2;
const INV_PI2 = 1 / PI2;
const DEG_RAD = PI / 180;
const RAD_DEG = 180 / PI;
const EPS = 0.00001;
const EPS2 = EPS * EPS;
const atan2Deg = (y: number, x: number) => Math.atan2(y, x) * RAD_DEG;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** A bone during the update: local pose, world transform (a b / c d, world x y) and Spine's lazy-update marks. */
export interface SpineBone {
  id: string;
  index: number;
  parent: SpineBone | null;
  children: SpineBone[];
  length: number;
  skinRequired: boolean;
  active: boolean;
  sorted: boolean;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  inherit: Inherit;
  a: number;
  b: number;
  c: number;
  d: number;
  worldX: number;
  worldY: number;
  /** Update number the world transform is current for. */
  world: number;
  /** Update number at which the world transform was changed directly (the local pose must be recomputed). */
  local: number;
}

/** Simulation state of one physics constraint (kept between frames by the caller, see SpineState). */
interface PhysicsState {
  reset: boolean;
  ux: number;
  uy: number;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  xOffset: number;
  xLag: number;
  xVelocity: number;
  yOffset: number;
  yLag: number;
  yVelocity: number;
  rotateOffset: number;
  rotateLag: number;
  rotateVelocity: number;
  scaleOffset: number;
  scaleLag: number;
  scaleVelocity: number;
  remaining: number;
  lastTime: number;
}

/**
 * State that lives between frames: physics simulation and the skeleton clock. `time` is advanced by the caller
 * (seconds); `resets` are physics constraint ids (or "" for all) to restart before the next update.
 */
export class SpineState {
  time = 0;
  /** Animation time of the last update, for physics reset keys crossed since (-1: none yet). */
  animTime = -1;
  /**
   * Clock at the last update. Spine applies reset keys with the animation, before advancing its clock: a reset
   * restarts from this time, so the first step after it covers the whole frame.
   */
  updatedAt = 0;
  readonly physics = new Map<string, PhysicsState>();
  resets: string[] = [];
  /** Clock when the state was made: a constraint that first runs later (its mix was 0) has waited since then. */
  readonly origin: number;
  constructor(time = 0) {
    this.time = time;
    this.updatedAt = time;
    this.origin = time;
  }
  physicsFor(id: string): PhysicsState {
    let s = this.physics.get(id);
    if (!s) {
      s = newPhysicsState(this.origin);
      this.physics.set(id, s);
    }
    return s;
  }
}

function newPhysicsState(time: number): PhysicsState {
  return {
    reset: true,
    ux: 0,
    uy: 0,
    cx: 0,
    cy: 0,
    tx: 0,
    ty: 0,
    xOffset: 0,
    xLag: 0,
    xVelocity: 0,
    yOffset: 0,
    yLag: 0,
    yVelocity: 0,
    rotateOffset: 0,
    rotateLag: 0,
    rotateVelocity: 0,
    scaleOffset: 0,
    scaleLag: 0,
    scaleVelocity: 0,
    remaining: 0,
    lastTime: time,
  };
}

/**
 * True when a model is posed by the Spine update: Spine models always (so the setup pose, the skinning bind
 * pose, uses the same float math as every other pose), other non-Live2D models when they use Spine-only features.
 */
export function needsSpineUpdate(model: Model): boolean {
  if (model.live2d) return false;
  if (model.target === "spine") return true;
  if (model.transforms?.length || model.paths?.length || model.spinePhysics?.length || model.sliders?.length) return true;
  if (model.ik?.some((c) => c.softness || c.compress || c.stretch || c.skin)) return true;
  for (const b of model.bones) if ((b.inherit && b.inherit !== "normal") || b.skin) return true;
  for (const a of Object.values(model.animations ?? {})) for (const tl of Object.values(a.bones ?? {})) if (tl.inherit?.length) return true;
  return false;
}

// ---------- bone pose (BonePose)

/** The runtime's per-update counter and skeleton transform (Awaken2D poses at the origin, unscaled, +y up). */
export interface SpineSkeleton {
  bones: SpineBone[];
  byId: Map<string, SpineBone>;
  update: number;
  scaleX: number;
  scaleY: number;
  x: number;
  y: number;
}

export function updateWorldTransform(sk: SpineSkeleton, bone: SpineBone): void {
  if (bone.local === sk.update) updateLocalTransform(sk, bone);
  else bone.world = sk.update;
  const { rotation, scaleX, scaleY, shearX, shearY } = bone;
  if (!bone.parent) {
    const sx = sk.scaleX;
    const sy = sk.scaleY;
    const rx = (rotation + shearX) * DEG_RAD;
    const ry = (rotation + 90 + shearY) * DEG_RAD;
    bone.a = Math.cos(rx) * scaleX * sx;
    bone.b = Math.cos(ry) * scaleY * sx;
    bone.c = Math.sin(rx) * scaleX * sy;
    bone.d = Math.sin(ry) * scaleY * sy;
    bone.worldX = bone.x * sx + sk.x;
    bone.worldY = bone.y * sy + sk.y;
    return;
  }
  const parent = bone.parent;
  let pa = parent.a;
  let pb = parent.b;
  let pc = parent.c;
  let pd = parent.d;
  bone.worldX = pa * bone.x + pb * bone.y + parent.worldX;
  bone.worldY = pc * bone.x + pd * bone.y + parent.worldY;
  switch (bone.inherit) {
    case "normal": {
      const rx = (rotation + shearX) * DEG_RAD;
      const ry = (rotation + 90 + shearY) * DEG_RAD;
      const la = Math.cos(rx) * scaleX;
      const lb = Math.cos(ry) * scaleY;
      const lc = Math.sin(rx) * scaleX;
      const ld = Math.sin(ry) * scaleY;
      bone.a = pa * la + pb * lc;
      bone.b = pa * lb + pb * ld;
      bone.c = pc * la + pd * lc;
      bone.d = pc * lb + pd * ld;
      return;
    }
    case "onlyTranslation": {
      const sx = sk.scaleX;
      const sy = sk.scaleY;
      const rx = (rotation + shearX) * DEG_RAD;
      const ry = (rotation + 90 + shearY) * DEG_RAD;
      bone.a = Math.cos(rx) * scaleX * sx;
      bone.b = Math.cos(ry) * scaleY * sx;
      bone.c = Math.sin(rx) * scaleX * sy;
      bone.d = Math.sin(ry) * scaleY * sy;
      break;
    }
    case "noRotationOrReflection": {
      const sx = sk.scaleX;
      const sy = sk.scaleY;
      const sxi = 1 / sx;
      const syi = 1 / sy;
      pa *= sxi;
      pc *= syi;
      let s = pa * pa + pc * pc;
      let r = 0;
      if (s > EPS2) {
        s = Math.abs(pa * pd * syi - pb * sxi * pc) / s;
        pb = pc * s;
        pd = pa * s;
        r = rotation - atan2Deg(pc, pa);
      } else {
        pa = 0;
        pc = 0;
        r = rotation - 90 + atan2Deg(pd, pb);
      }
      const rx = (r + shearX) * DEG_RAD;
      const ry = (r + shearY + 90) * DEG_RAD;
      const la = Math.cos(rx) * scaleX;
      const lb = Math.cos(ry) * scaleY;
      const lc = Math.sin(rx) * scaleX;
      const ld = Math.sin(ry) * scaleY;
      bone.a = (pa * la - pb * lc) * sx;
      bone.b = (pa * lb - pb * ld) * sx;
      bone.c = (pc * la + pd * lc) * sy;
      bone.d = (pc * lb + pd * ld) * sy;
      break;
    }
    case "noScale":
    case "noScaleOrReflection": {
      const sx = sk.scaleX;
      const sy = sk.scaleY;
      const sxi = 1 / sx;
      const syi = 1 / sy;
      const r = rotation * DEG_RAD;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      let za = (pa * cos + pb * sin) * sxi;
      let zc = (pc * cos + pd * sin) * syi;
      const s = 1 / Math.sqrt(za * za + zc * zc);
      za *= s;
      zc *= s;
      let zb = -zc;
      let zd = za;
      if (bone.inherit === "noScale" && pa * pd - pb * pc < 0 !== (sx < 0 !== sy < 0)) {
        zb = -zb;
        zd = -zd;
      }
      const rx = shearX * DEG_RAD;
      const ry = (90 + shearY) * DEG_RAD;
      const la = Math.cos(rx) * scaleX;
      const lb = Math.cos(ry) * scaleY;
      const lc = Math.sin(rx) * scaleX;
      const ld = Math.sin(ry) * scaleY;
      bone.a = (za * la + zb * lc) * sx;
      bone.b = (za * lb + zb * ld) * sx;
      bone.c = (zc * la + zd * lc) * sy;
      bone.d = (zc * lb + zd * ld) * sy;
      break;
    }
  }
}

/** Recomputes the local pose from the world transform (after a constraint changed the world transform). */
export function updateLocalTransform(sk: SpineSkeleton, bone: SpineBone): void {
  bone.local = 0;
  bone.world = sk.update;
  const sx = sk.scaleX;
  const sy = sk.scaleY;
  if (!bone.parent) {
    const sxi = 1 / sx;
    const syi = 1 / sy;
    bone.x = (bone.worldX - sk.x) * sxi;
    bone.y = (bone.worldY - sk.y) * syi;
    set5(bone, bone.a * sxi, bone.b * sxi, bone.c * syi, bone.d * syi, 0);
    return;
  }
  const parent = bone.parent;
  let pa = parent.a;
  const pb = parent.b;
  let pc = parent.c;
  const pd = parent.d;
  const pad = pa * pd - pb * pc;
  const pid = 1 / (pa * pd - pb * pc);
  const ia = pd * pid;
  const ib = pb * pid;
  const ic = pc * pid;
  const id = pa * pid;
  const dx = bone.worldX - parent.worldX;
  const dy = bone.worldY - parent.worldY;
  bone.x = dx * ia - dy * ib;
  bone.y = dy * id - dx * ic;
  switch (bone.inherit) {
    case "normal":
      set5(bone, ia * bone.a - ib * bone.c, ia * bone.b - ib * bone.d, id * bone.c - ic * bone.a, id * bone.d - ic * bone.b, 0);
      break;
    case "onlyTranslation": {
      const sxi = 1 / sx;
      const syi = 1 / sy;
      set5(bone, bone.a * sxi, bone.b * sxi, bone.c * syi, bone.d * syi, 0);
      break;
    }
    case "noRotationOrReflection": {
      const sxi = 1 / sx;
      const syi = 1 / sy;
      pa *= sxi;
      pc *= syi;
      const wa = bone.a * sxi;
      const wb = bone.b * sxi;
      const wc = bone.c * syi;
      const wd = bone.d * syi;
      const s = 1 / (pa * pa + pc * pc);
      const det = 1 / Math.abs(pad * sxi * syi);
      set5(bone, (pa * wa + pc * wc) * s, (pa * wb + pc * wd) * s, (pa * wc - pc * wa) * det, (pa * wd - pc * wb) * det, atan2Deg(pc, pa));
      break;
    }
    case "noScale":
    case "noScaleOrReflection": {
      const sxi = 1 / sx;
      const syi = 1 / sy;
      const wa = bone.a * sxi;
      const wb = bone.b * sxi;
      const wc = bone.c * syi;
      const wd = bone.d * syi;
      let tx = pd * bone.a - pb * bone.c;
      let ty = pa * bone.c - pc * bone.a;
      if (pad < 0) {
        tx = -tx;
        ty = -ty;
      }
      let r = atan2Deg(ty, tx);
      bone.rotation = r;
      r *= DEG_RAD;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      let za = (pa * cos + pb * sin) * sxi;
      let zc = (pc * cos + pd * sin) * syi;
      const s = 1 / Math.sqrt(za * za + zc * zc);
      za *= s;
      zc *= s;
      const si = bone.inherit === "noScale" && pad < 0 !== (sx < 0 !== sy < 0) ? -1 : 1;
      set4(bone, za * wa + zc * wc, za * wb + zc * wd, (za * wc - zc * wa) * si, (za * wd - zc * wb) * si);
    }
  }
}

function set4(bone: SpineBone, ra: number, rb: number, rc: number, rd: number): void {
  const x = ra * ra + rc * rc;
  const y = rb * rb + rd * rd;
  if (x > EPS2) {
    bone.shearX = atan2Deg(rc, ra);
    bone.scaleX = Math.sqrt(x);
  } else {
    bone.shearX = 0;
    bone.scaleX = 0;
  }
  bone.scaleY = Math.sqrt(y);
  if (y > EPS2) {
    bone.shearY = atan2Deg(rd, rb);
    if (ra * rd - rb * rc < 0) {
      bone.scaleY = -bone.scaleY;
      bone.shearY += 90;
    } else bone.shearY -= 90;
    if (bone.shearY > 180) bone.shearY -= 360;
    else if (bone.shearY <= -180) bone.shearY += 360;
  } else bone.shearY = 0;
}

function set5(bone: SpineBone, ra: number, rb: number, rc: number, rd: number, ro: number): void {
  bone.shearX = 0;
  const x = ra * ra + rc * rc;
  const y = rb * rb + rd * rd;
  if (x > EPS2) {
    const r = atan2Deg(rc, ra);
    bone.rotation = r + ro;
    bone.scaleX = Math.sqrt(x);
    bone.scaleY = Math.sqrt(y);
    if (y > EPS2) {
      bone.shearY = atan2Deg(rd, rb);
      if (ra * rd - rb * rc < 0) {
        bone.scaleY = -bone.scaleY;
        bone.shearY += 90 - r;
      } else bone.shearY -= 90 + r;
      if (bone.shearY > 180) bone.shearY -= 360;
      else if (bone.shearY <= -180) bone.shearY += 360;
    } else bone.shearY = 0;
  } else {
    bone.scaleX = 0;
    bone.scaleY = Math.sqrt(y);
    bone.shearY = 0;
    bone.rotation = y > EPS2 ? atan2Deg(rd, rb) - 90 + ro : ro;
  }
}

function validateLocalTransform(sk: SpineSkeleton, bone: SpineBone): void {
  if (bone.local === sk.update) updateLocalTransform(sk, bone);
}

/** A constraint changes the local pose: the world transforms below it are recomputed later. */
function modifyLocal(sk: SpineSkeleton, bone: SpineBone): void {
  if (bone.local === sk.update) updateLocalTransform(sk, bone);
  bone.world = 0;
  resetWorld(sk, bone, sk.update);
}

/** A constraint changes the world transform directly. */
function modifyWorld(sk: SpineSkeleton, bone: SpineBone): void {
  const update = sk.update;
  bone.local = update;
  bone.world = update;
  resetWorld(sk, bone, update);
}

function resetWorld(sk: SpineSkeleton, bone: SpineBone, update: number): void {
  for (const child of bone.children) {
    if (child.world === update) {
      if (child.local === update) updateLocalTransform(sk, child);
      child.world = 0;
      resetWorld(sk, child, update);
    }
  }
}

const worldScaleX = (b: SpineBone) => Math.sqrt(b.a * b.a + b.c * b.c);

// ---------- constraint poses (the values timelines change)

type Constraint =
  | { kind: "ik"; data: IkConstraint; bones: SpineBone[]; target: SpineBone; mix: number; softness: number; bend: number; compress: boolean; stretch: boolean }
  | { kind: "transform"; data: TransformConstraint; bones: SpineBone[]; source: SpineBone; mix: Record<TransformProperty, number> }
  | { kind: "path"; data: PathConstraint; bones: SpineBone[]; position: number; spacing: number; mixRotate: number; mixX: number; mixY: number }
  | {
      kind: "physics";
      data: SpinePhysics;
      bone: SpineBone;
      inertia: number;
      strength: number;
      damping: number;
      massInverse: number;
      wind: number;
      gravity: number;
      mix: number;
    }
  | { kind: "slider"; data: Slider; bone: SpineBone | null; time: number; mix: number };

type CacheItem = SpineBone | Constraint;

/** What the update needs from the caller besides the model: time, physics and how to pose a slider's animation. */
export interface SpineUpdateInput {
  model: Model;
  /** Local bone poses (animation, parameters) by id; bones not listed use their setup pose. */
  locals: Map<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number; shearX: number; shearY: number; inherit: Inherit }>;
  /** Animation time (local, seconds) for the constraint timelines, or null for the setup pose. */
  animation: string | null;
  time: number;
  /** Apply constraints (off: bones only, with their inherit modes). */
  constraints: boolean;
  /** Physics state; without it physics constraints do nothing. */
  state?: SpineState;
  /** "update" steps the simulation to state.time; "pose" only applies the current state. */
  physics?: "update" | "pose";
  /** World vertices of a path attachment for the current bones (with deform), or null when the slot shows no path. */
  pathVertices: (slot: string, sk: SpineSkeleton) => { att: PathAttachment; world: Vec2[] } | null;
  /** Poses a slider's animation onto the bones (mixed from their current local pose). */
  applySlider: (sk: SpineSkeleton, slider: Slider, time: number, mix: number) => void;
}

/** Result: the bones after the update, and which are inactive (skin bones not in the active skin). */
export interface SpineUpdateResult {
  sk: SpineSkeleton;
  inactive: Set<string>;
}

/** Constraint evaluation order: model.constraintOrder first, then the rest (IK, transforms, paths, physics, sliders). */
export function constraintList(model: Model): Array<{ kind: Constraint["kind"]; id: string }> {
  const all: Array<{ kind: Constraint["kind"]; id: string }> = [
    ...(model.ik ?? []).map((c) => ({ kind: "ik" as const, id: c.id })),
    ...(model.transforms ?? []).map((c) => ({ kind: "transform" as const, id: c.id })),
    ...(model.paths ?? []).map((c) => ({ kind: "path" as const, id: c.id })),
    ...(model.spinePhysics ?? []).map((c) => ({ kind: "physics" as const, id: c.id })),
    ...(model.sliders ?? []).map((c) => ({ kind: "slider" as const, id: c.id })),
  ];
  if (!model.constraintOrder?.length) return all;
  const rank = new Map(model.constraintOrder.map((key, i) => [key, i]));
  return all
    .map((c, i) => ({ c, r: rank.get(`${c.kind}:${c.id}`) ?? model.constraintOrder!.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c);
}

/** Current value of a constraint timeline channel (setup value without keys). */
function channel(keys: { t: number; v: number }[] | undefined, t: number, setup: number): number {
  return sampleTrack(keys, t, (a, b, f) => a + (b - a) * f, true) ?? setup;
}

export function spineUpdate(input: SpineUpdateInput): SpineUpdateResult {
  const { model } = input;
  const anim = input.animation ? model.animations?.[input.animation] : undefined;
  const t = input.time;
  const sk: SpineSkeleton = { bones: [], byId: new Map(), update: 1, scaleX: 1, scaleY: 1, x: 0, y: 0 };
  // bones in the model's order (Spine's bone list order: parents first)
  const src = new Map<string, Bone>(model.bones.map((b) => [b.id, b]));
  for (const id of parentFirst(model)) {
    const b = src.get(id)!;
    const l = input.locals.get(id);
    const bone: SpineBone = {
      id,
      index: sk.bones.length,
      parent: b.parent !== null ? sk.byId.get(b.parent)! : null,
      children: [],
      length: b.length,
      skinRequired: !!b.skin,
      active: true,
      sorted: false,
      x: l?.x ?? b.x,
      y: l?.y ?? b.y,
      rotation: l?.rotation ?? b.rotation,
      scaleX: l?.scaleX ?? b.scaleX,
      scaleY: l?.scaleY ?? b.scaleY,
      shearX: l?.shearX ?? b.shearX ?? 0,
      shearY: l?.shearY ?? b.shearY ?? 0,
      inherit: l?.inherit ?? b.inherit ?? "normal",
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      worldX: 0,
      worldY: 0,
      world: 0,
      local: 0,
    };
    bone.parent?.children.push(bone);
    sk.bones.push(bone);
    sk.byId.set(id, bone);
  }

  // ---- update cache (Skeleton.updateCache)
  const cache: CacheItem[] = [];
  for (const bone of sk.bones) {
    bone.sorted = bone.skinRequired;
    bone.active = !bone.sorted;
  }
  const skin = model.skin ? model.skins?.[model.skin] : undefined;
  for (const id of skin?.bones ?? []) {
    let bone = sk.byId.get(id) ?? null;
    while (bone) {
      bone.sorted = false;
      bone.active = true;
      bone = bone.parent;
    }
  }
  const sortBone = (bone: SpineBone) => {
    if (bone.sorted || !bone.active) return;
    if (bone.parent) sortBone(bone.parent);
    bone.sorted = true;
    cache.push(bone);
  };
  const sortReset = (bones: SpineBone[]) => {
    for (const bone of bones) {
      if (!bone.active) continue;
      if (bone.sorted) sortReset(bone.children);
      bone.sorted = false;
    }
  };
  const inSkin = (key: string, required: boolean | undefined) => !required || !!skin?.constraints?.includes(key);
  if (input.constraints) {
    for (const { kind, id } of constraintList(model)) {
      const c = makeConstraint(model, sk, kind, id, anim, t);
      if (!c) continue;
      if (!inSkin(`${kind}:${id}`, c.data.skin) || !sourceActive(model, sk, c)) continue;
      sortConstraint(model, sk, c, cache, sortBone, sortReset);
    }
  }
  for (const bone of sk.bones) sortBone(bone);

  // ---- update (Skeleton.updateWorldTransform)
  const state = input.state;
  if (state && input.physics === "update") {
    // physics reset keys crossed since the last update (> last time, <= time; wrapping when the time went back)
    const last = state.animTime;
    for (const [id, tl] of Object.entries(anim?.spinePhysics ?? {})) {
      const crossed = (tl.reset ?? []).some((rt) => (t >= last ? rt > last && rt <= t : rt > last || rt <= t));
      if (crossed) state.resets.push(id);
    }
    state.animTime = t;
  }
  if (state?.resets.length) {
    for (const id of state.resets) {
      if (id === "") for (const s of state.physics.values()) resetPhysics(s, state.updatedAt);
      else if (state.physics.has(id)) resetPhysics(state.physics.get(id)!, state.updatedAt);
    }
    state.resets = [];
  }
  if (state && input.physics === "update") state.updatedAt = state.time;
  for (const item of cache) {
    if ("kind" in item) updateConstraint(sk, item, input);
    else if (item.world !== sk.update) updateWorldTransform(sk, item);
  }
  // inactive bones were not updated: give them their plain world transform so tools and bounds stay sane
  const inactive = new Set<string>();
  for (const bone of sk.bones) {
    if (!bone.active) {
      inactive.add(bone.id);
      updateWorldTransform(sk, bone);
    }
    validateLocalTransform(sk, bone);
  }
  return { sk, inactive };
}

function parentFirst(model: Model): string[] {
  const byId = new Map(model.bones.map((b) => [b.id, b]));
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const b = byId.get(id);
    if (!b) throw new Error(`unknown bone "${id}"`);
    seen.add(id);
    if (b.parent !== null) visit(b.parent);
    out.push(id);
  };
  for (const b of model.bones) visit(b.id);
  return out;
}

function makeConstraint(model: Model, sk: SpineSkeleton, kind: Constraint["kind"], id: string, anim: Model["animations"] extends infer _ ? NonNullable<Model["animations"]>[string] | undefined : never, t: number): Constraint | null {
  const bone = (name: string) => {
    const b = sk.byId.get(name);
    if (!b) throw new Error(`constraint "${id}": unknown bone "${name}"`);
    return b;
  };
  switch (kind) {
    case "ik": {
      const data = model.ik!.find((c) => c.id === id)!;
      const tl = anim?.ik?.[id];
      return {
        kind,
        data,
        bones: data.bones.map(bone),
        target: bone(data.target),
        mix: channel(tl?.mix, t, data.mix),
        softness: channel(tl?.softness, t, data.softness ?? 0),
        bend: (sampleTrack(tl?.bendPositive, t, (a) => a) ?? data.bendPositive) ? 1 : -1,
        compress: sampleTrack(tl?.compress, t, (a) => a) ?? !!data.compress,
        stretch: sampleTrack(tl?.stretch, t, (a) => a) ?? !!data.stretch,
      };
    }
    case "transform": {
      const data = model.transforms!.find((c) => c.id === id)!;
      const tl = anim?.transforms?.[id];
      const mix = {} as Record<TransformProperty, number>;
      for (const p of ["rotate", "x", "y", "scaleX", "scaleY", "shearY"] as const) mix[p] = channel(tl?.[p], t, data.mix[p] ?? 0);
      return { kind, data, bones: data.bones.map(bone), source: bone(data.source), mix };
    }
    case "path": {
      const data = model.paths!.find((c) => c.id === id)!;
      const tl = anim?.paths?.[id];
      return {
        kind,
        data,
        bones: data.bones.map(bone),
        position: channel(tl?.position, t, data.position),
        spacing: channel(tl?.spacing, t, data.spacing),
        mixRotate: channel(tl?.rotate, t, data.mix.rotate),
        mixX: channel(tl?.x, t, data.mix.x),
        mixY: channel(tl?.y, t, data.mix.y),
      };
    }
    case "physics": {
      const data = model.spinePhysics!.find((c) => c.id === id)!;
      const own = anim?.spinePhysics?.[id];
      const all = anim?.spinePhysics?.[""];
      const value = (k: SpinePhysicsSetting, setup: number) => {
        let v = channel(own?.[k], t, setup);
        if (all?.[k]?.length && data.global?.includes(k)) v = channel(all[k], t, v);
        return v;
      };
      return {
        kind,
        data,
        bone: bone(data.bone),
        inertia: value("inertia", data.inertia),
        strength: value("strength", data.strength),
        damping: value("damping", data.damping),
        massInverse: 1 / value("mass", data.mass),
        wind: value("wind", data.wind),
        gravity: value("gravity", data.gravity),
        mix: value("mix", data.mix),
      };
    }
    case "slider": {
      const data = model.sliders!.find((c) => c.id === id)!;
      if (!model.animations?.[data.animation]) return null;
      const tl = anim?.sliders?.[id];
      return { kind, data, bone: data.bone ? bone(data.bone) : null, time: channel(tl?.time, t, data.time), mix: channel(tl?.mix, t, data.mix) };
    }
  }
}

function sourceActive(model: Model, sk: SpineSkeleton, c: Constraint): boolean {
  switch (c.kind) {
    case "ik":
      return c.target.active;
    case "transform":
      return c.source.active;
    case "path": {
      const slot = model.slots.find((s) => s.id === c.data.slot);
      return !!slot && sk.byId.get(slot.bone)!.active;
    }
    case "physics":
      return c.bone.active;
    case "slider":
      return true;
  }
}

/** The bones a slider's animation keys. */
function sliderBones(model: Model, s: Slider, sk: SpineSkeleton): SpineBone[] {
  return Object.keys(model.animations?.[s.animation]?.bones ?? {})
    .map((id) => sk.byId.get(id))
    .filter((b): b is SpineBone => !!b);
}

function sortConstraint(model: Model, sk: SpineSkeleton, c: Constraint, cache: CacheItem[], sortBone: (b: SpineBone) => void, sortReset: (b: SpineBone[]) => void): void {
  switch (c.kind) {
    case "ik": {
      sortBone(c.target);
      const parent = c.bones[0];
      sortBone(parent);
      cache.push(c);
      parent.sorted = false;
      sortReset(parent.children);
      return;
    }
    case "transform": {
      if (!c.data.localSource) sortBone(c.source);
      const worldTarget = !c.data.localTarget;
      if (worldTarget) for (const b of c.bones) sortBone(b);
      cache.push(c);
      for (const b of c.bones) sortReset(b.children);
      for (const b of c.bones) b.sorted = worldTarget;
      return;
    }
    case "path": {
      // the bones the path attachment is weighted to (in any skin) are needed first
      const slot = model.slots.find((s) => s.id === c.data.slot)!;
      const slotBone = sk.byId.get(slot.bone)!;
      const paths = pathAttachmentsOf(model, slot.id);
      if (!paths.length) sortBone(slotBone);
      for (const p of paths) {
        const weighted = p.weights.some((w) => w.length !== 1 || w[0][0] !== slot.bone);
        if (!weighted) sortBone(slotBone);
        else for (const w of p.weights) for (const [id] of w) if (sk.byId.has(id)) sortBone(sk.byId.get(id)!);
      }
      for (const b of c.bones) sortBone(b);
      cache.push(c);
      for (const b of c.bones) sortReset(b.children);
      for (const b of c.bones) b.sorted = true;
      return;
    }
    case "physics": {
      sortBone(c.bone);
      cache.push(c);
      sortReset(c.bone.children);
      return;
    }
    case "slider": {
      if (c.bone && !c.data.local) sortBone(c.bone);
      cache.push(c);
      for (const b of sliderBones(model, c.data, sk)) {
        b.sorted = false;
        sortReset(b.children);
      }
      return;
    }
  }
}

/** Path attachments a slot can show (the setup one, and every skin's). */
function pathAttachmentsOf(model: Model, slot: string): PathAttachment[] {
  const out = new Set<PathAttachment>();
  const s = model.slots.find((x) => x.id === slot);
  if (s?.attachment && model.pathAttachments?.[s.attachment]) out.add(model.pathAttachments[s.attachment]);
  for (const skin of Object.values(model.skins ?? {})) for (const id of Object.values(skin.attachments[slot] ?? {})) if (model.pathAttachments?.[id]) out.add(model.pathAttachments[id]);
  return [...out];
}

function updateConstraint(sk: SpineSkeleton, c: Constraint, input: SpineUpdateInput): void {
  switch (c.kind) {
    case "ik":
      return updateIk(sk, c);
    case "transform":
      return updateTransform(sk, c);
    case "path":
      return updatePath(sk, c, input);
    case "physics":
      return updatePhysics(sk, c, input);
    case "slider":
      return updateSlider(sk, c, input);
  }
}

// ---------- IK (IkConstraint)

function updateIk(sk: SpineSkeleton, c: Extract<Constraint, { kind: "ik" }>): void {
  if (c.mix === 0) return;
  const target = c.target;
  const scaleY = c.data.scaleY;
  if (c.bones.length === 1) ik1(sk, c.bones[0], target.worldX, target.worldY, c.compress, c.stretch, scaleY, c.mix);
  else if (c.bones.length === 2) ik2(sk, c.bones[0], c.bones[1], target.worldX, target.worldY, c.bend, c.stretch, scaleY, c.softness, c.mix);
}

function ik1(sk: SpineSkeleton, bone: SpineBone, targetX: number, targetY: number, compress: boolean, stretch: boolean, scaleYMode: "uniform" | "volume" | undefined, mix: number): void {
  modifyLocal(sk, bone);
  const p = bone.parent!;
  let pa = p.a;
  let pb = p.b;
  const pc = p.c;
  let pd = p.d;
  let rotationIK = -bone.shearX - bone.rotation;
  let tx = 0;
  let ty = 0;
  const general = () => {
    const x = targetX - p.worldX;
    const y = targetY - p.worldY;
    const d = pa * pd - pb * pc;
    if (Math.abs(d) <= EPS) {
      tx = 0;
      ty = 0;
    } else {
      tx = (x * pd - y * pb) / d - bone.x;
      ty = (y * pa - x * pc) / d - bone.y;
    }
  };
  switch (bone.inherit) {
    case "onlyTranslation":
      tx = (targetX - bone.worldX) * Math.sign(sk.scaleX);
      ty = (targetY - bone.worldY) * Math.sign(sk.scaleY);
      break;
    case "noRotationOrReflection": {
      const s = Math.abs(pa * pd - pb * pc) / Math.max(EPS, pa * pa + pc * pc);
      const sa = pa / sk.scaleX;
      const sc = pc / sk.scaleY;
      pb = -sc * s * sk.scaleX;
      pd = sa * s * sk.scaleY;
      rotationIK += atan2Deg(sc, sa);
      general();
      break;
    }
    default:
      general();
  }
  rotationIK += atan2Deg(ty, tx);
  if (bone.scaleX < 0) rotationIK += 180;
  if (rotationIK > 180) rotationIK -= 360;
  else if (rotationIK <= -180) rotationIK += 360;
  bone.rotation += rotationIK * mix;
  if (compress || stretch) {
    if (bone.inherit === "noScale" || bone.inherit === "noScaleOrReflection") {
      tx = targetX - bone.worldX;
      ty = targetY - bone.worldY;
    }
    const b = bone.length * bone.scaleX;
    if (b > EPS) {
      const dd = tx * tx + ty * ty;
      if ((compress && dd < b * b) || (stretch && dd > b * b)) {
        const s = (Math.sqrt(dd) / b - 1) * mix + 1;
        bone.scaleX *= s;
        if (scaleYMode === "uniform") bone.scaleY *= s;
        else if (scaleYMode === "volume") bone.scaleY /= s < 0.7 ? 0.25 + 0.642857 * s : s;
      }
    }
  }
}

function ik2(sk: SpineSkeleton, parent: SpineBone, child: SpineBone, targetX: number, targetY: number, bendDir: number, stretch: boolean, scaleYMode: "uniform" | "volume" | undefined, softness: number, mix: number): void {
  if (parent.inherit !== "normal" || child.inherit !== "normal") return;
  modifyLocal(sk, parent);
  modifyLocal(sk, child);
  const px = parent.x;
  const py = parent.y;
  let psx = parent.scaleX;
  let psy = parent.scaleY;
  let csx = child.scaleX;
  let os1 = 0;
  let os2 = 0;
  let s2 = 0;
  if (psx < 0) {
    psx = -psx;
    os1 = 180;
    s2 = -1;
  } else {
    os1 = 0;
    s2 = 1;
  }
  if (psy < 0) {
    psy = -psy;
    s2 = -s2;
  }
  if (csx < 0) {
    csx = -csx;
    os2 = 180;
  } else os2 = 0;
  let cwx = 0;
  let cwy = 0;
  let a = parent.a;
  let b = parent.b;
  let c = parent.c;
  let d = parent.d;
  const u = Math.abs(psx - psy) <= EPS;
  if (!u || stretch) {
    child.y = 0;
    cwx = a * child.x + parent.worldX;
    cwy = c * child.x + parent.worldY;
  } else {
    cwx = a * child.x + b * child.y + parent.worldX;
    cwy = c * child.x + d * child.y + parent.worldY;
  }
  const pp = parent.parent!;
  a = pp.a;
  b = pp.b;
  c = pp.c;
  d = pp.d;
  let id = a * d - b * c;
  let x = cwx - pp.worldX;
  let y = cwy - pp.worldY;
  id = Math.abs(id) <= EPS ? 0 : 1 / id;
  const dx = (x * d - y * b) * id - px;
  const dy = (y * a - x * c) * id - py;
  const l1 = Math.sqrt(dx * dx + dy * dy);
  let l2 = child.length * csx;
  let a1 = 0;
  let a2 = 0;
  if (l1 < EPS) {
    ik1(sk, parent, targetX, targetY, false, stretch, undefined, mix);
    child.rotation = 0;
    return;
  }
  x = targetX - pp.worldX;
  y = targetY - pp.worldY;
  let tx = (x * d - y * b) * id - px;
  let ty = (y * a - x * c) * id - py;
  let dd = tx * tx + ty * ty;
  if (softness !== 0) {
    softness *= psx * (csx + 1) * 0.5;
    const td = Math.sqrt(dd);
    const sd = td - l1 - l2 * psx + softness;
    if (sd > 0) {
      let p = Math.min(1, sd / (softness * 2)) - 1;
      p = (sd - softness * (1 - p * p)) / td;
      tx -= p * tx;
      ty -= p * ty;
      dd = tx * tx + ty * ty;
    }
  }
  outer: if (u) {
    l2 *= psx;
    let cos = (dd - l1 * l1 - l2 * l2) / (2 * l1 * l2);
    if (cos < -1) {
      cos = -1;
      a2 = Math.PI * bendDir;
    } else if (cos > 1) {
      cos = 1;
      a2 = 0;
      if (stretch) {
        a = (Math.sqrt(dd) / (l1 + l2) - 1) * mix + 1;
        parent.scaleX *= a;
        if (scaleYMode === "uniform") parent.scaleY *= a;
        else if (scaleYMode === "volume") parent.scaleY /= a < 0.7 ? 0.25 + 0.642857 * a : a;
      }
    } else a2 = Math.acos(cos) * bendDir;
    a = l1 + l2 * cos;
    b = l2 * Math.sin(a2);
    a1 = Math.atan2(ty * a - tx * b, tx * a + ty * b);
  } else {
    a = psx * l2;
    b = psy * l2;
    const aa = a * a;
    const bb = b * b;
    const ta = Math.atan2(ty, tx);
    c = bb * l1 * l1 + aa * dd - aa * bb;
    const c1 = -2 * bb * l1;
    const c2 = bb - aa;
    d = c1 * c1 - 4 * c2 * c;
    if (d >= 0) {
      let q = Math.sqrt(d);
      if (c1 < 0) q = -q;
      q = -(c1 + q) * 0.5;
      let r0 = q / c2;
      const r1 = c / q;
      const r = Math.abs(r0) < Math.abs(r1) ? r0 : r1;
      r0 = dd - r * r;
      if (r0 >= 0) {
        y = Math.sqrt(r0) * bendDir;
        a1 = ta - Math.atan2(y, r);
        a2 = Math.atan2(y / psy, (r - l1) / psx);
        break outer;
      }
    }
    let minAngle = PI;
    let minX = l1 - a;
    let minDist = minX * minX;
    let minY = 0;
    let maxAngle = 0;
    let maxX = l1 + a;
    let maxDist = maxX * maxX;
    let maxY = 0;
    c = (-a * l1) / (aa - bb);
    if (c >= -1 && c <= 1) {
      c = Math.acos(c);
      x = a * Math.cos(c) + l1;
      y = b * Math.sin(c);
      d = x * x + y * y;
      if (d < minDist) {
        minAngle = c;
        minDist = d;
        minX = x;
        minY = y;
      }
      if (d > maxDist) {
        maxAngle = c;
        maxDist = d;
        maxX = x;
        maxY = y;
      }
    }
    if (dd <= (minDist + maxDist) * 0.5) {
      a1 = ta - Math.atan2(minY * bendDir, minX);
      a2 = minAngle * bendDir;
    } else {
      a1 = ta - Math.atan2(maxY * bendDir, maxX);
      a2 = maxAngle * bendDir;
    }
  }
  const os = Math.atan2(child.y, child.x) * s2;
  a1 = (a1 - os) * RAD_DEG + os1 - parent.rotation;
  if (a1 > 180) a1 -= 360;
  else if (a1 <= -180) a1 += 360;
  parent.rotation += a1 * mix;
  a2 = ((a2 + os) * RAD_DEG - child.shearX) * s2 + os2 - child.rotation;
  if (a2 > 180) a2 -= 360;
  else if (a2 <= -180) a2 += 360;
  child.rotation += a2 * mix;
}

// ---------- transform constraints (TransformConstraint, TransformConstraintData)

function fromValue(sk: SpineSkeleton, prop: TransformProperty, source: SpineBone, local: boolean, off: Partial<Record<TransformProperty, number>>): number {
  const o = (p: TransformProperty) => off[p] ?? 0;
  switch (prop) {
    case "rotate": {
      if (local) return source.rotation + o("rotate");
      const sx = sk.scaleX;
      const sy = sk.scaleY;
      let value = Math.atan2(source.c / sy, source.a / sx) * RAD_DEG + ((source.a * source.d - source.b * source.c) * sx * sy > 0 ? o("rotate") : -o("rotate"));
      if (value < 0) value += 360;
      return value;
    }
    case "x":
      return local ? source.x + o("x") : (o("x") * source.a + o("y") * source.b + source.worldX) / sk.scaleX;
    case "y":
      return local ? source.y + o("y") : (o("x") * source.c + o("y") * source.d + source.worldY) / sk.scaleY;
    case "scaleX": {
      if (local) return source.scaleX + o("scaleX");
      const a = source.a / sk.scaleX;
      const c = source.c / sk.scaleY;
      return Math.sqrt(a * a + c * c) + o("scaleX");
    }
    case "scaleY": {
      if (local) return source.scaleY + o("scaleY");
      const b = source.b / sk.scaleX;
      const d = source.d / sk.scaleY;
      return Math.sqrt(b * b + d * d) + o("scaleY");
    }
    case "shearY": {
      if (local) return source.shearY + o("shearY");
      const ix = 1 / sk.scaleX;
      const iy = 1 / sk.scaleY;
      return (Math.atan2(source.d * iy, source.b * ix) - Math.atan2(source.c * iy, source.a * ix)) * RAD_DEG - 90 + o("shearY");
    }
  }
}

function toApply(sk: SpineSkeleton, prop: TransformProperty, mix: number, bone: SpineBone, value: number, local: boolean, additive: boolean): void {
  switch (prop) {
    case "rotate":
      if (local) bone.rotation += (additive ? value : value - bone.rotation) * mix;
      else {
        const sx = sk.scaleX;
        const sy = sk.scaleY;
        const ix = 1 / sx;
        const iy = 1 / sy;
        const a = bone.a * ix;
        const b = bone.b * ix;
        const c = bone.c * iy;
        const d = bone.d * iy;
        value *= DEG_RAD;
        if (!additive) value -= Math.atan2(c, a);
        if (value > PI) value -= PI2;
        else if (value < -PI) value += PI2;
        value *= mix;
        const cos = Math.cos(value);
        const sin = Math.sin(value);
        bone.a = (cos * a - sin * c) * sx;
        bone.b = (cos * b - sin * d) * sx;
        bone.c = (sin * a + cos * c) * sy;
        bone.d = (sin * b + cos * d) * sy;
      }
      return;
    case "x":
      if (local) bone.x += (additive ? value : value - bone.x) * mix;
      else {
        if (!additive) value -= bone.worldX / sk.scaleX;
        bone.worldX += value * mix * sk.scaleX;
      }
      return;
    case "y":
      if (local) bone.y += (additive ? value : value - bone.y) * mix;
      else {
        if (!additive) value -= bone.worldY / sk.scaleY;
        bone.worldY += value * mix * sk.scaleY;
      }
      return;
    case "scaleX":
      if (local) {
        if (additive) bone.scaleX *= 1 + (value - 1) * mix;
        else if (bone.scaleX !== 0) bone.scaleX += (value - bone.scaleX) * mix;
      } else if (additive) {
        const s = 1 + (value - 1) * mix;
        bone.a *= s;
        bone.c *= s;
      } else {
        const a = bone.a / sk.scaleX;
        const c = bone.c / sk.scaleY;
        let s = Math.sqrt(a * a + c * c);
        if (s !== 0) {
          s = 1 + ((value - s) * mix) / s;
          bone.a *= s;
          bone.c *= s;
        }
      }
      return;
    case "scaleY":
      if (local) {
        if (additive) bone.scaleY *= 1 + (value - 1) * mix;
        else if (bone.scaleY !== 0) bone.scaleY += (value - bone.scaleY) * mix;
      } else if (additive) {
        const s = 1 + (value - 1) * mix;
        bone.b *= s;
        bone.d *= s;
      } else {
        const b = bone.b / sk.scaleX;
        const d = bone.d / sk.scaleY;
        let s = Math.sqrt(b * b + d * d);
        if (s !== 0) {
          s = 1 + ((value - s) * mix) / s;
          bone.b *= s;
          bone.d *= s;
        }
      }
      return;
    case "shearY":
      if (local) {
        if (!additive) value -= bone.shearY;
        bone.shearY += value * mix;
      } else {
        const sx = sk.scaleX;
        const sy = sk.scaleY;
        const b = bone.b / sx;
        const d = bone.d / sy;
        const by = Math.atan2(d, b);
        value = (value + 90) * DEG_RAD;
        if (additive) value -= PI / 2;
        else {
          value -= by - Math.atan2(bone.c / sy, bone.a / sx);
          if (value > PI) value -= PI2;
          else if (value < -PI) value += PI2;
        }
        value = by + value * mix;
        const s = Math.sqrt(b * b + d * d);
        bone.b = Math.cos(value) * s * sx;
        bone.d = Math.sin(value) * s * sy;
      }
      return;
  }
}

function updateTransform(sk: SpineSkeleton, c: Extract<Constraint, { kind: "transform" }>): void {
  const mix = c.mix;
  if (mix.rotate === 0 && mix.x === 0 && mix.y === 0 && mix.scaleX === 0 && mix.scaleY === 0 && mix.shearY === 0) return;
  const data = c.data;
  const localSource = !!data.localSource;
  const localTarget = !!data.localTarget;
  const additive = !!data.additive;
  const offsets = data.offset ?? {};
  const source = c.source;
  if (localSource) validateLocalTransform(sk, source);
  for (const bone of c.bones) {
    if (localTarget) modifyLocal(sk, bone);
    else modifyWorld(sk, bone);
    for (const from of data.properties) {
      const value = fromValue(sk, from.from, source, localSource, offsets) - (from.offset ?? 0);
      for (const to of from.to) {
        const m = mix[to.property];
        if (m === 0) continue;
        const toOffset = to.offset ?? 0;
        const toMax = to.max ?? 1;
        let clamped = toOffset + value * (to.scale ?? 1);
        if (data.clamp) clamped = toOffset < toMax ? clamp(clamped, toOffset, toMax) : clamp(clamped, toMax, toOffset);
        toApply(sk, to.property, m, bone, clamped, localTarget, additive);
      }
    }
  }
}

// ---------- path constraints (PathConstraint)

function updatePath(sk: SpineSkeleton, c: Extract<Constraint, { kind: "path" }>, input: SpineUpdateInput): void {
  const path = input.pathVertices(c.data.slot, sk);
  if (!path) return;
  const { mixRotate, mixX, mixY } = c;
  if (mixRotate === 0 && mixX === 0 && mixY === 0) return;
  const data = c.data;
  const tangents = data.rotateMode === "tangent";
  const scale = data.rotateMode === "chainScale";
  const bones = c.bones;
  const boneCount = bones.length;
  const spacesCount = tangents ? boneCount : boneCount + 1;
  const spaces = new Array<number>(spacesCount).fill(0);
  const lengths: number[] = scale ? new Array<number>(boneCount).fill(0) : [];
  const spacing = c.spacing;
  switch (data.spacingMode) {
    case "percent":
      if (scale) {
        for (let i = 0, n = spacesCount - 1; i < n; i++) {
          const bone = bones[i];
          const x = bone.length * bone.a;
          const y = bone.length * bone.c;
          lengths[i] = Math.sqrt(x * x + y * y);
        }
      }
      for (let i = 1; i < spacesCount; i++) spaces[i] = spacing;
      break;
    case "proportional": {
      let sum = 0;
      for (let i = 0, n = spacesCount - 1; i < n; ) {
        const bone = bones[i];
        const setupLength = bone.length;
        if (setupLength < EPS) {
          if (scale) lengths[i] = 0;
          spaces[++i] = spacing;
        } else {
          const x = setupLength * bone.a;
          const y = setupLength * bone.c;
          const length = Math.sqrt(x * x + y * y);
          if (scale) lengths[i] = length;
          spaces[++i] = length;
          sum += length;
        }
      }
      if (sum > 0) {
        sum = (spacesCount / sum) * spacing;
        for (let i = 1; i < spacesCount; i++) spaces[i] *= sum;
      }
      break;
    }
    default: {
      const lengthSpacing = data.spacingMode === "length";
      for (let i = 0, n = spacesCount - 1; i < n; ) {
        const bone = bones[i];
        const setupLength = bone.length;
        if (setupLength < EPS) {
          if (scale) lengths[i] = 0;
          spaces[++i] = spacing;
        } else {
          const x = setupLength * bone.a;
          const y = setupLength * bone.c;
          const length = Math.sqrt(x * x + y * y);
          if (scale) lengths[i] = length;
          spaces[++i] = ((lengthSpacing ? Math.max(0, setupLength + spacing) : spacing) * length) / setupLength;
        }
      }
    }
  }
  const positions = pathPositions(c, path.att, path.world, spaces, spacesCount, tangents);
  let boneX = positions[0];
  let boneY = positions[1];
  let offsetRotation = data.rotation ?? 0;
  let tip = false;
  if (offsetRotation === 0) tip = data.rotateMode === "chain";
  else {
    tip = false;
    const slot = input.model.slots.find((s) => s.id === data.slot)!;
    const bone = sk.byId.get(slot.bone)!;
    offsetRotation *= bone.a * bone.d - bone.b * bone.c > 0 ? DEG_RAD : -DEG_RAD;
  }
  for (let i = 0, ip = 3; i < boneCount; i++, ip += 3) {
    const bone = bones[i];
    modifyWorld(sk, bone);
    bone.worldX += (boneX - bone.worldX) * mixX;
    bone.worldY += (boneY - bone.worldY) * mixY;
    const x = positions[ip];
    const y = positions[ip + 1];
    const dx = x - boneX;
    const dy = y - boneY;
    if (scale) {
      const length = lengths[i];
      if (length !== 0) {
        const s = (Math.sqrt(dx * dx + dy * dy) / length - 1) * mixRotate + 1;
        bone.a *= s;
        bone.c *= s;
      }
    }
    boneX = x;
    boneY = y;
    if (mixRotate > 0) {
      const a = bone.a;
      const b = bone.b;
      const cc = bone.c;
      const d = bone.d;
      let r = 0;
      let cos = 0;
      let sin = 0;
      if (tangents) r = positions[ip - 1];
      else if (spaces[i + 1] === 0) r = positions[ip + 2];
      else r = Math.atan2(dy, dx);
      r -= Math.atan2(cc, a);
      if (tip) {
        cos = Math.cos(r);
        sin = Math.sin(r);
        const length = bone.length;
        boneX += (length * (cos * a - sin * cc) - dx) * mixRotate;
        boneY += (length * (sin * a + cos * cc) - dy) * mixRotate;
      } else r += offsetRotation;
      if (r > PI) r -= PI2;
      else if (r < -PI) r += PI2;
      r *= mixRotate;
      cos = Math.cos(r);
      sin = Math.sin(r);
      bone.a = cos * a - sin * cc;
      bone.b = cos * b - sin * d;
      bone.c = sin * a + cos * cc;
      bone.d = sin * b + cos * d;
    }
  }
}

/** Positions (x, y, tangent angle) along the path for each space (PathConstraint.computeWorldPositions). */
function pathPositions(c: Extract<Constraint, { kind: "path" }>, path: PathAttachment, verts: Vec2[], spaces: number[], spacesCount: number, tangents: boolean): number[] {
  // flat world vertex list, like Spine's float array
  const all: number[] = [];
  for (const [x, y] of verts) all.push(x, y);
  const worldVerts = (start: number, count: number, out: number[], offset: number) => {
    for (let i = 0; i < count; i++) out[offset + i] = all[start + i];
  };
  let position = c.position;
  const out = new Array<number>(spacesCount * 3 + 2).fill(0);
  const closed = !!path.closed;
  let verticesLength = all.length;
  let curveCount = verticesLength / 6;
  let prevCurve = -1;
  const data = c.data;
  if (path.constantSpeed === false) {
    const lengths = path.lengths;
    curveCount -= closed ? 1 : 2;
    const pathLength = lengths[curveCount];
    if (data.positionMode === "percent") position *= pathLength;
    const multiplier = data.spacingMode === "percent" ? pathLength : data.spacingMode === "proportional" ? pathLength / spacesCount : 1;
    const world = new Array<number>(8).fill(0);
    for (let i = 0, o = 0, curve = 0; i < spacesCount; i++, o += 3) {
      const space = spaces[i] * multiplier;
      position += space;
      let p = position;
      if (closed) {
        p %= pathLength;
        if (p < 0) p += pathLength;
        curve = 0;
      } else if (p < 0) {
        if (prevCurve !== -2) {
          prevCurve = -2;
          worldVerts(2, 4, world, 0);
        }
        addBeforePosition(p, world, 0, out, o);
        continue;
      } else if (p > pathLength) {
        if (prevCurve !== -3) {
          prevCurve = -3;
          worldVerts(verticesLength - 6, 4, world, 0);
        }
        addAfterPosition(p - pathLength, world, 0, out, o);
        continue;
      }
      for (; ; curve++) {
        const length = lengths[curve];
        if (p > length) continue;
        if (curve === 0) p /= length;
        else {
          const prev = lengths[curve - 1];
          p = (p - prev) / (length - prev);
        }
        break;
      }
      if (curve !== prevCurve) {
        prevCurve = curve;
        if (closed && curve === curveCount) {
          worldVerts(verticesLength - 4, 4, world, 0);
          worldVerts(0, 4, world, 4);
        } else worldVerts(curve * 6 + 2, 8, world, 0);
      }
      addCurvePosition(p, world[0], world[1], world[2], world[3], world[4], world[5], world[6], world[7], out, o, tangents || (i > 0 && space === 0));
    }
    return out;
  }
  let world: number[];
  if (closed) {
    verticesLength += 2;
    world = new Array<number>(verticesLength).fill(0);
    worldVerts(2, verticesLength - 4, world, 0);
    worldVerts(0, 2, world, verticesLength - 4);
    world[verticesLength - 2] = world[0];
    world[verticesLength - 1] = world[1];
  } else {
    curveCount--;
    verticesLength -= 4;
    world = new Array<number>(verticesLength).fill(0);
    worldVerts(2, verticesLength, world, 0);
  }
  const curves = new Array<number>(curveCount).fill(0);
  let pathLength = 0;
  let x1 = world[0];
  let y1 = world[1];
  let cx1 = 0;
  let cy1 = 0;
  let cx2 = 0;
  let cy2 = 0;
  let x2 = 0;
  let y2 = 0;
  let tmpx = 0;
  let tmpy = 0;
  let dddfx = 0;
  let dddfy = 0;
  let ddfx = 0;
  let ddfy = 0;
  let dfx = 0;
  let dfy = 0;
  for (let i = 0, w = 2; i < curveCount; i++, w += 6) {
    cx1 = world[w];
    cy1 = world[w + 1];
    cx2 = world[w + 2];
    cy2 = world[w + 3];
    x2 = world[w + 4];
    y2 = world[w + 5];
    tmpx = (x1 - cx1 * 2 + cx2) * 0.1875;
    tmpy = (y1 - cy1 * 2 + cy2) * 0.1875;
    dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.09375;
    dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.09375;
    ddfx = tmpx * 2 + dddfx;
    ddfy = tmpy * 2 + dddfy;
    dfx = (cx1 - x1) * 0.75 + tmpx + dddfx * 0.16666667;
    dfy = (cy1 - y1) * 0.75 + tmpy + dddfy * 0.16666667;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx;
    dfy += ddfy;
    ddfx += dddfx;
    ddfy += dddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx;
    dfy += ddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx + dddfx;
    dfy += ddfy + dddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    curves[i] = pathLength;
    x1 = x2;
    y1 = y2;
  }
  if (data.positionMode === "percent") position *= pathLength;
  const multiplier = data.spacingMode === "percent" ? pathLength : data.spacingMode === "proportional" ? pathLength / spacesCount : 1;
  const segments = new Array<number>(10).fill(0);
  let curveLength = 0;
  for (let i = 0, o = 0, curve = 0, segment = 0; i < spacesCount; i++, o += 3) {
    const space = spaces[i] * multiplier;
    position += space;
    let p = position;
    if (closed) {
      p %= pathLength;
      if (p < 0) p += pathLength;
      curve = 0;
      segment = 0;
    } else if (p < 0) {
      addBeforePosition(p, world, 0, out, o);
      continue;
    } else if (p > pathLength) {
      addAfterPosition(p - pathLength, world, verticesLength - 4, out, o);
      continue;
    }
    for (; ; curve++) {
      const length = curves[curve];
      if (p > length) continue;
      if (curve === 0) p /= length;
      else {
        const prev = curves[curve - 1];
        p = (p - prev) / (length - prev);
      }
      break;
    }
    if (curve !== prevCurve) {
      prevCurve = curve;
      let ii = curve * 6;
      x1 = world[ii];
      y1 = world[ii + 1];
      cx1 = world[ii + 2];
      cy1 = world[ii + 3];
      cx2 = world[ii + 4];
      cy2 = world[ii + 5];
      x2 = world[ii + 6];
      y2 = world[ii + 7];
      tmpx = (x1 - cx1 * 2 + cx2) * 0.03;
      tmpy = (y1 - cy1 * 2 + cy2) * 0.03;
      dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.006;
      dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.006;
      ddfx = tmpx * 2 + dddfx;
      ddfy = tmpy * 2 + dddfy;
      dfx = (cx1 - x1) * 0.3 + tmpx + dddfx * 0.16666667;
      dfy = (cy1 - y1) * 0.3 + tmpy + dddfy * 0.16666667;
      curveLength = Math.sqrt(dfx * dfx + dfy * dfy);
      segments[0] = curveLength;
      for (ii = 1; ii < 8; ii++) {
        dfx += ddfx;
        dfy += ddfy;
        ddfx += dddfx;
        ddfy += dddfy;
        curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
        segments[ii] = curveLength;
      }
      dfx += ddfx;
      dfy += ddfy;
      curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
      segments[8] = curveLength;
      dfx += ddfx + dddfx;
      dfy += ddfy + dddfy;
      curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
      segments[9] = curveLength;
      segment = 0;
    }
    p *= curveLength;
    for (; ; segment++) {
      const length = segments[segment];
      if (p > length) continue;
      if (segment === 0) p /= length;
      else {
        const prev = segments[segment - 1];
        p = segment + (p - prev) / (length - prev);
      }
      break;
    }
    addCurvePosition(p * 0.1, x1, y1, cx1, cy1, cx2, cy2, x2, y2, out, o, tangents || (i > 0 && space === 0));
  }
  return out;
}

function addBeforePosition(p: number, temp: number[], i: number, out: number[], o: number): void {
  const x1 = temp[i];
  const y1 = temp[i + 1];
  const dx = temp[i + 2] - x1;
  const dy = temp[i + 3] - y1;
  const r = Math.atan2(dy, dx);
  out[o] = x1 + p * Math.cos(r);
  out[o + 1] = y1 + p * Math.sin(r);
  out[o + 2] = r;
}

function addAfterPosition(p: number, temp: number[], i: number, out: number[], o: number): void {
  const x1 = temp[i + 2];
  const y1 = temp[i + 3];
  const dx = x1 - temp[i];
  const dy = y1 - temp[i + 1];
  const r = Math.atan2(dy, dx);
  out[o] = x1 + p * Math.cos(r);
  out[o + 1] = y1 + p * Math.sin(r);
  out[o + 2] = r;
}

function addCurvePosition(p: number, x1: number, y1: number, cx1: number, cy1: number, cx2: number, cy2: number, x2: number, y2: number, out: number[], o: number, tangents: boolean): void {
  if (p === 0 || Number.isNaN(p)) {
    out[o] = x1;
    out[o + 1] = y1;
    out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    return;
  }
  const tt = p * p;
  const ttt = tt * p;
  const u = 1 - p;
  const uu = u * u;
  const uuu = uu * u;
  const ut = u * p;
  const ut3 = ut * 3;
  const uut3 = u * ut3;
  const utt3 = ut3 * p;
  const x = x1 * uuu + cx1 * uut3 + cx2 * utt3 + x2 * ttt;
  const y = y1 * uuu + cy1 * uut3 + cy2 * utt3 + y2 * ttt;
  out[o] = x;
  out[o + 1] = y;
  if (tangents) {
    if (p < 0.001) out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    else out[o + 2] = Math.atan2(y - (y1 * uu + cy1 * ut * 2 + cy2 * tt), x - (x1 * uu + cx1 * ut * 2 + cx2 * tt));
  }
}

// ---------- physics (PhysicsConstraint)

function resetPhysics(s: PhysicsState, time: number): void {
  Object.assign(s, newPhysicsState(time));
}

function updatePhysics(sk: SpineSkeleton, c: Extract<Constraint, { kind: "physics" }>, input: SpineUpdateInput): void {
  const mix = c.mix;
  if (mix === 0) return;
  const state = input.state;
  if (!state || !input.physics) return;
  const data = c.data;
  const s = state.physicsFor(data.id);
  const dx0 = data.x ?? 0;
  const dy0 = data.y ?? 0;
  const drot = data.rotate ?? 0;
  const dshear = data.shearX ?? 0;
  const dscale = data.scaleX ?? 0;
  const x = dx0 > 0;
  const y = dy0 > 0;
  const rotateOrShearX = drot > 0 || dshear > 0;
  const scaleX = dscale > 0;
  const bone = c.bone;
  const l = bone.length;
  const t = 1 / (data.fps ?? 60);
  let z = 0;
  modifyWorld(sk, bone);
  const referenceScale = input.model.referenceScale ?? 100;
  const limit = data.limit ?? 5000;
  // wind (1, 0) and gravity (0, 1) are the runtime's skeleton defaults
  const windX = 1;
  const windY = 0;
  const gravityX = 0;
  const gravityY = 1;
  if (input.physics === "update") {
    const delta = Math.max(state.time - s.lastTime, 0);
    const aa = s.remaining;
    s.remaining += delta;
    s.lastTime = state.time;
    const bx = bone.worldX;
    const by = bone.worldY;
    if (s.reset) {
      s.reset = false;
      s.ux = bx;
      s.uy = by;
    } else {
      let a = s.remaining;
      const i = c.inertia;
      const f = referenceScale;
      let d = -1;
      let m = 0;
      let e = 0;
      let qx = limit * delta;
      const qy = qx * Math.abs(sk.scaleY);
      qx *= Math.abs(sk.scaleX);
      if (x || y) {
        if (x) {
          const u = (s.ux - bx) * i;
          s.xOffset += u > qx ? qx : u < -qx ? -qx : u;
          s.ux = bx;
        }
        if (y) {
          const u = (s.uy - by) * i;
          s.yOffset += u > qy ? qy : u < -qy ? -qy : u;
          s.uy = by;
        }
        if (a >= t) {
          const xs = s.xOffset;
          const ys = s.yOffset;
          d = c.damping ** (60 * t);
          m = t * c.massInverse;
          e = c.strength;
          const w = f * c.wind;
          const g = f * c.gravity;
          const ax = (w * windX + g * gravityX) * sk.scaleX;
          const ay = (w * windY + g * gravityY) * sk.scaleY;
          do {
            if (x) {
              s.xVelocity += (ax - s.xOffset * e) * m;
              s.xOffset += s.xVelocity * t;
              s.xVelocity *= d;
            }
            if (y) {
              s.yVelocity -= (ay + s.yOffset * e) * m;
              s.yOffset += s.yVelocity * t;
              s.yVelocity *= d;
            }
            a -= t;
          } while (a >= t);
          s.xLag = s.xOffset - xs;
          s.yLag = s.yOffset - ys;
        }
        z = Math.max(0, 1 - a / t);
        if (x) bone.worldX += (s.xOffset - s.xLag * z) * mix * dx0;
        if (y) bone.worldY += (s.yOffset - s.yLag * z) * mix * dy0;
      }
      if (rotateOrShearX || scaleX) {
        const ca = Math.atan2(bone.c, bone.a);
        let cc = 0;
        let ss = 0;
        let mr = 0;
        let dx = s.cx - bone.worldX;
        let dy = s.cy - bone.worldY;
        if (dx > qx) dx = qx;
        else if (dx < -qx) dx = -qx;
        if (dy > qy) dy = qy;
        else if (dy < -qy) dy = -qy;
        a = s.remaining;
        if (rotateOrShearX) {
          mr = (drot + dshear) * mix;
          z = s.rotateLag * Math.max(0, 1 - aa / t);
          let r = Math.atan2(dy + s.ty, dx + s.tx) - ca - (s.rotateOffset - z) * mr;
          s.rotateOffset += (r - Math.ceil(r * INV_PI2 - 0.5) * PI2) * i;
          r = (s.rotateOffset - z) * mr + ca;
          cc = Math.cos(r);
          ss = Math.sin(r);
          if (scaleX) {
            r = l * worldScaleX(bone);
            if (r > 0) s.scaleOffset += ((dx * cc + dy * ss) * i) / r;
          }
        } else {
          cc = Math.cos(ca);
          ss = Math.sin(ca);
          const r = l * worldScaleX(bone) - s.scaleLag * Math.max(0, 1 - aa / t);
          if (r > 0) s.scaleOffset += ((dx * cc + dy * ss) * i) / r;
        }
        if (a >= t) {
          if (d === -1) {
            d = c.damping ** (60 * t);
            m = t * c.massInverse;
            e = c.strength;
          }
          const ax = c.wind * windX + c.gravity * gravityX;
          const ay = c.wind * windY + c.gravity * gravityY;
          const rs = s.rotateOffset;
          const ss0 = s.scaleOffset;
          const h = l / f;
          while (true) {
            a -= t;
            if (scaleX) {
              s.scaleVelocity += (ax * cc - ay * ss - s.scaleOffset * e) * m;
              s.scaleOffset += s.scaleVelocity * t;
              s.scaleVelocity *= d;
            }
            if (rotateOrShearX) {
              s.rotateVelocity -= ((ax * ss + ay * cc) * h + s.rotateOffset * e) * m;
              s.rotateOffset += s.rotateVelocity * t;
              s.rotateVelocity *= d;
              if (a < t) break;
              const r = s.rotateOffset * mr + ca;
              cc = Math.cos(r);
              ss = Math.sin(r);
            } else if (a < t) break;
          }
          s.rotateLag = s.rotateOffset - rs;
          s.scaleLag = s.scaleOffset - ss0;
        }
        z = Math.max(0, 1 - a / t);
      }
      s.remaining = a;
    }
    s.cx = bone.worldX;
    s.cy = bone.worldY;
  } else {
    z = Math.max(0, 1 - s.remaining / t);
    if (x) bone.worldX += (s.xOffset - s.xLag * z) * mix * dx0;
    if (y) bone.worldY += (s.yOffset - s.yLag * z) * mix * dy0;
  }
  if (rotateOrShearX) {
    let o = (s.rotateOffset - s.rotateLag * z) * mix;
    let sn = 0;
    let cs = 0;
    let a = 0;
    if (dshear > 0) {
      let r = 0;
      if (drot > 0) {
        r = o * drot;
        sn = Math.sin(r);
        cs = Math.cos(r);
        a = bone.b;
        bone.b = cs * a - sn * bone.d;
        bone.d = sn * a + cs * bone.d;
      }
      r += o * dshear;
      sn = Math.sin(r);
      cs = Math.cos(r);
      a = bone.a;
      bone.a = cs * a - sn * bone.c;
      bone.c = sn * a + cs * bone.c;
    } else {
      o *= drot;
      sn = Math.sin(o);
      cs = Math.cos(o);
      a = bone.a;
      bone.a = cs * a - sn * bone.c;
      bone.c = sn * a + cs * bone.c;
      a = bone.b;
      bone.b = cs * a - sn * bone.d;
      bone.d = sn * a + cs * bone.d;
    }
  }
  if (scaleX) {
    let sc = 1 + (s.scaleOffset - s.scaleLag * z) * mix * dscale;
    bone.a *= sc;
    bone.c *= sc;
    if (data.scaleY === "uniform") {
      bone.b *= sc;
      bone.d *= sc;
    } else if (data.scaleY === "volume") {
      sc = Math.abs(sc);
      sc = sc >= 0.7 ? 1 / sc : 4 - 3.67347 * sc;
      bone.b *= sc;
      bone.d *= sc;
    }
  }
  if (input.physics === "update") {
    s.tx = l * bone.a;
    s.ty = l * bone.c;
  }
}

// ---------- sliders (Slider)

function updateSlider(sk: SpineSkeleton, c: Extract<Constraint, { kind: "slider" }>, input: SpineUpdateInput): void {
  if (c.mix === 0) return;
  const data = c.data;
  const anim = input.model.animations![data.animation];
  let time = c.time;
  const bone = c.bone;
  if (bone) {
    if (!bone.active) return;
    if (data.local) validateLocalTransform(sk, bone);
    time = (data.to ?? 0) + (fromValue(sk, data.property ?? "rotate", bone, !!data.local, {}) - (data.from ?? 0)) * (data.scale ?? 1);
    if (data.loop) time = anim.duration + (time % anim.duration);
    else time = Math.max(0, time);
  }
  c.time = time;
  for (const b of sliderBones(input.model, data, sk)) modifyLocal(sk, b);
  input.applySlider(sk, data, data.loop && anim.duration ? time % anim.duration : time, c.mix);
}

/** Slider time at the pose (for tools that show it): the keyed / set time, or the one the bone drives. */
export function sliderAnimationTime(model: Model, slider: Slider, animTime: number): number {
  const anim = model.animations?.[slider.animation];
  if (!anim) return 0;
  return localTime(anim, animTime);
}
