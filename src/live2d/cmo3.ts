// Cubism Editor model (.cmo3) -> Awaken2D Live2D model. Pure: the CAFF container is unpacked by caff.ts (the caller
// supplies the inflater), then main.xml, a Java object serialization, is read into a small object graph and mapped to
// the same rig the moc3 import builds (keyform grids, deformers, parts, glue, blend shapes, draw-order groups), plus
// what only the editor file has: display names, hidden / locked objects, part labels and parameter groups.
//
// main.xml: one element per object, `xs.n` names the field it fills in its parent, `xs.id` / `xs.ref` share objects
// (the element with `xs.id` holds the fields, anywhere in the file), and a class's superclass fields sit in a child
// named `super`. Positions are stored like the runtime's except at the root: an object with no parent deformer keeps
// canvas pixels (+y down), which the export maps to canvas-width units around the canvas center. Hidden objects are
// left out of a runtime export; here they are kept with their hidden flag.
import { FORMAT_ID } from "../core/types.ts";
import type {
  Deformer,
  DrawOrderGroup,
  Glue,
  KeyformGrid,
  Live2DBlendShape,
  Live2DBlendShapeConstraint,
  Live2DPath,
  Live2DPhysics,
  Live2DPhysicsKind,
  Live2DRig,
  MeshAttachment,
  MeshKeyform,
  Model,
  Parameter,
  Part,
  RGB,
  RotationKeyform,
  Slot,
  Tri,
  Vec2,
  WarpKeyform,
} from "../core/types.ts";
import { live2dFrame } from "../core/live2d.ts";
import { readCaff } from "./caff.ts";
import type { CaffEntry, InflateRaw } from "./caff.ts";
import { defaultValues, f32, syncLive2DVertices } from "./import.ts";

// ---------- XML

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  text?: string;
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescape = (t: string) =>
  t.indexOf("&") < 0
    ? t
    : t.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_, e: string) =>
        ENTITY[e] ?? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
      );

/** A small non-validating XML reader: elements, attributes and text; processing instructions and comments are skipped. */
export function parseXml(s: string): XNode {
  const root: XNode = { tag: "#document", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const n = s.length;
  let i = 0;
  const space = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const t = s.slice(i, lt);
      if (t.trim()) {
        const top = stack[stack.length - 1];
        top.text = (top.text ?? "") + unescape(t);
      }
    }
    const c1 = s.charCodeAt(lt + 1);
    if (c1 === 63 /* ? */) {
      i = s.indexOf("?>", lt) + 2;
      continue;
    }
    if (c1 === 33 /* ! */) {
      i = s.startsWith("<!--", lt) ? s.indexOf("-->", lt) + 3 : s.indexOf(">", lt) + 1;
      continue;
    }
    if (c1 === 47 /* / */) {
      i = s.indexOf(">", lt) + 1;
      if (stack.length > 1) stack.pop();
      continue;
    }
    let j = lt + 1;
    while (j < n && !space(s.charCodeAt(j)) && s[j] !== "/" && s[j] !== ">") j++;
    const el: XNode = { tag: s.slice(lt + 1, j), attrs: {}, children: [] };
    stack[stack.length - 1].children.push(el);
    for (;;) {
      while (j < n && space(s.charCodeAt(j))) j++;
      if (j >= n) throw new Error("cmo3: unexpected end of main.xml");
      if (s[j] === "/") {
        j = s.indexOf(">", j) + 1;
        break;
      }
      if (s[j] === ">") {
        j++;
        stack.push(el);
        break;
      }
      const eq = s.indexOf("=", j);
      const q = s[eq + 1];
      const end = s.indexOf(q, eq + 2);
      el.attrs[s.slice(j, eq).trim()] = unescape(s.slice(eq + 2, end));
      j = end + 1;
    }
    i = j;
  }
  return root;
}

// ---------- object graph

export class Graph {
  private ids = new Map<string, XNode>();
  private uuids = new Map<string, XNode>();
  constructor(root: XNode) {
    const walk = (e: XNode) => {
      const id = e.attrs["xs.id"];
      if (id) this.ids.set(id, e);
      const uuid = e.attrs.uuid;
      if (uuid && !e.attrs["xs.ref"] && !this.uuids.has(uuid)) this.uuids.set(uuid, e);
      for (const c of e.children) walk(c);
    };
    walk(root);
  }
  /** The object an element stands for (follows xs.ref; guids written out twice are one object). */
  obj(e: XNode | undefined): XNode | undefined {
    const r = e?.attrs["xs.ref"];
    const o = r ? this.ids.get(r) : e;
    const uuid = o?.attrs.uuid;
    return uuid ? (this.uuids.get(uuid) ?? o) : o;
  }
  /** Field `name` of an object, searching its superclass parts. */
  field(e: XNode | undefined, name: string): XNode | undefined {
    let o = this.obj(e);
    while (o) {
      let sup: XNode | undefined;
      for (const c of o.children) {
        const n = c.attrs["xs.n"];
        if (n === name) return c.tag === "null" ? undefined : this.obj(c);
        if (n === "super") sup = c;
      }
      o = sup;
    }
    return undefined;
  }
  str(e: XNode | undefined, name: string): string | undefined {
    const f = this.field(e, name);
    return f ? (f.text ?? "") : undefined;
  }
  num(e: XNode | undefined, name: string, fallback = 0): number {
    const f = this.field(e, name);
    const v = f ? Number(f.text ?? f.attrs.v) : NaN;
    return Number.isFinite(v) ? v : fallback;
  }
  bool(e: XNode | undefined, name: string, fallback = false): boolean {
    const f = this.field(e, name);
    return f ? f.text === "true" : fallback;
  }
  enumOf(e: XNode | undefined, name: string): string | undefined {
    return this.field(e, name)?.attrs.v;
  }
  nums(e: XNode | undefined, name: string): number[] {
    const t = this.field(e, name)?.text?.trim();
    return t ? t.split(/\s+/).map(Number) : [];
  }
  list(e: XNode | undefined, name: string): XNode[] {
    const f = this.field(e, name);
    return f ? f.children.map((c) => this.obj(c)!).filter(Boolean) : [];
  }
  idstr(e: XNode | undefined): string | undefined {
    return this.field(e, "id")?.attrs.idstr;
  }
}

