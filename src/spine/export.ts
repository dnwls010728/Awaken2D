// Awaken2D model -> Spine skeleton JSON (4.x) + atlas. Data that came from Spine and was not edited is written
// back verbatim (attachments, constraints, deform and constraint keys, extra timelines kept in meta.spine);
// everything else is converted: setup-space meshes and paths to bone-local (or weighted per-bone) vertices with the
// hull first, Awaken2D eases to Spine's absolute bezier handles, setup-space deform offsets to Spine's per-bone
// deltas, skins, constraints (one "constraints" array from Spine 4.3, per-kind arrays before) and their timelines.
import { computePose, constraintList, drawList, invert, isChannelEases, parseColor, round, sampleTrack } from "../core/index.ts";
import type { Ease, Key, MeshAttachment, Model, PathAttachment, TransformProperty, Vec2, VertexOffsets } from "../core/index.ts";
import type { RGBAImage } from "../render/png.ts";
import { packAtlas, writeAtlas } from "./atlas.ts";
import { boxSig, clipSig, meshSig, pathSig } from "./import.ts";
import type { SpineMeta } from "./import.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface SpineExportOptions {
  /** Base name of the atlas page / atlas file. */
  name: string;
  /** PNG pixels of a model image id (for packing the atlas and writing the images folder). */
  loadImage: (id: string) => RGBAImage | null;
  /** Spine version written in the skeleton header when the model did not come from Spine. Default 4.2.43. */
  version?: string;
}

export interface SpineExportResult {
  json: Json;
  atlas: string;
  page: RGBAImage;
  /** Images by region name (write them as images/<name>.png for the Spine editor's "Import Data"). */
  images: Map<string, RGBAImage>;
  warnings: string[];
}

const NAMED: Record<string, [number, number, number, number]> = { easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1] };
const r5 = (n: number) => round(n, 5);
const hex8 = (c: string) => {
  const v = c.replace(/^#/, "").toLowerCase();
  return v.length === 6 ? v + "ff" : v;
};

/** Spine 4 curve for a key (towards the next key): absolute bezier handles for each value channel. */
function curveOf(ease: Ease | Ease[] | undefined, t0: number, t1: number, v0: number[], v1: number[]): Json {
  const per = isChannelEases(ease) ? ease : null;
  const eases = v0.map((_, c) => (per ? per[Math.min(c, per.length - 1)] : (ease as Ease | undefined)));
  if (eases.every((e) => !e || e === "linear")) return undefined;
  if (eases.every((e) => e === "stepped")) return "stepped";
  const dt = t1 - t0;
  const out: number[] = [];
  v0.forEach((a, c) => {
    const e = eases[c];
    // a stepped channel among curved ones: hold, then jump at the very end
    const b = !e || e === "linear" ? [1 / 3, 1 / 3, 2 / 3, 2 / 3] : e === "stepped" ? [1, 0, 1, 0] : typeof e === "string" ? NAMED[e] : e;
    out.push(r5(t0 + b[0] * dt), r5(a + b[1] * (v1[c] - a)), r5(t0 + b[2] * dt), r5(a + b[3] * (v1[c] - a)));
  });
  return out;
}

/** Spine keys from Awaken2D keys: `fields` writes a key's values (omitting defaults), `channels` gives numbers. */
function spineKeys<T>(keys: Key<T>[], fields: (v: T) => Json, channels: (v: T) => number[]): Json[] {
  return keys.map((k, i) => {
    const out: Json = {};
    if (k.t) out.time = r5(k.t);
    Object.assign(out, fields(k.v));
    const next = keys[i + 1];
    const curve = next ? curveOf(k.ease, k.t, next.t, channels(k.v), channels(next.v)) : k.ease === "stepped" ? "stepped" : undefined;
    if (curve !== undefined) out.curve = curve;
    return out;
  });
}

/** Drops the stepped setup key at 0 the importer adds (Spine holds the setup value before a first key anyway). */
function trimSetup<T>(keys: Key<T>[], setup: T, added: boolean): Key<T>[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return added && keys.length > 1 && keys[0].t === 0 && keys[0].ease === "stepped" && keys[1].t > 0 && same(keys[0].v, setup) ? keys.slice(1) : keys;
}

/** Vertex order with the longest boundary loop first (Spine's hull), plus that loop's edge list. */
function hullOrder(att: MeshAttachment): { order: number[]; hull: number; edges: number[] } {
  const count = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const t of att.triangles) for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) count.set(key(a, b), (count.get(key(a, b)) ?? 0) + 1);
  const next = new Map<number, number[]>();
  for (const [k, c] of count) {
    if (c !== 1) continue;
    const [a, b] = k.split(",").map(Number);
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }
  const seen = new Set<number>();
  let best: number[] = [];
  for (const start of [...next.keys()].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    let prev = -1;
    let cur = start;
    for (;;) {
      const n = (next.get(cur) ?? []).find((v) => v !== prev && !seen.has(v));
      if (n === undefined) break;
      loop.push(n);
      seen.add(n);
      prev = cur;
      cur = n;
    }
    if (loop.length > best.length) best = loop;
  }
  const inHull = new Set(best);
  const order = [...best, ...att.vertices.map((_, i) => i).filter((i) => !inHull.has(i))];
  const edges: number[] = [];
  for (let i = 0; i < best.length; i++) edges.push(i * 2, ((i + 1) % best.length) * 2);
  return { order, hull: best.length, edges };
}

