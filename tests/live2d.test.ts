import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, loadModel, normalizeModel, restVertices, serializeModel, validateModel } from "../src/core/index.ts";
import type { Model, Op } from "../src/core/index.ts";
import { live2dFrame, live2dGuides, partOpacities } from "../src/core/live2d.ts";
import { describeModel } from "../src/core/describe.ts";
import { parseOverlay, renderPose } from "../src/render/render.ts";
import { PoseSimulator } from "../src/core/physics.ts";
import { exportLive2D, exportLive2DData, importLive2DRuntime, motionToAnimation, readMoc3, writeMoc3 } from "../src/live2d/index.ts";
import { applyLive2DJson, mocToModel, syncLive2DVertices } from "../src/live2d/import.ts";
import { encodePNG } from "../src/render/png.ts";
import { live2dBlendRig, live2dRig, motion3, physics3, pose3 } from "./live2d-fixture.ts";

const golden = JSON.parse(readFileSync(new URL("./live2d-golden.json", import.meta.url), "utf8"));
const goldenBlend = JSON.parse(readFileSync(new URL("./live2d-golden-blend.json", import.meta.url), "utf8"));
const goldenMotion = JSON.parse(readFileSync(new URL("./live2d-golden-motion.json", import.meta.url), "utf8"));

/** Compares a model's Live2D evaluation with the Cubism Core output recorded in live2d-golden.json. */
function checkGolden(model: Model, label: string, tol = 2e-6, data = golden): void {
  const defaults = Object.fromEntries(model.parameters!.map((p) => [p.id, p.default]));
  for (const s of data.samples) {
    const f = live2dFrame(model, { ...defaults, ...s.params });
    const parts = partOpacities(model.live2d!);
    for (const [id, want] of Object.entries(s.meshes) as Array<[string, { points: number[]; opacity: number; visible: boolean; multiply: number[]; screen: number[] }]>) {
      const m = f.meshes.get(id)!;
      const opacity = m.opacity * (m.part ? parts.get(m.part)! : 1);
      assert.equal(m.enabled && opacity > 0, want.visible, `${label} ${id} visibility at ${JSON.stringify(s.params)}`);
      if (!want.visible) continue;
      want.points.forEach((v, k) => assert.ok(Math.abs((k & 1 ? -m.points[k] : m.points[k]) - v) < tol, `${label} ${id} point ${k} at ${JSON.stringify(s.params)}: ${m.points[k]} vs ${v}`));
      assert.ok(Math.abs(opacity - want.opacity) < 1e-6, `${label} ${id} opacity`);
      want.multiply.forEach((v, c) => assert.ok(Math.abs(m.multiply[c] - v) < 1e-5, `${label} ${id} multiply`));
      want.screen.forEach((v, c) => assert.ok(Math.abs(m.screen[c] - v) < 1e-5, `${label} ${id} screen`));
    }
    const order = f.order.filter((id) => {
      const m = f.meshes.get(id)!;
      return m.opacity * (m.part ? parts.get(m.part)! : 1) > 0;
    });
    assert.deepEqual(order, s.order, `${label} draw order at ${JSON.stringify(s.params)}`);
  }
}

test("live2d rig poses like the Cubism Core (nested warps / rotations, reflection, glue, colors, masks, draw-order groups)", () => {
  checkGolden(live2dRig(), "fixture");
});

test("moc3 write/read at every version keeps the rig exactly", () => {
  for (const version of [1, 2, 3, 4, 5] as const) {
    const rig = live2dRig();
    if (version < 4) for (const a of Object.values(rig.attachments)) for (const f of a.live2d!.forms) delete f.multiply, delete f.screen;
    if (version < 2) for (const d of rig.live2d!.deformers) if (d.type === "warp") delete d.bilinear;
    const bytes = writeMoc3(exportLive2DData(rig, { name: "f", version }).moc);
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "MOC3");
    assert.equal(bytes[4], version, `v${version} written as asked`);
    const back = readMoc3(bytes);
    assert.deepEqual(writeMoc3(back), bytes, `v${version} rewrites byte for byte`);
    const { model, warnings } = mocToModel(back, { name: "f", textures: ["tex"] });
    assert.deepEqual(warnings, []);
    const defaults = Object.fromEntries(rig.parameters!.map((p) => [p.id, p.default]));
    for (const sample of golden.samples) {
      const a = live2dFrame(rig, { ...defaults, ...sample.params });
      const b = live2dFrame(model, { ...defaults, ...sample.params });
      for (const [id, m] of a.meshes) m.points.forEach((x, k) => assert.ok(Math.abs(x - b.meshes.get(id)!.points[k]) < 1e-6, `v${version} ${id}`));
      assert.deepEqual(b.order, a.order);
    }
    if (version >= 4) checkGolden(model, `v${version} reimport`);
  }
  assert.throws(() => readMoc3(new Uint8Array(4096)), /not a \.moc3/);
});

