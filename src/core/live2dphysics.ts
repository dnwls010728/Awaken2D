// Live2D physics (physics3.json): pendulum strands driven by input parameters that write output parameters. This
// follows the Cubism Framework's CubismPhysics step for step (including its quirks, e.g. the in-place rotations and
// the zero scale of X / Y outputs) so a rig moves like it does in Cubism runtimes.
import type { Live2DPhysics, Live2DPhysicsSetting, Model, Parameter } from "./types.ts";

const AIR_RESISTANCE = 5;
const MAX_WEIGHT = 100;
const MOVEMENT_THRESHOLD = 0.001;
const MAX_DELTA = 5;
/** Without Meta.Fps the Framework steps once per rendered frame; Awaken2D assumes 60 frames per second. */
export const LIVE2D_FRAME = 1 / 60;

interface V2 {
  x: number;
  y: number;
}

interface Particle {
  initial: V2;
  position: V2;
  last: V2;
  lastGravity: V2;
  velocity: V2;
  mobility: number;
  delay: number;
  acceleration: number;
  radius: number;
}

const dirToRad = (from: V2, to: V2): number => {
  let r = Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x);
  while (r < -Math.PI) r += Math.PI * 2;
  while (r > Math.PI) r -= Math.PI * 2;
  return r;
};

const DEG = Math.PI / 180;

function normalize(value: number, p: Parameter, nMin: number, nMax: number, nDef: number, inverted: boolean): number {
  const maxV = Math.max(p.max, p.min);
  const minV = Math.min(p.max, p.min);
  value = Math.min(Math.max(value, minV), maxV);
  const minN = Math.min(nMin, nMax);
  const maxN = Math.max(nMin, nMax);
  const mid = minV + Math.abs(maxV - minV) / 2;
  const d = value - mid;
  let r = 0;
  if (d > 0) {
    const pl = maxV - mid;
    if (pl !== 0) r = d * ((maxN - nDef) / pl) + nDef;
  } else if (d < 0) {
    const pl = minV - mid;
    if (pl !== 0) r = d * ((minN - nDef) / pl) + nDef;
  } else r = nDef;
  return inverted ? r : -r;
}

/** Stateful Live2D physics for one model: `stabilize` once, then `evaluate` every frame. */
export class Live2DPhysicsSim {
  private readonly settings: Live2DPhysicsSetting[];
  private readonly params: Map<string, Parameter>;
  private readonly strands: Particle[][];
  private readonly current: number[][];
  private readonly previous: number[][];
  private readonly fps: number;
  private remain = 0;
  private caches: Map<string, number> | null = null;
  private inputCaches: Map<string, number> | null = null;

  constructor(model: Model, physics: Live2DPhysics = model.live2d!.physics!) {
    this.settings = physics.settings;
    this.fps = physics.fps ?? 0;
    this.params = new Map((model.parameters ?? []).map((p) => [p.id, p]));
    this.strands = this.settings.map((s) => {
      const out: Particle[] = [];
      s.vertices.forEach((v, i) => {
        const initial = i === 0 ? { x: 0, y: 0 } : { x: out[i - 1].initial.x, y: out[i - 1].initial.y + v.radius };
        out.push({
          initial,
          position: i === 0 ? { x: v.x, y: v.y } : { ...initial },
          last: { ...initial },
          lastGravity: { x: 0, y: 1 },
          velocity: { x: 0, y: 0 },
          mobility: v.mobility,
          delay: v.delay,
          acceleration: v.acceleration,
          radius: v.radius,
        });
      });
      return out;
    });
    this.current = this.settings.map((s) => s.outputs.map(() => 0));
    this.previous = this.settings.map((s) => s.outputs.map(() => 0));
  }

