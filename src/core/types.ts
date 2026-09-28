// Awaken2D model format types (format id "awaken2d/0.1").
// Coordinate system: world units, +x right, +y UP, rotations in degrees counter-clockwise.

export type Vec2 = [number, number];
export type Tri = [number, number, number];

export const FORMAT_ID = "awaken2d/0.1";
/** Format ids of the same format from before the project was renamed; read as FORMAT_ID. */
export const LEGACY_FORMAT_IDS = ["rigkit/0.1"];

export interface Bone {
  id: string;
  parent: string | null;
  /** Local translation relative to parent bone. */
  x: number;
  y: number;
  /** Local rotation (degrees, CCW) relative to parent bone. */
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Shear (degrees) of the local x / y axis, as in Spine. Optional, default 0. */
  shearX?: number;
  shearY?: number;
  /** Visual/weighting length along the bone's local +x axis. */
  length: number;
  /** Spine editor bone color; affects guides, not rendered attachments. */
  color?: string;
  /** Spine editor bone icon; a visual aid in the tree and viewport. */
  icon?: string;
  /** Which parent transforms the bone inherits (Spine). Default "normal" (all of them). */
  inherit?: Inherit;
  /** Spine: the bone only exists while the active skin lists it (see Skin.bones). */
  skin?: boolean;
}

/** Spine bone inherit modes: what a bone takes over from its parent's world transform. */
export type Inherit = "normal" | "onlyTranslation" | "noRotationOrReflection" | "noScale" | "noScaleOrReflection";
export const INHERITS: Inherit[] = ["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"];

export interface Slot {
  id: string;
  bone: string;
  /** Attachment shown in setup pose, or null for nothing. */
  attachment: string | null;
  /** Tint, "#rrggbb" or "#rrggbbaa". */
  color: string;
  /** How the attachment combines with what is drawn below it. Default "normal". */
  blend?: BlendMode;
  /**
   * Clipping mask: only draw where the named slot's current attachment is (as deformed this frame).
   * Use it for irises inside eye whites, teeth inside the mouth, patterns inside clothing.
   * Several slots (Live2D allows this) mask with their union.
   */
  clip?: string | string[];
  /** Invert the clipping mask: draw only OUTSIDE the mask shape. */
  clipInvert?: boolean;
  /** Hide back-facing (mirrored) triangles, like Live2D's culling setting. */
  cull?: boolean;
  /**
   * Spine two-color tint: the dark color, "#rrggbb". The image's dark parts take this color and its light parts
   * `color` (Spine's tint black). Absent: a plain tint.
   */
  dark?: string;
}

export type BlendMode = "normal" | "multiply" | "screen" | "additive";
export const BLEND_MODES: BlendMode[] = ["normal", "multiply", "screen", "additive"];

export interface MeshAttachment {
  type: "mesh";
  /** Key into model.images. When absent the mesh is filled with `color`. */
  image?: string;
  /** Fill/tint color. Default "#ffffff" with image, "#888888" without. */
  color?: string;
  /** Vertex positions in WORLD space of the setup pose. */
  vertices: Vec2[];
  /** Texture coordinates (0..1, v down). Required when `image` is set. */
  uvs?: Vec2[];
  triangles: Tri[];
  /** Per vertex list of [boneId, weight]. Weights are normalized at runtime. */
  weights: Array<Array<[string, number]>>;
  /**
   * Optional Spine bind positions: [x, y] per weight influence (flattened, in weight-list order), local to that
   * influence's bone. Spine keeps these per bone, and after a bone moves in setup they no longer agree on one
   * setup position; skinning uses them when present so such meshes pose exactly as in Spine. `vertices` stays
   * the setup-pose result. Any edit of the vertices or weights drops them.
   */
  binds?: number[];
  /**
   * Live2D keyforms (art mesh of a Live2D rig): the vertex positions come from these instead of `vertices`, which
   * holds the result at the parameters' defaults (kept in sync for tools; not the source of truth).
   */
  live2d?: Live2DMesh;
}

export type Attachment = MeshAttachment;

// ---------- Live2D (Cubism) rig
//
// A Live2D rig is keyforms over parameters: every art mesh, deformer and part stores whole "forms" at grid points of
// the parameters it is bound to, and the current form is the multilinear blend of the surrounding grid points
// (values clamp to the keyed range). Art meshes and deformers sit under a parent deformer: their points are in its
// space (a warp's 0..1 lattice square, or a rotation deformer's local frame), and the deformers carry them to the
// canvas. Canvas units are Cubism's: world = unit * pixelsPerUnit, +y up.

