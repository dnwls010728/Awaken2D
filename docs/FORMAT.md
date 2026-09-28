# Awaken2D model format (`awaken2d/0.1`) and edit ops

A model is one JSON file (convention: `*.rig.json`). Everything is plain data so agents can read,
diff, and generate it. Prefer editing through **ops** (`rig apply` / MCP `rig_apply`): they check
references, compute world placement and weights, and are atomic.

## Coordinates

- World units, **+x right, +y up**, rotation in **degrees counter-clockwise**.
- A bone's local transform is relative to its parent: translate (`x`,`y`), `rotation`, `scaleX`, `scaleY`.
- A bone points along its local +x axis; `length` is the distance from origin to tip.
- Mesh `vertices` are stored in **world space of the setup pose** (no animation). Moving a bone's
  setup transform later does not move meshes; re-run `autoWeight` if the bone layout changed a lot.

## Top level

```json
{
  "format": "awaken2d/0.1",
  "name": "mascot",
  "target": "spine",
  "meta": {},
  "images": { "face": { "path": "images/face.png" } },
  "bones": [ ... ],
  "slots": [ ... ],
  "attachments": { ... },
  "ik": [ ... ], "physics": [ ... ], "parameters": [ ... ], "warps": [ ... ], "combos": [ ... ],
  "transforms": [ ... ], "paths": [ ... ], "spinePhysics": [ ... ], "sliders": [ ... ], "constraintOrder": [ ... ],
  "skins": { ... }, "skin": "name", "pathAttachments": { ... }, "clippings": { ... }, "boundingBoxes": { ... }, "referenceScale": 100,
  "live2d": { ... },
  "animations": { ... }
}
```
(everything but `format`, `name`, `bones`, `slots`, `attachments` is optional.)

**target** says what the model is made for, and only that kind's features are available (ops for the other kind
are refused, the editor hides them):
- `"spine"` — Spine2D: bones (with inherit modes), weighted meshes, skins, IK / transform / path / physics / slider
  constraints, bone / slot / deform / draw-order / event / constraint timelines. No parameters and no spring bones
  (Spine export drops them). Exports with `rig spine-export`. Spine models are posed by Spine's own update rules
  (see "Spine constraints").
- `"live2d"` — Live2D: art meshes on a canvas (on the root bone, no other bones), parameters, keyforms, warp and
  rotation deformers, parts, physics3 and pose groups, animated by parameter, part-opacity and event tracks.
  Exports with `rig live2d-export`.
New models are made by agents only (`rig_new` / `rig new` with `target`; imports set it: Spine data → spine,
Live2D data → live2d, layered art → the `target` given). Older files without a target allow everything, including
Awaken2D's own parameter effects (bone keys, blend shapes, warps, combos), which neither format exports; `setTarget`
gives them one when nothing of the other kind is in the way. Awaken2D spring bones (`physics`) are only for models
without a target, like the demo character (`rig import --target none`).

### bones

```json
{ "id": "upper_arm_l", "parent": "torso", "x": 30, "y": 60, "rotation": 180, "length": 45 }
```
Defaults: `x=0 y=0 rotation=0 scaleX=1 scaleY=1 length=0`. Exactly one or more roots with `"parent": null`.
Optional `shearX` / `shearY` (degrees) shear the bone's local x / y axis exactly as in Spine.
Optional `inherit` (Spine): `normal` (default), `onlyTranslation`, `noRotationOrReflection`, `noScale`,
`noScaleOrReflection` — what the bone takes over from its parent's world transform. `skin: true`: the bone only
exists while the active skin lists it (`skins.<name>.bones`); its slots are not drawn otherwise.

### slots (draw order, back to front)

```json
{ "id": "arm_l", "bone": "upper_arm_l", "attachment": "arm_l_skin", "color": "#ffffff" }
```
A slot shows at most one attachment. `color` tints it (`#rrggbb` or `#rrggbbaa`). `blend` (optional) is
`normal` (default), `multiply`, `screen` or `additive` — imported from PSD blend modes.
`clip` (optional) names another slot: this slot is only drawn where that slot's attachment is drawn in the
current frame (a runtime clipping mask, e.g. irises clipped to the eye white so a closing lid hides them).
Ops: `updateSlot` with `clip: "slotId"` or `clip: null`. `clip` may also list several slots (their union, as Live2D
masks do); `clipInvert: true` draws only outside the mask; `cull: true` hides back-facing triangles (Live2D culling).
Spine models clip with clipping attachments instead (see Spine constraints and skins). `dark` (Spine, `#rrggbb`) is
the two-color tint ("tint black"): the image's light parts take `color`, its dark parts `dark`
(`light * tex + dark * (1 - tex)`); `updateSlot` with `dark: "#rrggbb"` or `dark: null`.

### attachments (meshes)

```json
"arm_l_skin": {
  "type": "mesh",
  "color": "#e0a070",
  "image": "face",            // optional, key into images; needs uvs
  "vertices": [[0,0], [10,0], [10,10]],
  "uvs": [[0,1], [1,1], [1,0]], // 0..1, v grows downward (image rows)
  "triangles": [[0,1,2]],
  "weights": [[["upper_arm_l", 1]], [["upper_arm_l", 0.6], ["lower_arm_l", 0.4]], [["lower_arm_l", 1]]]
}
```
- `binds` (optional, from Spine): `[x, y]` per weight influence, flattened in weight-list order, local to that influence's
  bone. Spine keeps these per bone; after a bone moves in setup they no longer agree on one setup position, and
  skinning then uses them so the mesh poses exactly as in Spine. Editing the vertices or weights drops them.
Skinning is linear blend: each vertex follows `sum(w * poseWorld(bone) * inverse(setupWorld(bone)))`.

### animations

```json
"wave": {
  "duration": 1.2, "loop": true,
  "bones": {
    "lower_arm_l": {
      "rotate":    [{ "t": 0, "v": 0, "ease": "easeInOut" }, { "t": 0.6, "v": 40 }, { "t": 1.2, "v": 0 }],
      "translate": [{ "t": 0, "v": [0, 0] }],
      "scale":     [{ "t": 0, "v": [1, 1] }]
    }
  },
  "slots": {
    "mouth": { "attachment": [{ "t": 0, "v": "mouth_closed" }, { "t": 0.3, "v": "mouth_open" }],
               "color": [{ "t": 0, "v": "#ffffff" }, { "t": 1, "v": "#ffffff00" }] }
  }
}
```
- `rotate` degrees are **added** to setup rotation; `translate` is **added** to setup position (parent space);
  `scale` **multiplies** setup scale.
