// Proposes a skeleton for an imported layered model. Output is a list of ops plus a report,
// so an agent (or human) can review, edit, and then apply it.
import { distToSegment, round } from "../core/math.ts";
import type { Op } from "../core/ops.ts";
import type { Model, Vec2 } from "../core/types.ts";
import type { ImportedLayerInfo } from "./layers.ts";

export type Role =
  | "head" | "torso" | "hip" | "neck"
  | "upper_arm" | "lower_arm" | "hand" | "arm"
  | "thigh" | "shin" | "foot" | "leg"
  | "face" | "hair" | "tail" | "other";

type Side = "l" | "r" | "";

export interface LayerAnalysis {
  slot: string;
  name: string;
  role: Role;
  side: Side;
  centroid: Vec2;
  /** Principal axis end points (world). */
  axis: [Vec2, Vec2];
  /** Major / minor extent ratio. */
  elongation: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface Proposal {
  ops: Op[];
  report: string[];
  layers: LayerAnalysis[];
}

// keyword tables (English + Korean); order matters: more specific first
const ROLE_WORDS: Array<[Role, RegExp]> = [
  ["face", /eye|brow|lash|pupil|iris|mouth|lip|teeth|tongue|nose|cheek|blush|(^|[^a-z])ears?([^a-z]|$)|눈|입|코|볼|귀|입술|눈썹|동공/i],
  ["hair", /hair|bang|fringe|ponytail|머리카락|앞머리|뒷머리|옆머리|헤어/i],
  ["neck", /neck|목(?!걸)/i],
  ["head", /head|face|skull|머리|얼굴|두부/i],
  ["upper_arm", /upper[\s_-]?arm|arm[\s_-]?upper|shoulder|bicep|상완|윗팔|위팔|어깨/i],
  ["lower_arm", /fore[\s_-]?arm|lower[\s_-]?arm|arm[\s_-]?lower|전완|아래팔|팔뚝/i],
  ["hand", /hand|fist|palm|finger|손/i],
  ["thigh", /thigh|upper[\s_-]?leg|leg[\s_-]?upper|허벅지|윗다리/i],
  ["shin", /shin|calf|lower[\s_-]?leg|leg[\s_-]?lower|종아리|정강이|아랫다리/i],
  ["foot", /foot|feet|shoe|boot|발(?!목걸)|신발/i],
  ["hip", /hip|pelvis|waist|skirt|pants|shorts|골반|엉덩이|허리|치마|바지/i],
  ["torso", /torso|body|chest|trunk|shirt|coat|jacket|몸통|몸|가슴|상체|옷/i],
  ["arm", /arm|팔/i],
  ["leg", /leg|다리/i],
  ["tail", /tail|꼬리/i],
];

function classify(text: string): Role {
  for (const [role, re] of ROLE_WORDS) if (re.test(text)) return role;
  return "other";
}

function sideOf(text: string): Side {
  if (/(^|[\s_\-./(])(l|left)([\s_\-./)]|$)|left|왼|좌/i.test(text)) return "l";
  if (/(^|[\s_\-./(])(r|right)([\s_\-./)]|$)|right|오른|우(측|쪽)/i.test(text)) return "r";
  return "";
}

/** PCA over mesh vertices (grid points sample the layer's solid area). */
function analyze(points: Vec2[]): { centroid: Vec2; axis: [Vec2, Vec2]; elongation: number } {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - cx) ** 2;
    syy += (y - cy) ** 2;
    sxy += (x - cx) * (y - cy);
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let lo = Infinity;
  let hi = -Infinity;
  let mlo = Infinity;
  let mhi = -Infinity;
  for (const [x, y] of points) {
    const p = (x - cx) * dx + (y - cy) * dy;
    const q = -(x - cx) * dy + (y - cy) * dx;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
    mlo = Math.min(mlo, q);
    mhi = Math.max(mhi, q);
  }
  const major = hi - lo;
  const minor = Math.max(mhi - mlo, 1e-6);
  return {
    centroid: [cx, cy],
    axis: [
      [cx + dx * lo, cy + dy * lo],
      [cx + dx * hi, cy + dy * hi],
    ],
    elongation: major / minor,
  };
}

