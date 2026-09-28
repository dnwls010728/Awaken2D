// Dope-sheet timeline: one row per animated channel, grouped by target. Keys can be selected, box-selected,
// dragged in time (with frame snapping), added, deleted, copied/pasted and edited in the key inspector.
// Every change is written back as ordinary "replace" track ops, so it is saved, validated and undoable.
import { lerp, localTime, parseColor, primaryEase, sampleTrack } from "../src/core/index.ts";
import type { Animation, Ease, Key, Model, Op, Pose, Vec2 } from "../src/core/index.ts";
import { colorSwatch } from "./colorpicker.ts";
import { t as tr } from "./i18n.ts";

type Kind = "bone" | "slot" | "ik" | "physics" | "param" | "part" | "deform" | "event" | "drawOrder" | "constraint";
type ValueType = "number" | "vec" | "color" | "attachment" | "bool" | "deform" | "event" | "drawOrder" | "inherit" | "marker";

/** Spine constraint timelines: the animation field and the channels of each kind (tracks target "<kind>:<id>"). */
const CONSTRAINT_TIMELINES: Array<[kind: string, field: "transforms" | "paths" | "spinePhysics" | "sliders", channels: string[]]> = [
  ["transform", "transforms", ["rotate", "x", "y", "scaleX", "scaleY", "shearY"]],
  ["path", "paths", ["position", "spacing", "rotate", "x", "y"]],
  ["physics", "spinePhysics", ["inertia", "strength", "damping", "mass", "wind", "gravity", "mix", "reset"]],
  ["slider", "sliders", ["time", "mix"]],
];

interface Track {
  id: string; // kind:target:channel
  kind: Kind;
  target: string;
  channel: string;
  label: string;
  valueType: ValueType;
  keys: Key<unknown>[];
}

interface Row {
  type: "group" | "track";
  group: string; // kind:target
  label: string;
  kind: Kind;
  track?: Track;
  tracks: Track[];
}

/** What the timeline needs from the editor. */
export interface TimelineHost {
  model(): Model | null;
  animation(): string | null;
  time(): number;
  setTime(t: number): void;
  pause(): void;
  pose(): Pose | null;
  selectedBone(): string | null;
  /** The selected slot: its color / attachment rows are shown (to key them) even without keys. */
  selectedSlot(): string | null;
  /** A pinned parameter slider value (keys added on a parameter row take it). */
  pinnedParam?(id: string): number | undefined;
  selectBone(id: string): void;
  /** Asks for an event name (an existing one, or a new one it creates first); null when cancelled. */
  pickEvent(current?: string): Promise<string | null>;
  commit(ops: Op[], what?: string): Promise<unknown>;
  preview(model: Model | null): void;
  apply(model: Model, ops: Op[]): Model;
  status(text: string, error?: boolean): void;
}

const KIND_COLOR: Record<Kind, string> = {
  bone: "#4ea1ff",
  slot: "#3fb96c",
  ik: "#e04ab8",
  physics: "#e0a43a",
  param: "#a371f7",
  part: "#e3b341",
  deform: "#26b5b5",
  constraint: "#ff7a45",
  event: "#ffd166",
  drawOrder: "#e5534b",
};
const EASES: Array<[string, string]> = [
  ["linear", "Linear"],
  ["stepped", "Stepped"],
  ["easeIn", "Ease in"],
  ["easeOut", "Ease out"],
  ["easeInOut", "Ease in-out"],
  ["custom", "Custom bezier"],
];

const LABEL_W = 210;
const RULER_H = 26;
const ROW_H = 22;

const keyId = (track: string, t: number) => `${track}@${t.toFixed(4)}`;

export class Timeline {
  private host: TimelineHost;
  private canvas: HTMLCanvasElement;
  private inspector: HTMLElement;
  private rows: Row[] = [];
  private collapsed = new Set<string>();
  private showAll = false;
  private selection = new Set<string>(); // keyIds
  private clipboard: Array<{ track: string; dt: number; key: Key<unknown> }> = [];
  private pxPerSec = 200;
  private viewStart = 0;
  private scrollY = 0;
  private fitted: string | null = null;
  fps = 30;
  snap = true;
  private drag:
    | { kind: "scrub" }
    | { kind: "move"; x0: number; dt: number; base: Model }
    | { kind: "box"; x0: number; y0: number; x1: number; y1: number; add: boolean }
    | { kind: "pan"; x0: number; start: number }
    | null = null;
  private hover: { row: number; key?: string } | null = null;
  private lastModel: Model | null = null;
  private lastAnim: string | null = null;
  private lastBone: string | null = null;
  private lastSlot: string | null = null;

