// Spine-side panels of the editor: the Constraints, Skins, Events and Images tabs (tree rows and property panels),
// the new-constraint dialog, bone inherit / skin fields and the path-attachment overlay. Everything edits through
// ops (setConstraint / updateConstraint / setSkinAttachment / setEvent ...), like the rest of the editor.
import { constraintList } from "../src/core/index.ts";
import type { DrawItem, PosedBoundingBox, IkConstraint, Model, Op, PathConstraint, Pose, Slider, SpinePhysics, TransformConstraint, TransformProperty, Vec2 } from "../src/core/index.ts";
import { confirmDialog, dialog, promptText } from "./dialog.ts";
import type { Field } from "./dialog.ts";

export type SpineSelKind = "ik" | "transform" | "path" | "sphysics" | "slider" | "skin" | "event" | "image";

/** What the panels need from the editor. */
export interface SpineUIHost {
  h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, unknown>, ...kids: Array<Node | string>): HTMLElementTagNameMap[K];
  field(label: string, control: HTMLElement): HTMLElement;
  num(label: string, value: number, onchange: (v: number) => void, step?: number): HTMLElement;
  selectOf(options: Array<[string, string]>, value: string, onchange: (v: string) => void): HTMLSelectElement;
  raw(text: string, tag?: "span" | "div" | "h3", cls?: string): HTMLElement;
  header(title: string, ...actions: HTMLElement[]): HTMLElement;
  iconBtn(label: string, title: string, onclick: () => void, extra?: string): HTMLElement;
  commit(ops: Op[], what?: string): Promise<boolean>;
  select(sel: { kind: string; id: string } | null): void;
  selected(): { kind: string; id: string } | null;
  status(text: string, error?: boolean): void;
  /** Image URL for thumbnails. */
  imageSrc(id: string): string | undefined;
  /** Items of the tree: a clickable row like the other tabs'. */
  item(kind: string, id: string, label: string, tag?: string): HTMLElement;
  /** The current animation and local time (for keying constraint values). */
  animation(): string | null;
  time(): number;
  /** Plays an event sound (audio/<path> next to the model); resolves false when it cannot be loaded. */
  playSound(path: string, volume?: number, balance?: number): Promise<boolean>;
  /** Asks for a sound file, copies it into audio/ next to the model; its event audio path, or null when cancelled. */
  chooseSound(): Promise<string | null>;
}

const KIND_LABEL: Record<string, string> = { ik: "IK", transform: "Transform", path: "Path", physics: "Physics", slider: "Slider" };
/** Constraint kind (in constraintOrder) -> selection kind. */
export const SEL_OF: Record<string, SpineSelKind> = { ik: "ik", transform: "transform", path: "path", physics: "sphysics", slider: "slider" };
const KIND_OF: Record<string, "ik" | "transform" | "path" | "physics" | "slider"> = { ik: "ik", transform: "transform", path: "path", sphysics: "physics", slider: "slider" };
const PROPS: TransformProperty[] = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"];

// ---------- tree rows

export function constraintRows(m: Model, host: SpineUIHost, matches: (id: string) => boolean): HTMLElement[] {
  const { h } = host;
  const list = constraintList(m);
  const add = h("button", { class: "icon small", title: "New constraint", onclick: (e: MouseEvent) => newConstraintMenu(m, host, e) }, "＋");
  const rows: HTMLElement[] = [h("div", { class: "item note combo-head" }, h("span", {}, "Constraints (evaluation order)"), add)];
  list.forEach(({ kind, id }, i) => {
    if (!matches(id)) return;
    rows.push(host.item(SEL_OF[kind], id, id, `${i + 1} · ${KIND_LABEL[kind]}`));
  });
  if (!list.length) rows.push(h("div", { class: "item", style: "color:var(--muted);white-space:normal" }, "No constraints. Add IK, transform, path, physics or slider constraints with ＋."));
  return rows;
}

export function skinRows(m: Model, host: SpineUIHost): HTMLElement[] {
  const { h } = host;
  const add = h("button", { class: "icon small", title: "New skin", onclick: () => void newSkin(m, host) }, "＋");
  const rows: HTMLElement[] = [h("div", { class: "item note combo-head" }, h("span", {}, "Skins"), add)];
  const none = h(
    "div",
    { class: "item" + (!m.skin ? " selected" : ""), title: "Default attachments only", onclick: () => void host.commit([{ op: "setSkin", name: null } as Op], "no skin") },
    h("span", { class: "dot", style: "background:#8b949e" }),
    "(default only)",
    !m.skin ? h("span", { class: "tag" }, "active") : "",
  );
  rows.push(none);
  for (const name of Object.keys(m.skins ?? {})) {
    const count = Object.values(m.skins![name].attachments).reduce((n, s) => n + Object.keys(s).length, 0);
    rows.push(host.item("skin", name, name, m.skin === name ? "active" : `${count}`));
  }
  if (!Object.keys(m.skins ?? {}).length) rows.push(h("div", { class: "item", style: "color:var(--muted);white-space:normal" }, "No skins. A skin swaps the attachments of placeholders (outfits, characters). Add one with ＋."));
  return rows;
}

