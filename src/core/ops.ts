// Declarative edit operations. Every mutation an agent (or the CLI) makes goes through
// applyOps, which is atomic: either every op succeeds or the model is left untouched.

import { autoWeights, ellipsePolygon, meshFromPolygon, meshFromRect } from "./geometry.ts";
import { DEG, angleOf, apply, fromTRS, invert, isColor, mul, round } from "./math.ts";
import { boneEnds, computePose } from "./pose.ts";
import type { Pose } from "./pose.ts";
import { isChannelEases, isEase } from "./animation.ts";
import { wrapDeg } from "./ik.ts";
import { PHYSICS_DEFAULTS } from "./model.ts";
import { WARP_PRESETS, findParameter, toSparse, transformOffsets, warpGrid, warpPresetOffsets } from "./params.ts";
import type { ShapeTransform, WarpPreset } from "./params.ts";
import { addVertex, adjustWeights, moveVertices, removeVertices, retriangulate, transferToPoints, weightMask } from "./meshedit.ts";
import type { WeightMode } from "./meshedit.ts";
import {
  LIVE2D_OP_NAMES,
  applyLive2DOp,
  moveLive2DVertices,
  refreshLive2DVertices,
  remapLive2DForms,
  renameLive2DAttachment,
  renameLive2DParam,
  renameLive2DSlot,
  toLive2DMesh,
} from "./live2dops.ts";
import { DEFAULT_LIVE2D_CANVAS } from "./model.ts";
import type { Live2DOp } from "./live2dops.ts";
import { BLEND_MODES, INHERITS, MODEL_TARGETS, SPINE_PHYSICS_SETTINGS, TRANSFORM_PROPERTIES } from "./types.ts";
import type { Inherit, PathConstraint, ScaleYMode, Slider, SpinePhysics, TransformConstraint } from "./types.ts";
import type {
  Animation,
  BlendMode,
  Bone,
  BoneChannel,
  Combo,
  ComboKey,
  DeformKey,
  DrawOrderKey,
  EventDef,
  EventKey,
  IkChannel,
  IkConstraint,
  Key,
  MeshAttachment,
  Model,
  ModelTarget,
  ParamKey,
  Parameter,
  PhysicsChannel,
  PhysicsConstraint,
  SlotChannel,
  Tri,
  Vec2,
  VertexOffsets,
  Warp,
} from "./types.ts";

type PhysicsSettings = Partial<Omit<PhysicsConstraint, "id" | "bones">>;

export type Shape =
  | { rect: { x: number; y: number; width: number; height: number }; cols?: number; rows?: number }
  | { polygon: Vec2[]; spacing?: number }
  | { ellipse: { cx: number; cy: number; rx: number; ry: number; segments?: number }; spacing?: number };

export type Op =
  | {
      op: "addBone";
      id: string;
      parent?: string;
      /** Local transform (relative to parent). Ignored when start/end are given. */
      x?: number;
      y?: number;
      rotation?: number;
      length?: number;
      scaleX?: number;
      scaleY?: number;
      shearX?: number;
      shearY?: number;
      /** World-space setup position of the bone origin. */
      start?: Vec2;
      /** World-space setup position of the bone tip; sets rotation and length. */
      end?: Vec2;
    }
  | {
      op: "updateBone";
      id: string;
      parent?: string;
      /** Spine inherit mode ("normal" clears it). */
      inherit?: Inherit;
      /** Spine: the bone exists only while the active skin lists it. */
      skin?: boolean;
      x?: number;
      y?: number;
      rotation?: number;
      length?: number;
      scaleX?: number;
      scaleY?: number;
      start?: Vec2;
      end?: Vec2;
      /**
       * Move the meshes bound to this bone (and its descendants) along with the setup change, as if the skin
       * were attached. Default false: only the bone moves and the art stays put (re-binding).
       */
      carry?: boolean;
    }
  | { op: "removeBone"; id: string }
  | { op: "renameBone"; id: string; to: string }
  | { op: "renameSlot"; id: string; to: string }
  | { op: "addSlot"; id: string; bone: string; attachment?: string | null; color?: string; index?: number; blend?: BlendMode }
  | { op: "updateSlot"; id: string; bone?: string; attachment?: string | null; color?: string; blend?: BlendMode; clip?: string | null; dark?: string | null }
  | { op: "removeSlot"; id: string }
  | { op: "moveSlot"; id: string; index: number }
  | { op: "addImage"; id: string; path: string }
  | {
      op: "addMesh";
      id: string;
      shape: Shape;
      /** Slot to show the mesh in; created when missing. Defaults to the mesh id. */
      slot?: string;
      /** Bone for a newly created slot. Defaults to the first weight bone, then "root". */
      bone?: string;
      color?: string;
      image?: string;
      /** World rect the image covers; defaults to the shape bounds. */
      imageRect?: { x: number; y: number; width: number; height: number };
      /** Bones for automatic weights. Omit for rigid binding to the slot bone. */
      bones?: string[];
      maxInfluences?: number;
      /** Slot draw index when a slot is created (default: front). */
      index?: number;
    }
  | { op: "autoWeight"; attachment: string; bones: string[]; maxInfluences?: number; power?: number }
  | { op: "setWeights"; attachment: string; weights: Array<Array<[string, number]>> }
  | { op: "removeAttachment"; id: string }
  | { op: "setAnimation"; name: string; duration: number; loop?: boolean }
  | { op: "removeAnimation"; name: string }
  | { op: "renameAnimation"; name: string; to: string }
  | {
      op: "setKeys";
      animation: string;
      bone: string;
      channel: BoneChannel;
      keys: Key<number | Vec2>[];
      /** replace (default) overwrites the track; merge replaces keys at equal times and keeps others. */
      mode?: "replace" | "merge";
      /**
       * "local" (default): values are offsets from the setup pose, as stored.
       * "world": translate values are world positions and rotate values are world angles at each key's
       * time; they are converted to local offsets using the parent's animated pose.
       */
      space?: "local" | "world";
    }
  | { op: "clearKeys"; animation: string; bone?: string; slot?: string; ik?: string; physics?: string; param?: string; channel?: string }
  | {
      op: "addBoneChain";
      /** Bones are named <id>_1 .. <id>_<count>, each the child of the previous one. */
      id: string;
      parent?: string;
      /** World start and end of the whole chain (setup pose). */
      start: Vec2;
      end: Vec2;
      count: number;
    }
  | ({ op: "addPhysics"; id: string; bones: string[] } & PhysicsSettings)
  | ({ op: "updatePhysics"; id: string; bones?: string[] } & PhysicsSettings)
  | { op: "removePhysics"; id: string }
  | { op: "setPhysicsKeys"; animation: string; physics: string; channel: PhysicsChannel; keys: Key<number | Vec2>[]; mode?: "replace" | "merge" }
  | { op: "addParameter"; id: string; min: number; max: number; default?: number; name?: string | null; group?: string | null; decimals?: number; repeat?: boolean }
  | {
      op: "updateParameter";
      id: string;
      min?: number;
      max?: number;
      default?: number;
      /** Display name / group (null clears). */
      name?: string | null;
      group?: string | null;
      /** Live2D: decimal places (key snap tolerance) and wrap-around. */
      decimals?: number;
      repeat?: boolean;
    }
  | { op: "renameParameter"; id: string; to: string }
  | { op: "removeParameter"; id: string }
  | { op: "setParamBoneKeys"; parameter: string; bone: string; channel: BoneChannel; keys: ParamKey<number | Vec2>[]; mode?: "replace" | "merge" }
  | { op: "setParamSlotKeys"; parameter: string; slot: string; channel: SlotChannel; keys: ParamKey<string | null>[]; mode?: "replace" | "merge" }
  | {
      op: "setParamShape";
      parameter: string;
      attachment: string;
      /** Each key: explicit sparse offsets and/or a transform of the mesh's setup vertices (summed). */
      keys: Array<{ at: number; offsets?: VertexOffsets; transform?: ShapeTransform }>;
      mode?: "replace" | "merge";
    }
  | { op: "addWarp"; id: string; targets: string[]; rect?: { x: number; y: number; width: number; height: number }; cols?: number; rows?: number; padding?: number }
  | { op: "updateWarp"; id: string; targets?: string[] }
  | { op: "removeWarp"; id: string }
  | {
      op: "setParamWarp";
      parameter: string;
      warp: string;
      /** Each key: presets, explicit control-point offsets and/or a transform of the control points (summed). */
      keys: Array<{
        at: number;
        preset?: WarpPreset;
        amount?: number;
        presets?: Array<{ preset: WarpPreset; amount: number }>;
        offsets?: Vec2[];
        transform?: ShapeTransform;
      }>;
      mode?: "replace" | "merge";
    }
  | { op: "clearParamKeys"; parameter: string; bone?: string; slot?: string; attachment?: string; warp?: string }
  | {
      op: "setMeshGeometry";
      attachment: string;
      vertices: Vec2[];
      triangles: Tri[];
      uvs?: Vec2[];
      /** Default: carried over from the old mesh (barycentric), like blend shapes and combo shapes. */
      weights?: Array<Array<[string, number]>>;
    }
  | { op: "addCombo"; id: string; params: string[] }
  | { op: "removeCombo"; id: string }
  | {
      op: "setComboKey";
      combo: string;
      /** One value per combo parameter. */
      at: number[];
      bones?: Record<string, { rotate?: number; translate?: Vec2; scale?: Vec2 }>;
      /** Per attachment: sparse offsets and/or a transform of its setup vertices (summed), as in setParamShape. */
      meshes?: Record<string, MeshKeySpec>;
      /** Per warp: presets, offsets and/or a transform of its control points (summed), as in setParamWarp. */
      warps?: Record<string, WarpKeySpec>;
      /** merge (default): replaces only the targets given in an existing key; replace: the whole key. */
      mode?: "replace" | "merge";
    }
  | { op: "removeComboKey"; combo: string; at: number[] }
  | { op: "setParamTrack"; animation: string; parameter: string; keys: Key<number>[]; mode?: "replace" | "merge" }
  | {
      op: "moveVertices";
      attachment: string;
      /** [vertexIndex, x, y] absolute setup-space positions. */
      moves: Array<[number, number, number]>;
      /** Default true: UVs follow so the image stays in place; false stretches the image with the vertices. */
      keepImage?: boolean;
    }
  | { op: "addVertex"; attachment: string; at: Vec2 }
  | { op: "removeVertices"; attachment: string; indices: number[] }
  | { op: "retriangulate"; attachment: string }
  | {
      op: "adjustWeights";
      attachment: string;
      /** Bone whose influence changes (ignored by "smooth"). */
      bone?: string;
      mode: WeightMode;
      /** set: target weight 0..1; add: delta; multiply: factor. */
      value?: number;
      /** Which vertices: explicit indices, a circle (optionally with smooth falloff), or all when omitted. */
      vertices?: number[];
      region?: { center: Vec2; radius: number; falloff?: boolean };
    }
  | {
      op: "addIk";
      id: string;
      /** [bone] or [parent, child]. */
      bones: string[];
      /** Existing target bone. When omitted a target bone "<id>_target" is created. */
      target?: string;
      /** Parent for a created target (default: the root). */
      targetParent?: string;
      /** World position for a created target (default: the chain tip, so the pose does not jump). */
      targetPosition?: Vec2;
      /** Default: inferred from the current bend of the chain. */
      bendPositive?: boolean;
      mix?: number;
    }
  | {
      op: "updateIk";
      id: string;
      bones?: string[];
      target?: string;
      bendPositive?: boolean;
      mix?: number;
      softness?: number;
      compress?: boolean;
      stretch?: boolean;
      /** "none" clears it. */
      scaleY?: ScaleYMode | "none";
      skin?: boolean;
    }
  | { op: "removeIk"; id: string; removeTarget?: boolean }
  | { op: "moveIk"; id: string; index: number }
  | { op: "setIkKeys"; animation: string; ik: string; channel: IkChannel; keys: Key<number | boolean>[]; mode?: "replace" | "merge" }
  | { op: "setSlotKeys"; animation: string; slot: string; channel: SlotChannel; keys: Key<string | null>[]; mode?: "replace" | "merge" }
  | { op: "setDrawOrderKeys"; animation: string; keys: DrawOrderKey[]; mode?: "replace" | "merge" }
  | {
      op: "setDeformKeys";
      animation: string;
      attachment: string;
      /** Each key: sparse setup-space offsets and/or a transform of the setup vertices (summed). */
      keys: Array<{ t: number; offsets?: VertexOffsets; transform?: ShapeTransform; ease?: Key<unknown>["ease"]; local?: { offset: number; values: number[] } }>;
      mode?: "replace" | "merge";
    }
  | { op: "setEvent"; name: string; int?: number; float?: number; string?: string; audio?: string; volume?: number; balance?: number; remove?: boolean }
  | { op: "setEventKeys"; animation: string; keys: EventKey[]; mode?: "replace" | "merge" }
  | { op: "setMeta"; name?: string; meta?: Record<string, unknown> }
  | { op: "setTarget"; target: ModelTarget }
  /** Adds or replaces (by id) a Spine transform / path / physics constraint or slider: the full definition. */
  | { op: "setConstraint"; kind: SpineConstraintKind; constraint: TransformConstraint | PathConstraint | SpinePhysics | Slider }
  /** Changes some fields of a Spine constraint (null removes an optional field). */
  | { op: "updateConstraint"; kind: SpineConstraintKind; id: string; set: Record<string, unknown> }
  | { op: "removeConstraint"; kind: SpineConstraintKind; id: string }
  /** Evaluation order of all constraints, as "<kind>:<id>" (kind: ik, transform, path, physics, slider). */
  | { op: "setConstraintOrder"; order: string[] }
  /**
   * Keys of a Spine constraint timeline. transform: rotate x y scaleX scaleY shearY (mixes); path: position spacing
   * rotate x y; physics: inertia strength damping mass wind gravity mix, or reset (keys without values: restart
   * times; constraint "" = the global settings of every physics constraint); slider: time mix.
   */
  | { op: "setConstraintKeys"; animation: string; kind: SpineConstraintKind; constraint: string; channel: string; keys: Key<number>[]; mode?: "replace" | "merge" }
  /** Active skin (null: only the default attachments). */
  | { op: "setSkin"; name: string | null }
  | { op: "addSkin"; name: string; copyOf?: string }
  | { op: "removeSkin"; name: string }
  | { op: "renameSkin"; name: string; to: string }
  /** In a skin, which attachment a slot shows for a placeholder (attachment null removes the entry). */
  | { op: "setSkinAttachment"; skin: string; slot: string; placeholder: string; attachment: string | null }
  /** The skin-only bones and constraints ("<kind>:<id>") a skin turns on. */
  | { op: "setSkinBones"; skin: string; bones?: string[]; constraints?: string[] }
  /** Spine clipping attachment settings: the last slot it clips (null: to the end), convex hull, inverse. */
  | { op: "updateClipping"; id: string; end?: string | null; convex?: boolean; inverse?: boolean }
  /**
   * Spine bounding box: its outline color (null: Spine's default), and/or a new polygon (setup-pose world space;
   * weights per vertex, else each new vertex takes the weights of the nearest old one).
   */
  | { op: "updateBoundingBox"; id: string; color?: string | null; vertices?: Vec2[]; weights?: Array<Array<[string, number]>> }
  | Live2DOp;

