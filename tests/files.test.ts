import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browseDir } from "../src/web/files.ts";

test("browseDir lists folders first, then the files with the wanted extensions (for the Import / Export pickers)", () => {
  const dir = mkdtempSync(join(tmpdir(), "awaken2d-browse-"));
  try {
    mkdirSync(join(dir, "runtime"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, "Hiyori.model3.json"), "{}");
    writeFileSync(join(dir, "hiyori.moc3"), "");
    writeFileSync(join(dir, "notes.txt"), "");
    const r = browseDir(dir, [".model3.json", ".moc3"]);
    assert.deepEqual(r.entries, [
      { name: "runtime", dir: true },
      { name: "hiyori.moc3", dir: false },
      { name: "Hiyori.model3.json", dir: false },
    ]);
    assert.ok(!r.dir.includes("\\"), "forward slashes");
    assert.equal(r.parent, join(dir, "..").replace(/\\/g, "/").replace(/\/$/, ""));
    assert.ok(r.roots.length >= 1);
    assert.equal(browseDir(dir).entries.length, 4, "no extensions: every file (hidden ones skipped)");
    assert.throws(() => browseDir(join(dir, "missing")), /no such folder/);
    assert.throws(() => browseDir(join(dir, "notes.txt")), /not a folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
