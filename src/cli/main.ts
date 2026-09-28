#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_MESH_PRESETS, applyOps, describeModel, describePlan, emptyModel, formatIssues, loadModel, meshAutoGenerate, meshAutoPlan, meshFromTrace, remeshFromAlpha, saveModel, summarizeModel, validateModel } from "../core/index.ts";
import type { MeshRole, ModelTarget, Op } from "../core/index.ts";
import { decodePNG, encodePNG, parseOverlay, renderParamSheet, renderPose, renderSheet } from "../render/index.ts";
import { importLayers, proposeBones, readLayerSource } from "../import/index.ts";
import type { OriginSpec } from "../import/index.ts";
import { startServer } from "../web/server.ts";
import { exportSpine, importSpine } from "../spine/index.ts";
import { exportLive2DFile, importLive2D } from "../live2d/index.ts";

const HELP = `rig - AI-friendly 2D skeletal animation toolkit

Usage: npm run rig -- <command> [args]

Commands:
  new <model.json> --target spine|live2d [--name N]            create an empty model with a root bone
  describe <model.json> [--json]         bone tree, slots, meshes, animations in text
  validate <model.json> [--json]         structural + pose checks (exit 1 on errors)
  apply <model.json> <ops.json|->        apply an array of edit ops atomically, then validate
  render <model.json> [-o out.png]       render one frame
        [--anim NAME] [--time SEC] [--size PX] [--overlay bones,names,mesh,axes|all]
        [--bg #rrggbb|transparent] [--ss N] [--no-physics]
  sheet <model.json> --anim NAME [-o out.png]
        [--frames N] [--cols N] [--cell PX] [--overlay ...]   contact sheet of an animation
  import <art.psd|art.png|folder> <model.json> [--target spine|live2d]   layers -> slots + textured meshes (PNGs in images/)
        [--origin content|canvas-bottom|center|top-left|X,Y] [--scale S] [--include-hidden] [--propose] [--ik] [--force]
        meshes are automatic by default: traced around each layer's art, vertex count and spacing chosen from its
        size, shape and name (hair/skirt/arm -> dense, pupils/buttons/small art -> outline only)
        [--mesh-density K] (more / fewer vertices) [--mesh-role NAME=rigid|standard|flexible,...]
        [--mesh grid] [--spacing PX]: the old grid mesh over solid cells instead
        (--target none: legacy model without a target, e.g. the demo; takes --physics spring chains, exports drop them)
  propose <model.json> [--apply] [--json] [--ik] [--physics]   suggest bones + bindings (+ limb IK) for an imported model
        (--physics: spring-bone chains, only for models without a target: neither Spine nor Live2D export them)
  spine-import <skeleton.json> <model.json> [--atlas FILE] [--images DIR] [--force]
        Spine 3.8/4.x export (+ atlas next to it) -> Awaken2D model; poses match Spine
        [--mesh auto [--mesh-density K]]: region attachments become automatic meshes traced around their art
        (exported as meshes; without it regions stay quads, exactly as in Spine)
  spine-export <model.json> <outDir> [--name N] [--no-images]
        -> <name>.json (Spine 4.x) + <name>.atlas + <name>.png + images/ (for Spine's Import Data)
  live2d-import <name.model3.json|name.moc3> <model.json> [--force]
        Live2D Cubism runtime model (moc3 + textures, motions, physics, pose, display info) -> Awaken2D model;
        poses match the Cubism Core
  live2d-export <model.json> <outDir> [--name N]
        -> <name>.model3.json + .moc3 + .physics3.json + .cdi3.json + motion/*.motion3.json + textures
  remesh <model.json> <attachment...|--all> [--spacing PX] [--threshold A]   rebuild image meshes from the
        image alpha (grid of PX image pixels); weights and shapes carry over
        --trace [--detail N] [--concavity 0-100] [--padding PX] [--interior PX]: an outline traced around the art
        with N vertices (Spine's Trace), inner vertices every PX image pixels
        --auto [standard|deformation-small|deformation-large]: Cubism's Automatic Mesh Generator (outline, inner ring,
        inner points)
        --plan [--mesh-density K] [--mesh-role rigid|standard|flexible]: the automatic mesh import makes (settings chosen
        from the art and the attachment's name)
  param-sheet <model.json> --param ID [--param2 ID] [--steps 5] [-o out.png]
        [--anim NAME --time SEC] [--overlay ...]   what a parameter does, min..max (grid for two)
  (render/sheet take --param ID=VALUE,ID=VALUE to pin parameter values; param-sheet uses --set for that)
  serve [--root DIR] [--port 5178] [--autosave]   web editor for the *.rig.json files under DIR (default .)
  spec                                   print the model format + ops reference
`;