test("motion3 curves and physics3 play like the Cubism Framework", () => {
  for (const [key, frames] of Object.entries(goldenMotion) as Array<[string, Array<Record<string, number>>]>) {
    if (key === "note") continue;
    const restricted = key.startsWith("restricted");
    const physics = key.endsWith("+physics");
    const model = live2dRig();
    applyLive2DJson({ model, log: [], warnings: [] }, { motions: [{ group: "Idle", index: 0, file: "motion/m.motion3.json", json: motion3(restricted) }], physics: physics3(), pose: pose3() });
    const sim = new PoseSimulator(model, "m", { settle: 0, warmupLoops: 0, physics });
    for (const fr of frames) {
      const pose = sim.at(fr.t);
      for (const p of ["AngleX", "Eye", "Arm"]) {
        const tol = physics && p === "Arm" ? 2e-3 : 1e-4;
        assert.ok(Math.abs(pose.params![p] - fr[p]) < tol, `${key} ${p} at t=${fr.t}: ${pose.params![p]} vs ${fr[p]}`);
      }
      for (const part of ["P_face", "P_alt"]) assert.ok(Math.abs((pose.parts?.[part] ?? 1) - fr["part:" + part]) < 1e-4, `${key} ${part} opacity at t=${fr.t}: ${pose.parts?.[part]} vs ${fr["part:" + part]}`);
    }
  }
});

test("motion3 export gives the same curves back", () => {
  for (const restricted of [false, true]) {
    const model = live2dRig();
    applyLive2DJson({ model, log: [], warnings: [] }, { motions: [{ group: "Idle", index: 0, file: "motion/m.motion3.json", json: motion3(restricted) }] });
    const out = exportLive2DData(model, { name: "f" });
    const json = out.motions[0].json;
    assert.equal(json.Meta.Duration, 2, "the file keeps its duration (Cubism adds the loop's closing frame itself)");
    assert.equal(out.model3.FileReferences.Motions.Idle[0].File, "motion/m.motion3.json");
    const back = motionToAnimation(json).anim;
    const a = model.animations!.m;
    for (let t = 0; t <= a.duration; t += 0.01) {
      for (const p of ["AngleX", "Eye"]) {
        const x = restVertexParam(a, p, t);
        const y = restVertexParam(back, p, t);
        assert.ok(Math.abs(x - y) < 1e-6, `${p} at ${t}`);
      }
    }
    assert.deepEqual(back.events, [{ t: 0.5, name: "user", string: "blink" }]);
  }
});

