import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, computePose, emptyModel, validateModel } from "../src/core/index.ts";

function model() {
  return applyOps(emptyModel("t"), [
    ...["a", "b", "c", "d"].map((id, i) => ({ op: "addMesh" as const, id, shape: { rect: { x: i * 10, y: 0, width: 8, height: 8 } }, color: "#ff0000", bone: "root" })),
    { op: "setAnimation", name: "swap", duration: 2 },
    { op: "setDrawOrderKeys", animation: "swap", keys: [{ t: 0.5, offsets: [["a", 3]] }, { t: 1.5, offsets: [] }] },
  ]).model;
}

const order = (m: ReturnType<typeof model>, t: number) => computePose(m, "swap", t).slots.map((s) => s.id).join("");

test("draw order keys are stepped and move slots by their offset", () => {
  const m = model();
  assert.equal(order(m, 0), "abcd", "setup order before the first key");
  assert.equal(order(m, 0.5), "bcda", "a moved three places toward the front");
  assert.equal(order(m, 1.2), "bcda");
  assert.equal(order(m, 1.6), "abcd", "an empty key restores the setup order");
  assert.deepEqual(validateModel(m, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
});

test("draw order follows slot renames and removals, and rejects unknown slots", () => {
  const renamed = applyOps(model(), [{ op: "renameSlot", id: "a", to: "hand" }]).model;
  assert.deepEqual(renamed.animations!.swap.drawOrder![0].offsets, [["hand", 3]]);
  const removed = applyOps(model(), [{ op: "removeSlot", id: "a" }]).model;
  assert.deepEqual(removed.animations!.swap.drawOrder![0].offsets, []);
  assert.throws(() => applyOps(model(), [{ op: "setDrawOrderKeys", animation: "swap", keys: [{ t: 0, offsets: [["nope", 1]] }] }]), /unknown slot/);
});