const r2 = (p: Vec2): Vec2 => [round(p[0], 1), round(p[1], 1)];
const mix = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const d2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function analyzeLayers(model: Model): LayerAnalysis[] {
  const meta = (model.meta?.import as { layers?: ImportedLayerInfo[] } | undefined)?.layers ?? [];
  const out: LayerAnalysis[] = [];
  for (const slot of model.slots) {
    // hidden imported layers keep their attachment under the slot id while the slot is empty
    const att = model.attachments[slot.attachment ?? slot.id];
    if (!att || att.vertices.length < 3) continue;
    const info = meta.find((l) => l.slot === slot.id);
    const name = info?.name ?? slot.id;
    const groupText = (info?.groups ?? []).join(" ");
    const nameRole = classify(name);
    const a = analyze(att.vertices);
    const xs = att.vertices.map((v) => v[0]);
    const ys = att.vertices.map((v) => v[1]);
    out.push({
      slot: slot.id,
      name,
      // the layer's own name wins; enclosing group names are the fallback
      role: nameRole === "other" ? classify(groupText) : nameRole,
      side: sideOf(name) || sideOf(groupText),
      ...a,
      bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    });
  }
  return out;
}

interface PlannedBone {
  id: string;
  parent: string;
  start: Vec2;
  end: Vec2;
}

/**
 * Heuristic skeleton from layer names (English/Korean keywords) and shapes:
 * torso/hip/head get vertical bones, limbs get bones along their principal axis oriented away from
 * their parent, single-layer arms/legs get two bones, face parts and hair ride on the head,
 * and unnamed elongated layers become bones attached to the nearest existing bone.
 */
export interface ProposeOptions {
  /** Add two-bone IK (with targets) to arm and leg chains, joints bending outward. */
  ik?: boolean;
  /** Turn tails and other dangling elongated layers into 3-bone spring chains. */
  physics?: boolean;
}

