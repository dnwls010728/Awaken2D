// Independent reference evaluation of Spine skeleton data, written straight from Spine's runtime rules (not from
// Awaken2D's model): bone world transforms with shear, bone timelines with Spine 4 bezier curves (sampled like the
// runtime: 10 straight segments), region / mesh / weighted mesh vertices, deform timelines applied in bone-local
// (per influence) space. No constraints: constraints are checked against the official runtime
// (work/tools/spine-rt-compare.ts). Used to check that an imported model poses exactly like Spine would.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
type M = [number, number, number, number, number, number];

const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const local = (x: number, y: number, r: number, sx: number, sy: number, shx: number, shy: number): M => {
  const rx = ((r + shx) * Math.PI) / 180;
  const ry = ((r + 90 + shy) * Math.PI) / 180;
  return [Math.cos(rx) * sx, Math.sin(rx) * sx, Math.cos(ry) * sy, Math.sin(ry) * sy, x, y];
};

/** Value of channel c of a Spine 4 timeline at time t (keys with absolute bezier handles, 4 numbers per channel). */
/** Spine: before the first key a timeline leaves the setup value (`before`); from it on, keys interpolate. */
function sample(keys: Json[], t: number, c: number, get: (k: Json) => number, before?: number): number {
  if (before !== undefined && t < (keys[0].time ?? 0) - 1e-9) return before;
  if (t <= (keys[0].time ?? 0)) return get(keys[0]);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    const t0 = a.time ?? 0;
    const t1 = b.time ?? 0;
    if (t >= t1) continue;
    const v0 = get(a);
    const v1 = get(b);
    if (a.curve === "stepped") return v0;
    if (!Array.isArray(a.curve)) return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    const [cx1, cy1, cx2, cy2] = a.curve.slice(c * 4, c * 4 + 4);
    // like the runtime (CurveTimeline.setBezier / getBezierValue): the curve sampled at every tenth of its
    // parameter, straight lines in between
    const pts: number[] = [];
    for (let k = 1; k <= 9; k++) {
      const s = k / 10;
      pts.push((1 - s) ** 3 * t0 + 3 * (1 - s) ** 2 * s * cx1 + 3 * (1 - s) * s * s * cx2 + s ** 3 * t1);
      pts.push((1 - s) ** 3 * v0 + 3 * (1 - s) ** 2 * s * cy1 + 3 * (1 - s) * s * s * cy2 + s ** 3 * v1);
    }
    if (pts[0] > t) return v0 + ((t - t0) / (pts[0] - t0)) * (pts[1] - v0);
    for (let k = 2; k < 18; k += 2) if (pts[k] >= t) return pts[k - 1] + ((t - pts[k - 2]) / (pts[k] - pts[k - 2])) * (pts[k + 1] - pts[k - 1]);
    return pts[17] + ((t - pts[16]) / (t1 - pts[16])) * (v1 - pts[17]);
  }
  return get(keys[keys.length - 1]);
}

/** Slot colors (r, g, b, a in 0..1) of an animation at time t. */
export function spineSlotColors(json: Json, animation: string | null, t: number): Map<string, number[]> {
  const anim = animation ? json.animations[animation] : {};
  const out = new Map<string, number[]>();
  for (const slot of json.slots) {
    const setup = (slot.color ?? "ffffffff").padEnd(8, "f");
    const keys = anim.slots?.[slot.name]?.rgba;
    const ch = (c: string, i: number) => parseInt(c.slice(i * 2, i * 2 + 2), 16) / 255;
    out.set(slot.name, [0, 1, 2, 3].map((i) => (keys ? sample(keys, t, i, (k) => ch(k.color, i), ch(setup, i)) : ch(setup, i))));
  }
  return out;
}