export function eventRows(m: Model, host: SpineUIHost, matches: (id: string) => boolean): HTMLElement[] {
  const { h } = host;
  const add = h("button", { class: "icon small", title: "New event", onclick: () => void newEvent(host) }, "＋");
  const rows: HTMLElement[] = [h("div", { class: "item note combo-head" }, h("span", {}, "Events"), add)];
  const uses = (name: string) => Object.values(m.animations ?? {}).reduce((n, a) => n + (a.events ?? []).filter((e) => e.name === name).length, 0);
  for (const name of Object.keys(m.events ?? {}).filter(matches)) {
    const row = host.item("event", name, name, `${m.events![name].audio ? "♪ " : ""}${uses(name)}`);
    row.title = m.events![name].audio ? `${name}: sound audio/${m.events![name].audio}, ${uses(name)} key(s)` : `${name}: no sound, ${uses(name)} key(s)`;
    rows.push(row);
  }
  if (Object.keys(m.events ?? {}).length && !Object.values(m.events ?? {}).some((e) => e.audio)) {
    rows.push(h("div", { class: "item", style: "color:var(--muted);white-space:normal" }, "No event has a sound. Select an event and choose a sound file to hear it while an animation plays."));
  }
  if (!Object.keys(m.events ?? {}).length) rows.push(h("div", { class: "item", style: "color:var(--muted);white-space:normal" }, "No events. Events fire at key times (sounds, effects); add keys on the timeline's events row."));
  return rows;
}

export function imageRows(m: Model, host: SpineUIHost, matches: (id: string) => boolean): HTMLElement[] {
  const { h } = host;
  const rows: HTMLElement[] = [h("div", { class: "item note" }, "Images (atlas regions)")];
  const users = imageUsers(m);
  for (const id of Object.keys(m.images ?? {}).filter(matches).sort()) rows.push(host.item("image", id, id, `${users.get(id)?.length ?? 0}`));
  const audio = [...new Set(Object.values(m.events ?? {}).map((e) => e.audio).filter((a): a is string => !!a))];
  if (Object.keys(m.events ?? {}).length && !audio.length) {
    rows.push(h("div", { class: "item note" }, "Audio (event sounds)"), h("div", { class: "item", style: "color:var(--muted);white-space:normal" }, "None: no event has a sound file."));
  }
  if (audio.length) {
    rows.push(h("div", { class: "item note" }, "Audio (event sounds)"));
    for (const a of audio) rows.push(h("div", { class: "item", title: `audio/${a}`, onclick: () => void host.playSound(a) }, h("span", { class: "dot", style: "background:#e3b341" }), host.raw(a), h("span", { class: "tag" }, "▶")));
  }
  return rows;
}

function imageUsers(m: Model): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, a] of Object.entries(m.attachments)) if (a.image) out.set(a.image, [...(out.get(a.image) ?? []), id]);
  return out;
}

// ---------- property panels

/** Fills the properties panel for a Spine selection; false when the selection is not one of these. */
export function spineProps(m: Model, sel: { kind: string; id: string }, box: HTMLElement, host: SpineUIHost): boolean {
  switch (sel.kind) {
    case "transform":
      return transformProps(m, sel.id, box, host);
    case "path":
      return pathProps(m, sel.id, box, host);
    case "sphysics":
      return physicsProps(m, sel.id, box, host);
    case "slider":
      return sliderProps(m, sel.id, box, host);
    case "skin":
      return skinProps(m, sel.id, box, host);
    case "event":
      return eventProps(m, sel.id, box, host);
    case "image":
      return imageProps(m, sel.id, box, host);
  }
  return false;
}

/** Order and delete buttons of a constraint's header. */
function constraintActions(m: Model, kind: "ik" | "transform" | "path" | "physics" | "slider", id: string, host: SpineUIHost): HTMLElement[] {
  const keys = constraintList(m).map((c) => `${c.kind}:${c.id}`);
  const me = `${kind}:${id}`;
  const at = keys.indexOf(me);
  const move = (d: number) => {
    const next = keys.filter((k) => k !== me);
    next.splice(Math.max(0, Math.min(next.length, at + d)), 0, me);
    void host.commit([{ op: "setConstraintOrder", order: next } as Op], `${id}: evaluated ${at + d + 1} of ${keys.length}`);
  };
  const remove = async () => {
    if (!(await confirmDialog(`Delete ${KIND_LABEL[kind]} constraint?`, `"${id}" and its keys in every animation are removed. (Undo brings it back.)`, "Delete", true))) return;
    const op = kind === "ik" ? { op: "removeIk", id } : { op: "removeConstraint", kind, id };
    if (await host.commit([op as Op], `deleted ${id}`)) host.select(null);
  };
  return [
    host.iconBtn("▲", "Evaluate earlier", () => move(-1)),
    host.iconBtn("▼", "Evaluate later", () => move(1)),
    host.iconBtn("🗑", "Delete constraint", () => void remove(), "danger"),
  ];
}

const bonesOf = (m: Model): Array<[string, string]> => m.bones.map((b) => [b.id, b.id]);

/** A checkbox field. */
function check(host: SpineUIHost, label: string, value: boolean, set: (v: boolean) => void, title = ""): HTMLElement {
  const c = host.h("input", { type: "checkbox", checked: value });
  c.addEventListener("change", () => set(c.checked));
  const f = host.field(label, c);
  if (title) f.title = title;
  return f;
}

/** A list of bones (the constrained bones) as chips with ✕ and an add select. */
function boneList(m: Model, host: SpineUIHost, bones: string[], set: (bones: string[]) => void, max = Infinity): HTMLElement {
  const { h } = host;
  const chips = bones.map((b, i) => h("span", { class: "chip" }, host.raw(b), bones.length > 1 ? h("button", { class: "icon small", title: `Remove ${b}`, onclick: () => set(bones.filter((_, j) => j !== i)) }, "✕") : ""));
  const add = bones.length < max ? host.selectOf([["", "+ bone…"], ...bonesOf(m).filter(([id]) => !bones.includes(id))], "", (v) => v && set([...bones, v])) : h("span");
  return h("div", { class: "key-chips" }, ...chips, add);
}

