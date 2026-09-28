// Mesh and weight editing primitives shared by ops (agents, CLI) and the editor's brushes.
import { alphaGridMesh, delaunay, triArea } from "./geometry.ts";
import { round } from "./math.ts";
import type { MeshAttachment, Tri, Vec2, VertexOffsets } from "./types.ts";

type Weights = MeshAttachment["weights"];

/** Least-squares affine map from positions to UVs (exact for meshes made from one image rect). */
export function fitUvAffine(verts: Vec2[], uvs: Vec2[]): ((p: Vec2) => Vec2) | null {
  // normal equations for [x y 1] * [a b c]^T = u (and the same for v)
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = 0;
  let sxu = 0, syu = 0, su = 0, sxv = 0, syv = 0, sv = 0;
  verts.forEach(([x, y], i) => {
    const [u, v] = uvs[i];
    sxx += x * x; sxy += x * y; sx += x; syy += y * y; sy += y; n++;
    sxu += x * u; syu += y * u; su += u; sxv += x * v; syv += y * v; sv += v;
  });
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const solve = (b: number[]): number[] | null => {
    const a = m.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-12) return null;
      [a[c], a[piv]] = [a[piv], a[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = a[r][c] / a[c][c];
        for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
      }
    }
    return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
  };
  const cu = solve([sxu, syu, su]);
  const cv = solve([sxv, syv, sv]);
  if (!cu || !cv) return null;
  return ([x, y]) => [cu[0] * x + cu[1] * y + cu[2], cv[0] * x + cv[1] * y + cv[2]];
}

const r4 = (n: number) => round(n, 4);

/** Moves vertices to absolute setup positions. keepImage re-derives UVs so the texture stays put. */
export function moveVertices(att: MeshAttachment, moves: Array<[number, number, number]>, keepImage = true): MeshAttachment {
  const out = structuredClone(att);
  const map = keepImage && att.uvs ? fitUvAffine(att.vertices, att.uvs) : null;
  for (const [i, x, y] of moves) {
    if (!Number.isInteger(i) || i < 0 || i >= out.vertices.length) throw new Error(`vertex ${i} does not exist (mesh has ${out.vertices.length})`);
    out.vertices[i] = [round(x), round(y)];
    if (map && out.uvs) out.uvs[i] = map(out.vertices[i]).map(r4) as Vec2;
  }
  return out;
}

function barycentric(p: Vec2, a: Vec2, b: Vec2, c: Vec2): [number, number, number] | null {
  const area = triArea(a, b, c);
  if (Math.abs(area) < 1e-12) return null;
  const w0 = triArea(p, b, c) / area;
  const w1 = triArea(a, p, c) / area;
  return [w0, w1, 1 - w0 - w1];
}

/** Blends per-vertex weight lists; keeps the 4 strongest influences, normalized. */
export function blendWeights(lists: Array<Array<[string, number]>>, factors: number[]): Array<[string, number]> {
  const acc = new Map<string, number>();
  lists.forEach((l, i) => {
    const total = l.reduce((s, [, w]) => s + w, 0) || 1;
    for (const [b, w] of l) acc.set(b, (acc.get(b) ?? 0) + (w / total) * factors[i]);
  });
  return normalizeInfluences([...acc.entries()]);
}

export function normalizeInfluences(list: Array<[string, number]>, maxInfluences = 4): Array<[string, number]> {
  const kept = list.filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maxInfluences);
  const sum = kept.reduce((s, [, w]) => s + w, 0);
  if (!(sum > 0)) return list.length ? [[list[0][0], 1]] : [];
  const out = kept.map(([b, w]) => [b, r4(w / sum)] as [string, number]);
  out[0][1] = r4(out[0][1] + 1 - out.reduce((s, [, w]) => s + w, 0));
  return out;
}

/**
 * Inserts a vertex at a setup-space point inside the mesh, splitting the triangle(s) it lands in
 * (two on an edge). Weights and UVs are interpolated. The new vertex gets the last index.
 */
