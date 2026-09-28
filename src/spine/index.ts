// File-level Spine import/export: finds the atlas (or images folder) next to the skeleton JSON, writes region
// images for the Awaken2D model, and writes skeleton JSON + atlas + page PNG + images folder on export.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { loadModel, saveModel } from "../core/index.ts";
import type { Model } from "../core/index.ts";
import { decodePNG, encodePNG } from "../render/png.ts";
import type { RGBAImage } from "../render/png.ts";
import { extractRegion, parseAtlas } from "./atlas.ts";
import type { AtlasPage } from "./atlas.ts";
import { exportSpineData } from "./export.ts";
import { importSpineData, meshSpineRegions } from "./import.ts";

export { parseAtlas, extractRegion, packAtlas, writeAtlas } from "./atlas.ts";
export { importSpineData, meshSig, meshSpineRegions } from "./import.ts";
export { exportSpineData } from "./export.ts";

/** Image paths a Spine skeleton's region / mesh attachments draw (path, else the attachment name). */
export function skeletonImagePaths(json: unknown): Set<string> {
  const out = new Set<string>();
  const skins = (json as { skins?: unknown })?.skins;
  // 4.x: [{ name, attachments }]; 3.7 and older: { skinName: { slot: { name: attachment } } }
  const list = Array.isArray(skins) ? skins.map((s) => s?.attachments) : skins && typeof skins === "object" ? Object.values(skins) : [];
  for (const slots of list) {
    if (!slots || typeof slots !== "object") continue;
    for (const atts of Object.values(slots as Record<string, unknown>)) {
      if (!atts || typeof atts !== "object") continue;
      for (const [name, a] of Object.entries(atts as Record<string, { type?: string; path?: string }>)) {
        const type = a?.type ?? "region";
        if (type === "region" || type === "mesh" || type === "linkedmesh") out.add(a?.path ?? name);
      }
    }
  }
  return out;
}

/**
 * The atlas next to a skeleton file: name.atlas, name.atlas.txt (Spine's default export names); else, of the atlases
 * in that folder, the one holding the most of the skeleton's images (an export folder often has several, e.g.
 * spineboy.atlas and spineboy-run.atlas), then the one whose name shares the longest start with the skeleton's
 * (hero-pro.json -> hero.atlas), a straight-alpha one before a "-pma" one.
 */
export function findAtlas(jsonPath: string, json?: unknown): string | null {
  const base = jsonPath.replace(/\.json$/i, "");
  for (const p of [`${base}.atlas`, `${base}.atlas.txt`]) if (existsSync(p)) return p;
  const dir = dirname(jsonPath);
  const name = basename(base).toLowerCase();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.atlas(\.txt)?$/i.test(f));
  } catch {
    return null;
  }
  const shared = (f: string) => {
    const a = f.toLowerCase().replace(/\.atlas(\.txt)?$/, "").replace(/[-_.]pma$/, "");
    let n = 0;
    while (n < a.length && n < name.length && a[n] === name[n]) n++;
    return n;
  };
  const wanted = json ? skeletonImagePaths(json) : new Set<string>();
  const covers = (f: string) => {
    if (!wanted.size) return 0;
    try {
      return parseAtlas(readFileSync(join(dir, f), "utf8")).reduce((n, p) => n + p.regions.filter((r) => wanted.has(r.name)).length, 0);
    } catch {
      return 0;
    }
  };
  const ranked = files
    .map((f) => ({ f, c: covers(f), n: shared(f), pma: /[-_.]pma\.atlas/i.test(f) }))
    .filter((x) => x.c > 0 || x.n > 0 || files.length === 1)
    .sort((a, b) => b.c - a.c || b.n - a.n || Number(a.pma) - Number(b.pma) || a.f.localeCompare(b.f));
  return ranked.length ? join(dir, ranked[0].f) : null;
}

/**
 * The folder of loose images: the skeleton's "images" path is relative to the Spine project, which usually sits one
 * level above the export folder, so it is looked up next to the skeleton and one level up.
 */