/** IK extras (Spine): shown under the IK panel. */
export function ikSpineFields(m: Model, c: IkConstraint, host: SpineUIHost): HTMLElement[] {
  const up = (patch: Record<string, unknown>) => void host.commit([{ op: "updateIk", id: c.id, ...patch } as Op]);
  return [
    host.h("div", { class: "grid2" }, ...constraintActions(m, "ik", c.id, host)),
    host.num("softness", c.softness ?? 0, (v) => up({ softness: Math.max(0, v) }), 1),
    host.h("div", { class: "grid2" }, check(host, "compress", !!c.compress, (v) => up({ compress: v }), "One-bone chains shrink to reach a close target"), check(host, "stretch", !!c.stretch, (v) => up({ stretch: v }), "The chain stretches to reach a far target")),
    host.field("scaleY", host.selectOf([["none", "unchanged"], ["uniform", "uniform"], ["volume", "keep volume"]], c.scaleY ?? "none", (v) => up({ scaleY: v }))),
    check(host, "skin only", !!c.skin, (v) => up({ skin: v }), "Active only while the active skin lists it"),
  ];
}

function transformProps(m: Model, id: string, box: HTMLElement, host: SpineUIHost): boolean {
  const c = m.transforms?.find((x) => x.id === id);
  if (!c) return false;
  const { h } = host;
  const set = (patch: Partial<TransformConstraint> | Record<string, unknown>) => void host.commit([{ op: "updateConstraint", kind: "transform", id, set: patch } as Op]);
  const mixRows = PROPS.filter((p) => c.properties.some((f) => f.to.some((t) => t.property === p))).map((p) =>
    host.num(`mix ${p}`, c.mix[p] ?? 0, (v) => set({ mix: { ...c.mix, [p]: v } }), 0.05),
  );
  const offsetRows = PROPS.map((p) => host.num(`offset ${p}`, c.offset?.[p] ?? 0, (v) => set({ offset: { ...(c.offset ?? {}), [p]: v } }), p === "x" || p === "y" ? 1 : p.startsWith("scale") ? 0.05 : 1));
  const mapping = c.properties.map((f, i) =>
    h(
      "div",
      { class: "note" },
      `${f.from}${f.offset ? ` − ${f.offset}` : ""} → ${f.to.map((t) => `${t.property}${t.scale !== undefined && t.scale !== 1 ? ` ×${t.scale}` : ""}${t.offset ? ` +${t.offset}` : ""}`).join(", ")}`,
      h("button", { class: "icon small", title: "Remove this mapping", onclick: () => set({ properties: c.properties.filter((_, j) => j !== i) }) }, "✕"),
    ),
  );
  const addFrom = host.selectOf([["", "+ copy…"], ...PROPS.map((p) => [p, p] as [string, string])], "", (v) => {
    if (!v) return;
    const p = v as TransformProperty;
    set({ properties: [...c.properties, { from: p, to: [{ property: p }] }], mix: { ...c.mix, [p]: c.mix[p] ?? 1 } });
  });
  box.replaceChildren(
    host.header(id, ...constraintActions(m, "transform", id, host)),
    h("div", { class: "sub" }, `transform · ${c.bones.join(", ")} follow ${c.source}`),
    host.field("source", host.selectOf(bonesOf(m), c.source, (v) => set({ source: v }))),
    host.field("bones", boneList(m, host, c.bones, (bones) => set({ bones }))),
    h("div", { class: "section" }, "Copies"),
    ...mapping,
    addFrom,
    h("div", { class: "section" }, "Mix"),
    ...mixRows,
    h("div", { class: "section" }, "Offsets (added to the source)"),
    h("div", { class: "grid2" }, ...offsetRows),
    h(
      "div",
      { class: "grid2" },
      check(host, "local source", !!c.localSource, (v) => set({ localSource: v || null }), "Read the source's local transform"),
      check(host, "local target", !!c.localTarget, (v) => set({ localTarget: v || null }), "Write the bones' local transforms"),
      check(host, "additive", !!c.additive, (v) => set({ additive: v || null }), "Add to the bones' transforms instead of replacing them"),
      check(host, "clamp", !!c.clamp, (v) => set({ clamp: v || null }), "Keep the values between the target offset and max"),
    ),
    check(host, "skin only", !!c.skin, (v) => set({ skin: v || null })),
    keyNote(host, "transform", id, ["rotate", "x", "y", "scaleX", "scaleY", "shearY"].filter((p) => (c.mix as Record<string, number>)[p] !== undefined), (p) => (c.mix as Record<string, number>)[p] ?? 0),
  );
  return true;
}

