#!/usr/bin/env node
// MCP server (stdio, newline-delimited JSON-RPC 2.0) exposing Awaken2D to AI agents.
// Stateless: every tool takes a model file path, reads it, and writes it back when editing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  OP_NAMES,
  applyOps,
  describeModel,
  emptyModel,
  formatIssues,
  loadModel,
  saveModel,
  summarizeModel,
  validateModel,
} from "../core/index.ts";
import type { MeshRole, Op } from "../core/index.ts";
import { encodePNG, renderParamSheet, renderPose, renderSheet } from "../render/index.ts";
import type { Overlay } from "../render/index.ts";
import { importLayers, proposeBones, readLayerSource } from "../import/index.ts";
import type { OriginSpec } from "../import/index.ts";
import { exportSpine, importSpine } from "../spine/index.ts";
import { exportLive2DFile, importLive2D } from "../live2d/index.ts";

// stdout belongs to the protocol
console.log = (...a: unknown[]) => console.error(...a);

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  isError?: boolean;
}
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => ToolResult;
}

const fileProp = { type: "string", description: "Path to the model JSON (*.rig.json), relative to the server's working directory or absolute." };
const overlayProp = {
  type: "array",
  items: { type: "string", enum: ["bones", "names", "mesh", "axes", "warps"] },
  description: "Debug overlays drawn on top: bones (segments+joints), names (bone labels), mesh (wireframe), axes (world origin).",
};

const paramsProp = {
  type: "object",
  additionalProperties: { type: "number" },
  description: 'Parameter values to pin, e.g. {"AngleX": 30, "EyeOpen": 0}; others come from the animation or their defaults.',
};

function paramsOf(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object") return undefined;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number"));
}

const text = (t: string): Content => ({ type: "text", text: t });
const image = (png: Buffer): Content => ({ type: "image", data: png.toString("base64"), mimeType: "image/png" });

