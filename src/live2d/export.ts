// Awaken2D model -> Live2D runtime data: moc3 (binary) + model3 / motion3 / physics3 / cdi3 / pose3 JSON. Pure.
// The Live2D rig (keyforms, deformers, parts, glue, draw-order groups) is written as it is; meshes without Live2D
// keyforms become static art meshes at their setup shape. Bones, slot timelines and spring bones have no Live2D
// counterpart and are reported.
import { isChannelEases } from "../core/animation.ts";
import type { Animation, Deformer, DrawOrderGroup, Ease, Key, KeyformGrid, MeshAttachment, Model, Part } from "../core/types.ts";
import { COUNT_NAMES, fieldsFor } from "./moc3.ts";
import type { CountName, Moc3Array, Moc3Data, Moc3Version } from "./moc3.ts";
import { live2dMeta } from "./import.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface Live2DExport {
  moc: Moc3Data;
  model3: Json;
  motions: Array<{ file: string; json: Json }>;
  physics?: Json;
  displayInfo?: Json;
  pose?: Json;
  userData?: Json;
  expressions: Array<{ file: string; json: Json }>;
  /** Image ids of the textures, by texture number (written as textures/<id>.png). */
  textures: string[];
  warnings: string[];
}

const FPS_DEFAULT = 30;

/** Topological order (parents first) of items with a parent reference. */
function parentsFirst<T extends { id: string }>(items: T[], parentOf: (t: T) => string | null): T[] {
  const byId = new Map(items.map((t) => [t.id, t]));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (t: T, depth: number) => {
    if (seen.has(t.id) || depth > items.length) return;
    const p = parentOf(t);
    if (p && byId.has(p)) visit(byId.get(p)!, depth + 1);
    seen.add(t.id);
    out.push(t);
  };
  for (const t of items) visit(t, 0);
  return out;
}

