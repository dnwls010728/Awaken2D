// Spine skeleton JSON (4.x, with 3.8 curve syntax understood) -> Awaken2D model.
// Everything Awaken2D evaluates is mapped onto the model: bones (shear, inherit modes, skin bones), slots, skins with
// region / mesh / linked mesh / path / clipping / bounding box attachments, weights, the IK, transform, path, physics and slider constraints
// (in Spine's order), events and animations (bone, slot, deform, draw-order, event and constraint timelines). What
// Awaken2D does not evaluate (point attachments, sequences, ...) is kept verbatim in
// meta.spine and written back by the exporter, and so is the original data of everything unedited (by signature),
// so a round trip does not change it.
import { computePose, describePlan, emptyModel, meshAutoPlan, round } from "../core/index.ts";
import type {
  BoundingBoxAttachment,
  ClippingAttachment,
  Ease,
  EventDef,
  EventKey,
  Inherit,
  Key,
  MeshAttachment,
  Model,
  PathAttachment,
  PathConstraint,
  Slider,
  SpinePhysics,
  SpinePhysicsSetting,
  TransformConstraint,
  TransformProperty,
  Tri,
  Vec2,
  VertexOffsets,
} from "../core/index.ts";
import type { RGBAImage } from "../render/png.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface SpineImportResult {
  model: Model;
  /** Images to write, by image id (the model stores them at images/<id>.png). */
  images: Map<string, RGBAImage>;
  log: string[];
  warnings: string[];
}

export interface SpineImportOptions {
  name?: string;
  /** Image for an attachment path (region name): from the atlas, or a PNG in the images folder. */
  resolveImage: (path: string) => RGBAImage | null;
}

/** Everything the exporter needs to write Spine data back the way it came in. */
export interface SpineMeta {
  version: string;
  skeleton: Json;
  /** Setup world matrix of every bone at import: raw local data is only reused while these are unchanged. */
  setupWorld: Record<string, number[]>;
  bones: Record<string, Json>;
  slots: Record<string, Json>;
  /** Per Awaken2D attachment id (mesh or path): where it lives (skin, slot, name) and its original data. */
  attachments: Record<string, { slot: string; name: string; raw: Json; sig: string; skin?: string }>;
  /** Attachments Awaken2D does not draw (point, and other types it does not know), per slot and name (default skin). */
  extraAttachments: Record<string, Record<string, Json>>;
  /** The same for the other skins: skin -> slot -> name. */
  skinExtraAttachments?: Record<string, Record<string, Record<string, Json>>>;
  /** Skins other than "default": their other fields (color, ...), and the skin order. */
  skins: Json[];
  /** Default-skin extras (bones/constraints lists of skin-specific data). */
  defaultSkin: Json;
  constraints: {
    ik: Record<string, Json>;
    transform: Json[];
    path: Json[];
    physics: Json[];
    /** Spine 4.3+ slider constraints. */
    slider?: Json[];
    /** Spine 4.3+: one "constraints" array; the names in their order (it is the evaluation order). */
    order?: Array<{ type: string; name: string }>;
    /** Every constraint as written ("<type>:<name>"), with the signature of the Awaken2D constraint it became (unedited = written back as is). */
    raw?: Record<string, { type: string; raw: Json; sig: string }>;
  };
  /** Per animation: timelines Awaken2D does not evaluate, and original deform keys by attachment id. */
  animations: Record<
    string,
    {
      extra: Json;
      deform: Record<string, { skin: string; slot: string; name: string; raw: Json; sig: string }>;
      /** Tracks ("bones/<bone>/<channel>", "slots/<slot>/<channel>", "deform/<id>", "ik/<name>/<channel>") that got a stepped setup key at 0. */
      setupKeys?: string[];
      /**
       * Bone tracks whose curves had to be cut (a bulge between equal values): the Spine timelines as written, and
       * the Awaken2D track they became. Unedited tracks are exported as written.
       */
      rawTracks?: Record<string, { raw: Record<string, Json[]>; sig: string }>;
      /** Constraint timelines ("transform/<name>", "path/<name>", "physics/<name>", "slider/<name>", "ik/<name>") as written. */
      constraintTracks?: Record<string, { raw: Json; sig: string }>;
    }
  >;
}

const hex = (c: string | undefined, fallback = "ffffffff") => {
  const v = (c ?? fallback).toLowerCase().replace(/^#/, "");
  return "#" + (v.length === 6 ? v + "ff" : v);
};

/** Signature of an attachment's geometry, to tell on export whether it was edited since import. */
export const meshSig = (a: MeshAttachment) => JSON.stringify([a.vertices, a.uvs, a.triangles, a.weights, a.image ?? null, a.binds ?? null]);

/**
 * Converts a Spine 4 bezier (absolute handles for each channel) between keys a and b into a Awaken2D ease: the
 * first channel that changes value decides the normalized curve (the Spine editor gives every channel the same
 * normalized curve unless edited per channel).
 */
function curveEase(curve: Json, t0: number, t1: number, v0: number[], v1: number[], version: string): Ease | Ease[] | undefined {
  if (curve === undefined) return undefined;
  if (curve === "stepped") return "stepped";
  const dt = t1 - t0 || 1;
  if (version.startsWith("3")) {
    // 3.x: normalized [c1, c2, c3, c4] (or a number with c2..c4 on the key, handled by the caller).
  // 4.x handles are kept as they are, also outside the keys' time span: Spine samples such curves as written
    if (Array.isArray(curve) && curve.length === 4) return curve.map((n: number) => round(n, 5)) as Ease;
    return undefined;
  }
  if (!Array.isArray(curve)) return undefined;
  // normalized curve of every channel (null where the channel does not change: any curve fits it)
  const per: Array<[number, number, number, number] | null> = [];
  for (let c = 0; c < v0.length && c * 4 + 3 < curve.length; c++) {
    const [cx1, cy1, cx2, cy2] = curve.slice(c * 4, c * 4 + 4);
    const x1 = round((cx1 - t0) / dt, 7);
    const x2 = round((cx2 - t0) / dt, 7);
    const dv = v1[c] - v0[c];
    per.push(Math.abs(dv) < 1e-9 ? null : [x1, round((cy1 - v0[c]) / dv, 7), x2, round((cy2 - v0[c]) / dv, 7)]);
  }
  const defined = per.filter((p): p is [number, number, number, number] => !!p);
  if (!defined.length) {
    // nothing changes: keep the timing handles so the curve survives a round trip
    const [cx1, , cx2] = curve;
    const x1 = round((cx1 - t0) / dt, 7);
    const x2 = round((cx2 - t0) / dt, 7);
    return [x1, x1, x2, x2];
  }
  // channels that do not change keep their own timing handles (y = x: any curve fits them, the handles survive export)
  const flat = (c: number): [number, number, number, number] => {
    const x1 = round((curve[c * 4] - t0) / dt, 7);
    const x2 = round((curve[c * 4 + 2] - t0) / dt, 7);
    return [x1, x1, x2, x2];
  };
  // one curve for all channels only when it puts every handle where it is (in time and value units)
  const close = (a: number, b: number, scale: number) => Math.abs(a - b) * scale < 1e-4;
  const same =
    per.every((p, c) => !p || p.every((v, i) => close(v, defined[0][i], i % 2 ? Math.abs(v1[c] - v0[c]) : dt))) &&
    per.every((p, c) => p || (close(flat(c)[0], defined[0][0], dt) && close(flat(c)[2], defined[0][2], dt)));
  if (same) return defined[0];
  // Spine allows a different curve per channel (graph editor): keep one ease per channel
  return per.map((p, c) => p ?? flat(c));
}

/**
 * A Spine 4 curve between two keys with the same value can still bulge (handles above or below): a normalized
 * ease cannot say that. Such segments are cut in half exactly (de Casteljau at the curve's middle), which adds a
 * key at the bulge; both halves then run between different values. `fields` are the key's numeric channels.
 */
function splitFlatCurves(raw: Json[], fields: string[], defaults: number[]): Json[] {
  const out: Json[] = raw.map((k) => ({ ...k }));
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i];
      const b = out[i + 1];
      const curve = a.curve;
      if (!Array.isArray(curve) || curve.length < fields.length * 4) continue;
      const t0 = a.time ?? 0;
      const t1 = b.time ?? 0;
      const v0 = fields.map((f, c) => a[f] ?? defaults[c]);
      const v1 = fields.map((f, c) => b[f] ?? defaults[c]);
      // a bulge worth a key (tiny values are export noise)
      const bulger = fields.findIndex((_, c) => Math.abs(v1[c] - v0[c]) < 1e-9 && (Math.abs(curve[c * 4 + 1] - v0[c]) > 1e-4 || Math.abs(curve[c * 4 + 3] - v0[c]) > 1e-4));
      if (bulger < 0) continue;
      const bez = (p0: number, p1: number, p2: number, p3: number, u: number) => (1 - u) ** 3 * p0 + 3 * (1 - u) ** 2 * u * p1 + 3 * (1 - u) * u * u * p2 + u ** 3 * p3;
      // cut at the middle of the bulging channel's curve; the other channels at the same time
      const [bx1, , bx2] = curve.slice(bulger * 4, bulger * 4 + 4);
      const tm = bez(t0, bx1, bx2, t1, 0.5);
      const left: number[] = [];
      const right: number[] = [];
      const mid: Json = {};
      fields.forEach((f, c) => {
        const [x1, y1, x2, y2] = curve.slice(c * 4, c * 4 + 4);
        let u = 0.5;
        if (c !== bulger) {
          let lo = 0;
          let hi = 1;
          for (let n = 0; n < 60; n++) {
            const m = (lo + hi) / 2;
            if (bez(t0, x1, x2, t1, m) < tm) lo = m;
            else hi = m;
          }
          u = (lo + hi) / 2;
        }
        const l = (p: number, q: number) => p + (q - p) * u;
        const m01 = [l(t0, x1), l(v0[c], y1)];
        const m12 = [l(x1, x2), l(y1, y2)];
        const m23 = [l(x2, t1), l(y2, v1[c])];
        const A = [l(m01[0], m12[0]), l(m01[1], m12[1])];
        const B = [l(m12[0], m23[0]), l(m12[1], m23[1])];
        const S = [l(A[0], B[0]), l(A[1], B[1])];
        left.push(m01[0], m01[1], A[0], A[1]);
        right.push(B[0], B[1], m23[0], m23[1]);
        mid[f] = S[1];
      });
      a.curve = left;
      out.splice(i + 1, 0, { ...mid, time: tm, curve: right });
      changed = true;
      i++;
    }
    if (!changed) break;
  }
  return out;
}

