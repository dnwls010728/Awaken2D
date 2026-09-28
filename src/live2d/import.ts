// Live2D runtime data (moc3 + model3/physics3/motion3/pose3/cdi3 JSON) -> Awaken2D model. Pure: file access is in
// index.ts. The rig keeps Cubism's own structure (keyforms, deformers, parts, glue, draw-order groups) so it poses
// exactly like the Cubism Core and exports back unchanged.
import { FORMAT_ID } from "../core/types.ts";
import type {
  Animation,
  Key,
  Deformer,
  DrawOrderGroup,
  Glue,
  KeyformGrid,
  Live2DRig,
  MeshAttachment,
  MeshKeyform,
  Model,
  Parameter,
  Part,
  RGB,
  Slot,
  Tri,
  Vec2,
} from "../core/types.ts";
import { live2dFrame, live2dVertices } from "../core/live2d.ts";
import type { Moc3Data } from "./moc3.ts";

type Arr = ArrayLike<number>;

export interface Live2DImportResult {
  model: Model;
  log: string[];
  warnings: string[];
}

/** The shortest decimal that reads back as the same 32-bit float (moc3 stores f32). */
export function f32(n: number): number {
  const t = Math.fround(n);
  for (let p = 1; p < 10; p++) {
    const d = Number(t.toPrecision(p));
    if (Math.fround(d) === t) return d;
  }
  return t;
}
const r6 = f32;

