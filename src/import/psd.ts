// Dependency-free PSD/PSB reader: extracts layers (RGBA pixels, names, group paths, visibility, opacity).
// Supports RGB and grayscale, 8/16-bit, raw/RLE/ZIP channel compression. Masks and effects are ignored.
import { inflateSync } from "node:zlib";

export interface PsdLayer {
  name: string;
  /** Enclosing group names, outermost first. */
  groups: string[];
  left: number;
  top: number;
  width: number;
  height: number;
  /** Straight RGBA, width*height*4. */
  rgba: Uint8Array;
  /** False when the layer or any enclosing group is hidden. */
  visible: boolean;
  /** Layer opacity 0..1 (fill opacity is folded in). */
  opacity: number;
  /** PSD blend mode key, e.g. "norm", "mul ". */
  blendMode: string;
  /** Layer is clipped to the layer below. */
  clipped: boolean;
}

export interface PsdDocument {
  width: number;
  height: number;
  depth: number;
  colorMode: "rgb" | "grayscale";
  /** Layers bottom to top (PSD order = back to front). Groups are flattened into `groups`. */
  layers: PsdLayer[];
  warnings: string[];
}

const COLOR_MODES: Record<number, string> = { 0: "bitmap", 1: "grayscale", 2: "indexed", 3: "rgb", 4: "cmyk", 7: "multichannel", 8: "duotone", 9: "lab" };
// additional layer info keys that use 8-byte lengths in PSB files
const PSB_LONG_KEYS = new Set(["LMsk", "Lr16", "Lr32", "Layr", "Mt16", "Mt32", "Mtrn", "Alph", "FMsk", "lnk2", "FEid", "FXid", "PxSD"]);