test("motion3 curves for ids the moc does not have are kept for export only (Cubism ignores them)", () => {
  const model = live2dRig();
  const json = motion3();
  json.Curves.push({ Target: "Parameter", Id: "Ghost", Segments: [0, 0, 0, 1, 1] }, { Target: "PartOpacity", Id: "P_ghost", Segments: [0, 1, 0, 1, 0] });
  const res = { model, log: [], warnings: [] as string[] };
  applyLive2DJson(res, { motions: [{ group: "Idle", index: 0, file: "m.motion3.json", json }] });
  const a = model.animations!.m;
  assert.equal(a.params?.Ghost, undefined);
  assert.equal(a.partOpacity?.P_ghost, undefined);
  assert.ok(a.params?.AngleX);
  assert.ok(res.warnings.some((w) => w.includes("Ghost") && w.includes("P_ghost")));
  assert.deepEqual(validateModel(model, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  const curves = exportLive2DData(model, { name: "f" }).motions[0].json.Curves;
  assert.ok(curves.some((c: { Id: string }) => c.Id === "Ghost") && curves.some((c: { Id: string }) => c.Id === "P_ghost"));
});

test("models imported before: motion curves for ids the moc lacks move aside on load (valid, still exported)", () => {
  const model = live2dRig();
  applyLive2DJson({ model, log: [], warnings: [] }, { motions: [{ group: "Idle", index: 0, file: "m.motion3.json", json: motion3() }] });
  // what an older import wrote: the orphan curves inside the animation
  const old = JSON.parse(serializeModel(model));
  old.animations.m.params.Ghost = [{ t: 0, v: 0 }, { t: 1, v: 1 }];
  old.animations.m.partOpacity.P_ghost = [{ t: 0, v: 1 }];
  const loaded = normalizeModel(old);
  assert.equal(loaded.animations!.m.params!.Ghost, undefined);
  assert.equal(loaded.animations!.m.partOpacity!.P_ghost, undefined);
  assert.ok(loaded.animations!.m.params!.AngleX);
  assert.deepEqual(validateModel(loaded, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  const curves = exportLive2DData(loaded, { name: "f" }).motions[0].json.Curves as Array<{ Target: string; Id: string }>;
  assert.ok(curves.some((c) => c.Target === "Parameter" && c.Id === "Ghost"));
  assert.ok(curves.some((c) => c.Target === "PartOpacity" && c.Id === "P_ghost"));
  // loading again changes nothing more
  assert.deepEqual(normalizeModel(JSON.parse(serializeModel(loaded))), loaded);
});

function restVertexParam(anim: NonNullable<Model["animations"]>[string], id: string, t: number): number {
  const sim = { model: { parameters: [{ id, min: -1e9, max: 1e9, default: 0 }] } } as unknown as { model: Model };
  const keys = anim.params![id];
  void sim;
  // sampleTrack semantics: same as the pose code
  let i = 0;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  if (k0.ease === "stepped") return k0.v;
  const a = (t - k0.t) / (k1.t - k0.t || 1);
  if (!Array.isArray(k0.ease)) return k0.v + (k1.v - k0.v) * a;
  const [x1, y1, x2, y2] = k0.ease as number[];
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let n = 0; n < 50; n++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < a) lo = mid;
    else hi = mid;
  }
  return k0.v + (k1.v - k0.v) * by((lo + hi) / 2);
}

test("live2d edit ops: keyforms, keys, deformers, parts, parameters", () => {
  const base = live2dRig();
  syncLive2DVertices(base);
  const defaults = Object.fromEntries(base.parameters!.map((p) => [p.id, p.default]));
  const pose = (m: Model, id: string, v: Record<string, number> = {}) => restVertices(m, id, m.attachments[id], { ...defaults, ...v });
  const near = (a: number[][], b: number[][], tol: number) => a.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) < tol);

  // a keyform offset moves the vertex by exactly that much at the keyform's values, and nowhere else changes there
  const r1 = applyOps(base, [{ op: "setKeyform", target: "body", at: { AngleX: 30 }, offsets: [[2, 12, -7]] } as Op]).model;
  const a = pose(base, "body", { AngleX: 30 });
  const b = pose(r1, "body", { AngleX: 30 });
  assert.ok(Math.abs(b[2][0] - a[2][0] - 12) < 1e-4 && Math.abs(b[2][1] - a[2][1] + 7) < 1e-4);
  assert.ok(near(pose(base, "body", { AngleX: -30 }), pose(r1, "body", { AngleX: -30 }), 1e-6), "other keyforms unchanged");
  assert.throws(() => applyOps(base, [{ op: "setKeyform", target: "body", at: { AngleX: 12 }, offsets: [[0, 1, 1]] } as Op]), /not on a key/);

  // new keys resample the forms without changing the look anywhere
  const r2 = applyOps(base, [
    { op: "setKeyformKeys", target: "body", param: "AngleX", keys: [-30, -10, 0, 30] },
    { op: "setKeyformKeys", target: "body", param: "Arm", keys: [-1, 1] },
    { op: "setKeyformKeys", target: "W_body", param: "AngleX", keys: [-30, 0, 30] },
  ] as Op[]).model;
  assert.equal(r2.attachments.body.live2d!.forms.length, 8);
  for (const v of [{}, { AngleX: 17, Arm: 0.3 }, { AngleX: -25, Arm: -1, Eye: 0.2 }] as Array<Record<string, number>>) assert.ok(near(pose(base, "body", v), pose(r2, "body", v), 1e-4), JSON.stringify(v));

  // a deformer inserted over a mesh (and removed again) keeps its look at the mesh's keyforms
  const r3 = applyOps(base, [{ op: "addDeformer", id: "W_new", type: "warp", parent: "W_body", children: ["body"], cols: 2, rows: 2 } as Op]).model;
  assert.equal(r3.attachments.body.live2d!.deformer, "W_new");
  for (const v of [{ AngleX: -30 }, { AngleX: 0 }, { AngleX: 30 }]) assert.ok(near(pose(base, "body", v), pose(r3, "body", v), 1e-3), JSON.stringify(v));
  const r3b = applyOps(r3, [{ op: "removeDeformer", id: "W_new" } as Op]).model;
  assert.equal(r3b.attachments.body.live2d!.deformer, "W_body");
  for (const v of [{ AngleX: -30 }, { AngleX: 30 }]) assert.ok(near(pose(base, "body", v), pose(r3b, "body", v), 1e-3));
  const r3c = applyOps(base, [{ op: "addDeformer", id: "R_new", type: "rotation", children: ["glow"] }, { op: "setKeyformKeys", target: "R_new", param: "AngleX", keys: [-30, 30] }, { op: "setKeyform", target: "R_new", at: { AngleX: 30 }, angle: 90 }] as Op[]).model;
  const g0 = pose(r3c, "glow", { AngleX: -30 });
  const g1 = pose(r3c, "glow", { AngleX: 30 });
  const c = [(g0[0][0] + g0[2][0]) / 2, (g0[0][1] + g0[2][1]) / 2];
  const ang = (p: number[]) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  assert.ok(Math.abs(((ang(g1[0]) - ang(g0[0]) + Math.PI * 3) % (Math.PI * 2)) - Math.PI - Math.PI / 2) < 1e-3 || Math.abs(Math.abs(ang(g1[0]) - ang(g0[0])) - Math.PI / 2) < 1e-3, "a 90 degree keyform turns the mesh by 90 degrees");

  // geometry edits reach every keyform
  const r4 = applyOps(base, [{ op: "removeVertices", attachment: "eye", indices: [3] }, { op: "addVertex", attachment: "body", at: pose(base, "body")[0].map((x, i) => (x + pose(base, "body")[2][i]) / 2) as [number, number] }] as Op[]).model;
  assert.ok(r4.attachments.eye.live2d!.forms.every((f) => f.points.length === 6));
  assert.ok(r4.attachments.body.live2d!.forms.every((f) => f.points.length === 10));
  assert.equal(r4.live2d!.glue![0].pairs.length, 4, "glue pairs of kept vertices stay");

  // parts, part opacity keys, parameter removal (keeps the default look), renames
  const r5 = applyOps(base, [
    { op: "addPart", id: "P_new", parent: "P_body", name: "New" },
    { op: "setLive2DMesh", attachment: "glow", part: "P_new" },
    { op: "setAnimation", name: "fade", duration: 1 },
    { op: "setPartOpacityKeys", animation: "fade", part: "P_new", keys: [{ t: 0, v: 1 }, { t: 1, v: 0 }] },
    { op: "removeParameter", id: "AngleX" },
    { op: "renameSlot", id: "arm", to: "arm2" },
  ] as Op[]).model;
  assert.equal(r5.attachments.glow.live2d!.part, "P_new");
  assert.deepEqual(r5.animations!.fade.partOpacity!.P_new.map((k) => k.v), [1, 0]);
  assert.ok(near(pose(base, "body"), restVertices(r5, "body", r5.attachments.body, Object.fromEntries(r5.parameters!.map((p) => [p.id, p.default]))), 1e-4));
  assert.ok(r5.live2d!.drawOrderGroups![1].items.some((it) => "slot" in it && it.slot === "arm2"));
  assert.deepEqual(validateModel(r5, { poseSamples: 0 }).filter((i) => i.level === "error"), []);
  assert.throws(() => applyOps(base, [{ op: "updateDeformer", id: "W_body", parent: "W_face" } as Op]), /under itself or its descendants/);
});

