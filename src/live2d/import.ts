// Shared parts of the Live2D import (the model itself comes from a Cubism Editor .cmo3, cmo3.ts): motion3 curves
// (what the .can3 animation scenes become) -> animations, the default pose of the art meshes, and the meta the export
// keeps. Pure: file access is in index.ts.
import type { Animation, Key, Model, Vec2 } from "../core/types.ts";
import { live2dFrame, live2dVertices } from "../core/live2d.ts";

export interface Live2DImportResult {
  model: Model;
  log: string[];
  warnings: string[];
}

/** The shortest decimal that reads back as the same 32-bit float (moc3 stores f32). */
export function f32(n: number): number {
  const t = Math.fround(n);
  for (let p = 1; p < 10; p++) {
    const d = Number(t.toPrecision(p));
    if (Math.fround(d) === t) return d;
  }
  return t;
}
const r6 = f32;

export function defaultValues(model: Model): Record<string, number> {
  return Object.fromEntries((model.parameters ?? []).map((p) => [p.id, p.default]));
}

/** Refreshes every Live2D mesh's `vertices` (the pose at the parameter defaults). */
export function syncLive2DVertices(model: Model): void {
  if (!model.live2d) return;
  const frame = live2dFrame(model, defaultValues(model));
  for (const [id, att] of Object.entries(model.attachments)) {
    if (!att.live2d) continue;
    att.vertices = (live2dVertices(model, frame, id) ?? []).map(([x, y]) => [r6(x), r6(y)] as Vec2);
  }
}

// ---------- motions (motion3 JSON: what the .can3 animation scenes become)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Meta kept for the Live2D export: motion groups and fades, the .cmo3 parts palette order, and what models imported from
 * runtime files by older versions carry (model3 groups, hit areas, layout, cdi3, expressions...), written back as it was.
 */
export interface Live2DMeta {
  mocVersion?: number;
  canvasFlags?: number;
  /** Art mesh order of the moc3 (drawable indices), kept on export. */
  meshOrder?: string[];
  /** Texture image ids by texture number. */
  textures?: string[];
  /**
   * Order of the Cubism Editor's parts palette (from a .cmo3), depth first: "p:<part>", "d:<deformer>", "m:<art mesh>",
   * "g:<glue>". The editor lists parts and deformers in this order; objects not in it follow.
   */
  treeOrder?: string[];
  groups?: Json;
  hitAreas?: Json;
  layout?: Json;
  pose?: Json;
  userData?: Json;
  displayInfo?: Json;
  expressions?: Array<{ name: string; file: string; json: Json }>;
  /** Per animation: its model3 motion group and the motion3 fields Awaken2D does not model. */
  motions?: Record<string, { group: string; index: number; file: string; duration?: number; fadeIn?: number; fadeOut?: number; fps?: number; restricted?: boolean; curves?: Json; curveFades?: Json }>;
}

export function live2dMeta(model: Model): Live2DMeta {
  const m = (model.meta ??= {}) as Record<string, unknown>;
  return (m.live2d ??= {}) as Live2DMeta;
}

/** Adds motions (motion3 JSON) as animations; the export writes them back with the fields kept in meta. */
export function applyLive2DMotions(res: Live2DImportResult, motions: Array<{ group: string; index: number; file: string; json: Json }>): void {
  const { model, log, warnings } = res;
  const meta = live2dMeta(model);
  const usedNames = new Set(Object.keys(model.animations ?? {}));
  meta.motions = {};
  const orphanIds = new Set<string>();
  let orphanMotions = 0;
  for (const mo of motions) {
    let name = mo.file.split("/").pop()!.replace(/\.motion3\.json$/i, "").replace(/\.json$/i, "") || `${mo.group}_${mo.index}`;
    while (usedNames.has(name)) name += "_";
    usedNames.add(name);
    const { anim, extra, notes } = motionToAnimation(mo.json);
    // curves for ids the moc does not have (renamed or deleted in the editor) do nothing in Cubism: kept for export only
    const params = new Set((model.parameters ?? []).map((p) => p.id));
    const parts = new Set(model.live2d!.parts.map((p) => p.id));
    const orphans: string[] = [];
    for (const [kind, known, target] of [
      ["params", params, "Parameter"],
      ["partOpacity", parts, "PartOpacity"],
    ] as const) {
      for (const id of Object.keys(anim[kind] ?? {})) {
        if (known.has(id)) continue;
        delete anim[kind]![id];
        orphans.push(id);
        const raw = (mo.json?.Curves ?? []).find((c: Json) => c.Target === target && c.Id === id);
        if (raw) ((extra.curves ??= []) as Json[]).push(raw);
      }
      if (anim[kind] && !Object.keys(anim[kind]!).length) delete anim[kind];
    }
    for (const id of orphans) orphanIds.add(id);
    if (orphans.length) orphanMotions++;
    model.animations![name] = anim;
    meta.motions[name] = { group: mo.group, index: mo.index, file: mo.file, ...extra };
    for (const n of notes) warnings.push(`${name}: ${n}`);
  }
  if (orphanIds.size) warnings.push(`${orphanMotions} motion(s) have curves for ${[...orphanIds].join(", ")}, which the moc3 does not have: kept for export only`);
  if (Object.values(model.animations ?? {}).some((a) => a.events?.length)) model.events = { ...(model.events ?? {}), user: model.events?.user ?? {} };
  if (motions.length) log.push(`${motions.length} motion(s)`);
}

/** Splits a cubic (t, v) bezier at s (de Casteljau). */
function splitBezier(p: number[][], s: number): [number[][], number[][]] {
  const L = (a: number[], b: number[]) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const p01 = L(p[0], p[1]);
  const p12 = L(p[1], p[2]);
  const p23 = L(p[2], p[3]);
  const p012 = L(p01, p12);
  const p123 = L(p12, p23);
  const m = L(p012, p123);
  return [
    [p[0], p01, p012, m],
    [m, p123, p23, p[3]],
  ];
}