/** Builds the Awaken2D model for a moc3. `textures` are the image ids of the texture pages, by texture number. */
export function mocToModel(moc: Moc3Data, opts: { name: string; textures: string[] }): Live2DImportResult {
  const log: string[] = [];
  const warnings: string[] = [];
  const A = moc.arrays;
  const num = (name: string): Arr => (A[name] as Arr) ?? [];
  const ids = (name: string): string[] => (A[name] as string[]) ?? [];
  const c = moc.counts;

  // parameters and the parameter behind each parameter binding
  const paramIds = ids("parameter.ids");
  const bindingParam: number[] = [];
  const parameters: Parameter[] = paramIds.map((id, i) => {
    const b = num("parameter.bindingBegin")[i];
    for (let k = 0; k < num("parameter.bindingCount")[i]; k++) bindingParam[b + k] = i;
    const p: Parameter = { id, min: r6(num("parameter.min")[i]), max: r6(num("parameter.max")[i]), default: r6(num("parameter.default")[i]) };
    if (num("parameter.repeat")[i]) p.repeat = true;
    p.decimals = num("parameter.decimals")[i];
    return p;
  });
  if (moc.version >= 4 && Array.from(num("parameter.type")).some((t) => t === 1)) {
    warnings.push("blend-shape parameters are not supported yet: their shapes are left out");
  }

  // keyform grids (shared per keyform binding)
  const keysOf = (pb: number): number[] => {
    const b = num("parameterBinding.keysBegin")[pb];
    return Array.from(num("keys")).slice(b, b + num("parameterBinding.keysCount")[pb]).map(r6);
  };
  const grids: KeyformGrid[] = [];
  for (let kb = 0; kb < c.keyformBindings; kb++) {
    const b = num("keyformBinding.begin")[kb];
    const n = num("keyformBinding.count")[kb];
    const g: KeyformGrid = { params: [], keys: [] };
    for (let k = b; k < b + n; k++) {
      const pb = num("parameterBindingIndices")[k];
      g.params.push(paramIds[bindingParam[pb]]);
      g.keys.push(keysOf(pb));
    }
    grids.push(g);
  }
  const gridOf = (kb: number): KeyformGrid => structuredClone(grids[kb] ?? { params: [], keys: [] });

  const positions = num("positions");
  const pts = (begin: number, n: number) => Array.from({ length: n * 2 }, (_, k) => r6(positions[begin + k]));
  const colorAt = (prefix: "multiplyColor" | "screenColor", i: number): RGB => [
    r6(num(`${prefix}.r`)[i]),
    r6(num(`${prefix}.g`)[i]),
    r6(num(`${prefix}.b`)[i]),
  ];
  const isOne = (c: RGB) => c[0] === 1 && c[1] === 1 && c[2] === 1;
  const isZero = (c: RGB) => c[0] === 0 && c[1] === 0 && c[2] === 0;
  /** Colors of keyform k of an object: 4.2 stores them per object from a begin index, 5.0 per keyform. */
  const colors = (kind: "warp" | "rotation" | "artMesh", obj: number, k: number, formIndex: number): { multiply?: RGB; screen?: RGB } => {
    if (moc.version < 4) return {};
    let mi: number;
    let si: number;
    if (moc.version >= 5) {
      mi = num(`${kind === "artMesh" ? "artMeshKeyform" : kind + "Keyform"}.multiplyBegin`)[k];
      si = num(`${kind === "artMesh" ? "artMeshKeyform" : kind + "Keyform"}.screenBegin`)[k];
    } else {
      mi = si = num(`${kind}.colorBegin`)[obj] + formIndex;
    }
    const out: { multiply?: RGB; screen?: RGB } = {};
    if (mi >= 0 && mi < c.keyformMultiplyColors) {
      const m = colorAt("multiplyColor", mi);
      if (!isOne(m)) out.multiply = m;
    }
    if (si >= 0 && si < c.keyformScreenColors) {
      const s = colorAt("screenColor", si);
      if (!isZero(s)) out.screen = s;
    }
    return out;
  };

  // parts
  const partIds = ids("part.ids");
  const parts: Part[] = partIds.map((id, i) => {
    const b = num("part.keyformBegin")[i];
    const n = num("part.keyformCount")[i];
    const parent = num("part.parentPart")[i];
    const p: Part = {
      id,
      parent: parent >= 0 ? partIds[parent] : null,
      grid: gridOf(num("part.keyformBinding")[i]),
      drawOrders: Array.from({ length: n }, (_, k) => r6(num("partKeyform.drawOrder")[b + k])),
    };
    if (!num("part.visible")[i]) p.visible = false;
    if (!num("part.enabled")[i]) p.disabled = true;
    return p;
  });

  // deformers (the file lists parents first)
  const defIds = ids("deformer.ids");
  const deformers: Deformer[] = defIds.map((id, i) => {
    const s = num("deformer.specific")[i];
    const parent = num("deformer.parentDeformer")[i];
    const part = num("deformer.parentPart")[i];
    const base = {
      id,
      parent: parent >= 0 ? defIds[parent] : null,
      part: part >= 0 ? partIds[part] : null,
      ...(num("deformer.visible")[i] ? {} : { hidden: true }),
      ...(num("deformer.enabled")[i] ? {} : { disabled: true }),
    };
    if (num("deformer.type")[i] === 0) {
      const b = num("warp.keyformBegin")[s];
      const n = num("warp.keyformCount")[s];
      const vc = num("warp.vertexCount")[s];
      return {
        ...base,
        type: "warp",
        grid: gridOf(num("warp.keyformBinding")[s]),
        cols: num("warp.cols")[s],
        rows: num("warp.rows")[s],
        ...(moc.version >= 2 && num("warp.quad")[s] ? { bilinear: true } : {}),
        forms: Array.from({ length: n }, (_, k) => {
          const op = r6(num("warpKeyform.opacity")[b + k]);
          return { points: pts(num("warpKeyform.positionBegin")[b + k], vc), ...(op !== 1 ? { opacity: op } : {}), ...colors("warp", s, b + k, k) };
        }),
      };
    }
    const b = num("rotation.keyformBegin")[s];
    const n = num("rotation.keyformCount")[s];
    return {
      ...base,
      type: "rotation",
      grid: gridOf(num("rotation.keyformBinding")[s]),
      baseAngle: r6(num("rotation.baseAngle")[s]),
      forms: Array.from({ length: n }, (_, k) => {
        const j = b + k;
        const op = r6(num("rotationKeyform.opacity")[j]);
        return {
          x: r6(num("rotationKeyform.x")[j]),
          y: r6(num("rotationKeyform.y")[j]),
          angle: r6(num("rotationKeyform.angle")[j]),
          scale: r6(num("rotationKeyform.scale")[j]),
          ...(num("rotationKeyform.reflectX")[j] ? { reflectX: true } : {}),
          ...(num("rotationKeyform.reflectY")[j] ? { reflectY: true } : {}),
          ...(op !== 1 ? { opacity: op } : {}),
          ...colors("rotation", s, j, k),
        };
      }),
    };
  });

  // art meshes -> slots + attachments
  const meshIds = ids("artMesh.ids");
  const uvs = num("uvs");
  const indices = num("positionIndices");
  const masks = num("drawableMasks");
  const attachments: Record<string, MeshAttachment> = {};
  const slots: Slot[] = [];
  const textureCount = Math.max(0, ...Array.from(num("artMesh.texture"))) + 1;
  if (opts.textures.length < textureCount) warnings.push(`the model uses ${textureCount} textures, ${opts.textures.length} found`);
  meshIds.forEach((id, i) => {
    const vc = num("artMesh.vertexCount")[i];
    const b = num("artMesh.keyformBegin")[i];
    const n = num("artMesh.keyformCount")[i];
    const flags = num("artMesh.flags")[i];
    const ub = num("artMesh.uvBegin")[i];
    const ib = num("artMesh.indexBegin")[i];
    const ic = num("artMesh.indexCount")[i];
    const tris: Tri[] = [];
    for (let k = 0; k + 2 < ic; k += 3) tris.push([indices[ib + k], indices[ib + k + 1], indices[ib + k + 2]]);
    const forms: MeshKeyform[] = Array.from({ length: n }, (_, k) => {
      const op = r6(num("artMeshKeyform.opacity")[b + k]);
      return {
        points: pts(num("artMeshKeyform.positionBegin")[b + k], vc),
        ...(op !== 1 ? { opacity: op } : {}),
        drawOrder: r6(num("artMeshKeyform.drawOrder")[b + k]),
        ...colors("artMesh", i, b + k, k),
      };
    });
    const parent = num("artMesh.parentDeformer")[i];
    const part = num("artMesh.parentPart")[i];
    const tex = num("artMesh.texture")[i];
    attachments[id] = {
      type: "mesh",
      image: opts.textures[tex] ?? opts.textures[0],
      uvs: Array.from({ length: vc }, (_, k): Vec2 => [r6(uvs[ub + k * 2]), r6(uvs[ub + k * 2 + 1])]),
      triangles: tris,
      vertices: [],
      weights: Array.from({ length: vc }, () => [["root", 1]] as Array<[string, number]>),
      live2d: {
        deformer: parent >= 0 ? defIds[parent] : null,
        part: part >= 0 ? partIds[part] : null,
        grid: gridOf(num("artMesh.keyformBinding")[i]),
        forms,
        ...(num("artMesh.visible")[i] ? {} : { hidden: true }),
        ...(num("artMesh.enabled")[i] ? {} : { disabled: true }),
      },
    };
    const mb = num("artMesh.maskBegin")[i];
    const mc = num("artMesh.maskCount")[i];
    const clip = Array.from({ length: mc }, (_, k) => meshIds[masks[mb + k]]).filter(Boolean);
    const blend = flags & 3;
    slots.push({
      id,
      bone: "root",
      attachment: id,
      color: "#ffffff",
      ...(blend === 1 ? { blend: "additive" as const } : blend === 2 ? { blend: "multiply" as const } : {}),
      ...(clip.length ? { clip: clip.length === 1 ? clip[0] : clip } : {}),
      ...(clip.length && flags & 8 ? { clipInvert: true } : {}),
      ...(flags & 4 ? {} : { cull: true }),
    });
  });

  // glue
  const glue: Glue[] = ids("glue.ids").map((id, i) => {
    const b = num("glue.infoBegin")[i];
    const n = num("glue.infoCount")[i];
    const kb = num("glue.keyformBegin")[i];
    const kn = num("glue.keyformCount")[i];
    return {
      id,
      a: meshIds[num("glue.meshA")[i]],
      b: meshIds[num("glue.meshB")[i]],
      pairs: Array.from({ length: n }, (_, k) => num("glueInfo.positionIndex")[b + k]),
      weights: Array.from({ length: n }, (_, k) => r6(num("glueInfo.weight")[b + k])),
      grid: gridOf(num("glue.keyformBinding")[i]),
      intensity: Array.from({ length: kn }, (_, k) => r6(num("glueKeyform.intensity")[kb + k])),
    };
  });

  // draw-order groups
  const drawOrderGroups: DrawOrderGroup[] = Array.from({ length: c.drawOrderGroups }, (_, g) => {
    const b = num("drawOrderGroup.objectBegin")[g];
    const n = num("drawOrderGroup.objectCount")[g];
    return {
      min: num("drawOrderGroup.minDrawOrder")[g],
      max: num("drawOrderGroup.maxDrawOrder")[g],
      items: Array.from({ length: n }, (_, k) => {
        const o = b + k;
        const index = num("drawOrderObject.index")[o];
        return num("drawOrderObject.type")[o] === 1 ? { part: partIds[index], group: num("drawOrderObject.selfGroup")[o] } : { slot: meshIds[index] };
      }),
    };
  });

  const canvas = moc.canvas;
  const live2d: Live2DRig = {
    canvas: { width: canvas.width, height: canvas.height, originX: canvas.originX, originY: canvas.originY, pixelsPerUnit: canvas.pixelsPerUnit },
    parts,
    deformers,
    ...(glue.length ? { glue } : {}),
    drawOrderGroups,
  };
  const model: Model = {
    format: FORMAT_ID,
    name: opts.name,
    target: "live2d",
    meta: { live2d: { mocVersion: moc.version, canvasFlags: canvas.flags, meshOrder: meshIds, textures: opts.textures } },
    images: {},
    bones: [{ id: "root", parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 }],
    slots,
    attachments,
    animations: {},
    parameters,
    live2d,
  };
  syncLive2DVertices(model);
  // setup draw order: the order at the defaults (meshes not drawn there keep their file position)
  const frame = live2dFrame(model, defaultValues(model));
  const rank = new Map(frame.order.map((id, k) => [id, k]));
  const ordered = [...model.slots].sort((a, b) => {
    const da = frame.meshes.get(a.id)?.drawOrder ?? 500;
    const db = frame.meshes.get(b.id)?.drawOrder ?? 500;
    return (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || da - db;
  });
  const drawn = ordered.filter((s) => rank.has(s.id));
  const rest = model.slots.filter((s) => !rank.has(s.id));
  model.slots = [...drawn, ...rest];
  log.push(
    `moc3 v${moc.version}: ${meshIds.length} art meshes, ${defIds.length} deformers (${c.warpDeformers} warp, ${c.rotationDeformers} rotation), ` +
      `${partIds.length} parts, ${paramIds.length} parameters, ${glue.length} glue`,
  );
  return { model, log, warnings };
}

export function defaultValues(model: Model): Record<string, number> {
  return Object.fromEntries((model.parameters ?? []).map((p) => [p.id, p.default]));
}

/** Refreshes every Live2D mesh's `vertices` (the pose at the parameter defaults). */
export function syncLive2DVertices(model: Model): void {
  if (!model.live2d) return;
  const frame = live2dFrame(model, defaultValues(model));
  for (const [id, att] of Object.entries(model.attachments)) {
    if (!att.live2d) continue;
    att.vertices = (live2dVertices(model, frame, id) ?? []).map(([x, y]) => [r6(x), r6(y)] as Vec2);
  }
}

// ---------- JSON files (model3 / motion3 / physics3 / pose3 / cdi3 / exp3)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface Live2DJsonFiles {
  model3?: Json;
  physics?: Json;
  pose?: Json;
  displayInfo?: Json;
  userData?: Json;
  motions?: Array<{ group: string; index: number; file: string; json: Json }>;
  expressions?: Array<{ name: string; file: string; json: Json }>;
}