/** Builds Awaken2D keys from Spine keys, converting each key's curve (which describes the way to the next key). */
function keysFrom<T>(raw: Json[], version: string, value: (k: Json) => T, channels: (v: T) => number[]): Key<T>[] {
  const out: Key<T>[] = [];
  raw.forEach((k, i) => {
    const t = k.time ?? 0;
    const v = value(k);
    const key: Key<T> = { t: round(t, 5), v };
    const next = raw[i + 1];
    let curve = k.curve;
    // 3.8: a number c1 with c2, c3, c4 fields
    if (typeof curve === "number") curve = [curve, k.c2 ?? 0, k.c3 ?? 1, k.c4 ?? 1];
    if (next) {
      const ease = curveEase(curve, t, next.time ?? 0, channels(v), channels(value(next)), version);
      if (ease) key.ease = ease;
    } else if (curve === "stepped") key.ease = "stepped";
    out.push(key);
  });
  return out;
}

export function importSpineData(json: Json, opts: SpineImportOptions): SpineImportResult {
  const log: string[] = [];
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(msg);
  };
  if (!json || typeof json !== "object" || !Array.isArray(json.bones)) throw new Error("not Spine skeleton JSON (no bones array)");
  const version: string = String(json.skeleton?.spine ?? "4.2");
  if (!/^[34]\./.test(version)) warnOnce("version", `Spine ${version}: only 3.8 and 4.x data are known; importing anyway`);

  const model: Model = emptyModel(opts.name ?? "spine", "spine");
  model.bones = [];
  const meta: SpineMeta = {
    version,
    skeleton: json.skeleton ?? {},
    setupWorld: {},
    bones: {},
    slots: {},
    attachments: {},
    extraAttachments: {},
    skins: [],
    defaultSkin: {},
    constraints: { ik: {}, transform: json.transform ?? [], path: json.path ?? [], physics: json.physics ?? [] },
    animations: {},
  };
  const pick = (o: Json, known: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !known.includes(k)));

  // ---- bones
  for (const b of json.bones) {
    model.bones.push({
      id: b.name,
      parent: b.parent ?? null,
      x: b.x ?? 0,
      y: b.y ?? 0,
      rotation: b.rotation ?? 0,
      scaleX: b.scaleX ?? 1,
      scaleY: b.scaleY ?? 1,
      ...(b.shearX ? { shearX: b.shearX } : {}),
      ...(b.shearY ? { shearY: b.shearY } : {}),
      length: b.length ?? 0,
      ...(b.color ? { color: hex(b.color) } : {}),
      ...(b.icon ? { icon: String(b.icon) } : {}),
      ...(inheritOf(b.inherit ?? b.transform) !== "normal" ? { inherit: inheritOf(b.inherit ?? b.transform) } : {}),
      ...(b.skin ? { skin: true } : {}),
    });
    const extra = pick(b, ["name", "parent", "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "length", "color", "icon", "inherit", "transform", "skin"]);
    if (Object.keys(extra).length) meta.bones[b.name] = extra;
  }
  if (json.skeleton?.referenceScale !== undefined) model.referenceScale = json.skeleton.referenceScale;
  const setup = computePose(model);
  for (const b of setup.bones) meta.setupWorld[b.id] = b.world.map((v) => round(v, 6));
  const world = (bone: string) => setup.byId.get(bone)!.world;
  const toWorld = (bone: string, x: number, y: number): Vec2 => {
    const m = world(bone);
    return [round(m[0] * x + m[2] * y + m[4], 4), round(m[1] * x + m[3] * y + m[5], 4)];
  };
  const linear = (bone: string, x: number, y: number): Vec2 => {
    const m = world(bone);
    return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
  };
  const boneAt = (i: number) => {
    const b = json.bones[i];
    if (!b) throw new Error(`bone index ${i} does not exist`);
    return b.name as string;
  };

  // ---- skins: every attachment of every skin becomes a Awaken2D attachment; slots and keys name them by
  // "attachment key": the default skin's attachment id, or the placeholder name for skin-only placeholders
  const skinList: Json[] = Array.isArray(json.skins)
    ? json.skins
    : Object.entries(json.skins ?? {}).map(([name, attachments]) => ({ name, attachments }));
  const defaultSkin = skinList.find((s) => s.name === "default") ?? { name: "default", attachments: {} };
  meta.skins = skinList.filter((s) => s !== defaultSkin).map((s) => ({ name: s.name, ...pick(s, ["name", "attachments", "bones", "ik", "transform", "path", "physics", "slider"]) }));
  meta.defaultSkin = pick(defaultSkin, ["name", "attachments"]);

  // attachment ids: default skin: the Spine name when it is unique in the skin, else "slot/name";
  // other skins: "<skin>/<slot>/<name>"
  const nameCount = new Map<string, number>();
  for (const atts of Object.values<Json>(defaultSkin.attachments ?? {})) for (const n of Object.keys(atts)) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  const idOf = new Map<string, string>(); // "skin\u0000slot\u0000name" -> id
  const idIn = (skin: string, slot: string, name: string) => idOf.get(`${skin}\u0000${slot}\u0000${name}`);
  const idFor = (slot: string, name: string) => idIn("default", slot, name);
  /** The key slots and attachment keys use for a Spine attachment name. */
  const keyFor = (slot: string, name: string) => idFor(slot, name) ?? name;
  const images = new Map<string, RGBAImage>();
  const useImage = (path: string, what: string): string | undefined => {
    if (!images.has(path)) {
      const img = opts.resolveImage(path);
      if (!img) {
        warnings.push(`${what}: image "${path}" not found in the atlas or images folder; the mesh is imported untextured`);
        return undefined;
      }
      images.set(path, img);
      model.images![path] = { path: `images/${path}.png` };
    }
    return path;
  };
  const slotBone = new Map<string, string>((json.slots ?? []).map((s: Json) => [s.name, s.bone]));
  const linked: Array<{ skin: string; slot: string; name: string; raw: Json; id: string }> = [];
  const bindsFor = new Map<string, number[]>();
  const knownSlot = new Set<string>((json.slots ?? []).map((s: Json) => s.name));

  /** Setup-space vertices and weights of a Spine vertex attachment (mesh or path), plus bind positions when they disagree. */
  const readVertices = (bone: string, rawVerts: number[], n: number) => {
    const vertices: Vec2[] = [];
    const weights: MeshAttachment["weights"] = [];
    let binds: number[] | undefined;
    if (rawVerts.length === n * 2) {
      for (let i = 0; i < n; i++) {
        vertices.push(toWorld(bone, rawVerts[i * 2], rawVerts[i * 2 + 1]));
        weights.push([[bone, 1]]);
      }
      return { vertices, weights, binds };
    }
    // weighted: per vertex [count, (boneIndex, x, y, weight) * count], positions local to each bone
    let i = 0;
    const all: number[] = [];
    let disagree = 0;
    for (let v = 0; v < n; v++) {
      const count = rawVerts[i++];
      let x = 0;
      let y = 0;
      const list: Array<[string, number]> = [];
      const first: Vec2[] = [];
      for (let k = 0; k < count; k++) {
        const b = boneAt(rawVerts[i++]);
        all.push(rawVerts[i], rawVerts[i + 1]);
        const p = toWorld(b, rawVerts[i++], rawVerts[i++]);
        const wgt = rawVerts[i++];
        if (first.length) disagree = Math.max(disagree, Math.hypot(p[0] - first[0][0], p[1] - first[0][1]));
        first.push(p);
        x += p[0] * wgt;
        y += p[1] * wgt;
        list.push([b, wgt]);
      }
      vertices.push([round(x, 4), round(y, 4)]);
      weights.push(list);
    }
    // bones moved in setup after binding: the per-bone positions disagree, keep them for exact skinning
    if (disagree > 1e-3) binds = all;
    return { vertices, weights, binds };
  };

  model.skins = {};
  for (const skin of skinList) {
    const skinName: string = skin.name;
    const isDefault = skin === defaultSkin;
    if (!isDefault) {
      const constraints = ["ik", "transform", "path", "physics", "slider"].flatMap((k) => ((skin[k] ?? []) as string[]).map((n) => `${k}:${n}`));
      model.skins[skinName] = { attachments: {}, ...(skin.bones?.length ? { bones: [...skin.bones] } : {}), ...(constraints.length ? { constraints } : {}) };
    }
    for (const [slot, atts] of Object.entries<Json>(skin.attachments ?? {})) {
      const bone = slotBone.get(slot);
      if (!bone || !knownSlot.has(slot)) {
        warnings.push(`skin ${skinName}: attachments for unknown slot "${slot}" skipped`);
        continue;
      }
      for (const [name, raw] of Object.entries<Json>(atts)) {
        const type = raw.type ?? "region";
        const id = isDefault ? ((nameCount.get(name) ?? 0) > 1 ? `${slot}/${name}` : name) : `${skinName}/${slot}/${name}`;
        const where = isDefault ? `${slot}/${name}` : `${skinName}: ${slot}/${name}`;
        const drawable = type === "region" || type === "mesh" || type === "linkedmesh" || type === "path" || type === "clipping" || type === "boundingbox";
        if (drawable) {
          idOf.set(`${skinName}\u0000${slot}\u0000${name}`, id);
          if (!isDefault) (model.skins[skinName].attachments[slot] ??= {})[keyFor(slot, name)] = id;
        }
        if (raw.sequence) warnOnce("sequence", `image sequences (${where}) are kept for export; Awaken2D shows the first image`);
        if (type === "region") {
          const image = useImage(raw.path ?? raw.name ?? name, where);
          const w = raw.width ?? 32;
          const h = raw.height ?? 32;
          const sx = raw.scaleX ?? 1;
          const sy = raw.scaleY ?? 1;
          const r = ((raw.rotation ?? 0) * Math.PI) / 180;
          const c = Math.cos(r);
          const sn = Math.sin(r);
          const corner = (lx: number, ly: number): Vec2 => {
            const x = lx * w * sx;
            const y = ly * h * sy;
            return toWorld(bone, (raw.x ?? 0) + x * c - y * sn, (raw.y ?? 0) + x * sn + y * c);
          };
          const vertices = [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)];
          const ccw = (vertices[1][0] - vertices[0][0]) * (vertices[2][1] - vertices[0][1]) - (vertices[1][1] - vertices[0][1]) * (vertices[2][0] - vertices[0][0]) > 0;
          const att: MeshAttachment = {
            type: "mesh",
            ...(image ? { image } : {}),
            ...(raw.color && raw.color.toLowerCase() !== "ffffffff" ? { color: hex(raw.color) } : {}),
            vertices,
            uvs: [[0, 1], [1, 1], [1, 0], [0, 0]],
            triangles: ccw ? [[0, 1, 2], [0, 2, 3]] : [[0, 2, 1], [0, 3, 2]],
            weights: vertices.map(() => [[bone, 1]]),
          };
          model.attachments[id] = att;
          meta.attachments[id] = { slot, name, raw, sig: meshSig(att), ...(isDefault ? {} : { skin: skinName }) };
        } else if (type === "mesh") {
          const image = useImage(raw.path ?? raw.name ?? name, where);
          const uvs: Vec2[] = [];
          for (let i = 0; i < raw.uvs.length; i += 2) uvs.push([raw.uvs[i], raw.uvs[i + 1]]);
          const { vertices, weights, binds } = readVertices(bone, raw.vertices, uvs.length);
          if (binds) bindsFor.set(`${skinName}\u0000${slot}\u0000${name}`, binds);
          const triangles: Tri[] = [];
          for (let i = 0; i < raw.triangles.length; i += 3) {
            const t: Tri = [raw.triangles[i], raw.triangles[i + 1], raw.triangles[i + 2]];
            const [a, b, cc] = t.map((k) => vertices[k]);
            const area = (b[0] - a[0]) * (cc[1] - a[1]) - (b[1] - a[1]) * (cc[0] - a[0]);
            triangles.push(area < 0 ? [t[0], t[2], t[1]] : t);
          }
          const att: MeshAttachment = {
            type: "mesh",
            ...(image ? { image } : {}),
            ...(raw.color && raw.color.toLowerCase() !== "ffffffff" ? { color: hex(raw.color) } : {}),
            vertices,
            uvs,
            triangles,
            weights,
            ...(binds ? { binds } : {}),
          };
          model.attachments[id] = att;
          meta.attachments[id] = { slot, name, raw, sig: meshSig(att), ...(isDefault ? {} : { skin: skinName }) };
        } else if (type === "linkedmesh") {
          linked.push({ skin: skinName, slot, name, raw, id });
        } else if (type === "path") {
          const count = raw.vertexCount ?? 0;
          const { vertices, weights, binds } = readVertices(bone, raw.vertices, count);
          const att: PathAttachment = {
            vertices,
            weights,
            ...(binds ? { binds } : {}),
            ...(raw.closed ? { closed: true } : {}),
            ...(raw.constantSpeed === false ? { constantSpeed: false } : { constantSpeed: true }),
            lengths: raw.lengths ?? [],
            ...(raw.color ? { color: hex(raw.color) } : {}),
          };
          (model.pathAttachments ??= {})[id] = att;
          meta.attachments[id] = { slot, name, raw, sig: pathSig(att), ...(isDefault ? {} : { skin: skinName }) };
        } else if (type === "clipping") {
          const count = raw.vertexCount ?? 0;
          const { vertices, weights, binds } = readVertices(bone, raw.vertices, count);
          const att: ClippingAttachment = {
            vertices,
            weights,
            ...(binds ? { binds } : {}),
            ...(raw.end ? { end: String(raw.end) } : {}),
            ...(raw.convex ? { convex: true } : {}),
            ...(raw.inverse ? { inverse: true } : {}),
            ...(raw.color ? { color: hex(raw.color) } : {}),
          };
          (model.clippings ??= {})[id] = att;
          meta.attachments[id] = { slot, name, raw, sig: clipSig(att), ...(isDefault ? {} : { skin: skinName }) };
        } else if (type === "boundingbox") {
          const { vertices, weights, binds } = readVertices(bone, raw.vertices, raw.vertexCount ?? 0);
          const att: BoundingBoxAttachment = { vertices, weights, ...(binds ? { binds } : {}), ...(raw.color ? { color: hex(raw.color) } : {}) };
          (model.boundingBoxes ??= {})[id] = att;
          meta.attachments[id] = { slot, name, raw, sig: boxSig(att), ...(isDefault ? {} : { skin: skinName }) };
        } else {
          if (isDefault) (meta.extraAttachments[slot] ??= {})[name] = raw;
          else (((meta.skinExtraAttachments ??= {})[skinName] ??= {})[slot] ??= {})[name] = raw;
          warnOnce(`type:${type}`, `${type} attachments (e.g. ${where}) are kept for export but not drawn or evaluated`);
        }
      }
    }
  }
  // linked meshes share their source's geometry with their own image
  const linkedDeform = new Map<string, string>();
  for (const l of linked) {
    const srcSkin = l.raw.skin ?? "default";
    // 4.3 names the source mesh "source", older versions "parent"
    const srcName = l.raw.source ?? l.raw.parent;
    const parentId = idIn(srcSkin, l.slot, srcName);
    const parent = parentId ? model.attachments[parentId] : undefined;
    if (!parent) {
      warnings.push(`linked mesh ${l.slot}/${l.name}: source "${srcName}" (skin ${srcSkin}) not found; skipped`);
      idOf.delete(`${l.skin}\u0000${l.slot}\u0000${l.name}`);
      if (l.skin !== "default") delete model.skins[l.skin]?.attachments[l.slot]?.[keyFor(l.slot, l.name)];
      continue;
    }
    const image = useImage(l.raw.path ?? l.raw.name ?? l.name, `${l.slot}/${l.name}`);
    const att: MeshAttachment = { ...structuredClone(parent), ...(image ? { image } : {}) };
    if (l.raw.color) att.color = hex(l.raw.color);
    model.attachments[l.id] = att;
    meta.attachments[l.id] = { slot: l.slot, name: l.name, raw: l.raw, sig: meshSig(att), ...(l.skin === "default" ? {} : { skin: l.skin }) };
    // linked meshes follow their source's deform keys unless they have their own timelines
    if (l.raw.timelines !== false && l.raw.deform !== false) linkedDeform.set(l.id, parentId!);
  }
  if (!Object.keys(model.skins).length) delete model.skins;
  const isExtra = (slot: string, name: string) => !!meta.extraAttachments[slot]?.[name] || Object.values(meta.skinExtraAttachments ?? {}).some((sk) => !!sk[slot]?.[name]);

  // ---- slots
  for (const s of json.slots ?? []) {
    const inSomeSkin = (n: string) => skinList.some((sk) => idIn(sk.name, s.name, n));
    const attachment = s.attachment && inSomeSkin(s.attachment) ? keyFor(s.name, s.attachment) : null;
    if (s.attachment && !attachment && !meta.extraAttachments[s.name]?.[s.attachment]) warnings.push(`slot ${s.name}: setup attachment "${s.attachment}" not found`);
    model.slots.push({
      id: s.name,
      bone: s.bone,
      attachment,
      color: hex(s.color),
      ...(s.blend && s.blend !== "normal" ? { blend: s.blend } : {}),
      ...(s.dark ? { dark: "#" + String(s.dark).toLowerCase().slice(0, 6) } : {}),
    });
    const extra = pick(s, ["name", "bone", "attachment", "color", "dark", "blend"]);
    if (s.attachment && !attachment && meta.extraAttachments[s.name]?.[s.attachment]) extra.attachment = s.attachment;
    if (Object.keys(extra).length) meta.slots[s.name] = extra;
  }

  // ---- constraints: 4.3+ writes one "constraints" array (each with a type, in evaluation order); older versions
  // one array per kind with an "order" field
  let typed: Array<{ type: string; c: Json }>;
  if (Array.isArray(json.constraints)) {
    typed = json.constraints.map((c: Json) => ({ type: String(c.type), c }));
    const other = typed.filter((x) => !["ik", "transform", "path", "physics", "slider"].includes(x.type));
    if (other.length) throw new Error(`unknown constraint type "${other[0].type}" (${other[0].c.name})`);
    meta.constraints.order = typed.map((x) => ({ type: x.type, name: String(x.c.name) }));
  } else {
    typed = [
      ...(json.ik ?? []).map((c: Json) => ({ type: "ik", c })),
      ...(json.transform ?? []).map((c: Json) => ({ type: "transform", c })),
      ...(json.path ?? []).map((c: Json) => ({ type: "path", c })),
      ...(json.physics ?? []).map((c: Json) => ({ type: "physics", c })),
    ].sort((a, b) => (a.c.order ?? 0) - (b.c.order ?? 0));
  }
  meta.constraints.transform = [];
  meta.constraints.path = [];
  meta.constraints.physics = [];
  meta.constraints.raw = {};
  const order: string[] = [];
  for (const { type, c } of typed) {
    const name = String(c.name);
    order.push(`${type}:${name}`);
    let made: unknown;
    if (type === "ik") {
      const ik = {
        id: name,
        bones: c.bones,
        target: c.target,
        mix: c.mix ?? 1,
        bendPositive: c.bendPositive ?? true,
        ...(c.softness ? { softness: c.softness } : {}),
        ...(c.compress ? { compress: true } : {}),
        ...(c.stretch ? { stretch: true } : {}),
        ...(c.scaleY && c.scaleY !== "none" ? { scaleY: c.scaleY } : c.uniform ? { scaleY: "uniform" as const } : {}),
        ...(c.skin ? { skin: true } : {}),
      };
      (model.ik ??= []).push(ik);
      made = ik;
    } else if (type === "transform") made = pushTo((model.transforms ??= []), transformFrom(name, c, version));
    else if (type === "path") made = pushTo((model.paths ??= []), pathFrom(name, c));
    else if (type === "physics") made = pushTo((model.spinePhysics ??= []), physicsFrom(name, c));
    else made = pushTo((model.sliders ??= []), sliderFrom(name, c));
    meta.constraints.raw[`${type}:${name}`] = { type, raw: c, sig: JSON.stringify(made) };
  }
  if (order.length) model.constraintOrder = order;

  // ---- events
  if (json.events && Object.keys(json.events).length) {
    model.events = {};
    for (const [name, e] of Object.entries<Json>(json.events)) {
      const def: EventDef = {};
      for (const k of ["int", "float", "string", "audio", "volume", "balance"] as const) if (e[k] !== undefined) (def as Json)[k] = e[k];
      model.events[name] = def;
    }
  }

  // ---- animations
  for (const [name, raw] of Object.entries<Json>(json.animations ?? {})) {
    const anim: NonNullable<Model["animations"]>[string] = { duration: 0, loop: true, bones: {}, slots: {} };
    const am: SpineMeta["animations"][string] = { extra: {}, deform: {} };
    const added: string[] = [];
    let maxT = 0;
    const seeT = (keys: Json[]) => keys.forEach((k) => (maxT = Math.max(maxT, k.time ?? 0)));
    for (const [bone, tls] of Object.entries<Json>(raw.bones ?? {})) {
      const tl: Json = {};
      const single: Record<string, Json[]> = {};
      // channels whose keys were cut: their Spine timelines as written (exported back while unedited)
      const cut = new Map<string, Record<string, Json[]>>();
      const split = (channel: string, type: string, keys: Json[], fields: string[], defaults: number[]) => {
        if (version.startsWith("3")) return keys;
        const out = splitFlatCurves(keys, fields, defaults);
        if (out.length !== keys.length) cut.set(channel, { ...(cut.get(channel) ?? {}), [type]: keys });
        return out;
      };
      for (const [type, keys] of Object.entries<Json[]>(tls)) {
        seeT(keys);
        if (type === "rotate") tl.rotate = fromSetup(keysFrom(split("rotate", type, keys, [keys.some((k) => k.angle !== undefined) ? "angle" : "value"], [0]), version, (k) => k.value ?? k.angle ?? 0, (v: number) => [v]), 0, `bones/${bone}/rotate`, added);
        else if (type === "translate" || type === "shear") tl[type] = fromSetup(keysFrom(split(type, type, keys, ["x", "y"], [0, 0]), version, (k) => [k.x ?? 0, k.y ?? 0] as Vec2, (v: Vec2) => v), [0, 0] as Vec2, `bones/${bone}/${type}`, added);
        else if (type === "scale") tl.scale = fromSetup(keysFrom(split("scale", type, keys, ["x", "y"], [1, 1]), version, (k) => [k.x ?? 1, k.y ?? 1] as Vec2, (v: Vec2) => v), [1, 1] as Vec2, `bones/${bone}/scale`, added);
        else if (/^(translate|scale|shear)[xy]$/.test(type)) single[type] = split(type.slice(0, -1), type, keys, ["value"], [type.startsWith("scale") ? 1 : 0]);
        else if (type === "inherit") {
          const setupInherit = model.bones.find((b) => b.id === bone)?.inherit ?? "normal";
          tl.inherit = fromSetup(
            keys.map((k) => ({ t: round(k.time ?? 0, 5), v: inheritOf(k.inherit), ease: "stepped" as const })),
            setupInherit,
            `bones/${bone}/inherit`,
            added,
          );
        }
        else {
          ((am.extra.bones ??= {})[bone] ??= {})[type] = keys;
          warnOnce(`bonetl:${type}`, `bone timeline "${type}" is kept for export but not evaluated`);
        }
      }
      // 4.1+ single-axis timelines: one Awaken2D track when both axes have keys at the same times (each axis keeps
      // its own curve), else one track per axis (translateX, ...) so each follows its own curve exactly
      for (const base of ["translate", "scale", "shear"]) {
        const xs = single[base + "x"];
        const ys = single[base + "y"];
        if (!xs && !ys) continue;
        const def = base === "scale" ? 1 : 0;
        const fx = xs ? keysFrom(xs, version, (k) => k.value ?? def, (v: number) => [v]) : [];
        const fy = ys ? keysFrom(ys, version, (k) => k.value ?? def, (v: number) => [v]) : [];
        const sameTimes = !!xs && !!ys && fx.length === fy.length && fx.every((k, i) => k.t === fy[i].t);
        if (!sameTimes) {
          if (xs) tl[base + "X"] = fromSetup(fx, def, `bones/${bone}/${base}X`, added);
          if (ys) tl[base + "Y"] = fromSetup(fy, def, `bones/${bone}/${base}Y`, added);
          continue;
        }
        tl[base] = fromSetup(
          fx.map((k, i) => {
            const ex = (k.ease as Ease | undefined) ?? "linear";
            const ey = (fy[i].ease as Ease | undefined) ?? "linear";
            const e: Ease | Ease[] = JSON.stringify(ex) === JSON.stringify(ey) ? ex : [ex, ey];
            return { t: k.t, v: [k.v, fy[i].v] as Vec2, ...(e !== "linear" ? { ease: e } : {}) };
          }),
          [def, def] as Vec2,
          `bones/${bone}/${base}`,
          added,
        );
        // written back as the two single-axis timelines while unedited
        (am.rawTracks ??= {})[`bones/${bone}/${base}`] = { raw: { [base + "x"]: tls[base + "x"], [base + "y"]: tls[base + "y"] }, sig: JSON.stringify(tl[base]) };
      }
      if (Object.keys(tl).length) anim.bones![bone] = tl;
      for (const [channel, cutRaw] of cut) {
        // the other axis of a split x / y pair is part of the same Awaken2D track
        const rawAll = { ...cutRaw };
        for (const axis of ["x", "y"]) if (tls[channel + axis] && !rawAll[channel + axis]) rawAll[channel + axis] = tls[channel + axis];
        if (tl[channel]) (am.rawTracks ??= {})[`bones/${bone}/${channel}`] = { raw: rawAll, sig: JSON.stringify(tl[channel]) };
        else
          for (const axis of ["X", "Y"]) {
            const ch = channel + axis;
            if (tl[ch] && rawAll[channel + axis.toLowerCase()]) (am.rawTracks ??= {})[`bones/${bone}/${ch}`] = { raw: { [channel + axis.toLowerCase()]: rawAll[channel + axis.toLowerCase()] }, sig: JSON.stringify(tl[ch]) };
          }
      }
    }
    for (const [slot, tls] of Object.entries<Json>(raw.slots ?? {})) {
      const tl: Json = {};
      const setupColor = model.slots.find((s) => s.id === slot)?.color ?? "#ffffffff";
      for (const [type, keys] of Object.entries<Json[]>(tls)) {
        seeT(keys);
        const rgba = (c: string) => [0, 2, 4, 6].map((i) => parseInt(c.slice(i + 1, i + 3), 16) / 255);
        if (type === "rgba" || type === "color") tl.color = fromSetup(keysFrom(keys, version, (k) => hex(k.color), rgba), setupColor, `slots/${slot}/color`, added);
        else if (type === "rgb") tl.color = fromSetup(keysFrom(keys, version, (k) => hex(k.color + setupColor.slice(7, 9)), rgba), setupColor, `slots/${slot}/color`, added);
        else if (type === "alpha") {
          tl.color = fromSetup(
            keysFrom(
              keys,
              version,
              (k) => setupColor.slice(0, 7) + Math.round((k.value ?? 1) * 255).toString(16).padStart(2, "0"),
              (c: string) => [parseInt(c.slice(7, 9), 16) / 255],
            ),
            setupColor,
            `slots/${slot}/color`,
            added,
          );
        } else if (type === "attachment") {
          const setupAtt = model.slots.find((x) => x.id === slot)?.attachment ?? null;
          tl.attachment = fromSetup(
            // names of attachments Awaken2D does not draw (clipping, ...) stay as placeholders: nothing drawn, name kept
            keys.map((k) => ({ t: round(k.time ?? 0, 5), v: !k.name ? null : skinList.some((sk) => idIn(sk.name, slot, k.name)) ? keyFor(slot, k.name) : isExtra(slot, k.name) ? k.name : null })),
            setupAtt,
            `slots/${slot}/attachment`,
            added,
          );
          for (const k of keys) if (k.name && !skinList.some((sk) => idIn(sk.name, slot, k.name)) && !isExtra(slot, k.name)) warnings.push(`${name}: slot ${slot} switches to "${k.name}", which is not a drawable attachment of any skin`);
        } else if (type === "rgba2" || type === "rgb2") {
          // two-color tint: light color (rgba or rgb) and dark color keyed together; the curves list the light
          // channels first, then the dark r, g, b
          const n = type === "rgba2" ? 4 : 3;
          const part = (from: number, to?: number) => keys.map((k) => (Array.isArray(k.curve) ? { ...k, curve: k.curve.slice(from, to) } : k));
          tl.color = fromSetup(keysFrom(part(0, n * 4), version, (k) => hex(n === 4 ? k.light : k.light + setupColor.slice(7, 9)), rgba), setupColor, `slots/${slot}/color`, added);
          const setupDark = model.slots.find((s) => s.id === slot)?.dark ?? "#000000";
          tl.dark = fromSetup(keysFrom(part(n * 4), version, (k) => "#" + String(k.dark ?? "000000").toLowerCase().slice(0, 6), (c: string) => rgba(c + "ff").slice(0, 3)), setupDark, `slots/${slot}/dark`, added);
          (am.rawTracks ??= {})[`slots/${slot}/twoColor`] = { raw: { [type]: keys }, sig: JSON.stringify([tl.color, tl.dark]) };
        } else {
          ((am.extra.slots ??= {})[slot] ??= {})[type] = keys;
          warnOnce(`slottl:${type}`, `slot timeline "${type}" (sequence) is kept for export but not evaluated`);
        }
      }
      if (Object.keys(tl).length) anim.slots![slot] = tl;
    }
    // deform: 4.2 animations.attachments.<skin>.<slot>.<attachment>.deform; older: animations.deform.<skin>...
    const deformRoot: Json = raw.attachments ?? raw.deform ?? {};
    for (const [skin, slots] of Object.entries<Json>(deformRoot)) {
      for (const [slot, atts] of Object.entries<Json>(slots)) {
        for (const [attName, entry] of Object.entries<Json>(atts)) {
          const keys: Json[] = raw.attachments ? entry.deform : entry;
          const other = raw.attachments ? pick(entry, ["deform"]) : {};
          if (Object.keys(other).length) (((am.extra.attachments ??= {})[skin] ??= {})[slot] ??= {})[attName] = other;
          if (!keys) continue;
          seeT(keys);
          const id = idIn(skin, slot, attName);
          if (!id) {
            if (raw.attachments) ((((am.extra.attachments ??= {})[skin] ??= {})[slot] ??= {})[attName] ??= {}).deform = keys;
            else (((am.extra.deform ??= {})[skin] ??= {})[slot] ??= {})[attName] = keys;
            continue;
          }
          const att = model.attachments[id] ?? model.pathAttachments?.[id] ?? model.clippings?.[id] ?? model.boundingBoxes![id];
          const src = meta.attachments[id].raw;
          // linked meshes deform with their source's vertex layout
          const layout = src.type === "linkedmesh" ? (meta.attachments[idIn(src.skin ?? "default", slot, src.source ?? src.parent) ?? ""]?.raw ?? src) : src;
          const polygon = layout.type === "path" || layout.type === "clipping" || layout.type === "boundingbox";
          const nVerts = polygon ? layout.vertexCount : (layout.uvs?.length ?? 0) / 2;
          const weighted = (layout.type === "mesh" || polygon) && layout.vertices.length !== nVerts * 2;
          const toSetup = (k: Json): VertexOffsets => {
            const flat: number[] = k.vertices ?? [];
            const off = k.offset ?? 0;
            const local = (i: number) => (i >= off && i < off + flat.length ? flat[i - off] : 0);
            const out: VertexOffsets = [];
            if (!weighted) {
              const bone = slotBone.get(slot)!;
              att.vertices.forEach((_, v) => {
                const d = linear(bone, local(v * 2), local(v * 2 + 1));
                if (Math.abs(d[0]) > 1e-6 || Math.abs(d[1]) > 1e-6) out.push([v, round(d[0], 4), round(d[1], 4)]);
              });
              return out;
            }
            let i = 0;
            let f = 0; // index into the per-influence delta list
            for (let v = 0; v < att.vertices.length; v++) {
              const count = layout.vertices[i++];
              let dx = 0;
              let dy = 0;
              for (let c = 0; c < count; c++) {
                const bone = boneAt(layout.vertices[i]);
                const wgt = layout.vertices[i + 3];
                i += 4;
                const d = linear(bone, local(f), local(f + 1));
                f += 2;
                dx += d[0] * wgt;
                dy += d[1] * wgt;
              }
              if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) out.push([v, round(dx, 4), round(dy, 4)]);
            }
            return out;
          };
          const converted = keysFrom(keys, version, (k) => toSetup(k), () => [0]).map((k, i) => {
            // deform curves run from 0 to 1 whatever the offsets: convert against that
            let curve = keys[i].curve;
            if (typeof curve === "number") curve = [curve, keys[i].c2 ?? 0, keys[i].c3 ?? 1, keys[i].c4 ?? 1];
            const next = keys[i + 1];
            const ease = next ? curveEase(curve, keys[i].time ?? 0, next.time ?? 0, [0], [1], version) : curve === "stepped" ? "stepped" : undefined;
            const { ease: _, ...rest } = k;
            // keep Spine's own per-influence deltas too: skinning uses them for an exact match
            const local = { offset: keys[i].offset ?? 0, values: keys[i].vertices ?? [] };
            return ease ? { ...rest, ease, local } : { ...rest, local };
          });
          const withSetup = converted.length && converted[0].t > 0 ? [{ t: 0, v: [] as VertexOffsets, ease: "stepped" as const, local: { offset: 0, values: [] } }, ...converted] : converted;
          if (withSetup !== converted) added.push(`deform/${id}`);
          (anim.deform ??= {})[id] = withSetup;
          am.deform[id] = { skin, slot, name: attName, raw: keys, sig: JSON.stringify(withSetup) };
        }
      }
    }
    const tracks: NonNullable<SpineMeta["animations"][string]["constraintTracks"]> = {};
    for (const [ikName, keys] of Object.entries<Json[]>(raw.ik ?? {})) {
      seeT(keys);
      const ikSetup = model.ik?.find((c) => c.id === ikName);
      const tl: NonNullable<NonNullable<typeof anim.ik>[string]> = {
        mix: fromSetup(channelKeys(keys, version, "mix", 1, 0), ikSetup?.mix ?? 1),
        bendPositive: fromSetup(stepKeys(keys, (k) => k.bendPositive ?? true), ikSetup?.bendPositive ?? true),
      };
      if (keys.some((k) => k.softness)) tl.softness = fromSetup(channelKeys(keys, version, "softness", 0, 1), ikSetup?.softness ?? 0);
      if (keys.some((k) => k.compress)) tl.compress = fromSetup(stepKeys(keys, (k) => !!k.compress), !!ikSetup?.compress);
      if (keys.some((k) => k.stretch)) tl.stretch = fromSetup(stepKeys(keys, (k) => !!k.stretch), !!ikSetup?.stretch);
      (anim.ik ??= {})[ikName] = tl;
      tracks[`ik/${ikName}`] = { raw: keys, sig: JSON.stringify(tl) };
    }
    for (const [cName, keys] of Object.entries<Json[]>(raw.transform ?? {})) {
      seeT(keys);
      const c = model.transforms?.find((x) => x.id === cName);
      const tl: Json = {};
      // Spine's defaults: a missing mix is 1, mixY follows mixX and mixScaleY follows mixScaleX
      const fields: Array<[TransformProperty, string, (k: Json) => number]> = [
        ["rotate", "mixRotate", (k) => k.mixRotate ?? 1],
        ["x", "mixX", (k) => k.mixX ?? 1],
        ["y", "mixY", (k) => k.mixY ?? k.mixX ?? 1],
        ["scaleX", "mixScaleX", (k) => k.mixScaleX ?? 1],
        ["scaleY", "mixScaleY", (k) => k.mixScaleY ?? 1],
        ["shearY", "mixShearY", (k) => k.mixShearY ?? 1],
      ];
      fields.forEach(([prop, , value], ch) => (tl[prop] = fromSetup(channelKeysBy(keys, version, value, ch), c?.mix[prop] ?? 0)));
      (anim.transforms ??= {})[cName] = tl;
      tracks[`transform/${cName}`] = { raw: keys, sig: JSON.stringify(tl) };
    }
    for (const [cName, groups] of Object.entries<Json>(raw.path ?? {})) {
      const c = model.paths?.find((x) => x.id === cName);
      const tl: Json = {};
      for (const [group, keys] of Object.entries<Json[]>(groups)) {
        seeT(keys);
        if (group === "position") tl.position = fromSetup(channelKeys(keys, version, "value", 0, 0), c?.position ?? 0);
        else if (group === "spacing") tl.spacing = fromSetup(channelKeys(keys, version, "value", 0, 0), c?.spacing ?? 0);
        else if (group === "mix") {
          tl.rotate = fromSetup(channelKeysBy(keys, version, (k) => k.mixRotate ?? 1, 0), c?.mix.rotate ?? 1);
          tl.x = fromSetup(channelKeysBy(keys, version, (k) => k.mixX ?? 1, 1), c?.mix.x ?? 1);
          tl.y = fromSetup(channelKeysBy(keys, version, (k) => k.mixY ?? k.mixX ?? 1, 2), c?.mix.y ?? 1);
        }
      }
      (anim.paths ??= {})[cName] = tl;
      tracks[`path/${cName}`] = { raw: groups, sig: JSON.stringify(tl) };
    }
    for (const [cName, groups] of Object.entries<Json>(raw.physics ?? {})) {
      const c = model.spinePhysics?.find((x) => x.id === cName);
      const tl: Json = {};
      for (const [group, keys] of Object.entries<Json[]>(groups)) {
        seeT(keys);
        if (group === "reset") tl.reset = keys.map((k) => round(k.time ?? 0, 5));
        else if (["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"].includes(group)) {
          const setupValue = c ? c[group as SpinePhysicsSetting] : group === "mix" ? 1 : 0;
          tl[group] = fromSetup(channelKeys(keys, version, "value", group === "mix" ? 1 : 0, 0), setupValue);
        }
      }
      (anim.spinePhysics ??= {})[cName] = tl;
      tracks[`physics/${cName}`] = { raw: groups, sig: JSON.stringify(tl) };
    }
    for (const [cName, groups] of Object.entries<Json>(raw.slider ?? {})) {
      const c = model.sliders?.find((x) => x.id === cName);
      const tl: Json = {};
      for (const [group, keys] of Object.entries<Json[]>(groups)) {
        seeT(keys);
        if (group === "time") tl.time = fromSetup(channelKeys(keys, version, "value", 1, 0), c?.time ?? 0);
        else if (group === "mix") tl.mix = fromSetup(channelKeys(keys, version, "value", 1, 0), c?.mix ?? 1);
      }
      (anim.sliders ??= {})[cName] = tl;
      tracks[`slider/${cName}`] = { raw: groups, sig: JSON.stringify(tl) };
    }
    if (Object.keys(tracks).length) am.constraintTracks = tracks;
    const drawOrder: Json[] = raw.drawOrder ?? raw.draworder ?? [];
    if (drawOrder.length) {
      seeT(drawOrder);
      anim.drawOrder = drawOrder.map((k) => ({ t: round(k.time ?? 0, 5), offsets: (k.offsets ?? []).map((o: Json) => [o.slot, o.offset] as [string, number]) }));
    }
    for (const [lid, sid] of linkedDeform) if (anim.deform?.[sid] && !anim.deform[lid]) anim.deform[lid] = anim.deform[sid];
    if (raw.events?.length) {
      seeT(raw.events);
      anim.events = raw.events.map((e: Json) => {
        const key: EventKey = { t: round(e.time ?? 0, 5), name: e.name };
        for (const k of ["int", "float", "string", "volume", "balance"] as const) if (e[k] !== undefined) (key as Json)[k] = e[k];
        return key;
      });
    }
    // every other timeline group (sequence, ...) is kept as written
    for (const k of Object.keys(raw)) {
      if (["bones", "slots", "attachments", "deform", "ik", "transform", "path", "physics", "slider", "drawOrder", "draworder", "events"].includes(k)) continue;
      am.extra[k] = raw[k];
      warnOnce(`animtl:${k}`, `${k} timelines are kept for export but not evaluated`);
    }
    anim.duration = round(Math.max(maxT, 1 / 30), 5);
    if (!Object.keys(anim.bones!).length) delete anim.bones;
    if (!Object.keys(anim.slots!).length) delete anim.slots;
    model.animations![name] = anim;
    if (added.length) am.setupKeys = added;
    if (Object.keys(am.extra).length || Object.keys(am.deform).length || added.length || am.rawTracks || am.constraintTracks) meta.animations[name] = am;
    log.push(`animation ${name}: ${anim.duration}s`);
  }

  // polygon-packed atlases put other images inside a mesh's rectangle: keep only what the mesh covers
  const masked = maskMeshImages(model, images);
  if (masked) log.push(`${masked} mesh image(s) cleared outside their mesh (polygon-packed atlas)`);

  model.meta = { spine: meta };
  log.unshift(
    `Spine ${version}: ${model.bones.length} bones, ${model.slots.length} slots, ${Object.keys(model.attachments).length} attachments, ${images.size} images, ${Object.keys(model.animations ?? {}).length} animations`,
  );
  return { model, images, log, warnings };
}

