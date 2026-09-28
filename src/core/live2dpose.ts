// Live2D pose groups (pose3.json): of each group of parts (e.g. arm variants) one is shown; animations pick it by
// keying the parts' opacity above zero, and the switch fades like the Cubism Framework's CubismPose.
import type { Live2DPose, Model } from "./types.ts";

const EPSILON = 0.001;
const PHI = 0.5;
const BACK_OPACITY_THRESHOLD = 0.15;

/** Stateful pose fading (one per playback), stepped with the frame time. */
export class Live2DPoseSim {
  private readonly pose: Live2DPose;
  private readonly fade: number;
  /** Current opacity of each part in a group. */
  readonly opacity = new Map<string, number>();
  /** The "part parameters" the groups read (animated part opacity values), kept between frames. */
  private readonly values = new Map<string, number>();

  constructor(pose: Live2DPose) {
    this.pose = pose;
    this.fade = pose.fadeIn !== undefined && pose.fadeIn >= 0 ? pose.fadeIn : 0.5;
    this.reset();
  }

  /** First part of every group shown, the rest hidden (the Framework does this on its first frame, discarding that frame's animated values). */
  reset(): void {
    for (const g of this.pose.groups) {
      g.forEach((p, i) => {
        this.opacity.set(p.part, i === 0 ? 1 : 0);
        this.values.set(p.part, i === 0 ? 1 : 0);
      });
    }
  }

  /** Advances by dt with the animated part values of this frame; returns the opacities (links included). */
  update(animated: Record<string, number> | undefined, dt: number): Map<string, number> {
    if (animated) for (const [id, v] of Object.entries(animated)) if (this.values.has(id)) this.values.set(id, v);
    dt = Math.max(0, dt);
    for (const g of this.pose.groups) {
      let visible = -1;
      let next = 1;
      for (let i = 0; i < g.length; i++) {
        if ((this.values.get(g[i].part) ?? 0) > EPSILON) {
          if (visible >= 0) break;
          visible = i;
          if (this.fade === 0) {
            next = 1;
            continue;
          }
          next = Math.min(1, (this.opacity.get(g[i].part) ?? 0) + dt / this.fade);
        }
      }
      if (visible < 0) {
        visible = 0;
        next = 1;
      }
      g.forEach((p, i) => {
        if (i === visible) return this.opacity.set(p.part, next);
        let a1 = next < PHI ? (next * (PHI - 1)) / PHI + 1 : ((1 - next) * PHI) / (1 - PHI);
        const back = (1 - a1) * (1 - next);
        if (back > BACK_OPACITY_THRESHOLD) a1 = 1 - BACK_OPACITY_THRESHOLD / (1 - next);
        this.opacity.set(p.part, Math.min(this.opacity.get(p.part) ?? 0, a1));
      });
    }
    return this.withLinks();
  }

  /** The opacities as they are (links included). */
  current(): Map<string, number> {
    return this.withLinks();
  }

  private withLinks(): Map<string, number> {
    const out = new Map(this.opacity);
    for (const g of this.pose.groups) for (const p of g) for (const l of p.link ?? []) out.set(l, out.get(p.part) ?? 1);
    return out;
  }
}

/** Parts that a pose group controls (links included). */
export function poseParts(model: Model): Set<string> {
  const out = new Set<string>();
  for (const g of model.live2d?.pose?.groups ?? []) for (const p of g) out.add(p.part), (p.link ?? []).forEach((l) => out.add(l));
  return out;
}

/** Settled pose-group opacities for animated part values (no fade history): the chosen part 1, the others 0. */
export function settledPose(pose: Live2DPose, animated: Record<string, number> | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of pose.groups) {
    let visible = g.findIndex((p, i) => (animated?.[p.part] ?? (i === 0 ? 1 : 0)) > EPSILON);
    if (visible < 0) visible = 0;
    g.forEach((p, i) => {
      out.set(p.part, i === visible ? 1 : 0);
      for (const l of p.link ?? []) out.set(l, i === visible ? 1 : 0);
    });
  }
  return out;
}