export function exportLive2DData(model: Model, opts: { name: string; version?: Moc3Version }): Live2DExport {
  const warnings: string[] = [];
  const meta = live2dMeta(structuredClone({ meta: model.meta }) as Model);
  const rig = model.live2d ?? { canvas: defaultCanvas(model), parts: [], deformers: [] };
  const params = model.parameters ?? [];
  const paramIndex = new Map(params.map((p, i) => [p.id, i]));

  // ---- art meshes: every slot whose setup attachment is a mesh, in the moc3's original order when known
  const slotOf = new Map<string, string>(); // attachment -> slot
  for (const s of model.slots) if (s.attachment && !slotOf.has(s.attachment)) slotOf.set(s.attachment, s.id);
  const meshIds = [...slotOf.keys()].filter((a) => model.attachments[a]?.type === "mesh");
  const order = meta.meshOrder ?? [];
  const rank = new Map(order.map((id, i) => [id, i]));
  meshIds.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  const meshIndex = new Map(meshIds.map((id, i) => [id, i]));
  const slotIndex = new Map(meshIds.map((id, i) => [slotOf.get(id)!, i]));
  const staticMeshes = meshIds.filter((id) => !model.attachments[id].live2d);
  if (staticMeshes.length) warnings.push(`${staticMeshes.length} mesh(es) without Live2D keyforms are exported as static art meshes (bone skinning does not exist in Live2D)`);
  const switched = model.slots.filter((s) => {
    const atts = new Set<string>();
    for (const a of Object.values(model.animations ?? {})) for (const k of a.slots?.[s.id]?.attachment ?? []) if (k.v) atts.add(k.v);
    return atts.size > 0;
  });
  if (switched.length) warnings.push("slot attachment switching is not exported (Live2D shows each art mesh on its own)");

  // textures: images used by the meshes, in the Live2D texture order when known
  const texOrder = [...(meta.textures ?? [])];
  for (const id of meshIds) {
    const img = model.attachments[id].image;
    if (img && !texOrder.includes(img)) texOrder.push(img);
  }
  const usedTex = texOrder.filter((t) => model.images?.[t] && meshIds.some((m) => model.attachments[m].image === t));
  const textures = usedTex.length ? usedTex : texOrder.slice(0, 1);
  const texIndex = new Map(textures.map((t, i) => [t, i]));

  // ---- keyform grids: shared bands, parameter bindings grouped by parameter
  const pbKey = (param: string, keys: number[]) => `${param}\u0000${keys.join(",")}`;
  const pbByParam = new Map<string, Map<string, number[]>>(); // param -> key signature -> keys
  const bands: string[][] = []; // keyform binding -> parameter binding signatures
  const bandIndex = new Map<string, number>();
  const bandOf = (grid: KeyformGrid | undefined): number => {
    const g = grid ?? { params: [], keys: [] };
    const sigs = g.params.map((p, i) => pbKey(p, g.keys[i]));
    const key = sigs.join("\u0001");
    let b = bandIndex.get(key);
    if (b === undefined) {
      b = bands.length;
      bands.push(sigs);
      bandIndex.set(key, b);
      g.params.forEach((p, i) => {
        if (!paramIndex.has(p)) throw new Error(`keyform grid uses unknown parameter "${p}"`);
        let m = pbByParam.get(p);
        if (!m) pbByParam.set(p, (m = new Map()));
        m.set(pbKey(p, g.keys[i]), g.keys[i]);
      });
    }
    return b;
  };

  const parts = parentsFirst(rig.parts, (p) => p.parent);
  const partIndex = new Map(parts.map((p, i) => [p.id, i]));
  const defs = parentsFirst(rig.deformers, (d) => d.parent);
  const defIndex = new Map(defs.map((d, i) => [d.id, i]));
  const warps = defs.filter((d): d is Deformer & { type: "warp" } => d.type === "warp");
  const rots = defs.filter((d): d is Deformer & { type: "rotation" } => d.type === "rotation");
  const specific = new Map<string, number>([...warps.map((d, i) => [d.id, i] as const), ...rots.map((d, i) => [d.id, i] as const)]);

  // bands in a stable order: parts, deformers, meshes, glue
  const partBand = parts.map((p) => bandOf(p.grid));
  const defBand = defs.map((d) => bandOf(d.grid));
  const meshBand = meshIds.map((id) => bandOf(model.attachments[id].live2d?.grid));
  const glue = (rig.glue ?? []).filter((g) => meshIndex.has(g.a) && meshIndex.has(g.b));
  const glueBand = glue.map((g) => bandOf(g.grid));

  // does anything need a newer format?
  const hasColors =
    rig.deformers.some((d) => d.forms.some((f) => f.multiply || f.screen)) ||
    meshIds.some((id) => model.attachments[id].live2d?.forms.some((f) => f.multiply || f.screen));
  const needs: Moc3Version = hasColors ? 4 : warps.some((w) => w.bilinear) ? 2 : 1;
  const version = Math.max(opts.version ?? meta.mocVersion ?? 3, needs) as Moc3Version;
  const colorsPerKeyform = version >= 5;

  // ---- arrays
  const A: Record<string, number[] | string[]> = {};
  const push = (name: string, ...v: Array<number | string>) => ((A[name] ??= []) as Array<number | string>).push(...v);
  const positions: number[] = [];
  const keysPool: number[] = [];
  const mul: number[][] = [[], [], []];
  const scr: number[][] = [[], [], []];
  const addColor = (m?: number[], s?: number[]) => {
    const i = mul[0].length;
    for (let c = 0; c < 3; c++) {
      mul[c].push(m?.[c] ?? 1);
      scr[c].push(s?.[c] ?? 0);
    }
    return i;
  };

  // parameters and their bindings (grouped per parameter, in parameter order)
  const pbIndex = new Map<string, number>();
  let pbCount = 0;
  params.forEach((p) => {
    const m = pbByParam.get(p.id);
    push("parameter.ids", p.id);
    push("parameter.max", p.max);
    push("parameter.min", p.min);
    push("parameter.default", p.default);
    push("parameter.repeat", p.repeat ? 1 : 0);
    push("parameter.decimals", p.decimals ?? 3);
    push("parameter.bindingBegin", pbCount);
    push("parameter.bindingCount", m?.size ?? 0);
    for (const [sig, keys] of m ?? []) {
      pbIndex.set(sig, pbCount++);
      push("parameterBinding.keysBegin", keysPool.length);
      push("parameterBinding.keysCount", keys.length);
      keysPool.push(...keys);
    }
  });
  const pbiPool: number[] = [];
  for (const sigs of bands) {
    push("keyformBinding.begin", pbiPool.length);
    push("keyformBinding.count", sigs.length);
    for (const s of sigs) pbiPool.push(pbIndex.get(s)!);
  }
  if (version >= 4) {
    // per-parameter key list (all keys the parameter is keyed at)
    params.forEach((p) => {
      const all = [...new Set([...(pbByParam.get(p.id)?.values() ?? [])].flat())].sort((a, b) => a - b);
      push("parameterExt.keysBegin", keysPool.length);
      push("parameterExt.keysCount", all.length);
      keysPool.push(...all);
      push("parameter.type", 0);
      push("parameter.blendShapeBindingBegin", 0);
      push("parameter.blendShapeBindingCount", 0);
    });
  }

  // parts
  let partKf = 0;
  parts.forEach((p: Part, i) => {
    push("part.ids", p.id);
    push("part.keyformBinding", partBand[i]);
    const n = gridSizeOf(p.grid);
    push("part.keyformBegin", partKf);
    push("part.keyformCount", n);
    for (let k = 0; k < n; k++) push("partKeyform.drawOrder", p.drawOrders[k] ?? 500);
    partKf += n;
    push("part.visible", p.visible === false ? 0 : 1);
    push("part.enabled", p.disabled ? 0 : 1);
    push("part.parentPart", p.parent && partIndex.has(p.parent) ? partIndex.get(p.parent)! : -1);
  });

  // deformers
  let warpKf = 0;
  let rotKf = 0;
  defs.forEach((d, i) => {
    push("deformer.ids", d.id);
    push("deformer.keyformBinding", defBand[i]);
    push("deformer.visible", d.hidden ? 0 : 1);
    push("deformer.enabled", d.disabled ? 0 : 1);
    push("deformer.parentPart", d.part && partIndex.has(d.part) ? partIndex.get(d.part)! : -1);
    push("deformer.parentDeformer", d.parent && defIndex.has(d.parent) ? defIndex.get(d.parent)! : -1);
    push("deformer.type", d.type === "warp" ? 0 : 1);
    push("deformer.specific", specific.get(d.id)!);
  });
  for (const d of warps) {
    const n = gridSizeOf(d.grid);
    const vc = (d.cols + 1) * (d.rows + 1);
    push("warp.keyformBinding", defBand[defIndex.get(d.id)!]);
    push("warp.keyformBegin", warpKf);
    push("warp.keyformCount", n);
    push("warp.vertexCount", vc);
    push("warp.rows", d.rows);
    push("warp.cols", d.cols);
    if (version >= 2) push("warp.quad", d.bilinear ? 1 : 0);
    if (version >= 4) push("warp.colorBegin", mul[0].length);
    for (let k = 0; k < n; k++) {
      const f = d.forms[k] ?? d.forms[0];
      push("warpKeyform.opacity", f?.opacity ?? 1);
      push("warpKeyform.positionBegin", positions.length);
      for (let q = 0; q < vc * 2; q++) positions.push(f?.points[q] ?? 0);
      if (version >= 4) {
        const ci = addColor(f?.multiply, f?.screen);
        if (colorsPerKeyform) {
          push("warpKeyform.multiplyBegin", ci);
          push("warpKeyform.screenBegin", ci);
        }
      }
    }
    warpKf += n;
  }
  for (const d of rots) {
    const n = gridSizeOf(d.grid);
    push("rotation.keyformBinding", defBand[defIndex.get(d.id)!]);
    push("rotation.keyformBegin", rotKf);
    push("rotation.keyformCount", n);
    push("rotation.baseAngle", d.baseAngle);
    if (version >= 4) push("rotation.colorBegin", mul[0].length);
    for (let k = 0; k < n; k++) {
      const f = d.forms[k] ?? d.forms[0];
      push("rotationKeyform.opacity", f?.opacity ?? 1);
      push("rotationKeyform.angle", f?.angle ?? 0);
      push("rotationKeyform.x", f?.x ?? 0);
      push("rotationKeyform.y", f?.y ?? 0);
      push("rotationKeyform.scale", f?.scale ?? 1);
      push("rotationKeyform.reflectX", f?.reflectX ? 1 : 0);
      push("rotationKeyform.reflectY", f?.reflectY ? 1 : 0);
      if (version >= 4) {
        const ci = addColor(f?.multiply, f?.screen);
        if (colorsPerKeyform) {
          push("rotationKeyform.multiplyBegin", ci);
          push("rotationKeyform.screenBegin", ci);
        }
      }
    }
    rotKf += n;
  }

  // art meshes
  const uvPool: number[] = [];
  const indexPool: number[] = [];
  const maskPool: number[] = [];
  const ppu = rig.canvas.pixelsPerUnit || 1;
  let meshKf = 0;
  meshIds.forEach((id, i) => {
    const att = model.attachments[id] as MeshAttachment;
    const slot = model.slots.find((s) => s.id === slotOf.get(id))!;
    const l = att.live2d;
    const vc = att.vertices.length;
    if (vc > 32767) throw new Error(`${id}: ${vc} vertices, Live2D allows at most 32767`);
    push("artMesh.ids", id);
    push("artMesh.keyformBinding", meshBand[i]);
    const forms = l?.forms.length ? l.forms : [{ points: att.vertices.flatMap(([x, y]) => [x / ppu, -y / ppu]) }];
    const n = l ? gridSizeOf(l.grid) : 1;
    push("artMesh.keyformBegin", meshKf);
    push("artMesh.keyformCount", n);
    push("artMesh.visible", l?.hidden ? 0 : 1);
    push("artMesh.enabled", l?.disabled ? 0 : 1);
    push("artMesh.parentPart", l?.part && partIndex.has(l.part) ? partIndex.get(l.part)! : -1);
    push("artMesh.parentDeformer", l?.deformer && defIndex.has(l.deformer) ? defIndex.get(l.deformer)! : -1);
    push("artMesh.texture", texIndex.get(att.image ?? "") ?? 0);
    const blend = slot.blend === "additive" ? 1 : slot.blend === "multiply" ? 2 : 0;
    if (slot.blend === "screen") warnings.push(`${slot.id}: screen blending does not exist in Live2D (written as normal)`);
    push("artMesh.flags", blend | (slot.cull ? 0 : 4) | (slot.clip && slot.clipInvert ? 8 : 0));
    push("artMesh.vertexCount", vc);
    push("artMesh.uvBegin", uvPool.length);
    for (let k = 0; k < vc; k++) uvPool.push(att.uvs?.[k]?.[0] ?? 0, att.uvs?.[k]?.[1] ?? 0);
    push("artMesh.indexBegin", indexPool.length);
    push("artMesh.indexCount", att.triangles.length * 3);
    for (const t of att.triangles) indexPool.push(...t);
    const clips = (slot.clip === undefined ? [] : Array.isArray(slot.clip) ? slot.clip : [slot.clip]).filter((c) => slotIndex.has(c));
    push("artMesh.maskBegin", maskPool.length);
    push("artMesh.maskCount", clips.length);
    for (const c of clips) maskPool.push(slotIndex.get(c)!);
    if (version >= 4) push("artMesh.colorBegin", mul[0].length);
    for (let k = 0; k < n; k++) {
      const f = forms[k] ?? forms[0];
      push("artMeshKeyform.opacity", f.opacity ?? 1);
      push("artMeshKeyform.drawOrder", (f as { drawOrder?: number }).drawOrder ?? 500);
      push("artMeshKeyform.positionBegin", positions.length);
      for (let q = 0; q < vc * 2; q++) positions.push(f.points[q] ?? 0);
      if (version >= 4) {
        const ci = addColor((f as { multiply?: number[] }).multiply, (f as { screen?: number[] }).screen);
        if (colorsPerKeyform) {
          push("artMeshKeyform.multiplyBegin", ci);
          push("artMeshKeyform.screenBegin", ci);
        }
      }
    }
    meshKf += n;
  });

  // glue
  let glueInfo = 0;
  let glueKf = 0;
  glue.forEach((g, i) => {
    push("glue.ids", g.id);
    push("glue.keyformBinding", glueBand[i]);
    const n = gridSizeOf(g.grid);
    push("glue.keyformBegin", glueKf);
    push("glue.keyformCount", n);
    for (let k = 0; k < n; k++) push("glueKeyform.intensity", g.intensity[k] ?? 0);
    glueKf += n;
    push("glue.meshA", meshIndex.get(g.a)!);
    push("glue.meshB", meshIndex.get(g.b)!);
    push("glue.infoBegin", glueInfo);
    push("glue.infoCount", g.pairs.length);
    for (let k = 0; k < g.pairs.length; k++) {
      push("glueInfo.positionIndex", g.pairs[k]);
      push("glueInfo.weight", g.weights[k] ?? 0);
    }
    glueInfo += g.pairs.length;
  });

  // draw-order groups
  const groups: DrawOrderGroup[] = rig.drawOrderGroups?.length
    ? rig.drawOrderGroups
    : [{ min: 0, max: 1000, items: meshIds.map((id) => ({ slot: slotOf.get(id)! })) }];
  const listed = new Set(groups.flatMap((g) => g.items.filter((it): it is { slot: string } => "slot" in it).map((it) => it.slot)));
  const unlisted = meshIds.filter((id) => !listed.has(slotOf.get(id)!));
  const outGroups = groups.map((g, gi) => ({ ...g, items: [...g.items, ...(gi === 0 ? unlisted.map((id) => ({ slot: slotOf.get(id)! })) : [])] }));
  const total = (gi: number, depth = 0): number =>
    depth > outGroups.length ? 0 : outGroups[gi].items.reduce((n, it) => n + ("slot" in it ? (slotIndex.has(it.slot) ? 1 : 0) : total(it.group, depth + 1)), 0);
  let objects = 0;
  outGroups.forEach((g, gi) => {
    const items = g.items.filter((it) => ("slot" in it ? slotIndex.has(it.slot) : partIndex.has(it.part)));
    push("drawOrderGroup.objectBegin", objects);
    push("drawOrderGroup.objectCount", items.length);
    push("drawOrderGroup.objectTotal", total(gi));
    push("drawOrderGroup.maxDrawOrder", g.max);
    push("drawOrderGroup.minDrawOrder", g.min);
    for (const it of items) {
      if ("slot" in it) {
        push("drawOrderObject.type", 0);
        push("drawOrderObject.index", slotIndex.get(it.slot)!);
        push("drawOrderObject.selfGroup", -1);
      } else {
        push("drawOrderObject.type", 1);
        push("drawOrderObject.index", partIndex.get(it.part)!);
        push("drawOrderObject.selfGroup", it.group);
      }
    }
    objects += items.length;
  });

  A.positions = positions;
  A.keys = keysPool;
  A.parameterBindingIndices = pbiPool;
  A.uvs = uvPool;
  A.positionIndices = indexPool;
  A.drawableMasks = maskPool;
  if (version >= 4) {
    ["r", "g", "b"].forEach((c, k) => {
      A[`multiplyColor.${c}`] = mul[k];
      A[`screenColor.${c}`] = scr[k];
    });
  }

  const counts = Object.fromEntries(COUNT_NAMES.map((n) => [n, 0])) as Record<CountName, number>;
  Object.assign(counts, {
    parts: parts.length,
    deformers: defs.length,
    warpDeformers: warps.length,
    rotationDeformers: rots.length,
    artMeshes: meshIds.length,
    parameters: params.length,
    partKeyforms: partKf,
    warpDeformerKeyforms: warpKf,
    rotationDeformerKeyforms: rotKf,
    artMeshKeyforms: meshKf,
    keyformPositions: positions.length,
    parameterBindingIndices: pbiPool.length,
    keyformBindings: bands.length,
    parameterBindings: pbCount,
    keys: keysPool.length,
    uvs: uvPool.length,
    positionIndices: indexPool.length,
    drawableMasks: maskPool.length,
    drawOrderGroups: outGroups.length,
    drawOrderGroupObjects: objects,
    glue: glue.length,
    glueInfo,
    glueKeyforms: glueKf,
    ...(version >= 4 ? { keyformMultiplyColors: mul[0].length, keyformScreenColors: scr[0].length } : {}),
  });
  const arrays: Record<string, Moc3Array> = {};
  for (const f of fieldsFor(version)) {
    if (f.type === "runtime") continue;
    const src = A[f.name] ?? [];
    if (f.type === "id") arrays[f.name] = src as string[];
    else if (f.type === "f32") arrays[f.name] = Float32Array.from(src as number[]);
    else if (f.type === "u8") arrays[f.name] = Uint8Array.from(src as number[]);
    else if (f.type === "i16") arrays[f.name] = Int16Array.from(src as number[]);
    else if (f.type === "u32") arrays[f.name] = Uint32Array.from(src as number[]);
    else arrays[f.name] = Int32Array.from(src as number[]);
  }
  const moc: Moc3Data = {
    version,
    counts,
    canvas: { ...rig.canvas, flags: meta.canvasFlags ?? 0 },
    arrays,
  };

  // ---- JSON files
  const name = opts.name;
  const motions: Array<{ file: string; json: Json }> = [];
  const motionRefs: Record<string, Array<Record<string, unknown>>> = {};
  const used = new Set<string>();
  for (const [animName, anim] of Object.entries(model.animations ?? {})) {
    const m = meta.motions?.[animName];
    let file = m?.file ?? `motion/${animName}.motion3.json`;
    while (used.has(file.toLowerCase())) file = file.replace(/\.motion3\.json$/i, "_.motion3.json");
    used.add(file.toLowerCase());
    const json = animationToMotion(model, anim, m, animName, warnings);
    motions.push({ file, json });
    const group = m?.group ?? (anim.loop === false ? "Motion" : "Idle");
    const ref: Record<string, unknown> = { File: file };
    if (m?.fadeIn !== undefined) ref.FadeInTime = m.fadeIn;
    if (m?.fadeOut !== undefined) ref.FadeOutTime = m.fadeOut;
    (motionRefs[group] ??= []).push({ ...ref, __index: m?.index ?? Infinity });
  }
  for (const list of Object.values(motionRefs)) {
    list.sort((a, b) => (a.__index as number) - (b.__index as number));
    for (const r of list) delete r.__index;
  }

  const physics = rig.physics?.settings.length ? physicsJson(rig.physics) : undefined;
  const displayInfo = displayInfoJson(model, meta.displayInfo);
  const expressions = (meta.expressions ?? []).filter((e) => e.json).map((e) => ({ file: e.file || `expressions/${e.name}.exp3.json`, json: e.json }));
  const model3: Json = {
    Version: 3,
    FileReferences: {
      Moc: `${name}.moc3`,
      Textures: textures.map((t) => `${name}.textures/${t}.png`),
      ...(physics ? { Physics: `${name}.physics3.json` } : {}),
      ...(rig.pose?.groups.length ? { Pose: `${name}.pose3.json` } : {}),
      DisplayInfo: `${name}.cdi3.json`,
      ...(expressions.length ? { Expressions: (meta.expressions ?? []).filter((e) => e.json).map((e, i) => ({ Name: e.name, File: expressions[i].file })) } : {}),
      ...(motions.length ? { Motions: motionRefs } : {}),
      ...(meta.userData ? { UserData: `${name}.userdata3.json` } : {}),
    },
    ...(meta.groups ? { Groups: meta.groups } : {}),
    ...(meta.hitAreas ? { HitAreas: meta.hitAreas } : {}),
    ...(meta.layout ? { Layout: meta.layout } : {}),
  };
  if (model.bones.length > 1) warnings.push(`${model.bones.length - 1} bone(s) are not exported (Live2D has no bones; use deformers)`);
  if (model.physics?.length) warnings.push("spring bones are not exported (use Live2D physics3 settings)");
  if (model.warps?.length || model.combos?.length || params.some((p) => p.bones || p.slots || p.meshes || p.warps)) {
    warnings.push("Awaken2D parameter effects (bone offsets, blend shapes, warps, combos) are not exported; only Live2D keyforms are");
  }
  const pose = rig.pose?.groups.length
    ? { Type: "Live2D Pose", ...(rig.pose.fadeIn !== undefined ? { FadeInTime: rig.pose.fadeIn } : {}), Groups: rig.pose.groups.map((g) => g.map((p) => ({ Id: p.part, Link: p.link ?? [] }))) }
    : undefined;
  return { moc, model3, motions, physics, displayInfo, pose, userData: meta.userData, expressions, textures, warnings };
}

