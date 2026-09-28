// Inverse kinematics: one-bone (aim) and analytic two-bone solvers, applied on top of the animated pose.
import { sampleTrack } from "./animation.ts";
import { DEG, apply, fromTRS, lerp, mul } from "./math.ts";
import type { Mat } from "./math.ts";
import type { BonePose, Pose } from "./pose.ts";
import type { IkConstraint, IkTimeline, Vec2 } from "./types.ts";

/** Wraps an angle in degrees to (-180, 180]. */
export function wrapDeg(a: number): number {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}

const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];
const angle = (from: Vec2, to: Vec2) => Math.atan2(to[1] - from[1], to[0] - from[0]) / DEG;

/** Rotates a bone so its world x axis turns by `worldDelta` degrees (handles mirrored parents). */
export function rotateWorld(pose: Pose, bone: BonePose, worldDelta: number): void {
  const parent = bone.parent ? pose.byId.get(bone.parent) : undefined;
  const flip = parent && det(parent.world) < 0 ? -1 : 1;
  bone.rotation += worldDelta * flip;
  updateSubtree(pose, bone);
}

/** Recomputes world matrices of a bone and its descendants only (bones are parent-first ordered). */
function updateSubtree(pose: Pose, bone: BonePose): void {
  const dirty = new Set<string>([bone.id]);
  const start = pose.bones.indexOf(bone);
  for (let i = start; i < pose.bones.length; i++) {
    const p = pose.bones[i];
    if (i !== start && !(p.parent && dirty.has(p.parent))) continue;
    dirty.add(p.id);
    const local = fromTRS(p.x, p.y, p.rotation, p.scaleX, p.scaleY, p.shearX, p.shearY);
    p.world = p.parent === null ? local : mul(pose.byId.get(p.parent)!.world, local);
  }
}

export function applyIkConstraints(constraints: IkConstraint[], pose: Pose, timelines: Record<string, IkTimeline> | undefined, t: number): void {
  for (const c of constraints) {
    const tl = timelines?.[c.id];
    const mix = Math.max(0, Math.min(1, sampleTrack(tl?.mix, t, lerp) ?? c.mix));
    const bend = sampleTrack(tl?.bendPositive, t, (a) => a) ?? c.bendPositive;
    if (mix <= 0) continue;
    const target = pose.byId.get(c.target);
    const chain = c.bones.map((id) => pose.byId.get(id));
    if (!target || chain.some((b) => !b)) continue; // validation reports these
    const goal = apply(target.world, 0, 0);
    if (chain.length === 1) solveOne(pose, chain[0]!, goal, mix);
    else if (chain.length === 2) solveTwo(pose, chain[0]!, chain[1]!, goal, bend, mix);
  }
}

function solveOne(pose: Pose, bone: BonePose, goal: Vec2, mix: number): void {
  const origin = apply(bone.world, 0, 0);
  if (Math.hypot(goal[0] - origin[0], goal[1] - origin[1]) < 1e-9) return;
  const current = Math.atan2(bone.world[1], bone.world[0]) / DEG;
  rotateWorld(pose, bone, wrapDeg(angle(origin, goal) - current) * mix);
}

function solveTwo(pose: Pose, upper: BonePose, lower: BonePose, goal: Vec2, bendPositive: boolean, mix: number): void {
  const p1 = apply(upper.world, 0, 0);
  const p2 = apply(lower.world, 0, 0);
  const tip = apply(lower.world, lower.length, 0);
  const l1 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const l2 = Math.hypot(tip[0] - p2[0], tip[1] - p2[1]);
  if (l1 < 1e-6 || l2 < 1e-6) {
    // degenerate chain (zero-length child): aim the parent instead
    solveOne(pose, upper, goal, mix);
    return;
  }
  const reach = Math.hypot(goal[0] - p1[0], goal[1] - p1[1]);
  const d = Math.max(Math.abs(l1 - l2), Math.min(l1 + l2, reach));
  const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const a = Math.acos(cosA) / DEG;
  const base = reach > 1e-9 ? angle(p1, goal) : angle(p1, p2);
  // bendPositive: the joint swings clockwise off the line so the child turns counter-clockwise
  const desired1 = bendPositive ? base - a : base + a;
  rotateWorld(pose, upper, wrapDeg(desired1 - angle(p1, p2)) * mix);
  const q2 = apply(lower.world, 0, 0);
  const qTip = apply(lower.world, lower.length, 0);
  rotateWorld(pose, lower, wrapDeg(angle(q2, goal) - angle(q2, qTip)) * mix);
}