test("enableLive2D turns a plain model into a Live2D rig that exports and reads back", () => {
  let m = applyOps(
    { format: "awaken2d/0.1", name: "plain", target: "live2d", images: {}, bones: [{ id: "root", parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 }], slots: [], attachments: {}, animations: {} },
    [
      { op: "addSlot", id: "a", bone: "root" },
      { op: "addMesh", id: "a", slot: "a", shape: { rect: { x: -50, y: 0, width: 100, height: 200 }, cols: 2, rows: 2 } },
      { op: "addParameter", id: "Tilt", min: -1, max: 1 },
      { op: "enableLive2D" },
      { op: "addDeformer", id: "W", type: "warp", children: ["a"], cols: 2, rows: 2 },
      { op: "setKeyformKeys", target: "W", param: "Tilt", keys: [-1, 0, 1] },
      { op: "setKeyform", target: "W", at: { Tilt: 1 }, offsets: [[0, 30, 0], [1, 30, 0], [2, 30, 0]] },
    ] as Op[],
  ).model;
  const top = (mm: Model, v: number) => restVertices(mm, "a", mm.attachments.a, { Tilt: v }).reduce((s, p) => (p[1] > 150 ? s + p[0] : s), 0);
  assert.ok(top(m, 1) - top(m, 0) > 50, "the warp's keyform moves the top of the mesh");
  const bytes = writeMoc3(exportLive2DData(m, { name: "plain" }).moc);
  const back = mocToModel(readMoc3(bytes), { name: "plain", textures: [] }).model;
  for (const v of [-1, 0, 0.4, 1]) {
    const x = restVertices(m, "a", m.attachments.a, { Tilt: v });
    const y = restVertices(back, "a", back.attachments.a, { Tilt: v });
    assert.ok(x.every((p, i) => Math.hypot(p[0] - y[i][0], p[1] - y[i][1]) < 1e-3), `Tilt ${v}`);
  }
  m = applyOps(m, [{ op: "removeDeformer", id: "W" } as Op]).model;
  assert.equal(m.live2d!.deformers.length, 0);
});