// ---------- model

export interface Cmo3Texture {
  /** Image id in the model (texture_00, ...). */
  id: string;
  /** Path of the PNG inside the cmo3 (the atlas the editor last rendered). */
  entry: string;
  width: number;
  height: number;
}

export interface Cmo3ImportResult {
  model: Model;
  log: string[];
  warnings: string[];
  textures: Cmo3Texture[];
  /** Parameter and part ids by guid uuid (an animation file (.can3) refers to them by guid). */
  uuids: Map<string, { kind: "parameter" | "part"; id: string }>;
}

const r6 = f32;
const LABELS: Record<string, string> = {
  RED: "#e5534b",
  ORANGE: "#e0a43a",
  YELLOW: "#e8d44d",
  GREEN: "#3fb96c",
  CYAN: "#26b5b5",
  BLUE: "#4ea1ff",
  PURPLE: "#a371f7",
  PINK: "#e04ab8",
};

/** Reads a .cmo3 file. `inflateRaw` decompresses raw deflate (node:zlib's inflateRawSync). */
export function readCmo3(bytes: Uint8Array, inflateRaw: InflateRaw): { entries: CaffEntry[]; xml: string } {
  const entries = readCaff(bytes, inflateRaw);
  const main = entries.find((e) => e.path === "main.xml");
  if (!main) throw new Error("not a Cubism model file (.cmo3): no main.xml inside");
  return { entries, xml: new TextDecoder().decode(main.data) };
}

