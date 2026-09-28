import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, emptyModel, normalizeModel, paramValues, serializeModel } from "../src/core/index.ts";
import type { Model, Op } from "../src/core/index.ts";

function knobs(extra: Op[] = []): Model {
  return applyOps(emptyModel("t", "live2d"), [
    { op: "addParameter", id: "EyeOpen", min: 0, max: 1, default: 1 },
    { op: "addParameter", id: "AngleX", min: -30, max: 30 },
    { op: "addParameter", id: "AngleZ", min: -30, max: 30 },
    ...extra,
  ]).model;
}

test("parameter values: override > animation track > default, clamped to range", () => {
  const m = knobs([
    { op: "setAnimation", name: "a", duration: 1 },
    { op: "setParamTrack", animation: "a", parameter: "AngleX", keys: [{ t: 0, v: -30 }, { t: 1, v: 30 }] },
  ]);
  assert.deepEqual(paramValues(m, undefined, 0), { EyeOpen: 1, AngleX: 0, AngleZ: 0 });
  assert.equal(paramValues(m, m.animations!.a, 0.5).AngleX, 0);
  assert.equal(paramValues(m, m.animations!.a, 0.75).AngleX, 15);
  assert.equal(paramValues(m, m.animations!.a, 0.75, { AngleX: 5 }).AngleX, 5);
  assert.equal(paramValues(m, undefined, 0, { AngleX: 999 }).AngleX, 30);
});

test("ops reject bad parameter data with clear errors", () => {
  const m = knobs();
  assert.throws(() => applyOps(m, [{ op: "addParameter", id: "X", min: 1, max: 0 }]), /min < max/);
  assert.throws(() => applyOps(m, [{ op: "updateParameter", id: "Nope", default: 0 }]), /unknown parameter "Nope"/);
});

test("older files: the target is inferred and Awaken2D's removed parameter effects, warps, combos and spring bones are dropped", () => {
  const old = {
    format: "awaken2d/1",
    name: "old",
    bones: [{ id: "root", parent: null }, { id: "tail", parent: "root", length: 10 }],
    slots: [],
    attachments: {},
    parameters: [{ id: "P", min: 0, max: 1, bones: { tail: { rotate: [{ at: 1, v: 10 }] } }, warps: {} }],
    warps: [{ id: "w", rect: { x: 0, y: 0, width: 1, height: 1 }, cols: 1, rows: 1, targets: [] }],
    combos: [{ id: "c", params: ["P"], keys: [] }],
    physics: [{ id: "s", bones: ["tail"] }],
    animations: { a: { duration: 1, physics: { s: { mix: [{ t: 0, v: 1 }] } } } },
  };
  const m = normalizeModel(old);
  assert.equal(m.target, "spine");
  assert.deepEqual(m.parameters, [{ id: "P", min: 0, max: 1, default: 0 }]);
  const saved = JSON.parse(serializeModel(m));
  for (const k of ["warps", "combos", "physics"]) assert.equal(k in saved, false, k);
  assert.equal("physics" in saved.animations.a, false);
  assert.equal(normalizeModel({ ...old, live2d: { canvas: {}, parts: [], deformers: [] } }).target, "live2d");
});
