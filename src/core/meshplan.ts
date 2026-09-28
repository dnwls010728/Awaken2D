// Automatic meshes for new art: measures an image (size, outline, elongation, separate pieces), decides how much it
// is likely to bend from that and the layer's name, picks the automatic mesh settings for it (outline and interior
// spacing sized to a vertex budget), builds the mesh, checks it (every opaque pixel covered, few slivers) and adjusts
// the settings when the result misses. Pure: images are RGBA buffers.
import { alphaGridMesh, triArea } from "./geometry.ts";
import { round } from "./math.ts";
import { fitUvAffine } from "./meshedit.ts";
import { meshAutoGenerate, uvRegion } from "./meshtrace.ts";
import type { AutoMeshOptions } from "./meshtrace.ts";
import type { MeshGeometry } from "./meshedit.ts";
import type { MeshAttachment, Tri, Vec2 } from "./types.ts";

/**
 * How much a piece of art bends: "rigid" (small props, highlights, pupils: an outline only), "standard" (a body, a
 * face: outline, inner ring and a few interior points), "flexible" (hair, cloth, tails, limbs: dense along its length).
 */
export type MeshRole = "rigid" | "standard" | "flexible";

export interface ArtStats {
  width: number;
  height: number;
  /** Opaque pixels. */
  area: number;
  /** Opaque pixels touching a transparent one (about the outline length in pixels). */
  perimeter: number;
  /** perimeter² / (4π·area): 1 for a disc, higher for ragged or thin shapes. */
  complexity: number;
  /** Length along the art's main axis and across it (pixels, from its spread). */
  length: number;
  breadth: number;
  /** length / breadth. */
  elongation: number;
  /** Separate pieces (far enough apart to mesh on their own), as pixel boxes [x, y, w, h]. */
  pieces: Array<[number, number, number, number]>;
}

export interface MeshQuality {
  vertices: number;
  triangles: number;
  /** Share of the art inside the mesh, weighted by alpha (1 = all; faint edge pixels count little). */
  coverage: number;
  /** Mesh area / opaque area: how much transparent space it draws. */
  overdraw: number;
  /** Triangles with an angle under 8°. */
  slivers: number;
}

export interface MeshPlan {
  role: MeshRole;
  /** Why this role and these numbers (for reports). */
  reasons: string[];
  /** "auto" traced outline; "grid" when tracing could not cover the art. */
  method: "auto" | "grid";
  /** Vertex budget aimed at. */
  target: number;
  /** Settings used for each piece (pixels of this image). */
  options: AutoMeshOptions;
  quality: MeshQuality;
  stats: ArtStats;
}

export interface MeshPlanContext {
  /** Layer / attachment name and its groups: hints like "hair" or "button". */
  name?: string;
  groups?: string[];
  /** Model kind: Live2D meshes are deformed by warp deformers and get a denser budget. */
  target?: "spine" | "live2d" | null;
  /** Alpha (0..255) above which a pixel is art. Default 8. */
  alphaThreshold?: number;
  /** Force a role instead of deciding it. */
  role?: MeshRole;
  /** Scale the vertex budget (e.g. 1.5 for more vertices). Default 1. */
  density?: number;
}

// Name hints. English words match whole words of the name ("hair-back-2", "upperArm", "arm_L"; not "crosshair"),
// Japanese and Korean ones anywhere in it.
const hints = (words: string, cjk: string) => ({ words: new Set(words.split(" ")), cjk: new RegExp(cjk) });
const FLEXIBLE = hints(
  "hair bang bangs fringe ponytail twintail braid ahoge tail skirt dress cloth cape cloak mantle scarf ribbon sleeve robe coat tie string rope chain tentacle wing feather leaf flame fire smoke arm leg thigh shin forearm finger body torso chest breast belly neck mouth lip eyelid lid brow eyebrow cheek",
  "髪|前髪|後ろ髪|横髪|もみあげ|アホ毛|尻尾|しっぽ|スカート|服|袖|リボン|マント|マフラー|紐|羽|翼|腕|脚|太もも|体|胴|胸|首|口|唇|まぶた|眉|頬|머리카락|앞머리|뒷머리|옆머리|꼬리|치마|스커트|옷|소매|리본|망토|목도리|끈|날개|깃털|팔|다리|허벅지|몸|가슴|목|입|입술|눈꺼풀|눈썹|볼",
);
// compact parts that bend little: named "hand" inside an "arm" group they stay standard
const STANDARD = hints("hand palm fist glove foot feet shoe boot head face", "手|顔|頭|靴|足|손|발|얼굴|신발");
const RIGID = hints(
  "highlight shine sparkle glint reflex pupil iris button badge emblem logo earring pin gem jewel star dot bolt nail screw coin icon crosshair",
  "ハイライト|瞳|虹彩|ボタン|バッジ|ピアス|イヤリング|宝石|星|하이라이트|동공|눈동자|단추|버튼|배지|귀걸이|보석|별",
);
/** Words of a name: split at separators, digits and camelCase humps, lower case; a plural "s" also matches. */
function nameHas(name: string, h: { words: Set<string>; cjk: RegExp }): boolean {
  if (h.cjk.test(name)) return true;
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return words.some((w) => h.words.has(w) || (w.endsWith("s") && h.words.has(w.slice(0, -1))));
}

