import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, boneEnds, computePose, emptyModel, normalizeModel, serializeModel, validateModel, wrapDeg } from "../src/core/index.ts";
import type { Model, Op, Vec2 } from "../src/core/index.ts";

const near = (a: Vec2, b: Vec2, eps = 1e-3) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < eps, `${a} != ${b}`);

/** Arm along +x: upper (0,0)->(50,0), lower (50,0)->(100,0), IK target created at the tip. */
function arm(extra: Op[] = []): Model {
  return applyOps(emptyModel("t"), [
    { op: "addBone", id: "upper", start: [0, 0], end: [50, 0] },
    { op: "addBone", id: "lower", parent: "upper", start: [50, 0], end: [100, 0] },
    { op: "addIk", id: "arm_ik", bones: ["upper", "lower"] },
    { op: "setAnimation", name: "reach", duration: 1, loop: false },
    ...extra,
  ]).model;
}

const tip = (m: Model, anim: string | null, t: number) => boneEnds(computePose(m, anim, t, { constraints: true }).byId.get("lower")!).end;
const joint = (m: Model, anim: string | null, t: number) => boneEnds(computePose(m, anim, t, { constraints: true }).byId.get("upper")!).end;

test("wrapDeg maps into (-180, 180]", () => {
  assert.equal(wrapDeg(190), -170);
  assert.equal(wrapDeg(-180), 180);
  assert.equal(wrapDeg(720 + 45), 45);
});

test("addIk creates a target at the chain tip, so the setup pose does not move", () => {
  const m = arm();
  const target = m.bones.find((b) => b.id === "arm_ik_target")!;
  assert.deepEqual([target.parent, target.x, target.y], ["root", 100, 0]);
  near(tip(m, null, 0), [100, 0]);
  assert.deepEqual(validateModel(m).filter((i) => i.level === "error"), []);
});

test("two-bone IK reaches a reachable target; bend direction picks the joint side", () => {
  const m = arm([
    { op: "setKeys", animation: "reach", bone: "arm_ik_target", channel: "translate", keys: [{ t: 0, v: [60, 40] }], space: "world" },
  ]);
  near(tip(m, "reach", 0), [60, 40]);
  const pos = joint(m, "reach", 0);
  near([Math.hypot(...pos), 0], [50, 0]); // bone lengths preserved
  // bendPositive: the joint lies clockwise of the shoulder->target line (right-hand side)
  const cross = 60 * pos[1] - 40 * pos[0];
  const bendPos = m.ik![0].bendPositive;
  assert.ok(bendPos ? cross < 0 : cross > 0, `joint ${pos} on wrong side for bendPositive=${bendPos}`);
  const flipped = applyOps(m, [{ op: "updateIk", id: "arm_ik", bendPositive: !bendPos }]).model;
  near(tip(flipped, "reach", 0), [60, 40]);
  const pos2 = joint(flipped, "reach", 0);
  assert.ok(Math.sign(60 * pos2[1] - 40 * pos2[0]) === -Math.sign(cross), "flipping bend mirrors the joint");
});

test("unreachable target straightens the chain toward it", () => {
  const m = arm([{ op: "setKeys", animation: "reach", bone: "arm_ik_target", channel: "translate", keys: [{ t: 0, v: [0, 300] }], space: "world" }]);
  near(tip(m, "reach", 0), [0, 100], 1e-2);
  near(joint(m, "reach", 0), [0, 50], 1e-2);
});

test("one-bone IK aims the bone at the target", () => {
  const m = applyOps(emptyModel("t"), [
    { op: "addBone", id: "head", start: [0, 0], end: [0, 30] },
    { op: "addBone", id: "look", start: [100, 0] },
    { op: "addIk", id: "aim", bones: ["head"], target: "look" },
  ]).model;
  near(boneEnds(computePose(m, null, 0, { constraints: true }).byId.get("head")!).end, [30, 0]);
});