/**
 * Turns region attachments (quads over their image) into automatic meshes traced around the art (core/meshplan.ts:
 * settings from the image and the attachment name). Opt-in: the export then writes them as meshes, not regions.
 * Regions showing an image sequence stay regions. Returns a log line per changed attachment.
 */
export function meshSpineRegions(model: Model, images: Map<string, RGBAImage>, opts: { density?: number } = {}): string[] {
  const meta = (model.meta as { spine?: SpineMeta } | undefined)?.spine;
  const log: string[] = [];
  for (const [id, att] of Object.entries(model.attachments)) {
    const m = meta?.attachments[id];
    if (!m || (m.raw.type ?? "region") !== "region" || m.raw.sequence || !att.image || !att.uvs) continue;
    const img = images.get(att.image);
    if (!img) continue;
    let made;
    try {
      made = meshAutoPlan(att, img.data, img.width, img.height, { name: m.name, groups: [m.slot], target: "spine", density: opts.density });
    } catch {
      continue; // no art above the threshold: the quad stays
    }
    const bone = att.weights[0];
    // a new object (attachments are shared between model versions): the export sees the change by its signature
    model.attachments[id] = { ...att, ...made.geometry, weights: made.geometry.vertices.map(() => bone.map(([b, w]) => [b, w] as [string, number])) };
    log.push(`${id}: ${describePlan(made.plan)}`);
  }
  return log;
}