/** The parameters an object is keyed on and the key values on each; forms are the product grid, FIRST parameter varying fastest. */
export interface KeyformGrid {
  params: string[];
  /** Sorted key values, one list per parameter. */
  keys: number[][];
}

export type RGB = [number, number, number];

export interface Live2DColors {
  /** Multiply color (default [1, 1, 1]). */
  multiply?: RGB;
  /** Screen color (default [0, 0, 0]). */
  screen?: RGB;
}

export interface MeshKeyform extends Live2DColors {
  /** x, y per vertex, flat, in the parent deformer's space (canvas units when there is none). */
  points: number[];
  /** Default 1. */
  opacity?: number;
  /** Draw order within the draw-order group (Cubism default 500). */
  drawOrder?: number;
}

/** A weight limit of a blend shape: its weight is multiplied by this piecewise-linear function of another parameter. */
export interface Live2DBlendShapeConstraint {
  param: string;
  /** [parameter value, weight] points, by value (clamped outside). */
  values: Array<[number, number]>;
}

/**
 * Live2D blend shape (Cubism 4.2+): the object adds a difference keyed on a blend-shape parameter, one form per
 * key of that parameter (the base key's form is zero), interpolated between keys and scaled by the constraints.
 * Form fields are differences: points / opacity / draw order / colors / angle... are added.
 */
export interface Live2DBlendShape<F> {
  param: string;
  forms: F[];
  constraints?: Live2DBlendShapeConstraint[];
}

/**
 * Deformation path on a Live2D art mesh (Cubism's path tool; editing aid, not exported): a curve through control
 * points pinned inside mesh triangles (vertex indices, barycentric weights) so it follows every keyform, and the
 * vertices bound to it, which follow the curve when a control point is dragged.
 */
export interface Live2DPath {
  points: Array<{ tri: [number, number, number]; w: [number, number, number]; corner?: boolean }>;
  closed?: boolean;
  /** Bound vertices: position along the curve (control point index + fraction) and influence 0..1. */
  bind: Array<{ vertex: number; t: number; weight: number }>;
  /** Brush width in pixels (what vertices it binds when drawn). */
  width?: number;
}

export interface Live2DMesh {
  deformer: string | null;
  part: string | null;
  grid: KeyformGrid;
  forms: MeshKeyform[];
  blendShapes?: Live2DBlendShape<MeshKeyform>[];
  /** Hidden in the Cubism editor (visible flag off). */
  hidden?: boolean;
  /** Disabled: never drawn. */
  disabled?: boolean;
  /** Locked in the editor: not picked in the viewport (editor state, not exported). */
  locked?: boolean;
  /** Display name in the Cubism editor (from a .cmo3; editor state, not exported). */
  name?: string;
  /** Deformation paths (editor state, not exported). */
  paths?: Live2DPath[];
}

export interface WarpKeyform extends Live2DColors {
  /** x, y per lattice point ((cols+1)*(rows+1), row-major from the first row), flat, in the parent's space. */
  points: number[];
  opacity?: number;
}

export interface RotationKeyform extends Live2DColors {
  /** Origin in the parent's space. */
  x: number;
  y: number;
  /** Degrees (added to the deformer's baseAngle). */
  angle: number;
  scale: number;
  reflectX?: boolean;
  reflectY?: boolean;
  opacity?: number;
}

interface DeformerBase {
  id: string;
  /** Parent deformer, or null (canvas). */
  parent: string | null;
  part: string | null;
  grid: KeyformGrid;
  hidden?: boolean;
  disabled?: boolean;
  /** Locked in the editor (editor state, not exported). */
  locked?: boolean;
  /** Display name in the Cubism editor (from a .cmo3; editor state, not exported). */
  name?: string;
}

/** Live2D warp deformer: children's points are in its 0..1 square, mapped through the keyed lattice. */
export interface WarpDeformer extends DeformerBase {
  type: "warp";
  cols: number;
  rows: number;
  /** Bilinear interpolation inside cells (Cubism 3.3+ "new" warp); otherwise two triangles per cell. */
  bilinear?: boolean;
  forms: WarpKeyform[];
  blendShapes?: Live2DBlendShape<WarpKeyform>[];
}