function pathProps(m: Model, id: string, box: HTMLElement, host: SpineUIHost): boolean {
  const c = m.paths?.find((x) => x.id === id);
  if (!c) return false;
  const { h } = host;
  const set = (patch: Partial<PathConstraint> | Record<string, unknown>) => void host.commit([{ op: "updateConstraint", kind: "path", id, set: patch } as Op]);
  const slot = m.slots.find((s) => s.id === c.slot);
  const hasPath = !!(slot?.attachment && m.pathAttachments?.[slot.attachment]);
  box.replaceChildren(
    host.header(id, ...constraintActions(m, "path", id, host)),
    h("div", { class: "sub" }, `path · ${c.bones.length} bones along ${c.slot}`),
    host.field("path slot", host.selectOf(m.slots.map((s) => [s.id, s.id]), c.slot, (v) => set({ slot: v }))),
    ...(hasPath ? [] : [h("div", { class: "note" }, "The slot shows no path attachment right now: the bones are not moved.")]),
    host.field("bones", boneList(m, host, c.bones, (bones) => set({ bones }))),
    host.field("position", host.selectOf([["percent", "percent"], ["fixed", "fixed"]], c.positionMode, (v) => set({ positionMode: v }))),
    host.num("position", c.position, (v) => set({ position: v }), c.positionMode === "percent" ? 0.01 : 1),
    host.field("spacing", host.selectOf([["length", "length"], ["fixed", "fixed"], ["percent", "percent"], ["proportional", "proportional"]], c.spacingMode, (v) => set({ spacingMode: v }))),
    host.num("spacing", c.spacing, (v) => set({ spacing: v }), c.spacingMode === "percent" || c.spacingMode === "proportional" ? 0.01 : 1),
    host.field("rotate", host.selectOf([["tangent", "tangent"], ["chain", "chain"], ["chainScale", "chain scale"]], c.rotateMode, (v) => set({ rotateMode: v }))),
    host.num("rotation offset", c.rotation ?? 0, (v) => set({ rotation: v || null }), 1),
    host.num("mix rotate", c.mix.rotate, (v) => set({ mix: { ...c.mix, rotate: v } }), 0.05),
    h("div", { class: "grid2" }, host.num("mix x", c.mix.x, (v) => set({ mix: { ...c.mix, x: v } }), 0.05), host.num("mix y", c.mix.y, (v) => set({ mix: { ...c.mix, y: v } }), 0.05)),
    check(host, "skin only", !!c.skin, (v) => set({ skin: v || null })),
    keyNote(host, "path", id, ["position", "spacing", "rotate", "x", "y"], (ch) => (ch === "position" ? c.position : ch === "spacing" ? c.spacing : (c.mix as Record<string, number>)[ch])),
  );
  return true;
}

function physicsProps(m: Model, id: string, box: HTMLElement, host: SpineUIHost): boolean {
  const c = m.spinePhysics?.find((x) => x.id === id);
  if (!c) return false;
  const { h } = host;
  const set = (patch: Partial<SpinePhysics> | Record<string, unknown>) => void host.commit([{ op: "updateConstraint", kind: "physics", id, set: patch } as Op]);
  const amount = (k: "x" | "y" | "rotate" | "scaleX" | "shearX") => host.num(k, c[k] ?? 0, (v) => set({ [k]: v || null }), 0.05);
  const global = (k: SpinePhysics["global"] extends Array<infer G> | undefined ? G : never) =>
    check(host, `${k} global`, !!c.global?.includes(k), (v) => {
      const g = new Set(c.global ?? []);
      if (v) g.add(k);
      else g.delete(k);
      set({ global: g.size ? [...g] : null });
    });
  box.replaceChildren(
    host.header(id, ...constraintActions(m, "physics", id, host)),
    h("div", { class: "sub" }, `physics · ${c.bone}`),
    host.field("bone", host.selectOf(bonesOf(m), c.bone, (v) => set({ bone: v }))),
    h("div", { class: "section" }, "Simulated"),
    h("div", { class: "grid2" }, amount("x"), amount("y"), amount("rotate"), amount("shearX"), amount("scaleX"), host.field("scaleY", host.selectOf([["none", "unchanged"], ["uniform", "uniform"], ["volume", "keep volume"]], c.scaleY ?? "none", (v) => set({ scaleY: v === "none" ? null : v })))),
    h("div", { class: "section" }, "Settings"),
    host.num("inertia", c.inertia, (v) => set({ inertia: v }), 0.05),
    host.num("strength", c.strength, (v) => set({ strength: v }), 1),
    host.num("damping", c.damping, (v) => set({ damping: v }), 0.01),
    host.num("mass", c.mass, (v) => set({ mass: Math.max(0.001, v) }), 0.05),
    host.num("wind", c.wind, (v) => set({ wind: v }), 0.1),
    host.num("gravity", c.gravity, (v) => set({ gravity: v }), 0.1),
    host.num("mix", c.mix, (v) => set({ mix: v }), 0.05),
    h("div", { class: "grid2" }, host.num("limit", c.limit ?? 5000, (v) => set({ limit: v === 5000 ? null : v }), 50), host.num("fps", c.fps ?? 60, (v) => set({ fps: v === 60 ? null : Math.max(1, Math.round(v)) }), 1)),
    h("details", {}, h("summary", {}, "Global settings (changed by the global physics keys)"), h("div", { class: "grid2" }, ...(["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"] as const).map(global))),
    check(host, "skin only", !!c.skin, (v) => set({ skin: v || null })),
    h("div", { class: "note" }, "Physics runs live in the editor, like Spine: while an animation plays (from its start), and in the setup pose or paused while you move bones (View › Physics turns it off)."),
    keyNote(host, "physics", id, ["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"], (ch) => (c as unknown as Record<string, number>)[ch]),
  );
  return true;
}