export const OP_NAMES: Op["op"][] = [
  "addBone", "updateBone", "removeBone", "renameBone", "renameSlot", "addSlot", "updateSlot", "removeSlot", "moveSlot", "addImage",
  "addMesh", "autoWeight", "setWeights", "removeAttachment", "setAnimation", "removeAnimation",
  "renameAnimation", "setKeys", "clearKeys", "setSlotKeys", "setDrawOrderKeys", "setDeformKeys", "setEvent", "setEventKeys", "setMeta", "setMeshGeometry", "addCombo", "removeCombo", "setComboKey", "removeComboKey", "addIk", "updateIk", "removeIk", "moveIk",
  "setIkKeys", "addBoneChain", "addPhysics", "updatePhysics", "removePhysics", "setPhysicsKeys", "addParameter",
  "updateParameter", "renameParameter", "removeParameter", "setParamBoneKeys", "setParamSlotKeys", "setParamShape", "addWarp", "updateWarp",
  "removeWarp", "setParamWarp", "clearParamKeys", "setParamTrack", "moveVertices", "addVertex", "removeVertices",
  "retriangulate", "adjustWeights", "setTarget",
  "setConstraint", "updateConstraint", "removeConstraint", "setConstraintOrder", "setConstraintKeys",
  "setSkin", "addSkin", "removeSkin", "renameSkin", "setSkinAttachment", "setSkinBones", "updateClipping", "updateBoundingBox", ...LIVE2D_OP_NAMES,
];

export interface MeshKeySpec {
  offsets?: VertexOffsets;
  transform?: ShapeTransform;
}
export interface WarpKeySpec {
  preset?: WarpPreset;
  amount?: number;
  presets?: Array<{ preset: WarpPreset; amount: number }>;
  offsets?: Vec2[];
  transform?: ShapeTransform;
}

export interface ApplyResult {
  model: Model;
  log: string[];
}

/**
 * Ops that never write to attachments (meshes are the bulk of a model). For these, applyOps shares the
 * attachment objects between input and output instead of deep-copying them; nothing mutates a model outside
 * applyOps, so sharing is safe and keeps interactive edits (dragging a bone every frame) cheap.
 */
const MESH_SAFE_OPS = new Set([
  "addBone", "removeBone", "renameSlot", "addSlot", "updateSlot", "removeSlot", "moveSlot", "addImage",
  "setAnimation", "removeAnimation", "renameAnimation", "setKeys", "clearKeys", "setSlotKeys", "setDrawOrderKeys", "setDeformKeys", "setEvent", "setEventKeys", "addIk",
  "updateIk", "removeIk", "moveIk", "setIkKeys", "addPhysics", "updatePhysics", "removePhysics", "setPhysicsKeys",
  "addParameter", "updateParameter", "removeParameter", "setParamBoneKeys", "setParamSlotKeys", "clearParamKeys",
  "setParamTrack", "addCombo", "removeCombo", "setComboKey", "removeComboKey",
  "setConstraint", "updateConstraint", "removeConstraint", "setConstraintOrder", "setConstraintKeys",
  "setSkin", "addSkin", "removeSkin", "renameSkin", "setSkinAttachment", "setSkinBones", "updateClipping", "updateBoundingBox",
]);

/** Ops that may change the Live2D rig (they replace model.live2d, so the others can share it). */
const LIVE2D_TOUCHING = new Set<string>(["removeParameter", "renameParameter", "renameSlot", "removeSlot", "removeAttachment", "removeVertices", "setMeshGeometry", ...LIVE2D_OP_NAMES]);

function cloneFor(model: Model, ops: Op[]): Model {
  // updateBone (with or without carry) replaces attachment objects rather than editing them; Live2D ops replace
  // the attachments and the rig they change (copy on write)
  const l2dOps = new Set<string>(LIVE2D_OP_NAMES);
  const safe = ops.every((o) => o && (MESH_SAFE_OPS.has(o.op) || o.op === "updateBone" || l2dOps.has(o.op)));
  const { attachments, live2d, ...rest } = model;
  const shareRig = ops.every((o) => o && !LIVE2D_TOUCHING.has(o.op)) || ops.every((o) => o && l2dOps.has(o.op));
  const rig = live2d === undefined ? {} : { live2d: shareRig ? live2d : structuredClone(live2d) };
  if (!safe) return { ...structuredClone(rest), attachments: structuredClone(attachments), ...rig } as Model;
  return { ...structuredClone(rest), attachments: { ...attachments }, ...rig } as Model;
}

/** Applies ops to a copy of the model. Throws (with the failing op index) on the first error. */
export function applyOps(model: Model, ops: Op[]): ApplyResult {
  if (!Array.isArray(ops)) throw new Error("ops must be an array");
  const m = cloneFor(model, ops);
  const log: string[] = [];
  ops.forEach((op, i) => {
    try {
      log.push(applyOne(m, op));
    } catch (e) {
      throw new Error(`op #${i} (${(op as { op?: string })?.op ?? "?"}) failed: ${(e as Error).message}`);
    }
  });
  return { model: m, log };
}

// ---------- what each kind of model may use

/** Bones, weights, IK and their timelines: Spine models only. */
const SPINE_ONLY = new Set<string>([
  "addBone", "updateBone", "removeBone", "renameBone", "autoWeight", "setWeights", "adjustWeights", "setKeys", "setSlotKeys",
  "setDrawOrderKeys", "setDeformKeys", "addIk", "updateIk", "removeIk", "moveIk", "setIkKeys", "addBoneChain",
  "setConstraint", "updateConstraint", "removeConstraint", "setConstraintOrder", "setConstraintKeys",
  "setSkin", "addSkin", "removeSkin", "renameSkin", "setSkinAttachment", "setSkinBones", "updateClipping", "updateBoundingBox",
]);
/** Awaken2D's spring bones: Spine export drops them (Spine 4.2 physics constraints work differently), Live2D has physics3. */
const SPRING_OPS = new Set<string>(["addPhysics", "updatePhysics", "removePhysics", "setPhysicsKeys"]);
/** Parameters and the Live2D rig: Live2D models only. */
const LIVE2D_ONLY = new Set<string>(["addParameter", "updateParameter", "renameParameter", "removeParameter", "setParamTrack", ...LIVE2D_OP_NAMES]);
/** Awaken2D's own parameter effects (bone keys, blend shapes, warps, combos): neither format has them. */
const UNTARGETED_ONLY = new Set<string>([
  "setParamBoneKeys", "setParamSlotKeys", "setParamShape", "addWarp", "updateWarp", "removeWarp", "setParamWarp", "clearParamKeys",
  "addCombo", "removeCombo", "setComboKey", "removeComboKey",
]);

/** Refuses ops the model's target (Spine or Live2D) does not support. Models without a target allow everything. */
function checkTarget(m: Model, op: Op): void {
  const t = m.target;
  if (!t || !op || typeof op !== "object") return;
  const name = op.op;
  if (SPRING_OPS.has(name)) {
    throw new Error(`${name} (Awaken2D spring bones) is not exported to ${t === "spine" ? "Spine" : "Live2D"}, so ${t} models do not use it${t === "spine" ? "; animate secondary motion with bone keys" : "; Live2D physics comes from physics3 (rig_live2d_import)"}`);
  }
  if (UNTARGETED_ONLY.has(name)) {
    throw new Error(`${name} (Awaken2D's own parameter effects) exports to neither Spine nor Live2D, so ${t} models do not use it${t === "live2d" ? "; shape Live2D keyforms with setKeyform / setKeyformKeys" : ""}`);
  }
  if (t === "live2d" && SPINE_ONLY.has(name)) {
    throw new Error(`${name} is for Spine models (bones, weights, IK and bone / slot / deform / draw-order timelines); this is a Live2D model: use deformers, keyforms and parameter tracks`);
  }
  if (t === "spine" && LIVE2D_ONLY.has(name)) {
    throw new Error(`${name} is for Live2D models (parameters, keyforms, deformers, parts); this is a Spine model: use bones, weights and timelines`);
  }
  if (op.op === "clearKeys") {
    if (t === "spine" && op.param) throw new Error("Spine models have no parameter tracks");
    if (t === "live2d" && (op.bone || op.slot || op.ik || op.physics)) throw new Error("Live2D models only have parameter, part-opacity and event tracks");
    if (t === "spine" && op.physics) throw new Error("Spine models have no spring-bone tracks");
  }
  if (t === "live2d") {
    if (op.op === "addSlot" && op.bone !== "root") throw new Error('Live2D models have no bones: slots sit on "root"');
    if (op.op === "addMesh" && ((op.bone && op.bone !== "root") || op.bones?.length)) throw new Error("Live2D models have no bones: add the mesh without bone / bones and place it with deformers");
    if (op.op === "updateSlot" && op.bone !== undefined && op.bone !== "root") throw new Error("Live2D models have no bones");
    if (op.op === "updateSlot" && op.dark) throw new Error("two-color tint (dark) is a Spine feature");
    if (op.op === "setSlotKeys" && op.channel === "dark") throw new Error("two-color tint (dark) is a Spine feature");
  }
}

/** Why a model cannot become the given target (empty when it can). */
export function targetConflicts(m: Model, target: ModelTarget): string[] {
  const out: string[] = [];
  const legacy = (m.parameters ?? []).some((p) => p.bones || p.slots || p.meshes || p.warps) || m.warps?.length || m.combos?.length;
  if (legacy) out.push("Awaken2D parameter effects (bone keys, blend shapes, warps or combos)");
  if (target === "live2d") {
    if (m.bones.length > 1) out.push(`${m.bones.length - 1} bone(s) besides root`);
    if (m.ik?.length) out.push("IK constraints");
    if (m.physics?.length) out.push("spring bones");
    for (const [name, a] of Object.entries(m.animations ?? {})) {
      if (Object.keys(a.bones ?? {}).length || Object.keys(a.slots ?? {}).length || Object.keys(a.deform ?? {}).length || a.drawOrder?.length || Object.keys(a.ik ?? {}).length || Object.keys(a.physics ?? {}).length) {
        out.push(`bone / slot / deform / draw-order / IK / physics tracks in "${name}"`);
      }
    }
  } else {
    if (m.live2d || Object.values(m.attachments).some((a) => a.live2d)) out.push("a Live2D rig");
    if (m.physics?.length) out.push("spring bones (not exported to Spine)");
    for (const [name, a] of Object.entries(m.animations ?? {})) if (Object.keys(a.physics ?? {}).length) out.push(`spring-bone tracks in "${name}"`);
    if (m.parameters?.length) out.push(`${m.parameters.length} parameter(s)`);
    for (const [name, a] of Object.entries(m.animations ?? {})) {
      if (Object.keys(a.params ?? {}).length || Object.keys(a.partOpacity ?? {}).length) out.push(`parameter / part tracks in "${name}"`);
    }
  }
  return out;
}

