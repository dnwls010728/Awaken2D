// File-level Live2D import/export: reads a model3.json (or a bare .moc3) with its textures, motions, physics, pose
// and display info, and writes the runtime set back.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadModel, saveModel } from "../core/index.ts";
import type { Model } from "../core/index.ts";
import { exportLive2DData } from "./export.ts";
import { readMoc3, writeMoc3 } from "./moc3.ts";
import { applyLive2DJson, mocToModel } from "./import.ts";
import type { Live2DImportResult } from "./import.ts";

export { readMoc3, writeMoc3 } from "./moc3.ts";
export { mocToModel, syncLive2DVertices, f32, motionToAnimation, live2dMeta } from "./import.ts";
export { exportLive2DData } from "./export.ts";

export interface Live2DFileImport extends Live2DImportResult {
  /** Image id -> source PNG path. */
  textures: Map<string, string>;
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));

/** Reads a Live2D runtime model: `name.model3.json` (preferred) or a `.moc3` (textures/motions found by model3 next to it). */
export function importLive2DFiles(path: string, opts: { name?: string } = {}): Live2DFileImport {
  let model3Path: string | null = null;
  let mocPath = path;
  if (/\.json$/i.test(path)) {
    model3Path = path;
    const m3 = readJson(path);
    const moc = m3?.FileReferences?.Moc;
    if (typeof moc !== "string") throw new Error(`${basename(path)} is not a model3.json (no FileReferences.Moc)`);
    mocPath = resolve(dirname(path), moc);
  } else {
    const guess = path.replace(/\.moc3$/i, ".model3.json");
    if (existsSync(guess)) model3Path = guess;
  }
  if (!existsSync(mocPath)) throw new Error(`moc3 not found: ${mocPath}`);
  const m3 = model3Path ? readJson(model3Path) : null;
  const base = model3Path ? dirname(model3Path) : dirname(mocPath);
  const refs = m3?.FileReferences ?? {};
  const textures = new Map<string, string>();
  const texIds: string[] = [];
  const texList: string[] = Array.isArray(refs.Textures) ? refs.Textures : [];
  for (const t of texList) {
    let id = basename(t).replace(/\.png$/i, "");
    while (textures.has(id)) id += "_";
    textures.set(id, resolve(base, t));
    texIds.push(id);
  }
  const name = opts.name ?? basename(model3Path ?? mocPath).replace(/\.model3\.json$|\.moc3$/i, "");
  const res = mocToModel(readMoc3(new Uint8Array(readFileSync(mocPath))), { name, textures: texIds });
  for (const [id, p] of textures) {
    if (!existsSync(p)) res.warnings.push(`texture ${p} not found`);
    res.model.images![id] = { path: `images/${id}.png` };
  }
  if (m3) {
    const load = (rel: unknown) => (typeof rel === "string" && existsSync(resolve(base, rel)) ? readJson(resolve(base, rel)) : undefined);
    const motions: Array<{ group: string; index: number; file: string; json: unknown }> = [];
    for (const [group, list] of Object.entries((refs.Motions ?? {}) as Record<string, Array<{ File?: string }>>)) {
      (list ?? []).forEach((mo, index) => {
        const json = load(mo.File);
        if (json) motions.push({ group, index, file: mo.File!, json });
        else res.warnings.push(`motion ${mo.File} not found`);
      });
    }
    const expressions = (Array.isArray(refs.Expressions) ? refs.Expressions : []).map((e: { Name?: string; File?: string }) => ({
      name: e.Name ?? basename(e.File ?? "exp"),
      file: e.File ?? "",
      json: load(e.File),
    }));
    applyLive2DJson(res, {
      model3: m3,
      physics: load(refs.Physics),
      pose: load(refs.Pose),
      displayInfo: load(refs.DisplayInfo),
      userData: load(refs.UserData),
      motions,
      expressions,
    });
  } else res.log.push("no model3.json next to the moc3: textures, motions and physics were not read");
  return { ...res, textures };
}

/**
 * Imports and saves: the model at modelPath, textures copied to images/<model name>/ next to it (texture pages are
 * named texture_00.png and so on in every Cubism export, so each model gets its own folder).
 */
export function importLive2D(path: string, modelPath: string, opts: { name?: string } = {}): Live2DFileImport {
  const res = importLive2DFiles(path, opts);
  const dir = dirname(resolve(modelPath));
  const folder = basename(modelPath).replace(/.rig.json$|.json$/i, "") || "live2d";
  mkdirSync(join(dir, "images", folder), { recursive: true });
  for (const [id, src] of res.textures) {
    res.model.images![id] = { path: `images/${folder}/${id}.png` };
    if (existsSync(src)) copyFileSync(src, join(dir, "images", folder, `${id}.png`));
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
