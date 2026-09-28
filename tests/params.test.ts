import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOps,
  computePose,
  drawList,
  emptyModel,
  normalizeModel,
  paramValues,
  restVertices,
  samplePoses,
  serializeModel,
  validateModel,
  warpPresetOffsets,
} from "../src/core/index.ts";
import type { Model, Op, Vec2 } from "../src/core/index.ts";

/** A 4x4 "face" rect mesh on a head bone, an "eye" mesh, and a few parameters. */
function face(extra: Op[] = []): Model {
  return applyOps(emptyModel("t"), [
    { op: "addBone", id: "head", start: [0, 0], end: [0, 100] },
    { op: "addMesh", id: "face", shape: { rect: { x: -50, y: 0, width: 100, height: 100 }, cols: 4, rows: 4 }, color: "#f0c0a0", bones: ["head"] },
    { op: "addMesh", id: "eye", shape: { rect: { x: 10, y: 50, width: 20, height: 10 }, cols: 2, rows: 1 }, color: "#000000", bones: ["head"] },
    { op: "addParameter", id: "EyeOpen", min: 0, max: 1, default: 1 },
    { op: "addParameter", id: "AngleX", min: -30, max: 30 },
    { op: "addParameter", id: "AngleZ", min: -30, max: 30 },
    ...extra,
  ]).model;
}

const pose = (m: Model, params: Record<string, number> = {}, anim: string | null = null, t = 0) => computePose(m, anim, t, { params });
const eyeHeight = (m: Model, params: Record<string, number>) => {
  const p = pose(m, params);
  const eye = drawList(m, p, computePose(m)).find((it) => it.slot === "eye")!;
  const ys = eye.positions.map((v) => v[1]);
  return Math.max(...ys) - Math.min(...ys);
};

test("parameter values: override > animation track > default, clamped to range", () => {
  const m = face([
    { op: "setAnimation", name: "a", duration: 1 },
    { op: "setParamTrack", animation: "a", parameter: "AngleX", keys: [{ t: 0, v: -30 }, { t: 1, v: 30 }] },
  ]);
  assert.deepEqual(paramValues(m, undefined, 0), { EyeOpen: 1, AngleX: 0, AngleZ: 0 });
  assert.equal(paramValues(m, m.animations!.a, 0.5).AngleX, 0);
  assert.equal(paramValues(m, m.animations!.a, 0.75).AngleX, 15);
  assert.equal(paramValues(m, m.animations!.a, 0.75, { AngleX: 5 }).AngleX, 5);
  assert.equal(paramValues(m, undefined, 0, { AngleX: 999 }).AngleX, 30);
});

test("setParamShape with a transform closes an eye, interpolating in between", () => {
  const m = face([
    { op: "setParamShape", parameter: "EyeOpen", attachment: "eye", keys: [{ at: 0, transform: { scale: [1, 0.1] } }, { at: 1, offsets: [] }] },
  ]);
  assert.ok(Math.abs(eyeHeight(m, { EyeOpen: 1 }) - 10) < 1e-6);
  assert.ok(Math.abs(eyeHeight(m, { EyeOpen: 0 }) - 1) < 1e-6);
  assert.ok(Math.abs(eyeHeight(m, { EyeOpen: 0.5 }) - 5.5) < 1e-6);
  // the raw bind pose never includes parameters
  assert.equal(drawList(m, computePose(m)).find((it) => it.slot === "eye")!.positions[0][1], 50);
});

test("parameter bone keys rotate bones and add to animation", () => {
  const m = face([{ op: "setParamBoneKeys", parameter: "AngleZ", bone: "head", channel: "rotate", keys: [{ at: -30, v: -20 }, { at: 30, v: 20 }] }]);
  assert.ok(Math.abs(pose(m, { AngleZ: 30 }).byId.get("head")!.rotation - 110) < 1e-9);
  assert.ok(Math.abs(pose(m, { AngleZ: 15 }).byId.get("head")!.rotation - 100) < 1e-9);
});

test("warp presets bend the lattice: turnX moves the middle, not the edges", () => {
  const m = face([
    { op: "addWarp", id: "w", targets: ["face", "eye"], rect: { x: -50, y: 0, width: 100, height: 100 }, cols: 4, rows: 4 },
    { op: "setParamWarp", parameter: "AngleX", warp: "w", keys: [{ at: 0, preset: "turnX", amount: 0 }, { at: 30, preset: "turnX", amount: 0.1 }] },
  ]);
  const warp = m.warps![0];
  const off = warpPresetOffsets(warp, "turnX", 0.1);
  assert.equal(off[0][0], 0); // left edge fixed
  assert.ok(Math.abs(off[2 * 5 + 2][0] - 10) < 1e-9); // centre point moves 10% of width
  const att = m.attachments.face;
  const rest = restVertices(m, "face", att, { AngleX: 30, EyeOpen: 1, AngleZ: 0 });
  const centre = att.vertices.findIndex((v) => v[0] === 0 && v[1] === 50);
  assert.ok(Math.abs(rest[centre][0] - 10) < 1e-6, `centre moved to ${rest[centre]}`);
  const corner = att.vertices.findIndex((v) => v[0] === -50 && v[1] === 0);
  assert.deepEqual(rest[corner], [-50, 0]);
  const half = restVertices(m, "face", att, { AngleX: 15, EyeOpen: 1, AngleZ: 0 });
  assert.ok(Math.abs(half[centre][0] - 5) < 1e-6);
});