/** Live2D rotation deformer: children's points are in its local frame (rotated, scaled, placed at its origin). */
export interface RotationDeformer extends DeformerBase {
  type: "rotation";
  baseAngle: number;
  forms: RotationKeyform[];
  blendShapes?: Live2DBlendShape<RotationKeyform>[];
}

export type Deformer = WarpDeformer | RotationDeformer;

/** Live2D part (a folder): opacity for everything in it (animated), and a draw order when it is a draw-order group item. */
export interface Part {
  id: string;
  name?: string;
  parent: string | null;
  /** Opacity 1 at rest (default true); false = 0. */
  visible?: boolean;
  disabled?: boolean;
  /** Locked in the editor: nothing in it is picked in the viewport (editor state, not exported). */
  locked?: boolean;
  /** Label color in the editor's parts list, "#rrggbb" (editor state, not exported). */
  label?: string;
  grid: KeyformGrid;
  /** Draw order per form. */
  drawOrders: number[];
  /** Blend shapes on the draw order (one difference per key). */
  blendShapes?: Live2DBlendShape<number>[];
}

/** Live2D glue: pulls vertex pairs of two meshes together (by keyed intensity). */
export interface Glue {
  id: string;
  a: string;
  b: string;
  /** Part it is listed under in the editor's parts tree (from a .cmo3; editor state, not exported). */
  part?: string | null;
  /** [vertexInA, vertexInB] pairs, flat. */
  pairs: number[];
  /** [weightA, weightB] per pair, flat. */
  weights: number[];
  grid: KeyformGrid;
  /** Intensity per form. */
  intensity: number[];
  /** Blend shapes on the intensity (one difference per key). */
  blendShapes?: Live2DBlendShape<number>[];
}

/** A draw-order group: its items sort by their current draw order (clamped to min..max), ties keep list order. */
export interface DrawOrderGroup {
  min: number;
  max: number;
  /** Slots, and parts whose own group is drawn at that part's place. */
  items: Array<{ slot: string } | { part: string; group: number }>;
}

/** A Live2D physics input or output kind: horizontal / vertical movement or angle. */
export type Live2DPhysicsKind = "X" | "Y" | "Angle";

/**
 * Live2D physics (physics3.json): pendulums driven by input parameters that write output parameters, simulated as
 * the Cubism Framework does. Runs on the parameter values before the rig is evaluated.
 */
export interface Live2DPhysics {
  /** Fixed simulation rate (physics3 Meta.Fps); absent = one step per frame. */
  fps?: number;
  /** EffectiveForces of the file (kept for export; the Cubism runtime simulates with gravity (0, -1) and no wind). */
  gravity?: Vec2;
  wind?: Vec2;
  settings: Live2DPhysicsSetting[];
}

export interface Live2DPhysicsSetting {
  id: string;
  name?: string;
  inputs: Array<{ param: string; weight: number; type: Live2DPhysicsKind; reflect?: boolean }>;
  outputs: Array<{ param: string; vertex: number; scale: number; weight: number; type: Live2DPhysicsKind; reflect?: boolean }>;
  vertices: Array<{ x: number; y: number; mobility: number; delay: number; acceleration: number; radius: number }>;
  normalization: {
    position: { min: number; default: number; max: number };
    angle: { min: number; default: number; max: number };
  };
}

/**
 * Live2D pose groups (pose3.json): in each group one part is shown; an animation picks it by keying that part's
 * opacity above 0, and the others fade out over fadeIn seconds (like Cubism's CubismPose). Links follow their part.
 */
export interface Live2DPose {
  fadeIn?: number;
  groups: Array<Array<{ part: string; link?: string[] }>>;
}

export interface Live2DRig {
  canvas: { width: number; height: number; originX: number; originY: number; pixelsPerUnit: number };
  physics?: Live2DPhysics;
  pose?: Live2DPose;
  parts: Part[];
  /** Parents before children. */
  deformers: Deformer[];
  glue?: Glue[];
  /** Group 0 is the root. When absent, all Live2D slots form one group (0..1000). */
  drawOrderGroups?: DrawOrderGroup[];
}

export interface ImageRef {
  /** Path relative to the model file. PNG only. */
  path: string;
}

