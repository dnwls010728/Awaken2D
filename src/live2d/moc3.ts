// Live2D Cubism .moc3 binary reader / writer (pure, browser-safe).
//
// Layout: a 64-byte header ("MOC3", version byte, endian byte), a section offset table of 160 u32 file offsets at
// 0x40, reserved space up to 1984, then the body: a count table, the canvas block and ~140 typed arrays (struct of
// arrays), each 64-byte aligned except the 64-byte id strings. Each offset-table slot points at one array; the slot
// order is the body order. Field names follow the community format notes (OpenL2D MOC3 spec, moc3-rs).

export type Moc3Version = 1 | 2 | 3 | 4 | 5; // 3.0, 3.3, 4.0, 4.2, 5.0

type FieldType = "i32" | "u32" | "f32" | "bool" | "u8" | "i16" | "id" | "runtime";

/** Counts, in count-table order (index = position in the table). */
export const COUNT_NAMES = [
  "parts",
  "deformers",
  "warpDeformers",
  "rotationDeformers",
  "artMeshes",
  "parameters",
  "partKeyforms",
  "warpDeformerKeyforms",
  "rotationDeformerKeyforms",
  "artMeshKeyforms",
  "keyformPositions",
  "parameterBindingIndices",
  "keyformBindings",
  "parameterBindings",
  "keys",
  "uvs",
  "positionIndices",
  "drawableMasks",
  "drawOrderGroups",
  "drawOrderGroupObjects",
  "glue",
  "glueInfo",
  "glueKeyforms",
  // 4.2+
  "keyformMultiplyColors",
  "keyformScreenColors",
  "blendShapeParameterBindings",
  "blendShapeKeyformBindings",
  "blendShapesWarpDeformers",
  "blendShapesArtMeshes",
  "blendShapeConstraintIndices",
  "blendShapeConstraints",
  "blendShapeConstraintValues",
  // 5.0+
  "blendShapesParts",
  "blendShapesRotationDeformers",
  "blendShapesGlue",
] as const;
export type CountName = (typeof COUNT_NAMES)[number];

interface Field {
  name: string;
  type: FieldType;
  count: CountName;
  since: Moc3Version;
}

const F = (name: string, type: FieldType, count: CountName, since: Moc3Version = 1): Field => ({ name, type, count, since });

