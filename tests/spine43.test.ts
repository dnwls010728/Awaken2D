import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, computePose, drawList, loadModel, saveModel } from "../src/core/index.ts";
import type { RGBAImage } from "../src/render/png.ts";
import { addEventSound, exportSpine, exportSpineData, extractRegion, findAtlas, importSpine, importSpineData, parseAtlas } from "../src/spine/index.ts";
import type { Op } from "../src/core/index.ts";
import { imageOf, skeleton } from "./spine-fixture.ts";
import { spinePose } from "./spine-reference.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The fixture in Spine 4.3's layout: one "constraints" array (typed, in evaluation order), a physics constraint. */
function skeleton43(): any {
  const j = skeleton();
  j.skeleton.spine = "4.3.75-beta";
  j.skeleton.audio = null;
  const { order: _t, ...t1 } = j.transform[0];
  const { order: _i, ...reach } = j.ik[0];
  j.constraints = [
    { type: "transform", ...t1 },
    { type: "physics", name: "sway", bone: "arm", rotate: 1, limit: 7000 },
    { type: "ik", ...reach },
  ];
  delete j.transform;
  delete j.ik;
  // a curve between two equal values that bulges (Spine's graph editor makes these for a bump)
  j.animations.move.bones.arm.rotate = [{ value: 0, curve: [0.2, 30, 0.4, 30] }, { time: 0.6, value: 0 }];
  j.animations.move.physics = { sway: { wind: [{ value: 2 }] } };
  return j;
}

test("Spine 4.3: the constraints array round trips in order, other timelines kept, null audio kept", () => {
  const src = skeleton43();
  const { model, warnings } = importSpineData(src, { name: "t", resolveImage: imageOf });
  assert.equal(model.ik?.[0].id, "reach", "IK from the constraints array is evaluated");
  assert.deepEqual(model.constraintOrder, ["transform:t1", "physics:sway", "ik:reach"], "Spine's evaluation order");
  assert.equal(model.spinePhysics?.[0].limit, 7000);
  assert.deepEqual(model.animations!.move.spinePhysics!.sway.wind, [{ t: 0, v: 2 }]);
  assert.ok(!warnings.some((w) => /constraint/.test(w)), "constraints are evaluated, not just kept");
  const out = exportSpineData(model, { name: "t", loadImage: imageOf }).json;
  assert.deepEqual(out.constraints, src.constraints);
  for (const k of ["ik", "transform", "path", "physics", "slider"]) assert.equal(out[k], undefined, `no top-level ${k} in 4.3 data`);
  assert.deepEqual(out.animations.move.physics, src.animations.move.physics);
  assert.equal(out.skeleton.audio, null);
  assert.deepEqual(Object.keys(out).slice(0, 4), ["skeleton", "bones", "slots", "constraints"]);
});

test("a curve bulging between equal values poses like Spine and exports as written", () => {
  const src = skeleton43();
  const { model: full } = importSpineData(src, { name: "t", resolveImage: imageOf });
  // the reference has no transform constraints
  const model = { ...full, transforms: undefined };
  const setup = computePose(model);
  for (const t of [0.1, 0.2, 0.3, 0.45]) {
    const pose = computePose(model, "move", t);
    const ours = new Map(drawList(model, pose, setup).map((it) => [it.slot, it.positions]));
    const ref = spinePose(src, "move", t).get("arm")!;
    const err = Math.max(...ref.map((p, i) => Math.hypot(p[0] - ours.get("arm")![i][0], p[1] - ours.get("arm")![i][1])));
    // the bulge is cut into two curves, which Spine's 10-segment sampling follows slightly differently
    assert.ok(err < 0.25, `arm at t=${t}: ${err}`);
  }
  const out = exportSpineData(model, { name: "t", loadImage: imageOf }).json;
  assert.deepEqual(out.animations.move.bones.arm.rotate, src.animations.move.bones.arm.rotate);
});

test("atlas regions rotated 180 and 270 degrees are cut upright", () => {
  // a 2x3 image with a distinct value per pixel; packed upside down (180) and turned clockwise (270)
  const W = 2;
  const H = 3;
  const val = (ox: number, oy: number) => 10 + oy * W + ox;
  const page = (deg: number): RGBAImage => {
    const pw = deg === 270 ? H : W;
    const ph = deg === 270 ? W : H;
    const data = new Uint8Array(pw * ph * 4);
    for (let oy = 0; oy < H; oy++) {
      for (let ox = 0; ox < W; ox++) {
        const [px, py] = deg === 180 ? [W - 1 - ox, H - 1 - oy] : [H - 1 - oy, ox];
        data.set([val(ox, oy), 0, 0, 255], (py * pw + px) * 4);
      }
    }
    return { width: pw, height: ph, data };
  };
  for (const deg of [180, 270]) {
    const [p] = parseAtlas(`p.png\nsize:4,4\nimg\nbounds:0,0,${W},${H}\nrotate:${deg}\n`);
    const img = extractRegion(page(deg), false, p.regions[0]);
    for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) assert.equal(img.data[(oy * W + ox) * 4], val(ox, oy), `rotate ${deg}: pixel ${ox},${oy}`);
  }
  assert.throws(() => parseAtlas("p.png\nsize:4,4\nimg\nbounds:0,0,1,1\nrotate:45\n"), /not supported/);
});