/** Measures the opaque part of an image. */
export function artStats(rgba: Uint8Array, width: number, height: number, alphaThreshold = 8): ArtStats {
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && rgba[(y * width + x) * 4 + 3] > alphaThreshold;
  let area = 0;
  let perimeter = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!solid(x, y)) continue;
      area++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      if (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)) perimeter++;
    }
  }
  if (!area) return { width, height, area: 0, perimeter: 0, complexity: 0, length: 0, breadth: 0, elongation: 1, pieces: [] };
  const mx = sx / area;
  const my = sy / area;
  const cxx = sxx / area - mx * mx;
  const cyy = syy / area - my * my;
  const cxy = sxy / area - mx * my;
  // principal spreads; a uniform bar of length L has variance L²/12
  const tr = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const length = Math.max(1, Math.sqrt(12 * (tr / 2 + disc)));
  const breadth = Math.max(1, Math.sqrt(12 * Math.max(0, tr / 2 - disc)));
  return {
    width,
    height,
    area,
    perimeter,
    complexity: (perimeter * perimeter) / (4 * Math.PI * area),
    length,
    breadth,
    elongation: length / breadth,
    pieces: findPieces(rgba, width, height, alphaThreshold, area),
  };
}

/**
 * Pieces far apart (a gap of about 1/12 of the art, at least 6 px): cells of that size holding art, joined when
 * they touch (8 neighbors). One box when splitting would not save much (the pieces fill most of the whole box).
 */
function findPieces(rgba: Uint8Array, width: number, height: number, threshold: number, area: number): Array<[number, number, number, number]> {
  const whole: Array<[number, number, number, number]> = [[0, 0, width, height]];
  const cell = Math.max(6, Math.round(Math.sqrt(area) / 12));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const has = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3] > threshold) has[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
  const label = new Int32Array(cols * rows).fill(-1);
  const boxes: Array<[number, number, number, number]> = [];
  for (let i = 0; i < cols * rows; i++) {
    if (!has[i] || label[i] >= 0) continue;
    const id = boxes.length;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cols;
      const cy = (c - cx) / cols;
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (has[n] && label[n] < 0) {
            label[n] = id;
            stack.push(n);
          }
        }
      }
    }
    const bx = x0 * cell;
    const by = y0 * cell;
    boxes.push([bx, by, Math.min(width, (x1 + 1) * cell) - bx, Math.min(height, (y1 + 1) * cell) - by]);
  }
  if (boxes.length < 2 || boxes.length > 8) return whole;
  const sum = boxes.reduce((s, b) => s + b[2] * b[3], 0);
  return sum < width * height * 0.55 ? boxes : whole;
}

/** The role for art: forced, else from its size, its name and its shape. */
export function meshRole(stats: ArtStats, ctx: MeshPlanContext = {}): { role: MeshRole; reasons: string[] } {
  if (ctx.role) return { role: ctx.role, reasons: [`role ${ctx.role} (given)`] };
  const size = Math.sqrt(stats.area);
  if (Math.max(stats.width, stats.height) < 24 || stats.area < 300) return { role: "rigid", reasons: [`small (${stats.width}x${stats.height} px)`] };
  const own = ctx.name ?? "";
  // the layer's own name first, then its shape, then its groups, nearest first (a "button" in a "coat" group is rigid)
  if (nameHas(own, RIGID)) return { role: "rigid", reasons: [`name "${own}"`] };
  if (nameHas(own, STANDARD)) return { role: "standard", reasons: [`name "${own}"`] };
  if (nameHas(own, FLEXIBLE)) return { role: "flexible", reasons: [`name "${own}"`] };
  if (stats.elongation >= 3) return { role: "flexible", reasons: [`long and thin (${stats.elongation.toFixed(1)}:1)`] };
  for (const g of [...(ctx.groups ?? [])].reverse()) {
    if (nameHas(g, RIGID)) return { role: "rigid", reasons: [`group "${g}"`] };
    if (nameHas(g, STANDARD)) return { role: "standard", reasons: [`group "${g}"`] };
    if (nameHas(g, FLEXIBLE)) return { role: "flexible", reasons: [`group "${g}"`] };
  }
  if (size < 40) return { role: "rigid", reasons: [`small (${stats.width}x${stats.height} px)`] };
  return { role: "standard", reasons: ["no hints: standard"] };
}