function applyOne(m: Model, op: Op): string {
  checkTarget(m, op);
  switch (op?.op) {
    case "addBone": {
      assertId(op.id, "id");
      if (findBone(m, op.id)) throw new Error(`bone "${op.id}" already exists`);
      const parent = op.parent ?? m.bones.find((b) => b.parent === null)?.id ?? null;
      if (parent !== null) requireBone(m, parent);
      const bone: Bone = { id: op.id, parent, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 };
      assignLocal(bone, op);
      m.bones.push(bone);
      if (op.start || op.end) placeInWorld(m, bone, op.start, op.end);
      return `added bone ${op.id} (parent ${parent ?? "none"})`;
    }
    case "updateBone": {
      const bone = requireBone(m, op.id);
      const hasBinds = Object.values(m.attachments).some((a) => a.binds);
      const before = op.carry || hasBinds ? computePose(m) : null;
      if (op.parent !== undefined && op.parent !== bone.parent) {
        requireBone(m, op.parent);
        if (isDescendant(m, op.parent, op.id)) throw new Error(`"${op.parent}" is a descendant of "${op.id}"`);
        // keep the world setup transform when re-parenting
        const world = computePose(m).byId.get(op.id)!.world;
        bone.parent = op.parent;
        const pw = computePose(m).byId.get(op.parent)!.world;
        setLocalFromMatrix(bone, mul(invert(pw), world));
      }
      assignLocal(bone, op);
      if (op.inherit !== undefined) {
        if (!INHERITS.includes(op.inherit)) throw new Error(`inherit must be one of ${INHERITS.join(", ")}`);
        if (op.inherit === "normal") delete bone.inherit;
        else bone.inherit = op.inherit;
      }
      if (op.skin !== undefined) {
        if (op.skin) bone.skin = true;
        else delete bone.skin;
      }
      if (op.start || op.end) placeInWorld(m, bone, op.start, op.end);
      if (before && !op.carry) {
        rebindMoved(m, before);
        return `updated bone ${op.id}`;
      }
      if (before) {
        const moved = carryMeshes(m, before);
        return `updated bone ${op.id} (carried ${moved} mesh${moved === 1 ? "" : "es"})`;
      }
      return `updated bone ${op.id}`;
    }
    case "renameBone": {
      const bone = requireBone(m, op.id);
      assertId(op.to, "to");
      if (op.to === op.id) return `bone ${op.id} unchanged`;
      if (findBone(m, op.to)) throw new Error(`bone "${op.to}" already exists`);
      const from = op.id;
      const to = op.to;
      const renameKey = <T>(rec: Record<string, T> | undefined) => {
        if (rec && from in rec) {
          rec[to] = rec[from];
          delete rec[from];
        }
      };
      bone.id = to;
      for (const b of m.bones) if (b.parent === from) b.parent = to;
      for (const s of m.slots) if (s.bone === from) s.bone = to;
      for (const a of Object.values(m.attachments)) for (const w of a.weights) for (const e of w) if (e[0] === from) e[0] = to;
      for (const a of Object.values(m.animations ?? {})) renameKey(a.bones);
      for (const c of m.ik ?? []) {
        c.bones = c.bones.map((b) => (b === from ? to : b));
        if (c.target === from) c.target = to;
      }
      for (const c of m.physics ?? []) c.bones = c.bones.map((b) => (b === from ? to : b));
      const swap = (b: string) => (b === from ? to : b);
      for (const c of m.transforms ?? []) {
        c.bones = c.bones.map(swap);
        c.source = swap(c.source);
      }
      for (const c of m.paths ?? []) c.bones = c.bones.map(swap);
      for (const c of m.spinePhysics ?? []) c.bone = swap(c.bone);
      for (const c of m.sliders ?? []) if (c.bone) c.bone = swap(c.bone);
      for (const sk of Object.values(m.skins ?? {})) if (sk.bones) sk.bones = sk.bones.map(swap);
      for (const a of [...Object.values(m.pathAttachments ?? {}), ...Object.values(m.clippings ?? {}), ...Object.values(m.boundingBoxes ?? {})]) for (const w of a.weights) for (const e of w) if (e[0] === from) e[0] = to;
      for (const p of m.parameters ?? []) renameKey(p.bones);
      for (const c of m.combos ?? []) for (const k of c.keys) renameKey(k.bones);
      return `renamed bone ${from} -> ${to}`;
    }
    case "renameSlot": {
      const slot = requireSlot(m, op.id);
      assertId(op.to, "to");
      if (op.to === op.id) return `slot ${op.id} unchanged`;
      if (m.slots.some((s) => s.id === op.to)) throw new Error(`slot "${op.to}" already exists`);
      const from = op.id;
      renameLive2DSlot(m, from, op.to);
      const to = op.to;
      const renameKey = <T>(rec: Record<string, T> | undefined) => {
        if (rec && from in rec) {
          rec[to] = rec[from];
          delete rec[from];
        }
      };
      slot.id = to;
      for (const s of m.slots) {
        if (s.clip === from) s.clip = to;
        else if (Array.isArray(s.clip)) s.clip = s.clip.map((c) => (c === from ? to : c));
      }
      for (const a of Object.values(m.animations ?? {})) {
        renameKey(a.slots);
        for (const k of a.drawOrder ?? []) for (const e of k.offsets) if (e[0] === from) e[0] = to;
      }
      for (const p of m.parameters ?? []) renameKey(p.slots);
      for (const c of m.paths ?? []) if (c.slot === from) c.slot = to;
      for (const c of Object.values(m.clippings ?? {})) if (c.end === from) c.end = to;
      for (const sk of Object.values(m.skins ?? {})) renameKey(sk.attachments);
      const layers = (m.meta?.import as { layers?: Array<{ slot: string }> } | undefined)?.layers;
      for (const l of layers ?? []) if (l.slot === from) l.slot = to;
      return `renamed slot ${from} -> ${to}`;
    }
    case "removeBone": {
      const bone = requireBone(m, op.id);
      if (bone.parent === null) throw new Error("cannot remove a root bone");
      const kids = m.bones.filter((b) => b.parent === op.id).map((b) => b.id);
      if (kids.length) throw new Error(`bone has children (${kids.join(", ")}); remove or re-parent them first`);
      const slots = m.slots.filter((s) => s.bone === op.id).map((s) => s.id);
      if (slots.length) throw new Error(`bone is used by slots (${slots.join(", ")})`);
      const weighted = Object.entries(m.attachments).filter(([, a]) => a.weights.some((w) => w.some(([b]) => b === op.id)));
      if (weighted.length) throw new Error(`bone is used in weights of ${weighted.map(([k]) => k).join(", ")}; re-weight first`);
      const iks = (m.ik ?? []).filter((c) => c.target === op.id || c.bones.includes(op.id)).map((c) => c.id);
      if (iks.length) throw new Error(`bone is used by IK constraints (${iks.join(", ")}); remove them first`);
      const spineUsers = [
        ...(m.transforms ?? []).filter((c) => c.source === op.id || c.bones.includes(op.id)).map((c) => `transform ${c.id}`),
        ...(m.paths ?? []).filter((c) => c.bones.includes(op.id)).map((c) => `path ${c.id}`),
        ...(m.spinePhysics ?? []).filter((c) => c.bone === op.id).map((c) => `physics ${c.id}`),
        ...(m.sliders ?? []).filter((c) => c.bone === op.id).map((c) => `slider ${c.id}`),
        ...Object.entries(m.pathAttachments ?? {}).filter(([, a]) => a.weights.some((w) => w.some(([b]) => b === op.id))).map(([id]) => `path attachment ${id}`),
        ...Object.entries(m.clippings ?? {}).filter(([, a]) => a.weights.some((w) => w.some(([b]) => b === op.id))).map(([id]) => `clipping attachment ${id}`),
        ...Object.entries(m.boundingBoxes ?? {}).filter(([, a]) => a.weights.some((w) => w.some(([b]) => b === op.id))).map(([id]) => `bounding box ${id}`),
      ];
      if (spineUsers.length) throw new Error(`bone is used by ${spineUsers.join(", ")}; change or remove them first`);
      for (const sk of Object.values(m.skins ?? {})) if (sk.bones) sk.bones = sk.bones.filter((b) => b !== op.id);
      const springs = (m.physics ?? []).filter((c) => c.bones.includes(op.id)).map((c) => c.id);
      if (springs.length) throw new Error(`bone is simulated by physics (${springs.join(", ")}); remove it there first`);
      const knobs = (m.parameters ?? []).filter((p) => p.bones?.[op.id]).map((p) => p.id);
      if (knobs.length) throw new Error(`bone is driven by parameters (${knobs.join(", ")}); clearParamKeys first`);
      const combos = (m.combos ?? []).filter((c) => c.keys.some((k) => k.bones?.[op.id])).map((c) => c.id);
      if (combos.length) throw new Error(`bone is driven by combos (${combos.join(", ")}); remove those keys first`);
      m.bones = m.bones.filter((b) => b.id !== op.id);
      for (const a of Object.values(m.animations ?? {})) if (a.bones) delete a.bones[op.id];
      return `removed bone ${op.id}`;
    }
    case "addSlot": {
      assertId(op.id, "id");
      if (m.slots.some((s) => s.id === op.id)) throw new Error(`slot "${op.id}" already exists`);
      requireBone(m, op.bone);
      if (op.attachment) requireAttachment(m, op.attachment);
      if (op.color !== undefined) assertColor(op.color);
      if (op.blend !== undefined && !BLEND_MODES.includes(op.blend)) throw new Error(`blend must be one of ${BLEND_MODES.join(", ")}`);
      const slot = { id: op.id, bone: op.bone, attachment: op.attachment ?? null, color: op.color ?? "#ffffff", ...(op.blend && op.blend !== "normal" ? { blend: op.blend } : {}) };
      insertAt(m.slots, slot, op.index);
      return `added slot ${op.id}`;
    }
    case "updateSlot": {
      const slot = requireSlot(m, op.id);
      if (op.bone !== undefined) slot.bone = requireBone(m, op.bone).id;
      if (op.attachment !== undefined) {
        if (op.attachment !== null && !isAttachmentKey(m, slot.id, op.attachment)) requireAttachment(m, op.attachment);
        slot.attachment = op.attachment;
      }
      if (op.color !== undefined) slot.color = assertColor(op.color);
      if (op.blend !== undefined) {
        if (!BLEND_MODES.includes(op.blend)) throw new Error(`blend must be one of ${BLEND_MODES.join(", ")}`);
        if (op.blend === "normal") delete slot.blend;
        else slot.blend = op.blend;
      }
      if (op.dark !== undefined) {
        if (op.dark === null) delete slot.dark;
        else slot.dark = assertColor(op.dark).slice(0, 7);
      }
      if (op.clip !== undefined) {
        if (op.clip === null) delete slot.clip;
        else {
          if (op.clip === slot.id) throw new Error("a slot cannot clip itself");
          requireSlot(m, op.clip);
          slot.clip = op.clip;
        }
      }
      return `updated slot ${op.id}`;
    }
    case "removeSlot": {
      requireSlot(m, op.id);
      const pathUsers = (m.paths ?? []).filter((c) => c.slot === op.id).map((c) => c.id);
      if (pathUsers.length) throw new Error(`slot holds the path of path constraints (${pathUsers.join(", ")}); remove them first`);
      for (const sk of Object.values(m.skins ?? {})) delete sk.attachments[op.id];
      renameLive2DSlot(m, op.id, null);
      // clippings ending at the slot clip to the end of the draw order
      for (const c of Object.values(m.clippings ?? {})) if (c.end === op.id) delete c.end;
      m.slots = m.slots.filter((s) => s.id !== op.id);
      for (const s of m.slots) {
        if (Array.isArray(s.clip)) {
          s.clip = s.clip.filter((c) => c !== op.id);
          if (!s.clip.length) delete s.clip;
        } else if (s.clip === op.id) delete s.clip;
        if (!s.clip) delete s.clipInvert;
      }
      for (const a of Object.values(m.animations ?? {})) {
        if (a.slots) delete a.slots[op.id];
        for (const k of a.drawOrder ?? []) k.offsets = k.offsets.filter((e) => e[0] !== op.id);
      }
      for (const p of m.parameters ?? []) if (p.slots) delete p.slots[op.id];
      return `removed slot ${op.id}`;
    }
    case "moveSlot": {
      const slot = requireSlot(m, op.id);
      m.slots = m.slots.filter((s) => s !== slot);
      insertAt(m.slots, slot, op.index);
      return `moved slot ${op.id} to index ${m.slots.indexOf(slot)}`;
    }
    case "addImage": {
      assertId(op.id, "id");
      if (!/\.png$/i.test(op.path)) throw new Error("only PNG images are supported");
      m.images = { ...(m.images ?? {}), [op.id]: { path: op.path } };
      return `added image ${op.id} -> ${op.path}`;
    }
    case "addMesh": {
      assertId(op.id, "id");
      if (m.attachments[op.id]) throw new Error(`attachment "${op.id}" already exists`);
      const data = buildShape(op.shape);
      const att: MeshAttachment = { type: "mesh", vertices: data.vertices, triangles: data.triangles, weights: [] };
      if (op.color !== undefined) att.color = assertColor(op.color);
      if (op.image !== undefined) {
        if (!m.images?.[op.image]) throw new Error(`unknown image "${op.image}" (addImage first)`);
        att.image = op.image;
        const r = op.imageRect ?? rectOf(data.vertices);
        att.uvs = data.vertices.map(([x, y]) => [round((x - r.x) / r.width, 4), round((r.y + r.height - y) / r.height, 4)]);
      }
      const slotId = op.slot ?? op.id;
      let slot = m.slots.find((s) => s.id === slotId);
      const bindBones = op.bones?.length ? op.bones : undefined;
      bindBones?.forEach((b) => requireBone(m, b));
      if (!slot) {
        const bone = op.bone ?? bindBones?.[0] ?? "root";
        requireBone(m, bone);
        slot = { id: slotId, bone, attachment: op.id, color: "#ffffff" };
        insertAt(m.slots, slot, op.index);
      } else {
        slot.attachment = op.id;
      }
      att.weights = bindBones
        ? weightsFor(m, att.vertices, bindBones, op.maxInfluences ?? 2, 3)
        : att.vertices.map(() => [[slot!.bone, 1]]);
      m.attachments[op.id] = att;
      if (m.target === "live2d") {
        // a Live2D art mesh on the canvas, with one keyform
        if (!m.live2d) m.live2d = { canvas: { ...DEFAULT_LIVE2D_CANVAS }, parts: [], deformers: [] };
        m.attachments[op.id] = toLive2DMesh(m, att);
      }
      return `added mesh ${op.id} (${att.vertices.length} vertices, ${att.triangles.length} triangles) in slot ${slotId}`;
    }
    case "autoWeight": {
      dropBinds(m, op.attachment);
      dropLocalDeform(m, op.attachment);
      const att = requireAttachment(m, op.attachment);
      if (!op.bones?.length) throw new Error("bones must list at least one bone");
      op.bones.forEach((b) => requireBone(m, b));
      att.weights = weightsFor(m, att.vertices, op.bones, op.maxInfluences ?? 2, op.power ?? 3);
      return `re-weighted ${op.attachment} to ${op.bones.join(", ")}`;
    }
    case "setWeights": {
      dropBinds(m, op.attachment);
      dropLocalDeform(m, op.attachment);
      const att = requireAttachment(m, op.attachment);
      if (!Array.isArray(op.weights) || op.weights.length !== att.vertices.length)
        throw new Error(`weights needs ${att.vertices.length} entries (one per vertex)`);
      op.weights.forEach((w) => w.forEach(([b]) => requireBone(m, b)));
      att.weights = op.weights;
      return `set weights of ${op.attachment}`;
    }
    case "removeAttachment": {
      if (m.clippings?.[op.id]) {
        delete m.clippings[op.id];
        if (!Object.keys(m.clippings).length) delete m.clippings;
      } else if (m.boundingBoxes?.[op.id]) {
        delete m.boundingBoxes[op.id];
        if (!Object.keys(m.boundingBoxes).length) delete m.boundingBoxes;
      } else {
        requireAttachment(m, op.id);
        renameLive2DAttachment(m, op.id, null);
        delete m.attachments[op.id];
      }
      for (const s of m.slots) if (s.attachment === op.id) s.attachment = null;
      for (const p of m.parameters ?? []) if (p.meshes) delete p.meshes[op.id];
      for (const c of m.combos ?? []) for (const k of c.keys) if (k.meshes) delete k.meshes[op.id];
      for (const a of Object.values(m.animations ?? {})) if (a.deform) delete a.deform[op.id];
      for (const w of m.warps ?? []) w.targets = w.targets.filter((t) => t !== op.id);
      for (const sk of Object.values(m.skins ?? {})) {
        for (const [slot, map] of Object.entries(sk.attachments)) {
          for (const [key, id] of Object.entries(map)) if (id === op.id) delete map[key];
          if (!Object.keys(map).length) delete sk.attachments[slot];
        }
      }
      return `removed attachment ${op.id}`;
    }
    case "setAnimation": {
      assertId(op.name, "name");
      if (!(typeof op.duration === "number" && op.duration > 0)) throw new Error("duration must be > 0 seconds");
      m.animations ??= {};
      const a: Animation = m.animations[op.name] ?? { duration: op.duration, bones: {}, slots: {} };
      a.duration = op.duration;
      if (op.loop !== undefined) a.loop = op.loop;
      m.animations[op.name] = a;
      return `animation ${op.name}: ${op.duration}s ${a.loop === false ? "once" : "loop"}`;
    }
    case "removeAnimation": {
      requireAnimation(m, op.name);
      const sliders = (m.sliders ?? []).filter((c) => c.animation === op.name).map((c) => c.id);
      if (sliders.length) throw new Error(`animation is posed by sliders (${sliders.join(", ")}); remove them first`);
      delete m.animations![op.name];
      return `removed animation ${op.name}`;
    }
    case "renameAnimation": {
      const a = requireAnimation(m, op.name);
      assertId(op.to, "to");
      if (m.animations![op.to]) throw new Error(`animation "${op.to}" already exists`);
      delete m.animations![op.name];
      m.animations![op.to] = a;
      for (const c of m.sliders ?? []) if (c.animation === op.name) c.animation = op.to;
      return `renamed animation ${op.name} -> ${op.to}`;
    }
    case "setKeys": {
      const a = requireAnimation(m, op.animation);
      requireBone(m, op.bone);
      const single = ["rotate", "translateX", "translateY", "scaleX", "scaleY", "shearX", "shearY"].includes(op.channel);
      if (!single && !["translate", "scale", "shear", "inherit"].includes(op.channel)) throw new Error(`channel must be rotate, translate, scale, shear, translateX/Y, scaleX/Y, shearX/Y or inherit`);
      let keys = checkKeys(op.keys, (v) =>
        op.channel === "inherit" ? INHERITS.includes(v as Inherit) : single ? typeof v === "number" : Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number"),
      );
      if (op.space === "world") {
        if (op.channel !== "rotate" && op.channel !== "translate" && op.channel !== "scale") throw new Error(`space "world" is only available for rotate, translate and scale`);
        keys = worldToLocalKeys(m, op.animation, op.bone, op.channel, keys);
      }
      else if (op.space !== undefined && op.space !== "local") throw new Error('space must be "local" or "world"');
      a.bones ??= {};
      const tl = (a.bones[op.bone] ??= {});
      const merged = mergeKeys((tl as Record<string, Key<unknown>[]>)[op.channel], keys, op.mode);
      (tl as Record<string, Key<unknown>[]>)[op.channel] = merged;
      return `${op.animation}: ${op.bone}.${op.channel} has ${merged.length} keys`;
    }
    case "setSlotKeys": {
      const a = requireAnimation(m, op.animation);
      requireSlot(m, op.slot);
      if (!["attachment", "color", "dark"].includes(op.channel)) throw new Error(`channel must be attachment, color or dark`);
      const keys = checkKeys(op.keys, (v) =>
        op.channel === "color" || op.channel === "dark" ? isColor(v) : v === null || (typeof v === "string" && isAttachmentKey(m, op.slot, v)),
      );
      a.slots ??= {};
      const tl = (a.slots[op.slot] ??= {});
      const merged = mergeKeys((tl as Record<string, Key<unknown>[]>)[op.channel], keys, op.mode);
      (tl as Record<string, Key<unknown>[]>)[op.channel] = merged;
      return `${op.animation}: slot ${op.slot}.${op.channel} has ${merged.length} keys`;
    }
    case "setDeformKeys": {
      const a = requireAnimation(m, op.animation);
      // clipping polygons and bounding boxes deform like meshes (their vertices and weights are all that is used here)
      const att = ((m.clippings?.[op.attachment] ?? m.boundingBoxes?.[op.attachment]) as unknown as MeshAttachment | undefined) ?? requireAttachment(m, op.attachment);
      if (!Array.isArray(op.keys)) throw new Error("keys must be an array of {t, offsets?, transform?, ease?}");
      const keys = op.keys.map((k, i): DeformKey => {
        if (typeof k?.t !== "number" || !(k.t >= 0)) throw new Error(`keys[${i}].t must be a number >= 0`);
        if (k.ease !== undefined && !isEase(k.ease)) throw new Error(`keys[${i}].ease is not a valid ease`);
        const local =
          k.local && Number.isInteger(k.local.offset) && k.local.offset >= 0 && Array.isArray(k.local.values) && k.local.values.every((n) => typeof n === "number")
            ? { local: { offset: k.local.offset, values: [...k.local.values] } }
            : {};
        return { t: k.t, v: meshKeyOffsets(att, k, `keys[${i}]`), ...(k.ease && k.ease !== "linear" ? { ease: k.ease } : {}), ...local };
      });
      a.deform ??= {};
      const merged = mergeKeys(a.deform[op.attachment], keys, op.mode);
      if (merged.length) a.deform[op.attachment] = merged;
      else delete a.deform[op.attachment];
      if (!Object.keys(a.deform).length) delete a.deform;
      return `${op.animation}: deform of ${op.attachment} has ${merged.length} keys`;
    }
    case "setEvent": {
      assertId(op.name, "name");
      m.events ??= {};
      if (op.remove) {
        delete m.events[op.name];
        for (const a of Object.values(m.animations ?? {})) if (a.events) a.events = a.events.filter((e) => e.name !== op.name);
        if (!Object.keys(m.events).length) delete m.events;
        return `removed event ${op.name}`;
      }
      const def: EventDef = {};
      for (const k of ["int", "float", "volume", "balance"] as const) {
        if (op[k] === undefined) continue;
        if (typeof op[k] !== "number" || !Number.isFinite(op[k])) throw new Error(`${k} must be a number`);
        def[k] = op[k];
      }
      for (const k of ["string", "audio"] as const) if (op[k] !== undefined && !(k === "audio" && op[k] === "")) def[k] = String(op[k]);
      m.events[op.name] = def;
      return `event ${op.name} defined`;
    }
    case "setEventKeys": {
      const a = requireAnimation(m, op.animation);
      if (!Array.isArray(op.keys)) throw new Error("keys must be an array of {t, name, int?, float?, string?}");
      const keys = op.keys.map((k, i) => {
        if (typeof k?.t !== "number" || !(k.t >= 0)) throw new Error(`keys[${i}].t must be a number >= 0`);
        if (!m.events?.[k.name]) throw new Error(`keys[${i}]: unknown event "${k.name}" (define it with setEvent)`);
        return { ...k };
      });
      const kept = op.mode === "merge" ? (a.events ?? []).filter((e) => !keys.some((k) => Math.abs(k.t - e.t) < 1e-6 && k.name === e.name)) : [];
      a.events = [...kept, ...keys].sort((x, y) => x.t - y.t);
      if (!a.events.length) delete a.events;
      return `${op.animation}: ${a.events?.length ?? 0} events`;
    }
    case "setDrawOrderKeys": {
      const a = requireAnimation(m, op.animation);
      if (!Array.isArray(op.keys)) throw new Error("keys must be an array of { t, offsets: [[slot, offset], ...] }");
      const keys = op.keys.map((k, i) => {
        if (typeof k?.t !== "number" || !(k.t >= 0)) throw new Error(`keys[${i}].t must be a number >= 0`);
        if (!Array.isArray(k.offsets)) throw new Error(`keys[${i}].offsets must be an array of [slot, offset]`);
        const seen = new Set<string>();
        for (const e of k.offsets) {
          if (!Array.isArray(e) || typeof e[0] !== "string" || !Number.isInteger(e[1])) throw new Error(`keys[${i}].offsets entries are [slotId, integer offset]`);
          requireSlot(m, e[0]);
          if (seen.has(e[0])) throw new Error(`keys[${i}] lists slot "${e[0]}" twice`);
          seen.add(e[0]);
        }
        return { t: k.t, offsets: k.offsets.filter((e) => e[1] !== 0).map((e) => [e[0], e[1]] as [string, number]) };
      });
      const byT = new Map((op.mode === "merge" ? (a.drawOrder ?? []) : []).map((k) => [k.t, k]));
      for (const k of keys) byT.set(k.t, k);
      a.drawOrder = [...byT.values()].sort((x, y) => x.t - y.t);
      if (!a.drawOrder.length) delete a.drawOrder;
      return `${op.animation}: draw order has ${a.drawOrder?.length ?? 0} keys`;
    }
    case "clearKeys": {
      const a = requireAnimation(m, op.animation);
      if (op.bone) {
        if (op.channel) delete (a.bones?.[op.bone] as Record<string, unknown> | undefined)?.[op.channel];
        else delete a.bones?.[op.bone];
      } else if (op.slot) {
        if (op.channel) delete (a.slots?.[op.slot] as Record<string, unknown> | undefined)?.[op.channel];
        else delete a.slots?.[op.slot];
      } else if (op.ik) {
        if (op.channel) delete (a.ik?.[op.ik] as Record<string, unknown> | undefined)?.[op.channel];
        else delete a.ik?.[op.ik];
      } else if (op.param) {
        delete a.params?.[op.param];
      } else if (op.physics) {
        if (op.channel) delete (a.physics?.[op.physics] as Record<string, unknown> | undefined)?.[op.channel];
        else delete a.physics?.[op.physics];
      } else {
        a.bones = {};
        a.slots = {};
        a.ik = {};
        a.physics = {};
        a.params = {};
      }
      return `cleared keys in ${op.animation}`;
    }
    case "addIk": {
      assertId(op.id, "id");
      if ((m.ik ?? []).some((c) => c.id === op.id)) throw new Error(`IK constraint "${op.id}" already exists`);
      const bones = checkChain(m, op.bones);
      let target = op.target;
      let created = "";
      if (target === undefined) {
        target = op.id + "_target";
        if (findBone(m, target)) throw new Error(`bone "${target}" already exists; pass it as target or pick another id`);
        const parent = op.targetParent ?? m.bones.find((b) => b.parent === null)!.id;
        requireBone(m, parent);
        const tipBone = computePose(m).byId.get(bones[bones.length - 1])!;
        const pos = op.targetPosition ?? boneEnds(tipBone).end;
        const bone: Bone = { id: target, parent, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 };
        m.bones.push(bone);
        placeInWorld(m, bone, pos);
        created = ` (created target bone ${target} at (${round(pos[0], 2)}, ${round(pos[1], 2)}))`;
      }
      requireBone(m, target);
      assertTargetOutsideChain(m, bones, target);
      const c: IkConstraint = {
        id: op.id,
        bones,
        target,
        mix: checkMix(op.mix ?? 1),
        bendPositive: op.bendPositive ?? inferBend(m, bones),
      };
      (m.ik ??= []).push(c);
      return `added IK ${op.id}: ${bones.join(" -> ")} reaches for ${target}, bend ${c.bendPositive ? "positive" : "negative"}${created}`;
    }
    case "updateIk": {
      const c = requireIk(m, op.id);
      if (op.bones !== undefined) c.bones = checkChain(m, op.bones);
      if (op.target !== undefined) c.target = requireBone(m, op.target).id;
      assertTargetOutsideChain(m, c.bones, c.target);
      if (op.mix !== undefined) c.mix = checkMix(op.mix);
      if (op.bendPositive !== undefined) c.bendPositive = !!op.bendPositive;
      if (op.softness !== undefined) {
        if (!(typeof op.softness === "number" && op.softness >= 0)) throw new Error("softness must be a number >= 0");
        if (op.softness) c.softness = op.softness;
        else delete c.softness;
      }
      for (const k of ["compress", "stretch", "skin"] as const) {
        if (op[k] === undefined) continue;
        if (op[k]) c[k] = true;
        else delete c[k];
      }
      if (op.scaleY !== undefined) {
        if (op.scaleY === "none") delete c.scaleY;
        else if (op.scaleY === "uniform" || op.scaleY === "volume") c.scaleY = op.scaleY;
        else throw new Error('scaleY must be "uniform", "volume" or "none"');
      }
      return `updated IK ${op.id}`;
    }
    case "removeIk": {
      const c = requireIk(m, op.id);
      m.ik = m.ik!.filter((x) => x !== c);
      forgetConstraint(m, "ik", op.id);
      for (const a of Object.values(m.animations ?? {})) if (a.ik) delete a.ik[op.id];
      if (op.removeTarget) {
        const t = requireBone(m, c.target);
        const users = m.ik.filter((x) => x.target === t.id || x.bones.includes(t.id));
        if (m.bones.some((b) => b.parent === t.id) || m.slots.some((s) => s.bone === t.id) || users.length)
          throw new Error(`target "${t.id}" is still used (children, slots or other IK); remove it separately`);
        m.bones = m.bones.filter((b) => b !== t);
        for (const a of Object.values(m.animations ?? {})) if (a.bones) delete a.bones[t.id];
      }
      if (!m.ik.length) delete m.ik;
      return `removed IK ${op.id}${op.removeTarget ? ` and bone ${c.target}` : ""}`;
    }
    case "moveIk": {
      const c = requireIk(m, op.id);
      m.ik = m.ik!.filter((x) => x !== c);
      insertAt(m.ik, c, op.index);
      return `moved IK ${op.id} to index ${m.ik.indexOf(c)}`;
    }
    case "setIkKeys": {
      const a = requireAnimation(m, op.animation);
      requireIk(m, op.ik);
      if (!["mix", "bendPositive", "softness", "compress", "stretch"].includes(op.channel)) throw new Error("channel must be mix, bendPositive, softness, compress or stretch");
      const keys = checkKeys(op.keys, (v) =>
        op.channel === "mix" ? typeof v === "number" && v >= 0 && v <= 1 : op.channel === "softness" ? typeof v === "number" && v >= 0 : typeof v === "boolean",
      );
      a.ik ??= {};
      const tl = (a.ik[op.ik] ??= {});
      const merged = mergeKeys((tl as Record<string, Key<unknown>[]>)[op.channel], keys, op.mode);
      (tl as Record<string, Key<unknown>[]>)[op.channel] = merged;
      return `${op.animation}: ik ${op.ik}.${op.channel} has ${merged.length} keys`;
    }
    case "addBoneChain": {
      assertId(op.id, "id");
      const count = op.count;
      if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error("count must be an integer between 1 and 32");
      if (!isVec(op.start) || !isVec(op.end)) throw new Error("start and end must be world points [x, y]");
      if (Math.hypot(op.end[0] - op.start[0], op.end[1] - op.start[1]) < 1e-9) throw new Error("start and end are the same point");
      const ids = Array.from({ length: count }, (_, i) => `${op.id}_${i + 1}`);
      for (const id of ids) if (findBone(m, id)) throw new Error(`bone "${id}" already exists`);
      let parent = op.parent ?? m.bones.find((b) => b.parent === null)!.id;
      requireBone(m, parent);
      const at = (f: number): Vec2 => [op.start[0] + (op.end[0] - op.start[0]) * f, op.start[1] + (op.end[1] - op.start[1]) * f];
      ids.forEach((id, i) => {
        const bone: Bone = { id, parent, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 };
        m.bones.push(bone);
        placeInWorld(m, bone, at(i / count), at((i + 1) / count));
        parent = id;
      });
      return `added bone chain ${ids.join(" -> ")}`;
    }
    case "addPhysics": {
      assertId(op.id, "id");
      if ((m.physics ?? []).some((c) => c.id === op.id)) throw new Error(`physics constraint "${op.id}" already exists`);
      const c: PhysicsConstraint = { id: op.id, bones: [], ...PHYSICS_DEFAULTS, gravity: [...PHYSICS_DEFAULTS.gravity] };
      applyPhysicsSettings(c, op);
      c.bones = checkSpringBones(m, op.bones, op.id);
      (m.physics ??= []).push(c);
      return `added physics ${op.id} on ${c.bones.join(", ")} (${c.frequency} Hz, damping ${c.damping}, gravity (${c.gravity.join(", ")}))`;
    }
    case "updatePhysics": {
      const c = requirePhysics(m, op.id);
      applyPhysicsSettings(c, op);
      if (op.bones !== undefined) c.bones = checkSpringBones(m, op.bones, op.id);
      return `updated physics ${op.id}`;
    }
    case "removePhysics": {
      const c = requirePhysics(m, op.id);
      m.physics = m.physics!.filter((x) => x !== c);
      for (const a of Object.values(m.animations ?? {})) if (a.physics) delete a.physics[op.id];
      if (!m.physics.length) delete m.physics;
      return `removed physics ${op.id}`;
    }
    case "setPhysicsKeys": {
      const a = requireAnimation(m, op.animation);
      requirePhysics(m, op.physics);
      if (op.channel !== "mix" && op.channel !== "force") throw new Error("channel must be mix or force");
      const keys = checkKeys(op.keys, (v) => (op.channel === "mix" ? typeof v === "number" && v >= 0 && v <= 1 : isVec(v)));
      a.physics ??= {};
      const tl = (a.physics[op.physics] ??= {});
      const merged = mergeKeys((tl as Record<string, Key<unknown>[]>)[op.channel], keys, op.mode);
      (tl as Record<string, Key<unknown>[]>)[op.channel] = merged;
      return `${op.animation}: physics ${op.physics}.${op.channel} has ${merged.length} keys`;
    }
    case "addParameter": {
      assertId(op.id, "id");
      if (findParameter(m, op.id)) throw new Error(`parameter "${op.id}" already exists`);
      if (!(typeof op.min === "number" && typeof op.max === "number" && op.min < op.max)) throw new Error("min and max must be numbers with min < max");
      const def = op.default ?? Math.min(op.max, Math.max(op.min, 0));
      if (!(def >= op.min && def <= op.max)) throw new Error(`default must be within [${op.min}, ${op.max}]`);
      const p: Parameter = { id: op.id, min: op.min, max: op.max, default: def };
      setParameterDetails(p, op);
      (m.parameters ??= []).push(p);
      return `added parameter ${op.id} ${op.min}..${op.max} (default ${def})`;
    }
    case "updateParameter": {
      const p = requireParameter(m, op.id);
      const min = op.min ?? p.min;
      const max = op.max ?? p.max;
      const def = op.default ?? Math.min(max, Math.max(min, p.default));
      if (!(min < max)) throw new Error("min must be < max");
      if (!(def >= min && def <= max)) throw new Error(`default must be within [${min}, ${max}]`);
      Object.assign(p, { min, max, default: def });
      setParameterDetails(p, op);
      return `updated parameter ${op.id}`;
    }
    case "renameParameter": {
      const p = requireParameter(m, op.id);
      assertId(op.to, "to");
      if (op.to === op.id) return `parameter ${op.id} unchanged`;
      if (findParameter(m, op.to)) throw new Error(`parameter "${op.to}" already exists`);
      const from = op.id;
      p.id = op.to;
      renameLive2DParam(m, from, op.to);
      for (const a of Object.values(m.animations ?? {})) {
        if (a.params?.[from]) {
          a.params[op.to] = a.params[from];
          delete a.params[from];
        }
      }
      for (const c of m.combos ?? []) c.params = c.params.map((x) => (x === from ? op.to : x));
      // Live2D model3 groups (EyeBlink / LipSync) and cdi3 combined parameters refer to parameter ids
      const l2meta = (m.meta as { live2d?: { groups?: Array<{ Ids?: string[] }>; displayInfo?: { CombinedParameters?: Array<{ Ids?: string[] }> } } } | undefined)?.live2d;
      if (l2meta) {
        m.meta = structuredClone(m.meta);
        const lm = (m.meta as { live2d: typeof l2meta }).live2d;
        for (const g of lm.groups ?? []) if (g.Ids) g.Ids = g.Ids.map((x) => (x === from ? op.to : x));
        for (const g of lm.displayInfo?.CombinedParameters ?? []) if (g.Ids) g.Ids = g.Ids.map((x) => (x === from ? op.to : x));
      }
      return `renamed parameter ${from} to ${op.to}`;
    }
    case "removeParameter": {
      requireParameter(m, op.id);
      const combos = (m.combos ?? []).filter((c) => c.params.includes(op.id)).map((c) => c.id);
      if (combos.length) throw new Error(`parameter is used by combos (${combos.join(", ")}); removeCombo first`);
      // Live2D objects keyed on it keep their look at its default
      renameLive2DParam(m, op.id, null);
      m.parameters = m.parameters!.filter((p) => p.id !== op.id);
      for (const a of Object.values(m.animations ?? {})) if (a.params) delete a.params[op.id];
      if (!m.parameters.length) delete m.parameters;
      return `removed parameter ${op.id}`;
    }
    case "setParamBoneKeys": {
      const p = requireParameter(m, op.parameter);
      requireBone(m, op.bone);
      if (!["rotate", "translate", "scale"].includes(op.channel)) throw new Error("channel must be rotate, translate or scale");
      const keys = checkParamKeys(p, op.keys, (v) => (op.channel === "rotate" ? typeof v === "number" && Number.isFinite(v) : isVec(v)));
      const tl = ((p.bones ??= {})[op.bone] ??= {}) as Record<string, ParamKey<unknown>[]>;
      tl[op.channel] = mergeParamKeys(tl[op.channel], keys, op.mode);
      return `${op.parameter}: bone ${op.bone}.${op.channel} has ${tl[op.channel].length} keys`;
    }
    case "setParamSlotKeys": {
      const p = requireParameter(m, op.parameter);
      requireSlot(m, op.slot);
      if (op.channel !== "color" && op.channel !== "attachment") throw new Error("channel must be color or attachment");
      const keys = checkParamKeys(p, op.keys, (v) =>
        op.channel === "color" ? isColor(v) : v === null || (typeof v === "string" && !!m.attachments[v]),
      );
      const tl = ((p.slots ??= {})[op.slot] ??= {}) as Record<string, ParamKey<unknown>[]>;
      tl[op.channel] = mergeParamKeys(tl[op.channel], keys, op.mode);
      return `${op.parameter}: slot ${op.slot}.${op.channel} has ${tl[op.channel].length} keys`;
    }
    case "setParamShape": {
      const p = requireParameter(m, op.parameter);
      const att = requireAttachment(m, op.attachment);
      if (!Array.isArray(op.keys) || !op.keys.length) throw new Error("keys must be a non-empty array of {at, offsets?, transform?}");
      const keys = op.keys.map((k, i): ParamKey<VertexOffsets> => {
        if (typeof k?.at !== "number") throw new Error(`keys[${i}].at must be a number`);
        return { at: k.at, v: meshKeyOffsets(att, k, `keys[${i}]`) };
      });
      checkParamKeys(p, keys, () => true);
      const meshes = (p.meshes ??= {});
      meshes[op.attachment] = mergeParamKeys(meshes[op.attachment], keys, op.mode);
      const moved = keys.map((k) => `${k.v.length} verts at ${k.at}`).join(", ");
      return `${op.parameter}: shape of ${op.attachment} (${moved})`;
    }
    case "addWarp": {
      assertId(op.id, "id");
      if (m.warps?.some((w) => w.id === op.id)) throw new Error(`warp "${op.id}" already exists`);
      if (!Array.isArray(op.targets) || !op.targets.length) throw new Error("targets must list the attachments to deform");
      op.targets.forEach((t) => requireAttachment(m, t));
      const cols = op.cols ?? 4;
      const rows = op.rows ?? 4;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 32 || rows > 32) throw new Error("cols and rows must be integers in 1..32");
      let rect = op.rect;
      if (!rect) {
        const pts = op.targets.flatMap((t) => m.attachments[t].vertices);
        const b = rectOf(pts);
        const pad = (op.padding ?? 0.1) * Math.max(b.width, b.height);
        rect = { x: round(b.x - pad), y: round(b.y - pad), width: round(b.width + 2 * pad), height: round(b.height + 2 * pad) };
      }
      if (!(rect.width > 0 && rect.height > 0)) throw new Error("rect width and height must be > 0");
      (m.warps ??= []).push({ id: op.id, rect, cols, rows, targets: [...op.targets] });
      return `added warp ${op.id} (${cols}x${rows}) over ${op.targets.join(", ")}`;
    }
    case "updateWarp": {
      const w = requireWarp(m, op.id);
      if (op.targets !== undefined) {
        if (!Array.isArray(op.targets)) throw new Error("targets must be an array");
        op.targets.forEach((t) => requireAttachment(m, t));
        w.targets = [...op.targets];
      }
      return `updated warp ${op.id}`;
    }
    case "removeWarp": {
      requireWarp(m, op.id);
      m.warps = m.warps!.filter((w) => w.id !== op.id);
      for (const p of m.parameters ?? []) if (p.warps) delete p.warps[op.id];
      for (const c of m.combos ?? []) for (const k of c.keys) if (k.warps) delete k.warps[op.id];
      if (!m.warps.length) delete m.warps;
      return `removed warp ${op.id}`;
    }
    case "setParamWarp": {
      const p = requireParameter(m, op.parameter);
      const w = requireWarp(m, op.warp);
      if (!Array.isArray(op.keys) || !op.keys.length) throw new Error("keys must be a non-empty array of {at, preset?, amount?, offsets?, transform?}");
      const keys = op.keys.map((k, i): ParamKey<Vec2[]> => {
        if (typeof k?.at !== "number") throw new Error(`keys[${i}].at must be a number`);
        return { at: k.at, v: warpKeyOffsets(w, k, `keys[${i}]`) };
      });
      checkParamKeys(p, keys, () => true);
      const warps = (p.warps ??= {});
      warps[op.warp] = mergeParamKeys(warps[op.warp], keys, op.mode);
      return `${op.parameter}: warp ${op.warp} has ${warps[op.warp].length} keys`;
    }
    case "addCombo": {
      assertId(op.id, "id");
      if (m.combos?.some((c) => c.id === op.id)) throw new Error(`combo "${op.id}" already exists`);
      if (!Array.isArray(op.params) || op.params.length < 2 || op.params.length > 3) throw new Error("params must list 2 or 3 parameters");
      if (new Set(op.params).size !== op.params.length) throw new Error("params must be different parameters");
      op.params.forEach((p) => requireParameter(m, p));
      (m.combos ??= []).push({ id: op.id, params: [...op.params], keys: [] });
      return `added combo ${op.id} over ${op.params.join(" x ")}`;
    }
    case "removeCombo": {
      requireCombo(m, op.id);
      m.combos = m.combos!.filter((c) => c.id !== op.id);
      if (!m.combos.length) delete m.combos;
      return `removed combo ${op.id}`;
    }
    case "setComboKey": {
      const c = requireCombo(m, op.combo);
      const at = checkComboAt(m, c, op.at);
      const key: ComboKey = { at };
      if (op.bones !== undefined) {
        key.bones = {};
        for (const [bone, e] of Object.entries(op.bones)) {
          requireBone(m, bone);
          if (e.rotate !== undefined && !(typeof e.rotate === "number" && Number.isFinite(e.rotate))) throw new Error(`bones.${bone}.rotate must be a number`);
          if (e.translate !== undefined && !isVec(e.translate)) throw new Error(`bones.${bone}.translate must be [x, y]`);
          if (e.scale !== undefined && !isVec(e.scale)) throw new Error(`bones.${bone}.scale must be [sx, sy]`);
          key.bones[bone] = { ...(e.rotate !== undefined ? { rotate: e.rotate } : {}), ...(e.translate ? { translate: e.translate } : {}), ...(e.scale ? { scale: e.scale } : {}) };
        }
      }
      if (op.meshes !== undefined) {
        key.meshes = {};
        for (const [id, spec] of Object.entries(op.meshes)) key.meshes[id] = meshKeyOffsets(requireAttachment(m, id), spec, `meshes.${id}`);
      }
      if (op.warps !== undefined) {
        key.warps = {};
        for (const [id, spec] of Object.entries(op.warps)) key.warps[id] = warpKeyOffsets(requireWarp(m, id), spec, `warps.${id}`);
      }
      const i = c.keys.findIndex((k) => sameAt(k.at, at));
      let merged = key;
      if (i >= 0 && op.mode !== "replace") {
        const old = c.keys[i];
        merged = {
          at,
          ...(old.bones || key.bones ? { bones: { ...old.bones, ...key.bones } } : {}),
          ...(old.meshes || key.meshes ? { meshes: { ...old.meshes, ...key.meshes } } : {}),
          ...(old.warps || key.warps ? { warps: { ...old.warps, ...key.warps } } : {}),
        };
      }
      if (i >= 0) c.keys[i] = merged;
      else c.keys.push(merged);
      c.keys.sort((a, b) => a.at.reduce((d, v, j) => d || v - b.at[j], 0));
      const parts = [Object.keys(merged.bones ?? {}).length && `${Object.keys(merged.bones!).length} bones`, Object.keys(merged.meshes ?? {}).length && `${Object.keys(merged.meshes!).length} meshes`, Object.keys(merged.warps ?? {}).length && `${Object.keys(merged.warps!).length} warps`].filter(Boolean);
      return `combo ${c.id} at (${at.join(", ")}): ${parts.join(", ") || "empty"}`;
    }
    case "removeComboKey": {
      const c = requireCombo(m, op.combo);
      const at = checkComboAt(m, c, op.at);
      const before = c.keys.length;
      c.keys = c.keys.filter((k) => !sameAt(k.at, at));
      if (c.keys.length === before) throw new Error(`combo ${c.id} has no key at (${at.join(", ")})`);
      return `combo ${c.id}: removed key at (${at.join(", ")})`;
    }
    case "clearParamKeys": {
      const p = requireParameter(m, op.parameter);
      if (op.bone) delete p.bones?.[op.bone];
      else if (op.slot) delete p.slots?.[op.slot];
      else if (op.attachment) delete p.meshes?.[op.attachment];
      else if (op.warp) delete p.warps?.[op.warp];
      else {
        delete p.bones;
        delete p.slots;
        delete p.meshes;
        delete p.warps;
      }
      return `cleared ${op.parameter} keys`;
    }
    case "setParamTrack": {
      const a = requireAnimation(m, op.animation);
      const p = requireParameter(m, op.parameter);
      const keys = checkKeys(op.keys, (v) => typeof v === "number" && v >= p.min - 1e-9 && v <= p.max + 1e-9);
      a.params ??= {};
      a.params[op.parameter] = mergeKeys(a.params[op.parameter], keys, op.mode);
      return `${op.animation}: param ${op.parameter} has ${a.params[op.parameter].length} keys`;
    }
    case "moveVertices": {
      dropBinds(m, op.attachment);
      const att = requireAttachment(m, op.attachment);
      if (!Array.isArray(op.moves) || !op.moves.length) throw new Error("moves must be a non-empty array of [vertexIndex, x, y]");
      for (const mv of op.moves) if (!Array.isArray(mv) || mv.length !== 3 || !mv.every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("each move must be [vertexIndex, x, y]");
      m.attachments[op.attachment] = moveLive2DVertices(m, op.attachment, att, moveVertices(att, op.moves, op.keepImage !== false));
      return `moved ${op.moves.length} vertices of ${op.attachment}${att.uvs && op.keepImage !== false ? " (image kept in place)" : ""}`;
    }
    case "addVertex": {
      dropBinds(m, op.attachment);
      dropLocalDeform(m, op.attachment);
      const att = requireAttachment(m, op.attachment);
      if (!isVec(op.at)) throw new Error("at must be a setup-space point [x, y]");
      const res = addVertex(att, op.at);
      m.attachments[op.attachment] = remapLive2DForms(att, res.att);
      if (att.live2d) refreshLive2DVertices(m, [op.attachment]);
      return `added vertex ${res.index} to ${op.attachment}`;
    }
    case "setMeshGeometry": {
      dropLocalDeform(m, op.attachment);
      const old = requireAttachment(m, op.attachment);
      const n = Array.isArray(op.vertices) ? op.vertices.length : 0;
      if (!n || !op.vertices.every(isVec)) throw new Error("vertices must be a non-empty array of [x, y]");
      if (!Array.isArray(op.triangles) || !op.triangles.length) throw new Error("triangles must be a non-empty array of [a, b, c]");
      for (const t of op.triangles) {
        if (!Array.isArray(t) || t.length !== 3 || !t.every((i) => Number.isInteger(i) && i >= 0 && i < n)) throw new Error(`triangle ${JSON.stringify(t)} must index 3 of the ${n} vertices`);
      }
      if (op.uvs !== undefined && (!Array.isArray(op.uvs) || op.uvs.length !== n || !op.uvs.every(isVec))) throw new Error(`uvs must have ${n} [u, v] entries`);
      if (old.image && !op.uvs) throw new Error("an image mesh needs uvs for the new vertices");
      if (op.weights !== undefined && (!Array.isArray(op.weights) || op.weights.length !== n)) throw new Error(`weights must have ${n} entries`);
      const transfer = transferToPoints(old, op.vertices);
      const weights = op.weights ?? transfer.weights;
      for (const list of weights) for (const [b] of list) requireBone(m, b);
      m.attachments[op.attachment] = {
        ...(({ binds: _binds, ...rest }) => rest)(old),
        vertices: op.vertices.map(([x, y]) => [round(x), round(y)] as Vec2),
        ...(op.uvs ? { uvs: op.uvs.map(([u, v]) => [round(u, 5), round(v, 5)] as Vec2) } : {}),
        triangles: op.triangles.map((t) => [t[0], t[1], t[2]] as Tri),
        weights,
      };
      // blend shapes and combo shapes are per vertex: resample them onto the new vertices
      let shapes = 0;
      for (const p of m.parameters ?? []) {
        for (const k of p.meshes?.[op.attachment] ?? []) {
          k.v = transfer.offsets(k.v);
          shapes++;
        }
      }
      for (const c of m.combos ?? []) {
        for (const k of c.keys) {
          if (!k.meshes?.[op.attachment]) continue;
          k.meshes[op.attachment] = transfer.offsets(k.meshes[op.attachment]);
          shapes++;
        }
      }
      for (const a of Object.values(m.animations ?? {})) {
        for (const k of a.deform?.[op.attachment] ?? []) {
          k.v = transfer.offsets(k.v);
          shapes++;
        }
      }
      if (old.live2d) {
        m.attachments[op.attachment] = remapLive2DForms(old, m.attachments[op.attachment]);
        remapGlue(m, op.attachment, old, m.attachments[op.attachment]);
        refreshLive2DVertices(m, [op.attachment]);
      }
      return `${op.attachment}: ${old.vertices.length} -> ${n} vertices, ${op.triangles.length} triangles${op.weights ? "" : ", weights carried over"}${shapes ? `, ${shapes} shape keys resampled` : ""}${old.live2d ? `, ${old.live2d.forms.length} keyforms resampled` : ""}`;
    }
    case "removeVertices": {
      dropBinds(m, op.attachment);
      dropLocalDeform(m, op.attachment);
      const att = requireAttachment(m, op.attachment);
      if (!Array.isArray(op.indices) || !op.indices.length) throw new Error("indices must list vertices to remove");
      const res = removeVertices(att, op.indices);
      m.attachments[op.attachment] = res.att;
      if (att.live2d) {
        // keyforms and glue pairs follow the renumbering
        const l = structuredClone(att.live2d);
        const n = res.att.vertices.length;
        for (const kf of l.forms) {
          const pts = new Array<number>(n * 2).fill(0);
          res.remap.forEach((j, i) => {
            if (j >= 0) {
              pts[j * 2] = kf.points[i * 2];
              pts[j * 2 + 1] = kf.points[i * 2 + 1];
            }
          });
          kf.points = pts;
        }
        m.attachments[op.attachment] = { ...res.att, live2d: l };
        remapGlueIndices(m, op.attachment, res.remap);
      }
      // blend shapes refer to vertex indices: follow the renumbering
      for (const p of m.parameters ?? []) {
        const keys = p.meshes?.[op.attachment];
        if (!keys) continue;
        for (const k of keys) k.v = k.v.filter(([i]) => res.remap[i] >= 0).map(([i, dx, dy]) => [res.remap[i], dx, dy]);
      }
      for (const c of m.combos ?? []) {
        for (const k of c.keys) {
          const v = k.meshes?.[op.attachment];
          if (v) k.meshes![op.attachment] = v.filter(([i]) => res.remap[i] >= 0).map(([i, dx, dy]) => [res.remap[i], dx, dy]);
        }
      }
      for (const a of Object.values(m.animations ?? {})) {
        for (const k of a.deform?.[op.attachment] ?? []) k.v = k.v.filter(([i]) => res.remap[i] >= 0).map(([i, dx, dy]) => [res.remap[i], dx, dy]);
      }
      return `removed ${new Set(op.indices).size} vertices from ${op.attachment} (${res.att.vertices.length} left, ${res.att.triangles.length} triangles)`;
    }
    case "retriangulate": {
      const att = requireAttachment(m, op.attachment);
      m.attachments[op.attachment] = retriangulate(att);
      return `re-triangulated ${op.attachment}: ${m.attachments[op.attachment].triangles.length} triangles`;
    }
    case "adjustWeights": {
      dropBinds(m, op.attachment);
      dropLocalDeform(m, op.attachment);
      const att = requireAttachment(m, op.attachment);
      if (!["set", "add", "multiply", "smooth"].includes(op.mode)) throw new Error("mode must be set, add, multiply or smooth");
      if (op.mode !== "smooth") {
        if (!op.bone) throw new Error(`mode "${op.mode}" needs a bone`);
        requireBone(m, op.bone);
        if (typeof op.value !== "number" || !Number.isFinite(op.value)) throw new Error(`mode "${op.mode}" needs a numeric value`);
      }
      if (op.vertices && !op.vertices.every((i) => Number.isInteger(i) && i >= 0 && i < att.vertices.length))
        throw new Error(`vertices must be indices in [0, ${att.vertices.length - 1}]`);
      if (op.region && !(isVec(op.region.center) && op.region.radius > 0)) throw new Error("region needs center [x, y] and radius > 0");
      const mask = weightMask(att.vertices, { vertices: op.vertices, region: op.region });
      const touched = mask.filter((s) => s > 0).length;
      att.weights = adjustWeights(att, op.bone ?? "", op.mode, op.value ?? 0, mask);
      return `${op.mode} weights of ${op.attachment}${op.bone && op.mode !== "smooth" ? ` for ${op.bone}` : ""} on ${touched} vertices`;
    }
    case "setConstraint": {
      const c = op.constraint as { id?: unknown };
      if (!c || typeof c !== "object") throw new Error("constraint must be an object");
      assertId(c.id as string, "constraint.id");
      const list = constraintList(m, op.kind, true)!;
      const next = structuredClone(op.constraint) as never;
      const at = list.findIndex((x) => x.id === c.id);
      if (at >= 0) list[at] = next;
      else list.push(next);
      const issue = checkSpineConstraint(m, op.kind, next);
      if (issue) throw new Error(issue);
      return `${at >= 0 ? "replaced" : "added"} ${op.kind} constraint ${c.id}`;
    }
    case "updateConstraint": {
      const list = constraintList(m, op.kind, false);
      const c = list?.find((x) => x.id === op.id) as Record<string, unknown> | undefined;
      if (!c) throw new Error(`no ${op.kind} constraint "${op.id}"`);
      if (!op.set || typeof op.set !== "object") throw new Error("set must be an object of fields");
      if ("id" in op.set) throw new Error("rename a constraint by removing it and setting it again");
      for (const [k, v] of Object.entries(op.set)) {
        if (v === null) delete c[k];
        else c[k] = structuredClone(v);
      }
      const issue = checkSpineConstraint(m, op.kind, c as never);
      if (issue) throw new Error(issue);
      return `updated ${op.kind} constraint ${op.id}`;
    }
    case "removeConstraint": {
      const list = constraintList(m, op.kind, false);
      if (!list?.some((x) => x.id === op.id)) throw new Error(`no ${op.kind} constraint "${op.id}"`);
      const field = CONSTRAINT_FIELD[op.kind];
      (m as unknown as Record<string, unknown[]>)[field] = list.filter((x) => x.id !== op.id);
      if (!(m as unknown as Record<string, unknown[]>)[field].length) delete (m as unknown as Record<string, unknown>)[field];
      forgetConstraint(m, op.kind, op.id);
      return `removed ${op.kind} constraint ${op.id}`;
    }
    case "setConstraintOrder": {
      if (!Array.isArray(op.order)) throw new Error("order must be an array of \"<kind>:<id>\"");
      const known = new Set(allConstraintKeys(m));
      for (const k of op.order) if (!known.has(k)) throw new Error(`unknown constraint "${k}" (use "<kind>:<id>", kind ik / transform / path / physics / slider)`);
      if (new Set(op.order).size !== op.order.length) throw new Error("order lists a constraint twice");
      m.constraintOrder = [...op.order, ...allConstraintKeys(m).filter((k) => !op.order.includes(k))];
      return `constraint order: ${m.constraintOrder.join(", ")}`;
    }
    case "setConstraintKeys": {
      const a = requireAnimation(m, op.animation);
      const channels: Record<SpineConstraintKind, string[]> = {
        transform: ["rotate", "x", "y", "scaleX", "scaleY", "shearY"],
        path: ["position", "spacing", "rotate", "x", "y"],
        physics: ["inertia", "strength", "damping", "mass", "wind", "gravity", "mix", "reset"],
        slider: ["time", "mix"],
      };
      if (!channels[op.kind]) throw new Error("kind must be transform, path, physics or slider");
      if (!(op.kind === "physics" && op.constraint === "") && !constraintList(m, op.kind, false)?.some((x) => x.id === op.constraint)) throw new Error(`no ${op.kind} constraint "${op.constraint}"`);
      if (!channels[op.kind].includes(op.channel)) throw new Error(`channel must be one of ${channels[op.kind].join(", ")}`);
      const field = ({ transform: "transforms", path: "paths", physics: "spinePhysics", slider: "sliders" } as const)[op.kind];
      const group = ((a as unknown as Record<string, Record<string, Record<string, unknown>>>)[field] ??= {});
      const tl = (group[op.constraint] ??= {});
      if (op.channel === "reset") {
        if (!Array.isArray(op.keys) || !op.keys.every((k) => typeof k?.t === "number" && k.t >= 0)) throw new Error("reset keys are [{t}]");
        const times = [...new Set([...(op.mode === "merge" ? ((tl.reset as number[]) ?? []) : []), ...op.keys.map((k) => k.t)])].sort((x, y) => x - y);
        if (times.length) tl.reset = times;
        else delete tl.reset;
      } else {
        const keys = checkKeys(op.keys, (v) => typeof v === "number" && Number.isFinite(v));
        const merged = mergeKeys(tl[op.channel] as Key<unknown>[] | undefined, keys, op.mode);
        if (merged.length) tl[op.channel] = merged;
        else delete tl[op.channel];
      }
      if (!Object.keys(tl).length) delete group[op.constraint];
      if (!Object.keys(group).length) delete (a as unknown as Record<string, unknown>)[field];
      return `${op.animation}: ${op.kind} ${op.constraint || "(global)"}.${op.channel} set`;
    }
    case "setSkin": {
      if (op.name === null) {
        delete m.skin;
        return "no skin (default attachments only)";
      }
      if (!m.skins?.[op.name]) throw new Error(`unknown skin "${op.name}"`);
      m.skin = op.name;
      return `skin ${op.name}`;
    }
    case "addSkin": {
      assertId(op.name, "name");
      if (m.skins?.[op.name]) throw new Error(`skin "${op.name}" already exists`);
      const from = op.copyOf === undefined ? undefined : m.skins?.[op.copyOf];
      if (op.copyOf !== undefined && !from) throw new Error(`unknown skin "${op.copyOf}"`);
      (m.skins ??= {})[op.name] = from ? structuredClone(from) : { attachments: {} };
      return `added skin ${op.name}${from ? ` (copy of ${op.copyOf})` : ""}`;
    }
    case "removeSkin": {
      if (!m.skins?.[op.name]) throw new Error(`unknown skin "${op.name}"`);
      delete m.skins[op.name];
      if (m.skin === op.name) delete m.skin;
      if (!Object.keys(m.skins).length) delete m.skins;
      return `removed skin ${op.name} (its attachments stay in the model)`;
    }
    case "renameSkin": {
      if (!m.skins?.[op.name]) throw new Error(`unknown skin "${op.name}"`);
      assertId(op.to, "to");
      if (m.skins[op.to]) throw new Error(`skin "${op.to}" already exists`);
      m.skins[op.to] = m.skins[op.name];
      delete m.skins[op.name];
      if (m.skin === op.name) m.skin = op.to;
      return `renamed skin ${op.name} -> ${op.to}`;
    }
    case "setSkinAttachment": {
      const sk = m.skins?.[op.skin];
      if (!sk) throw new Error(`unknown skin "${op.skin}"`);
      requireSlot(m, op.slot);
      if (typeof op.placeholder !== "string" || !op.placeholder) throw new Error("placeholder must be a name");
      if (op.attachment === null) {
        delete sk.attachments[op.slot]?.[op.placeholder];
        if (sk.attachments[op.slot] && !Object.keys(sk.attachments[op.slot]).length) delete sk.attachments[op.slot];
        return `skin ${op.skin}: ${op.slot}/${op.placeholder} removed`;
      }
      if (!m.attachments[op.attachment] && !m.pathAttachments?.[op.attachment] && !m.clippings?.[op.attachment] && !m.boundingBoxes?.[op.attachment]) throw new Error(`unknown attachment "${op.attachment}"`);
      (sk.attachments[op.slot] ??= {})[op.placeholder] = op.attachment;
      return `skin ${op.skin}: ${op.slot}/${op.placeholder} shows ${op.attachment}`;
    }
    case "updateClipping": {
      const c = m.clippings?.[op.id];
      if (!c) throw new Error(`unknown clipping attachment "${op.id}"`);
      const next = { ...c };
      if (op.end !== undefined) {
        if (op.end === null) delete next.end;
        else next.end = requireSlot(m, op.end).id;
      }
      for (const k of ["convex", "inverse"] as const) {
        if (op[k] === undefined) continue;
        if (op[k]) next[k] = true;
        else delete next[k];
      }
      m.clippings = { ...m.clippings, [op.id]: next };
      return `clipping ${op.id}: to ${next.end ?? "the end of the draw order"}${next.inverse ? ", inverse" : next.convex ? ", convex" : ""}`;
    }
    case "updateBoundingBox": {
      const b = m.boundingBoxes?.[op.id];
      if (!b) throw new Error(`unknown bounding box "${op.id}"`);
      const next = { ...b };
      if (op.color !== undefined) {
        if (op.color === null) delete next.color;
        else {
          if (!isColor(op.color)) throw new Error(`color must be "#rrggbb" or "#rrggbbaa", got "${op.color}"`);
          next.color = op.color;
        }
      }
      if (op.vertices !== undefined) {
        if (!Array.isArray(op.vertices) || op.vertices.length < 3 || op.vertices.some((v) => !Array.isArray(v) || !Number.isFinite(v[0]) || !Number.isFinite(v[1])))
          throw new Error("vertices must be 3 or more [x, y] points");
        let weights = op.weights;
        if (weights !== undefined) {
          if (!Array.isArray(weights) || weights.length !== op.vertices.length) throw new Error(`weights needs ${op.vertices.length} entries (one per vertex)`);
          weights.forEach((w) => w.forEach(([bone]) => requireBone(m, bone)));
        } else {
          // the nearest old vertex's weights (Spine binds positions per bone: dropped, rebuilt from the setup pose)
          weights = op.vertices.map((v) => {
            let best = 0;
            b.vertices.forEach((o, i) => {
              if (Math.hypot(o[0] - v[0], o[1] - v[1]) < Math.hypot(b.vertices[best][0] - v[0], b.vertices[best][1] - v[1])) best = i;
            });
            return b.weights[best].map(([bone, w]) => [bone, w] as [string, number]);
          });
        }
        next.vertices = op.vertices.map((v) => [v[0], v[1]] as Vec2);
        next.weights = weights;
        delete next.binds;
        // deform keys were per old vertex
        for (const a of Object.values(m.animations ?? {})) if (a.deform?.[op.id] && b.vertices.length !== op.vertices.length) delete a.deform[op.id];
      }
      m.boundingBoxes = { ...m.boundingBoxes, [op.id]: next };
      return `bounding box ${op.id}: ${next.vertices.length} vertices${next.color ? `, ${next.color}` : ""}`;
    }
    case "setSkinBones": {
      const sk = m.skins?.[op.skin];
      if (!sk) throw new Error(`unknown skin "${op.skin}"`);
      if (op.bones !== undefined) {
        for (const b of op.bones) requireBone(m, b);
        if (op.bones.length) sk.bones = [...op.bones];
        else delete sk.bones;
      }
      if (op.constraints !== undefined) {
        const known = new Set(allConstraintKeys(m));
        for (const c of op.constraints) if (!known.has(c)) throw new Error(`unknown constraint "${c}" (use "<kind>:<id>")`);
        if (op.constraints.length) sk.constraints = [...op.constraints];
        else delete sk.constraints;
      }
      return `skin ${op.skin}: ${sk.bones?.length ?? 0} bones, ${sk.constraints?.length ?? 0} constraints`;
    }
    case "setTarget": {
      if (!MODEL_TARGETS.includes(op.target)) throw new Error('target must be "spine" or "live2d"');
      if (m.target === op.target) return `already a ${op.target} model`;
      const conflicts = targetConflicts(m, op.target);
      if (conflicts.length) throw new Error(`cannot make this a ${op.target} model: it has ${conflicts.join(", ")}; remove them first`);
      m.target = op.target;
      if (op.target === "live2d") {
        // with art: a canvas around it (like enableLive2D); an empty model gets the default canvas
        if (!m.live2d && !Object.keys(m.attachments).length) m.live2d = { canvas: { ...DEFAULT_LIVE2D_CANVAS }, parts: [], deformers: [] };
        applyLive2DOp(m, { op: "enableLive2D" });
      }
      return `the model is now a ${op.target} model`;
    }
    case "setMeta": {
      if (op.name !== undefined) m.name = op.name;
      if (op.meta !== undefined) m.meta = { ...(m.meta ?? {}), ...op.meta };
      return "updated meta";
    }
    case "setKeyform":
    case "setKeyformKeys":
    case "addDeformer":
    case "updateDeformer":
    case "removeDeformer":
    case "setLive2DMesh":
    case "addPart":
    case "updatePart":
    case "removePart":
    case "enableLive2D":
    case "setPartOpacityKeys":
      return applyLive2DOp(m, op);
    default:
      throw new Error(`unknown op ${JSON.stringify((op as { op?: unknown })?.op)}; valid: ${OP_NAMES.join(", ")}`);
  }
}