export function exportSpineData(input: Model, opts: SpineExportOptions): SpineExportResult {
  const warnings: string[] = [];
  const { model, loadImage } = cropSharedImages(input, opts.loadImage);
  opts = { ...opts, loadImage };
  const meta = (model.meta?.spine ?? null) as SpineMeta | null;
  const setup = computePose(model);
  const boneIndex = new Map<string, number>();
  const order = setup.bones.map((b) => b.id);
  order.forEach((id, i) => boneIndex.set(id, i));
  const worldOf = (bone: string) => setup.byId.get(bone)!.world;
  const inv = new Map(order.map((id) => [id, invert(worldOf(id))]));
  const toLocal = (bone: string, p: Vec2): Vec2 => {
    const m = inv.get(bone)!;
    return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  };
  const linearLocal = (bone: string, d: Vec2): Vec2 => {
    const m = inv.get(bone)!;
    return [m[0] * d[0] + m[2] * d[1], m[1] * d[0] + m[3] * d[1]];
  };
  const bonesUnchanged = (bones: string[]) =>
    !!meta && bones.every((b) => meta.setupWorld?.[b] && worldOf(b).every((v, i) => Math.abs(v - meta.setupWorld[b][i]) < 1e-4));

  if (model.parameters?.length) warnings.push("parameters are Live2D features with no Spine equivalent: not exported");
  if (model.slots.some((s) => s.clip)) warnings.push("slot clip masks are not exported (Spine uses clipping attachments)");

  // ---- skeleton header, bones, slots
  const items = drawList(model, setup, setup);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) for (const [x, y] of it.positions) (minX = Math.min(minX, x)), (minY = Math.min(minY, y)), (maxX = Math.max(maxX, x)), (maxY = Math.max(maxY, y));
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
  const json: Json = {
    skeleton: {
      ...(meta?.skeleton ?? {}),
      ...(meta?.skeleton?.hash ? {} : { hash: Math.random().toString(36).slice(2, 13) }),
      spine: meta && !meta.version.startsWith("3") ? meta.version : (opts.version ?? "4.2.43"),
      x: r5(minX),
      y: r5(minY),
      width: r5(maxX - minX),
      height: r5(maxY - minY),
      images: meta?.skeleton?.images ?? "./images/",
      audio: meta?.skeleton && "audio" in meta.skeleton ? meta.skeleton.audio : "./audio",
    },
    bones: order.map((id) => {
      const b = model.bones.find((x) => x.id === id)!;
      const o: Json = { name: id };
      if (b.parent) o.parent = b.parent;
      if (b.length) o.length = r5(b.length);
      if (b.rotation) o.rotation = r5(b.rotation);
      if (b.x) o.x = r5(b.x);
      if (b.y) o.y = r5(b.y);
      if (b.scaleX !== 1) o.scaleX = r5(b.scaleX);
      if (b.scaleY !== 1) o.scaleY = r5(b.scaleY);
      if (b.shearX) o.shearX = r5(b.shearX);
      if (b.shearY) o.shearY = r5(b.shearY);
      if (b.inherit && b.inherit !== "normal") o.inherit = b.inherit;
      if (b.skin) o.skin = true;
      const out = { ...o, ...(meta?.bones?.[id] ?? {}) };
      if (b.color) out.color = hex8(b.color);
      else delete out.color;
      if (b.icon) out.icon = b.icon;
      else delete out.icon;
      return out;
    }),
  };

  // ---- attachments. Skin attachments are the ones model.skins map to; every other attachment used by a slot
  // (setup, keys, imported for it) is in the default skin. Slots and keys hold attachment keys: a default
  // attachment id, or a placeholder name the skins map.
  const inSkin = new Map<string, { skin: string; slot: string; key: string }>();
  for (const [skin, sk] of Object.entries(model.skins ?? {})) for (const [slot, m] of Object.entries(sk.attachments)) for (const [key, id] of Object.entries(m)) inSkin.set(id, { skin, slot, key });
  const isAttachment = (id: string) => !!model.attachments[id] || !!model.pathAttachments?.[id] || !!model.clippings?.[id] || !!model.boundingBoxes?.[id];
  const perSlot = new Map<string, Set<string>>(model.slots.map((s) => [s.id, new Set<string>()]));
  const use = (slot: string, key: string | null | undefined) => {
    if (key && perSlot.has(slot) && isAttachment(key) && !inSkin.has(key)) perSlot.get(slot)!.add(key);
  };
  for (const s of model.slots) use(s.id, s.attachment);
  for (const a of Object.values(model.animations ?? {})) {
    for (const [slot, tl] of Object.entries(a.slots ?? {})) for (const k of tl.attachment ?? []) use(slot, k.v);
  }
  for (const [id, m] of Object.entries(meta?.attachments ?? {})) if (!m.skin && !inSkin.has(id)) use(m.slot, id);

  /** Spine name of attachment id in a slot (default skin). */
  const names = new Map<string, string>(); // "slot\0id" -> name
  const nameIn = (slot: string, id: string) => names.get(`${slot}\u0000${id}`);
  /** Spine name (placeholder) of an attachment key in a slot. */
  const keyName = (slot: string, key: string) => nameIn(slot, key) ?? (inSkin.has(key) || isAttachment(key) ? undefined : key);
  const usedImages = new Set<string>();
  /** How each exported mesh's vertices map to Awaken2D's (for deform keys): exported index -> Awaken2D index. */
  const vertexOrder = new Map<string, { order: number[]; weighted: boolean; raw: boolean }>();
  const skinAttachments: Json = {};
  /** Where each exported attachment id lives: skin, slot, name. */
  const placed = new Map<string, Array<{ skin: string; slot: string; name: string }>>();
  const place = (id: string, skin: string, slot: string, name: string) => placed.set(id, [...(placed.get(id) ?? []), { skin, slot, name }]);

  const emit = (skin: string, slot: (typeof model.slots)[number], id: string, name: string): Json | undefined => {
    const m = meta?.attachments?.[id];
    const fromHere = !!m && m.slot === slot.id && (m.skin ?? "default") === skin;
    const path = model.pathAttachments?.[id];
    if (path) {
      const bonesOf = [...new Set([slot.bone, ...path.weights.flatMap((w) => w.map(([b]) => b))])];
      place(id, skin, slot.id, name);
      if (fromHere && pathSig(path) === m!.sig && bonesUnchanged(bonesOf)) return m!.raw;
      return convertPath(slot.bone, path, m?.raw);
    }
    const clip = model.clippings?.[id];
    if (clip) {
      const bonesOf = [...new Set([slot.bone, ...clip.weights.flatMap((w) => w.map(([b]) => b))])];
      place(id, skin, slot.id, name);
      if (fromHere && clipSig(clip) === m!.sig && bonesUnchanged(bonesOf)) return m!.raw;
      const { lengths: _l, ...rest } = convertPath(slot.bone, { ...clip, lengths: [] } as PathAttachment, undefined);
      const out: Json = { type: "clipping", ...(clip.end && model.slots.some((x) => x.id === clip.end) ? { end: clip.end } : {}) };
      if (clip.convex) out.convex = true;
      if (clip.inverse) out.inverse = true;
      out.vertexCount = rest.vertexCount;
      out.vertices = rest.vertices;
      if (clip.color) out.color = hex8(clip.color);
      else if (m?.raw?.color) out.color = m.raw.color;
      return out;
    }
    const box = model.boundingBoxes?.[id];
    if (box) {
      const bonesOf = [...new Set([slot.bone, ...box.weights.flatMap((w) => w.map(([b]) => b))])];
      place(id, skin, slot.id, name);
      if (fromHere && boxSig(box) === m!.sig && bonesUnchanged(bonesOf)) return m!.raw;
      const { lengths: _l, ...rest } = convertPath(slot.bone, { ...box, lengths: [] } as PathAttachment, undefined);
      const out: Json = { type: "boundingbox", vertexCount: rest.vertexCount, vertices: rest.vertices };
      if (box.color) out.color = hex8(box.color);
      else if (m?.raw?.color) out.color = m.raw.color;
      return out;
    }
    const att = model.attachments[id];
    if (!att) return undefined;
    place(id, skin, slot.id, name);
    const bonesOf = [...new Set([slot.bone, ...att.weights.flatMap((w) => w.map(([b]) => b))])];
    let out: Json;
    if (fromHere && meshSig(att) === m!.sig && bonesUnchanged(bonesOf) && m!.raw.type !== "linkedmesh") {
      // untouched since import: exactly what came in
      out = m!.raw;
      vertexOrder.set(`${slot.id}\u0000${id}`, { order: att.vertices.map((_, i) => i), weighted: m!.raw.type === "mesh" && m!.raw.vertices.length !== m!.raw.uvs.length, raw: true });
    } else if (fromHere && m!.raw.type === "linkedmesh" && meshSig(att) === m!.sig) {
      out = m!.raw;
    } else out = convertAttachment(slot.id, slot.bone, id, att, name, m?.raw);
    const img = att.image;
    if (img) {
      usedImages.add(img);
      const p = out.path ?? out.name ?? name;
      if (p !== img) out = { ...out, path: img };
    }
    return out;
  };

  for (const slot of model.slots) {
    const taken = new Set<string>();
    for (const id of perSlot.get(slot.id)!) {
      const m = meta?.attachments?.[id];
      let name = m && m.slot === slot.id && !m.skin ? m.name : id.includes("/") && id.startsWith(slot.id + "/") ? id.slice(slot.id.length + 1) : id;
      while (taken.has(name)) name += "_";
      taken.add(name);
      names.set(`${slot.id}\u0000${id}`, name);
      const out = emit("default", slot, id, name);
      if (out) (skinAttachments[slot.id] ??= {})[name] = out;
    }
    for (const [name, raw] of Object.entries(meta?.extraAttachments?.[slot.id] ?? {})) (skinAttachments[slot.id] ??= {})[name] = raw;
  }
  // the other skins
  const otherSkins: Json[] = [];
  const skinOrder = [...(meta?.skins ?? []).map((x: Json) => x.name as string).filter((n: string) => model.skins?.[n]), ...Object.keys(model.skins ?? {}).filter((n) => !(meta?.skins ?? []).some((x: Json) => x.name === n))];
  const constraintType = new Set<string>(constraintList(model).map((c) => `${c.kind}:${c.id}`));
  for (const skinName of skinOrder) {
    if (skinName === "default") continue;
    const sk = model.skins![skinName];
    const extra = (meta?.skins ?? []).find((x: Json) => x.name === skinName) ?? {};
    const o: Json = { name: skinName, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "name")) };
    if (sk.bones?.length) o.bones = [...sk.bones];
    for (const key of sk.constraints ?? []) {
      const i = key.indexOf(":");
      const type = key.slice(0, i);
      const name = key.slice(i + 1);
      if (constraintType.has(key)) (o[type] ??= []).push(name);
    }
    const atts: Json = {};
    for (const slot of model.slots) {
      for (const [key, id] of Object.entries(sk.attachments[slot.id] ?? {})) {
        const name = keyName(slot.id, key) ?? meta?.attachments?.[key]?.name ?? key;
        const out = emit(skinName, slot, id, name);
        if (out) (atts[slot.id] ??= {})[name] = out;
      }
      for (const [name, raw] of Object.entries(meta?.skinExtraAttachments?.[skinName]?.[slot.id] ?? {})) (atts[slot.id] ??= {})[name] = raw;
    }
    // a skin with only bones / constraints has no attachments entry
    if (Object.keys(atts).length || (meta?.skins ?? []).every((x: Json) => x.name !== skinName)) o.attachments = atts;
    otherSkins.push(o);
  }

  function convertPath(bone: string, path: PathAttachment, raw: Json): Json {
    const single = path.weights.every((w) => w.length === 1 && w[0][0] === bone);
    let vertices: number[];
    if (single) vertices = path.vertices.flatMap((v) => toLocal(bone, v).map(r5));
    else {
      vertices = [];
      const binds = path.binds && path.binds.length === path.weights.reduce((n, w) => n + Math.max(1, w.length), 0) * 2 ? path.binds : null;
      let f = 0;
      path.weights.forEach((w, i) => {
        const list = w.filter(([, x]) => x > 0);
        const total = list.reduce((sum, [, x]) => sum + x, 0) || 1;
        vertices.push(list.length);
        for (const [b, x] of w) {
          const pt = binds ? [binds[f], binds[f + 1]] : toLocal(b, path.vertices[i]);
          f += 2;
          if (x > 0) vertices.push(boneIndex.get(b)!, r5(pt[0]), r5(pt[1]), r5(x / total));
        }
      });
    }
    const out: Json = { type: "path" };
    if (path.closed) out.closed = true;
    if (path.constantSpeed === false) out.constantSpeed = false;
    out.lengths = path.lengths.map(r5);
    out.vertexCount = path.vertices.length;
    out.vertices = vertices;
    if (path.color) out.color = hex8(path.color);
    else if (raw?.color) out.color = raw.color;
    return out;
  }

  function convertAttachment(slot: string, bone: string, id: string, att: MeshAttachment, name: string, raw: Json): Json {
    const color = att.color && hex8(att.color) !== "ffffffff" ? { color: hex8(att.color) } : {};
    const single = att.weights.every((w) => w.length === 1 && w[0][0] === bone);
    const img = att.image ? opts.loadImage(att.image) : null;
    // a quad with the full image, rigid on the slot bone: a region attachment
    // (not for meshes that were meshes in Spine or have deform keys: regions cannot deform)
    const deformed = Object.values(model.animations ?? {}).some((an) => an.deform?.[id]?.length);
    if (single && att.vertices.length === 4 && att.uvs && att.image && (raw?.type ?? "region") === "region" && !deformed) {
      const at = (u: number, v: number) => att.uvs!.findIndex((p) => Math.abs(p[0] - u) < 1e-4 && Math.abs(p[1] - v) < 1e-4);
      const [bl, br, tl, tr] = [at(0, 1), at(1, 1), at(0, 0), at(1, 0)];
      if (bl >= 0 && br >= 0 && tl >= 0 && tr >= 0) {
        const pBL = toLocal(bone, att.vertices[bl]);
        const pBR = toLocal(bone, att.vertices[br]);
        const pTL = toLocal(bone, att.vertices[tl]);
        const pTR = toLocal(bone, att.vertices[tr]);
        const w = raw?.width ?? img?.width ?? Math.hypot(pBR[0] - pBL[0], pBR[1] - pBL[1]);
        const h = raw?.height ?? img?.height ?? Math.hypot(pTL[0] - pBL[0], pTL[1] - pBL[1]);
        const rot = (Math.atan2(pBR[1] - pBL[1], pBR[0] - pBL[0]) * 180) / Math.PI;
        const out: Json = {};
        const cx = (pBL[0] + pTR[0]) / 2;
        const cy = (pBL[1] + pTR[1]) / 2;
        if (r5(cx)) out.x = r5(cx);
        if (r5(cy)) out.y = r5(cy);
        const sx = Math.hypot(pBR[0] - pBL[0], pBR[1] - pBL[1]) / w;
        const sy = Math.hypot(pTL[0] - pBL[0], pTL[1] - pBL[1]) / h;
        if (Math.abs(sx - 1) > 1e-5) out.scaleX = r5(sx);
        if (Math.abs(sy - 1) > 1e-5) out.scaleY = r5(sy);
        if (r5(rot)) out.rotation = r5(rot);
        return { ...out, width: w, height: h, ...color };
      }
    }
    if (!att.uvs) warnings.push(`${slot}/${name}: untextured mesh exported with generated UVs`);
    const { order: ord, hull, edges } = hullOrder(att);
    const back = new Map(ord.map((old, i) => [old, i]));
    vertexOrder.set(`${slot}\u0000${id}`, { order: ord, weighted: !single, raw: false });
    const uvs = ord.flatMap((i) => (att.uvs?.[i] ?? [0, 0]).map(r5));
    const triangles = att.triangles.flatMap((t) => [back.get(t[0])!, back.get(t[1])!, back.get(t[2])!]);
    let vertices: number[];
    if (single) vertices = ord.flatMap((i) => toLocal(bone, att.vertices[i]).map(r5));
    else {
      vertices = [];
      // Spine bind positions (kept from import while the mesh is unedited) are exact; else from the setup vertex
      const binds = att.binds && att.binds.length === att.weights.reduce((n, w) => n + Math.max(1, w.length), 0) * 2 ? att.binds : null;
      const start: number[] = [];
      att.weights.reduce((n, w, i) => ((start[i] = n), n + Math.max(1, w.length) * 2), 0);
      for (const i of ord) {
        const list = att.weights[i].map((e, k) => [e, k] as const).filter(([[, w]]) => w > 0);
        const total = list.reduce((s, [[, w]]) => s + w, 0) || 1;
        vertices.push(list.length);
        for (const [[b, w], k] of list) {
          const p = binds ? [binds[start[i] + k * 2], binds[start[i] + k * 2 + 1]] : toLocal(b, att.vertices[i]);
          vertices.push(boneIndex.get(b)!, r5(p[0]), r5(p[1]), r5(w / total));
        }
      }
    }
    return {
      type: "mesh",
      uvs,
      triangles,
      vertices,
      hull,
      edges,
      width: raw?.width ?? img?.width ?? 0,
      height: raw?.height ?? img?.height ?? 0,
      ...color,
    };
  }

  json.slots = model.slots.map((s) => {
    const o: Json = { name: s.id, bone: s.bone };
    if (hex8(s.color) !== "ffffffff") o.color = hex8(s.color);
    if (s.dark) o.dark = hex8(s.dark).slice(0, 6);
    const extra = meta?.slots?.[s.id] ?? {};
    Object.assign(o, extra);
    if (s.attachment && keyName(s.id, s.attachment)) o.attachment = keyName(s.id, s.attachment);
    if (s.blend && s.blend !== "normal") o.blend = s.blend;
    return o;
  });

  // ---- constraints: unedited ones as written, others converted; Spine 4.3+ has one "constraints" array in
  // evaluation order, older versions one array per kind with an "order" field
  const version43 = !/^(3\.|4\.[012]\b)/.test(json.skeleton.spine);
  const exists = (b: string | undefined) => !b || boneIndex.has(b);
  const clist: Json[] = [];
  for (const { kind, id } of constraintList(model)) {
    const type = kind;
    const kept = meta?.constraints.raw?.[`${kind}:${id}`];
    let c: Json;
    let data: unknown;
    if (kind === "ik") {
      const x = model.ik!.find((k) => k.id === id)!;
      data = x;
      c = { name: id, bones: x.bones, target: x.target };
      if (x.mix !== 1) c.mix = r5(x.mix);
      if (x.softness) c.softness = r5(x.softness);
      if (!x.bendPositive) c.bendPositive = false;
      if (x.compress) c.compress = true;
      if (x.stretch) c.stretch = true;
      if (x.scaleY) {
        if (version43) c.scaleY = x.scaleY;
        else if (x.scaleY === "uniform") c.uniform = true;
      }
      if (x.skin) c.skin = true;
      if (!kept && meta?.constraints.ik?.[id]) Object.assign(c, meta.constraints.ik[id]);
    } else if (kind === "transform") {
      const x = model.transforms!.find((k) => k.id === id)!;
      data = x;
      c = { name: id, source: x.source, bones: x.bones };
      if (x.localSource) c.localSource = true;
      if (x.localTarget) c.localTarget = true;
      if (x.additive) c.additive = true;
      if (x.clamp) c.clamp = true;
      const offName: Record<TransformProperty, string> = { rotate: "rotation", x: "x", y: "y", scaleX: "scaleX", scaleY: "scaleY", shearY: "shearY" };
      for (const [p, v] of Object.entries(x.offset ?? {})) if (v) c[offName[p as TransformProperty]] = r5(v);
      const props: Json = {};
      for (const from of x.properties) {
        const to: Json = {};
        for (const t of from.to) {
          const e: Json = {};
          if (t.offset) e.offset = r5(t.offset);
          if ((t.max ?? 1) !== 1) e.max = r5(t.max!);
          if ((t.scale ?? 1) !== 1) e.scale = r5(t.scale!);
          to[t.property] = e;
        }
        props[from.from] = { ...(from.offset ? { offset: r5(from.offset) } : {}), to };
      }
      c.properties = props;
      const mixName: Record<TransformProperty, string> = { rotate: "mixRotate", x: "mixX", y: "mixY", scaleX: "mixScaleX", scaleY: "mixScaleY", shearY: "mixShearY" };
      for (const [p, v] of Object.entries(x.mix)) {
        const def = p === "y" ? (x.mix.x ?? 1) : p === "scaleY" ? (x.mix.scaleX ?? 1) : 1;
        if (v !== undefined && v !== def) c[mixName[p as TransformProperty]] = r5(v);
      }
      if (x.skin) c.skin = true;
      if (!version43) warnings.push(`transform constraint ${id}: written in Spine 4.3's format (properties); older Spine versions read it differently`);
    } else if (kind === "path") {
      const x = model.paths!.find((k) => k.id === id)!;
      data = x;
      c = { name: id, bones: x.bones, slot: x.slot };
      if (x.positionMode !== "percent") c.positionMode = x.positionMode;
      if (x.spacingMode !== "length") c.spacingMode = x.spacingMode;
      if (x.rotateMode !== "tangent") c.rotateMode = x.rotateMode;
      if (x.rotation) c.rotation = r5(x.rotation);
      if (x.position) c.position = r5(x.position);
      if (x.spacing) c.spacing = r5(x.spacing);
      if (x.mix.rotate !== 1) c.mixRotate = r5(x.mix.rotate);
      if (x.mix.x !== 1) c.mixX = r5(x.mix.x);
      if (x.mix.y !== x.mix.x) c.mixY = r5(x.mix.y);
      if (x.skin) c.skin = true;
    } else if (kind === "physics") {
      const x = model.spinePhysics!.find((k) => k.id === id)!;
      data = x;
      c = { name: id, bone: x.bone };
      for (const k of ["x", "y", "rotate", "scaleX", "shearX"] as const) if (x[k]) c[k] = r5(x[k]!);
      if (x.scaleY) c.scaleY = x.scaleY;
      if (x.limit !== undefined && x.limit !== 5000) c.limit = r5(x.limit);
      if (x.fps !== undefined && x.fps !== 60) c.fps = x.fps;
      const defs = { inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1 };
      for (const [k, def] of Object.entries(defs)) {
        const v = x[k as keyof typeof defs];
        if (v !== def) c[k] = r5(v);
      }
      for (const g of x.global ?? []) c[`${g}Global`] = true;
      if (x.skin) c.skin = true;
    } else {
      const x = model.sliders!.find((k) => k.id === id)!;
      data = x;
      c = { name: id };
      if (x.additive) c.additive = true;
      if (x.loop) c.loop = true;
      c.animation = x.animation;
      if (x.time) c.time = r5(x.time);
      if (x.mix !== 1) c.mix = r5(x.mix);
      if (x.bone) {
        c.bone = x.bone;
        c.property = x.property ?? "rotate";
        if (x.from) c.from = r5(x.from);
        if (x.to) c.to = r5(x.to);
        if (x.scale !== undefined && x.scale !== 1) c.scale = x.scale;
        if (x.max) c.max = r5(x.max);
        if (x.local) c.local = true;
      }
      if (x.skin) c.skin = true;
    }
    if (kept && kept.type === type && kept.sig === JSON.stringify(data)) {
      const { type: _t, ...rest } = kept.raw;
      c = rest;
    }
    const bonesOf: string[] = [...(c.bones ?? []), c.bone, c.target, c.source].filter(Boolean);
    if (!bonesOf.every(exists)) {
      warnings.push(`constraint ${id}: a bone it uses is gone; not exported`);
      continue;
    }
    clist.push({ type, c });
  }
  if (version43) {
    if (clist.length) json.constraints = clist.map(({ type, c }) => ({ type, ...c }));
  } else {
    clist.forEach(({ type, c }, i) => {
      if (type === "slider") return warnings.push(`slider ${c.name}: sliders need Spine 4.3; not exported`);
      const { order: _, ...rest } = c;
      (json[type] ??= []).push({ ...rest, order: i });
    });
  }

  // ---- skins
  json.skins = [{ name: "default", ...(meta?.defaultSkin ?? {}), attachments: skinAttachments }, ...otherSkins];

  // ---- events
  if (model.events && Object.keys(model.events).length) json.events = model.events;

  /** Spine rgba2 keys (light and dark color keyed together) at the union of the two tracks' key times. */
  function twoColorKeys(slot: string, color: Key<string>[] | undefined, dark: Key<string>[]): Json[] {
    const s = model.slots.find((x) => x.id === slot)!;
    const lightKeys = color?.length ? color : [{ t: 0, v: s.color }];
    const times = [...new Set([...lightKeys, ...dark].map((k) => k.t))].sort((a, b) => a - b);
    const sample = (keys: Key<string>[], t: number) =>
      sampleTrack(keys.map((k) => ({ ...k, v: parseColor(k.v) })), t, (a, b, f) => a.map((x, i) => x + (b[i] - x) * f) as typeof a, true)!;
    const easeAt = (keys: Key<string>[], t: number, n: number): Ease[] => {
      const k = keys.find((x) => x.t === t);
      const e = k?.ease ?? "linear";
      return Array.from({ length: n }, (_, c) => (isChannelEases(e) ? e[Math.min(c, e.length - 1)] : e));
    };
    const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
    return times.map((t, i) => {
      const l = sample(lightKeys, t);
      const d = sample(dark, t);
      const o: Json = {};
      if (t) o.time = r5(t);
      o.light = l.map(byte).join("");
      o.dark = d.slice(0, 3).map(byte).join("");
      const next = times[i + 1];
      if (next !== undefined) {
        const ln = sample(lightKeys, next);
        const dn = sample(dark, next);
        const c = curveOf([...easeAt(lightKeys, t, 4), ...easeAt(dark, t, 3)], t, next, [...l, ...d.slice(0, 3)], [...ln, ...dn.slice(0, 3)]);
        if (c !== undefined) o.curve = c;
      } else if (dark.find((k) => k.t === t)?.ease === "stepped") o.curve = "stepped";
      return o;
    });
  }

  // ---- animations
  const deformIn42 = !json.skeleton.spine.startsWith("4.0") && !json.skeleton.spine.startsWith("4.1");
  json.animations = {};
  for (const [name, a] of Object.entries(model.animations ?? {})) {
    const out: Json = {};
    const am = meta?.animations?.[name];
    const added = new Set(am?.setupKeys ?? []);
    if (a.params && Object.keys(a.params).length) warnings.push(`${name}: parameter tracks are not exported`);
    // slots
    const slots: Json = {};
    for (const [slot, tl] of Object.entries(a.slots ?? {})) {
      const o: Json = {};
      const kept = am?.rawTracks?.[`slots/${slot}/twoColor`];
      if (tl.dark?.length && kept && kept.sig === JSON.stringify([tl.color, tl.dark])) Object.assign(o, kept.raw);
      else if (tl.dark?.length) o.rgba2 = twoColorKeys(slot, tl.color, tl.dark);
      else if (tl.color?.length) {
        const ch = (c: string) => [0, 2, 4, 6].map((i) => parseInt(hex8(c).slice(i, i + 2), 16) / 255);
        const setupColor = model.slots.find((x) => x.id === slot)?.color ?? "#ffffffff";
        o.rgba = spineKeys(trimSetup(tl.color, setupColor, added.has(`slots/${slot}/color`)), (c) => ({ color: hex8(c) }), ch);
      }
      if (tl.attachment?.length) {
        // a key without a name hides the attachment
        o.attachment = trimSetup(tl.attachment, model.slots.find((x) => x.id === slot)?.attachment ?? null, added.has(`slots/${slot}/attachment`)).map((k) => {
          const nm = k.v ? keyName(slot, k.v) : undefined;
          return { ...(k.t ? { time: r5(k.t) } : {}), ...(nm ? { name: nm } : {}) };
        });
      }
      Object.assign(o, am?.extra?.slots?.[slot] ?? {});
      if (Object.keys(o).length) slots[slot] = o;
    }
    for (const [slot, extra] of Object.entries<Json>(am?.extra?.slots ?? {})) if (!slots[slot]) slots[slot] = extra;
    if (Object.keys(slots).length) out.slots = slots;
    // bones
    const bones: Json = {};
    for (const [bone, tl0] of Object.entries(a.bones ?? {})) {
      const o: Json = {};
      // tracks whose curves were cut on import go back as written while unedited
      const tl = { ...tl0 };
      for (const ch of ["rotate", "translate", "scale", "shear", "translateX", "translateY", "scaleX", "scaleY", "shearX", "shearY"] as const) {
        const kept = am?.rawTracks?.[`bones/${bone}/${ch}`];
        if (kept && tl[ch] && JSON.stringify(tl[ch]) === kept.sig) {
          Object.assign(o, kept.raw);
          delete tl[ch];
        }
      }
      if (tl.rotate?.length) o.rotate = spineKeys(trimSetup(tl.rotate, 0, added.has(`bones/${bone}/rotate`)), (v) => (r5(v) ? { value: r5(v) } : {}), (v) => [v]);
      if (tl.translate?.length) o.translate = spineKeys(trimSetup(tl.translate, [0, 0] as Vec2, added.has(`bones/${bone}/translate`)), (v) => ({ ...(r5(v[0]) ? { x: r5(v[0]) } : {}), ...(r5(v[1]) ? { y: r5(v[1]) } : {}) }), (v) => v);
      if (tl.scale?.length) o.scale = spineKeys(trimSetup(tl.scale, [1, 1] as Vec2, added.has(`bones/${bone}/scale`)), (v) => ({ ...(r5(v[0]) !== 1 ? { x: r5(v[0]) } : {}), ...(r5(v[1]) !== 1 ? { y: r5(v[1]) } : {}) }), (v) => v);
      for (const ch of ["translateX", "translateY", "scaleX", "scaleY", "shearX", "shearY"] as const) {
        const keys = tl[ch];
        if (!keys?.length) continue;
        const def = ch.startsWith("scale") ? 1 : 0;
        o[ch.toLowerCase()] = spineKeys(trimSetup(keys, def, added.has(`bones/${bone}/${ch}`)), (v) => (r5(v) !== def ? { value: r5(v) } : {}), (v) => [v]);
      }
      if (tl.inherit?.length) o.inherit = trimSetup(tl.inherit, model.bones.find((b) => b.id === bone)?.inherit ?? "normal", true).map((k) => ({ ...(k.t ? { time: r5(k.t) } : {}), inherit: k.v }));
      if (tl.shear?.length) o.shear = spineKeys(trimSetup(tl.shear, [0, 0] as Vec2, added.has(`bones/${bone}/shear`)), (v) => ({ ...(r5(v[0]) ? { x: r5(v[0]) } : {}), ...(r5(v[1]) ? { y: r5(v[1]) } : {}) }), (v) => v);
      Object.assign(o, am?.extra?.bones?.[bone] ?? {});
      if (Object.keys(o).length) bones[bone] = o;
    }
    for (const [bone, extra] of Object.entries<Json>(am?.extra?.bones ?? {})) if (!bones[bone]) bones[bone] = extra;
    if (Object.keys(bones).length) out.bones = bones;
    // constraint timelines: unedited ones as written
    const tracks = am?.constraintTracks ?? {};
    const keptTrack = (key: string, tl: unknown) => (tracks[key] && tracks[key].sig === JSON.stringify(tl) ? tracks[key].raw : undefined);
    for (const [id, tl] of Object.entries(a.ik ?? {})) {
      const c = model.ik?.find((x) => x.id === id);
      (out.ik ??= {})[id] =
        keptTrack(`ik/${id}`, tl) ??
        multiKeys(
          [
            { field: "mix", keys: tl.mix, def: 1, setup: c?.mix ?? 1 },
            { field: "softness", keys: tl.softness, def: 0, setup: c?.softness ?? 0 },
          ],
          [
            { field: "bendPositive", keys: tl.bendPositive, write: (v: boolean) => (v ? undefined : false), setup: c?.bendPositive ?? true },
            { field: "compress", keys: tl.compress, write: (v: boolean) => (v ? true : undefined), setup: !!c?.compress },
            { field: "stretch", keys: tl.stretch, write: (v: boolean) => (v ? true : undefined), setup: !!c?.stretch },
          ],
        );
    }
    for (const [id, tl] of Object.entries(a.transforms ?? {})) {
      const c = model.transforms?.find((x) => x.id === id);
      const f = (field: string, p: TransformProperty) => ({ field, keys: tl[p], def: 1, setup: c?.mix[p] ?? 0 });
      (out.transform ??= {})[id] = keptTrack(`transform/${id}`, tl) ?? multiKeys([f("mixRotate", "rotate"), f("mixX", "x"), f("mixY", "y"), f("mixScaleX", "scaleX"), f("mixScaleY", "scaleY"), f("mixShearY", "shearY")], [], true);
    }
    for (const [id, tl] of Object.entries(a.paths ?? {})) {
      const c = model.paths?.find((x) => x.id === id);
      const o: Json = {};
      if (tl.position?.length) o.position = oneKeys(tl.position);
      if (tl.spacing?.length) o.spacing = oneKeys(tl.spacing);
      if (tl.rotate?.length || tl.x?.length || tl.y?.length)
        o.mix = multiKeys(
          [
            { field: "mixRotate", keys: tl.rotate, def: 1, setup: c?.mix.rotate ?? 1 },
            { field: "mixX", keys: tl.x, def: 1, setup: c?.mix.x ?? 1 },
            { field: "mixY", keys: tl.y, def: 1, setup: c?.mix.y ?? 1 },
          ],
          [],
          true,
        );
      (out.path ??= {})[id] = keptTrack(`path/${id}`, tl) ?? o;
    }
    for (const [id, tl] of Object.entries(a.spinePhysics ?? {})) {
      const o: Json = {};
      for (const k of ["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"] as const) if (tl[k]?.length) o[k] = oneKeys(tl[k]!);
      if (tl.reset?.length) o.reset = tl.reset.map((t) => (t ? { time: r5(t) } : {}));
      (out.physics ??= {})[id] = keptTrack(`physics/${id}`, tl) ?? o;
    }
    for (const [id, tl] of Object.entries(a.sliders ?? {})) {
      const o: Json = {};
      if (tl.time?.length) o.time = oneKeys(tl.time);
      if (tl.mix?.length) o.mix = oneKeys(tl.mix);
      (out.slider ??= {})[id] = keptTrack(`slider/${id}`, tl) ?? o;
    }
    // deform
    const deformOut: Json = {};
    for (const [id, keys] of Object.entries(a.deform ?? {})) {
      const att = model.attachments[id] ?? model.pathAttachments?.[id] ?? model.clippings?.[id] ?? model.boundingBoxes?.[id];
      if (!att) continue;
      // a linked mesh that follows its source's keys (Spine's "timelines") has none of its own
      const lraw = meta?.attachments?.[id]?.raw;
      if (lraw?.type === "linkedmesh" && lraw.timelines !== false) {
        const src = Object.entries(meta!.attachments).find(([, m]) => m.slot === meta!.attachments[id].slot && (m.skin ?? "default") === (lraw.skin ?? "default") && m.name === (lraw.source ?? lraw.parent));
        if (src && JSON.stringify(a.deform?.[src[0]]) === JSON.stringify(keys)) continue;
      }
      for (const { skin, slot: slotId, name: nm } of placed.get(id) ?? []) {
        const slot = model.slots.find((x) => x.id === slotId)!;
        const vo = vertexOrder.get(`${slot.id}\u0000${id}`);
        const orig = am?.deform?.[id];
        let spineKeysOut: Json[];
        if ((vo?.raw || !model.attachments[id]) && orig && orig.slot === slot.id && orig.skin === skin && JSON.stringify(keys) === orig.sig) spineKeysOut = orig.raw;
        else {
          const order = vo?.order ?? att.vertices.map((_, i) => i);
          const weighted = vo ? vo.weighted : !att.weights.every((w) => w.length === 1 && w[0][0] === slot.bone);
          const trimmed = added.has(`deform/${id}`) && keys.length > 1 && keys[0].t === 0 && keys[0].ease === "stepped" && keys[1].t > 0 && !keys[0].v.length ? keys.slice(1) : keys;
          spineKeysOut = trimmed.map((k, i) => {
            const dense = new Map<number, Vec2>(k.v.map(([v, dx, dy]: [number, number, number]) => [v, [dx, dy]]));
            const flat: number[] = [];
            for (const v of order) {
              const d = dense.get(v) ?? [0, 0];
              if (!weighted) flat.push(...linearLocal(slot.bone, d).map(r5));
              else for (const [b, w] of att.weights[v]) if (w > 0) flat.push(...linearLocal(b, d).map(r5));
            }
            let first = flat.findIndex((x) => Math.abs(x) > 1e-5);
            let last = flat.length - 1;
            while (last >= 0 && Math.abs(flat[last]) <= 1e-5) last--;
            const o: Json = {};
            if (k.t) o.time = r5(k.t);
            if (first >= 0) {
              first -= first % 2 === 1 ? 1 : 0;
              if (first) o.offset = first;
              o.vertices = flat.slice(first, last + 1);
            }
            const next = trimmed[i + 1];
            const c = next ? curveOf(k.ease, k.t, next.t, [0], [1]) : k.ease === "stepped" ? "stepped" : undefined;
            if (c !== undefined) o.curve = c;
            return o;
          });
        }
        ((deformOut[skin] ??= {})[slot.id] ??= {})[nm] = deformIn42 ? { deform: spineKeysOut } : spineKeysOut;
      }
    }
    // other attachment timelines kept from import (sequence, deform of attachments Awaken2D does not have)
    const extraAtt = am?.extra?.attachments ?? {};
    for (const [skin, slots2] of Object.entries<Json>(extraAtt)) {
      for (const [slot, atts] of Object.entries<Json>(slots2)) for (const [nm, e] of Object.entries<Json>(atts)) ((deformOut[skin] ??= {})[slot] ??= {})[nm] = { ...(((deformOut[skin] ?? {})[slot] ?? {})[nm] ?? {}), ...e };
    }
    for (const [skin, slots2] of Object.entries<Json>(am?.extra?.deform ?? {})) {
      for (const [slot, atts] of Object.entries<Json>(slots2)) for (const [nm, keys] of Object.entries<Json>(atts)) ((deformOut[skin] ??= {})[slot] ??= {})[nm] = deformIn42 ? { deform: keys } : keys;
    }
    if (Object.keys(deformOut).length) out[deformIn42 ? "attachments" : "deform"] = deformOut;
    // draw order
    if (a.drawOrder?.length) {
      const index = new Map(model.slots.map((s, i) => [s.id, i]));
      out.drawOrder = a.drawOrder.map((k) => {
        const o: Json = {};
        if (k.t) o.time = r5(k.t);
        const offsets = k.offsets.filter(([s]) => index.has(s)).sort((x, y) => index.get(x[0])! - index.get(y[0])!);
        if (offsets.length) o.offsets = offsets.map(([slot, offset]) => ({ slot, offset }));
        return o;
      });
    }
    // events
    if (a.events?.length) {
      out.events = a.events.map((e) => {
        const def = model.events?.[e.name] ?? {};
        const o: Json = { ...(e.t ? { time: r5(e.t) } : {}), name: e.name };
        for (const k of ["int", "float", "string", "volume", "balance"] as const) if (e[k] !== undefined && e[k] !== (def as Json)[k]) o[k] = e[k];
        return o;
      });
    }
    // timeline groups Awaken2D keeps as written
    for (const [k, v] of Object.entries<Json>(am?.extra ?? {})) if (!["bones", "slots", "attachments", "deform", "ikExtras"].includes(k)) out[k] = v;
    json.animations[name] = out;
  }

  // ---- atlas + images
  const images = new Map<string, RGBAImage>();
  for (const id of [...usedImages].sort()) {
    const img = opts.loadImage(id);
    if (img) images.set(id, img);
    else warnings.push(`image ${id} could not be read; it is missing from the atlas`);
  }
  const packed = packAtlas(images, { name: `${opts.name}.png` });
  return { json: orderKeys(json), atlas: writeAtlas([packed.page]), page: packed.image, images, warnings };
}

