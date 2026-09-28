import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, computePose, drawList, validateModel } from "../src/core/index.ts";
import type { Model } from "../src/core/index.ts";
import type { RGBAImage } from "../src/render/png.ts";
import { exportSpineData, extractRegion, importSpineData, packAtlas, parseAtlas, writeAtlas } from "../src/spine/index.ts";
import { IMAGES, imageOf, skeleton } from "./spine-fixture.ts";
import { spinePose, spineSlotColors } from "./spine-reference.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

function imported() {
  return importSpineData(skeleton(), { name: "t", resolveImage: imageOf });
}

/**
 * Max distance between the reference Spine evaluation of `json` and the model, over the animation. The reference
 * has no constraints but IK, so the model's transform constraints are left out here (the official runtime checks
 * them: work/tools/spine-rt-compare.ts).
 */
function maxError(json: any, full: Model, anim: string | null): { verts: number; color: number } {
  const model: Model = { ...full, transforms: undefined };
  const setup = computePose(model);
  let verts = 0;
  let color = 0;
  const dur = anim ? model.animations![anim].duration : 0;
  for (let f = 0; f <= (anim ? 40 : 0); f++) {
    const t = anim ? Math.min((dur * f) / 40, dur - 1e-6) : 0;
    const pose = computePose(model, anim, t);
    const items = new Map(drawList(model, pose, setup).map((it) => [it.slot, it.positions]));
    for (const [slot, pts] of spinePose(json, anim, t)) {
      const ours = items.get(slot);
      assert.ok(ours, `${slot} is drawn at t=${t}`);
      for (const p of pts) verts = Math.max(verts, Math.min(...ours!.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))));
    }
    for (const [slot, c] of spineSlotColors(json, anim, t)) {
      const ours = pose.slots.find((s) => s.id === slot)!.color;
      color = Math.max(color, ...c.map((v, i) => Math.abs(v - ours[i])));
    }
  }
  return { verts, color };
}

test("spine import poses exactly like Spine (shear, weighted + unweighted meshes, regions, curves, deform, colors)", () => {
  const res = imported();
  const m = res.model;
  assert.equal(m.bones.find((b) => b.id === "chest")!.shearX, 8);
  assert.deepEqual(Object.keys(m.attachments).sort(), ["alt/hat/hat2", "arm", "body", "hat"]);
  assert.deepEqual(m.skins, { alt: { attachments: { hat: { hat2: "alt/hat/hat2" } } } }, "other skins are imported");
  assert.equal(m.slots.find((s) => s.id === "hat")!.blend, "additive");
  assert.equal(m.animations!.move.events!.length, 2);
  assert.deepEqual(m.animations!.move.drawOrder![0], { t: 0.4, offsets: [["body", 2]] });
  assert.ok(m.animations!.move.deform!.body[1].local, "Spine's per-influence deltas are kept");
  for (const anim of [null, "move"]) {
    const e = maxError(skeleton(), m, anim);
    assert.ok(e.verts < 1e-3, `${anim ?? "setup"}: vertices within 0.001 (got ${e.verts})`);
    assert.ok(e.color < 1e-3, `${anim ?? "setup"}: slot colors match (got ${e.color})`);
  }
  assert.equal(m.transforms?.[0].source, "chest", "transform constraints are imported");
  assert.ok(!res.warnings.some((w) => /boundingbox/.test(w)) && Object.keys(m.boundingBoxes ?? {}).length === 1, "bounding boxes are imported");
  assert.deepEqual(validateModel(m, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
});

test("spine export of an unedited import gives the original data back", () => {
  const m = imported().model;
  const out = exportSpineData(m, { name: "t", loadImage: imageOf }).json;
  const src = skeleton();
  const near = (a: any, b: any, path: string): void => {
    if (typeof a === "number" && typeof b === "number") return assert.ok(Math.abs(a - b) < 1e-3, `${path}: ${a} vs ${b}`);
    if (a && typeof a === "object") {
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b ?? {}).sort(), `${path} keys`);
      for (const k of Object.keys(a)) near(a[k], b[k], `${path}.${k}`);
      return;
    }
    assert.equal(a, b, path);
  };
  for (const k of ["bones", "slots", "skins", "events", "animations", "transform"]) near(src[k], out[k], k);
  assert.equal(out.ik[0].name, "reach");
  assert.equal(out.skeleton.spine, "4.2.43");
});

test("spine export of an edited model poses like the model (regenerated meshes, deforms, shear keys)", () => {
  const m = applyOps(imported().model, [
    { op: "updateBone", id: "arm", rotation: 150, carry: true },
    { op: "addVertex", attachment: "body", at: [-12, 42] },
    { op: "setDeformKeys", animation: "move", attachment: "arm", keys: [{ t: 0.6, transform: { translate: [2, 1] } }], mode: "merge" },
    { op: "setKeys", animation: "move", bone: "hip", channel: "shear", keys: [{ t: 0, v: [0, 0] }, { t: 1, v: [10, 5], ease: "easeInOut" }] },
    { op: "updateSlot", id: "body", color: "#ff000080" },
  ]).model;
  const res = exportSpineData(m, { name: "t", loadImage: imageOf });
  // the edited mesh is regenerated: hull first, weighted per bone
  const body = res.json.skins[0].attachments.body.body;
  assert.equal(body.uvs.length / 2, 6);
  assert.ok(body.hull >= 3);
  for (const anim of [null, "move"]) {
    const e = maxError(res.json, m, anim);
    assert.ok(e.verts < 2e-3, `${anim ?? "setup"}: exported data within 0.002 of the model (got ${e.verts})`);
    assert.ok(e.color < 1e-3);
  }
});

test("spine atlases: parse 4.x and 3.x, cut rotated / stripped / premultiplied regions, pack and write back", () => {
  const page: RGBAImage = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) };
  const set = (x: number, y: number, v: number[]) => page.data.set(v, (y * 8 + x) * 4);
  // a 3x2 image, stripped to 2x2 (offset x 1), packed rotated at (0,0): original pixel (ox, oy) sits at
  // page (oy, width - 1 - ox), premultiplied
  set(0, 1, [100, 50, 0, 200]); // stripped (0,0) -> original (1,0)
  set(1, 0, [10, 20, 30, 255]); // stripped (1,1) -> original (2,1)
  const four = parseAtlas("p.png\nsize:8,8\npma:true\nimg\nbounds:0,0,2,2\noffsets:1,0,3,2\nrotate:90\n");
  const three = parseAtlas("p.png\nsize: 8,8\nformat: RGBA8888\nimg\n  rotate: true\n  xy: 0, 0\n  size: 2, 2\n  orig: 3, 2\n  offset: 1, 0\n  index: -1\n");
  assert.deepEqual(three[0].regions[0], { ...four[0].regions[0], extra: {} });
  const img = extractRegion(page, true, four[0].regions[0]);
  assert.equal(img.width, 3);
  const px = (x: number, y: number) => [...img.data.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4)];
  assert.deepEqual(px(1, 0), [128, 64, 0, 200], "un-premultiplied");
  assert.deepEqual(px(2, 1), [10, 20, 30, 255]);
  assert.deepEqual(px(0, 0), [0, 0, 0, 0], "stripped whitespace restored");
  // pack + write + parse + cut gives the same images back
  const images = new Map(Object.keys(IMAGES).map((n) => [n, imageOf(n)!]));
  const packed = packAtlas(images, { name: "t.png" });
  const again = parseAtlas(writeAtlas([packed.page]));
  for (const r of again[0].regions) assert.deepEqual(extractRegion(packed.image, false, r).data, images.get(r.name)!.data);
});