/** Curve from this key to the next one. Array form is a CSS-style cubic bezier [x1, y1, x2, y2]. */
export type Ease = "linear" | "stepped" | "easeIn" | "easeOut" | "easeInOut" | [number, number, number, number];

export interface Key<T> {
  /** Time in seconds. */
  t: number;
  v: T;
  /**
   * Curve to the next key. For multi-value keys (translate/scale/shear, colors) it may be one ease per channel
   * ([x, y] or [r, g, b, a]), as Spine allows separate curves per channel.
   */
  ease?: Ease | Ease[];
}

export interface BoneTimeline {
  /** Inherit mode changes (stepped). */
  inherit?: Key<Inherit>[];
  /** Degrees ADDED to the setup rotation. */
  rotate?: Key<number>[];
  /** Offset ADDED to the setup translation (parent space). */
  translate?: Key<Vec2>[];
  /** Factor MULTIPLIED with the setup scale. */
  scale?: Key<Vec2>[];
  /** Degrees ADDED to the setup shear [x, y]. */
  shear?: Key<Vec2>[];
  /**
   * Single-axis tracks (Spine 4.1+ keys the axes separately): they replace that axis of translate / scale / shear.
   * Imported Spine data keeps them when the two axes have keys at different times.
   */
  translateX?: Key<number>[];
  translateY?: Key<number>[];
  scaleX?: Key<number>[];
  scaleY?: Key<number>[];
  shearX?: Key<number>[];
  shearY?: Key<number>[];
}

export const AXIS_CHANNELS = ["translateX", "translateY", "scaleX", "scaleY", "shearX", "shearY"] as const;

export interface SlotTimeline {
  attachment?: Key<string | null>[];
  color?: Key<string>[];
  /** Two-color tint dark color, "#rrggbb" (the slot must have `dark`). Spine keys it with the color (rgba2). */
  dark?: Key<string>[];
}

export interface IkTimeline {
  mix?: Key<number>[];
  softness?: Key<number>[];
  compress?: Key<boolean>[];
  stretch?: Key<boolean>[];
  /** Always stepped. */
  bendPositive?: Key<boolean>[];
}

/** Sparse vertex offsets: [vertexIndex, dx, dy] (world units, setup space). */
export type VertexOffsets = Array<[number, number, number]>;

/** A Live2D parameter: a named knob that keyforms (art meshes, deformers, parts, glue) are keyed on. */
export interface Parameter {
  id: string;
  min: number;
  max: number;
  default: number;
  /** Display name (e.g. from Live2D's cdi3). */
  name?: string;
  /** Display group. */
  group?: string;
  /** Live2D: the value wraps around (e.g. 360-degree turns). */
  repeat?: boolean;
  /** Live2D: decimal places shown (and the key snap tolerance). */
  decimals?: number;
  /**
   * Live2D: linked with the next parameter in the list, shown as one 2D control (Cubism's chain link; cdi3
   * CombinedParameters). Editor display only.
   */
  combined?: boolean;
  /**
   * Live2D blend-shape parameter (Cubism 4.2+): objects bound to it add keyed differences on top of their keyforms
   * (see Live2DBlendShape). `keys` are its key values, `base` the index of the key where it adds nothing.
   */
  blendShape?: { keys: number[]; base: number };
}

export interface Animation {
  duration: number;
  loop?: boolean;
  /** Parameter values over time. */
  params?: Record<string, Key<number>[]>;
  bones?: Record<string, BoneTimeline>;
  slots?: Record<string, SlotTimeline>;
  ik?: Record<string, IkTimeline>;
  /**
   * Draw-order changes over time (stepped, like Spine): each key moves slots by [slotId, offset] positions from
   * their setup draw order (positive = toward the front); slots not listed keep their relative order.
   */
  drawOrder?: DrawOrderKey[];
  /**
   * Mesh deformation over time, per attachment: sparse [vertexIndex, dx, dy] offsets in setup space, added to
   * the setup vertices (with blend shapes) before skinning. Like Spine's deform timelines.
   */
  deform?: Record<string, DeformKey[]>;
  /** Events fired at points in time (data for the game; they do not change the pose). */
  events?: EventKey[];
  /** Transform constraint mixes over time, by constraint id. */
  transforms?: Record<string, TransformTimeline>;
  /** Path constraint position, spacing and mixes over time, by constraint id. */
  paths?: Record<string, PathTimeline>;
  /** Spine physics settings over time, by constraint id ("" = every constraint whose setting is global). */
  spinePhysics?: Record<string, SpinePhysicsTimeline>;
  /** Slider time and mix over time, by slider id. */
  sliders?: Record<string, SliderTimeline>;
  /**
   * Live2D part opacity over time (0..1), by part id. Parts in a pose group only use it to pick the shown part
   * (see Live2DPose); other parts take it as their opacity.
   */
  partOpacity?: Record<string, Key<number>[]>;
}

