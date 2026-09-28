import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, emptyModel, normalizeModel, serializeModel, validateModel } from "../src/core/index.ts";
import type { Model, Op } from "../src/core/index.ts";

const apply = (m: Model, ops: unknown[]) => applyOps(m, ops as Op[]).model;

test("a Spine model refuses Live2D ops, a Live2D model refuses bones", () => {
  const spine = emptyModel("s", "spine");
  assert.equal(spine.target, "spine");
  const s2 = apply(spine, [
    { op: "addBone", id: "arm", start: [0, 0], end: [40, 0] },
    { op: "addMesh", id: "m", shape: { rect: { x: 0, y: -5, width: 40, height: 10 } }, bones: ["arm"] },
  ]);
  assert.throws(() => apply(s2, [{ op: "addParameter", id: "P", min: 0, max: 1 }]), /for Live2D models/);
  assert.throws(() => apply(s2, [{ op: "enableLive2D" }]), /for Live2D models/);
  assert.throws(() => apply(s2, [{ op: "addCombo", id: "c", params: ["a", "b"] }]), /neither Spine nor Live2D/);

  const l2d = emptyModel("l", "live2d");
  assert.ok(l2d.live2d, "a Live2D model starts with a rig (canvas)");
  assert.throws(() => apply(l2d, [{ op: "addBone", id: "arm", start: [0, 0], end: [40, 0] }]), /for Spine models/);
  assert.throws(() => apply(l2d, [{ op: "addMesh", id: "m", shape: { rect: { x: 0, y: 0, width: 10, height: 10 } }, bones: ["root"] }]), /no bones/);
  const l2 = apply(l2d, [
    { op: "addParameter", id: "P", min: -1, max: 1 },
    { op: "addMesh", id: "m", shape: { rect: { x: 0, y: 0, width: 100, height: 100 } } },
    { op: "addDeformer", id: "W", type: "warp", children: ["m"] },
    { op: "setAnimation", name: "a", duration: 1 },
    { op: "setParamTrack", animation: "a", parameter: "P", keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] },
  ]);
  assert.ok(l2.attachments.m.live2d, "meshes added to a Live2D model are art meshes");
  assert.throws(() => apply(l2, [{ op: "setKeys", animation: "a", bone: "root", channel: "rotate", keys: [{ t: 0, v: 1 }] }]), /for Spine models/);
  assert.throws(() => apply(l2, [{ op: "clearKeys", animation: "a", bone: "root" }]), /Live2D models only have/);
  assert.equal(normalizeModel(JSON.parse(serializeModel(l2))).target, "live2d", "the target is saved");
});

test("setTarget converts an older model when it fits, and says what is in the way otherwise", () => {
  const old = apply(emptyModel("o"), [{ op: "addMesh", id: "m", shape: { rect: { x: 0, y: 0, width: 10, height: 10 } } }]);
  assert.equal(old.target, undefined);
  const l = apply(old, [{ op: "setTarget", target: "live2d" }]);
  assert.equal(l.target, "live2d");
  assert.ok(l.attachments.m.live2d);
  // the canvas fits the art (imported layers can be far bigger than the default canvas)
  const big = apply(emptyModel("b"), [{ op: "addMesh", id: "m", shape: { rect: { x: -1200, y: 0, width: 2400, height: 4000 } } }]);
  const c = apply(big, [{ op: "setTarget", target: "live2d" }]).live2d!.canvas;
  assert.ok(c.width >= 2400 && c.height >= 4000 && c.originX >= 1200 && c.originY >= 4000, JSON.stringify(c));
  const withBones = apply(old, [{ op: "addBone", id: "b", start: [0, 0], end: [10, 0] }]);
  assert.throws(() => apply(withBones, [{ op: "setTarget", target: "live2d" }]), /1 bone\(s\) besides root/);
  assert.throws(() => apply(l, [{ op: "setTarget", target: "spine" }]), /a Live2D rig/);
  // a model that has the other kind's data (e.g. edited by hand) is warned about
  const mixed = { ...l, target: "spine" as const };
  assert.ok(validateModel(mixed, { poseSamples: 0 }).some((i) => i.path === "target"));
});

test("parameter details: names, groups, decimals, repeat, and renaming follows every reference", async () => {
  const { live2dRig, motion3, physics3 } = await import("./live2d-fixture.ts");
  const { applyLive2DJson } = await import("../src/live2d/import.ts");
  const base = live2dRig();
  applyLive2DJson({ model: base, log: [], warnings: [] }, { motions: [{ group: "Idle", index: 0, file: "m", json: motion3() }], physics: physics3() });
  base.target = "live2d";
  const m = apply(base, [
    { op: "updateParameter", id: "AngleX", name: "Angle X", group: "Face", decimals: 2, repeat: true },
    { op: "renameParameter", id: "AngleX", to: "ParamAngleX" },
  ]);
  const p = m.parameters!.find((x) => x.id === "ParamAngleX")!;
  assert.deepEqual([p.name, p.group, p.decimals, p.repeat], ["Angle X", "Face", 2, true]);
  assert.ok(m.attachments.body.live2d!.grid.params.includes("ParamAngleX"));
  assert.ok(m.live2d!.deformers.find((d) => d.id === "W_body")!.grid.params.includes("ParamAngleX"));
  assert.ok(m.animations!.m.params!.ParamAngleX && !m.animations!.m.params!.AngleX);
  assert.equal(m.live2d!.physics!.settings[0].inputs[0].param, "ParamAngleX");
  const cleared = apply(m, [{ op: "updateParameter", id: "ParamAngleX", name: null, group: null, repeat: false }]);
  const q = cleared.parameters!.find((x) => x.id === "ParamAngleX")!;
  assert.deepEqual([q.name, q.group, q.repeat], [undefined, undefined, undefined]);
  // addParameter takes the same details
  const n = apply(m, [{ op: "addParameter", id: "ParamSkirt", min: -1, max: 1, name: "Skirt", group: "Sway", decimals: 1 }]);
  const r = n.parameters!.find((x) => x.id === "ParamSkirt")!;
  assert.deepEqual([r.name, r.group, r.decimals], ["Skirt", "Sway", 1]);
  assert.throws(() => apply(m, [{ op: "renameParameter", id: "ParamAngleX", to: "Eye" }]), /already exists/);
  assert.throws(() => apply(m, [{ op: "updateParameter", id: "Eye", decimals: 1.5 }]), /decimals/);
});

test("spring bones are refused on Spine and Live2D models (neither export has them)", () => {
  for (const target of ["spine", "live2d"] as const) {
    const m = emptyModel("s", target);
    assert.throws(() => applyOps(m, [{ op: "addPhysics", id: "x", bones: ["root"] }]), /spring bones/);
  }
  const spine = applyOps(emptyModel("s", "spine"), [{ op: "setAnimation", name: "a", duration: 1 }]).model;
  assert.throws(() => applyOps(spine, [{ op: "clearKeys", animation: "a", physics: "x" } as never]), /spring/);
});
