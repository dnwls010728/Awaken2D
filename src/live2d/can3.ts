// Cubism Editor animation file (.can3) -> motion3 JSON, one per scene. Pure. The container and main.xml are the
// same as a .cmo3's (caff.ts, cmo3.ts's XML reader); the motions then go through the motion3 import like a runtime
// export's, so they play the same way.
//
// A scene has a model track whose attributes are the animated values: "live2dParam_<id>" (a parameter) and
// "live2DPartsOpacity_<id>" (a part's opacity), each referring to the model object by guid. An attribute's keys are
// CBezierPt: an anchor (frame, value) with two handles (fractional frame, value); the curve type of the segment that
// starts at a key is SMOOTH or BEZIER (a cubic through the handles), LINEAR, STEP or INVERSE_STEP. The runtime export
// writes the handles as they are (frames / fps) and holds the last value to the end of the scene.
import { Graph, parseXml } from "./cmo3.ts";
import type { XNode } from "./cmo3.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface Can3Motion {
  /** Scene name (the motion's name). */
  name: string;
  /** motion3.json content. */
  json: Json;
}

export interface Can3Result {
  motions: Can3Motion[];
  warnings: string[];
}

/**
 * Reads the scenes of a can3's main.xml. `uuids` maps the model's parameter / part guids to their ids (from the
 * .cmo3 import); attributes of objects the model does not have are skipped with a warning.
 */
type Pt = [number, number];
interface Seg {
  /** motion3 segment type: 0 linear, 1 bezier, 2 stepped, 3 inverse stepped. */
  type: number;
  /** Start, (bezier handles,) end. */
  p: Pt[];
}

const lerp = (a: Pt, b: Pt, s: number): Pt => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
/** Splits a bezier (t, v) at time t: [left, right]. */
function splitAt(p: Pt[], t: number): [Pt[], Pt[]] {
  const at = (s: number) => {
    const a = lerp(p[0], p[1], s), b = lerp(p[1], p[2], s), c = lerp(p[2], p[3], s);
    const d = lerp(a, b, s), e = lerp(b, c, s);
    return { a, c, d, e, f: lerp(d, e, s) };
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid).f[0] < t) lo = mid;
    else hi = mid;
  }
  const r = at((lo + hi) / 2);
  return [
    [p[0], r.a, r.d, r.f],
    [r.f, r.e, r.c, p[3]],
  ];
}
/** A segment's value at time t (for the linear / step kinds). */
const valueAt = (s: Seg, t: number) => (s.type === 0 ? lerp(s.p[0], s.p[1], (t - s.p[0][0]) / (s.p[1][0] - s.p[0][0] || 1))[1] : s.type === 2 ? s.p[0][1] : s.p[1][1]);

/**
 * motion3 segments for keys cut to the exported range 0..duration (segments across an end are split there, like
 * the runtime export), the last value held to the end.
 */
function trim(segs: Seg[], first: Pt, duration: number): number[] {
  const cut = (s: Seg, t: number, keep: "left" | "right"): Seg => {
    if (s.type === 1) {
      const [l, r] = splitAt(s.p, t);
      l[3] = [t, l[3][1]];
      r[0] = [t, r[0][1]];
      return { type: 1, p: keep === "left" ? l : r };
    }
    const q: Pt = [t, valueAt(s, t)];
    return { type: s.type, p: keep === "left" ? [s.p[0], q] : [q, s.p[s.p.length - 1]] };
  };
  const out: Seg[] = [];
  let start: Pt = first;
  for (const s of segs) {
    let x = s;
    const t0 = x.p[0][0];
    const t1 = x.p[x.p.length - 1][0];
    if (t1 <= 0) {
      start = x.p[x.p.length - 1];
      continue;
    }
    if (t0 >= duration) break;
    if (t0 < 0) x = cut(x, 0, "right");
    if (t1 > duration) x = cut(x, duration, "left");
    if (!out.length) start = x.p[0];
    out.push(x);
  }
  if (!out.length && start[0] < 0) start = [0, start[1]];
  const seg: number[] = [...start];
  for (const s of out) for (const q of [s.type, ...s.p.slice(1).flat()]) seg.push(q);
  const lastT = seg[seg.length - 2];
  if (lastT < duration - 1e-9) seg.push(0, duration, seg[seg.length - 1]);
  return seg;
}

