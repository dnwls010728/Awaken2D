// Builds examples/mascot/mascot.rig.json purely through edit ops, the same way an agent would.
// Run: npm run example
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, emptyModel, formatIssues, saveModel, validateModel } from "../src/core/index.ts";
import type { Op, Vec2 } from "../src/core/index.ts";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "mascot/mascot.rig.json");

/** Outline of a thick polyline (e.g. a two-segment limb) as a polygon. */
function limb(points: Vec2[], width: number): Vec2[] {
  const h = width / 2;
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    left.push([p[0] + nx * h, p[1] + ny * h]);
    right.push([p[0] - nx * h, p[1] - ny * h]);
  });
  return [...left, ...right.reverse()];
}

const SKIN = "#f2c29b";
const SHIRT = "#4a78c8";
const PANTS = "#3a3f55";

const arm = (side: "l" | "r"): Op[] => {
  const s = side === "l" ? 1 : -1;
  return [
    { op: "addBone", id: `upper_arm_${side}`, parent: "torso", start: [22 * s, 160], end: [44 * s, 122] },
    { op: "addBone", id: `lower_arm_${side}`, parent: `upper_arm_${side}`, start: [44 * s, 122], end: [58 * s, 84] },
    {
      op: "addMesh",
      id: `arm_${side}`,
      shape: { polygon: limb([[20 * s, 166], [44 * s, 122], [60 * s, 78]], 15), spacing: 7 },
      color: SKIN,
      bones: [`upper_arm_${side}`, `lower_arm_${side}`],
      index: side === "r" ? 0 : undefined,
    },
  ];
};

const leg = (side: "l" | "r"): Op[] => {
  const s = side === "l" ? 1 : -1;
  return [
    { op: "addBone", id: `thigh_${side}`, parent: "hip", start: [12 * s, 92], end: [13 * s, 48] },
    { op: "addBone", id: `shin_${side}`, parent: `thigh_${side}`, start: [13 * s, 48], end: [14 * s, 4] },
    {
      op: "addMesh",
      id: `leg_${side}`,
      shape: { polygon: limb([[12 * s, 100], [13 * s, 48], [14 * s, 0]], 17), spacing: 7 },
      color: PANTS,
      bones: [`thigh_${side}`, `shin_${side}`],
    },
  ];
};