/** Every array of the body in offset-table order (slots 2..). */
export const FIELDS: Field[] = [
  F("part.runtime", "runtime", "parts"),
  F("part.ids", "id", "parts"),
  F("part.keyformBinding", "i32", "parts"),
  F("part.keyformBegin", "i32", "parts"),
  F("part.keyformCount", "i32", "parts"),
  F("part.visible", "bool", "parts"),
  F("part.enabled", "bool", "parts"),
  F("part.parentPart", "i32", "parts"),

  F("deformer.runtime", "runtime", "deformers"),
  F("deformer.ids", "id", "deformers"),
  F("deformer.keyformBinding", "i32", "deformers"),
  F("deformer.visible", "bool", "deformers"),
  F("deformer.enabled", "bool", "deformers"),
  F("deformer.parentPart", "i32", "deformers"),
  F("deformer.parentDeformer", "i32", "deformers"),
  F("deformer.type", "i32", "deformers"),
  F("deformer.specific", "i32", "deformers"),

  F("warp.keyformBinding", "i32", "warpDeformers"),
  F("warp.keyformBegin", "i32", "warpDeformers"),
  F("warp.keyformCount", "i32", "warpDeformers"),
  F("warp.vertexCount", "i32", "warpDeformers"),
  F("warp.rows", "u32", "warpDeformers"),
  F("warp.cols", "u32", "warpDeformers"),

  F("rotation.keyformBinding", "i32", "rotationDeformers"),
  F("rotation.keyformBegin", "i32", "rotationDeformers"),
  F("rotation.keyformCount", "i32", "rotationDeformers"),
  F("rotation.baseAngle", "f32", "rotationDeformers"),

  F("artMesh.runtime0", "runtime", "artMeshes"),
  F("artMesh.runtime1", "runtime", "artMeshes"),
  F("artMesh.runtime2", "runtime", "artMeshes"),
  F("artMesh.runtime3", "runtime", "artMeshes"),
  F("artMesh.ids", "id", "artMeshes"),
  F("artMesh.keyformBinding", "i32", "artMeshes"),
  F("artMesh.keyformBegin", "i32", "artMeshes"),
  F("artMesh.keyformCount", "i32", "artMeshes"),
  F("artMesh.visible", "bool", "artMeshes"),
  F("artMesh.enabled", "bool", "artMeshes"),
  F("artMesh.parentPart", "i32", "artMeshes"),
  F("artMesh.parentDeformer", "i32", "artMeshes"),
  F("artMesh.texture", "u32", "artMeshes"),
  F("artMesh.flags", "u8", "artMeshes"),
  F("artMesh.vertexCount", "i32", "artMeshes"),
  F("artMesh.uvBegin", "i32", "artMeshes"),
  F("artMesh.indexBegin", "i32", "artMeshes"),
  F("artMesh.indexCount", "i32", "artMeshes"),
  F("artMesh.maskBegin", "i32", "artMeshes"),
  F("artMesh.maskCount", "i32", "artMeshes"),

  F("parameter.runtime", "runtime", "parameters"),
  F("parameter.ids", "id", "parameters"),
  F("parameter.max", "f32", "parameters"),
  F("parameter.min", "f32", "parameters"),
  F("parameter.default", "f32", "parameters"),
  F("parameter.repeat", "bool", "parameters"),
  F("parameter.decimals", "u32", "parameters"),
  F("parameter.bindingBegin", "i32", "parameters"),
  F("parameter.bindingCount", "i32", "parameters"),

  F("partKeyform.drawOrder", "f32", "partKeyforms"),

  F("warpKeyform.opacity", "f32", "warpDeformerKeyforms"),
  F("warpKeyform.positionBegin", "i32", "warpDeformerKeyforms"),

  F("rotationKeyform.opacity", "f32", "rotationDeformerKeyforms"),
  F("rotationKeyform.angle", "f32", "rotationDeformerKeyforms"),
  F("rotationKeyform.x", "f32", "rotationDeformerKeyforms"),
  F("rotationKeyform.y", "f32", "rotationDeformerKeyforms"),
  F("rotationKeyform.scale", "f32", "rotationDeformerKeyforms"),
  F("rotationKeyform.reflectX", "bool", "rotationDeformerKeyforms"),
  F("rotationKeyform.reflectY", "bool", "rotationDeformerKeyforms"),

  F("artMeshKeyform.opacity", "f32", "artMeshKeyforms"),
  F("artMeshKeyform.drawOrder", "f32", "artMeshKeyforms"),
  F("artMeshKeyform.positionBegin", "i32", "artMeshKeyforms"),

  F("positions", "f32", "keyformPositions"),
  F("parameterBindingIndices", "i32", "parameterBindingIndices"),
  F("keyformBinding.begin", "i32", "keyformBindings"),
  F("keyformBinding.count", "i32", "keyformBindings"),
  F("parameterBinding.keysBegin", "i32", "parameterBindings"),
  F("parameterBinding.keysCount", "i32", "parameterBindings"),
  F("keys", "f32", "keys"),
  F("uvs", "f32", "uvs"),
  F("positionIndices", "i16", "positionIndices"),
  F("drawableMasks", "i32", "drawableMasks"),

  F("drawOrderGroup.objectBegin", "i32", "drawOrderGroups"),
  F("drawOrderGroup.objectCount", "i32", "drawOrderGroups"),
  F("drawOrderGroup.objectTotal", "i32", "drawOrderGroups"),
  F("drawOrderGroup.maxDrawOrder", "u32", "drawOrderGroups"),
  F("drawOrderGroup.minDrawOrder", "u32", "drawOrderGroups"),
  F("drawOrderObject.type", "i32", "drawOrderGroupObjects"),
  F("drawOrderObject.index", "i32", "drawOrderGroupObjects"),
  F("drawOrderObject.selfGroup", "i32", "drawOrderGroupObjects"),

  F("glue.runtime", "runtime", "glue"),
  F("glue.ids", "id", "glue"),
  F("glue.keyformBinding", "i32", "glue"),
  F("glue.keyformBegin", "i32", "glue"),
  F("glue.keyformCount", "i32", "glue"),
  F("glue.meshA", "i32", "glue"),
  F("glue.meshB", "i32", "glue"),
  F("glue.infoBegin", "i32", "glue"),
  F("glue.infoCount", "i32", "glue"),
  F("glueInfo.weight", "f32", "glueInfo"),
  F("glueInfo.positionIndex", "i16", "glueInfo"),
  F("glueKeyform.intensity", "f32", "glueKeyforms"),

  // 3.3+
  F("warp.quad", "bool", "warpDeformers", 2),

  // 4.2+
  F("parameterExt.runtime", "runtime", "parameters", 4),
  F("parameterExt.keysBegin", "i32", "parameters", 4),
  F("parameterExt.keysCount", "i32", "parameters", 4),
  F("warp.colorBegin", "i32", "warpDeformers", 4),
  F("rotation.colorBegin", "i32", "rotationDeformers", 4),
  F("artMesh.colorBegin", "i32", "artMeshes", 4),
  F("multiplyColor.r", "f32", "keyformMultiplyColors", 4),
  F("multiplyColor.g", "f32", "keyformMultiplyColors", 4),
  F("multiplyColor.b", "f32", "keyformMultiplyColors", 4),
  F("screenColor.r", "f32", "keyformScreenColors", 4),
  F("screenColor.g", "f32", "keyformScreenColors", 4),
  F("screenColor.b", "f32", "keyformScreenColors", 4),
  F("parameter.type", "i32", "parameters", 4),
  F("parameter.blendShapeBindingBegin", "i32", "parameters", 4),
  F("parameter.blendShapeBindingCount", "i32", "parameters", 4),
  F("blendShapeParameterBinding.keysBegin", "i32", "blendShapeParameterBindings", 4),
  F("blendShapeParameterBinding.keysCount", "i32", "blendShapeParameterBindings", 4),
  F("blendShapeParameterBinding.baseKey", "i32", "blendShapeParameterBindings", 4),
  F("blendShapeKeyformBinding.parameterBinding", "i32", "blendShapeKeyformBindings", 4),
  F("blendShapeKeyformBinding.keyformBegin", "i32", "blendShapeKeyformBindings", 4),
  F("blendShapeKeyformBinding.keyformCount", "i32", "blendShapeKeyformBindings", 4),
  F("blendShapeKeyformBinding.constraintBegin", "i32", "blendShapeKeyformBindings", 4),
  F("blendShapeKeyformBinding.constraintCount", "i32", "blendShapeKeyformBindings", 4),
  F("blendShapeWarp.target", "i32", "blendShapesWarpDeformers", 4),
  F("blendShapeWarp.bindingBegin", "i32", "blendShapesWarpDeformers", 4),
  F("blendShapeWarp.bindingCount", "i32", "blendShapesWarpDeformers", 4),
  F("blendShapeArtMesh.target", "i32", "blendShapesArtMeshes", 4),
  F("blendShapeArtMesh.bindingBegin", "i32", "blendShapesArtMeshes", 4),
  F("blendShapeArtMesh.bindingCount", "i32", "blendShapesArtMeshes", 4),
  F("blendShapeConstraintIndices", "i32", "blendShapeConstraintIndices", 4),
  F("blendShapeConstraint.parameter", "i32", "blendShapeConstraints", 4),
  F("blendShapeConstraint.valueBegin", "i32", "blendShapeConstraints", 4),
  F("blendShapeConstraint.valueCount", "i32", "blendShapeConstraints", 4),
  F("blendShapeConstraintValue.key", "f32", "blendShapeConstraintValues", 4),
  F("blendShapeConstraintValue.weight", "f32", "blendShapeConstraintValues", 4),

  // 5.0+
  F("warpKeyform.multiplyBegin", "i32", "warpDeformerKeyforms", 5),
  F("warpKeyform.screenBegin", "i32", "warpDeformerKeyforms", 5),
  F("rotationKeyform.multiplyBegin", "i32", "rotationDeformerKeyforms", 5),
  F("rotationKeyform.screenBegin", "i32", "rotationDeformerKeyforms", 5),
  F("artMeshKeyform.multiplyBegin", "i32", "artMeshKeyforms", 5),
  F("artMeshKeyform.screenBegin", "i32", "artMeshKeyforms", 5),
  F("blendShapePart.target", "i32", "blendShapesParts", 5),
  F("blendShapePart.bindingBegin", "i32", "blendShapesParts", 5),
  F("blendShapePart.bindingCount", "i32", "blendShapesParts", 5),
  F("blendShapeRotation.target", "i32", "blendShapesRotationDeformers", 5),
  F("blendShapeRotation.bindingBegin", "i32", "blendShapesRotationDeformers", 5),
  F("blendShapeRotation.bindingCount", "i32", "blendShapesRotationDeformers", 5),
  F("blendShapeGlue.target", "i32", "blendShapesGlue", 5),
  F("blendShapeGlue.bindingBegin", "i32", "blendShapesGlue", 5),
  F("blendShapeGlue.bindingCount", "i32", "blendShapesGlue", 5),
];

