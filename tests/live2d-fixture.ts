// A small synthetic Live2D rig covering what the evaluator and the moc3 writer handle: nested warp and rotation
// deformers (bilinear and triangle warps, reflection), keyforms over one and two parameters, opacity and colors,
// glue, parts, masks and a part draw-order group. Checked against the official Cubism Core with the local tools.
import { FORMAT_ID } from "../src/core/types.ts";
import type { Model } from "../src/core/types.ts";

const quad = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s];

export function live2dRig(): Model {
  return {
    format: FORMAT_ID,
    name: "l2d",
    target: "live2d",
    images: { tex: { path: "tex.png" } },
    bones: [{ id: "root", parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 }],
    slots: [
      { id: "body", bone: "root", attachment: "body", color: "#ffffff" },
      { id: "arm", bone: "root", attachment: "arm", color: "#ffffff", cull: true },
      { id: "eye", bone: "root", attachment: "eye", color: "#ffffff", clip: "body" },
      { id: "glow", bone: "root", attachment: "glow", color: "#ffffff", blend: "additive" },
    ],
    attachments: {
      body: mesh("body", { deformer: "W_body", part: "P_body", grid: { params: ["AngleX"], keys: [[-30, 0, 30]] } }, [quad(0.2, 0.2, 0.6), quad(0.25, 0.2, 0.6), quad(0.3, 0.2, 0.6)], [600, 600, 600]),
      arm: mesh("arm", { deformer: "R_arm", part: "P_body", grid: { params: ["Arm"], keys: [[-1, 1]] } }, [quad(-40, -10, 80), quad(-30, -20, 80)], [650, 650]),
      eye: mesh(
        "eye",
        { deformer: "W_face", part: "P_face", grid: { params: ["AngleX", "Eye"], keys: [[-30, 30], [0, 1]] } },
        [quad(0.4, 0.4, 0.2), quad(0.45, 0.4, 0.2), quad(0.4, 0.48, 0.2), quad(0.45, 0.48, 0.2)],
        [700, 700, 700, 700],
        [undefined, undefined, 0, 1],
      ),
      glow: mesh("glow", { deformer: null, part: null, grid: { params: [], keys: [] } }, [quad(-0.1, -0.1, 0.2)], [900], [0.5], true),
    },
    animations: {},
    parameters: [
      { id: "AngleX", min: -30, max: 30, default: 0, decimals: 3, name: "Angle X" },
      { id: "Eye", min: 0, max: 1, default: 1, decimals: 3 },
      { id: "Arm", min: -1, max: 1, default: 0, decimals: 3 },
    ],
    live2d: {
      canvas: { width: 1000, height: 1000, originX: 500, originY: 500, pixelsPerUnit: 1000 },
      parts: [
        { id: "P_body", parent: null, grid: { params: [], keys: [] }, drawOrders: [500] },
        { id: "P_face", parent: "P_body", grid: { params: [], keys: [] }, drawOrders: [500], name: "Face" },
        { id: "P_alt", parent: null, grid: { params: [], keys: [] }, drawOrders: [500] },
      ],
      deformers: [
        {
          id: "W_body",
          type: "warp",
          parent: null,
          part: "P_body",
          cols: 2,
          rows: 2,
          bilinear: true,
          grid: { params: ["AngleX"], keys: [[-30, 30]] },
          forms: [lattice(-0.35, -0.3, 0.6, 2, 2, 0.02), lattice(-0.25, -0.3, 0.6, 2, 2, -0.02)],
        },
        {
          id: "W_face",
          type: "warp",
          parent: "W_body",
          part: "P_face",
          cols: 3,
          rows: 2,
          grid: { params: [], keys: [] },
          forms: [{ points: lattice(0.1, 0.05, 0.8, 3, 2, 0.03).points, opacity: 0.9 }],
        },
        {
          id: "R_arm",
          type: "rotation",
          parent: "W_body",
          part: "P_body",
          baseAngle: 10,
          grid: { params: ["Arm"], keys: [[-1, 0, 1]] },
          forms: [
            { x: 0.8, y: 0.3, angle: -25, scale: 0.001 },
            { x: 0.8, y: 0.3, angle: 0, scale: 0.001, reflectX: true },
            { x: 0.82, y: 0.3, angle: 30, scale: 0.0012 },
          ],
        },
      ],
      glue: [{ id: "G", a: "body", b: "eye", pairs: [0, 0, 1, 1], weights: [0.5, 0.5, 0.3, 0.7], grid: { params: ["Eye"], keys: [[0, 1]] }, intensity: [0, 0.8] }],
      drawOrderGroups: [
        { min: 0, max: 1000, items: [{ slot: "glow" }, { part: "P_body", group: 1 }] },
        { min: 100, max: 900, items: [{ slot: "body" }, { slot: "arm" }, { slot: "eye" }] },
      ],
    },
  };
}

