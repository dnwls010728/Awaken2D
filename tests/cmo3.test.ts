import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync, constants } from "node:zlib";
import { loadModel, validateModel } from "../src/core/index.ts";
import type { RotationDeformer, WarpDeformer } from "../src/core/index.ts";
import { live2dFrame } from "../src/core/live2d.ts";
import { readCaff } from "../src/live2d/caff.ts";
import { cmo3ToModel, parseXml } from "../src/live2d/cmo3.ts";
import { exportLive2DData, importLive2D, writeMoc3 } from "../src/live2d/index.ts";
import { can3Fixture, cmo3Fixture } from "./cmo3-fixture.ts";
import { can3ToMotions } from "../src/live2d/can3.ts";
import { pathAt, pathMoves, pathPoints, remapPaths } from "../src/core/live2dpath.ts";
import { applyOps } from "../src/core/index.ts";
import type { Live2DPath } from "../src/core/index.ts";

const inflate = (d: Uint8Array) => new Uint8Array(inflateRawSync(d, { finishFlush: constants.Z_SYNC_FLUSH }));

test("CAFF container: entries are de-obfuscated and main.xml inflated (negative and positive keys)", () => {
  for (const key of [-0x1234567, 0x7aac70bd]) {
    const fx = cmo3Fixture(key);
    const entries = readCaff(fx.file, inflate);
    assert.deepEqual(
      entries.map((e) => e.path),
      ["imageFileBuf_0.png", "main.xml"],
    );
    assert.deepEqual(entries[0].data, fx.atlasPng);
    assert.equal(new TextDecoder().decode(entries[1].data), fx.xml);
  }
  assert.throws(() => readCaff(new Uint8Array(100), inflate), /CAFF/);
});

test("XML reader: attributes, entities, self-closing elements, processing instructions", () => {
  const doc = parseXml(`<?xml version="1.0"?>\n<?version X:1?><a k="1 &amp; 2"><b xs.n="x" /><s>&lt;hi&gt; &#x41;</s></a>`);
  const a = doc.children[0];
  assert.equal(a.attrs.k, "1 & 2");
  assert.equal(a.children[0].attrs["xs.n"], "x");
  assert.equal(a.children[1].text, "<hi> A");
});