  constructor(canvas: HTMLCanvasElement, inspector: HTMLElement, host: TimelineHost) {
    this.canvas = canvas;
    this.inspector = inspector;
    this.host = host;
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointerleave", () => (this.hover = null));
    canvas.addEventListener("dblclick", (e) => this.onDouble(e));
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // ---------- data

  private anim(): Animation | undefined {
    const name = this.host.animation();
    return name ? this.host.model()?.animations?.[name] : undefined;
  }

  private buildTracks(model: Model, anim: Animation): Track[] {
    const tracks: Track[] = [];
    // Spine models have no parameter / part / spring tracks, Live2D models no bone / slot / IK / physics / deform / draw-order tracks
    const hidden = new Set<Kind>(model.target === "spine" ? ["param", "part", "physics"] : model.target === "live2d" ? ["bone", "slot", "ik", "physics", "deform", "drawOrder"] : []);
    const push = (kind: Kind, target: string, channel: string, valueType: ValueType, keys: Key<unknown>[] | undefined) =>
      hidden.has(kind) ||
      tracks.push({ id: `${kind}:${target}:${channel}`, kind, target, channel, label: channel, valueType, keys: keys ?? [] });
    const boneChannels: Array<[string, ValueType]> = [
      ["rotate", "number"],
      ["translate", "vec"],
      ["scale", "vec"],
      ["shear", "vec"],
      // Spine: single-axis tracks and inherit changes, shown when they have keys
      ["translateX", "number"],
      ["translateY", "number"],
      ["scaleX", "number"],
      ["scaleY", "number"],
      ["shearX", "number"],
      ["shearY", "number"],
      ["inherit", "inherit"],
    ];
    const rare = new Set(["shear", "translateX", "translateY", "scaleX", "scaleY", "shearX", "shearY", "inherit"]);
    const bones = new Set(Object.keys(anim.bones ?? {}));
    const sel = this.host.selectedBone();
    if (sel) bones.add(sel);
    for (const b of model.bones.map((x) => x.id).filter((id) => bones.has(id) || this.showAll)) {
      const tl = anim.bones?.[b] ?? {};
      for (const [ch, vt] of boneChannels) {
        const keys = (tl as Record<string, Key<unknown>[]>)[ch];
        // shear is rare (mostly Spine data): only shown when it has keys
        if (keys?.length || ((b === sel || this.showAll) && !rare.has(ch))) push("bone", b, ch, vt, keys);
      }
    }
    for (const p of model.parameters ?? []) {
      const keys = anim.params?.[p.id];
      // Live2D: every parameter has a row (like Cubism's animation view), so keys can be added anywhere
      if (keys?.length || this.showAll || model.target === "live2d") push("param", p.id, "value", "number", keys);
    }
    // Live2D part opacity: one row per part
    for (const p of model.live2d?.parts ?? []) {
      const keys = anim.partOpacity?.[p.id];
      if (keys?.length || (this.showAll && Object.keys(anim.partOpacity ?? {}).length)) push("part", p.id, "opacity", "number", keys);
    }
    const selSlot = this.host.selectedSlot();
    for (const slot of model.slots.map((x) => x.id)) {
      const tl = anim.slots?.[slot];
      const shown = slot === selSlot || this.showAll;
      if (tl?.attachment?.length || shown) push("slot", slot, "attachment", "attachment", tl?.attachment);
      if (tl?.color?.length || shown) push("slot", slot, "color", "color", tl?.color);
      // Spine two-color tint (slots with a dark color)
      if (tl?.dark?.length || (shown && model.slots.find((x) => x.id === slot)?.dark)) push("slot", slot, "dark", "color", tl?.dark);
    }
    for (const [ik, tl] of Object.entries(anim.ik ?? {})) {
      if (tl.mix?.length) push("ik", ik, "mix", "number", tl.mix);
      if (tl.softness?.length) push("ik", ik, "softness", "number", tl.softness);
      if (tl.bendPositive?.length) push("ik", ik, "bendPositive", "bool", tl.bendPositive);
      if (tl.compress?.length) push("ik", ik, "compress", "bool", tl.compress);
      if (tl.stretch?.length) push("ik", ik, "stretch", "bool", tl.stretch);
    }
    for (const [kind, field, channels] of CONSTRAINT_TIMELINES) {
      for (const [id, tl] of Object.entries((anim[field] ?? {}) as Record<string, Record<string, unknown>>)) {
        for (const ch of channels) {
          const keys = tl[ch];
          if (ch === "reset") {
            if ((keys as number[] | undefined)?.length) push("constraint", `${kind}:${id}`, ch, "marker", (keys as number[]).map((t) => ({ t, v: true, ease: "stepped" as const })));
          } else if ((keys as Key<unknown>[] | undefined)?.length) push("constraint", `${kind}:${id}`, ch, "number", keys as Key<unknown>[]);
        }
      }
    }
    for (const [ph, tl] of Object.entries(anim.physics ?? {})) {
      if (tl.mix?.length) push("physics", ph, "mix", "number", tl.mix);
      if (tl.force?.length) push("physics", ph, "force", "vec", tl.force);
    }
    for (const [att, keys] of Object.entries(anim.deform ?? {})) if (keys.length) push("deform", att, "deform", "deform", keys as Key<unknown>[]);
    if (anim.drawOrder?.length) push("drawOrder", "draw order", "order", "drawOrder", anim.drawOrder.map((k) => ({ t: k.t, v: k.offsets })));
    {
      // one row for all events (always there, so events can be added); a key per time (several events at one time share it)
      const byT = new Map<number, NonNullable<typeof anim.events>>();
      for (const e of anim.events ?? []) byT.set(e.t, [...(byT.get(e.t) ?? []), e]);
      push("event", "events", "events", "event", [...byT].map(([t, v]) => ({ t, v, ease: "stepped" as const })));
    }
    return tracks;
  }

  private rebuild(): void {
    const model = this.host.model();
    const anim = this.anim();
    this.rows = [];
    if (!model || !anim) return;
    const tracks = this.buildTracks(model, anim);
    const groups = new Map<string, Track[]>();
    for (const t of tracks) {
      const g = `${t.kind}:${t.target}`;
      groups.set(g, [...(groups.get(g) ?? []), t]);
    }
    // params with a single channel are shown as one row
    for (const [g, ts] of groups) {
      const kind = ts[0].kind;
      if (kind === "param" || kind === "part") {
        this.rows.push({ type: "track", group: g, label: kind === "part" ? `${ts[0].target} (opacity)` : kind === "param" ? (model.parameters?.find((p) => p.id === ts[0].target)?.name ?? ts[0].target) : ts[0].target, kind, track: ts[0], tracks: ts });
        continue;
      }
      // constraint groups read "transform follow", "physics (global)"
      const label = kind === "constraint" ? ts[0].target.replace(":", " ").replace(/ $/, " (global)") : ts[0].target;
      this.rows.push({ type: "group", group: g, label, kind, tracks: ts });
      if (!this.collapsed.has(g)) for (const t of ts) this.rows.push({ type: "track", group: g, label: t.label, kind, track: t, tracks: [t] });
    }
    // drop selections that no longer exist
    const valid = new Set(tracks.flatMap((t) => t.keys.map((k) => keyId(t.id, k.t))));
    for (const id of [...this.selection]) if (!valid.has(id)) this.selection.delete(id);
  }

  private tracks(): Track[] {
    const out = new Map<string, Track>();
    for (const r of this.rows) for (const t of r.tracks) out.set(t.id, t);
    return [...out.values()];
  }

  private selectedKeys(): Array<{ track: Track; key: Key<unknown>; index: number }> {
    const out: Array<{ track: Track; key: Key<unknown>; index: number }> = [];
    for (const t of this.tracks()) t.keys.forEach((k, index) => this.selection.has(keyId(t.id, k.t)) && out.push({ track: t, key: k, index }));
    return out;
  }

  // ---------- ops

  private trackOp(track: Track, keys: Key<unknown>[]): Op {
    const animation = this.host.animation()!;
    const sorted = [...keys].sort((a, b) => a.t - b.t);
    // tracks written as whole lists (deform keys keep Spine's exact per-bone deltas when only moved in time)
    if (track.kind === "deform") {
      const keys = sorted.map((k) => ({ t: k.t, offsets: k.v, ...(k.ease ? { ease: k.ease } : {}), ...((k as { local?: unknown }).local ? { local: (k as { local?: unknown }).local } : {}) }));
      return { op: "setDeformKeys", animation, attachment: track.target, keys, mode: "replace" } as Op;
    }
    if (track.kind === "drawOrder") return { op: "setDrawOrderKeys", animation, keys: sorted.map((k) => ({ t: k.t, offsets: k.v })), mode: "replace" } as Op;
    if (track.kind === "event") {
      const keys = sorted.flatMap((k) => (k.v as Array<{ name: string }>).map((e) => ({ ...e, t: k.t })));
      return { op: "setEventKeys", animation, keys, mode: "replace" } as Op;
    }
    if (track.kind === "part") return { op: "setPartOpacityKeys", animation, part: track.target, keys: sorted, mode: "replace" } as Op;
    if (track.kind === "constraint") {
      const i = track.target.indexOf(":");
      const keys = track.channel === "reset" ? sorted.map((k) => ({ t: k.t })) : sorted;
      return { op: "setConstraintKeys", animation, kind: track.target.slice(0, i), constraint: track.target.slice(i + 1), channel: track.channel, keys, mode: "replace" } as Op;
    }
    if (!sorted.length) {
      const which = { bone: { bone: track.target }, slot: { slot: track.target }, ik: { ik: track.target }, physics: { physics: track.target }, param: { param: track.target } }[track.kind as "bone"];
      return { op: "clearKeys", animation, ...which, ...(track.kind === "param" ? {} : { channel: track.channel }) } as Op;
    }
    switch (track.kind) {
      case "bone":
        return { op: "setKeys", animation, bone: track.target, channel: track.channel, keys: sorted, mode: "replace" } as Op;
      case "slot":
        return { op: "setSlotKeys", animation, slot: track.target, channel: track.channel, keys: sorted, mode: "replace" } as Op;
      case "ik":
        return { op: "setIkKeys", animation, ik: track.target, channel: track.channel, keys: sorted, mode: "replace" } as Op;
      case "physics":
        return { op: "setPhysicsKeys", animation, physics: track.target, channel: track.channel, keys: sorted, mode: "replace" } as Op;
      default:
        return { op: "setParamTrack", animation, parameter: track.target, keys: sorted, mode: "replace" } as Op;
    }
  }

  private snapT(t: number): number {
    const d = this.anim()?.duration ?? 1;
    const s = this.snap ? Math.round(t * this.fps) / this.fps : t;
    return Math.max(0, Math.min(d, +s.toFixed(4)));
  }

  /** Ops that move the selected keys by dt (keys landing on an existing key replace it). */
  private moveOps(dt: number): { ops: Op[]; moved: string[] } {
    const byTrack = new Map<Track, Set<number>>();
    for (const s of this.selectedKeys()) byTrack.set(s.track, (byTrack.get(s.track) ?? new Set()).add(s.index));
    const ops: Op[] = [];
    const moved: string[] = [];
    for (const [track, idx] of byTrack) {
      const movedKeys = track.keys.filter((_, i) => idx.has(i)).map((k) => ({ ...k, t: this.snapT(k.t + dt) }));
      const newTimes = new Set(movedKeys.map((k) => k.t.toFixed(4)));
      const stay = track.keys.filter((k, i) => !idx.has(i) && !newTimes.has(k.t.toFixed(4)));
      ops.push(this.trackOp(track, [...stay, ...movedKeys]));
      moved.push(...movedKeys.map((k) => keyId(track.id, k.t)));
    }
    return { ops, moved };
  }

  deleteSelected(): boolean {
    const sel = this.selectedKeys();
    if (!sel.length) return false;
    const byTrack = new Map<Track, Set<number>>();
    for (const s of sel) byTrack.set(s.track, (byTrack.get(s.track) ?? new Set()).add(s.index));
    const ops = [...byTrack].map(([track, idx]) => this.trackOp(track, track.keys.filter((_, i) => !idx.has(i))));
    this.selection.clear();
    void this.host.commit(ops, `deleted ${sel.length} key(s)`);
    return true;
  }

  hasSelection(): boolean {
    return this.selection.size > 0;
  }

  copy(): boolean {
    const sel = this.selectedKeys();
    if (!sel.length) return false;
    const t0 = Math.min(...sel.map((s) => s.key.t));
    this.clipboard = sel.map((s) => ({ track: s.track.id, dt: s.key.t - t0, key: structuredClone(s.key) }));
    this.host.status(`copied ${sel.length} key(s)`);
    return true;
  }

  paste(): boolean {
    if (!this.clipboard.length || !this.anim()) return false;
    const at = this.snapT(this.localT());
    const tracks = new Map(this.tracks().map((t) => [t.id, t]));
    const byTrack = new Map<Track, Key<unknown>[]>();
    const pasted: string[] = [];
    for (const c of this.clipboard) {
      const track = tracks.get(c.track);
      if (!track) continue;
      const k = { ...c.key, t: this.snapT(at + c.dt) };
      byTrack.set(track, [...(byTrack.get(track) ?? []), k]);
      pasted.push(keyId(track.id, k.t));
    }
    if (!byTrack.size) {
      this.host.status("nothing to paste here: the copied tracks are not in this animation", true);
      return true;
    }
    const ops = [...byTrack].map(([track, ks]) => {
      const times = new Set(ks.map((k) => k.t.toFixed(4)));
      return this.trackOp(track, [...track.keys.filter((k) => !times.has(k.t.toFixed(4))), ...ks]);
    });
    this.selection = new Set(pasted);
    void this.host.commit(ops, `pasted ${pasted.length} key(s)`);
    return true;
  }

  /** Current value of a track at time t (for new keys). */
  private valueAt(track: Track, t: number): unknown {
    const num = (a: number, b: number, f: number) => lerp(a, b, f);
    const vec = (a: Vec2, b: Vec2, f: number): Vec2 => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
    const model = this.host.model()!;
    switch (track.valueType) {
      case "number": {
        const v = sampleTrack(track.keys as Key<number>[], t, num);
        const pinned = track.kind === "param" ? this.host.pinnedParam?.(track.target) : undefined;
        if (pinned !== undefined) return +pinned.toFixed(3);
        if (v !== undefined) return +v.toFixed(3);
        if (track.kind === "param") return model.parameters?.find((p) => p.id === track.target)?.default ?? 0;
        if (track.kind === "part") return model.live2d?.parts.find((p) => p.id === track.target)?.visible === false ? 0 : 1;
        return track.kind === "bone" ? (track.channel.startsWith("scale") ? 1 : 0) : 1;
      }
      case "inherit":
        return sampleTrack(track.keys as Key<string>[], t, (a) => a) ?? "normal";
      case "marker":
        return true;
      case "vec": {
        const v = sampleTrack(track.keys as Key<Vec2>[], t, vec);
        return v ? v.map((x) => +x.toFixed(3)) : track.channel === "scale" ? [1, 1] : [0, 0];
      }
      case "color": {
        const keys = (track.keys as Key<string>[]).map((k) => ({ ...k, v: parseColor(k.v) }));
        const c = sampleTrack(keys, t, (a, b, f) => a.map((x, i) => lerp(x, b[i], f)) as typeof a);
        if (!c) return track.channel === "dark" ? (this.host.model()?.slots.find((s) => s.id === track.target)?.dark ?? "#000000") : "#ffffff";
        const h = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
        return "#" + h(c[0]) + h(c[1]) + h(c[2]) + (c[3] < 1 ? h(c[3]) : "");
      }
      case "attachment": {
        const v = sampleTrack(track.keys as Key<string | null>[], t, (a) => a);
        if (v !== undefined) return v;
        return this.host.pose()?.slots.find((s) => s.id === track.target)?.attachment ?? null;
      }
      case "deform":
      case "drawOrder":
      case "event": {
        // no interpolation: the value of the key before (or the first)
        const prev = [...track.keys].reverse().find((k) => k.t <= t + 1e-6) ?? track.keys[0];
        return structuredClone(prev?.v ?? (track.valueType === "event" ? [] : []));
      }
      default:
        return sampleTrack(track.keys as Key<boolean>[], t, (a) => a) ?? true;
    }
  }

  addKeyAt(row: Row, t: number): void {
    const tracks = row.type === "group" ? row.tracks : [row.track!];
    const at = this.snapT(t);
    if (tracks.length === 1 && tracks[0].kind === "event") return void this.addEventAt(tracks[0], at);
    const ops = tracks.map((track) => {
      // the new key continues the curve it was inserted into
      const prev = [...track.keys].reverse().find((k) => k.t < at - 1e-6);
      const key: Key<unknown> = { t: at, v: this.valueAt(track, at), ...(prev?.ease ? { ease: prev.ease } : {}) };
      return this.trackOp(track, [...track.keys.filter((k) => Math.abs(k.t - at) > 1e-6), key]);
    });
    this.selection = new Set(tracks.map((tr) => keyId(tr.id, at)));
    void this.host.commit(ops, `keyed ${row.label} at ${at}s`);
  }

  /** Adds an event key (asks which event; a new name defines it). */
  private async addEventAt(track: Track, at: number): Promise<void> {
    const name = await this.host.pickEvent();
    if (!name) return;
    const same = track.keys.find((k) => Math.abs(k.t - at) < 1e-6);
    const list = [...((same?.v as Array<{ name: string }>) ?? []), { name }];
    const keys = [...track.keys.filter((k) => k !== same), { t: at, v: list }];
    this.selection = new Set([keyId(track.id, at)]);
    void this.host.commit([this.trackOp(track, keys)], `event ${name} at ${at}s`);
  }

  // ---------- geometry

  private localT(): number {
    const a = this.anim();
    return a ? localTime(a, this.host.time()) : 0;
  }
  private x(t: number): number {
    return LABEL_W + (t - this.viewStart) * this.pxPerSec;
  }
  private t(x: number): number {
    return (x - LABEL_W) / this.pxPerSec + this.viewStart;
  }
  private rowY(i: number): number {
    return RULER_H + i * ROW_H - this.scrollY;
  }
  private rowAt(y: number): number {
    return Math.floor((y - RULER_H + this.scrollY) / ROW_H);
  }
  private keysOfRow(r: Row): Array<{ track: Track; key: Key<unknown> }> {
    return r.tracks.flatMap((track) => track.keys.map((key) => ({ track, key })));
  }
  private keyAt(x: number, y: number): { row: number; track: Track; key: Key<unknown> } | null {
    const i = this.rowAt(y);
    const r = this.rows[i];
    if (!r || y < RULER_H) return null;
    let best: { row: number; track: Track; key: Key<unknown> } | null = null;
    let bestD = 7;
    for (const { track, key } of this.keysOfRow(r)) {
      const d = Math.abs(this.x(key.t) - x);
      if (d < bestD) {
        bestD = d;
        best = { row: i, track, key };
      }
    }
    return best;
  }

  fit(): void {
    const a = this.anim();
    const w = this.canvas.clientWidth - LABEL_W - 24;
    if (!a || w <= 0) return;
    this.pxPerSec = Math.max(20, w / Math.max(a.duration, 0.1));
    this.viewStart = 0;
  }

  // ---------- input

  private onDown(e: PointerEvent): void {
    if (!this.anim()) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { offsetX: x, offsetY: y } = e;
    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: "pan", x0: x, start: this.viewStart };
      return;
    }
    if (y < RULER_H && x > LABEL_W) {
      this.drag = { kind: "scrub" };
      this.scrub(x);
      return;
    }
    if (x < LABEL_W) {
      const r = this.rows[this.rowAt(y)];
      if (!r) return;
      if (r.type === "group" && x < 22) {
        if (this.collapsed.has(r.group)) this.collapsed.delete(r.group);
        else this.collapsed.add(r.group);
        this.rebuild();
      } else if (r.kind === "bone") this.host.selectBone(r.tracks[0].target);
      // clicking a label selects all its keys
      const ids = this.keysOfRow(r).map(({ track, key }) => keyId(track.id, key.t));
      if (!e.shiftKey) this.selection.clear();
      for (const id of ids) this.selection.add(id);
      this.renderInspector();
      return;
    }
    const hit = this.keyAt(x, y);
    if (hit) {
      const rowKeys = this.rows[hit.row].type === "group" ? this.rows[hit.row].tracks.flatMap((tr) => tr.keys.filter((k) => Math.abs(k.t - hit.key.t) < 1e-6).map((k) => keyId(tr.id, k.t))) : [keyId(hit.track.id, hit.key.t)];
      const already = rowKeys.every((id) => this.selection.has(id));
      if (e.shiftKey || e.ctrlKey) {
        for (const id of rowKeys) (already ? this.selection.delete(id) : this.selection.add(id));
      } else if (!already) this.selection = new Set(rowKeys);
      this.host.pause();
      this.host.setTime(hit.key.t);
      this.drag = { kind: "move", x0: x, dt: 0, base: this.host.model()! };
      this.renderInspector();
      return;
    }
    this.drag = { kind: "box", x0: x, y0: y, x1: x, y1: y, add: e.shiftKey || e.ctrlKey };
  }

  private onMove(e: PointerEvent): void {
    const { offsetX: x, offsetY: y } = e;
    if (!this.drag) {
      const hit = this.keyAt(x, y);
      this.hover = { row: this.rowAt(y), key: hit ? keyId(hit.track.id, hit.key.t) : undefined };
      this.canvas.style.cursor = y < RULER_H && x > LABEL_W ? "ew-resize" : hit ? "grab" : x < LABEL_W ? "pointer" : "crosshair";
      if (hit) this.host.status(`${hit.track.kind} ${hit.track.target}.${hit.track.channel} @ ${+hit.key.t.toFixed(3)}s (frame ${Math.round(hit.key.t * this.fps)}): ${JSON.stringify(hit.key.v)}${hit.key.ease ? `, ${JSON.stringify(hit.key.ease)}` : ""}`);
      return;
    }
    if (this.drag.kind === "scrub") this.scrub(x);
    else if (this.drag.kind === "pan") this.viewStart = Math.max(0, this.drag.start - (x - this.drag.x0) / this.pxPerSec);
    else if (this.drag.kind === "box") {
      this.drag.x1 = x;
      this.drag.y1 = y;
    } else if (this.drag.kind === "move") {
      let dt = (x - this.drag.x0) / this.pxPerSec;
      if (this.snap) dt = Math.round(dt * this.fps) / this.fps;
      if (dt === this.drag.dt) return;
      this.drag.dt = dt;
      try {
        this.host.preview(dt ? this.host.apply(this.drag.base, this.moveOps(dt).ops) : null);
        this.canvas.style.cursor = "grabbing";
      } catch (err) {
        this.host.status((err as Error).message, true);
      }
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === "move" && d.dt) {
      const { ops, moved } = this.moveOps(d.dt);
      this.selection = new Set(moved);
      void this.host.commit(ops, `moved ${moved.length} key(s) by ${+d.dt.toFixed(3)}s`);
    } else if (d.kind === "box") {
      if (Math.abs(d.x1 - d.x0) < 3 && Math.abs(d.y1 - d.y0) < 3) {
        if (!d.add) this.selection.clear();
        // plain click on empty track area moves the playhead
        if (d.x0 > LABEL_W) {
          this.host.pause();
          this.host.setTime(this.snapT(this.t(d.x0)));
        }
      } else {
        if (!d.add) this.selection.clear();
        const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
        const [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
        for (let i = 0; i < this.rows.length; i++) {
          // a row counts only when the box covers its middle
          const mid = this.rowY(i) + ROW_H / 2;
          if (mid < ya || mid > yb) continue;
          for (const { track, key } of this.keysOfRow(this.rows[i])) {
            const kx = this.x(key.t);
            if (kx >= x0 && kx <= x1) this.selection.add(keyId(track.id, key.t));
          }
        }
      }
      this.renderInspector();
    }
    void e;
  }

  private onDouble(e: MouseEvent): void {
    if (!this.anim() || e.offsetX < LABEL_W || e.offsetY < RULER_H) return;
    const r = this.rows[this.rowAt(e.offsetY)];
    if (r) this.addKeyAt(r, this.t(e.offsetX));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const t = this.t(e.offsetX);
      this.pxPerSec = Math.max(10, Math.min(5000, this.pxPerSec * Math.exp(-e.deltaY * 0.002)));
      this.viewStart = Math.max(0, t - (e.offsetX - LABEL_W) / this.pxPerSec);
    } else if (e.shiftKey) {
      this.viewStart = Math.max(0, this.viewStart + e.deltaY / this.pxPerSec);
    } else {
      const max = Math.max(0, this.rows.length * ROW_H - (this.canvas.clientHeight - RULER_H) + 8);
      this.scrollY = Math.max(0, Math.min(max, this.scrollY + e.deltaY));
    }
  }

  private scrub(x: number): void {
    this.host.pause();
    this.host.setTime(this.snapT(this.t(x)));
  }

  setShowAll(v: boolean): void {
    this.showAll = v;
    this.rebuild();
  }

  // ---------- drawing

  draw(): void {
    const model = this.host.model();
    const anim = this.anim();
    const name = this.host.animation();
    if (model !== this.lastModel || name !== this.lastAnim || this.host.selectedBone() !== this.lastBone || this.host.selectedSlot() !== this.lastSlot) {
      const animChanged = name !== this.lastAnim;
      this.lastModel = model;
      this.lastAnim = name;
      this.lastBone = this.host.selectedBone();
      this.lastSlot = this.host.selectedSlot();
      if (animChanged) {
        this.selection.clear();
        this.scrollY = 0;
      }
      this.rebuild();
      this.renderInspector();
    }
    if (anim && this.fitted !== name) {
      this.fitted = name;
      this.fit();
    }
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1f2226";
    ctx.fillRect(0, 0, W, H);
    ctx.font = "12px system-ui, sans-serif";
    if (!anim) {
      ctx.fillStyle = "#8a919c";
      ctx.fillText(tr("Setup pose — edits change the rest pose. Pick or create an animation to see its tracks."), 14, 22);
      return;
    }
    // rows
    const tl = this.localT();
    this.rows.forEach((r, i) => {
      const y = this.rowY(i);
      if (y + ROW_H < RULER_H || y > H) return;
      const isSelBone = r.kind === "bone" && r.tracks[0].target === this.host.selectedBone();
      ctx.fillStyle = r.type === "group" ? "#262a30" : i % 2 ? "#212429" : "#1f2226";
      if (this.hover?.row === i) ctx.fillStyle = "#2b3038";
      ctx.fillRect(0, y, W, ROW_H);
      if (isSelBone) {
        ctx.fillStyle = "rgba(78,161,255,0.08)";
        ctx.fillRect(0, y, W, ROW_H);
      }
      // label
      ctx.fillStyle = KIND_COLOR[r.kind];
      if (r.type === "group") {
        ctx.fillText(this.collapsed.has(r.group) ? "▸" : "▾", 8, y + 15);
        ctx.beginPath();
        ctx.arc(26, y + ROW_H / 2, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#d9dde3";
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.fillText(clip(ctx, r.label, LABEL_W - 44), 36, y + 15);
        ctx.font = "12px system-ui, sans-serif";
      } else {
        const flat = r.kind === "param" || r.kind === "part";
        const indent = flat ? 10 : 36;
        if (flat) {
          ctx.beginPath();
          ctx.arc(indent + 4, y + ROW_H / 2, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = flat ? "#d9dde3" : "#a9b0ba";
        ctx.fillText(clip(ctx, flat ? r.label : tr(r.label), LABEL_W - indent - 20), indent + (flat ? 14 : 0), y + 15);
      }
      // interpolation hint between keys
      if (r.type === "track" && r.track!.keys.length > 1 && r.track!.valueType !== "attachment" && r.track!.valueType !== "bool") {
        const ks = r.track!.keys;
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k < ks.length - 1; k++) {
          if (ks[k].ease === "stepped") continue;
          ctx.moveTo(this.x(ks[k].t) + 5, y + ROW_H / 2);
          ctx.lineTo(this.x(ks[k + 1].t) - 5, y + ROW_H / 2);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      // keys
      for (const { track, key } of this.keysOfRow(r)) {
        const id = keyId(track.id, key.t);
        const selected = r.type === "group" ? r.tracks.some((t) => this.selection.has(keyId(t.id, key.t))) : this.selection.has(id);
        let x = this.x(key.t);
        if (this.drag?.kind === "move" && selected) x += this.drag.dt * this.pxPerSec;
        if (x < LABEL_W - 6 || x > W + 6) continue;
        drawKey(ctx, x, y + ROW_H / 2, r.type === "group" ? 4 : 5.5, primaryEase(key.ease), selected ? "#ffd166" : r.type === "group" ? "#8a919c" : KIND_COLOR[r.kind], selected || this.hover?.key === id);
      }
    });
    // label column border
    ctx.fillStyle = "#3a3f47";
    ctx.fillRect(LABEL_W - 1, RULER_H, 1, H);
    // ruler
    ctx.fillStyle = "#262a30";
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.fillStyle = "#3a3f47";
    ctx.fillRect(0, RULER_H - 1, W, 1);
    ctx.fillStyle = "#8a919c";
    ctx.fillText(`${this.fps} fps · ${tr(this.snap ? "snap" : "free")}`, 10, 17);
    const frameW = this.pxPerSec / this.fps;
    const labelEvery = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((n) => n * frameW >= 48) ?? 600;
    const tickEvery = frameW >= 6 ? 1 : [2, 5, 10, 15, 30, 60].find((n) => n * frameW >= 6) ?? 60;
    const f0 = Math.max(0, Math.floor(this.viewStart * this.fps));
    const f1 = Math.ceil(this.t(W) * this.fps);
    for (let f = f0 - (f0 % tickEvery); f <= f1; f += tickEvery) {
      const x = this.x(f / this.fps);
      if (x < LABEL_W) continue;
      const major = f % labelEvery === 0;
      ctx.fillStyle = major ? "#8a919c" : "#4a505a";
      ctx.fillRect(Math.round(x), major ? 12 : 18, 1, major ? 14 : 8);
      if (major) ctx.fillText(frameW >= 12 ? `${f}` : `${+(f / this.fps).toFixed(2)}s`, x + 3, 11);
    }
    // duration end
    const endX = this.x(anim.duration);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    if (endX < W) ctx.fillRect(endX, RULER_H, W - endX, H);
    ctx.fillStyle = anim.loop === false ? "#e5534b" : "#3fb96c";
    ctx.fillRect(endX - 1, 0, 2, H);
    // box
    if (this.drag?.kind === "box") {
      const d = this.drag;
      ctx.strokeStyle = "#4ea1ff";
      ctx.fillStyle = "rgba(78,161,255,0.12)";
      ctx.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    // playhead
    const px = this.x(tl);
    if (px >= LABEL_W) {
      ctx.fillStyle = "#4ea1ff";
      ctx.fillRect(Math.round(px) - 1, 0, 2, H);
      const label = `${Math.round(tl * this.fps)}`;
      const w = ctx.measureText(label).width + 10;
      ctx.beginPath();
      ctx.roundRect(px - w / 2, 2, w, 16, 4);
      ctx.fill();
      ctx.fillStyle = "#0b1320";
      ctx.fillText(label, px - w / 2 + 5, 14);
    }
    if (this.rows.every((r) => r.kind === "event") && !this.rows.some((r) => r.tracks.some((t) => t.keys.length))) {
      ctx.fillStyle = "#8a919c";
      ctx.fillText(tr("No keys yet. Select a bone or slot and edit it in the viewport or panel, press K, or double-click a row here (the events row adds an event)."), LABEL_W + 12, RULER_H + this.rows.length * ROW_H + 18);
    }
  }

  // ---------- key inspector

  renderInspector(): void {
    const box = this.inspector;
    const sel = this.selectedKeys();
    const anim = this.anim();
    if (!anim) {
      box.replaceChildren(el("div", { class: "insp-empty" }, "No animation"));
      return;
    }
    if (!sel.length) {
      box.replaceChildren(
        el("div", { class: "insp-title" }, "Keys"),
        el(
          "div",
          { class: "insp-empty" },
          "Click a key to edit it. Drag to move, Shift/Ctrl+click or drag a box to select several, double-click a row to add a key, Delete removes, Ctrl+C / Ctrl+V copies to the playhead. Ctrl+wheel zooms, Shift+wheel or right-drag scrolls time.",
        ),
      );
      return;
    }
    const commitTrack = (track: Track, keys: Key<unknown>[], what: string) => void this.host.commit([this.trackOp(track, keys)], what);
    if (sel.length === 1) {
      const { track, key, index } = sel[0];
      const replace = (patch: Partial<Key<unknown>>, what: string) => {
        const keys = track.keys.map((k, i) => (i === index ? { ...k, ...patch } : k));
        if (patch.t !== undefined) {
          this.selection = new Set([keyId(track.id, patch.t)]);
          const clash = keys.findIndex((k, i) => i !== index && Math.abs(k.t - patch.t!) < 1e-6);
          if (clash >= 0) keys.splice(clash, 1);
        }
        commitTrack(track, keys, what);
      };
      const timeIn = numInput(key.t, 1 / this.fps, (v) => replace({ t: this.snapT(v) }, "moved key"));
      const frameIn = numInput(Math.round(key.t * this.fps), 1, (v) => replace({ t: this.snapT(v / this.fps) }, "moved key"));
      const rows: HTMLElement[] = [
        el("div", { class: "insp-title" }, `${track.target}`, el("span", { class: "insp-sub" }, ` ${track.kind} · ${track.channel}`)),
        field("time (s)", timeIn),
        field("frame", frameIn),
        field("value", this.valueEditor(track, key.v, (v) => replace({ v }, "edited key value"))),
      ];
      if (!["attachment", "bool", "inherit", "marker"].includes(track.valueType)) rows.push(...this.easeEditor(primaryEase(key.ease), (ease) => replace({ ease }, "changed easing")));
      rows.push(
        el(
          "div",
          { class: "insp-actions" },
          el("button", { onclick: () => this.deleteSelected() }, "Delete"),
          el("button", { onclick: () => (this.host.pause(), this.host.setTime(key.t)) }, "Go to"),
        ),
      );
      box.replaceChildren(...rows);
      return;
    }
    const tracks = new Set(sel.map((s) => s.track));
    const shift = numInput(0, 1 / this.fps, (v) => {
      if (!v) return;
      const { ops, moved } = this.moveOps(v);
      this.selection = new Set(moved);
      void this.host.commit(ops, `moved ${moved.length} keys`);
    });
    box.replaceChildren(
      el("div", { class: "insp-title" }, `${sel.length} keys`, el("span", { class: "insp-sub" }, ` in ${tracks.size} track(s)`)),
      field("shift by (s)", shift),
      ...this.easeEditor(primaryEase(sel[0].key.ease), (ease) => {
        const ops = [...tracks].map((track) => this.trackOp(track, track.keys.map((k) => (this.selection.has(keyId(track.id, k.t)) ? { ...k, ease } : k))));
        void this.host.commit(ops, "changed easing");
      }),
      el("div", { class: "insp-actions" }, el("button", { onclick: () => this.deleteSelected() }, "Delete all"), el("button", { onclick: () => this.copy() }, "Copy")),
    );
  }

  private valueEditor(track: Track, v: unknown, set: (v: unknown) => void): HTMLElement {
    switch (track.valueType) {
      case "number": {
        const p = track.kind === "param" ? this.host.model()!.parameters?.find((x) => x.id === track.target) : track.kind === "part" ? { min: 0, max: 1 } : undefined;
        const input = numInput(v as number, p ? (p.max - p.min) / 100 : track.channel === "rotate" ? 1 : 0.05, set);
        if (!p) return input;
        const range = el("input", { type: "range", min: String(p.min), max: String(p.max), step: String((p.max - p.min) / 200), value: String(v) }) as HTMLInputElement;
        range.addEventListener("change", () => set(Number(range.value)));
        return el("div", { class: "insp-stack" }, input, range);
      }
      case "vec": {
        const [a, b] = v as Vec2;
        let cur: Vec2 = [a, b];
        return el("div", { class: "pair" }, numInput(a, 1, (x) => set((cur = [x, cur[1]]))), numInput(b, 1, (y) => set((cur = [cur[0], y]))));
      }
      case "color": {
        const text = el("input", { value: String(v) }) as HTMLInputElement;
        text.addEventListener("change", () => set(text.value));
        const pick = colorSwatch({ value: String(v), alpha: true, title: "Key color and opacity", onChange: (c) => set(c) });
        return el("div", { class: "pair" }, pick, text);
      }
      case "attachment": {
        const model = this.host.model()!;
        // the slot's skin placeholders first, then attachment ids
        const placeholders = [...new Set(Object.values(model.skins ?? {}).flatMap((sk) => Object.keys(sk.attachments[track.target] ?? {})))];
        const ids = Object.keys(model.attachments).filter((a) => !placeholders.includes(a));
        const opt = (a: string, label = a) => el("option", { value: a, selected: a === v }, label);
        const s = el("select", {}, el("option", { value: "" }, "(none)"), ...placeholders.map((a) => opt(a, `${a} (skin placeholder)`)), ...ids.map((a) => opt(a))) as HTMLSelectElement;
        s.addEventListener("change", () => set(s.value || null));
        return s;
      }
      case "inherit": {
        const modes = ["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"];
        const s = el("select", {}, ...modes.map((m) => el("option", { value: m, selected: m === v }, m))) as HTMLSelectElement;
        s.addEventListener("change", () => set(s.value));
        return s;
      }
      case "marker":
        return el("span", { class: "insp-sub" }, "The simulation restarts here");
      case "deform":
        return el("span", { class: "insp-sub" }, `${(v as unknown[]).length} vertices moved (edit the shape in Mesh mode or with setDeformKeys)`);
      case "drawOrder": {
        const offsets = v as Array<[string, number]>;
        return el("span", { class: "insp-sub" }, offsets.length ? offsets.map(([sl, o]) => `${sl} ${o > 0 ? "+" : ""}${o}`).join(", ") : "setup order");
      }
      case "event": {
        const model = this.host.model()!;
        const names = Object.keys(model.events ?? {});
        const list = v as Array<{ name: string; int?: number; float?: number; string?: string }>;
        const first = list[0] ?? { name: "" };
        const s = el(
          "select",
          {},
          ...names.map((n) => el("option", { value: n, selected: n === first.name }, n)),
          el("option", { value: "__new" }, "New event…"),
        ) as HTMLSelectElement;
        s.addEventListener("change", async () => {
          const name = s.value === "__new" ? await this.host.pickEvent(first.name) : s.value;
          if (name) set([{ ...first, name }, ...list.slice(1)]);
          else this.renderInspector();
        });
        // the key's own values (override the event's defaults when set)
        const def = model.events?.[first.name] ?? {};
        const numField = (label: string, key: "int" | "float") => {
          const input = el("input", { type: "number", step: key === "int" ? "1" : "0.1", value: String(first[key] ?? (def as Record<string, number>)[key] ?? 0) }) as HTMLInputElement;
          input.addEventListener("change", () => set([{ ...first, [key]: key === "int" ? Math.round(Number(input.value)) : Number(input.value) }, ...list.slice(1)]));
          return field(label, input);
        };
        const str = el("input", { value: first.string ?? (def as { string?: string }).string ?? "" }) as HTMLInputElement;
        str.addEventListener("change", () => set([{ ...first, string: str.value }, ...list.slice(1)]));
        return el(
          "div",
          { class: "insp-stack" },
          s,
          numField("int", "int"),
          numField("float", "float"),
          field("string", str),
          list.length > 1 ? el("span", { class: "insp-sub" }, `+ ${list.length - 1} more at this time`) : el("span"),
        );
      }
      default: {
        const c = el("input", { type: "checkbox", checked: v === true }) as HTMLInputElement;
        c.addEventListener("change", () => set(c.checked));
        return c;
      }
    }
  }

  private easeEditor(ease: Ease | undefined, set: (e: Ease) => void): HTMLElement[] {
    const kind = Array.isArray(ease) ? "custom" : (ease ?? "linear");
    const s = el("select", {}, ...EASES.map(([v, l]) => el("option", { value: v, selected: v === kind }, l))) as HTMLSelectElement;
    const bez: [number, number, number, number] = Array.isArray(ease) ? [...ease] : [0.42, 0, 0.58, 1];
    const preview = easePreview(ease);
    s.addEventListener("change", () => set(s.value === "custom" ? bez : (s.value as Ease)));
    const out: HTMLElement[] = [field("easing", el("div", { class: "insp-stack" }, s, preview))];
    if (kind === "custom") {
      const inputs = bez.map((n, i) => numInput(n, 0.05, (v) => ((bez[i] = v), set([...bez] as [number, number, number, number]))));
      out.push(field("bezier", el("div", { class: "quad" }, ...inputs)));
    }
    return out;
  }
}

// ---------- helpers

function drawKey(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, ease: Ease | undefined, color: string, outline: boolean): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ease === "stepped") ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
  else if (ease && ease !== "linear") ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
  else {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  }
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}

function el(tag: string, attrs: Record<string, unknown> = {}, ...kids: Array<Node | string>): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (v !== undefined && v !== false) (e as unknown as Record<string, unknown>)[k] = v;
  }
  e.append(...kids);
  return e;
}

