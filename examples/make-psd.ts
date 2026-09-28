// Paints a layered demo character procedurally and saves it as examples/psd-demo/character.psd.
// Stands in for artist-made PSDs in tests and demos. Run: npm run example:psd
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePsd } from "../src/import/psd-write.ts";
import type { PsdWriteLayer } from "../src/import/psd-write.ts";

const W = 400;
const H = 640;
type P = [number, number];
type Sdf = (x: number, y: number) => number;

const capsule = (a: P, b: P, r: number): Sdf => (x, y) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) - r;
};
const ellipse = (c: P, rx: number, ry: number): Sdf => (x, y) => (Math.hypot((x - c[0]) / rx, (y - c[1]) / ry) - 1) * Math.min(rx, ry);
const box = (c: P, hx: number, hy: number, r: number): Sdf => (x, y) => {
  const qx = Math.abs(x - c[0]) - hx + r;
  const qy = Math.abs(y - c[1]) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const union = (...s: Sdf[]): Sdf => (x, y) => Math.min(...s.map((f) => f(x, y)));
const cut = (s: Sdf, keepAboveY: number): Sdf => (x, y) => Math.max(s(x, y), y - keepAboveY);

function hex(c: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
}

/** Rasterizes an SDF with a dark outline and simple top-left lighting, trimmed to its bounds. */
function paint(name: string, sdf: Sdf, color: string, opts: { outline?: boolean; groups?: string[]; hidden?: boolean } = {}): PsdWriteLayer {
  const base = hex(color);
  const full = new Uint8Array(W * H * 4);
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a <= 0) continue;
      const shade = 0.82 + 0.3 * Math.max(0, Math.min(1, (-d) / 18)) - 0.12 * (x / W);
      const edge = opts.outline !== false && d > -2.5;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) full[o + c] = edge ? Math.round(base[c] * 0.35) : Math.min(255, Math.round(base[c] * shade));
      full[o + 3] = Math.round(a * 255);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(full.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + w) * 4), y * w * 4);
  return { name, groups: opts.groups, left: x0, top: y0, width: w, height: h, rgba, hidden: opts.hidden };
}

const SKIN = "#f2c29b";
const SHIRT = "#e0644a";
const PANTS = "#3a4a78";

const layers: PsdWriteLayer[] = [
  paint("꼬리", capsule([232, 362], [330, 300], 11), "#b07a4a"),
  paint("arm R", union(capsule([146, 238], [112, 322], 16), capsule([112, 322], [94, 408], 14)), SKIN),
  paint("leg R", union(capsule([176, 382], [168, 500], 22), capsule([168, 500], [164, 606], 19)), PANTS),
  paint("thigh L", capsule([224, 382], [232, 500], 22), PANTS, { groups: ["Leg L"] }),
  paint("shin L", capsule([232, 500], [236, 600], 19), PANTS, { groups: ["Leg L"] }),
  paint("foot L", ellipse([250, 614], 28, 12), "#2a2a2a", { groups: ["Leg L"] }),
  paint("torso", box([200, 300], 56, 88, 26), SHIRT, { groups: ["Body"] }),
  paint("head", ellipse([200, 150], 62, 68), SKIN, { groups: ["Head"] }),
  paint("hair", cut(ellipse([200, 122], 70, 52), 138), "#5a3a22", { groups: ["Head"] }),
  paint("eye L", ellipse([222, 160], 7, 10), "#222222", { groups: ["Head"], outline: false }),
  paint("eye R", ellipse([178, 160], 7, 10), "#222222", { groups: ["Head"], outline: false }),
  paint("mouth", ellipse([200, 192], 14, 5), "#b04848", { groups: ["Head"] }),
  paint("upper arm L", capsule([254, 238], [288, 322], 16), SKIN, { groups: ["Arm L"] }),
  paint("forearm L", capsule([288, 322], [306, 404], 14), SKIN, { groups: ["Arm L"] }),
  paint("hand L", ellipse([310, 424], 16, 17), SKIN, { groups: ["Arm L"] }),
  paint("sketch", capsule([20, 20], [380, 620], 2), "#00aaff", { hidden: true, outline: false }),
];

const out = resolve(dirname(fileURLToPath(import.meta.url)), "psd-demo/character.psd");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, writePsd({ width: W, height: H, layers }));
console.log(`wrote ${out} (${layers.length} layers)`);
