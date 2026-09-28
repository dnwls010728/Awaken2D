// Spring-bone physics. Simulation is deterministic: a fixed time step from the start of the animation
// (after settling in the first frame's pose), so any time can be reproduced exactly.
import { localTime, sampleTrack } from "./animation.ts";
import { rotateWorld, wrapDeg } from "./ik.ts";
import { LIVE2D_FRAME, Live2DPhysicsSim } from "./live2dphysics.ts";
import { Live2DPoseSim, poseParts } from "./live2dpose.ts";
import { DEG, apply, lerp } from "./math.ts";
import { paramValues } from "./params.ts";
import { boneOrder, computePose } from "./pose.ts";
import { SpineState } from "./spine.ts";
import type { Pose } from "./pose.ts";
import type { Animation, Model, PhysicsConstraint, Vec2 } from "./types.ts";

export const PHYSICS_DT = 1 / 120;
/** Seconds held in the first frame's pose before recording, so gravity sag is at rest. */
export const SETTLE_TIME = 1.5;
/** Loops are run this many times before recording, so the start of the loop is in steady state. */
export const WARMUP_LOOPS = 2;

interface BodyState {
  bone: string;
  c: PhysicsConstraint;
  p: Vec2;
  v: Vec2;
  prevOrigin: Vec2;
  started: boolean;
}

export interface PoseSampleOptions {
  /** Apply IK (default true). */
  constraints?: boolean;
  /** Simulate spring bones (default true). */
  physics?: boolean;
  /** Parameter overrides (others come from the animation or their defaults). */
  params?: Record<string, number>;
  /** Loops run before recording (default WARMUP_LOOPS). Fewer is faster but the loop start is less settled. */
  warmupLoops?: number;
  /** Seconds held in the first frame before recording (default SETTLE_TIME). */
  settle?: number;
}

/**
 * Stateful pose source for one animation: FK, IK and spring bones. Moving forward in time advances the
 * simulation incrementally (cheap, for live playback); asking for an earlier time re-simulates from the start.
 * Times are unwrapped seconds; looping animations wrap internally, so playback can simply keep counting.
 */
export class PoseSimulator {
  readonly model: Model;
  readonly animation: string | null;
  private readonly constraints: boolean;
  private readonly params: Record<string, number>;
  private readonly anim: Animation | undefined;
  private readonly bodies: BodyState[];
  /** Live2D parameter physics (physics3), when the model has it. */
  private l2d: Live2DPhysicsSim | null;
  /** Live2D pose-group fading (pose3), when the model has groups. */
  private l2dPose: Live2DPoseSim | null;
  /** Spine physics constraints: their simulation state and clock (starts with playback, like Spine). */
  private spine: SpineState | null;
  private poseRemain = 0;
  private readonly warmupLoops: number;
  private readonly settle: number;
  private cur = 0;
  private last!: Pose;

  constructor(model: Model, animation: string | null, opts: PoseSampleOptions = {}, from?: PoseSimulator) {
    this.model = model;
    this.warmupLoops = opts.warmupLoops ?? WARMUP_LOOPS;
    this.settle = opts.settle ?? SETTLE_TIME;
    this.animation = animation;
    this.constraints = opts.constraints !== false;
    this.params = opts.params ?? {};
    this.anim = animation ? model.animations?.[animation] : undefined;
    if (animation && !this.anim) throw new Error(`unknown animation "${animation}"`);
    const phys = opts.physics !== false ? (model.physics ?? []) : [];
    const l2dPhysics = opts.physics !== false && model.live2d?.physics?.settings.length ? model.live2d.physics : undefined;
    this.l2d = l2dPhysics ? new Live2DPhysicsSim(model, l2dPhysics) : null;
    this.l2dPose = model.live2d?.pose?.groups.length ? new Live2DPoseSim(model.live2d.pose) : null;
    this.spine = opts.physics !== false && model.spinePhysics?.length ? new SpineState() : null;
    const order = new Map(boneOrder(model).map((id, i) => [id, i]));
    this.bodies = phys
      .flatMap((c) => c.bones.map((bone) => ({ bone, c, p: [0, 0] as Vec2, v: [0, 0] as Vec2, prevOrigin: [0, 0] as Vec2, started: false })))
      .filter((b) => order.has(b.bone))
      .sort((a, b) => order.get(a.bone)! - order.get(b.bone)!);
    if (from && from.animation === animation) {
      // continue the other simulator's spring state instead of re-settling from scratch
      const prev = new Map(from.bodies.map((b) => [b.bone, b]));
      for (const b of this.bodies) {
        const p = prev.get(b.bone);
        if (p) Object.assign(b, { p: [...p.p] as Vec2, v: [...p.v] as Vec2, prevOrigin: [...p.prevOrigin] as Vec2, started: p.started });
      }
      this.cur = from.cur;
      if (this.l2d && from.l2d && model.live2d?.physics === from.model.live2d?.physics) this.l2d = from.l2d;
      if (this.l2dPose && from.l2dPose && model.live2d?.pose === from.model.live2d?.pose) this.l2dPose = from.l2dPose;
      if (this.spine && from.spine) this.spine = from.spine;
      this.last = this.simulated ? this.step(this.cur, 0) : computePose(model, animation, this.cur, { constraints: this.constraints, params: this.params });
      return;
    }
    this.reset();
  }

