import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOps,
  computePose,
  delaunay,
  drawList,
  easeValue,
  emptyModel,
  FORMAT_ID,
  fromTRS,
  invert,
  mul,
  normalizeModel,
  sampleTrack,
  serializeModel,
  validateModel,
} from "../src/core/index.ts";
import type { Op } from "../src/core/index.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("matrix inverse round-trips", () => {
  const m = fromTRS(10, -4, 33, 1.5, 0.7);
  const id = mul(m, invert(m));
  [1, 0, 0, 1, 0, 0].forEach((v, i) => close(id[i], v));
});

test("sampleTrack interpolates, clamps and steps", () => {
  const keys = [{ t: 0, v: 0 }, { t: 1, v: 10, ease: "stepped" as const }, { t: 2, v: 20 }];
  const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
  close(sampleTrack(keys, 0.5, lerp)!, 5);
  close(sampleTrack(keys, 1.5, lerp)!, 10);
  close(sampleTrack(keys, 5, lerp)!, 20);
  close(sampleTrack(keys, -1, lerp)!, 0);
  close(easeValue("easeInOut", 0.5), 0.5, 1e-3);
});

test("delaunay triangulates a square into 2 CCW triangles", () => {
  const tris = delaunay([[0, 0], [1, 0], [1, 1], [0, 1]]);
  assert.equal(tris.length, 2);
});

const arm: Op[] = [
  { op: "addBone", id: "upper", start: [0, 0], end: [50, 0] },
  { op: "addBone", id: "lower", parent: "upper", start: [50, 0], end: [100, 0] },
  { op: "addMesh", id: "skin", shape: { rect: { x: 0, y: -5, width: 100, height: 10 }, cols: 10 }, color: "#ff0000", bones: ["upper", "lower"] },
  { op: "setAnimation", name: "bend", duration: 1, loop: false },
  { op: "setKeys", animation: "bend", bone: "lower", channel: "rotate", keys: [{ t: 0, v: 0 }, { t: 1, v: 90 }] },
];

test("ops build a bendable arm; setup pose leaves vertices unchanged", () => {
  const { model } = applyOps(emptyModel("t"), arm);
  assert.deepEqual(validateModel(model).filter((i) => i.level === "error"), []);
  const setup = computePose(model);
  const [item] = drawList(model, setup, setup);
  item.positions.forEach((p, i) => {
    close(p[0], item.attachment.vertices[i][0]);
    close(p[1], item.attachment.vertices[i][1]);
  });
});

test("rotating the lower bone moves the tip vertices around the elbow", () => {
  const { model } = applyOps(emptyModel("t"), arm);
  const pose = computePose(model, "bend", 1);
  const [item] = drawList(model, pose);
  const tipIdx = item.attachment.vertices.findIndex((v) => v[0] === 100 && v[1] === 5);
  const tip = item.positions[tipIdx];
  // (100, 5) rotated 90deg around the elbow (50, 0) -> (45, 50)
  close(tip[0], 45, 1e-3);
  close(tip[1], 50, 1e-3);
  const lower = pose.byId.get("lower")!;
  close(lower.world[4], 50);
});

test("applyOps is atomic and reports the failing op", () => {
  const base = emptyModel("t");
  assert.throws(() => applyOps(base, [{ op: "addBone", id: "a" }, { op: "addBone", id: "b", parent: "nope" }]), /op #1 \(addBone\).*unknown bone "nope"/);
  assert.equal(base.bones.length, 1);
});

test("validate catches cycles and bad weights", () => {
  const m = normalizeModel({
    bones: [
      { id: "a", parent: "b" },
      { id: "b", parent: "a" },
    ],
    slots: [],
    attachments: {},
  });
  assert.ok(validateModel(m).some((i) => i.message.includes("cycle")));
  const { model } = applyOps(emptyModel("t"), arm);
  model.attachments.skin.weights[0] = [["ghost", 1]];
  assert.ok(validateModel(model).some((i) => i.message.includes('unknown bone "ghost"')));
});

test("validate warns about folding meshes", () => {
  const { model } = applyOps(emptyModel("t"), [
    ...arm.slice(0, 4),
    { op: "setKeys", animation: "bend", bone: "lower", channel: "rotate", keys: [{ t: 0, v: 0 }, { t: 1, v: 175 }] },
  ]);
  assert.ok(validateModel(model).some((i) => i.message.includes("flip")));
});

test("serialize is stable and round-trips", () => {
  const { model } = applyOps(emptyModel("t"), arm);
  const text = serializeModel(model);
  const again = serializeModel(normalizeModel(JSON.parse(text)));
  assert.equal(again, text);
});

test("files saved under the old project name (format rigkit/0.1) load as the current format", () => {
  const m = normalizeModel({ format: "rigkit/0.1", name: "old", bones: [{ id: "root", parent: null }], slots: [], attachments: {}, animations: {} });
  assert.equal(m.format, FORMAT_ID);
  assert.equal(validateModel(m).filter((i) => i.path === "format").length, 0);
  assert.equal(normalizeModel({ format: "other/1", name: "x", bones: [] }).format, "other/1");
});