- `ease` describes the curve from that key to the next: `linear` (default), `stepped`, `easeIn`, `easeOut`,
  `easeInOut`, or a cubic bezier `[x1, y1, x2, y2]` (CSS style).
- Looping animations wrap time; for a seamless loop make the last key equal the first at `t = duration`.
- Slot `attachment` keys are always stepped. Spine slots with a `dark` color also take `dark` keys (`#rrggbb`),
  written out with the color keys as Spine's `rgba2` timeline.
- `shear` bone channel: `[x, y]` degrees added to the setup shear.
- A key's `ease` may be one ease per channel for multi-value keys (`translate`, `scale`, `shear`, slot `color`):
  `"ease": ["linear", [0.25, 0, 0.75, 1]]` (Spine lets each channel have its own curve).
- `deform` (optional): `{ "attachmentId": [{ "t": 0.5, "v": [[vertexIndex, dx, dy], ...], "ease": ... }] }`, setup-space
  offsets added to the vertices (with blend shapes) before skinning, like Spine's deform timelines. Keys imported
  from Spine also carry `local: { offset, values }` (Spine's per-bone deltas) so the pose is exact; ops drop it.
- `events` (optional): `[{ "t": 0.3, "name": "step", "int"?, "float"?, "string"?, "volume"?, "balance"? }]`; names are
  defined in the top-level `events` map (`{ "step": { "int": 1 } }`). Data for games; they do not change the pose.
  An event's `audio` is a sound file path under `audio/` next to the model (the editor plays it during playback;
  its event panel's *Choose sound file…* copies a .wav / .ogg / .mp3 there). The Spine export copies the sounds to
  `audio/` beside the JSON and, when the skeleton has no audio folder yet, sets `skeleton.audio` to `./audio/`.
- `drawOrder` (optional): `[{ "t": 0.4, "offsets": [["hand_l", 12], ["forearm_l", 12]] }, { "t": 2, "offsets": [] }]`.
  Stepped: from each key's time the listed slots move that many places from their setup draw order (positive =
  toward the front); unlisted slots keep their relative order. A key with no offsets restores the setup order.

### ik (inverse kinematics)

```json
"ik": [
  { "id": "leg_l_ik", "bones": ["thigh_l", "shin_l"], "target": "leg_l_ik_target", "mix": 1, "bendPositive": false }
]
```
- After animation is applied, each constraint (in array order) rotates its chain so the chain tip reaches the
  target bone's world origin. `bones` is `[bone]` (aim the bone at the target) or `[parent, child]` (two-bone,
  solved exactly; the tip is the child's `length` end). Bone lengths never change; an out-of-reach target
  straightens the chain toward it.
- `bendPositive: true` puts the joint on the clockwise side of the line from chain start to target, so the child
  turns counter-clockwise relative to the parent. Flip it to mirror the elbow/knee.
- `mix` 0..1 blends from the animated (FK) pose to the IK solution. Use `mix: 0` keys to animate a chain by
  rotation (FK) in some animations and by target (IK) in others.
- The target must not be in or below the chain; usually it is a child of the root, so animating the body leaves
  hands/feet planted. Children of the target (for example a foot) follow it.
- The **setup pose used for skinning ignores IK**; rendering, validation and sheets apply it.
- Animation timelines: `"ik": { "leg_l_ik": { "mix": [{ "t": 0, "v": 1 }], "bendPositive": [{ "t": 0, "v": false }] } }`
  (`bendPositive` keys are stepped).

### Spine constraints (transforms, paths, spinePhysics, sliders) and skins

Spine models are updated like the Spine 4.3 runtime (`src/core/spine.ts`): bone inherit modes, then the constraints
in `constraintOrder` (entries `"<kind>:<id>"`, kind `ik` / `transform` / `path` / `physics` / `slider`; ids are
unique per kind), each after the bones it reads, with the bones it changes updated again after it. Checked against
the official runtime: the Spine examples pose within about 0.05 units.

- **ik** (see above) also takes Spine's `softness` (two-bone chains straighten softly this far before full
  reach), `compress` / `stretch` (the chain scales to reach), `scaleY` (`uniform` / `volume`: what stretching does
  to scaleY) and `skin: true`. Timelines: `mix`, `softness`, `bendPositive`, `compress`, `stretch`.
- **transforms**: `{ "id", "source", "bones", "properties": [{ "from": "rotate", "offset"?, "to": [{ "property":
  "rotate", "offset"?, "max"?, "scale"? }] }], "mix": { "rotate": 1 }, "offset"?: { "x": 10 }, "localSource"?,
  "localTarget"?, "additive"?, "clamp"? }` — properties `rotate x y scaleX scaleY shearY`; each target value is
  `to.offset + (source value + offset - from.offset) * to.scale` (clamped between `to.offset` and `to.max` with
  `clamp`), blended in by the mix of the written property (other values than 0..1 allowed). World values unless
  `localSource` / `localTarget`; `additive` adds instead of replacing. Timeline channels: the six mixes.
- **paths**: `{ "id", "bones", "slot", "positionMode": "percent"|"fixed", "spacingMode": "length"|"fixed"|"percent"|
  "proportional", "rotateMode": "tangent"|"chain"|"chainScale", "rotation"?, "position", "spacing", "mix": {
  "rotate", "x", "y" } }` — the bones are placed along the path attachment the slot shows. **pathAttachments**:
  `{ "vertices": [...], "weights": [...], "closed"?, "constantSpeed"?, "lengths": [...] }` (3 vertices per point:
  in handle, point, out handle; setup world space; never drawn). Timeline channels: `position spacing rotate x y`.