  /**
   * A simulator for an edited version of the model that carries on from this one's state (no settle/warm-up
   * re-run). For interactive editing: the result is continuous but not bit-identical to a fresh simulation.
   */
  rebase(model: Model, opts: PoseSampleOptions = {}): PoseSimulator {
    return new PoseSimulator(model, this.animation, opts, this);
  }

  /** True when there is something to simulate (otherwise every call is a plain computePose). */
  get simulated(): boolean {
    return this.bodies.length > 0 || !!this.l2d || !!this.l2dPose || !!this.spine;
  }

  /** The Spine physics state (to carry on simulating live after playback stops), or null. */
  get spineState(): SpineState | null {
    return this.spine;
  }

  /** Current simulation time in seconds (unwrapped). */
  get time(): number {
    return this.cur;
  }

  /** Back to the start: settle in the first frame's pose, warm up loops. */
  reset(): void {
    this.cur = 0;
    if (!this.simulated) {
      this.last = computePose(this.model, this.animation, 0, { constraints: this.constraints, params: this.params });
      return;
    }
    for (const b of this.bodies) b.started = false;
    if (this.l2d) {
      this.l2d = new Live2DPhysicsSim(this.model, this.model.live2d!.physics!);
      this.l2d.stabilize(paramValues(this.model, this.anim, 0, this.params));
    }
    this.l2dPose?.reset();
    this.poseRemain = 0;
    for (let s = 0; s < Math.round(this.settle / PHYSICS_DT); s++) this.step(0, PHYSICS_DT, true);
    if (this.anim && this.anim.loop !== false) {
      for (let i = 0; i < this.warmupLoops; i++) this.advance(0, this.anim.duration);
    }
    // Spine physics starts at rest with playback, like in Spine (its settling is part of the animation)
    if (this.spine) this.spine = new SpineState();
    this.last = this.step(0, 0);
  }

  /** Pose at time t (seconds, unwrapped). */
  at(t: number): Pose {
    if (!this.simulated) {
      this.cur = t;
      return computePose(this.model, this.animation, t, { constraints: this.constraints, params: this.params });
    }
    if (!this.anim) return this.last;
    if (t < this.cur - 1e-9) this.reset();
    this.last = this.advance(this.cur, t) ?? this.last;
    this.cur = Math.max(this.cur, t);
    return this.last;
  }

  /** Animated pose at time t with the simulation advanced by dt (dt = 0 only applies the current state). */
  private step(t: number, dt: number, bonesOnly = false): Pose {
    const local = this.anim ? localTime(this.anim, t) : 0;
    let params = this.params;
    if (this.l2d) {
      // Live2D physics writes its output parameters over the animated values
      params = paramValues(this.model, this.anim, local, this.params);
      this.l2d.evaluate(params, dt);
    }
    let spine: { state: SpineState; physics: "update" | "pose" } | undefined;
    if (this.spine) {
      this.spine.time += Math.max(0, dt);
      spine = { state: this.spine, physics: dt > 0 || this.spine.animTime < 0 ? "update" : "pose" };
    }
    const pose = computePose(this.model, this.animation, t, { constraints: this.constraints, params, bonesOnly, spine });
    if (this.l2dPose) {
      // pose groups fade over time from the animated part values
      const animated: Record<string, number> = {};
      for (const [id, keys] of Object.entries(this.anim?.partOpacity ?? {})) {
        const v = sampleTrack(keys, local, lerp);
        if (v !== undefined) animated[id] = v;
      }
      const grouped = poseParts(this.model);
      // like physics, the Framework fades once per rendered frame (60 fps here)
      this.poseRemain += Math.max(0, dt);
      let faded = this.l2dPose.current();
      while (this.poseRemain >= LIVE2D_FRAME - 1e-9) {
        faded = this.l2dPose.update(animated, LIVE2D_FRAME);
        this.poseRemain = Math.max(0, this.poseRemain - LIVE2D_FRAME);
      }
      pose.parts = { ...Object.fromEntries(Object.entries(pose.parts ?? {}).filter(([id]) => !grouped.has(id))), ...Object.fromEntries(faded) };
    }
    for (const body of this.bodies) stepBody(pose, body, this.anim?.physics?.[body.c.id], local, dt);
    return pose;
  }