export function addVertex(att: MeshAttachment, p: Vec2): { att: MeshAttachment; index: number } {
  const out = structuredClone(att);
  const n = out.vertices.length;
  const hits: Array<{ t: number; w: [number, number, number] }> = [];
  out.triangles.forEach((tri, t) => {
    const w = barycentric(p, out.vertices[tri[0]], out.vertices[tri[1]], out.vertices[tri[2]]);
    if (w && w.every((x) => x >= -1e-9)) hits.push({ t, w });
  });
  if (!hits.length) throw new Error(`point (${p[0]}, ${p[1]}) is outside the mesh`);
  const { t, w } = hits[0];
  const src = out.triangles[t];
  if (w.some((x, k) => x > 1 - 1e-6 && src[k] !== undefined)) throw new Error("a vertex already exists at that point");
  out.vertices.push([round(p[0]), round(p[1])]);
  out.weights.push(blendWeights(src.map((i) => out.weights[i]), w));
  if (out.uvs) {
    const uv = src.map((i) => out.uvs![i]);
    out.uvs.push([r4(uv[0][0] * w[0] + uv[1][0] * w[1] + uv[2][0] * w[2]), r4(uv[0][1] * w[0] + uv[1][1] * w[1] + uv[2][1] * w[2])]);
  }
  const split = new Set(hits.map((h) => h.t));
  const tris: Tri[] = [];
  out.triangles.forEach((tri, k) => {
    if (!split.has(k)) return void tris.push(tri);
    for (const [a, b] of [
      [tri[0], tri[1]],
      [tri[1], tri[2]],
      [tri[2], tri[0]],
    ]) {
      const nt: Tri = [a, b, n];
      if (Math.abs(triArea(out.vertices[a], out.vertices[b], out.vertices[n])) > 1e-9) tris.push(nt);
    }
  });
  out.triangles = tris;
  return { att: out, index: n };
}

/** Ear clipping of a simple polygon given as vertex indices (either winding); returns CCW triangles. */
function earClip(poly: number[], pos: Vec2[]): Tri[] {
  const ring = [...poly];
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = pos[ring[i]];
    const b = pos[ring[(i + 1) % ring.length]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) ring.reverse();
  const out: Tri[] = [];
  let guard = 0;
  while (ring.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const ia = ring[(i + ring.length - 1) % ring.length];
      const ib = ring[i];
      const ic = ring[(i + 1) % ring.length];
      if (triArea(pos[ia], pos[ib], pos[ic]) <= 1e-12) continue;
      const inside = ring.some((j) => j !== ia && j !== ib && j !== ic && (barycentric(pos[j], pos[ia], pos[ib], pos[ic])?.every((x) => x > 1e-9) ?? false));
      if (inside) continue;
      out.push([ia, ib, ic]);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate leftovers: fan the rest
  }
  for (let i = 1; i + 1 < ring.length; i++) {
    const t: Tri = [ring[0], ring[i], ring[i + 1]];
    if (Math.abs(triArea(pos[t[0]], pos[t[1]], pos[t[2]])) > 1e-12) out.push(triArea(pos[t[0]], pos[t[1]], pos[t[2]]) > 0 ? t : [t[0], t[2], t[1]]);
  }
  return out;
}

/**
 * Removes vertices, re-triangulating the holes they leave. Returns the new attachment and an index map
 * (old index -> new index, or -1 when removed) for updating anything that refers to vertex indices.
 */
export function removeVertices(att: MeshAttachment, indices: number[]): { att: MeshAttachment; remap: number[] } {
  let cur = structuredClone(att);
  const n0 = att.vertices.length;
  const unique = [...new Set(indices)].sort((a, b) => b - a);
  for (const v of unique) {
    if (!Number.isInteger(v) || v < 0 || v >= n0) throw new Error(`vertex ${v} does not exist (mesh has ${n0})`);
  }
  if (n0 - unique.length < 3) throw new Error("a mesh needs at least 3 vertices");
  let remap = Array.from({ length: n0 }, (_, i) => i);
  for (const v of unique) {
    const around = cur.triangles.filter((t) => t.includes(v));
    const rest = cur.triangles.filter((t) => !t.includes(v));
    // ring of neighbours in CCW order: each triangle (v, a, b) contributes the edge a -> b
    const next = new Map<number, number>();
    for (const t of around) {
      const k = t.indexOf(v);
      next.set(t[(k + 1) % 3], t[(k + 2) % 3]);
    }
    const targets = new Set(next.values());
    const start = [...next.keys()].find((a) => !targets.has(a)) ?? next.keys().next().value;
    const ring: number[] = [];
    for (let a = start; a !== undefined && !ring.includes(a); a = next.get(a)) ring.push(a);
    const fill = ring.length >= 3 ? earClip(ring, cur.vertices) : [];
    const tris = [...rest, ...fill].map((t) => t.map((i) => (i > v ? i - 1 : i)) as Tri);
    cur = {
      ...cur,
      vertices: cur.vertices.filter((_, i) => i !== v),
      uvs: cur.uvs?.filter((_, i) => i !== v),
      weights: cur.weights.filter((_, i) => i !== v),
      triangles: tris,
    };
    remap = remap.map((i) => (i === v ? -1 : i > v ? i - 1 : i));
  }
  if (!cur.uvs) delete cur.uvs;
  return { att: cur, remap };
}

