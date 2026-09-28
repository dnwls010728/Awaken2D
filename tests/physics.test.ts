import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, boneEnds, computePose, emptyModel, normalizeModel, samplePoses, serializeModel, validateModel } from "../src/core/index.ts";
import type { Model, Op, Pose, Vec2 } from "../src/core/index.ts";

/** Horizontal spring bone "tail" (0,100)->(50,100) hanging off a "body" bone. */
function rig(physics: Record<string, unknown> = {}, extra: Op[] = []): Model {
  return applyOps(emptyModel("t"), [
    { op: "addBone", id: "body", start: [0, 0], end: [0, 100] },
    { op: "addBone", id: "tail", parent: "body", start: [0, 100], end: [50, 100] },
    { op: "addPhysics", id: "tail_spring", bones: ["tail"], ...physics } as Op,
    ...extra,
  ]).model;
}

const tipOf = (p: Pose, id = "tail") => boneEnds(p.byId.get(id)!).end.map((v) => Math.round(v * 1e6) / 1e6) as Vec2;
const angleDeg = (p: Pose, id = "tail") => {
  const e = boneEnds(p.byId.get(id)!);
  return (Math.atan2(e.end[1] - e.start[1], e.end[0] - e.start[0]) * 180) / Math.PI;
};

test("gravity makes a spring bone sag in the setup pose, keeping its length", () => {
  const m = rig({ gravity: [0, -2000], frequency: 2, damping: 0.5 });
  const [pose] = samplePoses(m, null, [0]);
  const tip = tipOf(pose);
  assert.ok(tip[1] < 90, `tip should hang down, got ${tip}`);
  assert.ok(Math.abs(Math.hypot(tip[0], tip[1] - 100) - 50) < 1e-6, "bone length preserved");
  // raw pose (no physics) is untouched
  assert.deepEqual(tipOf(computePose(m)), [50, 100]);
  assert.deepEqual(tipOf(samplePoses(m, null, [0], { physics: false })[0]), [50, 100]);
});

test("simulation is deterministic and independent of which times are requested together", () => {
  const m = rig({ gravity: [0, -800] }, [
    { op: "setAnimation", name: "shake", duration: 1 },
    { op: "setKeys", animation: "shake", bone: "body", channel: "rotate", keys: [{ t: 0, v: 0 }, { t: 0.5, v: 30 }, { t: 1, v: 0 }] },
  ]);
  const a = samplePoses(m, "shake", [0.25, 0.5, 0.75]).map((p) => angleDeg(p));
  const b = samplePoses(m, "shake", [0.75, 0.25, 0.5]).map((p) => angleDeg(p));
  const c = [0.25, 0.5, 0.75].map((t) => angleDeg(samplePoses(m, "shake", [t])[0]));
  assert.deepEqual([b[1], b[2], b[0]], a);
  a.forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 1e-9, `${v} vs ${c[i]}`));
});

test("spring tip lags behind parent motion and settles back", () => {
  const m = rig({ frequency: 3, damping: 0.4 }, [
    { op: "setAnimation", name: "lift", duration: 2, loop: false },
    { op: "setKeys", animation: "lift", bone: "body", channel: "translate", keys: [{ t: 0, v: [0, 0] }, { t: 0.2, v: [0, 60] }, { t: 2, v: [0, 60] }] },
  ]);
  const [mid, end] = samplePoses(m, "lift", [0.2, 2]);
  assert.ok(angleDeg(mid) < -5, `moving up, the tail should trail below: ${angleDeg(mid)}`);
  assert.ok(Math.abs(angleDeg(end)) < 1, `after settling it returns to the animated angle: ${angleDeg(end)}`);
});

test("mix 0 and limit bound the simulation", () => {
  const off = rig({ gravity: [0, -5000], mix: 0 });
  assert.deepEqual(tipOf(samplePoses(off, null, [0])[0]), [50, 100]);
  const limited = rig({ gravity: [0, -50000], frequency: 1, limit: 20 });
  const a = angleDeg(samplePoses(limited, null, [0])[0]);
  assert.ok(a >= -20 - 1e-6 && a < -15, `angle should stop at the 20 degree limit, got ${a}`);
});

test("keyed force (wind) pushes the bone", () => {
  const m = rig({ frequency: 2, damping: 0.5 }, [
    { op: "addBoneChain", id: "flag", parent: "body", start: [0, 100], end: [0, 160], count: 1 },
    { op: "addPhysics", id: "flag_spring", bones: ["flag_1"], frequency: 2, damping: 0.5 },
    { op: "setAnimation", name: "wind", duration: 2, loop: false },
    { op: "setPhysicsKeys", animation: "wind", physics: "flag_spring", channel: "force", keys: [{ t: 0, v: [3000, 0] }] },
  ]);
  const [pose] = samplePoses(m, "wind", [2]);
  assert.ok(tipOf(pose, "flag_1")[0] > 10, `wind should push the flag to +x, got ${tipOf(pose, "flag_1")}`);
});

test("chains: children follow their simulated parent", () => {
  const m = applyOps(emptyModel("t"), [
    { op: "addBoneChain", id: "hair", start: [0, 100], end: [90, 100], count: 3 },
    { op: "addPhysics", id: "hair", bones: ["hair_1", "hair_2", "hair_3"], gravity: [0, -1500], frequency: 2, damping: 0.6 },
  ]).model;
  assert.deepEqual(m.bones.map((b) => [b.id, b.parent]), [["root", null], ["hair_1", "root"], ["hair_2", "hair_1"], ["hair_3", "hair_2"]]);
  const raw = computePose(m);
  assert.deepEqual(tipOf(raw, "hair_3").map((v) => Math.round(v)), [90, 100]);
  const [pose] = samplePoses(m, null, [0]);
  const tips = ["hair_1", "hair_2", "hair_3"].map((id) => tipOf(pose, id)[1]);
  assert.ok(tips[0] > tips[1] && tips[1] > tips[2], `each segment hangs lower: ${tips}`);
});

test("ops and validation guard physics", () => {
  const m = rig();
  assert.throws(() => applyOps(m, [{ op: "addPhysics", id: "x", bones: ["root"] }]), /length 0/);
  assert.throws(() => applyOps(m, [{ op: "addPhysics", id: "x", bones: ["tail"] }]), /already simulated/);
  assert.throws(() => applyOps(m, [{ op: "updatePhysics", id: "tail_spring", damping: -1 }]), /damping/);
  assert.throws(() => applyOps(m, [{ op: "removeBone", id: "tail" }]), /simulated by physics/);
  const bad = normalizeModel({
    bones: [{ id: "root", parent: null }, { id: "a", parent: "root" }],
    slots: [],
    attachments: {},
    physics: [{ id: "p", bones: ["a"], frequency: 0 }],
    animations: { x: { duration: 1, physics: { ghost: { mix: [{ t: 0, v: 1 }] } } } },
  });
  const msgs = validateModel(bad).map((i) => i.message).join("\n");
  assert.match(msgs, /length 0/);
  assert.match(msgs, /> 0 Hz/);
  assert.match(msgs, /unknown physics constraint "ghost"/);
});

test("physics survives serialization with defaults stripped", () => {
  const m = rig({ gravity: [0, -300], limit: 45 });
  const text = serializeModel(m);
  assert.match(text, /"gravity":\s*\[0,\s*-300\]/);
  assert.doesNotMatch(text, /"inertia"/);
  assert.deepEqual(normalizeModel(JSON.parse(text)).physics, m.physics);
  const v: Vec2 = m.physics![0].gravity;
  assert.deepEqual(v, [0, -300]);
});
