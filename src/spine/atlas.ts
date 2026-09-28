// Spine texture atlases: parsing (4.x "bounds:" and 3.x "xy:" styles), cutting regions back out of the page
// images (rotation, whitespace stripping and premultiplied alpha undone), and packing images into a new atlas.
// Pure: images are plain RGBA buffers, so this runs anywhere.
import type { RGBAImage } from "../render/png.ts";

export interface AtlasRegion {
  name: string;
  page: string;
  /** Rectangle of the packed (stripped) image on the page, unrotated size. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0, 90, 180 or 270: how the packed image is turned on the page (90 / 270 swap its footprint). */
  degrees: number;
  /** Where the stripped image sits in the original image (x from the left, y from the BOTTOM). */
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
  index: number;
  /** Other keys kept as written (split, pad, ...). */
  extra: Record<string, string>;
}

export interface AtlasPage {
  name: string;
  width: number;
  height: number;
  pma: boolean;
  /** Page keys as written (filter, format, repeat, scale, ...), minus size/pma. */
  extra: Record<string, string>;
  regions: AtlasRegion[];
}

const nums = (v: string) => v.split(",").map((s) => Number(s.trim()));

/** Parses a .atlas file (Spine 4.x or 3.x format). */
export function parseAtlas(text: string): AtlasPage[] {
  const lines = text.split(/\r?\n/);
  const pages: AtlasPage[] = [];
  let page: AtlasPage | null = null;
  let region: AtlasRegion | null = null;
  const kv = (line: string): [string, string] | null => {
    const i = line.indexOf(":");
    return i < 0 ? null : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      // a blank line ends the page: the next name starts a new one
      page = null;
      region = null;
      continue;
    }
    const pair = kv(line);
    if (!page) {
      page = { name: line.trim(), width: 0, height: 0, pma: false, extra: {}, regions: [] };
      pages.push(page);
      region = null;
      continue;
    }
    if (!pair) {
      region = {
        name: line.trim(),
        page: page.name,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        degrees: 0,
        offsetX: 0,
        offsetY: 0,
        originalWidth: 0,
        originalHeight: 0,
        index: -1,
        extra: {},
      };
      page.regions.push(region);
      continue;
    }
    const [k, v] = pair;
    if (!region) {
      if (k === "size") [page.width, page.height] = nums(v);
      else if (k === "pma") page.pma = v === "true";
      else page.extra[k] = v;
      continue;
    }
    switch (k) {
      case "bounds":
        [region.x, region.y, region.width, region.height] = nums(v);
        break;
      case "xy":
        [region.x, region.y] = nums(v);
        break;
      case "size":
        [region.width, region.height] = nums(v);
        break;
      case "offsets":
        [region.offsetX, region.offsetY, region.originalWidth, region.originalHeight] = nums(v);
        break;
      case "offset":
        [region.offsetX, region.offsetY] = nums(v);
        break;
      case "orig":
        [region.originalWidth, region.originalHeight] = nums(v);
        break;
      case "rotate":
        region.degrees = v === "true" ? 90 : v === "false" ? 0 : Number(v);
        break;
      case "index":
        region.index = Number(v);
        break;
      default:
        region.extra[k] = v;
    }
  }
  for (const p of pages) {
    for (const r of p.regions) {
      if (!r.originalWidth) r.originalWidth = r.width;
      if (!r.originalHeight) r.originalHeight = r.height;
      r.degrees = ((r.degrees % 360) + 360) % 360;
      if (![0, 90, 180, 270].includes(r.degrees)) throw new Error(`atlas region "${r.name}": rotation ${r.degrees} is not supported (0, 90, 180 or 270)`);
    }
  }
  return pages;
}

/**
 * The region's ORIGINAL image (originalWidth x originalHeight, whitespace restored), un-rotated, with straight
 * alpha. Mesh UVs in skeleton data are relative to this image.
 */
export function extractRegion(page: RGBAImage, pma: boolean, r: AtlasRegion): RGBAImage {
  const out = new Uint8Array(r.originalWidth * r.originalHeight * 4);
  const top = r.originalHeight - r.height - r.offsetY;
  for (let oy = 0; oy < r.height; oy++) {
    for (let ox = 0; ox < r.width; ox++) {
      // where image pixel (ox, oy) sits on the page: 90 = turned counter-clockwise (the image's x runs up the page),
      // 180 = upside down, 270 = turned clockwise
      const [px, py] =
        r.degrees === 90
          ? [r.x + oy, r.y + (r.width - 1 - ox)]
          : r.degrees === 180
            ? [r.x + (r.width - 1 - ox), r.y + (r.height - 1 - oy)]
            : r.degrees === 270
              ? [r.x + (r.height - 1 - oy), r.y + ox]
              : [r.x + ox, r.y + oy];
      if (px < 0 || py < 0 || px >= page.width || py >= page.height) continue;
      const si = (py * page.width + px) * 4;
      const dx = r.offsetX + ox;
      const dy = top + oy;
      if (dx < 0 || dy < 0 || dx >= r.originalWidth || dy >= r.originalHeight) continue;
      const di = (dy * r.originalWidth + dx) * 4;
      const a = page.data[si + 3];
      if (pma && a > 0 && a < 255) {
        for (let c = 0; c < 3; c++) out[di + c] = Math.min(255, Math.round((page.data[si + c] * 255) / a));
      } else {
        out[di] = page.data[si];
        out[di + 1] = page.data[si + 1];
        out[di + 2] = page.data[si + 2];
      }
      out[di + 3] = a;
    }
  }
  return { width: r.originalWidth, height: r.originalHeight, data: out };
}