/**
 * A deform keyform. `v` (setup-space offsets per vertex) is what Awaken2D edits. Data imported from Spine also
 * keeps Spine's own form in `local`: deltas per bone influence in each bone's local space, in the order of the
 * attachment's weight lists (`offset` counts numbers, x and y per influence). When every key of a track has it
 * and it still fits the mesh, skinning uses it, which reproduces Spine exactly even where the per-bone deltas
 * disagree (deforms keyed in an animated pose). Editing a key through ops drops it.
 */
export interface DeformKey extends Key<VertexOffsets> {
  local?: { offset: number; values: number[] };
}

/** Event defaults (Spine-style): name -> values an event key inherits unless it sets its own. */
export interface EventDef {
  int?: number;
  float?: number;
  string?: string;
  audio?: string;
  volume?: number;
  balance?: number;
}

export interface EventKey {
  t: number;
  name: string;
  int?: number;
  float?: number;
  string?: string;
  volume?: number;
  balance?: number;
}

export interface DrawOrderKey {
  t: number;
  offsets: Array<[string, number]>;
}

/**
 * Rotates a chain of 1 or 2 bones so the chain tip reaches the target bone's world position.
 * Applied in array order after animation, before skinning.
 */
export interface IkConstraint {
  id: string;
  /** Spine: only active while the active skin lists it. */
  skin?: boolean;
  /** Spine: distance before full extension where the chain starts to straighten softly (two-bone chains). */
  softness?: number;
  /** Spine: one-bone chains shrink to reach a target that is too close. */
  compress?: boolean;
  /** Spine: the chain stretches to reach a target that is too far. */
  stretch?: boolean;
  /** Spine: how stretching / compressing changes scaleY. Default: not at all. */
  scaleY?: ScaleYMode;
  /** [bone] or [parent, child] where child.parent === parent. */
  bones: string[];
  /** Bone whose world origin is the goal. Must not be part of or below the chain. */
  target: string;
  /** 0 = ignore IK, 1 = fully solved. */
  mix: number;
  /** Two-bone chains: true bends the joint counter-clockwise (the child rotates positive). */
  bendPositive: boolean;
}

/**
 * What a model is made for. "spine": bones, weights, constraints (IK, transform, path, physics, sliders), skins and
 * bone / slot / deform / draw-order timelines (exports to Spine). "live2d": parameters and the Live2D rig (keyforms,
 * deformers, parts, physics3, pose), animated by parameter and part-opacity tracks (exports to Live2D). Ops for the
 * other kind are refused. Files saved without one load as Live2D when they have a Live2D rig, else as Spine.
 */
export type ModelTarget = "spine" | "live2d";
export const MODEL_TARGETS: ModelTarget[] = ["spine", "live2d"];

