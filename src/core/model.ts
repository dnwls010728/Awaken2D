import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FORMAT_ID, LEGACY_FORMAT_IDS, MODEL_TARGETS } from "./types.ts";
import type { Bone, Combo, IkConstraint, Model, ModelTarget, Parameter, PhysicsConstraint, Slot, Warp } from "./types.ts";

/** Default Live2D canvas of a new model: 2048 x 2048 pixels, world (0, 0) in the middle. */
export const DEFAULT_LIVE2D_CANVAS = { width: 2048, height: 2048, originX: 1024, originY: 1024, pixelsPerUnit: 2048 };

export function emptyModel(name: string, target?: ModelTarget): Model {
  return {
    format: FORMAT_ID,
    name,
    ...(target ? { target } : {}),
    ...(target === "live2d" ? { live2d: { canvas: { ...DEFAULT_LIVE2D_CANVAS }, parts: [], deformers: [] } } : {}),
    images: {},
    bones: [{ id: "root", parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 }],
    slots: [],
    attachments: {},
    animations: {},
  };
}

/** Fills optional fields with defaults so runtime code can rely on them. Does not validate. */
export function normalizeModel(raw: unknown): Model {
  return moveOrphanMotionCurves(normalizeFields(raw));
}

/**
 * Live2D motions imported before Awaken2D kept them aside could hold curves for parameters or parts the moc does not
 * have (Cubism ignores them). They move to the motion's meta (`meta.live2d.motions[name].orphanKeys`), where the
 * export still writes them, so they neither fail validation nor show up as tracks. Returns the model (a changed copy
 * of its meta and animations when there were any).
 */
function moveOrphanMotionCurves(model: Model): Model {
  const motions = (model.meta?.live2d as { motions?: Record<string, Record<string, unknown>> } | undefined)?.motions;
  if (!model.live2d || !motions) return model;
  const params = new Set((model.parameters ?? []).map((p) => p.id));
  const parts = new Set(model.live2d.parts.map((p) => p.id));
  let animations = model.animations;
  let moved: Record<string, Record<string, unknown>> | null = null;
  for (const [name, anim] of Object.entries(model.animations ?? {})) {
    if (!motions[name]) continue;
    const orphans: { params?: Record<string, unknown>; partOpacity?: Record<string, unknown> } = {};
    const next = { ...anim };
    for (const [kind, known] of [["params", params], ["partOpacity", parts]] as const) {
      const keys = anim[kind];
      if (!keys || Object.keys(keys).every((id) => known.has(id))) continue;
      const kept: Record<string, unknown> = {};
      for (const [id, k] of Object.entries(keys)) (known.has(id) ? kept : (orphans[kind] ??= {}))[id] = k;
      if (Object.keys(kept).length) (next as Record<string, unknown>)[kind] = kept;
      else delete next[kind];
    }
    if (!orphans.params && !orphans.partOpacity) continue;
    animations = { ...animations, [name]: next };
    moved ??= { ...motions };
    const prev = (motions[name].orphanKeys ?? {}) as typeof orphans;
    moved[name] = {
      ...motions[name],
      orphanKeys: { ...(prev.params || orphans.params ? { params: { ...prev.params, ...orphans.params } } : {}), ...(prev.partOpacity || orphans.partOpacity ? { partOpacity: { ...prev.partOpacity, ...orphans.partOpacity } } : {}) },
    };
  }
  if (!moved) return model;
  return { ...model, animations, meta: { ...model.meta, live2d: { ...(model.meta!.live2d as object), motions: moved } } };
}