  private inputs(s: Live2DPhysicsSetting, value: (id: string) => number): { tx: number; ty: number; angle: number } {
    let tx = 0;
    let ty = 0;
    let angle = 0;
    for (const inp of s.inputs) {
      const p = this.params.get(inp.param);
      if (!p) continue;
      const w = inp.weight / MAX_WEIGHT;
      const n = s.normalization;
      if (inp.type === "Angle") angle += normalize(value(inp.param), p, n.angle.min, n.angle.max, n.angle.default, !!inp.reflect) * w;
      else {
        const v = normalize(value(inp.param), p, n.position.min, n.position.max, n.position.default, !!inp.reflect) * w;
        if (inp.type === "X") tx += v;
        else ty += v;
      }
    }
    // the Framework rotates in place (the new x feeds the y)
    const r = -angle * DEG;
    tx = tx * Math.cos(r) - ty * Math.sin(r);
    ty = tx * Math.sin(r) + ty * Math.cos(r);
    return { tx, ty, angle };
  }

  private outputValue(s: Live2DPhysicsSetting, strand: Particle[], o: Live2DPhysicsSetting["outputs"][number]): number | undefined {
    const i = o.vertex;
    if (i < 1 || i >= strand.length) return undefined;
    const t = { x: strand[i].position.x - strand[i - 1].position.x, y: strand[i].position.y - strand[i - 1].position.y };
    let v: number;
    if (o.type === "X") v = t.x;
    else if (o.type === "Y") v = t.y;
    else {
      // the Framework's default gravity (0, -1), negated, when there is no grandparent particle
      const parent = i >= 2 ? { x: strand[i - 1].position.x - strand[i - 2].position.x, y: strand[i - 1].position.y - strand[i - 2].position.y } : { x: 0, y: 1 };
      v = dirToRad(parent, t);
    }
    return o.reflect ? -v : v;
  }

  private write(o: Live2DPhysicsSetting["outputs"][number], raw: number, get: (id: string) => number, set: (id: string, v: number) => void): void {
    const p = this.params.get(o.param);
    if (!p) return;
    // X / Y outputs use a translation scale the Framework never sets (0)
    let v = raw * (o.type === "Angle" ? o.scale : 0);
    if (v < p.min) v = p.min;
    else if (v > p.max) v = p.max;
    const w = o.weight / MAX_WEIGHT;
    set(o.param, w >= 1 ? v : get(o.param) * (1 - w) + v * w);
  }

  /** Settles the strands at rest for the current values (Framework `stabilization`) and writes the outputs. */
  stabilize(values: Record<string, number>): void {
    this.caches = new Map(Object.entries(values));
    this.inputCaches = new Map(Object.entries(values));
    const get = (id: string) => values[id] ?? this.params.get(id)?.default ?? 0;
    this.settings.forEach((s, si) => {
      const { tx, ty, angle } = this.inputs(s, get);
      const strand = this.strands[si];
      if (!strand.length) return;
      strand[0].position = { x: tx, y: ty };
      const g = { x: Math.sin(angle * DEG), y: Math.cos(angle * DEG) };
      const gl = Math.hypot(g.x, g.y) || 1;
      g.x /= gl;
      g.y /= gl;
      const threshold = MOVEMENT_THRESHOLD * s.normalization.position.max;
      for (let i = 1; i < strand.length; i++) {
        const q = strand[i];
        q.last = { ...q.position };
        q.velocity = { x: 0, y: 0 };
        const fx = g.x * q.acceleration;
        const fy = g.y * q.acceleration;
        const fl = Math.hypot(fx, fy) || 1;
        q.position = { x: strand[i - 1].position.x + (fx / fl) * q.radius, y: strand[i - 1].position.y + (fy / fl) * q.radius };
        if (Math.abs(q.position.x) < threshold) q.position.x = 0;
        q.lastGravity = { ...g };
      }
      s.outputs.forEach((o, oi) => {
        const v = this.outputValue(s, strand, o);
        if (v === undefined) return;
        this.current[si][oi] = v;
        this.previous[si][oi] = v;
        this.write(o, v, get, (id, x) => {
          values[id] = x;
          this.caches!.set(id, x);
        });
      });
    });
  }