test("warps compose with skinning: the warped face still follows the head bone", () => {
  const m = face([
    { op: "addWarp", id: "w", targets: ["face"], cols: 2, rows: 2 },
    { op: "setParamWarp", parameter: "AngleX", warp: "w", keys: [{ at: 30, preset: "translateX", amount: 7 }] },
    { op: "setAnimation", name: "tilt", duration: 1 },
    { op: "setKeys", animation: "tilt", bone: "head", channel: "translate", keys: [{ t: 0, v: [0, 20] }] },
  ]);
  const [p] = samplePoses(m, "tilt", [0], { params: { AngleX: 30 } });
  const item = drawList(m, p, computePose(m)).find((it) => it.slot === "face")!;
  const i = m.attachments.face.vertices.findIndex((v) => v[0] === -50 && v[1] === 0);
  const expected: Vec2 = [-43, 20];
  assert.ok(Math.hypot(item.positions[i][0] - expected[0], item.positions[i][1] - expected[1]) < 1e-6, `${item.positions[i]}`);
});

test("param slot keys switch attachments and tint", () => {
  const m = face([
    { op: "addMesh", id: "eye_closed", slot: "eye_tmp", bone: "head", shape: { rect: { x: 10, y: 54, width: 20, height: 2 } }, color: "#000000" },
    { op: "removeSlot", id: "eye_tmp" },
    { op: "setParamSlotKeys", parameter: "EyeOpen", slot: "eye", channel: "attachment", keys: [{ at: 0, v: "eye_closed" }, { at: 0.3, v: "eye" }] },
    { op: "setParamSlotKeys", parameter: "AngleX", slot: "face", channel: "color", keys: [{ at: -30, v: "#ff0000" }, { at: 30, v: "#ffffff" }] },
  ]);
  assert.equal(pose(m, { EyeOpen: 0.2 }).slots.find((s) => s.id === "eye")!.attachment, "eye_closed");
  assert.equal(pose(m, { EyeOpen: 0.5 }).slots.find((s) => s.id === "eye")!.attachment, "eye");
  const c = pose(m, { AngleX: -30 }).slots.find((s) => s.id === "face")!.color;
  assert.deepEqual(c.map((v) => Math.round(v * 255)), [255, 0, 0, 255]);
});

test("ops reject bad parameter data with clear errors", () => {
  const m = face();
  assert.throws(() => applyOps(m, [{ op: "addParameter", id: "X", min: 1, max: 0 }]), /min < max/);
  assert.throws(() => applyOps(m, [{ op: "setParamBoneKeys", parameter: "EyeOpen", bone: "head", channel: "rotate", keys: [{ at: 5, v: 1 }] }]), /outside EyeOpen's range/);
  assert.throws(() => applyOps(m, [{ op: "setParamShape", parameter: "Nope", attachment: "eye", keys: [{ at: 0 }] }]), /unknown parameter "Nope"/);
  assert.throws(() => applyOps(m, [{ op: "addWarp", id: "w", targets: ["face"] }, { op: "setParamWarp", parameter: "AngleX", warp: "w", keys: [{ at: 0, preset: "spin" as never, amount: 1 }] }]), /unknown preset/);
  assert.throws(
    () => applyOps(m, [{ op: "setParamBoneKeys", parameter: "AngleZ", bone: "head", channel: "rotate", keys: [{ at: 0, v: 1 }] }, { op: "removeBone", id: "head" }]),
    /driven by parameters|used by slots/,
  );
});

test("validation and serialization cover parameters and warps", () => {
  const m = face([
    { op: "addWarp", id: "w", targets: ["face"], cols: 2, rows: 2 },
    { op: "setParamWarp", parameter: "AngleX", warp: "w", keys: [{ at: 30, preset: "turnX", amount: 0.1 }] },
    { op: "setParamShape", parameter: "EyeOpen", attachment: "eye", keys: [{ at: 0, transform: { scale: [1, 0.1] } }] },
  ]);
  assert.deepEqual(validateModel(m).filter((i) => i.level === "error"), []);
  const again = normalizeModel(JSON.parse(serializeModel(m)));
  assert.deepEqual(again.parameters, m.parameters);
  assert.deepEqual(again.warps, m.warps);
  const broken = normalizeModel({
    ...JSON.parse(serializeModel(m)),
    parameters: [{ id: "P", min: 0, max: 1, default: 2, warps: { w: [{ at: 0, v: [[0, 0]] }] }, meshes: { eye: [{ at: 0, v: [[99, 1, 1]] }] } }],
  });
  const msgs = validateModel(broken).map((i) => i.message).join("\n");
  assert.match(msgs, /within \[0, 1\]/);
  assert.match(msgs, /9 control-point offsets/);
  assert.match(msgs, /vertexIndex < 6/);
});
