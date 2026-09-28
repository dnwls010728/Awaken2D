// Minimal PSD writer (8-bit RGB + alpha layers, RLE, groups, unicode names).
// Used to generate test fixtures and demo art without an image editor.

export interface PsdWriteLayer {
  name: string;
  /** Enclosing group names, outermost first. */
  groups?: string[];
  left: number;
  top: number;
  width: number;
  height: number;
  /** Straight RGBA, width*height*4. */
  rgba: Uint8Array;
  hidden?: boolean;
  /** 0..1 */
  opacity?: number;
}

class Writer {
  private chunks: number[] = [];
  u8(v: number) {
    this.chunks.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v >> 8);
    this.u8(v);
  }
  i16(v: number) {
    this.u16(v & 0xffff);
  }
  u32(v: number) {
    this.u16((v >>> 16) & 0xffff);
    this.u16(v & 0xffff);
  }
  i32(v: number) {
    this.u32(v >>> 0);
  }
  ascii(s: string) {
    for (const c of s) this.u8(c.charCodeAt(0));
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.chunks.push(b[i]);
  }
  get length() {
    return this.chunks.length;
  }
  toBuffer() {
    return Buffer.from(this.chunks);
  }
}

function packBits(row: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 2) {
      out.push(257 - run, row[i]);
      i += run;
      continue;
    }
    let lit = 1;
    while (i + lit < row.length && lit < 128 && !(i + lit + 1 < row.length && row[i + lit] === row[i + lit + 1])) lit++;
    out.push(lit - 1);
    for (let k = 0; k < lit; k++) out.push(row[i + k]);
    i += lit;
  }
  return out;
}

function encodeChannel(rgba: Uint8Array, w: number, h: number, offset: number): number[] {
  const counts: number[] = [];
  const data: number[] = [];
  const row = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = rgba[(y * w + x) * 4 + offset];
    const packed = packBits(row);
    counts.push(packed.length);
    data.push(...packed);
  }
  const out: number[] = [0, 1]; // compression = RLE
  for (const c of counts) out.push(c >> 8, c & 0xff);
  return out.concat(data);
}

interface Record {
  layer: PsdWriteLayer | null;
  name: string;
  section: number;
}

function extraData(name: string, section: number): number[] {
  const w = new Writer();
  w.u32(0); // mask
  w.u32(0); // blending ranges
  const latin = [...name].map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63)).slice(0, 255);
  w.u8(latin.length);
  w.bytes(latin);
  while ((w.length - 8) % 4 !== 0) w.u8(0); // pascal string padded to a multiple of 4
  // luni: unicode name
  const units = [...name].flatMap((c) => {
    const cp = c.codePointAt(0)!;
    if (cp < 0x10000) return [cp];
    const v = cp - 0x10000;
    return [0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)];
  });
  const len = 4 + units.length * 2;
  const pad = (4 - (len % 4)) % 4;
  w.ascii("8BIM");
  w.ascii("luni");
  w.u32(len + pad);
  w.u32(units.length);
  for (const u of units) w.u16(u);
  for (let i = 0; i < pad; i++) w.u8(0);
  if (section) {
    w.ascii("8BIM");
    w.ascii("lsct");
    w.u32(4);
    w.u32(section);
  }
  return [...w.toBuffer()];
}

export function writePsd(doc: { width: number; height: number; layers: PsdWriteLayer[] }): Buffer {
  // build bottom-to-top records including group markers
  const records: Record[] = [];
  let path: string[] = [];
  const transition = (next: string[]) => {
    let common = 0;
    while (common < path.length && common < next.length && path[common] === next[common]) common++;
    for (let d = path.length - 1; d >= common; d--) records.push({ layer: null, name: path[d], section: 1 });
    for (let d = common; d < next.length; d++) records.push({ layer: null, name: "</Layer group>", section: 3 });
    path = [...next];
  };
  for (const l of doc.layers) {
    transition(l.groups ?? []);
    records.push({ layer: l, name: l.name, section: 0 });
  }
  transition([]);

  const info = new Writer();
  info.i16(records.length);
  const channelData: number[][][] = [];
  for (const rec of records) {
    const l = rec.layer;
    const w = l?.width ?? 0;
    const h = l?.height ?? 0;
    const chans = l
      ? [
          { id: -1, data: encodeChannel(l.rgba, w, h, 3) },
          { id: 0, data: encodeChannel(l.rgba, w, h, 0) },
          { id: 1, data: encodeChannel(l.rgba, w, h, 1) },
          { id: 2, data: encodeChannel(l.rgba, w, h, 2) },
        ]
      : [-1, 0, 1, 2].map((id) => ({ id, data: [0, 0] }));
    channelData.push(chans.map((c) => c.data));
    info.i32(l?.top ?? 0);
    info.i32(l?.left ?? 0);
    info.i32((l?.top ?? 0) + h);
    info.i32((l?.left ?? 0) + w);
    info.u16(chans.length);
    for (const c of chans) {
      info.i16(c.id);
      info.u32(c.data.length);
    }
    info.ascii("8BIM");
    info.ascii(rec.section ? "pass" : "norm");
    info.u8(Math.round((l?.opacity ?? 1) * 255));
    info.u8(0);
    info.u8(l?.hidden ? 2 : 0);
    info.u8(0);
    const extra = extraData(rec.name, rec.section);
    info.u32(extra.length);
    info.bytes(extra);
  }
  for (const chans of channelData) for (const c of chans) info.bytes(c);
  while (info.length % 4) info.u8(0);

  const out = new Writer();
  out.ascii("8BPS");
  out.u16(1);
  out.bytes([0, 0, 0, 0, 0, 0]);
  out.u16(4);
  out.u32(doc.height);
  out.u32(doc.width);
  out.u16(8);
  out.u16(3);
  out.u32(0); // color mode data
  out.u32(0); // image resources
  out.u32(info.length + 4 + 4); // layer and mask info (layer info + global mask len)
  out.u32(info.length);
  const infoBuf = info.toBuffer();
  const head = out.toBuffer();
  const tail = new Writer();
  tail.u32(0); // global layer mask info
  // merged image: raw, composite of visible layers
  tail.u16(0);
  const comp = composite(doc);
  for (const off of [0, 1, 2, 3]) {
    const plane = new Uint8Array(doc.width * doc.height);
    for (let i = 0; i < plane.length; i++) plane[i] = comp[i * 4 + off];
    tail.bytes(plane);
  }
  return Buffer.concat([head, infoBuf, tail.toBuffer()]);
}

function composite(doc: { width: number; height: number; layers: PsdWriteLayer[] }): Uint8Array {
  const out = new Float32Array(doc.width * doc.height * 4);
  for (const l of doc.layers) {
    if (l.hidden) continue;
    const op = l.opacity ?? 1;
    for (let y = 0; y < l.height; y++) {
      const cy = l.top + y;
      if (cy < 0 || cy >= doc.height) continue;
      for (let x = 0; x < l.width; x++) {
        const cx = l.left + x;
        if (cx < 0 || cx >= doc.width) continue;
        const s = (y * l.width + x) * 4;
        const d = (cy * doc.width + cx) * 4;
        const a = (l.rgba[s + 3] / 255) * op;
        for (let c = 0; c < 3; c++) out[d + c] = (l.rgba[s + c] / 255) * a + out[d + c] * (1 - a);
        out[d + 3] = a + out[d + 3] * (1 - a);
      }
    }
  }
  const res = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    for (let c = 0; c < 3; c++) res[i + c] = a > 0 ? Math.round((out[i + c] / a) * 255) : 0;
    res[i + 3] = Math.round(a * 255);
  }
  return res;
}
