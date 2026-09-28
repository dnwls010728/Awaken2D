import { angleOf, round } from "./math.ts";
import { boneEnds, computePose, drawList, poseBounds } from "./pose.ts";
import type { Model, Vec2 } from "./types.ts";

const fmt = (n: number) => String(round(n, 2));
const pt = (p: Vec2) => `(${fmt(p[0])}, ${fmt(p[1])})`;

export interface ModelSummary {
  name: string;
  format: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  bones: Array<{
    id: string;
    parent: string | null;
    depth: number;
    local: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; length: number };
    worldStart: Vec2;
    worldEnd: Vec2;
    worldAngle: number;
  }>;
  slots: Array<{
    index: number;
    id: string;
    bone: string;
    attachment: string | null;
    mesh?: { vertices: number; triangles: number; fill: string; bounds: [Vec2, Vec2]; influences: Record<string, number> };
  }>;
  ik: Array<{ id: string; bones: string[]; target: string; mix: number; bendPositive: boolean; targetWorld: Vec2 }>;
  animations: Array<{ name: string; duration: number; loop: boolean; tracks: string[] }>;
}

/** Structured summary of a model in its setup pose (what an agent needs to reason about it). */
export function summarizeModel(model: Model): ModelSummary {
  const pose = computePose(model);
  const items = drawList(model, pose, pose);
  const b = poseBounds(items, pose);
  const depth = new Map<string, number>();
  for (const bp of pose.bones) {
    const src = model.bones.find((x) => x.id === bp.id)!;
    depth.set(bp.id, src.parent === null ? 0 : (depth.get(src.parent) ?? 0) + 1);
  }
  // tree order: depth-first by children in file order
  const children = new Map<string | null, string[]>();
  for (const bone of model.bones) children.set(bone.parent, [...(children.get(bone.parent) ?? []), bone.id]);
  const treeOrder: string[] = [];
  const walk = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    treeOrder.push(id);
    for (const c of children.get(id) ?? []) walk(c, seen);
  };
  const seen = new Set<string>();
  for (const r of children.get(null) ?? []) walk(r, seen);

  return {
    name: model.name,
    format: model.format,
    bounds: Number.isFinite(b.minX) ? { minX: round(b.minX, 2), minY: round(b.minY, 2), maxX: round(b.maxX, 2), maxY: round(b.maxY, 2) } : null,
    bones: treeOrder.map((id) => {
      const src = model.bones.find((x) => x.id === id)!;
      const p = pose.byId.get(id)!;
      const e = boneEnds(p);
      return {
        id,
        parent: src.parent,
        depth: depth.get(id) ?? 0,
        local: { x: src.x, y: src.y, rotation: src.rotation, scaleX: src.scaleX, scaleY: src.scaleY, length: src.length },
        worldStart: [round(e.start[0], 2), round(e.start[1], 2)],
        worldEnd: [round(e.end[0], 2), round(e.end[1], 2)],
        worldAngle: round(angleOf(p.world), 2),
      };
    }),
    slots: model.slots.map((s, index) => {
      const a = s.attachment ? model.attachments[s.attachment] : undefined;
      const out: ModelSummary["slots"][number] = { index, id: s.id, bone: s.bone, attachment: s.attachment };
      if (a) {
        const infl: Record<string, number> = {};
        for (const w of a.weights) for (const [bid, v] of w) infl[bid] = (infl[bid] ?? 0) + v;
        const total = Object.values(infl).reduce((x, y) => x + y, 0) || 1;
        for (const k of Object.keys(infl)) infl[k] = round((infl[k] / total) * 100, 1);
        const xs = a.vertices.map((v) => v[0]);
        const ys = a.vertices.map((v) => v[1]);
        out.mesh = {
          vertices: a.vertices.length,
          triangles: a.triangles.length,
          fill: a.image ? `image:${a.image}` : (a.color ?? "#888888"),
          bounds: [
            [round(Math.min(...xs), 2), round(Math.min(...ys), 2)],
            [round(Math.max(...xs), 2), round(Math.max(...ys), 2)],
          ],
          influences: infl,
        };
      }
      return out;
    }),
    ik: (model.ik ?? []).map((c) => {
      const t = pose.byId.get(c.target);
      return { ...c, targetWorld: t ? ([round(t.world[4], 2), round(t.world[5], 2)] as Vec2) : ([NaN, NaN] as Vec2) };
    }),
    animations: Object.entries(model.animations ?? {}).map(([name, anim]) => ({
      name,
      duration: anim.duration,
      loop: anim.loop !== false,
      tracks: [
        ...Object.entries(anim.bones ?? {}).flatMap(([bid, tl]) =>
          Object.entries(tl).map(([ch, keys]) => `bone ${bid}.${ch} (${(keys as unknown[]).length} keys)`),
        ),
        ...Object.entries(anim.slots ?? {}).flatMap(([sid, tl]) =>
          Object.entries(tl).map(([ch, keys]) => `slot ${sid}.${ch} (${(keys as unknown[]).length} keys)`),
        ),
        ...Object.entries(anim.params ?? {}).map(([pid, keys]) => `param ${pid} (${keys.length} keys)`),
        ...Object.entries(anim.physics ?? {}).flatMap(([pid, tl]) =>
          Object.entries(tl).map(([ch, keys]) => `physics ${pid}.${ch} (${(keys as unknown[]).length} keys)`),
        ),
        ...Object.entries(anim.ik ?? {}).flatMap(([iid, tl]) =>
          Object.entries(tl).map(([ch, keys]) => `ik ${iid}.${ch} (${(keys as unknown[]).length} keys)`),
        ),
      ],
    })),
  };
}

