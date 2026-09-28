import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, emptyModel, remeshFromAlpha, validateModel } from "../src/core/index.ts";

/** 20 x 10 image: the left half is opaque. */
function image(): { rgba: Uint8Array; w: number; h: number } {
  const w = 20;
  const h = 10;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < 10; x++) rgba[(y * w + x) * 4 + 3] = 255;
  return { rgba, w, h };
}

function rigged() {
  return applyOps(emptyModel("t"), [
    { op: "addBone", id: "a", start: [0, 0], end: [100, 0] },
    { op: "addBone", id: "b", parent: "a", start: [100, 0], end: [200, 0] },
    { op: "addImage", id: "img", path: "img.png" },
    // the image covers x 0..200, y -50..50 (y up); a coarse 2x1 mesh
    { op: "addMesh", id: "m", shape: { rect: { x: 0, y: -50, width: 200, height: 100 }, cols: 2, rows: 1 }, image: "img", bones: ["a", "b"] },
    { op: "setAnimation", name: "a", duration: 1 },
    { op: "setDeformKeys", animation: "a", attachment: "m", keys: [{ t: 0 }, { t: 1, transform: { translate: [5, 10] } }] },
  ]).model;
}

test("remeshFromAlpha places a grid over the opaque pixels, in the mesh's image placement", () => {
  const m = rigged();
  const { rgba, w, h } = image();
  const g = remeshFromAlpha(m.attachments.m, rgba, w, h, 5);
  const xs = g.vertices.map((v) => v[0]);
  const ys = g.vertices.map((v) => v[1]);
  // opaque pixels 0..9 (+1px filter margin) of 20, in 5px cells -> x 0..150; full height -50..50
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 150, "cells are whole: the 5px cell holding the filter margin at x 10..15");
  assert.equal(Math.min(...ys), -50);
  assert.equal(Math.max(...ys), 50);
  assert.equal(g.uvs!.length, g.vertices.length);
});

test("setMeshGeometry carries weights and deform keys over to the new vertices", () => {
  const m = rigged();
  const { rgba, w, h } = image();
  const g = remeshFromAlpha(m.attachments.m, rgba, w, h, 5);
  const res = applyOps(m, [{ op: "setMeshGeometry", attachment: "m", ...g }]);
  const att = res.model.attachments.m;
  assert.equal(att.vertices.length, g.vertices.length);
  assert.match(res.log[0], /weights carried over, 2 shape keys resampled/);
  // every new vertex got the uniform (+5, +10) deform
  const shape = res.model.animations!.a.deform!.m[1].v;
  assert.equal(shape.length, att.vertices.length);
  assert.ok(shape.every(([, dx, dy]) => Math.abs(dx - 5) < 1e-6 && Math.abs(dy - 10) < 1e-6));
  // weights still come from bones a and b, and vertices near x = 0 lean to bone a
  const left = att.vertices.findIndex((v) => v[0] === 0);
  assert.equal(att.weights[left][0][0], "a");
  assert.deepEqual(validateModel(res.model, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  assert.throws(() => applyOps(m, [{ op: "setMeshGeometry", attachment: "m", vertices: [[0, 0]], triangles: [[0, 1, 2]], uvs: [[0, 0]] }]), /must index/);
});