/** Meta kept for the Live2D export (model3 groups, motion groups, fades, pose, expressions...). */
export interface Live2DMeta {
  mocVersion?: number;
  canvasFlags?: number;
  /** Art mesh order of the moc3 (drawable indices), kept on export. */
  meshOrder?: string[];
  /** Texture image ids by texture number. */
  textures?: string[];
  groups?: Json;
  hitAreas?: Json;
  layout?: Json;
  pose?: Json;
  userData?: Json;
  displayInfo?: Json;
  expressions?: Array<{ name: string; file: string; json: Json }>;
  /** Per animation: its model3 motion group and the motion3 fields Awaken2D does not model. */
  motions?: Record<string, { group: string; index: number; file: string; duration?: number; fadeIn?: number; fadeOut?: number; fps?: number; restricted?: boolean; curves?: Json; curveFades?: Json }>;
}

export function live2dMeta(model: Model): Live2DMeta {
  const m = (model.meta ??= {}) as Record<string, unknown>;
  return (m.live2d ??= {}) as Live2DMeta;
}

/** Adds what the JSON files carry: motions, physics, names and groups (cdi3), pose, hit areas. */
export function applyLive2DJson(res: Live2DImportResult, files: Live2DJsonFiles): void {
  const { model, log, warnings } = res;
  const meta = live2dMeta(model);
  const m3 = files.model3;
  if (m3?.Groups?.length) meta.groups = m3.Groups;
  if (m3?.HitAreas?.length) meta.hitAreas = m3.HitAreas;
  if (m3?.Layout) meta.layout = m3.Layout;
  if (files.pose?.Groups?.length) {
    const known = new Set(model.live2d!.parts.map((p) => p.id));
    const groups = (files.pose.Groups as Json[])
      .map((g: Json[]) => g.filter((p) => known.has(p?.Id)).map((p) => ({ part: String(p.Id), ...(p.Link?.length ? { link: p.Link.map(String).filter((l: string) => known.has(l)) } : {}) })))
      .filter((g: unknown[]) => g.length);
    if (groups.length) model.live2d!.pose = { ...(typeof files.pose.FadeInTime === "number" ? { fadeIn: files.pose.FadeInTime } : {}), groups };
  }
  if (files.userData) meta.userData = files.userData;
  if (files.expressions?.length) {
    meta.expressions = files.expressions;
    warnings.push(`${files.expressions.length} expression(s) kept for export but not shown (Awaken2D has no expression blending)`);
  }

  // display names and groups
  const cdi = files.displayInfo;
  if (cdi) {
    meta.displayInfo = cdi;
    const params = new Map((model.parameters ?? []).map((p) => [p.id, p]));
    for (const p of cdi.Parameters ?? []) {
      const t = params.get(p.Id);
      if (!t) continue;
      if (p.Name) t.name = p.Name;
      if (p.GroupId) t.group = p.GroupId;
    }
    const parts = new Map(model.live2d!.parts.map((p) => [p.id, p]));
    for (const p of cdi.Parts ?? []) {
      const t = parts.get(p.Id);
      if (t && p.Name) t.name = p.Name;
    }
  }

  // physics
  const ph = files.physics;
  if (ph?.PhysicsSettings?.length) {
    const names = new Map<string, string>((ph.Meta?.PhysicsDictionary ?? []).map((d: Json) => [d.Id, d.Name]));
    const nv = (n: Json) => ({ min: n?.Minimum ?? -10, default: n?.Default ?? 0, max: n?.Maximum ?? 10 });
    const forces = ph.Meta?.EffectiveForces;
    model.live2d!.physics = {
      ...(ph.Meta?.Fps > 0 ? { fps: ph.Meta.Fps } : {}),
      ...(forces?.Gravity ? { gravity: [forces.Gravity.X ?? 0, forces.Gravity.Y ?? -1] as Vec2 } : {}),
      ...(forces?.Wind ? { wind: [forces.Wind.X ?? 0, forces.Wind.Y ?? 0] as Vec2 } : {}),
      settings: ph.PhysicsSettings.map((s: Json) => ({
        id: s.Id,
        ...(names.get(s.Id) ? { name: names.get(s.Id) } : {}),
        inputs: (s.Input ?? []).map((i: Json) => ({ param: i.Source?.Id, weight: i.Weight ?? 0, type: i.Type, ...(i.Reflect ? { reflect: true } : {}) })),
        outputs: (s.Output ?? []).map((o: Json) => ({
          param: o.Destination?.Id,
          vertex: o.VertexIndex ?? 1,
          scale: o.Scale ?? 1,
          weight: o.Weight ?? 100,
          type: o.Type,
          ...(o.Reflect ? { reflect: true } : {}),
        })),
        vertices: (s.Vertices ?? []).map((v: Json) => ({
          x: v.Position?.X ?? 0,
          y: v.Position?.Y ?? 0,
          mobility: v.Mobility ?? 1,
          delay: v.Delay ?? 1,
          acceleration: v.Acceleration ?? 1,
          radius: v.Radius ?? 0,
        })),
        normalization: { position: nv(s.Normalization?.Position), angle: nv(s.Normalization?.Angle) },
      })),
    };
    const known = new Set((model.parameters ?? []).map((p) => p.id));
    const missing = new Set<string>();
    for (const s of model.live2d!.physics.settings) for (const x of [...s.inputs, ...s.outputs]) if (!known.has(x.param)) missing.add(x.param);
    if (missing.size) warnings.push(`physics refers to unknown parameters: ${[...missing].join(", ")}`);
    log.push(`physics: ${model.live2d!.physics.settings.length} settings`);
  }

  // motions
  const usedNames = new Set(Object.keys(model.animations ?? {}));
  meta.motions = {};
  const orphanIds = new Set<string>();
  let orphanMotions = 0;
  for (const mo of files.motions ?? []) {
    let name = mo.file.split("/").pop()!.replace(/\.motion3\.json$/i, "").replace(/\.json$/i, "") || `${mo.group}_${mo.index}`;
    while (usedNames.has(name)) name += "_";
    usedNames.add(name);
    const { anim, extra, notes } = motionToAnimation(mo.json);
    // curves for ids the moc does not have (renamed or deleted in the editor) do nothing in Cubism: kept for export only
    const params = new Set((model.parameters ?? []).map((p) => p.id));
    const parts = new Set(model.live2d!.parts.map((p) => p.id));
    const orphans: string[] = [];
    for (const [kind, known, target] of [
      ["params", params, "Parameter"],
      ["partOpacity", parts, "PartOpacity"],
    ] as const) {
      for (const id of Object.keys(anim[kind] ?? {})) {
        if (known.has(id)) continue;
        delete anim[kind]![id];
        orphans.push(id);
        const raw = (mo.json?.Curves ?? []).find((c: Json) => c.Target === target && c.Id === id);
        if (raw) ((extra.curves ??= []) as Json[]).push(raw);
      }
      if (anim[kind] && !Object.keys(anim[kind]!).length) delete anim[kind];
    }
    for (const id of orphans) orphanIds.add(id);
    if (orphans.length) orphanMotions++;
    model.animations![name] = anim;
    meta.motions[name] = { group: mo.group, index: mo.index, file: mo.file, ...extra };
    for (const n of notes) warnings.push(`${name}: ${n}`);
  }
  if (orphanIds.size) warnings.push(`${orphanMotions} motion(s) have curves for ${[...orphanIds].join(", ")}, which the moc3 does not have: kept for export only`);
  if (Object.values(model.animations ?? {}).some((a) => a.events?.length)) model.events = { ...(model.events ?? {}), user: model.events?.user ?? {} };
  if (files.motions?.length) log.push(`${files.motions.length} motion(s)`);
}