export interface Model {
  format: string;
  name: string;
  target: ModelTarget;
  meta?: Record<string, unknown>;
  images?: Record<string, ImageRef>;
  /** Bones; order is free, parents are resolved by id. */
  bones: Bone[];
  /** Slots in draw order, back to front. */
  slots: Slot[];
  attachments: Record<string, Attachment>;
  animations?: Record<string, Animation>;
  /** IK constraints, applied in order. */
  ik?: IkConstraint[];
  /** Spine transform constraints: bones copy (part of) another bone's transform. */
  transforms?: TransformConstraint[];
  /** Spine path constraints: bones follow a path attachment. */
  paths?: PathConstraint[];
  /** Spine physics constraints (Spine 4.2+ physics). */
  spinePhysics?: SpinePhysics[];
  /** Spine 4.3 sliders: an animation posed at a time set by a value or a bone. */
  sliders?: Slider[];
  /**
   * Evaluation order of the constraints, like Spine's constraints list, as "<kind>:<id>" (kind: ik, transform,
   * path, physics, slider; ids are unique per kind only). Constraints missing from it run after the listed ones,
   * IK first, in the order above.
   */
  constraintOrder?: string[];
  /** Spine skins: named sets of attachments (and skin-only bones / constraints). */
  skins?: Record<string, Skin>;
  /** The active skin (absent: only the default attachments). */
  skin?: string;
  /** Spine physics: world units per reference unit for wind and gravity (Spine's referenceScale, default 100). */
  referenceScale?: number;
  /** Spine path attachments (curves the path constraints follow; never drawn), by id. */
  pathAttachments?: Record<string, PathAttachment>;
  /** Spine clipping attachments (polygons that clip the slots above them), by id. */
  clippings?: Record<string, ClippingAttachment>;
  /** Spine bounding box attachments (hit-test polygons for games; never drawn), by id. */
  boundingBoxes?: Record<string, BoundingBoxAttachment>;
  /** Live2D parameters. */
  parameters?: Parameter[];
  /** Event definitions (see EventKey). */
  events?: Record<string, EventDef>;
  /** Live2D rig: deformers, parts, glue and draw-order groups (art meshes are attachments with `live2d`). */
  live2d?: Live2DRig;
}

export type BoneChannel = keyof BoneTimeline;
export type SlotChannel = keyof SlotTimeline;
export type IkChannel = keyof IkTimeline;

/** How a constraint's stretch / squash changes the bone's scaleY (Spine). */
export type ScaleYMode = "uniform" | "volume";

/** A bone transform property (Spine transform constraints and sliders read / write these). */
export type TransformProperty = "rotate" | "x" | "y" | "scaleX" | "scaleY" | "shearY";
export const TRANSFORM_PROPERTIES: TransformProperty[] = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"];

/**
 * Spine transform constraint: the source bone's properties drive the constrained bones' properties. Each "from"
 * property maps to one or more "to" properties: to = to.offset + (from value - from.offset) * to.scale (clamped
 * between to.offset and to.max with `clamp`), mixed in by the mix of the written property.
 */
export interface TransformConstraint {
  id: string;
  /** Constrained bones. */
  bones: string[];
  source: string;
  /** Read the source's local transform (else its world transform). */
  localSource?: boolean;
  /** Write the bones' local transforms (else their world transforms). */
  localTarget?: boolean;
  /** Add to the bones' transforms instead of replacing them. */
  additive?: boolean;
  clamp?: boolean;
  /** Offsets added to the source's values (rotate / shearY in degrees). */
  offset?: Partial<Record<TransformProperty, number>>;
  properties: TransformMapping[];
  /** Mix per written property (0 = off, 1 = full; Spine allows other values). Missing = 0. */
  mix: Partial<Record<TransformProperty, number>>;
  /** Only active while the active skin lists it. */
  skin?: boolean;
}

export interface TransformMapping {
  from: TransformProperty;
  offset?: number;
  to: Array<{ property: TransformProperty; offset?: number; max?: number; scale?: number }>;
}

/** Spine path constraint: bones placed along (and rotated with) the path attachment in `slot`. */
export interface PathConstraint {
  id: string;
  bones: string[];
  /** Slot whose current attachment is the path. */
  slot: string;
  /** Position along the path: "percent" (0..1 of its length) or "fixed" (world units). */
  positionMode: "fixed" | "percent";
  spacingMode: "length" | "fixed" | "percent" | "proportional";
  rotateMode: "tangent" | "chain" | "chainScale";
  /** Rotation offset (degrees). */
  rotation?: number;
  position: number;
  spacing: number;
  mix: { rotate: number; x: number; y: number };
  skin?: boolean;
}

/**
 * Spine path attachment: cubic bezier curves through points, 3 vertices per point (in handle, point, out
 * handle: Spine's layout, which starts with the first point's in handle), in setup world space and weighted like
 * mesh vertices. Path attachments are never drawn.
 */
export interface PathAttachment {
  vertices: Vec2[];
  weights: Array<Array<[string, number]>>;
  /** Spine per-influence bind positions (see MeshAttachment.binds). */
  binds?: number[];
  closed?: boolean;
  /** Even speed along the path (Spine's default). */
  constantSpeed?: boolean;
  /** Length of the path at the end of each curve (used when constantSpeed is false). */
  lengths: number[];
  color?: string;
}