/**
 * motion3.json -> Awaken2D animation. Cubism's default bezier (the "Cardano" evaluation) solves the time handles like
 * Awaken2D's eases; restricted beziers ignore them (time handles at thirds). A flat segment with bulging handles is
 * split until every piece has a value change to normalize against.
 */
export function motionToAnimation(json: Json): { anim: Animation; extra: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const metaIn = json?.Meta ?? {};
  const restricted = !!metaIn.AreBeziersRestricted;
  const loop = !!metaIn.Loop;
  // a looping motion (Cubism motion behavior v2) repeats every Duration + one frame, closing linearly to the start
  const fileDuration = metaIn.Duration ?? 0;
  const duration = loop ? Math.round((fileDuration + 1 / (metaIn.Fps > 0 ? metaIn.Fps : 30)) * 1e7) / 1e7 : fileDuration;
  const anim: Animation = { duration, loop };
  const extra: Record<string, unknown> = {};
  if (metaIn.FadeInTime !== undefined) extra.fadeIn = metaIn.FadeInTime;
  if (metaIn.FadeOutTime !== undefined) extra.fadeOut = metaIn.FadeOutTime;
  if (metaIn.Fps !== undefined) extra.fps = metaIn.Fps;
  if (restricted) extra.restricted = true;
  if (loop) extra.duration = fileDuration;
  const keep: Json[] = [];
  const curveFades: Record<string, Json> = {};
  for (const c of json?.Curves ?? []) {
    const seg: number[] = c.Segments ?? [];
    if (seg.length < 2) continue;
    const keys: Key<number>[] = [{ t: seg[0], v: seg[1] }];
    const firstValue = keys[0].v;
    let lastType = 0;
    for (let i = 2; i < seg.length; ) {
      const type = seg[i];
      const prev = keys[keys.length - 1];
      lastType = type;
      if (type === 0 || type === 2 || type === 3) {
        const t = seg[i + 1];
        const v = seg[i + 2];
        if (type === 2) prev.ease = "stepped";
        if (type === 3) {
          // inverse stepped: the next value right away
          prev.ease = "stepped";
          keys.push({ t: prev.t, v, ease: "stepped" });
        }
        keys.push({ t, v });
        i += 3;
      } else if (type === 1) {
        const pts = [
          [prev.t, prev.v],
          [seg[i + 1], seg[i + 2]],
          [seg[i + 3], seg[i + 4]],
          [seg[i + 5], seg[i + 6]],
        ];
        i += 7;
        const emit = (p: number[][], depth: number) => {
          const from = keys[keys.length - 1];
          const dt = p[3][0] - p[0][0];
          const dv = p[3][1] - p[0][1];
          const flatHandles = Math.abs(p[1][1] - p[0][1]) < 1e-9 && Math.abs(p[2][1] - p[0][1]) < 1e-9;
          if (Math.abs(dv) < 1e-9 && !flatHandles && depth < 4) {
            const [a, b] = splitBezier(p, 0.5);
            emit(a, depth + 1);
            emit(b, depth + 1);
            return;
          }
          if (Math.abs(dv) >= 1e-9 && dt > 0) {
            const x1 = restricted ? 1 / 3 : Math.min(1, Math.max(0, (p[1][0] - p[0][0]) / dt));
            const x2 = restricted ? 2 / 3 : Math.min(1, Math.max(0, (p[2][0] - p[0][0]) / dt));
            const y1 = (p[1][1] - p[0][1]) / dv;
            const y2 = (p[2][1] - p[0][1]) / dv;
            const linear = Math.abs(x1 - y1) < 1e-7 && Math.abs(x2 - y2) < 1e-7;
            if (!linear) from.ease = [x1, y1, x2, y2].map((n) => Math.round(n * 1e7) / 1e7) as [number, number, number, number];
          }
          keys.push({ t: Math.round(p[3][0] * 1e7) / 1e7, v: Math.round(p[3][1] * 1e7) / 1e7 });
        };
        emit(pts, 0);
      } else {
        notes.push(`curve ${c.Id}: unknown segment type ${type}, rest of the curve skipped`);
        break;
      }
    }
    // the loop closes linearly from the last point back to the first value
    const last = keys[keys.length - 1];
    if (loop && last.t < duration - 1e-6 && Math.abs(last.v - firstValue) > 1e-9) {
      if (lastType === 2) last.ease = "stepped";
      if (lastType === 3) {
        last.ease = "stepped";
        keys.push({ t: last.t, v: firstValue, ease: "stepped" });
      }
      keys.push({ t: duration, v: firstValue });
    }
    if (c.FadeInTime !== undefined || c.FadeOutTime !== undefined) curveFades[`${c.Target}/${c.Id}`] = { fadeIn: c.FadeInTime, fadeOut: c.FadeOutTime };
    if (c.Target === "Parameter") (anim.params ??= {})[c.Id] = keys;
    else if (c.Target === "PartOpacity") (anim.partOpacity ??= {})[c.Id] = keys;
    else keep.push(c);
  }
  if (keep.length) {
    extra.curves = keep;
    notes.push(`${keep.length} "Model" curve(s) (model opacity, eye blink / lip sync) kept for export only`);
  }
  if (Object.keys(curveFades).length) extra.curveFades = curveFades;
  const ud = json?.UserData ?? [];
  if (ud.length) anim.events = ud.map((u: Json) => ({ t: u.Time ?? 0, name: "user", string: String(u.Value ?? "") }));
  return { anim, extra, notes };
}