// ---------- helpers

/** Display details of a parameter (addParameter / updateParameter): name, group (null or "" clears), decimals, repeat. */
function setParameterDetails(p: Parameter, op: { name?: string | null; group?: string | null; decimals?: number; repeat?: boolean }): void {
  const text = (v: unknown, field: string) => {
    if (v !== null && typeof v !== "string") throw new Error(`${field} must be a string or null`);
    return v === null ? "" : v.trim();
  };
  if (op.name !== undefined) {
    const t = text(op.name, "name");
    if (t) p.name = t;
    else delete p.name;
  }
  if (op.group !== undefined) {
    const t = text(op.group, "group");
    if (t) p.group = t;
    else delete p.group;
  }
  if (op.decimals !== undefined) {
    if (!Number.isInteger(op.decimals) || op.decimals < 0 || op.decimals > 10) throw new Error("decimals must be an integer 0..10");
    p.decimals = op.decimals;
  }
  if (op.repeat !== undefined) {
    if (op.repeat) p.repeat = true;
    else delete p.repeat;
  }
}

/** Glue pairs of a mesh after its vertices were renumbered (removed vertices drop their pairs). */
function remapGlueIndices(m: Model, attachment: string, remap: number[]): void {
  if (!m.live2d?.glue?.some((g) => g.a === attachment || g.b === attachment)) return;
  m.live2d = structuredClone(m.live2d);
  for (const g of m.live2d.glue!) {
    if (g.a !== attachment && g.b !== attachment) continue;
    const pairs: number[] = [];
    const weights: number[] = [];
    for (let k = 0; k + 1 < g.pairs.length; k += 2) {
      const a = g.a === attachment ? remap[g.pairs[k]] : g.pairs[k];
      const b = g.b === attachment ? remap[g.pairs[k + 1]] : g.pairs[k + 1];
      if (a === undefined || b === undefined || a < 0 || b < 0) continue;
      pairs.push(a, b);
      weights.push(g.weights[k], g.weights[k + 1]);
    }
    g.pairs = pairs;
    g.weights = weights;
  }
}