function sliderProps(m: Model, id: string, box: HTMLElement, host: SpineUIHost): boolean {
  const c = m.sliders?.find((x) => x.id === id);
  if (!c) return false;
  const { h } = host;
  const set = (patch: Partial<Slider> | Record<string, unknown>) => void host.commit([{ op: "updateConstraint", kind: "slider", id, set: patch } as Op]);
  const anim = m.animations?.[c.animation];
  box.replaceChildren(
    host.header(id, ...constraintActions(m, "slider", id, host)),
    h("div", { class: "sub" }, `slider · poses ${c.animation}`),
    host.field("animation", host.selectOf(Object.keys(m.animations ?? {}).map((a) => [a, a]), c.animation, (v) => set({ animation: v }))),
    host.num("time", c.time, (v) => set({ time: v }), 0.01),
    ...(anim ? [h("div", { class: "dim" }, `${c.animation} is ${anim.duration}s long`)] : []),
    host.num("mix", c.mix, (v) => set({ mix: v }), 0.05),
    h("div", { class: "grid2" }, check(host, "additive", !!c.additive, (v) => set({ additive: v || null })), check(host, "loop", !!c.loop, (v) => set({ loop: v || null }))),
    h("div", { class: "section" }, "Driven by a bone (optional)"),
    host.field("bone", host.selectOf([["", "(none: the time above)"], ...bonesOf(m)], c.bone ?? "", (v) => set(v ? { bone: v, property: c.property ?? "rotate" } : { bone: null, property: null }))),
    ...(c.bone
      ? [
          host.field("property", host.selectOf(PROPS.map((p) => [p, p]), c.property ?? "rotate", (v) => set({ property: v }))),
          h("div", { class: "grid2" }, host.num("from", c.from ?? 0, (v) => set({ from: v || null }), 1), host.num("to", c.to ?? 0, (v) => set({ to: v || null }), 0.01)),
          host.num("scale", c.scale ?? 1, (v) => set({ scale: v === 1 ? null : v }), 0.001),
          check(host, "local", !!c.local, (v) => set({ local: v || null }), "Read the bone's local value"),
          h("div", { class: "note" }, "time = to + (bone value − from) × scale"),
        ]
      : []),
    check(host, "skin only", !!c.skin, (v) => set({ skin: v || null })),
    keyNote(host, "slider", id, ["time", "mix"], (ch) => (ch === "time" ? c.time : c.mix)),
  );
  return true;
}

/** "Key at the playhead" buttons for a constraint's timeline channels (with an animation selected). */
function keyNote(host: SpineUIHost, kind: string, id: string, channels: string[], value: (ch: string) => number): HTMLElement {
  const { h } = host;
  const anim = host.animation();
  if (!anim) return h("div", { class: "note" }, "Select an animation to key these values over time.");
  const t = host.time();
  return h(
    "div",
    { class: "insp-stack" },
    h("div", { class: "section" }, `Key at ${t.toFixed(3)}s in ${anim}`),
    h(
      "div",
      { class: "key-chips" },
      ...channels.map((ch) =>
        h(
          "button",
          {
            class: "chip",
            title: `Key ${ch} (its current setup value) at the playhead`,
            onclick: () => void host.commit([{ op: "setConstraintKeys", animation: anim, kind, constraint: id, channel: ch, keys: [{ t, v: value(ch) }], mode: "merge" } as Op], `keyed ${id} ${ch} at ${t}s`),
          },
          `◆ ${ch}`,
        ),
      ),
      ...(kind === "physics"
        ? [h("button", { class: "chip", title: "Restart the simulation at the playhead", onclick: () => void host.commit([{ op: "setConstraintKeys", animation: anim, kind, constraint: id, channel: "reset", keys: [{ t }], mode: "merge" } as Op], `${id}: reset at ${t}s`) }, "◆ reset")]
        : []),
    ),
  );
}