test("Live2D files: model3.json import and runtime export round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-l2d-"));
  const src = join(dir, "src");
  mkdirSync(join(src, "tex"), { recursive: true });
  mkdirSync(join(src, "motion"), { recursive: true });
  writeFileSync(join(src, "f.moc3"), writeMoc3(exportLive2DData(live2dRig(), { name: "f", version: 5 }).moc));
  writeFileSync(join(src, "tex", "texture_00.png"), encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(255) }));
  writeFileSync(join(src, "motion", "m.motion3.json"), JSON.stringify(motion3()));
  writeFileSync(join(src, "f.physics3.json"), JSON.stringify(physics3()));
  writeFileSync(join(src, "f.cdi3.json"), JSON.stringify({ Version: 3, Parameters: [{ Id: "AngleX", GroupId: "G", Name: "각도 X" }], ParameterGroups: [{ Id: "G", GroupId: "", Name: "Face" }], Parts: [{ Id: "P_face", Name: "얼굴" }] }));
  writeFileSync(join(src, "f.pose3.json"), JSON.stringify({ Type: "Live2D Pose", Groups: [[{ Id: "P_face", Link: [] }]] }));
  writeFileSync(
    join(src, "f.model3.json"),
    JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "f.moc3", Textures: ["tex/texture_00.png"], Physics: "f.physics3.json", Pose: "f.pose3.json", DisplayInfo: "f.cdi3.json", Motions: { Idle: [{ File: "motion/m.motion3.json" }] } },
      Groups: [{ Target: "Parameter", Name: "EyeBlink", Ids: ["Eye"] }],
    }),
  );
  const res = importLive2DRuntime(join(src, "f.model3.json"), join(dir, "rig", "f.rig.json"));
  assert.deepEqual(res.warnings, []);
  assert.ok(existsSync(join(dir, "rig", "images", "f", "texture_00.png")));
  const { model, baseDir } = loadModel(join(dir, "rig", "f.rig.json"));
  assert.equal(model.parameters!.find((p) => p.id === "AngleX")!.name, "각도 X");
  assert.equal(model.live2d!.parts.find((p) => p.id === "P_face")!.name, "얼굴");
  assert.equal(model.live2d!.physics!.settings.length, 1);
  assert.ok(model.animations!.m.partOpacity!.P_face.length > 0);
  checkGolden(model, "imported");
  assert.deepEqual(validateModel(model, { baseDir, poseSamples: 2 }).filter((i) => i.level === "error"), []);

  const out = join(dir, "out");
  const ex = exportLive2D(model, baseDir, out, { name: "g" });
  for (const f of ["g.model3.json", "g.moc3", "g.physics3.json", "g.cdi3.json", "g.pose3.json", "motion/m.motion3.json", "g.textures/texture_00.png"]) assert.ok(ex.files.includes(f), f);
  const m3 = JSON.parse(readFileSync(join(out, "g.model3.json"), "utf8"));
  assert.deepEqual(m3.Groups, [{ Target: "Parameter", Name: "EyeBlink", Ids: ["Eye"] }]);
  const again = importLive2DRuntime(join(out, "g.model3.json"), join(dir, "again", "g.rig.json"));
  checkGolden(again.model, "exported and read back");
  assert.deepEqual(again.model.live2d!.physics, model.live2d!.physics);
});

