// CAFF container (Cubism Editor's .cmo3 / .can3): a header with an XOR key, a file table and the entries. Pure: the
// caller passes the raw-deflate inflater (node:zlib's inflateRawSync, or a browser one).
//
// Layout (big-endian): "CAFF", 3 version bytes, "----", the format version, the key (int32 at 14), 8 reserved bytes,
// a 28-byte preview block, then the file count at 54. Table and entries are XOR'd with the key: int32s with the key,
// int64s with the key widened as (key << 32) | (long) key, bytes and strings (varint length + UTF-8) with its low
// byte. Entry: path, tag, start (int64), size (int32), obfuscated flag, compression byte, 8 reserved bytes. A
// compressed entry (compression 33, e.g. main.xml) is one zip local-file record whose deflate stream is read up to
// its end (the record has a data descriptor and no usable central directory).

export type InflateRaw = (data: Uint8Array) => Uint8Array;

export interface CaffEntry {
  path: string;
  tag: string;
  data: Uint8Array;
}

const utf8 = new TextDecoder();

export function isCaff(bytes: Uint8Array): boolean {
  return bytes.length > 58 && bytes[0] === 0x43 && bytes[1] === 0x41 && bytes[2] === 0x46 && bytes[3] === 0x46;
}

export function readCaff(bytes: Uint8Array, inflateRaw: InflateRaw): CaffEntry[] {
  if (!isCaff(bytes)) throw new Error("not a Cubism Editor file (no CAFF header)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const key = view.getInt32(14);
  const kb = key & 0xff;
  let p = 54;
  const int = () => {
    const v = view.getInt32(p) ^ key;
    p += 4;
    return v;
  };
  const long = () => {
    const hi = view.getInt32(p) ^ (key < 0 ? -1 : key);
    const lo = (view.getInt32(p + 4) ^ key) >>> 0;
    p += 8;
    return hi * 2 ** 32 + lo;
  };
  const byte = () => (bytes[p++] ^ kb) & 0xff;
  const str = () => {
    let n = 0;
    let shift = 0;
    let c: number;
    do {
      c = byte();
      n |= (c & 0x7f) << shift;
      shift += 7;
    } while (c & 0x80);
    const s = bytes.slice(p, p + n);
    for (let i = 0; i < n; i++) s[i] ^= kb;
    p += n;
    return utf8.decode(s);
  };
  const count = int();
  const out: CaffEntry[] = [];
  for (let i = 0; i < count; i++) {
    const path = str();
    const tag = str();
    const start = long();
    const size = int();
    const obfuscated = byte();
    const compression = byte();
    p += 8;
    if (start < 0 || start + size > bytes.length) throw new Error(`CAFF entry ${path} lies outside the file`);
    let data: Uint8Array = bytes.slice(start, start + size);
    if (obfuscated) for (let k = 0; k < data.length; k++) data[k] ^= kb;
    if (compression !== 16 && data.length >= 30 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4) {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const body = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
      data = inflateRaw(data.subarray(body));
    }
    out.push({ path, tag, data });
  }
  return out;
}