function skinProps(m: Model, name: string, box: HTMLElement, host: SpineUIHost): boolean {
  const sk = m.skins?.[name];
  if (!sk) return false;
  const { h } = host;
  const active = m.skin === name;
  const rename = async () => {
    const to = await promptText("Rename Skin", "New name", name);
    if (to && to !== name && (await host.commit([{ op: "renameSkin", name, to } as Op]))) host.select({ kind: "skin", id: to });
  };
  const dup = async () => {
    const to = await promptText("Duplicate Skin", "Name", `${name}-copy`);
    if (to && (await host.commit([{ op: "addSkin", name: to, copyOf: name } as Op]))) host.select({ kind: "skin", id: to });
  };
  const remove = async () => {
    if (!(await confirmDialog("Delete skin?", `"${name}" is removed; its attachments stay in the model. (Undo brings it back.)`, "Delete", true))) return;
    if (await host.commit([{ op: "removeSkin", name } as Op])) host.select(null);
  };
  const setAtt = (slot: string, placeholder: string, attachment: string | null) => void host.commit([{ op: "setSkinAttachment", skin: name, slot, placeholder, attachment } as Op]);
  const ids = [...Object.keys(m.attachments), ...Object.keys(m.pathAttachments ?? {})];
  const rows: HTMLElement[] = [];
  for (const s of m.slots) {
    const entries = Object.entries(sk.attachments[s.id] ?? {});
    for (const [key, id] of entries) {
      rows.push(
        h(
          "div",
          { class: "skin-row" },
          host.raw(`${s.id} / ${key}`, "span", "skin-key"),
          host.selectOf(ids.map((a) => [a, a]), id, (v) => setAtt(s.id, key, v)),
          h("button", { class: "icon small", title: "Remove from the skin", onclick: () => setAtt(s.id, key, null) }, "✕"),
        ),
      );
    }
  }
  const addEntry = async () => {
    const r = await dialog({
      title: `Add to ${name}`,
      fields: [
        { name: "slot", label: "Slot", type: "select", options: m.slots.map((s) => [s.id, s.id]) },
        { name: "placeholder", label: "Placeholder", type: "text", hint: "The name slots and keys use (usually the default attachment's)" },
        { name: "attachment", label: "Attachment", type: "select", options: ids.map((a) => [a, a]) },
      ] as Field[],
      buttons: [{ label: "Cancel", value: "cancel" }, { label: "Add", value: "ok", primary: true }],
      validate: (res) => (res.button === "ok" && !String(res.values.placeholder).trim() ? "Enter a placeholder name" : null),
    });
    if (r?.button !== "ok") return;
    setAtt(String(r.values.slot), String(r.values.placeholder).trim(), String(r.values.attachment));
  };
  const skinBones = m.bones.filter((b) => b.skin);
  const constraints = constraintList(m).map((c) => `${c.kind}:${c.id}`);
  const skinConstraints = constraints.filter((k) => {
    const [kind, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const list = kind === "ik" ? m.ik : kind === "transform" ? m.transforms : kind === "path" ? m.paths : kind === "physics" ? m.spinePhysics : m.sliders;
    return (list as Array<{ id: string; skin?: boolean }> | undefined)?.find((c) => c.id === id)?.skin;
  });
  const toggle = (list: string[] | undefined, v: string, on: boolean) => {
    const s = new Set(list ?? []);
    if (on) s.add(v);
    else s.delete(v);
    return [...s];
  };
  box.replaceChildren(
    host.header(name, host.iconBtn("✎", "Rename", () => void rename()), host.iconBtn("⧉", "Duplicate", () => void dup()), host.iconBtn("🗑", "Delete skin", () => void remove(), "danger")),
    h("div", { class: "sub" }, `skin · ${rows.length} attachment${rows.length === 1 ? "" : "s"}${active ? " · active" : ""}`),
    active
      ? h("button", { onclick: () => void host.commit([{ op: "setSkin", name: null } as Op]) }, "Deactivate (default attachments only)")
      : h("button", { class: "primary", onclick: () => void host.commit([{ op: "setSkin", name } as Op], `skin ${name}`) }, "Activate this skin"),
    h("div", { class: "section" }, "Attachments (slot / placeholder → attachment)"),
    ...(rows.length ? rows : [h("div", { class: "note" }, "Empty: the default attachments show.")]),
    h("button", { onclick: () => void addEntry() }, "+ Add attachment…"),
    ...(skinBones.length
      ? [
          h("div", { class: "section" }, "Skin bones (exist only with this skin)"),
          ...skinBones.map((b) => check(host, b.id, !!sk.bones?.includes(b.id), (v) => void host.commit([{ op: "setSkinBones", skin: name, bones: toggle(sk.bones, b.id, v) } as Op]))),
        ]
      : []),
    ...(skinConstraints.length
      ? [
          h("div", { class: "section" }, "Skin constraints"),
          ...skinConstraints.map((k) => check(host, k, !!sk.constraints?.includes(k), (v) => void host.commit([{ op: "setSkinBones", skin: name, constraints: toggle(sk.constraints, k, v) } as Op]))),
        ]
      : []),
    h("div", { class: "note" }, 'A slot showing a placeholder name draws the active skin\'s attachment for it. Mark bones / constraints "skin only" to switch them with skins.'),
  );
  return true;
}

function eventProps(m: Model, name: string, box: HTMLElement, host: SpineUIHost): boolean {
  const e = m.events?.[name];
  if (!e) return false;
  const { h } = host;
  const set = (patch: Record<string, unknown>) => void host.commit([{ op: "setEvent", name, ...e, ...patch } as Op]);
  const text = (label: string, value: string, apply: (v: string) => void) => {
    const input = h("input", { value });
    input.addEventListener("change", () => apply(input.value));
    return host.field(label, input);
  };
  const uses = Object.entries(m.animations ?? {}).flatMap(([a, an]) => (an.events ?? []).filter((x) => x.name === name).map((x) => `${a} @ ${x.t}s`));
  const soundNote = host.raw(e.audio ? `audio/${e.audio}` : "", "span", "dim");
  const preview = async (path: string) => {
    const ok = await host.playSound(path, e.volume ?? 1, e.balance ?? 0);
    soundNote.textContent = ok ? `audio/${path}` : `audio/${path} ✕`;
    soundNote.style.color = ok ? "" : "var(--err)";
  };
  const choose = async () => {
    const path = await host.chooseSound();
    if (path) set({ audio: path });
  };
  const remove = async () => {
    if (!(await confirmDialog("Delete event?", `"${name}" and its ${uses.length} key(s) are removed. (Undo brings it back.)`, "Delete", true))) return;
    if (await host.commit([{ op: "setEvent", name, remove: true } as Op])) host.select(null);
  };
  box.replaceChildren(
    host.header(name, host.iconBtn("🗑", "Delete event", () => void remove(), "danger")),
    h("div", { class: "sub" }, `event · ${uses.length} key${uses.length === 1 ? "" : "s"}`),
    h("div", { class: "section" }, "Defaults (keys can override them)"),
    h("div", { class: "grid2" }, host.num("int", e.int ?? 0, (v) => set({ int: Math.round(v) }), 1), host.num("float", e.float ?? 0, (v) => set({ float: v }), 0.1)),
    text("string", e.string ?? "", (v) => set({ string: v })),
    h("div", { class: "section" }, "Sound"),
    ...(e.audio
      ? [
          text("audio path", e.audio, (v) => set({ audio: v.trim() })),
          h("div", { class: "grid2" }, host.num("volume", e.volume ?? 1, (v) => set({ volume: v }), 0.05), host.num("balance", e.balance ?? 0, (v) => set({ balance: v }), 0.05)),
          h(
            "div",
            { class: "row" },
            h("button", { class: "small", title: "Play the sound (volume and balance applied)", onclick: () => void preview(e.audio!) }, "▶ Play sound"),
            soundNote,
          ),
          h(
            "div",
            { class: "pair" },
            h("button", { title: "Pick another sound file (copied into audio/ next to the model)", onclick: () => void choose() }, "Change sound…"),
            h("button", { title: "The event keeps firing, silently", onclick: () => set({ audio: undefined, volume: undefined, balance: undefined }) }, "Remove sound"),
          ),
        ]
      : [
          h("div", { class: "note" }, "No sound: this event fires silently (games may still react to it). Pick a .wav, .ogg or .mp3 file to play when it fires."),
          h("button", { class: "primary", title: "Copied into audio/ next to the model; exported with the model", onclick: () => void choose() }, "Choose sound file…"),
        ]),
    h("div", { class: "section" }, "Keys"),
    ...(uses.length ? uses.slice(0, 20).map((u) => host.raw(u, "div", "dim")) : [h("div", { class: "note" }, "Not keyed yet: double-click the timeline's events row.")]),
  );
  return true;
}

function imageProps(m: Model, id: string, box: HTMLElement, host: SpineUIHost): boolean {
  const ref = m.images?.[id];
  if (!ref) return false;
  const { h } = host;
  const users = imageUsers(m).get(id) ?? [];
  const src = host.imageSrc(id);
  box.replaceChildren(
    host.header(id),
    host.raw(ref.path, "div", "sub"),
    ...(src ? [h("img", { src, class: "image-preview", alt: id })] : []),
    h("div", { class: "section" }, `Used by ${users.length} attachment${users.length === 1 ? "" : "s"}`),
    ...users.slice(0, 40).map((a) => host.raw(a, "div", "dim")),
  );
  return true;
}

// ---------- create

function newConstraintMenu(m: Model, host: SpineUIHost, e: MouseEvent): void {
  e.stopPropagation();
  void newConstraint(m, host);
}

async function newConstraint(m: Model, host: SpineUIHost): Promise<void> {
  const bones: Array<[string, string]> = bonesOf(m);
  const r = await dialog({
    title: "New Constraint",
    fields: [
      { name: "kind", label: "Kind", type: "select", value: "transform", options: [["ik", "IK (reach a target)"], ["transform", "Transform (copy another bone)"], ["path", "Path (follow a path attachment)"], ["physics", "Physics (simulated)"], ["slider", "Slider (pose an animation)"]] },
      { name: "id", label: "Name", type: "text", value: "" },
      { name: "bone", label: "Bone (constrained / physics bone / IK chain end)", type: "select", options: bones },
      { name: "source", label: "Source / target bone (transform, IK)", type: "select", options: bones },
      { name: "slot", label: "Path slot (path)", type: "select", options: m.slots.map((s) => [s.id, s.id]) },
      { name: "animation", label: "Animation (slider)", type: "select", options: Object.keys(m.animations ?? {}).map((a) => [a, a]) },
    ] as Field[],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Create", value: "ok", primary: true }],
    validate: (res) => {
      if (res.button !== "ok") return null;
      const id = String(res.values.id).trim();
      if (!id) return "Enter a name";
      const kind = String(res.values.kind);
      if (constraintList(m).some((c) => c.kind === kind && c.id === id)) return `a ${kind} constraint "${id}" exists`;
      if ((kind === "transform" || kind === "ik") && res.values.bone === res.values.source) return "Pick a different source / target bone";
      if (kind === "slider" && !res.values.animation) return "The model has no animation to pose";
      return null;
    },
  });
  if (r?.button !== "ok") return;
  const id = String(r.values.id).trim();
  const kind = String(r.values.kind);
  const bone = String(r.values.bone);
  const source = String(r.values.source);
  let op: Op;
  if (kind === "ik") op = { op: "addIk", id, bones: [bone], target: source } as Op;
  else if (kind === "transform")
    op = { op: "setConstraint", kind, constraint: { id, source, bones: [bone], properties: PROPS.map((p) => ({ from: p, to: [{ property: p }] })), mix: { rotate: 1, x: 1, y: 1, scaleX: 1, scaleY: 1, shearY: 1 } } } as Op;
  else if (kind === "path")
    op = { op: "setConstraint", kind, constraint: { id, bones: [bone], slot: String(r.values.slot), positionMode: "percent", spacingMode: "length", rotateMode: "tangent", position: 0, spacing: 0, mix: { rotate: 1, x: 1, y: 1 } } } as Op;
  else if (kind === "physics") op = { op: "setConstraint", kind, constraint: { id, bone, rotate: 1, inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1 } } as Op;
  else op = { op: "setConstraint", kind, constraint: { id, animation: String(r.values.animation), time: 0, mix: 1 } } as Op;
  if (await host.commit([op], `added ${kind} constraint ${id}`)) host.select({ kind: SEL_OF[kind], id });
}

async function newSkin(m: Model, host: SpineUIHost): Promise<void> {
  const name = await promptText("New Skin", "Name", `skin${Object.keys(m.skins ?? {}).length + 1}`);
  if (name && (await host.commit([{ op: "addSkin", name } as Op], `added skin ${name}`))) host.select({ kind: "skin", id: name });
}

async function newEvent(host: SpineUIHost): Promise<void> {
  const name = await promptText("New Event", "Name", "event");
  if (name && (await host.commit([{ op: "setEvent", name } as Op], `new event ${name}`))) host.select({ kind: "event", id: name });
}

// ---------- bones

/** Inherit mode and skin-only fields of a Spine bone. */
export function boneSpineFields(m: Model, boneId: string, host: SpineUIHost): HTMLElement[] {
  const b = m.bones.find((x) => x.id === boneId);
  if (!b) return [];
  const up = (patch: Record<string, unknown>) => void host.commit([{ op: "updateBone", id: boneId, ...patch } as Op]);
  const modes: Array<[string, string]> = [
    ["normal", "normal"],
    ["onlyTranslation", "only translation"],
    ["noRotationOrReflection", "no rotation or reflection"],
    ["noScale", "no scale"],
    ["noScaleOrReflection", "no scale or reflection"],
  ];
  return [
    host.field("inherit", host.selectOf(modes, b.inherit ?? "normal", (v) => up({ inherit: v }))),
    check(host, "skin only", !!b.skin, (v) => up({ skin: v }), "The bone exists only while the active skin lists it"),
  ];
}

// ---------- viewport

/** Path attachments shown in slots: their curves (and points), in world space. */
export function drawPaths(ctx: CanvasRenderingContext2D, m: Model, pose: Pose, toScreen: (p: Vec2) => Vec2, selectedPath: string | null): void {
  if (!m.pathAttachments) return;
  const setup = new Map<string, number[]>();
  for (const s of pose.slots) {
    const att = s.attachment ? m.pathAttachments[s.attachment] : undefined;
    if (!att) continue;
    // path vertices follow their bones (setup pose -> current pose)
    const pts = att.vertices.map((v, i) => {
      let x = 0;
      let y = 0;
      let total = 0;
      for (const [bone, w] of att.weights[i]?.length ? att.weights[i] : [[s.bone, 1] as [string, number]]) {
        const p = pose.byId.get(bone);
        if (!p) continue;
        const inv = setupInverse(m, bone, setup);
        const lx = inv[0] * v[0] + inv[2] * v[1] + inv[4];
        const ly = inv[1] * v[0] + inv[3] * v[1] + inv[5];
        x += (p.world[0] * lx + p.world[2] * ly + p.world[4]) * w;
        y += (p.world[1] * lx + p.world[3] * ly + p.world[5]) * w;
        total += w;
      }
      return toScreen(total ? [x / total, y / total] : v);
    });
    const used = (m.paths ?? []).some((c) => c.slot === s.id && c.id === selectedPath);
    ctx.strokeStyle = used ? "#ffffff" : att.color ? att.color.slice(0, 7) : "#ff7a45";
    ctx.lineWidth = used ? 2.5 : 1.5;
    const n = pts.length / 3;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const p = pts[k * 3 + 1];
      if (k === 0) ctx.moveTo(p[0], p[1]);
      const next = k + 1 < n ? k + 1 : att.closed ? 0 : -1;
      if (next < 0) break;
      const c1 = pts[k * 3 + 2];
      const c2 = pts[next * 3];
      const q = pts[next * 3 + 1];
      ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], q[0], q[1]);
    }
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    for (let k = 0; k < n; k++) ctx.fillRect(pts[k * 3 + 1][0] - 2.5, pts[k * 3 + 1][1] - 2.5, 5, 5);
  }
}

