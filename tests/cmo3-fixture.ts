// A small synthetic Cubism Editor file (.cmo3) for the importer tests: main.xml written the way the editor
// serializes (xs.id / xs.ref, `super` fields, guids repeated inline) inside a CAFF container.
import { deflateRawSync } from "node:zlib";

let nextId = 0;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Guid objects: the first use defines it (xs.id), later uses refer to it, `inline` repeats it as a new element. */
class Guid {
  id = `#${++nextId}`;
  used = false;
  tag: string;
  uuid: string;
  constructor(tag: string, uuid: string) {
    this.tag = tag;
    this.uuid = uuid;
  }
  el(field?: string, inline = false): string {
    const n = field ? ` xs.n="${field}"` : "";
    if (inline) return `<${this.tag}${n} uuid="${this.uuid}" note="(no debug info)" />`;
    if (this.used) return `<${this.tag}${n} xs.ref="${this.id}" />`;
    this.used = true;
    return `<${this.tag}${n} uuid="${this.uuid}" note="(no debug info)" xs.id="${this.id}" />`;
  }
}
let uuidN = 0;
const guid = (tag: string) => new Guid(tag, `00000000-0000-0000-0000-${String(++uuidN).padStart(12, "0")}`);

const s = (n: string, v: string) => `<s xs.n="${n}">${esc(v)}</s>`;
const b = (n: string, v: boolean) => `<b xs.n="${n}">${v}</b>`;
const i = (n: string, v: number) => `<i xs.n="${n}">${v}</i>`;
const f = (n: string, v: number) => `<f xs.n="${n}">${v}</f>`;
const floats = (n: string, v: number[]) => `<float-array xs.n="${n}" count="${v.length}">${v.join(" ")}</float-array>`;
const ints = (tag: string, n: string, v: number[]) => `<${tag} xs.n="${n}" count="${v.length}">${v.join(" ")}</${tag}>`;
const list = (n: string, items: string[], tag = "carray_list") => `<${tag} xs.n="${n}" count="${items.length}">${items.join("")}</${tag}>`;

interface Binding {
  id: string;
  param: Guid;
  keys: number[];
}

/** keyformGridSource over bindings (first varies fastest), forms in grid order. */
function grid(bindings: Binding[], formGuids: Guid[]): string {
  const sizes = bindings.map((x) => x.keys.length);
  const cells: string[] = [];
  formGuids.forEach((fg, k) => {
    let rest = k;
    const keys = bindings.map((bd, j) => {
      const idx = rest % sizes[j];
      rest = Math.floor(rest / sizes[j]);
      return `<KeyOnParameter><KeyformBindingSource xs.n="binding" xs.ref="${bd.id}" /><i xs.n="keyIndex">${idx}</i></KeyOnParameter>`;
    });
    // listed out of order on purpose: the importer places forms by their access keys
    cells.unshift(`<KeyformOnGrid><KeyformGridAccessKey xs.n="accessKey">${list("_keyOnParameterList", keys, "array_list")}</KeyformGridAccessKey>${fg.el("keyformGuid")}</KeyformOnGrid>`);
  });
  const defs = bindings.map(
    (bd) =>
      `<KeyformBindingSource xs.id="${bd.id}">${bd.param.el("parameterGuid")}<array_list xs.n="keys" count="${bd.keys.length}">${bd.keys.map((k) => `<f>${k}</f>`).join("")}</array_list><InterpolationType xs.n="interpolationType" v="LINEAR" /><s xs.n="description">x</s></KeyformBindingSource>`,
  );
  return `<KeyformGridSource xs.n="keyformGridSource">${list("keyformsOnGrid", cells, "array_list")}<array_list xs.n="keyformBindings" count="${defs.length}">${defs.join("")}</array_list></KeyformGridSource>`;
}
const binding = (param: Guid, keys: number[]): Binding => ({ id: `#${++nextId}`, param, keys });