test("cmo3 import: parameters, parts, deformers, meshes, blend shapes, glue, physics and editor state", () => {
  const { model, warnings } = cmo3ToModel(cmo3Fixture().xml, { name: "fx" });
  assert.deepEqual(warnings, []);
  const rig = model.live2d!;
  // parameters in group-tree order, with names, groups and the blend-shape keys (base value 0)
  assert.deepEqual(
    model.parameters!.map((p) => [p.id, p.name, p.group]),
    [
      ["ParamB", "ParamB name", "ParamGroupG"],
      ["ParamA", "ParamA name", "ParamGroupRoot"],
      ["ParamM", "ParamM name", "ParamGroupRoot"],
    ],
  );
  assert.deepEqual(model.parameters![2].blendShape, { keys: [0, 1], base: 0 });
  // canvas: the runtime's units (canvas width) around the center
  assert.deepEqual(rig.canvas, { width: 400, height: 200, originX: 200, originY: 100, pixelsPerUnit: 400 });
  // parts breadth first without the root part, with name / lock / label / visibility
  assert.deepEqual(
    rig.parts.map((p) => [p.id, p.parent, p.name, p.locked, p.label, p.visible]),
    [
      ["PartA", null, "Part A", true, "#e5534b", undefined],
      ["PartSub", "PartA", "Sub part", undefined, undefined, false],
    ],
  );
  // deformers parents first
  assert.deepEqual(
    rig.deformers.map((d) => [d.id, d.parent]),
    [
      ["W1", null],
      ["R1", null],
      ["R2", "R1"],
    ],
  );
  const w1 = rig.deformers[0] as WarpDeformer;
  assert.equal(w1.name, "Warp one");
  assert.equal(w1.bilinear, true);
  assert.deepEqual(w1.grid, { params: ["ParamA", "ParamB"], keys: [[-1, 1], [0, 1]] });
  // root warp points in canvas-width units; forms placed by their grid keys (the file lists them reversed)
  const lat = (dx: number, dy: number) => [100 + dx, 50 + dy, 300 + dx, 50 + dy, 100 + dx, 150 + dy, 300 + dx, 150 + dy].map((v, k) => (k % 2 ? (v - 100) / 400 : (v - 200) / 400));
  assert.deepEqual(w1.forms[0].points, lat(0, 0));
  assert.deepEqual(w1.forms[1].points, lat(40, 0));
  assert.deepEqual(w1.forms[2].points, lat(0, 20));
  assert.deepEqual(w1.forms[3], { points: lat(40, 20), opacity: 0.5 });
  // rotation at the root: origin and scale in canvas units; under a rotation: pixels
  assert.deepEqual((rig.deformers[1] as RotationDeformer).forms[0], { x: 0.25, y: -0.1, angle: 10, scale: 0.0025, reflectY: true });
  assert.deepEqual((rig.deformers[2] as RotationDeformer).forms[0], { x: 5, y: -5, angle: 10, scale: 2, reflectY: true });
  // meshes
  const m1 = model.attachments.M1.live2d!;
  assert.equal(m1.name, "Mesh one");
  assert.deepEqual(m1.forms[0].points, [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(m1.blendShapes, [{ param: "ParamM", forms: [{ points: [0, 0, 0, 0, 0, 0] }, { points: [0, 0.5, 0, 0.5, 0, 0] }], constraints: [{ param: "ParamA", values: [[0, 1], [1, 0]] }] }]);
  assert.equal(model.attachments.M2.live2d!.hidden, true);
  assert.deepEqual(model.attachments.M2.live2d!.forms[0].points, [0, 0, 10, 0, 0, 10]);
  assert.deepEqual(model.attachments.M3.live2d!.forms[0], { points: [0, 0, 0.1, 0, 0, 0.1], drawOrder: 500, screen: [0.25, 0, 0] });
  assert.equal(model.slots.find((s) => s.id === "M3")!.blend, "additive");
  assert.equal(model.attachments.M1.image, "texture_00");
  // deformation path: control points pinned at vertices 0 and 1, vertex 2 (uid 9) bound halfway
  assert.deepEqual(m1.paths, [
    { points: [{ tri: [0, 1, 2], w: [1, 0, 0] }, { tri: [0, 1, 2], w: [0, 1, 0], corner: true }], bind: [{ vertex: 2, t: 0.5, weight: 0.75 }], width: 50 },
  ]);
  // glue pairs by point uid
  assert.deepEqual(rig.glue, [{ id: "Glue__M1__M3", a: "M1", b: "M3", part: "PartA", pairs: [2, 1], weights: [0.25, 0.75], grid: { params: [], keys: [] }, intensity: [0.8] }]);
  // draw-order group items in reverse tree order
  assert.deepEqual(rig.drawOrderGroups, [{ min: 500, max: 500, items: [{ slot: "M2" }, { slot: "M3" }, { slot: "M1" }] }]);
  // physics, numbered like the runtime export
  const ph = rig.physics!;
  assert.equal(ph.fps, 30);
  assert.deepEqual(ph.settings[0].inputs, [{ param: "ParamA", weight: 60, type: "X" }]);
  assert.deepEqual(ph.settings[0].outputs, [{ param: "ParamB", vertex: 1, scale: 1.5, weight: 100, type: "Angle", reflect: true }]);
  assert.equal(ph.settings[0].id, "PhysicsSetting1");
  assert.equal(ph.settings[0].name, "Sway");
  // it poses: the warp at ParamA = 1 carries M1 40 px right
  const at = (a: number) => live2dFrame(model, { ParamA: a, ParamB: 0, ParamM: 0 }).meshes.get("M1")!.points;
  const d = at(1)[0] - at(-1)[0];
  assert.ok(Math.abs(d - 40 / 400) < 1e-6, `moved ${d}`);
});

test("cmo3 import saves the model with its atlas, validates and exports to moc3", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmo3-"));
  const src = join(dir, "fx.cmo3");
  const fx = cmo3Fixture();
  writeFileSync(src, fx.file);
  const res = importLive2D(src, join(dir, "fx", "fx.rig.json"));
  assert.ok(res.log[0].startsWith("cmo3:"));
  assert.deepEqual(readFileSync(join(dir, "fx", "images", "fx", "texture_00.png")), Buffer.from(fx.atlasPng));
  const { model, baseDir } = loadModel(join(dir, "fx", "fx.rig.json"));
  assert.equal(model.images!.texture_00.path, "images/fx/texture_00.png");
  const issues = validateModel(model, { baseDir });
  assert.deepEqual(issues.filter((i) => i.level === "error"), []);
  // it exports to moc3 (blend shapes need 5.0)
  const out = exportLive2DData(model, { name: "fx" });
  assert.deepEqual(out.warnings, ["1 hidden art mesh(es) left out: M2"]);
  assert.equal(out.moc.version, 5);
  assert.equal(out.moc.counts.artMeshes, Object.values(model.attachments).filter((a) => a.live2d && !a.live2d.hidden).length);
  assert.equal(out.moc.counts.parameters, model.parameters!.length);
  assert.ok(out.moc.counts.blendShapesArtMeshes > 0);
  // runtime files are refused: the import reads the editor file
  writeFileSync(join(dir, "fx.moc3"), writeMoc3(out.moc));
  assert.throws(() => importLive2D(join(dir, "fx.moc3"), join(dir, "x", "x.rig.json")), /runtime export/);
  assert.equal(existsSync(join(dir, "x", "x.rig.json")), false);
});

test("can3 motions: scenes to motion3 curves, cut to the work area; parameters and parts by guid", () => {
  const { uuids } = cmo3ToModel(cmo3Fixture().xml, { name: "fx" });
  const xml = new TextDecoder().decode(readCaff(can3Fixture(), inflate)[0].data);
  const { motions, warnings } = can3ToMotions(xml, uuids);
  assert.equal(motions.length, 1);
  assert.match(warnings.join(), /ParamGone/);
  const m = motions[0];
  assert.equal(m.name, "wave");
  assert.equal(m.json.Meta.Duration, 1);
  assert.equal(m.json.Meta.Fps, 30);
  assert.equal(m.json.Meta.FadeInTime, 0.5);
  const a = m.json.Curves.find((c: { Id: string }) => c.Id === "ParamA").Segments as number[];
  // starts at 0 (the bezier from frame -15 split there), reaches 1 at 0.5 s, the linear part cut at 1 s (value 0.5)
  assert.equal(a.length, 12);
  assert.equal(a[0], 0);
  assert.ok(a[1] > 0 && a[1] < 1);
  assert.deepEqual(a.slice(7), [0.5, 1, 0, 1, 0.5]);
  const part = m.json.Curves.find((c: { Id: string }) => c.Id === "PartA");
  assert.equal(part.Target, "PartOpacity");
  assert.deepEqual(part.Segments, [0, 1, 2, 1 / 3, 0, 0, 1, 0]);
  assert.equal(m.json.Curves.length, 2);
});

test("cmo3 import reads the .can3 next to it into animations", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmo3-"));
  writeFileSync(join(dir, "fx.cmo3"), cmo3Fixture().file);
  writeFileSync(join(dir, "fx.can3"), can3Fixture());
  const res = importLive2D(join(dir, "fx.cmo3"), join(dir, "fx", "fx.rig.json"));
  const anim = res.model.animations!.wave;
  assert.ok(anim, "motion imported");
  assert.equal(anim.duration, 1.0333333, "a looping motion lasts one frame longer (the Framework's loop)");
  assert.ok(anim.params?.ParamA?.length);
  assert.ok(anim.partOpacity?.PartA?.length);
});