function overlayOf(v: unknown): Overlay {
  const o: Overlay = {};
  const list = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [];
  for (const s of list) {
    const k = String(s).trim();
    if (k === "all") Object.assign(o, { bones: true, names: true, mesh: true, axes: true });
    else if (k === "bones" || k === "names" || k === "mesh" || k === "axes" || k === "warps") o[k] = true;
  }
  return o;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`"${name}" must be a non-empty string`);
  return v;
};
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const TOOLS: Tool[] = [
  {
    name: "rig_spec",
    description:
      "Returns the Awaken2D model format and the full edit-op reference. Read this once before editing models with rig_apply.",
    inputSchema: { type: "object", properties: {} },
    run: () => ({ content: [text(readFileSync(resolve(here, "../../docs/FORMAT.md"), "utf8"))] }),
  },
  {
    name: "rig_new",
    description:
      "Creates a new empty model. The target decides what it is made for, and the editor and ops only offer that kind's features: " +
      '"spine" (Spine2D: bones, weighted meshes, IK, bone / slot / deform / draw-order / event timelines; exports with rig_spine_export) or ' +
      '"live2d" (Live2D: art meshes on a canvas shaped by parameters through keyforms, warp / rotation deformers, parts, parameter and part-opacity ' +
      "tracks; exports with rig_live2d_export). Ask the user which one when it is not clear. New models are only made this way (the editor has no New).",
    inputSchema: {
      type: "object",
      properties: {
        file: fileProp,
        target: { type: "string", enum: ["spine", "live2d"], description: "Spine2D or Live2D model." },
        name: { type: "string" },
        force: { type: "boolean", description: "Overwrite an existing file." },
      },
      required: ["file", "target"],
    },
    run: (a) => {
      const file = resolve(str(a.file, "file"));
      if (a.target !== "spine" && a.target !== "live2d") throw new Error('target must be "spine" or "live2d"');
      if (existsSync(file) && a.force !== true) throw new Error(`${file} already exists (pass force: true to overwrite)`);
      mkdirSync(dirname(file), { recursive: true });
      saveModel(file, emptyModel(typeof a.name === "string" ? a.name : "untitled", a.target));
      return { content: [text(`created ${file} (${a.target === "live2d" ? "Live2D" : "Spine2D"} model)`)] };
    },
  },
  {
    name: "rig_describe",
    description:
      "Describes a model in its setup pose: bone tree with local and world transforms, slots in draw order with mesh stats, bounds, weight influences, and animation tracks.",
    inputSchema: {
      type: "object",
      properties: { file: fileProp, json: { type: "boolean", description: "Return structured JSON instead of text." } },
      required: ["file"],
    },
    run: (a) => {
      const { model } = loadModel(str(a.file, "file"));
      return { content: [text(a.json ? JSON.stringify(summarizeModel(model), null, 2) : describeModel(model))] };
    },
  },
  {
    name: "rig_validate",
    description:
      "Validates structure (ids, hierarchy, weights, triangles, key tracks, images) and samples every animation for folding/flipped triangles and NaN vertices.",
    inputSchema: { type: "object", properties: { file: fileProp }, required: ["file"] },
    run: (a) => {
      const { model, baseDir } = loadModel(str(a.file, "file"));
      const issues = validateModel(model, { baseDir });
      return { content: [text(formatIssues(issues))], isError: issues.some((i) => i.level === "error") };
    },
  },
  {
    name: "rig_apply",
    description:
      "Applies a list of edit ops to a model atomically (all succeed or nothing is written), then validates. " +
      `Ops: ${OP_NAMES.join(", ")}. See rig_spec for fields. ` +
      'Example: [{"op":"addBone","id":"arm","parent":"root","start":[0,100],"end":[60,100]},' +
      '{"op":"addMesh","id":"arm_skin","shape":{"rect":{"x":0,"y":90,"width":60,"height":20},"cols":6},"color":"#e0a070","bones":["arm"]}]. ' +
      "Set preview to get a rendered image of the result in the same call.",
    inputSchema: {
      type: "object",
      properties: {
        file: fileProp,
        ops: { type: "array", items: { type: "object", properties: { op: { type: "string", enum: OP_NAMES } }, required: ["op"] } },
        dryRun: { type: "boolean", description: "Validate and preview without writing the file." },
        preview: {
          type: "object",
          description: "Render after applying.",
          properties: { animation: { type: "string" }, time: { type: "number" }, size: { type: "number" }, overlay: overlayProp },
        },
      },
      required: ["file", "ops"],
    },
    run: (a) => {
      const file = str(a.file, "file");
      if (!Array.isArray(a.ops)) throw new Error('"ops" must be an array');
      const { model, baseDir } = loadModel(file);
      const res = applyOps(model, a.ops as Op[]);
      const issues = validateModel(res.model, { baseDir });
      if (a.dryRun !== true) saveModel(resolve(file), res.model);
      const content: Content[] = [
        text(
          res.log.map((l) => "- " + l).join("\n") +
            "\n" +
            formatIssues(issues) +
            (a.dryRun === true ? "\n(dry run: file not written)" : `\nsaved ${resolve(file)}`),
        ),
      ];
      if (a.preview && typeof a.preview === "object") {
        const p = a.preview as Record<string, unknown>;
        const img = renderPose(res.model, baseDir, {
          animation: typeof p.animation === "string" ? p.animation : null,
          time: optNum(p.time) ?? 0,
          size: optNum(p.size) ?? 384,
          overlay: p.overlay === undefined ? { bones: true, names: true } : overlayOf(p.overlay),
        });
        content.push(image(encodePNG(img)));
      }
      return { content };
    },
  },
  {
    name: "rig_render",
    description:
      "Renders one frame of the model (setup pose, or an animation at a time) to a PNG and returns it as an image. " +
      "Use overlays to see bones, their names, and mesh wireframes. Optionally also saves the PNG to `out`.",
    inputSchema: {
      type: "object",
      properties: {
        file: fileProp,
        animation: { type: "string" },
        time: { type: "number", description: "Seconds into the animation." },
        size: { type: "number", description: "Longest image side in pixels (default 512)." },
        overlay: overlayProp,
        background: { type: "string", description: '"#rrggbb" or "transparent" (default white).' },
        out: { type: "string", description: "Also write the PNG to this path." },
        physics: { type: "boolean", description: "Simulate physics (spring bones, Live2D physics3; default true); false shows the pose without it." },
        params: paramsProp,
      },
      required: ["file"],
    },
    run: (a) => {
      const { model, baseDir } = loadModel(str(a.file, "file"));
      const anim = typeof a.animation === "string" ? a.animation : null;
      const img = renderPose(model, baseDir, {
        animation: anim,
        time: optNum(a.time) ?? 0,
        size: optNum(a.size),
        overlay: overlayOf(a.overlay),
        physics: a.physics !== false,
        params: paramsOf(a.params),
        background: typeof a.background === "string" ? a.background : undefined,
        label: anim ? `${anim} t=${optNum(a.time) ?? 0}` : undefined,
      });
      return withSave(encodePNG(img), a.out, `${img.width}x${img.height}`);
    },
  },
  {
    name: "rig_sheet",
    description:
      "Renders a contact sheet: N frames of an animation in a grid with one shared camera, each labeled with its time. " +
      "Best way to judge motion in a single image.",
    inputSchema: {
      type: "object",
      properties: {
        file: fileProp,
        animation: { type: "string" },
        frames: { type: "number", description: "Frames sampled evenly across the animation (default 8)." },
        times: { type: "array", items: { type: "number" }, description: "Explicit sample times; overrides frames." },
        cols: { type: "number" },
        cellSize: { type: "number", description: "Longest side of each cell (default 256)." },
        overlay: overlayProp,
        out: { type: "string", description: "Also write the PNG to this path." },
        physics: { type: "boolean", description: "Simulate physics (spring bones, Live2D physics3; default true); false shows the pose without it." },
        params: paramsProp,
      },
      required: ["file", "animation"],
    },
    run: (a) => {
      const { model, baseDir } = loadModel(str(a.file, "file"));
      const img = renderSheet(model, baseDir, {
        animation: str(a.animation, "animation"),
        frames: optNum(a.frames),
        times: Array.isArray(a.times) ? a.times.filter((t): t is number => typeof t === "number") : undefined,
        cols: optNum(a.cols),
        cellSize: optNum(a.cellSize),
        overlay: overlayOf(a.overlay),
        physics: a.physics !== false,
        params: paramsOf(a.params),
      });
      return withSave(encodePNG(img), a.out, `${img.width}x${img.height}`);
    },
  },
  {
    name: "rig_import",
    description:
      "Imports layered art into a new model: a PSD/PSB, a single PNG, or a folder of PNGs (back-to-front by filename, or ordered by layers.json). " +
      "Each visible layer becomes a slot with a textured mesh (PNG written to images/ next to the model); groups and original names are kept in meta.import. " +
      "All layers start on the root bone; set propose to also build a skeleton from layer names (English/Korean) and shapes. " +
      "Returns the import log and a preview image with bones and names.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Path to .psd/.psb/.png or a folder of PNGs." },
        file: fileProp,
        origin: {
          description:
            'World origin in source pixels: "content" (default, bottom-center of the art), "canvas-bottom", "center", "top-left", or [x, y].',
          anyOf: [
            { type: "string", enum: ["content", "canvas-bottom", "center", "top-left"] },
            { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          ],
        },
        scale: { type: "number", description: "World units per pixel (default 1)." },
        mesh: {
          type: "string",
          enum: ["auto", "grid"],
          description:
            'Default "auto": each layer gets a mesh traced around its art, with the vertex budget and spacing chosen from its size, shape and name ' +
            "(role rigid = outline only for small art, pupils, buttons; standard; flexible = dense along its length for hair, cloth, tails, limbs). " +
            "The result lists each layer's role, vertex count, coverage and why; override with meshRoles / meshDensity, or rig_apply setMeshGeometry. 'grid': a grid over the solid cells.",
        },
        meshDensity: { type: "number", description: "Scales every automatic vertex budget (e.g. 1.5 denser, 0.7 lighter). Default 1." },
        meshRoles: {
          type: "object",
          additionalProperties: { type: "string", enum: ["rigid", "standard", "flexible"] },
          description: 'Role per layer (slot id, layer name or "group/name" path), e.g. { "hair_front": "flexible", "badge": "rigid" }.',
        },
        spacing: { type: "number", description: "Grid cell size in pixels (implies mesh grid; default ~1/8 of each layer's longest side)." },
        includeHidden: { type: "boolean", description: "Also import hidden layers (their slots start empty)." },
        target: { type: "string", enum: ["spine", "live2d"], description: "Spine2D model (layers on the root bone, then bones) or Live2D model (layers become art meshes on the canvas, then deformers and keyforms)." },
        propose: { type: "boolean", description: "Apply the proposed skeleton right away (see rig_propose_bones)." },
        ik: { type: "boolean", description: "With propose: also add two-bone IK to arms and legs (targets at wrists/ankles)." },
        force: { type: "boolean", description: "Overwrite an existing model file." },
      },
      required: ["source", "file", "target"],
    },
    run: (a) => {
      const file = resolve(str(a.file, "file"));
      if (a.target !== "spine" && a.target !== "live2d") throw new Error('target must be "spine" or "live2d"');
      if (a.physics === true) throw new Error("physics (spring bones) is not exported to Spine or Live2D, so imports do not take it");
      if (a.target === "live2d" && (a.propose === true || a.ik === true)) throw new Error("propose / ik build bones: Spine models only");
      if (existsSync(file) && a.force !== true) throw new Error(`${file} already exists (pass force: true to overwrite)`);
      const res = importLayers(readLayerSource(str(a.source, "source")), file, {
        origin: a.origin as OriginSpec | undefined,
        scale: optNum(a.scale),
        spacing: optNum(a.spacing),
        mesh: a.mesh === "grid" ? "grid" : a.mesh === "auto" ? "auto" : undefined,
        meshDensity: optNum(a.meshDensity),
        meshRoles: a.meshRoles && typeof a.meshRoles === "object" ? (a.meshRoles as Record<string, MeshRole>) : undefined,
        target: a.target,
        includeHidden: a.includeHidden === true,
      });
      let model = applyOps(res.model, [{ op: "setTarget", target: a.target }]).model;
      const lines = [...res.log.map((l) => "- " + l), ...res.warnings.map((w) => "WARN " + w)];
      if (a.propose === true) {
        const p = proposeBones(model, { ik: a.ik === true });
        model = applyOps(model, p.ops).model;
        lines.push("proposed skeleton:", ...p.report.map((l) => "- " + l));
      }
      saveModel(file, model);
      lines.push(formatIssues(validateModel(model, { baseDir: dirname(file) })), `saved ${file}`);
      const img = renderPose(model, dirname(file), { size: 512, overlay: { bones: true, names: true } });
      return { content: [text(lines.join("\n")), image(encodePNG(img))] };
    },
  },
  {
    name: "rig_spine_import",
    description:
      "Imports a Spine skeleton export (JSON, Spine 3.8/4.x) with its atlas (name.atlas / name.atlas.txt + page PNGs next to it, or an images folder) " +
      "into a new Awaken2D model: bones (incl. shear), slots, region and (weighted) mesh attachments, IK, events, and animations (bone, slot color/attachment, " +
      "deform, draw order, IK, event timelines). Poses match Spine; what Awaken2D does not evaluate (other skins, transform/path/physics constraints, clipping, " +
      "bounding boxes, dark tint) is kept in meta.spine and written back by rig_spine_export. Region images are written to images/ next to the model.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Path to the Spine skeleton .json." },
        file: fileProp,
        atlas: { type: "string", description: "Atlas file (default: found next to the JSON)." },
        images: { type: "string", description: "Folder of region PNGs when there is no atlas." },
        mesh: { type: "string", enum: ["auto"], description: 'Opt-in "auto": region attachments become automatic meshes traced around their art (exported as meshes). Default: regions stay quads, as in Spine.' },
        meshDensity: { type: "number", description: "With mesh auto: scales every vertex budget (1.5 = denser)." },
        force: { type: "boolean", description: "Overwrite an existing model file." },
      },
      required: ["source", "file"],
    },
    run: (a) => {
      const file = resolve(str(a.file, "file"));
      if (existsSync(file) && a.force !== true) throw new Error(`${file} already exists (pass force: true to overwrite)`);
      mkdirSync(dirname(file), { recursive: true });
      const res = importSpine(str(a.source, "source"), file, {
        atlas: typeof a.atlas === "string" ? a.atlas : undefined,
        images: typeof a.images === "string" ? a.images : undefined,
        mesh: a.mesh === "auto" ? "auto" : undefined,
        meshDensity: optNum(a.meshDensity),
      });
      const lines = [...res.log.map((l) => "- " + l), ...res.warnings.map((w) => "WARN " + w), formatIssues(validateModel(res.model, { baseDir: dirname(file) })), `saved ${file}`];
      const img = renderPose(res.model, dirname(file), { size: 512, overlay: { bones: true } });
      return { content: [text(lines.join("\n")), image(encodePNG(img))] };
    },
  },
  {
    name: "rig_spine_export",
    description:
      "Exports a model for Spine: <name>.json (Spine 4.x skeleton data), <name>.atlas + <name>.png (packed atlas for runtimes) and images/<region>.png " +
      "(for the Spine editor's Import Data) into a folder. Data imported from Spine and not edited is written back verbatim; edited meshes, keys and " +
      "deforms are converted. Parameters/warps/combos (Live2D side) and spring bones have no Spine equivalent and are reported as not exported.",
    inputSchema: {
      type: "object",
      properties: {
        file: fileProp,
        out: { type: "string", description: "Output folder." },
        name: { type: "string", description: "Base name of the files (default: the model file name)." },
        images: { type: "boolean", description: "Also write the images folder (default true)." },
        version: { type: "string", description: "Target Spine editor version for newly authored models, e.g. 4.3.26 (default 4.2.43)." },
      },
      required: ["file", "out"],
    },
    run: (a) => {
      const res = exportSpine(str(a.file, "file"), resolve(str(a.out, "out")), { name: typeof a.name === "string" ? a.name : undefined, images: a.images !== false, version: typeof a.version === "string" ? a.version : undefined });
      return { content: [text([`wrote ${res.files.join(", ")} to ${resolve(String(a.out))}`, ...res.warnings.map((w) => "WARN " + w)].join("\n"))] };
    },
  },
  {
    name: "rig_live2d_import",
    description:
      "Imports a Live2D Cubism runtime model (name.model3.json, or a bare .moc3) into a new Awaken2D model: parameters, parts, warp and rotation " +
      "deformers, art meshes with their keyforms, glue, masks, draw-order groups, motions (parameter and part-opacity curves), physics (physics3) and " +
      "display names (cdi3). The rig keeps Cubism's own structure and poses exactly like the Cubism Core; textures are copied to images/ next to the model. " +
      "Expressions, pose groups and model curves are kept for rig_live2d_export.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Path to the .model3.json (preferred) or .moc3." },
        file: fileProp,
        force: { type: "boolean", description: "Overwrite an existing model file." },
      },
      required: ["source", "file"],
    },
    run: (a) => {
      const file = resolve(str(a.file, "file"));
      if (existsSync(file) && a.force !== true) throw new Error(`${file} already exists (pass force: true to overwrite)`);
      mkdirSync(dirname(file), { recursive: true });
      const res = importLive2D(str(a.source, "source"), file);
      const lines = [...res.log.map((l) => "- " + l), ...res.warnings.map((w) => "WARN " + w), formatIssues(validateModel(res.model, { baseDir: dirname(file) })), `saved ${file}`];
      const img = renderPose(res.model, dirname(file), { size: 512 });
      return { content: [text(lines.join("\n")), image(encodePNG(img))] };
    },
  },
  {
    name: "rig_live2d_export",
    description:
      "Exports a model as a Live2D Cubism runtime model into a folder: <name>.model3.json, <name>.moc3, <name>.physics3.json, <name>.cdi3.json, " +
      "<name>.pose3.json, motion/*.motion3.json and <name>.textures/*.png (loadable by Cubism SDKs and viewers; the Cubism Editor itself opens only .cmo3). " +
      "The Live2D rig is written as it is; meshes without Live2D keyforms become static art meshes; bones, spring bones and bone/slot timelines are reported as not exported.",
    inputSchema: {
      type: "object",
      properties: {
        file: fileProp,
        out: { type: "string", description: "Output folder." },
        name: { type: "string", description: "Base name of the files (default: the model file name)." },
      },
      required: ["file", "out"],
    },
    run: (a) => {
      const res = exportLive2DFile(str(a.file, "file"), resolve(str(a.out, "out")), { name: typeof a.name === "string" ? a.name : undefined });
      return { content: [text([`wrote ${res.files.length} files to ${resolve(String(a.out))}: ${res.name}.model3.json ...`, ...res.warnings.map((w) => "WARN " + w)].join("\n"))] };
    },
  },
  {
    name: "rig_propose_bones",
    description:
      "Suggests a skeleton for a model imported from layers: classifies each layer (head, torso, hip, upper/lower arm, hand, thigh, shin, foot, " +
      "single-layer arm/leg split into two bones, face parts, hair, tail, other) from its name and shape, places bones along principal axes, " +
      "and binds each slot with weights. Returns the report and the ops; review/edit them and pass to rig_apply, or set apply to apply as-is.",
    inputSchema: {
      type: "object",
      properties: {
        file: fileProp,
        apply: { type: "boolean", description: "Apply the proposed ops and return a preview." },
        ik: { type: "boolean", description: "Also add two-bone IK to arm and leg chains (targets at wrists/ankles, joints bend outward)." },
        physics: { type: "boolean", description: "Turn tails and other dangling elongated layers into 3-bone spring chains. Only for models without a target: Spine and Live2D exports drop spring bones." },
      },
      required: ["file"],
    },
    run: (a) => {
      const file = str(a.file, "file");
      const { model, baseDir } = loadModel(file);
      if (model.target === "live2d") throw new Error("this is a Live2D model: it has no bones (use deformers)");
      if (a.physics === true && model.target) throw new Error("physics (spring bones) is not exported to Spine: only models without a target use it");
      const p = proposeBones(model, { ik: a.ik === true, physics: a.physics === true });
      const report = p.report.map((l) => "- " + l).join("\n");
      if (a.apply !== true) return { content: [text(report + "\n\nops:\n" + JSON.stringify(p.ops))] };
      const res = applyOps(model, p.ops);
      saveModel(resolve(file), res.model);
      const img = renderPose(res.model, baseDir, { size: 512, overlay: { bones: true, names: true } });
      const summary = `${report}\n${formatIssues(validateModel(res.model, { baseDir }))}\napplied ${p.ops.length} ops`;
      return { content: [text(summary), image(encodePNG(img))] };
    },
  },
  {
    name: "rig_param_sheet",
    description:
      "Shows what a parameter does: renders the model at evenly spaced values from the parameter's min to max, labeled " +
      "(a grid when param2 is given, e.g. AngleX across and AngleY down). Use after setParamShape/setParamWarp/setParamBoneKeys " +
      "to check the result; add overlay warps to see the lattice.",
    inputSchema: {
      type: "object",
      properties: {
        file: fileProp,
        param: { type: "string", description: "Parameter swept across the columns." },
        param2: { type: "string", description: "Optional parameter swept down the rows." },
        steps: { type: "number", description: "Values per parameter, 2..9 (default 5)." },
        animation: { type: "string", description: "Pose the rest of the model with this animation (default setup pose)." },
        time: { type: "number" },
        cellSize: { type: "number", description: "Longest side of each cell (default 220)." },
        overlay: overlayProp,
        params: paramsProp,
        out: { type: "string", description: "Also write the PNG to this path." },
      },
      required: ["file", "param"],
    },
    run: (a) => {
      const { model, baseDir } = loadModel(str(a.file, "file"));
      const img = renderParamSheet(model, baseDir, {
        param: str(a.param, "param"),
        param2: typeof a.param2 === "string" ? a.param2 : undefined,
        steps: optNum(a.steps),
        animation: typeof a.animation === "string" ? a.animation : null,
        time: optNum(a.time),
        cellSize: optNum(a.cellSize),
        overlay: overlayOf(a.overlay),
        params: paramsOf(a.params),
      });
      return withSave(encodePNG(img), a.out, `${img.width}x${img.height}`);
    },
  },
];

