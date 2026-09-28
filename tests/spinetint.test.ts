import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, computePose, drawList, emptyModel, normalizeModel, serializeModel, validateModel } from "../src/core/index.ts";
import type { Model, Op } from "../src/core/index.ts";
import { renderPose } from "../src/render/index.ts";
import { exportSpineData, importSpineData } from "../src/spine/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

/** Spine data: a clipping slot "c" (triangle, clips up to "s"), a region on "s" with a dark color keyed by rgba2, one after it. */
function spineJson(): any {
  return {
    skeleton: { spine: "4.2.43" },
    bones: [{ name: "root" }],
    slots: [
      { name: "c", bone: "root", attachment: "clip" },
      { name: "s", bone: "root", attachment: "box", dark: "101010" },
      { name: "after", bone: "root", attachment: "box" },
    ],
    skins: [
      {
        name: "default",
        attachments: {
          c: { clip: { type: "clipping", end: "s", vertexCount: 3, vertices: [0, 0, 10, 0, 0, 10], color: "ce3a3aff" } },
          s: { box: { x: 5, y: 5, width: 10, height: 10 } },
          after: { box: { x: 5, y: 5, width: 10, height: 10 } },
        },
      },
    ],
    animations: {
      a: {
        slots: {
          s: {
            rgba2: [
              { light: "ff0000ff", dark: "000000" },
              { time: 1, light: "00ff00ff", dark: "ffffff" },
            ],
          },
        },
      },
    },
  };
}

test("Spine two-color tint: slot dark color and rgba2 keys pose, and round-trip (as written, or rebuilt after an edit)", () => {
  const json = spineJson();
  const { model } = importSpineData(structuredClone(json), { name: "t", resolveImage: () => null });
  const s = model.slots.find((x) => x.id === "s")!;
  assert.equal(s.dark, "#101010");
  const mid = computePose(model, "a", 0.5).slots.find((x) => x.id === "s")!;
  near(mid.color[0], 0.5);
  near(mid.color[1], 0.5);
  mid.dark!.forEach((v) => near(v, 0.5));
  // setup: the slot's dark color; slots without one have none
  const setup = computePose(model);
  near(setup.slots.find((x) => x.id === "s")!.dark![0], 0x10 / 255);
  assert.equal(setup.slots.find((x) => x.id === "after")!.dark, undefined);
  assert.equal(drawList(model, setup).find((x) => x.slot === "s")!.dark!.length, 3);
  // unedited: exactly what came in
  const out = exportSpineData(model, { name: "t", loadImage: () => null }).json;
  assert.deepEqual(out.animations.a.slots.s, json.animations.a.slots.s);
  assert.equal(out.slots.find((x: any) => x.name === "s").dark, "101010");
  // edited: rgba2 at the union of the color and dark key times, the same pose after re-import
  const edited = applyOps(model, [{ op: "setSlotKeys", animation: "a", slot: "s", channel: "dark", keys: [{ t: 0.5, v: "#ff0000" }], mode: "merge" }] as Op[]).model;
  const out2 = exportSpineData(edited, { name: "t", loadImage: () => null }).json;
  assert.equal(out2.animations.a.slots.s.rgba2.length, 3);
  const back = importSpineData(out2, { name: "t", resolveImage: () => null }).model;
  for (const t of [0.25, 0.5, 0.75]) {
    const x = computePose(edited, "a", t).slots.find((q) => q.id === "s")!;
    const y = computePose(back, "a", t).slots.find((q) => q.id === "s")!;
    x.color.forEach((v, i) => near(v, y.color[i], 3e-3));
    x.dark!.forEach((v, i) => near(v, y.dark![i], 3e-3));
  }
  // save / load keeps it
  const again = normalizeModel(JSON.parse(serializeModel(edited)));
  assert.equal(again.slots.find((x) => x.id === "s")!.dark, "#101010");
  assert.equal(again.animations!.a.slots!.s.dark!.length, 3);
  // ops: set / clear the dark color; Live2D models refuse it
  const cleared = applyOps(edited, [{ op: "updateSlot", id: "s", dark: null }] as Op[]).model;
  assert.equal(cleared.slots.find((x) => x.id === "s")!.dark, undefined);
  assert.ok(validateModel(cleared, { poseSamples: 0 }).some((i) => i.level === "warning" && i.path.endsWith(".dark")));
  assert.throws(() => applyOps(emptyModel("l", "live2d"), [{ op: "updateSlot", id: "x", dark: "#000000" }] as Op[]), /Spine feature/);
});

