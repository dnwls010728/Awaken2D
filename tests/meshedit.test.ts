import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, emptyModel, fitUvAffine, triArea, validateModel } from "../src/core/index.ts";
import type { MeshAttachment, Model } from "../src/core/index.ts";
import { encodePNG } from "../src/render/index.ts";

/** Textured 4x4-cell rect mesh (0,0)-(100,100) bound to two bones; 25 vertices, center vertex = 12. */
function model(): Model {
  return applyOps(emptyModel("t"), [
    { op: "addBone", id: "a", start: [0, 50], end: [50, 50] },
    { op: "addBone", id: "b", parent: "a", start: [50, 50], end: [100, 50] },
    { op: "addImage", id: "img", path: "img.png" },
    { op: "addMesh", id: "m", shape: { rect: { x: 0, y: 0, width: 100, height: 100 }, cols: 4, rows: 4 }, image: "img", bones: ["a", "b"] },
    { op: "addParameter", id: "P", min: 0, max: 1 },
    { op: "setParamShape", parameter: "P", attachment: "m", keys: [{ at: 1, offsets: [[12, 5, 0], [24, 1, 1]] }] },
  ]).model;
}
const area = (a: MeshAttachment) => a.triangles.reduce((s, [i, j, k]) => s + triArea(a.vertices[i], a.vertices[j], a.vertices[k]), 0);
const valid = (a: MeshAttachment) => {
  assert.equal(a.weights.length, a.vertices.length);
  assert.equal(a.uvs?.length, a.vertices.length);
  for (const t of a.triangles) {
    assert.ok(t.every((i) => i >= 0 && i < a.vertices.length), `bad triangle ${t}`);
    assert.ok(triArea(a.vertices[t[0]], a.vertices[t[1]], a.vertices[t[2]]) > 0, `triangle ${t} not CCW`);
  }
};

test("fitUvAffine recovers the image mapping; moveVertices keeps the image in place or stretches it", () => {
  const m = model();
  const att = m.attachments.m;
  const map = fitUvAffine(att.vertices, att.uvs!)!;
  const [u, v] = map([25, 75]);
  assert.ok(Math.abs(u - 0.25) < 1e-6 && Math.abs(v - 0.25) < 1e-6);
  const kept = applyOps(m, [{ op: "moveVertices", attachment: "m", moves: [[12, 60, 40]] }]).model.attachments.m;
  assert.deepEqual(kept.vertices[12], [60, 40]);
  assert.deepEqual(kept.uvs![12], [0.6, 0.6]);
  const stretched = applyOps(m, [{ op: "moveVertices", attachment: "m", moves: [[12, 60, 40]], keepImage: false }]).model.attachments.m;
  assert.deepEqual(stretched.uvs![12], att.uvs![12]);
});

test("addVertex splits the containing triangle (or both triangles on an edge) and interpolates data", () => {
  const m = model();
  const before = m.attachments.m;
  const inside = applyOps(m, [{ op: "addVertex", attachment: "m", at: [30, 36] }]).model.attachments.m;
  assert.equal(inside.vertices.length, 26);
  assert.equal(inside.triangles.length, before.triangles.length + 2);
  assert.ok(Math.abs(area(inside) - area(before)) < 1e-6);
  assert.deepEqual(inside.uvs![25], [0.3, 0.64]);
  valid(inside);
  const w = inside.weights[25];
  assert.ok(Math.abs(w.reduce((s, [, x]) => s + x, 0) - 1) < 1e-6);
  const onEdge = applyOps(m, [{ op: "addVertex", attachment: "m", at: [10, 0] }]).model.attachments.m;
  valid(onEdge);
  assert.ok(Math.abs(area(onEdge) - area(before)) < 1e-6);
  assert.throws(() => applyOps(m, [{ op: "addVertex", attachment: "m", at: [150, 50] }]), /outside the mesh/);
});

test("removeVertices re-triangulates the hole and renumbers blend shapes", () => {
  const m = model();
  const res = applyOps(m, [{ op: "removeVertices", attachment: "m", indices: [12] }]).model;
  const att = res.attachments.m;
  assert.equal(att.vertices.length, 24);
  valid(att);
  assert.ok(Math.abs(area(att) - 10000) < 1e-6, "interior removal keeps the covered area");
  // shape offsets: vertex 12 dropped, vertex 24 is now 23
  assert.deepEqual(res.parameters![0].meshes!.m[0].v, [[23, 1, 1]]);
  const corner = applyOps(m, [{ op: "removeVertices", attachment: "m", indices: [0, 4] }]).model.attachments.m;
  valid(corner);
  assert.equal(corner.vertices.length, 23);
  assert.deepEqual(validateModel(res).filter((i) => i.level === "error"), []);
  assert.throws(() => applyOps(m, [{ op: "removeVertices", attachment: "m", indices: [99] }]), /does not exist/);
});

test("retriangulate keeps triangles inside the old outline", () => {
  const m = applyOps(model(), [{ op: "moveVertices", attachment: "m", moves: [[12, 55, 45]] }, { op: "retriangulate", attachment: "m" }]).model;
  const att = m.attachments.m;
  valid(att);
  assert.ok(Math.abs(area(att) - 10000) < 1e-6);
});

test("adjustWeights: set in a region, add, smooth, and others keep their proportions", () => {
  const m = model();
  const set = applyOps(m, [{ op: "adjustWeights", attachment: "m", bone: "b", mode: "set", value: 1, region: { center: [100, 50], radius: 30 } }]).model.attachments.m;
  const tip = set.vertices.findIndex((v) => v[0] === 100 && v[1] === 50);
  assert.deepEqual(set.weights[tip], [["b", 1]]);
  const far = set.vertices.findIndex((v) => v[0] === 0 && v[1] === 0);
  assert.deepEqual(set.weights[far], m.attachments.m.weights[far], "outside the region nothing changes");

  const half = applyOps(m, [{ op: "adjustWeights", attachment: "m", bone: "a", mode: "set", value: 0.5, vertices: [12] }]).model.attachments.m;
  assert.deepEqual(Object.fromEntries(half.weights[12]), { a: 0.5, b: 0.5 });

  const smooth = applyOps(m, [
    { op: "adjustWeights", attachment: "m", bone: "b", mode: "set", value: 1, vertices: [12] },
    { op: "adjustWeights", attachment: "m", mode: "smooth", vertices: [12] },
  ]).model.attachments.m;
  const b12 = Object.fromEntries(smooth.weights[12]).b;
  assert.ok(b12 < 1 && b12 > 0.3, `smoothing pulls the vertex toward its neighbours: ${b12}`);
  assert.throws(() => applyOps(m, [{ op: "adjustWeights", attachment: "m", mode: "set", value: 1 }]), /needs a bone/);
});

test("mesh edits keep the model renderable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-mesh-"));
  writeFileSync(join(dir, "img.png"), encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(200) }));
  const m = applyOps(model(), [
    { op: "addVertex", attachment: "m", at: [33, 33] },
    { op: "removeVertices", attachment: "m", indices: [6, 7] },
    { op: "adjustWeights", attachment: "m", mode: "smooth" },
  ]).model;
  assert.deepEqual(validateModel(m, { baseDir: dir }).filter((i) => i.level === "error"), []);
});