function defaultCanvas(model: Model) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const a of Object.values(model.attachments)) {
    for (const [x, y] of a.vertices) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return { width: 1024, height: 1024, originX: 512, originY: 512, pixelsPerUnit: 1024 };
  const width = Math.ceil(maxX - minX + 20);
  const height = Math.ceil(maxY - minY + 20);
  return { width, height, originX: -minX + 10, originY: maxY + 10, pixelsPerUnit: width };
}

function gridSizeOf(g: KeyformGrid): number {
  return g.keys.reduce((n, k) => n * k.length, 1);
}

// ---------- motion3

const NAMED: Record<string, [number, number, number, number]> = { easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1] };

function easeBezier(e: Ease | undefined): [number, number, number, number] | null {
  if (e === undefined || e === "linear" || e === "stepped") return null;
  if (typeof e === "string") return NAMED[e] ?? null;
  return e;
}

function curveSegments(keys: Key<number>[], before: number): number[] {
  // keys at the loop end are the loop closure Cubism adds by itself
  const ks = keys.filter((k) => k.t < before - 1e-6);
  if (!ks.length) return [];
  const seg: number[] = [ks[0].t, ks[0].v];
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    const ease = isChannelEases(a.ease) ? a.ease[0] : (a.ease as Ease | undefined);
    if (Math.abs(b.t - a.t) < 1e-9) {
      // a jump at one time: inverse stepped to the key after it, or a stepped jump
      const c = ks[i + 2];
      if (c && b.ease === "stepped" && Math.abs(c.v - b.v) < 1e-9) {
        seg.push(3, c.t, c.v);
        i++;
      } else seg.push(2, b.t, b.v);
      continue;
    }
    if (ease === "stepped") {
      seg.push(2, b.t, b.v);
      continue;
    }
    const bz = easeBezier(ease);
    if (!bz) {
      seg.push(0, b.t, b.v);
      continue;
    }
    const dt = b.t - a.t;
    const dv = b.v - a.v;
    const r = (n: number) => Math.round(n * 1e7) / 1e7;
    seg.push(1, r(a.t + bz[0] * dt), r(a.v + bz[1] * dv), r(a.t + bz[2] * dt), r(a.v + bz[3] * dv), b.t, b.v);
  }
  return seg;
}