test("Spine clipping attachments: import, the slots they clip (up to the end slot), round-trip and the updateClipping op", () => {
  const json = spineJson();
  const { model } = importSpineData(structuredClone(json), { name: "t", resolveImage: () => null });
  assert.deepEqual(Object.keys(model.clippings ?? {}), ["clip"]);
  assert.equal(model.clippings!.clip.end, "s");
  assert.equal(model.slots.find((x) => x.id === "c")!.attachment, "clip");
  const items = drawList(model, computePose(model));
  assert.deepEqual(items.map((x) => x.slot), ["s", "after"], "the clipping attachment itself is not drawn");
  assert.deepEqual(items[0].clipPolygon, [[0, 0], [10, 0], [0, 10]]);
  assert.equal(items[1].clipPolygon, undefined, "after the end slot: not clipped");
  assert.deepEqual(validateModel(model, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  const out = exportSpineData(model, { name: "t", loadImage: () => null }).json;
  assert.deepEqual(out.skins[0].attachments.c, json.skins[0].attachments.c);
  // updateClipping: to the end of the draw order, inverse; the export follows
  const m2 = applyOps(model, [{ op: "updateClipping", id: "clip", end: null, inverse: true }] as Op[]).model;
  const items2 = drawList(m2, computePose(m2));
  assert.ok(items2.every((x) => x.clipPolygon && x.clipOutside));
  const clip2 = exportSpineData(m2, { name: "t", loadImage: () => null }).json.skins[0].attachments.c.clip;
  assert.equal(clip2.end, undefined);
  assert.equal(clip2.inverse, true);
  assert.deepEqual(clip2.vertices, [0, 0, 10, 0, 0, 10]);
  // removing the end slot clips to the end; bones used by the polygon cannot be removed
  const m3 = applyOps(model, [{ op: "removeSlot", id: "s" }] as Op[]).model;
  assert.equal(m3.clippings!.clip.end, undefined);
  const m4 = applyOps(model, [{ op: "renameSlot", id: "s", to: "s2" }] as Op[]).model;
  assert.equal(m4.clippings!.clip.end, "s2");
});

test("renders Spine clipping (inside, or outside when inverse) and the two-color tint", () => {
  let model: Model = applyOps(emptyModel("t", "spine"), [
    { op: "addMesh", id: "paint", shape: { rect: { x: 0, y: 0, width: 100, height: 100 } }, color: "#ff0000" },
    { op: "addSlot", id: "c", bone: "root", index: 0 },
  ] as Op[]).model;
  model = { ...model, clippings: { half: { vertices: [[0, 0], [50, 0], [50, 100], [0, 100]], weights: [[], [], [], []], end: "paint" } } };
  model = applyOps(model, [{ op: "updateSlot", id: "c", attachment: "half" }] as Op[]).model;
  const px = (m: Model, x: number, y: number) => {
    const img = renderPose(m, ".", { width: 100, height: 100, padding: 0, supersample: 1, background: "#ffffff", view: { minX: 0, minY: 0, maxX: 100, maxY: 100 } });
    return [...img.data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)];
  };
  assert.deepEqual(px(model, 25, 50), [255, 0, 0]);
  assert.deepEqual(px(model, 75, 50), [255, 255, 255]);
  const inv = applyOps(model, [{ op: "updateClipping", id: "half", inverse: true }] as Op[]).model;
  assert.deepEqual(px(inv, 25, 50), [255, 255, 255]);
  assert.deepEqual(px(inv, 75, 50), [255, 0, 0]);
  // an untextured mesh is "white" texture: the dark color does not show (tex - rgb = 0), the light color does
  const dark = applyOps(model, [{ op: "updateSlot", id: "paint", dark: "#00ff00" }] as Op[]).model;
  assert.deepEqual(px(dark, 25, 50), [255, 0, 0]);
});