/** Clipping polygons in effect (as the items they clip carry them), outlined. */
export function drawClippings(ctx: CanvasRenderingContext2D, items: DrawItem[], toScreen: (p: Vec2) => Vec2): void {
  const seen = new Set<Vec2[]>();
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  for (const it of items) {
    const poly = it.clipPolygon;
    if (!poly || seen.has(poly)) continue;
    seen.add(poly);
    ctx.strokeStyle = it.clipOutside ? "#ff6b9a" : "#c586ff";
    ctx.beginPath();
    poly.forEach((p, i) => {
      const q = toScreen(p);
      if (i) ctx.lineTo(q[0], q[1]);
      else ctx.moveTo(q[0], q[1]);
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

/** Bounding boxes the slots show (hit-test polygons), outlined in their color; the selected slot's one thicker. */
export function drawBoundingBoxes(ctx: CanvasRenderingContext2D, boxes: PosedBoundingBox[], toScreen: (p: Vec2) => Vec2, selectedSlot: string | null): void {
  ctx.save();
  ctx.setLineDash([3, 3]);
  for (const b of boxes) {
    const c = b.color ?? "#60a8ffff";
    ctx.strokeStyle = c.length === 9 ? c.slice(0, 7) : c;
    ctx.lineWidth = b.slot === selectedSlot ? 2.5 : 1.25;
    ctx.beginPath();
    b.polygon.forEach((p, i) => {
      const q = toScreen(p);
      if (i) ctx.lineTo(q[0], q[1]);
      else ctx.moveTo(q[0], q[1]);
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

const setupInverseCache = new WeakMap<Model["bones"], Map<string, number[]>>();
function setupInverse(m: Model, bone: string, _cache: Map<string, number[]>): number[] {
  let cache = setupInverseCache.get(m.bones);
  if (!cache) setupInverseCache.set(m.bones, (cache = new Map()));
  let inv = cache.get(bone);
  if (!inv) {
    const w = setupWorld(m, bone);
    const det = w[0] * w[3] - w[1] * w[2];
    inv = [w[3] / det, -w[1] / det, -w[2] / det, w[0] / det, (w[2] * w[5] - w[3] * w[4]) / det, (w[1] * w[4] - w[0] * w[5]) / det];
    cache.set(bone, inv);
  }
  return inv;
}

let setupPoseCache: { bones: Model["bones"]; pose: Map<string, number[]> } | null = null;
let computeSetup: ((m: Model) => Pose) | null = null;
/** The editor passes computePose here (keeps this module free of pose imports cycles). */
export function useSetupPose(fn: (m: Model) => Pose): void {
  computeSetup = fn;
}
function setupWorld(m: Model, bone: string): number[] {
  if (!setupPoseCache || setupPoseCache.bones !== m.bones) {
    const pose = computeSetup!(m);
    setupPoseCache = { bones: m.bones, pose: new Map(pose.bones.map((b) => [b.id, b.world as number[]])) };
  }
  return setupPoseCache.pose.get(bone) ?? [1, 0, 0, 1, 0, 0];
}

/** Kind of the constraint a selection names ("sphysics" -> "physics"). */
export const constraintKindOf = (selKind: string) => KIND_OF[selKind];
