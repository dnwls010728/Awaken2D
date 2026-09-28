import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isChannelEases, isEase, sampleTimes } from "./animation.ts";
import { triArea } from "./geometry.ts";
import { isColor } from "./math.ts";
import { boneOrder, computePose, deformMesh, poseDeform } from "./pose.ts";
import { samplePoses } from "./physics.ts";
import { restVertices } from "./params.ts";
import { targetConflicts } from "./ops.ts";
import { checkPaths } from "./live2dpath.ts";
import { AXIS_CHANNELS, BLEND_MODES, FORMAT_ID, INHERITS, SPINE_PHYSICS_SETTINGS, TRANSFORM_PROPERTIES } from "./types.ts";
import type { Inherit, Key, KeyformGrid, MeshAttachment, Model, TransformProperty } from "./types.ts";

export interface Issue {
  level: "error" | "warning";
  /** JSON-path-like location, e.g. attachments.arm.weights[3]. */
  path: string;
  message: string;
}

export interface ValidateOptions {
  /** Directory used to check image files exist. */
  baseDir?: string;
  /** Samples per animation for pose checks (triangle flips, NaN). 0 disables. */
  poseSamples?: number;
}

export function validateModel(model: Model, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

  if (model.format !== FORMAT_ID) warn("format", `expected "${FORMAT_ID}", got "${model.format}"`);

  // bones
  const boneIds = new Set<string>();
  model.bones.forEach((b, i) => {
    const p = `bones[${i}](${b.id})`;
    if (!b.id) err(p, "bone id is empty");
    if (boneIds.has(b.id)) err(p, `duplicate bone id "${b.id}"`);
    boneIds.add(b.id);
    for (const k of ["x", "y", "rotation", "scaleX", "scaleY", "length"] as const) {
      if (!num(b[k])) err(`${p}.${k}`, `must be a finite number`);
    }
    if (b.scaleX === 0 || b.scaleY === 0) err(p, "zero scale makes the bone non-invertible");
    if (b.length < 0) warn(`${p}.length`, "negative length");
    if (b.color !== undefined && !isColor(b.color)) err(`${p}.color`, `invalid color "${b.color}"`);
    if (b.icon !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(b.icon)) err(`${p}.icon`, `invalid bone icon "${b.icon}"`);
  });
  const roots = model.bones.filter((b) => b.parent === null);
  if (model.bones.length === 0) err("bones", "model has no bones");
  else if (roots.length === 0) err("bones", "no root bone (parent: null)");
  let hierarchyOk = true;
  try {
    boneOrder(model);
  } catch (e) {
    hierarchyOk = false;
    err("bones", (e as Error).message);
  }

  // images
  for (const [id, img] of Object.entries(model.images ?? {})) {
    if (!img || typeof img.path !== "string") err(`images.${id}`, "missing path");
    else if (!img.path.toLowerCase().endsWith(".png")) err(`images.${id}.path`, "only PNG images are supported");
    else if (opts.baseDir && !existsSync(resolve(opts.baseDir, img.path)))
      err(`images.${id}.path`, `file not found: ${img.path}`);
  }

  // attachments
  const usedAttachments = new Set<string>();
  for (const [id, a] of Object.entries(model.attachments)) {
    const p = `attachments.${id}`;
    if (a.type !== "mesh") {
      err(p, `unsupported attachment type "${(a as { type: string }).type}"`);
      continue;
    }
    const nv = a.vertices?.length ?? 0;
    // Live2D art meshes may be helpers (glue anchors, masks) without a drawable shape
    if (nv < 3 && !a.live2d) err(`${p}.vertices`, "mesh needs at least 3 vertices");
    a.vertices?.forEach((v, i) => {
      if (!Array.isArray(v) || v.length !== 2 || !num(v[0]) || !num(v[1])) err(`${p}.vertices[${i}]`, "must be [x, y]");
    });
    if (a.image !== undefined) {
      if (!model.images?.[a.image]) err(`${p}.image`, `unknown image "${a.image}"`);
      if (!a.uvs || a.uvs.length !== nv) err(`${p}.uvs`, `textured mesh needs ${nv} uvs, has ${a.uvs?.length ?? 0}`);
    }
    if (a.color !== undefined && !isColor(a.color)) err(`${p}.color`, `invalid color "${a.color}"`);
    if (!a.triangles?.length) {
      if (a.live2d) warn(`${p}.triangles`, "mesh has no triangles (never drawn)");
      else err(`${p}.triangles`, "mesh has no triangles");
    }
    a.triangles?.forEach((t, i) => {
      if (!Array.isArray(t) || t.length !== 3 || t.some((k) => !Number.isInteger(k) || k < 0 || k >= nv)) {
        err(`${p}.triangles[${i}]`, `indices must be integers in [0, ${nv - 1}]`);
      } else if (!a.live2d && a.vertices && Math.abs(triArea(a.vertices[t[0]], a.vertices[t[1]], a.vertices[t[2]])) < 1e-6) {
        warn(`${p}.triangles[${i}]`, "degenerate (zero area) triangle");
      }
    });
    if (!Array.isArray(a.weights) || a.weights.length !== nv) {
      err(`${p}.weights`, `needs one weight list per vertex (${nv}), has ${a.weights?.length ?? 0}`);
    } else {
      a.weights.forEach((infl, i) => {
        const wp = `${p}.weights[${i}]`;
        if (!Array.isArray(infl) || infl.length === 0) return err(wp, "vertex has no bone influences");
        let sum = 0;
        for (const e of infl) {
          if (!Array.isArray(e) || typeof e[0] !== "string" || !num(e[1])) return err(wp, 'entries must be ["boneId", weight]');
          if (!boneIds.has(e[0])) err(wp, `unknown bone "${e[0]}"`);
          if (e[1] < 0) warn(wp, "negative weight (Spine data can have them; painting tools clamp to 0)");
          sum += e[1];
        }
        if (Math.abs(sum - 1) > 0.01) warn(wp, `weights sum to ${sum.toFixed(3)} (normalized at runtime)`);
      });
    }
  }

  // attachment keys: an attachment id, or a placeholder a skin maps for the slot (or that Spine data kept)
  const spineExtra = (model.meta?.spine as { extraAttachments?: Record<string, Record<string, unknown>>; skinExtraAttachments?: Record<string, Record<string, Record<string, unknown>>> } | undefined) ?? {};
  const isKey = (slot: string, key: string) =>
    !!model.attachments[key] ||
    !!model.pathAttachments?.[key] ||
    !!model.clippings?.[key] ||
    !!model.boundingBoxes?.[key] ||
    Object.values(model.skins ?? {}).some((sk) => sk.attachments[slot]?.[key] !== undefined) ||
    !!spineExtra.extraAttachments?.[slot]?.[key] ||
    Object.values(spineExtra.skinExtraAttachments ?? {}).some((sk) => !!sk[slot]?.[key]);
  const checkAttachmentKey = (path: string, slot: string, key: string) => {
    if (!isKey(slot, key)) err(path, `unknown attachment "${key}" (no attachment with that id, no skin placeholder for slot ${slot})`);
  };
  for (const sk of Object.values(model.skins ?? {})) for (const m of Object.values(sk.attachments)) for (const id of Object.values(m)) usedAttachments.add(id);

  // slots
  const slotIds = new Set<string>();
  model.slots.forEach((s, i) => {
    const p = `slots[${i}](${s.id})`;
    if (slotIds.has(s.id)) err(p, `duplicate slot id "${s.id}"`);
    slotIds.add(s.id);
    if (!boneIds.has(s.bone)) err(`${p}.bone`, `unknown bone "${s.bone}"`);
    if (s.attachment !== null) {
      checkAttachmentKey(`${p}.attachment`, s.id, s.attachment);
      usedAttachments.add(s.attachment);
    }
    if (!isColor(s.color)) err(`${p}.color`, `invalid color "${s.color}"`);
    if (s.dark !== undefined && !/^#[0-9a-fA-F]{6}$/.test(s.dark)) err(`${p}.dark`, `invalid dark color "${s.dark}" (use #rrggbb)`);
    if (s.blend !== undefined && !BLEND_MODES.includes(s.blend)) err(`${p}.blend`, `blend must be one of ${BLEND_MODES.join(", ")}`);
    for (const c of s.clip === undefined ? [] : Array.isArray(s.clip) ? s.clip : [s.clip]) {
      if (c === s.id) err(`${p}.clip`, "a slot cannot clip itself");
      else if (!model.slots.some((x) => x.id === c)) err(`${p}.clip`, `unknown slot "${c}"`);
    }
  });

  // IK constraints
  const ikIds = new Set<string>();
  const parentOf = new Map(model.bones.map((b) => [b.id, b.parent]));
  const isBelow = (id: string, ancestor: string) => {
    for (let cur: string | null | undefined = id; cur; cur = parentOf.get(cur)) if (cur === ancestor) return true;
    return false;
  };
  (model.ik ?? []).forEach((c, i) => {
    const p = `ik[${i}](${c.id})`;
    if (ikIds.has(c.id)) err(p, `duplicate IK id "${c.id}"`);
    ikIds.add(c.id);
    if (!Array.isArray(c.bones) || c.bones.length < 1 || c.bones.length > 2) return err(`${p}.bones`, "needs 1 or 2 bones");
    for (const b of c.bones) if (!boneIds.has(b)) err(`${p}.bones`, `unknown bone "${b}"`);
    if (c.bones.length === 2 && parentOf.get(c.bones[1]) !== c.bones[0])
      err(`${p}.bones`, `"${c.bones[1]}" must be a direct child of "${c.bones[0]}"`);
    if (!boneIds.has(c.target)) err(`${p}.target`, `unknown bone "${c.target}"`);
    else if (hierarchyOk && c.bones.some((b) => isBelow(c.target, b)))
      err(`${p}.target`, `target "${c.target}" is part of or below the chain it drives (would chase itself)`);
    if (!num(c.mix) || c.mix < 0 || c.mix > 1) err(`${p}.mix`, "must be between 0 and 1");
    if (c.bones.length === 2 && boneIds.has(c.bones[1]) && model.bones.find((b) => b.id === c.bones[1])!.length <= 0)
      warn(`${p}.bones`, `"${c.bones[1]}" has length 0, so the chain has no tip to place; the parent is aimed instead`);
  });

  // parameters
  const paramIds = new Set<string>();
  (model.parameters ?? []).forEach((prm, i) => {
    const p = `parameters[${i}](${prm.id})`;
    if (paramIds.has(prm.id)) err(p, `duplicate parameter id "${prm.id}"`);
    paramIds.add(prm.id);
    if (!num(prm.min) || !num(prm.max) || prm.min >= prm.max) err(p, "needs min < max");
    else if (!num(prm.default) || prm.default < prm.min || prm.default > prm.max) err(`${p}.default`, `must be within [${prm.min}, ${prm.max}]`);
  });

  // animations
  for (const [name, anim] of Object.entries(model.animations ?? {})) {
    const p = `animations.${name}`;
    if (!num(anim.duration) || anim.duration <= 0) err(`${p}.duration`, "must be > 0");
    const checkKeys = <T>(kp: string, keys: Key<T>[] | undefined, check: (v: T) => boolean, expect: string) => {
      if (keys === undefined) return;
      if (!Array.isArray(keys)) return err(kp, "must be an array of keys");
      keys.forEach((k, i) => {
        if (!num(k.t)) err(`${kp}[${i}].t`, "must be a number");
        else if (k.t < 0 || k.t > anim.duration + 1e-9) warn(`${kp}[${i}].t`, `time ${k.t} outside [0, ${anim.duration}]`);
        if (i > 0 && k.t < keys[i - 1].t) err(`${kp}[${i}]`, "keys must be sorted by time");
        if (!check(k.v)) err(`${kp}[${i}].v`, `expected ${expect}`);
        if (k.ease !== undefined && !isEase(k.ease) && !isChannelEases(k.ease)) err(`${kp}[${i}].ease`, `invalid ease ${JSON.stringify(k.ease)}`);
      });
    };
    const vec = (v: unknown) => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
    for (const [bone, tl] of Object.entries(anim.bones ?? {})) {
      const bp = `${p}.bones.${bone}`;
      if (!boneIds.has(bone)) err(bp, `unknown bone "${bone}"`);
      for (const ch of Object.keys(tl)) if (!["rotate", "translate", "scale", "shear", "inherit", ...AXIS_CHANNELS].includes(ch)) err(`${bp}.${ch}`, "unknown channel");
      for (const ch of AXIS_CHANNELS) checkKeys(`${bp}.${ch}`, tl[ch], num, "number");
      checkKeys(`${bp}.inherit`, tl.inherit, (v) => INHERITS.includes(v as Inherit), INHERITS.join(" | "));
      checkKeys(`${bp}.rotate`, tl.rotate, num, "number (degrees)");
      checkKeys(`${bp}.translate`, tl.translate, vec, "[x, y]");
      checkKeys(`${bp}.scale`, tl.scale, vec, "[sx, sy]");
      checkKeys(`${bp}.shear`, tl.shear, vec, "[shearX, shearY] degrees");
    }
    for (const [slot, tl] of Object.entries(anim.slots ?? {})) {
      const sp = `${p}.slots.${slot}`;
      if (!slotIds.has(slot)) err(sp, `unknown slot "${slot}"`);
      for (const ch of Object.keys(tl)) if (!["attachment", "color", "dark"].includes(ch)) err(`${sp}.${ch}`, "unknown channel");
      checkKeys(`${sp}.attachment`, tl.attachment, (v) => v === null || (typeof v === "string" && isKey(slot, v)), "attachment id, skin placeholder or null");
      checkKeys(`${sp}.color`, tl.color, isColor, "color string");
      checkKeys(`${sp}.dark`, tl.dark, isColor, "color string");
      if (tl.dark?.length && !model.slots.find((x) => x.id === slot)?.dark) warn(`${sp}.dark`, "the slot has no dark color (Spine needs one for two-color keys)");
      tl.attachment?.forEach((k) => typeof k.v === "string" && usedAttachments.add(k.v));
    }
    for (const [ik, tl] of Object.entries(anim.ik ?? {})) {
      const ip = `${p}.ik.${ik}`;
      if (!ikIds.has(ik)) err(ip, `unknown IK constraint "${ik}"`);
      for (const ch of Object.keys(tl)) if (!["mix", "bendPositive", "softness", "compress", "stretch"].includes(ch)) err(`${ip}.${ch}`, "unknown channel");
      checkKeys(`${ip}.softness`, tl.softness, (v) => num(v) && (v as number) >= 0, "number >= 0");
      checkKeys(`${ip}.compress`, tl.compress, (v) => typeof v === "boolean", "boolean");
      checkKeys(`${ip}.stretch`, tl.stretch, (v) => typeof v === "boolean", "boolean");
      checkKeys(`${ip}.mix`, tl.mix, (v) => num(v) && (v as number) >= 0 && (v as number) <= 1, "number 0..1");
      checkKeys(`${ip}.bendPositive`, tl.bendPositive, (v) => typeof v === "boolean", "boolean");
    }
    for (const [prm, keys] of Object.entries(anim.params ?? {})) {
      const def = model.parameters?.find((x) => x.id === prm);
      if (!def) err(`${p}.params.${prm}`, `unknown parameter "${prm}"`);
      checkKeys(`${p}.params.${prm}`, keys, num, "number");
      // values beyond the range are clamped when played (Live2D motions often key past it)
      const out = def ? (keys ?? []).filter((k) => num(k?.v) && (k.v < def.min - 1e-9 || k.v > def.max + 1e-9)).length : 0;
      if (out) warn(`${p}.params.${prm}`, `${out} key(s) outside [${def!.min}, ${def!.max}] (clamped when played)`);
    }
    const kinds: Array<[string, Record<string, Record<string, unknown>> | undefined, Set<string>, string[]]> = [
      ["transforms", anim.transforms as never, new Set((model.transforms ?? []).map((c) => c.id)), ["rotate", "x", "y", "scaleX", "scaleY", "shearY"]],
      ["paths", anim.paths as never, new Set((model.paths ?? []).map((c) => c.id)), ["position", "spacing", "rotate", "x", "y"]],
      ["spinePhysics", anim.spinePhysics as never, new Set(["", ...(model.spinePhysics ?? []).map((c) => c.id)]), ["inertia", "strength", "damping", "mass", "wind", "gravity", "mix", "reset"]],
      ["sliders", anim.sliders as never, new Set((model.sliders ?? []).map((c) => c.id)), ["time", "mix"]],
    ];
    for (const [kind, tls, ids, channels] of kinds) {
      for (const [id, tl] of Object.entries(tls ?? {})) {
        const cp = `${p}.${kind}.${id}`;
        if (!ids.has(id)) err(cp, `unknown constraint "${id}"`);
        for (const [ch, keys] of Object.entries(tl)) {
          if (!channels.includes(ch)) err(`${cp}.${ch}`, "unknown channel");
          else if (ch === "reset") {
            if (!Array.isArray(keys) || !keys.every((t) => num(t))) err(`${cp}.reset`, "must be an array of times");
          } else checkKeys(`${cp}.${ch}`, keys as Key<number>[], num, "number");
        }
      }
    }
    for (const [attId, keys] of Object.entries(anim.deform ?? {})) {
      const path = model.pathAttachments?.[attId] ?? model.clippings?.[attId] ?? model.boundingBoxes?.[attId];
      if (path) {
        usedAttachments.add(attId);
        checkKeys(`${p}.deform.${attId}`, keys, (v) => Array.isArray(v) && v.every((o) => Array.isArray(o) && Number.isInteger(o[0]) && o[0] >= 0 && o[0] < path.vertices.length && num(o[1]) && num(o[2])), `[vertexIndex, dx, dy] offsets for ${path.vertices.length} vertices`);
        continue;
      }
      const a = model.attachments[attId];
      const dp = `${p}.deform.${attId}`;
      if (!a) {
        err(dp, `unknown attachment "${attId}"`);
        continue;
      }
      usedAttachments.add(attId);
      checkKeys(dp, keys, (v) => Array.isArray(v) && v.every((o) => Array.isArray(o) && Number.isInteger(o[0]) && o[0] >= 0 && o[0] < a.vertices.length && num(o[1]) && num(o[2])), `[vertexIndex, dx, dy] offsets for ${a.vertices.length} vertices`);
    }
    for (const [i, e] of (anim.events ?? []).entries()) {
      if (!model.events?.[e.name]) err(`${p}.events[${i}]`, `unknown event "${e.name}"`);
      if (!(e.t >= 0 && e.t <= anim.duration + 1e-9)) err(`${p}.events[${i}]`, `time ${e.t} is outside 0..${anim.duration}`);
    }
    for (const [i, k] of (anim.drawOrder ?? []).entries()) {
      const dp = `${p}.drawOrder[${i}]`;
      if (typeof k.t !== "number" || k.t < 0 || k.t > anim.duration + 1e-9) err(dp, `time ${k.t} is outside 0..${anim.duration}`);
      for (const [slot, off] of k.offsets ?? []) {
        if (!model.slots.some((x) => x.id === slot)) err(dp, `unknown slot "${slot}"`);
        if (!Number.isInteger(off)) err(dp, `offset for "${slot}" must be an integer`);
      }
    }
  }

  // one warning each; many (Spine skins often keep spare attachments) are summed up in one
  const unused = Object.keys(model.attachments).filter((id) => !usedAttachments.has(id));
  if (unused.length > 5) warn("attachments", `${unused.length} attachments are not used by any slot or animation (e.g. ${unused.slice(0, 3).join(", ")})`);
  else for (const id of unused) warn(`attachments.${id}`, "attachment is not used by any slot or animation");
  validateSpineConstraints(model, boneIds, slotIds, err, warn);
  if (model.live2d || Object.values(model.attachments).some((a) => a.live2d)) validateLive2D(model, err, warn);
  if (model.target) {
    for (const c of targetConflicts(model, model.target)) warn("target", `this ${model.target === "live2d" ? "Live2D" : "Spine"} model has ${c}: not exported and hidden in the editor`);
  }
  for (const [name, anim] of Object.entries(model.animations ?? {})) {
    for (const [part, keys] of Object.entries(anim.partOpacity ?? {})) {
      if (!model.live2d?.parts.some((x) => x.id === part)) err(`animations.${name}.partOpacity.${part}`, `unknown part "${part}"`);
      if (!Array.isArray(keys) || keys.some((k) => !num(k?.t) || !num(k?.v))) err(`animations.${name}.partOpacity.${part}`, "keys must be { t, v } numbers");
    }
  }

  // pose checks: only when structure is sound
  const samples = opts.poseSamples ?? 8;
  if (samples > 0 && hierarchyOk && !issues.some((i) => i.level === "error")) {
    const setup = computePose(model);
    const setupSign = new Map<string, number[]>();
    // A mesh driven by one bone and nothing else moves by one affine transform: it can go NaN only through that
    // bone, and it can only flip as a whole (a mirror, not a fold). Those need no per-vertex check, which keeps
    // validation of big art-heavy models fast.
    const slotAttachment = new Map(model.slots.map((s) => [s.id, s.attachment]));
    const rigidBone = (att: string, a: MeshAttachment, fallback: string): string | null => {
      let only: string | null = null;
      for (const infl of a.weights) {
        const list = infl?.length ? infl : [[fallback, 1] as [string, number]];
        for (const [b, w] of list) {
          if (!(w > 0)) continue;
          if (only === null) only = b;
          else if (only !== b) return null;
        }
      }
      return only ?? fallback;
    };
    for (const s of model.slots) {
      const a = s.attachment ? model.attachments[s.attachment] : undefined;
      if (a) setupSign.set(s.id, a.triangles.map((t) => Math.sign(triArea(a.vertices[t[0]], a.vertices[t[1]], a.vertices[t[2]]))));
    }
    for (const [name, anim] of Object.entries(model.animations ?? {})) {
      const flagged = new Set<string>();
      const times = sampleTimes(anim, samples);
      // one warm-up loop is plenty to catch folds and NaNs (the default two only make loop starts seamless)
      const poses = samplePoses(model, name, times, { warmupLoops: 1 });
      for (const [ti, t] of times.entries()) {
        const pose = poses[ti];
        for (const sp of pose.slots) {
          const a = sp.attachment ? model.attachments[sp.attachment] : undefined;
          if (!a || flagged.has(sp.id)) continue;
          const rigid = rigidBone(sp.attachment!, a, sp.bone);
          if (rigid !== null) {
            const w = pose.byId.get(rigid)?.world;
            if (w && !w.every(Number.isFinite)) {
              err(`animations.${name}`, `slot "${sp.id}" produces NaN/Infinity vertices at t=${t}`);
              flagged.add(sp.id);
            }
            continue;
          }
          const dfm = poseDeform(model, pose, sp.attachment!, a);
          const pos = deformMesh(a, setup, pose, sp.bone, dfm.rest, dfm.local);
          if (pos.some((v) => !Number.isFinite(v[0]) || !Number.isFinite(v[1]))) {
            err(`animations.${name}`, `slot "${sp.id}" produces NaN/Infinity vertices at t=${t}`);
            flagged.add(sp.id);
            continue;
          }
          // Live2D art folds on purpose (turns drawn as keyforms)
          if (a.live2d) continue;
          const ref = sp.attachment === slotAttachment.get(sp.id) ? setupSign.get(sp.id) : undefined;
          const signs = ref ?? a.triangles.map((tr) => Math.sign(triArea(a.vertices[tr[0]], a.vertices[tr[1]], a.vertices[tr[2]])));
          const flipped = a.triangles.filter((tr, i) => {
            const s = Math.sign(triArea(pos[tr[0]], pos[tr[1]], pos[tr[2]]));
            return s !== 0 && signs[i] !== 0 && s !== signs[i];
          }).length;
          // all triangles flipping together is a mirror (negative scale), not a fold
          if (flipped > 0 && flipped < a.triangles.length) {
            warn(`animations.${name}`, `slot "${sp.id}": ${flipped}/${a.triangles.length} triangles flip (mesh folds over itself) around t=${t}`);
            flagged.add(sp.id);
          }
        }
      }
    }
  }
  return issues;
}

export function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) return "OK: no issues";
  const errors = issues.filter((i) => i.level === "error").length;
  const lines = issues.map((i) => `${i.level === "error" ? "ERROR" : "WARN "} ${i.path}: ${i.message}`);
  return `${errors} error(s), ${issues.length - errors} warning(s)\n` + lines.join("\n");
}

