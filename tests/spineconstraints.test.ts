import assert from "node:assert/strict";
import { test } from "node:test";
import { PoseSimulator, SpineState, applyOps, computePose, drawList, emptyModel, normalizeModel, serializeModel, validateModel } from "../src/core/index.ts";
import type { Model, Op, Vec2 } from "../src/core/index.ts";
import { exportSpineData, importSpineData } from "../src/spine/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** root -> a (x 100) and a free bone b (x 0, y 100); a mesh on a slot of b. */
function base(): Model {
  return applyOps(emptyModel("t", "spine"), [
    { op: "addBone", id: "a", parent: "root", x: 100, y: 0, length: 50 },
    { op: "addBone", id: "b", parent: "root", x: 0, y: 100, length: 50 },
    { op: "addBone", id: "c", parent: "b", x: 50, y: 0, length: 40 },
    { op: "setAnimation", name: "turn", duration: 1 },
    { op: "setKeys", animation: "turn", bone: "a", channel: "rotate", keys: [{ t: 0, v: 0 }, { t: 1, v: 90 }] },
  ] as Op[]).model;
}
const world = (m: Model, bone: string, anim: string | null = null, t = 0) => computePose(m, anim, t, { constraints: true }).byId.get(bone)!.world;
const near = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("transform constraint: b copies a's world rotation (mixed), and the setConstraint / updateConstraint / removeConstraint ops", () => {
  let m = applyOps(base(), [
    {
      op: "setConstraint",
      kind: "transform",
      constraint: { id: "follow", source: "a", bones: ["b"], properties: [{ from: "rotate", to: [{ property: "rotate" }] }], mix: { rotate: 1 } },
    },
  ] as Op[]).model;
  const w = world(m, "b", "turn", 0.5); // a is at 45 degrees
  near(Math.atan2(w[1], w[0]) * (180 / Math.PI), 45, 1e-3);
  m = applyOps(m, [{ op: "updateConstraint", kind: "transform", id: "follow", set: { mix: { rotate: 0.5 } } }] as Op[]).model;
  const h = world(m, "b", "turn", 0.5);
  near(Math.atan2(h[1], h[0]) * (180 / Math.PI), 22.5, 1e-3);
  // a mix timeline takes over from the setup mix
  m = applyOps(m, [{ op: "setConstraintKeys", animation: "turn", kind: "transform", constraint: "follow", channel: "rotate", keys: [{ t: 0, v: 0 }] }] as Op[]).model;
  near(world(m, "b", "turn", 0.5)[0], 1);
  assert.deepEqual(validateModel(m, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  assert.throws(() => applyOps(m, [{ op: "removeBone", id: "a" }] as Op[]), /transform follow/);
  m = applyOps(m, [{ op: "removeConstraint", kind: "transform", id: "follow" }] as Op[]).model;
  assert.equal(m.transforms, undefined);
  assert.equal(m.animations!.turn.transforms, undefined, "its keys go with it");
});

test("bone inherit modes: onlyTranslation keeps the bone upright under a turning parent", () => {
  let m = applyOps(base(), [
    { op: "setKeys", animation: "turn", bone: "b", channel: "rotate", keys: [{ t: 0, v: 0 }, { t: 1, v: 90 }] },
    { op: "updateBone", id: "c", inherit: "onlyTranslation" },
  ] as Op[]).model;
  const w = world(m, "c", "turn", 0.99999);
  near(w[0], 1);
  near(w[1], 0);
  // its origin still follows the parent: (0, 100) + rotate(90) * (50, 0)
  near(w[4], 0, 1e-3);
  near(w[5], 150, 1e-3);
  m = applyOps(m, [{ op: "updateBone", id: "c", inherit: "normal" }] as Op[]).model;
  assert.equal(m.bones.find((b) => b.id === "c")!.inherit, undefined);
  near(world(m, "c", "turn", 0.99999)[1], 1);
});

test("Spine physics: a rotating physics bone swings when its parent moves across it and settles, stepped by PoseSimulator", () => {
  const m = applyOps(base(), [
    { op: "setAnimation", name: "move", duration: 2 },
    { op: "setKeys", animation: "move", bone: "b", channel: "translate", keys: [{ t: 0, v: [0, 0] }, { t: 0.2, v: [0, 200] }] },
    { op: "setConstraint", kind: "physics", constraint: { id: "wobble", bone: "c", rotate: 1, inertia: 1, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1 } },
  ] as Op[]).model;
  // without a simulation state (plain computePose) physics does nothing
  near(world(m, "c", "move", 0.5)[1], 0);
  const sim = new PoseSimulator(m, "move", { settle: 0, warmupLoops: 0 });
  let peak = 0;
  for (let t = 0; t <= 1.5; t += 1 / 60) peak = Math.max(peak, Math.abs(sim.at(t).byId.get("c")!.world[1]));
  assert.ok(peak > 0.05, `the bone swings after the jump (peak sin ${peak})`);
  const end = sim.at(1.99).byId.get("c")!.world;
  assert.ok(Math.abs(end[1]) < peak / 3, "and settles back");
  // the state can be driven directly too
  const state = new SpineState();
  const a = computePose(m, "move", 0, { constraints: true, spine: { state, physics: "update" } }).byId.get("c")!.world;
  near(a[1], 0);
});

test("path constraint: bones spread along a straight path attachment", () => {
  // a path from (0, 0) to (300, 0): points with their handles on the line
  const pts: Vec2[] = [[-10, 0], [0, 0], [100, 0], [200, 0], [300, 0], [310, 0]];
  let m = applyOps(base(), [
    { op: "addSlot", id: "rail", bone: "root" },
    { op: "addBone", id: "p1", parent: "root", length: 10 },
    { op: "addBone", id: "p2", parent: "root", length: 10 },
  ] as Op[]).model;
  m.pathAttachments = { rail: { vertices: pts, weights: pts.map(() => [["root", 1]]), lengths: [300], constantSpeed: true } };
  m = applyOps(m, [
    { op: "updateSlot", id: "rail", attachment: "rail" },
    {
      op: "setConstraint",
      kind: "path",
      constraint: { id: "along", bones: ["p1", "p2"], slot: "rail", positionMode: "percent", spacingMode: "percent", rotateMode: "tangent", position: 0.25, spacing: 0.5, mix: { rotate: 1, x: 1, y: 1 } },
    },
  ] as Op[]).model;
  const p1 = world(m, "p1");
  const p2 = world(m, "p2");
  near(p1[4], 75, 0.05);
  near(p2[4], 225, 0.05);
  near(p1[5], 0, 1e-6);
  assert.deepEqual(validateModel(m, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  assert.equal(drawList(m, computePose(m)).length, 0, "path attachments are not drawn");
});

test("skins: the active skin decides what a placeholder shows; skin bones and constraints turn on with it", () => {
  let m = applyOps(base(), [
    { op: "addMesh", id: "plain", bone: "b", shape: { rect: { x: 0, y: 0, width: 10, height: 10 } } },
    { op: "addMesh", id: "fancy", bone: "b", shape: { rect: { x: 0, y: 0, width: 20, height: 20 } } },
    { op: "addSlot", id: "hat", bone: "b" },
    { op: "addSkin", name: "party" },
    { op: "setSkinAttachment", skin: "party", slot: "hat", placeholder: "hat", attachment: "fancy" },
    { op: "addSkin", name: "work" },
    { op: "setSkinAttachment", skin: "work", slot: "hat", placeholder: "hat", attachment: "plain" },
    { op: "updateSlot", id: "hat", attachment: "hat" },
    { op: "addBone", id: "feather", parent: "b", length: 5, skin: true },
    { op: "updateBone", id: "feather", skin: true },
    { op: "setSkinBones", skin: "party", bones: ["feather"] },
  ] as Op[]).model;
  const shown = (mm: Model) => computePose(mm).slots.find((s) => s.id === "hat")!.attachment;
  assert.equal(shown(m), null, "no skin: the placeholder shows nothing");
  m = applyOps(m, [{ op: "setSkin", name: "party" }] as Op[]).model;
  assert.equal(shown(m), "fancy");
  assert.equal(computePose(m).inactive, undefined, "the party skin turns on its bone");
  m = applyOps(m, [{ op: "setSkin", name: "work" }] as Op[]).model;
  assert.equal(shown(m), "plain");
  assert.ok(computePose(m).inactive?.has("feather"), "skin bones of other skins are off");
  assert.deepEqual(validateModel(m, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  m = applyOps(m, [{ op: "renameSkin", name: "work", to: "office" }] as Op[]).model;
  assert.equal(m.skin, "office");
});

test("Spine export writes skins, inherit modes and constraints (4.3 array) that import back the same", () => {
  let m = applyOps(base(), [
    { op: "updateBone", id: "c", inherit: "noScale" },
    { op: "setConstraint", kind: "transform", constraint: { id: "t", source: "a", bones: ["b"], properties: [{ from: "x", to: [{ property: "x" }] }], mix: { x: 0.5 } } },
    { op: "setConstraint", kind: "physics", constraint: { id: "p", bone: "c", rotate: 1, inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1 } },
    { op: "setConstraintOrder", order: ["physics:p", "transform:t"] },
    { op: "setConstraintKeys", animation: "turn", kind: "physics", constraint: "p", channel: "reset", keys: [{ t: 0.5 }] },
    { op: "addMesh", id: "m1", bone: "b", shape: { rect: { x: 0, y: 0, width: 10, height: 10 } } },
    { op: "addSlot", id: "s", bone: "b", attachment: "m1" },
    { op: "addSkin", name: "alt" },
  ] as Op[]).model;
  const json = exportSpineData(m, { name: "t", loadImage: () => null, version: "4.3.75" }).json;
  assert.deepEqual(json.constraints.map((c: any) => `${c.type}:${c.name}`), ["physics:p", "transform:t"]);
  assert.equal(json.bones.find((b: any) => b.name === "c").inherit, "noScale");
  assert.deepEqual(json.animations.turn.physics, { p: { reset: [{ time: 0.5 }] } });
  const back = importSpineData(json, { name: "t", resolveImage: () => null }).model;
  assert.deepEqual(back.transforms, m.transforms);
  assert.deepEqual(back.spinePhysics, m.spinePhysics);
  assert.deepEqual(back.constraintOrder, m.constraintOrder);
  assert.deepEqual(back.animations!.turn.spinePhysics, m.animations!.turn.spinePhysics);
  near(world(back, "b", "turn", 0.5)[4], world(m, "b", "turn", 0.5)[4], 1e-3);
  // and the model file keeps all of it
  m = applyOps(m, [{ op: "setSkin", name: "alt" }] as Op[]).model;
  const saved = normalizeModel(JSON.parse(serializeModel(m)));
  for (const k of ["transforms", "spinePhysics", "constraintOrder", "skins", "skin", "bones"] as const) assert.deepEqual(saved[k], m[k], `${k} survives save / load`);
});

test("renameConstraint / renameEvent follow the name into the order, skins and animations; folder names use '/'", () => {
  let m = applyOps(base(), [
    { op: "setConstraint", kind: "transform", constraint: { id: "t", source: "a", bones: ["b"], properties: [{ from: "x", to: [{ property: "x" }] }], mix: { x: 0.5 } } },
    { op: "addIk", id: "reach", bones: ["c"], target: "a" },
    { op: "setConstraintOrder", order: ["transform:t", "ik:reach"] },
    { op: "updateConstraint", kind: "transform", id: "t", set: { skin: true } },
    { op: "addSkin", name: "s" },
    { op: "setSkinBones", skin: "s", constraints: ["transform:t"] },
    { op: "setConstraintKeys", animation: "turn", kind: "transform", constraint: "t", channel: "x", keys: [{ t: 0, v: 1 }] },
    { op: "setIkKeys", animation: "turn", ik: "reach", channel: "mix", keys: [{ t: 0, v: 1 }] },
    { op: "setEvent", name: "hit" },
    { op: "setEventKeys", animation: "turn", keys: [{ t: 0.5, name: "hit" }] },
  ] as Op[]).model;
  m = applyOps(m, [
    { op: "renameConstraint", kind: "transform", id: "t", to: "arms/follow" },
    { op: "renameConstraint", kind: "ik", id: "reach", to: "arms/reach" },
    { op: "renameEvent", name: "hit", to: "sfx/hit" },
  ] as Op[]).model;
  assert.deepEqual(m.constraintOrder, ["transform:arms/follow", "ik:arms/reach"]);
  assert.deepEqual(m.skins!.s.constraints, ["transform:arms/follow"]);
  const a = m.animations!.turn;
  assert.deepEqual(Object.keys(a.transforms!), ["arms/follow"]);
  assert.deepEqual(Object.keys(a.ik!), ["arms/reach"]);
  assert.deepEqual(Object.keys(m.events!), ["sfx/hit"]);
  assert.equal(a.events![0].name, "sfx/hit");
  assert.throws(() => applyOps(m, [{ op: "renameConstraint", kind: "transform", id: "arms/follow", to: "arms/reach" }] as Op[]), /already exists/);
  assert.throws(() => applyOps(m, [{ op: "renameEvent", name: "nope", to: "x" }] as Op[]), /unknown event/);
  assert.deepEqual(validateModel(m, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
});