export function can3ToMotions(xml: string, uuids: Map<string, { kind: "parameter" | "part"; id: string }>): Can3Result {
  const doc = parseXml(xml);
  const g = new Graph(doc);
  const warnings: string[] = [];
  const all: XNode[] = [];
  const walk = (e: XNode) => {
    all.push(e);
    for (const c of e.children) walk(c);
  };
  walk(doc);
  const scenes = all.filter((e) => e.tag === "CSceneSource" && e.attrs["xs.id"]);
  // attributes, grouped by the model track they animate
  const attrsByTrack = new Map<XNode, XNode[]>();
  for (const e of all) {
    if (e.tag !== "CMvAttrF" || !e.attrs["xs.id"]) continue;
    const track = g.field(e, "track");
    if (!track) continue;
    if (!attrsByTrack.has(track)) attrsByTrack.set(track, []);
    attrsByTrack.get(track)!.push(e);
  }
  const motions: Can3Motion[] = [];
  const unknown = new Set<string>();
  for (const scene of scenes) {
    const name = g.str(scene, "sceneName") ?? `scene${motions.length + 1}`;
    const info = g.field(scene, "movieInfo");
    const fps = g.num(info, "fps", 30) || 30;
    // the export covers the scene's work area
    const start = g.num(info, "workspaceStart", 0);
    const end = g.num(info, "workspaceEnd", g.num(info, "duration", 1) - 1);
    const duration = Math.max(0, end - start) / fps;
    const tracks = g.list(g.field(scene, "trackSourceSet"), "_sources").filter((t) => t.tag === "CMvTrack_Live2DModel_Source");
    const curves: Json[] = [];
    for (const track of tracks) {
      for (const attr of attrsByTrack.get(track) ?? []) {
        const attrId = g.field(attr, "id")?.attrs.idstr ?? "";
        const kind = attrId.startsWith("live2dParam_") ? "Parameter" : attrId.startsWith("live2DPartsOpacity_") ? "PartOpacity" : null;
        if (!kind) continue;
        const uuid = g.field(attr, "guid")?.attrs.uuid;
        const ref = uuid ? uuids.get(uuid) : undefined;
        const id = ref && ref.kind === (kind === "Parameter" ? "parameter" : "part") ? ref.id : attrId.replace(/^live2d\w+?_/i, "");
        if (id === "__RootPart__") continue;
        // an attribute of a parameter or part the model no longer has (deleted in the editor): nothing to drive
        if (!ref) {
          unknown.add(`${id} (${g.str(attr, "name") ?? ""})`);
          if (uuid) continue;
        }
        const seq = g.field(attr, "valueData");
        const points = g.list(seq, "points");
        if (!points.length) continue;
        const types = g.list(seq, "curveTypes").map((c) => c.attrs.v ?? "SMOOTH");
        const anchor = (p: XNode): [number, number] => {
          const a = g.field(p, "anchor");
          return [(g.num(a, "pos") - start) / fps, g.num(a, "doubleValue")];
        };
        const handle = (p: XNode, side: "next" | "prev"): [number, number] => {
          const h = g.field(p, side);
          return [(g.num(h, "posF") - start) / fps, g.num(h, "doubleValue")];
        };
        const segs: Seg[] = [];
        for (let k = 0; k + 1 < points.length; k++) {
          const type = types[k] ?? "SMOOTH";
          const p0 = anchor(points[k]);
          const p1 = anchor(points[k + 1]);
          segs.push(
            type === "LINEAR" || type === "STEP" || type === "INVERSE_STEP"
              ? { type: type === "LINEAR" ? 0 : type === "STEP" ? 2 : 3, p: [p0, p1] }
              : { type: 1, p: [p0, handle(points[k], "next"), handle(points[k + 1], "prev"), p1] },
          );
        }
        const seg = trim(segs, anchor(points[0]), duration);
        const curve: Json = { Target: kind, Id: id, Segments: seg };
        const opt = g.field(attr, "optionParam");
        const fadeIn = g.num(opt, "KEY_ATTR_FADE_IN", -1);
        const fadeOut = g.num(opt, "KEY_ATTR_FADE_OUT", -1);
        if (fadeIn >= 0) curve.FadeInTime = fadeIn / 1000;
        if (fadeOut >= 0) curve.FadeOutTime = fadeOut / 1000;
        curves.push(curve);
      }
    }
    const fadeIn = g.num(info, "fadeInMSec", -1);
    const fadeOut = g.num(info, "fadeOutMSec", -1);
    const segCount = (s: number[]) => {
      let n = 0;
      for (let i = 2; i < s.length; n++) i += s[i] === 1 ? 7 : 3;
      return n;
    };
    motions.push({
      name,
      json: {
        Version: 3,
        Meta: {
          Duration: duration,
          Fps: fps,
          // the runtime export marks every motion as looping (the player decides)
          Loop: true,
          AreBeziersRestricted: g.bool(info, "isBezierRestricted"),
          ...(fadeIn >= 0 ? { FadeInTime: fadeIn / 1000 } : {}),
          ...(fadeOut >= 0 ? { FadeOutTime: fadeOut / 1000 } : {}),
          CurveCount: curves.length,
          TotalSegmentCount: curves.reduce((n, c) => n + segCount(c.Segments), 0),
          TotalPointCount: curves.reduce((n, c) => n + 1 + (c.Segments.length - 2 - segCount(c.Segments)) / 2, 0),
          UserDataCount: 0,
          TotalUserDataSize: 0,
        },
        Curves: curves,
      },
    });
  }
  if (unknown.size) warnings.push(`animation curves for parameters / parts the model does not have were left out: ${[...unknown].join(", ")}`);
  return { motions, warnings };
}