/** Builds the Awaken2D model from a cmo3's main.xml. */
export function cmo3ToModel(xml: string, opts: { name: string }): Cmo3ImportResult {
  const log: string[] = [];
  const warnings: string[] = [];
  const doc = parseXml(xml);
  const g = new Graph(doc);
  const find = (e: XNode, tag: string): XNode | undefined => {
    if (e.tag === tag) return e;
    for (const c of e.children) {
      const r = find(c, tag);
      if (r) return r;
    }
    return undefined;
  };
  const src = find(doc, "CModelSource");
  if (!src) throw new Error("cmo3: main.xml has no model (CModelSource)");
  const uuids: Cmo3ImportResult["uuids"] = new Map();
  const sources = (set: string) => g.list(g.field(src, set), "_sources");

  const canvasNode = g.field(src, "canvas");
  const W = g.num(canvasNode, "pixelWidth");
  const H = g.num(canvasNode, "pixelHeight");
  if (!(W > 0 && H > 0)) throw new Error("cmo3: the canvas has no size");
  /** Canvas pixels (+y down) -> the runtime's root space: canvas-width units around the center. */
  const rootX = (x: number) => (x - W / 2) / W;
  const rootY = (y: number) => (y - H / 2) / W;

  // parameters
  const paramNodes = sources("parameterSourceSet");
  const paramByGuid = new Map<XNode, Parameter>();
  const groupNodes = new Map<XNode, XNode>();
  for (const grp of g.list(g.field(src, "parameterGroupSet"), "_groups")) {
    const guid = g.field(grp, "guid");
    if (guid) groupNodes.set(guid, grp);
  }
  const parameters: Parameter[] = [];
  const morphParams = new Set<Parameter>();
  const paramOrder: XNode[] = [];
  const paramNodeByGuid = new Map(paramNodes.map((pn) => [g.field(pn, "guid"), pn]));
  const walkGroups = (grp: XNode | undefined, depth: number) => {
    for (const c of g.list(grp, "_childGuids")) {
      const pn = paramNodeByGuid.get(c);
      if (pn) paramOrder.push(pn);
      else if (groupNodes.has(c) && depth < 64) walkGroups(groupNodes.get(c), depth + 1);
    }
  };
  walkGroups(g.field(src, "rootParameterGroup"), 0);
  for (const pn of paramNodes) if (!paramOrder.includes(pn)) paramOrder.push(pn);
  for (const pn of paramOrder) {
    const id = g.idstr(pn);
    if (!id) continue;
    const p: Parameter = { id, min: r6(g.num(pn, "minValue")), max: r6(g.num(pn, "maxValue")), default: r6(g.num(pn, "defaultValue")) };
    const name = g.str(pn, "name");
    if (name && name !== id) p.name = name;
    if (g.bool(pn, "isRepeat")) p.repeat = true;
    if (g.bool(pn, "combined")) p.combined = true;
    p.decimals = g.num(pn, "decimalPlaces", 1);
    const grp = groupNodes.get(g.field(pn, "parentGroupGuid")!);
    const gid = grp && g.idstr(grp);
    if (gid) p.group = gid;
    if (g.enumOf(pn, "paramType") === "MORPH_TARGET") morphParams.add(p);
    parameters.push(p);
    const guid = g.field(pn, "guid");
    if (guid) {
      paramByGuid.set(guid, p);
      if (guid.attrs.uuid) uuids.set(guid.attrs.uuid, { kind: "parameter", id });
    }
  }
  const paramOf = (guid: XNode | undefined) => (guid ? paramByGuid.get(guid) : undefined);

  // keyform grids: bindings give the grid axes (first binding varies fastest), keyformsOnGrid place each form
  const gridOf = (o: XNode): { grid: KeyformGrid; forms: XNode[] } => {
    const gs = g.field(o, "keyformGridSource");
    const bindings = g.list(gs, "keyformBindings");
    const grid: KeyformGrid = { params: [], keys: [] };
    for (const b of bindings) {
      const p = paramOf(g.field(b, "parameterGuid"));
      grid.params.push(p?.id ?? "?");
      grid.keys.push(g.list(b, "keys").map((k) => r6(Number(k.text))));
    }
    const strides: number[] = [];
    let size = 1;
    for (const k of grid.keys) {
      strides.push(size);
      size *= Math.max(1, k.length);
    }
    const formByGuid = new Map<XNode, XNode>();
    for (const f of g.list(o, "keyforms")) {
      const guid = g.field(f, "guid");
      if (guid) formByGuid.set(guid, f);
    }
    const forms: XNode[] = new Array(size);
    for (const kg of g.list(gs, "keyformsOnGrid")) {
      let at = 0;
      for (const kp of g.list(g.field(kg, "accessKey"), "_keyOnParameterList")) {
        const bi = bindings.indexOf(g.field(kp, "binding")!);
        if (bi >= 0) at += g.num(kp, "keyIndex") * strides[bi];
      }
      const f = formByGuid.get(g.field(kg, "keyformGuid")!);
      if (f) forms[at] = f;
    }
    for (let k = 0; k < size; k++) if (!forms[k]) throw new Error(`cmo3: ${g.idstr(o) ?? o.tag} is missing keyform ${k}`);
    return { grid, forms };
  };

  const colorOf = (f: XNode, name: string): RGB | undefined => {
    const c = g.field(f, name);
    return c ? [r6(Number(c.attrs.red)), r6(Number(c.attrs.green)), r6(Number(c.attrs.blue))] : undefined;
  };
  const colors = (f: XNode): { multiply?: RGB; screen?: RGB } => {
    const m = colorOf(f, "multiplyColor");
    const s = colorOf(f, "screenColor");
    return {
      ...(m && (m[0] !== 1 || m[1] !== 1 || m[2] !== 1) ? { multiply: m } : {}),
      ...(s && (s[0] !== 0 || s[1] !== 0 || s[2] !== 0) ? { screen: s } : {}),
    };
  };
  const colorDelta = (f: XNode, base: XNode): { multiply?: RGB; screen?: RGB } => {
    const out: { multiply?: RGB; screen?: RGB } = {};
    for (const [key, name, def] of [
      ["multiply", "multiplyColor", 1],
      ["screen", "screenColor", 0],
    ] as const) {
      const a = colorOf(f, name) ?? [def, def, def];
      const b = colorOf(base, name) ?? [def, def, def];
      const d: RGB = [r6(a[0] - b[0]), r6(a[1] - b[1]), r6(a[2] - b[2])];
      if (d[0] || d[1] || d[2]) out[key] = d;
    }
    return out;
  };

  // parts, the scene tree: the root part is the model itself
  const rootPart = g.field(src, "rootPart");
  const partNodes = sources("partSourceSet");
  const nodeByGuid = new Map<XNode, XNode>();
  for (const set of ["partSourceSet", "drawableSourceSet", "deformerSourceSet", "affecterSourceSet"]) {
    for (const o of sources(set)) {
      const guid = g.field(o, "guid");
      if (guid) nodeByGuid.set(guid, o);
    }
  }
  const partIdOf = (guid: XNode | undefined): string | null => {
    const p = guid && nodeByGuid.get(guid);
    return p && p !== rootPart ? (g.idstr(p) ?? null) : null;
  };
  // runtime order: breadth first from the root part
  const partOrder: XNode[] = [];
  for (let level = [rootPart!]; level.length; ) {
    const next: XNode[] = [];
    for (const p of level) {
      for (const c of g.list(p, "_childGuids")) {
        const o = nodeByGuid.get(c);
        if (o?.tag === "CPartSource") {
          partOrder.push(o);
          next.push(o);
        }
      }
    }
    level = next;
  }
  for (const p of partNodes) if (p !== rootPart && !partOrder.includes(p)) partOrder.push(p);
  const labelOf = (o: XNode): string | undefined => {
    const l = g.field(o, "labelColor");
    const type = g.enumOf(l, "labelType");
    if (!l || !type || type === "UNDEFINED") return undefined;
    if (type === "CUSTOM") {
      const argb = Number(l.attrs.customizedColorInt);
      return Number.isFinite(argb) ? "#" + (argb & 0xffffff).toString(16).padStart(6, "0") : undefined;
    }
    return LABELS[type];
  };
  const parts: Part[] = [];
  const partById = new Map<string, Part>();
  const partNodeById = new Map<string, XNode>();
  for (const pn of partOrder) {
    const id = g.idstr(pn);
    if (!id) continue;
    const { grid, forms } = gridOf(pn);
    const p: Part = { id, parent: partIdOf(g.field(pn, "parentGuid")), grid, drawOrders: forms.map((f) => r6(g.num(f, "drawOrder", 500))) };
    const name = g.str(pn, "localName");
    if (name) p.name = name;
    if (!g.bool(pn, "isVisible", true)) p.visible = false;
    if (g.bool(pn, "isLocked")) p.locked = true;
    const label = labelOf(pn);
    if (label) p.label = label;
    parts.push(p);
    partById.set(id, p);
    partNodeById.set(id, pn);
    const pg = g.field(pn, "guid");
    if (pg?.attrs.uuid) uuids.set(pg.attrs.uuid, { kind: "part", id });
  }

  // blend shapes: morph targets of one object, keyed on blend-shape parameters; forms are stored whole and become
  // differences from the object's form at the parameter defaults
  const blendKeys = new Map<Parameter, Set<number>>();
  // the base key (where a blend shape adds nothing) is value 0
  const baseValue = (p: Parameter) => (p.min <= 0 && p.max >= 0 ? 0 : p.default);
  for (const p of morphParams) blendKeys.set(p, new Set([baseValue(p)]));
  const morphTargetsOf = (o: XNode) => g.list(g.field(o, "keyformMorphTargetSet"), "_morphTargets");
  const allSources = ["partSourceSet", "drawableSourceSet", "deformerSourceSet", "affecterSourceSet"].flatMap((s) => sources(s));
  for (const o of allSources) {
    for (const t of morphTargetsOf(o)) {
      const p = paramOf(g.field(t, "parameterGuid"));
      if (p && blendKeys.has(p)) blendKeys.get(p)!.add(r6(g.num(t, "keyValue")));
    }
  }
  for (const [p, keys] of blendKeys) {
    const sorted = [...keys].sort((a, b) => a - b);
    p.blendShape = { keys: sorted, base: sorted.indexOf(baseValue(p)) };
  }
  /** The default-pose form of an object (its grid form nearest the parameter defaults). */
  const baseFormOf = (grid: KeyformGrid, forms: XNode[]): XNode => {
    let at = 0;
    let stride = 1;
    grid.params.forEach((pid, i) => {
      const def = parameters.find((p) => p.id === pid)?.default ?? 0;
      const keys = grid.keys[i];
      let best = 0;
      for (let k = 1; k < keys.length; k++) if (Math.abs(keys[k] - def) < Math.abs(keys[best] - def)) best = k;
      at += best * stride;
      stride *= Math.max(1, keys.length);
    });
    return forms[at];
  };
  const shapesOf = <F>(o: XNode, grid: KeyformGrid, forms: XNode[], diff: (f: XNode, base: XNode) => F, zero: F): Live2DBlendShape<F>[] | undefined => {
    const targets = morphTargetsOf(o);
    if (!targets.length) return undefined;
    const formByGuid = new Map<XNode, XNode>();
    for (const f of g.list(o, "keyforms")) {
      const guid = g.field(f, "guid");
      if (guid) formByGuid.set(guid, f);
    }
    const base = baseFormOf(grid, forms);
    const constraints = g.list(g.field(g.field(o, "keyformMorphTargetSet"), "blendWeightConstraintSet"), "_constraints");
    const out: Live2DBlendShape<F>[] = [];
    const byParam = new Map<Parameter, XNode[]>();
    for (const t of targets) {
      const p = paramOf(g.field(t, "parameterGuid"));
      if (!p?.blendShape) continue;
      if (!byParam.has(p)) byParam.set(p, []);
      byParam.get(p)!.push(t);
    }
    const paramRank = (p: Parameter) => parameters.indexOf(p);
    for (const [p, ts] of [...byParam].sort((x, y) => paramRank(x[0]) - paramRank(y[0]))) {
      const shapeForms = p.blendShape!.keys.map((key) => {
        const t = ts.find((x) => r6(g.num(x, "keyValue")) === key);
        const f = t && formByGuid.get(g.field(t, "keyformGuid")!);
        return f ? diff(f, base) : structuredClone(zero);
      });
      const cons = new Map<Parameter, Array<[number, number]>>();
      for (const c of constraints) {
        if (paramOf(g.field(c, "morphTargetParameterGuid")) !== p) continue;
        const cp = paramOf(g.field(c, "constraintParameterGuid"));
        if (!cp) continue;
        if (!cons.has(cp)) cons.set(cp, []);
        cons.get(cp)!.push([r6(g.num(c, "constraintParameterValue")), r6(g.num(c, "blendWeight"))]);
      }
      const list: Live2DBlendShapeConstraint[] = [...cons].sort((x, y) => paramRank(x[0]) - paramRank(y[0])).map(([cp, values]) => ({ param: cp.id, values: values.sort((a, b) => a[0] - b[0]) }));
      out.push({ param: p.id, forms: shapeForms, ...(list.length ? { constraints: list } : {}) });
    }
    return out.length ? out : undefined;
  };

  // deformers, parents first
  const defNodes = sources("deformerSourceSet");
  const defByGuid = new Map<XNode, XNode>();
  for (const d of defNodes) {
    const guid = g.field(d, "guid");
    if (guid) defByGuid.set(guid, d);
  }
  const parentDef = (o: XNode) => defByGuid.get(g.field(o, "targetDeformerGuid")!);
  /** Whether a deformer's scale is in pixels: some ancestor is a rotation deformer (otherwise canvas-width units). */
  const pixelSpace = (o: XNode): boolean => {
    for (let p = parentDef(o), n = 0; p && n < 256; p = parentDef(p), n++) if (p.tag === "CRotationDeformerSource") return true;
    return false;
  };
  const defOrder: XNode[] = [];
  for (let level: Array<XNode | undefined> = [undefined]; level.length; ) {
    const next: XNode[] = [];
    for (const p of level) for (const d of defNodes) if (parentDef(d) === p) next.push(d);
    defOrder.push(...next);
    level = next;
  }
  const deformers: Deformer[] = [];
  for (const dn of defOrder) {
    const id = g.idstr(dn);
    if (!id) continue;
    const parent = parentDef(dn);
    const pid = parent ? (g.idstr(parent) ?? null) : null;
    const { grid, forms } = gridOf(dn);
    const base = {
      id,
      parent: pid,
      part: partIdOf(g.field(dn, "parentGuid")),
      grid,
      ...(g.bool(dn, "isVisible", true) ? {} : { hidden: true }),
      ...(g.bool(dn, "isLocked") ? { locked: true } : {}),
    };
    const name = g.str(dn, "localName");
    if (dn.tag === "CWarpDeformerSource") {
      const pts = (f: XNode) => {
        const p = g.nums(f, "positions");
        return pid ? p.map(r6) : p.map((v, k) => r6(k % 2 ? rootY(v) : rootX(v)));
      };
      const warpForm = (f: XNode): WarpKeyform => {
        const op = r6(g.num(f, "opacity", 1));
        return { points: pts(f), ...(op !== 1 ? { opacity: op } : {}), ...colors(f) };
      };
      const cols = g.num(dn, "col");
      const rows = g.num(dn, "row");
      const shapes = shapesOf<WarpKeyform>(
        dn,
        grid,
        forms,
        (f, b) => {
          const a = pts(f);
          const bb = pts(b);
          const op = r6(g.num(f, "opacity", 1) - g.num(b, "opacity", 1));
          return { points: a.map((v, k) => r6(v - bb[k])), ...(op ? { opacity: op } : {}), ...colorDelta(f, b) };
        },
        { points: new Array((cols + 1) * (rows + 1) * 2).fill(0) },
      );
      deformers.push({
        ...base,
        type: "warp",
        cols,
        rows,
        ...(g.bool(dn, "isQuadTransform") ? { bilinear: true } : {}),
        forms: forms.map(warpForm),
        ...(shapes ? { blendShapes: shapes } : {}),
        ...(name ? { name } : {}),
      } as Deformer);
    } else if (dn.tag === "CRotationDeformerSource") {
      const rot = (f: XNode): RotationKeyform => {
        const a = f.attrs;
        const x = Number(a.originX);
        const y = Number(a.originY);
        const scale = Number(a.scale);
        const op = r6(g.num(f, "opacity", 1));
        return {
          x: r6(pid ? x : rootX(x)),
          y: r6(pid ? y : rootY(y)),
          angle: r6(Number(a.angle)),
          scale: r6(pixelSpace(dn) ? scale : scale / W),
          ...(a.isReflectX === "true" ? { reflectX: true } : {}),
          ...(a.isReflectY === "true" ? { reflectY: true } : {}),
          ...(op !== 1 ? { opacity: op } : {}),
          ...colors(f),
        };
      };
      const shapes = shapesOf<RotationKeyform>(
        dn,
        grid,
        forms,
        (f, b) => {
          const a = rot(f);
          const bb = rot(b);
          const op = r6(g.num(f, "opacity", 1) - g.num(b, "opacity", 1));
          return { x: r6(a.x - bb.x), y: r6(a.y - bb.y), angle: r6(a.angle - bb.angle), scale: r6(a.scale - bb.scale), ...(op ? { opacity: op } : {}), ...colorDelta(f, b) };
        },
        { x: 0, y: 0, angle: 0, scale: 0 },
      );
      deformers.push({
        ...base,
        type: "rotation",
        baseAngle: r6(g.num(dn, "baseAngle")),
        forms: forms.map(rot),
        ...(shapes ? { blendShapes: shapes } : {}),
        ...(name ? { name } : {}),
      } as Deformer);
    } else warnings.push(`deformer ${id} (${dn.tag}) is not supported: left out`);
  }

  // textures: the atlases, with the image the editor last rendered for each
  const atlases = g.list(g.field(src, "textureManager"), "_textureAtlases");
  const textures: Cmo3Texture[] = [];
  const texIndexByImage = new Map<XNode, number>();
  atlases.forEach((a, k) => {
    const img = g.field(a, "cachedAtlasImage");
    const file = g.field(img, "imageFileBuf")?.attrs.path;
    const id = `texture_${String(k).padStart(2, "0")}`;
    if (img) texIndexByImage.set(img, k);
    if (file) textures.push({ id, entry: file, width: g.num(a, "width"), height: g.num(a, "height") });
    else warnings.push(`texture atlas ${k} has no rendered image: open the model in Cubism Editor and save it once`);
  });

  // art meshes
  const meshNodes = sources("drawableSourceSet").filter((o) => o.tag === "CArtMeshSource");
  const meshIdByGuid = new Map<XNode, string>();
  for (const mn of meshNodes) {
    const guid = g.field(mn, "guid");
    const id = g.idstr(mn);
    if (guid && id) meshIdByGuid.set(guid, id);
  }
  const attachments: Record<string, MeshAttachment> = {};
  const slots: Slot[] = [];
  const uidIndex = new Map<string, Map<number, number>>();
  for (const mn of meshNodes) {
    const id = g.idstr(mn);
    if (!id) continue;
    const parent = parentDef(mn);
    const pid = parent ? (g.idstr(parent) ?? null) : null;
    const { grid, forms } = gridOf(mn);
    const pts = (f: XNode) => {
      const p = g.nums(f, "positions");
      return pid ? p.map(r6) : p.map((v, k) => r6(k % 2 ? rootY(v) : rootX(v)));
    };
    const meshForm = (f: XNode): MeshKeyform => {
      const op = r6(g.num(f, "opacity", 1));
      return { points: pts(f), ...(op !== 1 ? { opacity: op } : {}), drawOrder: r6(g.num(f, "drawOrder", 500)), ...colors(f) };
    };
    const uvs = g.nums(mn, "uvs");
    const vc = uvs.length / 2;
    const idx = g.nums(mn, "indices");
    const tris: Tri[] = [];
    for (let k = 0; k + 2 < idx.length; k += 3) tris.push([idx[k], idx[k + 1], idx[k + 2]]);
    const shapes = shapesOf<MeshKeyform>(
      mn,
      grid,
      forms,
      (f, b) => {
        const a = pts(f);
        const bb = pts(b);
        const op = r6(g.num(f, "opacity", 1) - g.num(b, "opacity", 1));
        const dro = r6(g.num(f, "drawOrder", 500) - g.num(b, "drawOrder", 500));
        return { points: a.map((v, k) => r6(v - bb[k])), ...(op ? { opacity: op } : {}), ...(dro ? { drawOrder: dro } : {}), ...colorDelta(f, b) };
      },
      { points: new Array(vc * 2).fill(0) },
    );
    const texture = g.field(mn, "texture");
    const tex = texIndexByImage.get(g.field(texture, "srcImageResource")!) ?? 0;
    const name = g.str(mn, "localName");
    attachments[id] = {
      type: "mesh",
      image: textures[tex]?.id ?? textures[0]?.id,
      uvs: Array.from({ length: vc }, (_, k): Vec2 => [r6(uvs[k * 2]), r6(uvs[k * 2 + 1])]),
      triangles: tris,
      vertices: [],
      weights: Array.from({ length: vc }, () => [["root", 1]] as Array<[string, number]>),
      live2d: {
        deformer: pid,
        part: partIdOf(g.field(mn, "parentGuid")),
        grid,
        forms: forms.map(meshForm),
        ...(shapes ? { blendShapes: shapes } : {}),
        ...(g.bool(mn, "isVisible", true) ? {} : { hidden: true }),
        ...(g.bool(mn, "isLocked") ? { locked: true } : {}),
        ...(name ? { name } : {}),
      },
    };
    const clip = g
      .list(mn, "clipGuidList")
      .map((c) => meshIdByGuid.get(c))
      .filter((c): c is string => !!c);
    const comp = g.enumOf(mn, "colorComposition") ?? "NORMAL";
    slots.push({
      id,
      bone: "root",
      attachment: id,
      color: "#ffffff",
      ...(comp === "ADD" ? { blend: "additive" as const } : comp === "MULTIPLY" ? { blend: "multiply" as const } : {}),
      ...(clip.length ? { clip: clip.length === 1 ? clip[0] : clip } : {}),
      ...(clip.length && g.bool(mn, "invertClippingMask") ? { clipInvert: true } : {}),
      ...(g.bool(mn, "culling") ? { cull: true } : {}),
    });
    // point uids (glue refers to vertices by uid): the editable mesh lists them in vertex order
    let em: XNode | undefined;
    for (const ext of g.list(mn, "_extensions")) if (ext.tag === "CEditableMeshExtension") em = g.field(ext, "editableMesh");
    const puids = g.nums(em, "pointUid");
    const byUid = new Map(puids.map((u, k) => [u, k]));
    uidIndex.set(id, byUid);
    // deformation paths: control points pinned in triangles (vertex indices), bound vertices by point uid
    const paths: Live2DPath[] = [];
    for (const ext of g.list(mn, "_extensions")) {
      if (ext.tag !== "CControllerExtension") continue;
      const targets = g.list(ext, "targetPoints");
      for (const curve of g.list(ext, "controlCurves")) {
        const curveId = g.field(curve, "curveId");
        const points = g.list(curve, "_curvePoints").map((cp) => {
          const pit = g.field(cp, "pointInTriangle");
          const tri = [g.num(pit, "ptIndex1"), g.num(pit, "ptIndex2"), g.num(pit, "ptIndex3")] as [number, number, number];
          const w = [r6(g.num(pit, "weight1")), r6(g.num(pit, "weight2")), r6(g.num(pit, "weight3"))] as [number, number, number];
          return { tri, w, ...(g.bool(cp, "isCorner") ? { corner: true } : {}) };
        });
        if (points.length < 2 || points.some((p) => p.tri.some((i) => !(i >= 0 && i < vc)))) {
          warnings.push(`${id}: a deformation path could not be read`);
          continue;
        }
        const bind: Live2DPath["bind"] = [];
        for (const tp of targets) {
          const vertex = byUid.get(g.num(g.field(tp, "_point"), "pointUid", -1));
          if (vertex === undefined) continue;
          for (const eff of g.list(tp, "effects")) {
            const at = g.field(eff, "effectorPt");
            if (g.field(at, "curveId") !== curveId) continue;
            bind.push({ vertex, t: r6(g.num(at, "totalT")), weight: r6(Math.min(1, g.num(eff, "weight", 1))) });
          }
        }
        const width = g.num(curve, "lineWidth", 0);
        paths.push({ points, ...(g.bool(curve, "isOpen", true) ? {} : { closed: true }), bind, ...(width > 0 ? { width: r6(width) } : {}) });
      }
    }
    if (paths.length) attachments[id].live2d!.paths = paths;
  }

  // glue
  const glue: Glue[] = [];
  // runtime order (glue is applied in turn): depth first through the part tree
  const treeOrder: XNode[] = [];
  const walkTree = (p: XNode, depth: number) => {
    for (const c of g.list(p, "_childGuids")) {
      const o = nodeByGuid.get(c);
      if (!o) continue;
      treeOrder.push(o);
      if (o.tag === "CPartSource" && depth < 256) walkTree(o, depth + 1);
    }
  };
  walkTree(rootPart!, 0);
  const affecters = sources("affecterSourceSet");
  const glueOrder = [...treeOrder.filter((o) => affecters.includes(o)), ...affecters.filter((o) => !treeOrder.includes(o))];
  for (const gn of glueOrder) {
    if (gn.tag !== "CGlueSource") continue;
    const id = g.idstr(gn);
    const a = meshIdByGuid.get(g.field(gn, "targetArtMeshA_guid")!);
    const b = meshIdByGuid.get(g.field(gn, "targetArtMeshB_guid")!);
    if (!id || !a || !b) continue;
    const uids = g.nums(gn, "bindVertexUids");
    const weights = g.nums(gn, "weights");
    const ua = uidIndex.get(a)!;
    const ub = uidIndex.get(b)!;
    const pairs: number[] = [];
    const w: number[] = [];
    for (let k = 0; k + 1 < uids.length; k += 2) {
      const ia = ua.get(uids[k]);
      const ib = ub.get(uids[k + 1]);
      if (ia === undefined || ib === undefined) continue;
      pairs.push(ia, ib);
      w.push(r6(weights[k] ?? 0.5), r6(weights[k + 1] ?? 0.5));
    }
    const { grid, forms } = gridOf(gn);
    const shapes = shapesOf<number>(gn, grid, forms, (f, base) => r6(g.num(f, "intensity", 1) - g.num(base, "intensity", 1)), 0);
    const gluePart = partIdOf(g.field(gn, "parentGuid"));
    glue.push({ id, a, b, ...(gluePart ? { part: gluePart } : {}), pairs, weights: w, grid, intensity: forms.map((f) => r6(g.num(f, "intensity", 1))), ...(shapes ? { blendShapes: shapes } : {}) });
  }

  // part draw orders and blend shapes need the grids read above
  for (const p of parts) {
    const pn = partNodeById.get(p.id)!;
    const { grid, forms } = gridOf(pn);
    const shapes = shapesOf<number>(pn, grid, forms, (f, base) => r6(g.num(f, "drawOrder", 500) - g.num(base, "drawOrder", 500)), 0);
    if (shapes) p.blendShapes = shapes;
  }

  // draw-order groups: the root, and every part that sorts its own contents. Items are listed in reverse tree order
  // (the runtime keeps that order for equal draw orders); the range covers the items' keyform draw orders.
  const groupPartIds = new Set(parts.filter((p) => g.bool(partNodeById.get(p.id), "enableDrawOrderGroup")).map((p) => p.id));
  const drawOrderGroups: DrawOrderGroup[] = [];
  const buildGroup = (partNode: XNode): number => {
    const gi = drawOrderGroups.length;
    const group: DrawOrderGroup = { min: 0, max: 1000, items: [] };
    drawOrderGroups.push(group);
    const items: DrawOrderGroup["items"] = [];
    const orders: number[] = [];
    const walk = (p: XNode) => {
      for (const c of g.list(p, "_childGuids")) {
        const o = nodeByGuid.get(c);
        if (!o) continue;
        const id = g.idstr(o);
        if (o.tag === "CArtMeshSource" && id && attachments[id]) {
          items.push({ slot: id });
          orders.push(...attachments[id].live2d!.forms.map((f) => f.drawOrder ?? 500));
        } else if (o.tag === "CPartSource" && id) {
          if (groupPartIds.has(id)) {
            items.push({ part: id, group: buildGroup(o) });
            orders.push(...partById.get(id)!.drawOrders);
          } else walk(o);
        }
      }
    };
    walk(partNode);
    group.items = items.reverse();
    if (orders.length) {
      group.min = Math.min(...orders);
      group.max = Math.max(...orders);
    }
    return gi;
  };
  buildGroup(rootPart!);

  // physics (the physics3 settings)
  const physSet = g.field(src, "physicsSettingsSourceSet");
  const kind = (e: XNode): Live2DPhysicsKind => {
    const v = g.enumOf(e, "type") ?? "";
    return v === "SRC_TO_Y" ? "Y" : v === "SRC_TO_G_ANGLE" ? "Angle" : "X";
  };
  const physics: Live2DPhysics = {
    ...(g.num(physSet, "settingFPS") > 0 ? { fps: g.num(physSet, "settingFPS") } : {}),
    gravity: [0, -1],
    wind: [0, 0],
    settings: g.list(physSet, "_sourceCubismPhysics").map((s, k) => {
      const vec = (e: XNode, name: string): Vec2 => {
        const v = g.field(e, name);
        return [g.num(v, "x"), g.num(v, "y")];
      };
      const name = g.str(s, "name");
      return {
        // the runtime export numbers the settings in order
        id: `PhysicsSetting${k + 1}`,
        ...(name ? { name } : {}),
        inputs: g.list(s, "inputs").flatMap((i) => {
          const p = paramOf(g.field(i, "source"));
          return p ? [{ param: p.id, weight: r6(g.num(i, "weight")), type: kind(i), ...(g.bool(i, "isReverse") ? { reflect: true } : {}) }] : [];
        }),
        outputs: g.list(s, "outputs").flatMap((o) => {
          const p = paramOf(g.field(o, "destination"));
          const type = kind(o);
          const ts = vec(o, "translationScale");
          const scale = type === "Angle" ? g.num(o, "angleScale") : type === "Y" ? ts[1] : ts[0];
          return p ? [{ param: p.id, vertex: g.num(o, "vertexIndex"), scale: r6(scale), weight: r6(g.num(o, "weight")), type, ...(g.bool(o, "isReverse") ? { reflect: true } : {}) }] : [];
        }),
        vertices: g.list(s, "vertices").map((v) => {
          const [x, y] = vec(v, "position");
          return { x: r6(x), y: r6(y), mobility: r6(g.num(v, "mobility")), delay: r6(g.num(v, "delay")), acceleration: r6(g.num(v, "acceleration")), radius: r6(g.num(v, "radius")) };
        }),
        normalization: {
          position: { min: r6(g.num(s, "normalizedPositionValueMin")), default: r6(g.num(s, "normalizedPositionDefaultValue")), max: r6(g.num(s, "normalizedPositionValueMax")) },
          angle: { min: r6(g.num(s, "normalizedAngleValueMin")), default: r6(g.num(s, "normalizedAngleDefaultValue")), max: r6(g.num(s, "normalizedAngleValueMax")) },
        },
      };
    }),
  };

  const live2d: Live2DRig = {
    canvas: { width: W, height: H, originX: W / 2, originY: H / 2, pixelsPerUnit: W },
    parts,
    deformers,
    ...(glue.length ? { glue } : {}),
    drawOrderGroups,
    ...(physics.settings.length ? { physics } : {}),
  };
  const displayInfo = {
    Version: 3,
    Parameters: parameters.map((p) => ({ Id: p.id, GroupId: p.group ?? "", Name: p.name ?? p.id })),
    ParameterGroups: [...groupNodes.values()].flatMap((grp) => {
      const id = g.idstr(grp);
      return id ? [{ Id: id, GroupId: "", Name: g.str(grp, "name") ?? id }] : [];
    }),
    Parts: parts.map((p) => ({ Id: p.id, Name: p.name ?? p.id })),
  };
  const model: Model = {
    format: FORMAT_ID,
    name: opts.name,
    target: "live2d",
    meta: {
      live2d: {
        mocVersion: 5,
        canvasFlags: 0,
        meshOrder: slots.map((s) => s.id),
        textures: textures.map((t) => t.id),
        displayInfo,
        treeOrder: treeOrder.flatMap((o) => {
          const id = g.idstr(o);
          const kind = o.tag === "CPartSource" ? "p" : o.tag === "CArtMeshSource" ? "m" : o.tag === "CGlueSource" ? "g" : /Deformer/.test(o.tag) ? "d" : "";
          return id && kind ? [`${kind}:${id}`] : [];
        }),
      },
    },
    images: {},
    bones: [{ id: "root", parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0 }],
    slots,
    attachments,
    animations: {},
    parameters,
    live2d,
  };
  syncLive2DVertices(model);
  const frame = live2dFrame(model, defaultValues(model));
  const rank = new Map(frame.order.map((id, k) => [id, k]));
  const drawn = [...model.slots].filter((s) => rank.has(s.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  model.slots = [...drawn, ...model.slots.filter((s) => !rank.has(s.id))];
  log.push(
    `cmo3: ${meshNodes.length} art meshes, ${deformers.length} deformers, ${parts.length} parts, ${parameters.length} parameters` +
      `${morphParams.size ? ` (${morphParams.size} blend shape)` : ""}, ${glue.length} glue, ${textures.length} texture(s)`,
  );
  return { model, log, warnings, textures, uuids };
}