interface Args {
  pos: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") flags.out = argv[++i];
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: string | true | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

function need(pos: string[], i: number, what: string): string {
  if (!pos[i]) throw new Error(`missing ${what}\n\n${HELP}`);
  return pos[i];
}

function writeOut(path: string, data: Buffer): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, data);
  console.log(`wrote ${resolve(path)}`);
}

export function specText(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "../../docs/FORMAT.md"), "utf8");
}

/** "AngleX=30,EyeOpen=0" -> { AngleX: 30, EyeOpen: 0 } */
function parseParams(v: string | undefined): Record<string, number> | undefined {
  if (!v) return undefined;
  const out: Record<string, number> = {};
  for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, raw] = part.split("=");
    const n = Number(raw);
    if (!k || raw === undefined || !Number.isFinite(n)) throw new Error(`--param expects ID=VALUE[,ID=VALUE] (got "${part}")`);
    out[k] = n;
  }
  return out;
}

function parseOrigin(v: string | undefined): OriginSpec | undefined {
  if (!v) return undefined;
  const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(v);
  if (m) return [Number(m[1]), Number(m[2])];
  if (["content", "canvas-bottom", "center", "top-left"].includes(v)) return v as OriginSpec;
  throw new Error(`--origin must be content, canvas-bottom, center, top-left or X,Y`);
}

const MESH_ROLES: MeshRole[] = ["rigid", "standard", "flexible"];

function meshFlag(v: unknown): "auto" | "grid" | undefined {
  if (v === undefined) return undefined;
  if (v !== "auto" && v !== "grid") throw new Error("--mesh must be auto or grid");
  return v;
}

/** "hair=flexible,button=rigid" -> { hair: "flexible", button: "rigid" } (keys: slot id, layer name or group/name path). */
function parseRoles(v: string | undefined): Record<string, MeshRole> | undefined {
  if (!v) return undefined;
  const out: Record<string, MeshRole> = {};
  for (const part of v.split(",")) {
    const i = part.lastIndexOf("=");
    const role = part.slice(i + 1).trim() as MeshRole;
    if (i <= 0 || !MESH_ROLES.includes(role)) throw new Error(`--mesh-role takes NAME=${MESH_ROLES.join("|")} pairs, got "${part}"`);
    out[part.slice(0, i).trim()] = role;
  }
  return out;
}