  /** Advances from `from` to `to` in fixed steps (the last one shortened to land exactly). */
  private advance(from: number, to: number): Pose | undefined {
    let last: Pose | undefined;
    for (let cur = from; cur < to - 1e-9; ) {
      const h = Math.min(PHYSICS_DT, to - cur);
      cur += h;
      // only the pose that is returned needs slots
      last = this.step(cur, h, cur < to - 1e-9);
    }
    return last;
  }
}

/**
 * Final poses (FK, IK, physics) at the given times of an animation (null = setup pose).
 * Times are wrapped/clamped like computePose. One simulation run serves all requested times.
 */
export function samplePoses(model: Model, animation: string | null, times: number[], opts: PoseSampleOptions = {}): Pose[] {
  const sim = new PoseSimulator(model, animation, opts);
  const anim = animation ? model.animations?.[animation] : undefined;
  if (!sim.simulated || !anim) return times.map((t) => sim.at(t));
  const wanted = [...new Set(times.map((t) => localTime(anim, t)))].sort((a, b) => a - b);
  const found = new Map(wanted.map((t) => [t, sim.at(t)]));
  return times.map((t) => found.get(localTime(anim, t))!);
}

function stepBody(pose: Pose, body: BodyState, tl: { mix?: { t: number; v: number }[]; force?: { t: number; v: Vec2 }[] } | undefined, t: number, dt: number): void {
  const bone = pose.byId.get(body.bone);
  if (!bone || bone.length <= 0) return;
  const { c } = body;
  const origin = apply(bone.world, 0, 0);
  const goal = apply(bone.world, bone.length, 0);
  const len = Math.hypot(goal[0] - origin[0], goal[1] - origin[1]);
  if (len < 1e-9) return;
  if (!body.started) {
    body.p = goal;
    body.v = [0, 0];
    body.prevOrigin = origin;
    body.started = true;
  }
  if (dt > 0) {
    // parent motion: with inertia < 1 the mass is carried along with its origin
    const carry = 1 - Math.max(0, Math.min(1, c.inertia));
    body.p = [body.p[0] + (origin[0] - body.prevOrigin[0]) * carry, body.p[1] + (origin[1] - body.prevOrigin[1]) * carry];
    const w = 2 * Math.PI * Math.max(0, c.frequency);
    const k = w * w;
    const damp = 2 * Math.max(0, c.damping) * w;
    const force = sampleTrack(tl?.force, t, (a, b, f) => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)] as Vec2) ?? [0, 0];
    const ax = k * (goal[0] - body.p[0]) - damp * body.v[0] + c.gravity[0] + force[0];
    const ay = k * (goal[1] - body.p[1]) - damp * body.v[1] + c.gravity[1] + force[1];
    body.v = [body.v[0] + ax * dt, body.v[1] + ay * dt];
    body.p = [body.p[0] + body.v[0] * dt, body.p[1] + body.v[1] * dt];
    // keep the bone length: project onto the circle and drop the radial velocity
    let dx = body.p[0] - origin[0];
    let dy = body.p[1] - origin[1];
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-9) {
      dx = goal[0] - origin[0];
      dy = goal[1] - origin[1];
    } else {
      dx = (dx / dl) * len;
      dy = (dy / dl) * len;
    }
    // angle limit relative to the animated direction
    const animAngle = Math.atan2(goal[1] - origin[1], goal[0] - origin[0]) / DEG;
    let simAngle = Math.atan2(dy, dx) / DEG;
    if (c.limit > 0) {
      const dev = wrapDeg(simAngle - animAngle);
      if (Math.abs(dev) > c.limit) {
        simAngle = animAngle + Math.sign(dev) * c.limit;
        dx = Math.cos(simAngle * DEG) * len;
        dy = Math.sin(simAngle * DEG) * len;
      }
    }
    body.p = [origin[0] + dx, origin[1] + dy];
    const nx = dx / len;
    const ny = dy / len;
    const radial = body.v[0] * nx + body.v[1] * ny;
    body.v = [body.v[0] - radial * nx, body.v[1] - radial * ny];
    body.prevOrigin = origin;
  }
  const mix = Math.max(0, Math.min(1, sampleTrack(tl?.mix, t, lerp) ?? c.mix));
  const simAngle = Math.atan2(body.p[1] - origin[1], body.p[0] - origin[0]) / DEG;
  const animAngle = Math.atan2(goal[1] - origin[1], goal[0] - origin[0]) / DEG;
  if (mix > 0) rotateWorld(pose, bone, wrapDeg(simAngle - animAngle) * mix);
}