  /** Advances by dt seconds (0 = no step) and writes the (interpolated) outputs into `values`. */
  evaluate(values: Record<string, number>, dt: number): void {
    const val = (id: string) => values[id] ?? this.params.get(id)?.default ?? 0;
    this.remain += Math.max(0, dt);
    if (this.remain > MAX_DELTA) this.remain = 0;
    this.caches ??= new Map();
    if (!this.inputCaches) this.inputCaches = new Map([...this.params.keys()].map((id) => [id, val(id)]));
    const step = this.fps > 0 ? 1 / this.fps : LIVE2D_FRAME;
    while (this.remain >= step - 1e-9) {
      this.settings.forEach((_s, si) => this.previous[si].splice(0, this.previous[si].length, ...this.current[si]));
      // inputs at the step time: blend of the last inputs and the current values
      const iw = Math.min(1, step / this.remain);
      for (const id of this.params.keys()) {
        const v = (this.inputCaches.get(id) ?? val(id)) * (1 - iw) + val(id) * iw;
        this.caches.set(id, v);
        this.inputCaches.set(id, v);
      }
      const cache = (id: string) => this.caches!.get(id) ?? val(id);
      this.settings.forEach((s, si) => {
        const { tx, ty, angle } = this.inputs(s, cache);
        const strand = this.strands[si];
        if (!strand.length) return;
        updateStrand(strand, tx, ty, angle, MOVEMENT_THRESHOLD * s.normalization.position.max, step);
        s.outputs.forEach((o, oi) => {
          const v = this.outputValue(s, strand, o);
          if (v === undefined) return;
          this.current[si][oi] = v;
          this.write(o, v, cache, (id, x) => this.caches!.set(id, x));
        });
      });
      this.remain = Math.max(0, this.remain - step);
    }
    // without Fps the Framework shows the previous pendulum state
    const alpha = this.fps > 0 ? this.remain / step : 0;
    this.settings.forEach((s, si) =>
      s.outputs.forEach((o, oi) => {
        if (!this.params.has(o.param)) return;
        this.write(o, this.previous[si][oi] * (1 - alpha) + this.current[si][oi] * alpha, val, (id, x) => (values[id] = x));
      }),
    );
  }
}

function updateStrand(strand: Particle[], tx: number, ty: number, angle: number, threshold: number, dt: number): void {
  strand[0].position = { x: tx, y: ty };
  const g = { x: Math.sin(angle * DEG), y: Math.cos(angle * DEG) };
  const gl = Math.hypot(g.x, g.y) || 1;
  g.x /= gl;
  g.y /= gl;
  for (let i = 1; i < strand.length; i++) {
    const q = strand[i];
    const prev = strand[i - 1];
    const fx = g.x * q.acceleration;
    const fy = g.y * q.acceleration;
    q.last = { ...q.position };
    const delay = q.delay * dt * 30;
    const dir = { x: q.position.x - prev.position.x, y: q.position.y - prev.position.y };
    const r = dirToRad(q.lastGravity, g) / AIR_RESISTANCE;
    // in place, as in the Framework
    dir.x = Math.cos(r) * dir.x - dir.y * Math.sin(r);
    dir.y = Math.sin(r) * dir.x + dir.y * Math.cos(r);
    q.position = { x: prev.position.x + dir.x, y: prev.position.y + dir.y };
    q.position.x += q.velocity.x * delay + fx * delay * delay;
    q.position.y += q.velocity.y * delay + fy * delay * delay;
    const nd = { x: q.position.x - prev.position.x, y: q.position.y - prev.position.y };
    const nl = Math.hypot(nd.x, nd.y);
    if (nl > 0) {
      nd.x /= nl;
      nd.y /= nl;
    }
    q.position = { x: prev.position.x + nd.x * q.radius, y: prev.position.y + nd.y * q.radius };
    if (Math.abs(q.position.x) < threshold) q.position.x = 0;
    if (delay !== 0) {
      q.velocity = { x: ((q.position.x - q.last.x) / delay) * q.mobility, y: ((q.position.y - q.last.y) / delay) * q.mobility };
    }
    q.lastGravity = { ...g };
  }
}