export function proposeBones(model: Model, opts: ProposeOptions = {}): Proposal {
  const layers = analyzeLayers(model);
  const report: string[] = [];
  const bones: PlannedBone[] = [];
  const binding = new Map<string, string[]>(); // slot -> bones for weights
  const existing = new Set(model.bones.map((b) => b.id));
  const taken = new Set(existing);
  const uid = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    return id;
  };
  const byRole = (role: Role) => layers.filter((l) => l.role === role);
  const find = (id: string) => bones.find((b) => b.id === id);

  // body center decides sides for unlabeled limbs: +x is the character's left (viewer's right)
  const torsoL = byRole("torso")[0];
  const all = layers.reduce(
    (b, l) => ({ minX: Math.min(b.minX, l.bounds.minX), maxX: Math.max(b.maxX, l.bounds.maxX), minY: Math.min(b.minY, l.bounds.minY), maxY: Math.max(b.maxY, l.bounds.maxY) }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
  const centerX = torsoL ? torsoL.centroid[0] : (all.minX + all.maxX) / 2;
  for (const l of layers) if (!l.side && ["upper_arm", "lower_arm", "hand", "arm", "thigh", "shin", "foot", "leg"].includes(l.role)) l.side = l.centroid[0] >= centerX ? "l" : "r";

  const vertical = (l: LayerAnalysis): [Vec2, Vec2] => [
    [l.centroid[0], l.bounds.minY],
    [l.centroid[0], l.bounds.maxY],
  ];
  /** Axis endpoints ordered so the start is nearest the anchor; ends inset to sit inside rounded caps. */
  const oriented = (l: LayerAnalysis, anchor: Vec2): [Vec2, Vec2] => {
    let [a, b] = l.axis;
    if (d2(b, anchor) < d2(a, anchor)) [a, b] = [b, a];
    const inset = Math.min(0.12, 0.5 / Math.max(l.elongation, 1));
    return [mix(a, b, inset), mix(a, b, 1 - inset)];
  };
  const add = (id: string, parent: string, start: Vec2, end: Vec2, why: string) => {
    if (d2(start, end) < 1e-3) end = [start[0], start[1] + 1];
    bones.push({ id, parent, start: r2(start), end: r2(end) });
    report.push(`bone ${id} (parent ${parent}): ${why}`);
    return id;
  };

  // core: hip -> torso -> neck -> head
  let hip = "root";
  let torso = "root";
  const hipL = byRole("hip")[0];
  if (torsoL) {
    const [s, e] = vertical(torsoL);
    const hipStart: Vec2 = hipL ? [hipL.centroid[0], hipL.bounds.maxY] : s;
    hip = add(uid("hip"), "root", hipStart, mix(hipStart, e, 0.15), hipL ? `from hip layer "${hipL.name}"` : `base of torso layer "${torsoL.name}"`);
    torso = add(uid("torso"), hip, mix(hipStart, e, 0.15), e, `vertical through torso layer "${torsoL.name}"`);
    binding.set(torsoL.slot, [hip, torso]);
    if (hipL) binding.set(hipL.slot, [hip]);
  } else if (hipL) {
    const [s, e] = vertical(hipL);
    hip = torso = add(uid("hip"), "root", s, e, `hip layer "${hipL.name}" (no torso layer found)`);
    binding.set(hipL.slot, [hip]);
  }
  let neckParent = torso;
  for (const l of byRole("neck")) {
    const [s, e] = vertical(l);
    neckParent = add(uid("neck"), torso, s, e, `neck layer "${l.name}"`);
    binding.set(l.slot, [neckParent]);
  }
  let head = torso;
  const headL = byRole("head").sort((a, b) => (b.bounds.maxX - b.bounds.minX) * (b.bounds.maxY - b.bounds.minY) - (a.bounds.maxX - a.bounds.minX) * (a.bounds.maxY - a.bounds.minY))[0];
  if (headL) {
    const [s, e] = vertical(headL);
    head = add(uid("head"), neckParent, s, e, `vertical through head layer "${headL.name}"`);
    for (const l of byRole("head")) binding.set(l.slot, [head]);
  }

  // limbs; two-bone chains are remembered for optional IK
  const chains: Array<{ upper: string; lower: string; end?: string; side: "l" | "r"; kind: "arm" | "leg" }> = [];
  const limb = (upper: Role, lower: Role, end: Role, whole: Role, rootBone: string, names: [string, string, string], kind: "arm" | "leg") => {
    for (const side of ["l", "r"] as const) {
      const suffix = `_${side}`;
      let parent = rootBone;
      const made = new Map<Role, string>();
      const chain: Array<[Role, string]> = [
        [upper, names[0]],
        [lower, names[1]],
        [end, names[2]],
      ];
      for (const [role, base] of chain) {
        const l = layers.find((x) => x.role === role && x.side === side);
        if (!l) continue;
        const p = find(parent);
        const anchor = p ? p.end : l.centroid;
        const [s, e] = oriented(l, anchor);
        parent = add(uid(base + suffix), parent, s, e, `principal axis of "${l.name}"`);
        made.set(role, parent);
        binding.set(l.slot, [parent]);
      }
      const u = made.get(upper);
      const lo = made.get(lower);
      if (u && lo && find(lo)?.parent === u) chains.push({ upper: u, lower: lo, end: made.get(end), side, kind });
      for (const l of layers.filter((x) => x.role === whole && x.side === side)) {
        const p = find(rootBone);
        const [s, e] = oriented(l, p ? p.end : l.centroid);
        const knee = mix(s, e, 0.5);
        const a = add(uid(names[0] + suffix), rootBone, s, knee, `upper half of single-layer "${l.name}"`);
        const b = add(uid(names[1] + suffix), a, knee, e, `lower half of single-layer "${l.name}"`);
        binding.set(l.slot, [a, b]);
        chains.push({ upper: a, lower: b, side, kind });
      }
    }
  };
  limb("upper_arm", "lower_arm", "hand", "arm", torso, ["upper_arm", "lower_arm", "hand"], "arm");
  limb("thigh", "shin", "foot", "leg", hip, ["thigh", "shin", "foot"], "leg");

  // face parts and hair ride on the head
  for (const l of layers.filter((x) => x.role === "face" || x.role === "hair")) {
    binding.set(l.slot, [head]);
    report.push(`slot ${l.slot} ("${l.name}", ${l.role}) bound to ${head}`);
  }

  // anything else: elongated -> own bone from the nearest bone, compact -> ride on the nearest bone
  const springs: Array<{ id: string; bones: string[]; name: string }> = [];
  const nearestBone = (p: Vec2): PlannedBone | undefined =>
    bones.slice().sort((a, b) => distToSegment(p, a.start, a.end) - distToSegment(p, b.start, b.end))[0];
  const rest = layers.filter((l) => !binding.has(l.slot)).sort((a, b) => d2(a.centroid, [centerX, 0]) - d2(b.centroid, [centerX, 0]));
  for (const l of rest) {
    if (l.elongation >= 2.2 || l.role === "tail") {
      // attach at whichever axis end is closest to any existing bone (a tail meets the hip, not the arm it overlaps)
      let best: { bone?: PlannedBone; start: Vec2; end: Vec2; d: number } = { start: l.axis[0], end: l.axis[1], d: Infinity };
      // tails grow from the pelvis/spine, never from a limb they happen to overlap
      const core = bones.filter((b) => b.id === hip || b.id === torso);
      const candidates = l.role === "tail" && core.length ? core : bones;
      for (const b of candidates) {
        for (const [s, e] of [l.axis, [l.axis[1], l.axis[0]]] as Array<[Vec2, Vec2]>) {
          const d = distToSegment(s, b.start, b.end);
          if (d < best.d) best = { bone: b, start: s, end: e, d };
        }
      }
      const base = l.role === "other" ? l.slot : l.role;
      if (opts.physics) {
        // dangling part: a 3-segment chain that a spring can bend smoothly
        const ids: string[] = [];
        let parent = best.bone?.id ?? "root";
        for (let k = 0; k < 3; k++) {
          const s = mix(best.start, best.end, k / 3);
          const e = mix(best.start, best.end, (k + 1) / 3);
          parent = add(uid(`${base}_${k + 1}`), parent, s, e, `segment ${k + 1}/3 of elongated layer "${l.name}"`);
          ids.push(parent);
        }
        binding.set(l.slot, ids);
        springs.push({ id: uid(`${base}_spring`), bones: ids, name: l.name });
      } else {
        const id = add(uid(base), best.bone?.id ?? "root", best.start, best.end, `elongated layer "${l.name}" (x${round(l.elongation, 1)})`);
        binding.set(l.slot, [id]);
      }
    } else {
      const near = nearestBone(l.centroid);
      binding.set(l.slot, [near?.id ?? "root"]);
      report.push(`slot ${l.slot} ("${l.name}") bound to ${near?.id ?? "root"} (compact shape, no own bone)`);
    }
  }

  const ops: Op[] = bones.map((b) => ({ op: "addBone", id: b.id, parent: b.parent, start: b.start, end: b.end }));
  for (const [slot, bs] of binding) {
    const att = model.slots.find((s) => s.id === slot)?.attachment ?? slot;
    ops.push({ op: "updateSlot", id: slot, bone: bs[0] });
    ops.push({ op: "autoWeight", attachment: att, bones: bs, maxInfluences: 2 });
  }
  for (const s of springs) {
    ops.push({ op: "addPhysics", id: s.id, bones: s.bones, frequency: 2.5, damping: 0.35, inertia: 1, limit: 60 });
    report.push(`physics ${s.id}: spring chain ${s.bones.join(" -> ")} for "${s.name}" (add gravity to make it droop)`);
  }
  if (opts.ik) {
    for (const c of chains) {
      const u = find(c.upper)!;
      const lo = find(c.lower)!;
      // bend the joint outward, away from the body (+x is the character's left):
      // bendPositive puts the joint on the clockwise side of the start->tip line, i.e. along (dy, -dx)
      const dx = lo.end[0] - u.start[0];
      const dy = lo.end[1] - u.start[1];
      const outward = c.side === "l" ? 1 : -1;
      const bendPositive = dy * outward > 0;
      const id = uid(`${c.kind}_${c.side}_ik`);
      ops.push({ op: "addIk", id, bones: [c.upper, c.lower], bendPositive });
      if (c.kind === "leg" && c.end) {
        // feet follow the IK target so they stay flat on the ground while the knee bends
        ops.push({ op: "updateBone", id: c.end, parent: id + "_target" });
        report.push(`bone ${c.end} re-parented to ${id}_target (stays level while the leg bends)`);
      }
      report.push(`IK ${id}: ${c.upper} -> ${c.lower}, target ${id}_target at the ${c.kind === "leg" ? "ankle" : "wrist"}, joint bends outward`);
    }
  }
  report.unshift(
    `layers: ${layers.map((l) => `${l.slot}=${l.role}${l.side ? "(" + l.side + ")" : ""}`).join(", ")}`,
    `sides: +x is the character's left (viewer's right)`,
  );
  return { ops, report, layers };
}