/**
 * Clears the pixels of each image that no mesh using it covers (its triangles in UV space, grown by 2 px), for
 * images used only by meshes with real outlines (not by region quads). Returns how many images changed.
 */
function maskMeshImages(model: Model, images: Map<string, RGBAImage>): number {
  const users = new Map<string, MeshAttachment[]>();
  for (const a of Object.values(model.attachments)) if (a.image) users.set(a.image, [...(users.get(a.image) ?? []), a]);
  let changed = 0;
  for (const [path, img] of images) {
    const atts = users.get(path) ?? [];
    // region quads (4 vertices, 2 triangles over the whole image) show the whole rectangle
    if (!atts.length || atts.some((a) => !a.uvs || (a.vertices.length === 4 && a.uvs.every(([u, v]) => (u === 0 || u === 1) && (v === 0 || v === 1))))) continue;
    const { width: w, height: h } = img;
    const keep = new Uint8Array(w * h);
    for (const a of atts) {
      for (const [i, j, k] of a.triangles) {
        const uv = a.uvs!;
        const p = [uv[i], uv[j], uv[k]].map(([u, v]) => [u * w, v * h]);
        const x0 = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0]) - 3));
        const x1 = Math.min(w - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0]) + 3));
        const y0 = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1]) - 3));
        const y1 = Math.min(h - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1]) + 3));
        const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
        if (Math.abs(area) < 1e-9) continue;
        // pixel centers inside the triangle grown by 2 px (signed distance to each edge)
        const edges = [0, 1, 2].map((e) => {
          const [ax, ay] = p[e];
          const [bx, by] = p[(e + 1) % 3];
          const len = Math.hypot(bx - ax, by - ay) || 1;
          const s = area > 0 ? 1 : -1;
          return { ax, ay, nx: (s * -(by - ay)) / len, ny: (s * (bx - ax)) / len };
        });
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const cx = x + 0.5;
            const cy = y + 0.5;
            if (edges.every((e) => (cx - e.ax) * e.nx + (cy - e.ay) * e.ny >= -2)) keep[y * w + x] = 1;
          }
        }
      }
    }
    let cleared = 0;
    for (let q = 0; q < w * h; q++) {
      if (keep[q] || img.data[q * 4 + 3] === 0) continue;
      img.data[q * 4 + 3] = 0;
      cleared++;
    }
    if (cleared) changed++;
  }
  return changed;
}