function countPoints(seg: number[]): { segments: number; points: number } {
  let segments = 0;
  let points = seg.length ? 1 : 0;
  for (let i = 2; i < seg.length; ) {
    segments++;
    if (seg[i] === 1) {
      points += 3;
      i += 7;
    } else {
      points += 1;
      i += 3;
    }
  }
  return { segments, points };
}

function animationToMotion(model: Model, anim: Animation, m: NonNullable<ReturnType<typeof live2dMeta>["motions"]>[string] | undefined, name: string, warnings: string[]): Json {
  const fps = m?.fps ?? FPS_DEFAULT;
  const loop = anim.loop !== false;
  // a Cubism loop repeats every Duration + one frame
  const duration = m?.duration ?? (loop ? Math.max(0, anim.duration - 1 / fps) : anim.duration);
  const curves: Json[] = [];
  const fades = (m?.curveFades ?? {}) as Record<string, { fadeIn?: number; fadeOut?: number }>;
  const add = (target: string, id: string, keys: Key<number>[]) => {
    const seg = curveSegments(keys, loop ? anim.duration : Infinity);
    if (!seg.length) return;
    const c: Json = { Target: target, Id: id };
    const f = fades[`${target}/${id}`];
    if (f?.fadeIn !== undefined) c.FadeInTime = f.fadeIn;
    if (f?.fadeOut !== undefined) c.FadeOutTime = f.fadeOut;
    c.Segments = seg;
    curves.push(c);
  };
  // Model curves first: the Framework evaluates them in front
  for (const c of m?.curves ?? []) curves.push(c);
  const known = new Set((model.parameters ?? []).map((p) => p.id));
  for (const [id, keys] of Object.entries(anim.params ?? {})) if (known.has(id)) add("Parameter", id, keys);
  for (const [id, keys] of Object.entries(anim.partOpacity ?? {})) add("PartOpacity", id, keys);
  // curves for ids the moc does not have, set aside when an older import was loaded (Cubism ignores them)
  const orphans = (m as { orphanKeys?: { params?: Record<string, Key<number>[]>; partOpacity?: Record<string, Key<number>[]> } } | undefined)?.orphanKeys;
  for (const [id, keys] of Object.entries(orphans?.params ?? {})) add("Parameter", id, keys);
  for (const [id, keys] of Object.entries(orphans?.partOpacity ?? {})) add("PartOpacity", id, keys);
  if (Object.keys(anim.bones ?? {}).length || Object.keys(anim.deform ?? {}).length || anim.drawOrder?.length || Object.keys(anim.slots ?? {}).length) {
    warnings.push(`${name}: bone / slot / deform / draw-order tracks are not exported (Live2D motions drive parameters and part opacity)`);
  }
  let segments = 0;
  let points = 0;
  for (const c of curves) {
    const n = countPoints(c.Segments);
    segments += n.segments;
    points += n.points;
  }
  const userData = (anim.events ?? []).map((e) => ({ Time: e.t, Value: e.string ?? e.name }));
  return {
    Version: 3,
    Meta: {
      Duration: duration,
      Fps: fps,
      ...(m?.fadeIn !== undefined ? { FadeInTime: m.fadeIn } : {}),
      ...(m?.fadeOut !== undefined ? { FadeOutTime: m.fadeOut } : {}),
      Loop: loop,
      AreBeziersRestricted: false,
      CurveCount: curves.length,
      TotalSegmentCount: segments,
      TotalPointCount: points,
      UserDataCount: userData.length,
      TotalUserDataSize: userData.reduce((n, u) => n + u.Value.length, 0),
    },
    Curves: curves,
    ...(userData.length ? { UserData: userData } : {}),
  };
}