type Report = (path: string, message: string) => void;

/** Structure of a Live2D rig: grids, forms, parents, glue, draw-order groups, physics. */
function validateLive2D(model: Model, err: Report, warn: Report): void {
  const rig = model.live2d;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const params = new Set((model.parameters ?? []).map((p) => p.id));
  const parts = new Set((rig?.parts ?? []).map((p) => p.id));
  const defs = new Map((rig?.deformers ?? []).map((d) => [d.id, d]));
  const grid = (p: string, g: KeyformGrid | undefined, forms: number): void => {
    if (!g || !Array.isArray(g.params) || !Array.isArray(g.keys) || g.params.length !== g.keys.length) return err(`${p}.grid`, "grid needs params and one key list per param");
    const seen = new Set<string>();
    g.params.forEach((id, i) => {
      if (!params.has(id)) err(`${p}.grid`, `unknown parameter "${id}"`);
      if (seen.has(id)) err(`${p}.grid`, `parameter "${id}" appears twice`);
      seen.add(id);
      const k = g.keys[i];
      if (!Array.isArray(k) || !k.length || !k.every(num)) err(`${p}.grid.keys[${i}]`, "keys must be a non-empty list of numbers");
      else if (k.some((x, j) => j > 0 && x <= k[j - 1])) err(`${p}.grid.keys[${i}]`, "keys must be strictly increasing");
    });
    const size = g.keys.reduce((n, k) => n * (Array.isArray(k) ? k.length : 1), 1);
    if (forms !== size) err(`${p}.forms`, `the grid has ${size} points but there are ${forms} forms`);
  };
  // blend shapes: a blend-shape parameter, one form per key, forms the right size, constraints on known parameters
  const bsParams = new Map((model.parameters ?? []).filter((x) => x.blendShape).map((x) => [x.id, x.blendShape!]));
  for (const x of model.parameters ?? []) {
    const b = x.blendShape;
    if (!b) continue;
    if (!Array.isArray(b.keys) || !b.keys.length || !b.keys.every(num) || b.keys.some((k, j) => j > 0 && k <= b.keys[j - 1])) err(`parameters.${x.id}.blendShape.keys`, "keys must be strictly increasing numbers");
    else if (!(Number.isInteger(b.base) && b.base >= 0 && b.base < b.keys.length)) err(`parameters.${x.id}.blendShape.base`, "base must be the index of one of the keys");
  }
  const shapes = (p: string, list: Array<{ param: string; forms: unknown[]; constraints?: Array<{ param: string; values: unknown }> }> | undefined, check: (f: unknown, where: string) => void): void => {
    list?.forEach((sh, i) => {
      const q = `${p}.blendShapes[${i}]`;
      const b = bsParams.get(sh.param);
      if (!b) err(q, `"${sh.param}" is not a blend-shape parameter`);
      else if (!Array.isArray(sh.forms) || sh.forms.length !== b.keys.length) err(`${q}.forms`, `needs one form per key of ${sh.param} (${b.keys.length})`);
      sh.forms?.forEach((f, k) => check(f, `${q}.forms[${k}]`));
      sh.constraints?.forEach((c, k) => {
        if (!params.has(c.param)) err(`${q}.constraints[${k}]`, `unknown parameter "${c.param}"`);
        if (!Array.isArray(c.values) || !c.values.length || !c.values.every((v) => Array.isArray(v) && v.length === 2 && v.every(num))) err(`${q}.constraints[${k}].values`, "values must be [value, weight] pairs");
      });
    });
  };
  const pointsOf = (n: number) => (f: unknown, where: string) => {
    const pts = (f as { points?: unknown })?.points;
    if (!Array.isArray(pts) || pts.length !== n || !pts.every(num)) err(`${where}.points`, `needs ${n} numbers`);
  };
  const numberForm = (f: unknown, where: string) => {
    if (!num(f)) err(where, "must be a number");
  };
  const cycle = (start: string, parentOf: (id: string) => string | null | undefined): boolean => {
    const seen = new Set<string>();
    for (let id: string | null | undefined = start; id; id = parentOf(id)) {
      if (seen.has(id)) return true;
      seen.add(id);
    }
    return false;
  };
  if (rig) {
    const c = rig.canvas;
    if (!c || !(c.pixelsPerUnit > 0)) err("live2d.canvas", "canvas needs a positive pixelsPerUnit");
    const partById = new Map(rig.parts.map((x) => [x.id, x]));
    rig.parts.forEach((x, i) => {
      const p = `live2d.parts[${i}](${x.id})`;
      if (x.parent !== null && !parts.has(x.parent)) err(`${p}.parent`, `unknown part "${x.parent}"`);
      else if (cycle(x.id, (id) => partById.get(id)?.parent)) err(`${p}.parent`, "part hierarchy cycle");
      grid(p, x.grid, x.drawOrders?.length ?? 0);
      shapes(p, x.blendShapes as Array<{ param: string; forms: unknown[] }> | undefined, numberForm);
    });
    rig.deformers.forEach((d, i) => {
      const p = `live2d.deformers[${i}](${d.id})`;
      if (d.parent !== null && !defs.has(d.parent)) err(`${p}.parent`, `unknown deformer "${d.parent}"`);
      else if (cycle(d.id, (id) => defs.get(id)?.parent)) err(`${p}.parent`, "deformer hierarchy cycle");
      if (d.part !== null && !parts.has(d.part)) err(`${p}.part`, `unknown part "${d.part}"`);
      grid(p, d.grid, d.forms?.length ?? 0);
      if (d.type === "warp") {
        if (!(Number.isInteger(d.cols) && d.cols >= 1 && Number.isInteger(d.rows) && d.rows >= 1)) err(p, "cols and rows must be integers >= 1");
        const n = (d.cols + 1) * (d.rows + 1) * 2;
        d.forms?.forEach((f, k) => {
          if (!Array.isArray(f.points) || f.points.length !== n || !f.points.every(num)) err(`${p}.forms[${k}].points`, `needs ${n} numbers (x, y per lattice point)`);
        });
        shapes(p, d.blendShapes, pointsOf(n));
      } else if (d.type === "rotation") {
        d.forms?.forEach((f, k) => {
          if (![f.x, f.y, f.angle, f.scale].every(num)) err(`${p}.forms[${k}]`, "x, y, angle and scale must be numbers");
        });
        shapes(p, d.blendShapes, (f, where) => {
          const r = f as { x?: unknown; y?: unknown; angle?: unknown; scale?: unknown };
          if (![r.x, r.y, r.angle, r.scale].every(num)) err(where, "x, y, angle and scale must be numbers");
        });
      } else err(p, `unknown deformer type "${(d as { type: string }).type}"`);
    });
    for (const [i, g] of (rig.glue ?? []).entries()) {
      const p = `live2d.glue[${i}](${g.id})`;
      const a = model.attachments[g.a];
      const b = model.attachments[g.b];
      if (!a || !b) err(p, `unknown mesh "${!a ? g.a : g.b}"`);
      else if (g.pairs.length % 2 || g.weights.length !== g.pairs.length) err(p, "pairs are [vertexInA, vertexInB] and weights one per entry");
      else if (g.pairs.some((v, k) => !Number.isInteger(v) || v < 0 || v >= (k % 2 ? b : a).vertices.length)) err(`${p}.pairs`, "vertex index out of range");
      grid(p, g.grid, g.intensity?.length ?? 0);
      shapes(p, g.blendShapes as Array<{ param: string; forms: unknown[] }> | undefined, numberForm);
    }
    const groups = rig.drawOrderGroups ?? [];
    const inGroups = new Set<string>();
    groups.forEach((g, gi) => {
      g.items.forEach((it, k) => {
        const p = `live2d.drawOrderGroups[${gi}].items[${k}]`;
        if ("slot" in it) {
          if (!model.slots.some((s) => s.id === it.slot)) err(p, `unknown slot "${it.slot}"`);
          if (inGroups.has(it.slot)) err(p, `slot "${it.slot}" is in more than one group`);
          inGroups.add(it.slot);
        } else {
          if (!parts.has(it.part)) err(p, `unknown part "${it.part}"`);
          if (!(Number.isInteger(it.group) && it.group > gi && it.group < groups.length)) err(p, "group must be a later group index");
        }
      });
    });
    rig.physics?.settings.forEach((s, i) => {
      const p = `live2d.physics.settings[${i}](${s.id})`;
      for (const x of [...s.inputs, ...s.outputs]) {
        if (!params.has(x.param)) err(p, `unknown parameter "${x.param}"`);
        if (!["X", "Y", "Angle"].includes(x.type)) err(p, "type must be X, Y or Angle");
      }
      for (const o of s.outputs) if (!(o.vertex >= 1 && o.vertex < s.vertices.length)) warn(p, `output "${o.param}" uses vertex ${o.vertex}, the strand has ${s.vertices.length}`);
    });
    for (const id of params) if (new TextEncoder().encode(id).length > 63) warn(`parameters.${id}`, "Live2D ids are at most 63 bytes (export fails)");
  }
  for (const [id, a] of Object.entries(model.attachments)) {
    const l = a.live2d;
    if (!l) continue;
    const p = `attachments.${id}.live2d`;
    if (!rig) {
      err(p, "Live2D mesh but the model has no live2d rig");
      continue;
    }
    if (l.deformer !== null && !defs.has(l.deformer)) err(`${p}.deformer`, `unknown deformer "${l.deformer}"`);
    if (l.part !== null && !parts.has(l.part)) err(`${p}.part`, `unknown part "${l.part}"`);
    grid(p, l.grid, l.forms?.length ?? 0);
    const n = a.vertices.length * 2;
    l.forms?.forEach((f, k) => {
      if (!Array.isArray(f.points) || f.points.length !== n || !f.points.every(num)) err(`${p}.forms[${k}].points`, `needs ${n} numbers (x, y per vertex)`);
    });
    shapes(p, l.blendShapes, pointsOf(n));
    if (l.paths) {
      try {
        checkPaths(l.paths, a.vertices.length);
      } catch (e) {
        err(`${p}.paths`, (e as Error).message);
      }
    }
    if (rig.drawOrderGroups?.length && !model.slots.some((s) => s.attachment === id && rig.drawOrderGroups!.some((g) => g.items.some((it) => "slot" in it && it.slot === s.id)))) {
      warn(p, "not in any draw-order group (drawn after the listed ones)");
    }
  }
}