export type Moc3Array = Int32Array | Uint32Array | Float32Array | Uint8Array | Int16Array | string[];

export interface Moc3Canvas {
  pixelsPerUnit: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  flags: number;
}

export interface Moc3Data {
  version: Moc3Version;
  counts: Record<CountName, number>;
  canvas: Moc3Canvas;
  /** Arrays by field name (runtime-space fields are left out). Booleans are 0/1 in an Int32Array. */
  arrays: Record<string, Moc3Array>;
}

const HEADER = 64;
const TABLE_SLOTS = 160;
const BODY = 1984;
const ALIGN = 64;
const RUNTIME_UNIT = 8;

const countsFor = (v: Moc3Version) => (v >= 5 ? 35 : v >= 4 ? 32 : 23);
const countTableSize = (v: Moc3Version) => (v >= 5 ? 256 : 128);

function elemSize(t: FieldType): number {
  return t === "u8" ? 1 : t === "i16" ? 2 : t === "id" ? 64 : t === "runtime" ? RUNTIME_UNIT : 4;
}

/** The fields present in a file of this version. */
export function fieldsFor(version: Moc3Version): Field[] {
  return FIELDS.filter((f) => f.since <= version);
}

export function readMoc3(bytes: Uint8Array): Moc3Data {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < BODY || String.fromCharCode(...bytes.subarray(0, 4)) !== "MOC3") throw new Error("not a .moc3 file (no MOC3 header)");
  const version = bytes[4] as Moc3Version;
  if (!(version >= 1 && version <= 5)) throw new Error(`unsupported .moc3 version ${bytes[4]} (known: 1-5, Cubism 3.0-5.0)`);
  const le = bytes[5] === 0;
  const slot = (i: number) => dv.getUint32(HEADER + i * 4, le);
  const countsAt = slot(0);
  const counts = {} as Record<CountName, number>;
  COUNT_NAMES.forEach((n, i) => (counts[n] = i < countsFor(version) ? dv.getUint32(countsAt + i * 4, le) : 0));
  const c = slot(1);
  const canvas: Moc3Canvas = {
    pixelsPerUnit: dv.getFloat32(c, le),
    originX: dv.getFloat32(c + 4, le),
    originY: dv.getFloat32(c + 8, le),
    width: dv.getFloat32(c + 12, le),
    height: dv.getFloat32(c + 16, le),
    flags: bytes[c + 20],
  };
  const arrays: Record<string, Moc3Array> = {};
  fieldsFor(version).forEach((f, i) => {
    if (f.type === "runtime") return;
    const n = counts[f.count];
    const at = slot(i + 2);
    if (n > 0 && at + n * elemSize(f.type) > bytes.length) throw new Error(`corrupt .moc3: ${f.name} runs past the end of the file`);
    switch (f.type) {
      case "id": {
        const td = new TextDecoder();
        const out: string[] = [];
        for (let k = 0; k < n; k++) {
          const raw = bytes.subarray(at + k * 64, at + k * 64 + 64);
          const end = raw.indexOf(0);
          out.push(td.decode(raw.subarray(0, end < 0 ? 64 : end)));
        }
        arrays[f.name] = out;
        break;
      }
      case "u8":
        arrays[f.name] = bytes.slice(at, at + n);
        break;
      case "i16": {
        const a = new Int16Array(n);
        for (let k = 0; k < n; k++) a[k] = dv.getInt16(at + k * 2, le);
        arrays[f.name] = a;
        break;
      }
      case "f32": {
        const a = new Float32Array(n);
        for (let k = 0; k < n; k++) a[k] = dv.getFloat32(at + k * 4, le);
        arrays[f.name] = a;
        break;
      }
      case "u32": {
        const a = new Uint32Array(n);
        for (let k = 0; k < n; k++) a[k] = dv.getUint32(at + k * 4, le);
        arrays[f.name] = a;
        break;
      }
      default: {
        const a = new Int32Array(n);
        for (let k = 0; k < n; k++) a[k] = dv.getInt32(at + k * 4, le);
        arrays[f.name] = a;
      }
    }
  });
  return { version, counts, canvas, arrays };
}