/** Vertex budget for art of this role and size. */
export function vertexBudget(stats: ArtStats, role: MeshRole, ctx: MeshPlanContext = {}): number {
  const size = Math.sqrt(stats.area);
  const k = (ctx.density ?? 1) * (ctx.target === "live2d" ? 1.25 : 1);
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)) * k);
  if (role === "rigid") return clamp(4 + size / 25, 4, 12);
  if (role === "standard") return clamp(10 + size / 10, 14, 60);
  return clamp(16 + size / 6 + 2 * Math.min(8, stats.elongation), 22, 110);
}

/** First settings for a budget: outline points take a share that grows with a ragged outline, the rest is interior. */
function firstOptions(stats: ArtStats, role: MeshRole, budget: number, threshold: number): AutoMeshOptions {
  const size = Math.sqrt(stats.area);
  // outline length of a traced hull: about the pixel perimeter for smooth art, less for ragged art
  const outline = stats.perimeter / Math.max(1, Math.sqrt(stats.complexity) * 0.8);
  const margin = Math.max(2, Math.min(8, Math.round(size * 0.02)));
  if (role === "rigid") {
    const points = Math.max(4, budget);
    return { outerInterval: round(Math.max(3, outline / points), 2), innerInterval: 1e6, outerMargin: margin, innerMargin: 0, minMargin: 1.5, minBoundaryPoints: 4, alphaThreshold: threshold, textureScale: 1 };
  }
  const share = Math.max(0.3, Math.min(0.5, 0.3 + 0.05 * (stats.complexity - 1)));
  // the inner ring repeats the outline once, so outline points count twice
  const outerN = Math.max(role === "flexible" ? 8 : 6, Math.round((budget * share) / 2));
  let outerInterval = Math.max(3, outline / outerN);
  const rest = Math.max(1, budget - 2 * outerN);
  let innerInterval = Math.max(4, Math.sqrt(stats.area / rest));
  if (role === "flexible" && stats.elongation >= 2) {
    // bends along its length: at least 8 steps
    outerInterval = Math.min(outerInterval, stats.length / 8);
    innerInterval = Math.min(innerInterval, stats.length / 6);
  }
  const innerMargin = Math.max(2, Math.min(stats.breadth / 4, outerInterval * 0.6));
  return {
    outerInterval: round(Math.max(3, outerInterval), 2),
    innerInterval: round(Math.max(4, innerInterval), 2),
    outerMargin: margin,
    innerMargin: round(innerMargin, 2),
    minMargin: 1.5,
    minBoundaryPoints: role === "flexible" ? 8 : 6,
    alphaThreshold: threshold,
    textureScale: 1,
  };
}

/** Coverage, overdraw and slivers of a pixel-space mesh (y down) over an image. */
export function meshQuality(px: Vec2[], triangles: Tri[], rgba: Uint8Array, width: number, height: number, alphaThreshold = 8): MeshQuality {
  const inside = new Uint8Array(width * height);
  let meshArea = 0;
  let slivers = 0;
  for (const [i, j, k] of triangles) {
    const a = px[i];
    const b = px[j];
    const c = px[k];
    const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    meshArea += Math.abs(area2) / 2;
    const sides = [Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(a[0] - c[0], a[1] - c[1]), Math.hypot(a[0] - b[0], a[1] - b[1])];
    const longest = Math.max(...sides);
    // smallest angle: sin(θ) = 2·area / (product of its two sides); a sliver is thin against its longest side
    const minHeight = Math.abs(area2) / (longest || 1);
    if (minHeight / (longest || 1) < Math.tan((8 * Math.PI) / 180) / 2) slivers++;
    if (Math.abs(area2) < 1e-9) continue;
    const s = area2 > 0 ? 1 : -1;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    // signed distance of a point from each edge (positive inside)
    const edge = (p: Vec2, q: Vec2, x: number, y: number) => (s * ((q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]))) / (Math.hypot(q[0] - p[0], q[1] - p[1]) || 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        // a hair outside still counts (texture filtering spreads pixels a little)
        if (edge(a, b, cx, cy) >= -0.5 && edge(b, c, cx, cy) >= -0.5 && edge(c, a, cx, cy) >= -0.5) inside[y * width + x] = 1;
      }
    }
  }
  let solid = 0;
  let total = 0;
  let covered = 0;
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a <= alphaThreshold) continue;
    solid++;
    total += a;
    if (inside[i]) covered += a;
  }
  return {
    vertices: px.length,
    triangles: triangles.length,
    coverage: total ? covered / total : 1,
    overdraw: solid ? round(meshArea / solid, 3) : 0,
    slivers,
  };
}

