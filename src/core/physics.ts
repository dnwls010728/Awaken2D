// Simulated posing (Live2D physics3 and pose fades, Spine physics constraints). Simulation is deterministic: a
// fixed time step from the start of the animation (after settling in the first frame's pose), so any time can be
// reproduced exactly.
import { localTime, sampleTrack } from "./animation.ts";
import { LIVE2D_FRAME, Live2DPhysicsSim } from "./live2dphysics.ts";
import { Live2DPoseSim, poseParts } from "./live2dpose.ts";
import { lerp } from "./math.ts";
import { paramValues } from "./params.ts";
import { computePose } from "./pose.ts";
import { SpineState } from "./spine.ts";
import type { Pose } from "./pose.ts";
import type { Animation, Model } from "./types.ts";

export const PHYSICS_DT = 1 / 120;
/** Seconds held in the first frame's pose before recording, so gravity sag is at rest. */
export const SETTLE_TIME = 1.5;
/** Loops are run this many times before recording, so the start of the loop is in steady state. */
export const WARMUP_LOOPS = 2;

export interface PoseSampleOptions {
  /** Apply IK (default true). */
  constraints?: boolean;
  /** Simulate physics (Live2D physics3, Spine physics constraints; default true). */
  physics?: boolean;
  /** Parameter overrides (others come from the animation or their defaults). */
  params?: Record<string, number>;
  /** Loops run before recording (default WARMUP_LOOPS). Fewer is faster but the loop start is less settled. */
  warmupLoops?: number;
  /** Seconds held in the first frame before recording (default SETTLE_TIME). */
  settle?: number;
}

/**
 * Stateful pose source for one animation: FK, constraints and physics. Moving forward in time advances the
 * simulation incrementally (cheap, for live playback); asking for an earlier time re-simulates from the start.
 * Times are unwrapped seconds; looping animations wrap internally, so playback can simply keep counting.
 */
export class PoseSimulator {
  readonly model: Model;
  readonly animation: string | null;
  private readonly constraints: boolean;
  private readonly params: Record<string, number>;
  private readonly anim: Animation | undefined;
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
    const l2dPhysics = opts.physics !== false && model.live2d?.physics?.settings.length ? model.live2d.physics : undefined;
    this.l2d = l2dPhysics ? new Live2DPhysicsSim(model, l2dPhysics) : null;
    this.l2dPose = model.live2d?.pose?.groups.length ? new Live2DPoseSim(model.live2d.pose) : null;
    this.spine = opts.physics !== false && model.spinePhysics?.length ? new SpineState() : null;
    if (from && from.animation === animation) {
      // continue the other simulator's state instead of re-settling from scratch
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
    return !!this.l2d || !!this.l2dPose || !!this.spine;
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
 * Final poses (FK, constraints, physics) at the given times of an animation (null = setup pose).
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
