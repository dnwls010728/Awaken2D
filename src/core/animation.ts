import type { Animation, Ease, Key } from "./types.ts";

const NAMED_EASES: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** A per-channel ease list (one Ease per value channel). */
export function isChannelEases(e: unknown): e is Ease[] {
  return Array.isArray(e) && e.length > 0 && e.every((x) => typeof x !== "number" && isEase(x));
}

/** The ease that stands for a key when one is needed (the first channel's for per-channel eases). */
export function primaryEase(e: Ease | Ease[] | undefined): Ease | undefined {
  return isChannelEases(e) ? e[0] : (e as Ease | undefined);
}

export function isEase(e: unknown): e is Ease {
  if (e === "linear" || e === "stepped") return true;
  if (typeof e === "string") return e in NAMED_EASES;
  return Array.isArray(e) && e.length === 4 && e.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Maps linear progress a (0..1) through the ease curve. `spine`: like the Spine runtime, which follows a bezier
 * through 10 straight segments (the curve sampled at every tenth of its parameter), not the exact curve.
 */
export function easeValue(ease: Ease | undefined, a: number, spine = false): number {
  if (ease === undefined || ease === "linear") return a;
  if (ease === "stepped") return 0;
  const bez = typeof ease === "string" ? NAMED_EASES[ease] : ease;
  if (!bez) return a;
  return spine ? spineBezier(bez[0], bez[1], bez[2], bez[3], a) : cubicBezier(bez[0], bez[1], bez[2], bez[3], a);
}

const spineCurveCache = new Map<string, Float64Array>();
/** Spine's CurveTimeline.setBezier / getBezierValue on the normalized curve (0,0)-(1,1). */
function spineBezier(cx1: number, cy1: number, cx2: number, cy2: number, time: number): number {
  const id = `${cx1},${cy1},${cx2},${cy2}`;
  let pts = spineCurveCache.get(id);
  if (!pts) {
    pts = new Float64Array(18);
    const tmpx = (0 - cx1 * 2 + cx2) * 0.03;
    const tmpy = (0 - cy1 * 2 + cy2) * 0.03;
    const dddx = ((cx1 - cx2) * 3 - 0 + 1) * 0.006;
    const dddy = ((cy1 - cy2) * 3 - 0 + 1) * 0.006;
    let ddx = tmpx * 2 + dddx;
    let ddy = tmpy * 2 + dddy;
    let dx = (cx1 - 0) * 0.3 + tmpx + dddx * 0.16666667;
    let dy = (cy1 - 0) * 0.3 + tmpy + dddy * 0.16666667;
    let x = dx;
    let y = dy;
    for (let i = 0; i < 18; i += 2) {
      pts[i] = x;
      pts[i + 1] = y;
      dx += ddx;
      dy += ddy;
      ddx += dddx;
      ddy += dddy;
      x += dx;
      y += dy;
    }
    if (spineCurveCache.size > 5000) spineCurveCache.clear();
    spineCurveCache.set(id, pts);
  }
  if (pts[0] > time) return (time / pts[0]) * pts[1];
  for (let i = 2; i < 18; i += 2) {
    if (pts[i] >= time) {
      const x = pts[i - 2];
      const y = pts[i - 1];
      return y + ((time - x) / (pts[i] - x)) * (pts[i + 1] - y);
    }
  }
  const x = pts[16];
  const y = pts[17];
  return y + ((time - x) / (1 - x)) * (1 - y);
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/** Samples a key track at time t. Returns undefined for an empty track. */
export function sampleTrack<T>(keys: Key<T>[] | undefined, t: number, mix: (a: T, b: T, f: number) => T, spine = false): T | undefined {
  if (!keys || keys.length === 0) return undefined;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  if (k0.ease === "stepped") return k0.v;
  const span = k1.t - k0.t;
  const a = span > 0 ? (t - k0.t) / span : 1;
  if (isChannelEases(k0.ease)) {
    // one curve per channel: numeric arrays interpolate channel by channel
    const eases = k0.ease;
    if (Array.isArray(k0.v) && Array.isArray(k1.v)) {
      const va = k0.v as unknown as number[];
      const vb = k1.v as unknown as number[];
      return va.map((x, i) => {
        const e = eases[Math.min(i, eases.length - 1)];
        return e === "stepped" ? x : x + (vb[i] - x) * easeValue(e, a, spine);
      }) as unknown as T;
    }
    return mix(k0.v, k1.v, easeValue(eases[0], a, spine));
  }
  return mix(k0.v, k1.v, easeValue(k0.ease, a, spine));
}

/** Wraps (loop) or clamps time into the animation's range. */
export function localTime(anim: Animation, time: number): number {
  const d = anim.duration;
  if (!(d > 0)) return 0;
  if (anim.loop === false) return Math.max(0, Math.min(d, time));
  const t = time % d;
  return t < 0 ? t + d : t;
}

/** Evenly spaced sample times: loops exclude the end (it equals the start), one-shots include it. */
export function sampleTimes(anim: Animation, frames: number): number[] {
  const n = Math.max(1, Math.floor(frames));
  if (n === 1) return [0];
  const step = anim.loop === false ? anim.duration / (n - 1) : anim.duration / n;
  return Array.from({ length: n }, (_, i) => +(i * step).toFixed(6));
}