/**
 * Spine leaves the setup value in place before a timeline's first key (then jumps to it); Awaken2D would hold the
 * first key's value. A stepped setup key at 0 keeps Spine's behaviour. The exporter drops it again.
 */
function fromSetup<T>(keys: Key<T>[], setup: T, track?: string, added?: string[]): Key<T>[] {
  if (!(keys.length && keys[0].t > 0)) return keys;
  if (track && added) added.push(track);
  return [{ t: 0, v: setup, ease: "stepped" }, ...keys];
}

/** Linear-with-ease sample of numeric keys (used to merge split x/y timelines). */
function sampleKeys(keys: Key<number>[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (a.ease === "stepped") return a.v;
  return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1));
}

/** Signature of a bounding box attachment (edited since import or not). */
export const boxSig = (a: BoundingBoxAttachment) => JSON.stringify([a.vertices, a.weights, a.color ?? null, a.binds ?? null]);

/** Signature of a clipping attachment (edited since import or not). */
export const clipSig = (a: ClippingAttachment) => JSON.stringify([a.vertices, a.weights, a.end ?? null, !!a.convex, !!a.inverse, a.color ?? null, a.binds ?? null]);

/** Signature of a path attachment's geometry (edited since import or not). */
export const pathSig = (a: PathAttachment) => JSON.stringify([a.vertices, a.weights, a.closed ?? false, a.constantSpeed ?? true, a.lengths, a.binds ?? null]);

