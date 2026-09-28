import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, emptyModel, validateModel } from "../src/core/index.ts";

function rigged() {
  return applyOps(emptyModel("t"), [
    { op: "addBone", id: "arm", start: [0, 0], end: [50, 0] },
    { op: "addBone", id: "hand", parent: "arm", start: [50, 0], end: [70, 0] },
    { op: "addMesh", id: "skin", shape: { rect: { x: 0, y: -5, width: 70, height: 10 }, cols: 4 }, color: "#ff0000", bones: ["arm", "hand"] },
    { op: "addMesh", id: "glove", shape: { rect: { x: 50, y: -5, width: 20, height: 10 } }, color: "#00ff00", bone: "hand" },
    { op: "updateSlot", id: "glove", clip: "skin" },
    { op: "addIk", id: "reach", bones: ["arm", "hand"] },
    { op: "setConstraint", kind: "physics", constraint: { id: "wobble", bone: "hand", rotate: 1, inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1 } },
    { op: "setAnimation", name: "a", duration: 1 },
    { op: "setKeys", animation: "a", bone: "arm", channel: "rotate", keys: [{ t: 0, v: 5 }] },
    { op: "setSlotKeys", animation: "a", slot: "skin", channel: "color", keys: [{ t: 0, v: "#ffffff" }] },
  ]).model;
}

test("renameBone updates every reference", () => {
  const m = applyOps(rigged(), [{ op: "renameBone", id: "arm", to: "upper_arm" }]).model;
  const json = JSON.stringify(m);
  assert.ok(!/"arm"/.test(json), "no reference to the old bone id remains");
  assert.equal(m.bones.find((b) => b.id === "hand")!.parent, "upper_arm");
  assert.deepEqual(m.ik![0].bones, ["upper_arm", "hand"]);
  assert.ok(m.animations!.a.bones!.upper_arm);
  assert.equal(m.spinePhysics![0].bone, "hand");
  assert.deepEqual(validateModel(m).filter((i) => i.level === "error"), []);
  assert.throws(() => applyOps(m, [{ op: "renameBone", id: "hand", to: "upper_arm" }]), /already exists/);
});

test("renameSlot updates clips and animations", () => {
  const m = applyOps(rigged(), [{ op: "renameSlot", id: "skin", to: "body" }]).model;
  assert.equal(m.slots.find((s) => s.id === "glove")!.clip, "body");
  assert.ok(m.animations!.a.slots!.body);
  assert.deepEqual(validateModel(m).filter((i) => i.level === "error"), []);
});