test("findAtlas picks the atlas sharing the skeleton's name, straight alpha before -pma", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-atlas-"));
  try {
    for (const f of ["hero-pro.json", "hero-pma.atlas", "hero.atlas", "other.atlas"]) writeFileSync(join(dir, f), "");
    assert.equal(findAtlas(join(dir, "hero-pro.json")), join(dir, "hero.atlas"));
    writeFileSync(join(dir, "hero-pro.atlas"), "");
    assert.equal(findAtlas(join(dir, "hero-pro.json")), join(dir, "hero-pro.atlas"), "the exact name wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findAtlas prefers the atlas holding the skeleton's images (an export folder with several atlases)", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-atlas-"));
  const atlas = (...regions: string[]) => `p.png
size:8,8
${regions.map((r) => `${r}
bounds:0,0,1,1
`).join("")}`;
  try {
    const json = { skins: [{ name: "default", attachments: { a: { head: {}, arm: { type: "mesh", path: "limbs/arm" } }, b: { bb: { type: "boundingbox" } } } }] };
    writeFileSync(join(dir, "boy-pro.json"), JSON.stringify(json));
    writeFileSync(join(dir, "boy-run.atlas"), atlas("head"));
    writeFileSync(join(dir, "boy.atlas"), atlas("head", "limbs/arm", "bb"));
    assert.equal(findAtlas(join(dir, "boy-pro.json"), json), join(dir, "boy.atlas"));
    assert.equal(findAtlas(join(dir, "boy-pro.json")), join(dir, "boy-run.atlas"), "without the skeleton: by name only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("event sounds: found in the skeleton's audio folder, copied next to the model on import and into the export", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-audio-"));
  try {
    // Spine's layout: project/export/x.json, project/audio/...
    mkdirSync(join(dir, "export"));
    mkdirSync(join(dir, "audio", "fx"), { recursive: true });
    writeFileSync(join(dir, "audio", "fx", "step.wav"), "RIFF");
    const json = {
      skeleton: { spine: "4.2.43", audio: "./audio/" },
      bones: [{ name: "root" }],
      events: { step: { audio: "fx/step.wav", volume: 0.5 }, gone: { audio: "nope.ogg" }, evil: { audio: "../../x.wav" } },
      animations: { walk: { events: [{ time: 0.5, name: "step", balance: -1 }] } },
    };
    writeFileSync(join(dir, "export", "x.json"), JSON.stringify(json));
    const res = importSpine(join(dir, "export", "x.json"), join(dir, "model", "x.rig.json"));
    assert.equal(readFileSync(join(dir, "model", "audio", "fx", "step.wav"), "utf8"), "RIFF");
    assert.ok(res.warnings.some((w) => w.includes("nope.ogg") && w.includes("not found")));
    assert.ok(!existsSync(join(dir, "x.wav")), "paths outside the audio folder are not copied");
    const out = exportSpine(join(dir, "model", "x.rig.json"), join(dir, "out"));
    assert.equal(readFileSync(join(dir, "out", "audio", "fx", "step.wav"), "utf8"), "RIFF");
    assert.ok(out.files.some((f) => f.startsWith("audio/")));
    assert.equal(out.json.events.step.audio, "fx/step.wav");
    assert.equal(out.json.animations.walk.events[0].balance, -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a picked sound is copied into the model's audio/ folder (same file reused, another one renamed) and exported", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-sound-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "step.wav"), "RIFF-1");
    writeFileSync(join(dir, "src", "other.wav"), "RIFF-2");
    mkdirSync(join(dir, "src", "b"));
    writeFileSync(join(dir, "src", "b", "step.wav"), "RIFF-3");
    const modelDir = join(dir, "m");
    assert.equal(addEventSound(join(dir, "src", "step.wav"), modelDir), "step.wav");
    assert.equal(addEventSound(join(dir, "src", "step.wav"), modelDir), "step.wav", "the same file again: reused");
    assert.equal(addEventSound(join(dir, "src", "b", "step.wav"), modelDir), "step-2.wav", "another file with that name");
    assert.throws(() => addEventSound(join(dir, "src"), modelDir), /.wav/);
    // an event of a skeleton without an audio folder: the export points it at audio/
    const { model } = importSpineData({ skeleton: { spine: "4.2.43", audio: null }, bones: [{ name: "root" }], events: { step: {} } }, { name: "t", resolveImage: () => null });
    const withSound = applyOps(model, [{ op: "setEvent", name: "step", audio: "step.wav" }] as Op[]).model;
    saveModel(join(modelDir, "t.rig.json"), withSound);
    const out = exportSpine(join(modelDir, "t.rig.json"), join(dir, "out"));
    assert.equal(out.json.skeleton.audio, "./audio/");
    assert.equal(readFileSync(join(dir, "out", "audio", "step.wav"), "utf8"), "RIFF-1");
    // removing the sound: an empty path clears it
    const silent = applyOps(withSound, [{ op: "setEvent", name: "step", audio: "" }] as Op[]).model;
    assert.equal(silent.events!.step.audio, undefined);
    assert.ok(loadModel(join(modelDir, "t.rig.json")).model.events!.step.audio);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