function lattice(x: number, y: number, size: number, cols: number, rows: number, wobble: number): { points: number[] } {
  const points: number[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) points.push(x + (size * i) / cols + wobble * j, y + (size * j) / rows + wobble * i * 0.5);
  }
  return { points };
}

function mesh(
  id: string,
  l: { deformer: string | null; part: string | null; grid: { params: string[]; keys: number[][] } },
  forms: number[][],
  drawOrders: number[],
  opacity: Array<number | undefined> = [],
  colored = false,
) {
  return {
    type: "mesh" as const,
    image: "tex",
    uvs: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as Array<[number, number]>,
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
    ] as Array<[number, number, number]>,
    vertices: [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ] as Array<[number, number]>,
    weights: [0, 1, 2, 3].map(() => [["root", 1]] as Array<[string, number]>),
    live2d: {
      ...l,
      forms: forms.map((points, k) => ({
        points,
        drawOrder: drawOrders[k],
        ...(opacity[k] !== undefined ? { opacity: opacity[k] } : {}),
        ...(colored ? { multiply: [1, 0.8, 0.6] as [number, number, number], screen: [0.1, 0, 0.2] as [number, number, number] } : {}),
      })),
    },
    ...(id === "__" ? {} : {}),
  };
}

/** A motion3.json with every segment kind (linear, Cardano bezier, a flat bezier bulge, stepped, inverse stepped). */
export function motion3(restricted = false) {
  return {
    Version: 3,
    Meta: { Duration: 2, Fps: 30, Loop: true, AreBeziersRestricted: restricted, CurveCount: 4, TotalSegmentCount: 12, TotalPointCount: 20, UserDataCount: 1, TotalUserDataSize: 5 },
    Curves: [
      { Target: "Parameter", Id: "AngleX", Segments: [0, -10, 1, 0.3, -10, 0.5, 20, 1, 20, 1, 1.2, 20, 1.4, 5, 1.6, 20, 0, 1.9, -5] },
      { Target: "Parameter", Id: "Eye", Segments: [0, 1, 2, 0.5, 0, 3, 1, 1, 0, 1.5, 1] },
      { Target: "PartOpacity", Id: "P_face", Segments: [0, 1, 2, 0.8, 0, 2, 1.4, 1, 0, 2, 1] },
      { Target: "PartOpacity", Id: "P_alt", Segments: [0, 0, 2, 0.8, 1, 2, 1.4, 0, 0, 2, 0] },
    ],
    UserData: [{ Time: 0.5, Value: "blink" }],
  };
}

