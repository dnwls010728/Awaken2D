import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, computePose, validateModel } from "../src/core/index.ts";
import { importLayers, proposeBones, readLayerSource, readPsd, writePsd } from "../src/import/index.ts";
import type { LayerSource, PsdWriteLayer } from "../src/import/index.ts";
import { encodePNG } from "../src/render/index.ts";

function solid(name: string, left: number, top: number, w: number, h: number, rgb: [number, number, number], extra: Partial<PsdWriteLayer> = {}): PsdWriteLayer {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { name, left, top, width: w, height: h, rgba, ...extra };
}

/** Stick figure as plain rectangles, top-left pixel coordinates (y down). */
function figure(): PsdWriteLayer[] {
  return [
    solid("leg L", 108, 150, 12, 90, [40, 40, 90]),
    solid("leg R", 80, 150, 12, 90, [40, 40, 90]),
    solid("body", 75, 70, 50, 85, [200, 80, 60], { groups: ["Body"] }),
    solid("머리", 70, 10, 60, 60, [240, 200, 160], { groups: ["Head"] }),
    solid("eye L", 108, 35, 6, 8, [0, 0, 0], { groups: ["Head"] }),
    solid("upper arm L", 127, 72, 10, 40, [240, 200, 160], { groups: ["Arm L"] }),
    solid("forearm L", 128, 112, 9, 38, [240, 200, 160], { groups: ["Arm L"] }),
    solid("arm R", 62, 72, 11, 78, [240, 200, 160]),
    solid("sketch", 0, 0, 10, 10, [0, 0, 255], { hidden: true }),
  ];
}

test("PSD write/read round-trip keeps names, groups, visibility, opacity and pixels", () => {
  const layers = [
    solid("back", 0, 0, 4, 3, [255, 0, 0]),
    solid("얼굴", 2, 1, 3, 2, [0, 255, 0], { groups: ["Head", "Face"], opacity: 0.5 }),
    solid("eye", 1, 1, 1, 1, [0, 0, 255], { groups: ["Head"] }),
    solid("hidden", 0, 0, 2, 2, [9, 9, 9], { hidden: true }),
  ];
  const doc = readPsd(writePsd({ width: 8, height: 6, layers }));
  assert.equal(doc.width, 8);
  assert.deepEqual(
    doc.layers.map((l) => [l.name, l.groups.join("/"), l.visible]),
    [
      ["back", "", true],
      ["얼굴", "Head/Face", true],
      ["eye", "Head", true],
      ["hidden", "", false],
    ],
  );
  const face = doc.layers[1];
  assert.equal(face.left, 2);
  assert.equal(face.width, 3);
  assert.ok(Math.abs(face.opacity - 0.5) < 0.01);
  assert.deepEqual([...face.rgba.subarray(0, 4)], [0, 255, 0, 255]);
});

test("PSD reader rejects non-PSD input with a clear message", () => {
  assert.throws(() => readPsd(new Uint8Array(40)), /not a PSD file/);
});

test("importLayers writes cropped PNGs, maps pixels to world, and meshes only solid cells", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-imp-"));
  // L-shaped layer: the empty quadrant must not get triangles
  const w = 40;
  const h = 40;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 20 || y >= 20) rgba.set([255, 255, 255, 255], (y * w + x) * 4);
  const src: LayerSource = {
    source: "test.psd",
    width: 100,
    height: 100,
    layers: [{ name: "L shape", groups: [], left: 30, top: 60, width: w, height: h, rgba, visible: true, opacity: 1 }],
    warnings: [],
  };
  const { model } = importLayers(src, join(dir, "m.rig.json"), { spacing: 10 });
  const att = model.attachments.L_shape;
  assert.ok(att, "slot id derived from layer name");
  // 16 cells; the empty quadrant's cells that touch the art (within the 1px filter margin) are kept,
  // only its far corner cell is dropped
  assert.equal(att.triangles.length, 15 * 2);
  assert.ok(existsSync(join(dir, "images/L_shape.png")));
  // origin "content" = bottom-center of the art => feet at y = 0, centered on x = 0
  const xs = att.vertices.map((v) => v[0]);
  const ys = att.vertices.map((v) => v[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [-20, 20, 0, 40]);
  assert.deepEqual(validateModel(model, { baseDir: dir }).filter((i) => i.level === "error"), []);
});