function controllable(o: { name: string; visible?: boolean; locked?: boolean; parent: Guid | null; grid: string; morph?: string; extensions?: string; label?: string }): string {
  return (
    `<ACParameterControllableSource xs.n="super">${s("localName", o.name)}${b("isVisible", o.visible ?? true)}${b("isLocked", o.locked ?? false)}` +
    (o.parent ? o.parent.el("parentGuid") : `<null xs.n="parentGuid" />`) +
    o.grid +
    (o.morph ?? "") +
    `<carray_list xs.n="_extensions" count="${o.extensions ? 1 : 0}">${o.extensions ?? ""}</carray_list>` +
    (o.label ? `<CLabelColor xs.n="labelColor" customizedColorInt="-1"><CLabelColorType xs.n="labelType" v="${o.label}" /></CLabelColor>` : "") +
    `</ACParameterControllableSource>`
  );
}
/** A form: the ACForm part (guid) inside the kind's form superclass (when it has one), then the form's own fields. */
const form = (guid: Guid, body: string, superTag = "", superBody = "") => {
  const acForm = `<ACForm xs.n="super">${guid.el("guid")}<null xs.n="name" /></ACForm>`;
  return (superTag ? `<${superTag} xs.n="super">${acForm}${superBody}</${superTag}>` : acForm) + body;
};
const color = (n: string, c: [number, number, number]) => `<CFloatColor xs.n="${n}" red="${c[0]}" green="${c[1]}" blue="${c[2]}" alpha="1.0" />`;

export interface Cmo3Fixture {
  xml: string;
  /** The CAFF file: main.xml (zip record, deflated) and a 1x1 atlas PNG. */
  file: Uint8Array;
  atlasPng: Uint8Array;
}

/**
 * Canvas 400 x 200. Parameters (group tree order: ParamB first): ParamA (-1..1), ParamB (-1..1, in group "G"), ParamM
 * (blend shape, 0..1, default 0). Parts: PartA (RED label, locked) holding PartSub (hidden). Warp W1 (root, 1x1,
 * keyed on ParamA [-1, 1] x ParamB [0, 1]); rotation R1 (root) and R2 (under R1); art mesh M1 under W1 (blend shape
 * on ParamM at 1, with a constraint on ParamA), M2 under R2 (hidden, pixels), M3 at the root (screen color, ADD).
 * Glue M1 <-> M3 by point uids. One physics setting.
 */
