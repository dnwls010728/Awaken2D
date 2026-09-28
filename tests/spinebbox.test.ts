import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, boundingBoxPolygons, computePose, normalizeModel, serializeModel, validateModel } from "../src/core/index.ts";
import type { Op } from "../src/core/index.ts";
import { exportSpineData, importSpineData } from "../src/spine/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

/** A bone "b" (at x 10), a slot showing a bounding box (a square around the bone), a deform key moving vertex 2. */
function spineJson(): any {
  return {
    skeleton: { spine: "4.2.43" },
    bones: [{ name: "root" }, { name: "b", parent: "root", x: 10 }],
    slots: [{ name: "hit", bone: "b", attachment: "box" }],
    skins: [{ name: "default", attachments: { hit: { box: { type: "boundingbox", vertexCount: 4, vertices: [-5, -5, 5, -5, 5, 5, -5, 5], color: "60f000ff" } } } }],
    animations: {
      move: {
        bones: { b: { translate: [{ x: 0 }, { time: 1, x: 20 }] } },
        attachments: { default: { hit: { box: { deform: [{ offset: 4, vertices: [3, 0] }] } } } },
      },
    },
  };
}

test("Spine bounding boxes: imported, posed with their bone and deform keys, written back as they came", () => {
  const json = spineJson();
  const res = importSpineData(structuredClone(json), { name: "t", resolveImage: () => null });
  const { model } = res;
  assert.ok(!res.warnings.some((w) => /boundingbox/.test(w)), res.warnings.join("\n"));
  assert.deepEqual(model.boundingBoxes?.box.vertices, [[5, -5], [15, -5], [15, 5], [5, 5]]);
  assert.equal(model.boundingBoxes?.box.color, "#60f000ff");
  const setup = boundingBoxPolygons(model, computePose(model));
  assert.equal(setup.length, 1);
  assert.equal(setup[0].slot, "hit");
  // halfway: the bone moved 10, vertex 2 deformed by +3 in x
  const mid = boundingBoxPolygons(model, computePose(model, "move", 0.5))[0].polygon;
  near(mid[0][0], 15);
  near(mid[2][0], 28);
  assert.deepEqual(validateModel(model, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  const out = exportSpineData(model, { name: "t", loadImage: () => null }).json;
  assert.deepEqual(out.skins[0].attachments.hit, json.skins[0].attachments.hit);
  assert.deepEqual(out.animations.move.attachments, json.animations.move.attachments);
  // save / load keeps it
  const again = normalizeModel(JSON.parse(serializeModel(model)));
  assert.deepEqual(again.boundingBoxes, model.boundingBoxes);
});

test("updateBoundingBox: color and a new polygon (weights from the nearest old vertex), exported and read back", () => {
  const { model } = importSpineData(spineJson(), { name: "t", resolveImage: () => null });
  const m2 = applyOps(model, [{ op: "updateBoundingBox", id: "box", color: "#ff0000ff", vertices: [[0, 0], [20, 0], [10, 15]] }] as Op[]).model;
  const b = m2.boundingBoxes!.box;
  assert.equal(b.vertices.length, 3);
  assert.deepEqual(b.weights, [[["b", 1]], [["b", 1]], [["b", 1]]]);
  assert.equal(m2.animations!.move.deform?.box, undefined, "deform keys for the old vertices are dropped");
  const out = exportSpineData(m2, { name: "t", loadImage: () => null }).json;
  const box = out.skins[0].attachments.hit.box;
  assert.equal(box.type, "boundingbox");
  assert.equal(box.vertexCount, 3);
  assert.equal(box.color, "ff0000ff");
  const back = importSpineData(out, { name: "t", resolveImage: () => null }).model;
  back.boundingBoxes!.box.vertices.forEach((v, i) => v.forEach((x, k) => near(x, b.vertices[i][k])));
  // bones a box uses cannot be removed; a renamed bone follows; errors are clear
  const rehomed = applyOps(model, [{ op: "updateSlot", id: "hit", bone: "root" }] as Op[]).model;
  assert.throws(() => applyOps(rehomed, [{ op: "removeBone", id: "b" }] as Op[]), /bounding box box/);
  const renamed = applyOps(model, [{ op: "renameBone", id: "b", to: "c" }] as Op[]).model;
  assert.equal(renamed.boundingBoxes!.box.weights[0][0][0], "c");
  assert.throws(() => applyOps(model, [{ op: "updateBoundingBox", id: "box", vertices: [[0, 0]] }] as Op[]), /3 or more/);
  assert.throws(() => applyOps(model, [{ op: "updateBoundingBox", id: "nope", color: null }] as Op[]), /unknown bounding box/);
  const gone = applyOps(model, [{ op: "removeAttachment", id: "box" }] as Op[]).model;
  assert.equal(gone.boundingBoxes, undefined);
});