/** A copy of the image with only the pixels inside a box kept. */
function onlyBox(rgba: Uint8Array, width: number, height: number, [bx, by, bw, bh]: [number, number, number, number]): Uint8Array {
  if (bx === 0 && by === 0 && bw === width && bh === height) return rgba;
  const out = new Uint8Array(rgba.length);
  for (let y = by; y < by + bh; y++) out.set(rgba.subarray((y * width + bx) * 4, (y * width + bx + bw) * 4), (y * width + bx) * 4);
  return out;
}

/** Pixel-space (y down) automatic mesh of an image: every piece traced on its own, merged into one geometry. */
function tracePieces(rgba: Uint8Array, width: number, height: number, pieces: Array<[number, number, number, number]>, o: AutoMeshOptions): { px: Vec2[]; triangles: Tri[] } {
  const px: Vec2[] = [];
  const triangles: Tri[] = [];
  for (const box of pieces) {
    // a quad over the piece's box in pixel space (y down), so the generator's placement maps UV straight to pixels
    const [bx, by, bw, bh] = box;
    const u0 = bx / width;
    const v0 = by / height;
    const u1 = (bx + bw) / width;
    const v1 = (by + bh) / height;
    const quad: MeshAttachment = {
      type: "mesh",
      vertices: [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]],
      uvs: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
      triangles: [[0, 1, 2], [0, 2, 3]],
      weights: [[], [], [], []],
    };
    const g = meshAutoGenerate(quad, onlyBox(rgba, width, height, box), width, height, o);
    const base = px.length;
    px.push(...g.uvs!.map(([u, v]) => [u * width, v * height] as Vec2));
    triangles.push(...g.triangles.map((t) => t.map((i) => i + base) as Tri));
  }
  return { px, triangles };
}

/**
 * Plans and builds a mesh for an image: the role (from `ctx` hints and the art's shape), a vertex budget, settings
 * tuned until the vertex count is near the budget, then checked: when the trace leaves opaque pixels out, margins
 * grow; if that fails, a grid mesh is used. Returns pixel-space geometry (y down) and UVs over the whole image.
 */