test("motion3 export of a loop made in the editor: every curve has a segment and reaches Duration (Cubism Viewer / Framework parse it)", () => {
  const model = live2dRig();
  model.animations = {
    sway: {
      duration: 4,
      loop: true,
      params: {
        AngleX: [
          { t: 0, v: -10, ease: [0.42, 0, 0.58, 1] },
          { t: 2, v: 10, ease: [0.42, 0, 0.58, 1] },
          { t: 4, v: -10 },
        ],
        Eye: [
          { t: 0, v: 1 },
          { t: 4, v: 1 },
        ],
      },
    },
  };
  const json = exportLive2DData(model, { name: "f" }).motions[0].json;
  const D = 4 - 1 / 30;
  assert.ok(Math.abs(json.Meta.Duration - D) < 1e-9);
  let segments = 0;
  for (const c of json.Curves as Array<{ Id: string; Segments: number[] }>) {
    // the Framework reads a segment after the first point, whatever the length: a single-point curve breaks the parse
    assert.ok(c.Segments.length > 2, `${c.Id} has a segment`);
    assert.ok(Math.abs(c.Segments[c.Segments.length - 2] - D) < 1e-9, `${c.Id} ends at Duration`);
    for (let i = 2; i < c.Segments.length; i += c.Segments[i] === 1 ? 7 : 3) segments++;
  }
  assert.equal(json.Meta.TotalSegmentCount, segments);
  // played back (with the closing frame Cubism adds, linear over the last 1/30 s) it is the same motion
  const back = motionToAnimation(json).anim;
  const a = model.animations.sway;
  for (let t = 0; t <= 4; t += 0.01) {
    for (const p of ["AngleX", "Eye"]) assert.ok(Math.abs(restVertexParam(a, p, t) - restVertexParam(back, p, t)) < 5e-3, `${p} at ${t}`);
  }
});