test("mix blends between the animated pose and the IK solution, and can be keyed", () => {
  const m = arm([
    { op: "setKeys", animation: "reach", bone: "arm_ik_target", channel: "translate", keys: [{ t: 0, v: [0, 100] }], space: "world" },
    { op: "setIkKeys", animation: "reach", ik: "arm_ik", channel: "mix", keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] },
  ]);
  near(tip(m, "reach", 0), [100, 0]); // mix 0: untouched
  near(tip(m, "reach", 1), [0, 100], 1e-2); // mix 1: straight up
  const half = tip(m, "reach", 0.5);
  assert.ok(half[1] > 1 && half[1] < 99, `half mix should be in between, got ${half}`);
});

test("bend direction is inferred from a pre-bent chain", () => {
  const bent = (end: Vec2) =>
    applyOps(emptyModel("t"), [
      { op: "addBone", id: "a", start: [0, 0], end: [50, 0] },
      { op: "addBone", id: "b", parent: "a", start: [50, 0], end },
      { op: "addIk", id: "ik", bones: ["a", "b"] },
    ]).model.ik![0].bendPositive;
  assert.equal(bent([80, 40]), true); // child turns counter-clockwise
  assert.equal(bent([80, -40]), false);
});

test("IK rejects targets inside the chain and removeBone protects IK bones", () => {
  const m = arm();
  assert.throws(() => applyOps(m, [{ op: "addBone", id: "hand", parent: "lower", start: [100, 0] }, { op: "addIk", id: "bad", bones: ["upper", "lower"], target: "hand" }]), /part of or below/);
  assert.throws(() => applyOps(m, [{ op: "removeBone", id: "arm_ik_target" }]), /used by IK/);
  assert.throws(() => applyOps(m, [{ op: "addIk", id: "gap", bones: ["root", "lower"] }]), /direct child/);
  const removed = applyOps(m, [{ op: "removeIk", id: "arm_ik", removeTarget: true }]).model;
  assert.equal(removed.ik, undefined);
  assert.ok(!removed.bones.some((b) => b.id === "arm_ik_target"));
});

test("validate reports broken IK definitions", () => {
  const m = normalizeModel({
    bones: [{ id: "root", parent: null }, { id: "a", parent: "root", length: 10 }, { id: "b", parent: "a", length: 10 }],
    slots: [],
    attachments: {},
    ik: [{ id: "x", bones: ["a", "b"], target: "b" }, { id: "y", bones: ["a", "b"], target: "nope", mix: 2 }],
    animations: { run: { duration: 1, ik: { ghost: { mix: [{ t: 0, v: 1 }] } } } },
  });
  const msgs = validateModel(m).map((i) => i.message).join("\n");
  assert.match(msgs, /chase itself/);
  assert.match(msgs, /unknown bone "nope"/);
  assert.match(msgs, /mix.*|between 0 and 1/);
  assert.match(msgs, /unknown IK constraint "ghost"/);
});

test("world-space rotate keys account for the parent's rotation", () => {
  const m = applyOps(emptyModel("t"), [
    { op: "addBone", id: "p", start: [0, 0], end: [0, 10] }, // world angle 90
    { op: "addBone", id: "c", parent: "p", start: [0, 10], end: [10, 10] }, // world angle 0
    { op: "setAnimation", name: "a", duration: 1 },
    { op: "setKeys", animation: "a", bone: "c", channel: "rotate", keys: [{ t: 0, v: 45 }], space: "world" },
  ]).model;
  const w = computePose(m, "a", 0).byId.get("c")!.world;
  assert.ok(Math.abs(Math.atan2(w[1], w[0]) * (180 / Math.PI) - 45) < 1e-4, "Spine models pose in float32 like the runtime");
});

test("IK survives serialization", () => {
  const m = arm([{ op: "updateIk", id: "arm_ik", mix: 0.5 }]);
  const again = normalizeModel(JSON.parse(serializeModel(m)));
  assert.deepEqual(again.ik, m.ik);
});