export function planImageMesh(rgba: Uint8Array, width: number, height: number, ctx: MeshPlanContext = {}): { px: Vec2[]; uvs: Vec2[]; triangles: Tri[]; plan: MeshPlan } {
  const threshold = ctx.alphaThreshold ?? 8;
  const stats = artStats(rgba, width, height, threshold);
  if (!stats.area) throw new Error("the image has no pixels above the alpha threshold");
  const { role, reasons } = meshRole(stats, ctx);
  const target = vertexBudget(stats, role, ctx);
  let o = firstOptions(stats, role, target, threshold);
  if (stats.pieces.length > 1) reasons.push(`${stats.pieces.length} separate pieces, meshed apart`);
  const build = (opts: AutoMeshOptions) => {
    const m = tracePieces(rgba, width, height, stats.pieces, opts);
    return { ...m, quality: meshQuality(m.px, m.triangles, rgba, width, height, threshold) };
  };
  let best: ReturnType<typeof build> | null = null;
  let bestOpts = o;
  // tune toward the budget: fewer vertices than wanted -> smaller spacing, more -> larger
  for (let i = 0; i < 4; i++) {
    let m: ReturnType<typeof build>;
    try {
      m = build(o);
    } catch {
      break;
    }
    const off = (x: ReturnType<typeof build>) => Math.abs(x.quality.vertices - target) / target;
    if (!best || off(m) < off(best)) {
      best = m;
      bestOpts = o;
    }
    if (off(m) <= 0.2 || role === "rigid") break;
    const f = Math.sqrt(m.quality.vertices / target);
    const flex = role === "flexible" && stats.elongation >= 2 ? { outer: stats.length / 8, inner: stats.length / 6 } : { outer: Infinity, inner: Infinity };
    o = {
      ...o,
      outerInterval: round(Math.max(3, Math.min(flex.outer, o.outerInterval * f)), 2),
      innerInterval: round(Math.max(4, Math.min(flex.inner, o.innerInterval * f)), 2),
      innerMargin: round(Math.max(2, Math.min(stats.breadth / 4, o.innerMargin * Math.sqrt(f))), 2),
    };
  }
  // every opaque pixel must be drawn: a denser outline (art touching the image edge cannot get more room), wider
  // margins, then both
  const retries: Array<[string, (o: AutoMeshOptions) => AutoMeshOptions]> = [
    ["denser outline to cover the art", (o) => ({ ...o, outerInterval: round(Math.max(3, o.outerInterval * 0.6), 2), minBoundaryPoints: Math.max(o.minBoundaryPoints ?? 4, 8) })],
    ["wider margins to cover the art", (o) => ({ ...o, outerMargin: o.outerMargin + 2, minMargin: (o.minMargin ?? 1.5) + 1.5 })],
    ["denser outline and wider margins to cover the art", (o) => ({ ...o, outerInterval: round(Math.max(3, o.outerInterval * 0.4), 2), minBoundaryPoints: 12, outerMargin: o.outerMargin + 2, minMargin: (o.minMargin ?? 1.5) + 1.5 })],
  ];
  for (const [why, change] of retries) {
    if (!best || best.quality.coverage >= 0.999) break;
    const next = change(bestOpts);
    try {
      const m = build(next);
      if (m.quality.coverage > best.quality.coverage) {
        best = m;
        bestOpts = next;
        reasons.push(why);
      }
    } catch {
      /* keep the best so far */
    }
  }
  let method: "auto" | "grid" = "auto";
  if (!best || best.quality.coverage < 0.995) {
    const spacing = Math.max(8, Math.round(Math.max(width, height) / 8));
    const g = alphaGridMesh(rgba, width, height, spacing, threshold);
    best = { px: g.vertices, triangles: g.triangles, quality: meshQuality(g.vertices, g.triangles, rgba, width, height, threshold) };
    method = "grid";
    reasons.push("the traced outline missed art: grid mesh");
  }
  const uvs = best.px.map(([x, y]) => [round(x / width, 5), round(y / height, 5)] as Vec2);
  return { px: best.px, uvs, triangles: best.triangles, plan: { role, reasons, method, target, options: bestOpts, quality: best.quality, stats } };
}

/**
 * A planned mesh for an image attachment, placed through its current UV mapping (like the other mesh generators).
 * On a shared texture page only the part its UVs cover is used.
 */
export function meshAutoPlan(att: MeshAttachment, rgba: Uint8Array, width: number, height: number, ctx: MeshPlanContext = {}): { geometry: MeshGeometry; plan: MeshPlan } {
  if (!att.uvs?.length) throw new Error("the mesh has no image UVs to place a new mesh with");
  const box = uvRegion(att.uvs, width, height);
  let data = rgba;
  if (box.width !== width || box.height !== height) {
    data = new Uint8Array(box.width * box.height * 4);
    for (let y = 0; y < box.height; y++) data.set(rgba.subarray(((y + box.y) * width + box.x) * 4, ((y + box.y) * width + box.x + box.width) * 4), y * box.width * 4);
  }
  const part = planImageMesh(data, box.width, box.height, ctx);
  const r = { ...part, uvs: part.px.map(([x, y]) => [round((x + box.x) / width, 5), round((y + box.y) / height, 5)] as Vec2) };
  // UV -> world from the current mesh, then triangles made counter-clockwise in world space
  const toWorld = fitUvAffine(att.uvs, att.vertices);
  if (!toWorld) throw new Error("cannot derive the image placement from the current UVs (degenerate mesh)");
  const vertices = r.uvs.map((uv) => toWorld(uv).map((v) => round(v)) as Vec2);
  const triangles = r.triangles.map((t): Tri => (triArea(vertices[t[0]], vertices[t[1]], vertices[t[2]]) < 0 ? [t[0], t[2], t[1]] : t));
  return { geometry: { vertices, uvs: r.uvs, triangles }, plan: r.plan };
}

/** One-line summary of a plan for logs. */
export function describePlan(p: MeshPlan): string {
  const q = p.quality;
  return `${p.method === "grid" ? "grid" : p.role} mesh: ${q.vertices} vertices, ${q.triangles} triangles (aim ${p.target}), covers ${(q.coverage * 100).toFixed(1)}% · ${p.reasons.join("; ")}`;
}
