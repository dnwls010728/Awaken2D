import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, computePose, drawList, emptyModel, validateModel, warpOffsets } from "../src/core/index.ts";

function rigged() {
  return applyOps(emptyModel("t"), [
    { op: "addBone", id: "head", start: [0, 0], end: [0, 50] },
    { op: "addMesh", id: "face", shape: { rect: { x: -20, y: 10, width: 40, height: 40 }, cols: 2, rows: 2 }, color: "#ffcc99", bone: "head" },
    { op: "addParameter", id: "AngleX", min: -30, max: 30 },
    { op: "addParameter", id: "AngleY", min: -30, max: 30 },
    { op: "addWarp", id: "w", targets: ["face"], cols: 2, rows: 2 },
    // each parameter on its own moves the face 10 units
    { op: "setParamShape", parameter: "AngleX", attachment: "face", keys: [{ at: -30, transform: { translate: [-10, 0] } }, { at: 0 }, { at: 30, transform: { translate: [10, 0] } }] },
    { op: "setParamShape", parameter: "AngleY", attachment: "face", keys: [{ at: -30, transform: { translate: [0, -10] } }, { at: 0 }, { at: 30, transform: { translate: [0, 10] } }] },
    { op: "addCombo", id: "angles", params: ["AngleX", "AngleY"] },
    // looking up-right together: pull back toward the centre and lift a bit more than the sum
    { op: "setComboKey", combo: "angles", at: [30, 30], meshes: { face: { transform: { translate: [-4, 2] } } }, bones: { head: { rotate: 6 } }, warps: { w: { preset: "translateX", amount: 3 } } },
  ]).model;
}

const firstVertex = (m: ReturnType<typeof rigged>, params: Record<string, number>) => {
  const pose = computePose(m, null, 0, { params });
  return drawList(m, pose, computePose(m))[0].positions[0];
};

test("combo keyforms act only where the parameters combine", () => {
  const m = rigged();
  const base = m.attachments.face.vertices[0];
  const at = (x: number, y: number) => {
    const p = firstVertex(m, { AngleX: x, AngleY: y });
    return [+(p[0] - base[0]).toFixed(3), +(p[1] - base[1]).toFixed(3)];
  };
  assert.deepEqual(at(30, 0), [10, 0], "AngleX alone: only its own shape");
  assert.deepEqual(at(0, 30), [0, 10], "AngleY alone: only its own shape");
  // (30, 30): 10 + 10 from the parameters, plus the combo's own correction (and its warp / head rotation)
  const rest = m.bones.find((b) => b.id === "head")!.rotation;
  const pose = computePose(m, null, 0, { params: { AngleX: 30, AngleY: 30 } });
  assert.ok(Math.abs(pose.byId.get("head")!.rotation - rest - 6) < 1e-9, "combo bone key applies at the corner");
  const half = computePose(m, null, 0, { params: { AngleX: 15, AngleY: 15 } });
  assert.ok(Math.abs(half.byId.get("head")!.rotation - rest - 1.5) < 1e-9, "bilinear: a quarter of the corner key halfway to it");
  const w = m.warps![0];
  assert.equal(warpOffsets(m, w, { AngleX: 30, AngleY: 30 })![0], 3);
  assert.equal(warpOffsets(m, w, { AngleX: 30, AngleY: 0 }), null, "no warp keys reached off the corner");
});

test("combo ops validate input and keep references in sync", () => {
  const m = rigged();
  assert.throws(() => applyOps(m, [{ op: "addCombo", id: "x", params: ["AngleX"] }]), /2 or 3/);
  assert.throws(() => applyOps(m, [{ op: "setComboKey", combo: "angles", at: [99, 0] }]), /outside/);
  assert.throws(() => applyOps(m, [{ op: "removeParameter", id: "AngleX" }]), /removeCombo first/);
  const merged = applyOps(m, [{ op: "setComboKey", combo: "angles", at: [30, 30], bones: { head: { rotate: 2 } } }]).model;
  assert.ok(merged.combos![0].keys[0].meshes?.face, "merge keeps the other targets");
  assert.equal(merged.combos![0].keys[0].bones!.head.rotate, 2);
  const renamed = applyOps(m, [{ op: "renameBone", id: "head", to: "kopf" }]).model;
  assert.ok(renamed.combos![0].keys[0].bones!.kopf);
  const gone = applyOps(m, [{ op: "removeComboKey", combo: "angles", at: [30, 30] }, { op: "removeCombo", id: "angles" }]).model;
  assert.equal(gone.combos, undefined);
  assert.deepEqual(validateModel(m, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
});