function normalizeFields(raw: unknown): Model {
  if (!raw || typeof raw !== "object") throw new Error("model must be a JSON object");
  const m = raw as Partial<Model>;
  const bones: Bone[] = (Array.isArray(m.bones) ? m.bones : []).map((b: Partial<Bone>) => ({
    id: String(b.id),
    parent: b.parent ?? null,
    x: b.x ?? 0,
    y: b.y ?? 0,
    rotation: b.rotation ?? 0,
    scaleX: b.scaleX ?? 1,
    scaleY: b.scaleY ?? 1,
    ...(b.shearX ? { shearX: b.shearX } : {}),
    ...(b.shearY ? { shearY: b.shearY } : {}),
    length: b.length ?? 0,
    ...(b.inherit && b.inherit !== "normal" ? { inherit: b.inherit } : {}),
    ...(b.skin ? { skin: true } : {}),
  }));
  const slots: Slot[] = (Array.isArray(m.slots) ? m.slots : []).map((s: Partial<Slot>) => ({
    id: String(s.id),
    bone: String(s.bone),
    attachment: s.attachment ?? null,
    color: s.color ?? "#ffffff",
    ...(s.blend && s.blend !== "normal" ? { blend: s.blend } : {}),
    ...(Array.isArray(s.clip) ? (s.clip.length ? { clip: s.clip.map(String) } : {}) : s.clip ? { clip: String(s.clip) } : {}),
    ...(s.clipInvert ? { clipInvert: true } : {}),
    ...(s.cull ? { cull: true } : {}),
    ...(typeof s.dark === "string" ? { dark: s.dark } : {}),
  }));
  return {
    format: m.format && !LEGACY_FORMAT_IDS.includes(m.format) ? m.format : FORMAT_ID,
    name: m.name ?? "untitled",
    ...(MODEL_TARGETS.includes(m.target as ModelTarget) ? { target: m.target } : {}),
    ...(m.meta ? { meta: m.meta } : {}),
    images: m.images ?? {},
    bones,
    slots,
    attachments: m.attachments ?? {},
    animations: m.animations ?? {},
    ...(m.events && typeof m.events === "object" && Object.keys(m.events).length ? { events: m.events } : {}),
    ...(Array.isArray(m.ik) && m.ik.length
      ? {
          ik: m.ik.map((c: Partial<IkConstraint>) => ({
            id: String(c.id),
            bones: Array.isArray(c.bones) ? c.bones.map(String) : [],
            target: String(c.target),
            mix: c.mix ?? 1,
            bendPositive: c.bendPositive ?? true,
            ...(c.softness ? { softness: c.softness } : {}),
            ...(c.compress ? { compress: true } : {}),
            ...(c.stretch ? { stretch: true } : {}),
            ...(c.scaleY ? { scaleY: c.scaleY } : {}),
            ...(c.skin ? { skin: true } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(m.physics) && m.physics.length
      ? { physics: m.physics.map((c: Partial<PhysicsConstraint>) => ({ ...PHYSICS_DEFAULTS, ...c, id: String(c.id), bones: Array.isArray(c.bones) ? c.bones.map(String) : [] })) }
      : {}),
    ...normalizeParams(m),
    ...(m.live2d && typeof m.live2d === "object" ? { live2d: m.live2d } : {}),
    // Spine constraints, skins and path attachments are kept as they are
    ...(Array.isArray(m.transforms) && m.transforms.length ? { transforms: m.transforms } : {}),
    ...(Array.isArray(m.paths) && m.paths.length ? { paths: m.paths } : {}),
    ...(Array.isArray(m.spinePhysics) && m.spinePhysics.length ? { spinePhysics: m.spinePhysics } : {}),
    ...(Array.isArray(m.sliders) && m.sliders.length ? { sliders: m.sliders } : {}),
    ...(Array.isArray(m.constraintOrder) && m.constraintOrder.length ? { constraintOrder: m.constraintOrder.map(String) } : {}),
    ...(m.skins && typeof m.skins === "object" && Object.keys(m.skins).length ? { skins: m.skins } : {}),
    ...(typeof m.skin === "string" ? { skin: m.skin } : {}),
    ...(m.pathAttachments && typeof m.pathAttachments === "object" && Object.keys(m.pathAttachments).length ? { pathAttachments: m.pathAttachments } : {}),
    ...(m.clippings && typeof m.clippings === "object" && Object.keys(m.clippings).length ? { clippings: m.clippings } : {}),
    ...(m.boundingBoxes && typeof m.boundingBoxes === "object" && Object.keys(m.boundingBoxes).length ? { boundingBoxes: m.boundingBoxes } : {}),
    ...(typeof m.referenceScale === "number" ? { referenceScale: m.referenceScale } : {}),
  };
}

/** Adds parameters/warps from raw JSON (defaults filled) to a normalized model. */
function normalizeParams(m: Partial<Model>): Pick<Model, "parameters" | "warps" | "combos"> {
  const out: Pick<Model, "parameters" | "warps" | "combos"> = {};
  if (Array.isArray(m.combos) && m.combos.length) {
    out.combos = m.combos.map((c: Partial<Combo>) => ({
      id: String(c.id),
      params: Array.isArray(c.params) ? c.params.map(String) : [],
      keys: Array.isArray(c.keys) ? c.keys : [],
    }));
  }
  if (Array.isArray(m.parameters) && m.parameters.length) {
    out.parameters = m.parameters.map((p: Partial<Parameter>) => {
      const min = p.min ?? 0;
      const max = p.max ?? 1;
      return { ...p, id: String(p.id), min, max, default: p.default ?? Math.min(max, Math.max(min, 0)) } as Parameter;
    });
  }
  if (Array.isArray(m.warps) && m.warps.length) {
    out.warps = m.warps.map((w: Partial<Warp>) => ({
      id: String(w.id),
      rect: w.rect ?? { x: 0, y: 0, width: 1, height: 1 },
      cols: w.cols ?? 2,
      rows: w.rows ?? 2,
      targets: Array.isArray(w.targets) ? w.targets.map(String) : [],
    }));
  }
  return out;
}

export const PHYSICS_DEFAULTS: Omit<PhysicsConstraint, "id" | "bones"> = {
  frequency: 2,
  damping: 0.3,
  gravity: [0, 0],
  inertia: 1,
  mix: 1,
  limit: 0,
};

export interface LoadedModel {
  model: Model;
  path: string;
  baseDir: string;
}

export function loadModel(path: string): LoadedModel {
  const full = resolve(path);
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (e) {
    throw new Error(`cannot read model file ${full}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`model file ${full} is not valid JSON: ${(e as Error).message}`);
  }
  return { model: normalizeModel(raw), path: full, baseDir: dirname(full) };
}

export function saveModel(path: string, model: Model): void {
  writeFileSync(path, serializeModel(model) + "\n", "utf8");
}

/** Serializes with defaults stripped and compact numeric arrays for readable diffs. */
export function serializeModel(model: Model): string {
  const out: Record<string, unknown> = {
    format: model.format,
    name: model.name,
  };
  if (model.target) out.target = model.target;
  if (model.meta && Object.keys(model.meta).length) out.meta = model.meta;
  if (model.images && Object.keys(model.images).length) out.images = model.images;
  out.bones = model.bones.map((b) => {
    const o: Record<string, unknown> = { id: b.id, parent: b.parent };
    if (b.x !== 0) o.x = b.x;
    if (b.y !== 0) o.y = b.y;
    if (b.rotation !== 0) o.rotation = b.rotation;
    if (b.scaleX !== 1) o.scaleX = b.scaleX;
    if (b.scaleY !== 1) o.scaleY = b.scaleY;
    if (b.shearX) o.shearX = b.shearX;
    if (b.shearY) o.shearY = b.shearY;
    if (b.length !== 0) o.length = b.length;
    if (b.inherit && b.inherit !== "normal") o.inherit = b.inherit;
    if (b.skin) o.skin = true;
    return o;
  });
  out.slots = model.slots.map((s) => {
    const o: Record<string, unknown> = { id: s.id, bone: s.bone, attachment: s.attachment };
    if (s.color.toLowerCase() !== "#ffffff" && s.color.toLowerCase() !== "#ffffffff") o.color = s.color;
    if (s.blend && s.blend !== "normal") o.blend = s.blend;
    if (s.clip) o.clip = s.clip;
    if (s.clipInvert) o.clipInvert = true;
    if (s.cull) o.cull = true;
    if (s.dark) o.dark = s.dark;
    return o;
  });
  out.attachments = model.attachments;
  if (model.ik?.length) {
    out.ik = model.ik.map((c) => {
      const o: Record<string, unknown> = { id: c.id, bones: c.bones, target: c.target };
      if (c.mix !== 1) o.mix = c.mix;
      if (!c.bendPositive) o.bendPositive = false;
      if (c.softness) o.softness = c.softness;
      if (c.compress) o.compress = true;
      if (c.stretch) o.stretch = true;
      if (c.scaleY) o.scaleY = c.scaleY;
      if (c.skin) o.skin = true;
      return o;
    });
  }
  if (model.parameters?.length) out.parameters = model.parameters;
  if (model.warps?.length) out.warps = model.warps;
  if (model.combos?.length) out.combos = model.combos;
  if (model.events && Object.keys(model.events).length) out.events = model.events;
  if (model.live2d) out.live2d = model.live2d;
  if (model.physics?.length) {
    out.physics = model.physics.map((c) => {
      const o: Record<string, unknown> = { id: c.id, bones: c.bones };
      for (const k of ["frequency", "damping", "gravity", "inertia", "mix", "limit"] as const) {
        if (JSON.stringify(c[k]) !== JSON.stringify(PHYSICS_DEFAULTS[k])) o[k] = c[k];
      }
      return o;
    });
  }
  if (model.transforms?.length) out.transforms = model.transforms;
  if (model.paths?.length) out.paths = model.paths;
  if (model.spinePhysics?.length) out.spinePhysics = model.spinePhysics;
  if (model.sliders?.length) out.sliders = model.sliders;
  if (model.constraintOrder?.length) out.constraintOrder = model.constraintOrder;
  if (model.skins && Object.keys(model.skins).length) out.skins = model.skins;
  if (model.skin !== undefined) out.skin = model.skin;
  if (model.pathAttachments && Object.keys(model.pathAttachments).length) out.pathAttachments = model.pathAttachments;
  if (model.clippings && Object.keys(model.clippings).length) out.clippings = model.clippings;
  if (model.boundingBoxes && Object.keys(model.boundingBoxes).length) out.boundingBoxes = model.boundingBoxes;
  if (model.referenceScale !== undefined) out.referenceScale = model.referenceScale;
  out.animations = model.animations ?? {};
  return stringifyCompact(out);
}

/**
 * JSON.stringify variant: values that fit on one line (<= width) are inlined,
 * and arrays of inlined arrays are packed several per line.
 */
export function stringifyCompact(value: unknown, width = 100): string {
  return write(value, 0);

  function write(v: unknown, indent: number): string {
    const flat = JSON.stringify(v);
    if (flat === undefined) return "null";
    if (typeof v !== "object" || v === null) return flat;
    const pad = " ".repeat(indent);
    const inner = " ".repeat(indent + 2);
    if (indent > 0 && flat.length + indent <= width && !hasNestedContainers(v, 2)) return flat;
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const parts = v.map((e) => write(e, indent + 2));
      if (parts.every((p) => !p.includes("\n") && p.length < 40)) {
        // pack
        const lines: string[] = [];
        let line = "";
        for (const p of parts) {
          if (line && inner.length + line.length + p.length + 2 > width) {
            lines.push(line + ",");
            line = "";
          }
          line = line ? line + ", " + p : p;
        }
        if (line) lines.push(line);
        return "[\n" + lines.map((l) => inner + l).join("\n") + "\n" + pad + "]";
      }
      return "[\n" + parts.map((p) => inner + p).join(",\n") + "\n" + pad + "]";
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, e]) => e !== undefined);
    if (entries.length === 0) return "{}";
    return (
      "{\n" +
      entries.map(([k, e]) => inner + JSON.stringify(k) + ": " + write(e, indent + 2)).join(",\n") +
      "\n" +
      pad +
      "}"
    );
  }

  function hasNestedContainers(v: unknown, depth: number): boolean {
    if (typeof v !== "object" || v === null) return false;
    if (depth === 0) return true;
    const children = Array.isArray(v) ? v : Object.values(v);
    return children.some((c) => hasNestedContainers(c, depth - 1));
  }
}