/** Spine constraints (transform, path, physics, sliders), their order, skins and path attachments. */
function validateSpineConstraints(model: Model, boneIds: Set<string>, slotIds: Set<string>, err: (p: string, m: string) => void, warn: (p: string, m: string) => void): void {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const bone = (p: string, b: unknown) => {
    if (typeof b !== "string" || !boneIds.has(b)) err(p, `unknown bone "${String(b)}"`);
  };
  const seen = new Map<string, Set<string>>();
  const unique = (kind: string, p: string, id: string) => {
    const set = seen.get(kind) ?? new Set<string>();
    seen.set(kind, set);
    if (set.has(id)) err(p, `duplicate ${kind} id "${id}"`);
    set.add(id);
  };
  (model.transforms ?? []).forEach((c, i) => {
    const p = `transforms[${i}](${c.id})`;
    unique("transform", p, c.id);
    bone(`${p}.source`, c.source);
    if (!Array.isArray(c.bones) || !c.bones.length) err(`${p}.bones`, "needs at least one bone");
    for (const b of c.bones ?? []) bone(`${p}.bones`, b);
    if ((c.bones ?? []).includes(c.source)) err(`${p}.bones`, "the source cannot be one of the constrained bones");
    for (const [k, v] of Object.entries(c.mix ?? {})) if (!TRANSFORM_PROPERTIES.includes(k as TransformProperty) || !num(v)) err(`${p}.mix.${k}`, "unknown property or not a number");
    for (const [j, m] of (c.properties ?? []).entries()) {
      if (!TRANSFORM_PROPERTIES.includes(m.from)) err(`${p}.properties[${j}].from`, `must be one of ${TRANSFORM_PROPERTIES.join(", ")}`);
      for (const t of m.to ?? []) if (!TRANSFORM_PROPERTIES.includes(t.property)) err(`${p}.properties[${j}].to`, `must be one of ${TRANSFORM_PROPERTIES.join(", ")}`);
    }
  });
  (model.paths ?? []).forEach((c, i) => {
    const p = `paths[${i}](${c.id})`;
    unique("path", p, c.id);
    for (const b of c.bones ?? []) bone(`${p}.bones`, b);
    if (!slotIds.has(c.slot)) err(`${p}.slot`, `unknown slot "${c.slot}"`);
    if (!["fixed", "percent"].includes(c.positionMode)) err(`${p}.positionMode`, "must be fixed or percent");
    if (!["length", "fixed", "percent", "proportional"].includes(c.spacingMode)) err(`${p}.spacingMode`, "must be length, fixed, percent or proportional");
    if (!["tangent", "chain", "chainScale"].includes(c.rotateMode)) err(`${p}.rotateMode`, "must be tangent, chain or chainScale");
  });
  (model.spinePhysics ?? []).forEach((c, i) => {
    const p = `spinePhysics[${i}](${c.id})`;
    unique("physics", p, c.id);
    bone(`${p}.bone`, c.bone);
    for (const k of SPINE_PHYSICS_SETTINGS) if (!num(c[k])) err(`${p}.${k}`, "must be a number");
    if (num(c.mass) && c.mass <= 0) err(`${p}.mass`, "must be > 0");
    if (!(c.x || c.y || c.rotate || c.scaleX || c.shearX)) warn(p, "simulates nothing (x, y, rotate, scaleX and shearX are all 0)");
  });
  (model.sliders ?? []).forEach((c, i) => {
    const p = `sliders[${i}](${c.id})`;
    unique("slider", p, c.id);
    if (!model.animations?.[c.animation]) err(`${p}.animation`, `unknown animation "${c.animation}"`);
    if (c.bone !== undefined) bone(`${p}.bone`, c.bone);
    if (c.property !== undefined && !TRANSFORM_PROPERTIES.includes(c.property)) err(`${p}.property`, `must be one of ${TRANSFORM_PROPERTIES.join(", ")}`);
  });
  const keys = new Set([
    ...(model.ik ?? []).map((c) => `ik:${c.id}`),
    ...(model.transforms ?? []).map((c) => `transform:${c.id}`),
    ...(model.paths ?? []).map((c) => `path:${c.id}`),
    ...(model.spinePhysics ?? []).map((c) => `physics:${c.id}`),
    ...(model.sliders ?? []).map((c) => `slider:${c.id}`),
  ]);
  for (const k of model.constraintOrder ?? []) if (!keys.has(k)) err("constraintOrder", `unknown constraint "${k}" (entries are "<kind>:<id>")`);
  for (const [name, sk] of Object.entries(model.skins ?? {})) {
    const p = `skins.${name}`;
    for (const [slot, m] of Object.entries(sk.attachments ?? {})) {
      if (!slotIds.has(slot)) err(`${p}.attachments.${slot}`, `unknown slot "${slot}"`);
      for (const [key, id] of Object.entries(m)) if (!model.attachments[id] && !model.pathAttachments?.[id] && !model.clippings?.[id] && !model.boundingBoxes?.[id]) err(`${p}.attachments.${slot}.${key}`, `unknown attachment "${id}"`);
    }
    for (const b of sk.bones ?? []) bone(`${p}.bones`, b);
    for (const c of sk.constraints ?? []) if (!keys.has(c)) err(`${p}.constraints`, `unknown constraint "${c}"`);
  }
  if (model.skin !== undefined && !model.skins?.[model.skin]) err("skin", `unknown skin "${model.skin}"`);
  for (const [id, a] of Object.entries(model.pathAttachments ?? {})) {
    const p = `pathAttachments.${id}`;
    if (!Array.isArray(a.vertices) || a.vertices.length % 3 !== 0) err(`${p}.vertices`, "3 vertices per path point (in handle, point, out handle)");
    if (a.weights?.length !== a.vertices?.length) err(`${p}.weights`, "one weight list per vertex");
    for (const w of a.weights ?? []) for (const [b] of w) if (!boneIds.has(b)) err(`${p}.weights`, `unknown bone "${b}"`);
  }
  for (const [id, a] of Object.entries(model.clippings ?? {})) {
    const p = `clippings.${id}`;
    if (!Array.isArray(a.vertices) || a.vertices.length < 3) err(`${p}.vertices`, "a clipping polygon needs 3 or more vertices");
    if (a.weights?.length !== a.vertices?.length) err(`${p}.weights`, "one weight list per vertex");
    for (const w of a.weights ?? []) for (const [b] of w) if (!boneIds.has(b)) err(`${p}.weights`, `unknown bone "${b}"`);
    if (a.end !== undefined && !slotIds.has(a.end)) err(`${p}.end`, `unknown slot "${a.end}"`);
    if (model.attachments[id] || model.pathAttachments?.[id]) err(p, `id "${id}" is also a mesh or path attachment`);
  }
  for (const [id, a] of Object.entries(model.boundingBoxes ?? {})) {
    const p = `boundingBoxes.${id}`;
    if (!Array.isArray(a.vertices) || a.vertices.length < 3) err(`${p}.vertices`, "a bounding box needs 3 or more vertices");
    if (a.weights?.length !== a.vertices?.length) err(`${p}.weights`, "one weight list per vertex");
    for (const w of a.weights ?? []) for (const [b] of w) if (!boneIds.has(b)) err(`${p}.weights`, `unknown bone "${b}"`);
    if (a.color !== undefined && !isColor(a.color)) err(`${p}.color`, "color must be #rrggbb or #rrggbbaa");
    if (model.attachments[id] || model.pathAttachments?.[id] || model.clippings?.[id]) err(p, `id "${id}" is also a mesh, path or clipping attachment`);
  }
}