test("deformation paths: pinned control points, curve, dragging carries the bound vertices", () => {
  const path: Live2DPath = { points: [{ tri: [0, 1, 2], w: [1, 0, 0] }, { tri: [0, 1, 2], w: [0, 1, 0] }], bind: [{ vertex: 2, t: 0.5, weight: 1 }] };
  const verts: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [5, 2],
  ];
  assert.deepEqual(pathPoints(path, verts), [
    [0, 0],
    [10, 0],
  ]);
  const mid = pathAt(pathPoints(path, verts), 0.5);
  assert.ok(Math.abs(mid.p[0] - 5) < 1e-9 && Math.abs(mid.p[1]) < 1e-9 && Math.abs(mid.dir[0] - 1) < 1e-6);
  assert.deepEqual(pathMoves(path, verts, 1, [10, 0]), []);
  // the end swings up: the bound vertex keeps its place beside the curve (2 to the left of it)
  const [[v, x, y]] = pathMoves(path, verts, 1, [0, 10]);
  assert.equal(v, 2);
  assert.ok(Math.abs(x + 2) < 1e-6 && Math.abs(y - 5) < 1e-6, `${x}, ${y}`);
  const [[, hx, hy]] = pathMoves({ ...path, bind: [{ vertex: 2, t: 0.5, weight: 0.5 }] }, verts, 1, [0, 10]);
  assert.ok(Math.abs(hx - 1.5) < 1e-6 && Math.abs(hy - 3.5) < 1e-6);
});