/** World vertex positions of every drawable slot attachment (default skin) of an animation at time t. */
export function spinePose(json: Json, animation: string | null, t: number): Map<string, Array<[number, number]>> {
  const anim = animation ? json.animations[animation] : {};
  const world = new Map<string, M>();
  const boneIndex = json.bones.map((b: Json) => b.name);
  for (const b of json.bones) {
    const tl = anim.bones?.[b.name] ?? {};
    const rot = tl.rotate ? sample(tl.rotate, t, 0, (k) => k.value ?? 0, 0) : 0;
    const tx = tl.translate ? sample(tl.translate, t, 0, (k) => k.x ?? 0, 0) : 0;
    const ty = tl.translate ? sample(tl.translate, t, 1, (k) => k.y ?? 0, 0) : 0;
    const sx = tl.scale ? sample(tl.scale, t, 0, (k) => k.x ?? 1, 1) : 1;
    const sy = tl.scale ? sample(tl.scale, t, 1, (k) => k.y ?? 1, 1) : 1;
    const hx = tl.shear ? sample(tl.shear, t, 0, (k) => k.x ?? 0, 0) : 0;
    const hy = tl.shear ? sample(tl.shear, t, 1, (k) => k.y ?? 0, 0) : 0;
    const l = local((b.x ?? 0) + tx, (b.y ?? 0) + ty, (b.rotation ?? 0) + rot, (b.scaleX ?? 1) * sx, (b.scaleY ?? 1) * sy, (b.shearX ?? 0) + hx, (b.shearY ?? 0) + hy);
    world.set(b.name, b.parent ? mul(world.get(b.parent)!, l) : l);
  }
  const skin = (Array.isArray(json.skins) ? json.skins.find((s: Json) => s.name === "default") : { attachments: json.skins.default }).attachments;
  const out = new Map<string, Array<[number, number]>>();
  for (const slot of json.slots) {
    const tl = anim.slots?.[slot.name]?.attachment;
    let name = slot.attachment ?? null;
    if (tl) for (const k of tl) if ((k.time ?? 0) <= t + 1e-9) name = k.name ?? null;
    if (!name) continue;
    const a = skin[slot.name]?.[name];
    if (!a) continue;
    const bone = world.get(slot.bone)!;
    const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const type = a.type ?? "region";
    if (type === "region") {
      const w = a.width;
      const h = a.height;
      const r = ((a.rotation ?? 0) * Math.PI) / 180;
      const pts: Array<[number, number]> = [
        [-0.5, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ].map(([u, v]) => {
        const x = u * w * (a.scaleX ?? 1);
        const y = v * h * (a.scaleY ?? 1);
        return apply(bone, (a.x ?? 0) + x * Math.cos(r) - y * Math.sin(r), (a.y ?? 0) + x * Math.sin(r) + y * Math.cos(r));
      });
      out.set(slot.name, pts);
      continue;
    }
    if (type !== "mesh") continue;
    // deform keys for this attachment (4.2: animations.attachments.default.slot.name.deform)
    const dk: Json[] | undefined = anim.attachments?.default?.[slot.name]?.[name]?.deform ?? anim.deform?.default?.[slot.name]?.[name];
    const n = a.uvs.length / 2;
    const weighted = a.vertices.length !== a.uvs.length;
    const size = weighted ? (() => {
      let i = 0;
      let f = 0;
      for (let v = 0; v < n; v++) {
        const c = a.vertices[i];
        i += 1 + c * 4;
        f += c * 2;
      }
      return f;
    })() : n * 2;
    const deform = new Array(size).fill(0);
    if (dk?.length && t >= (dk[0].time ?? 0) - 1e-9) {
      // find surrounding keys and the curve percent
      let i = 0;
      while (i < dk.length - 1 && (dk[i + 1].time ?? 0) <= t) i++;
      const a0 = dk[i];
      const b0 = dk[Math.min(i + 1, dk.length - 1)];
      const full = (k: Json) => {
        const arr = new Array(size).fill(0);
        (k.vertices ?? []).forEach((v: number, j: number) => (arr[(k.offset ?? 0) + j] = v));
        return arr;
      };
      const va = full(a0);
      const vb = full(b0);
      let f = 0;
      if (b0 !== a0 && t > (a0.time ?? 0)) f = sample([{ ...a0, p: 0 }, { ...b0, p: 1 }], t, 0, (k) => k.p);
      for (let j = 0; j < size; j++) deform[j] = va[j] + (vb[j] - va[j]) * f;
    }
    const pts: Array<[number, number]> = [];
    if (!weighted) {
      for (let v = 0; v < n; v++) pts.push(apply(bone, a.vertices[v * 2] + deform[v * 2], a.vertices[v * 2 + 1] + deform[v * 2 + 1]));
    } else {
      let i = 0;
      let f = 0;
      for (let v = 0; v < n; v++) {
        const c = a.vertices[i++];
        let x = 0;
        let y = 0;
        for (let k = 0; k < c; k++) {
          const m = world.get(boneIndex[a.vertices[i]])!;
          const p = apply(m, a.vertices[i + 1] + deform[f], a.vertices[i + 2] + deform[f + 1]);
          x += p[0] * a.vertices[i + 3];
          y += p[1] * a.vertices[i + 3];
          i += 4;
          f += 2;
        }
        pts.push([x, y]);
      }
    }
    out.set(slot.name, pts);
  }
  return out;
}