/** Top-level keys in the order the Spine editor writes them. */
function orderKeys(json: Json): Json {
  const out: Json = {};
  for (const k of ["skeleton", "bones", "slots", "constraints", "ik", "transform", "path", "physics", "slider", "skins", "events", "animations"]) if (json[k] !== undefined) out[k] = json[k];
  return out;
}

/**
 * Meshes that use a small part of a big shared texture (Live2D texture pages) get their own cropped image, so the
 * atlas holds just the art each attachment shows.
 */
function cropSharedImages(model: Model, loadImage: (id: string) => RGBAImage | null): { model: Model; loadImage: (id: string) => RGBAImage | null } {
  const crops = new Map<string, { src: string; x: number; y: number; w: number; h: number }>();
  const attachments: Model["attachments"] = { ...model.attachments };
  const sizes = new Map<string, RGBAImage | null>();
  const size = (id: string) => {
    if (!sizes.has(id)) sizes.set(id, loadImage(id));
    return sizes.get(id);
  };
  const taken = new Set(Object.keys(model.images ?? {}));
  for (const [id, att] of Object.entries(model.attachments)) {
    if (!att.image || !att.uvs?.length) continue;
    const us = att.uvs.map((p) => p[0]);
    const vs = att.uvs.map((p) => p[1]);
    const u0 = Math.max(0, Math.min(...us));
    const u1 = Math.min(1, Math.max(...us));
    const v0 = Math.max(0, Math.min(...vs));
    const v1 = Math.min(1, Math.max(...vs));
    if ((u1 - u0) * (v1 - v0) > 0.6) continue;
    const img = size(att.image);
    if (!img) continue;
    const x = Math.max(0, Math.floor(u0 * img.width) - 2);
    const y = Math.max(0, Math.floor(v0 * img.height) - 2);
    const w = Math.min(img.width, Math.ceil(u1 * img.width) + 2) - x;
    const h = Math.min(img.height, Math.ceil(v1 * img.height) + 2) - y;
    if (w <= 0 || h <= 0) continue;
    let name = id;
    while (taken.has(name)) name += "_";
    taken.add(name);
    crops.set(name, { src: att.image, x, y, w, h });
    attachments[id] = {
      ...att,
      image: name,
      uvs: att.uvs.map(([u, v]) => [Math.round(((u * img.width - x) / w) * 1e6) / 1e6, Math.round(((v * img.height - y) / h) * 1e6) / 1e6]),
    };
  }
  if (!crops.size) return { model, loadImage };
  const images = { ...(model.images ?? {}) };
  for (const [name, c] of crops) images[name] = { path: model.images?.[c.src]?.path ?? "" };
  return {
    model: { ...model, attachments, images },
    loadImage: (id) => {
      const c = crops.get(id);
      if (!c) return loadImage(id);
      const src = size(c.src);
      if (!src) return null;
      const data = new Uint8Array(c.w * c.h * 4);
      for (let row = 0; row < c.h; row++) data.set(src.data.subarray(((c.y + row) * src.width + c.x) * 4, ((c.y + row) * src.width + c.x + c.w) * 4), row * c.w * 4);
      return { width: c.w, height: c.h, data };
    },
  };
}