/** Delaunay re-triangulation of the current vertices, keeping only triangles inside the old mesh. */
export function retriangulate(att: MeshAttachment): MeshAttachment {
  const inside = (p: Vec2) =>
    att.triangles.some((t) => barycentric(p, att.vertices[t[0]], att.vertices[t[1]], att.vertices[t[2]])?.every((x) => x >= -1e-9) ?? false);
  const tris = delaunay(att.vertices).filter(([a, b, c]) => {
    const v = att.vertices;
    return inside([(v[a][0] + v[b][0] + v[c][0]) / 3, (v[a][1] + v[b][1] + v[c][1]) / 3]);
  });
  if (!tris.length) throw new Error("re-triangulation produced no triangles");
  return { ...structuredClone(att), triangles: tris };
}

export type WeightMode = "set" | "add" | "multiply" | "smooth";

/** Vertex neighbours via triangle edges. */
export function vertexNeighbors(att: MeshAttachment): Set<number>[] {
  const nb = att.vertices.map(() => new Set<number>());
  for (const [a, b, c] of att.triangles) {
    nb[a].add(b).add(c);
    nb[b].add(a).add(c);
    nb[c].add(a).add(b);
  }
  return nb;
}

/**
 * Changes one bone's influence per vertex, scaled by `strength` (0..1 per vertex); the other bones share the rest
 * in their existing proportions. "smooth" averages each vertex with its neighbours (bone is ignored).
 */
export function adjustWeights(att: MeshAttachment, bone: string, mode: WeightMode, value: number, strength: number[]): Weights {
  const weights = att.weights;
  if (mode === "smooth") {
    const nb = vertexNeighbors(att);
    return weights.map((w, i) => {
      const s = strength[i] ?? 0;
      if (!(s > 0) || !nb[i].size) return w;
      const avg = blendWeights([...nb[i]].map((j) => weights[j]), [...nb[i]].map(() => 1 / nb[i].size));
      return blendWeights([w, avg], [1 - s, s]);
    });
  }
  return weights.map((w, i) => {
    const s = Math.max(0, Math.min(1, strength[i] ?? 0));
    if (!(s > 0)) return w;
    const total = w.reduce((sum, [, x]) => sum + x, 0) || 1;
    const norm = w.map(([b, x]) => [b, x / total] as [string, number]);
    const cur = norm.find(([b]) => b === bone)?.[1] ?? 0;
    const target = mode === "set" ? value : mode === "add" ? cur + value : cur * value;
    const next = Math.max(0, Math.min(1, cur + (target - cur) * s));
    const others = norm.filter(([b]) => b !== bone);
    const rest = 1 - cur;
    if (!others.length && next < 1) return w; // nothing to hand the weight to
    const scaled = others.map(([b, x]) => [b, rest > 1e-9 ? (x / rest) * (1 - next) : (1 - next) / others.length] as [string, number]);
    return normalizeInfluences([...scaled, [bone, next]], 8);
  });
}

/** Per-vertex strength: listed vertices (1), a circle with optional smooth falloff, or every vertex. */
export function weightMask(verts: Vec2[], opts: { vertices?: number[]; region?: { center: Vec2; radius: number; falloff?: boolean } }): number[] {
  if (opts.vertices) {
    const set = new Set(opts.vertices);
    return verts.map((_, i) => (set.has(i) ? 1 : 0));
  }
  if (opts.region) {
    const { center, radius, falloff } = opts.region;
    return verts.map((p) => {
      const d = Math.hypot(p[0] - center[0], p[1] - center[1]) / Math.max(radius, 1e-9);
      if (d >= 1) return 0;
      if (!falloff) return 1;
      const k = 1 - d;
      return k * k * (3 - 2 * k);
    });
  }
  return verts.map(() => 1);
}

// ---------- re-meshing

