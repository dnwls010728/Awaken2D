// Converts layered art (PSD, PNG stack, single PNG) into a Awaken2D model: one slot + textured mesh per layer.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { alphaGridMesh, triArea } from "../core/geometry.ts";
import { formatColor, round } from "../core/math.ts";
import { emptyModel } from "../core/model.ts";
import { describePlan, planImageMesh } from "../core/meshplan.ts";
import type { MeshPlan, MeshRole } from "../core/meshplan.ts";
import type { BlendMode, MeshAttachment, Model, Tri, Vec2 } from "../core/types.ts";
import { decodePNG, encodePNG } from "../render/png.ts";
import { readPsd } from "./psd.ts";

export { alphaGridMesh };

export interface SourceLayer {
  name: string;
  groups: string[];
  left: number;
  top: number;
  width: number;
  height: number;
  rgba: Uint8Array;
  visible: boolean;
  opacity: number;
  /** PSD blend mode key ("norm", "mul ", "scrn", "lddg", ...). */
  blendMode?: string;
  /** Clipped to the nearest unclipped layer below it in the same group. */
  clipped?: boolean;
}

export interface LayerSource {
  /** Where the layers came from (file or folder name). */
  source: string;
  width: number;
  height: number;
  /** Back to front. */
  layers: SourceLayer[];
  warnings: string[];
}

export type OriginSpec = "content" | "canvas-bottom" | "center" | "top-left" | [number, number];

export interface ImportOptions {
  /** Model name. Default: source file name. */
  name?: string;
  /**
   * Pixel position that becomes world (0, 0). Default: canvas center for Live2D,
   * bottom-center of the visible art for Spine. Explicit origin always takes precedence.
   */
  origin?: OriginSpec;
  /** World units per pixel. Default 1. */
  scale?: number;
  /**
   * "auto" (default): per layer, a mesh traced around the art with settings chosen from its size, shape and name
   * (see core/meshplan.ts); "grid": a grid over the solid cells (the default when `spacing` is given).
   */
  mesh?: "auto" | "grid";
  /** Scales every automatic mesh's vertex budget (e.g. 1.5 = denser). Default 1. */
  meshDensity?: number;
  /** Role per layer (slot id, layer name or "group/.../name" path) instead of the automatic choice. */
  meshRoles?: Record<string, MeshRole>;
  /** What the model is for: Live2D art meshes get a denser budget (warp deformers bend them). */
  target?: "spine" | "live2d";
  /**
   * Grid mesh cell size in pixels, or a function choosing it per layer (after resampling and cropping).
   * Default: ~1/8 of the layer's longest side, at least 8.
   */
  spacing?: number | ((layer: SourceLayer, width: number, height: number) => number);
  /** Import hidden layers too (their slots start empty). Default false. */
  includeHidden?: boolean;
  /** Alpha (0..255) above which a pixel counts as solid for cropping and meshing. Default 4. */
  alphaThreshold?: number;
  /** Folder for extracted layer PNGs, relative to the model file. Default "images". */
  imageDir?: string;
  /** Resample every layer by this factor first (e.g. 0.35 for a 6000px PSD). Default 1. */
  resample?: number;
  /** Skip layers whose "group/.../name" path matches. */
  skip?: RegExp;
}

export interface ImportedLayerInfo {
  slot: string;
  name: string;
  groups: string[];
  /** Cropped pixel rect in the source canvas: [left, top, width, height]. */
  pixelRect: [number, number, number, number];
  visible: boolean;
  /** How its mesh was made: automatic (role and why) or a grid. */
  mesh?: { method: "auto" | "grid"; role?: MeshRole; reasons?: string[] };
}

export interface ImportResult {
  model: Model;
  log: string[];
  warnings: string[];
  /** The automatic mesh chosen for each layer (by slot id), when meshes were automatic. */
  meshes?: Record<string, MeshPlan>;
}

/** Transparent room kept around each cropped layer image: the traced outline needs it to stay off the art. */
const AUTO_PAD = 3;

/** Reads a PSD/PSB, a single PNG, or a folder of PNGs (optionally ordered by layers.json). */
export function readLayerSource(path: string): LayerSource {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`source not found: ${full}`);
  if (statSync(full).isDirectory()) return readPngFolder(full);
  const ext = extname(full).toLowerCase();
  if (ext === ".psd" || ext === ".psb") {
    const doc = readPsd(readFileSync(full));
    return { source: basename(full), width: doc.width, height: doc.height, layers: doc.layers, warnings: doc.warnings };
  }
  if (ext === ".png") {
    const img = decodePNG(readFileSync(full));
    return {
      source: basename(full),
      width: img.width,
      height: img.height,
      layers: [{ name: basename(full, ext), groups: [], left: 0, top: 0, width: img.width, height: img.height, rgba: img.data, visible: true, opacity: 1 }],
      warnings: [],
    };
  }
  throw new Error(`unsupported source "${ext}" (use .psd, .psb, .png, or a folder of PNGs)`);
}