test("PSD import + proposed skeleton rigs a figure sensibly", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-fig-"));
  const psd = join(dir, "fig.psd");
  writeFileSync(psd, writePsd({ width: 200, height: 250, layers: figure() }));
  const imported = importLayers(readLayerSource(psd), join(dir, "fig.rig.json"));
  assert.ok(!imported.model.slots.some((s) => s.id === "sketch"), "hidden layer skipped");
  const p = proposeBones(imported.model);
  const { model } = applyOps(imported.model, p.ops);
  const ids = new Set(model.bones.map((b) => b.id));
  for (const id of ["hip", "torso", "head", "upper_arm_l", "lower_arm_l", "upper_arm_r", "lower_arm_r", "thigh_l", "shin_l", "thigh_r", "shin_r"]) {
    assert.ok(ids.has(id), `missing bone ${id}; got ${[...ids].join(", ")}`);
  }
  const parent = (id: string) => model.bones.find((b) => b.id === id)?.parent;
  assert.equal(parent("lower_arm_l"), "upper_arm_l");
  assert.equal(parent("head"), "torso");
  assert.equal(model.slots.find((s) => s.id === "eye_L")?.bone, "head");
  assert.equal(model.slots.find((s) => s.id === "머리")?.bone, "head", "Korean layer name classified");
  // the upper arm hangs down: its bone starts at the shoulder (top) end
  const ua = computePose(model).byId.get("upper_arm_l")!;
  assert.ok(ua.world[5] > 150, `shoulder should be high, got y=${ua.world[5]}`);
  assert.deepEqual(validateModel(model, { baseDir: dir }).filter((i) => i.level === "error"), []);
});

test("proposal with ik adds limb IK that keeps the setup pose and bends knees outward", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-ik-"));
  const psd = join(dir, "fig.psd");
  writeFileSync(psd, writePsd({ width: 200, height: 250, layers: figure() }));
  const imported = importLayers(readLayerSource(psd), join(dir, "fig.rig.json"));
  const { model } = applyOps(imported.model, proposeBones(imported.model, { ik: true }).ops);
  assert.deepEqual(model.ik!.map((c) => c.id).sort(), ["arm_l_ik", "arm_r_ik", "leg_l_ik", "leg_r_ik"]);
  const raw = computePose(model);
  const solved = computePose(model, null, 0, { constraints: true });
  for (const id of ["lower_arm_l", "shin_r"]) {
    const a = raw.byId.get(id)!.world;
    const b = solved.byId.get(id)!.world;
    // near-straight chains are sensitive to the target's rounded position; a fraction of a unit is fine
    assert.ok(Math.hypot(a[4] - b[4], a[5] - b[5]) < 0.5, `${id} moved when IK was applied to the setup pose`);
  }
  // crouch: drop the hip with feet planted; the left knee (character's left, +x) must go outward
  const crouched = applyOps(model, [
    { op: "setAnimation", name: "c", duration: 1 },
    { op: "setKeys", animation: "c", bone: "hip", channel: "translate", keys: [{ t: 0, v: [0, -30] }] },
  ]).model;
  const knee = computePose(crouched, "c", 0, { constraints: true }).byId.get("shin_l")!.world[4];
  const kneeBefore = raw.byId.get("shin_l")!.world[4];
  assert.ok(knee > kneeBefore + 3, `left knee should move outward: ${kneeBefore} -> ${knee}`);
});

test("proposal with physics turns a tail layer into a spring chain", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-phys-"));
  const psd = join(dir, "fig.psd");
  writeFileSync(psd, writePsd({ width: 200, height: 250, layers: [solid("tail", 125, 140, 60, 8, [120, 80, 40]), ...figure()] }));
  const imported = importLayers(readLayerSource(psd), join(dir, "fig.rig.json"));
  const { model } = applyOps(imported.model, proposeBones(imported.model, { physics: true }).ops);
  assert.deepEqual(model.physics?.map((c) => [c.id, c.bones]), [["tail_spring", ["tail_1", "tail_2", "tail_3"]]]);
  assert.equal(model.bones.find((b) => b.id === "tail_1")?.parent, "hip");
  assert.deepEqual(validateModel(model, { baseDir: dir }).filter((i) => i.level === "error"), []);
});

test("PNG folder import honors layers.json order and offsets", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-png-"));
  const art = join(dir, "art");
  mkdirSync(art);
  const px = (rgb: number[]) => ({ width: 2, height: 2, data: new Uint8Array(Array(4).fill([...rgb, 255]).flat()) });
  writeFileSync(join(art, "a.png"), encodePNG(px([255, 0, 0])));
  writeFileSync(join(art, "b.png"), encodePNG(px([0, 255, 0])));
  writeFileSync(join(art, "layers.json"), JSON.stringify([{ file: "b.png", name: "back", x: 5, y: 5 }, { file: "a.png", name: "front" }]));
  const src = readLayerSource(art);
  assert.deepEqual(src.layers.map((l) => [l.name, l.left]), [["back", 5], ["front", 0]]);
  const { model } = importLayers(src, join(dir, "m.rig.json"));
  assert.deepEqual(model.slots.map((s) => s.id), ["back", "front"]);
});