function findImagesDir(jsonPath: string, json: { skeleton?: { images?: unknown } }): string {
  const dir = dirname(jsonPath);
  const rel = typeof json.skeleton?.images === "string" && json.skeleton.images && !/^[a-z]:|^\//i.test(json.skeleton.images) ? json.skeleton.images : "images";
  const candidates = [resolve(dir, rel), resolve(dir, "..", rel), resolve(dir, "images"), resolve(dir, "..", "images")];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

/**
 * The folder of event sounds: the skeleton's "audio" path (relative to the Spine project, like "images"), else an
 * "audio" folder next to the skeleton or one level up. Null when none exists.
 */
function findAudioDir(jsonPath: string, json: { skeleton?: { audio?: unknown } }): string | null {
  const dir = dirname(jsonPath);
  const set = typeof json.skeleton?.audio === "string" && json.skeleton.audio ? json.skeleton.audio : null;
  const candidates = [
    ...(set ? (isAbsolute(set) ? [set] : [resolve(dir, set), resolve(dir, "..", set)]) : []),
    resolve(dir, "audio"),
    resolve(dir, "..", "audio"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Where a model keeps its event sounds: audio/<event audio path> next to the model file. */
export const AUDIO_DIR = "audio";

/** An event audio path that stays inside the audio folder (relative, no ".." parts). */
export const safeAudioPath = (p: string): boolean => !!p && !isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes("..");

/** Sound files an event can play. */
export const AUDIO_EXTS = [".wav", ".ogg", ".mp3"];

/**
 * Copies a sound file into the model's audio/ folder (modelDir/audio) and returns its event audio path (the file
 * name): the same file already there is reused, another file with that name gets a numbered name.
 */
export function addEventSound(source: string, modelDir: string): string {
  const ext = extname(source).toLowerCase();
  if (!AUDIO_EXTS.includes(ext)) throw new Error(`a sound must be ${AUDIO_EXTS.join(", ")} (got "${basename(source)}")`);
  if (!existsSync(source) || statSync(source).isDirectory()) throw new Error(`no such file: ${source}`);
  const dir = join(modelDir, AUDIO_DIR);
  mkdirSync(dir, { recursive: true });
  const stem = basename(source, extname(source)).replace(/[:*?"<>|]/g, "_") || "sound";
  const bytes = readFileSync(source);
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const target = join(dir, name);
    if (!existsSync(target)) {
      writeFileSync(target, bytes);
      return name;
    }
    if (readFileSync(target).equals(bytes)) return name;
  }
}

/** Copies the model's event sounds (audio/ next to it) into outDir/audio; returns how many were copied. */
export function copyEventAudio(model: Model, baseDir: string, outDir: string): { copied: number; missing: string[] } {
  const paths = [...new Set(Object.values(model.events ?? {}).map((e) => e.audio).filter((a): a is string => !!a))];
  let copied = 0;
  const missing: string[] = [];
  for (const p of paths) {
    if (!safeAudioPath(p)) {
      missing.push(p);
      continue;
    }
    const from = join(baseDir, AUDIO_DIR, p);
    if (!existsSync(from)) {
      missing.push(p);
      continue;
    }
    const to = join(outDir, AUDIO_DIR, p);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
  return { copied, missing };
}

export interface SpineImportFileOptions {
  atlas?: string;
  /** Folder of loose PNGs (Spine "images" path) used when there is no atlas. */
  images?: string;
  name?: string;
  /**
   * "auto": region attachments become automatic meshes traced around their art (exported as meshes then). Default:
   * regions stay quads, exactly as in Spine.
   */
  mesh?: "auto";
  /** With mesh "auto": scales the vertex budgets. */
  meshDensity?: number;
}

/** Reads a Spine skeleton (+ atlas or images folder) and builds a Awaken2D model whose images live next to it. */
export function importSpineFiles(jsonPath: string, opts: SpineImportFileOptions = {}) {
  const json = JSON.parse(readFileSync(jsonPath, "utf8"));
  const atlasPath = opts.atlas ?? findAtlas(jsonPath, json);
  let pages: AtlasPage[] = [];
  const pageImages = new Map<string, RGBAImage>();
  if (atlasPath) {
    pages = parseAtlas(readFileSync(atlasPath, "utf8"));
    for (const p of pages) {
      const file = join(dirname(atlasPath), p.name);
      if (!existsSync(file)) throw new Error(`atlas page ${p.name} not found next to ${atlasPath}`);
      pageImages.set(p.name, decodePNG(readFileSync(file)));
    }
  }
  const imagesDir = opts.images ?? findImagesDir(jsonPath, json);
  const regions = new Map(pages.flatMap((p) => p.regions.map((r) => [r.name, { r, p }] as const)));
  const resolveImage = (path: string): RGBAImage | null => {
    const hit = regions.get(path);
    if (hit) return extractRegion(pageImages.get(hit.p.name)!, hit.p.pma, hit.r);
    const file = join(imagesDir, `${path}.png`);
    return existsSync(file) ? decodePNG(readFileSync(file)) : null;
  };
  const res = importSpineData(json, { name: opts.name ?? basename(jsonPath).replace(/\.json$/i, ""), resolveImage });
  if (opts.mesh === "auto") {
    const lines = meshSpineRegions(res.model, res.images, { density: opts.meshDensity });
    res.log.push(`${lines.length} region(s) turned into automatic meshes (exported as meshes)`, ...lines.map((l) => `  ${l}`));
  }
  // event sounds: found in the skeleton's audio folder, copied next to the model by importSpine
  const audioDir = findAudioDir(jsonPath, json);
  const audio = new Map<string, string>();
  for (const [name, e] of Object.entries(res.model.events ?? {})) {
    if (!e.audio || audio.has(e.audio) || !safeAudioPath(e.audio)) continue;
    const file = audioDir ? join(audioDir, e.audio) : "";
    if (file && existsSync(file)) audio.set(e.audio, file);
    else res.warnings.push(`event "${name}": sound "${e.audio}" not found${audioDir ? ` in ${audioDir}` : " (no audio folder next to the skeleton)"}; it is kept but not played`);
  }
  if (audio.size) res.log.push(`${audio.size} event sound(s) from ${audioDir}`);
  if (!atlasPath) res.log.push(`no atlas next to ${basename(jsonPath)}: images read from ${imagesDir}`);
  else res.log.push(`atlas ${basename(atlasPath)}: ${pages.reduce((n, p) => n + p.regions.length, 0)} regions on ${pages.length} page(s)`);
  return { ...res, audio };
}

/** Imports and saves: model at modelPath, region images in images/ next to it. */
export function importSpine(jsonPath: string, modelPath: string, opts: SpineImportFileOptions = {}) {
  const res = importSpineFiles(jsonPath, opts);
  const dir = dirname(resolve(modelPath));
  for (const [id, img] of res.images) {
    const file = join(dir, "images", `${id}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, encodePNG(img));
  }
  for (const [path, from] of res.audio) {
    const file = join(dir, AUDIO_DIR, path);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(from, file);
  }
  saveModel(modelPath, res.model);
  return res;
}

/** Image pixels of a model image id, read from the model's folder. */
export function modelImageLoader(model: Model, baseDir: string): (id: string) => RGBAImage | null {
  const cache = new Map<string, RGBAImage | null>();
  return (id) => {
    if (cache.has(id)) return cache.get(id)!;
    const ref = model.images?.[id];
    const file = ref ? resolve(baseDir, ref.path) : "";
    const img = ref && existsSync(file) ? decodePNG(readFileSync(file)) : null;
    cache.set(id, img);
    return img;
  };
}

export interface SpineExportFileOptions {
  name?: string;
  /** Target editor version for newly authored models (e.g. 4.3.26). */
  version?: string;
  /** Also write images/<region>.png (what the Spine editor's Import Data reads). Default true. */
  images?: boolean;
}

/** Writes <name>.json, <name>.atlas and <name>.png (+ images/) into outDir. */
export function exportSpine(modelPath: string, outDir: string, opts: SpineExportFileOptions = {}) {
  const { model, baseDir } = loadModel(modelPath);
  const name = opts.name ?? basename(modelPath).replace(/\.rig\.json$|\.json$/i, "");
  const res = exportSpineData(model, { name, version: opts.version, loadImage: modelImageLoader(model, baseDir) });
  mkdirSync(outDir, { recursive: true });
  const files = [`${name}.json`, `${name}.atlas`, `${name}.png`];
  // event sounds go to audio/ beside the JSON; a skeleton without an audio folder then points there
  const sounds = copyEventAudio(model, baseDir, outDir);
  if (sounds.copied && !res.json.skeleton.audio) res.json.skeleton.audio = `./${AUDIO_DIR}/`;
  writeFileSync(join(outDir, files[0]), JSON.stringify(res.json, null, "\t"));
  writeFileSync(join(outDir, files[1]), res.atlas);
  writeFileSync(join(outDir, files[2]), encodePNG(res.page));
  if (opts.images !== false) {
    for (const [id, img] of res.images) {
      const file = join(outDir, "images", `${id}.png`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, encodePNG(img));
    }
    files.push(`images/ (${res.images.size} png)`);
  }
  if (sounds.copied) files.push(`${AUDIO_DIR}/ (${sounds.copied} sound(s))`);
  for (const p of sounds.missing) res.warnings.push(`event sound "${p}" is not in ${AUDIO_DIR}/ next to the model: not copied`);
  return { ...res, files };
}
