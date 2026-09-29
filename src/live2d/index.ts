// File-level Live2D import/export: imports a Cubism Editor model (.cmo3, with the .can3 animation files next to it) and
// writes the runtime set (model3.json, moc3, physics3, ...). Runtime sets are only written, never read.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { inflateRawSync, constants as zlibConstants } from "node:zlib";
import { loadModel, saveModel } from "../core/index.ts";
import type { Model } from "../core/index.ts";
import { exportLive2DData } from "./export.ts";
import { writeMoc3 } from "./moc3.ts";
import { applyLive2DMotions } from "./import.ts";
import type { Live2DImportResult } from "./import.ts";
import { cmo3ToModel, readCmo3 } from "./cmo3.ts";
import { can3ToMotions } from "./can3.ts";
import { readCaff } from "./caff.ts";

export { writeMoc3 } from "./moc3.ts";
export { syncLive2DVertices, f32, motionToAnimation, live2dMeta } from "./import.ts";
export { exportLive2DData } from "./export.ts";
export { cmo3ToModel, readCmo3 } from "./cmo3.ts";

const inflateRaw = (d: Uint8Array) => new Uint8Array(inflateRawSync(d, { finishFlush: zlibConstants.Z_SYNC_FLUSH }));

export interface Cmo3FileImport extends Live2DImportResult {
  /** Image id -> PNG bytes (the texture atlases). */
  textures: Map<string, Uint8Array>;
}

/**
 * Reads a Cubism Editor model (.cmo3): the rig, physics, names and the texture atlases the editor last rendered, and
 * the motions of its animation files (.can3): `opts.motions`, or by default every .can3 in the model's folder.
 */
export function importCmo3Files(path: string, opts: { name?: string; motions?: string[] } = {}): Cmo3FileImport {
  if (!/.cmo3$/i.test(path)) {
    throw new Error(
      /.(moc3|json)$/i.test(path)
        ? `${basename(path)} is a runtime export: import the Cubism Editor model (.cmo3) it was exported from`
        : `${basename(path)} is not a Cubism Editor model (.cmo3)`,
    );
  }
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  const { entries, xml } = readCmo3(new Uint8Array(readFileSync(path)), inflateRaw);
  const name = opts.name ?? basename(path).replace(/.cmo3$/i, "");
  const res = cmo3ToModel(xml, { name });
  const can3 = opts.motions ?? readdirSync(dirname(resolve(path))).filter((f) => /.can3$/i.test(f)).map((f) => join(dirname(resolve(path)), f));
  const motions: Array<{ group: string; index: number; file: string; json: unknown }> = [];
  for (const file of can3) {
    if (!existsSync(file)) {
      res.warnings.push(`animation file not found: ${file}`);
      continue;
    }
    const main = readCaff(new Uint8Array(readFileSync(file)), inflateRaw).find((e) => e.path === "main.xml");
    if (!main) {
      res.warnings.push(`${basename(file)} is not a Cubism animation file (.can3)`);
      continue;
    }
    const got = can3ToMotions(new TextDecoder().decode(main.data), res.uuids);
    for (const w of got.warnings) res.warnings.push(`${basename(file)}: ${w}`);
    for (const m of got.motions) motions.push({ group: "Idle", index: motions.length, file: `motion/${m.name}.motion3.json`, json: m.json });
    res.log.push(`${basename(file)}: ${got.motions.length} motion(s)`);
  }
  if (motions.length) applyLive2DMotions(res, motions);
  const textures = new Map<string, Uint8Array>();
  for (const t of res.textures) {
    const e = entries.find((x) => x.path === t.entry);
    if (e) textures.set(t.id, e.data);
    else res.warnings.push(`texture ${t.entry} is missing from the file`);
  }
  return { model: res.model, log: res.log, warnings: res.warnings, textures };
}

/**
 * Imports a Cubism Editor model (.cmo3) and saves it at modelPath, the texture atlases written to images/<model
 * name>/ next to it (each model gets its own folder: every model's pages are texture_00.png and so on).
 */
export function importLive2D(path: string, modelPath: string, opts: { name?: string; motions?: string[] } = {}): Cmo3FileImport {
  const res = importCmo3Files(path, opts);
  const dir = dirname(resolve(modelPath));
  const folder = basename(modelPath).replace(/.rig.json$|.json$/i, "") || "live2d";
  mkdirSync(join(dir, "images", folder), { recursive: true });
  for (const [id, png] of res.textures) {
    res.model.images![id] = { path: `images/${folder}/${id}.png` };
    writeFileSync(join(dir, "images", folder, `${id}.png`), png);
  }
  saveModel(modelPath, res.model);
  return res;
}

/**
 * Writes the Live2D runtime set for a model: <name>.model3.json, .moc3, .physics3.json, .cdi3.json, .pose3.json,
 * motion/*.motion3.json and <name>.textures/*.png. Returns the written files (relative to outDir) and warnings.
 */
export function exportLive2D(model: Model, baseDir: string, outDir: string, opts: { name: string }): { files: string[]; warnings: string[] } {
  const res = exportLive2DData(model, { name: opts.name });
  const files: string[] = [];
  const write = (rel: string, data: string | Uint8Array) => {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    files.push(rel);
  };
  const json = (v: unknown) => JSON.stringify(v, null, "	");
  write(`${opts.name}.moc3`, writeMoc3(res.moc));
  write(`${opts.name}.model3.json`, json(res.model3));
  if (res.physics) write(`${opts.name}.physics3.json`, json(res.physics));
  if (res.displayInfo) write(`${opts.name}.cdi3.json`, json(res.displayInfo));
  if (res.pose) write(`${opts.name}.pose3.json`, json(res.pose));
  if (res.userData) write(`${opts.name}.userdata3.json`, json(res.userData));
  for (const m of res.motions) write(m.file, json(m.json));
  for (const e of res.expressions) write(e.file, json(e.json));
  for (const t of res.textures) {
    const src = model.images?.[t] ? resolve(baseDir, model.images[t].path) : "";
    if (!src || !existsSync(src)) {
      res.warnings.push(`texture image "${t}" not found`);
      continue;
    }
    const rel = `${opts.name}.textures/${t}.png`;
    mkdirSync(join(outDir, `${opts.name}.textures`), { recursive: true });
    copyFileSync(src, join(outDir, rel));
    files.push(rel);
  }
  return { files, warnings: res.warnings };
}

/** Loads a model file and writes its Live2D runtime set into outDir (name: the model file name by default). */
export function exportLive2DFile(modelPath: string, outDir: string, opts: { name?: string } = {}): { files: string[]; warnings: string[]; name: string } {
  const { model, baseDir } = loadModel(modelPath);
  const name = opts.name ?? basename(modelPath).replace(/\.rig\.json$|\.json$/i, "");
  return { ...exportLive2D(model, baseDir, outDir, { name }), name };
}