/** Writes a little-endian .moc3. Arrays must match the counts (missing arrays are written as zeros). */
export function writeMoc3(data: Moc3Data): Uint8Array {
  const v = data.version;
  const fields = fieldsFor(v);
  // sizes first, to allocate once
  let size = BODY + countTableSize(v) + 64;
  const align = (n: number) => Math.ceil(n / ALIGN) * ALIGN;
  const offsets: number[] = [BODY, BODY + countTableSize(v)];
  for (const f of fields) {
    if (f.type !== "id") size = align(size);
    offsets.push(size);
    size += data.counts[f.count] * elemSize(f.type);
  }
  size = align(size);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([0x4d, 0x4f, 0x43, 0x33, v, 0]);
  offsets.forEach((o, i) => {
    if (i < TABLE_SLOTS) dv.setUint32(HEADER + i * 4, o, true);
  });
  COUNT_NAMES.forEach((n, i) => {
    if (i < countsFor(v)) dv.setUint32(BODY + i * 4, data.counts[n] ?? 0, true);
  });
  const c = offsets[1];
  dv.setFloat32(c, data.canvas.pixelsPerUnit, true);
  dv.setFloat32(c + 4, data.canvas.originX, true);
  dv.setFloat32(c + 8, data.canvas.originY, true);
  dv.setFloat32(c + 12, data.canvas.width, true);
  dv.setFloat32(c + 16, data.canvas.height, true);
  out[c + 20] = data.canvas.flags;
  const te = new TextEncoder();
  fields.forEach((f, i) => {
    if (f.type === "runtime") return;
    const n = data.counts[f.count];
    const at = offsets[i + 2];
    const a = data.arrays[f.name];
    if (!n) return;
    if (!a) throw new Error(`moc3 write: missing ${f.name}`);
    if (a.length !== n) throw new Error(`moc3 write: ${f.name} has ${a.length} entries, count ${f.count} is ${n}`);
    for (let k = 0; k < n; k++) {
      switch (f.type) {
        case "id": {
          const b = te.encode((a as string[])[k]);
          if (b.length >= 64) throw new Error(`id "${(a as string[])[k]}" is longer than 63 bytes`);
          out.set(b, at + k * 64);
          break;
        }
        case "u8":
          out[at + k] = (a as Uint8Array)[k];
          break;
        case "i16":
          dv.setInt16(at + k * 2, (a as Int16Array)[k], true);
          break;
        case "f32":
          dv.setFloat32(at + k * 4, (a as Float32Array)[k], true);
          break;
        case "u32":
          dv.setUint32(at + k * 4, (a as Uint32Array)[k], true);
          break;
        default:
          dv.setInt32(at + k * 4, (a as Int32Array)[k], true);
      }
    }
  });
  return out;
}
