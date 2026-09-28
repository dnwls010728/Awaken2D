import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, emptyModel } from "../src/core/index.ts";

function rigged() {
  return applyOps(emptyModel("t"), [
    { op: "addBone", id: "arm", start: [0, 0], end: [50, 0] },
    { op: "addBone", id: "hand", parent: "arm", start: [50, 0], end: [70, 0] },
    { op: "addMesh", id: "glove", shape: { rect: { x: 50, y: -5, width: 20, height: 10 } }, color: "#00ff00", bone: "hand" },
    { op: "addMesh", id: "body", shape: { rect: { x: -20, y: -20, width: 10, height: 10 } }, color: "#0000ff", bone: "root" },
  ]).model;
}

test("updateBone carry moves bound meshes of the bone and its children; default keeps them", () => {
  const base = rigged();
  const kept = applyOps(base, [{ op: "updateBone", id: "arm", rotation: 90 }]).model;
  assert.deepEqual(kept.attachments.glove.vertices, base.attachments.glove.vertices, "without carry the art stays");

  const res = applyOps(base, [{ op: "updateBone", id: "arm", rotation: 90, carry: true }]);
  const m = res.model;
  // the glove sat at x 50..70 along the arm; rotated 90° CCW about the origin it now spans y 50..70
  for (const [x, y] of m.attachments.glove.vertices) {
    assert.ok(x >= -5.001 && x <= 5.001, `x ${x}`);
    assert.ok(y >= 49.999 && y <= 70.001, `y ${y}`);
  }
  assert.deepEqual(m.attachments.body.vertices, base.attachments.body.vertices, "meshes on other bones stay");
  assert.match(res.log[0], /carried 1 mesh/);
  assert.deepEqual(m.attachments.glove.uvs, base.attachments.glove.uvs, "texture moves with the vertices");
});

test("updateBone carry translates meshes with a moved bone", () => {
  const m = applyOps(rigged(), [{ op: "updateBone", id: "hand", x: 60, carry: true }]).model;
  const xs = m.attachments.glove.vertices.map((v) => v[0]);
  assert.equal(Math.min(...xs), 60);
  assert.equal(Math.max(...xs), 80);
});