function inheritOf(v: unknown): Inherit {
  const s = String(v ?? "normal");
  const m: Record<string, Inherit> = { normal: "normal", onlytranslation: "onlyTranslation", norotationorreflection: "noRotationOrReflection", noscale: "noScale", noscaleorreflection: "noScaleOrReflection" };
  return m[s.toLowerCase()] ?? "normal";
}

function pushTo<T>(list: T[], item: T): T {
  list.push(item);
  return item;
}

/** One numeric channel of Spine keys (curve channel `ch` of multi-value keys). */
function channelKeys(keys: Json[], version: string, field: string, def: number, ch: number): Key<number>[] {
  return channelKeysBy(keys, version, (k) => k[field] ?? def, ch);
}

function channelKeysBy(keys: Json[], version: string, value: (k: Json) => number, ch: number): Key<number>[] {
  return keys.map((k, i) => {
    const key: Key<number> = { t: round(k.time ?? 0, 5), v: value(k) };
    const next = keys[i + 1];
    let curve = k.curve;
    if (typeof curve === "number") curve = [curve, k.c2 ?? 0, k.c3 ?? 1, k.c4 ?? 1];
    if (next) {
      const c = Array.isArray(curve) && !version.startsWith("3") ? curve.slice(ch * 4, ch * 4 + 4) : curve;
      const ease = curveEase(Array.isArray(c) && !c.length ? undefined : c, k.time ?? 0, next.time ?? 0, [value(k)], [value(next)], version);
      if (ease) key.ease = ease;
    } else if (curve === "stepped") key.ease = "stepped";
    return key;
  });
}