interface ManifestEntry {
  file: string;
  name?: string;
  x?: number;
  y?: number;
  groups?: string[];
  hidden?: boolean;
  opacity?: number;
}

/**
 * Folder of PNGs. Without a manifest, files are layered back-to-front in natural filename order and
 * placed at (0, 0) (typical "export layers to files" output with full-canvas images).
 * layers.json: [{ "file": "arm.png", "name": "arm_l", "x": 120, "y": 40 }, ...] back to front.
 */
function readPngFolder(dir: string): LayerSource {
  const manifestPath = join(dir, "layers.json");
  let entries: ManifestEntry[];
  if (existsSync(manifestPath)) {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[] | { layers: ManifestEntry[] };
    entries = Array.isArray(parsed) ? parsed : parsed.layers;
  } else {
    entries = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((file) => ({ file }));
  }
  if (!entries.length) throw new Error(`no PNG layers in ${dir}`);
  let width = 0;
  let height = 0;
  const layers: SourceLayer[] = entries.map((e) => {
    const img = decodePNG(readFileSync(join(dir, e.file)));
    const left = e.x ?? 0;
    const top = e.y ?? 0;
    width = Math.max(width, left + img.width);
    height = Math.max(height, top + img.height);
    return {
      // "03_arm.png" -> "arm"; a purely numeric name like "01.png" stays "01"
      name: e.name ?? (basename(e.file, extname(e.file)).replace(/^\d+[\s_-]*/, "") || basename(e.file, extname(e.file))),
      groups: e.groups ?? [],
      left,
      top,
      width: img.width,
      height: img.height,
      rgba: img.data,
      visible: e.hidden !== true,
      opacity: e.opacity ?? 1,
    };
  });
  return { source: basename(dir), width, height, layers, warnings: [] };
}

const BLEND_FROM_PSD: Record<string, BlendMode> = { "mul ": "multiply", scrn: "screen", lddg: "additive", "lnDg": "additive" };

/**
 * Clipping: each clipped layer only shows where the nearest unclipped layer below it (same group) is opaque.
 * Bakes that into the clipped layer's alpha in place. Returns how many layers were baked.
 */
export function bakeClipping(layers: SourceLayer[]): number {
  let count = 0;
  layers.forEach((l, i) => {
    if (!l.clipped) return;
    const path = l.groups.join("/");
    let base: SourceLayer | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (layers[j].groups.join("/") === path && !layers[j].clipped) {
        base = layers[j];
        break;
      }
    }
    if (!base) return;
    const rgba = new Uint8Array(l.rgba);
    for (let y = 0; y < l.height; y++) {
      const by = l.top + y - base.top;
      for (let x = 0; x < l.width; x++) {
        const bx = l.left + x - base.left;
        const ba = bx >= 0 && by >= 0 && bx < base.width && by < base.height ? base.rgba[(by * base.width + bx) * 4 + 3] : 0;
        const o = (y * l.width + x) * 4 + 3;
        rgba[o] = Math.round((rgba[o] * ba) / 255);
      }
    }
    l.rgba = rgba;
    l.clipped = false;
    count++;
  });
  return count;
}

/** Box-filter downscale of a layer (premultiplied), keeping its canvas position proportional. */
export function resampleLayer(l: SourceLayer, f: number): SourceLayer {
  const left = Math.floor(l.left * f);
  const top = Math.floor(l.top * f);
  const right = Math.ceil((l.left + l.width) * f);
  const bottom = Math.ceil((l.top + l.height) * f);
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  const acc = new Float64Array(w * h * 4);
  const area = new Float64Array(w * h);
  for (let y = 0; y < l.height; y++) {
    const ty = Math.min(h - 1, Math.floor((l.top + y) * f) - top);
    for (let x = 0; x < l.width; x++) {
      const tx = Math.min(w - 1, Math.floor((l.left + x) * f) - left);
      const i = (y * l.width + x) * 4;
      const a = l.rgba[i + 3];
      const o = ty * w + tx;
      acc[o * 4] += l.rgba[i] * a;
      acc[o * 4 + 1] += l.rgba[i + 1] * a;
      acc[o * 4 + 2] += l.rgba[i + 2] * a;
      acc[o * 4 + 3] += a;
      area[o]++;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let o = 0; o < w * h; o++) {
    const a = acc[o * 4 + 3];
    if (a > 0) for (let c = 0; c < 3; c++) rgba[o * 4 + c] = Math.round(acc[o * 4 + c] / a);
    rgba[o * 4 + 3] = area[o] ? Math.round(a / area[o]) : 0;
  }
  return { ...l, left, top, width: w, height: h, rgba };
}

/** Turns a layer name into a unique slot id (letters incl. non-Latin, digits, _ . -). */
export function slotIdFor(name: string, used: Set<string>): string {
  let base = name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_.\-]/gu, "")
    .replace(/^[_.\-]+|[_.\-]+$/g, "");
  if (!base) base = "layer";
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

