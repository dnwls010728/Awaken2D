import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, emptyModel } from "../src/core/index.ts";
import { decodePNG, encodePNG, renderPose, renderSheet } from "../src/render/index.ts";

test("PNG encode/decode round-trip", () => {
  const data = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 0xff);
  const img = decodePNG(encodePNG({ width: 3, height: 2, data }));
  assert.equal(img.width, 3);
  assert.deepEqual([...img.data], [...data]);
});

test("renders a solid mesh and a textured mesh", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-"));
  // 2x2 texture: red, green / blue, white
  const tex = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  writeFileSync(join(dir, "tex.png"), encodePNG({ width: 2, height: 2, data: tex }));
  const { model } = applyOps(emptyModel("t"), [
    { op: "addImage", id: "tex", path: "tex.png" },
    { op: "addMesh", id: "quad", shape: { rect: { x: 0, y: 0, width: 100, height: 100 } }, image: "tex" },
  ]);
  const img = renderPose(model, dir, { width: 100, height: 100, padding: 0, supersample: 1, background: "#000000" });
  const px = (x: number, y: number) => [...img.data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)];
  assert.deepEqual(px(10, 10), [255, 0, 0]); // top-left texel
  assert.deepEqual(px(90, 90), [255, 255, 255]); // bottom-right texel
});

test("clipping: a clipped slot only draws inside its mask slot's current shape", () => {
  const { model } = applyOps(emptyModel("t"), [
    { op: "addMesh", id: "mask", shape: { rect: { x: 0, y: 0, width: 50, height: 100 } }, color: "#0000ff" },
    { op: "addMesh", id: "paint", shape: { rect: { x: 0, y: 0, width: 100, height: 100 } }, color: "#ff0000" },
    { op: "updateSlot", id: "paint", clip: "mask" },
  ]);
  const img = renderPose(model, ".", { width: 100, height: 100, padding: 0, supersample: 1, background: "#ffffff" });
  const px = (x: number, y: number) => [...img.data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)];
  assert.deepEqual(px(25, 50), [255, 0, 0], "inside the mask: the clipped paint");
  assert.deepEqual(px(75, 50), [255, 255, 255], "outside the mask: nothing");
  assert.throws(() => applyOps(model, [{ op: "updateSlot", id: "paint", clip: "paint" }]), /cannot clip itself/);
});

test("sheet has one cell per frame", () => {
  const { model } = applyOps(emptyModel("t"), [
    { op: "addBone", id: "b", start: [0, 0], end: [50, 0] },
    { op: "addMesh", id: "m", shape: { rect: { x: 0, y: -5, width: 50, height: 10 } }, color: "#00ff00", bones: ["b"] },
    { op: "setAnimation", name: "spin", duration: 1 },
    { op: "setKeys", animation: "spin", bone: "b", channel: "rotate", keys: [{ t: 0, v: 0 }, { t: 1, v: 360 }] },
  ]);
  const img = renderSheet(model, ".", { animation: "spin", frames: 6, cols: 3, cellSize: 64, overlay: { bones: true, names: true } });
  assert.ok(img.width > 3 * 60 && img.height > 2 * 60);
});
