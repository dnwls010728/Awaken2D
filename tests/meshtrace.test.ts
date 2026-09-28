import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MESH_PRESETS, isSimplePolygon, meshAddHullVertex, meshAutoGenerate, meshQuarter, meshFillInterior, meshFromTrace, meshOutline, meshReset, pointInPolygon, signedArea, traceHull, triangulateHull } from "../src/core/index.ts";
import { applyOps, computePose, drawList, emptyModel } from "../src/core/index.ts";
import type { MeshAttachment, Op, Tri, Vec2 } from "../src/core/index.ts";

/** An L-shaped piece plus a small separate blob, on a 40x30 transparent image. */
function image(): { data: Uint8Array; w: number; h: number } {
  const w = 40;
  const h = 30;
  const data = new Uint8Array(w * h * 4);
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[(y * w + x) * 4 + 3] = 255;
  };
  fill(4, 4, 12, 26); // vertical bar
  fill(12, 18, 28, 26); // foot
  fill(31, 5, 36, 10); // blob
  return { data, w, h };
}

const area = (vs: Vec2[], tris: Tri[]) => tris.reduce((s, [a, b, c]) => s + Math.abs((vs[b][0] - vs[a][0]) * (vs[c][1] - vs[a][1]) - (vs[b][1] - vs[a][1]) * (vs[c][0] - vs[a][0])) / 2, 0);

test("traceHull wraps every opaque pixel in a simple outline of about `detail` vertices on the image", () => {
  const { data, w, h } = image();
  for (const concavity of [0, 50, 100]) {
    const hull = traceHull(data, w, h, { detail: 12, concavity });
    assert.ok(hull.length >= 3 && hull.length <= 14, `concavity ${concavity}: ${hull.length} vertices`);
    assert.ok(isSimplePolygon(hull), `concavity ${concavity}: simple`);
    for (const [x, y] of hull) assert.ok(x >= 0 && x <= w && y >= 0 && y <= h, "on the image");
    // pixel centers of the art are inside (the corners too, within rounding)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!data[(y * w + x) * 4 + 3]) continue;
        assert.ok(pointInPolygon([x + 0.5, y + 0.5], hull), `concavity ${concavity}: pixel ${x},${y} inside`);
      }
    }
  }
  // tighter with more concavity: the dent of the L is left out
  const loose = Math.abs(signedArea(traceHull(data, w, h, { detail: 30, concavity: 0 })));
  const tight = Math.abs(signedArea(traceHull(data, w, h, { detail: 30, concavity: 100 })));
  assert.ok(tight < loose * 0.85, `tight ${tight} < loose ${loose}`);
  assert.throws(() => traceHull(new Uint8Array(4 * 4 * 4), 4, 4), /no pixels/);
});