function withSave(png: Buffer, out: unknown, dims: string): ToolResult {
  const content: Content[] = [image(png)];
  if (typeof out === "string" && out) {
    const p = resolve(out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, png);
    content.unshift(text(`${dims} PNG written to ${p}`));
  }
  return { content };
}

// ---------- JSON-RPC plumbing

interface Req {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req: Req): unknown {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: (req.params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "awaken2d", version: VERSION },
        instructions:
          "Awaken2D edits 2D animation models stored as JSON files. Every model is either a Spine2D model (target \"spine\": bones, weights, IK, spring bones, timelines) or a Live2D model (target \"live2d\": parameters, keyforms, deformers, parts); ops for the other kind are refused (rig_describe shows the target). Workflow: rig_spec (once) -> rig_import (layered art, propose: true), rig_spine_import (Spine data), rig_live2d_import (Live2D model3/moc3) or rig_new -> rig_apply ops " +
          "(bones, meshes, weights, animations) -> rig_validate -> rig_render / rig_sheet to look at the result, and iterate. rig_spine_export / rig_live2d_export write Spine / Live2D data back.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call": {
      const name = req.params?.name as string;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
      try {
        return tool.run((req.params?.arguments as Record<string, unknown>) ?? {});
      } catch (e) {
        return { content: [text(`error: ${(e as Error).message}`)], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: Req;
  try {
    req = JSON.parse(line) as Req;
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  if (req.id === undefined || req.id === null) return; // notification
  try {
    send({ jsonrpc: "2.0", id: req.id, result: handle(req) });
  } catch (e) {
    const err = e as Error & { code?: number };
    send({ jsonrpc: "2.0", id: req.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
