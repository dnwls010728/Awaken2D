import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("MCP server: initialize, list tools, create + edit + render a model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-mcp-"));
  const file = join(dir, "m.rig.json");
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/mcp/server.ts"], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (v: any) => void>();
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown = {}) =>
    new Promise<any>((res) => {
      pending.set(++id, res);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.serverInfo.name, "awaken2d");
    const list = await call("tools/list");
    assert.ok(list.result.tools.some((t: any) => t.name === "rig_apply"));
    const created = await call("tools/call", { name: "rig_new", arguments: { file, target: "spine" } });
    assert.ok(!created.result.isError, JSON.stringify(created));
    const applied = await call("tools/call", {
      name: "rig_apply",
      arguments: {
        file,
        ops: [
          { op: "addBone", id: "b", start: [0, 0], end: [40, 0] },
          { op: "addMesh", id: "m", shape: { rect: { x: 0, y: -5, width: 40, height: 10 } }, color: "#3366ff", bones: ["b"] },
        ],
        preview: { size: 128 },
      },
    });
    assert.ok(!applied.result.isError, JSON.stringify(applied.result));
    assert.equal(applied.result.content[1].type, "image");
    const imported = await call("tools/call", {
      name: "rig_import",
      arguments: { source: "examples/psd-demo/character.psd", file: join(dir, "char.rig.json"), propose: true, ik: true, target: "spine" },
    });
    assert.ok(!imported.result.isError, imported.result.content[0].text);
    assert.match(imported.result.content[0].text, /bone upper_arm_l/);
    assert.equal(imported.result.content[1].type, "image");
    const exported = await call("tools/call", {
      name: "rig_spine_export",
      arguments: { file: join(dir, "char.rig.json"), out: join(dir, "spine43"), name: "char", version: "4.3.26" },
    });
    assert.ok(!exported.result.isError, JSON.stringify(exported));
    const json43 = JSON.parse(readFileSync(join(dir, "spine43", "char.json"), "utf8"));
    assert.equal(json43.skeleton.spine, "4.3.26");
    assert.ok(json43.constraints?.some((c: any) => c.type === "ik"));
    assert.equal(json43.ik, undefined);
    const bad = await call("tools/call", { name: "rig_apply", arguments: { file, ops: [{ op: "removeBone", id: "nope" }] } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /unknown bone "nope"/);
  } finally {
    proc.kill();
  }
});