// ---------- physics3 / cdi3

function physicsJson(p: NonNullable<Model["live2d"]>["physics"] & object): Json {
  const s = p.settings;
  return {
    Version: 3,
    Meta: {
      PhysicsSettingCount: s.length,
      TotalInputCount: s.reduce((n, x) => n + x.inputs.length, 0),
      TotalOutputCount: s.reduce((n, x) => n + x.outputs.length, 0),
      VertexCount: s.reduce((n, x) => n + x.vertices.length, 0),
      ...(p.fps ? { Fps: p.fps } : {}),
      EffectiveForces: {
        Gravity: { X: p.gravity?.[0] ?? 0, Y: p.gravity?.[1] ?? -1 },
        Wind: { X: p.wind?.[0] ?? 0, Y: p.wind?.[1] ?? 0 },
      },
      PhysicsDictionary: s.map((x) => ({ Id: x.id, Name: x.name ?? x.id })),
    },
    PhysicsSettings: s.map((x) => ({
      Id: x.id,
      Input: x.inputs.map((i) => ({ Source: { Target: "Parameter", Id: i.param }, Weight: i.weight, Type: i.type, Reflect: !!i.reflect })),
      Output: x.outputs.map((o) => ({
        Destination: { Target: "Parameter", Id: o.param },
        VertexIndex: o.vertex,
        Scale: o.scale,
        Weight: o.weight,
        Type: o.type,
        Reflect: !!o.reflect,
      })),
      Vertices: x.vertices.map((v) => ({
        Position: { X: v.x, Y: v.y },
        Mobility: v.mobility,
        Delay: v.delay,
        Acceleration: v.acceleration,
        Radius: v.radius,
      })),
      Normalization: {
        Position: { Minimum: x.normalization.position.min, Default: x.normalization.position.default, Maximum: x.normalization.position.max },
        Angle: { Minimum: x.normalization.angle.min, Default: x.normalization.angle.default, Maximum: x.normalization.angle.max },
      },
    })),
  };
}

function displayInfoJson(model: Model, prev: Json): Json {
  const out: Json = { Version: 3 };
  out.Parameters = (model.parameters ?? []).map((p) => ({ Id: p.id, GroupId: p.group ?? "", Name: p.name ?? p.id }));
  const groupIds = new Set((model.parameters ?? []).map((p) => p.group).filter(Boolean));
  const prevGroups: Json[] = prev?.ParameterGroups ?? [];
  const groups = prevGroups.filter((g) => groupIds.has(g.Id));
  for (const g of groupIds) if (!groups.some((x) => x.Id === g)) groups.push({ Id: g, GroupId: "", Name: g });
  if (groups.length) out.ParameterGroups = groups;
  out.Parts = (model.live2d?.parts ?? []).map((p) => ({ Id: p.id, Name: p.name ?? p.id }));
  const params = new Set((model.parameters ?? []).map((p) => p.id));
  const combined = (prev?.CombinedParameters ?? []).filter((c: Json) => (c.Ids ?? []).every((id: string) => params.has(id)));
  if (combined.length) out.CombinedParameters = combined;
  return out;
}