/**
 * Where a point lands in a mesh: the containing triangle and barycentric weights. Points outside every
 * triangle use the closest one (weights clamped to its edges), so shapes and weights extend to new border
 * vertices sensibly.
 */
export function locateInMesh(verts: Vec2[], tris: Tri[], p: Vec2): { tri: Tri; w: [number, number, number] } | null {
  let best: { tri: Tri; w: [number, number, number] } | null = null;
  let bestD = Infinity;
  for (const tri of tris) {
    const w = barycentric(p, verts[tri[0]], verts[tri[1]], verts[tri[2]]);
    if (!w) continue;
    if (w.every((x) => x >= -1e-9)) return { tri, w };
    // distance outside: how far the most negative coordinate is below zero, scaled by the triangle size
    const c = w.map((x) => Math.max(0, x)) as [number, number, number];
    const sum = c[0] + c[1] + c[2] || 1;
    const q: [number, number, number] = [c[0] / sum, c[1] / sum, c[2] / sum];
    const px = q[0] * verts[tri[0]][0] + q[1] * verts[tri[1]][0] + q[2] * verts[tri[2]][0];
    const py = q[0] * verts[tri[0]][1] + q[1] * verts[tri[1]][1] + q[2] * verts[tri[2]][1];
    const d = Math.hypot(px - p[0], py - p[1]);
    if (d < bestD) {
      bestD = d;
      best = { tri, w: q };
    }
  }
  return best;
}

export interface MeshGeometry {
  vertices: Vec2[];
  uvs?: Vec2[];
  triangles: Tri[];
}

/**
 * New geometry for an image mesh from the image's alpha: a grid of `spacing` image pixels over the solid
 * area (as the importer makes). Placement comes from the mesh's current UV mapping, so the art stays exactly
 * where it is. Triangles are counter-clockwise in world space.
 */
export function remeshFromAlpha(att: MeshAttachment, rgba: Uint8Array, width: number, height: number, spacing: number, threshold = 4): MeshGeometry {
  if (!att.uvs?.length) throw new Error("the mesh has no image UVs to place a new mesh with");
  const toWorld = fitUvAffine(att.uvs, att.vertices);
  if (!toWorld) throw new Error("cannot derive the image placement from the current UVs (degenerate mesh)");
  const grid = alphaGridMesh(rgba, width, height, Math.max(2, spacing), threshold);
  if (!grid.triangles.length) throw new Error("the image has no opaque pixels");
  const uvs = grid.vertices.map(([x, y]) => [r4(x / width), r4(y / height)] as Vec2);
  const vertices = uvs.map((uv) => toWorld(uv).map((v) => round(v)) as Vec2);
  const triangles = grid.triangles.map((t): Tri => (triArea(vertices[t[0]], vertices[t[1]], vertices[t[2]]) < 0 ? [t[0], t[2], t[1]] : t));
  return { vertices, uvs, triangles };
}

/** Resamples per-vertex data of `old` at new setup-space points (barycentric in the old triangles). */
export function transferToPoints(old: MeshAttachment, points: Vec2[]): {
  weights: Weights;
  offsets: (sparse: VertexOffsets) => VertexOffsets;
} {
  const loc = points.map((p) => locateInMesh(old.vertices, old.triangles, p));
  const weights = loc.map((l, i) =>
    l ? blendWeights(l.tri.map((v) => old.weights[v] ?? []), l.w) : (old.weights[nearest(old.vertices, points[i])] ?? [["root", 1]]),
  ) as Weights;
  const offsets = (sparse: VertexOffsets): VertexOffsets => {
    const dense = new Map<number, [number, number]>();
    for (const [i, dx, dy] of sparse) dense.set(i, [dx, dy]);
    const out: VertexOffsets = [];
    loc.forEach((l, i) => {
      if (!l) return;
      let dx = 0;
      let dy = 0;
      l.tri.forEach((v, k) => {
        const d = dense.get(v);
        if (d) {
          dx += d[0] * l.w[k];
          dy += d[1] * l.w[k];
        }
      });
      if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) out.push([i, round(dx), round(dy)]);
    });
    return out;
  };
  return { weights, offsets };
}

function nearest(verts: Vec2[], p: Vec2): number {
  let best = 0;
  let bestD = Infinity;
  verts.forEach((v, i) => {
    const d = (v[0] - p[0]) ** 2 + (v[1] - p[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