/** Spine single-value keys ({time, value, curve}). */
function oneKeys(keys: Key<number>[]): Json[] {
  return spineKeys(keys, (v) => ({ value: r5(v) }), (v) => [v]);
}

/**
 * Spine keys with several values each (IK, transform and path mixes): one key at every time any channel has a key,
 * each channel's value (sampled where it has no key) and its own curve channel. `flags` are stepped values.
 */
function multiKeys(
  channels: Array<{ field: string; keys: Key<number>[] | undefined; def: number; setup: number }>,
  flags: Array<{ field: string; keys: Key<boolean>[] | undefined; write: (v: boolean) => boolean | undefined; setup: boolean }> = [],
  always = false,
): Json[] {
  const times = [...new Set([...channels.flatMap((c) => (c.keys ?? []).map((k) => k.t)), ...flags.flatMap((f) => (f.keys ?? []).map((k) => k.t))])].sort((a, b) => a - b);
  const valueAt = (c: (typeof channels)[number], t: number) => (c.keys?.length ? sampleTrack(c.keys, t, (a, b, f) => a + (b - a) * f)! : c.setup);
  const easeAt = (c: (typeof channels)[number], t: number, t2: number): Ease | undefined => {
    const k = c.keys?.find((x) => x.t === t);
    const hasNext = c.keys?.some((x) => x.t === t2);
    if (k && hasNext) return Array.isArray(k.ease) && isChannelEases(k.ease) ? k.ease[0] : (k.ease as Ease | undefined);
    return undefined;
  };
  return times.map((t, i) => {
    const o: Json = {};
    if (t) o.time = r5(t);
    const vals = channels.map((c) => valueAt(c, t));
    // written unless equal to Spine's default for the key (mixY defaults to the key's mixX)
    channels.forEach((c, n) => {
      if (!c.keys?.length && !always) return;
      const def = c.field === "mixY" ? (vals[channels.findIndex((x) => x.field === "mixX")] ?? 1) : c.def;
      if (vals[n] !== def) o[c.field] = r5(vals[n]);
    });
    for (const f of flags) {
      if (!f.keys?.length) continue;
      const v = f.keys.filter((k) => k.t <= t + 1e-9).pop()?.v ?? f.setup;
      const w = f.write(v);
      if (w !== undefined) o[f.field] = w;
    }
    const t2 = times[i + 1];
    if (t2 !== undefined) {
      const eases = channels.map((c) => easeAt(c, t, t2));
      const c = curveOf(eases.every((e) => e === eases[0]) ? eases[0] : (eases.map((e) => e ?? "linear") as Ease[]), t, t2, vals, channels.map((ch) => valueAt(ch, t2)));
      if (c !== undefined) o.curve = c;
    }
    return o;
  });
}
