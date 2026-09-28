// Minimal dependency-free PNG codec (8-bit RGBA output; decodes non-interlaced gray/RGB/palette/alpha).
import { deflateSync, inflateSync } from "node:zlib";

export interface RGBAImage {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, 4 bytes per pixel, rows top to bottom. */
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePNG(img: RGBAImage): Buffer {
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1; // Sub filter: compresses flat areas well
    const row = y * stride;
    const o = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) raw[o + x] = (data[row + x] - (x >= 4 ? data[row + x - 4] : 0)) & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function decodePNG(buf: Uint8Array): RGBAImage {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG file");
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("ascii", pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (interlace) throw new Error("interlaced PNGs are not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`unsupported PNG color type ${ctype}`);
  if (depth !== 8 && depth !== 16 && !(ctype === 3 && depth < 8) && !(ctype === 0 && depth < 8))
    throw new Error(`unsupported PNG bit depth ${depth}`);
  const bitsPP = channels * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const stride = Math.ceil((width * bitsPP) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const up = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      px[dst + x] = v & 0xff;
    }
  }
  const out = new Uint8Array(width * height * 4);
  const sample = (row: number, i: number): number => {
    // i-th sample in the row (channel-level), scaled to 8 bits
    if (depth === 8) return px[row + i];
    if (depth === 16) return px[row + i * 2];
    const perByte = 8 / depth;
    const byte = px[row + Math.floor(i / perByte)];
    const shift = 8 - depth * ((i % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 3) {
        const idx = sample(row, x);
        out[o] = palette![idx * 3];
        out[o + 1] = palette![idx * 3 + 1];
        out[o + 2] = palette![idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (ctype === 0 || ctype === 4) {
        let g = sample(row, x * channels);
        if (depth < 8) g = Math.round((g * 255) / ((1 << depth) - 1));
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = ctype === 4 ? sample(row, x * channels + 1) : 255;
      } else {
        out[o] = sample(row, x * channels);
        out[o + 1] = sample(row, x * channels + 1);
        out[o + 2] = sample(row, x * channels + 2);
        out[o + 3] = ctype === 6 ? sample(row, x * channels + 3) : 255;
      }
    }
  }
  return { width, height, data: out };
}