/** Glue pairs of a mesh whose geometry was replaced: each old vertex maps to the nearest new one (by UV). */
function remapGlue(m: Model, attachment: string, old: MeshAttachment, next: MeshAttachment): void {
  const src = old.uvs && next.uvs ? old.uvs : old.vertices;
  const dst = old.uvs && next.uvs ? next.uvs : next.vertices;
  const remap = src.map((p) => {
    let best = -1;
    let d = Infinity;
    dst.forEach((q, j) => {
      const e = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (e < d) {
        d = e;
        best = j;
      }
    });
    return best;
  });
  remapGlueIndices(m, attachment, remap);
}

/** Drops Spine bind positions of an attachment (its vertices or weights are being edited). */
function dropBinds(m: Model, attachment: string): void {
  const a = m.attachments[attachment];
  if (a?.binds) m.attachments[attachment] = (({ binds: _, ...rest }) => rest)(a);
}

/** Drops Spine-exact per-influence deform data of an attachment (its weight layout changed). */
function dropLocalDeform(m: Model, attachment: string): void {
  for (const a of Object.values(m.animations ?? {})) for (const k of a.deform?.[attachment] ?? []) delete k.local;
}

function assertId(id: unknown, field: string): void {
  // Spine-compatible: names like "arm(L)" or "eye left" are fine; only control characters, quotes and
  // backslashes (and surrounding spaces) are refused
  if (typeof id !== "string" || !id || id !== id.trim() || /[\u0000-\u001f"\\]/.test(id))
    throw new Error(`${field} must be a non-empty name without control characters, quotes, backslashes or surrounding spaces (got ${JSON.stringify(id)})`);
}

function assertColor(c: string): string {
  if (!isColor(c)) throw new Error(`invalid color ${JSON.stringify(c)} (use #rrggbb or #rrggbbaa)`);
  return c;
}

const findBone = (m: Model, id: string) => m.bones.find((b) => b.id === id);

function requireBone(m: Model, id: string): Bone {
  const b = findBone(m, id);
  if (!b) throw new Error(`unknown bone "${id}"; bones: ${m.bones.map((x) => x.id).join(", ")}`);
  return b;
}

function requireSlot(m: Model, id: string) {
  const s = m.slots.find((x) => x.id === id);
  if (!s) throw new Error(`unknown slot "${id}"; slots: ${m.slots.map((x) => x.id).join(", ") || "(none)"}`);
  return s;
}

function requireAttachment(m: Model, id: string): MeshAttachment {
  const a = m.attachments[id];
  if (!a) throw new Error(`unknown attachment "${id}"; attachments: ${Object.keys(m.attachments).join(", ") || "(none)"}`);
  return a;
}

function requireAnimation(m: Model, name: string): Animation {
  const a = m.animations?.[name];
  if (!a) throw new Error(`unknown animation "${name}" (create it with setAnimation)`);
  return a;
}

function isVec(v: unknown): v is Vec2 {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

function requirePhysics(m: Model, id: string): PhysicsConstraint {
  const c = m.physics?.find((x) => x.id === id);
  if (!c) throw new Error(`unknown physics constraint "${id}"; physics: ${(m.physics ?? []).map((x) => x.id).join(", ") || "(none)"}`);
  return c;
}

function checkSpringBones(m: Model, bones: unknown, self: string): string[] {
  if (!Array.isArray(bones) || bones.length === 0) throw new Error("bones must list at least one bone");
  return bones.map((raw) => {
    const b = requireBone(m, String(raw));
    if (!(b.length > 0)) throw new Error(`bone "${b.id}" has length 0; spring bones need a length (use addBoneChain or updateBone end)`);
    const other = (m.physics ?? []).find((c) => c.id !== self && c.bones.includes(b.id));
    if (other) throw new Error(`bone "${b.id}" is already simulated by "${other.id}"`);
    return b.id;
  });
}

function applyPhysicsSettings(c: PhysicsConstraint, s: PhysicsSettings): void {
  const range = (k: "damping" | "inertia" | "mix" | "limit" | "frequency", lo: number, hi: number) => {
    const v = s[k];
    if (v === undefined) return;
    if (typeof v !== "number" || !(v >= lo && v <= hi)) throw new Error(`${k} must be between ${lo} and ${hi}`);
    c[k] = v;
  };
  range("frequency", 0.01, 60);
  range("damping", 0, 10);
  range("inertia", 0, 1);
  range("mix", 0, 1);
  range("limit", 0, 180);
  if (s.gravity !== undefined) {
    if (!isVec(s.gravity)) throw new Error("gravity must be [x, y] (world units per second squared)");
    c.gravity = [s.gravity[0], s.gravity[1]];
  }
}

function requireParameter(m: Model, id: string): Parameter {
  const p = findParameter(m, id);
  if (!p) throw new Error(`unknown parameter "${id}"; parameters: ${(m.parameters ?? []).map((x) => x.id).join(", ") || "(none, use addParameter)"}`);
  return p;
}

function requireCombo(m: Model, id: string): Combo {
  const c = m.combos?.find((x) => x.id === id);
  if (!c) throw new Error(`unknown combo "${id}"; combos: ${(m.combos ?? []).map((x) => x.id).join(", ") || "(none, use addCombo)"}`);
  return c;
}

const sameAt = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

function checkComboAt(m: Model, c: Combo, at: unknown): number[] {
  if (!Array.isArray(at) || at.length !== c.params.length || !at.every((v) => typeof v === "number" && Number.isFinite(v)))
    throw new Error(`at must list ${c.params.length} numbers (${c.params.join(", ")})`);
  at.forEach((v, i) => {
    const p = requireParameter(m, c.params[i]);
    if (v < Math.min(p.min, p.max) - 1e-9 || v > Math.max(p.min, p.max) + 1e-9) throw new Error(`${p.id} value ${v} is outside [${p.min}, ${p.max}]`);
  });
  return at as number[];
}

/** Sparse vertex offsets from explicit offsets and/or a transform of the setup vertices (summed). */
function meshKeyOffsets(att: MeshAttachment, k: MeshKeySpec, label: string): VertexOffsets {
  const n = att.vertices.length;
  const dense: Vec2[] = att.vertices.map(() => [0, 0]);
  if (k.offsets !== undefined) {
    if (!Array.isArray(k.offsets)) throw new Error(`${label}.offsets must be [[vertexIndex, dx, dy], ...]`);
    for (const o of k.offsets) {
      if (!Array.isArray(o) || !Number.isInteger(o[0]) || o[0] < 0 || o[0] >= n) throw new Error(`${label}.offsets: vertex index must be an integer in [0, ${n - 1}]`);
      dense[o[0]] = [dense[o[0]][0] + o[1], dense[o[0]][1] + o[2]];
    }
  }
  if (k.transform !== undefined) transformOffsets(att.vertices, k.transform).forEach((d, j) => (dense[j] = [dense[j][0] + d[0], dense[j][1] + d[1]]));
  return toSparse(dense);
}

/** Control-point offsets from presets, explicit offsets and/or a transform of the grid (summed). */
function warpKeyOffsets(w: Warp, k: WarpKeySpec, label: string): Vec2[] {
  const grid = warpGrid(w);
  const acc: Vec2[] = grid.map(() => [0, 0]);
  const add = (d: Vec2[]) => d.forEach((o, j) => (acc[j] = [acc[j][0] + o[0], acc[j][1] + o[1]]));
  const presets = k.presets ?? (k.preset !== undefined ? [{ preset: k.preset, amount: k.amount ?? 0 }] : []);
  for (const pr of presets) {
    if (!WARP_PRESETS.includes(pr.preset)) throw new Error(`${label}: unknown preset "${pr.preset}"; presets: ${WARP_PRESETS.join(", ")}`);
    if (typeof pr.amount !== "number") throw new Error(`${label}: preset "${pr.preset}" needs a numeric amount`);
    add(warpPresetOffsets(w, pr.preset, pr.amount));
  }
  if (k.offsets !== undefined) {
    if (!Array.isArray(k.offsets) || k.offsets.length !== grid.length || !k.offsets.every(isVec))
      throw new Error(`${label}.offsets must have ${grid.length} [dx, dy] entries (row-major from the bottom row)`);
    add(k.offsets);
  }
  if (k.transform !== undefined) add(transformOffsets(grid, k.transform));
  return acc.map(([dx, dy]) => [round(dx), round(dy)] as Vec2);
}

function requireWarp(m: Model, id: string): Warp {
  const w = m.warps?.find((x) => x.id === id);
  if (!w) throw new Error(`unknown warp "${id}"; warps: ${(m.warps ?? []).map((x) => x.id).join(", ") || "(none, use addWarp)"}`);
  return w;
}

function checkParamKeys<T>(p: Parameter, keys: Array<ParamKey<T>>, valid: (v: unknown) => boolean): ParamKey<T>[] {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("keys must be a non-empty array of {at, v}");
  keys.forEach((k, i) => {
    if (typeof k?.at !== "number" || !Number.isFinite(k.at)) throw new Error(`keys[${i}].at must be a number (a value of ${p.id})`);
    if (k.at < p.min - 1e-9 || k.at > p.max + 1e-9) throw new Error(`keys[${i}].at ${k.at} is outside ${p.id}'s range [${p.min}, ${p.max}]`);
    if (!valid(k.v)) throw new Error(`keys[${i}].v has the wrong type: ${JSON.stringify(k.v)}`);
  });
  return keys.map((k) => ({ at: k.at, v: k.v }));
}

function mergeParamKeys<T>(existing: ParamKey<T>[] | undefined, keys: ParamKey<T>[], mode: "replace" | "merge" = "merge"): ParamKey<T>[] {
  const base = mode === "merge" ? (existing ?? []).filter((e) => !keys.some((k) => Math.abs(k.at - e.at) < 1e-9)) : [];
  return [...base, ...keys].sort((a, b) => a.at - b.at);
}

function requireIk(m: Model, id: string): IkConstraint {
  const c = m.ik?.find((x) => x.id === id);
  if (!c) throw new Error(`unknown IK constraint "${id}"; IK: ${(m.ik ?? []).map((x) => x.id).join(", ") || "(none)"}`);
  return c;
}

function checkChain(m: Model, bones: unknown): string[] {
  if (!Array.isArray(bones) || bones.length < 1 || bones.length > 2) throw new Error("bones must list 1 or 2 bones ([parent, child])");
  bones.forEach((b) => requireBone(m, String(b)));
  if (bones.length === 2 && findBone(m, bones[1])!.parent !== bones[0])
    throw new Error(`"${bones[1]}" must be a direct child of "${bones[0]}"`);
  return bones.map(String);
}

function assertTargetOutsideChain(m: Model, bones: string[], target: string): void {
  for (const b of bones) {
    if (isDescendant(m, target, b)) throw new Error(`target "${target}" is part of or below chain bone "${b}"; parent it elsewhere (e.g. root)`);
  }
}

function checkMix(v: number): number {
  if (typeof v !== "number" || !(v >= 0 && v <= 1)) throw new Error("mix must be between 0 and 1");
  return v;
}

/** Keeps the chain's current bend: positive when the child turns counter-clockwise from its parent. */
function inferBend(m: Model, bones: string[]): boolean {
  if (bones.length < 2) return true;
  const pose = computePose(m);
  const rel = wrapDeg(angleOf(pose.byId.get(bones[1])!.world) - angleOf(pose.byId.get(bones[0])!.world));
  return rel >= -1;
}

/** Converts world-space translate/rotate keys into setup-relative local offsets for one bone. */
function worldToLocalKeys(m: Model, animation: string, boneId: string, channel: BoneChannel, keys: Key<number | Vec2>[]): Key<number | Vec2>[] {
  if (channel === "scale") throw new Error('space "world" supports translate and rotate only');
  const bone = findBone(m, boneId)!;
  let prev: number | undefined;
  return keys.map((k) => {
    const pose = computePose(m, animation, k.t, { constraints: true, params: {} });
    const parentWorld = bone.parent ? pose.byId.get(bone.parent)!.world : fromTRS(0, 0, 0, 1, 1);
    if (channel === "translate") {
      const [wx, wy] = k.v as Vec2;
      const l = apply(invert(parentWorld), wx, wy);
      return { ...k, v: [round(l[0] - bone.x), round(l[1] - bone.y)] as Vec2 };
    }
    const flip = parentWorld[0] * parentWorld[3] - parentWorld[1] * parentWorld[2] < 0 ? -1 : 1;
    let local = wrapDeg(((k.v as number) - angleOf(parentWorld)) * flip - bone.rotation);
    // unwrap against the previous key so interpolation takes the short way round
    if (prev !== undefined) local = prev + wrapDeg(local - prev);
    prev = local;
    return { ...k, v: round(local) };
  });
}

function isDescendant(m: Model, id: string, ancestor: string): boolean {
  let cur = findBone(m, id);
  while (cur) {
    if (cur.id === ancestor) return true;
    cur = cur.parent ? findBone(m, cur.parent) : undefined;
  }
  return false;
}

function insertAt<T>(arr: T[], item: T, index?: number): void {
  if (index === undefined || index >= arr.length) arr.push(item);
  else arr.splice(Math.max(0, index), 0, item);
}

function assignLocal(bone: Bone, op: Partial<Bone>): void {
  for (const k of ["x", "y", "rotation", "length", "scaleX", "scaleY", "shearX", "shearY"] as const) {
    const v = op[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} must be a finite number`);
    if ((k === "shearX" || k === "shearY") && v === 0) delete bone[k];
    else bone[k] = v;
  }
}

function setLocalFromMatrix(bone: Bone, local: [number, number, number, number, number, number]): void {
  bone.x = round(local[4]);
  bone.y = round(local[5]);
  bone.rotation = round(angleOf(local));
  bone.scaleX = round(Math.hypot(local[0], local[1]), 4);
  const det = local[0] * local[3] - local[1] * local[2];
  bone.scaleY = round((det / (bone.scaleX || 1)), 4);
}

/** Sets a bone's local transform so its world origin/tip land on the given world points. */
function placeInWorld(m: Model, bone: Bone, start?: Vec2, end?: Vec2): void {
  const pose = computePose(m);
  const parentWorld = bone.parent ? pose.byId.get(bone.parent)!.world : fromTRS(0, 0, 0, 1, 1);
  const cur = boneEnds(pose.byId.get(bone.id)!);
  const s = start ?? cur.start;
  const inv = invert(parentWorld);
  const ls = apply(inv, s[0], s[1]);
  bone.x = round(ls[0]);
  bone.y = round(ls[1]);
  if (end) {
    const le = apply(inv, end[0], end[1]);
    const dx = le[0] - ls[0];
    const dy = le[1] - ls[1];
    if (Math.hypot(dx, dy) < 1e-9) throw new Error("start and end are the same point");
    bone.rotation = round(Math.atan2(dy, dx) / DEG);
    // length is measured along the bone's own (possibly scaled) axis
    const worldLen = Math.hypot(end[0] - s[0], end[1] - s[1]);
    const w = computePose(m).byId.get(bone.id)!.world;
    const axisScale = Math.hypot(w[0], w[1]) || 1;
    bone.length = round(worldLen / axisScale);
  }
}

function buildShape(shape: Shape) {
  if (!shape || typeof shape !== "object") throw new Error("shape is required: {rect}, {polygon} or {ellipse}");
  if ("rect" in shape) {
    const r = shape.rect;
    if (!(r.width > 0 && r.height > 0)) throw new Error("rect width/height must be > 0");
    return meshFromRect(r.x, r.y, r.width, r.height, shape.cols ?? 1, shape.rows ?? 1);
  }
  if ("ellipse" in shape) {
    const e = shape.ellipse;
    if (!(e.rx > 0 && e.ry > 0)) throw new Error("ellipse rx/ry must be > 0");
    return meshFromPolygon(ellipsePolygon(e.cx, e.cy, e.rx, e.ry, e.segments ?? 24), shape.spacing);
  }
  if ("polygon" in shape) return meshFromPolygon(shape.polygon, shape.spacing);
  throw new Error("shape must have rect, polygon or ellipse");
}

function rectOf(vs: Vec2[]) {
  const xs = vs.map((v) => v[0]);
  const ys = vs.map((v) => v[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x || 1, height: Math.max(...ys) - y || 1 };
}

function weightsFor(m: Model, vertices: Vec2[], bones: string[], maxInfluences: number, power: number) {
  const pose = computePose(m);
  return autoWeights(
    vertices,
    bones.map((id) => ({ id, ...boneEnds(pose.byId.get(id)!) })),
    maxInfluences,
    power,
  );
}

function checkKeys<T>(keys: Key<T>[], valid: (v: unknown) => boolean): Key<T>[] {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("keys must be a non-empty array of {t, v, ease?}");
  keys.forEach((k, i) => {
    if (typeof k?.t !== "number" || !Number.isFinite(k.t) || k.t < 0) throw new Error(`keys[${i}].t must be a number >= 0`);
    if (!valid(k.v)) throw new Error(`keys[${i}].v has the wrong type: ${JSON.stringify(k.v)}`);
    if (k.ease !== undefined && !isEase(k.ease) && !isChannelEases(k.ease)) throw new Error(`keys[${i}].ease invalid: ${JSON.stringify(k.ease)}`);
  });
  return keys.map((k) => (k.ease === undefined ? { t: k.t, v: k.v } : { t: k.t, v: k.v, ease: k.ease }));
}

function mergeKeys<T>(existing: Key<T>[] | undefined, keys: Key<T>[], mode: "replace" | "merge" = "replace"): Key<T>[] {
  const base = mode === "merge" ? (existing ?? []).filter((e) => !keys.some((k) => Math.abs(k.t - e.t) < 1e-6)) : [];
  return [...base, ...keys].sort((a, b) => a.t - b.t);
}

/**
 * After a setup-pose change, re-skins every mesh from the old setup pose to the new one and stores the result as
 * the new setup vertices (UVs unchanged, so the art moves with the bones). Parameter blend-shape offsets are
 * rotated/scaled with their vertex. Returns the number of meshes that moved.
 */
/** Bones whose setup world transform differs between two poses. */
function movedBones(before: Pose, after: Pose): Set<string> {
  return new Set(
    after.bones
      .filter((b) => {
        const a = before.byId.get(b.id);
        return !a || a.world.some((v, i) => Math.abs(v - b.world[i]) > 1e-9);
      })
      .map((b) => b.id),
  );
}

/** After a setup change that leaves the art in place: meshes bound (with Spine binds) to moved bones rebind. */
function rebindMoved(m: Model, before: Pose): void {
  const moved = movedBones(before, computePose(m));
  for (const [id, a] of Object.entries(m.attachments)) if (a.binds && a.weights.some((w) => w.some(([b]) => moved.has(b)))) dropBinds(m, id);
}

function carryMeshes(m: Model, before: Pose): number {
  const after = computePose(m);
  // bones whose setup transform actually changed; meshes not weighted to any of them are left alone
  const moved = new Set(after.bones.filter((b) => {
    const a = before.byId.get(b.id);
    return !a || a.world.some((v, i) => Math.abs(v - b.world[i]) > 1e-9);
  }).map((b) => b.id));
  if (!moved.size) return 0;
  const skin = new Map<string, number[]>();
  const skinFor = (id: string) => {
    let k = skin.get(id);
    if (!k) {
      const a = before.byId.get(id);
      const b = after.byId.get(id);
      k = a && b ? mul(b.world, invert(a.world)) : [1, 0, 0, 1, 0, 0];
      skin.set(id, k);
    }
    return k;
  };
  const fallback = new Map<string, string>();
  for (const s of m.slots) if (s.attachment && !fallback.has(s.attachment)) fallback.set(s.attachment, s.bone);
  let count = 0;
  for (const [attId, att] of Object.entries(m.attachments)) {
    const bone0 = fallback.get(attId);
    const touches = att.weights.some((w) => (w?.length ? w.some(([b, x]) => x > 0 && moved.has(b)) : !!bone0 && moved.has(bone0)));
    if (!touches) continue;
    let changed = false;
    // per-vertex blended matrix (linear blend skinning == blending the matrices)
    const mats = att.vertices.map((_, i) => {
      let infl = att.weights[i];
      if (!infl || infl.length === 0) infl = bone0 ? [[bone0, 1]] : [];
      const acc = [0, 0, 0, 0, 0, 0];
      let total = 0;
      for (const [id, w] of infl) {
        if (!(w > 0)) continue;
        const k = skinFor(id);
        for (let j = 0; j < 6; j++) acc[j] += k[j] * w;
        total += w;
      }
      return total > 0 ? acc.map((x) => x / total) : [1, 0, 0, 1, 0, 0];
    });
    // with Spine binds the mesh follows its bones exactly the way Spine moves it: from the bind positions
    const bindCount = att.weights.reduce((n, w) => n + Math.max(1, w.length), 0);
    const binds = att.binds && att.binds.length === bindCount * 2 ? att.binds : null;
    let bf = 0;
    const vertices = att.vertices.map((v, i) => {
      if (binds) {
        let x = 0;
        let y = 0;
        let total = 0;
        for (const [b, w] of att.weights[i]) {
          const p = after.byId.get(b)?.world;
          const lx = binds[bf++];
          const ly = binds[bf++];
          if (!p || !(w > 0)) continue;
          x += (p[0] * lx + p[2] * ly + p[4]) * w;
          y += (p[1] * lx + p[3] * ly + p[5]) * w;
          total += w;
        }
        const nx = round(x / (total || 1));
        const ny = round(y / (total || 1));
        if (nx !== v[0] || ny !== v[1]) changed = true;
        return [nx, ny] as Vec2;
      }
      const k = mats[i];
      const x = round(k[0] * v[0] + k[2] * v[1] + k[4]);
      const y = round(k[1] * v[0] + k[3] * v[1] + k[5]);
      if (x !== v[0] || y !== v[1]) changed = true;
      return [x, y] as Vec2;
    });
    if (!changed) continue;
    // a new object: applyOps may share attachment objects with the input model
    m.attachments[attId] = { ...att, vertices };
    count++;
    const rotateOffsets = (v: VertexOffsets): VertexOffsets =>
      v.map(([i, dx, dy]) => {
        const k = mats[i] ?? [1, 0, 0, 1, 0, 0];
        return [i, round(k[0] * dx + k[2] * dy), round(k[1] * dx + k[3] * dy)] as [number, number, number];
      });
    for (const p of m.parameters ?? []) for (const key of p.meshes?.[attId] ?? []) key.v = rotateOffsets(key.v);
    for (const c of m.combos ?? []) for (const key of c.keys) if (key.meshes?.[attId]) key.meshes[attId] = rotateOffsets(key.meshes[attId]);
    for (const a of Object.values(m.animations ?? {})) for (const key of a.deform?.[attId] ?? []) key.v = rotateOffsets(key.v);
  }
  return count;
}

// ---------- Spine constraints

export type SpineConstraintKind = "transform" | "path" | "physics" | "slider";
const CONSTRAINT_FIELD: Record<SpineConstraintKind, "transforms" | "paths" | "spinePhysics" | "sliders"> = { transform: "transforms", path: "paths", physics: "spinePhysics", slider: "sliders" };

function constraintList(m: Model, kind: SpineConstraintKind, create: boolean): Array<{ id: string }> | undefined {
  const field = CONSTRAINT_FIELD[kind];
  if (!field) throw new Error("kind must be transform, path, physics or slider");
  const rec = m as unknown as Record<string, Array<{ id: string }> | undefined>;
  if (create) rec[field] ??= [];
  return rec[field];
}

function allConstraintKeys(m: Model): string[] {
  return [
    ...(m.ik ?? []).map((c) => `ik:${c.id}`),
    ...(m.transforms ?? []).map((c) => `transform:${c.id}`),
    ...(m.paths ?? []).map((c) => `path:${c.id}`),
    ...(m.spinePhysics ?? []).map((c) => `physics:${c.id}`),
    ...(m.sliders ?? []).map((c) => `slider:${c.id}`),
  ];
}

/** Drops a removed constraint from the order, the skins and the animations. */
function forgetConstraint(m: Model, kind: "ik" | SpineConstraintKind, id: string): void {
  const key = `${kind}:${id}`;
  if (m.constraintOrder) {
    m.constraintOrder = m.constraintOrder.filter((k) => k !== key);
    if (!m.constraintOrder.length) delete m.constraintOrder;
  }
  for (const sk of Object.values(m.skins ?? {})) if (sk.constraints) sk.constraints = sk.constraints.filter((k) => k !== key);
  const field = kind === "ik" ? "ik" : ({ transform: "transforms", path: "paths", physics: "spinePhysics", slider: "sliders" } as const)[kind];
  for (const a of Object.values(m.animations ?? {})) {
    const rec = a as unknown as Record<string, Record<string, unknown> | undefined>;
    const group = rec[field];
    if (group) {
      delete group[id];
      if (!Object.keys(group).length) delete rec[field];
    }
  }
}

/** Why a Spine constraint definition is invalid (null when it is fine). */
function checkSpineConstraint(m: Model, kind: SpineConstraintKind, c: Record<string, unknown>): string | null {
  const bone = (b: unknown) => typeof b === "string" && !!findBone(m, b);
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const props = TRANSFORM_PROPERTIES as string[];
  switch (kind) {
    case "transform": {
      const t = c as unknown as TransformConstraint;
      if (!bone(t.source)) return `unknown source bone "${t.source}"`;
      if (!Array.isArray(t.bones) || !t.bones.length || !t.bones.every(bone)) return "bones must be existing bone ids";
      if (t.bones.includes(t.source)) return "the source cannot be one of the constrained bones";
      if (!Array.isArray(t.properties)) return "properties must be [{from, offset?, to: [{property, offset?, max?, scale?}]}]";
      for (const p of t.properties) {
        if (!props.includes(p.from)) return `from must be one of ${props.join(", ")}`;
        if (!Array.isArray(p.to) || p.to.some((x) => !props.includes(x.property))) return `to properties must be among ${props.join(", ")}`;
      }
      if (!t.mix || typeof t.mix !== "object" || Object.entries(t.mix).some(([k, v]) => !props.includes(k) || !num(v))) return "mix must map properties to numbers";
      return null;
    }
    case "path": {
      const t = c as unknown as PathConstraint;
      if (!Array.isArray(t.bones) || !t.bones.length || !t.bones.every(bone)) return "bones must be existing bone ids";
      if (!m.slots.some((s) => s.id === t.slot)) return `unknown slot "${t.slot}"`;
      if (!["fixed", "percent"].includes(t.positionMode)) return "positionMode must be fixed or percent";
      if (!["length", "fixed", "percent", "proportional"].includes(t.spacingMode)) return "spacingMode must be length, fixed, percent or proportional";
      if (!["tangent", "chain", "chainScale"].includes(t.rotateMode)) return "rotateMode must be tangent, chain or chainScale";
      if (!num(t.position) || !num(t.spacing)) return "position and spacing must be numbers";
      if (!t.mix || !num(t.mix.rotate) || !num(t.mix.x) || !num(t.mix.y)) return "mix must be {rotate, x, y}";
      return null;
    }
    case "physics": {
      const t = c as unknown as SpinePhysics;
      if (!bone(t.bone)) return `unknown bone "${t.bone}"`;
      for (const k of SPINE_PHYSICS_SETTINGS) if (!num(t[k])) return `${k} must be a number`;
      if (t.mass <= 0) return "mass must be > 0";
      return null;
    }
    case "slider": {
      const t = c as unknown as Slider;
      if (!m.animations?.[t.animation]) return `unknown animation "${t.animation}"`;
      if (!num(t.time) || !num(t.mix)) return "time and mix must be numbers";
      if (t.bone !== undefined && !bone(t.bone)) return `unknown bone "${t.bone}"`;
      if (t.property !== undefined && !props.includes(t.property)) return `property must be one of ${props.join(", ")}`;
      return null;
    }
  }
  return "kind must be transform, path, physics or slider";
}

/** An attachment id, or a placeholder some skin maps for the slot. */
function isAttachmentKey(m: Model, slot: string, key: string): boolean {
  return !!m.attachments[key] || !!m.pathAttachments?.[key] || !!m.clippings?.[key] || !!m.boundingBoxes?.[key] || Object.values(m.skins ?? {}).some((sk) => sk.attachments[slot]?.[key] !== undefined);
}