test("Live2D editor flags (lock, label), deformer / glue guides, render overlays and the part tree in describe", () => {
  let m = live2dRig();
  m = applyOps(m, [
    { op: "updatePart", id: "P_face", locked: true, label: "#E5534B" },
    { op: "updateDeformer", id: "W_face", locked: true, hidden: true },
    { op: "setLive2DMesh", attachment: "eye", locked: true },
  ] as Op[]).model;
  const rig = m.live2d!;
  assert.equal(rig.parts.find((p) => p.id === "P_face")!.label, "#e5534b");
  assert.equal(rig.parts.find((p) => p.id === "P_face")!.locked, true);
  assert.equal(rig.deformers.find((d) => d.id === "W_face")!.locked, true);
  assert.equal(m.attachments.eye.live2d!.locked, true);
  assert.throws(() => applyOps(m, [{ op: "updatePart", id: "P_face", label: "red" } as Op]), /#rrggbb/);
  const cleared = applyOps(m, [{ op: "updatePart", id: "P_face", locked: false, label: null } as Op]).model.live2d!.parts.find((p) => p.id === "P_face")!;
  assert.ok(!("locked" in cleared) && !("label" in cleared));
  assert.equal(validateModel(m).filter((i) => i.level === "error").length, 0);
  // lock and label are editor state: the export is the same without them
  const unflagged = applyOps(m, [
    { op: "updatePart", id: "P_face", locked: false, label: null },
    { op: "updateDeformer", id: "W_face", locked: false },
    { op: "setLive2DMesh", attachment: "eye", locked: false },
  ] as Op[]).model;
  assert.deepEqual(writeMoc3(exportLive2DData(m, { name: "f" }).moc), writeMoc3(exportLive2DData(unflagged, { name: "f" }).moc));
  // guides: the posed lattices, rotation handles and glued pairs in world space
  const g = live2dGuides(m, live2dFrame(m, { AngleX: 0, Eye: 1, Arm: 0 }));
  assert.deepEqual(g.warps.map((w) => [w.id, w.hidden]).sort(), [["W_body", false], ["W_face", true]]);
  for (const w of g.warps) assert.equal(w.points.length, (w.cols + 1) * (w.rows + 1));
  assert.equal(g.rotations.length, 1);
  assert.ok(Math.abs(Math.hypot(...g.rotations[0].up) - 1) < 1e-9);
  assert.equal(g.glue[0].lines.length, 2);
  // render overlays
  assert.deepEqual(parseOverlay("deformers,glue,noart"), { deformers: true, glue: true, noArt: true });
  assert.throws(() => parseOverlay("deformer"), /unknown overlay/);
  const plain = renderPose(m, ".", { images: new Map(), overlay: { noArt: true }, size: 64, params: { Eye: 1 } });
  const guides = renderPose(m, ".", { images: new Map(), overlay: { noArt: true, deformers: true, glue: true }, size: 64, params: { Eye: 1 } });
  assert.ok(plain.data.every((v) => v === 255), "no art: blank");
  assert.ok(guides.data.some((v, i) => i % 4 === 1 && v < 250), "guides drawn");
  // describe: the part tree with what each part holds
  const text = describeModel(m);
  assert.match(text, /Parts \(children indented/);
  assert.match(text, /\n {4}P_face "Face" \(locked, label #e5534b\)/);
});

test("blend shapes (Cubism 4.2+) pose like the Cubism Core: keyed differences on meshes, warps, rotations, parts and glue, the smallest constraint limit, colors clamped", () => {
  const m = live2dBlendRig();
  assert.equal(validateModel(m).filter((i) => i.level === "error").length, 0);
  checkGolden(m, "blend", 2e-6, goldenBlend);
  // moc3 round trip (5.0: colors per keyform) keeps the shapes and their look
  const data = exportLive2DData(m, { name: "f" }).moc;
  assert.equal(data.version, 5);
  const back = mocToModel(readMoc3(writeMoc3(data)), { name: "f", textures: ["tex"] }).model;
  assert.deepEqual(back.parameters!.find((p) => p.id === "Tilt")!.blendShape, { keys: [-1, 0, 1], base: 1 });
  assert.deepEqual(back.attachments.glow.live2d!.blendShapes, m.attachments.glow.live2d!.blendShapes);
  assert.deepEqual(back.live2d!.parts.find((p) => p.id === "P_body")!.blendShapes, m.live2d!.parts.find((p) => p.id === "P_body")!.blendShapes);
  checkGolden(back, "blend reimport", 2e-6, goldenBlend);
  // renaming a parameter follows it into shapes and constraints; removing one drops them
  const renamed = applyOps(m, [{ op: "renameParameter", id: "Lim", to: "Limit" }, { op: "renameParameter", id: "Vow", to: "Vowel" }] as Op[]).model;
  assert.equal(renamed.attachments.glow.live2d!.blendShapes![0].param, "Vowel");
  assert.equal(renamed.attachments.glow.live2d!.blendShapes![0].constraints![0].param, "Limit");
  assert.equal(renamed.live2d!.parts.find((p) => p.id === "P_body")!.blendShapes![0].param, "Vowel");
  const removed = applyOps(m, [{ op: "removeParameter", id: "Vow" }] as Op[]).model;
  assert.equal(removed.attachments.glow.live2d!.blendShapes, undefined);
  assert.equal(validateModel(removed).filter((i) => i.level === "error").length, 0);
  assert.throws(() => applyOps(m, [{ op: "setKeyformKeys", target: "glow", param: "Vow", keys: [0, 1] } as Op]), /blend-shape parameter/);
  // mesh edits carry the differences: removing a vertex removes it from every shape
  const trimmed = applyOps(m, [{ op: "removeVertices", attachment: "eye", indices: [3] } as Op]);
  for (const f of trimmed.model.attachments.eye.live2d!.blendShapes![0].forms) assert.equal(f.points.length, 6);
});