export function physics3() {
  return {
    Version: 3,
    Meta: { PhysicsSettingCount: 1, TotalInputCount: 1, TotalOutputCount: 1, VertexCount: 2, EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } }, PhysicsDictionary: [{ Id: "S1", Name: "Arm swing" }] },
    PhysicsSettings: [
      {
        Id: "S1",
        Input: [{ Source: { Target: "Parameter", Id: "AngleX" }, Weight: 100, Type: "X", Reflect: false }],
        Output: [{ Destination: { Target: "Parameter", Id: "Arm" }, VertexIndex: 1, Scale: 1, Weight: 100, Type: "Angle", Reflect: false }],
        Vertices: [
          { Position: { X: 0, Y: 0 }, Mobility: 1, Delay: 1, Acceleration: 1, Radius: 0 },
          { Position: { X: 0, Y: 10 }, Mobility: 0.9, Delay: 0.8, Acceleration: 1.5, Radius: 10 },
        ],
        Normalization: { Position: { Minimum: -10, Default: 0, Maximum: 10 }, Angle: { Minimum: -10, Default: 0, Maximum: 10 } },
      },
    ],
  };
}

/** Pose groups: the face part and an alternative, switched by the motion's part curves. */
export function pose3() {
  return { Type: "Live2D Pose", FadeInTime: 0.5, Groups: [[{ Id: "P_face", Link: [] }, { Id: "P_alt", Link: [] }]] };
}

/**
 * The fixture rig with blend shapes (Cubism 4.2+) on every kind of object: a blend-shape parameter "Vow" (keys 0, 1)
 * and "Tilt" (keys -1, 0, 1, base in the middle), constraints from "Lim" and "Eye" (the smallest limit applies).
 */
export function live2dBlendRig(): Model {
  const m = live2dRig();
  m.parameters!.push(
    { id: "Vow", min: 0, max: 1, default: 0, decimals: 3, blendShape: { keys: [0, 1], base: 0 } },
    { id: "Tilt", min: -1, max: 1, default: 0, decimals: 3, blendShape: { keys: [-1, 0, 1], base: 1 } },
    { id: "Lim", min: 0, max: 1, default: 0, decimals: 3 },
  );
  const limits = [
    { param: "Lim", values: [[0, 1], [1, 0]] as Array<[number, number]> },
    { param: "Eye", values: [[0, 0.5], [1, 0.8]] as Array<[number, number]> },
  ];
  const rig = m.live2d!;
  m.attachments.glow.live2d!.blendShapes = [
    { param: "Vow", forms: [{ points: [0, 0, 0, 0, 0, 0, 0, 0] }, { points: [0.03, 0, 0, 0, 0, 0.02, -0.01, 0.04], opacity: -0.2, screen: [2, 0.3, 0.1] }], constraints: limits },
  ];
  m.attachments.eye.live2d!.blendShapes = [
    { param: "Tilt", forms: [{ points: [0.02, 0, 0.02, 0, 0.02, 0, 0.02, 0], drawOrder: 50 }, { points: [0, 0, 0, 0, 0, 0, 0, 0] }, { points: [0, 0.03, 0, 0.03, 0, -0.02, 0, 0] }] },
  ];
  const wBody = rig.deformers.find((d) => d.id === "W_body")!;
  if (wBody.type === "warp") {
    const n = (wBody.cols + 1) * (wBody.rows + 1) * 2;
    wBody.blendShapes = [{ param: "Vow", forms: [{ points: new Array(n).fill(0) }, { points: Array.from({ length: n }, (_, k) => (k % 4 === 0 ? 0.02 : 0)), multiply: [-0.3, 0, 0] }], constraints: [limits[0]] }];
  }
  const rArm = rig.deformers.find((d) => d.id === "R_arm")!;
  if (rArm.type === "rotation") {
    rArm.blendShapes = [{ param: "Tilt", forms: [{ x: 0, y: 0, angle: -15, scale: 0 }, { x: 0, y: 0, angle: 0, scale: 0 }, { x: 0.02, y: 0, angle: 20, scale: 0.0002 }] }];
  }
  rig.parts.find((p) => p.id === "P_body")!.blendShapes = [{ param: "Vow", forms: [0, 500] }];
  rig.glue![0].blendShapes = [{ param: "Tilt", forms: [0.3, 0, -0.2] }];
  return m;
}