const ops: Op[] = [
  { op: "setMeta", name: "mascot", meta: { description: "Demo character built from ops by examples/make-mascot.ts" } },
  { op: "addBone", id: "hip", parent: "root", start: [0, 92], end: [0, 110] },
  { op: "addBone", id: "torso", parent: "hip", start: [0, 110], end: [0, 168] },
  { op: "addBone", id: "head", parent: "torso", start: [0, 170], end: [0, 228] },
  ...arm("r"),
  ...leg("r"),
  ...leg("l"),
  {
    op: "addMesh",
    id: "body",
    shape: { polygon: [[-24, 86], [24, 86], [27, 150], [20, 172], [-20, 172], [-27, 150]], spacing: 8 },
    color: SHIRT,
    bones: ["hip", "torso"],
  },
  { op: "addMesh", id: "head", shape: { ellipse: { cx: 0, cy: 200, rx: 27, ry: 29 }, spacing: 9 }, color: SKIN, bones: ["head"] },
  { op: "addMesh", id: "hair", shape: { polygon: [[-29, 200], [-24, 222], [-8, 232], [10, 231], [26, 220], [29, 202], [16, 214], [-6, 214], [-20, 208]] }, color: "#5a3a22", bones: ["head"] },
  { op: "addMesh", id: "eye_l_open", slot: "eye_l", bone: "head", shape: { ellipse: { cx: 10, cy: 202, rx: 3.5, ry: 5, segments: 12 } }, color: "#222222" },
  { op: "addMesh", id: "eye_l_closed", slot: "eye_l_tmp", bone: "head", shape: { rect: { x: 5.5, y: 200.5, width: 9, height: 2 } }, color: "#222222" },
  { op: "addMesh", id: "eye_r_open", slot: "eye_r", bone: "head", shape: { ellipse: { cx: -10, cy: 202, rx: 3.5, ry: 5, segments: 12 } }, color: "#222222" },
  { op: "addMesh", id: "eye_r_closed", slot: "eye_r_tmp", bone: "head", shape: { rect: { x: -14.5, y: 200.5, width: 9, height: 2 } }, color: "#222222" },
  // closed-eye meshes only live in animations: drop their temporary slots
  { op: "removeSlot", id: "eye_l_tmp" },
  { op: "removeSlot", id: "eye_r_tmp" },
  { op: "addMesh", id: "mouth", bone: "head", shape: { polygon: [[-7, 186], [7, 186], [4, 182], [-4, 182]] }, color: "#b04848" },
  ...arm("l"),

  // idle: breathing, head bob, blink
  { op: "setAnimation", name: "idle", duration: 2, loop: true },
  { op: "setKeys", animation: "idle", bone: "torso", channel: "rotate", keys: [{ t: 0, v: 0, ease: "easeInOut" }, { t: 1, v: 2.5, ease: "easeInOut" }, { t: 2, v: 0 }] },
  { op: "setKeys", animation: "idle", bone: "torso", channel: "scale", keys: [{ t: 0, v: [1, 1], ease: "easeInOut" }, { t: 1, v: [1.02, 1.03], ease: "easeInOut" }, { t: 2, v: [1, 1] }] },
  { op: "setKeys", animation: "idle", bone: "head", channel: "rotate", keys: [{ t: 0, v: 0, ease: "easeInOut" }, { t: 1, v: -5, ease: "easeInOut" }, { t: 2, v: 0 }] },
  { op: "setKeys", animation: "idle", bone: "upper_arm_l", channel: "rotate", keys: [{ t: 0, v: 0, ease: "easeInOut" }, { t: 1, v: 6, ease: "easeInOut" }, { t: 2, v: 0 }] },
  { op: "setKeys", animation: "idle", bone: "upper_arm_r", channel: "rotate", keys: [{ t: 0, v: 0, ease: "easeInOut" }, { t: 1, v: -6, ease: "easeInOut" }, { t: 2, v: 0 }] },
  { op: "setSlotKeys", animation: "idle", slot: "eye_l", channel: "attachment", keys: [{ t: 0, v: "eye_l_open" }, { t: 1.6, v: "eye_l_closed" }, { t: 1.72, v: "eye_l_open" }] },
  { op: "setSlotKeys", animation: "idle", slot: "eye_r", channel: "attachment", keys: [{ t: 0, v: "eye_r_open" }, { t: 1.6, v: "eye_r_closed" }, { t: 1.72, v: "eye_r_open" }] },

  // wave: raise the left arm and swing the forearm
  { op: "setAnimation", name: "wave", duration: 1.2, loop: true },
  { op: "setKeys", animation: "wave", bone: "upper_arm_l", channel: "rotate", keys: [{ t: 0, v: 125 }, { t: 1.2, v: 125 }] },
  { op: "setKeys", animation: "wave", bone: "lower_arm_l", channel: "rotate", keys: [{ t: 0, v: 20, ease: "easeInOut" }, { t: 0.3, v: 55, ease: "easeInOut" }, { t: 0.6, v: 20, ease: "easeInOut" }, { t: 0.9, v: 55, ease: "easeInOut" }, { t: 1.2, v: 20 }] },
  { op: "setKeys", animation: "wave", bone: "head", channel: "rotate", keys: [{ t: 0, v: 6 }, { t: 1.2, v: 6 }] },

  // walk cycle
  { op: "setAnimation", name: "walk", duration: 1, loop: true },
  { op: "setKeys", animation: "walk", bone: "thigh_l", channel: "rotate", keys: [{ t: 0, v: 25, ease: "easeInOut" }, { t: 0.5, v: -25, ease: "easeInOut" }, { t: 1, v: 25 }] },
  { op: "setKeys", animation: "walk", bone: "thigh_r", channel: "rotate", keys: [{ t: 0, v: -25, ease: "easeInOut" }, { t: 0.5, v: 25, ease: "easeInOut" }, { t: 1, v: -25 }] },
  { op: "setKeys", animation: "walk", bone: "shin_l", channel: "rotate", keys: [{ t: 0, v: 0 }, { t: 0.25, v: -10 }, { t: 0.5, v: 0 }, { t: 0.75, v: -45 }, { t: 1, v: 0 }] },
  { op: "setKeys", animation: "walk", bone: "shin_r", channel: "rotate", keys: [{ t: 0, v: 0 }, { t: 0.25, v: -45 }, { t: 0.5, v: 0 }, { t: 0.75, v: -10 }, { t: 1, v: 0 }] },
  { op: "setKeys", animation: "walk", bone: "upper_arm_l", channel: "rotate", keys: [{ t: 0, v: -8, ease: "easeInOut" }, { t: 0.5, v: 8, ease: "easeInOut" }, { t: 1, v: -8 }] },
  { op: "setKeys", animation: "walk", bone: "upper_arm_r", channel: "rotate", keys: [{ t: 0, v: 8, ease: "easeInOut" }, { t: 0.5, v: -8, ease: "easeInOut" }, { t: 1, v: 8 }] },
  { op: "setKeys", animation: "walk", bone: "lower_arm_l", channel: "rotate", keys: [{ t: 0, v: 10 }, { t: 0.5, v: 25 }, { t: 1, v: 10 }] },
  { op: "setKeys", animation: "walk", bone: "lower_arm_r", channel: "rotate", keys: [{ t: 0, v: -25 }, { t: 0.5, v: -10 }, { t: 1, v: -25 }] },
  { op: "setKeys", animation: "walk", bone: "hip", channel: "translate", keys: [{ t: 0, v: [0, 0], ease: "easeOut" }, { t: 0.25, v: [0, 4], ease: "easeIn" }, { t: 0.5, v: [0, 0], ease: "easeOut" }, { t: 0.75, v: [0, 4], ease: "easeIn" }, { t: 1, v: [0, 0] }] },
  { op: "setKeys", animation: "walk", bone: "torso", channel: "rotate", keys: [{ t: 0, v: -4 }, { t: 1, v: -4 }] },
];

const { model, log } = applyOps(emptyModel("mascot"), ops);
mkdirSync(dirname(out), { recursive: true });
saveModel(out, model);
console.log(log.map((l) => "- " + l).join("\n"));
console.log(formatIssues(validateModel(model)));
console.log(`wrote ${out}`);