test("triangulateHull keeps the outline edges, covers the polygon and adds the inner points", () => {
  const hull: Vec2[] = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]]; // an L (concave)
  const inner: Vec2[] = [[4, 4], [14, 4], [4, 14], [30, 30]]; // the last is outside
  const { vertices, triangles, used } = triangulateHull(hull, inner);
  assert.deepEqual(used, [0, 1, 2]);
  assert.equal(vertices.length, 9);
  assert.ok(Math.abs(area(vertices, triangles) - Math.abs(signedArea(hull))) < 1e-6, "covers exactly the polygon");
  const edges = new Set(triangles.flatMap(([a, b, c]) => [[a, b], [b, c], [c, a]].map(([p, q]) => (p < q ? `${p},${q}` : `${q},${p}`))));
  for (let i = 0; i < hull.length; i++) {
    const j = (i + 1) % hull.length;
    assert.ok(edges.has(i < j ? `${i},${j}` : `${j},${i}`), `hull edge ${i}-${j}`);
  }
  const loops = meshOutline(vertices, triangles);
  assert.equal(loops.length, 1);
  assert.deepEqual([...loops[0]].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test("mesh Trace / Generate / Reset / outline vertex keep the art where it is", () => {
  const { data, w, h } = image();
  // a 4-vertex mesh showing the image at 2 world units per pixel, +y up, origin at the image's bottom-left
  const toWorld = ([u, v]: Vec2): Vec2 => [u * w * 2, (1 - v) * h * 2];
  const uvs: Vec2[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
  const att: MeshAttachment = { type: "mesh", image: "img", vertices: uvs.map(toWorld), uvs, triangles: [[0, 1, 2], [0, 2, 3]], weights: uvs.map(() => [["root", 1]]) };
  const traced = meshFromTrace(att, data, w, h, { detail: 16, interior: 6 });
  assert.ok(traced.vertices.length > 16, "outline + inner vertices");
  traced.uvs!.forEach((uv, i) => {
    const p = toWorld(uv);
    assert.ok(Math.hypot(p[0] - traced.vertices[i][0], p[1] - traced.vertices[i][1]) < 0.02, "vertex at its UV's place");
  });
  for (const [a, b, c] of traced.triangles) {
    const [p, q, r] = [traced.vertices[a], traced.vertices[b], traced.vertices[c]];
    assert.ok((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) > 0, "counter-clockwise in world");
  }
  const tracedAtt = { ...att, ...traced, weights: traced.vertices.map(() => [["root", 1]] as Array<[string, number]>) };
  const outline = meshOutline(tracedAtt.vertices, tracedAtt.triangles)[0].length;
  const filled = meshFillInterior(tracedAtt, 4);
  assert.equal(meshOutline(filled.vertices, filled.triangles)[0].length, outline, "Generate keeps the outline");
  assert.ok(filled.vertices.length > traced.vertices.length);
  const reset = meshReset(tracedAtt);
  assert.equal(reset.vertices.length, 4);
  assert.ok(reset.vertices.every((p, i) => Math.hypot(p[0] - toWorld(reset.uvs![i])[0], p[1] - toWorld(reset.uvs![i])[1]) < 0.02));
  // an outline vertex outside the mesh extends it
  const grown = meshAddHullVertex(att, [w, h * 2 + 10]);
  assert.equal(grown.geometry.vertices.length, 5);
  assert.ok(area(grown.geometry.vertices, grown.geometry.triangles) > w * 2 * h * 2);
  assert.deepEqual(grown.geometry.vertices[grown.index], [w, h * 2 + 10]);
});

test("Cubism-style auto mesh: an outline around the art with an inner ring and inner points; quartering keeps the shape", () => {
  const { data, w, h } = image();
  const uvs: Vec2[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
  const toWorld = ([u, v]: Vec2): Vec2 => [u * w, (1 - v) * h];
  const att: MeshAttachment = { type: "mesh", image: "img", vertices: uvs.map(toWorld), uvs, triangles: [[0, 1, 2], [0, 2, 3]], weights: uvs.map(() => [["root", 1]]) };
  const g = meshAutoGenerate(att, data, w, h, { outerInterval: 4, innerInterval: 5, outerMargin: 1, innerMargin: 2, minBoundaryPoints: 4 });
  const loop = meshOutline(g.vertices, g.triangles)[0];
  assert.ok(loop.length >= 8, `outline points: ${loop.length}`);
  assert.ok(g.vertices.length > loop.length + 5, "inner ring and inner points");
  // every opaque pixel center is covered by a triangle (in UV space)
  const covered = (p: Vec2) =>
    g.triangles.some(([a, b, c]) => {
      const [A, B, C] = [g.uvs![a], g.uvs![b], g.uvs![c]].map(([u, v]) => [u * w, v * h]);
      const s = (P: number[], Q: number[]) => (Q[0] - P[0]) * (p[1] - P[1]) - (Q[1] - P[1]) * (p[0] - P[0]);
      const d = [s(A, B), s(B, C), s(C, A)];
      return d.every((x) => x >= -1e-6) || d.every((x) => x <= 1e-6);
    });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]) assert.ok(covered([x + 0.5, y + 0.5]), `pixel ${x},${y}`);
  for (const k of Object.keys(AUTO_MESH_PRESETS)) assert.ok(meshAutoGenerate(att, data, w, h, AUTO_MESH_PRESETS[k]).triangles.length > 0, k);
  // quartering: four times the triangles, same area, shared midpoints
  const q = meshQuarter({ ...att, ...g, weights: g.vertices.map(() => [["root", 1]] as Array<[string, number]>) });
  assert.equal(q.triangles.length, g.triangles.length * 4);
  assert.ok(Math.abs(area(q.vertices, q.triangles) - area(g.vertices, g.triangles)) < 1e-3);
  const edges = new Set(g.triangles.flatMap(([a, b, c]) => [[a, b], [b, c], [c, a]].map(([p, r]) => (p < r ? `${p},${r}` : `${r},${p}`))));
  assert.equal(q.vertices.length, g.vertices.length + edges.size);
});

test("a Live2D mesh rebuilt with a wider outline keeps the new vertices where they are, in every keyform", () => {
  let m = applyOps(emptyModel("l", "live2d"), [
    { op: "addParameter", id: "P", min: 0, max: 1, default: 1 },
    { op: "addMesh", id: "m", shape: { rect: { x: 0, y: 0, width: 100, height: 100 }, cols: 2, rows: 2 } },
    { op: "setKeyformKeys", target: "m", param: "P", keys: [0, 1] },
  ] as Op[]).model;
  // at P = 0 the mesh is squashed to a tenth of its height (toward y = 0)
  const squash = m.attachments.m.vertices.map((v, i): [number, number, number] => [i, 0, -v[1] * 0.9]);
  m = applyOps(m, [{ op: "setKeyform", target: "m", at: { P: 0 }, offsets: squash }] as Op[]).model;
  // new outline 5 units wider on every side (outside the old mesh)
  const verts: Vec2[] = [[-5, -5], [105, -5], [105, 105], [-5, 105]];
  m = applyOps(m, [{ op: "setMeshGeometry", attachment: "m", vertices: verts, triangles: [[0, 1, 2], [0, 2, 3]] }] as Op[]).model;
  const at = (p: number) => computePose(m, null, 0, { params: { P: p } });
  const pts = (p: number) => drawList(m, at(p), computePose(m)).find((it) => it.slot === "m")!.positions;
  pts(1).forEach((q, i) => assert.ok(Math.hypot(q[0] - verts[i][0], q[1] - verts[i][1]) < 1e-3, `default: vertex ${i} stays at ${verts[i]}, got ${q}`));
  // squashed keyform: the wider outline squashes the same way (y * 0.1), not pinned to the old edge
  pts(0).forEach((q, i) => assert.ok(Math.abs(q[1] - verts[i][1] * 0.1) < 1e-3, `P=0: vertex ${i} y ${q[1]} vs ${verts[i][1] * 0.1}`));
});