export function cmo3Fixture(key = -0x1234567): Cmo3Fixture {
  nextId = 0;
  uuidN = 0;
  const pA = guid("CParameterGuid");
  const pB = guid("CParameterGuid");
  const pM = guid("CParameterGuid");
  const gG = guid("CParameterGroupGuid");
  const gRoot = guid("CParameterGroupGuid");
  const root = guid("CPartGuid");
  const partA = guid("CPartGuid");
  const partSub = guid("CPartGuid");
  const w1 = guid("CDeformerGuid");
  const r1 = guid("CDeformerGuid");
  const r2 = guid("CDeformerGuid");
  const rootDef = guid("CDeformerGuid");
  const m1 = guid("CDrawableGuid");
  const m2 = guid("CDrawableGuid");
  const m3 = guid("CDrawableGuid");
  const atlasImg = `#${++nextId}`;
  const F = () => guid("CFormGuid");

  const param = (g: Guid, id: string, min: number, max: number, def: number, type: string, group: Guid) =>
    `<CParameterSource>${i("decimalPlaces", 1)}${g.el("guid")}${f("minValue", min)}${f("maxValue", max)}${f("defaultValue", def)}${b("isRepeat", false)}<CParameterId xs.n="id" idstr="${id}" /><Type xs.n="paramType" v="${type}" />${s("name", id + " name")}${group.el("parentGroupGuid")}</CParameterSource>`;
  const params = [param(pA, "ParamA", -1, 1, 0, "NORMAL", gRoot), param(pB, "ParamB", -1, 1, 0, "NORMAL", gG), param(pM, "ParamM", 0, 1, 0, "MORPH_TARGET", gRoot)];
  const groups =
    `<CParameterGroup>${s("name", "Root")}${gRoot.el("guid")}${list("_childGuids", [gG.el(), pA.el(undefined, true), pM.el()])}<CParameterGroupId xs.n="id" idstr="ParamGroupRoot" /></CParameterGroup>` +
    `<CParameterGroup>${s("name", "Group G")}${gG.el("guid")}${list("_childGuids", [pB.el()])}<CParameterGroupId xs.n="id" idstr="ParamGroupG" /></CParameterGroup>`;

  const partForm = (d: number) => {
    const fg = F();
    return { guid: fg, xml: `<CPartForm>${form(fg, i("drawOrder", d))}</CPartForm>` };
  };
  const part = (g: Guid, id: string, name: string, parent: Guid | null, kids: string[], extra: { visible?: boolean; locked?: boolean; label?: string; group?: boolean } = {}) => {
    const pf = partForm(500);
    return `<CPartSource>${controllable({ name, parent, visible: extra.visible, locked: extra.locked, label: extra.label, grid: grid([], [pf.guid]) })}${g.el("guid")}<CPartId xs.n="id" idstr="${id}" />${b("enableDrawOrderGroup", !!extra.group)}${list("_childGuids", kids)}${rootDef.el("targetDeformerGuid")}${list("keyforms", [pf.xml])}</CPartSource>`;
  };

  // W1: 1x1 lattice at the root in canvas pixels, keyed ParamA [-1, 1] x ParamB [0, 1]
  const bA = binding(pA, [-1, 1]);
  const bB = binding(pB, [0, 1]);
  const wForms = [F(), F(), F(), F()];
  const lattice = (dx: number, dy: number) => [100 + dx, 50 + dy, 300 + dx, 50 + dy, 100 + dx, 150 + dy, 300 + dx, 150 + dy];
  const wShift = [
    [0, 0],
    [40, 0],
    [0, 20],
    [40, 20],
  ];
  const warp = `<CWarpDeformerSource><ACDeformerSource xs.n="super">${controllable({ name: "Warp one", parent: partA, grid: grid([bA, bB], wForms) })}${w1.el("guid")}<CDeformerId xs.n="id" idstr="W1" />${rootDef.el("targetDeformerGuid")}</ACDeformerSource>${i("col", 1)}${i("row", 1)}${b("isQuadTransform", true)}${list(
    "keyforms",
    wForms.map((fg, k) => `<CWarpDeformerForm>${form(fg, "", "ACDeformerForm", f("opacity", k === 3 ? 0.5 : 1))}${floats("positions", lattice(wShift[k][0], wShift[k][1]))}</CWarpDeformerForm>`),
  )}</CWarpDeformerSource>`;

  const rot = (g: Guid, id: string, parent: Guid, x: number, y: number, scale: number) => {
    const fg = F();
    return `<CRotationDeformerSource><ACDeformerSource xs.n="super">${controllable({ name: id, parent: partA, grid: grid([], [fg]) })}${g.el("guid")}<CDeformerId xs.n="id" idstr="${id}" />${parent.el("targetDeformerGuid")}</ACDeformerSource>${f("baseAngle", 0)}${list(
      "keyforms",
      [`<CRotationDeformerForm angle="10.0" originX="${x}" originY="${y}" scale="${scale}" isReflectX="false" isReflectY="true">${form(fg, "", "ACDeformerForm", f("opacity", 1))}</CRotationDeformerForm>`],
    )}</CRotationDeformerSource>`;
  };

  const editable = (uids: number[]) =>
    `<CEditableMeshExtension><GEditableMesh2 xs.n="editableMesh">${ints("int-array", "pointUid", uids)}</GEditableMesh2></CEditableMeshExtension>`;
  const mesh = (o: { g: Guid; id: string; name: string; parent: Guid; part: Guid; pts: number[]; uids: number[]; visible?: boolean; comp?: string; screen?: [number, number, number]; morph?: { form: Guid; pts: number[] }; path?: string }) => {
    const fg = F();
    const morph = o.morph
      ? `<KeyFormMorphTargetSet xs.n="keyformMorphTargetSet"><carray_list xs.n="_morphTargets" count="1"><KeyFormMorphTarget>${pM.el("parameterGuid")}${f("keyValue", 1)}${o.morph.form.el("keyformGuid")}</KeyFormMorphTarget></carray_list><MorphTargetBlendWeightConstraintSet xs.n="blendWeightConstraintSet"><carray_list xs.n="_constraints" count="2"><MorphTargetBlendWeightConstraint>${pM.el("morphTargetParameterGuid")}${pA.el("constraintParameterGuid")}${f("constraintParameterValue", 1)}${f("blendWeight", 0)}</MorphTargetBlendWeightConstraint><MorphTargetBlendWeightConstraint>${pM.el("morphTargetParameterGuid")}${pA.el("constraintParameterGuid")}${f("constraintParameterValue", 0)}${f("blendWeight", 1)}</MorphTargetBlendWeightConstraint></carray_list></MorphTargetBlendWeightConstraintSet></KeyFormMorphTargetSet>`
      : "";
    const drawForm = (g: Guid, pts: number[]) =>
      `<CArtMeshForm>${form(g, "", "ACDrawableForm", `${i("drawOrder", 500)}${f("opacity", 1)}${color("multiplyColor", [1, 1, 1])}${color("screenColor", o.screen ?? [0, 0, 0])}`)}${floats("positions", pts)}</CArtMeshForm>`;
    const forms = [drawForm(fg, o.pts), ...(o.morph ? [drawForm(o.morph.form, o.morph.pts)] : [])];
    return `<CArtMeshSource><ACDrawableSource xs.n="super">${controllable({ name: o.name, parent: o.part, visible: o.visible, grid: grid([], [fg]), morph, extensions: editable(o.uids) + (o.path ?? "") })}<CDrawableId xs.n="id" idstr="${o.id}" />${o.g.el("guid")}${o.parent.el("targetDeformerGuid")}${list("clipGuidList", [])}${b("invertClippingMask", false)}</ACDrawableSource>${ints("int-array", "indices", [0, 1, 2])}${list("keyforms", forms)}${floats("uvs", [0, 0, 1, 0, 0, 1])}<GTexture2D xs.n="texture"><CImageResource xs.n="srcImageResource" xs.ref="${atlasImg}" /></GTexture2D><ColorComposition xs.n="colorComposition" v="${o.comp ?? "NORMAL"}" />${b("culling", false)}</CArtMeshSource>`;
  };
  // a deformation path on M1: from vertex 0 to vertex 1 (control points pinned there), vertex 2 (uid 9) bound halfway
  const controller = () => {
    const curve = guid("CControllerCurveGuid");
    const pin = (k: number, corner: boolean) =>
      `<CControllerPoint>${b("isCorner", corner)}<PointInTriangle xs.n="pointInTriangle">${[0, 1, 2].map((j) => `${i(`ptIndex${j + 1}`, j)}${f(`weight${j + 1}`, j === k ? 1 : 0)}`).join("")}</PointInTriangle></CControllerPoint>`;
    return (
      `<CControllerExtension>${list("controlCurves", [`<CControllerCurve>${f("lineWidth", 50)}${b("isOpen", true)}${list("_curvePoints", [pin(0, false), pin(1, true)])}${curve.el("curveId")}</CControllerCurve>`])}` +
      `${list("targetPoints", [`<TargetPoint><MeshPointRef xs.n="_point"><l xs.n="pointUid">9</l></MeshPointRef>${list("effects", [`<Effect><PointOnCurve xs.n="effectorPt">${curve.el("curveId")}${f("totalT", 0.5)}</PointOnCurve>${f("weight", 0.75)}</Effect>`])}</TargetPoint>`])}</CControllerExtension>`
    );
  };
  const meshes = [
    mesh({ g: m1, id: "M1", name: "Mesh one", parent: w1, part: partA, pts: [0, 0, 1, 0, 0, 1], uids: [7, 8, 9], morph: { form: F(), pts: [0, 0.5, 1, 0.5, 0, 1] }, path: controller() }),
    mesh({ g: m2, id: "M2", name: "Mesh two", parent: r2, part: partSub, pts: [0, 0, 10, 0, 0, 10], uids: [0, 1, 2], visible: false }),
    mesh({ g: m3, id: "M3", name: "Mesh three", parent: rootDef, part: partA, pts: [200, 100, 240, 100, 200, 140], uids: [20, 21, 22], comp: "ADD", screen: [0.25, 0, 0] }),
  ];

  const glueGuid = guid("CAffecterGuid");
  const glueForm = F();
  const glue = `<CGlueSource><ACAffecterSource xs.n="super">${controllable({ name: "Glue", parent: partA, grid: grid([], [glueForm]) })}${glueGuid.el("guid")}<CAffecterId xs.n="id" idstr="Glue__M1__M3" /></ACAffecterSource>${floats("weights", [0.25, 0.75])}${list(
    "keyforms",
    [`<CGlueForm>${form(glueForm, "", "ACAffecterForm")}${f("intensity", 0.8)}</CGlueForm>`],
  )}${m1.el("targetArtMeshA_guid", true)}${m3.el("targetArtMeshB_guid")}${ints("long-array", "bindVertexUids", [9, 21])}</CGlueSource>`;

  const physics = `<CPhysicsSettingsSourceSet xs.n="physicsSettingsSourceSet"><carray_list xs.n="_sourceCubismPhysics" count="1"><CPhysicsSettingsSource>${s("name", "Sway")}<CPhysicsSettingId xs.n="id" idstr="PhysicsSetting7" /><carray_list xs.n="inputs" count="1"><CPhysicsInput>${pA.el("source")}${f("weight", 60)}<CPhysicsSourceType xs.n="type" v="SRC_TO_X" />${b("isReverse", false)}</CPhysicsInput></carray_list><carray_list xs.n="outputs" count="1"><CPhysicsOutput>${pB.el("destination")}${i("vertexIndex", 1)}<GVector2 xs.n="translationScale"><f xs.n="x">0</f><f xs.n="y">0</f></GVector2>${f("angleScale", 1.5)}${f("weight", 100)}<CPhysicsSourceType xs.n="type" v="SRC_TO_G_ANGLE" />${b("isReverse", true)}</CPhysicsOutput></carray_list><carray_list xs.n="vertices" count="2"><CPhysicsVertex><GVector2 xs.n="position"><f xs.n="x">0</f><f xs.n="y">0</f></GVector2>${f("mobility", 1)}${f("delay", 1)}${f("acceleration", 1)}${f("radius", 0)}</CPhysicsVertex><CPhysicsVertex><GVector2 xs.n="position"><f xs.n="x">0</f><f xs.n="y">3</f></GVector2>${f("mobility", 0.95)}${f("delay", 0.9)}${f("acceleration", 1.5)}${f("radius", 3)}</CPhysicsVertex></carray_list>${f("normalizedPositionValueMax", 10)}${f("normalizedPositionValueMin", -10)}${f("normalizedPositionDefaultValue", 0)}${f("normalizedAngleValueMax", 10)}${f("normalizedAngleValueMin", -10)}${f("normalizedAngleDefaultValue", 0)}</CPhysicsSettingsSource></carray_list>${i("settingFPS", 30)}</CPhysicsSettingsSourceSet>`;

  const rootPartXml = part(root, "__RootPart__", "Root Part", null, [partA.el()]);
  const partAXml = part(partA, "PartA", "Part A", root, [w1.el(), r1.el(), r2.el(), m1.el(), m3.el(), partSub.el(), glueGuid.el()], { locked: true, label: "RED" });
  const partSubXml = part(partSub, "PartSub", "Sub part", partA, [m2.el()], { visible: false });

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<?version CModelSource:13?>\n<root fileFormatVersion="402030000">` +
    `<CModelSource>` +
    `<CImageCanvas xs.n="canvas">${i("pixelWidth", 400)}${i("pixelHeight", 200)}</CImageCanvas>` +
    `<CParameterSourceSet xs.n="parameterSourceSet">${list("_sources", params)}</CParameterSourceSet>` +
    `<CTextureManager xs.n="textureManager"><carray_list xs.n="_textureAtlases" count="1"><CTextureAtlas>${i("width", 1)}${i("height", 1)}<CImageResource xs.n="cachedAtlasImage" width="1" height="1" xs.id="${atlasImg}"><file xs.n="imageFileBuf" path="imageFileBuf_0.png" /></CImageResource></CTextureAtlas></carray_list></CTextureManager>` +
    `<CDrawableSourceSet xs.n="drawableSourceSet">${list("_sources", meshes)}</CDrawableSourceSet>` +
    `<CDeformerSourceSet xs.n="deformerSourceSet">${list("_sources", [rot(r2, "R2", r1, 5, -5, 2), warp, rot(r1, "R1", rootDef, 300, 60, 1)])}</CDeformerSourceSet>` +
    `<CAffecterSourceSet xs.n="affecterSourceSet">${list("_sources", [glue])}</CAffecterSourceSet>` +
    `<CPartSourceSet xs.n="partSourceSet">${list("_sources", [partSubXml, rootPartXml, partAXml])}</CPartSourceSet>` +
    physics +
    `<CPartSource xs.n="rootPart" xs.ref="#rootpart" />` +
    `<CParameterGroupSet xs.n="parameterGroupSet">${list("_groups", groups.split("</CParameterGroup>").filter(Boolean).map((x) => x + "</CParameterGroup>"))}</CParameterGroupSet>` +
    `<CParameterGroup xs.n="rootParameterGroup" xs.ref="#rootgroup" />` +
    `</CModelSource></root>`;
  // the root part and group are referenced by id: give the defining elements those ids
  const fixed = xml
    .replace(`<CPartSource><ACParameterControllableSource xs.n="super"><s xs.n="localName">Root Part</s>`, `<CPartSource xs.id="#rootpart"><ACParameterControllableSource xs.n="super"><s xs.n="localName">Root Part</s>`)
    .replace(`<CParameterGroup><s xs.n="name">Root</s>`, `<CParameterGroup xs.id="#rootgroup"><s xs.n="name">Root</s>`);

  const atlasPng = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  return { xml: fixed, file: caff([{ path: "imageFileBuf_0.png", data: atlasPng, compress: false }, { path: "main.xml", data: new TextEncoder().encode(fixed), compress: true }], key), atlasPng };
}

/** Writes a CAFF container (obfuscated entries; compressed ones as a zip local-file record). */
export function caff(files: Array<{ path: string; data: Uint8Array; compress: boolean }>, key: number): Uint8Array {
  const kb = key & 0xff;
  const bodies = files.map((x) => {
    if (!x.compress) return x.data;
    const name = new TextEncoder().encode(x.path);
    const deflated = deflateRawSync(x.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(8, 6); // data descriptor follows
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(name.length, 26);
    return new Uint8Array(Buffer.concat([h, name, deflated, Buffer.alloc(16)]));
  });
  // the table has fixed-width offsets: build it once to learn its size, then with the real offsets
  const build = (base: number) => {
    const table: number[] = [];
    const int = (v: number) => {
      const x = (v ^ key) >>> 0;
      table.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
    };
    const str = (t: string) => {
      const u = new TextEncoder().encode(t);
      table.push((u.length ^ kb) & 255, ...Array.from(u, (c) => (c ^ kb) & 255));
    };
    let offset = base;
    int(files.length);
    files.forEach((x, k) => {
      str(x.path);
      str(x.compress ? "main_xml" : "");
      const hi = (Math.floor(offset / 2 ** 32) ^ (key < 0 ? -1 : key)) >>> 0;
      table.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
      int(offset);
      int(bodies[k].length);
      table.push((1 ^ kb) & 255, ((x.compress ? 33 : 16) ^ kb) & 255, 0, 0, 0, 0, 0, 0, 0, 0);
      offset += bodies[k].length;
    });
    return table;
  };
  const table = build(54 + build(0).length);
  const head = Buffer.alloc(54);
  head.write("CAFF", 0, "latin1");
  head.write("----", 7, "latin1");
  head.writeInt32BE(key, 14);
  const out = Buffer.concat([head, Buffer.from(table), ...bodies.map((d) => Buffer.from(d.map((c) => c ^ kb)))]);
  return new Uint8Array(out);
}

/**
 * A Cubism animation file (.can3) for the fixture model: scene "wave" (30 fps, work area frames 0..30) animating
 * ParamA (keys at frames -15 (smooth), 15 (linear to) 45: cut at both ends of the work area) and PartA's opacity
 * (stepped), plus a curve for a parameter the model does not have.
 */
export function can3Fixture(key = 0x2345678): Uint8Array {
  const pA = "00000000-0000-0000-0000-000000000001"; // ParamA's guid in cmo3Fixture
  const partA = "00000000-0000-0000-0000-000000000007";
  const key3 = (pos: number, v: number, next: number, prev: number) =>
    `<CBezierPt><CSeqPt xs.n="anchor">${b("isCorner", false)}${i("pos", pos)}<d xs.n="doubleValue">${v}</d></CSeqPt><CBezierCtrlPt xs.n="next">${f("posF", next)}<d xs.n="doubleValue">${v}</d></CBezierCtrlPt><CBezierCtrlPt xs.n="prev">${f("posF", prev)}<d xs.n="doubleValue">${v}</d></CBezierCtrlPt></CBezierPt>`;
  const attr = (id: string, tag: string, uuid: string, keys: string[], types: string[]) =>
    `<CMvAttrF xs.id="#a${id}"><ICMvAttr xs.n="super"><CAttrId xs.n="id" idstr="${id}" /><s xs.n="name">${id}</s><${tag} xs.n="guid" uuid="${uuid}" /><hash_map xs.n="optionParam" count="0" keyType="string" /><CMvTrack_Live2DModel_Source xs.n="track" xs.ref="#track" /></ICMvAttr><CMutableSequence xs.n="valueData"><array xs.n="points" count="${keys.length}" type="CBezierPt">${keys.join("")}</array>${list("curveTypes", types.map((v) => `<CCurveType v="${v}" />`))}</CMutableSequence></CMvAttrF>`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>
<root>` +
    `<CSceneSource xs.id="#scene">${s("sceneName", "wave")}<CTrackSourceSet xs.n="trackSourceSet">${list("_sources", [`<CMvTrack_Live2DModel_Source xs.ref="#track" />`])}</CTrackSourceSet>` +
    `<CMvMovieInfo xs.n="movieInfo">${i("duration", 60)}<d xs.n="fps">30.0</d>${i("workspaceStart", 0)}${i("workspaceEnd", 30)}${i("fadeInMSec", 500)}${i("fadeOutMSec", -1)}${b("isBezierRestricted", false)}</CMvMovieInfo></CSceneSource>` +
    `<CMvTrack_Live2DModel_Source xs.id="#track"><s xs.n="name">fx</s></CMvTrack_Live2DModel_Source>` +
    attr("live2dParam_ParamA", "CParameterGuid", pA, [key3(-15, 0, -5, -15), key3(15, 1, 25, 5), key3(45, 0, 45, 35)], ["SMOOTH", "LINEAR", "SMOOTH"]) +
    attr("live2DPartsOpacity_PartA", "CPartGuid", partA, [key3(0, 1, 0, 0), key3(10, 0, 10, 10)], ["STEP", "STEP"]) +
    attr("live2dParam_ParamGone", "CParameterGuid", "99999999-0000-0000-0000-000000000000", [key3(0, 1, 0, 0)], ["SMOOTH"]) +
    `</root>`;
  return caff([{ path: "main.xml", data: new TextEncoder().encode(xml), compress: true }], key);
}