test("deformation paths in ops: set / remove with setLive2DMesh, dropped when a pinning vertex is removed", () => {
  const { model } = cmo3ToModel(cmo3Fixture().xml, { name: "fx" });
  assert.throws(() => applyOps(model, [{ op: "setLive2DMesh", attachment: "M1", paths: [{ points: [{ tri: [0, 1, 9], w: [1, 0, 0] }, { tri: [0, 1, 2], w: [0, 1, 0] }], bind: [] }] }]), /vertex indices/);
  const cleared = applyOps(model, [{ op: "setLive2DMesh", attachment: "M1", paths: null }]).model;
  assert.equal(cleared.attachments.M1.live2d!.paths, undefined);
  // renumbering after vertex removal: bound vertices follow, a lost pinning vertex drops the path
  const path = model.attachments.M1.live2d!.paths!;
  assert.deepEqual(remapPaths(path, [0, 1, 2]), path);
  assert.deepEqual(remapPaths([{ ...path[0], bind: [{ vertex: 2, t: 0.5, weight: 1 }] }], [0, 1, 2]), [{ ...path[0], bind: [{ vertex: 2, t: 0.5, weight: 1 }] }]);
  assert.equal(remapPaths(path, [0, -1, 1]), undefined);
  const [p2] = remapPaths([{ points: [{ tri: [0, 1, 1], w: [1, 0, 0] }, { tri: [1, 1, 1], w: [1, 0, 0] }], bind: [{ vertex: 2, t: 0.5, weight: 1 }, { vertex: 3, t: 1, weight: 1 }] }], [0, 1, -1, 2])!;
  assert.deepEqual(p2.bind, [{ vertex: 2, t: 1, weight: 1 }]);
});

test("linked parameters (Cubism's chain link): combined flag to cdi3 CombinedParameters", () => {
  const { model } = cmo3ToModel(cmo3Fixture().xml, { name: "fx" });
  const linked = applyOps(model, [{ op: "updateParameter", id: "ParamB", combined: true }]).model;
  const out = exportLive2DData(linked, { name: "fx" });
  assert.deepEqual(out.displayInfo.CombinedParameters, [["ParamB", "ParamA"]]);
  const unlinked = applyOps(linked, [{ op: "updateParameter", id: "ParamB", combined: false }]).model;
  assert.equal(exportLive2DData(unlinked, { name: "fx" }).displayInfo.CombinedParameters, undefined);
});