export function describeModel(model: Model): string {
  const s = summarizeModel(model);
  const lines: string[] = [];
  lines.push(`Model "${s.name}" (${s.format}); coordinates: +x right, +y up, degrees CCW`);
  lines.push(model.target === "live2d" ? "Target: Live2D (parameters, keyforms, deformers, parts; no bones)" : model.target === "spine" ? "Target: Spine2D (bones, weights, IK, spring bones, timelines; no parameters)" : "Target: not set (older file; setTarget spine|live2d)");
  if (s.bounds) lines.push(`Setup bounds: x ${fmt(s.bounds.minX)}..${fmt(s.bounds.maxX)}, y ${fmt(s.bounds.minY)}..${fmt(s.bounds.maxY)}`);
  lines.push("", `Bones (${s.bones.length}) - local transform | world start -> end @ angle:`);
  for (const b of s.bones) {
    const l = b.local;
    const extra = [l.scaleX !== 1 || l.scaleY !== 1 ? `scale=(${fmt(l.scaleX)}, ${fmt(l.scaleY)})` : ""].filter(Boolean).join(" ");
    lines.push(
      `${"  ".repeat(b.depth + 1)}${b.id}: pos=${pt([l.x, l.y])} rot=${fmt(l.rotation)} len=${fmt(l.length)}${extra ? " " + extra : ""}` +
        ` | ${pt(b.worldStart)} -> ${pt(b.worldEnd)} @ ${fmt(b.worldAngle)}deg`,
    );
  }
  lines.push("", `Slots (${s.slots.length}) in draw order, back to front:`);
  for (const sl of s.slots) {
    let line = `  ${sl.index}. ${sl.id} [bone ${sl.bone}] -> ${sl.attachment ?? "(empty)"}`;
    if (sl.mesh) {
      const infl = Object.entries(sl.mesh.influences).map(([k, v]) => `${k} ${v}%`).join(", ");
      line += ` | mesh ${sl.mesh.vertices}v/${sl.mesh.triangles}t, ${sl.mesh.fill}, bounds ${pt(sl.mesh.bounds[0])}..${pt(sl.mesh.bounds[1])}, weights: ${infl}`;
    }
    lines.push(line);
  }
  const unused = Object.keys(model.attachments).filter((id) => !model.slots.some((sl) => sl.attachment === id));
  if (unused.length) lines.push(`  (attachments not in setup pose: ${unused.join(", ")})`);
  if (s.ik.length) {
    lines.push("", `IK constraints (${s.ik.length}), applied in order (bone world positions above are before IK):`);
    for (const c of s.ik) {
      lines.push(`  ${c.id}: ${c.bones.join(" -> ")} reaches for ${c.target} at ${pt(c.targetWorld)}, mix ${c.mix}, bend ${c.bendPositive ? "positive (CCW)" : "negative (CW)"}`);
    }
  }
  // Live2D objects keyed on each parameter (keyforms live on the objects)
  const l2dUse = new Map<string, { keys: Set<number>; objects: string[] }>();
  const addUse = (id: string, grid: { params: string[]; keys: number[][] } | undefined) => {
    grid?.params.forEach((p, i) => {
      const u = l2dUse.get(p) ?? { keys: new Set<number>(), objects: [] };
      grid.keys[i].forEach((k) => u.keys.add(k));
      u.objects.push(id);
      l2dUse.set(p, u);
    });
  };
  for (const [id, a] of Object.entries(model.attachments)) addUse(id, a.live2d?.grid);
  for (const d of model.live2d?.deformers ?? []) addUse(d.id, d.grid);
  for (const pt of model.live2d?.parts ?? []) addUse(pt.id, pt.grid);
  for (const g of model.live2d?.glue ?? []) addUse(g.id, g.grid);
  if (model.parameters?.length) {
    lines.push("", `Parameters (${model.parameters.length}) - value range [default]: what they drive`);
    for (const p of model.parameters) {
      const use = l2dUse.get(p.id);
      const drives = [
        ...(use ? [`Live2D keyforms of ${use.objects.length <= 6 ? use.objects.join(", ") : `${use.objects.slice(0, 6).join(", ")} +${use.objects.length - 6} more`}`] : []),
        ...Object.entries(p.bones ?? {}).map(([b, tl]) => `bone ${b}.${Object.keys(tl).join("/")}`),
        ...Object.entries(p.slots ?? {}).map(([s, tl]) => `slot ${s}.${Object.keys(tl).join("/")}`),
        ...Object.keys(p.meshes ?? {}).map((a) => `shape ${a}`),
        ...Object.keys(p.warps ?? {}).map((w) => `warp ${w}`),
      ];
      const keyed = [...new Set([
        ...Object.values(p.bones ?? {}).flatMap((tl) => Object.values(tl).flatMap((k) => (k as Array<{ at: number }>).map((x) => x.at))),
        ...Object.values(p.slots ?? {}).flatMap((tl) => Object.values(tl).flatMap((k) => (k as Array<{ at: number }>).map((x) => x.at))),
        ...Object.values(p.meshes ?? {}).flatMap((k) => k.map((x) => x.at)),
        ...Object.values(p.warps ?? {}).flatMap((k) => k.map((x) => x.at)),
        ...(use?.keys ?? []),
      ])].sort((a, b) => a - b);
      lines.push(`  ${p.id}${p.name ? ` "${p.name}"` : ""}: ${p.min}..${p.max} [${p.default}]${p.repeat ? " repeat" : ""} keys at ${keyed.join(", ") || "-"}: ${drives.join(", ") || "(drives nothing yet)"}`);
    }
  }
  if (model.warps?.length) {
    lines.push("", `Warp deformers (${model.warps.length}), applied in order before skinning:`);
    for (const w of model.warps) {
      const r = w.rect;
      lines.push(`  ${w.id}: ${w.cols}x${w.rows} cells over x ${fmt(r.x)}..${fmt(r.x + r.width)}, y ${fmt(r.y)}..${fmt(r.y + r.height)} -> ${w.targets.join(", ")}`);
    }
  }
  if (model.combos?.length) {
    lines.push("", `Combination keyforms (${model.combos.length}), added on top of the parameters' own effects:`);
    for (const c of model.combos) {
      const targets = new Set(c.keys.flatMap((k) => [...Object.keys(k.bones ?? {}).map((b) => `bone ${b}`), ...Object.keys(k.meshes ?? {}).map((a) => `shape of ${a}`), ...Object.keys(k.warps ?? {}).map((w) => `warp ${w}`)]));
      lines.push(`  ${c.id}: ${c.params.join(" x ")} | keys at ${c.keys.map((k) => `(${k.at.join(", ")})`).join(" ") || "(none)"} | drives ${[...targets].join(", ") || "nothing yet"}`);
    }
  }
  if (model.physics?.length) {
    lines.push("", `Spring bones (${model.physics.length}), simulated after IK:`);
    for (const c of model.physics) {
      lines.push(
        `  ${c.id}: ${c.bones.join(", ")} | ${c.frequency} Hz, damping ${c.damping}, gravity (${c.gravity.join(", ")}), inertia ${c.inertia}, mix ${c.mix}${c.limit ? `, limit ${c.limit}deg` : ""}`,
      );
    }
  }
  const rig = model.live2d;
  if (rig) {
    const grid = (g: { params: string[]; keys: number[][] }) => (g.params.length ? g.params.map((p, i) => `${p}[${g.keys[i].join(",")}]`).join(" x ") : "no keys");
    const meshes = Object.entries(model.attachments).filter(([, a]) => a.live2d);
    lines.push("", `Live2D rig: ${meshes.length} art meshes, ${rig.deformers.length} deformers, ${rig.parts.length} parts, ${rig.glue?.length ?? 0} glue; canvas ${rig.canvas.width}x${rig.canvas.height} px (${rig.canvas.pixelsPerUnit} px per unit)`);
    lines.push("Deformers (children indented; points of a child live in its parent's space):");
    const kids = new Map<string | null, string[]>();
    for (const d of rig.deformers) kids.set(d.parent, [...(kids.get(d.parent) ?? []), d.id]);
    const meshKids = new Map<string | null, string[]>();
    for (const [id, a] of meshes) meshKids.set(a.live2d!.deformer, [...(meshKids.get(a.live2d!.deformer) ?? []), id]);
    const byId = new Map(rig.deformers.map((d) => [d.id, d]));
    const walk = (parent: string | null, depth: number) => {
      for (const id of kids.get(parent) ?? []) {
        const d = byId.get(id)!;
        const ms = meshKids.get(id) ?? [];
        lines.push(`${"  ".repeat(depth + 1)}${id}: ${d.type === "warp" ? `warp ${d.cols}x${d.rows}` : "rotation"}, ${grid(d.grid)}${d.part ? `, part ${d.part}` : ""}${ms.length ? `; meshes ${ms.length <= 8 ? ms.join(", ") : `${ms.slice(0, 8).join(", ")} +${ms.length - 8}`}` : ""}`);
        if (depth < 12) walk(id, depth + 1);
      }
    };
    walk(null, 0);
    const rootMeshes = meshKids.get(null) ?? [];
    if (rootMeshes.length) lines.push(`  (on the canvas: ${rootMeshes.join(", ")})`);
    lines.push(`Parts: ${rig.parts.map((p) => `${p.id}${p.name ? ` "${p.name}"` : ""}${p.parent ? ` < ${p.parent}` : ""}${p.visible === false ? " (hidden)" : ""}`).join(", ")}`);
    if (rig.pose?.groups.length) lines.push(`Pose groups (one part shown each): ${rig.pose.groups.map((g) => g.map((p) => p.part).join(" | ")).join("; ")}`);
    if (rig.physics?.settings.length) {
      lines.push(`Physics (${rig.physics.settings.length} pendulums):`);
      for (const ps of rig.physics.settings) lines.push(`  ${ps.id}${ps.name ? ` "${ps.name}"` : ""}: ${ps.inputs.map((i) => `${i.param}(${i.type})`).join(" + ")} -> ${ps.outputs.map((o) => o.param).join(", ")}`);
    }
  }
  lines.push("", `Animations (${s.animations.length}):`);
  for (const a of s.animations) {
    lines.push(`  ${a.name}: ${a.duration}s ${a.loop ? "loop" : "once"}`);
    for (const t of a.tracks) lines.push(`    ${t}`);
  }
  return lines.join("\n");
}