/**
 * Spine clipping attachment: while it is the slot's attachment, the slots from this one up to and including `end`
 * in draw order are drawn only inside the polygon. Never drawn itself.
 */
export interface ClippingAttachment {
  /** Polygon, setup-pose world space. */
  vertices: Vec2[];
  weights: Array<Array<[string, number]>>;
  /** Spine per-influence bind positions (see MeshAttachment.binds). */
  binds?: number[];
  /** Last slot clipped (absent: clips to the end of the draw order). */
  end?: string;
  /** Spine 4.3: clip with the polygon's convex hull (cheaper in Spine; a concave polygon loses its dents). */
  convex?: boolean;
  /** Spine 4.3: draw only OUTSIDE the polygon (always its convex hull). */
  inverse?: boolean;
  color?: string;
}

/**
 * Spine bounding box attachment: a polygon games test hits against (Spine's SkeletonBounds). Never drawn; it follows
 * its bones and deform keys like a mesh.
 */
export interface BoundingBoxAttachment {
  /** Polygon, setup-pose world space. */
  vertices: Vec2[];
  weights: Array<Array<[string, number]>>;
  /** Spine per-influence bind positions (see MeshAttachment.binds). */
  binds?: number[];
  color?: string;
}

/** Spine 4.2+ physics constraint on one bone. */
export interface SpinePhysics {
  id: string;
  bone: string;
  /** How much of each property is simulated (usually 0..1). */
  x?: number;
  y?: number;
  rotate?: number;
  scaleX?: number;
  shearX?: number;
  scaleY?: ScaleYMode;
  /** Max movement per second picked up from the bone (world units). Default 5000. */
  limit?: number;
  /** Simulation steps per second. Default 60. */
  fps?: number;
  inertia: number;
  strength: number;
  damping: number;
  mass: number;
  wind: number;
  gravity: number;
  mix: number;
  /** Settings that the physics timelines of all constraints ("" in Animation.spinePhysics) change. */
  global?: SpinePhysicsSetting[];
  skin?: boolean;
}

export type SpinePhysicsSetting = "inertia" | "strength" | "damping" | "mass" | "wind" | "gravity" | "mix";
export const SPINE_PHYSICS_SETTINGS: SpinePhysicsSetting[] = ["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"];

/**
 * Spine 4.3 slider: poses `animation` at `time` (or at a time driven by a bone property), mixed by `mix`.
 * With a bone: time = to + (bone property - from) * scale.
 */
export interface Slider {
  id: string;
  animation: string;
  time: number;
  mix: number;
  additive?: boolean;
  loop?: boolean;
  bone?: string;
  property?: TransformProperty;
  local?: boolean;
  from?: number;
  to?: number;
  scale?: number;
  /** Editor hint: the largest value the slider goes to. */
  max?: number;
  skin?: boolean;
}

/**
 * Spine skin: which attachment a slot shows for a placeholder name while the skin is active. Slot attachments
 * (setup and keys) are attachment ids or placeholder names; the active skin maps a placeholder to one of its
 * attachments, otherwise an attachment id is drawn as it is.
 */
export interface Skin {
  /** slot -> placeholder -> attachment id (in model.attachments or model.pathAttachments). */
  attachments: Record<string, Record<string, string>>;
  /** Bones (with `skin: true`) that exist while this skin is active. */
  bones?: string[];
  /** Constraints (with `skin: true`) active while this skin is active, as "<kind>:<id>" (see constraintOrder). */
  constraints?: string[];
}

export interface TransformTimeline {
  rotate?: Key<number>[];
  x?: Key<number>[];
  y?: Key<number>[];
  scaleX?: Key<number>[];
  scaleY?: Key<number>[];
  shearY?: Key<number>[];
}

export interface PathTimeline {
  position?: Key<number>[];
  spacing?: Key<number>[];
  rotate?: Key<number>[];
  x?: Key<number>[];
  y?: Key<number>[];
}

export interface SpinePhysicsTimeline {
  inertia?: Key<number>[];
  strength?: Key<number>[];
  damping?: Key<number>[];
  mass?: Key<number>[];
  wind?: Key<number>[];
  gravity?: Key<number>[];
  mix?: Key<number>[];
  /** Times at which the simulation restarts. */
  reset?: number[];
}

export interface SliderTimeline {
  time?: Key<number>[];
  mix?: Key<number>[];
}
