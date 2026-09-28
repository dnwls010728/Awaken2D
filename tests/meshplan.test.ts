import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alphaGridMesh, artStats, computePose, drawList, earClip, meshQuality, meshRole, planImageMesh, signedArea } from "../src/core/index.ts";
import type { Vec2 } from "../src/core/index.ts";
import { importLayers } from "../src/import/index.ts";
import type { LayerSource } from "../src/import/index.ts";
import { exportSpineData, importSpineData, meshSpineRegions } from "../src/spine/index.ts";
import { imageOf, skeleton } from "./spine-fixture.ts";

/** An image with the pixels `inside(x, y)` opaque. */
function art(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) rgba.set([200, 120, 80, 255], (y * w + x) * 4);
  return rgba;
}
const disc = (w: number, h: number, r: number) => art(w, h, (x, y) => (x - w / 2) ** 2 + (y - h / 2) ** 2 <= r * r);

test("mesh roles: small art is rigid, names and long thin shapes decide the rest (whole words, groups too)", () => {
  const big = artStats(disc(120, 120, 55), 120, 120);
  assert.equal(meshRole(artStats(disc(16, 16, 7), 16, 16)).role, "rigid");
  assert.equal(meshRole(big).role, "standard");
  assert.equal(meshRole(big, { name: "hair_front" }).role, "flexible");
  assert.equal(meshRole(big, { name: "앞머리" }).role, "flexible");
  assert.equal(meshRole(big, { name: "upperArm" }).role, "flexible");
  assert.equal(meshRole(big, { name: "crosshair" }).role, "rigid", '"crosshair" is not "hair"');
  assert.equal(meshRole(big, { name: "armor" }).role, "standard", '"armor" is not "arm"');
  assert.equal(meshRole(big, { name: "badge", groups: ["coat"] }).role, "rigid", "the layer's own name before its group");
  assert.equal(meshRole(big, { name: "piece", groups: ["Skirt"] }).role, "flexible");
  assert.equal(meshRole(big, { name: "hand L", groups: ["Arm L"] }).role, "standard");
  const bar = artStats(art(200, 30, (x, y) => y > 5 && y < 25), 200, 30);
  assert.ok(bar.elongation > 5);
  assert.equal(meshRole(bar).role, "flexible");
  assert.equal(meshRole(big, { role: "rigid" }).role, "rigid");
});

test("planned meshes cover the art with fewer vertices and less empty space than the grid", () => {
  const w = 160;
  const h = 160;
  const img = disc(w, h, 78); // touches the image edge: the outline must still cover it
  const r = planImageMesh(img, w, h, { name: "face" });
  assert.equal(r.plan.method, "auto");
  assert.ok(r.plan.quality.coverage >= 0.999, `coverage ${r.plan.quality.coverage}`);
  const g = alphaGridMesh(img, w, h, 20, 8);
  const gq = meshQuality(g.vertices, g.triangles, img, w, h);
  assert.ok(r.plan.quality.vertices < gq.vertices, `${r.plan.quality.vertices} vs grid ${gq.vertices}`);
  assert.ok(r.plan.quality.overdraw < gq.overdraw);
  assert.ok(r.uvs.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1));
  // rigid: an outline only (no interior vertices beyond the hull)
  const small = planImageMesh(disc(20, 20, 8), 20, 20, {});
  assert.equal(small.plan.role, "rigid");
  assert.ok(small.plan.quality.vertices <= 12);
  // a hair strand gets steps along its length; density scales the budget
  const strand = art(40, 300, (x, y) => Math.abs(x - 20 - 8 * Math.sin(y / 40)) < 8);
  const s1 = planImageMesh(strand, 40, 300, { name: "hair" });
  const s2 = planImageMesh(strand, 40, 300, { name: "hair", density: 2 });
  assert.equal(s1.plan.role, "flexible");
  const ys = new Set(s1.px.map((p) => Math.round(p[1] / 30)));
  assert.ok(ys.size >= 8, `vertices along the strand: ${ys.size} bands`);
  assert.ok(s2.plan.quality.vertices > s1.plan.quality.vertices);
  assert.ok(s1.plan.quality.coverage >= 0.999);
  // Live2D budgets are denser
  assert.ok(planImageMesh(img, w, h, { name: "face", target: "live2d" }).plan.target > r.plan.target);
});

test("art in separate pieces is meshed piece by piece (no triangles across the gap)", () => {
  const w = 300;
  const h = 60;
  const img = art(w, h, (x, y) => (x - 30) ** 2 + (y - 30) ** 2 < 625 || (x - 270) ** 2 + (y - 30) ** 2 < 625);
  const r = planImageMesh(img, w, h, { name: "eyes" });
  assert.equal(r.plan.stats.pieces.length, 2);
  assert.ok(r.plan.quality.coverage >= 0.999);
  assert.ok(r.plan.quality.overdraw < 1.6, `overdraw ${r.plan.quality.overdraw}`);
  assert.ok(!r.px.some(([x]) => x > 70 && x < 230), "nothing in the gap");
});