function targetFlag(v: unknown, required: boolean): ModelTarget | undefined {
  if (v === undefined && !required) return undefined;
  if (v !== "spine" && v !== "live2d") throw new Error("--target must be spine or live2d (what the model is made for: Spine2D or Live2D)");
  return v;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  switch (cmd) {
    case "new": {
      const file = need(pos, 0, "model path");
      const target = targetFlag(flags.target, true)!;
      if (existsSync(file) && !flags.force) throw new Error(`${file} exists (use --force to overwrite)`);
      mkdirSync(dirname(resolve(file)), { recursive: true });
      saveModel(file, emptyModel(str(flags.name) ?? "untitled", target));
      console.log(`created ${resolve(file)} (${target === "live2d" ? "Live2D" : "Spine"} model)`);
      return 0;
    }
    case "describe": {
      const { model } = loadModel(need(pos, 0, "model path"));
      console.log(flags.json ? JSON.stringify(summarizeModel(model), null, 2) : describeModel(model));
      return 0;
    }
    case "validate": {
      const { model, baseDir } = loadModel(need(pos, 0, "model path"));
      const issues = validateModel(model, { baseDir });
      console.log(flags.json ? JSON.stringify(issues, null, 2) : formatIssues(issues));
      return issues.some((i) => i.level === "error") ? 1 : 0;
    }
    case "apply": {
      const file = need(pos, 0, "model path");
      const src = need(pos, 1, "ops file (or - for stdin)");
      const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
      const parsed = JSON.parse(text) as Op[] | { ops: Op[] };
      const ops = Array.isArray(parsed) ? parsed : parsed.ops;
      const { model, baseDir } = loadModel(file);
      const res = applyOps(model, ops);
      const issues = validateModel(res.model, { baseDir });
      if (!flags["dry-run"]) saveModel(file, res.model);
      console.log(res.log.map((l) => "- " + l).join("\n"));
      console.log(formatIssues(issues));
      if (flags["dry-run"]) console.log("(dry run: file not written)");
      return 0;
    }
    case "render": {
      const file = need(pos, 0, "model path");
      const { model, baseDir } = loadModel(file);
      const img = renderPose(model, baseDir, {
        animation: str(flags.anim) ?? null,
        time: num(flags.time, "time") ?? 0,
        size: num(flags.size, "size"),
        background: str(flags.bg),
        overlay: parseOverlay(str(flags.overlay)),
        supersample: num(flags.ss, "ss"),
        physics: flags["no-physics"] !== true,
        params: parseParams(str(flags.param)),
        label: flags.anim ? `${flags.anim} t=${num(flags.time, "time") ?? 0}` : undefined,
      });
      writeOut(str(flags.out) ?? "out/render.png", encodePNG(img));
      return 0;
    }
    case "sheet": {
      const file = need(pos, 0, "model path");
      const anim = str(flags.anim);
      if (!anim) throw new Error("--anim is required");
      const { model, baseDir } = loadModel(file);
      const img = renderSheet(model, baseDir, {
        animation: anim,
        frames: num(flags.frames, "frames"),
        cols: num(flags.cols, "cols"),
        cellSize: num(flags.cell, "cell"),
        background: str(flags.bg),
        overlay: parseOverlay(str(flags.overlay)),
        physics: flags["no-physics"] !== true,
        params: parseParams(str(flags.param)),
      });
      writeOut(str(flags.out) ?? `out/${anim}-sheet.png`, encodePNG(img));
      return 0;
    }
    case "import": {
      const source = need(pos, 0, "source (.psd/.png/folder)");
      const file = need(pos, 1, "model path");
      if (existsSync(file) && !flags.force) throw new Error(`${file} exists (use --force to overwrite)`);
      // --target none: a legacy model without a target (every Awaken2D feature, e.g. the demo's spring tail and face
      // parameters; neither export keeps those)
      const target = flags.target === "none" ? null : (targetFlag(flags.target, false) ?? "spine");
      const res = importLayers(readLayerSource(source), file, {
        origin: parseOrigin(str(flags.origin)),
        scale: num(flags.scale, "scale"),
        spacing: num(flags.spacing, "spacing"),
        mesh: meshFlag(flags.mesh),
        meshDensity: num(flags["mesh-density"], "mesh-density"),
        meshRoles: parseRoles(str(flags["mesh-role"])),
        target,
        includeHidden: flags["include-hidden"] === true,
        name: str(flags.name),
      });
      if (flags.physics && target) throw new Error("--physics (spring bones) is not exported to Spine or Live2D: only --target none takes it");
      if (target === "live2d" && (flags.propose || flags.ik)) throw new Error("--propose / --ik build bones: Spine models only");
      let model = target ? applyOps(res.model, [{ op: "setTarget", target }]).model : res.model;
      console.log(res.log.map((l) => "- " + l).join("\n"));
      for (const w of res.warnings) console.log(`WARN ${w}`);
      if (flags.propose) {
        const p = proposeBones(model, { ik: flags.ik === true, physics: flags.physics === true });
        model = applyOps(model, p.ops).model;
        console.log(p.report.map((l) => "- " + l).join("\n"));
      }
      saveModel(file, model);
      console.log(formatIssues(validateModel(model, { baseDir: dirname(resolve(file)) })));
      console.log(`wrote ${resolve(file)}`);
      return 0;
    }
    case "propose": {
      const file = need(pos, 0, "model path");
      const { model, baseDir } = loadModel(file);
      if (flags.physics && model.target) throw new Error(`--physics (spring bones) is not exported to ${model.target === "spine" ? "Spine" : "Live2D"}: only models without a target use it`);
      const p = proposeBones(model, { ik: flags.ik === true, physics: flags.physics === true });
      if (flags.json) console.log(JSON.stringify({ ops: p.ops, report: p.report }, null, 2));
      else console.log(p.report.map((l) => "- " + l).join("\n"));
      if (flags.apply) {
        const res = applyOps(model, p.ops);
        saveModel(file, res.model);
        console.log(formatIssues(validateModel(res.model, { baseDir })));
        console.log(`applied ${p.ops.length} ops to ${resolve(file)}`);
      } else if (!flags.json) console.log(`(${p.ops.length} ops; --json to print them, --apply to apply)`);
      return 0;
    }
    case "spine-import": {
      const src = need(pos, 0, "Spine skeleton .json");
      const file = need(pos, 1, "model path");
      if (existsSync(file) && !flags.force) throw new Error(`${file} exists (use --force to overwrite)`);
      mkdirSync(dirname(resolve(file)), { recursive: true });
      const res = importSpine(src, file, {
        atlas: str(flags.atlas),
        images: str(flags.images),
        mesh: flags.mesh === undefined ? undefined : flags.mesh === "auto" ? "auto" : (() => { throw new Error("spine-import --mesh takes auto (regions become traced meshes)"); })(),
        meshDensity: num(flags["mesh-density"], "mesh-density"),
      });
      console.log(res.log.map((l) => "- " + l).join("\n"));
      for (const w of res.warnings) console.log(`WARN ${w}`);
      console.log(formatIssues(validateModel(res.model, { baseDir: dirname(resolve(file)) })));
      console.log(`wrote ${resolve(file)}`);
      return 0;
    }
    case "spine-export": {
      const file = need(pos, 0, "model path");
      const out = need(pos, 1, "output folder");
      const res = exportSpine(file, out, { name: str(flags.name), images: flags["no-images"] !== true });
      for (const w of res.warnings) console.log(`WARN ${w}`);
      console.log(`wrote ${res.files.join(", ")} to ${resolve(out)}`);
      return 0;
    }
    case "live2d-import": {
      const src = need(pos, 0, "Live2D .model3.json or .moc3");
      const file = need(pos, 1, "model path");
      if (existsSync(file) && !flags.force) throw new Error(`${file} exists (use --force to overwrite)`);
      mkdirSync(dirname(resolve(file)), { recursive: true });
      const res = importLive2D(src, file);
      console.log(res.log.map((l) => "- " + l).join("\n"));
      for (const w of res.warnings) console.log(`WARN ${w}`);
      console.log(formatIssues(validateModel(res.model, { baseDir: dirname(resolve(file)) })));
      console.log(`wrote ${resolve(file)}`);
      return 0;
    }
    case "live2d-export": {
      const file = need(pos, 0, "model path");
      const out = need(pos, 1, "output folder");
      const res = exportLive2DFile(file, out, { name: str(flags.name) });
      for (const w of res.warnings) console.log(`WARN ${w}`);
      console.log(`wrote ${res.files.length} files to ${resolve(out)} (open ${res.name}.model3.json in a Cubism viewer / SDK)`);
      return 0;
    }
    case "remesh": {
      const file = need(pos, 0, "model path");
      const { model, baseDir } = loadModel(file);
      const ids = flags.all ? Object.keys(model.attachments).filter((id) => model.attachments[id].image) : pos.slice(1);
      if (!ids.length) throw new Error("name the attachments to remesh, or --all");
      const ops: Op[] = ids.map((id) => {
        const att = model.attachments[id];
        if (!att) throw new Error(`unknown attachment "${id}"`);
        if (!att.image || !model.images?.[att.image]) throw new Error(`${id} has no image to remesh from`);
        const img = decodePNG(readFileSync(resolve(baseDir, model.images[att.image].path)));
        if (flags.plan) {
          const role = str(flags["mesh-role"]);
          if (role !== undefined && !MESH_ROLES.includes(role as MeshRole)) throw new Error(`--mesh-role must be one of ${MESH_ROLES.join(", ")}`);
          const slot = model.slots.find((s) => s.attachment === id)?.id;
          const { geometry, plan } = meshAutoPlan(att, img.data, img.width, img.height, {
            name: id.split("/").pop(),
            groups: slot && slot !== id ? [slot] : [],
            target: model.target ?? null,
            role: role as MeshRole | undefined,
            density: num(flags["mesh-density"], "mesh-density"),
          });
          console.log(`- ${id}: ${describePlan(plan)}`);
          return { op: "setMeshGeometry", attachment: id, ...geometry };
        }
        if (flags.auto) {
          // Cubism-style Automatic Mesh Generator (preset: standard, deformation-small, deformation-large)
          const name = typeof flags.auto === "string" ? flags.auto : "standard";
          const preset = AUTO_MESH_PRESETS[name];
          if (!preset) throw new Error(`--auto preset must be one of ${Object.keys(AUTO_MESH_PRESETS).join(", ")}`);
          return { op: "setMeshGeometry", attachment: id, ...meshAutoGenerate(att, img.data, img.width, img.height, preset) };
        }
        if (flags.trace) {
          // Spine-style: an outline traced around the art (+ inner vertices at --interior spacing)
          return {
            op: "setMeshGeometry",
            attachment: id,
            ...meshFromTrace(att, img.data, img.width, img.height, {
              detail: num(flags.detail, "detail"),
              concavity: num(flags.concavity, "concavity"),
              alphaThreshold: num(flags.threshold, "threshold"),
              padding: num(flags.padding, "padding"),
              interior: num(flags.interior, "interior"),
            }),
          };
        }
        const spacing = num(flags.spacing, "spacing") ?? Math.max(8, Math.round(Math.max(img.width, img.height) / 8));
        return { op: "setMeshGeometry", attachment: id, ...remeshFromAlpha(att, img.data, img.width, img.height, spacing, num(flags.threshold, "threshold") ?? 4) };
      });
      const res = applyOps(model, ops);
      console.log(res.log.map((l) => "- " + l).join("\n"));
      if (!flags["dry-run"]) saveModel(file, res.model);
      console.log(formatIssues(validateModel(res.model, { baseDir })));
      if (flags["dry-run"]) console.log("(dry run: file not written)");
      return 0;
    }
    case "param-sheet": {
      const file = need(pos, 0, "model path");
      const param = str(flags.param);
      if (!param || param.includes("=")) throw new Error("--param ID is required (the parameter to sweep)");
      const { model, baseDir } = loadModel(file);
      const img = renderParamSheet(model, baseDir, {
        param,
        param2: str(flags.param2),
        steps: num(flags.steps, "steps"),
        animation: str(flags.anim) ?? null,
        time: num(flags.time, "time"),
        cellSize: num(flags.cell, "cell"),
        overlay: parseOverlay(str(flags.overlay)),
        params: parseParams(str(flags.set)),
        physics: flags["no-physics"] !== true,
      });
      writeOut(str(flags.out) ?? `out/${param}-sheet.png`, encodePNG(img));
      return 0;
    }
    case "serve": {
      const root = str(flags.root) ?? ".";
      startServer({ root, port: num(flags.port, "port") ?? 5178, autosave: flags.autosave === true }).then(
        (s) => console.log(`Awaken2D editor: ${s.url}  (models under ${resolve(root)}; Ctrl+C to stop)`),
        (e: Error) => {
          console.error(`error: ${e.message}`);
          process.exitCode = 1;
        },
      );
      return 0;
    }
    case "spec":
      console.log(specText());
      return 0;
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return 0;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