function numInput(v: number, step: number, set: (v: number) => void): HTMLInputElement {
  const i = el("input", { type: "number", value: String(+v.toFixed(4)), step: String(+step.toFixed(4)) }) as HTMLInputElement;
  i.addEventListener("change", () => {
    const n = Number(i.value);
    if (Number.isFinite(n)) set(n);
  });
  return i;
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el("label", { class: "field" }, el("span", {}, label), control);
}

/** Tiny SVG of the easing curve. */
function easePreview(ease: Ease | undefined): HTMLElement {
  const pts: string[] = [];
  const bez = ease === "easeIn" ? [0.42, 0, 1, 1] : ease === "easeOut" ? [0, 0, 0.58, 1] : ease === "easeInOut" ? [0.42, 0, 0.58, 1] : Array.isArray(ease) ? ease : null;
  for (let i = 0; i <= 24; i++) {
    const a = i / 24;
    let y = a;
    if (ease === "stepped") y = a < 1 ? 0 : 1;
    else if (bez) {
      // sample the bezier by its parameter s (x and y both cubic)
      const s = a;
      const x = 3 * (1 - s) ** 2 * s * bez[0] + 3 * (1 - s) * s * s * bez[2] + s ** 3;
      y = 3 * (1 - s) ** 2 * s * bez[1] + 3 * (1 - s) * s * s * bez[3] + s ** 3;
      pts.push(`${(x * 60).toFixed(1)},${(30 - y * 28).toFixed(1)}`);
      continue;
    }
    pts.push(`${(a * 60).toFixed(1)},${(30 - y * 28).toFixed(1)}`);
  }
  const wrap = document.createElement("div");
  wrap.className = "ease-preview";
  wrap.innerHTML = `<svg viewBox="-2 -2 64 36" width="64" height="36"><rect x="0" y="2" width="60" height="28" fill="none" stroke="#3a3f47"/><polyline points="${pts.join(" ")}" fill="none" stroke="#4ea1ff" stroke-width="2"/></svg>`;
  return wrap;
}