function stepKeys<T>(keys: Json[], value: (k: Json) => T): Key<T>[] {
  return keys.map((k) => ({ t: round(k.time ?? 0, 5), v: value(k), ease: "stepped" as const }));
}

function transformFrom(id: string, c: Json, version: string): TransformConstraint {
  const out: TransformConstraint = { id, bones: [...(c.bones ?? [])], source: c.source ?? c.target, properties: [], mix: {} };
  if (c.localSource || c.local) out.localSource = true;
  if (c.localTarget || c.local) out.localTarget = true;
  if (c.additive || c.relative) out.additive = true;
  if (c.clamp) out.clamp = true;
  const offset: Partial<Record<TransformProperty, number>> = {};
  for (const [k, p] of [["rotation", "rotate"], ["x", "x"], ["y", "y"], ["scaleX", "scaleX"], ["scaleY", "scaleY"], ["shearY", "shearY"]] as const) if (c[k]) offset[p] = c[k];
  const written = new Set<TransformProperty>();
  if (c.properties) {
    // 4.3: from property -> to properties
    for (const [from, fe] of Object.entries<Json>(c.properties)) {
      const to = Object.entries<Json>(fe.to ?? {}).map(([prop, te]) => {
        written.add(prop as TransformProperty);
        return { property: prop as TransformProperty, ...(te.offset ? { offset: te.offset } : {}), ...(te.max !== undefined && te.max !== 1 ? { max: te.max } : {}), ...(te.scale !== undefined && te.scale !== 1 ? { scale: te.scale } : {}) };
      });
      if (to.length) out.properties.push({ from: from as TransformProperty, ...(fe.offset ? { offset: fe.offset } : {}), to });
    }
    if (Object.keys(offset).length) out.offset = offset;
    if (written.has("rotate")) out.mix.rotate = c.mixRotate ?? 1;
    if (written.has("x")) out.mix.x = c.mixX ?? 1;
    if (written.has("y")) out.mix.y = c.mixY ?? out.mix.x ?? 1;
    if (written.has("scaleX")) out.mix.scaleX = c.mixScaleX ?? 1;
    if (written.has("scaleY")) out.mix.scaleY = c.mixScaleY ?? out.mix.scaleX ?? 1;
    if (written.has("shearY")) out.mix.shearY = c.mixShearY ?? 1;
    return out;
  }
  // 4.0 - 4.2: each property copies itself, the offsets added to the source's values
  for (const p of ["rotate", "x", "y", "scaleX", "scaleY", "shearY"] as const) {
    out.properties.push({ from: p, to: [{ property: p }] });
  }
  void version;
  if (Object.keys(offset).length) out.offset = offset;
  out.mix = {
    rotate: c.mixRotate ?? c.rotateMix ?? 1,
    x: c.mixX ?? c.translateMix ?? 1,
    y: c.mixY ?? c.mixX ?? c.translateMix ?? 1,
    scaleX: c.mixScaleX ?? c.scaleMix ?? 1,
    scaleY: c.mixScaleY ?? c.mixScaleX ?? c.scaleMix ?? 1,
    shearY: c.mixShearY ?? c.shearMix ?? 1,
  };
  return out;
}

