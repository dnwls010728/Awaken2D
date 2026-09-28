import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, emptyModel, saveModel } from "../src/core/index.ts";
import { encodePNG } from "../src/render/index.ts";
import { startServer } from "../src/web/server.ts";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "awaken2d-srv-"));
  const file = join(root, "a.rig.json");
  mkdirSync(join(root, "images"));
  writeFileSync(join(root, "images", "i.png"), encodePNG({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }));
  saveModel(
    file,
    applyOps(emptyModel("a"), [
      { op: "addBone", id: "arm", start: [0, 0], end: [10, 0] },
      { op: "addImage", id: "i", path: "images/i.png" },
    ]).model,
  );
  const srv = await startServer({ root, port: 0 });
  const get = async (p: string) => {
    const r = await fetch(srv.url + p.replace(/^\//, ""));
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const post = async (p: string, body: unknown, type = "application/json") => {
    const r = await fetch(srv.url + p.replace(/^\//, ""), { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  return { root, file, srv, get, post };
}

test("editor server: edits stay in the working copy until saved; undo/redo; revert", async () => {
  const { file, srv, get, post } = await setup();
  try {
    assert.deepEqual((await get("/api/files")).json.files, ["a.rig.json"]);
    const applied = await post("/api/apply", { file: "a.rig.json", ops: [{ op: "updateBone", id: "arm", rotation: 45 }] });
    assert.equal(applied.status, 200);
    assert.equal(applied.json.dirty, true);
    assert.doesNotMatch(readFileSync(file, "utf8"), /"rotation":45/, "not written before Save");
    assert.deepEqual((await get("/api/files")).json.dirty, ["a.rig.json"]);

    const bad = await post("/api/apply", { file: "a.rig.json", ops: [{ op: "removeBone", id: "nope" }] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /unknown bone "nope"/);

    assert.equal((await post("/api/undo", { file: "a.rig.json" })).json.model.bones[1].rotation, 0);
    assert.equal((await post("/api/redo", { file: "a.rig.json" })).json.model.bones[1].rotation, 45);

    const saved = await post("/api/save", { file: "a.rig.json" });
    assert.equal(saved.json.dirty, false);
    assert.match(readFileSync(file, "utf8"), /"rotation":45/);

    await post("/api/apply", { file: "a.rig.json", ops: [{ op: "updateBone", id: "arm", rotation: 90 }] });
    const reverted = await post("/api/revert", { file: "a.rig.json" });
    assert.equal(reverted.json.model.bones[1].rotation, 45);
    assert.equal(reverted.json.dirty, false);
  } finally {
    srv.close();
  }
});

test("editor server: disk changes reload a clean document and raise a conflict on a dirty one", async () => {
  const { file, srv, get, post } = await setup();
  try {
    await get("/api/model?file=a.rig.json"); // opens and watches
    writeFileSync(file, readFileSync(file, "utf8").replace('"length":10', '"length":20'));
    let m = null;
    for (let i = 0; i < 40; i++) {
      m = (await get("/api/model?file=a.rig.json")).json;
      if (m.model.bones[1].length === 20) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(m.model.bones[1].length, 20, "clean document follows the disk");

    await post("/api/apply", { file: "a.rig.json", ops: [{ op: "updateBone", id: "arm", rotation: 30 }] });
    writeFileSync(file, readFileSync(file, "utf8").replace('"length":20', '"length":25'));
    for (let i = 0; i < 40; i++) {
      m = (await get("/api/model?file=a.rig.json")).json;
      if (m.conflict) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(m.conflict, true);
    assert.equal(m.model.bones[1].rotation, 30, "unsaved edits are kept until the user decides");
    const resolved = await post("/api/resolve", { file: "a.rig.json", use: "disk" });
    assert.equal(resolved.json.model.bones[1].length, 25);
    assert.equal(resolved.json.conflict, false);
  } finally {
    srv.close();
  }
});

test("editor server: lean edits skip the model; full validation arrives from the worker", async () => {
  const { srv, get, post } = await setup();
  try {
    const lean = await post("/api/apply", { file: "a.rig.json", ops: [{ op: "updateBone", id: "arm", rotation: 5 }], lean: true });
    assert.equal(lean.status, 200);
    assert.equal(lean.json.model, undefined, "lean responses leave the model out");
    assert.equal(typeof lean.json.version, "number");
    let m = null;
    for (let i = 0; i < 100; i++) {
      m = (await get("/api/model?file=a.rig.json")).json;
      if (!m.validating) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(m.validating, false, "worker validation finished");
    assert.ok(Array.isArray(m.issues));
    assert.equal(m.model.bones[1].rotation, 5);
  } finally {
    srv.close();
  }
});

test("editor server: Spine import (images folder) and export", async () => {
  const { root, srv, post } = await setup();
  try {
    const { skeleton, imageOf, IMAGES } = await import("./spine-fixture.ts");
    mkdirSync(join(root, "spine", "images"), { recursive: true });
    writeFileSync(join(root, "spine", "hero.json"), JSON.stringify(skeleton()));
    for (const n of Object.keys(IMAGES)) writeFileSync(join(root, "spine", "images", `${n}.png`), encodePNG(imageOf(n)!));
    const imp = await post("/api/spine-import", { source: "spine/hero.json", file: "rigs/hero.rig.json" });
    assert.equal(imp.status, 200, imp.json.error);
    assert.equal(imp.json.model.bones.length, 4);
    assert.ok(existsSync(join(root, "rigs", "images", "body.png")), "region images written beside the model");
    const exp = await post("/api/spine-export", { file: "rigs/hero.rig.json", out: "export/hero" });
    assert.equal(exp.status, 200, exp.json.error);
    for (const f of ["hero.json", "hero.atlas", "hero.png", "images/arm.png"]) assert.ok(existsSync(join(root, "export", "hero", f)), f);
    assert.equal((await post("/api/spine-export", { file: "rigs/hero.rig.json", out: "../outside" })).status, 403);
  } finally {
    srv.close();
  }
});

test("editor server: Live2D import (.cmo3) and export", async () => {
  const { root, srv, post } = await setup();
  try {
    const { cmo3Fixture } = await import("./cmo3-fixture.ts");
    const { exportLive2DData, writeMoc3 } = await import("../src/live2d/index.ts");
    const { live2dRig } = await import("./live2d-fixture.ts");
    mkdirSync(join(root, "l2d"), { recursive: true });
    writeFileSync(join(root, "l2d", "f.cmo3"), cmo3Fixture().file);
    const imp = await post("/api/live2d-import", { source: "l2d/f.cmo3", file: "rigs/f.rig.json" });
    assert.equal(imp.status, 200, imp.json.error);
    assert.equal(imp.json.model.slots.length, 3);
    assert.ok(existsSync(join(root, "rigs", "images", "f", "texture_00.png")));
    const exp = await post("/api/live2d-export", { file: "rigs/f.rig.json", out: "export/f", name: "f" });
    assert.equal(exp.status, 200, exp.json.error);
    for (const f of ["f.model3.json", "f.moc3", "f.physics3.json", "f.textures/texture_00.png"]) assert.ok(existsSync(join(root, "export", "f", f)), f);
    assert.equal((await post("/api/live2d-export", { file: "rigs/f.rig.json", out: "../outside" })).status, 403);
    assert.equal((await post("/api/live2d-import", { source: "l2d/missing.cmo3", file: "rigs/g.rig.json" })).status, 400);
    // runtime exports are not imported
    writeFileSync(join(root, "l2d", "r.moc3"), writeMoc3(exportLive2DData(live2dRig(), { name: "r" }).moc));
    const rt = await post("/api/live2d-import", { source: "l2d/r.moc3", file: "rigs/r.rig.json" });
    assert.equal(rt.status, 400);
    assert.match(rt.json.error, /runtime export/);
  } finally {
    srv.close();
  }
});

test("editor server: deleting an open file's folder does not take the server down", async () => {
  const { root, srv, get, post } = await setup();
  try {
    mkdirSync(join(root, "gone"));
    saveModel(join(root, "gone", "x.rig.json"), emptyModel("x", "spine"));
    await get("/api/model?file=gone/x.rig.json"); // opens and watches
    rmSync(join(root, "gone"), { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual((await get("/api/files")).json.files, ["a.rig.json"]);
  } finally {
    srv.close();
  }
});

test("editor server: deleting a project moves it and its own images to .awaken2d-trash", async () => {
  const { root, srv, get, post } = await setup();
  try {
    mkdirSync(join(root, "p", "images", "own"), { recursive: true });
    writeFileSync(join(root, "p", "images", "own", "t.png"), encodePNG({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) }));
    const m = applyOps(emptyModel("p", "spine"), [
      { op: "addImage", id: "own", path: "images/own/t.png" },
      { op: "addImage", id: "shared", path: "../images/i.png" },
    ]).model;
    saveModel(join(root, "p", "p.rig.json"), m);
    await post("/api/apply", { file: "p/p.rig.json", ops: [{ op: "setMeta", name: "edited" }] });
    assert.equal((await post("/api/delete", { file: "p/p.rig.json" })).status, 409, "unsaved edits are not dropped silently");
    const del = await post("/api/delete", { file: "p/p.rig.json", discard: true });
    assert.equal(del.status, 200, del.json.error);
    assert.ok(!existsSync(join(root, "p", "p.rig.json")));
    assert.ok(!existsSync(join(root, "p", "images", "own")), "its own image (and the emptied folder) went too");
    assert.ok(existsSync(join(root, "images", "i.png")), "an image another model uses stays");
    assert.ok(existsSync(join(root, del.json.trash, "p", "p.rig.json")), "recoverable from the trash");
    assert.deepEqual((await get("/api/files")).json.files, ["a.rig.json"], "the trash is not listed");
    assert.equal((await post("/api/delete", { file: "../x.rig.json" })).status, 403);
  } finally {
    srv.close();
  }
});

test("editor server: new, save-as (image paths follow), CSRF and path safety", async () => {
  const { root, srv, get, post } = await setup();
  try {
    await post("/api/apply", { file: "a.rig.json", ops: [{ op: "updateBone", id: "arm", rotation: 12 }] });
    const as = await post("/api/save-as", { file: "a.rig.json", to: "sub/b.rig.json" });
    assert.equal(as.json.file, "sub/b.rig.json");
    assert.equal(as.json.model.images.i.path, "../images/i.png");
    assert.equal(as.json.model.bones[1].rotation, 12);
    assert.ok(existsSync(join(root, "sub", "b.rig.json")));
    assert.equal((await get("/api/model?file=a.rig.json")).json.dirty, false, "the original keeps its disk content");
    assert.equal((await post("/api/save-as", { file: "a.rig.json", to: "sub/b.rig.json" })).status, 409);

    assert.equal((await post("/api/new", { file: "c.rig.json", name: "c" })).status, 404, "new models come from agents (rig_new), not the editor");

    assert.equal((await post("/api/apply", { file: "a.rig.json", ops: [] }, "text/plain")).status, 415, "non-JSON POSTs are refused");
    assert.equal((await get("/api/model?file=../outside.rig.json")).status, 403);
    assert.equal((await post("/api/save-as", { file: "a.rig.json", to: "../escape.rig.json" })).status, 403);
    assert.equal((await post("/api/import", { file: "d.rig.json", source: "missing.psd" })).status, 404, "the editor has no importer (use the CLI / MCP)");

    const js = await fetch(srv.url + "src/core/model.ts").then((r) => r.text());
    assert.ok(!js.includes("interface LoadedModel"), "types stripped");
    assert.match(js, /from "\/web\/shims\/fs\.js"/);
  } finally {
    srv.close();
  }
});