test("ear clipping handles outlines with straight runs of collinear points", () => {
  // a rectangle with many points along its edges (as resampled outlines have)
  const poly: Vec2[] = [];
  for (let x = 0; x < 100; x += 10) poly.push([x, 0]);
  for (let y = 0; y < 30; y += 5) poly.push([100, y]);
  for (let x = 100; x > 0; x -= 10) poly.push([x, 30]);
  for (let y = 30; y > 0; y -= 5) poly.push([0, y]);
  const tris = earClip(poly);
  assert.equal(tris.length, poly.length - 2);
  const area = tris.reduce((s, t) => s + Math.abs(signedArea(t.map((i) => poly[i]))), 0);
  assert.ok(Math.abs(area - 3000) < 1e-6, `area ${area}`);
  assert.ok(tris.every((t) => Math.abs(signedArea(t.map((i) => poly[i]))) > 1e-9), "no degenerate triangles");
});

test("importLayers makes automatic meshes by default (padded crops, roles in meta.import), grid on request", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-plan-"));
  try {
    const w = 60;
    const h = 200;
    const src: LayerSource = {
      source: "t.psd",
      width: 300,
      height: 300,
      layers: [
        { name: "hair", groups: ["Head"], left: 10, top: 10, width: w, height: h, rgba: art(w, h, (x, y) => Math.abs(x - 30) < 20), visible: true, opacity: 1 },
        { name: "button", groups: [], left: 200, top: 10, width: 20, height: 20, rgba: disc(20, 20, 9), visible: true, opacity: 1 },
      ],
      warnings: [],
    };
    const res = importLayers(src, join(dir, "m.rig.json"), { meshRoles: { button: "standard" } });
    const info = (res.model.meta!.import as { layers: Array<{ slot: string; pixelRect: number[]; mesh: { method: string; role: string } }> }).layers;
    assert.deepEqual(info.map((l) => [l.slot, l.mesh.method, l.mesh.role]), [["hair", "auto", "flexible"], ["button", "auto", "standard"]]);
    // the art is 40 x 200 px at (20, 10) in the canvas; its image keeps 3 transparent pixels around it
    assert.deepEqual(info[0].pixelRect, [17, 7, 46, 206]);
    assert.equal(res.meshes!.hair.quality.coverage >= 0.999, true);
    // the mesh lies on the art, not on the padded rectangle
    const xs = res.model.attachments.hair.vertices.map((v) => v[0]);
    assert.ok(Math.max(...xs) - Math.min(...xs) < 46);
    const pose = computePose(res.model);
    assert.equal(drawList(res.model, pose).length, 2);
    const grid = importLayers(src, join(dir, "g.rig.json"), { mesh: "grid" });
    assert.equal(grid.meshes, undefined);
    assert.equal((grid.model.meta!.import as { layers: Array<{ mesh: { method: string } }> }).layers[0].mesh.method, "grid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Spine regions become automatic meshes on request, and export as meshes that read back the same", () => {
  const { model, images } = importSpineData(skeleton(), { name: "t", resolveImage: imageOf });
  const before = drawList(model, computePose(model));
  const lines = meshSpineRegions(model, images);
  assert.ok(lines.length >= 2, lines.join("\n"));
  const after = drawList(model, computePose(model));
  // same place: every new vertex maps its UV through the quad's placement
  for (const item of after) {
    const old = before.find((b) => b.attachmentId === item.attachmentId)!;
    const box = (vs: Vec2[]) => [Math.min(...vs.map((v) => v[0])), Math.max(...vs.map((v) => v[0])), Math.min(...vs.map((v) => v[1])), Math.max(...vs.map((v) => v[1]))];
    const [a0, a1, b0, b1] = box(item.positions);
    const [c0, c1, d0, d1] = box(old.positions);
    assert.ok(a0 >= c0 - 1e-3 && a1 <= c1 + 1e-3 && b0 >= d0 - 1e-3 && b1 <= d1 + 1e-3, `${item.attachmentId} inside its quad`);
  }
  const out = exportSpineData(model, { name: "t", loadImage: (id) => images.get(id) ?? null }).json;
  assert.equal(out.skins[0].attachments.body.body.type, "mesh");
  const back = importSpineData(out, { name: "t", resolveImage: imageOf }).model;
  const again = drawList(back, computePose(back));
  for (const item of after) {
    const b = again.find((x) => x.attachmentId === item.attachmentId)!;
    assert.equal(b.positions.length, item.positions.length);
    // the export writes the outline first: same points, maybe another order
    for (const p of item.positions) assert.ok(b.positions.some((v) => Math.hypot(v[0] - p[0], v[1] - p[1]) < 1e-3), `${item.attachmentId}: ${p} kept`);
  }
});