class Reader {
  pos = 0;
  readonly view: DataView;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8() {
    return this.view.getUint8(this.pos++);
  }
  u16() {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i16() {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  i32() {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  u64() {
    const hi = this.u32();
    const lo = this.u32();
    return hi * 2 ** 32 + lo;
  }
  len(big: boolean) {
    return big ? this.u64() : this.u32();
  }
  ascii(n: number) {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  skip(n: number) {
    this.pos += n;
  }
  bytes(n: number) {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  check(n: number, what: string) {
    if (this.pos + n > this.buf.length) throw new Error(`PSD truncated while reading ${what}`);
  }
}

interface ChannelInfo {
  id: number;
  length: number;
}

interface RawLayer {
  top: number;
  left: number;
  bottom: number;
  right: number;
  channels: ChannelInfo[];
  blendMode: string;
  opacity: number;
  clipping: number;
  hidden: boolean;
  name: string;
  fillOpacity: number;
  section: number; // 0 normal, 1/2 group folder, 3 group end marker
}

export function readPsd(input: Uint8Array): PsdDocument {
  const r = new Reader(input);
  const warnings: string[] = [];
  r.check(26, "header");
  if (r.ascii(4) !== "8BPS") throw new Error("not a PSD file (missing 8BPS signature)");
  const version = r.u16();
  if (version !== 1 && version !== 2) throw new Error(`unsupported PSD version ${version}`);
  const psb = version === 2;
  r.pos += 6;
  const channels = r.u16();
  const height = r.u32();
  const width = r.u32();
  const depth = r.u16();
  const mode = r.u16();
  if (mode !== 3 && mode !== 1) throw new Error(`unsupported PSD color mode ${COLOR_MODES[mode] ?? mode} (use RGB or grayscale)`);
  if (depth !== 8 && depth !== 16) throw new Error(`unsupported PSD bit depth ${depth} (use 8 or 16 bits/channel)`);
  const colorMode = mode === 3 ? "rgb" : "grayscale";

  r.skip(r.u32()); // color mode data
  r.skip(r.u32()); // image resources

  const layers: PsdLayer[] = [];
  const lmLen = r.len(psb);
  const lmEnd = r.pos + lmLen;
  if (lmLen > 0) {
    const liLen = r.len(psb);
    const liEnd = r.pos + liLen;
    if (liLen > 0) {
      const count = Math.abs(r.i16());
      const raws: RawLayer[] = [];
      for (let i = 0; i < count; i++) raws.push(readLayerRecord(r, psb));
      const pixels: Array<Uint8Array | null> = raws.map((l) => readLayerPixels(r, l, psb, depth, colorMode, warnings));
      layers.push(...assembleLayers(raws, pixels, warnings));
    }
    r.pos = liEnd;
  }
  r.pos = lmEnd;

  if (layers.length === 0) {
    // flattened document: use the merged image as a single layer
    const rgba = readMergedImage(r, width, height, channels, depth, colorMode, psb);
    layers.push({ name: "image", groups: [], left: 0, top: 0, width, height, rgba, visible: true, opacity: 1, blendMode: "norm", clipped: false });
    warnings.push("document has no layers; imported the flattened image as one layer");
  }
  return { width, height, depth, colorMode, layers, warnings };
}

function readLayerRecord(r: Reader, psb: boolean): RawLayer {
  const top = r.i32();
  const left = r.i32();
  const bottom = r.i32();
  const right = r.i32();
  const nch = r.u16();
  const channels: ChannelInfo[] = [];
  for (let c = 0; c < nch; c++) channels.push({ id: r.i16(), length: r.len(psb) });
  const sig = r.ascii(4);
  if (sig !== "8BIM") throw new Error(`bad blend mode signature "${sig}" in layer record`);
  const blendMode = r.ascii(4);
  const opacity = r.u8();
  const clipping = r.u8();
  const flags = r.u8();
  r.pos += 1;
  const extraLen = r.u32();
  const extraEnd = r.pos + extraLen;
  r.skip(r.u32()); // layer mask data
  r.skip(r.u32()); // blending ranges
  const nameLen = r.u8();
  let name = decodeLatin1(r.bytes(nameLen));
  r.pos += (4 - ((nameLen + 1) % 4)) % 4;
  let section = 0;
  let fillOpacity = 255;
  while (r.pos + 12 <= extraEnd) {
    const s = r.ascii(4);
    if (s !== "8BIM" && s !== "8B64") {
      // tolerate writers that pad blocks: resync on the next signature
      r.pos -= 3;
      continue;
    }
    const key = r.ascii(4);
    const len = psb && PSB_LONG_KEYS.has(key) ? r.u64() : r.u32();
    const start = r.pos;
    if (key === "luni" && len >= 4) {
      const n = r.u32();
      let s2 = "";
      for (let i = 0; i < n && r.pos + 2 <= start + len; i++) s2 += String.fromCharCode(r.u16());
      name = s2.replace(/\0+$/, "");
    } else if ((key === "lsct" || key === "lsdk") && len >= 4) {
      section = r.u32();
    } else if (key === "iOpa" && len >= 1) {
      fillOpacity = r.u8();
    }
    r.pos = start + len;
  }
  r.pos = extraEnd;
  return { top, left, bottom, right, channels, blendMode, opacity, clipping, hidden: (flags & 2) !== 0, name, fillOpacity, section };
}

function decodeLatin1(b: Uint8Array): string {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

function readLayerPixels(r: Reader, l: RawLayer, psb: boolean, depth: number, mode: string, warnings: string[]): Uint8Array | null {
  const w = l.right - l.left;
  const h = l.bottom - l.top;
  const rgba = w > 0 && h > 0 ? new Uint8Array(w * h * 4) : null;
  if (rgba) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // opaque unless an alpha channel says otherwise
  for (const ch of l.channels) {
    const start = r.pos;
    const end = start + ch.length;
    const target = channelTarget(ch.id, mode);
    if (rgba && target >= 0 && ch.length >= 2) {
      const compression = r.u16();
      try {
        const plane = decodePlane(r, compression, w, h, depth, psb, end);
        writePlane(rgba, plane, target, mode, ch.id);
      } catch (e) {
        warnings.push(`layer "${l.name}": channel ${ch.id} unreadable (${(e as Error).message})`);
      }
    }
    r.pos = end;
  }
  return rgba;
}

/** RGBA byte offset for a channel id, -1 to skip (masks). Grayscale channel 0 fills RGB. */
function channelTarget(id: number, mode: string): number {
  if (id === -1) return 3;
  if (id < -1) return -1;
  if (mode === "grayscale") return id === 0 ? 0 : -1;
  return id <= 2 ? id : -1;
}

function writePlane(rgba: Uint8Array, plane: Uint8Array, target: number, mode: string, id: number): void {
  const n = rgba.length / 4;
  if (mode === "grayscale" && id === 0) {
    for (let i = 0; i < n; i++) rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = plane[i];
  } else {
    for (let i = 0; i < n; i++) rgba[i * 4 + target] = plane[i];
  }
}

/** Decodes one channel plane to 8-bit samples. */
function decodePlane(r: Reader, compression: number, w: number, h: number, depth: number, psb: boolean, end: number): Uint8Array {
  const bpc = depth / 8;
  const rowBytes = w * bpc;
  let raw: Uint8Array;
  if (compression === 0) {
    raw = r.bytes(rowBytes * h);
  } else if (compression === 1) {
    const counts: number[] = [];
    for (let y = 0; y < h; y++) counts.push(psb ? r.u32() : r.u16());
    raw = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      unpackBits(r.bytes(counts[y]), raw, y * rowBytes, rowBytes);
    }
  } else if (compression === 2 || compression === 3) {
    raw = new Uint8Array(inflateSync(r.bytes(end - r.pos)));
    if (compression === 3) unpredict(raw, w, h, bpc);
  } else {
    throw new Error(`unknown compression ${compression}`);
  }
  if (raw.length < rowBytes * h) throw new Error("channel data too short");
  if (bpc === 1) return raw.length === w * h ? raw : raw.subarray(0, w * h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = raw[i * 2]; // 16-bit: keep the high byte
  return out;
}

function unpackBits(src: Uint8Array, dst: Uint8Array, offset: number, length: number): void {
  let i = 0;
  let o = offset;
  const end = offset + length;
  while (i < src.length && o < end) {
    const n = src[i++];
    if (n < 128) {
      for (let k = 0; k <= n && o < end; k++) dst[o++] = src[i++];
    } else if (n > 128) {
      const v = src[i++];
      for (let k = 0; k < 257 - n && o < end; k++) dst[o++] = v;
    }
    // n === 128 is a no-op
  }
}

function unpredict(buf: Uint8Array, w: number, h: number, bpc: number): void {
  if (bpc === 1) {
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) buf[y * w + x] = (buf[y * w + x] + buf[y * w + x - 1]) & 0xff;
  } else {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const o = (y * w + x) * 2;
        dv.setUint16(o, (dv.getUint16(o) + dv.getUint16(o - 2)) & 0xffff);
      }
    }
  }
}

function readMergedImage(r: Reader, w: number, h: number, channels: number, depth: number, mode: string, psb: boolean): Uint8Array {
  const compression = r.u16();
  const bpc = depth / 8;
  const rowBytes = w * bpc;
  const planes: Uint8Array[] = [];
  if (compression === 1) {
    const counts: number[] = [];
    for (let i = 0; i < h * channels; i++) counts.push(psb ? r.u32() : r.u16());
    for (let c = 0; c < channels; c++) {
      const raw = new Uint8Array(rowBytes * h);
      for (let y = 0; y < h; y++) unpackBits(r.bytes(counts[c * h + y]), raw, y * rowBytes, rowBytes);
      planes.push(raw);
    }
  } else if (compression === 0) {
    for (let c = 0; c < channels; c++) planes.push(r.bytes(rowBytes * h));
  } else {
    throw new Error(`unsupported merged image compression ${compression}`);
  }
  const at = (p: Uint8Array, i: number) => p[i * bpc];
  const rgba = new Uint8Array(w * h * 4);
  const color = mode === "rgb" ? 3 : 1;
  for (let i = 0; i < w * h; i++) {
    const g = at(planes[0], i);
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = color === 3 ? at(planes[1], i) : g;
    rgba[i * 4 + 2] = color === 3 ? at(planes[2], i) : g;
    rgba[i * 4 + 3] = planes.length > color ? at(planes[color], i) : 255;
  }
  return rgba;
}

/** Resolves group structure (bottom-to-top records with section markers) into flat layers. */
function assembleLayers(raws: RawLayer[], pixels: Array<Uint8Array | null>, warnings: string[]): PsdLayer[] {
  // Walk top-to-bottom: a folder record (1/2) opens a group, the end marker (3) closes it.
  const stack: Array<{ name: string; hidden: boolean }> = [];
  const out: PsdLayer[] = [];
  for (let i = raws.length - 1; i >= 0; i--) {
    const l = raws[i];
    if (l.section === 1 || l.section === 2) {
      stack.push({ name: l.name, hidden: l.hidden });
      continue;
    }
    if (l.section === 3) {
      stack.pop();
      continue;
    }
    const rgba = pixels[i];
    if (!rgba) continue;
    out.push({
      name: l.name,
      groups: stack.map((g) => g.name),
      left: l.left,
      top: l.top,
      width: l.right - l.left,
      height: l.bottom - l.top,
      rgba,
      visible: !l.hidden && !stack.some((g) => g.hidden),
      opacity: (l.opacity / 255) * (l.fillOpacity / 255),
      blendMode: l.blendMode,
      clipped: l.clipping !== 0,
    });
  }
  return out.reverse();
}