- **clippings** (clipping attachments): `{ "<id>": { "vertices": [...], "weights": [...], "end"?: "slotId",
  "convex"?, "inverse"?, "color"? } }` — a slot showing one (its `attachment` key is the id, or a skin placeholder
  mapping to it) clips the slots after it in draw order up to and including `end` (absent: all the rest): they are
  drawn only inside the polygon (setup world space, weighted like mesh vertices, deform keys allowed), or only
  outside it with `inverse`; `convex` / `inverse` use the polygon's convex hull. One clipping at a time (a second one
  inside the range is ignored), like the Spine runtime. Never drawn itself (the editor outlines it, dashed).
- **boundingBoxes** (bounding box attachments): `{ "<id>": { "vertices": [...], "weights": [...], "color"? } }` — a
  polygon games test hits against (Spine's SkeletonBounds) while a slot shows it; setup world space, weighted like
  mesh vertices, deform keys allowed. Never drawn (the editor outlines it, dashed, in its color).
- **spinePhysics** (Spine 4.2+ physics; `physics` is Awaken2D's spring bones): `{ "id", "bone", "x"?, "y"?,
  "rotate"?, "scaleX"?, "shearX"? (how much of each is simulated), "scaleY"?, "limit"? (5000), "fps"? (60),
  "inertia", "strength", "damping", "mass", "wind", "gravity", "mix", "global"?: [settings changed by the ""
  timelines] }`. Simulated from the start of playback (PoseSimulator: the editor and sheets), and live in the editor
  outside playback (setup pose or paused: moving bones makes it swing, like in Spine); a plain computePose has no
  physics. `referenceScale` (top level, default 100) scales wind and gravity. Timeline channels: the settings, and
  `reset` (a list of times at which the simulation restarts).
- **sliders** (Spine 4.3): `{ "id", "animation", "time", "mix", "additive"?, "loop"?, "bone"?, "property"?,
  "local"?, "from"?, "to"?, "scale"?, "max"? }` — poses the animation at `time` (or `to + (bone property - from) *
  scale` when a bone drives it), mixed by `mix` (bones, slot colors / attachments, deform keys). Channels `time mix`.
- **skins**: `{ "<name>": { "attachments": { "<slot>": { "<placeholder>": "<attachment id>" } }, "bones"?: [...],
  "constraints"?: ["<kind>:<id>"] } }`, active one in `skin`. A slot's attachment (setup and keys) is an attachment
  id or a placeholder: the active skin's attachment for it, else the id itself (the default skin). Skin bones and
  constraints (`skin: true`) are on only while their skin is active.

Animation timelines: `"transforms": { "<id>": { "rotate": [keys], ... } }`, `"paths"`, `"spinePhysics"` (`""` for the
global settings), `"sliders"`; bone timelines also take `inherit` (stepped) and single-axis `translateX translateY
scaleX scaleY shearX shearY` tracks, which replace that axis (imported Spine data keeps them when the axes are keyed
at different times). Bezier eases on Spine models are sampled like the runtime (10 straight segments).

### physics (spring bones)

Only for models without a target: neither Spine nor Live2D export spring bones (Spine and Live2D models refuse
`addPhysics` / `updatePhysics` / `removePhysics` / `setPhysicsKeys`).

```json
"physics": [
  { "id": "tail_spring", "bones": ["tail_1", "tail_2", "tail_3"], "frequency": 2.5, "damping": 0.35,
    "gravity": [0, -1500], "inertia": 1, "mix": 1, "limit": 60 }
]
```
- Each listed bone's tip is a point mass on a damped spring pulled toward the animated pose (after IK).
  The bone keeps its length and only rotates; children follow their simulated parent.
- `frequency` Hz (stiffness: 1 = floppy, 5 = snappy), `damping` ratio (0 = wobbles long, 1 = no overshoot),
  `gravity` world units/s² (0 by default; droop ≈ gravity / (2π·frequency)² units), `inertia` 0..1 (1 = lags
  fully behind parent motion, 0 = carried along), `mix` 0..1, `limit` max degrees away from the animated angle
  (0 = unlimited). Defaults: 2 Hz, 0.3, [0, 0], 1, 1, 0.
- Deterministic: simulated at 120 Hz from the start of the animation after 1.5 s of settling in the first frame's
  pose (so gravity sag is at rest); looping animations run 2 warm-up loops first. The same model, animation and
  time always give the same pose. The skinning setup pose ignores physics; renders, sheets and validation apply it
  (`--no-physics` / MCP `physics: false` to compare).
- Animation timelines: `"physics": { "tail_spring": { "mix": [...], "force": [{ "t": 0, "v": [800, 0] }] } }`
  (`force` is added to gravity, e.g. wind gusts).
- Spring bones need length > 0 and a bone may belong to only one physics constraint. Use `addBoneChain` to make a
  multi-segment chain for hair, tails, ribbons, then `autoWeight` the mesh to those bones.

### parameters and warps (Live2D-style deformation)

A **parameter** is a named knob with a range. Everything it drives is stored on it, keyed by parameter value
(`at`), linear in between and clamped at the ends. Effects of different parameters add up.

```json
"parameters": [
  { "id": "EyeOpen", "min": 0, "max": 1, "default": 1,
    "meshes": { "eye_L": [{ "at": 0, "v": [[0, 0.4, 9.1], [3, -0.4, -9.2]] }, { "at": 1, "v": [] }] } },
  { "id": "AngleX", "min": -30, "max": 30, "default": 0,
    "warps": { "face": [{ "at": -30, "v": [[0, 0], ...] }, { "at": 30, "v": [...] }] },
    "bones": { "head": { "rotate": [{ "at": -30, "v": -4 }, { "at": 30, "v": 4 }] } } }
],
"warps": [
  { "id": "face", "rect": { "x": -70, "y": 420, "width": 150, "height": 160 }, "cols": 4, "rows": 4,
    "targets": ["head", "hair", "eye_L", "eye_R", "mouth"] }
]
```
- `bones`: rotate/translate add to the pose, scale multiplies (like a Live2D rotation deformer).
- `slots`: `color` tints multiply; `attachment` switches (the last key with `at` <= value wins).
- `meshes`: blend shapes, sparse `[vertexIndex, dx, dy]` offsets in setup space.
- `warps`: one `[dx, dy]` per lattice control point, `(cols+1)*(rows+1)` points, row-major from the bottom row.
- A **warp** is a lattice over a setup-space rectangle; moving its control points bends every target mesh
  (bilinear per cell; points outside the rect take the edge displacement). Warps apply in array order, so a
  second, smaller warp on the eyes and mouth on top of a face warp gives parallax.
- Geometry order: blend shapes, then warps, then skinning. So a head warp deforms the face in its rest pose and
  the head bone then carries the result, like a warp deformer under a rotation deformer in Live2D.
- Animations key parameters over time: `"params": { "MouthOpen": [{ "t": 0, "v": 0 }, { "t": 0.2, "v": 1 }] }`.
  Values: explicit override (render `--param`, editor sliders) > animation track > default.
- The raw setup pose (skinning bind pose) ignores parameters; renders, sheets, validation and the editor apply them.

### combos (combination keyforms)

Some shapes depend on two or three parameters **together** (Live2D's multi-parameter keys): the head turned right
*and* up is not just "right" + "up", an open mouth that also smiles is wider than both. A **combo** is a grid
over 2-3 parameters with keyforms at chosen grid points:

```json
"combos": [
  { "id": "head_angles", "params": ["AngleX", "AngleY"],
    "keys": [
      { "at": [30, 30], "warps": { "face": [[0, 0], ...] }, "bones": { "head": { "rotate": 2 } } },
      { "at": [-30, 30], "meshes": { "mouth": [[4, 0, 1.5]] } }
    ] }
]
```
- Each axis of the grid is the keyed values plus the parameter's **default**; grid points without a key mean
  "no change". Values in between blend multilinearly (bilinear for two parameters), clamped at the grid edges.
- The result **adds** to each parameter's own effects. So corner keys are corrections that only show when the
  parameters combine: `AngleX = 30` alone looks exactly as before, `AngleX = 30, AngleY = 30` gets the key in
  full, `(15, 15)` gets a quarter of it. (To author the whole shape in the combo instead, leave the single
  parameters unkeyed for that target.)
- Targets: `bones` (rotate/translate add, scale multiplies as 1 + weight*(s-1)), `meshes` (sparse
  `[vertexIndex, dx, dy]`), `warps` (one `[dx, dy]` per control point).
- Check a combo with `rig param-sheet --param A --param2 B`: the grid shows every combination.

### live2d (Live2D Cubism rig)

A Live2D rig keeps Cubism's own structure, so it poses exactly like the Cubism Core and exports back to .moc3.
Everything is a **keyform grid**: an object is bound to parameters (`grid.params`) at key values (`grid.keys`), and
stores one form per grid point (`forms`, the FIRST parameter varying fastest). The current form is the multilinear
blend of the surrounding grid points; values clamp to the keyed range, a value within the parameter's `decimals`
precision of a key sits on it, and an object whose parameter leaves its keyed range is not drawn.

```json
"live2d": {
  "canvas": { "width": 2976, "height": 4175, "originX": 1488, "originY": 2087.5, "pixelsPerUnit": 2976 },
  "parts": [{ "id": "PartFace", "name": "Face", "parent": null, "grid": { "params": [], "keys": [] }, "drawOrders": [500] }],
  "deformers": [
    { "id": "WarpFace", "type": "warp", "parent": null, "part": "PartFace", "cols": 5, "rows": 5, "bilinear": true,
      "grid": { "params": ["ParamAngleX"], "keys": [[-30, 0, 30]] }, "forms": [{ "points": [x, y, ...] }, ...] },
    { "id": "RotHead", "type": "rotation", "parent": "WarpBody", "part": "PartFace", "baseAngle": 0,
      "grid": { "params": ["ParamAngleZ"], "keys": [[-30, 0, 30]] },
      "forms": [{ "x": 0.49, "y": 0.31, "angle": -10, "scale": 0.000336 }, ...] }
  ],
  "glue": [{ "id": "G", "a": "ArmL", "b": "Body", "pairs": [3, 7, 4, 8], "weights": [0.5, 0.5, 0.5, 0.5], "grid": ..., "intensity": [1] }],
  "drawOrderGroups": [{ "min": 0, "max": 1000, "items": [{ "slot": "Body" }, { "part": "PartArm", "group": 1 }] }, ...],
  "physics": { "settings": [...] }, "pose": { "fadeIn": 0.5, "groups": [[{ "part": "PartArmA" }, { "part": "PartArmB" }]] }
}
```
- **Canvas space**: Cubism units (world = unit * pixelsPerUnit), +y **down** like Cubism's data; Awaken2D's world
  (pixels, +y up) is derived from it.
- **Art meshes** are ordinary slots + mesh attachments with an `attachment.live2d` block:
  `{ deformer, part, grid, forms: [{ points, opacity?, drawOrder?, multiply?, screen? }] }`. `points` are x, y per
  vertex in the parent deformer's space. The attachment's `vertices` hold the result at the parameter defaults
  (kept in sync by the ops; not the source). Weights stay on the root bone: bones still work on top.
- **Warp deformer**: children's points are in its 0..1 square (x right, y down); the keyed lattice (`points`,
  (cols+1)*(rows+1) points, row by row from the top) maps them, bilinearly per cell when `bilinear` (else two
  triangles per cell), extrapolated outside. **Rotation deformer**: children's points are in its local frame
  (pixels at the default scale); it rotates by `baseAngle + angle`, scales, reflects and moves to `x, y` in its
  parent's space. Deformers nest; list parents first.
- Opacity, multiply and screen colors multiply down the deformers; parts multiply their own opacity into what they
  hold. Draw order: each draw-order group sorts its items by their current draw order (truncated to whole numbers,
  clamped to min..max), ties keep the list order; a part item draws its own group at its place.
- **Glue** pulls vertex pairs of two meshes together after deforming, by the keyed intensity.
- **physics** (physics3.json): pendulums from input parameters (X, Y, Angle, with weights) to output parameters,
  simulated like the Cubism Framework at 60 fps (or the file's `fps`), before the rig is evaluated. Awaken2D spring
  bones (`physics` at the top level) are a different thing (bones).
- **pose** (pose3.json): in each group one part is shown. Animations key `partOpacity` tracks
  (`"partOpacity": { "PartArmB": [{ "t": 0, "v": 1 }] }`); for grouped parts the keyed values pick the shown
  part and the others fade out over `fadeIn` seconds (Cubism's CubismPose); ungrouped parts take the value as
  their opacity.
- Parameters may carry `name`, `group` (display, from cdi3), `repeat` and `decimals`.

## Edit ops

Send an array; the whole batch is applied atomically. Ids are names as in Spine: any text (any script, spaces, parentheses like `arm(L)`) except control characters, quotes and backslashes, without leading/trailing spaces.

| op | fields |
|----|--------|
| `addBone` | `id`, `parent?` (default: the root), local `x y rotation length scaleX scaleY`, **or** world `start: [x,y]` + `end: [x,y]` (sets position, rotation and length) |
| `updateBone` | `id`, any of the addBone fields; `parent` re-parents keeping the world transform; `carry: true` moves the meshes bound to the bone and its descendants along with the setup change (default: art stays, i.e. re-binding); Spine's `inherit?` and `skin?` |
| `removeBone` | `id` (fails while it has children, slots, or weights) |
| `renameBone` / `renameSlot` | `id`, `to` — every reference (children, slots, weights, animations, IK, springs, parameters, clips) follows |
| `addSlot` | `id`, `bone`, `attachment?`, `color?`, `index?` (draw position; default front) |
| `updateSlot` | `id`, `bone?`, `attachment?` (null hides), `color?`, `blend?`, `clip?`, `dark?` (Spine two-color tint `#rrggbb`, null removes) |
| `removeSlot` / `moveSlot` | `id` / `id`, `index` |
| `addImage` | `id`, `path` (PNG, relative to the model file) |
| `addMesh` | `id`, `shape`, `color?`, `image?`, `imageRect?`, `bones?`, `maxInfluences?` (2), `slot?` (default = id; created if missing), `bone?` (slot bone), `index?` |
| `moveVertices` | `attachment`, `moves` [[index, x, y], ...] (absolute setup positions), `keepImage?` (default true: UVs follow so the texture stays put; false: the texture stretches) |
| `addVertex` | `attachment`, `at` [x, y] inside the mesh — splits the triangle (two on an edge), interpolates weights and UVs; gets the last index |
| `removeVertices` | `attachment`, `indices` — re-triangulates the holes; blend-shape offsets are renumbered |
| `retriangulate` | `attachment` — Delaunay over the current vertices, clipped to the old outline |
| `setMeshGeometry` | `attachment`, `vertices`, `triangles`, `uvs` (required for image meshes), optional `weights` — replaces the mesh; weights (unless given), blend shapes and combo shapes are carried over from the old mesh by position. `rig remesh <model> <attachment...|--all> --spacing PX` builds one from the image alpha (as the importer does); `--trace [--detail N --concavity 0-100 --padding PX --interior PX]` builds Spine-style: an outline of about N vertices traced around the art, inner vertices every PX image pixels; `--auto [standard|deformation-small|deformation-large]` Cubism-style (outline, inner ring, inner points; on a shared texture page the lengths are pixels of a 1024 texture); `--plan [--mesh-role R] [--mesh-density K]` the importer's automatic mesh (settings from the art and the names). On Live2D art meshes every keyform follows the new vertices |
| `adjustWeights` | `attachment`, `mode` (`set`/`add`/`multiply`/`smooth`), `bone` (not for smooth), `value`, and `vertices` [indices] or `region` {center, radius, falloff?} (default: all). Other bones keep their proportions |
| `autoWeight` | `attachment`, `bones`, `maxInfluences?` (2), `power?` (3) |
| `setWeights` | `attachment`, `weights` (one list per vertex) |
| `removeAttachment` | `id` |
| `setAnimation` | `name`, `duration`, `loop?` — creates or updates |
| `removeAnimation` / `renameAnimation` | `name` / `name`, `to` |
| `setKeys` | `animation`, `bone`, `channel` (`rotate`/`translate`/`scale`/`shear`, single-axis `translateX`... `shearY`, or `inherit` with stepped mode names), `keys`, `mode?` (`replace` default, or `merge`), `space?` (`local` default; `world` = translate values are world positions, rotate values world angles, converted using the parent's animated pose) |
| `setSlotKeys` | `animation`, `slot`, `channel` (`attachment`/`color`/`dark`), `keys`, `mode?` |
| `setDeformKeys` | `animation`, `attachment`, `keys` [{`t`, `offsets?` [[vertex, dx, dy]], `transform?` (as setParamShape), `ease?`}], `mode` replace/merge — mesh deformation over time (setup-space offsets) |
| `setEvent` | `name`, optional `int` `float` `string` `audio` `volume` `balance` defaults; `remove: true` deletes it (and its keys) |
| `setEventKeys` | `animation`, `keys` [{`t`, `name`, `int?` ...}], `mode` replace/merge |
| `setKeyform` | `target` (Live2D art mesh / deformer / part / glue id), `at?` {param: value} (a grid point; missing params use their defaults), `moves?` [[i, x, y]] world positions or `offsets?` [[i, dx, dy]] world offsets (mesh vertices, warp lattice points), `origin?` [x, y] world / `angle?` / `scale?` / `reflectX?` / `reflectY?` (rotation deformer), `opacity?`, `drawOrder?`, `multiply?` / `screen?` [r, g, b] or null, `intensity?` (glue) — edits one keyform; world input goes through the parent's inverse mapping at that keyform's parameter values |
| `setKeyformKeys` | `target`, `param`, `keys` [values] or null — keys an object on a parameter (adds the axis, adds/moves keys) or unbinds it (null); the forms are resampled from the old grid, so the look does not change |
| `addDeformer` | `id`, `type` warp/rotation, `parent?`, `part?`, warp: `rect?` {x, y, width, height} world, `cols?`/`rows?` (3), `bilinear?` (true); rotation: `origin?` [x, y] world, `baseAngle?`; `children?` [art meshes / deformers] moved under it keeping their look (exact at their keyforms) |
| `updateDeformer` | `id`, `parent?` (re-expresses it, keeping its look), `part?`, `bilinear?`, `hidden?`, `disabled?` |
| `removeDeformer` | `id` — its children move to its parent, keeping their look |
| `setLive2DMesh` | `attachment`, `deformer?` (re-expresses its keyforms), `part?`, `hidden?`, `disabled?` — also turns a plain mesh into a Live2D art mesh |
| `addPart` / `updatePart` / `removePart` | `id`, `parent?`, `name?`, `visible?` (`disabled?` on update); removal moves contents to the parent part |
| `enableLive2D` | `canvas?`, `attachments?` (default all) — creates a Live2D rig (canvas from the meshes' bounds) and turns meshes into art meshes with one keyform |
| `setPartOpacityKeys` | `animation`, `part`, `keys` [{t, v 0..1, ease?}], `mode` replace/merge |
| `setDrawOrderKeys` | `animation`, `keys`: [{ `t`, `offsets`: [[slotId, offset], ...] }], `mode` replace/merge. Stepped draw-order changes (Spine-style): each listed slot moves `offset` places from its setup draw order (positive = toward the front); the others keep their order. Use it for a hand passing in front of the body or face. `keys: []` with replace clears it |
| `clearKeys` | `animation`, optional `bone`, `slot` or `ik`, optional `channel` |
| `addIk` | `id`, `bones` (1 or 2), `target?` (omit to create bone `<id>_target` at the chain tip), `targetParent?` (root), `targetPosition?` (world), `bendPositive?` (default: keeps the current bend), `mix?` (1) |
| `updateIk` | `id`, `bones?`, `target?`, `bendPositive?`, `mix?`, Spine's `softness?`, `compress?`, `stretch?`, `scaleY?` (`uniform`/`volume`/`none`), `skin?` |
| `removeIk` / `moveIk` | `id`, `removeTarget?` / `id`, `index` (evaluation order) |
| `setIkKeys` | `animation`, `ik`, `channel` (`mix`/`bendPositive`/`softness`/`compress`/`stretch`), `keys`, `mode?` |
| `setConstraint` | `kind` (`transform`/`path`/`physics`/`slider`), `constraint` (the full definition, see "Spine constraints") — adds it, or replaces the one with that id |
| `updateConstraint` | `kind`, `id`, `set` {field: value} (null removes an optional field) |
| `removeConstraint` | `kind`, `id` — also drops it from the order, the skins and the animations |
| `setConstraintOrder` | `order` ["ik:leg", "transform:follow", ...] — the evaluation order (unlisted ones follow) |
| `setConstraintKeys` | `animation`, `kind`, `constraint` (physics: `""` = the global settings), `channel` (transform: `rotate x y scaleX scaleY shearY` mixes; path: `position spacing rotate x y`; physics: `inertia strength damping mass wind gravity mix`, or `reset` with keys [{t}]; slider: `time mix`), `keys`, `mode?` |
| `setSkin` | `name` (null: default attachments only) — the active skin |
| `addSkin` / `removeSkin` / `renameSkin` | `name`, `copyOf?` / `name` / `name`, `to` |
| `setSkinAttachment` | `skin`, `slot`, `placeholder`, `attachment` (id; null removes) — what the slot shows for that placeholder in the skin |
| `setSkinBones` | `skin`, `bones?`, `constraints?` ["<kind>:<id>"] — the skin-only bones and constraints the skin turns on |
| `updateBoundingBox` | `id` (a `boundingBoxes` entry), `color?` (null: Spine's default), `vertices?` (new polygon, setup world space; its deform keys are dropped when the vertex count changes), `weights?` (per vertex; default: each vertex takes the nearest old vertex's weights) |
| `updateClipping` | `id` (a `clippings` entry), `end?` (slot; null: to the end of the draw order), `convex?`, `inverse?` |
| `addBoneChain` | `id`, `parent?` (root), world `start`, `end`, `count` — creates `<id>_1 .. <id>_<count>` |
| `addPhysics` | `id`, `bones`, `frequency?`, `damping?`, `gravity?`, `inertia?`, `mix?`, `limit?` |
| `updatePhysics` / `removePhysics` | `id` + any addPhysics field / `id` |
| `addParameter` / `updateParameter` / `removeParameter` | `id`, `min`, `max`, `default?` / `id` + any of those; both take `name?` / `group?` (display; null clears on update), `decimals?` (0..10), `repeat?` / `id` |
| `renameParameter` | `id`, `to` — renames it everywhere: keyform grids, animation tracks, physics, combos, Live2D groups |
| `setParamBoneKeys` | `parameter`, `bone`, `channel` (`rotate`/`translate`/`scale`), `keys` [{`at`, `v`}], `mode?` (`merge` default) |
| `setParamSlotKeys` | `parameter`, `slot`, `channel` (`color`/`attachment`), `keys`, `mode?` |
| `setParamShape` | `parameter`, `attachment`, `keys` [{`at`, `offsets?`, `transform?`}] — `transform`: `{scale, rotate, translate, pivot?, falloff?: {center?, radius}, only?}` applied to the mesh's setup vertices (e.g. close an eye: `{"scale": [1, 0.1]}`) |
| `addWarp` / `updateWarp` / `removeWarp` | `id`, `targets`, `rect?` (default: target bounds + `padding` 0.1), `cols?` 4, `rows?` 4 / `id`, `targets` / `id` |
| `setParamWarp` | `parameter`, `warp`, `keys` [{`at`, `preset?` + `amount?`, `presets?` [...], `offsets?`, `transform?`}] — presets: `turnX`, `turnY` (amount = bulge as a fraction of width/height, e.g. 0.12), `shearX`, `shearY`, `scale`, `scaleX`, `scaleY` (factor - 1), `translateX`, `translateY` (units) |
| `clearParamKeys` | `parameter`, optional `bone`, `slot`, `attachment` or `warp` |
| `addCombo` | `id`, `params`: 2-3 parameter ids — a combination keyform grid (see combos) |
| `setComboKey` | `combo`, `at`: one value per parameter, any of `bones` {bone: {rotate?, translate?, scale?}}, `meshes` {attachment: {offsets?, transform?}} (as setParamShape), `warps` {warp: {preset?+amount?, presets?, offsets?, transform?}} (as setParamWarp); `mode` merge (default: replaces only the given targets) / replace |
| `removeComboKey` | `combo`, `at` |
| `removeCombo` | `id` |
| `setParamTrack` | `animation`, `parameter`, `keys` [{`t`, `v`, `ease?`}], `mode?` — the parameter's value over time |
| `setPhysicsKeys` | `animation`, `physics`, `channel` (`mix`/`force`), `keys`, `mode?` |
| `setMeta` | `name?`, `meta?` |
| `setTarget` | `target` spine/live2d — gives an older model a target (refused, with the reason, while it holds the other kind's features); to live2d, meshes become art meshes |

`shape` for `addMesh` (world coordinates, setup pose):
- `{ "rect": { "x", "y", "width", "height" }, "cols": 6, "rows": 1 }` — `x,y` is the bottom-left corner. Use several
  cols/rows along the direction the mesh must bend.
- `{ "ellipse": { "cx", "cy", "rx", "ry", "segments?" }, "spacing?" }`
- `{ "polygon": [[x,y], ...], "spacing?" }` — simple polygon, filled with interior points every `spacing` units.

Mesh ops on Live2D art meshes keep every keyform in step: `moveVertices` moves the vertex by the same world offset in
each keyform (the geometry edit; `keepImage` refits the UVs), `addVertex` / `setMeshGeometry` resample the keyforms
through the old triangles (by UV), `removeVertices` drops the vertex from every keyform and glue pair.
`removeParameter` keeps each object's look at the parameter's default.

`bones` on `addMesh` binds with automatic inverse-distance weights to those bones' setup segments (each vertex keeps
the `maxInfluences` nearest). Without `bones` the mesh is rigidly bound to its slot bone.

## Spine interop

`rig spine-import <skeleton.json> <model.rig.json>` (MCP `rig_spine_import`, editor File › Import Spine) reads a Spine
3.8/4.x JSON export (4.3's single typed `constraints` array included) and its atlas (`name.atlas` / `name.atlas.txt`
next to it, else the atlas there holding the most of the skeleton's images, then the one sharing the longest name
start, straight alpha before `-pma`; images missing from it are read from the images folder, looked up next to the
skeleton and one level up, where Spine's project keeps it):
bones (shear, inherit modes, skin bones), slots (color, two-color tint, blend), every skin's region attachments (as
4-vertex meshes), weighted/unweighted meshes, linked meshes, path, clipping and bounding box attachments, the IK / transform / path / physics / slider
constraints in their order, events, and bone / slot color+attachment / deform / draw-order / event / constraint
timelines (`rgba2` / `rgb2` as color + dark keys) with Spine's bezier curves (per channel; x / y timelines keyed at different times stay separate tracks; a
curve bulging between two equal values gets an extra key at its middle, exported back as written while unedited).
Poses match the official Spine 4.3 runtime (physics included) to within about 0.05 units on the Spine examples. Region images are cut out of the atlas (rotation 90 /
180 / 270, whitespace stripping and premultiplied alpha undone) into `images/`; with polygon packing, mesh images are
cleared outside their mesh (other regions share the rectangle). Event sounds (the event's `audio` path in the
skeleton's `audio` folder, looked up like the images folder) are copied to `audio/<path>` next to the model; the
editor plays them while an animation plays (event volume / balance, a key's own first; 🔊 in the transport mutes).

`--mesh auto` (MCP `mesh: "auto"`, editor checkbox) is opt-in: region attachments become automatic meshes traced
around their art (as for layers above), so they can bend and draw less empty space; they are exported as meshes.
Without it regions stay 4-vertex quads written back exactly.

Kept verbatim in `meta.spine` and written back on export, but not evaluated: point attachments,
sequences (the first image is shown).

`rig spine-export <model.rig.json> <outDir>` (MCP `rig_spine_export`, editor File › Export to Spine) writes
`<name>.json` (Spine 4.x), `<name>.atlas` + `<name>.png` (packed atlas) and `images/<region>.png` (for Spine's Import
Data), plus the event sounds from `audio/` next to the model into `audio/`. Constraints go out as Spine 4.3's `constraints` array (per-kind arrays with `order` for older versions;
sliders need 4.3), skins with their attachments, bones and constraints. Anything unchanged since import is written
exactly as it came; edited meshes are converted to bone-local /
weighted vertices with the hull first, eases to absolute bezier handles, deforms to per-bone deltas. Parameters,
warps, combos (Live2D side), spring bones and slot clip masks have no Spine equivalent and are reported.

## Live2D interop

`rig live2d-import <name.model3.json> <model.rig.json>` (MCP `rig_live2d_import`, editor File › Import Live2D) reads a
Cubism runtime model: the .moc3 (Cubism 3.0-5.0 formats) with its textures, motions (motion3), physics (physics3),
pose groups (pose3), display names (cdi3), groups and hit areas (model3). Checked against the official Cubism Core
and Framework: vertices within 0.02 px, opacities, colors and draw order identical; motion curves (linear, both bezier
interpretations, stepped, inverse stepped, the loop's closing frame), physics and pose fades match frame by frame at
60 fps. Textures are copied to `images/` next to the model. A bare .moc3 imports without motions and physics.

Kept for export but not evaluated: expressions (exp3), "Model" motion curves (eye blink / lip sync / model opacity),
per-motion fade times, user data. Blend-shape parameters (Cubism 4.2+ "blend shapes") are not supported yet.

`rig live2d-export <model.rig.json> <outDir>` (MCP `rig_live2d_export`, editor File › Export to Live2D) writes
`<name>.model3.json`, `.moc3` (the source file's format version, raised when colors or bilinear warps need it),
`.physics3.json`, `.cdi3.json`, `.pose3.json`, `motion/*.motion3.json` and `<name>.textures/` for Cubism SDKs and
viewers (the Cubism Editor itself only opens its .cmo3 projects). An unedited import exports a rig that the Cubism
Core evaluates identically. Meshes without Live2D keyforms become static art meshes; bones, spring bones, Awaken2D
parameter effects (bone keys, blend shapes, warps, combos) and bone / slot / deform timelines have no Live2D
counterpart and are reported. `rig spine-export` of a Live2D model crops each mesh's part of the texture pages
(parameters and Live2D motions are not exported to Spine).

## Importing layered art

`rig import <art> <model.rig.json>` / MCP `rig_import` accepts:
- **PSD/PSB** (RGB or grayscale, 8/16-bit, raw/RLE/ZIP). Groups become `meta.import.layers[].groups`;
  hidden layers (or layers in hidden groups) are skipped unless `includeHidden` (then their slots start empty).
  Layer opacity becomes the slot color alpha; multiply/screen/linear-dodge become slot `blend`. Clipping masks are
  baked: a clipped layer keeps only the pixels where its base layer is opaque, and stays a separate slot so it can be
  reordered. Layer masks and effects are ignored.
- Import options for big PSDs: `resample` (e.g. 0.35 to downscale a 6000px file), `skip` (regex over
  `group/.../name`), and `spacing` as a function of the layer for dense face meshes and coarse body meshes.
- **A single PNG**, or **a folder of PNGs**: back to front in natural filename order (a leading number like `03_`
  is dropped from the name), each placed at (0, 0). Add `layers.json` to set order and offsets:
  `[{ "file": "arm.png", "name": "arm_l", "x": 120, "y": 40, "groups": ["Arm"], "hidden": false }]`.

Each non-empty layer is cropped to its alpha bounds (plus 3 transparent pixels of room) and saved as
`images/<slot>.png`. Its mesh is automatic (`src/core/meshplan.ts`): the art is measured (size, outline length,
elongation along its main axis, separate pieces) and given a role, from its own name first, then its shape, then its
group names (English words, Japanese / Korean anywhere in the name):
- `rigid`: small art (under ~40 px), pupils, highlights, buttons, badges, stars: an outline only (4-12 vertices);
- `flexible`: hair, bangs, tails, skirts, cloth, ribbons, wings, arms, legs, torso, neck, mouth, brows, and anything
  3× longer than wide: dense, with at least 8 steps along its length;
- `standard` otherwise (also hands, feet, head, face): outline, an inner ring and a few interior points.
The role and size give a vertex budget (Live2D models 1.25×); Cubism-style automatic mesh settings (outline and
interior spacing, margins) are tuned until the count is near it, then the mesh is checked: every opaque pixel must be
inside it (alpha-weighted coverage ≥ 99.9%, else a denser outline / wider margins, and a grid as the last resort).
Pieces far apart are meshed separately (no triangles across the gap). The import log and `meta.import.layers[].mesh`
say which role each layer got and why; `--mesh-role NAME=rigid|standard|flexible` (MCP `meshRoles`) overrides it,
`--mesh-density K` scales every budget, and `rig remesh --plan` (editor: Mesh mode › Auto…, Live2D generator preset
"Automatic") redoes one mesh. `--mesh grid` (or `--spacing PX`) gives the older grid mesh instead: cells of
`spacing` px containing solid pixels.
Pixels map to world as `x = (px - originX) * scale`, `y = (originY - py) * scale`; the default origin is the
bottom-center of the visible art, so the character stands on y = 0.

Everything starts bound to `root`. `rig propose` / MCP `rig_propose_bones` then suggests a skeleton:
- roles from layer names (then group names), English or Korean: head/머리/얼굴, torso/body/몸, hip/pelvis/골반,
  upper arm/상완, forearm/전완, hand/손, thigh/허벅지, shin/종아리, foot/발, arm/팔, leg/다리, eye/눈, mouth/입,
  hair/머리카락, tail/꼬리; sides from `L`/`R`/`left`/`right`/왼/오른, else from position (+x = character's left)
- torso, hip, head: vertical bones through the layer; limbs: bones along the layer's principal axis starting at the
  end nearest the parent; a single-layer arm or leg gets two bones with blended weights
- face parts and hair ride on the head bone; other elongated layers get a bone attached where they meet the
  nearest bone; compact unknown layers ride on the nearest bone
- with `ik` (`--ik`, MCP `ik: true`): two-bone IK on every arm and leg, targets at wrists/ankles, joints bending
  outward, and feet re-parented to their leg target so they stay level
- with `physics` (`--physics`, MCP `physics: true`; models without a target only): tails and other dangling
  elongated layers become 3-bone chains with a spring (2.5 Hz, damping 0.35, limit 60°, no gravity until you add it)
The result is a list of ordinary ops plus a report. Review it (render with `bones,names` overlays) and fix names,
parents or positions with `updateBone`, `updateSlot`, `autoWeight` as needed.

## Workflow for agents

0. Decide (ask the user when unsure) whether the model is for **Spine2D** or **Live2D**: `rig_new` / `rig_import` need
   `target`. Steps 1-7 are the Spine workflow; for Live2D: import the layers with `target: "live2d"`, `addParameter`,
   `addDeformer` (warps over faces / hair, rotation deformers for limbs) with `children`, `setKeyformKeys` +
   `setKeyform` for each keyed shape, `setParamTrack` for motion, then `rig_live2d_export`.
1. `rig_import` layered art with `propose: true` (or `rig_new` for a model built from shapes), then check the preview.
   Otherwise `rig_apply` bones with world `start`/`end` (easiest to reason about).
2. `rig_apply` meshes with `bones` for auto weights; bendable limbs need `cols`/`rows` > 1 along their length.
3. `rig_render` with `overlay: ["bones","names","mesh"]` to check placement.
4. `setAnimation` + `setKeys`, then `rig_sheet` to see motion, `rig_validate` to catch folding triangles.
5. For limbs prefer IK: `addIk` on each arm/leg, then key the targets with `setKeys` `space: "world"` (hand/foot
   positions) and move the hip; knees and elbows follow. Feet stay planted unless their target moves.
6. Faces: bones for the face parts (eyes, mouth, brows) weighted on a dense head mesh, deform keys
   (`setDeformKeys`) for shapes like blinks, attachment keys (`setSlotKeys` channel `attachment`) for swaps.
7. Secondary motion (hair, tails, ears, ribbons): short bone chains with offset rotation keys (overlapping action).
   (Spring bones, Awaken2D parameters, warps and combos exist only for models without a target: neither export has them.)