function alphaBounds(l: SourceLayer, threshold: number): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < l.height; y++) {
    for (let x = 0; x < l.width; x++) {
      if (l.rgba[(y * l.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

/** Pixels of a box of the layer; parts of the box outside the layer are transparent. */
function crop(l: SourceLayer, [x0, y0, w, h]: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const sx0 = Math.max(0, x0);
  const sx1 = Math.min(l.width, x0 + w);
  if (sx1 <= sx0) return out;
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= l.height) continue;
    out.set(l.rgba.subarray((sy * l.width + sx0) * 4, (sy * l.width + sx1) * 4), (y * w + sx0 - x0) * 4);
  }
  return out;
}


function resolveOrigin(spec: OriginSpec, src: LayerSource, content: [number, number, number, number] | null): [number, number] {
  if (Array.isArray(spec)) return spec;
  switch (spec) {
    case "canvas-bottom":
      return [src.width / 2, src.height];
    case "center":
      return [src.width / 2, src.height / 2];
    case "top-left":
      return [0, 0];
    default:
      return content ? [round(content[0] + content[2] / 2, 1), content[1] + content[3]] : [src.width / 2, src.height];
  }
}

/**
 * Builds a model from layers and writes each cropped layer as a PNG next to the model.
 * All slots start on the root bone with rigid weights; use proposeBones to rig them.
 */
export function importLayers(src: LayerSource, modelPath: string, opts: ImportOptions = {}): ImportResult {
  const threshold = opts.alphaThreshold ?? 4;
  const scale = opts.scale ?? 1;
  if (!(scale > 0)) throw new Error("scale must be > 0");
  const modelDir = dirname(resolve(modelPath));
  const imageDir = resolve(modelDir, opts.imageDir ?? "images");
  const warnings = [...src.warnings];
  const log: string[] = [];

  const factor = opts.resample ?? 1;
  if (!(factor > 0 && factor <= 1)) throw new Error("resample must be in (0, 1]");
  const kept = src.layers.filter((l) => {
    if (opts.skip && opts.skip.test([...l.groups, l.name].join("/"))) {
      log.push(`skipped "${[...l.groups, l.name].join("/")}" (matches skip)`);
      return false;
    }
    return true;
  });
  // clipping masks: bake the base layer's alpha into the clipped layer, which stays a separate slot
  const clippedCount = bakeClipping(src.layers);
  if (clippedCount) log.push(`baked ${clippedCount} clipping mask(s) into their layers' alpha`);
  src = factor < 1 ? { ...src, width: Math.round(src.width * factor), height: Math.round(src.height * factor) } : src;
  const layers = factor < 1 ? kept.map((l) => resampleLayer(l, factor)) : kept;

  const prepared = layers
    .map((l) => ({ l, box: alphaBounds(l, threshold) }))
    .filter(({ l, box }) => {
      if (!box) {
        log.push(`skipped empty layer "${l.name}"`);
        return false;
      }
      if (!l.visible && !opts.includeHidden) {
        log.push(`skipped hidden layer "${l.name}" (use includeHidden to keep it)`);
        return false;
      }
      return true;
    });
  if (!prepared.length) throw new Error("no visible, non-empty layers to import");

  // content bounds in canvas pixels (visible layers only)
  let cx0 = Infinity;
  let cy0 = Infinity;
  let cx1 = -Infinity;
  let cy1 = -Infinity;
  for (const { l, box } of prepared) {
    if (!l.visible) continue;
    cx0 = Math.min(cx0, l.left + box![0]);
    cy0 = Math.min(cy0, l.top + box![1]);
    cx1 = Math.max(cx1, l.left + box![0] + box![2]);
    cy1 = Math.max(cy1, l.top + box![1] + box![3]);
  }
  const content: [number, number, number, number] | null = Number.isFinite(cx0) ? [cx0, cy0, cx1 - cx0, cy1 - cy0] : null;
  const [ox, oy] = resolveOrigin(opts.origin ?? (opts.target === "live2d" ? "center" : "content"), src, content);
  const toWorld = (px: number, py: number): Vec2 => [round((px - ox) * scale, 3), round((oy - py) * scale, 3)];

  const model = emptyModel(opts.name ?? basename(src.source, extname(src.source)));
  const used = new Set<string>(["root"]);
  const infos: ImportedLayerInfo[] = [];
  mkdirSync(imageDir, { recursive: true });

  const auto = (opts.mesh ?? (opts.spacing !== undefined ? "grid" : "auto")) === "auto";
  const meshes: Record<string, MeshPlan> = {};
  for (const { l, box: tight } of prepared) {
    // automatic meshes: the crop keeps a few transparent pixels around the art (outside the layer they are empty)
    const pad = auto ? AUTO_PAD : 0;
    const box: [number, number, number, number] = [tight![0] - pad, tight![1] - pad, tight![2] + 2 * pad, tight![3] + 2 * pad];
    const [bx, by, bw, bh] = box;
    const id = slotIdFor(l.name, used);
    const pixels = crop(l, box);
    const file = join(imageDir, `${id}.png`);
    writeFileSync(file, encodePNG({ width: bw, height: bh, data: pixels }));
    const rel = relative(modelDir, file).split("\\").join("/");
    model.images![id] = { path: rel };

    let grid: { vertices: Vec2[]; triangles: Tri[] };
    let plan: MeshPlan | undefined;
    if (auto) {
      const path = [...l.groups, l.name].join("/");
      const role = opts.meshRoles?.[id] ?? opts.meshRoles?.[path] ?? opts.meshRoles?.[l.name];
      const r = planImageMesh(pixels, bw, bh, { name: l.name, groups: l.groups, target: opts.target, alphaThreshold: threshold, role, density: opts.meshDensity });
      grid = { vertices: r.px.map(([x, y]) => [round(x, 3), round(y, 3)] as Vec2), triangles: r.triangles };
      plan = r.plan;
      meshes[id] = plan;
    } else {
      const spacing =
        typeof opts.spacing === "function" ? Math.max(2, opts.spacing(l, bw, bh)) : (opts.spacing ?? Math.max(8, Math.round(Math.max(bw, bh) / 8)));
      grid = alphaGridMesh(pixels, bw, bh, spacing, threshold);
    }
    const left = l.left + bx;
    const top = l.top + by;
    const vertices = grid.vertices.map(([x, y]) => toWorld(left + x, top + y));
    // pixel space is y-down, world is y-up: flip winding so triangles are CCW in world space
    const triangles = grid.triangles.map((t): Tri => (triArea(vertices[t[0]], vertices[t[1]], vertices[t[2]]) < 0 ? [t[0], t[2], t[1]] : t));
    const att: MeshAttachment = {
      type: "mesh",
      image: id,
      vertices,
      uvs: grid.vertices.map(([x, y]) => [round(x / bw, 5), round(y / bh, 5)]),
      triangles,
      weights: vertices.map(() => [["root", 1]]),
    };
    model.attachments[id] = att;
    model.slots.push({
      id,
      bone: "root",
      attachment: l.visible ? id : null,
      color: l.opacity < 1 ? formatColor([1, 1, 1, l.opacity]) : "#ffffff",
      ...(BLEND_FROM_PSD[l.blendMode ?? ""] ? { blend: BLEND_FROM_PSD[l.blendMode!] } : {}),
    });
    infos.push({
      slot: id,
      name: l.name,
      groups: l.groups,
      pixelRect: [left, top, bw, bh],
      visible: l.visible,
      mesh: plan ? { method: plan.method, role: plan.role, reasons: plan.reasons } : { method: "grid" },
    });
    if (l.blendMode && l.blendMode !== "norm" && l.blendMode !== "pass" && !BLEND_FROM_PSD[l.blendMode]) {
      warnings.push(`layer "${[...l.groups, l.name].join("/")}": blend mode "${l.blendMode.trim()}" is not supported, imported as normal`);
    }
    log.push(
      `layer "${[...l.groups, l.name].join("/")}" -> slot ${id} (${bw}x${bh}px, ${plan ? describePlan(plan) : `grid mesh: ${att.vertices.length} vertices, ${att.triangles.length} triangles`})`,
    );
  }

  model.meta = {
    import: {
      source: src.source,
      canvas: { width: src.width, height: src.height },
      origin: [ox, oy],
      scale,
      layers: infos,
    },
  };
  return { model, log, warnings, ...(auto ? { meshes } : {}) };
}