/** Splits a cubic (t, v) bezier at s (de Casteljau). */
function splitBezier(p: number[][], s: number): [number[][], number[][]] {
  const L = (a: number[], b: number[]) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const p01 = L(p[0], p[1]);
  const p12 = L(p[1], p[2]);
  const p23 = L(p[2], p[3]);
  const p012 = L(p01, p12);
  const p123 = L(p12, p23);
  const m = L(p012, p123);
  return [
    [p[0], p01, p012, m],
    [m, p123, p23, p[3]],
  ];
}

/**
 * motion3.json -> Awaken2D animation. Cubism's default bezier (the "Cardano" evaluation) solves the time handles like
 * Awaken2D's eases; restricted beziers ignore them (time handles at thirds). A flat segment with bulging handles is
 * split until every piece has a value change to normalize against.
 */
export function motionToAnimation(json: Json): { anim: Animation; extra: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const metaIn = json?.Meta ?? {};
  const restricted = !!metaIn.AreBeziersRestricted;
  const loop = !!metaIn.Loop;
  // a looping motion (Cubism motion behavior v2) repeats every Duration + one frame, closing linearly to the start
  const fileDuration = metaIn.Duration ?? 0;
  const duration = loop ? Math.round((fileDuration + 1 / (metaIn.Fps > 0 ? metaIn.Fps : 30)) * 1e7) / 1e7 : fileDuration;
  const anim: Animation = { duration, loop };
  const extra: Record<string, unknown> = {};
  if (metaIn.FadeInTime !== undefined) extra.fadeIn = metaIn.FadeInTime;
  if (metaIn.FadeOutTime !== undefined) extra.fadeOut = metaIn.FadeOutTime;
  if (metaIn.Fps !== undefined) extra.fps = metaIn.Fps;
  if (restricted) extra.restricted = true;
  if (loop) extra.duration = fileDuration;
  const keep: Json[] = [];
  const curveFades: Record<string, Json> = {};
  for (const c of json?.Curves ?? []) {
    const seg: number[] = c.Segments ?? [];
    if (seg.length < 2) continue;
    const keys: Key<number>[] = [{ t: seg[0], v: seg[1] }];
    const firstValue = keys[0].v;
    let lastType = 0;
    for (let i = 2; i < seg.length; ) {
      const type = seg[i];
      const prev = keys[keys.length - 1];
      lastType = type;
      if (type === 0 || type === 2 || type === 3) {
        const t = seg[i + 1];
        const v = seg[i + 2];
        if (type === 2) prev.ease = "stepped";
        if (type === 3) {
          // inverse stepped: the next value right away
          prev.ease = "stepped";
          keys.push({ t: prev.t, v, ease: "stepped" });
        }
        keys.push({ t, v });
        i += 3;
      } else if (type === 1) {
        const pts = [
          [prev.t, prev.v],
          [seg[i + 1], seg[i + 2]],
          [seg[i + 3], seg[i + 4]],
          [seg[i + 5], seg[i + 6]],
        ];
        i += 7;
        const emit = (p: number[][], depth: number) => {
          const from = keys[keys.length - 1];
          const dt = p[3][0] - p[0][0];
          const dv = p[3][1] - p[0][1];
          const flatHandles = Math.abs(p[1][1] - p[0][1]) < 1e-9 && Math.abs(p[2][1] - p[0][1]) < 1e-9;
          if (Math.abs(dv) < 1e-9 && !flatHandles && depth < 4) {
            const [a, b] = splitBezier(p, 0.5);
            emit(a, depth + 1);
            emit(b, depth + 1);
            return;
          }
          if (Math.abs(dv) >= 1e-9 && dt > 0) {
            const x1 = restricted ? 1 / 3 : Math.min(1, Math.max(0, (p[1][0] - p[0][0]) / dt));
            const x2 = restricted ? 2 / 3 : Math.min(1, Math.max(0, (p[2][0] - p[0][0]) / dt));
            const y1 = (p[1][1] - p[0][1]) / dv;
            const y2 = (p[2][1] - p[0][1]) / dv;
            const linear = Math.abs(x1 - y1) < 1e-7 && Math.abs(x2 - y2) < 1e-7;
            if (!linear) from.ease = [x1, y1, x2, y2].map((n) => Math.round(n * 1e7) / 1e7) as [number, number, number, number];
          }
          keys.push({ t: Math.round(p[3][0] * 1e7) / 1e7, v: Math.round(p[3][1] * 1e7) / 1e7 });
        };
        emit(pts, 0);
      } else {
        notes.push(`curve ${c.Id}: unknown segment type ${type}, rest of the curve skipped`);
        break;
      }
    }
    // the loop closes linearly from the last point back to the first value
    const last = keys[keys.length - 1];
    if (loop && last.t < duration - 1e-6 && Math.abs(last.v - firstValue) > 1e-9) {
      if (lastType === 2) last.ease = "stepped";
      if (lastType === 3) {
        last.ease = "stepped";
        keys.push({ t: last.t, v: firstValue, ease: "stepped" });
      }
      keys.push({ t: duration, v: firstValue });
    }
    if (c.FadeInTime !== undefined || c.FadeOutTime !== undefined) curveFades[`${c.Target}/${c.Id}`] = { fadeIn: c.FadeInTime, fadeOut: c.FadeOutTime };
    if (c.Target === "Parameter") (anim.params ??= {})[c.Id] = keys;
    else if (c.Target === "PartOpacity") (anim.partOpacity ??= {})[c.Id] = keys;
    else keep.push(c);
  }
  if (keep.length) {
    extra.curves = keep;
    notes.push(`${keep.length} "Model" curve(s) (model opacity, eye blink / lip sync) kept for export only`);
  }
  if (Object.keys(curveFades).length) extra.curveFades = curveFades;
  const ud = json?.UserData ?? [];
  if (ud.length) anim.events = ud.map((u: Json) => ({ t: u.Time ?? 0, name: "user", string: String(u.Value ?? "") }));
  return { anim, extra, notes };
}