function pathFrom(id: string, c: Json): PathConstraint {
  const lower = (v: unknown, def: string) => {
    const s = String(v ?? def);
    return s[0].toLowerCase() + s.slice(1);
  };
  return {
    id,
    bones: [...(c.bones ?? [])],
    slot: c.slot,
    positionMode: lower(c.positionMode, "percent") as PathConstraint["positionMode"],
    spacingMode: lower(c.spacingMode, "length") as PathConstraint["spacingMode"],
    rotateMode: lower(c.rotateMode, "tangent") as PathConstraint["rotateMode"],
    ...(c.rotation ? { rotation: c.rotation } : {}),
    position: c.position ?? 0,
    spacing: c.spacing ?? 0,
    mix: { rotate: c.mixRotate ?? c.rotateMix ?? 1, x: c.mixX ?? c.translateMix ?? 1, y: c.mixY ?? c.mixX ?? c.translateMix ?? 1 },
    ...(c.skin ? { skin: true } : {}),
  };
}

function physicsFrom(id: string, c: Json): SpinePhysics {
  const global = (["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"] as const).filter((k) => c[`${k}Global`]);
  return {
    id,
    bone: c.bone,
    ...(c.x ? { x: c.x } : {}),
    ...(c.y ? { y: c.y } : {}),
    ...(c.rotate ? { rotate: c.rotate } : {}),
    ...(c.scaleX ? { scaleX: c.scaleX } : {}),
    ...(c.shearX ? { shearX: c.shearX } : {}),
    ...(c.scaleY && String(c.scaleY).toLowerCase() !== "none" ? { scaleY: String(c.scaleY).toLowerCase() as "uniform" | "volume" } : {}),
    ...(c.limit !== undefined ? { limit: c.limit } : {}),
    ...(c.fps !== undefined ? { fps: c.fps } : {}),
    inertia: c.inertia ?? 0.5,
    strength: c.strength ?? 100,
    damping: c.damping ?? 0.85,
    mass: c.mass ?? 1,
    wind: c.wind ?? 0,
    gravity: c.gravity ?? 0,
    mix: c.mix ?? 1,
    ...(global.length ? { global: [...global] } : {}),
    ...(c.skin ? { skin: true } : {}),
  };
}

function sliderFrom(id: string, c: Json): Slider {
  return {
    id,
    animation: c.animation,
    time: c.time ?? 0,
    mix: c.mix ?? 1,
    ...(c.additive ? { additive: true } : {}),
    ...(c.loop ? { loop: true } : {}),
    ...(c.bone
      ? {
          bone: c.bone,
          property: (c.property ?? "rotate") as TransformProperty,
          ...(c.local ? { local: true } : {}),
          ...(c.from ? { from: c.from } : {}),
          ...(c.to ? { to: c.to } : {}),
          ...(c.scale !== undefined ? { scale: c.scale } : {}),
          ...(c.max ? { max: c.max } : {}),
        }
      : {}),
    ...(c.skin ? { skin: true } : {}),
  };
}