/** Transparent border of an image: [left, top, width, height] of the opaque part (null when empty). */
function trimBounds(img: RGBAImage): [number, number, number, number] | null {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

export interface PackOptions {
  /** Page name (image file name). */
  name: string;
  maxWidth?: number;
  padding?: number;
  /** Strip transparent borders (stored as offsets). Default true. */
  strip?: boolean;
}

/**
 * Packs images into one page (shelf packing, tallest first, no rotation) and returns the page image plus its
 * atlas description. Region names are the given keys.
 */
export function packAtlas(images: Map<string, RGBAImage>, opts: PackOptions): { page: AtlasPage; image: RGBAImage } {
  const pad = opts.padding ?? 2;
  const items = [...images].map(([name, img]) => {
    const t = opts.strip === false ? [0, 0, img.width, img.height] : (trimBounds(img) ?? [0, 0, 1, 1]);
    return { name, img, trim: t as [number, number, number, number] };
  });
  const area = items.reduce((s, it) => s + (it.trim[2] + pad) * (it.trim[3] + pad), 0);
  const widest = Math.max(1, ...items.map((it) => it.trim[2] + pad * 2));
  const maxWidth = Math.max(widest, Math.min(opts.maxWidth ?? 4096, Math.ceil(Math.sqrt(area) * 1.15)));
  items.sort((a, b) => b.trim[3] - a.trim[3] || b.trim[2] - a.trim[2] || a.name.localeCompare(b.name));
  let x = pad;
  let y = pad;
  let shelf = 0;
  const placed: Array<{ it: (typeof items)[number]; x: number; y: number }> = [];
  for (const it of items) {
    const [, , w, h] = it.trim;
    if (x + w + pad > maxWidth) {
      x = pad;
      y += shelf + pad;
      shelf = 0;
    }
    placed.push({ it, x, y });
    x += w + pad;
    shelf = Math.max(shelf, h);
  }
  const width = Math.max(1, ...placed.map((p) => p.x + p.it.trim[2] + pad));
  const height = Math.max(1, y + shelf + pad);
  const data = new Uint8Array(width * height * 4);
  const regions: AtlasRegion[] = [];
  for (const { it, x: px, y: py } of placed) {
    const [tx, ty, w, h] = it.trim;
    for (let row = 0; row < h; row++) {
      const si = ((ty + row) * it.img.width + tx) * 4;
      data.set(it.img.data.subarray(si, si + w * 4), ((py + row) * width + px) * 4);
    }
    regions.push({
      name: it.name,
      page: opts.name,
      x: px,
      y: py,
      width: w,
      height: h,
      degrees: 0,
      offsetX: tx,
      offsetY: it.img.height - ty - h,
      originalWidth: it.img.width,
      originalHeight: it.img.height,
      index: -1,
      extra: {},
    });
  }
  regions.sort((a, b) => a.name.localeCompare(b.name));
  return { page: { name: opts.name, width, height, pma: false, extra: { filter: "Linear,Linear" }, regions }, image: { width, height, data } };
}

/** Writes pages in the Spine 4.x atlas format. */
export function writeAtlas(pages: AtlasPage[]): string {
  const out: string[] = [];
  pages.forEach((p, i) => {
    if (i) out.push("");
    out.push(p.name, `size:${p.width},${p.height}`);
    for (const [k, v] of Object.entries(p.extra)) out.push(`${k}:${v}`);
    if (p.pma) out.push("pma:true");
    for (const r of p.regions) {
      out.push(r.name, `bounds:${r.x},${r.y},${r.width},${r.height}`);
      if (r.offsetX || r.offsetY || r.originalWidth !== r.width || r.originalHeight !== r.height) {
        out.push(`offsets:${r.offsetX},${r.offsetY},${r.originalWidth},${r.originalHeight}`);
      }
      if (r.degrees) out.push(`rotate:${r.degrees}`);
      if (r.index >= 0) out.push(`index:${r.index}`);
      for (const [k, v] of Object.entries(r.extra)) out.push(`${k}:${v}`);
    }
  });
  return out.join("\n") + "\n";
}
