// Awaken2D editor: live viewer + direct-manipulation editor. Every edit is an op sent to the server, which applies
// it with the same core code to a working copy and records undo history; File > Save writes it to disk (or
// auto-save does). File changes made elsewhere (an agent using the MCP server or CLI) stream in over SSE: a clean
// document reloads, a document with unsaved edits shows a conflict banner.
import {
  BLEND_MODES,
  PoseSimulator,
  SpineState,
  remeshFromAlpha,
  adjustWeights,
  meshAddHullVertex,
  meshFillInterior,
  meshFromTrace,
  meshAutoGenerate,
  meshAutoPlan,
  boundingBoxPolygons,
  describePlan,
  meshQuarter,
  AUTO_MESH_PRESETS,
  meshOutline,
  meshReset,
  normalizeInfluences,
  angleOf,
  apply,
  applyDrawOrder,
  applyOps,
  boneEnds,
  computePose,
  drawList,
  invert,
  localTime,
  normalizeModel,
  poseRestVertices,
  resolveAttachment,
  restVertices,
  sampleTrack,
  wrapDeg,
  constraintList as allConstraints,
} from "../src/core/index.ts";
import type { MeshRole, AutoMeshOptions, BonePose, Deformer, DrawItem, RotationKeyform, Issue, Key, Live2DPath, MeshAttachment, MeshGeometry, Model, Op, Pose, Vec2 } from "../src/core/index.ts";
import { MeshRenderer } from "./gl.ts";
import { Timeline } from "./timeline.ts";
import { gridIndexAt } from "../src/core/live2dops.ts";
import { live2dFrame, live2dGuides } from "../src/core/live2d.ts";
import { pathMoves, pathPoints, pathPolyline } from "../src/core/live2dpath.ts";
import { alertDialog, confirmDialog, customDialog, dialog, dialogOpen, promptText, showMenu } from "./dialog.ts";
import type { Field, MenuItem } from "./dialog.ts";
import { pickPath } from "./picker.ts";
import { colorSwatch } from "./colorpicker.ts";
import { LANGS, currentLang, misses as i18nMisses, setLang, startI18n, t as tr } from "./i18n.ts";
import { boneSpineFields, constraintKindOf, constraintRows, drawBoundingBoxes, drawClippings, drawPaths, eventRows, ikSpineFields, imageRows, newConstraint, newEvent, newSkin, skinMenuItems, skinRows, spineProps, useSetupPose } from "./spineui.ts";
import type { SpineUIHost } from "./spineui.ts";
import { GIZMO_SIZE, drawGizmo, drawReadout, hitGizmo } from "./gizmo.ts";
import { BONE_ICONS, boneIcon, boneIconSvg, drawBoneIcon } from "./boneicons.ts";
import type { GizmoSpec, Handle, Tool } from "./gizmo.ts";
import type { View } from "./gl.ts";
import { EventAudio, animationSounds } from "./audio.ts";

// ---------- DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const glCanvas = $<HTMLCanvasElement>("gl");
const overlay = $<HTMLCanvasElement>("overlay");
const viewportEl = $<HTMLElement>("viewport");
const animSel = $<HTMLSelectElement>("anim");
const statusEl = $<HTMLElement>("status");
const ov = {
  bones: $<HTMLInputElement>("ov-bones"),
  names: $<HTMLInputElement>("ov-names"),
  mesh: $<HTMLInputElement>("ov-mesh"),
  ik: $<HTMLInputElement>("ov-ik"),
  physics: $<HTMLInputElement>("ov-physics"),
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v !== undefined && v !== false) (el as unknown as Record<string, unknown>)[k] = v;
  }
  el.append(...kids);
  return el;
}

// ---------- state

type Selection = { kind: "bone" | "slot" | "ik" | "param" | "glue" | "transform" | "path" | "sphysics" | "slider" | "skin" | "event" | "image" | "part" | "deformer"; id: string } | null;

const state = {
  file: null as string | null,
  model: null as Model | null,
  /** Model shown while dragging, before the server confirms the edit. */
  preview: null as Model | null,
  version: 0,
  issues: [] as Issue[],
  validating: false,
  canUndo: false,
  canRedo: false,
  anim: null as string | null,
  time: 0,
  playing: false,
  speed: 1,
  sel: null as Selection,
  tab: "bones",
  view: { cx: 0, cy: 0, zoom: 1 } as View,
  fitted: false,
  showIssues: false,
  /** Parameter values pinned with the sliders (preview only; not saved). */
  params: {} as Record<string, number>,
  dirty: false,
  conflict: false,
  autosave: false,
  tool: "select" as Tool,
  /** Setup edits of a bone move the meshes bound to it (off: bones only, to re-bind the skeleton to the art). */
  carry: true,
  /** Spine's bone compensation: Setup edits of a bone leave its child bones where they are. */
  compBones: false,
};

let renderer: MeshRenderer;
let sim: PoseSimulator | null = null;
let simKey: unknown[] = [];
let setupCache: { model: Model; pose: Pose } | null = null;
let lastPose: Pose | null = null;
let lastItems: DrawItem[] = [];
let events: EventSource | null = null;

// ---------- Live2D display toggles, parts / deformers tree state

/** Viewport guides for every deformer / glue (View menu; the selected deformer is always drawn). */
type L2DShow = { warp: boolean; rotation: boolean; glue: boolean; lock: boolean; deflock: boolean; drawables: boolean };
const L2D_SHOW_KEY = "awaken2d.l2dShow";
const l2dShow: L2DShow = (() => {
  const def: L2DShow = { warp: false, rotation: false, glue: false, lock: false, deflock: false, drawables: true };
  try {
    const saved = JSON.parse(localStorage.getItem(L2D_SHOW_KEY) ?? "{}");
    return {
      warp: saved.warp === true,
      rotation: saved.rotation === true,
      // (stored as glueAll: an older setting left glue on everywhere)
      glue: saved.glueAll === true,
      lock: saved.lock === true,
      deflock: saved.deflock === true,
      drawables: saved.drawables !== false,
    };
  } catch {
    return def;
  }
})();
/** Kinds listed in the parts / deformers tree (Cubism's parts palette filter). */
type TreeShow = { art: boolean; warp: boolean; rotation: boolean; glue: boolean };
const TREE_SHOW_KEY = "awaken2d.treeShow";
const treeShow: TreeShow = (() => {
  const def: TreeShow = { art: true, warp: true, rotation: true, glue: true };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(TREE_SHOW_KEY) ?? "{}") };
  } catch {
    return def;
  }
})();
/** Expanded rows of the Live2D tree ("p:<part>" / "d:<deformer>"), per file. */
let treeOpen: { file: string | null; keys: Set<string> } = { file: null, keys: new Set() };
function treeKeys(): Set<string> {
  if (treeOpen.file !== state.file) {
    let keys: string[] = [];
    try {
      keys = JSON.parse(localStorage.getItem(`awaken2d.tree.${state.file}`) ?? "[]");
    } catch {
      // storage blocked: start collapsed
    }
    treeOpen = { file: state.file, keys: new Set(keys) };
  }
  return treeOpen.keys;
}
function toggleTreeKey(key: string): void {
  const keys = treeKeys();
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  try {
    localStorage.setItem(`awaken2d.tree.${state.file}`, JSON.stringify([...keys]));
  } catch {
    // not remembered
  }
  refreshTree();
}

/** Spine hierarchy: bones start expanded, sections start folded. Store only deviations from those defaults. */
let spineTreeState: { file: string | null; toggles: Set<string> } = { file: null, toggles: new Set() };
function spineTreeToggles(): Set<string> {
  if (spineTreeState.file !== state.file) {
    let saved: string[] = [];
    try {
      const value: unknown = JSON.parse(localStorage.getItem(`awaken2d.spineTree.${state.file}`) ?? "[]");
      if (Array.isArray(value)) saved = value.filter((key): key is string => typeof key === "string");
    } catch {
      // Storage blocked: use default expansion.
    }
    spineTreeState = { file: state.file, toggles: new Set(saved) };
  }
  return spineTreeState.toggles;
}
function spineTreeExpanded(key: string): boolean {
  const defaultOpen = key === "model" || key.startsWith("bone:") || key.startsWith("slot:");
  return defaultOpen !== spineTreeToggles().has(key);
}
function toggleSpineTreeKey(key: string): void {
  const toggles = spineTreeToggles();
  if (toggles.has(key)) toggles.delete(key);
  else toggles.add(key);
  try {
    localStorage.setItem(`awaken2d.spineTree.${state.file}`, JSON.stringify([...toggles]));
  } catch {
    // Expansion still works for this session.
  }
  refreshTree();
}
function revealSpineTreeSelection(sel: Selection): void {
  const m = state.model;
  if (!m || !sel || modelTarget(m) !== "spine") return;
  const toggles = spineTreeToggles();
  let changed = false;
  const open = (key: string): void => {
    if (!spineTreeExpanded(key)) {
      if (key === "model" || key.startsWith("bone:") || key.startsWith("slot:")) toggles.delete(key);
      else toggles.add(key);
      changed = true;
    }
  };
  open("model");
  let boneId = sel.kind === "bone" ? sel.id : sel.kind === "slot" ? m.slots.find((slot) => slot.id === sel.id)?.bone : undefined;
  const seen = new Set<string>();
  while (boneId && !seen.has(boneId)) {
    seen.add(boneId);
    open(`bone:${boneId}`);
    boneId = m.bones.find((bone) => bone.id === boneId)?.parent ?? undefined;
  }
  const sections: Partial<Record<NonNullable<Selection>["kind"], string>> = { ik: "constraints", transform: "constraints", path: "constraints", sphysics: "constraints", slider: "constraints", skin: "skins", event: "events", image: "images" };
  const group = sections[sel.kind];
  if (group) for (const key of [`section:${group}`, ...spineFolderKeys(group, sel.id)]) open(key);
  if (changed) {
    try {
      localStorage.setItem(`awaken2d.spineTree.${state.file}`, JSON.stringify([...toggles]));
    } catch {
      // Expansion still works for this session.
    }
  }
}
function revealSpineAnimation(): void {
  const keys = ["section:animations", ...spineFolderKeys("animations", state.anim ?? "")].filter((k) => !spineTreeExpanded(k));
  if (modelTarget() !== "spine" || !keys.length) return;
  const toggles = spineTreeToggles();
  for (const k of keys) toggles.add(k);
  try {
    localStorage.setItem(`awaken2d.spineTree.${state.file}`, JSON.stringify([...toggles]));
  } catch {
    // Expansion still works for this session.
  }
}

/** Items drawn in the viewport: Live2D art meshes hidden in the editor (eye off) are left out. */
function shownItems(): DrawItem[] {
  return state.model?.live2d ? lastItems.filter((it) => !it.attachment.live2d?.hidden) : lastItems;
}

/** A Live2D art mesh that cannot be picked in the viewport: locked itself or inside a locked part. */
function l2dLocked(m: Model, attachmentId: string): boolean {
  const l = m.attachments[attachmentId]?.live2d;
  if (!l) return false;
  if (l.locked) return true;
  const seen = new Set<string>();
  for (let p = l.part; p && !seen.has(p); ) {
    seen.add(p);
    const part = m.live2d?.parts.find((x) => x.id === p);
    if (!part) break;
    if (part.locked) return true;
    p = part.parent;
  }
  return false;
}

function setL2DShow(key: keyof L2DShow, on: boolean): void {
  l2dShow[key] = on;
  try {
    const { glue, ...rest } = l2dShow;
    localStorage.setItem(L2D_SHOW_KEY, JSON.stringify({ ...rest, glueAll: glue }));
  } catch {
    // not remembered
  }
  refreshL2DShow();
  requestDraw();
}

function refreshL2DShow(): void {
  const m = state.model;
  $("l2d-view").hidden = !m?.live2d;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#l2d-view button")) {
    const key = b.dataset.view as ViewButton;
    b.classList.toggle("on", viewButtonOn(key));
  }
  $<HTMLInputElement>("ov-l2d-deformers").checked = l2dShow.warp && l2dShow.rotation;
  const glue = $<HTMLInputElement>("ov-l2d-glue");
  glue.checked = l2dShow.glue;
  glue.disabled = !m?.live2d?.glue?.length;
}

/** Viewport buttons: drawable objects (art meshes, deformation / art paths) locked, deformers locked, drawables shown. */
type ViewButton = "lock" | "deflock" | "drawables";
const viewButtonOn = (key: ViewButton) => l2dShow[key];
function toggleViewButton(key: ViewButton): void {
  setL2DShow(key, !l2dShow[key]);
  if (key === "lock") status(l2dShow.lock ? "drawable objects locked: art meshes, deformation paths and art paths are not picked" : "drawable objects unlocked");
  if (key === "deflock") status(l2dShow.deflock ? "deformers locked: warp and rotation deformers are not picked or edited" : "deformers unlocked");
  if (key === "drawables") status(l2dShow.drawables ? "drawable objects shown" : "drawable objects hidden: art meshes and paths are not drawn");
}

function setTreeShow(key: keyof TreeShow, on: boolean): void {
  treeShow[key] = on;
  try {
    localStorage.setItem(TREE_SHOW_KEY, JSON.stringify(treeShow));
  } catch {
    // not remembered
  }
  refreshTree();
}

/** The parts palette's kind filter (art meshes, art paths, warp / rotation deformers, glue). */
const TREE_KINDS: Array<{ key: keyof TreeShow | "artpath"; title: string; svg: string }> = [
  { key: "art", title: "Show / hide art meshes in the list", svg: '<svg viewBox="0 0 20 20" fill="none" stroke="#4ea1ff" stroke-width="1.6"><rect x="3.5" y="3.5" width="13" height="13" /><path d="M3.5 3.5l13 13M16.5 3.5l-13 13" /></svg>' },
  { key: "artpath", title: "Art paths: not supported yet (Cubism 5.3 art paths are not imported or exported)", svg: '<svg viewBox="0 0 20 20" fill="none" stroke="#26b5b5" stroke-width="1.8"><path d="M3 16c3-9 6 1 8-5s4-6 6-8" /><circle cx="3" cy="16" r="1.6" fill="#26b5b5" /><circle cx="17" cy="3" r="1.6" fill="#26b5b5" /></svg>' },
  { key: "warp", title: "Show / hide warp deformers in the list", svg: '<svg viewBox="0 0 20 20" fill="#3fb96c"><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></svg>' },
  { key: "rotation", title: "Show / hide rotation deformers in the list", svg: '<svg viewBox="0 0 20 20" fill="none" stroke="#e5534b" stroke-width="2"><circle cx="10" cy="11" r="5.5" /><path d="M10 11V2.5M7.5 5L10 2.5 12.5 5" /></svg>' },
  { key: "glue", title: "Show / hide glue in the list", svg: '<svg viewBox="0 0 20 20" fill="#4ea1ff"><path d="M13.5 2.5l4 4-9 9-5 1 1-5z" /><path d="M11.5 4.5l4 4" stroke="#17191d" stroke-width="1.2" /></svg>' },
];
function treeKindFilter(m: Model): HTMLElement {
  return h(
    "div",
    { class: "l2d-show tree-kinds" },
    ...TREE_KINDS.map((k) => {
      const b = h("button", { title: k.title });
      b.innerHTML = k.svg; // constant markup
      if (k.key === "artpath" || (k.key === "glue" && !m.live2d?.glue?.length)) b.disabled = true;
      else {
        const key = k.key;
        b.classList.toggle("on", treeShow[key]);
        b.addEventListener("click", () => setTreeShow(key, !treeShow[key]));
      }
      return b;
    }),
  );
}

const shown = () => state.preview ?? state.model;
const animDef = () => (state.anim ? shown()?.animations?.[state.anim] : undefined);
/** Event sounds (audio/<path> next to the model), played while an animation plays. */
const eventAudio = new EventAudio(
  (path) => (state.file ? `/api/asset?file=${encodeURIComponent(state.file)}&path=${encodeURIComponent(`audio/${path}`)}` : null),
  (path, why) => status(`event sound "${path}" cannot play: ${why} (expected in audio/ next to the model)`, true),
);
/** Whether the last drawn frame was playing (playback starting fires the keys at the playhead too). */
let wasPlaying = false;

const localT = () => {
  const a = animDef();
  return a ? +localTime(a, state.time).toFixed(4) : 0;
};

function status(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.className = "status" + (error ? " error" : "");
  statusEl.title = text;
}

// ---------- server

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error ?? res.statusText);
  return data as T;
}

interface ModelInfo {
  file: string;
  version: number;
  /** Absent in lean edit responses: the client applied the ops itself. */
  model?: Model;
  /** Pose checks still running on the server; full issues arrive over SSE ("validated"). */
  validating?: boolean;
  issues: Issue[];
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  conflict: boolean;
  autosave: boolean;
  log?: string[];
}

async function openFile(file: string): Promise<void> {
  state.file = file;
  eventAudio.reset();
  state.fitted = false;
  state.sel = null;
  state.anim = null;
  state.time = 0;
  history.replaceState(null, "", `?file=${encodeURIComponent(file)}`);
  applyInfo(await api<ModelInfo>(`/api/model?file=${encodeURIComponent(file)}`));
  events?.close();
  events = new EventSource(`/api/events?file=${encodeURIComponent(file)}`);
  events.onopen = () => $("live").classList.add("on");
  events.onerror = () => $("live").classList.remove("on");
  events.onmessage = (e) => {
    const msg = JSON.parse(e.data) as ServerEvent;
    if (state.file !== file) return;
    // our own edit's echo can arrive before its response: wait, then compare versions
    if (commitsInFlight > 0) deferredEvent = msg;
    else void handleEvent(file, msg);
  };
}

interface ServerEvent {
  version: number;
  source: string;
  dirty: boolean;
  conflict: boolean;
  issues?: Issue[];
}
let commitsInFlight = 0;
let deferredEvent: ServerEvent | null = null;

async function handleEvent(file: string, msg: ServerEvent): Promise<void> {
  {
    if (state.file !== file) return;
    if (msg.source === "validated" && msg.version === state.version && msg.issues) {
      state.issues = msg.issues;
      state.validating = false;
      refreshToolbar();
      return;
    }
    if (msg.version > state.version) {
      applyInfo(await api<ModelInfo>(`/api/model?file=${encodeURIComponent(file)}`));
      if (msg.source === "external") status("reloaded: file changed on disk");
      else if (msg.source === "reverted") status("reverted to the saved file");
    } else if (msg.dirty !== state.dirty || msg.conflict !== state.conflict) {
      state.dirty = msg.dirty;
      state.conflict = msg.conflict;
      if (msg.conflict) status("the file changed on disk while you have unsaved edits", true);
      refreshFileState();
    }
  }
}

function applyInfo(info: ModelInfo, local?: Model): void {
  const prev = state.model;
  state.model = info.model ? normalizeModel(info.model) : local!;
  state.preview = null;
  pendingPreview = null;
  state.version = info.version;
  state.issues = info.issues;
  state.validating = info.validating === true;
  state.canUndo = info.canUndo;
  state.canRedo = info.canRedo;
  state.dirty = info.dirty;
  state.conflict = info.conflict;
  state.autosave = info.autosave;
  const m = state.model;
  if (state.anim && !m.animations?.[state.anim]) state.anim = null;
  if (state.sel && !selectionExists(state.sel)) state.sel = null;
  if (!prev || prev.images !== m.images) loadImages(m);
  requestDraw();
  if (!state.fitted) {
    fitView();
    state.fitted = true;
  }
  refreshPanels();
  refreshFileState();
}

/** Sends ops to the server's working copy. Resolves false (with the error in the status bar) when rejected. */
let commitChain: Promise<unknown> = Promise.resolve();
function commit(ops: Op[], what?: string): Promise<boolean> {
  // one at a time: each edit is applied to the result of the previous one, locally and on the server
  const run = commitChain.then(() => commitNow(ops, what));
  commitChain = run;
  return run;
}

async function commitNow(ops: Op[], what?: string): Promise<boolean> {
  if (!state.file || !state.model) return false;
  const file = state.file;
  let local: Model;
  try {
    // same core code as the server: invalid edits fail here without a round trip, and the result is shown
    // without downloading the whole model back
    local = applyOps(state.model, ops).model;
  } catch (e) {
    state.preview = null;
    status((e as Error).message, true);
    return false;
  }
  const expected = state.version + 1;
  commitsInFlight++;
  try {
    const info = await api<ModelInfo>("/api/apply", { file, ops, lean: true });
    if (state.file !== file) return true;
    if (info.version === expected) applyInfo(info, local);
    else applyInfo(await api<ModelInfo>(`/api/model?file=${encodeURIComponent(file)}`)); // someone else edited too
    status((what ?? info.log?.join("; ") ?? "edited") + (info.autosave ? " · saved" : ""));
    return true;
  } catch (e) {
    state.preview = null;
    status((e as Error).message, true);
    return false;
  } finally {
    commitsInFlight--;
    if (commitsInFlight === 0 && deferredEvent) {
      const msg = deferredEvent;
      deferredEvent = null;
      void handleEvent(file, msg);
    }
  }
}

async function undoRedo(kind: "undo" | "redo"): Promise<void> {
  if (!state.file) return;
  try {
    applyInfo(await api<ModelInfo>(`/api/${kind}`, { file: state.file }));
    status(kind === "undo" ? "undone" : "redone");
  } catch (e) {
    status((e as Error).message, true);
  }
}

// ---------- file commands (File menu)

const dirtyFiles = new Set<string>();

/** Header title, dirty dot, Save button and the conflict banner. */
/** What the open model is made for: "spine" or "live2d". */
function modelTarget(m: Model | null = state.model): "spine" | "live2d" {
  return m?.target === "live2d" ? "live2d" : "spine";
}

const TARGET_TABS = { spine: ["bones", "slots", "constraints", "skins", "events", "images"], live2d: ["slots", "params"], none: ["bones", "slots"] };

/** Shows the model's kind and hides what that kind does not have (CSS on body[data-target]). */
function applyTarget(): void {
  const t = state.file && state.model ? modelTarget() : "none";
  if (document.body.dataset.target !== t) {
    document.body.dataset.target = t;
    if (meshState.mode === "pose") $("hint").textContent = toolHint(state.tool);
  }
  const badge = $("target");
  badge.hidden = t === "none";
  badge.className = `target-badge ${t}`;
  badge.textContent = t === "live2d" ? "Live2D" : "Spine";
  badge.title =
    t === "live2d"
      ? "Live2D model: parameters, keyforms, deformers and parts (File › Export to Live2D)"
      : "Spine model: bones, weighted meshes, constraints, skins and timelines (File › Export to Spine)";
  // a tab the model does not have: go to one it has
  if (!TARGET_TABS[t].includes(state.tab)) state.tab = t === "live2d" ? "slots" : "bones";
  if (t === "live2d" && (meshState.mode === "weights" || state.tool === "bone")) {
    queueMicrotask(() => {
      if (meshState.mode === "weights") setMode("pose");
      if (state.tool === "bone") setTool("select");
    });
  }
}

function refreshFileState(): void {
  const name = state.file ?? "no file";
  document.title = `${state.dirty ? "● " : ""}${name.split("/").pop()} — Awaken2D`;
  if (state.file) {
    if (state.dirty) dirtyFiles.add(state.file);
    else dirtyFiles.delete(state.file);
  }
  $("file-name").textContent = state.file ?? "No model";
  applyTarget();
  $("file").title = `${state.file ?? "No model"}${state.dirty ? " (unsaved changes)" : ""} — click to open another model (Ctrl+O)`;
  $("dirty").hidden = !state.dirty;
  const save = $<HTMLButtonElement>("save");
  save.disabled = !state.file || (!state.dirty && !state.conflict);
  save.classList.toggle("attention", state.dirty);
  $<HTMLInputElement>("m-autosave").checked = state.autosave;
  $("banner").hidden = !state.conflict;
  for (const id of ["m-save", "m-save-as", "m-revert"]) $<HTMLButtonElement>(id).disabled = !state.file;
  $<HTMLButtonElement>("m-revert").disabled = !state.dirty;
  $<HTMLButtonElement>("m-undo").disabled = !state.canUndo;
  $<HTMLButtonElement>("m-redo").disabled = !state.canRedo;
  const selKind = state.sel?.kind;
  $<HTMLButtonElement>("m-rename").disabled = selKind !== "bone" && selKind !== "slot";
  $<HTMLButtonElement>("m-delete").disabled = !state.sel || selKind === "param";
}

/** Refreshes which files have unsaved working copies (marked in the Open dialog). */
async function refreshFileList(): Promise<void> {
  const { dirty } = await api<{ dirty: string[] }>("/api/files");
  dirtyFiles.clear();
  dirty.forEach((f) => dirtyFiles.add(f));
  refreshFileState();
}

/** Runs an action that would drop the view of the current file: offers to save unsaved edits first. */
async function leaveCurrent(): Promise<boolean> {
  if (!state.dirty || !state.file) return true;
  // other open documents keep their working copies on the server, so switching away loses nothing;
  // still, make the user aware that edits are pending
  const r = await dialog({
    title: "Unsaved changes",
    message: `${state.file} has unsaved changes. They stay in the editor's working copy until you save or revert.`,
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Keep unsaved", value: "keep" },
      { label: "Save", value: "save", primary: true },
    ],
  });
  if (!r) return false;
  if (r.button === "save") return await saveFile();
  return true;
}

async function switchTo(file: string): Promise<void> {
  if (file === state.file) return;
  if (!(await leaveCurrent())) return;
  await openFile(file);
  await refreshFileList();
}

async function saveFile(): Promise<boolean> {
  if (!state.file) return false;
  if (state.conflict) {
    const ok = await confirmDialog("Overwrite newer file?", `${state.file} was changed on disk after you started editing. Saving replaces that version with yours.`, "Overwrite", true);
    if (!ok) return false;
    await api<ModelInfo>("/api/resolve", { file: state.file, use: "mine" });
  }
  try {
    applyInfo(await api<ModelInfo>("/api/save", { file: state.file }));
    status(`saved ${state.file}`);
    return true;
  } catch (e) {
    await alertDialog("Save failed", (e as Error).message);
    return false;
  }
}

const RIG_EXT = /\.rig\.json$/;

async function saveFileAs(): Promise<void> {
  if (!state.file) return;
  const slashAt = state.file.lastIndexOf("/");
  const r = await dialog({
    title: "Save As",
    width: 500,
    fields: [
      { name: "folder", label: "Folder (in the project)", type: "path", value: slashAt > 0 ? state.file.slice(0, slashAt) : ".", browse: (cur) => pickPath({ title: "Save As: folder", mode: "folder", start: cur, key: "save-as" }) },
      { name: "name", label: "Name", value: state.file.slice(slashAt + 1).replace(RIG_EXT, ""), hint: "Saved as <name>.rig.json in that folder. Images stay where they are; their paths are rewritten for the new folder." },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Save", value: "ok", primary: true },
    ],
    validate: (x) => (plainName(x.values.name) ? null : "Enter a name"),
  });
  if (!r) return;
  const to = joinRel(await projectRel(String(r.values.folder)), `${plainName(r.values.name)}.rig.json`);
  if (to === state.file) return void saveFile();
  try {
    const info = await withOverwrite(to, (overwrite) => api<ModelInfo>("/api/save-as", { file: state.file, to, overwrite }));
    if (!info) return;
    await openFile(info.file);
    await refreshFileList();
    status(`saved as ${info.file}`);
  } catch (e) {
    await alertDialog("Save As failed", (e as Error).message);
  }
}

// ---------- paths picked in dialogs (never typed)

let projectRoot = "";
/** A picked path relative to the project folder when inside it (the server keeps models there), else as is. */
async function projectRel(path: string): Promise<string> {
  const p = path.replace(/\\/g, "/").replace(/\/$/, "");
  if (!/^([A-Za-z]:)?\//.test(p)) return p === "." ? "" : p;
  if (!projectRoot) projectRoot = (await api<{ root: string }>("/api/files")).root.replace(/\\/g, "/").replace(/\/$/, "");
  if (p.toLowerCase() === projectRoot.toLowerCase()) return "";
  return p.toLowerCase().startsWith(projectRoot.toLowerCase() + "/") ? p.slice(projectRoot.length + 1) : p;
}
const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** A file / folder name with path characters replaced, or "" when there is none. */
const plainName = (v: unknown) => String(v ?? "").trim().replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+$/, "");
/** The file name of a path without the given extensions. */
const baseName = (path: string, ...exts: RegExp[]) => exts.reduce((n, e) => n.replace(e, ""), path.replace(/\\/g, "/").split("/").pop() ?? "");
/** The folder of a picked file (the picker starts there next time). */
const folderOf = (path: string) => (path ? path.replace(/\/[^/]*$/, "") : undefined);

/** Deletes a model (and the images only it uses) after asking; they go to .awaken2d-trash/ in the project. */
async function deleteProject(file: string): Promise<boolean> {
  const unsaved = dirtyFiles.has(file) || (file === state.file && state.dirty);
  const ok = await confirmDialog(
    "Delete project?",
    `${file}${unsaved ? "\n\nIt has unsaved edits, which are lost." : ""}\n\nThe model file and the images no other model uses are moved to .awaken2d-trash/ in the project folder (restore them from there if needed).`,
    "Delete",
    true,
  );
  if (!ok) return false;
  try {
    const res = await api<{ moved: string[]; trash: string }>("/api/delete", { file, discard: true });
    dirtyFiles.delete(file);
    status(`deleted ${file} (${res.moved.length} file(s) moved to ${res.trash})`);
    if (file === state.file) {
      const { files } = await api<{ files: string[] }>("/api/files");
      if (files.length) await openFile(files[0]);
      else location.reload();
    }
    await refreshFileList();
    return true;
  } catch (e) {
    await alertDialog("Cannot delete", (e as Error).message);
    return false;
  }
}

async function openDialog(): Promise<void> {
  const { files, kinds } = await api<{ files: string[]; kinds?: Record<string, string> }>("/api/files");
  const r = await dialog({
    title: "Open Model",
    width: 460,
    fields: [
      {
        name: "file",
        label: "Models in this project (right-click for more)",
        type: "list",
        value: state.file ?? files[0],
        options: files.map((f) => [f, `${dirtyFiles.has(f) ? "● " : ""}${f}`, kinds?.[f] === "live2d" ? "Live2D" : kinds?.[f] === "spine" ? "Spine" : ""]),
        menu: (file) => [
          { label: "Open", run: () => void switchTo(file) },
          { label: "Delete project…", danger: true, run: () => deleteProject(file) },
        ],
      },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Open", value: "ok", primary: true },
    ],
  });
  if (r && r.values.file) await switchTo(String(r.values.file));
}

/** File › Import Spine: a Spine export (skeleton JSON + atlas) becomes a new model. */
async function spineImportDialog(): Promise<void> {
  if (!(await leaveCurrent())) return;
  const r = await dialog({
    title: "Import Spine",
    width: 520,
    fields: [
      {
        name: "source",
        label: "Spine skeleton (.json)",
        type: "path",
        placeholder: "Pick the skeleton .json exported from Spine",
        hint: "Spine 3.8 / 4.x JSON. The atlas (<name>.atlas or .atlas.txt) and its PNG are found next to it.",
        browse: (cur) => pickPath({ title: "Spine skeleton (.json)", mode: "file", exts: [".json"], start: folderOf(cur), key: "spine-import" }),
        onPick: (v, set) => set("name", plainName(baseName(v, /\.json$/i))),
      },
      {
        name: "atlas",
        label: "Atlas (optional)",
        type: "path",
        optional: true,
        placeholder: "found next to the skeleton",
        hint: "Only when the atlas has another name than the skeleton.",
        browse: (cur) => pickPath({ title: "Spine atlas", mode: "file", exts: [".atlas", ".txt"], start: folderOf(cur), key: "spine-import" }),
      },
      {
        name: "mesh",
        label: "Automatic meshes for region attachments",
        type: "checkbox",
        value: false,
        hint: "Regions become meshes traced around their art (density from size, shape and name), so they can bend and draw less empty space. Exported as meshes; off keeps them exactly as in Spine.",
      },
      { name: "name", label: "Model name", value: "", hint: "The new model is <folder>/<name>/<name>.rig.json, with its images beside it." },
      { name: "folder", label: "Folder (in the project)", type: "path", value: "spine", browse: (cur) => pickPath({ title: "Import into folder", mode: "folder", start: cur, key: "spine-models" }) },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Import", value: "ok", primary: true },
    ],
    validate: (x) => (!x.values.source ? "Pick the skeleton .json (Browse…)" : plainName(x.values.name) ? null : "Enter a model name"),
  });
  if (!r) return;
  const name = plainName(r.values.name);
  const file = joinRel(await projectRel(String(r.values.folder)), `${name}/${name}.rig.json`);
  status("importing Spine data…");
  try {
    const info = await withOverwrite(file, (overwrite) =>
      api<ModelInfo & { warnings?: string[]; log?: string[] }>("/api/spine-import", { source: String(r.values.source), atlas: String(r.values.atlas) || undefined, mesh: r.values.mesh === true ? "auto" : undefined, file, overwrite }),
    );
    if (!info) return status("import cancelled");
    await openFile(info.file);
    await refreshFileList();
    status(`imported ${info.file}: ${info.log?.[0] ?? ""}`);
    if (info.warnings?.length) await alertDialog("Imported with notes", info.warnings.join("\n"));
  } catch (e) {
    status("Spine import failed", true);
    await alertDialog("Spine import failed", (e as Error).message);
  }
}

/** File › Import Live2D: a Cubism Editor model (.cmo3: rig, physics, names, texture atlases) becomes a new model. */
async function live2dImportDialog(): Promise<void> {
  if (!(await leaveCurrent())) return;
  const r = await dialog({
    title: "Import Live2D",
    width: 520,
    fields: [
      {
        name: "source",
        label: "Cubism model (.cmo3)",
        type: "path",
        placeholder: "Pick the .cmo3",
        hint: "The model file Cubism Editor saves (runtime exports, .model3.json / .moc3, are not imported).",
        browse: (cur) => pickPath({ title: "Cubism model", mode: "file", exts: [".cmo3"], start: folderOf(cur), key: "live2d-import" }),
        onPick: (v, set) => set("name", plainName(baseName(v, /.cmo3$/i))),
      },
      { name: "name", label: "Model name", value: "", hint: "The new model is <folder>/<name>/<name>.rig.json; the textures are written to images/ beside it." },
      { name: "folder", label: "Folder (in the project)", type: "path", value: "live2d", browse: (cur) => pickPath({ title: "Import into folder", mode: "folder", start: cur, key: "live2d-models" }) },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Import", value: "ok", primary: true },
    ],
    validate: (x) => (!x.values.source ? "Pick the .cmo3 (Browse…)" : plainName(x.values.name) ? null : "Enter a model name"),
  });
  if (!r) return;
  const name = plainName(r.values.name);
  const file = joinRel(await projectRel(String(r.values.folder)), `${name}/${name}.rig.json`);
  status("importing Live2D model…");
  try {
    const info = await withOverwrite(file, (overwrite) =>
      api<ModelInfo & { warnings?: string[]; log?: string[] }>("/api/live2d-import", { source: String(r.values.source), file, overwrite }),
    );
    if (!info) return status("import cancelled");
    await openFile(info.file);
    await refreshFileList();
    status(`imported ${info.file}: ${info.log?.[0] ?? ""}`);
    if (info.warnings?.length) await alertDialog("Imported with notes", info.warnings.join("\n"));
  } catch (e) {
    status("Live2D import failed", true);
    await alertDialog("Live2D import failed", (e as Error).message);
  }
}

/** Export dialog fields: the destination folder (picked; anywhere) and the file name. */
const exportFields = (defaultOut: string, base: string, hint: string, key: string): Field[] => [
  { name: "out", label: "Folder", type: "path", value: defaultOut, hint, browse: (cur) => pickPath({ title: "Export to folder", mode: "folder", start: cur, key }) },
  { name: "name", label: "Name", value: base },
];

/** File › Export to Live2D: model3.json + moc3 + physics3 + cdi3 + motions + textures, from the working copy. */
async function live2dExportDialog(): Promise<void> {
  if (!state.file) return;
  const base = state.file.split("/").pop()!.replace(/\.rig\.json$/, "");
  const r = await dialog({
    title: "Export to Live2D",
    width: 520,
    fields: exportFields(`export/${base}-live2d`, base, "Writes <name>.model3.json, .moc3, .physics3.json, .cdi3.json, motion/ and textures into it. Open the model3.json in a Cubism viewer or SDK.", "live2d-export"),
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Export", value: "ok", primary: true },
    ],
    validate: (x) => (x.values.out && plainName(x.values.name) ? null : "Pick a folder and enter a name"),
  });
  if (!r) return;
  try {
    const res = await api<{ out: string; files: string[]; warnings: string[] }>("/api/live2d-export", { file: state.file, out: String(r.values.out), name: plainName(r.values.name) });
    status(`exported to ${res.out}: ${res.files.length} files`);
    await alertDialog("Exported to Live2D", [`${res.out}/`, ...res.files.slice(0, 12).map((f) => "  " + f), ...(res.files.length > 12 ? [`  … ${res.files.length - 12} more`] : []), ...(res.warnings.length ? ["", "Not exported:", ...res.warnings.map((w) => "• " + w)] : [])].join("\n"));
  } catch (e) {
    await alertDialog("Live2D export failed", (e as Error).message);
  }
}

/** File › Export to Spine: skeleton JSON + atlas + PNG + images folder, from the working copy. */
async function spineExportDialog(): Promise<void> {
  if (!state.file) return;
  const base = state.file.split("/").pop()!.replace(/\.rig\.json$/, "");
  const r = await dialog({
    title: "Export to Spine",
    width: 520,
    fields: exportFields(`export/${base}`, base, "Writes <name>.json, <name>.atlas, <name>.png and images/ into it. In Spine: Import Data, pick the .json (images come from images/).", "spine-export"),
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Export", value: "ok", primary: true },
    ],
    validate: (x) => (x.values.out && plainName(x.values.name) ? null : "Pick a folder and enter a name"),
  });
  if (!r) return;
  try {
    const res = await api<{ out: string; files: string[]; warnings: string[] }>("/api/spine-export", { file: state.file, out: String(r.values.out), name: plainName(r.values.name) });
    status(`exported to ${res.out}: ${res.files.join(", ")}`);
    await alertDialog("Exported to Spine", [`${res.out}/`, ...res.files.map((f) => "  " + f), ...(res.warnings.length ? ["", "Not exported:", ...res.warnings.map((w) => "• " + w)] : [])].join("\n"));
  } catch (e) {
    await alertDialog("Spine export failed", (e as Error).message);
  }
}

/** Calls `run`; when the target exists, asks before retrying with overwrite. Null when the user declines. */
async function withOverwrite<T>(file: string, run: (overwrite: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await run(false);
  } catch (e) {
    if (!/already exists/.test((e as Error).message)) throw e;
    if (!(await confirmDialog("Replace file?", `${file} already exists. Replace it? This cannot be undone.`, "Replace", true))) return null;
    return await run(true);
  }
}

async function revertFile(): Promise<void> {
  if (!state.file || !state.dirty) return;
  if (!(await confirmDialog("Revert to saved?", `Discard every unsaved change to ${state.file}? Undo can still bring them back.`, "Revert", true))) return;
  applyInfo(await api<ModelInfo>("/api/revert", { file: state.file }));
  status("reverted to the saved file");
}

async function setAutosave(on: boolean): Promise<void> {
  const r = await api<{ autosave: boolean }>("/api/settings", { autosave: on });
  state.autosave = r.autosave;
  if (on && state.dirty) await saveFile();
  status(on ? "auto-save on: every edit is written to disk" : "auto-save off: use File › Save (Ctrl+S)");
  refreshFileState();
}

async function resolveConflict(use: "disk" | "mine"): Promise<void> {
  if (!state.file) return;
  applyInfo(await api<ModelInfo>("/api/resolve", { file: state.file, use }));
  status(use === "disk" ? "loaded the version on disk" : "kept your edits; saving will overwrite the disk version");
}

const imageSrc = new Map<string, string>();
/** Loaded images and their decoded pixels (for re-meshing from the alpha channel). */
const images = new Map<string, HTMLImageElement>();
const imagePixels = new Map<string, { data: Uint8Array; width: number; height: number }>();
function pixelsOf(id: string): { data: Uint8Array; width: number; height: number } | null {
  const hit = imagePixels.get(id);
  if (hit) return hit;
  const img = images.get(id);
  if (!img?.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = { data: new Uint8Array(d.data.buffer), width: c.width, height: c.height };
  imagePixels.set(id, px);
  return px;
}
function loadImages(m: Model): void {
  for (const [id, ref] of Object.entries(m.images ?? {})) {
    const src = `/api/asset?file=${encodeURIComponent(state.file!)}&path=${encodeURIComponent(ref.path)}`;
    if (imageSrc.get(id) === src) continue; // already loaded (or loading)
    imageSrc.set(id, src);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      renderer.setImage(id, src, img);
      images.set(id, img);
      imagePixels.delete(id);
      requestDraw();
    };
    img.onerror = () => status(`image ${id} failed to load (${ref.path})`, true);
    img.src = src;
  }
}

function selectionExists(sel: NonNullable<Selection>): boolean {
  const m = state.model!;
  if (sel.kind === "bone") return m.bones.some((b) => b.id === sel.id);
  if (sel.kind === "slot") return m.slots.some((s) => s.id === sel.id);
  if (sel.kind === "ik") return !!m.ik?.some((c) => c.id === sel.id);
  if (sel.kind === "transform") return !!m.transforms?.some((c) => c.id === sel.id);
  if (sel.kind === "path") return !!m.paths?.some((c) => c.id === sel.id);
  if (sel.kind === "sphysics") return !!m.spinePhysics?.some((c) => c.id === sel.id);
  if (sel.kind === "slider") return !!m.sliders?.some((c) => c.id === sel.id);
  if (sel.kind === "skin") return !!m.skins?.[sel.id];
  if (sel.kind === "event") return !!m.events?.[sel.id];
  if (sel.kind === "image") return !!m.images?.[sel.id];
  if (sel.kind === "param") return !!m.parameters?.some((p) => p.id === sel.id);
  if (sel.kind === "glue") return !!m.live2d?.glue?.some((g) => g.id === sel.id);
  if (sel.kind === "part") return !!m.live2d?.parts.some((p) => p.id === sel.id);
  if (sel.kind === "deformer") return !!m.live2d?.deformers.some((d) => d.id === sel.id);
  return false;
}

// ---------- poses

/**
 * Spine physics outside playback (setup pose, paused, dragging bones): simulated live in real time like the Spine
 * editor, carrying on from where playback left it.
 */
let livePhysics: SpineState | null = null;
/** Seconds since the last frame (the live physics step). */
let frameDt = 0;
/** The viewport keeps drawing until then (ms) while live physics may still be moving. */
let physicsAwakeUntil = 0;
const hasLivePhysics = (m: Model | null) => !!m?.spinePhysics?.length && ov.physics.checked && meshState.mode === "pose" && !state.playing;

function currentPose(model: Model): Pose {
  // mesh/weight editing works on stored setup positions: no animation, IK, physics or parameters
  if (meshState.mode !== "pose") return model.live2d ? keyformPose(model) : (deformKeyPose(model) ?? setupPose(model));
  if (hasLivePhysics(model)) {
    livePhysics ??= (sim?.animation === state.anim ? sim?.spineState : null) ?? new SpineState();
    livePhysics.time += frameDt;
    return computePose(model, state.anim, state.anim ? state.time : 0, { constraints: ov.ik.checked, params: state.params, spine: { state: livePhysics, physics: "update" } });
  }
  livePhysics = null;
  const key = [model, state.anim, ov.ik.checked, ov.physics.checked, state.params];
  if (!sim || key.some((k, i) => k !== simKey[i])) {
    // one warm-up loop (instead of two) halves the pause when switching to a long animation
    const opts = { constraints: ov.ik.checked, physics: ov.physics.checked, params: state.params, warmupLoops: 1 };
    // only the model changed (an edit or a drag preview): continue the physics where it is. A fresh
    // simulation settles and warms up every loop first, which is far too slow to do on every edit.
    const onlyModel = sim && key.slice(1).every((k, i) => k === simKey[i + 1]);
    sim = onlyModel ? sim!.rebase(model, opts) : new PoseSimulator(model, state.anim, opts);
    simKey = key;
  }
  return sim.at(state.anim ? state.time : 0);
}

function setupPose(model: Model): Pose {
  if (setupCache?.model !== model) setupCache = { model, pose: computePose(model) };
  return setupCache.pose;
}

// ---------- Live2D keyform editing: meshes are shaped at the pinned parameter values (defaults otherwise)

let keyformCache: { model: Model; params: Record<string, number>; values: Record<string, number>; pose: Pose } | null = null;
/** Parameter values keyforms are edited at: the defaults with the pinned sliders. */
function keyformValues(m: Model): Record<string, number> {
  if (keyformCache?.model !== m || keyformCache.params !== state.params) {
    const values = { ...Object.fromEntries((m.parameters ?? []).map((p) => [p.id, p.default])), ...state.params };
    keyformCache = { model: m, params: state.params, values, pose: computePose(m, null, 0, { params: values }) };
  }
  return keyformCache.values;
}
function keyformPose(m: Model): Pose {
  keyformValues(m);
  return keyformCache!.pose;
}
const isLive2D = (m: Model, att: MeshAttachment | undefined) => !!(att?.live2d && m.live2d);
/** Where a mesh's vertices are edited: Live2D meshes as shaped at the pinned values, others at their setup positions. */
function editPoints(m: Model, id: string, att: MeshAttachment): Vec2[] {
  if (isLive2D(m, att)) return restVertices(m, id, att, keyformValues(m));
  const dk = deformKeyPose(m);
  return dk ? poseRestVertices(m, dk, id, att) : att.vertices;
}

/**
 * Spine models in Mesh mode with an animation open: the setup pose with the animation's deform keys at the playhead.
 * Dragging vertices then keys the deform there (like Spine's Animate mode); without an animation it edits the mesh.
 */
function deformKeyPose(m: Model): Pose | null {
  if (meshState.mode !== "mesh" || modelTarget(m) !== "spine" || !state.anim || !m.animations?.[state.anim]) return null;
  return { ...setupPose(m), animation: state.anim, time: localT() };
}
/** The keyform grid point of a Live2D object at the pinned values, restricted to the parameters it is keyed on. */
function keyformAt(m: Model, params: string[]): Record<string, number> {
  const v = keyformValues(m);
  return Object.fromEntries(params.map((p) => [p, v[p]]));
}

// ---------- view transforms

const size = () => ({ w: viewportEl.clientWidth, h: viewportEl.clientHeight });
function toScreen(p: Vec2): Vec2 {
  const { w, h: hh } = size();
  return [(p[0] - state.view.cx) * state.view.zoom + w / 2, hh / 2 - (p[1] - state.view.cy) * state.view.zoom];
}
function toWorld(x: number, y: number): Vec2 {
  const { w, h: hh } = size();
  return [(x - w / 2) / state.view.zoom + state.view.cx, (hh / 2 - y) / state.view.zoom + state.view.cy];
}

function fitView(): void {
  const m = shown();
  if (!m) return;
  const pose = currentPose(m);
  const items = drawList(m, pose, setupPose(m));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Vec2) => {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  };
  items.forEach((it) => it.positions.forEach(add));
  pose.bones.forEach((b) => add([b.world[4], b.world[5]]));
  if (!Number.isFinite(minX)) return;
  const { w, h: hh } = size();
  state.view.cx = (minX + maxX) / 2;
  state.view.cy = (minY + maxY) / 2;
  state.view.zoom = Math.min(w / Math.max(maxX - minX, 1), hh / Math.max(maxY - minY, 1)) * 0.85;
}

// ---------- frame loop

let lastFrame = performance.now();
let fpsSmooth = 60;
let fpsTick = 0;
/** Ops previewed on the next frame (pointer events can fire far more often than frames). */
let pendingPreview: { base: Model; ops: Op[] } | null = null;
function schedulePreview(base: Model, ops: Op[] | null): void {
  pendingPreview = ops ? { base, ops } : null;
  if (!ops) state.preview = null;
  requestDraw();
}

let drawRequested = true;
let lastDrawKey: unknown[] = [];
let lastDrawAt = 0;
/** Marks the viewport for redrawing (input and state changes call this). */
function requestDraw(): void {
  drawRequested = true;
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (pendingPreview) {
    const p = pendingPreview;
    pendingPreview = null;
    try {
      state.preview = applyOps(p.base, p.ops).model;
    } catch (err) {
      status((err as Error).message, true);
    }
  }
  const m = shown();
  const a = animDef();
  // idle (nothing playing, no input, nothing changed): skip the whole frame. Big models stay cheap at rest.
  const drawKey = [m, state.time, state.anim, state.view.cx, state.view.cy, state.view.zoom, state.sel, state.params, meshState.mode, state.tool];
  const changed = drawKey.some((k, i) => k !== lastDrawKey[i]);
  // live Spine physics keeps moving a few seconds after the last change (then it has settled)
  if (hasLivePhysics(m) && (changed || drawRequested)) physicsAwakeUntil = now + 4000;
  const physicsAwake = hasLivePhysics(m) && now < physicsAwakeUntil;
  frameDt = dt;
  if (!state.playing && !drawRequested && !changed && !physicsAwake && now - lastDrawAt < 1000) {
    if (Math.round(now / 500) !== fpsTick) {
      fpsTick = Math.round(now / 500);
      $("fps-meter").textContent = "idle";
    }
    wasPlaying = false;
    return;
  }
  drawRequested = false;
  lastDrawKey = drawKey;
  lastDrawAt = now;
  if (state.playing && a) {
    const started = !wasPlaying;
    // keys at the playhead fire on the first frame; sounds load then (and are cached for the next events)
    if (started && m && !eventAudio.muted) for (const p of animationSounds(m, a)) eventAudio.preload(p);
    const from = localTime(a, state.time) - (started ? 1e-6 : 0);
    state.time += dt * state.speed;
    if (a.loop === false && state.time >= a.duration) {
      state.time = a.duration;
      state.playing = false;
      updatePlayButton();
    }
    const to = localTime(a, state.time);
    if (m) eventAudio.fire(m, a, from, to, to < from);
  }
  wasPlaying = state.playing && !!a;
  const { w, h: hh } = size();
  const dpr = window.devicePixelRatio || 1;
  if (m) {
    try {
      lastPose = currentPose(m);
      lastItems = drawList(m, lastPose, setupPose(m));
    } catch (e) {
      status(`cannot pose model: ${(e as Error).message}`, true);
      lastPose = null;
      lastItems = [];
    }
  }
  renderer.render(m?.live2d && !l2dShow.drawables ? [] : shownItems(), state.view, w, hh, dpr, [0.165, 0.176, 0.2]);
  drawOverlay(w, hh, dpr);
  drawBox(overlay.getContext("2d")!);
  timeline.draw();
  syncParamRows();
  const lt = localT();
  $("time").textContent = a ? `${lt.toFixed(3)} s · frame ${Math.round(lt * timeline.fps)} / ${Math.round(a.duration * timeline.fps)}` : "setup pose";
  $("zoom").textContent = `${Math.round(state.view.zoom * 100)}%`;
  fpsSmooth = fpsSmooth * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
  if (Math.round(now / 500) !== fpsTick) {
    fpsTick = Math.round(now / 500);
    $("fps-meter").textContent = `${Math.round(fpsSmooth)} fps`;
  }
}

/** Live2D deformers (warp lattices green, rotation deformers red) and glue, as posed; the selected deformer always. */
function drawLive2DGuides(ctx: CanvasRenderingContext2D, m: Model): void {
  const selDef = state.sel?.kind === "deformer" ? state.sel.id : null;
  const selPart = state.sel?.kind === "part" ? state.sel.id : null;
  // glue: every glue (View › Glue), or the glue of the selected art mesh / glue row
  const selSlot = state.sel?.kind === "slot" ? m.slots.find((s) => s.id === state.sel!.id)?.attachment : null;
  const glueShown = (gl: { id: string; a: string; b: string }) => l2dShow.drawables && (l2dShow.glue || gl.id === selGlue || gl.a === selSlot || gl.b === selSlot);
  const anyGlue = (m.live2d?.glue ?? []).some(glueShown);
  if (!l2dShow.warp && !l2dShow.rotation && !anyGlue && !selDef && !selPart) return;
  if (!lastPose) return;
  const values = lastPose.params ?? Object.fromEntries((m.parameters ?? []).map((p) => [p.id, p.default]));
  const g = live2dGuides(m, live2dFrame(m, values));
  const inPart = new Set(selPart ? m.live2d!.deformers.filter((d) => d.part === selPart).map((d) => d.id) : []);
  for (const w of g.warps) {
    const sel = w.id === selDef || inPart.has(w.id);
    if (!sel && (!l2dShow.warp || w.hidden)) continue;
    const pts = w.points.map((p) => toScreen(p));
    const at = (i: number, j: number) => pts[j * (w.cols + 1) + i];
    ctx.strokeStyle = sel ? "rgba(110,235,140,1)" : "rgba(63,185,108,0.6)";
    ctx.lineWidth = sel ? 1.5 : 1;
    ctx.beginPath();
    for (let j = 0; j <= w.rows; j++) for (let i = 0; i < w.cols; i++) (ctx.moveTo(...at(i, j)), ctx.lineTo(...at(i + 1, j)));
    for (let i = 0; i <= w.cols; i++) for (let j = 0; j < w.rows; j++) (ctx.moveTo(...at(i, j)), ctx.lineTo(...at(i, j + 1)));
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    const r = sel ? 2.5 : 1.5;
    for (const p of pts) ctx.fillRect(p[0] - r, p[1] - r, r * 2, r * 2);
    if (w.id === selDef && meshState.mode === "pose" && latticeSel.warp === w.id) {
      ctx.fillStyle = "#ffffff";
      for (const i of latticeSel.pts) if (pts[i]) ctx.fillRect(pts[i][0] - 4, pts[i][1] - 4, 8, 8);
    }
  }
  for (const rd of g.rotations) {
    const sel = rd.id === selDef || inPart.has(rd.id);
    if (!sel && (!l2dShow.rotation || rd.hidden)) continue;
    const [x, y] = toScreen(rd.origin);
    ctx.strokeStyle = sel ? "rgba(255,120,110,1)" : "rgba(229,83,75,0.75)";
    ctx.lineWidth = sel ? 2 : 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.moveTo(x, y);
    ctx.lineTo(x + rd.up[0] * 30, y - rd.up[1] * 30);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (anyGlue) {
    ctx.strokeStyle = "rgba(230,80,180,0.85)";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1;
    for (const gl of g.glue) {
      if (!glueShown(gl)) continue;
      ctx.beginPath();
      for (const [a, b] of gl.lines) {
        const pa = toScreen(a);
        const pb = toScreen(b);
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.rect(pa[0] - 1.5, pa[1] - 1.5, 3, 3);
        ctx.rect(pb[0] - 1.5, pb[1] - 1.5, 3, 3);
      }
      ctx.stroke();
    }
  }
}

/** Deformation paths of the selected Live2D art mesh (curve, control points; draggable in Mesh mode). */
function drawMeshPaths(ctx: CanvasRenderingContext2D, m: Model): void {
  if (!l2dShow.drawables) return;
  const active = activeMesh();
  if (ov.mesh.checked) {
    // every art mesh's paths, as posed (the selected mesh is drawn below, editable)
    for (const it of shownItems()) {
      if (it.attachmentId === active?.id) continue;
      for (const p of it.attachment.live2d?.paths ?? []) drawPath(ctx, p, pathPoints(p, it.positions), false, -1);
    }
  }
  const paths = active && isLive2D(m, active.att) ? active.att.live2d!.paths : undefined;
  if (!active || !paths?.length || editDrag?.kind === "path") return drawDraggedPath(ctx);
  const verts = editPoints(m, active.id, active.att);
  const editing = meshState.mode === "mesh" && !meshState.l2dReshape;
  paths.forEach((p, k) => drawPath(ctx, p, pathPoints(p, verts), editing, meshState.pathHover?.path === k ? meshState.pathHover.point : -1));
}
function drawDraggedPath(ctx: CanvasRenderingContext2D): void {
  if (editDrag?.kind !== "path") return;
  drawPath(ctx, editDrag.path, editDrag.ctrl, true, editDrag.point);
}
function drawPath(ctx: CanvasRenderingContext2D, p: Live2DPath, ctrl: Vec2[], editing: boolean, hot: number): void {
  const line = pathPolyline(p, ctrl).map((q) => toScreen(q));
  ctx.lineWidth = editing ? 2 : 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath();
  line.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
  ctx.stroke();
  ctx.lineWidth = editing ? 1.5 : 1;
  ctx.strokeStyle = "rgba(255,170,60,0.95)";
  ctx.stroke();
  ctrl.forEach((q, i) => {
    const [x, y] = toScreen(q);
    const r = !editing ? 2.5 : i === hot ? 6 : 4.5;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath();
    ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = i === hot ? "#ffffff" : "rgba(255,170,60,1)";
    ctx.beginPath();
    if (p.points[i]?.corner) ctx.rect(x - r, y - r, r * 2, r * 2);
    else ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  });
}
/** The deformation path control point under a screen point (the selected mesh's, in Mesh mode). */
function pathPointAt(x: number, y: number): { path: number; point: number } | null {
  const m = state.model;
  const active = activeMesh();
  const paths = m && active && isLive2D(m, active.att) ? active.att.live2d!.paths : undefined;
  if (!m || !active || !paths?.length || meshState.l2dReshape || l2dShow.lock || !l2dShow.drawables) return null;
  const verts = editPoints(m, active.id, active.att);
  let best: { path: number; point: number } | null = null;
  let bestD = 9;
  paths.forEach((p, k) =>
    pathPoints(p, verts).forEach((q, i) => {
      const s = toScreen(q);
      const d = Math.hypot(s[0] - x, s[1] - y);
      if (d < bestD) {
        bestD = d;
        best = { path: k, point: i };
      }
    }),
  );
  return best;
}

const BONE_COLORS = ["#e5534b", "#4ea1ff", "#3fb96c", "#e0a43a", "#a371f7", "#26b5b5", "#e04ab8", "#9aa4ae"];

function drawOverlay(w: number, hh: number, dpr: number): void {
  if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(hh * dpr)) {
    overlay.width = Math.round(w * dpr);
    overlay.height = Math.round(hh * dpr);
  }
  const ctx = overlay.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  const m = shown();
  if (!m || !lastPose) return;

  // grid + origin
  const step = gridStep();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  const [x0, y1] = toWorld(0, 0);
  const [x1, y0] = toWorld(w, hh);
  ctx.beginPath();
  for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
    const [sx] = toScreen([x, 0]);
    ctx.moveTo(Math.round(sx) + 0.5, 0);
    ctx.lineTo(Math.round(sx) + 0.5, hh);
  }
  for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
    const [, sy] = toScreen([0, y]);
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(w, Math.round(sy) + 0.5);
  }
  ctx.stroke();
  const [ox, oy] = toScreen([0, 0]);
  ctx.strokeStyle = "rgba(229,83,75,0.6)";
  ctx.beginPath();
  ctx.moveTo(ox - 14, oy);
  ctx.lineTo(ox + 14, oy);
  ctx.stroke();
  ctx.strokeStyle = "rgba(63,185,108,0.6)";
  ctx.beginPath();
  ctx.moveTo(ox, oy - 14);
  ctx.lineTo(ox, oy + 14);
  ctx.stroke();

  const selSlot = state.sel?.kind === "slot" ? state.sel.id : null;
  if (ov.mesh.checked || selSlot) {
    for (const it of lastItems) {
      if (!ov.mesh.checked && it.slot !== selSlot) continue;
      ctx.strokeStyle = it.slot === selSlot ? "rgba(78,161,255,0.9)" : "rgba(0,0,0,0.35)";
      ctx.beginPath();
      for (const [a, b, c] of it.attachment.triangles) {
        const pa = toScreen(it.positions[a]);
        const pb = toScreen(it.positions[b]);
        const pc = toScreen(it.positions[c]);
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.lineTo(pc[0], pc[1]);
        ctx.closePath();
      }
      ctx.stroke();
    }
  }

  if (m.live2d) drawLive2DGuides(ctx, m);
  if (m.live2d) drawMeshPaths(ctx, m);

  const physicsBones = new Set((m.spinePhysics ?? []).map((c) => c.bone));
  const selBone = state.sel?.kind === "bone" ? state.sel.id : null;
  const selBones = new Set(selectedBones());
  const selIk = state.sel?.kind === "ik" ? m.ik?.find((c) => c.id === state.sel!.id) : undefined;
  const selPhys = state.sel?.kind === "sphysics" ? m.spinePhysics?.find((c) => c.id === state.sel!.id) : undefined;
  const highlighted = new Set([...(selIk ? [...selIk.bones, selIk.target] : []), ...(selPhys ? [selPhys.bone] : [])]);
  if ((ov.bones.checked || ov.names.checked) && modelTarget() !== "live2d") {
    const boneColors = new Map(m.bones.map((bone, i) => [bone.id, bone.color ?? BONE_COLORS[i % BONE_COLORS.length]]));
    const boneIcons = new Map(m.bones.map((bone) => [bone.id, bone.icon]));
    const customBoneColors = new Set(m.bones.filter((bone) => bone.color).map((bone) => bone.id));
    lastPose.bones.forEach((b, i) => {
      const e = boneEnds(b);
      const s = toScreen(e.start);
      const t = toScreen(e.end);
      const color = boneColors.get(b.id) ?? BONE_COLORS[i % BONE_COLORS.length];
      const selected = selBones.has(b.id) || highlighted.has(b.id);
      if (ov.bones.checked) {
        if (b.length > 0) {
          ctx.lineCap = "round";
          ctx.strokeStyle = "rgba(0,0,0,0.55)";
          ctx.lineWidth = selected ? 7 : 5;
          ctx.beginPath();
          ctx.moveTo(s[0], s[1]);
          ctx.lineTo(t[0], t[1]);
          ctx.stroke();
          ctx.strokeStyle = selected && !customBoneColors.has(b.id) ? "#ffffff" : color;
          ctx.lineWidth = selected ? 4 : 2.5;
          ctx.setLineDash(physicsBones.has(b.id) ? [5, 4] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const icon = boneIcons.get(b.id);
        if (icon) {
          drawBoneIcon(ctx, icon, s[0], s[1], selected ? 18 : 15, selected && !customBoneColors.has(b.id) ? "#ffffff" : color);
        } else {
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.beginPath();
          ctx.arc(s[0], s[1], selected ? 6 : 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = selected && !customBoneColors.has(b.id) ? "#ffffff" : color;
          ctx.beginPath();
          ctx.arc(s[0], s[1], selected ? 4.5 : 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (ov.names.checked || selected) {
        const mx = b.length > 0 ? (s[0] + t[0]) / 2 : s[0];
        const my = b.length > 0 ? (s[1] + t[1]) / 2 : s[1];
        ctx.font = "11px system-ui, sans-serif";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.strokeText(b.id, mx + 7, my - 5);
        ctx.fillStyle = selected ? "#ffffff" : color;
        ctx.fillText(b.id, mx + 7, my - 5);
      }
    });
  }
  if (meshState.mode !== "pose") {
    drawEditOverlay(ctx);
    if (meshState.mode === "mesh") return;
  }
  try {
    drawIkTargets(ctx, m);
    if (lastPose && ov.ik.checked) drawPaths(ctx, m, lastPose, toScreen, state.sel?.kind === "path" ? state.sel.id : null);
    if (ov.ik.checked) drawClippings(ctx, lastItems, toScreen);
    if (lastPose && ov.ik.checked && m.boundingBoxes) drawBoundingBoxes(ctx, boundingBoxPolygons(m, lastPose, setupPose(m)), toScreen, state.sel?.kind === "slot" ? state.sel.id : null);
  } finally {
    if (meshState.mode === "pose") drawTools(ctx);
  }
}

function drawIkTargets(ctx: CanvasRenderingContext2D, m: Model): void {
  if (!lastPose) return;
  const selBone = state.sel?.kind === "bone" ? state.sel.id : null;
  const selIk = state.sel?.kind === "ik" ? m.ik?.find((c) => c.id === state.sel!.id) : undefined;
  if (ov.ik.checked) {
    for (const c of m.ik ?? []) {
      const target = lastPose.byId.get(c.target);
      const last = lastPose.byId.get(c.bones[c.bones.length - 1]);
      if (!target || !last) continue;
      const g = toScreen([target.world[4], target.world[5]]);
      const tip = toScreen(boneEnds(last).end);
      const sel = selIk === c || selBone === c.target;
      ctx.strokeStyle = sel ? "#ffffff" : "#e04ab8";
      ctx.lineWidth = sel ? 3 : 2;
      if (Math.hypot(g[0] - tip[0], g[1] - tip[1]) > 2) {
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(tip[0], tip[1]);
        ctx.lineTo(g[0], g[1]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.moveTo(g[0] - 7, g[1] - 7);
      ctx.lineTo(g[0] + 7, g[1] + 7);
      ctx.moveTo(g[0] - 7, g[1] + 7);
      ctx.lineTo(g[0] + 7, g[1] - 7);
      ctx.stroke();
    }
  }
}

function gridStep(): number {
  const target = 60 / state.view.zoom;
  const p = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= target) ?? p * 10;
}

// ---------- viewport interaction

type Drag =
  | { kind: "pan"; x: number; y: number; cx: number; cy: number }
  | { kind: "rotate" | "move"; bone: string; startWorld: Vec2; startPose: BonePose; parentWorld: number[]; base: Model; angle: number; last: number; op?: Op }
  | { kind: "gizmo"; handle: Handle; target: GizmoTarget; spec: GizmoSpec; parents: Record<string, number[]>; start: Vec2; base: Model; acc: number; last: number; op?: Op; ops?: Op[]; readout: string }
  | { kind: "newBone"; start: Vec2; end: Vec2 }
  | { kind: "lattice"; base: Model; id: string; start: Vec2; pts: number[]; op?: Op }
  | { kind: "rotOrigin"; base: Model; id: string; start: Vec2; origin: Vec2; op?: Op }
  | { kind: "rotAngle"; base: Model; id: string; center: Vec2; angle0: number; sign: number; acc: number; last: number; op?: Op }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; mode: "set" | "add" | "remove"; target: "bones" | "verts" | "lattice" };

type GizmoTarget =
  | { kind: "bone"; id: string }
  | { kind: "slot"; id: string; att: string; pivot: Vec2 }
  | { kind: "warp"; id: string; pivot: Vec2; pts: Array<[number, Vec2]> }
  | { kind: "rotation"; id: string; pivot: Vec2; angle0: number; scale0: number; sign: number };

// ---------- Live2D deformers in the viewport: warp lattice points and rotation deformers of the selected deformer,
// edited in the keyform at the pinned slider values (setKeyform)

/** Glue picked in the parts tree (drawn in the viewport; glue is not a selection kind). */
let selGlue: string | null = null;
/** Selected lattice points of the selected warp deformer. */
const latticeSel = { warp: "", pts: new Set<number>() };
let deformerGuideCache: { m: Model; key: string; guides: ReturnType<typeof live2dGuides> } | null = null;
/** Deformer guides (world) at the pinned slider values, cached per model version and values. */
function pinnedGuides(m: Model): ReturnType<typeof live2dGuides> {
  const values = keyformValues(m);
  const key = JSON.stringify(values);
  if (deformerGuideCache?.m !== m || deformerGuideCache.key !== key) deformerGuideCache = { m, key, guides: live2dGuides(m, live2dFrame(m, values)) };
  return deformerGuideCache.guides;
}
function selectedDeformer(m: Model): Deformer | null {
  if (meshState.mode !== "pose" || state.sel?.kind !== "deformer" || !m.live2d) return null;
  const d = m.live2d.deformers.find((x) => x.id === state.sel!.id) ?? null;
  if (d && latticeSel.warp !== d.id) {
    latticeSel.warp = d.id;
    latticeSel.pts.clear();
  }
  return d;
}
/** The keyform of a deformer at the pinned values (null with a status note when the sliders sit between keys). */
function pinnedDeformerForm(m: Model, d: Deformer): number | null {
  try {
    return gridIndexAt(m, d.grid, keyformAt(m, d.grid.params), d.id);
  } catch (e) {
    status((e as Error).message, true);
    return null;
  }
}
/** World-space turn direction of a rotation deformer's angle: -1 (canvas space is y-down), flipped by reflections. */
function rotationSign(m: Model, d: Deformer): number {
  let flips = 0;
  for (let x: Deformer | undefined = d, n = 0; x && n < 64; x = m.live2d!.deformers.find((y) => y.id === x!.parent), n++) {
    if (x.type !== "rotation") continue;
    const f = x.forms[0];
    if (f?.reflectX) flips++;
    if (f?.reflectY) flips++;
  }
  return flips % 2 ? 1 : -1;
}
/** Length of a rotation deformer's handle on screen (as drawn by drawLive2DGuides). */
const ROT_HANDLE = 30;
/** Pointer down on the selected deformer's handles (pose mode). Returns true when it started a drag / selection. */
function deformerPointerDown(e: PointerEvent, m: Model): boolean {
  const d = l2dShow.deflock ? null : selectedDeformer(m);
  if (!d) return false;
  const g = pinnedGuides(m);
  const at: Vec2 = [e.offsetX, e.offsetY];
  if (d.type === "warp") {
    const w = g.warps.find((x) => x.id === d.id);
    if (!w) return false;
    let hit = -1;
    let best = 8;
    w.points.forEach((p, i) => {
      const s = toScreen(p);
      const dd = Math.hypot(s[0] - at[0], s[1] - at[1]);
      if (dd < best) {
        best = dd;
        hit = i;
      }
    });
    if (hit >= 0) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (latticeSel.pts.has(hit)) latticeSel.pts.delete(hit);
        else latticeSel.pts.add(hit);
        requestDraw();
        return true;
      }
      if (!latticeSel.pts.has(hit)) latticeSel.pts = new Set([hit]);
      requestDraw();
      if (pinnedDeformerForm(m, d) === null) return true;
      drag = { kind: "lattice", base: m, id: d.id, start: toWorld(at[0], at[1]), pts: [...latticeSel.pts] };
      status(latticeSel.pts.size + " lattice point(s) of " + d.id + ": drag to shape the keyform");
      return true;
    }
    if (state.tool === "select") {
      drag = { kind: "box", x0: at[0], y0: at[1], x1: at[0], y1: at[1], mode: e.shiftKey ? "add" : e.ctrlKey || e.metaKey || e.altKey ? "remove" : "set", target: "lattice" };
      return true;
    }
    return false;
  }
  const r = g.rotations.find((x) => x.id === d.id);
  if (!r) return false;
  const o = toScreen(r.origin);
  const tip: Vec2 = [o[0] + r.up[0] * ROT_HANDLE, o[1] - r.up[1] * ROT_HANDLE];
  const onTip = Math.hypot(tip[0] - at[0], tip[1] - at[1]) < 8;
  const onOrigin = Math.hypot(o[0] - at[0], o[1] - at[1]) < 11;
  if (!onTip && !onOrigin) return false;
  const k = pinnedDeformerForm(m, d);
  if (k === null) return true;
  if (onTip) {
    const a = screenAngle(o[0], o[1], at[0], at[1]);
    drag = { kind: "rotAngle", base: m, id: d.id, center: o, angle0: (d.forms[k] as RotationKeyform).angle, sign: rotationSign(m, d), acc: 0, last: a };
  } else drag = { kind: "rotOrigin", base: m, id: d.id, start: toWorld(at[0], at[1]), origin: r.origin };
  return true;
}
/**
 * The deformer whose lattice point or rotation centre is under a screen point: among the drawn guides, or among every
 * visible deformer while drawable objects are locked (Cubism's Shift+A). Locked deformers are skipped.
 */
function pickDeformer(m: Model, x: number, y: number): string | null {
  if (l2dShow.deflock) return null;
  const any = l2dShow.lock;
  if (!any && !l2dShow.warp && !l2dShow.rotation) return null;
  const g = pinnedGuides(m);
  const locked = (id: string) => {
    const d = m.live2d!.deformers.find((q) => q.id === id);
    if (!d || d.locked) return true;
    for (let p = d.part, n = 0; p && n < 64; n++) {
      const part = m.live2d!.parts.find((q) => q.id === p);
      if (!part) break;
      if (part.locked) return true;
      p = part.parent;
    }
    return false;
  };
  let best: string | null = null;
  let bestD = 7;
  const consider = (id: string, p: Vec2, r: number) => {
    const s = toScreen(p);
    const dd = Math.hypot(s[0] - x, s[1] - y);
    if (dd < Math.max(bestD, r) && !locked(id)) {
      bestD = dd;
      best = id;
    }
  };
  for (const r of g.rotations) if (!r.hidden && (any || l2dShow.rotation)) consider(r.id, r.origin, 10);
  for (const w of g.warps) if (!w.hidden && (any || l2dShow.warp)) for (const p of w.points) consider(w.id, p, 7);
  return best;
}

/** Pointer move for the deformer drags; true when handled. */
function deformerPointerMove(e: PointerEvent): boolean {
  if (!drag || (drag.kind !== "lattice" && drag.kind !== "rotOrigin" && drag.kind !== "rotAngle")) return false;
  const d = drag;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const def = d.base.live2d!.deformers.find((x) => x.id === d.id)!;
  const at = keyformAt(d.base, def.grid.params);
  if (d.kind === "lattice") {
    const w = toWorld(e.offsetX, e.offsetY);
    let dx = w[0] - d.start[0];
    let dy = w[1] - d.start[1];
    if (e.shiftKey) {
      dx = Math.round(dx / 5) * 5;
      dy = Math.round(dy / 5) * 5;
    }
    d.op = { op: "setKeyform", target: d.id, at, offsets: d.pts.map((i) => [i, r2(dx), r2(dy)] as [number, number, number]) };
  } else if (d.kind === "rotOrigin") {
    const w = toWorld(e.offsetX, e.offsetY);
    d.op = { op: "setKeyform", target: d.id, at, origin: [r2(d.origin[0] + w[0] - d.start[0]), r2(d.origin[1] + w[1] - d.start[1])] };
  } else {
    const a = screenAngle(d.center[0], d.center[1], e.offsetX, e.offsetY);
    d.acc += wrapDeg(a - d.last);
    d.last = a;
    const rot = e.shiftKey ? Math.round(d.acc / 15) * 15 : d.acc;
    d.op = { op: "setKeyform", target: d.id, at, angle: Math.round((d.angle0 + d.sign * rot) * 1000) / 1000 };
    status(d.id + ": " + (rot >= 0 ? "+" : "") + rot.toFixed(1) + "°");
  }
  try {
    schedulePreview(d.base, [d.op]);
  } catch (err) {
    status((err as Error).message, true);
  }
  return true;
}

let drag: Drag | null = null;
let hotHandle: Handle | null = null;
let pointer: Vec2 = [0, 0];

/** Viewport hints for Live2D models (no bones: the tools shape the selected art mesh's keyform). */
const LIVE2D_HINTS: Partial<Record<Tool, string>> = {
  select:
    "Click an art mesh to select it; drag empty space to pan, wheel zooms. Pin parameter sliders (Params) to pick the keyform to edit. A selected warp deformer: drag its lattice points (Shift adds, drag empty space to box-select); a rotation deformer: drag its centre to move it, the handle end to turn it.",
  move: "Move (W): moves the selected art mesh, warp lattice points or rotation deformer in the keyform at the pinned slider values. Shift snaps to 5 units.",
  rotate: "Rotate (E): rotates the selected art mesh, warp lattice points or rotation deformer in the keyform at the pinned slider values. Shift snaps to 15°.",
  scale: "Scale (R): scales the selected art mesh, warp lattice points or rotation deformer in the keyform at the pinned slider values.",
};
const toolHint = (tool: Tool) => (modelTarget() === "live2d" ? (LIVE2D_HINTS[tool] ?? TOOL_HINTS[tool]) : TOOL_HINTS[tool]);

const TOOL_HINTS: Record<Tool, string> = {
  select: "Drag a bone to rotate, its joint to move. Drag empty space to box-select bones (Shift adds, Ctrl removes). Right-drag pans, wheel zooms.",
  move: "Move (W): drag the arrows or the square. Shift snaps to 5 units. Works on bones, and on slot meshes in Setup.",
  rotate: "Rotate (E): drag the ring. Shift snaps to 15°.",
  scale: "Scale (R): drag the axis handles, or the centre dot for uniform scale. Shift snaps to 0.1.",
  bone: "Create bone (B): drag from the joint to the tip. The new bone is parented to the selected bone.",
};

const CARRY_KEY = "awaken2d.carry";
const COMP_BONES_KEY = "awaken2d.compBones";
/**
 * Spine's compensation toggles (Setup only). Image compensation on = the art stays put when a bone moves (the
 * bone is re-fitted to it); off = meshes follow their bones (`carry`). Bone compensation on = child bones stay put.
 */
function setCompensation(images: boolean, bones: boolean): void {
  state.carry = !images;
  state.compBones = bones;
  const img = $("comp-images");
  img.classList.toggle("active", images);
  img.title = images
    ? "Image compensation on: moving a bone in Setup leaves the images / meshes in place (re-fit the skeleton to the art). Click to turn off (T)"
    : "Image compensation off: moving a bone in Setup moves its images / meshes. Click to leave them in place (T)";
  const bn = $("comp-bones");
  bn.classList.toggle("active", bones);
  bn.title = bones
    ? "Bone compensation on: moving a bone in Setup leaves its child bones in place. Click to turn off (Shift+T)"
    : "Bone compensation off: child bones follow their parent in Setup. Click to leave them in place (Shift+T)";
  try {
    localStorage.setItem(CARRY_KEY, state.carry ? "1" : "0");
    localStorage.setItem(COMP_BONES_KEY, bones ? "1" : "0");
  } catch {
    /* not persisted */
  }
}

function setTool(tool: Tool): void {
  state.tool = tool;
  if (meshState.mode !== "pose") setMode("pose");
  document.querySelectorAll<HTMLButtonElement>("#tools button[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  $("hint").textContent = toolHint(tool);
}

/** Where the transform gizmo sits for the current selection and tool (null: no gizmo). */
function gizmoTarget(): { target: GizmoTarget; spec: GizmoSpec } | null {
  const m = shown();
  const tool = state.tool;
  if (!m || !lastPose || meshState.mode !== "pose" || tool === "select" || tool === "bone" || !state.sel) return null;
  if (state.sel.kind === "bone") {
    const bp = lastPose.byId.get(state.sel.id);
    if (!bp) return null;
    const [x, y] = toScreen([bp.world[4], bp.world[5]]);
    return { target: { kind: "bone", id: bp.id }, spec: { tool, x, y, angle: Math.atan2(-bp.world[1], bp.world[0]) } };
  }
  if (state.sel.kind === "slot") {
    const slot = m.slots.find((s) => s.id === state.sel!.id);
    const att = slot?.attachment ? m.attachments[slot.attachment] : undefined;
    if (!slot || !att) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [vx, vy] of editPoints(m, slot.attachment!, att)) {
      minX = Math.min(minX, vx);
      maxX = Math.max(maxX, vx);
      minY = Math.min(minY, vy);
      maxY = Math.max(maxY, vy);
    }
    const pivot: Vec2 = [(minX + maxX) / 2, (minY + maxY) / 2];
    const [x, y] = toScreen(pivot);
    return { target: { kind: "slot", id: slot.id, att: slot.attachment!, pivot }, spec: { tool, x, y, angle: 0 } };
  }
  const d = l2dShow.deflock ? null : selectedDeformer(m);
  if (d?.type === "warp") {
    const w = pinnedGuides(m).warps.find((x) => x.id === d.id);
    if (!w) return null;
    const idx = latticeSel.pts.size ? [...latticeSel.pts].filter((i) => i < w.points.length) : w.points.map((_, i) => i);
    const pts = idx.map((i) => [i, w.points[i]] as [number, Vec2]);
    const xs = pts.map(([, p]) => p[0]);
    const ys = pts.map(([, p]) => p[1]);
    const pivot: Vec2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const [x, y] = toScreen(pivot);
    return { target: { kind: "warp", id: d.id, pivot, pts }, spec: { tool, x, y, angle: 0 } };
  }
  if (d?.type === "rotation") {
    const r = pinnedGuides(m).rotations.find((x) => x.id === d.id);
    if (!r) return null;
    let k = 0;
    try {
      k = gridIndexAt(m, d.grid, keyformAt(m, d.grid.params), d.id);
    } catch {
      return null;
    }
    const f = d.forms[k] as RotationKeyform;
    const [x, y] = toScreen(r.origin);
    return { target: { kind: "rotation", id: d.id, pivot: r.origin, angle0: f.angle, scale0: f.scale, sign: rotationSign(m, d) }, spec: { tool, x, y, angle: Math.atan2(r.up[0], r.up[1]) } };
  }
  return null;
}

function pick(x: number, y: number): { bone?: string; mode?: "rotate" | "move"; slot?: string } {
  const m = shown();
  if (!m || !lastPose) return {};
  if (ov.ik.checked) {
    for (const c of m.ik ?? []) {
      const t = lastPose.byId.get(c.target);
      if (t && Math.hypot(...sub(toScreen([t.world[4], t.world[5]]), [x, y])) < 10) return { bone: c.target, mode: "move" };
    }
  }
  if (ov.bones.checked && modelTarget() !== "live2d") {
    for (const b of [...lastPose.bones].reverse()) {
      const e = boneEnds(b);
      const s = toScreen(e.start);
      if (Math.hypot(s[0] - x, s[1] - y) < 8) return { bone: b.id, mode: b.length > 0 && b.parent !== null ? "rotate" : "move" };
    }
    for (const b of [...lastPose.bones].reverse()) {
      if (b.length <= 0) continue;
      const e = boneEnds(b);
      if (segDist([x, y], toScreen(e.start), toScreen(e.end)) < 6) return { bone: b.id, mode: "rotate" };
    }
  }
  const w = toWorld(x, y);
  for (const it of [...shownItems()].reverse()) {
    if (it.color[3] < 0.02) continue; // fully transparent (e.g. Live2D hit areas): not pickable
    if (m.live2d && (l2dShow.lock || !l2dShow.drawables || l2dLocked(m, it.attachmentId))) continue;
    for (const [a, b, c] of it.attachment.triangles) {
      if (inTri(w, it.positions[a], it.positions[b], it.positions[c])) return { slot: it.slot };
    }
  }
  return {};
}

/** Same rule as the core ops (Spine-compatible names): no control characters, quotes, backslashes, edge spaces. */
const ID_RE = /^(?! )[^\u0000-\u001f"\\]+(?<! )$/u;
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const d = sub(b, a);
  const l2 = d[0] * d[0] + d[1] * d[1];
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * d[0]), p[1] - (a[1] + t * d[1]));
}
function inTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const s = (u: Vec2, v: Vec2) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const d1 = s(a, b);
  const d2 = s(b, c);
  const d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Screen-space angle in degrees, CCW positive (matches the model's +y up convention). */
const screenAngle = (cx: number, cy: number, x: number, y: number) => Math.atan2(-(y - cy), x - cx) * (180 / Math.PI);

overlay.addEventListener("pointerdown", (e) => {
  try {
    overlay.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic events (automation) have no capturable pointer */
  }
  const m = state.model;
  if (!m || !lastPose) return;
  if (editPointerDown(e)) return;
  if (e.button !== 0) {
    drag = { kind: "pan", x: e.offsetX, y: e.offsetY, cx: state.view.cx, cy: state.view.cy };
    return;
  }
  const g = gizmoTarget();
  let handle = g ? hitGizmo(g.spec, e.offsetX, e.offsetY) : null;
  // Live2D (like Cubism): with Move, dragging the selected art mesh itself moves it
  if (g && !handle && g.target.kind === "slot" && state.tool === "move" && modelTarget(m) === "live2d" && pick(e.offsetX, e.offsetY).slot === g.target.id) handle = "moveFree";
  if (g && handle) {
    if (g.target.kind === "slot" && state.anim) {
      status("slot meshes are transformed in Setup: pick Setup in the animation list (animate slots through their bones)", true);
      return;
    }
    // every selected bone moves together; each needs its parent's world transform from the drag start
    const parents: Record<string, number[]> = {};
    for (const id of g.target.kind === "bone" ? topSelectedBones(m) : []) {
      const bp = lastPose.byId.get(id);
      if (bp) parents[id] = bp.parent ? [...lastPose.byId.get(bp.parent)!.world] : [1, 0, 0, 1, 0, 0];
    }
    const a = screenAngle(g.spec.x, g.spec.y, e.offsetX, e.offsetY);
    drag = { kind: "gizmo", handle, target: g.target, spec: g.spec, parents, start: [e.offsetX, e.offsetY], base: m, acc: 0, last: a, readout: "" };
    return;
  }
  if (state.tool === "bone") {
    const w = toWorld(e.offsetX, e.offsetY);
    drag = { kind: "newBone", start: w, end: w };
    return;
  }
  if (deformerPointerDown(e, m)) return;
  const def = m.live2d ? pickDeformer(m, e.offsetX, e.offsetY) : null;
  if (def) {
    select({ kind: "deformer", id: def });
    return;
  }
  const hit = pick(e.offsetX, e.offsetY);
  if (hit.bone && (e.shiftKey || e.ctrlKey || e.metaKey)) {
    // toggle the bone in the selection
    const has = selectedBones().includes(hit.bone);
    if (has && state.sel?.kind === "bone" && state.sel.id === hit.bone) {
      const next = [...multi][0];
      multi.delete(next);
      select(next ? { kind: "bone", id: next } : null, true);
    } else if (has) {
      multi.delete(hit.bone);
      refreshPanels();
    } else if (state.sel?.kind === "bone") {
      multi.add(hit.bone);
      refreshPanels();
    } else select({ kind: "bone", id: hit.bone });
    return;
  }
  if (hit.bone && hit.mode) {
    // clicking a bone that is part of a multi-selection keeps the others
    const keep = selectedBones().includes(hit.bone) && state.tool !== "select";
    if (keep && state.sel?.kind === "bone" && state.sel.id !== hit.bone) multi.add(state.sel.id);
    if (keep) multi.delete(hit.bone);
    select({ kind: "bone", id: hit.bone }, keep);
    if (state.tool !== "select") return; // transform tools: the click selects, the gizmo edits
    const ik = ov.ik.checked ? m.ik?.find((c) => c.bones.includes(hit.bone!) && c.mix > 0) : undefined;
    if (ik) status(`${hit.bone} is driven by IK "${ik.id}": drag its target (magenta X) or untick IK to edit the rotation directly`);
    const sim = ov.physics.checked ? m.spinePhysics?.find((c) => c.bone === hit.bone) : undefined;
    if (sim) status(`${hit.bone} is moved by physics "${sim.id}": your edit sets where it rests; physics adds the swing`);
    const bp = lastPose.byId.get(hit.bone)!;
    const origin = toScreen([bp.world[4], bp.world[5]]);
    const parent = bp.parent ? lastPose.byId.get(bp.parent)!.world : [1, 0, 0, 1, 0, 0];
    const angle = screenAngle(origin[0], origin[1], e.offsetX, e.offsetY);
    drag = { kind: hit.mode, bone: hit.bone, startWorld: toWorld(e.offsetX, e.offsetY), startPose: { ...bp }, parentWorld: [...parent], base: m, angle: 0, last: angle };
    return;
  }
  // empty space (or art): box selection; a click without dragging selects the part under the pointer
  drag = { kind: "box", x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, mode: e.shiftKey ? "add" : e.ctrlKey || e.metaKey || e.altKey ? "remove" : "set", target: "bones" };
});

overlay.addEventListener("pointermove", (e) => {
  pointer = [e.offsetX, e.offsetY];
  if (editPointerMove(e)) return;
  if (!drag) {
    const g = gizmoTarget();
    hotHandle = g ? hitGizmo(g.spec, e.offsetX, e.offsetY) : null;
    if (hotHandle) {
      overlay.style.cursor = hotHandle === "rotate" ? "grab" : hotHandle.startsWith("move") ? "move" : "nwse-resize";
      return;
    }
    if (state.tool === "bone") {
      overlay.style.cursor = "crosshair";
      return;
    }
    const hit = pick(e.offsetX, e.offsetY);
    overlay.style.cursor =
      state.tool !== "select"
        ? hit.bone || hit.slot
          ? "pointer"
          : "default"
        : hit.mode === "rotate"
          ? "crosshair"
          : hit.mode === "move"
            ? "move"
            : hit.slot
              ? "pointer"
              : "default";
    return;
  }
  if (drag.kind === "pan") {
    state.view.cx = drag.cx - (e.offsetX - drag.x) / state.view.zoom;
    state.view.cy = drag.cy + (e.offsetY - drag.y) / state.view.zoom;
    return;
  }
  if (drag.kind === "box") {
    drag.x1 = e.offsetX;
    drag.y1 = e.offsetY;
    return;
  }
  if (drag.kind === "newBone") {
    drag.end = toWorld(e.offsetX, e.offsetY);
    if (e.shiftKey) {
      // snap the direction to 15°
      const d = sub(drag.end, drag.start);
      const len = Math.hypot(d[0], d[1]);
      const a = Math.round(Math.atan2(d[1], d[0]) / (Math.PI / 12)) * (Math.PI / 12);
      drag.end = [drag.start[0] + Math.cos(a) * len, drag.start[1] + Math.sin(a) * len];
    }
    return;
  }
  if (drag.kind === "lattice" || drag.kind === "rotOrigin" || drag.kind === "rotAngle") return void deformerPointerMove(e);
  if (drag.kind === "gizmo") {
    gizmoDrag(drag, e.offsetX, e.offsetY, e.shiftKey);
    schedulePreview(drag.base, drag.ops ?? (drag.op ? [drag.op] : null));
    return;
  } else {
    const bp = drag.startPose;
    const parentDet = drag.parentWorld[0] * drag.parentWorld[3] - drag.parentWorld[1] * drag.parentWorld[2];
    if (drag.kind === "rotate") {
      const origin = toScreen([bp.world[4], bp.world[5]]);
      const a = screenAngle(origin[0], origin[1], e.offsetX, e.offsetY);
      drag.angle += wrapDeg(a - drag.last);
      drag.last = a;
      const local = drag.angle * (parentDet < 0 ? -1 : 1);
      drag.op = boneEdit(drag.base, drag.bone, "rotate", local);
    } else {
      const w = toWorld(e.offsetX, e.offsetY);
      const inv = invert(drag.parentWorld as [number, number, number, number, number, number]);
      const p0 = apply(inv, drag.startWorld[0], drag.startWorld[1]);
      const p1 = apply(inv, w[0], w[1]);
      drag.op = boneEdit(drag.base, drag.bone, "translate", [p1[0] - p0[0], p1[1] - p0[1]]);
    }
  }
  try {
    schedulePreview(drag.base, drag.op ? [drag.op] : null);
  } catch (err) {
    status((err as Error).message, true);
  }
});

/** Turns the pointer position into the op for a gizmo drag (bone rest pose / keys, or slot mesh vertices). */
function gizmoDrag(d: Extract<Drag, { kind: "gizmo" }>, x: number, y: number, snap: boolean): void {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const { spec, handle, target } = d;
  let move: Vec2 = [0, 0];
  let rot = 0;
  let scale: Vec2 = [1, 1];
  if (handle.startsWith("move")) {
    const a = toWorld(d.start[0], d.start[1]);
    const b = toWorld(x, y);
    move = [handle === "moveY" ? 0 : b[0] - a[0], handle === "moveX" ? 0 : b[1] - a[1]];
    if (snap) move = [Math.round(move[0] / 5) * 5, Math.round(move[1] / 5) * 5];
    d.readout = `Δ ${move[0].toFixed(1)}, ${move[1].toFixed(1)}`;
  } else if (handle === "rotate") {
    const a = screenAngle(spec.x, spec.y, x, y);
    d.acc += wrapDeg(a - d.last);
    d.last = a;
    rot = snap ? Math.round(d.acc / 15) * 15 : d.acc;
    d.readout = `${rot >= 0 ? "+" : ""}${rot.toFixed(1)}°`;
  } else {
    const ax: Vec2 = [Math.cos(spec.angle), Math.sin(spec.angle)];
    const ay: Vec2 = [Math.sin(spec.angle), -Math.cos(spec.angle)];
    const ratio = (axis: Vec2) => {
      const s0 = (d.start[0] - spec.x) * axis[0] + (d.start[1] - spec.y) * axis[1];
      const s1 = (x - spec.x) * axis[0] + (y - spec.y) * axis[1];
      return Math.abs(s0) > 4 ? s1 / s0 : 1 + (s1 - s0) / GIZMO_SIZE;
    };
    let f =
      handle === "scaleUniform"
        ? Math.max(0.01, 1 + (x - d.start[0] - (y - d.start[1])) / (GIZMO_SIZE * 1.5))
        : handle === "scaleX"
          ? ratio(ax)
          : ratio(ay);
    if (snap) f = Math.round(f * 10) / 10 || 0.1;
    scale = handle === "scaleX" ? [f, 1] : handle === "scaleY" ? [1, f] : [f, f];
    d.readout = handle === "scaleUniform" ? `× ${f.toFixed(2)}` : `${handle === "scaleX" ? "x" : "y"} × ${f.toFixed(2)}`;
  }
  if (target.kind === "bone") {
    d.ops = Object.entries(d.parents).map(([id, pw]) => {
      if (handle.startsWith("move")) {
        // world delta -> parent-local delta (linear part only)
        const inv = invert([pw[0], pw[1], pw[2], pw[3], 0, 0]);
        return boneEdit(d.base, id, "translate", apply(inv, move[0], move[1]));
      }
      if (handle === "rotate") return boneEdit(d.base, id, "rotate", rot * (pw[0] * pw[3] - pw[1] * pw[2] < 0 ? -1 : 1));
      return boneEdit(d.base, id, "scale", scale);
    });
    if (d.ops.length > 1) d.readout += ` · ${d.ops.length} bones`;
    return;
  }
  if (target.kind === "warp" || target.kind === "rotation") {
    const def = d.base.live2d!.deformers.find((x) => x.id === target.id)!;
    const at = keyformAt(d.base, def.grid.params);
    if (target.kind === "warp") {
      const [px, py] = target.pivot;
      const c = Math.cos((rot * Math.PI) / 180);
      const s = Math.sin((rot * Math.PI) / 180);
      const offsets = target.pts.map(([i, [vx, vy]]) => {
        const lx = (vx - px) * scale[0];
        const ly = (vy - py) * scale[1];
        return [i, r2(px + lx * c - ly * s + move[0] - vx), r2(py + lx * s + ly * c + move[1] - vy)] as [number, number, number];
      });
      d.op = { op: "setKeyform", target: target.id, at, offsets };
    } else if (handle.startsWith("move")) d.op = { op: "setKeyform", target: target.id, at, origin: [r2(target.pivot[0] + move[0]), r2(target.pivot[1] + move[1])] };
    else if (handle === "rotate") d.op = { op: "setKeyform", target: target.id, at, angle: Math.round((target.angle0 + target.sign * rot) * 1000) / 1000 };
    else d.op = { op: "setKeyform", target: target.id, at, scale: Math.max(1e-6, target.scale0 * Math.sqrt(Math.abs(scale[0] * scale[1]))) };
    return;
  }
  // slot: transform the mesh's setup vertices about the pivot (the texture moves with them)
  const att = d.base.attachments[target.att];
  const [px, py] = target.pivot;
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  if (isLive2D(d.base, att)) {
    // Live2D: the keyform at the pinned parameter values
    const pts = editPoints(d.base, target.att, att);
    const offsets = pts.map(([vx, vy], i) => {
      const lx = (vx - px) * scale[0];
      const ly = (vy - py) * scale[1];
      return [i, r2(px + lx * c - ly * s + move[0] - vx), r2(py + lx * s + ly * c + move[1] - vy)] as [number, number, number];
    });
    d.op = { op: "setKeyform", target: target.att, at: keyformAt(d.base, att.live2d!.grid.params), offsets };
    return;
  }
  const moves = att.vertices.map(([vx, vy], i) => {
    const lx = (vx - px) * scale[0];
    const ly = (vy - py) * scale[1];
    return [i, r2(px + lx * c - ly * s + move[0]), r2(py + lx * s + ly * c + move[1])] as [number, number, number];
  });
  d.op = { op: "moveVertices", attachment: target.att, moves, keepImage: false };
}

overlay.addEventListener("pointerup", () => {
  if (editPointerUp()) return;
  const d = drag;
  drag = null;
  if (!d || d.kind === "pan") return;
  if (d.kind === "newBone") return void finishNewBone(d.start, d.end);
  if (d.kind === "box") return finishBox(d);
  if (d.kind === "gizmo" && d.ops?.length) return void commit(d.ops);
  if (d.op) void commit([d.op]);
});

/** Box selection: bones whose joint (or midpoint) lies inside, or mesh vertices in Mesh mode. */
function finishBox(d: Extract<Drag, { kind: "box" }>): void {
  const x0 = Math.min(d.x0, d.x1);
  const x1 = Math.max(d.x0, d.x1);
  const y0 = Math.min(d.y0, d.y1);
  const y1 = Math.max(d.y0, d.y1);
  const inside = (p: Vec2) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const click = x1 - x0 < 4 && y1 - y0 < 4;
  if (d.target === "lattice") {
    const m = state.model;
    const def = m && selectedDeformer(m);
    if (!m || !def) return;
    if (click) {
      // a plain click off the lattice: select what is under the pointer (or nothing)
      if (d.mode !== "set") return;
      latticeSel.pts.clear();
      const hit = pick(d.x0, d.y0);
      return select(hit.slot ? { kind: "slot", id: hit.slot } : null);
    }
    const w = pinnedGuides(m).warps.find((x) => x.id === def.id);
    const found = (w?.points ?? []).map((p, i) => (inside(toScreen(p)) ? i : -1)).filter((i) => i >= 0);
    if (d.mode === "set") latticeSel.pts = new Set(found);
    else if (d.mode === "add") found.forEach((i) => latticeSel.pts.add(i));
    else found.forEach((i) => latticeSel.pts.delete(i));
    status(latticeSel.pts.size + " lattice point(s) selected");
    return requestDraw();
  }
  if (d.target === "verts") {
    const active = activeMesh();
    if (click) {
      const hit = pick(d.x0, d.y0);
      if (hit.slot && hit.slot !== active?.slot) {
        select({ kind: "slot", id: hit.slot });
        meshState.verts.clear();
      } else if (d.mode === "set") meshState.verts.clear();
      return refreshProps();
    }
    if (!active) return;
    const found = editPoints(state.model!, active.id, active.att).map((v, i) => (inside(toScreen(v)) ? i : -1)).filter((i) => i >= 0);
    if (d.mode === "set") meshState.verts = new Set(found);
    else if (d.mode === "add") found.forEach((i) => meshState.verts.add(i));
    else found.forEach((i) => meshState.verts.delete(i));
    status(`${meshState.verts.size} vertices selected`);
    return refreshProps();
  }
  if (click) {
    const hit = pick(d.x0, d.y0);
    if (d.mode !== "set") return;
    return select(hit.slot ? { kind: "slot", id: hit.slot } : null);
  }
  if (!lastPose || !ov.bones.checked) return;
  const found = lastPose.bones
    .filter((b) => {
      const e = boneEnds(b);
      return inside(toScreen(e.start)) || (b.length > 0 && inside(toScreen([(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2])));
    })
    .map((b) => b.id);
  let all = d.mode === "set" ? found : d.mode === "add" ? [...new Set([...selectedBones(), ...found])] : selectedBones().filter((id) => !found.includes(id));
  if (!all.length) return select(null);
  const primary = state.sel?.kind === "bone" && all.includes(state.sel.id) ? state.sel.id : all[0];
  all = all.filter((id) => id !== primary);
  multi.clear();
  all.forEach((id) => multi.add(id));
  select({ kind: "bone", id: primary }, true);
  status(`${all.length + 1} bone${all.length ? "s" : ""} selected`);
}

/** Dashed selection rectangle while box-selecting. */
function drawBox(ctx: CanvasRenderingContext2D): void {
  if (drag?.kind !== "box") return;
  const x = Math.min(drag.x0, drag.x1);
  const y = Math.min(drag.y0, drag.y1);
  const w = Math.abs(drag.x1 - drag.x0);
  const h2 = Math.abs(drag.y1 - drag.y0);
  if (w < 3 && h2 < 3) return;
  ctx.save();
  ctx.fillStyle = drag.mode === "remove" ? "rgba(229,83,75,0.08)" : "rgba(78,161,255,0.1)";
  ctx.fillRect(x, y, w, h2);
  ctx.strokeStyle = drag.mode === "remove" ? "#e5534b" : "#4ea1ff";
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h2);
  ctx.restore();
}

async function finishNewBone(start: Vec2, end: Vec2): Promise<void> {
  const m = state.model;
  if (!m) return;
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) * state.view.zoom < 6) return status("drag farther to create a bone (from joint to tip)");
  // meshes the new bone lies on (setup pose), front-most first: offered for binding
  const on = bonesMeshes(m, start, end);
  const parent = state.sel?.kind === "bone" ? state.sel.id : (on[0] ? m.slots.find((sl) => sl.id === on[0].slot)!.bone : m.bones.find((b) => b.parent === null)?.id);
  let n = m.bones.length;
  while (m.bones.some((b) => b.id === `bone${n}`)) n++;
  newBonePreview = { start, end };
  const r = await dialog({
    title: "New Bone",
    message: on.length ? "Bound meshes are re-weighted automatically between their bones and the new one (Weights mode fine-tunes it; Ctrl+Z undoes)." : undefined,
    fields: [
      { name: "id", label: "Name", value: `bone${n}` },
      { name: "parent", label: "Parent", type: "select", value: parent ?? "", options: m.bones.map((b) => [b.id, b.id]) },
      ...on.map((c, i) => ({
        name: `bind:${c.slot}`,
        label: `Bind ${c.slot} (${c.vertices} vertices${c.vertices <= 4 ? ": too few to bend" : ""})`,
        type: "checkbox" as const,
        value: i === 0,
      })),
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Create", value: "ok", primary: true },
    ],
    validate: (x) => {
      const id = String(x.values.id).trim();
      if (!ID_RE.test(id)) return "Names cannot contain quotes or backslashes, or start/end with a space";
      return m.bones.some((b) => b.id === id) ? `A bone named "${id}" already exists` : null;
    },
  });
  newBonePreview = null;
  if (!r) return;
  const id = String(r.values.id).trim();
  const round = (p: Vec2): Vec2 => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
  const bind = on.filter((c) => r.values[`bind:${c.slot}`] === true);
  const ops: Op[] = [
    { op: "addBone", id, parent: String(r.values.parent) || undefined, start: round(start), end: round(end) },
    ...bind.map((c) => ({ op: "autoWeight", attachment: c.attachment, bones: [...c.bones, id] }) as Op),
  ];
  const ok = await commit(ops, `added bone ${id}${bind.length ? ` bound to ${bind.map((c) => c.slot).join(", ")}` : ""}`);
  if (state.model?.bones.some((b) => b.id === id)) select({ kind: "bone", id });
  const flat = bind.filter((c) => c.vertices <= 4);
  if (ok && flat.length) status(`${flat.map((c) => c.slot).join(", ")}: only 4 vertices, so it moves but cannot bend. Add vertices first: Mesh mode (2) › Regenerate from image, then rebind in Weights mode (3).`, true);
  else if (ok && !on.length) status(`added ${id}: it lies on no mesh, so nothing follows it yet (bind meshes in Weights mode, 3)`);
}

/** Visible, non-Live2D meshes a bone from start to end lies on (setup pose), front-most first, with their current bones. */
function bonesMeshes(m: Model, start: Vec2, end: Vec2): Array<{ slot: string; attachment: string; vertices: number; bones: string[] }> {
  const probes: Vec2[] = [start, [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2], end];
  const out: Array<{ slot: string; attachment: string; vertices: number; bones: string[] }> = [];
  for (const sl of [...m.slots].reverse()) {
    const att = sl.attachment ? m.attachments[sl.attachment] : undefined;
    if (!att || att.type !== "mesh" || att.live2d || out.some((c) => c.attachment === sl.attachment)) continue;
    const v = att.vertices;
    const hit = probes.some((p) => att.triangles.some(([a, b, c]) => inTri(p, v[a], v[b], v[c])));
    if (!hit) continue;
    const bones = new Set<string>();
    for (const w of att.weights) for (const [b, x] of w ?? []) if (x > 0) bones.add(b);
    if (!bones.size) bones.add(sl.bone);
    out.push({ slot: sl.id, attachment: sl.attachment!, vertices: v.length, bones: [...bones] });
  }
  return out;
}

/** Bone being created: drawn while dragging and while the name dialog is open. */
let newBonePreview: { start: Vec2; end: Vec2 } | null = null;

/** Gizmo, bone-creation preview and drag readout, drawn last. */
function drawTools(ctx: CanvasRenderingContext2D): void {
  const nb = drag?.kind === "newBone" ? drag : newBonePreview;
  if (nb) {
    const s = toScreen(nb.start);
    const t = toScreen(nb.end);
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    ctx.lineTo(t[0], t[1]);
    ctx.stroke();
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.arc(s[0], s[1], 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const len = Math.hypot(nb.end[0] - nb.start[0], nb.end[1] - nb.start[1]);
    const ang = (Math.atan2(nb.end[1] - nb.start[1], nb.end[0] - nb.start[0]) * 180) / Math.PI;
    if (drag?.kind === "newBone") drawReadout(ctx, pointer[0], pointer[1], `length ${len.toFixed(1)} · ${ang.toFixed(1)}°`);
  }
  const active = drag?.kind === "gizmo" ? drag : null;
  const g = active ? { spec: active.spec } : gizmoTarget();
  if (g) {
    // while dragging, the gizmo follows the previewed pose
    const live = active ? gizmoTarget() : null;
    drawGizmo(ctx, live?.spec ?? g.spec, hotHandle, active?.handle ?? null);
  }
  if (active?.readout) drawReadout(ctx, pointer[0], pointer[1], active.readout);
}

overlay.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const before = toWorld(e.offsetX, e.offsetY);
    state.view.zoom *= Math.exp(-e.deltaY * 0.0015);
    state.view.zoom = Math.max(0.02, Math.min(200, state.view.zoom));
    const after = toWorld(e.offsetX, e.offsetY);
    state.view.cx += before[0] - after[0];
    state.view.cy += before[1] - after[1];
  },
  { passive: false },
);

/**
 * Builds the op for a drag: in setup mode it edits the bone's rest transform; in an animation it keys the
 * bone at the current time (on top of whatever the animation already does there).
 */
function boneEdit(m: Model, id: string, channel: "rotate" | "translate" | "scale", delta: number | Vec2): Op {
  const bone = m.bones.find((b) => b.id === id)!;
  const r = (n: number) => Math.round(n * 100) / 100;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const lerpV = (a: Vec2, b: Vec2, f: number): Vec2 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  if (!state.anim) {
    if (channel === "scale") {
      const k = delta as Vec2;
      return { op: "updateBone", id, scaleX: r3(bone.scaleX * k[0]), scaleY: r3(bone.scaleY * k[1]), carry: state.carry, compensate: state.compBones };
    }
    if (channel === "rotate") return { op: "updateBone", id, rotation: r(bone.rotation + (delta as number)), carry: state.carry, compensate: state.compBones };
    const d = delta as Vec2;
    return { op: "updateBone", id, x: r(bone.x + d[0]), y: r(bone.y + d[1]), carry: state.carry, compensate: state.compBones };
  }
  const t = localT();
  const tl = m.animations?.[state.anim]?.bones?.[id];
  if (channel === "rotate") {
    const cur = sampleTrack(tl?.rotate, t, (a, b, f) => a + (b - a) * f) ?? 0;
    return { op: "setKeys", animation: state.anim, bone: id, channel: "rotate", keys: [{ t, v: r(cur + (delta as number)) }], mode: "merge" };
  }
  if (channel === "scale") {
    const cur = sampleTrack(tl?.scale, t, lerpV) ?? [1, 1];
    const k = delta as Vec2;
    return { op: "setKeys", animation: state.anim, bone: id, channel: "scale", keys: [{ t, v: [r3(cur[0] * k[0]), r3(cur[1] * k[1])] }], mode: "merge" };
  }
  const cur = sampleTrack(tl?.translate, t, lerpV) ?? [0, 0];
  const d = delta as Vec2;
  return { op: "setKeys", animation: state.anim, bone: id, channel: "translate", keys: [{ t, v: [r(cur[0] + d[0]), r(cur[1] + d[1])] }], mode: "merge" };
}

// ---------- panels

/** Bones selected in addition to the primary selection (box select, Shift+click). */
const multi = new Set<string>();
/** Every selected bone: the primary one first. */
function selectedBones(): string[] {
  const primary = state.sel?.kind === "bone" ? [state.sel.id] : [];
  return [...primary, ...[...multi].filter((id) => !primary.includes(id))];
}
/** Selected bones without those whose ancestor is also selected (moving both would move the child twice). */
function topSelectedBones(m: Model): string[] {
  const set = new Set(selectedBones());
  const parent = new Map(m.bones.map((b) => [b.id, b.parent]));
  return [...set].filter((id) => {
    for (let p = parent.get(id); p; p = parent.get(p)) if (set.has(p)) return false;
    return true;
  });
}

/** The Live2D art mesh of the selected slot (Params rows show its keys), if any. */
function selectedLive2DMesh(m: Model): { id: string; att: MeshAttachment } | null {
  if (state.sel?.kind !== "slot" || !m.live2d) return null;
  const sel = state.sel.id;
  const id = m.slots.find((sl) => sl.id === sel)?.attachment;
  const att = id ? m.attachments[id] : undefined;
  return id && att?.live2d ? { id, att } : null;
}

/** Keys a Live2D object on a parameter at min, default and max (Cubism's "Add 3 keys"), keeping keys it has. */
async function addThreeKeys(m: Model, target: string, param: string): Promise<boolean> {
  const p = m.parameters?.find((x) => x.id === param);
  if (!p) return false;
  const grid = m.attachments[target]?.live2d?.grid ?? m.live2d?.deformers.find((d) => d.id === target)?.grid ?? m.live2d?.parts.find((x) => x.id === target)?.grid ?? m.live2d?.glue?.find((x) => x.id === target)?.grid;
  const i = grid?.params.indexOf(param) ?? -1;
  const had = i >= 0 ? grid!.keys[i] : [];
  const keys = [...new Set([...had, p.min, p.default, p.max])].sort((a, b) => a - b);
  return commit([{ op: "setKeyformKeys", target, param, keys } as Op]);
}

/** The slot selected last (the parameter panel offers to key its mesh). */
let lastSlotSel: string | null = null;

let spineTreeActiveRow: { file: string | null; key: string | null } = { file: null, key: null };
function select(sel: Selection, keepMulti = false, treeRow?: string): void {
  if (!keepMulti) multi.clear();
  selGlue = sel?.kind === "glue" ? sel.id : null;
  // an unapplied preview (e.g. a remesh) belongs to the old selection
  if (!drag && !editDrag) schedulePreview(state.model!, null);
  if (meshState.mode === "weights" && sel?.kind === "bone") {
    // keep editing the same mesh; the bone becomes the one being painted
    meshState.bone = sel.id;
    refreshProps();
    return;
  }
  state.sel = sel;
  spineTreeActiveRow = { file: state.file, key: treeRow ?? (sel ? `${sel.kind}:${sel.id}` : null) };
  revealSpineTreeSelection(sel);
  if (sel?.kind === "slot") lastSlotSel = sel.id;
  if (sel) {
    const spineTab: Record<string, string> = { transform: "constraints", path: "constraints", sphysics: "constraints", slider: "constraints", skin: "skins", event: "events", image: "images", ...(modelTarget() === "spine" ? { ik: "constraints" } : {}) };
    const tab = sel.kind === "bone" ? "bones" : sel.kind === "slot" || sel.kind === "part" || sel.kind === "deformer" || sel.kind === "glue" ? "slots" : sel.kind === "param" ? "params" : (spineTab[sel.kind] ?? sel.kind);
    const stayOnParams = sel.kind === "slot" && state.tab === "params" && modelTarget() === "live2d";
    if (TARGET_TABS[modelTarget()].includes(tab) && !stayOnParams) state.tab = tab;
  }
  refreshPanels();
}

function refreshPanels(): void {
  refreshL2DShow();
  refreshToolbar();
  refreshTree();
  refreshProps();
  refreshAnimSelect();
}

function refreshToolbar(): void {
  refreshFileState();
  for (const el of document.querySelectorAll<HTMLElement>("#tools .compensate")) el.hidden = !!state.anim;
  $<HTMLButtonElement>("undo").disabled = !state.canUndo;
  $<HTMLButtonElement>("redo").disabled = !state.canRedo;
  const errors = state.issues.filter((i) => i.level === "error").length;
  const warnings = state.issues.length - errors;
  const badge = $("issues");
  badge.className = "issues " + (errors ? "err" : warnings ? "warn" : "ok");
  badge.textContent = (errors || warnings ? `${errors} errors, ${warnings} warnings` : "valid") + (state.validating ? " …" : "");
  badge.title = state.validating ? "Structure checked; pose checks (animations, physics) still running" : "Validation results";
  const list = $("issue-list");
  list.hidden = !state.showIssues;
  list.replaceChildren(
    ...(state.issues.length
      ? state.issues.map((i) => h("div", { class: i.level === "error" ? "e" : "w" }, `${i.path}: ${i.message}`))
      : [h("div", {}, "No issues.")]),
  );
  const m = state.model;
  const counts: Record<string, number> = {
    bones: m?.bones.length ?? 0,
    slots: m?.slots.length ?? 0,
    params: m?.parameters?.length ?? 0,
    constraints: (m?.ik?.length ?? 0) + (m?.transforms?.length ?? 0) + (m?.paths?.length ?? 0) + (m?.spinePhysics?.length ?? 0) + (m?.sliders?.length ?? 0),
    skins: Object.keys(m?.skins ?? {}).length,
    events: Object.keys(m?.events ?? {}).length,
    images: Object.keys(m?.images ?? {}).length,
  };
  const names: Record<string, string> = { bones: "Bones", slots: m?.live2d ? "Parts" : "Slots", params: "Params", constraints: "Constraints", skins: "Skins", events: "Events", images: "Images" };
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === state.tab);
    b.replaceChildren(names[b.dataset.tab!], h("span", { class: "count" }, String(counts[b.dataset.tab!])));
  });
}

/** The editor side of the Spine panels (web/spineui.ts). */
function spineHost(): SpineUIHost {
  return {
    h,
    field,
    num: (label, value, onchange, step) => num(label, value, onchange, step),
    selectOf,
    raw,
    header,
    iconBtn,
    commit: (ops, what) => commit(ops, what),
    select: (sel) => select(sel as Selection),
    selected: () => state.sel,
    status,
    imageSrc: (id) => imageSrc.get(id),
    item: (kind, id, label, tag = "") => {
      const colors: Record<string, string> = { ik: "#e04ab8", transform: "#26b5b5", path: "#ff7a45", sphysics: "#e0a43a", slider: "#a371f7", skin: "#3fb96c", event: "#e3b341", image: "#8b949e" };
      const selected = state.sel?.kind === kind && state.sel.id === id;
      return h(
        "div",
        {
          class: "item" + (selected ? " selected" : ""),
          title: id,
          onclick: () => select({ kind, id } as Selection),
          oncontextmenu: (e: MouseEvent) => state.model && spineRowMenu(e, state.model, { selection: { kind, id } as Selection }),
          dataset: { path: id },
        },
        h("span", { class: "dot", style: `background:${colors[kind] ?? "#8b949e"}` }),
        raw(label),
        tag ? h("span", { class: "tag" }, tag) : "",
      );
    },
    rowMenu: (e, sel, items) => state.model && spineRowMenu(e, state.model, { selection: sel as Selection, extra: items }),
    animation: () => state.anim,
    time: () => localT(),
    playSound: async (path, volume, balance) => {
      await eventAudio.play(path, volume, balance);
      return !eventAudio.missing.has(path);
    },
    chooseSound: async () => {
      const source = await pickPath({ title: "Sound file", mode: "file", exts: [".wav", ".ogg", ".mp3"], key: "event-sound" });
      if (!source || !state.file) return null;
      try {
        const r = await api<{ path: string }>("/api/add-sound", { file: state.file, source });
        eventAudio.reset(); // a sound that failed before may be there now
        status(`sound copied to audio/${r.path}`);
        return r.path;
      } catch (e) {
        status((e as Error).message, true);
        return null;
      }
    },
  };
}

/** Scroll positions of the Live2D parts / deformer lists (they are rebuilt on every refresh). */
const listScroll = new Map<string, number>();
let lastTreeSel = "";

/** Spine's bone icon picker: the current icon, and the full grid of Spine's icons. */
function spineBoneIconEditor(bone: Model["bones"][number]): HTMLElement {
  const current = bone.icon ?? "";
  const known = BONE_ICONS.some((i) => i.id === current);
  const choices = known ? BONE_ICONS : [...BONE_ICONS, { id: current, label: current }];
  return h("details", { class: "spine-icon-picker" },
    h("summary", {}, h("span", { class: "current" }, boneIconSvg(current, 18)), h("span", {}, !current ? "Default" : known ? boneIcon(current).label : current)),
    h("div", { class: "spine-icon-grid" }, ...choices.map((ic) => {
      const b = h("button", {
        type: "button",
        class: ic.id === current ? "active" : "",
        title: ic.id ? `${ic.label} (${ic.id})` : "Default",
        onclick: () => void commit([{ op: "updateBone", id: bone.id, icon: ic.id || null }]),
      });
      b.setAttribute("aria-label", ic.label);
      b.append(boneIconSvg(ic.id, 18));
      return b;
    })),
  );
}

/**
 * Attachments a slot can show: in a Spine model the ones that belong to it (setup, skins, keys, imported), like
 * Spine lists a slot's attachments; otherwise (or when it has none yet) every attachment.
 */
function slotAttachmentChoices(m: Model, slotId: string, shown: string | null): string[] {
  const all = [...Object.keys(m.attachments), ...Object.keys(m.clippings ?? {}), ...Object.keys(m.boundingBoxes ?? {})];
  if (modelTarget(m) !== "spine") return all;
  const own = spineAttachmentsBySlot(m).get(slotId) ?? [];
  if (!own.length) return all;
  return [...new Set([...own, ...(shown ? [shown] : [])])];
}

/** Spine keeps attachments in skins even when a slot is empty in setup. */
function spineAttachmentsBySlot(m: Model): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  const add = (slotId: string, id: string | null | undefined) => {
    if (!id || !(m.attachments[id] || m.pathAttachments?.[id] || m.clippings?.[id] || m.boundingBoxes?.[id])) return;
    if (!found.has(slotId)) found.set(slotId, new Set());
    found.get(slotId)!.add(id);
  };
  for (const slot of m.slots) add(slot.id, slot.attachment);
  for (const [id, entry] of Object.entries((m.meta?.spine as { attachments?: Record<string, { slot: string }> } | undefined)?.attachments ?? {})) add(entry.slot, id);
  for (const skin of Object.values(m.skins ?? {})) for (const [slotId, entries] of Object.entries(skin.attachments)) for (const id of Object.values(entries)) add(slotId, id);
  for (const anim of Object.values(m.animations ?? {})) for (const [slotId, timeline] of Object.entries(anim.slots ?? {})) for (const key of timeline.attachment ?? []) add(slotId, key.v);
  return new Map([...found].map(([slotId, ids]) => [slotId, [...ids]]));
}

// ---------- tree context menus (right-click): expand / collapse, rename, delete and the usual "new" actions

const SEP: MenuItem = { label: "", separator: true, run: () => {} };

// ---------- Spine tree folders: like Spine, a folder is part of the item's name ("accessories/bag")

type FolderSection = "constraints" | "draw" | "skins" | "events" | "animations";
const FOLDER_SECTIONS: FolderSection[] = ["constraints", "draw", "skins", "events", "animations"];

/** Names of a section's items (folders included). */
function folderItems(m: Model, section: FolderSection): string[] {
  if (section === "constraints") return allConstraints(m).map((c) => c.id);
  if (section === "draw") return m.slots.map((s) => s.id);
  return Object.keys((section === "skins" ? m.skins : section === "events" ? m.events : m.animations) ?? {});
}

/** Tree keys of the folders holding an item: "a/b/name" -> folder:<section>:a/, folder:<section>:a/b/. */
function spineFolderKeys(section: string, path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => `folder:${section}:${parts.slice(0, i + 1).join("/")}/`);
}

/** Section and folder path ("a/b/") of a folder tree key. */
function parseFolderKey(key: string): { section: string; folder: string } {
  const at = key.indexOf(":", 7);
  return { section: key.slice(7, at), folder: key.slice(at + 1) };
}

/** Every folder path of a section ("a/", "a/b/"), sorted. */
function sectionFolders(m: Model, section: FolderSection): string[] {
  return [...new Set(folderItems(m, section).flatMap((n) => spineFolderKeys(section, n).map((k) => parseFolderKey(k).folder)))].sort();
}

function renameItemOp(m: Model, section: FolderSection, from: string, to: string): Op {
  switch (section) {
    case "constraints":
      return { op: "renameConstraint", kind: allConstraints(m).find((c) => c.id === from)!.kind, id: from, to } as Op;
    case "draw":
      return { op: "renameSlot", id: from, to };
    case "skins":
      return { op: "renameSkin", name: from, to } as Op;
    case "events":
      return { op: "renameEvent", name: from, to } as Op;
    case "animations":
      return { op: "renameAnimation", name: from, to };
  }
}

function removeItemOp(m: Model, section: FolderSection, name: string): Op {
  switch (section) {
    case "constraints": {
      const kind = allConstraints(m).find((c) => c.id === name)!.kind;
      return (kind === "ik" ? { op: "removeIk", id: name } : { op: "removeConstraint", kind, id: name }) as Op;
    }
    case "draw":
      return { op: "removeSlot", id: name };
    case "skins":
      return { op: "removeSkin", name } as Op;
    case "events":
      return { op: "setEvent", name, remove: true } as Op;
    case "animations":
      return { op: "removeAnimation", name };
  }
}

/** Renames items (moving them between folders) in one undo step; the open animation and the selection follow. */
async function renameItems(m: Model, section: FolderSection, pairs: Array<[string, string]>): Promise<boolean> {
  pairs = pairs.filter(([a, b]) => a !== b);
  if (!pairs.length) return false;
  const anim = state.anim;
  const sel = state.sel;
  if (!(await commit(pairs.map(([a, b]) => renameItemOp(m, section, a, b))))) return false;
  const moved = new Map(pairs);
  if (section === "animations" && anim && moved.has(anim)) showAnimation(moved.get(anim)!);
  if (sel && moved.has(sel.id)) select({ ...sel, id: moved.get(sel.id)! });
  for (const [, to] of pairs) setSpineTreeExpanded([`section:${section}`, ...spineFolderKeys(section, to)], true);
  return true;
}

const leafName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folderPrefix = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const FOLDER_RE = /^[^\u0000-\u001f"\\/]+$/u;

/** Moves one item into another folder (or out of every folder). */
async function moveToFolder(m: Model, section: FolderSection, name: string): Promise<void> {
  const r = await dialog({
    title: "Move to Folder",
    fields: [
      { name: "folder", label: "Folder", type: "select", value: folderPrefix(name), options: [["", "(no folder)"], ...sectionFolders(m, section).map((f): [string, string] => [f, f.slice(0, -1)])] },
      { name: "sub", label: "New folder inside it", placeholder: "(none)", hint: "Optional. Spine keeps folders in the names: this becomes <folder>/<new folder>/" + leafName(name) },
    ] as Field[],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Move", value: "ok", primary: true }],
    validate: (x) => (x.button === "ok" && String(x.values.sub).trim() && !FOLDER_RE.test(String(x.values.sub).trim()) ? "Folder names cannot contain quotes, backslashes or /" : null),
  });
  if (r?.button !== "ok") return;
  const sub = String(r.values.sub).trim();
  await renameItems(m, section, [[name, `${r.values.folder}${sub ? `${sub}/` : ""}${leafName(name)}`]]);
}

/** A new folder, holding one item to start with (a folder only exists while an item's name uses it). */
async function newFolder(m: Model, section: FolderSection, parent: string): Promise<void> {
  const items = folderItems(m, section);
  if (!items.length) return void alertDialog("New folder", "Add an item first: a folder holds at least one item (Spine keeps folders in the item names).");
  const r = await dialog({
    title: parent ? `New Folder in ${parent.slice(0, -1)}` : "New Folder",
    fields: [
      { name: "name", label: "Name", value: "folder" },
      { name: "item", label: "Move into it", type: "list", value: items.find((n) => n.startsWith(parent)) ?? items[0], options: items.map((n): [string, string] => [n, n]) },
    ] as Field[],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Create", value: "ok", primary: true }],
    validate: (x) => (x.button === "ok" && !FOLDER_RE.test(String(x.values.name).trim()) ? "Enter a folder name (no quotes, backslashes or /)" : null),
  });
  if (r?.button !== "ok") return;
  const item = String(r.values.item);
  await renameItems(m, section, [[item, `${parent}${String(r.values.name).trim()}/${leafName(item)}`]]);
}

/** Right-click items of a folder row. */
function folderMenuItems(m: Model, key: string): MenuItem[] {
  const { section, folder } = parseFolderKey(key);
  if (!FOLDER_SECTIONS.includes(section as FolderSection)) return [];
  const sec = section as FolderSection;
  const inside = folderItems(m, sec).filter((n) => n.startsWith(folder));
  const parent = folderPrefix(folder.slice(0, -1));
  const name = leafName(folder.slice(0, -1));
  const rename = async () => {
    const to = await promptText("Rename Folder", "Name", name);
    if (to === null || to.trim() === name) return;
    if (!FOLDER_RE.test(to.trim())) return void alertDialog("Rename folder", "Folder names cannot be empty or contain quotes, backslashes or /.");
    await renameItems(m, sec, inside.map((n) => [n, parent + to.trim() + "/" + n.slice(folder.length)]));
  };
  const remove = async () => {
    if (!(await confirmDialog("Delete folder", `Delete the folder "${folder.slice(0, -1)}" and the ${inside.length} item(s) in it? (Undo brings them back.)`, "Delete", true))) return;
    if (inside.includes(state.anim ?? "\u0000")) state.anim = null;
    if (await commit(inside.map((n) => removeItemOp(m, sec, n)))) select(null);
  };
  return [
    { label: "New folder inside…", run: () => void newFolder(m, sec, folder) },
    { label: "Rename folder…", run: () => void rename() },
    { label: "Move contents out of folder", run: () => void renameItems(m, sec, inside.map((n) => [n, parent + n.slice(folder.length)])) },
    SEP,
    { label: "Delete folder and contents…", danger: true, run: () => void remove() },
  ];
}

/** The folder section of a tree row's item, with the item's name (null: not an item that can go in a folder). */
function rowFolderItem(row: { selection?: Selection; entryKey?: string; anim?: string }): { section: FolderSection; name: string } | null {
  const sel = row.selection;
  if (row.anim) return { section: "animations", name: row.anim };
  if (!sel) return null;
  if (sel.kind === "slot") return row.entryKey?.startsWith("attachment:") ? null : { section: "draw", name: sel.id };
  if (sel.kind === "skin") return { section: "skins", name: sel.id };
  if (sel.kind === "event") return { section: "events", name: sel.id };
  if (["ik", "transform", "path", "sphysics", "slider"].includes(sel.kind)) return { section: "constraints", name: sel.id };
  return null;
}

/** Expandable keys of the Spine tree: all of them, or a bone's subtree (its bones and slots), or a folder and its subfolders, or one key. */
function spineTreeKeys(m: Model, under?: string): string[] {
  const kids = new Map<string | null, string[]>();
  for (const b of m.bones) kids.set(b.parent, [...(kids.get(b.parent) ?? []), b.id]);
  const slotsOf = (bone: string) => m.slots.filter((s) => s.bone === bone).map((s) => s.id);
  const bonesUnder = (id: string): string[] => [id, ...(kids.get(id) ?? []).flatMap(bonesUnder)];
  const boneKeys = (id: string) => bonesUnder(id).flatMap((b) => [`bone:${b}`, ...slotsOf(b).map((s) => `slot:${s}`)]);
  if (!under || under === "model") {
    const sections = ["constraints", "draw", "skins", "events", "animations", "images", "audio"].map((s) => `section:${s}`);
    const folders = FOLDER_SECTIONS.flatMap((s) => sectionFolders(m, s).map((f) => `folder:${s}:${f}`));
    return ["model", ...(kids.get(null) ?? []).flatMap(boneKeys), ...sections, ...folders];
  }
  if (under.startsWith("bone:")) return boneKeys(under.slice(5));
  if (under.startsWith("folder:")) {
    const { section, folder } = parseFolderKey(under);
    const subs = FOLDER_SECTIONS.includes(section as FolderSection) ? sectionFolders(m, section as FolderSection).filter((f) => f.startsWith(folder)) : [folder];
    return subs.map((f) => `folder:${section}:${f}`);
  }
  return [under];
}

/** Opens or folds Spine tree rows (stored as deviations from the defaults, like a click on a caret). */
function setSpineTreeExpanded(keys: string[], open: boolean): void {
  const toggles = spineTreeToggles();
  for (const k of keys) {
    const defaultOpen = k === "model" || k.startsWith("bone:") || k.startsWith("slot:");
    if (open === defaultOpen) toggles.delete(k);
    else toggles.add(k);
  }
  try {
    localStorage.setItem(`awaken2d.spineTree.${state.file}`, JSON.stringify([...toggles]));
  } catch {
    // expansion still works for this session
  }
  refreshTree();
}

/** Right-click on a row of the Spine tree. */
function spineRowMenu(e: MouseEvent, m: Model, row: { key?: string; selection?: Selection; entryKey?: string; anim?: string; extra?: MenuItem[] }): void {
  e.preventDefault();
  e.stopPropagation();
  const sel = row.selection;
  if (sel && !(state.sel?.kind === sel.kind && state.sel.id === sel.id)) select(sel, false, row.entryKey);
  const items: MenuItem[] = [];
  if (row.key && row.key !== "model") {
    const sub = spineTreeKeys(m, row.key);
    items.push({ label: "Expand", run: () => setSpineTreeExpanded(sub, true) }, { label: "Collapse", run: () => setSpineTreeExpanded(sub, false) });
  }
  const all = spineTreeKeys(m);
  items.push(
    { label: "Expand all", run: () => setSpineTreeExpanded(all, true) },
    // the model row stays open, so the bones stay reachable
    { label: "Collapse all", run: () => setSpineTreeExpanded(all.filter((k) => k !== "model"), false) },
  );
  const setup = !state.anim;
  if (sel?.kind === "bone") {
    const root = m.bones.find((b) => b.id === sel.id)?.parent === null;
    items.push(
      SEP,
      { label: "Rename…", hint: "F2", run: () => void renameSelected() },
      { label: "New bone chain…", run: () => void newBoneChain(sel.id) },
      { label: "New slot…", run: () => void newSlot() },
      SEP,
      { label: "Delete bone…", hint: "Shift+Del", danger: true, disabled: root, run: () => void deleteSelected() },
    );
  } else if (sel?.kind === "slot" && row.entryKey?.startsWith("attachment:")) {
    const att = row.entryKey.split(":").slice(2).join(":");
    const slot = m.slots.find((s) => s.id === sel.id);
    items.push(
      SEP,
      { label: "Show this attachment", disabled: !setup || slot?.attachment === att, run: () => void commit([{ op: "updateSlot", id: sel.id, attachment: att }]) },
      SEP,
      { label: "Delete attachment…", danger: true, disabled: !(m.attachments[att] || m.clippings?.[att] || m.boundingBoxes?.[att]), run: () => void deleteAttachment(att) },
    );
  } else if (sel?.kind === "slot") {
    const slot = m.slots.find((s) => s.id === sel.id);
    const back = hiddenAttachment.get(sel.id) ?? spineAttachmentsBySlot(m).get(sel.id)?.[0] ?? null;
    items.push(
      SEP,
      { label: "Rename…", hint: "F2", run: () => void renameSelected() },
      slot?.attachment
        ? { label: "Hide", disabled: !setup, run: () => (hiddenAttachment.set(sel.id, slot.attachment!), void commit([{ op: "updateSlot", id: sel.id, attachment: null }])) }
        : { label: "Show", disabled: !setup || !back, run: () => void commit([{ op: "updateSlot", id: sel.id, attachment: back }]) },
      SEP,
      { label: "Delete slot…", hint: "Shift+Del", danger: true, run: () => void deleteSelected() },
    );
  } else if (row.extra) {
    items.push(SEP, ...row.extra);
  } else if (sel?.kind === "skin") {
    items.push(SEP, ...skinMenuItems(m, sel.id, spineHost()));
  } else if (sel?.kind === "event") {
    items.push(SEP, { label: "New event…", run: () => void newEvent(spineHost()) }, SEP, { label: "Delete event…", hint: "Shift+Del", danger: true, run: () => void deleteSelected() });
  } else if (sel && ["ik", "transform", "path", "sphysics", "slider"].includes(sel.kind)) {
    items.push(SEP, { label: "New constraint…", run: () => void newConstraint(m, spineHost()) }, SEP, { label: "Delete constraint…", hint: "Shift+Del", danger: true, run: () => void deleteSelected() });
  } else if (row.anim) {
    const name = row.anim;
    const open = () => {
      if (state.anim !== name) selectAnimation(name);
    };
    items.push(
      SEP,
      { label: "Open", disabled: state.anim === name, run: open },
      { label: "Rename…", run: () => (open(), $("rename-anim").click()) },
      { label: "Duplicate", run: () => (open(), $("dup-anim").click()) },
      SEP,
      { label: "Delete animation…", danger: true, run: () => (open(), $("del-anim").click()) },
    );
  } else if (row.key?.startsWith("folder:")) {
    const more = folderMenuItems(m, row.key);
    if (more.length) items.push(SEP, ...more);
  } else if (row.key === "section:constraints") {
    items.push(SEP, { label: "New constraint…", run: () => void newConstraint(m, spineHost()) });
  } else if (row.key === "section:skins") {
    items.push(SEP, { label: "New skin…", run: () => void newSkin(m, spineHost()) });
  } else if (row.key === "section:events") {
    items.push(SEP, { label: "New event…", run: () => void newEvent(spineHost()) });
  } else if (row.key === "section:draw") {
    items.push(SEP, { label: "New slot…", run: () => void newSlot() });
  } else if (row.key === "section:animations") {
    items.push(SEP, { label: "New animation…", run: () => void newAnimation() });
  }
  const headSection = row.key?.startsWith("section:") ? (row.key.slice(8) as FolderSection) : null;
  if (headSection && FOLDER_SECTIONS.includes(headSection)) items.push({ label: "New folder…", run: () => void newFolder(m, headSection, "") });
  const item = rowFolderItem(row);
  if (item) {
    // before the delete entry, like Spine's menu
    const move: MenuItem = { label: "Move to folder…", run: () => void moveToFolder(m, item.section, item.name) };
    const del = items.findLastIndex((it) => it.danger);
    if (del > 0 && items[del - 1].separator) items.splice(del - 1, 0, move);
    else items.push(SEP, move);
  }
  showMenu(e.clientX, e.clientY, items);
}

/** The selection the Live2D lists last opened their folders for (they reveal a new selection once). */
let lastReveal = "";

/** Opens or folds rows of the Live2D Parts / Deformers lists. */
function setTreeKeysOpen(keys: string[], open: boolean): void {
  const set = treeKeys();
  for (const k of keys) {
    if (open) set.add(k);
    else set.delete(k);
  }
  try {
    localStorage.setItem(`awaken2d.tree.${state.file}`, JSON.stringify([...set]));
  } catch {
    // not remembered
  }
  refreshTree();
}

/** Right-click on a row of the Live2D Parts / Deformers lists (`node` null: the list head). */
function live2dRowMenu(
  e: MouseEvent,
  m: Model,
  node: { key: string; kind: "part" | "deformer" | "slot" | "glue"; id: string; hidden: boolean; locked: boolean; toggleHidden: Op[]; toggleLock: Op[] } | null,
  subtreeKeys: string[],
  listKeys: string[],
): void {
  e.preventDefault();
  e.stopPropagation();
  if (node && !(state.sel?.kind === node.kind && state.sel.id === node.id)) select({ kind: node.kind, id: node.id });
  const items: MenuItem[] = [];
  if (subtreeKeys.length) items.push({ label: "Expand", run: () => setTreeKeysOpen(subtreeKeys, true) }, { label: "Collapse", run: () => setTreeKeysOpen(subtreeKeys, false) });
  items.push({ label: "Expand all", run: () => setTreeKeysOpen(listKeys, true) }, { label: "Collapse all", run: () => setTreeKeysOpen(listKeys, false) });
  if (node && node.kind !== "glue") {
    items.push(
      SEP,
      { label: node.hidden ? "Show" : "Hide", run: () => void commit(node.toggleHidden) },
      { label: node.locked ? "Unlock" : "Lock", run: () => void commit(node.toggleLock) },
    );
  }
  if (node?.kind === "part") {
    const p = m.live2d?.parts.find((x) => x.id === node.id);
    items.push(
      SEP,
      {
        label: "Rename…",
        run: async () => {
          const to = await promptText("Rename Part", "Name", p?.name ?? node.id);
          if (to !== null && to.trim() !== (p?.name ?? "")) void commit([{ op: "updatePart", id: node.id, name: to.trim() } as Op]);
        },
      },
      { label: "New part inside…", run: () => void newLive2DPart() },
      SEP,
      {
        label: "Delete part…",
        danger: true,
        run: async () => {
          if (await confirmDialog("Delete part", `Delete part ${node.id}? Its sub-parts, deformers and art meshes move to ${p?.parent ?? "the root"}.`, "Delete", true)) {
            if (await commit([{ op: "removePart", id: node.id } as Op])) select(null);
          }
        },
      },
    );
  } else if (node?.kind === "deformer") {
    const d = m.live2d?.deformers.find((x) => x.id === node.id);
    items.push(
      SEP,
      { label: "New warp deformer around it…", run: () => void newLive2DDeformer("warp") },
      { label: "New rotation deformer around it…", run: () => void newLive2DDeformer("rotation") },
      SEP,
      {
        label: "Delete deformer…",
        danger: true,
        run: async () => {
          if (await confirmDialog("Delete deformer", `Delete deformer ${node.id}? Its children move to ${d?.parent ?? "the canvas"} and keep their look.`, "Delete", true)) {
            if (await commit([{ op: "removeDeformer", id: node.id } as Op])) select(null);
          }
        },
      },
    );
  } else if (node?.kind === "slot") {
    items.push(
      SEP,
      { label: "Rename…", hint: "F2", run: () => void renameSelected() },
      { label: "New warp deformer around it…", run: () => void newLive2DDeformer("warp") },
      { label: "New rotation deformer around it…", run: () => void newLive2DDeformer("rotation") },
      SEP,
      { label: "Delete art mesh…", hint: "Shift+Del", danger: true, run: () => void deleteSelected() },
    );
  } else if (!node) {
    items.push(SEP, { label: "New part…", run: () => void newLive2DPart() });
  }
  showMenu(e.clientX, e.clientY, items);
}

/** Spine's single hierarchy: skeleton, slots and attachments, followed by the other editor sections. */
function spineTreeRows(m: Model, query: string): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const filter = m.name.toLowerCase().includes(query) ? "" : query;
  const matches = (value: string) => !filter || value.toLowerCase().includes(filter);
  const matchesLabel = (value: string) => matches(value) || tr(value).toLowerCase().includes(filter);
  const expanded = (key: string) => !!filter || spineTreeExpanded(key);
  const attachmentsBySlot = spineAttachmentsBySlot(m);
  const slotAttachments = (slotId: string) => attachmentsBySlot.get(slotId) ?? [];
  const row = (label: string, depth: number, icon: string, key?: string, selection?: Selection, onClick?: () => void, entryKey?: string): HTMLElement => {
    const open = key ? expanded(key) : false;
    const activeRow = spineTreeActiveRow.file === state.file ? spineTreeActiveRow.key : null;
    const selected = selection && state.sel?.kind === selection.kind && state.sel.id === selection.id && (activeRow ?? `${selection.kind}:${selection.id}`) === (entryKey ?? `${selection.kind}:${selection.id}`);
    const caret = h("button", {
      class: "spine-caret" + (key ? "" : " empty"),
      title: key ? (open ? "Collapse" : "Expand") : "",
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        if (key) toggleSpineTreeKey(key);
      },
    }, key ? (open ? "▾" : "▸") : "");
    caret.tabIndex = key ? 0 : -1;
    const el = h("div", {
      class: "item spine-row" + (selected ? " selected" : "") + (depth === 0 ? " spine-root" : ""),
      title: label,
      onclick: (e: MouseEvent) => {
        if (selection?.kind === "bone" && (e.shiftKey || e.ctrlKey || e.metaKey) && state.sel?.kind === "bone" && state.sel.id !== selection.id) {
          if (multi.has(selection.id)) multi.delete(selection.id);
          else multi.add(selection.id);
          refreshPanels();
          return;
        }
        if (onClick) onClick();
        else if (selection) select(selection, false, entryKey);
        else if (key) toggleSpineTreeKey(key);
        else select(null);
      },
      oncontextmenu: (e: MouseEvent) => spineRowMenu(e, m, { key, selection, entryKey, anim: el.dataset.anim }),
    }, caret, h("span", { class: "spine-icon" }, icon), h("span", { class: "spine-name" }, label));
    el.style.setProperty("--depth", String(depth));
    if (selection || depth === 0 || onClick) el.setAttribute("translate", "no");
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-level", String(depth + 1));
    if (key) el.setAttribute("aria-expanded", String(open));
    return el;
  };
  const appendChildren = (children: HTMLElement[], depth: number): void => {
    for (const child of children) {
      child.classList.add("spine-row", "spine-child");
      if (child.style.whiteSpace === "normal") child.classList.add("spine-help");
      const d = Number(child.dataset.depth ?? depth);
      child.style.setProperty("--depth", String(d));
      child.setAttribute("role", "treeitem");
      child.setAttribute("aria-level", String(d + 1));
      rows.push(child);
    }
  };
  const section = (key: string, label: string, icon: string, count: number, children: HTMLElement[], action?: HTMLElement): void => {
    if (filter && !matchesLabel(label)) children = children.filter((child) => matches(child.textContent ?? ""));
    if (filter && !matchesLabel(label) && !children.length) return;
    const head = row(label, 1, icon, `section:${key}`);
    head.classList.add("spine-section");
    head.append(h("span", { class: "spine-count" }, String(count)));
    if (action) {
      action.addEventListener("click", (e) => e.stopPropagation());
      head.append(action);
    }
    rows.push(head);
    if (expanded(`section:${key}`)) appendChildren(folderRows(key, children, 2, ""), 2);
  };
  /** Groups items whose names hold "/" (data-path) under folder rows, like Spine's tree. */
  const folderRows = (sectionKey: string, children: HTMLElement[], depth: number, prefix: string): HTMLElement[] => {
    const out: HTMLElement[] = [];
    const done = new Set<string>();
    for (const child of children) {
      const path = child.dataset.path;
      const rest = path !== undefined && path.startsWith(prefix) ? path.slice(prefix.length) : null;
      const cut = rest?.indexOf("/") ?? -1;
      if (rest === null || cut <= 0) {
        if (prefix && rest !== null) {
          const label = child.querySelector(".spine-name") ?? child.querySelector("[translate=no]");
          if (label) label.textContent = rest;
        }
        child.dataset.depth = String(depth);
        out.push(child);
        continue;
      }
      const name = rest.slice(0, cut);
      if (done.has(name)) continue;
      done.add(name);
      const folder = `${prefix}${name}/`;
      const inside = children.filter((c) => c.dataset.path?.startsWith(folder));
      const folderKey = `folder:${sectionKey}:${folder}`;
      const el = row(name, depth, "📁", folderKey);
      el.classList.add("spine-folder");
      el.title = folder.slice(0, -1);
      el.setAttribute("translate", "no");
      el.dataset.depth = String(depth);
      el.append(h("span", { class: "spine-count" }, String(inside.length)));
      out.push(el);
      if (expanded(folderKey)) out.push(...folderRows(sectionKey, inside, depth + 1, folder));
    }
    return out;
  };

  rows.push(row(m.name, 0, "✳", "model", undefined, () => select(null)));
  if (expanded("model")) {
    const boneKids = new Map<string | null, string[]>();
    for (const bone of m.bones) boneKids.set(bone.parent, [...(boneKids.get(bone.parent) ?? []), bone.id]);
    const boneColors = new Map(m.bones.map((bone) => [bone.id, bone.color ?? "var(--accent)"]));
    const boneIcons = new Map(m.bones.map((bone) => [bone.id, bone.icon]));
    const slots = new Map<string, typeof m.slots>();
    for (const slot of [...m.slots].reverse()) slots.set(slot.bone, [...(slots.get(slot.bone) ?? []), slot]);
    const visible = (id: string): boolean =>
      matches(id) || (slots.get(id) ?? []).some((slot) => matches(slot.id) || slotAttachments(slot.id).some(matches)) || (boneKids.get(id) ?? []).some(visible);
    const walk = (id: string, depth: number): void => {
      if (!visible(id)) return;
      const key = `bone:${id}`;
      const children = boneKids.get(id) ?? [];
      const attached = slots.get(id) ?? [];
      const boneIcon = boneIcons.get(id);
      const boneRow = row(id, depth, "", children.length || attached.length ? key : undefined, { kind: "bone", id });
      boneRow.querySelector<HTMLElement>(".spine-icon")!.replaceChildren(boneIconSvg(boneIcon, 13));
      if (boneIcon) boneRow.querySelector<HTMLElement>(".spine-icon")!.title = boneIcon;
      boneRow.querySelector<HTMLElement>(".spine-icon")!.style.color = boneColors.get(id) ?? "var(--accent)";
      const linkedIk = (m.ik ?? []).filter((constraint) => constraint.target === id || constraint.bones.includes(id));
      if (linkedIk.length) boneRow.append(h("span", { class: "spine-ik-links" }, ...linkedIk.map((constraint) => h("button", {
        type: "button",
        class: "spine-ik-link",
        title: `${constraint.id} · ${constraint.target === id ? "IK target" : "IK bone"} · click to select`,
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          select({ kind: "ik", id: constraint.id });
        },
      }, "⌖"))));
      if (multi.has(id)) boneRow.classList.add("selected");
      rows.push(boneRow);
      if (!expanded(key)) return;
      for (const slot of attached) {
        const attachmentIds = slotAttachments(slot.id);
        if (!matches(id) && !matches(slot.id) && !attachmentIds.some(matches)) continue;
        const shown = resolveAttachment(m, slot.id, slotAttachmentNow(m, slot.id));
        const slotKey = `slot:${slot.id}`;
        const slotRow = row(slot.id, depth + 1, "◉", attachmentIds.length ? slotKey : undefined, { kind: "slot", id: slot.id });
        slotRow.classList.add("spine-slot-row");
        slotRow.dataset.slotId = slot.id;
        paintSpineSlotTreeRow(slotRow, slotColorNow(m, slot.id));
        if (shown === null) slotRow.classList.add("spine-muted");
        rows.push(slotRow);
        if (expanded(slotKey)) for (const attachmentId of attachmentIds) {
          if (!matches(id) && !matches(slot.id) && !matches(attachmentId)) continue;
          const child = row(attachmentId, depth + 2, "▣", undefined, { kind: "slot", id: slot.id }, undefined, `attachment:${slot.id}:${attachmentId}`);
          if (attachmentId !== shown) {
            child.classList.add("spine-muted");
            child.append(h("span", { class: "tag" }, "hidden"));
          }
          rows.push(child);
        }
      }
      for (const child of children) walk(child, depth + 1);
    };
    for (const id of boneKids.get(null) ?? []) walk(id, 1);

    const host = spineHost();
    const constraintLabel = "Constraints";
    const constraintList = constraintRows(m, host, (id) => matchesLabel("Constraints") || matches(id));
    const constraintAction = constraintList.shift()?.querySelector("button") ?? undefined;
    section("constraints", constraintLabel, "⌘", (m.ik?.length ?? 0) + (m.transforms?.length ?? 0) + (m.paths?.length ?? 0) + (m.spinePhysics?.length ?? 0) + (m.sliders?.length ?? 0), constraintList, constraintAction as HTMLElement | undefined);

    const drawSlots = [...m.slots].reverse().filter((slot) => matchesLabel("Draw Order") || matches(slot.id)).map((slot) => {
      const entry = row(slot.id, 2, "◉", undefined, { kind: "slot", id: slot.id }, undefined, `draw:${slot.id}`);
      entry.classList.add("spine-slot-row");
      entry.dataset.slotId = slot.id;
      entry.dataset.path = slot.id;
      paintSpineSlotTreeRow(entry, slotColorNow(m, slot.id));
      entry.append(h("span", { class: "tag" }, slot.bone));
      return entry;
    });
    section("draw", "Draw Order", "≡", m.slots.length, drawSlots,
      h("button", { class: "icon small", title: "New empty slot (in front, on the selected bone)", onclick: () => void newSlot() }, "＋"));

    const skinList = skinRows(m, host);
    const skinAction = skinList.shift()?.querySelector("button") ?? undefined;
    section("skins", "Skins", "◧", Object.keys(m.skins ?? {}).length, skinList, skinAction as HTMLElement | undefined);

    const eventList = eventRows(m, host, (id) => matchesLabel("Events") || matches(id));
    const eventAction = eventList.shift()?.querySelector("button") ?? undefined;
    section("events", "Events", "⚑", Object.keys(m.events ?? {}).length, eventList, eventAction as HTMLElement | undefined);

    const animations = Object.entries(m.animations ?? {}).filter(([name]) => matchesLabel("Animations") || matches(name)).map(([name, animation]) => {
      const entry = row(name, 2, "▶", undefined, undefined, () => selectAnimation(name));
      entry.dataset.anim = name;
      entry.dataset.path = name;
      if (state.anim === name) entry.classList.add("selected");
      entry.append(h("span", { class: "tag" }, `${+animation.duration.toFixed(3)}s`));
      return entry;
    });
    section("animations", "Animations", "▶", Object.keys(m.animations ?? {}).length, animations,
      h("button", { class: "icon small", title: "New animation", onclick: () => void newAnimation() }, "＋"));

    const imageList = imageRows(m, host, (id) => matchesLabel("Images") || matches(id), "images");
    imageList.shift();
    section("images", "Images", "▧", Object.keys(m.images ?? {}).length, imageList);
    const audioList = imageRows(m, host, (id) => matchesLabel("Audio") || matches(id), "audio");
    audioList.shift();
    const audioCount = new Set(Object.values(m.events ?? {}).map((event) => event.audio).filter(Boolean)).size;
    section("audio", "Audio", "♫", audioCount, audioList);
  }
  return rows;
}

function refreshTree(): void {
  const m = state.model;
  const tree = $("tree");
  if (!m) {
    tree.removeAttribute("role");
    return tree.replaceChildren();
  }
  const query = $<HTMLInputElement>("search").value.trim().toLowerCase();
  if (modelTarget(m) === "spine") {
    tree.setAttribute("role", "tree");
    tree.replaceChildren(...spineTreeRows(m, query));
    const selKey = JSON.stringify(state.sel) + (selGlue ?? "");
    if (selKey !== lastTreeSel) tree.querySelector<HTMLElement>(".spine-row.selected")?.scrollIntoView({ block: "nearest" });
    lastTreeSel = selKey;
    return;
  }
  tree.removeAttribute("role");
  const DOT: Record<string, string> = { bone: "#4ea1ff", slot: "#3fb96c", ik: "#e04ab8", param: "#a371f7", target: "#e04ab8", physics: "#e0a43a" };
  const item = (kind: NonNullable<Selection>["kind"], id: string, label: Node | string, indent = 0, tag = "") =>
    h(
      "div",
      {
        class: "item" + ((state.sel?.kind === kind && state.sel.id === id) || (kind === "bone" && multi.has(id)) ? " selected" : ""),
        style: `padding-left:${10 + (query ? 0 : indent) * 14}px`,
        onclick: (e: MouseEvent) => {
          // Shift/Ctrl+click adds or removes bones from the selection, like in the viewport
          if (kind === "bone" && (e.shiftKey || e.ctrlKey || e.metaKey) && state.sel?.kind === "bone" && state.sel.id !== id) {
            if (multi.has(id)) multi.delete(id);
            else multi.add(id);
            return refreshPanels();
          }
          select({ kind, id });
        },
        title: id,
      },
      h("span", { class: "dot", style: `background:${DOT[tag === "IK target" ? "target" : tag === "physics" ? "physics" : kind]}` }),
      typeof label === "string" ? raw(label) : label,
      tag ? h("span", { class: "tag" }, tag) : "",
    );
  const matches = (id: string) => !query || id.toLowerCase().includes(query);
  const rows: HTMLElement[] = [];
  if (state.tab === "bones") {
    const kids = new Map<string | null, string[]>();
    for (const b of m.bones) kids.set(b.parent, [...(kids.get(b.parent) ?? []), b.id]);
    const ik = new Set((m.ik ?? []).map((c) => c.target));
    const phys = new Set((m.spinePhysics ?? []).map((c) => c.bone));
    const walk = (id: string, depth: number) => {
      if (matches(id)) rows.push(item("bone", id, id, depth, ik.has(id) ? "IK target" : phys.has(id) ? "physics" : ""));
      for (const c of kids.get(id) ?? []) walk(c, depth + 1);
    };
    for (const r of kids.get(null) ?? []) walk(r, 0);
  } else if (state.tab === "slots" && m.live2d) {
    for (const el of tree.querySelectorAll<HTMLElement>(".l2d-list-body")) listScroll.set(el.parentElement!.className, el.scrollTop);
    rows.push(...live2dTreeRows(m, query));
  } else if (state.tab === "slots") {
    const l2d = modelTarget(m) === "live2d";
    const partOf = (s: (typeof m.slots)[number]) => (s.attachment ? (m.attachments[s.attachment]?.live2d?.part ?? "") : "");
    [...m.slots].reverse().filter((s) => matches(s.id)).forEach((s) => rows.push(item("slot", s.id, s.id, 0, s.attachment === null ? "hidden" : l2d ? partOf(s) : s.bone)));
    rows.unshift(
      h(
        "div",
        { class: "item note list-head" },
        h("span", {}, "Draw order: front to back"),
        ...(l2d ? [] : [h("button", { class: "icon small", title: "New empty slot (in front, on the selected bone)", onclick: () => void newSlot() }, "＋")]),
      ),
    );
  } else if (state.tab === "params") {
    rows.push(...paramRows(m));
  } else if (state.tab === "constraints") {
    rows.push(...constraintRows(m, spineHost(), matches));
  } else if (state.tab === "skins") {
    rows.push(...skinRows(m, spineHost()));
  } else if (state.tab === "events") {
    rows.push(...eventRows(m, spineHost(), matches));
  } else if (state.tab === "images") {
    rows.push(...imageRows(m, spineHost(), matches));
  }
  tree.replaceChildren(...rows);
  for (const el of tree.querySelectorAll<HTMLElement>(".l2d-list-body")) el.scrollTop = listScroll.get(el.parentElement!.className) ?? 0;
  // a new selection is scrolled into view (not on every refresh: the lists keep where the user scrolled)
  const selKey = JSON.stringify(state.sel) + (selGlue ?? "");
  if (selKey !== lastTreeSel) tree.querySelector<HTMLElement>(".l2d-list-body .item.selected")?.scrollIntoView({ block: "nearest" });
  lastTreeSel = selKey;
}

/**
 * The Live2D tree, Cubism style: parts (folders) holding sub-parts, deformers and art meshes (front first), or the
 * deformer hierarchy with the art meshes under their deformer. Rows fold; the eye and lock toggle an object's
 * visibility and editor lock; the color strip is its part's label.
 */
function live2dTreeRows(m: Model, query: string): HTMLElement[] {
  const rig = m.live2d!;
  const open = treeKeys();
  const q = query.toLowerCase();
  const values = lastPose?.params ?? Object.fromEntries((m.parameters ?? []).map((p) => [p.id, p.default]));
  let frame: ReturnType<typeof live2dFrame> | null = null;
  try {
    frame = live2dFrame(m, values);
  } catch {
    // a broken rig: no current draw orders
  }
  const slotOf = new Map<string, string>();
  for (const s of m.slots) if (s.attachment) slotOf.set(s.attachment, s.id);
  const meshes = Object.entries(m.attachments).filter(([, a]) => a.live2d) as Array<[string, MeshAttachment & { live2d: NonNullable<MeshAttachment["live2d"]> }]>;
  const orderOf = (id: string, a: (typeof meshes)[number][1]) => frame?.meshes.get(id)?.drawOrder ?? a.live2d.forms[0]?.drawOrder ?? 500;
  const byFront = (list: typeof meshes) => [...list].sort((x, y) => orderOf(y[0], y[1]) - orderOf(x[0], x[1]));
  const partById = new Map(rig.parts.map((p) => [p.id, p]));
  const defById = new Map(rig.deformers.map((d) => [d.id, d]));
  const labelOf = (part: string | null): string => {
    for (let p = part, n = 0; p && n < 64; n++) {
      const x = partById.get(p);
      if (!x) break;
      if (x.label) return x.label;
      p = x.parent;
    }
    return "transparent";
  };
  // the Cubism palette's order (from a .cmo3): listed objects in that order, the others after them as they come
  const treeRank = new Map((((m.meta as { live2d?: { treeOrder?: string[] } } | undefined)?.live2d?.treeOrder) ?? []).map((k, i) => [k, i]));
  const inTreeOrder = <T extends { key: string }>(list: T[]): T[] =>
    treeRank.size ? list.map((n, i) => ({ n, i, r: treeRank.get(n.key) ?? Infinity })).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.n) : list;
  // reveal the selection: its parts / deformers open (not remembered)
  const reveal = new Set<string>();
  const sel = state.sel;
  const revealParts = (p: string | null) => {
    for (let n = 0; p && n < 64; n++) (reveal.add(`p:${p}`), (p = partById.get(p)?.parent ?? null));
  };
  const revealDefs = (d: string | null) => {
    for (let n = 0; d && n < 64; n++) (reveal.add(`d:${d}`), (d = defById.get(d)?.parent ?? null));
  };
  if (sel?.kind === "slot") {
    const att = m.slots.find((s) => s.id === sel.id)?.attachment;
    const l = att ? m.attachments[att]?.live2d : undefined;
    if (l) {
      revealParts(l.part);
      revealDefs(l.deformer);
    }
  } else if (sel?.kind === "deformer") {
    const d = defById.get(sel.id);
    if (d) {
      revealParts(d.part);
      revealDefs(d.parent);
    }
  } else if (sel?.kind === "part") revealParts(partById.get(sel.id)?.parent ?? null);
  // only when the selection changes: after that the user can fold them again
  const revealFor = `${state.file} ${JSON.stringify(sel)}`;
  if (revealFor !== lastReveal) {
    lastReveal = revealFor;
    if ([...reveal].some((k) => !open.has(k))) {
      for (const k of reveal) open.add(k);
      try {
        localStorage.setItem(`awaken2d.tree.${state.file}`, JSON.stringify([...open]));
      } catch {
        // not remembered
      }
    }
  }

  type Node = {
    key: string;
    kind: "part" | "deformer" | "slot" | "glue";
    /** Tree filter kind. */
    show: keyof TreeShow | null;
    id: string;
    name: string;
    icon: string;
    iconColor: string;
    order?: number;
    label: string;
    hidden: boolean;
    locked: boolean;
    kids: () => Node[];
    toggleHidden: Op[];
    toggleLock: Op[];
  };
  const meshNode = (id: string, a: (typeof meshes)[number][1]): Node => {
    const slot = slotOf.get(id) ?? id;
    return {
      key: `m:${id}`,
      kind: "slot",
      show: "art",
      id: slot,
      name: a.live2d.name || slot,
      icon: "◩",
      iconColor: "#9aa4ae",
      order: orderOf(id, a),
      label: labelOf(a.live2d.part),
      hidden: !!a.live2d.hidden,
      locked: !!a.live2d.locked,
      kids: () => [],
      toggleHidden: [{ op: "setLive2DMesh", attachment: id, hidden: !a.live2d.hidden } as Op],
      toggleLock: [{ op: "setLive2DMesh", attachment: id, locked: !a.live2d.locked } as Op],
    };
  };
  const defNode = (d: (typeof rig.deformers)[number], kids: () => Node[]): Node => ({
    key: `d:${d.id}`,
    kind: "deformer",
    show: d.type === "warp" ? "warp" : "rotation",
    id: d.id,
    name: d.name || d.id,
    icon: d.type === "warp" ? "▦" : "↻",
    iconColor: d.type === "warp" ? "#3fb96c" : "#e5534b",
    label: labelOf(d.part),
    hidden: !!d.hidden,
    locked: !!d.locked,
    kids,
    toggleHidden: [{ op: "updateDeformer", id: d.id, hidden: !d.hidden } as Op],
    toggleLock: [{ op: "updateDeformer", id: d.id, locked: !d.locked } as Op],
  });
  const partNode = (p: (typeof rig.parts)[number]): Node => ({
    key: `p:${p.id}`,
    kind: "part",
    show: null,
    id: p.id,
    name: p.name || p.id,
    icon: "📁",
    iconColor: "#9aa4ae",
    order: p.drawOrders[0] ?? 500,
    label: labelOf(p.id),
    hidden: p.visible === false,
    locked: !!p.locked,
    kids: () =>
      inTreeOrder([
        ...rig.parts.filter((x) => x.parent === p.id).map(partNode),
        ...rig.deformers.filter((d) => d.part === p.id).map((d) => defNode(d, () => [])),
        ...byFront(meshes.filter(([, a]) => a.live2d.part === p.id)).map(([id, a]) => meshNode(id, a)),
        ...(rig.glue ?? []).filter((g) => g.part === p.id).map(glueNode),
      ]),
    toggleHidden: [{ op: "updatePart", id: p.id, visible: p.visible === false } as Op],
    toggleLock: [{ op: "updatePart", id: p.id, locked: !p.locked } as Op],
  });
  const glueNode = (g: NonNullable<typeof rig.glue>[number]): Node => ({
    key: `g:${g.id}`,
    kind: "glue",
    show: "glue",
    id: g.id,
    name: g.id,
    icon: "✎",
    iconColor: "#4ea1ff",
    label: labelOf(g.part ?? null),
    hidden: false,
    locked: false,
    kids: () => [],
    toggleHidden: [],
    toggleLock: [],
  });
  const defTree = (d: (typeof rig.deformers)[number]): Node =>
    defNode(d, () => inTreeOrder([...rig.deformers.filter((x) => x.parent === d.id).map(defTree), ...byFront(meshes.filter(([, a]) => a.live2d.deformer === d.id)).map(([id, a]) => meshNode(id, a))]));
  const partRoots: Node[] = inTreeOrder([
    ...rig.parts.filter((p) => !p.parent || !partById.has(p.parent)).map(partNode),
    ...rig.deformers.filter((d) => !d.part).map((d) => defNode(d, () => [])),
    ...byFront(meshes.filter(([, a]) => !a.live2d.part)).map(([id, a]) => meshNode(id, a)),
    ...(rig.glue ?? []).filter((g) => !g.part || !partById.has(g.part)).map(glueNode),
  ]);
  const defRoots: Node[] = inTreeOrder([...rig.deformers.filter((d) => !d.parent || !defById.has(d.parent)).map(defTree), ...byFront(meshes.filter(([, a]) => !a.live2d.deformer)).map(([id, a]) => meshNode(id, a))]);

  const out: HTMLElement[] = [];
  out.push(treeKindFilter(m));
  const listed = (n: Node) => !n.show || treeShow[n.show];
  const matches = (n: Node): boolean => (listed(n) && (!q || n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))) || n.kids().some(matches);
  const toggle = (e: MouseEvent, ops: Op[]) => {
    e.stopPropagation();
    void commit(ops);
  };
  let rows: HTMLElement[] = [];
  /** Keys of the nodes with children at and under these nodes. */
  const keysUnder = (ns: Node[]): string[] => ns.flatMap((x) => {
    const k = x.kids();
    return k.length ? [x.key, ...keysUnder(k)] : [];
  });
  let listKeys: string[] = [];
  const walk = (n: Node, depth: number) => {
    if (!matches(n)) return;
    const kids = n.kids();
    // a kind filtered out of the list: its children take its place
    if (!listed(n)) {
      for (const k of kids) walk(k, depth);
      return;
    }
    const expanded = !!kids.length && (!!q || open.has(n.key));
    const inList = listKeys;
    const selected = n.kind === "glue" ? selGlue === n.id : state.sel?.kind === n.kind && state.sel.id === n.id;
    rows.push(
      h(
        "div",
        {
          class: `item l2row${selected ? " selected" : ""}${n.hidden ? " dim" : ""}`,
          onclick: () => {
            select({ kind: n.kind, id: n.id });
            requestDraw();
          },
          ondblclick: () => kids.length && toggleTreeKey(n.key),
          oncontextmenu: (e: MouseEvent) => live2dRowMenu(e, m, n, kids.length ? keysUnder([n]) : [], inList),
        },
        h("span", { class: "label", style: `background:${n.label}` }),
        n.kind === "glue" ? h("span", { class: "eye" }) : h("button", { class: `eye${n.hidden ? " off" : ""}`, title: n.hidden ? "Show" : "Hide", onclick: (e: MouseEvent) => toggle(e, n.toggleHidden) }, "👁"),
        n.kind === "glue" ? h("span", { class: "lock" }) : h("button", { class: `lock${n.locked ? " on" : ""}`, title: n.locked ? "Unlock" : "Lock (not picked in the viewport)", onclick: (e: MouseEvent) => toggle(e, n.toggleLock) }, n.locked ? "🔒" : "○"),
        h("span", { style: `width:${depth * 12}px;flex:none` }),
        h(
          "span",
          {
            class: "caret",
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              if (kids.length) toggleTreeKey(n.key);
            },
          },
          kids.length ? (expanded ? "▾" : "▸") : "",
        ),
        h("span", { class: "ico", style: `color:${n.iconColor}` }, n.icon),
        Object.assign(raw(n.name, "span", "name"), { title: n.name === n.id ? n.id : `${n.name} (${n.id})` }),
        n.order !== undefined ? h("span", { class: "order" }, String(Math.round(n.order))) : "",
      ),
    );
    if (expanded) for (const k of kids) walk(k, depth + 1);
  };
  const list = (title: string, cls: string, roots: Node[], empty: string) => {
    rows = [];
    listKeys = keysUnder(roots);
    const allKeys = listKeys;
    for (const r of roots) walk(r, 0);
    if (!rows.length) rows.push(h("div", { class: "item note" }, q ? "Nothing matches the filter." : empty));
    const adds =
      cls === "parts"
        ? [h("button", { class: "icon small", title: "New part (inside the selected part)", onclick: () => void newLive2DPart() }, "＋")]
        : [
            h("button", { class: "icon small", title: "New warp deformer around the selected art mesh or deformer", onclick: () => void newLive2DDeformer("warp") }, "＋▦"),
            h("button", { class: "icon small", title: "New rotation deformer around the selected art mesh or deformer", onclick: () => void newLive2DDeformer("rotation") }, "＋↻"),
          ];
    const head = h("div", { class: "l2d-list-head", oncontextmenu: (e: MouseEvent) => live2dRowMenu(e, m, null, [], allKeys) }, h("span", {}, title), h("span", { class: "adds" }, ...adds));
    return h("section", { class: `l2d-list ${cls}` }, head, h("div", { class: "l2d-list-body" }, ...rows));
  };
  out.push(
    h(
      "div",
      { class: "l2d-split" },
      list("Parts", "parts", partRoots, "No parts or art meshes."),
      list("Deformers", "deformers", defRoots, "No deformers."),
    ),
  );
  return out;
}

/**
 * Numeric field. Drag the label left/right to scrub (Shift = 10× finer); `live` turns a value into the ops
 * previewed while scrubbing, and the value is committed on release through `onchange`.
 */
function num(label: string, value: number, onchange: (v: number) => void, step = 1, live?: (v: number) => Op[]): HTMLElement {
  const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step)) + 1));
  const input = h("input", { type: "number", value: String(+value.toFixed(3)), step: String(step) });
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onchange(v);
  });
  const name = h("span", { class: "scrub", title: "Drag to change (Shift: fine)" }, label);
  name.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    name.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = Number(input.value) || 0;
    let v = v0;
    const base = state.model;
    const move = (ev: PointerEvent) => {
      v = +(v0 + (ev.clientX - x0) * step * (ev.shiftKey ? 0.05 : 0.5)).toFixed(decimals);
      input.value = String(v);
      if (live && base) {
        try {
          schedulePreview(base, live(v));
        } catch {
          /* invalid intermediate value: keep the last preview */
        }
      }
    };
    const up = () => {
      name.removeEventListener("pointermove", move);
      name.removeEventListener("pointerup", up);
      name.removeEventListener("pointercancel", up);
      if (v !== v0) onchange(v);
      else state.preview = null;
    };
    name.addEventListener("pointermove", move);
    name.addEventListener("pointerup", up);
    name.addEventListener("pointercancel", up);
  });
  return h("label", { class: "field" }, name, input);
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), control);
}

function selectOf(options: Array<[string, string]>, value: string, onchange: (v: string) => void): HTMLSelectElement {
  const s = h("select", {}, ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
  s.addEventListener("change", () => onchange(s.value));
  return s;
}

/** Title row with small action buttons (rename, delete, ...). */
function header(title: string, ...actions: HTMLElement[]): HTMLElement {
  return h("div", { class: "props-head" }, raw(title, "h3"), h("div", { class: "actions" }, ...actions));
}

/** Text that is data (a name, an id): the UI translation leaves it alone. */
function raw(text: string, tag: "span" | "div" | "h3" = "span", cls = ""): HTMLElement {
  const e = h(tag, cls ? { class: cls } : {}, text);
  e.setAttribute("translate", "no");
  return e;
}

const iconBtn = (label: string, title: string, onclick: () => void, extra = "") => h("button", { class: `icon small ${extra}`, title, onclick }, label);

/** Part labels, like Cubism's label colors. */
const LABEL_COLORS = ["#e5534b", "#e0a43a", "#e8d44d", "#3fb96c", "#26b5b5", "#4ea1ff", "#a371f7", "#e04ab8"];

/** A checkbox field that commits ops. */
function l2Check(label: string, on: boolean, ops: (v: boolean) => Op[], title = ""): HTMLElement {
  const c = h("input", { type: "checkbox", checked: on, title });
  c.addEventListener("change", () => void commit(ops(c.checked)));
  return field(label, c);
}

/** With a motion open: the part's opacity at the playhead, keyed there (part opacity tracks). */
function partOpacityKey(m: Model, id: string): HTMLElement[] {
  const anim = state.anim;
  if (!anim) return [];
  const t = localT();
  const keys = m.animations?.[anim]?.partOpacity?.[id];
  const now = sampleTrack(keys, t, (a, b, f) => a + (b - a) * f) ?? (m.live2d?.parts.find((p) => p.id === id)?.visible === false ? 0 : 1);
  return [
    h("div", { class: "section" }, `${anim} @ ${t.toFixed(3)}s`),
    num("opacity key", now, (v) => void commit([{ op: "setPartOpacityKeys", animation: anim, part: id, keys: [{ t: keyTime(), v: Math.max(0, Math.min(1, v)) }], mode: "merge" } as Op], `keyed ${id} opacity at ${t}s`), 0.1),
    h("div", { class: "note" }, keys?.length ? `${keys.length} opacity keys in ${anim}. Parts in a pose group only use them to pick the shown part.` : `No opacity keys in ${anim} yet: a value here adds one at the playhead.`),
  ];
}

// ---------- Live2D objects in the panel: their keys, the keyform at the pinned sliders, new parts and deformers

type L2Obj = { kind: "mesh" | "deformer" | "part" | "glue"; id: string };

/** The keyform grid of a Live2D object. */
function l2Grid(m: Model, o: L2Obj): { params: string[]; keys: number[][] } | null {
  const rig = m.live2d;
  if (o.kind === "mesh") return m.attachments[o.id]?.live2d?.grid ?? null;
  if (o.kind === "deformer") return rig?.deformers.find((d) => d.id === o.id)?.grid ?? null;
  if (o.kind === "part") return rig?.parts.find((p) => p.id === o.id)?.grid ?? null;
  return rig?.glue?.find((g) => g.id === o.id)?.grid ?? null;
}

/**
 * The parameters an object is keyed on, one row each: its keys (click = pin the slider there to edit that keyform,
 * ✕ = stop keying on it, + = a key at the pinned value), and a select to key it on another parameter.
 */
function l2KeyRows(m: Model, id: string, grid: { params: string[]; keys: number[][] }): HTMLElement[] {
  const pinnedAt = (p: string) => (typeof state.params[p] === "number" ? state.params[p] : undefined);
  const pin = (p: string, v: number | undefined) => {
    if (v === undefined) {
      const { [p]: _, ...rest } = state.params;
      state.params = rest;
    } else state.params = { ...state.params, [p]: v };
    refreshPanels();
  };
  const rows = grid.params.map((p, i) => {
    const def = m.parameters?.find((x) => x.id === p);
    const at = pinnedAt(p);
    const keys = grid.keys[i];
    const offKey = at !== undefined && !keys.some((k) => Math.abs(k - at) < 1e-9);
    return h(
      "div",
      { class: "l2d-keyrow" },
      h("div", { class: "head" }, h("span", { title: p }, def?.name ? `${def.name} · ${p}` : p), h("button", { class: "icon small", title: `Stop keying ${id} on ${p} (keeps its look at the default)`, onclick: () => void commit([{ op: "setKeyformKeys", target: id, param: p, keys: null }]) }, "✕")),
      h(
        "div",
        { class: "key-chips" },
        ...keys.map((k) =>
          h("button", { class: `chip${at !== undefined && Math.abs(k - at) < 1e-9 ? " active" : ""}`, title: `Pin ${p} at ${k} and edit this keyform (click again to unpin)`, onclick: () => pin(p, at !== undefined && Math.abs(k - at) < 1e-9 ? undefined : k) }, String(k)),
        ),
        ...(offKey ? [h("button", { class: "chip add", title: `Add a key at the pinned value ${at}`, onclick: () => void commit([{ op: "setKeyformKeys", target: id, param: p, keys: [...keys, at!] }]) }, `+ ${+at!.toFixed(3)}`)] : []),
      ),
    );
  });
  const free = (m.parameters ?? []).filter((p) => !grid.params.includes(p.id) && !p.blendShape);
  const addSel = h(
    "select",
    { title: "Key this object on another parameter at min, default and max (Cubism's Add 3 keys)" },
    h("option", { value: "" }, "+ Key on parameter (min / default / max)…"),
    ...free.map((p) => h("option", { value: p.id }, p.name ? `${p.name} · ${p.id}` : p.id)),
  ) as HTMLSelectElement;
  addSel.addEventListener("change", () => addSel.value && void addThreeKeys(m, id, addSel.value));
  return [h("div", { class: "section" }, "Keys"), ...(rows.length ? rows : [h("div", { class: "note" }, "Not keyed on any parameter yet (one keyform).")]), addSel];
}

/** The values of an object's keyform at the pinned sliders: draw order, colors and opacity, rotation, glue intensity. */
function l2KeyformEditor(m: Model, o: L2Obj): HTMLElement[] {
  const grid = l2Grid(m, o);
  if (!grid) return [];
  const at = keyformAt(m, grid.params);
  let index = -1;
  try {
    index = gridIndexAt(m, grid, at, o.id);
  } catch {
    /* between keys */
  }
  const head = h("div", { class: "section" }, "Keyform");
  if (index < 0) return [head, h("div", { class: "note" }, "The pinned sliders are between this object's keys. Click a key (above, or a key dot in Params) to edit that keyform.")];
  const opOf = (patch: Record<string, unknown>) => [{ op: "setKeyform", target: o.id, at, ...patch } as Op];
  const set = (patch: Record<string, unknown>, what?: string) => void commit(opOf(patch), what);
  const preview = (patch: Record<string, unknown>) => {
    try {
      schedulePreview(state.model!, opOf(patch));
    } catch {
      /* invalid intermediate value */
    }
  };
  const where = grid.params.length ? grid.params.map((p) => `${p} ${at[p]}`).join(", ") : "its only keyform";
  const out: HTMLElement[] = [head];
  const rig = m.live2d!;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (o.kind === "part") {
    const p = rig.parts.find((x) => x.id === o.id)!;
    out.push(num("draw order", p.drawOrders[index] ?? 500, (v) => set({ drawOrder: clamp(Math.round(v), 0, 1000) }), 1));
    out.push(h("div", { class: "note" }, "Its place among the items of the draw-order group it is in (Cubism's part draw order)."));
  } else if (o.kind === "glue") {
    const g = rig.glue!.find((x) => x.id === o.id)!;
    out.push(num("intensity", g.intensity[index] ?? 1, (v) => set({ intensity: clamp(v, 0, 1) }), 0.05, (v) => opOf({ intensity: clamp(v, 0, 1) })));
    out.push(h("div", { class: "note" }, "How strongly the glued vertex pairs pull together (0 = not at all, 1 = fully)."));
  } else {
    const d = o.kind === "deformer" ? rig.deformers.find((x) => x.id === o.id)! : null;
    const form = (d ? d.forms[index] : m.attachments[o.id].live2d!.forms[index]) as { opacity?: number; drawOrder?: number; multiply?: [number, number, number]; screen?: [number, number, number] };
    if (o.kind === "mesh") out.push(num("draw order", form.drawOrder ?? 500, (v) => set({ drawOrder: clamp(Math.round(v), 0, 1000) }), 1));
    if (d?.type === "rotation") {
      const f = d.forms[index];
      const flip = (label: string, key: "reflectX" | "reflectY", title: string) => {
        const c = h("input", { type: "checkbox", checked: !!f[key], title });
        c.addEventListener("change", () => set({ [key]: c.checked }));
        return field(label, c);
      };
      out.push(
        h("div", { class: "grid2" }, num("angle °", f.angle, (v) => set({ angle: v }), 1, (v) => opOf({ angle: v })), num("scale", f.scale, (v) => set({ scale: Math.max(1e-3, v) }), 0.05, (v) => opOf({ scale: Math.max(1e-3, v) }))),
        h("div", { class: "grid2" }, flip("reflect X", "reflectX", "Mirror its children horizontally"), flip("reflect Y", "reflectY", "Mirror its children vertically")),
      );
    }
    const toHex = (c: [number, number, number] | undefined, dflt: string) => (c ? "#" + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0")).join("") : dflt);
    const fromHex = (v: string): [number, number, number] => [1, 3, 5].map((i) => +(parseInt(v.slice(i, i + 2), 16) / 255).toFixed(4)) as [number, number, number];
    // moc3 keeps multiply / screen as RGB: the multiply picker's alpha is the keyform opacity (the slider below)
    const alphaOf = (c: string) => (c.length === 9 ? +(parseInt(c.slice(7, 9), 16) / 255).toFixed(3) : 1);
    const mul = colorSwatch({
      value: colorHex(toHex(form.multiply, "#ffffff"), form.opacity ?? 1),
      alpha: true,
      title: "Multiply color (tints) and opacity",
      onInput: (c) => preview({ multiply: fromHex(c), opacity: alphaOf(c) }),
      onChange: (c) => set({ multiply: fromHex(c), opacity: alphaOf(c) }, `${o.id} multiply color / opacity`),
    });
    const scr = colorSwatch({
      value: toHex(form.screen, "#000000"),
      alpha: false,
      title: "Screen color (lightens; black = none)",
      onInput: (c) => preview({ screen: fromHex(c) }),
      onChange: (c) => set({ screen: fromHex(c) }, `${o.id} screen color`),
    });
    const alpha = form.opacity ?? 1;
    const op = h("input", { type: "range", min: "0", max: "100", step: "1", value: String(Math.round(alpha * 100)), title: "Opacity" }) as HTMLInputElement;
    const pct = h("span", { class: "value" }, `${Math.round(alpha * 100)}%`);
    op.addEventListener("input", () => ((pct.textContent = `${op.value}%`), preview({ opacity: Number(op.value) / 100 })));
    op.addEventListener("change", () => set({ opacity: Number(op.value) / 100 }, `${o.id} opacity ${op.value}%`));
    out.push(
      h(
        "div",
        { class: "color-editor" },
        h("div", { class: "row" }, h("span", { class: "dim" }, "multiply"), mul, h("span", { class: "dim" }, "screen"), scr, iconBtn("↺", "No tint (white multiply, black screen)", () => set({ multiply: null, screen: null }, `${o.id} colors reset`))),
        h("div", { class: "row" }, h("span", { class: "dim" }, "opacity"), op, pct),
      ),
    );
  }
  out.push(h("div", { class: "note" }, `Set on the keyform at ${where}. Other keys keep their own values and it blends between them; motions change it through the parameters.`));
  return out;
}

/** Parts a new object can go in, and deformers it can go under (excluding `self` and what is below it). */
function l2PartOptions(m: Model): Array<[string, string]> {
  return [["", "(none)"], ...(m.live2d?.parts ?? []).map((x) => [x.id, x.name || x.id] as [string, string])];
}

/** The part and deformer of the selected Live2D object (where a new one goes by default). */
function l2SelectedPlace(m: Model): { part: string | null; deformer: string | null; child: string | null } {
  const rig = m.live2d;
  const sel = state.sel;
  const mesh = selectedLive2DMesh(m);
  if (mesh) return { part: mesh.att.live2d!.part, deformer: mesh.att.live2d!.deformer, child: mesh.id };
  if (sel?.kind === "deformer") {
    const d = rig?.deformers.find((x) => x.id === sel.id);
    if (d) return { part: d.part, deformer: d.parent, child: d.id };
  }
  if (sel?.kind === "part") return { part: sel.id, deformer: null, child: null };
  return { part: null, deformer: null, child: null };
}

const freeId = (taken: Set<string>, base: string) => {
  let i = 1;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
};

/** New Live2D part (Cubism's Create Part), inside the selected part. */
async function newLive2DPart(): Promise<void> {
  const m = state.model;
  if (!m?.live2d) return;
  const taken = new Set(m.live2d.parts.map((p) => p.id));
  const place = l2SelectedPlace(m);
  const r = await dialog({
    title: "New Part",
    fields: [
      { name: "id", label: "Id", value: freeId(taken, "Part") },
      { name: "name", label: "Name (optional)", value: "" },
      { name: "parent", label: "Inside", type: "select", value: place.part ?? "", options: [["", "(root)"], ...m.live2d.parts.map((x) => [x.id, x.name || x.id] as [string, string])] },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Create", value: "ok", primary: true },
    ],
    validate: (x) => {
      const id = String(x.values.id).trim();
      if (!ID_RE.test(id)) return "Ids cannot contain quotes or backslashes, or start/end with a space";
      return taken.has(id) ? `"${id}" exists` : null;
    },
  });
  if (!r) return;
  const id = String(r.values.id).trim();
  const name = String(r.values.name).trim();
  if (await commit([{ op: "addPart", id, parent: String(r.values.parent) || null, ...(name ? { name } : {}) } as Op])) select({ kind: "part", id });
}

/**
 * New Live2D deformer (Cubism's Create Warp / Rotation Deformer): around the selected art mesh or deformer, which
 * moves under it keeping its look; the new one takes its place (same parent and part).
 */
async function newLive2DDeformer(type: "warp" | "rotation"): Promise<void> {
  const m = state.model;
  if (!m?.live2d) return;
  const place = l2SelectedPlace(m);
  if (!place.child) return void (await alertDialog(type === "warp" ? "New Warp Deformer" : "New Rotation Deformer", "Select the art mesh or deformer it should hold first (in the viewport or the lists): the new deformer is sized around it and takes its place."));
  const taken = new Set(m.live2d.deformers.map((d) => d.id));
  const r = await dialog({
    title: type === "warp" ? "New Warp Deformer" : "New Rotation Deformer",
    message: `Holds ${place.child} (it keeps its look).`,
    fields: [
      { name: "id", label: "Id", value: freeId(taken, type === "warp" ? "Warp" : "Rotation") },
      ...(type === "warp"
        ? ([
            { name: "cols", label: "Columns", type: "number", value: 3, step: 1, min: 1 },
            { name: "rows", label: "Rows", type: "number", value: 3, step: 1, min: 1 },
          ] as Field[])
        : []),
      { name: "parent", label: "Under", type: "select", value: place.deformer ?? "", options: [["", "(canvas)"], ...m.live2d.deformers.filter((d) => d.id !== place.child).map((d) => [d.id, d.id] as [string, string])] },
      { name: "part", label: "Part", type: "select", value: place.part ?? "", options: l2PartOptions(m) },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Create", value: "ok", primary: true },
    ],
    validate: (x) => {
      const id = String(x.values.id).trim();
      if (!ID_RE.test(id)) return "Ids cannot contain quotes or backslashes, or start/end with a space";
      if (taken.has(id)) return `"${id}" exists`;
      if (type === "warp" && !(Number.isInteger(Number(x.values.cols)) && Number(x.values.cols) >= 1 && Number.isInteger(Number(x.values.rows)) && Number(x.values.rows) >= 1)) return "Columns and rows must be whole numbers ≥ 1";
      return null;
    },
  });
  if (!r) return;
  const id = String(r.values.id).trim();
  const op = {
    op: "addDeformer",
    id,
    type,
    parent: String(r.values.parent) || null,
    part: String(r.values.part) || null,
    children: [place.child],
    ...(type === "warp" ? { cols: Number(r.values.cols), rows: Number(r.values.rows) } : {}),
  } as Op;
  if (await commit([op])) select({ kind: "deformer", id });
}

/** Properties of a glue (selected in the Parts list): the meshes it joins, its keys and intensity. */
function glueProps(m: Model, id: string): HTMLElement[] {
  const g = m.live2d!.glue!.find((x) => x.id === id)!;
  return [
    header(g.id),
    raw(`glue · ${g.a} + ${g.b}`, "div", "sub"),
    h("div", { class: "note" }, `${g.pairs.length / 2} glued vertex pairs.`),
    ...l2KeyRows(m, g.id, g.grid),
    ...l2KeyformEditor(m, { kind: "glue", id }),
  ];
}

/** Properties of a Live2D part or deformer (selected in the Parts tree). */
function live2dObjectProps(m: Model, kind: "part" | "deformer", id: string): HTMLElement[] {
  const rig = m.live2d!;
  const check = l2Check;
  if (kind === "part") {
    const p = rig.parts.find((x) => x.id === id)!;
    const up = (patch: Record<string, unknown>): Op[] => [{ op: "updatePart", id, ...patch } as Op];
    const below = new Set<string>([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of rig.parts) if (x.parent && below.has(x.parent) && !below.has(x.id)) (below.add(x.id), (grew = true));
    }
    const nameInput = h("input", { type: "text", value: p.name ?? "" });
    nameInput.addEventListener("change", () => void commit(up({ name: nameInput.value.trim() })));
    const meshes = Object.values(m.attachments).filter((a) => a.live2d?.part === id).length;
    const defs = rig.deformers.filter((d) => d.part === id).length;
    const subs = rig.parts.filter((x) => x.parent === id).length;
    return [
      header(p.name || p.id, iconBtn("🗑", "Delete part (its contents move to the parent part)", async () => {
        if (await confirmDialog("Delete part", `Delete part ${p.id}? Its sub-parts, deformers and art meshes move to ${p.parent ?? "the root"}.`, "Delete", true)) {
          if (await commit([{ op: "removePart", id } as Op])) select(null);
        }
      }, "danger")),
      raw(`part · ${p.id}`, "div", "sub"),
      h("div", { class: "note" }, `${subs} sub-parts, ${defs} deformers, ${meshes} art meshes.`),
      field("name", nameInput),
      field("parent", selectOf([["", "(root)"], ...rig.parts.filter((x) => !below.has(x.id)).map((x) => [x.id, x.name || x.id] as [string, string])], p.parent ?? "", (v) => void commit(up({ parent: v || null })))),
      check("visible", p.visible !== false, (v) => up({ visible: v }), "Opacity 1 at rest (off: 0, also at runtime)"),
      check("locked", !!p.locked, (v) => up({ locked: v }), "Nothing in the part is picked in the viewport"),
      check("disabled", !!p.disabled, (v) => up({ disabled: v }), "Nothing in the part is drawn (Cubism's disabled parts)"),
      field(
        "label",
        h(
          "div",
          { class: "label-swatches" },
          h("button", { class: p.label ? "" : "active", title: "No label", style: "background:transparent;border:1px dashed var(--line)", onclick: () => void commit(up({ label: null })) }),
          ...LABEL_COLORS.map((c) => h("button", { class: p.label === c ? "active" : "", style: `background:${c}`, onclick: () => void commit(up({ label: c })) })),
        ),
      ),
      ...partOpacityKey(m, id),
      ...l2KeyRows(m, id, p.grid),
      ...l2KeyformEditor(m, { kind: "part", id }),
    ];
  }
  const d = rig.deformers.find((x) => x.id === id)!;
  const up = (patch: Record<string, unknown>): Op[] => [{ op: "updateDeformer", id, ...patch } as Op];
  const below = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of rig.deformers) if (x.parent && below.has(x.parent) && !below.has(x.id)) (below.add(x.id), (grew = true));
  }
  const childDefs = rig.deformers.filter((x) => x.parent === id).length;
  const childMeshes = Object.values(m.attachments).filter((a) => a.live2d?.deformer === id).length;
  return [
    header(d.id, iconBtn("🗑", "Delete deformer (its children move to its parent, keeping their look)", async () => {
      if (await confirmDialog("Delete deformer", `Delete deformer ${d.id}? Its children move to ${d.parent ?? "the canvas"} and keep their look.`, "Delete", true)) {
        if (await commit([{ op: "removeDeformer", id } as Op])) select(null);
      }
    }, "danger")),
    h("div", { class: "sub" }, d.type === "warp" ? `warp deformer · ${d.cols} × ${d.rows}` : "rotation deformer"),
    h("div", { class: "note" }, `${childDefs} child deformers, ${childMeshes} art meshes.`),
    field("parent", selectOf([["", "(canvas)"], ...rig.deformers.filter((x) => !below.has(x.id)).map((x) => [x.id, x.id] as [string, string])], d.parent ?? "", (v) => void commit(up({ parent: v || null })))),
    field("part", selectOf([["", "(none)"], ...rig.parts.map((x) => [x.id, x.name || x.id] as [string, string])], d.part ?? "", (v) => void commit(up({ part: v || null })))),
    check("visible", !d.hidden, (v) => up({ hidden: !v }), "Shown in the editor (Cubism's visible flag; the runtime ignores it)"),
    check("locked", !!d.locked, (v) => up({ locked: v })),
    check("disabled", !!d.disabled, (v) => up({ disabled: v }), "Its children are not deformed by it (Cubism's disabled deformers)"),
    ...(d.type === "warp" ? [check("bilinear", !!d.bilinear, (v) => up({ bilinear: v }), "Bilinear cells (Cubism 3.3+); off: two triangles per cell")] : []),
    ...l2KeyRows(m, id, d.grid),
    ...l2KeyformEditor(m, { kind: "deformer", id }),
  ];
}

// ---------- rename / delete (Edit menu, F2, panel buttons)

async function renameSelected(): Promise<void> {
  const m = state.model;
  const sel = state.sel;
  if (!m || (sel?.kind !== "bone" && sel?.kind !== "slot")) return;
  const kind = sel.kind;
  const taken = new Set(kind === "bone" ? m.bones.map((b) => b.id) : m.slots.map((s) => s.id));
  const r = await dialog({
    title: `Rename ${kind}`,
    fields: [{ name: "to", label: "New name", value: sel.id, hint: "Animations, parameters, weights and constraints that use it are updated." }],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Rename", value: "ok", primary: true },
    ],
    validate: (x) => {
      const to = String(x.values.to).trim();
      if (!ID_RE.test(to)) return "Names cannot contain quotes or backslashes, or start/end with a space";
      return to !== sel.id && taken.has(to) ? `"${to}" is already used` : null;
    },
  });
  const to = r ? String(r.values.to).trim() : "";
  if (!to || to === sel.id) return;
  if (await commit([{ op: kind === "bone" ? "renameBone" : "renameSlot", id: sel.id, to }], `renamed ${sel.id} to ${to}`)) select({ kind, id: to });
}

/**
 * Deleting a bone in the editor is forgiving: its children, slots and weights move to its parent (the core
 * removeBone op refuses instead, which is what an agent wants). Constraints and parameters still block it.
 */
function deleteBoneOps(m: Model, id: string): Op[] {
  const bone = m.bones.find((b) => b.id === id)!;
  const parent = bone.parent!;
  const ops: Op[] = [];
  for (const kid of m.bones.filter((b) => b.parent === id)) ops.push({ op: "updateBone", id: kid.id, parent });
  for (const s of m.slots.filter((s) => s.bone === id)) ops.push({ op: "updateSlot", id: s.id, bone: parent });
  for (const [attId, att] of Object.entries(m.attachments)) {
    if (!att.weights.some((w) => w.some(([b]) => b === id))) continue;
    const weights = att.weights.map((w) => {
      const merged = new Map<string, number>();
      for (const [b, x] of w) merged.set(b === id ? parent : b, (merged.get(b === id ? parent : b) ?? 0) + x);
      return [...merged] as Array<[string, number]>;
    });
    ops.push({ op: "setWeights", attachment: attId, weights });
  }
  ops.push({ op: "removeBone", id });
  return ops;
}

/** New empty slot (Spine): on the selected bone (or the root), in front of the others. */
async function newSlot(): Promise<void> {
  const m = state.model;
  if (!m) return;
  const taken = new Set(m.slots.map((s) => s.id));
  const bone = state.sel?.kind === "bone" ? state.sel.id : (m.bones.find((b) => b.parent === null)?.id ?? "root");
  const r = await dialog({
    title: "New Slot",
    fields: [
      { name: "id", label: "Id", value: freeId(taken, "slot") },
      { name: "bone", label: "Bone", type: "select", value: bone, options: m.bones.map((b) => [b.id, b.id] as [string, string]) },
      { name: "attachment", label: "Attachment", type: "select", value: "", options: [["", "(none)"], ...Object.keys(m.attachments).map((a) => [a, a] as [string, string])] },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Create", value: "ok", primary: true },
    ],
    validate: (x) => {
      const id = String(x.values.id).trim();
      if (!ID_RE.test(id)) return "Ids cannot contain quotes or backslashes, or start/end with a space";
      return taken.has(id) ? `"${id}" exists` : null;
    },
  });
  if (!r) return;
  const id = String(r.values.id).trim();
  if (await commit([{ op: "addSlot", id, bone: String(r.values.bone), attachment: String(r.values.attachment) || null }])) select({ kind: "slot", id });
}

/** A chain of bones from the tip of a bone onward, along its direction (for hair, tails, ribbons). */
async function newBoneChain(parent: string): Promise<void> {
  const m = state.model;
  const bp = lastPose?.byId.get(parent) ?? (m ? setupPose(m).byId.get(parent) : undefined);
  if (!m || !bp) return;
  const ends = boneEnds(setupPose(m).byId.get(parent) ?? bp);
  const dir = Math.atan2(ends.end[1] - ends.start[1], ends.end[0] - ends.start[0]);
  const taken = new Set(m.bones.map((b) => b.id));
  const r = await dialog({
    title: "New Bone Chain",
    message: `From the tip of ${parent}, in the setup pose.`,
    fields: [
      { name: "id", label: "Name (bones are name_1, name_2, …)", value: freeId(new Set(m.bones.map((b) => b.id.replace(/_\d+$/, ""))), "chain") },
      { name: "count", label: "Bones", type: "number", value: 3, step: 1, min: 1 },
      { name: "length", label: "Total length", type: "number", value: Math.round(Math.max(bp.length, 20) * 3), step: 1, min: 1 },
      { name: "angle", label: "Direction (degrees, world)", type: "number", value: Math.round((dir * 180) / Math.PI), step: 1 },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Create", value: "ok", primary: true },
    ],
    validate: (x) => {
      const id = String(x.values.id).trim();
      const n = Number(x.values.count);
      if (!ID_RE.test(id)) return "Names cannot contain quotes or backslashes, or start/end with a space";
      if (!(Number.isInteger(n) && n >= 1 && n <= 32)) return "Bones: a whole number from 1 to 32";
      if (!(Number(x.values.length) > 0)) return "The length must be above 0";
      for (let i = 1; i <= n; i++) if (taken.has(`${id}_${i}`)) return `"${id}_${i}" exists`;
      return null;
    },
  });
  if (!r) return;
  const id = String(r.values.id).trim();
  const a = (Number(r.values.angle) * Math.PI) / 180;
  const len = Number(r.values.length);
  const start = ends.end;
  const end: Vec2 = [+(start[0] + Math.cos(a) * len).toFixed(3), +(start[1] + Math.sin(a) * len).toFixed(3)];
  if (await commit([{ op: "addBoneChain", id, parent, start: [+start[0].toFixed(3), +start[1].toFixed(3)], end, count: Number(r.values.count) }])) select({ kind: "bone", id: `${id}_1` });
}

/** Deletes an attachment (mesh, clipping or bounding box) from the model: slots, skins and deform keys drop it. */
async function deleteAttachment(id: string): Promise<void> {
  const m = state.model;
  if (!m) return;
  const users = m.slots.filter((s) => s.attachment === id).map((s) => s.id);
  if (!(await confirmDialog("Delete attachment", `Delete the attachment "${id}"?${users.length ? ` Slots showing it (${users.join(", ")}) become empty.` : ""} Its deform keys and skin entries go too. (Undo brings it back.)`, "Delete", true))) return;
  if (!(await commit([{ op: "removeAttachment", id }], `deleted attachment ${id}`))) await alertDialog("Cannot delete", statusEl.textContent ?? "");
}

async function deleteSelected(): Promise<void> {
  const m = state.model;
  const sel = state.sel;
  if (!m || !sel || sel.kind === "param") return;
  let ops: Op[];
  let message: string;
  if (sel.kind === "bone") {
    const bone = m.bones.find((b) => b.id === sel.id)!;
    if (bone.parent === null) return alertDialog("Cannot delete", "The root bone cannot be deleted.");
    const kids = m.bones.filter((b) => b.parent === sel.id).length;
    const slots = m.slots.filter((s) => s.bone === sel.id).length;
    message = `Delete bone "${sel.id}"?` + (kids || slots ? ` Its ${kids} child bone(s) and ${slots} slot(s) move to "${bone.parent}", and its weights go to "${bone.parent}".` : "");
    ops = deleteBoneOps(m, sel.id);
  } else if (sel.kind === "slot") {
    message = `Delete slot "${sel.id}"? The mesh stays in the model's attachments.`;
    ops = [{ op: "removeSlot", id: sel.id }];
  } else if (sel.kind === "ik") {
    message = `Delete IK constraint "${sel.id}"?`;
    ops = [{ op: "removeIk", id: sel.id }];
  } else if (constraintKindOf(sel.kind)) {
    message = `Delete ${constraintKindOf(sel.kind)} constraint "${sel.id}"?`;
    ops = [{ op: "removeConstraint", kind: constraintKindOf(sel.kind), id: sel.id } as Op];
  } else if (sel.kind === "skin") {
    message = `Delete skin "${sel.id}"? Its attachments stay in the model.`;
    ops = [{ op: "removeSkin", name: sel.id } as Op];
  } else if (sel.kind === "event") {
    message = `Delete event "${sel.id}" and its keys?`;
    ops = [{ op: "setEvent", name: sel.id, remove: true } as Op];
  } else {
    return;
  }
  if (!(await confirmDialog("Delete", `${message} (Undo brings it back.)`, "Delete", true))) return;
  if (await commit(ops, `deleted ${sel.kind} ${sel.id}`)) select(null);
  else await alertDialog("Cannot delete", statusEl.textContent ?? "");
}

/** Draw order buttons: the setup order, or with a Spine animation open a draw-order key at the playhead. */
function slotOrderFields(m: Model, slotId: string): HTMLElement[] {
  const anim = modelTarget(m) === "spine" && state.anim ? m.animations?.[state.anim] : undefined;
  if (!anim) {
    const index = m.slots.findIndex((x) => x.id === slotId);
    return [
      field(
        "order",
        h(
          "div",
          { class: "pair" },
          h("button", { onclick: () => commit([{ op: "moveSlot", id: slotId, index: index + 1 }]), disabled: index === m.slots.length - 1, title: "Draw later (in front)" }, "Forward"),
          h("button", { onclick: () => commit([{ op: "moveSlot", id: slotId, index: Math.max(0, index - 1) }]), disabled: index === 0, title: "Draw earlier (behind)" }, "Back"),
        ),
      ),
    ];
  }
  const t = localT();
  const order = applyDrawOrder(m.slots, anim.drawOrder ?? [], t).map((x) => x.id);
  const at = order.indexOf(slotId);
  const keyOrder = (to: number) => {
    const next = order.filter((x) => x !== slotId);
    next.splice(to, 0, slotId);
    const setup = new Map(m.slots.map((x, i) => [x.id, i]));
    const offsets = next.map((id, i) => [id, i - setup.get(id)!] as [string, number]).filter(([, d]) => d !== 0);
    void commit([{ op: "setDrawOrderKeys", animation: state.anim!, keys: [{ t: keyTime(), offsets }], mode: "merge" }], `keyed the draw order at ${t}s`);
  };
  const keyed = (anim.drawOrder ?? []).some((k) => Math.abs(k.t - t) < 1e-4);
  return [
    field(
      "order (key)",
      h(
        "div",
        { class: "pair" },
        h("button", { onclick: () => keyOrder(at + 1), disabled: at === order.length - 1, title: `Key: draw later (in front) from ${t.toFixed(3)}s in ${state.anim}` }, "Forward"),
        h("button", { onclick: () => keyOrder(Math.max(0, at - 1)), disabled: at === 0, title: `Key: draw earlier (behind) from ${t.toFixed(3)}s in ${state.anim}` }, "Back"),
        ...(keyed ? [h("button", { title: "Back to the setup order from here (a key without changes)", onclick: () => void commit([{ op: "setDrawOrderKeys", animation: state.anim!, keys: [{ t: keyTime(), offsets: [] }], mode: "merge" }]) }, "Setup")] : []),
      ),
    ),
    h("div", { class: "note" }, `Draw position ${at + 1} of ${order.length} at the playhead; the buttons key the draw order (Spine draw-order timeline).`),
  ];
}

// ---------- slot appearance

/** "#rrggbb" + alpha 0..1 -> "#rrggbb" or "#rrggbbaa". */
function colorHex(rgb: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return a === 255 ? rgb.toLowerCase() : rgb.toLowerCase() + a.toString(16).padStart(2, "0");
}
function splitColor(c: string): { rgb: string; alpha: number } {
  const hex = c.replace("#", "");
  return { rgb: "#" + hex.slice(0, 6), alpha: hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
}

/** Slot color at the playhead: the animation's color key in effect, else the setup color. */
function slotColorNow(m: Model, slotId: string): string {
  const slot = m.slots.find((s) => s.id === slotId)!;
  const keys = state.anim ? m.animations?.[state.anim]?.slots?.[slotId]?.color : undefined;
  if (!keys?.length) return slot.color;
  const t = localT();
  let v = keys[0].v;
  for (const k of keys) if (k.t <= t + 1e-6) v = k.v;
  return v ?? slot.color;
}

function paintSpineSlotTreeRow(row: HTMLElement, color: string): void {
  const icon = row.querySelector<HTMLElement>(".spine-icon");
  if (!icon) return;
  const tint = splitColor(color);
  icon.style.color = tint.rgb.toLowerCase() === "#ffffff" ? "" : tint.rgb;
  icon.style.opacity = tint.alpha < 1 ? String(Math.max(0.35, tint.alpha)) : "";
  icon.title = color;
}

function previewSpineSlotTreeColor(slotId: string, color: string): void {
  for (const row of $("tree").querySelectorAll<HTMLElement>(".spine-slot-row")) {
    if (row.dataset.slotId === slotId) paintSpineSlotTreeRow(row, color);
  }
}

/** Slot attachment at the playhead: the animation's attachment key in effect, else the setup one. */
function slotAttachmentNow(m: Model, slotId: string): string | null {
  const slot = m.slots.find((s) => s.id === slotId)!;
  const keys = state.anim ? m.animations?.[state.anim]?.slots?.[slotId]?.attachment : undefined;
  if (!keys?.length) return slot.attachment;
  const t = localT();
  let v: string | null | undefined;
  for (const k of keys) if (k.t <= t + 1e-6) v = k.v;
  return v === undefined ? slot.attachment : v;
}

/** Remembers what a hidden slot showed so the eye toggle can bring it back. */
const hiddenAttachment = new Map<string, string>();

/** Time for a key set from a panel: stops playback and puts the playhead on a frame first (keys land where you see them). */
function keyTime(): number {
  if (state.playing) {
    state.playing = false;
    updatePlayButton();
  }
  const fps = timeline?.fps ?? 30;
  const t = +(Math.round(localT() * fps) / fps).toFixed(4);
  const a = animDef();
  if (a && Math.abs(localT() - t) > 1e-9) state.time += t - localT();
  return t;
}

function slotColorOps(slotId: string, color: string, t = state.anim ? localT() : 0): Op[] {
  if (!state.anim) return [{ op: "updateSlot", id: slotId, color }];
  return [{ op: "setSlotKeys", animation: state.anim, slot: slotId, channel: "color", keys: [{ t, v: color }], mode: "merge" }];
}

/** Shows / hides a slot: in Setup the slot itself, with an animation an attachment key at the playhead. */
function slotAttachmentOps(slotId: string, attachment: string | null): Op[] {
  if (!state.anim) return [{ op: "updateSlot", id: slotId, attachment }];
  return [{ op: "setSlotKeys", animation: state.anim, slot: slotId, channel: "attachment", keys: [{ t: keyTime(), v: attachment }], mode: "merge" }];
}

/** Picks an event for an event key: an existing one or a new name (defined first). Null when cancelled. */
async function pickEvent(current?: string): Promise<string | null> {
  const m = state.model;
  if (!m) return null;
  const names = Object.keys(m.events ?? {});
  const r = await dialog({
    title: "Event key",
    message: "Events fire at their key time (sounds, effects, hit frames...). Pick one or name a new one.",
    fields: [
      ...(names.length ? [{ name: "pick", label: "Event", type: "select" as const, value: current && names.includes(current) ? current : names[0], options: [...names.map((n) => [n, n] as [string, string]), ["", "New event…"] as [string, string]] }] : []),
      { name: "name", label: names.length ? "New event name (with New event…)" : "New event name", value: "" },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "OK", value: "ok", primary: true },
    ],
    validate: (x) => {
      if (x.values.pick) return null;
      const n = String(x.values.name ?? "").trim();
      return n && ID_RE.test(n) ? null : "Type a name for the new event";
    },
  });
  if (!r) return null;
  if (r.values.pick) return String(r.values.pick);
  const name = String(r.values.name).trim();
  if (!m.events?.[name] && !(await commit([{ op: "setEvent", name } as Op], `new event ${name}`))) return null;
  return name;
}

function colorEditor(m: Model, slotId: string): HTMLElement {
  let cur = slotColorNow(m, slotId);
  const { alpha } = splitColor(cur);
  const opacity = h("input", { type: "range", min: "0", max: "100", step: "1", value: String(Math.round(alpha * 100)), title: "Opacity" }) as HTMLInputElement;
  const pct = h("span", { class: "value" }, `${Math.round(alpha * 100)}%`);
  const hex = h("input", { value: cur, class: "hex", spellcheck: false }) as HTMLInputElement;
  const preview = (c: string) => {
    hex.value = c;
    if (modelTarget(m) === "spine") previewSpineSlotTreeColor(slotId, c);
    const a = splitColor(c).alpha;
    opacity.value = String(Math.round(a * 100));
    pct.textContent = `${opacity.value}%`;
    try {
      schedulePreview(state.model!, slotColorOps(slotId, c));
    } catch {
      /* ignore */
    }
  };
  const save = (c: string) => {
    cur = c;
    const t = state.anim ? keyTime() : 0;
    void commit(slotColorOps(slotId, c, t), state.anim ? `keyed ${slotId} color at ${t}s` : `${slotId} color ${c}`).then((ok) => {
      if (!ok) refreshTree();
    });
  };
  const swatch = colorSwatch({ value: cur, alpha: true, title: "Tint (multiplies the texture) and opacity", onInput: preview, onChange: (c) => (preview(c), save(c)) });
  const withOpacity = () => colorHex(splitColor(cur).rgb, Number(opacity.value) / 100);
  opacity.addEventListener("input", () => preview(withOpacity()));
  opacity.addEventListener("change", () => save(withOpacity()));
  hex.addEventListener("change", () => {
    const v = hex.value.trim().replace(/^([^#])/, "#$1");
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) return status("color must be #rrggbb or #rrggbbaa", true);
    preview(v.toLowerCase());
    save(v.toLowerCase());
  });
  const reset = iconBtn("↺", state.anim ? "Key white (no tint) at the playhead" : "Reset to white", () => void commit(slotColorOps(slotId, "#ffffff", state.anim ? keyTime() : 0)));
  return h(
    "div",
    { class: "color-editor" },
    h("div", { class: "row" }, swatch, hex, reset),
    h("div", { class: "row" }, h("span", { class: "dim" }, "opacity"), opacity, pct),
  );
}

/** Spine two-color tint: the dark color (setup, or a key at the playhead with an animation). */
function darkEditor(m: Model, slotId: string): HTMLElement[] {
  const slot = m.slots.find((s) => s.id === slotId)!;
  const summary = h("summary", {}, "Two-color tint (optional)");
  const explain = h("div", { class: "note" }, "Spine two-color tint colors an image's dark pixels separately. Standard Color above is enough for most slots.");
  if (!slot.dark) {
    return [
      h("details", { class: "spine-dark" }, summary, explain,
        h("div", { class: "row" }, h("button", { onclick: () => void commit([{ op: "updateSlot", id: slotId, dark: "#000000" }]), title: "Spine's tint black: the image's dark parts take a second color" }, "Add dark color"))),
    ];
  }
  const keys = state.anim ? m.animations?.[state.anim]?.slots?.[slotId]?.dark : undefined;
  let cur = slot.dark;
  if (keys?.length) for (const k of keys) if (k.t <= localT() + 1e-6) cur = k.v.slice(0, 7);
  const ops = (c: string, t: number): Op[] =>
    state.anim ? [{ op: "setSlotKeys", animation: state.anim, slot: slotId, channel: "dark", keys: [{ t, v: c }], mode: "merge" }] : [{ op: "updateSlot", id: slotId, dark: c }];
  const preview = (c: string) => {
    try {
      schedulePreview(state.model!, ops(c.slice(0, 7), state.anim ? localT() : 0));
    } catch {
      /* ignore */
    }
  };
  const save = (c: string) => {
    const t = state.anim ? keyTime() : 0;
    void commit(ops(c.slice(0, 7), t), state.anim ? `keyed ${slotId} dark color at ${t}s` : `${slotId} dark color ${c}`);
  };
  const swatch = colorSwatch({ value: cur, alpha: false, title: "The color the image's dark parts take (black: none)", onInput: preview, onChange: (c) => (preview(c), save(c)) });
  const remove = iconBtn("✕", "Remove the dark color (plain tint)", () => void commit([{ op: "updateSlot", id: slotId, dark: null }]));
  return [h("details", { class: "spine-dark", open: true }, summary, explain,
    ...(state.anim ? [h("div", { class: "section" }, `Dark color — keyed at ${localT().toFixed(3)}s in ${state.anim}`)] : []),
    h("div", { class: "color-editor" }, h("div", { class: "row" }, swatch, raw(cur, "span", "dim"), ...(state.anim ? [] : [remove]))))];
}

/** Spine clipping attachment shown by a slot: what it clips and how. */
function clippingEditor(m: Model, id: string): HTMLElement[] {
  const c = m.clippings![id];
  const up = (patch: Record<string, unknown>) => void commit([{ op: "updateClipping", id, ...patch } as Op]);
  const check = (label: string, on: boolean, set: (v: boolean) => void, title: string) => {
    const box = h("input", { type: "checkbox", checked: on }) as HTMLInputElement;
    box.addEventListener("change", () => set(box.checked));
    return h("label", { class: "check", title }, box, " ", label);
  };
  return [
    h("div", { class: "section" }, "Clipping"),
    h("div", { class: "sub" }, c.inverse ? `${c.vertices.length}-point polygon: the slots above this one are drawn only outside it` : `${c.vertices.length}-point polygon: the slots above this one are drawn only inside it`),
    field("clips up to", selectOf([["", "(end of draw order)"], ...m.slots.map((s) => [s.id, s.id] as [string, string])], c.end ?? "", (v) => up({ end: v || null }))),
    check("convex", !!c.convex, (v) => up({ convex: v }), "Clip with the polygon's convex hull"),
    check("inverse", !!c.inverse, (v) => up({ inverse: v }), "Draw only outside the polygon (its convex hull)"),
  ];
}

/** Spine bounding box shown by a slot: a hit-test polygon for games (never drawn); its outline color. */
function boundingBoxEditor(m: Model, id: string): HTMLElement[] {
  const b = m.boundingBoxes![id];
  const swatch = colorSwatch({
    value: b.color ?? "#60a8ffff",
    alpha: true,
    title: "Outline color (in Spine's editor; games ignore it)",
    onChange: (c) => void commit([{ op: "updateBoundingBox", id, color: c } as Op]),
  });
  return [
    h("div", { class: "section" }, "Bounding box"),
    h("div", { class: "sub" }, `${b.vertices.length}-point polygon for hit tests in games (Spine's SkeletonBounds); not drawn, follows its bones`),
    field("outline color", swatch),
    h("div", { class: "note" }, "Shown as a dashed outline in the viewport (View › IK constraints). Agents change its polygon with the updateBoundingBox op."),
  ];
}

/** Live2D art mesh colors: multiply / screen color and opacity of the keyform at the pinned sliders (what moc3 stores). */
function refreshProps(): void {
  const m = state.model;
  const box = $("props");
  if (!m) return box.replaceChildren(h("h3", {}, "No model"), h("div", { class: "note" }, "Open a model from the File menu, or create one with File › New."));
  if (meshProps(box)) return;
  const sel = state.sel;
  if (!sel) {
    const nameInput = h("input", { type: "text", value: m.name, title: "Model name (the skeleton / model name written by the exports)" }) as HTMLInputElement;
    nameInput.addEventListener("change", () => {
      const v = nameInput.value.trim();
      if (v && v !== m.name) void commit([{ op: "setMeta", name: v }], `renamed the model to ${v}`);
    });
    return box.replaceChildren(
      h("h3", {}, m.name),
      raw(state.file ?? "", "div", "sub"),
      field("name", nameInput),
      h(
        "div",
        { class: "note" },
        modelTarget(m) === "live2d"
          ? `Live2D model: ${m.slots.length} art meshes, ${m.parameters?.length ?? 0} parameters, ${m.live2d?.deformers.length ?? 0} deformers, ` +
              `${m.live2d?.parts.length ?? 0} parts, ${m.live2d?.physics?.settings.length ?? 0} physics settings, ${Object.keys(m.animations ?? {}).length} motions.`
          : `Spine model: ${m.bones.length} bones, ${m.slots.length} slots, ${Object.keys(m.attachments).length} meshes, ` +
              `${Object.keys(m.animations ?? {}).length} animations, ${(m.ik?.length ?? 0) + (m.transforms?.length ?? 0) + (m.paths?.length ?? 0) + (m.spinePhysics?.length ?? 0) + (m.sliders?.length ?? 0)} constraints.`,
      ),
      h(
        "div",
        { class: "note" },
        // one text node per sentence group, so each is translated on its own
        ...(modelTarget(m) === "live2d"
          ? ["Select an art mesh in the viewport or the Slots list. Pin parameter sliders (Params) on keys, then shape the keyform: Move (W), Rotate (E), Scale (R), or drag vertices in Mesh mode with keep image off. Motions animate parameters. "]
          : ["Select a bone or a part in the viewport or the list. Tools: Select (Q), Move (W), Rotate (E), Scale (R), New bone (B). ", "In Setup, edits change the rest pose; with an animation selected, they set keys at the playhead. "]),
        "Edits stay unsaved until File › Save (Ctrl+S). Edits made by an agent through MCP or the CLI appear here automatically.",
      ),
    );
  }
  if (spineProps(m, sel, box, spineHost())) return;
  if (sel.kind === "bone") {
    const b = m.bones.find((x) => x.id === sel.id)!;
    const upOps = (patch: Record<string, unknown>) => [{ op: "updateBone", id: b.id, ...patch, ...("parent" in patch ? {} : { carry: state.carry, compensate: state.compBones }) } as Op];
    const up = (patch: Record<string, unknown>) => commit(upOps(patch));
    const parents: Array<[string, string]> = m.bones.filter((x) => x.id !== b.id).map((x) => [x.id, x.id]);
    const setupField = (label: string, key: "x" | "y" | "rotation" | "length" | "scaleX" | "scaleY" | "shearX" | "shearY", step = 1) =>
      num(label, b[key] ?? 0, (v) => up({ [key]: v }), step, (v) => upOps({ [key]: v }));
    const spine = modelTarget(m) === "spine";
    const kids: HTMLElement[] = [
      header(b.id, iconBtn("⛓", "New bone chain from this bone's tip", () => void newBoneChain(b.id)), iconBtn("✎", "Rename (F2)", () => void renameSelected()), iconBtn("🗑", "Delete bone", () => void deleteSelected(), "danger")),
      h("div", { class: "sub" }, "bone · setup (rest) transform, local to parent"),
      ...(multi.size ? [h("div", { class: "note multi" }, `+ ${multi.size} more selected: ${[...multi].slice(0, 6).join(", ")}${multi.size > 6 ? "…" : ""}. Move / Rotate / Scale (W / E / R) and K apply to all of them; the fields below edit ${b.id} only.`)] : []),
      b.parent === null ? field("parent", h("span", {}, "(root)")) : field("parent", selectOf(parents, b.parent, (v) => up({ parent: v }))),
      h("div", { class: "section" }, "Transform"),
      h("div", { class: "grid2" }, setupField("rotation", "rotation"), setupField("length", "length")),
      h("div", { class: "grid2" }, setupField("x", "x"), setupField("y", "y")),
      h("div", { class: "grid2" }, setupField("scaleX", "scaleX", 0.05), setupField("scaleY", "scaleY", 0.05)),
      ...(spine ? [h("div", { class: "grid2" }, setupField("shearX", "shearX"), setupField("shearY", "shearY"))] : []),
      ...(spine
        ? [
            h("div", { class: "section" }, "Appearance"),
            field("Icon", spineBoneIconEditor(b)),
            field("Bone color", h("div", { class: "row" },
              colorSwatch({
                value: b.color ?? BONE_COLORS[m.bones.indexOf(b) % BONE_COLORS.length],
                alpha: false,
                title: "Bone color (editor guide)",
                onInput: (color) => schedulePreview(m, [{ op: "updateBone", id: b.id, color }]),
                onChange: (color) => void commit([{ op: "updateBone", id: b.id, color }]),
              }),
              iconBtn("↺", "Use automatic bone color", () => void commit([{ op: "updateBone", id: b.id, color: null }])),
            )),
            h("div", { class: "section" }, "Options"),
            ...boneSpineFields(m, b.id, spineHost()),
          ]
        : []),
    ];
    const pose = lastPose?.byId.get(b.id);
    if (pose) {
      const e = boneEnds(pose);
      kids.push(
        h(
          "div",
          { class: "note" },
          `World now: (${e.start[0].toFixed(1)}, ${e.start[1].toFixed(1)}) → (${e.end[0].toFixed(1)}, ${e.end[1].toFixed(1)}) at ${angleOf(pose.world).toFixed(1)}°`,
        ),
      );
    }
    if (state.anim) {
      const anim = state.anim;
      const tl = m.animations?.[anim]?.bones?.[b.id];
      const t = localT();
      const lerpV = (a: Vec2, c: Vec2, f: number): Vec2 => [a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f];
      const rot = sampleTrack(tl?.rotate, t, (a, c, f) => a + (c - a) * f) ?? 0;
      const tr = sampleTrack(tl?.translate, t, lerpV) ?? [0, 0];
      const sc = sampleTrack(tl?.scale, t, lerpV) ?? [1, 1];
      const sh = sampleTrack(tl?.shear, t, lerpV) ?? [0, 0];
      const key = (channel: "rotate" | "translate" | "scale" | "shear", v: number | Vec2): Op[] => [{ op: "setKeys", animation: anim, bone: b.id, channel, keys: [{ t, v }], mode: "merge" } as Op];
      const keyField = (label: string, value: number, make: (v: number) => Op[], step = 1) => num(label, value, (v) => void commit(make(v), `keyed ${b.id} at ${t}s`), step, make);
      kids.push(
        h("div", { class: "section" }, `${anim} @ ${t.toFixed(3)}s — keys at the playhead`),
        h("div", { class: "grid2" }, keyField("rotate +°", rot, (v) => key("rotate", v)), h("span")),
        h("div", { class: "grid2" }, keyField("move x", tr[0], (v) => key("translate", [v, tr[1]])), keyField("move y", tr[1], (v) => key("translate", [tr[0], v]))),
        h("div", { class: "grid2" }, keyField("scale x", sc[0], (v) => key("scale", [v, sc[1]]), 0.05), keyField("scale y", sc[1], (v) => key("scale", [sc[0], v]), 0.05)),
        ...(spine ? [h("div", { class: "grid2" }, keyField("shear x", sh[0], (v) => key("shear", [v, sh[1]])), keyField("shear y", sh[1], (v) => key("shear", [sh[0], v])))] : []),
        h("div", { class: "note" }, `Offsets on top of the setup pose. Keys: ${Object.entries(tl ?? {}).map(([ch, k]) => `${ch} ${(k as unknown[]).length}`).join(", ") || "none"}.`),
      );
    }
    return box.replaceChildren(...kids);
  }
  if ((sel.kind === "part" || sel.kind === "deformer") && m.live2d) return box.replaceChildren(...live2dObjectProps(m, sel.kind, sel.id));
  if (sel.kind === "glue" && m.live2d) return box.replaceChildren(...glueProps(m, sel.id));
  if (sel.kind === "slot") {
    const s = m.slots.find((x) => x.id === sel.id)!;
    const up = (patch: Record<string, unknown>) => commit([{ op: "updateSlot", id: s.id, ...patch } as Op]);
    const index = m.slots.indexOf(s);
    const l2d = modelTarget(m) === "live2d";
    // with an animation (Spine), visibility is the attachment key in effect at the playhead
    const animKeyed = !!state.anim && !l2d;
    const shownAtt = animKeyed ? slotAttachmentNow(m, s.id) : s.attachment;
    const visible = shownAtt !== null;
    const toggleVisible = () => {
      if (visible) {
        hiddenAttachment.set(s.id, shownAtt!);
        void commit(animKeyed ? slotAttachmentOps(s.id, null) : [{ op: "updateSlot", id: s.id, attachment: null }], animKeyed ? `keyed ${s.id} hidden` : undefined);
      } else {
        const back = hiddenAttachment.get(s.id) ?? s.attachment ?? (l2d ? (m.attachments[s.id] ? s.id : Object.keys(m.attachments)[0]) : spineAttachmentsBySlot(m).get(s.id)?.[0]);
        if (back) void commit(animKeyed ? slotAttachmentOps(s.id, back) : [{ op: "updateSlot", id: s.id, attachment: back }], animKeyed ? `keyed ${s.id} shown` : undefined);
      }
    };
    const clipOptions: Array<[string, string]> = [["", "(none)"], ...m.slots.filter((x) => x.id !== s.id).map((x) => [x.id, x.id] as [string, string])];
    const att = s.attachment ? m.attachments[s.attachment] : undefined;
    return box.replaceChildren(
      header(
        s.id,
        iconBtn(visible ? "👁" : "◌", animKeyed ? (visible ? `Key hidden at the playhead (${state.anim})` : `Key shown at the playhead (${state.anim})`) : visible ? "Hide (clears the attachment)" : "Show", toggleVisible, visible ? "" : "off"),
        iconBtn("✎", "Rename (F2)", () => void renameSelected()),
        iconBtn("🗑", "Delete slot", () => void deleteSelected(), "danger"),
      ),
      h("div", { class: "sub" }, `slot · draw position ${index + 1} of ${m.slots.length}${att ? ` · ${att.vertices.length} vertices` : shownAtt && m.clippings?.[shownAtt] ? " · clipping" : shownAtt && m.boundingBoxes?.[shownAtt] ? " · bounding box" : " · hidden"}`),
      ...(l2d && att?.live2d
        ? l2KeyformEditor(m, { kind: "mesh", id: s.attachment! })
        : [h("div", { class: "section" }, state.anim ? `Color — keyed at ${localT().toFixed(3)}s in ${state.anim}` : "Color"), colorEditor(m, s.id)]),
      ...(modelTarget(m) === "spine" ? darkEditor(m, s.id) : []),
      ...(shownAtt && m.clippings?.[shownAtt] ? clippingEditor(m, shownAtt) : []),
      ...(shownAtt && m.boundingBoxes?.[shownAtt] ? boundingBoxEditor(m, shownAtt) : []),
      h("div", { class: "section" }, "Rendering"),
      field("blend", selectOf(BLEND_MODES.map((b) => [b, b] as [string, string]), s.blend ?? "normal", (v) => up({ blend: v }))),
      // Spine clips with clipping attachments (above), not slot masks
      ...(modelTarget(m) === "spine" && !s.clip ? [] : [field("clip to", selectOf(clipOptions, (Array.isArray(s.clip) ? s.clip[0] : s.clip) ?? "", (v) => up({ clip: v || null })))]),
      ...slotOrderFields(m, s.id),
      h("div", { class: "section" }, "Binding"),
      ...(l2d && att?.live2d
        ? [
            field("deformer", selectOf([["", "(canvas)"], ...(m.live2d?.deformers ?? []).map((d) => [d.id, d.id] as [string, string])], att.live2d.deformer ?? "", (v) => void commit([{ op: "setLive2DMesh", attachment: s.attachment!, deformer: v || null } as Op]))),
            field("part", selectOf(l2PartOptions(m), att.live2d.part ?? "", (v) => void commit([{ op: "setLive2DMesh", attachment: s.attachment!, part: v || null } as Op]))),
            l2Check("disabled", !!att.live2d.disabled, (v) => [{ op: "setLive2DMesh", attachment: s.attachment!, disabled: v } as Op], "Never drawn (Cubism's disabled objects)"),
          ]
        : l2d
          ? []
          : [field("bone", selectOf(m.bones.map((b) => [b.id, b.id]), s.bone, (v) => up({ bone: v })))]),
      field(
        animKeyed ? "attachment (key)" : "attachment",
        h(
          "div",
          { class: "pair" },
          selectOf([["", "(none)"], ...slotAttachmentChoices(m, s.id, shownAtt).map((a) => [a, a] as [string, string])], shownAtt ?? "", (v) =>
            void commit(animKeyed ? slotAttachmentOps(s.id, v || null) : [{ op: "updateSlot", id: s.id, attachment: v || null }]),
          ),
          ...(shownAtt && (m.attachments[shownAtt] || m.clippings?.[shownAtt] || m.boundingBoxes?.[shownAtt])
            ? [iconBtn("🗑", `Delete the attachment ${shownAtt} from the model`, () => void deleteAttachment(shownAtt), "danger")]
            : []),
        ),
      ),
      ...(animKeyed ? [h("div", { class: "note" }, `With ${state.anim} selected, the eye, the attachment and the color set keys at the playhead (K keys color and attachment together).`)] : []),
      h(
        "div",
        { class: "note" },
        modelTarget(m) === "live2d"
          ? "Shapes the keyform at the pinned sliders (Params: ◇ adds min / default / max keys, key dots pin them). Move (W): drag the mesh or the gizmo; Rotate (E), Scale (R); Mesh mode (2) drags single vertices."
          : "Move / Rotate / Scale tools (W / E / R) transform this part's mesh in Setup. Mesh mode (2) edits single vertices; Weights mode (3) paints which bones move it.",
      ),
    );
  }
  if (sel.kind === "ik") {
    const c = m.ik!.find((x) => x.id === sel.id)!;
    const up = (patch: Record<string, unknown>) => commit([{ op: "updateIk", id: c.id, ...patch } as Op]);
    const bend = h("input", { type: "checkbox", checked: c.bendPositive });
    bend.addEventListener("change", () => up({ bendPositive: bend.checked }));
    return box.replaceChildren(
      h("h3", {}, c.id),
      h("div", { class: "sub" }, `IK · ${c.bones.join(" → ")} reaches for ${c.target}`),
      field("target", selectOf(m.bones.map((b) => [b.id, b.id]), c.target, (v) => up({ target: v }))),
      num("mix", c.mix, (v) => up({ mix: v }), 0.1),
      field("bendPositive", bend),
      ...(modelTarget(m) === "spine" ? ikSpineFields(m, c, spineHost()) : []),
      h("div", { class: "note" }, "Drag the magenta X to move the target. In an animation this keys the target bone."),
    );
  }
  if (sel.kind === "param") return paramProps(m, box, sel.id);
}
/** Keeps unpinned sliders following the values the animation is producing. */
function syncParamRows(): void {
  if (state.tab !== "params" || !lastPose?.params) return;
  for (const draw of padDrawers) draw();
  document.querySelectorAll<HTMLElement>(".param-row").forEach((row) => {
    const id = row.dataset.param!;
    if (typeof state.params[id] === "number") return;
    const v = lastPose!.params![id];
    const slider = row.querySelector<HTMLInputElement>("input[type=range]");
    if (slider && document.activeElement !== slider) slider.value = String(v);
    const input = row.querySelector<HTMLInputElement>("input.value");
    if (!input) return;
    const d = Math.max(0, Math.min(4, state.model?.parameters?.find((p) => p.id === id)?.decimals ?? 2));
    if (document.activeElement !== input) input.value = paramText(v, d);
  });
}

/** A parameter value as the list shows it: up to its decimal places, trailing zeros dropped (at least one decimal). */
function paramText(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, ".0") : s + ".0";
}

/** Collapsed parameter groups of the open file (remembered). */
function paramGroupsClosed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("awaken2d.paramGroups." + state.file) ?? "[]"));
  } catch {
    return new Set();
  }
}
function toggleParamGroup(g: string): void {
  const s = paramGroupsClosed();
  if (s.has(g)) s.delete(g);
  else s.add(g);
  try {
    localStorage.setItem("awaken2d.paramGroups." + state.file, JSON.stringify([...s]));
  } catch {
    // not remembered
  }
  refreshTree();
}

/** The selected Live2D object that parameters key (art mesh, deformer or part), with its keyform grid. */
function selectedKeyTarget(m: Model): { id: string; grid: { params: string[]; keys: number[][] } } | null {
  const mesh = selectedLive2DMesh(m);
  if (mesh) return { id: mesh.id, grid: mesh.att.live2d!.grid };
  if (state.sel?.kind === "deformer") {
    const d = m.live2d?.deformers.find((x) => x.id === state.sel!.id);
    if (d) return { id: d.id, grid: d.grid };
  }
  if (state.sel?.kind === "part") {
    const pt = m.live2d?.parts.find((x) => x.id === state.sel!.id);
    if (pt) return { id: pt.id, grid: pt.grid };
  }
  if (state.sel?.kind === "glue") {
    const g = m.live2d?.glue?.find((x) => x.id === state.sel!.id);
    if (g) return { id: g.id, grid: g.grid };
  }
  return null;
}

/** Parameter list with live sliders. Pinned values override the animation until reset. */
function paramRows(m: Model): HTMLElement[] {
  const addRow = h(
    "div",
    { class: "item note list-head" },
    h("span", {}, "Parameters"),
    h("button", { class: "icon small", title: "New parameter", onclick: () => void newParameter() }, "＋"),
  );
  if (!m.parameters?.length) return [addRow, h("div", { class: "item", style: "color:var(--muted)" }, "No parameters yet. Add one with ＋.")];
  const selObj = selectedKeyTarget(m);
  const hintRow = modelTarget(m) === "live2d"
    ? h(
        "div",
        { class: "item note", style: "white-space:normal" },
        selObj
          ? `Keying ${selObj.id}: ◇ adds 3 keys (min, default, max), then click a key dot on the slider and shape it in the viewport.`
          : "Select an art mesh, deformer or part to key it on parameters (◇ adds min / default / max keys).",
      )
    : null;
  const query = $<HTMLInputElement>("search").value.trim().toLowerCase();
  const rows: HTMLElement[] = [addRow, ...(hintRow ? [hintRow] : [])];
  const shown = m.parameters.filter((p) => !query || p.id.toLowerCase().includes(query) || !!p.name?.toLowerCase().includes(query));
  const closed = paramGroupsClosed();
  const skip = new Set<string>();
  let lastGroup: string | undefined;
  for (const p of shown) {
    if ((p.group ?? "") !== (lastGroup ?? "")) {
      lastGroup = p.group;
      if (p.group) {
        const g = p.group;
        const count = shown.filter((x) => x.group === g).length;
        const isClosed = closed.has(g) && !query;
        rows.push(
          h(
            "div",
            { class: "param-group" + (isClosed ? " closed" : ""), title: g, onclick: () => toggleParamGroup(g) },
            h("span", { class: "caret" }, isClosed ? "▸" : "▾"),
            h("span", { class: "ico" }, isClosed ? "📁" : "📂"),
            Object.assign(raw(groupName(m, g), "span", "g-name"), {}),
            h("span", { class: "g-count" }, String(count)),
          ),
        );
      }
    }
    if (p.group && closed.has(p.group) && !query) continue;
    if (skip.has(p.id)) continue;
    const next = m.parameters[m.parameters.indexOf(p) + 1];
    if (p.combined && next && modelTarget(m) === "live2d" && shown.includes(next) && (next.group ?? "") === (p.group ?? "")) {
      rows.push(pairRow(m, p, next));
      skip.add(next.id);
      continue;
    }
    rows.push(paramRow(m, p));
  }
  return finishParamRows(m, rows);
}

/** Key values of a parameter across the Live2D objects keyed on it. */
function paramKeys(m: Model, id: string): number[] {
  const out = new Set<number>();
  const add = (g?: { params: string[]; keys: number[][] }) => g?.params.forEach((p, i) => p === id && g.keys[i].forEach((k) => out.add(k)));
  for (const a of Object.values(m.attachments)) add(a.live2d?.grid);
  for (const d of m.live2d?.deformers ?? []) add(d.grid);
  for (const pt of m.live2d?.parts ?? []) add(pt.grid);
  for (const g of m.live2d?.glue ?? []) add(g.grid);
  return [...out].sort((a, b) => a - b);
}

/** Live2D objects keyed on a parameter: [kind, id, keys]. */
function paramUsers(m: Model, id: string): Array<{ kind: "mesh" | "deformer" | "part" | "glue"; id: string; keys: number[] }> {
  const out: Array<{ kind: "mesh" | "deformer" | "part" | "glue"; id: string; keys: number[] }> = [];
  const add = (kind: "mesh" | "deformer" | "part" | "glue", oid: string, g?: { params: string[]; keys: number[][] }) => {
    const i = g?.params.indexOf(id) ?? -1;
    if (i >= 0) out.push({ kind, id: oid, keys: g!.keys[i] });
  };
  for (const [aid, a] of Object.entries(m.attachments)) add("mesh", aid, a.live2d?.grid);
  for (const d of m.live2d?.deformers ?? []) add("deformer", d.id, d.grid);
  for (const pt of m.live2d?.parts ?? []) add("part", pt.id, pt.grid);
  for (const g of m.live2d?.glue ?? []) add("glue", g.id, g.grid);
  // blend shapes on it (added on top of the keyforms)
  const keys = m.parameters?.find((p) => p.id === id)?.blendShape?.keys ?? [];
  const shapes = (kind: "mesh" | "deformer" | "part" | "glue", oid: string, list?: Array<{ param: string }>) => {
    if (list?.some((sh) => sh.param === id)) out.push({ kind, id: oid, keys });
  };
  for (const [aid, a] of Object.entries(m.attachments)) shapes("mesh", aid, a.live2d?.blendShapes);
  for (const d of m.live2d?.deformers ?? []) shapes("deformer", d.id, d.blendShapes);
  for (const pt of m.live2d?.parts ?? []) shapes("part", pt.id, pt.blendShapes);
  for (const g of m.live2d?.glue ?? []) shapes("glue", g.id, g.blendShapes);
  return out;
}

/** Display name of a parameter group (cdi3 names them). */
function groupName(m: Model, group: string): string {
  const groups = ((m.meta as { live2d?: { displayInfo?: { ParameterGroups?: Array<{ Id: string; Name?: string }> } } } | undefined)?.live2d?.displayInfo?.ParameterGroups ?? []);
  return groups.find((g) => g.Id === group)?.Name ?? group;
}

async function newParameter(): Promise<void> {
  const m = state.model;
  if (!m) return;
  const r = await dialog({
    title: "New Parameter",
    fields: [
      { name: "id", label: "Id", value: `Param${(m.parameters?.length ?? 0) + 1}`, hint: "Live2D standard ids: ParamAngleX, ParamEyeLOpen, ParamMouthOpenY, …" },
      { name: "name", label: "Display name (optional)", value: "" },
      { name: "min", label: "Min", type: "number", value: -1, step: 0.1 },
      { name: "max", label: "Max", type: "number", value: 1, step: 0.1 },
      { name: "def", label: "Default", type: "number", value: 0, step: 0.1 },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Create", value: "ok", primary: true },
    ],
    validate: (x) => {
      const id = String(x.values.id).trim();
      if (!ID_RE.test(id)) return "Ids cannot contain quotes or backslashes, or start/end with a space";
      if (m.parameters?.some((p) => p.id === id)) return `"${id}" exists`;
      const [mn, mx, d] = [Number(x.values.min), Number(x.values.max), Number(x.values.def)];
      if (!(mn < mx)) return "Min must be below max";
      if (!(d >= mn && d <= mx)) return "Default must lie within min..max";
      return null;
    },
  });
  if (!r) return;
  const id = String(r.values.id).trim();
  const name = String(r.values.name).trim();
  const ops: Op[] = [{ op: "addParameter", id, min: Number(r.values.min), max: Number(r.values.max), default: Number(r.values.def) }];
  if (name) ops.push({ op: "updateParameter", id, name } as Op);
  if (await commit(ops)) select({ kind: "param", id });
}

/** The parameter panel: identity, range, Live2D settings, what it drives, keys. */
function paramProps(m: Model, box: HTMLElement, id: string): void {
  const p = m.parameters!.find((x) => x.id === id)!;
  const up = (patch: Record<string, unknown>) => commit([{ op: "updateParameter", id: p.id, ...patch } as Op]);
  const text = (value: string, onchange: (v: string) => void, placeholder = "") => {
    const i = h("input", { value, placeholder }) as HTMLInputElement;
    i.addEventListener("change", () => onchange(i.value.trim()));
    return i;
  };
  const rename = async (to: string) => {
    if (!to || to === p.id) return;
    if (await commit([{ op: "renameParameter", id: p.id, to } as Op])) {
      if (p.id in state.params) {
        const { [p.id]: v, ...rest } = state.params;
        state.params = { ...rest, [to]: v };
      }
      select({ kind: "param", id: to });
    }
  };
  const groups = [...new Set((m.parameters ?? []).map((x) => x.group).filter((g): g is string => !!g))];
  const groupSel = selectOf([["", "(none)"], ...groups.map((g) => [g, groupName(m, g)] as [string, string]), ["__new", "New group…"]], p.group ?? "", async (v) => {
    if (v === "__new") {
      const g = await promptText("New group", "Group id", "ParamGroup");
      if (g) void up({ group: g });
      else refreshProps();
    } else void up({ group: v || null });
  });
  const repeat = h("input", { type: "checkbox", checked: !!p.repeat }) as HTMLInputElement;
  repeat.addEventListener("change", () => void up({ repeat: repeat.checked }));
  const keys = paramKeys(m, p.id);
  const pinned = typeof state.params[p.id] === "number" ? state.params[p.id] : undefined;
  const pin = (v: number | undefined) => {
    if (v === undefined) {
      const { [p.id]: _, ...rest } = state.params;
      state.params = rest;
    } else state.params = { ...state.params, [p.id]: v };
    refreshPanels();
  };
  const users = paramUsers(m, p.id);
  const l2d = modelTarget(m) === "live2d" || !!m.live2d;
  const physics = (m.live2d?.physics?.settings ?? []).filter((st) => st.inputs.some((i) => i.param === p.id) || st.outputs.some((o) => o.param === p.id));
  const animated = Object.entries(m.animations ?? {}).filter(([, a]) => a.params?.[p.id]?.length).map(([n]) => n);
  const userRow = (u: (typeof users)[number]) => {
    const keysIn = text(u.keys.join(", "), (v) => {
      const ks = v.split(/[,\s]+/).filter(Boolean).map(Number);
      if (!ks.length || ks.some((k) => !Number.isFinite(k))) return void status("keys must be numbers, e.g. -30, 0, 30", true);
      void commit([{ op: "setKeyformKeys", target: u.id, param: p.id, keys: ks } as Op]);
    });
    keysIn.title = "Key values (comma separated). New keys copy the shape interpolated there; removing a key drops its keyform.";
    const label = h(
      "span",
      { class: "user-id", title: `${u.kind} ${u.id}`, onclick: () => u.kind === "mesh" && m.slots.some((sl) => sl.attachment === u.id) && select({ kind: "slot", id: m.slots.find((sl) => sl.attachment === u.id)!.id }) },
      `${u.kind === "mesh" ? "▣" : u.kind === "deformer" ? "▦" : u.kind === "part" ? "▤" : "◈"} ${u.id}`,
    );
    return h(
      "div",
      { class: "param-user" },
      label,
      keysIn,
      iconBtn("✕", `Stop keying ${u.id} on ${p.id} (keeps its look at the default)`, () => void commit([{ op: "setKeyformKeys", target: u.id, param: p.id, keys: null } as Op])),
    );
  };
  // key the selected art mesh / deformer on this parameter
  const selMesh = lastSlotSel ? (m.slots.find((sl) => sl.id === lastSlotSel)?.attachment ?? undefined) : undefined;
  box.replaceChildren(
    header(
      p.name ? `${p.name}` : p.id,
      iconBtn("🗑", "Delete parameter", async () => {
        const ok = await confirmDialog("Delete parameter?", `${p.id}${users.length ? `\n\n${users.length} Live2D object(s) keyed on it keep their look at its default.` : ""}${animated.length ? `\nIts tracks in ${animated.join(", ")} are removed.` : ""}`, "Delete", true);
        if (ok && (await commit([{ op: "removeParameter", id: p.id }]))) select(null);
      }, "danger"),
    ),
    h("div", { class: "sub" }, `parameter · ${p.id}`),
    field("id", text(p.id, (v) => void rename(v))),
    field("name", text(p.name ?? "", (v) => void up({ name: v || null }), "display name")),
    field("group", groupSel),
    num("min", p.min, (v) => up({ min: v }), (p.max - p.min) / 20),
    num("max", p.max, (v) => up({ max: v }), (p.max - p.min) / 20),
    num("default", p.default, (v) => up({ default: v }), (p.max - p.min) / 20),
    ...(l2d
      ? [
          num("decimals", p.decimals ?? 3, (v) => up({ decimals: Math.round(v) }), 1),
          field("repeat", repeat),
          h("div", { class: "note" }, "Decimals: a value this close to a key sits on it (10^-decimals). Repeat: the value wraps around (360° turns)."),
        ]
      : []),
    h("div", { class: "section" }, "Keys"),
    keys.length
      ? h(
          "div",
          { class: "key-chips" },
          ...keys.map((k) => h("button", { class: `chip${pinned === k ? " active" : ""}`, title: `Pin the slider at ${k} (edit the keyforms there)`, onclick: () => pin(pinned === k ? undefined : k) }, String(k))),
        )
      : h("div", { class: "note" }, "Nothing is keyed on it yet."),
    ...(pinned !== undefined ? [h("div", { class: "note" }, `Pinned at ${pinned}. Shape keyforms here: Move / Rotate / Scale a mesh in Pose mode, or drag vertices in Mesh mode with keep image off.`)] : []),
    ...(l2d
      ? [
          h("div", { class: "section" }, `Keyed objects (${users.length})`),
          ...(users.length ? users.map(userRow) : [h("div", { class: "note" }, "No art mesh, deformer, part or glue is keyed on it.")]),
          ...(selMesh && m.attachments[selMesh]?.live2d && !users.some((u) => u.id === selMesh)
            ? [
                h(
                  "button",
                  {
                    style: "margin-top:6px",
                    onclick: () => void commit([{ op: "setKeyformKeys", target: selMesh, param: p.id, keys: [...new Set([p.min, p.default, p.max])].sort((a, b) => a - b) } as Op]),
                  },
                  `Key ${selMesh} on this parameter (min, default, max)`,
                ),
              ]
            : [h("div", { class: "note" }, "To key another art mesh: select it in the Slots list, then come back here (or use Add key here in Mesh mode).")]),
        ]
      : []),
    ...(physics.length
      ? [
          h("div", { class: "section" }, "Physics"),
          ...physics.map((st) =>
            h("div", { class: "note" }, `${st.name ?? st.id}: ${st.inputs.some((i) => i.param === p.id) ? "input" : ""}${st.inputs.some((i) => i.param === p.id) && st.outputs.some((o) => o.param === p.id) ? " and " : ""}${st.outputs.some((o) => o.param === p.id) ? "output (driven by the pendulum)" : ""}`),
          ),
        ]
      : []),
    h("div", { class: "note" }, animated.length ? `Animated in: ${animated.join(", ")}.` : "Not animated. With an animation selected, Key (in the list) writes the slider value at the playhead."),
  );
}

/** One slider row of the Params list. */
function paramRow(m: Model, p: NonNullable<Model["parameters"]>[number]): HTMLElement {
  const anim = animDef();
  const shownValues = lastPose?.params ?? {};
  const pinned = typeof state.params[p.id] === "number";
  const value = pinned ? state.params[p.id] : (shownValues[p.id] ?? p.default);
  const decimals = Math.max(0, Math.min(4, p.decimals ?? 2));
  const fmt = (v: number) => paramText(v, decimals);
  // Cubism style: one line per parameter, name | slider with the selected object's keys on it | value
  const slider = h("input", { type: "range", min: String(p.min), max: String(p.max), step: String((p.max - p.min) / 200), value: String(value) });
  const input = h("input", { type: "number", class: "value" + (pinned ? " pinned" : ""), step: String(10 ** -Math.min(decimals, 3)), value: fmt(value) });
  const target = selectedKeyTarget(m);
  const gi = target ? target.grid.params.indexOf(p.id) : -1;
  const objKeys = gi >= 0 ? target!.grid.keys[gi] : [];
  const keys = objKeys.length ? objKeys : paramKeys(m, p.id);
  const pin = (v: number, refresh = false) => {
    const c = Math.min(Math.max(v, Math.min(p.min, p.max)), Math.max(p.min, p.max));
    state.params = { ...state.params, [p.id]: c };
    slider.value = String(c);
    input.value = fmt(c);
    input.className = "value pinned";
    if (refresh) refreshPanels();
    else requestDraw();
  };
  slider.addEventListener("input", () => {
    const raw = Number(slider.value);
    // the slider snaps onto keys (keyforms are edited there)
    const near = keys.find((k) => Math.abs(k - raw) <= (p.max - p.min) * 0.015);
    pin(near ?? raw);
  });
  slider.addEventListener("change", () => objKeys.length && refreshPanels());
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) pin(v, true);
  });
  const at = typeof state.params[p.id] === "number" ? state.params[p.id] : p.default;
  // key dots on the track: the selected object's keys (filled where the slider sits), else every key of the parameter (faint)
  const frac = (k: number) => (p.max === p.min ? 0 : (k - p.min) / (p.max - p.min));
  const dots = keys.map((k) =>
    h("button", {
      class: `p-key${objKeys.length ? "" : " all"}${objKeys.length && Math.abs(k - at) < 1e-9 && pinned ? " active" : ""}`,
      style: `left:calc(7px + (100% - 14px) * ${frac(k)})`,
      title: objKeys.length ? `${p.id} = ${k}: pin here to shape ${target!.id}'s keyform` : `${p.id} = ${k} (a key of some object)`,
      onclick: (e: Event) => {
        e.stopPropagation();
        pin(k, true);
      },
    }),
  );
  const track = h("div", { class: "p-track" }, slider, ...dots);
  const keyObj = keyObjButton(m, p);
  // key the value into the animation at the playhead (only with an animation open)
  const animKey = anim
    ? h(
        "button",
        {
          class: "anim-key",
          title: "Key this value at the playhead",
          onclick: (e: Event) => {
            e.stopPropagation();
            const v = Number(slider.value);
            void commit([{ op: "setParamTrack", animation: state.anim!, parameter: p.id, keys: [{ t: keyTime(), v }], mode: "merge" }]).then(() => {
              const { [p.id]: _, ...rest } = state.params;
              state.params = rest;
              refreshTree();
            });
          },
        },
        "Key",
      )
    : null;
  const name = h("span", { class: "p-name", title: p.name ? `${p.name} (${p.id})` : p.id, onclick: () => select({ kind: "param", id: p.id }) }, p.name ?? p.id);
  name.setAttribute("translate", "no");
  const row = h(
    "div",
    {
      class: "param-row" + (state.sel?.kind === "param" && state.sel.id === p.id ? " selected" : "") + (gi >= 0 ? " keyed" : "") + (p.blendShape ? " blend" : ""),
      ondblclick: (e: MouseEvent) => {
        // double-click the name area: back to the default (unpinned)
        if ((e.target as HTMLElement).classList.contains("p-name")) {
          const { [p.id]: _, ...rest } = state.params;
          state.params = rest;
          refreshPanels();
        }
      },
    },
    chainButton(m, p),
    keyObj,
    name,
    track,
    input,
    ...(animKey ? [animKey] : []),
  );
  row.dataset.param = p.id;
  return row;
}

/** ◇ / ◆: key the selected object on a parameter (◇ adds min / default / max; ◆ it is keyed: adds a key at the slider). */
function keyObjButton(m: Model, p: NonNullable<Model["parameters"]>[number]): HTMLElement {
  const target = selectedKeyTarget(m);
  if (!target) return h("span", { class: "l2d-key-space" });
  const gi = target.grid.params.indexOf(p.id);
  const objKeys = gi >= 0 ? target.grid.keys[gi] : [];
  const at = typeof state.params[p.id] === "number" ? state.params[p.id] : p.default;
  if (gi < 0) {
    return h(
      "button",
      {
        class: "l2d-key",
        title: `Add 3 keys to ${target.id} on ${p.id} (min, default, max)`,
        onclick: (e: Event) => {
          e.stopPropagation();
          void addThreeKeys(m, target.id, p.id);
        },
      },
      "◇",
    );
  }
  return h(
    "button",
    {
      class: "l2d-key on",
      title: `${target.id} is keyed on ${p.id} at ${objKeys.join(", ")}. Click to add a key at the slider value (${at}); right-click to remove ${p.id} from it.`,
      onclick: (e: Event) => {
        e.stopPropagation();
        if (objKeys.some((k) => Math.abs(k - at) < 1e-9)) return void status(`${target.id} already has a key at ${at}`);
        void commit([{ op: "setKeyformKeys", target: target.id, param: p.id, keys: [...objKeys, at].sort((a, b) => a - b) } as Op]);
      },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: `Add key at ${at}`, run: () => void commit([{ op: "setKeyformKeys", target: target.id, param: p.id, keys: [...new Set([...objKeys, at])].sort((a, b) => a - b) } as Op]) },
          { label: `Remove ${p.id} from ${target.id}`, danger: true, run: () => void commit([{ op: "setKeyformKeys", target: target.id, param: p.id, keys: null } as Op]) },
        ]);
      },
    },
    "◆",
  );
}

/** Cubism's chain link: joins a parameter with the next one into one 2D control (or splits a joined pair). */
function chainButton(m: Model, p: NonNullable<Model["parameters"]>[number]): HTMLElement {
  const list = m.parameters ?? [];
  const next = list[list.indexOf(p) + 1];
  if (modelTarget(m) !== "live2d" || (!p.combined && !next)) return h("span", { class: "chain-space" });
  return h(
    "button",
    {
      class: "chain" + (p.combined ? " on" : ""),
      title: p.combined ? `Unlink ${p.name ?? p.id} and ${next?.name ?? next?.id} (two sliders again)` : `Link with ${next!.name ?? next!.id} below: one 2D control for both`,
      onclick: (e: Event) => {
        e.stopPropagation();
        void commit([{ op: "updateParameter", id: p.id, combined: !p.combined } as Op]);
      },
    },
    "⛓",
  );
}

/** Two linked parameters (Cubism's chain link): a 2D area moving both, with the keys of the selected object in red. */
function pairRow(m: Model, px: NonNullable<Model["parameters"]>[number], py: NonNullable<Model["parameters"]>[number]): HTMLElement {
  const target = selectedKeyTarget(m);
  const objKeys = (id: string) => {
    const i = target ? target.grid.params.indexOf(id) : -1;
    return i >= 0 ? target!.grid.keys[i] : null;
  };
  const kx = objKeys(px.id);
  const ky = objKeys(py.id);
  const both = !!(kx && ky);
  // grid lines: the selected object's keys, else every key of each parameter
  const axis = (d: 0 | 1) => {
    const p = d ? py : px;
    const own = d ? ky : kx;
    const ks = own ?? paramKeys(m, p.id);
    return [...new Set([p.min, ...ks, p.max])].sort((a, b) => a - b);
  };
  const line = (p: NonNullable<Model["parameters"]>[number]) => {
    const pinned = typeof state.params[p.id] === "number";
    const value = pinned ? state.params[p.id] : (lastPose?.params?.[p.id] ?? p.default);
    const decimals = Math.max(0, Math.min(4, p.decimals ?? 2));
    const input = h("input", { type: "number", class: "value" + (pinned ? " pinned" : ""), step: String(10 ** -Math.min(decimals, 3)), value: paramText(value, decimals) });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      state.params = { ...state.params, [p.id]: Math.min(Math.max(v, Math.min(p.min, p.max)), Math.max(p.min, p.max)) };
      refreshPanels();
    });
    const name = h("span", { class: "p-name", title: p.name ? `${p.name} (${p.id})` : p.id, onclick: () => select({ kind: "param", id: p.id }) }, p.name ?? p.id);
    name.setAttribute("translate", "no");
    const row = h(
      "div",
      { class: "param-row sub" + (state.sel?.kind === "param" && state.sel.id === p.id ? " selected" : "") + (objKeys(p.id) ? " keyed" : "") + (p.blendShape ? " blend" : "") },
      p === px ? chainButton(m, px) : h("span", { class: "chain-space" }),
      keyObjButton(m, p),
      name,
      input,
    );
    row.dataset.param = p.id;
    return row;
  };
  const pad = paramPad(m, px.id, py.id, 132, {
    axis,
    keyed: (vx, vy) => both && kx!.some((k) => Math.abs(k - vx) < 1e-9) && ky!.some((k) => Math.abs(k - vy) < 1e-9),
    keyColor: "#e5534b",
    onStop: () => refreshPanels(),
  });
  return h("div", { class: "param-pair" + (both ? " keyed" : "") }, line(px), line(py), h("div", { class: "pair-pad" }, pad));
}

function finishParamRows(m: Model, rows: HTMLElement[]): HTMLElement[] {
  const query = $<HTMLInputElement>("search").value.trim().toLowerCase();
  rows.push(
    h("div", { class: "item" }, h("button", { onclick: () => ((state.params = {}), refreshTree()) }, "Reset sliders")),
  );
  padDrawers = [];
  return rows;
}
// ---------- linked parameter pads (Cubism's chain link)

let padDrawers: Array<() => void> = [];

/** Current value of a parameter as shown (pinned slider, else what the pose evaluated, else the default). */
const paramNow = (id: string): number => {
  if (typeof state.params[id] === "number") return state.params[id];
  const v = lastPose?.params?.[id];
  return typeof v === "number" ? v : (state.model?.parameters?.find((p) => p.id === id)?.default ?? 0);
};

/**
 * Drag pad for two parameters: dragging pins both (preview, like the sliders); Shift snaps to the grid (axis values).
 * Filled dots are keyed grid points, rings are grid points without a key, the yellow dot is the current value.
 */
function paramPad(
  m: Model,
  xId: string,
  yId: string,
  size: number,
  o: { axis: (d: 0 | 1) => number[]; keyed: (vx: number, vy: number) => boolean; onStop: () => void; keyColor?: string },
): HTMLElement {
  const px = m.parameters!.find((p) => p.id === xId)!;
  const py = m.parameters!.find((p) => p.id === yId)!;
  const canvas = h("canvas", { class: "param-pad", width: size * 2, height: size * 2 });
  canvas.style.width = canvas.style.height = `${size}px`;
  const pad = 12;
  const toPx = (vx: number, vy: number): Vec2 => [pad + ((vx - px.min) / (px.max - px.min)) * (size - 2 * pad), size - pad - ((vy - py.min) / (py.max - py.min)) * (size - 2 * pad)];
  const fromPx = (x: number, y: number): Vec2 => [
    Math.max(px.min, Math.min(px.max, px.min + ((x - pad) / (size - 2 * pad)) * (px.max - px.min))),
    Math.max(py.min, Math.min(py.max, py.min + ((size - pad - y) / (size - 2 * pad)) * (py.max - py.min))),
  ];
  const draw = () => {
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "#16181c";
    ctx.fillRect(0, 0, size, size);
    const ax = o.axis(0);
    const ay = o.axis(1);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (const v of ax) {
      const [x] = toPx(v, py.min);
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, size - pad);
      ctx.stroke();
    }
    for (const v of ay) {
      const [, y] = toPx(px.min, v);
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(size - pad, y);
      ctx.stroke();
    }
    for (const vx of ax) {
      for (const vy of ay) {
        const [x, y] = toPx(vx, vy);
        const keyed = o.keyed(vx, vy);
        ctx.beginPath();
        ctx.arc(x, y, keyed ? 4 : 3, 0, Math.PI * 2);
        if (keyed) {
          ctx.fillStyle = o.keyColor ?? "#a371f7";
          ctx.fill();
        } else {
          ctx.strokeStyle = "rgba(255,255,255,0.3)";
          ctx.stroke();
        }
      }
    }
    const [cx, cy] = toPx(paramNow(px.id), paramNow(py.id));
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#8a919c";
    ctx.font = "9px system-ui, sans-serif";
    const lx = px.name ?? px.id;
    const ly = py.name ?? py.id;
    ctx.fillText(lx, size - pad - ctx.measureText(lx).width, size - 2);
    ctx.fillText(ly, 2, 9);
  };
  const setFrom = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    let [vx, vy] = fromPx(e.clientX - r.left, e.clientY - r.top);
    if (e.shiftKey) {
      const snap = (v: number, axis: number[]) => axis.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
      vx = snap(vx, o.axis(0));
      vy = snap(vy, o.axis(1));
    }
    state.params = { ...state.params, [px.id]: +vx.toFixed(3), [py.id]: +vy.toFixed(3) };
    for (const [id, v] of [[px.id, vx], [py.id, vy]] as const) {
      const row = document.querySelector<HTMLElement>(`.param-row[data-param="${CSS.escape(id)}"]`);
      if (!row) continue;
      const slider = row.querySelector<HTMLInputElement>("input[type=range]");
      if (slider) slider.value = String(v);
      const label = row.querySelector<HTMLInputElement>("input.value");
      if (label) {
        label.value = paramText(v, Math.max(0, Math.min(4, (id === px.id ? px : py).decimals ?? 2)));
        label.className = "value pinned";
      }
    }
    requestDraw();
  };
  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    dragging = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no capturable pointer */
    }
    setFrom(e);
  });
  canvas.addEventListener("pointermove", (e) => dragging && setFrom(e));
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    // the properties panel shows the point the pad was left at (and which key it is on)
    o.onStop();
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.title = `Drag to set ${px.id} and ${py.id} together (Shift snaps to the grid)`;
  draw();
  padDrawers.push(draw);
  return canvas;
}

const paramName = (m: Model, id: string) => m.parameters?.find((p) => p.id === id)?.name ?? id;

function refreshAnimSelect(): void {
  const m = state.model;
  const names = Object.keys(m?.animations ?? {});
  animSel.replaceChildren(
    h("option", { value: "", selected: state.anim === null }, "Setup"),
    ...names.map((n) => h("option", { value: n, selected: n === state.anim }, `${n} (${+m!.animations![n].duration.toFixed(3)}s)`)),
  );
  const keyBtn = $<HTMLButtonElement>("key");
  if (modelTarget() === "live2d") {
    keyBtn.disabled = !state.anim;
    keyBtn.title = "Key the pinned parameter sliders at the playhead (K)";
  } else {
    keyBtn.disabled = !state.anim || !(state.sel?.kind === "bone" || state.sel?.kind === "slot");
    keyBtn.title = "Key the selected bone or slot at the playhead (K)";
  }
  const a = animDef();
  const dur = $<HTMLInputElement>("duration");
  const loopBox = $<HTMLInputElement>("loop");
  dur.disabled = loopBox.disabled = !a;
  if (document.activeElement !== dur) dur.value = a ? String(+a.duration.toFixed(3)) : "";
  loopBox.checked = !!a && a.loop !== false;
  for (const id of ["dup-anim", "rename-anim", "del-anim", "to-start", "prev-frame", "next-frame", "to-end", "tl-fit"]) $<HTMLButtonElement>(id).disabled = !a;
  updateMuteButton();
}

function updatePlayButton(): void {
  $("play").textContent = state.playing ? "❚❚" : "▶";
}

/** The event-sound toggle: shown when the model has events; without any sound it is off and says so. */
function updateMuteButton(): void {
  const b = $<HTMLButtonElement>("mute");
  const events = Object.values(state.model?.events ?? {});
  const has = events.some((e) => !!e.audio);
  b.hidden = !events.length;
  b.disabled = !has;
  b.textContent = eventAudio.muted || !has ? "🔇" : "🔊";
  b.title = has
    ? "Event sounds on / off (audio of events with a sound, while playing)"
    : "No event sounds in this model: its events have no sound file (Events tab: select an event, Choose sound file…)";
  b.classList.toggle("off", eventAudio.muted || !has);
}

/** Keys the selected bone's current (interpolated) rotate/translate/scale at the playhead. */
function keySelected(): void {
  const m = state.model;
  const anim = state.anim;
  if (m && modelTarget(m) === "live2d") {
    if (!anim) return void status("Pick or create an animation first (the + next to Setup), then pin sliders and key them", true);
    // Live2D: every pinned slider (or the selected parameter) is keyed at the playhead, then unpinned
    const ids = Object.keys(state.params).filter((id) => m.parameters?.some((p) => p.id === id));
    if (!ids.length && state.sel?.kind === "param") ids.push(state.sel.id);
    if (!ids.length) return void status("Move parameter sliders (Params) to the pose you want, then press K to key them at the playhead", true);
    const t = keyTime();
    const values = keyformValues(m);
    const ops = ids.map((id) => ({ op: "setParamTrack", animation: anim, parameter: id, keys: [{ t, v: +(state.params[id] ?? paramNow(id) ?? values[id]).toFixed(3) }], mode: "merge" }) as Op);
    void commit(ops, `keyed ${ids.length > 1 ? `${ids.length} parameters` : paramName(m, ids[0])} at ${t}s`).then((ok) => {
      if (!ok) return;
      state.params = Object.fromEntries(Object.entries(state.params).filter(([id]) => !ids.includes(id)));
      refreshTree();
    });
    return;
  }
  if (m && anim && state.sel?.kind === "slot" && modelTarget(m) !== "live2d") {
    const id = state.sel.id;
    const t = keyTime();
    const att = slotAttachmentNow(m, id);
    void commit([...slotColorOps(id, slotColorNow(m, id), t), { op: "setSlotKeys", animation: anim, slot: id, channel: "attachment", keys: [{ t, v: att }], mode: "merge" } as Op], `keyed ${id} color and attachment at ${t}s`);
    return;
  }
  const ids = selectedBones();
  if (!m || !anim || !ids.length) return;
  const t = localT();
  const lerpV = (a: Vec2, b: Vec2, f: number): Vec2 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const ops: Op[] = ids.flatMap((id): Op[] => {
    const tl = m.animations?.[anim]?.bones?.[id];
    const out: Op[] = [
      { op: "setKeys", animation: anim, bone: id, channel: "rotate", keys: [{ t, v: +(sampleTrack(tl?.rotate, t, (a, b, f) => a + (b - a) * f) ?? 0).toFixed(3) }], mode: "merge" },
      { op: "setKeys", animation: anim, bone: id, channel: "translate", keys: [{ t, v: sampleTrack(tl?.translate, t, lerpV) ?? [0, 0] }], mode: "merge" },
    ];
    if (tl?.scale?.length) out.push({ op: "setKeys", animation: anim, bone: id, channel: "scale", keys: [{ t, v: sampleTrack(tl.scale, t, lerpV)! }], mode: "merge" });
    return out;
  });
  void commit(ops, `keyed ${ids.length > 1 ? `${ids.length} bones` : ids[0]} at ${t}s`);
}

// ---------- wiring

function wire(): void {
  for (const type of ["pointermove", "pointerdown", "pointerup", "wheel", "keydown", "keyup", "input", "change", "resize"]) {
    window.addEventListener(type, requestDraw, { capture: true, passive: true });
  }
  $("file").addEventListener("click", () => void openDialog());
  wireMenus();
  $("save").addEventListener("click", () => void saveFile());
  $("use-disk").addEventListener("click", () => void resolveConflict("disk"));
  $("keep-mine").addEventListener("click", () => void resolveConflict("mine"));
  document.querySelectorAll<HTMLButtonElement>("#tools button[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool as Tool)));
  $("comp-images").addEventListener("click", () => {
    setCompensation(state.carry, state.compBones);
    status(state.carry ? "image compensation off: images follow their bones in Setup" : "image compensation on: Setup edits move bones without their images (re-binding)");
  });
  $("comp-bones").addEventListener("click", () => {
    setCompensation(!state.carry, !state.compBones);
    status(state.compBones ? "bone compensation on: child bones stay in place in Setup" : "bone compensation off: child bones follow in Setup");
  });
  window.addEventListener("beforeunload", (e) => {
    // the working copy survives a reload (it lives on the server), but closing the server would lose it
    if (state.dirty && !state.autosave) e.preventDefault();
  });
  animSel.addEventListener("change", () => {
    selectAnimation(animSel.value || null);
  });
  $("play").addEventListener("click", togglePlay);
  $("mute").addEventListener("click", () => {
    eventAudio.setMuted(!eventAudio.muted);
    updateMuteButton();
    status(eventAudio.muted ? "event sounds off" : "event sounds on");
  });
  $<HTMLSelectElement>("speed").addEventListener("change", (e) => (state.speed = Number((e.target as HTMLSelectElement).value)));
  $("undo").addEventListener("click", () => void undoRedo("undo"));
  $("redo").addEventListener("click", () => void undoRedo("redo"));
  $("fit").addEventListener("click", fitView);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#l2d-view button")) {
    b.addEventListener("click", () => toggleViewButton(b.dataset.view as ViewButton));
  }
  $<HTMLInputElement>("ov-l2d-glue").addEventListener("change", (e) => setL2DShow("glue", (e.target as HTMLInputElement).checked));
  $<HTMLInputElement>("ov-l2d-deformers").addEventListener("change", (e) => {
    l2dShow.warp = (e.target as HTMLInputElement).checked;
    setL2DShow("rotation", l2dShow.warp);
  });
  document.querySelectorAll<HTMLButtonElement>("#modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as EditMode)));
  overlay.addEventListener("contextmenu", (e) => e.preventDefault());
  overlay.addEventListener("pointerleave", () => (meshState.cursor = null));
  $("key").addEventListener("click", keySelected);
  $("issues").addEventListener("click", () => {
    state.showIssues = !state.showIssues;
    refreshToolbar();
  });
  wireTimelineBar();
  wireResizers();
  $<HTMLInputElement>("search").addEventListener("input", () => refreshTree());
  overlay.addEventListener("pointermove", (e) => {
    const [x, y] = toWorld(e.offsetX, e.offsetY);
    $("cursor").textContent = `x ${x.toFixed(1)}  y ${y.toFixed(1)}`;
  });
  $("new-anim").addEventListener("click", () => void newAnimation());
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab!;
      refreshPanels();
    }),
  );
  for (const input of Object.values(ov)) input.addEventListener("change", () => (refreshL2DShow(), refreshPanels()));
  window.addEventListener("keydown", (e) => {
    if (dialogOpen()) return;
    const mod = e.ctrlKey || e.metaKey;
    // file shortcuts work everywhere, even while typing in a field
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur(); // commit a field being edited first
      setTimeout(() => void (e.shiftKey ? saveFileAs() : saveFile()), 0);
      return;
    }
    if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void openDialog();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
    closeMenus();
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      void undoRedo(e.shiftKey ? "redo" : "undo");
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      void undoRedo("redo");
    } else if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const a = animDef();
      if (!a) return;
      state.playing = false;
      updatePlayButton();
      stepFrame(e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "f") fitView();
    else if (e.key === "k") keySelected();
    else if (e.key === "Escape") select(null);
    else if (e.key === "F2") {
      e.preventDefault();
      void renameSelected();
    } else if (e.key === "?") void showShortcuts();
    else if (!mod && e.shiftKey && e.key.toLowerCase() === "a" && modelTarget() === "live2d") toggleViewButton("lock");
    else if (!mod && e.shiftKey && e.key.toLowerCase() === "d" && modelTarget() === "live2d") toggleViewButton("deflock");
    else if (!mod && TOOL_KEYS[e.key.toLowerCase()]) {
      if (!(TOOL_KEYS[e.key.toLowerCase()] === "bone" && modelTarget() === "live2d")) setTool(TOOL_KEYS[e.key.toLowerCase()]);
    } else if (!mod && e.key.toLowerCase() === "t") {
      if (modelTarget() !== "live2d" && !state.anim) $(e.shiftKey ? "comp-bones" : "comp-images").click();
    }
    else if ((e.key === "Delete" || e.key === "Backspace") && e.shiftKey) void deleteSelected();
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (meshState.mode === "pose" && timeline.deleteSelected()) return;
      deleteSelectedVertices();
    } else if (mod && e.key.toLowerCase() === "a" && meshState.mode === "mesh") {
      const active = activeMesh();
      if (active) {
        e.preventDefault();
        meshState.verts = new Set(active.att.vertices.map((_, i) => i));
        refreshProps();
      }
    } else if (mod && e.key.toLowerCase() === "c") {
      if (timeline.copy()) e.preventDefault();
    } else if (mod && e.key.toLowerCase() === "v") {
      if (timeline.paste()) e.preventDefault();
    } else if (e.key === "Home") jumpTo(0);
    else if (e.key === "End") jumpTo(animDef()?.duration ?? 0);
    else if (e.key === "1" || e.key === "2" || (e.key === "3" && modelTarget() !== "live2d")) setMode((["pose", "mesh", "weights"] as const)[Number(e.key) - 1]);
  });
}

// ---------- mesh and weight editing modes

type EditMode = "pose" | "mesh" | "weights";

const meshState = {
  mode: "pose" as EditMode,
  /** Selected vertex indices of the active mesh. */
  verts: new Set<number>(),
  keepImage: true,
  /** Live2D art meshes: drags move the base mesh (every keyform, texture stays) instead of shaping the keyform. */
  l2dReshape: false,
  bone: null as string | null,
  brush: { radius: 40, strength: 0.35, mode: "add" as "add" | "subtract" | "set" | "smooth", value: 1 },
  cursor: null as Vec2 | null,
  hover: -1,
  /** Deformation path control point under the cursor (Mesh mode). */
  pathHover: null as { path: number; point: number } | null,
  /** Mesh mode tool (Spine's Modify / Create / Delete). */
  tool: "modify" as "modify" | "create" | "delete",
  /** Draw the inner triangle edges (the outline is always drawn). */
  showTris: true,
  trace: { open: false, attachment: "", detail: 20, concavity: 50, alphaThreshold: 8, padding: 0, interior: 0 },
  /** Automatic mesh planned from the art (core/meshplan.ts): role ("" = decided from the art) and density. */
  plan: { open: false, attachment: "", role: "" as MeshRole | "", density: 1 },
  /** Cubism's Automatic Mesh Generator (Live2D art meshes). */
  auto: { open: false, attachment: "", preset: "standard", scope: "mesh" as "mesh" | "part" | "all", opts: { ...AUTO_MESH_PRESETS.standard } as AutoMeshOptions },
  genSpacing: 0,
  genFor: "",
  /** Weights mode: Direct (selected vertices, typed weight) or Brush. */
  weightTool: "direct" as "direct" | "brush",
  pie: false,
  maxInfluences: 4,
  /** Bones listed per mesh in Weights mode besides those that weigh it (Spine's bound bones). */
  listed: new Map<string, Set<string>>(),
};

type EditDrag =
  | { kind: "verts"; base: Model; att: string; start: Vec2; orig: Map<number, Vec2>; op?: Op; moved: boolean }
  | { kind: "paint"; base: Model; att: string; weights: MeshAttachment["weights"] }
  | { kind: "path"; base: Model; att: string; path: Live2DPath; point: number; verts: Vec2[]; ctrl: Vec2[]; op?: Op; moved: boolean }
  | null;
let editDrag: EditDrag = null;

/** Slot + attachment being edited (from the selected slot). */
function activeMesh(): { slot: string; id: string; att: MeshAttachment } | null {
  const m = shown();
  if (!m || state.sel?.kind !== "slot") return null;
  const slot = m.slots.find((s) => s.id === state.sel!.id);
  const id = slot?.attachment;
  if (!slot || !id || !m.attachments[id]) return null;
  return { slot: slot.id, id, att: m.attachments[id] };
}

function setMode(mode: EditMode): void {
  if (state.model) schedulePreview(state.model, null);
  meshState.mode = mode;
  meshState.verts.clear();
  editDrag = null;
  if (mode !== "pose") {
    state.playing = false;
    updatePlayButton();
    if (!activeMesh()) status(`${mode} mode: click a mesh to pick the slot to edit`);
  } else if (statusEl.textContent?.includes(" mode: ")) status("");
  document.querySelectorAll<HTMLButtonElement>("#modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("hint").textContent =
    mode === "mesh"
      ? "Drag vertices to move them; drag empty space to box-select (Shift adds, Ctrl removes). Double-click inside the mesh adds a vertex, Delete removes the selection. Right-drag pans."
      : mode === "weights"
        ? "Pick a bone (Alt+click it, click it in the Bones list, or choose on the right), then paint on the mesh. Right-drag pans."
        : toolHint(state.tool);
  setMeshHint();
  setWeightHint();
  refreshPanels();
}

const nearestVertex = (att: MeshAttachment, x: number, y: number, maxPx = 8, pts: Vec2[] = att.vertices): number => {
  let best = -1;
  let bestD = maxPx;
  pts.forEach((v, i) => {
    const s = toScreen(v);
    const d = Math.hypot(s[0] - x, s[1] - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
};

/** Returns true when the event was handled by mesh/weight editing. */
function editPointerDown(e: PointerEvent): boolean {
  if (meshState.mode === "pose") return false;
  const m = state.model!;
  if (!editDrag && (state.preview || pendingPreview)) schedulePreview(m, null);
  if (e.button !== 0) {
    drag = { kind: "pan", x: e.offsetX, y: e.offsetY, cx: state.view.cx, cy: state.view.cy };
    return true;
  }
  const active = activeMesh();
  if (meshState.mode === "weights") {
    const hit = pick(e.offsetX, e.offsetY);
    // Alt/Ctrl-click picks the bone to paint; a plain click always paints
    if (hit.bone && (e.altKey || e.ctrlKey)) {
      meshState.bone = hit.bone;
      refreshProps();
      status(`painting weights for ${hit.bone}`);
      return true;
    }
    if (active && meshState.weightTool === "direct") {
      // Direct: click / Shift+click vertices, box-drag to select
      const v = nearestVertex(active.att, e.offsetX, e.offsetY, 8, editPoints(m, active.id, active.att));
      if (v >= 0) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) meshState.verts.has(v) ? meshState.verts.delete(v) : meshState.verts.add(v);
        else meshState.verts = new Set([v]);
        refreshProps();
        return true;
      }
      drag = { kind: "box", x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, mode: e.shiftKey ? "add" : e.ctrlKey || e.metaKey || e.altKey ? "remove" : "set", target: "verts" };
      return true;
    }
    if (active && meshState.bone) {
      editDrag = { kind: "paint", base: m, att: active.id, weights: structuredClone(active.att.weights) };
      paintAt(e.offsetX, e.offsetY);
      return true;
    }
    if (hit.slot) select({ kind: "slot", id: hit.slot });
    else if (!meshState.bone) status("pick a bone to paint: Alt+click it in the viewport or choose it on the right");
    drag = { kind: "pan", x: e.offsetX, y: e.offsetY, cx: state.view.cx, cy: state.view.cy };
    return true;
  }
  // mesh mode: a deformation path control point first (it drags the vertices bound to the path)
  const pp = active && meshState.tool === "modify" ? pathPointAt(e.offsetX, e.offsetY) : null;
  if (active && pp) {
    const path = active.att.live2d!.paths![pp.path];
    const verts = editPoints(m, active.id, active.att);
    editDrag = { kind: "path", base: m, att: active.id, path, point: pp.point, verts, ctrl: pathPoints(path, verts), moved: false };
    return true;
  }
  const v = active ? nearestVertex(active.att, e.offsetX, e.offsetY, 8, editPoints(m, active.id, active.att)) : -1;
  const tools = active && (!isLive2D(m, active.att) || meshState.l2dReshape);
  if (tools && meshState.tool === "delete" && v >= 0) {
    meshState.verts.clear();
    void commit([{ op: "removeVertices", attachment: active!.id, indices: [v] }]);
    return true;
  }
  if (tools && meshState.tool === "create" && v < 0) {
    const hit = pick(e.offsetX, e.offsetY);
    if (hit.slot && hit.slot !== active!.slot && !insideMesh(active!.att, toWorld(e.offsetX, e.offsetY))) {
      // another mesh under the cursor: switch to it rather than growing this one across the canvas
      select({ kind: "slot", id: hit.slot });
      return true;
    }
    createVertexAt(active!.id, toWorld(e.offsetX, e.offsetY));
    return true;
  }
  if (active && v >= 0) {
    if (e.shiftKey) {
      if (meshState.verts.has(v)) meshState.verts.delete(v);
      else meshState.verts.add(v);
    } else if (!meshState.verts.has(v)) meshState.verts = new Set([v]);
    const pts = editPoints(m, active.id, active.att);
    const orig = new Map([...meshState.verts].map((i) => [i, pts[i]] as [number, Vec2]));
    editDrag = { kind: "verts", base: m, att: active.id, start: toWorld(e.offsetX, e.offsetY), orig, moved: false };
    refreshProps();
    return true;
  }
  drag = { kind: "box", x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, mode: e.shiftKey ? "add" : e.ctrlKey || e.metaKey || e.altKey ? "remove" : "set", target: "verts" };
  return true;
}

function editPointerMove(e: PointerEvent): boolean {
  if (meshState.mode === "pose") return false;
  meshState.cursor = [e.offsetX, e.offsetY];
  const active = activeMesh();
  if (!editDrag) {
    if (drag) return false; // panning or box-selecting
    meshState.hover = active ? nearestVertex(active.att, e.offsetX, e.offsetY, 8, editPoints(state.model!, active.id, active.att)) : -1;
    const ph = meshState.mode === "mesh" && meshState.tool === "modify" ? pathPointAt(e.offsetX, e.offsetY) : null;
    if (JSON.stringify(ph) !== JSON.stringify(meshState.pathHover)) {
      meshState.pathHover = ph;
      requestDraw();
    }
    if (ph) {
      overlay.style.cursor = "move";
      status(`deformation path point ${ph.point + 1}: drag to bend the path (the vertices bound to it follow)`);
      return true;
    }
    overlay.style.cursor =
      meshState.mode === "weights"
        ? meshState.weightTool === "direct"
          ? meshState.hover >= 0
            ? "pointer"
            : "default"
          : "none"
        : meshState.tool === "create"
          ? "crosshair"
          : meshState.tool === "delete"
            ? meshState.hover >= 0
              ? "not-allowed"
              : "default"
            : meshState.hover >= 0
              ? "move"
              : "default";
    if (meshState.hover >= 0 && active) {
      const w = active.att.weights[meshState.hover].map(([b, x]) => `${b} ${(x * 100).toFixed(0)}%`).join(", ");
      status(`vertex ${meshState.hover}: ${w}`);
    }
    return true;
  }
  if (editDrag.kind === "path") {
    const d = editDrag;
    const to = toWorld(e.offsetX, e.offsetY);
    const r = (n: number) => Math.round(n * 100) / 100;
    const moves = pathMoves(d.path, d.verts, d.point, to).map(([i, x, y]) => [i, r(x), r(y)] as [number, number, number]);
    d.ctrl = d.ctrl.map((q, i) => (i === d.point ? to : q));
    d.op = { op: "setKeyform", target: d.att, at: keyformAt(d.base, d.base.attachments[d.att].live2d!.grid.params), moves };
    d.moved = true;
    try {
      schedulePreview(d.base, [d.op]);
    } catch (err) {
      status((err as Error).message, true);
    }
    requestDraw();
    return true;
  }
  if (editDrag.kind === "verts") {
    const w = toWorld(e.offsetX, e.offsetY);
    const dx = w[0] - editDrag.start[0];
    const dy = w[1] - editDrag.start[1];
    const r = (n: number) => Math.round(n * 100) / 100;
    const base = editDrag.base;
    const att = base.attachments[editDrag.att];
    if (isLive2D(base, att) && !meshState.l2dReshape) {
      // deform: the keyform at the pinned parameter values
      const offsets = [...editDrag.orig.keys()].map((i) => [i, r(dx), r(dy)] as [number, number, number]);
      editDrag.op = { op: "setKeyform", target: editDrag.att, at: keyformAt(base, att.live2d!.grid.params), offsets };
    } else if (isLive2D(base, att)) {
      // reshape: the setup vertices move (every keyform follows), the texture stays
      const moves = [...editDrag.orig.keys()].map((i) => [i, r(att.vertices[i][0] + dx), r(att.vertices[i][1] + dy)] as [number, number, number]);
      editDrag.op = { op: "moveVertices", attachment: editDrag.att, moves, keepImage: true };
    } else if (deformKeyPose(base)) {
      // a deform key at the playhead: the whole shape there (setup-space offsets), with the dragged vertices moved
      const cur = editPoints(base, editDrag.att, att);
      const moved = new Map([...editDrag.orig].map(([i, p]) => [i, [p[0] + dx, p[1] + dy] as Vec2]));
      const offsets = cur
        .map((v, i) => {
          const p = moved.get(i) ?? v;
          return [i, r(p[0] - att.vertices[i][0]), r(p[1] - att.vertices[i][1])] as [number, number, number];
        })
        .filter(([, x, y]) => x !== 0 || y !== 0);
      editDrag.op = { op: "setDeformKeys", animation: state.anim!, attachment: editDrag.att, keys: [{ t: keyTime(), offsets }], mode: "merge" };
    } else {
      const moves = [...editDrag.orig].map(([i, p]) => [i, r(p[0] + dx), r(p[1] + dy)] as [number, number, number]);
      editDrag.op = { op: "moveVertices", attachment: editDrag.att, moves, keepImage: meshState.keepImage };
    }
    editDrag.moved = true;
    try {
      schedulePreview(editDrag.base, [editDrag.op]);
    } catch (err) {
      status((err as Error).message, true);
    }
    return true;
  }
  paintAt(e.offsetX, e.offsetY);
  return true;
}

function editPointerUp(): boolean {
  if (meshState.mode === "pose" || !editDrag) return false; // (box selection finishes in the shared handler)
  const d = editDrag;
  editDrag = null;
  if ((d.kind === "verts" || d.kind === "path") && d.moved && d.op) void commit([d.op], d.kind === "path" ? "bent the deformation path" : undefined);
  if (d.kind === "paint") void commit([{ op: "setWeights", attachment: d.att, weights: d.weights }], `painted weights for ${meshState.bone}`);
  return true;
}

/** One brush dab at a screen point: adjusts the working weights and previews them. */
function paintAt(x: number, y: number): void {
  if (editDrag?.kind !== "paint" || !meshState.bone) return;
  const att = editDrag.base.attachments[editDrag.att];
  const b = meshState.brush;
  const strength = att.vertices.map((v) => {
    const s = toScreen(v);
    const d = Math.hypot(s[0] - x, s[1] - y) / b.radius;
    if (d >= 1) return 0;
    const k = 1 - d;
    return k * k * (3 - 2 * k) * b.strength;
  });
  if (!strength.some((s) => s > 0)) return;
  const working = { ...att, weights: editDrag.weights };
  const mode = b.mode === "subtract" ? "add" : b.mode;
  const value = b.mode === "subtract" ? -1 : b.mode === "add" ? 1 : b.value;
  editDrag.weights = adjustWeights(working, meshState.bone, mode, value, strength);
  // copy only the painted mesh; everything else is shared with the base model (never mutated)
  const base = editDrag.base;
  state.preview = { ...base, attachments: { ...base.attachments, [editDrag.att]: { ...att, weights: editDrag.weights } } };
}

function deleteSelectedVertices(): void {
  const active = activeMesh();
  if (meshState.mode !== "mesh" || !active || !meshState.verts.size) return;
  const indices = [...meshState.verts];
  meshState.verts.clear();
  void commit([{ op: "removeVertices", attachment: active.id, indices }]);
}

overlay.addEventListener("dblclick", (e) => {
  const active = activeMesh();
  if (meshState.mode !== "mesh" || !active || meshState.tool === "create") return;
  const w = toWorld(e.offsetX, e.offsetY);
  const r = (n: number) => Math.round(n * 100) / 100;
  void commit([{ op: "addVertex", attachment: active.id, at: [r(w[0]), r(w[1])] }]);
});

const heat = (w: number, a: number) => {
  // 0 = blue, 0.5 = green/yellow, 1 = red
  const r = Math.round(255 * Math.min(1, Math.max(0, 2 * w - 0.2)));
  const g = Math.round(255 * Math.max(0, 1 - Math.abs(2 * w - 1)));
  const b = Math.round(255 * Math.max(0, 1 - 2 * w));
  return `rgba(${r},${g},${b},${a})`;
};

/** Mesh/weights overlays, drawn over the setup pose. */
function drawEditOverlay(ctx: CanvasRenderingContext2D): void {
  const active = activeMesh();
  const m = shown();
  if (!m) return;
  // faint wireframe of the other meshes so they can be picked
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  for (const it of lastItems) {
    if (it.slot === active?.slot) continue;
    ctx.beginPath();
    for (const [a, b, c] of it.attachment.triangles) {
      ctx.moveTo(...toScreen(it.positions[a]));
      ctx.lineTo(...toScreen(it.positions[b]));
      ctx.lineTo(...toScreen(it.positions[c]));
      ctx.closePath();
    }
    ctx.stroke();
  }
  if (!active) return;
  const pts = editPoints(m, active.id, active.att).map(toScreen);
  if (meshState.mode === "weights" && meshState.bone) {
    const wOf = (i: number) => {
      const list = active.att.weights[i] ?? [];
      const total = list.reduce((s, [, x]) => s + x, 0) || 1;
      return (list.find(([b]) => b === meshState.bone)?.[1] ?? 0) / total;
    };
    for (const [a, b, c] of active.att.triangles) {
      ctx.fillStyle = heat((wOf(a) + wOf(b) + wOf(c)) / 3, 0.55);
      ctx.beginPath();
      ctx.moveTo(...pts[a]);
      ctx.lineTo(...pts[b]);
      ctx.lineTo(...pts[c]);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (meshState.showTris || meshState.mode === "weights") {
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b, c] of active.att.triangles) {
      ctx.moveTo(...pts[a]);
      ctx.lineTo(...pts[b]);
      ctx.lineTo(...pts[c]);
      ctx.closePath();
    }
    ctx.stroke();
  }
  // the outline (Spine's hull), always
  ctx.strokeStyle = "#35d0e0";
  ctx.lineWidth = 2;
  for (const loop of meshOutline(active.att.vertices, active.att.triangles)) {
    ctx.beginPath();
    loop.forEach((vi, k) => (k ? ctx.lineTo(...pts[vi]) : ctx.moveTo(...pts[vi])));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  if (meshState.mode === "weights" && meshState.pie) {
    // every bone's share at each vertex
    setWeightColors(weightBones(m, active.id, active.att));
    const r = 7;
    pts.forEach((p, i) => {
      const list = active.att.weights[i] ?? [];
      const sum = list.reduce((s2, [, x]) => s2 + x, 0) || 1;
      let a0 = -Math.PI / 2;
      for (const [b, x] of list) {
        const a1 = a0 + (x / sum) * Math.PI * 2;
        ctx.fillStyle = boneColor(m, b);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.arc(p[0], p[1], r, a0, a1);
        ctx.closePath();
        ctx.fill();
        a0 = a1;
      }
      ctx.strokeStyle = meshState.verts.has(i) ? "#ffffff" : "rgba(0,0,0,0.6)";
      ctx.lineWidth = meshState.verts.has(i) ? 2 : 1;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    });
  } else pts.forEach((p, i) => {
    const selected = meshState.verts.has(i);
    ctx.fillStyle = selected ? "#4ea1ff" : i === meshState.hover ? "#ffffff" : "rgba(20,20,20,0.9)";
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(p[0], p[1], selected ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  if (meshState.mode === "weights" && meshState.weightTool === "brush" && meshState.cursor) {
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(meshState.cursor[0], meshState.cursor[1], meshState.brush.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Remesh state kept across panel refreshes: the detail being previewed. */
const remesh = { attachment: "", spacing: 0 };

/**
 * "Regenerate from image": a new grid mesh over the image's opaque pixels at the chosen detail, previewed live;
 * Apply commits it (weights, keyforms and deform keys carry over by position).
 */
function remeshControls(id: string, att: MeshAttachment): HTMLElement[] {
  if (!att.image || !att.uvs) return [];
  const px = pixelsOf(att.image);
  if (!px) return [h("div", { class: "section" }, "Regenerate from image"), h("div", { class: "dim" }, "Image still loading…")];
  const maxDim = Math.max(px.width, px.height);
  if (remesh.attachment !== id) {
    // start from roughly the current density
    const area = att.triangles.length / 2;
    remesh.attachment = id;
    remesh.spacing = Math.max(2, Math.round(Math.sqrt((px.width * px.height) / Math.max(1, area)) * 0.8));
  }
  const info = h("span", { class: "value" }, "");
  const geometry = (spacing: number) => remeshFromAlpha(att, px.data, px.width, px.height, spacing);
  const preview = () => {
    try {
      const g = geometry(remesh.spacing);
      info.textContent = `${g.vertices.length} verts`;
      meshState.verts.clear(); // indices of the old mesh mean nothing on the new one
      schedulePreview(state.model!, [{ op: "setMeshGeometry", attachment: id, ...g }]);
    } catch (e) {
      info.textContent = (e as Error).message;
    }
  };
  const slider = h("input", { type: "range", min: "2", max: String(Math.max(8, Math.round(maxDim / 3))), step: "1", value: String(remesh.spacing) });
  const px2 = h("span", { class: "value" }, `${remesh.spacing}px`);
  slider.addEventListener("input", () => {
    remesh.spacing = Number(slider.value);
    px2.textContent = `${remesh.spacing}px`;
    preview();
  });
  // releasing the slider applies it: what you see is then the model (and Save writes it)
  slider.addEventListener("change", () => apply());
  const apply = () => {
    try {
      void commit([{ op: "setMeshGeometry", attachment: id, ...geometry(remesh.spacing) }], `${id}: regenerated from the image (${remesh.spacing}px grid)`);
      meshState.verts.clear();
    } catch (e) {
      status((e as Error).message, true);
    }
  };
  return [
    h("div", { class: "section" }, "Regenerate from image"),
    h("label", { class: "field" }, h("span", { title: "Grid spacing in image pixels: smaller = more vertices" }, "detail"), h("div", { class: "pair" }, slider, px2)),
    h("button", { onclick: apply, title: "Rebuild the mesh at this detail" }, "Regenerate now"),
    h("div", { class: "remesh-info" }, info, h("span", { class: "dim" }, " · drag to preview, release to apply (Ctrl+Z undoes); weights and shapes carry over")),
  ];
}

/** Mesh panel for a Live2D art mesh: its keyform grid, where the pinned values sit, and key editing. */
function live2dMeshProps(box: HTMLElement, id: string, att: MeshAttachment): void {
  const m = state.model!;
  const l = att.live2d!;
  const values = keyformValues(m);
  const onKey = l.grid.params.every((p, i) => l.grid.keys[i].some((k) => Math.abs(k - values[p]) < 10 ** -(m.parameters?.find((x) => x.id === p)?.decimals ?? 3)));
  const modeBtn = (edit: boolean, label: string, title: string) =>
    h("button", { class: meshState.l2dReshape === edit ? "active" : "", title, onclick: () => ((meshState.l2dReshape = edit), (meshState.verts = new Set()), schedulePreview(m, null), setMeshHint(), refreshProps()) }, label);
  box.replaceChildren(
    h("h3", {}, id),
    h("div", { class: "sub" }, `Live2D art mesh · ${att.vertices.length} vertices · ${att.triangles.length} polygons · ${l.forms.length} keyform${l.forms.length === 1 ? "" : "s"}${l.deformer ? ` · under ${l.deformer}` : ""}`),
    h(
      "div",
      { class: "segmented mesh-tools" },
      modeBtn(false, "Shape keyform", "Dragging vertices shapes the keyform at the pinned parameter keys"),
      modeBtn(true, "Edit mesh", "Cubism's mesh edit mode: add, delete and move vertices over a fixed texture; every keyform follows"),
    ),
    h(
      "div",
      { class: "note" },
      meshState.l2dReshape
        ? "Editing the mesh itself: the texture stays put and every keyform follows (resampled by position)."
        : onKey
          ? "Dragging vertices shapes the keyform at the pinned keys below. Click another key to shape that one."
          : "The sliders are between this mesh's keys: click a key below (or add one at the pinned value) before shaping.",
    ),
    ...(meshState.l2dReshape
      ? live2dMeshEditTools(id, att)
      : l2KeyRows(m, id, l.grid)),
  );
}

/** Cubism's mesh edit mode for a Live2D art mesh: tools, Automatic Mesh Generator, Auto connect, Quartering. */
function live2dMeshEditTools(id: string, att: MeshAttachment): HTMLElement[] {
  const nSel = meshState.verts.size;
  const tool = (t: typeof meshState.tool, label: string, title: string) =>
    h("button", { class: meshState.tool === t ? "active" : "", title, onclick: () => ((meshState.tool = t), setMeshHint(), refreshProps()) }, label);
  const tris = h("input", { type: "checkbox", checked: meshState.showTris });
  tris.addEventListener("change", () => ((meshState.showTris = tris.checked), requestDraw()));
  const quarter = () => {
    meshState.verts.clear();
    void commit([{ op: "setMeshGeometry", attachment: id, ...meshQuarter(committedAtt(id)) }], `${id}: quartered (every triangle split in four)`);
  };
  return [
    h(
      "div",
      { class: "segmented mesh-tools" },
      tool("modify", "Select / Edit", "Click or box-drag to select vertices, drag them to move (the texture stays)"),
      tool("create", "Add vertex", "Click inside to add a vertex, outside to extend the outline"),
      tool("delete", "Delete", "Click a vertex to delete it"),
    ),
    h(
      "div",
      { class: "mesh-actions" },
      h("button", { class: meshState.auto.open ? "active" : "", title: "Cubism's Automatic Mesh Generator: outline, inner ring and inner points from the texture", onclick: () => toggleAutoMesh(id) }, "Auto mesh…"),
      h("button", { title: "Rebuild the polygons from the vertices, keeping the outline (Cubism's Auto connect, Ctrl+R)", onclick: () => commit([{ op: "retriangulate", attachment: id }]) }, "Auto connect"),
      h("button", { title: "Split every triangle into four (smoother bends, same shape)", onclick: quarter }, "Quartering"),
    ),
    ...(meshState.auto.open ? autoMeshControls(id) : []),
    h(
      "div",
      { class: "pair" },
      h("button", { onclick: deleteSelectedVertices, disabled: !nSel, title: "Select vertices (click / box-drag) to delete them" }, nSel ? `Delete ${nSel} selected` : "Delete selected"),
      h("button", { onclick: () => ((meshState.verts = new Set(att.vertices.map((_, i) => i))), refreshProps()) }, "Select all"),
    ),
    h("div", { class: "grid2" }, field("triangles", tris), h("span")),
  ];
}

function toggleAutoMesh(id: string): void {
  meshState.auto.open = !meshState.auto.open;
  if (!meshState.auto.open) schedulePreview(state.model!, null);
  meshState.auto.attachment = id;
  refreshProps();
}

/** Art meshes the generator applies to: this one, the ones in its part, or every art mesh with an image. */
function autoMeshTargets(id: string): string[] {
  const m = state.model!;
  const part = m.attachments[id]?.live2d?.part ?? null;
  const all = Object.entries(m.attachments).filter(([, a]) => a.live2d && a.image && a.uvs?.length);
  if (meshState.auto.scope === "part") return all.filter(([, a]) => a.live2d!.part === part).map(([k]) => k);
  if (meshState.auto.scope === "all") return all.map(([k]) => k);
  return [id];
}

/** The automatic mesh planned from an art mesh's own part of its texture (Live2D budget). */
function planned(id: string, att: MeshAttachment, px: { data: Uint8Array; width: number; height: number }) {
  return meshAutoPlan(att, px.data, px.width, px.height, { ...planHints(id), target: "live2d" }).geometry;
}

/** Cubism's Automatic Mesh Generator dialog: presets and settings, previewed on this mesh, applied to the scope. */
function autoMeshControls(id: string): HTMLElement[] {
  const m = state.model!;
  const att = committedAtt(id);
  if (!att.image || !att.uvs?.length) return [h("div", { class: "note" }, "The generator needs a mesh with a texture.")];
  const px = pixelsOf(att.image);
  if (!px) return [h("div", { class: "dim" }, "Texture still loading…")];
  const a = meshState.auto;
  const o = a.opts;
  const info = h("span", { class: "value" }, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const g = a.preset === "plan" ? planned(id, att, px) : meshAutoGenerate(att, px.data, px.width, px.height, o);
        info.textContent = `${g.vertices.length} vertices, ${g.triangles.length} polygons (this mesh)`;
        meshState.verts.clear();
        schedulePreview(m, [{ op: "setMeshGeometry", attachment: id, ...g }]);
      } catch (e) {
        info.textContent = (e as Error).message;
      }
    }, 40);
  };
  const setOpt = (k: keyof AutoMeshOptions, v: number) => {
    (o as unknown as Record<string, number>)[k] = v;
    a.preset = "custom";
    presetSel.value = "custom";
    preview();
  };
  const presetSel = selectOf(
    [["plan", "Automatic (from the art)"], ["standard", "Standard"], ["deformation-small", "Deformation (small)"], ["deformation-large", "Deformation (large)"], ["custom", "Custom"]],
    a.preset,
    (v) => {
      a.preset = v;
      if (AUTO_MESH_PRESETS[v]) a.opts = { ...AUTO_MESH_PRESETS[v] };
      refreshProps();
    },
  );
  const part = att.live2d?.part ? m.live2d?.parts.find((p) => p.id === att.live2d!.part) : undefined;
  const scopeSel = selectOf(
    [["mesh", "This art mesh"], ["part", `Art meshes in ${part ? (part.name ?? part.id) : "no part"}`], ["all", "All art meshes"]],
    a.scope,
    (v) => ((a.scope = v as typeof a.scope), refreshProps()),
  );
  const apply = async () => {
    const targets = autoMeshTargets(id);
    status(`generating ${targets.length} mesh${targets.length === 1 ? "" : "es"}…`);
    await new Promise((r) => setTimeout(r, 20)); // let the status paint
    const ops: Op[] = [];
    const failed: string[] = [];
    for (const t of targets) {
      const ta = committedAtt(t);
      const tp = ta.image ? pixelsOf(ta.image) : null;
      try {
        if (!tp) throw new Error("texture not loaded");
        ops.push({ op: "setMeshGeometry", attachment: t, ...(a.preset === "plan" ? planned(t, ta, tp) : meshAutoGenerate(ta, tp.data, tp.width, tp.height, o)) });
      } catch {
        failed.push(t);
      }
    }
    if (!ops.length) return status("nothing generated (no opaque pixels?)", true);
    a.open = false;
    meshState.verts.clear();
    await commit(ops, `auto mesh (${a.preset}) on ${ops.length} art mesh${ops.length === 1 ? "" : "es"}`);
    if (failed.length) status(`skipped ${failed.length}: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}`, true);
  };
  const cancel = () => {
    a.open = false;
    schedulePreview(m, null);
    refreshProps();
  };
  preview();
  return [
    h(
      "div",
      { class: "trace-box" },
      h("div", { class: "section" }, "Automatic mesh generator"),
      field("preset", presetSel),
      ...(a.preset === "plan" ? [h("div", { class: "note" }, "Settings chosen per art mesh from its size, shape and part names (hair, cloth: dense; small parts: outline only).")] : [
      sliderRow("dot interval (outside)", "Spacing of the outline points (pixels of a 1024 texture)", 4, 80, 1, o.outerInterval, (v) => setOpt("outerInterval", v)),
      sliderRow("dot interval (inside)", "Spacing of the inner points", 6, 160, 1, o.innerInterval, (v) => setOpt("innerInterval", v)),
      sliderRow("boundary margin (outside)", "Room between the art and the outline", 0, 30, 1, o.outerMargin, (v) => setOpt("outerMargin", v)),
      sliderRow("boundary margin (inside)", "Distance from the outline to the inner ring (0 = no ring)", 0, 40, 1, o.innerMargin, (v) => setOpt("innerMargin", v)),
      sliderRow("minimum boundary margin", "Room kept where the art comes closest to the outline (corners)", 0, 10, 0.5, o.minMargin ?? 2, (v) => setOpt("minMargin", v)),
      sliderRow("minimum boundary points", "Fewest outline points", 3, 12, 1, o.minBoundaryPoints ?? 4, (v) => setOpt("minBoundaryPoints", v)),
      sliderRow("transparent alpha", "Alpha (0-255) up to which a pixel counts as transparent", 0, 254, 1, o.alphaThreshold ?? 10, (v) => setOpt("alphaThreshold", v)),
      ]),
      field("apply to", scopeSel),
      h("div", { class: "remesh-info" }, info),
      h("div", { class: "dim" }, "Keyforms are carried over by position. Cubism advises generating meshes before shaping keyforms."),
      h("div", { class: "pair" }, h("button", { onclick: cancel }, "Cancel"), h("button", { class: "primary", onclick: () => void apply() }, "Apply")),
    ),
  ];
}

function meshProps(box: HTMLElement): boolean {
  if (meshState.mode === "pose") return false;
  const m = state.model!;
  const active = activeMesh();
  if (!active) {
    box.replaceChildren(h("h3", {}, meshState.mode === "mesh" ? "Mesh editing" : "Weight painting"), h("div", { class: "note" }, "Click a mesh in the viewport (or pick a slot in the Slots tab) to edit it."));
    return true;
  }
  const { id, att } = active;
  if (meshState.mode === "mesh" && isLive2D(m, att)) return live2dMeshProps(box, id, att), true;
  if (meshState.mode === "mesh") return spineMeshProps(box, id, att), true;
  return weightsProps(box, id, att), true;
}

// ---------- Spine-style mesh panel (Modify / Create / Delete, Trace, Generate, Reset) and weights panel

/** Stable per-bone colors (weights list, pie overlay). */
const BONE_PALETTE = ["#ff6b6b", "#4ea1ff", "#5dd39e", "#ffd166", "#c77dff", "#ff8fab", "#4dd0e1", "#f7b267", "#a3be8c", "#e36414", "#9aa5b1", "#48cae4"];

/** Bones listed for a mesh in Weights mode: those weighing it (most influence first), then the ones added. */
function weightBones(m: Model, id: string, att: MeshAttachment): string[] {
  const influence = new Map<string, number>();
  for (const w of att.weights) for (const [b, x] of w) influence.set(b, (influence.get(b) ?? 0) + x);
  const listed = meshState.listed.get(id) ?? new Set<string>();
  return [...[...influence.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b]) => b), ...[...listed].filter((b) => !influence.has(b) && m.bones.some((x) => x.id === b))];
}
/** A bone's color in the weights list and pies: by its place in the mesh's list, so neighbours differ. */
let weightColors = new Map<string, string>();
const boneColor = (_m: Model, id: string) => weightColors.get(id) ?? "#9aa5b1";
function setWeightColors(bones: string[]): void {
  // keep a bone's color while it stays listed, new bones get the first free color
  const next = new Map<string, string>();
  for (const b of bones) if (weightColors.has(b)) next.set(b, weightColors.get(b)!);
  for (const b of bones) if (!next.has(b)) next.set(b, BONE_PALETTE.find((c) => ![...next.values()].includes(c)) ?? BONE_PALETTE[next.size % BONE_PALETTE.length]);
  weightColors = next;
}

/** A labelled slider row: `set` runs while dragging, `done` on release. */
function sliderRow(label: string, title: string, min: number, max: number, step: number, value: number, set: (v: number) => void, done?: (v: number) => void, unit = ""): HTMLElement {
  const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
  const out = h("span", { class: "value" }, `${value}${unit}`);
  input.addEventListener("input", () => {
    out.textContent = `${input.value}${unit}`;
    set(Number(input.value));
  });
  if (done) input.addEventListener("change", () => done(Number(input.value)));
  return h("label", { class: "field" }, h("span", { title }, label), h("div", { class: "pair" }, input, out));
}

/** The committed attachment (not a preview) of the mesh being edited. */
const committedAtt = (id: string) => state.model!.attachments[id];

function spineMeshProps(box: HTMLElement, id: string, att: MeshAttachment): void {
  const loops = meshOutline(att.vertices, att.triangles);
  const hullN = loops[0]?.length ?? 0;
  const tool = (t: typeof meshState.tool, label: string, title: string) =>
    h("button", { class: meshState.tool === t ? "active" : "", title, onclick: () => ((meshState.tool = t), setMeshHint(), refreshProps()) }, label);
  const keep = h("input", { type: "checkbox", checked: meshState.keepImage });
  keep.addEventListener("change", () => (meshState.keepImage = keep.checked));
  const tris = h("input", { type: "checkbox", checked: meshState.showTris });
  tris.addEventListener("change", () => ((meshState.showTris = tris.checked), requestDraw()));
  const nSel = meshState.verts.size;
  const apply = (g: MeshGeometry, what: string) => {
    meshState.verts.clear();
    return commit([{ op: "setMeshGeometry", attachment: id, ...g }], what);
  };
  const reset = () => {
    try {
      void apply(meshReset(committedAtt(id)), `${id}: reset to the image rectangle`);
    } catch (e) {
      status((e as Error).message, true);
    }
  };
  // Generate: keep the outline, fill it with vertices at this spacing (world units); drag previews, release applies
  if (!meshState.genSpacing || meshState.genFor !== id) {
    const xs = att.vertices.map((v) => v[0]);
    const ys = att.vertices.map((v) => v[1]);
    meshState.genSpacing = Math.max(2, Math.round(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 6));
    meshState.genFor = id;
  }
  const genInfo = h("span", { class: "dim" }, "");
  const genGeometry = () => meshFillInterior(committedAtt(id), meshState.genSpacing);
  const genPreview = () => {
    try {
      const g = genGeometry();
      genInfo.textContent = `${g.vertices.length} vertices`;
      meshState.verts.clear();
      schedulePreview(state.model!, [{ op: "setMeshGeometry", attachment: id, ...g }]);
    } catch (e) {
      genInfo.textContent = (e as Error).message;
    }
  };
  const generate = () => {
    try {
      void apply(genGeometry(), `${id}: generated inner vertices (${meshState.genSpacing} apart)`);
    } catch (e) {
      status((e as Error).message, true);
    }
  };
  const xs = att.vertices.map((v) => v[0]);
  const ys = att.vertices.map((v) => v[1]);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const dk = state.model && deformKeyPose(state.model);
  const deformKeys = dk ? (state.model!.animations?.[state.anim!]?.deform?.[id] ?? []) : [];
  box.replaceChildren(
    h("h3", {}, id),
    h("div", { class: "sub" }, `mesh · ${att.vertices.length} vertices (${hullN} on the outline${loops.length > 1 ? `, ${loops.length} pieces` : ""}) · ${att.triangles.length} triangles${att.image ? ` · image ${att.image}` : ""}`),
    ...(dk
      ? [
          h("div", { class: "note multi" }, `Keying deform in ${state.anim} at ${localT().toFixed(3)}s: dragged vertices key the shape at the playhead (${deformKeys.length} deform keys). The tools below still change the mesh itself.`),
          ...(deformKeys.some((k) => Math.abs(k.t - localT()) < 1e-4)
            ? [h("button", { title: "Remove the deform key at the playhead", onclick: () => void commit([{ op: "setDeformKeys", animation: state.anim!, attachment: id, keys: deformKeys.filter((k) => Math.abs(k.t - localT()) >= 1e-4).map((k) => ({ t: k.t, offsets: k.v, ...(k.ease ? { ease: k.ease } : {}) })), mode: "replace" } as Op]) }, "Remove deform key here")]
            : []),
        ]
      : []),
    h(
      "div",
      { class: "segmented mesh-tools" },
      tool("modify", "Modify", "Select and drag vertices; drag empty space to box-select (Shift adds, Ctrl removes)"),
      tool("create", "Create", "Click inside the mesh to add a vertex, outside to add an outline vertex"),
      tool("delete", "Delete", "Click a vertex to delete it"),
    ),
    h(
      "div",
      { class: "mesh-actions" },
      h("button", { class: meshState.plan.open ? "active" : "", title: "An automatic mesh: outline and vertex spacing chosen from the art's size, shape and name", onclick: () => togglePlan(id) }, "Auto…"),
      h("button", { class: meshState.trace.open ? "active" : "", title: "Trace an outline around the image's opaque pixels", onclick: () => toggleTrace(id) }, "Trace…"),
      h("button", { title: "Keep the outline, fill it with evenly spaced vertices (spacing below)", onclick: generate }, "Generate"),
      h("button", { title: "Back to a 4-vertex rectangle over the whole image", onclick: reset }, "Reset"),
      h("button", { title: "Rebuild the triangles from the current vertices", onclick: () => commit([{ op: "retriangulate", attachment: id }]) }, "Retriangulate"),
    ),
    ...(meshState.plan.open ? planControls(id) : []),
    ...(meshState.trace.open ? traceControls(id) : []),
    sliderRow("generate spacing", "Distance between the vertices Generate adds (world units): drag to preview, release to apply", 2, Math.max(10, Math.round(size / 2)), 1, meshState.genSpacing, (v) => ((meshState.genSpacing = v), genPreview()), () => generate()),
    genInfo,
    h(
      "div",
      { class: "pair" },
      h("button", { onclick: deleteSelectedVertices, disabled: !nSel }, nSel ? `Delete ${nSel} selected` : "Delete selected"),
      h("button", { onclick: () => ((meshState.verts = new Set(att.vertices.map((_, i) => i))), refreshProps()) }, "Select all"),
    ),
    h("div", { class: "grid2" }, field("triangles", tris), field("keep image", keep)),
    h(
      "div",
      { class: "note" },
      "Keep image on: vertices slide over the texture (reshape the mesh). Off: the texture stretches with them (deform the art). ",
      "Weights, blend shapes and deform keys carry over when the mesh is rebuilt.",
    ),
    h("details", { class: "grid-remesh" }, h("summary", {}, "Grid mesh from the image"), ...remeshControls(id, att)),
  );
}

function setMeshHint(): void {
  if (meshState.mode !== "mesh") return;
  const act = activeMesh();
  if (act && state.model && isLive2D(state.model, act.att) && !meshState.l2dReshape) {
    $("hint").textContent = "Shape keyform: drag vertices (box-drag selects, Shift adds) to shape the keyform at the pinned keys. Edit mesh (right panel) changes the mesh itself. Right-drag pans.";
    return;
  }
  if (state.model && deformKeyPose(state.model)) {
    $("hint").textContent = `Deform keys: dragging vertices keys the mesh shape at the playhead in ${state.anim} (select Setup to edit the mesh itself). Right-drag pans.`;
    return;
  }
  $("hint").textContent =
    meshState.tool === "create"
      ? "Create: click inside the mesh to add a vertex, outside it to extend the outline. Right-drag pans."
      : meshState.tool === "delete"
        ? "Delete: click a vertex to delete it; box-drag selects, Delete removes the selection. Right-drag pans."
        : "Modify: drag vertices to move them; drag empty space to box-select (Shift adds, Ctrl removes). Delete removes the selection. Right-drag pans.";
}

function togglePlan(id: string): void {
  meshState.plan.open = !meshState.plan.open;
  meshState.trace.open = false;
  if (!meshState.plan.open) schedulePreview(state.model!, null);
  meshState.plan.attachment = id;
  refreshProps();
}

/**
 * Name hints for an attachment's automatic mesh: its own name, and its slot's (Spine), or its Live2D parts' names
 * outermost first (art mesh ids like "ArtMesh12" say nothing, "Hair Front" does).
 */
function planHints(id: string): { name: string; groups: string[] } {
  const m = state.model!;
  const part = m.attachments[id]?.live2d?.part;
  if (part !== undefined) {
    const groups: string[] = [];
    const parts = m.live2d?.parts ?? [];
    for (let p = parts.find((x) => x.id === part); p && groups.length < 16; p = parts.find((x) => x.id === p!.parent)) groups.unshift(p.name ?? p.id);
    return { name: id, groups };
  }
  const slot = m.slots.find((s) => s.attachment === id || id.startsWith(s.id + "/"))?.id;
  return { name: id.split("/").pop()!, groups: slot && slot !== id ? [slot] : [] };
}

/** The automatic mesh (the one imports make), previewed live: the role and density can be changed. */
function planControls(id: string): HTMLElement[] {
  const att = committedAtt(id);
  if (!att.image || !att.uvs?.length) return [h("div", { class: "note" }, "Auto needs a mesh with an image.")];
  const px = pixelsOf(att.image);
  if (!px) return [h("div", { class: "dim" }, "Image still loading…")];
  const p = meshState.plan;
  const info = h("div", { class: "remesh-info" }, "");
  const geometry = () =>
    meshAutoPlan(att, px.data, px.width, px.height, { ...planHints(id), target: state.model!.target ?? null, role: p.role || undefined, density: p.density });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const g = geometry();
        info.replaceChildren(raw(describePlan(g.plan), "span", "value"));
        meshState.verts.clear();
        schedulePreview(state.model!, [{ op: "setMeshGeometry", attachment: id, ...g.geometry }]);
      } catch (e) {
        info.textContent = (e as Error).message;
      }
    }, 30);
  };
  const apply = () => {
    try {
      const g = geometry();
      meshState.verts.clear();
      p.open = false;
      void commit([{ op: "setMeshGeometry", attachment: id, ...g.geometry }], `${id}: automatic mesh (${g.plan.role}, ${g.plan.quality.vertices} vertices)`);
    } catch (e) {
      status((e as Error).message, true);
    }
  };
  const cancel = () => {
    p.open = false;
    schedulePreview(state.model!, null);
    refreshProps();
  };
  const roleSel = selectOf(
    [["", "From the art"], ["rigid", "Rigid (outline only)"], ["standard", "Standard"], ["flexible", "Flexible (bends a lot)"]],
    p.role,
    (v) => ((p.role = v as MeshRole | ""), preview()),
  );
  preview();
  return [
    h(
      "div",
      { class: "trace-box" },
      h("div", { class: "section" }, "Automatic mesh"),
      field("role", roleSel),
      sliderRow("density", "More or fewer vertices than the automatic budget", 0.4, 2.5, 0.1, p.density, (v) => ((p.density = v), preview()), undefined, "×"),
      info,
      h("div", { class: "note" }, "Size, shape and name decide how much the art bends: small parts and pupils get an outline only, hair, cloth and limbs a dense mesh along their length."),
      h("div", { class: "pair" }, h("button", { onclick: cancel }, "Cancel"), h("button", { class: "primary", onclick: apply }, "Apply")),
    ),
  ];
}

function toggleTrace(id: string): void {
  meshState.trace.open = !meshState.trace.open;
  meshState.plan.open = false;
  if (!meshState.trace.open) schedulePreview(state.model!, null);
  meshState.trace.attachment = id;
  refreshProps();
}

/** Spine's Trace dialog: outline settings, previewed live; Apply replaces the mesh. */
function traceControls(id: string): HTMLElement[] {
  const att = committedAtt(id);
  if (!att.image || !att.uvs?.length) return [h("div", { class: "note" }, "Trace needs a mesh with an image.")];
  const px = pixelsOf(att.image);
  if (!px) return [h("div", { class: "dim" }, "Image still loading…")];
  const t = meshState.trace;
  const info = h("span", { class: "value" }, "");
  const geometry = () =>
    meshFromTrace(att, px.data, px.width, px.height, { detail: t.detail, concavity: t.concavity, alphaThreshold: t.alphaThreshold, padding: t.padding, interior: t.interior });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const g = geometry();
        info.textContent = `${g.vertices.length} vertices, ${g.triangles.length} triangles`;
        meshState.verts.clear();
        schedulePreview(state.model!, [{ op: "setMeshGeometry", attachment: id, ...g }]);
      } catch (e) {
        info.textContent = (e as Error).message;
      }
    }, 30);
  };
  const apply = () => {
    try {
      meshState.verts.clear();
      t.open = false;
      void commit([{ op: "setMeshGeometry", attachment: id, ...geometry() }], `${id}: traced (${t.detail} outline vertices)`);
    } catch (e) {
      status((e as Error).message, true);
    }
  };
  const cancel = () => {
    t.open = false;
    schedulePreview(state.model!, null);
    refreshProps();
  };
  const maxDim = Math.max(px.width, px.height);
  preview();
  return [
    h(
      "div",
      { class: "trace-box" },
      h("div", { class: "section" }, "Trace"),
      sliderRow("detail", "Outline vertices", 3, 100, 1, t.detail, (v) => ((t.detail = v), preview())),
      sliderRow("concavity", "How far the outline follows dents and gaps (0 = wrap loosely, 100 = hug the art)", 0, 100, 1, t.concavity, (v) => ((t.concavity = v), preview())),
      sliderRow("alpha threshold", "Pixels at or below this alpha are empty", 0, 254, 1, t.alphaThreshold, (v) => ((t.alphaThreshold = v), preview())),
      sliderRow("padding", "Room around the art (pixels)", 0, 20, 1, t.padding, (v) => ((t.padding = v), preview()), undefined, "px"),
      sliderRow("inner spacing", "Inner vertices this far apart (image pixels); 0 = outline only (add them later with Generate)", 0, Math.max(10, Math.round(maxDim / 2)), 1, t.interior, (v) => ((t.interior = v), preview()), undefined, "px"),
      h("div", { class: "remesh-info" }, info),
      h("div", { class: "pair" }, h("button", { onclick: cancel }, "Cancel"), h("button", { class: "primary", onclick: apply }, "Apply")),
    ),
  ];
}

/** Whether a world point lies inside one of the mesh's triangles (no nearest-triangle fallback). */
function insideMesh(att: MeshAttachment, p: Vec2): boolean {
  return att.triangles.some(([a, b, c]) => {
    const [A, B, C] = [att.vertices[a], att.vertices[b], att.vertices[c]];
    const s1 = (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
    const s2 = (C[0] - B[0]) * (p[1] - B[1]) - (C[1] - B[1]) * (p[0] - B[0]);
    const s3 = (A[0] - C[0]) * (p[1] - C[1]) - (A[1] - C[1]) * (p[0] - C[0]);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  });
}

/** Create tool: a vertex inside the mesh splits its triangle; outside, it extends the outline. */
function createVertexAt(id: string, p: Vec2): void {
  const att = committedAtt(id);
  const r = (n: number) => Math.round(n * 100) / 100;
  const at: Vec2 = [r(p[0]), r(p[1])];
  if (insideMesh(att, at)) {
    void commit([{ op: "addVertex", attachment: id, at }]).then((ok) => {
      if (ok) meshState.verts = new Set([committedAtt(id).vertices.length - 1]);
    });
    return;
  }
  try {
    const { geometry, index } = meshAddHullVertex(att, at);
    void commit([{ op: "setMeshGeometry", attachment: id, ...geometry }], `${id}: outline vertex added`).then((ok) => {
      if (ok) meshState.verts = new Set([index]);
    });
  } catch (e) {
    status((e as Error).message, true);
  }
}

/** Weights panel (Spine's): bound bones with colors, Direct weights for the selected vertices or a brush, tools. */
function weightsProps(box: HTMLElement, id: string, att: MeshAttachment): void {
  const m = state.model!;
  const influence = new Map<string, number>();
  for (const w of att.weights) for (const [b, x] of w) influence.set(b, (influence.get(b) ?? 0) + x);
  const total = [...influence.values()].reduce((s, x) => s + x, 0) || 1;
  const listed = meshState.listed.get(id) ?? new Set<string>();
  meshState.listed.set(id, listed);
  const shownBones = weightBones(m, id, att);
  setWeightColors(shownBones);
  if (!meshState.bone || !shownBones.includes(meshState.bone)) meshState.bone = shownBones[0] ?? null;
  const bone = meshState.bone;
  const sel = [...meshState.verts].filter((i) => i < att.vertices.length);
  const scope = sel.length ? sel : att.vertices.map((_, i) => i);
  const scopeText = sel.length ? `${sel.length} selected vertices` : "all vertices";
  const setWeights = (weights: MeshAttachment["weights"], what: string) => commit([{ op: "setWeights", attachment: id, weights }], what);
  const removeBone = (b: string) => {
    const others = shownBones.filter((x) => x !== b);
    const slotBone = m.slots.find((s) => s.attachment === id)?.bone ?? "root";
    const fallback = others[0] ?? (slotBone === b ? (m.bones.find((x) => x.id !== b)?.id ?? "root") : slotBone);
    const weights = att.weights.map((w) => {
      const rest = w.filter(([x]) => x !== b);
      return rest.length ? normalizeInfluences(rest, 8) : ([[fallback, 1]] as Array<[string, number]>);
    });
    listed.delete(b);
    if (meshState.bone === b) meshState.bone = null;
    void setWeights(weights, `${id}: ${b} removed (its weights went to the other bones)`);
  };
  const boneRow = (b: string) => {
    const pct = ((influence.get(b) ?? 0) / total) * 100;
    return h(
      "div",
      { class: `wbone${b === bone ? " active" : ""}`, title: `Paint / set weights for ${b}`, onclick: () => ((meshState.bone = b), refreshProps(), requestDraw()) },
      h("span", { class: "dot", style: `background:${boneColor(m, b)}` }),
      h("span", { class: "name" }, b),
      h("span", { class: "pct" }, `${pct.toFixed(pct < 1 && pct > 0 ? 1 : 0)}%`),
      h("button", { class: "icon small", title: `Remove ${b} from this mesh (its weights go to the other bones)`, onclick: (e: Event) => (e.stopPropagation(), removeBone(b)) }, "✕"),
    );
  };
  const addSel = h(
    "select",
    { title: "Add a bone to this mesh's list (weight it with Direct, the brush or Auto)" },
    h("option", { value: "" }, "+ Add bone…"),
    ...m.bones.filter((b) => !shownBones.includes(b.id)).map((b) => h("option", { value: b.id }, b.id)),
  ) as HTMLSelectElement;
  addSel.addEventListener("change", () => {
    if (!addSel.value) return;
    listed.add(addSel.value);
    meshState.bone = addSel.value;
    refreshProps();
  });
  const wtool = (t: typeof meshState.weightTool, label: string, title: string) =>
    h("button", { class: meshState.weightTool === t ? "active" : "", title, onclick: () => ((meshState.weightTool = t), setWeightHint(), refreshProps(), requestDraw()) }, label);

  // Direct: the selected bone's weight on the selected vertices
  const direct = (): HTMLElement[] => {
    if (!bone) return [h("div", { class: "note" }, "Add a bone to the list first.")];
    if (!sel.length) return [h("div", { class: "note" }, "Select vertices (click, Shift+click, box-drag), then set their weight for the chosen bone.")];
    const cur = sel.reduce((s, i) => {
      const w = att.weights[i];
      const t = w.reduce((a, [, x]) => a + x, 0) || 1;
      return s + (w.find(([b]) => b === bone)?.[1] ?? 0) / t;
    }, 0) / sel.length;
    const value = +cur.toFixed(3);
    const num = h("input", { type: "number", min: "0", max: "1", step: "0.01", value: String(value), class: "wnum" }) as HTMLInputElement;
    const range = h("input", { type: "range", min: "0", max: "1", step: "0.01", value: String(value) }) as HTMLInputElement;
    const previewSet = (v: number) => {
      const strength = att.vertices.map((_, i) => (meshState.verts.has(i) ? 1 : 0));
      const weights = adjustWeights(att, bone, "set", v, strength);
      state.preview = { ...m, attachments: { ...m.attachments, [id]: { ...att, weights } } };
      requestDraw();
    };
    const commitSet = (v: number) => void commit([{ op: "adjustWeights", attachment: id, bone, mode: "set", value: Math.max(0, Math.min(1, v)), vertices: sel }], `${id}: ${bone} = ${v} on ${sel.length} vertices`);
    range.addEventListener("input", () => ((num.value = range.value), previewSet(Number(range.value))));
    range.addEventListener("change", () => commitSet(Number(range.value)));
    num.addEventListener("change", () => commitSet(Number(num.value)));
    const only = sel.length === 1 ? att.weights[sel[0]] : null;
    return [
      h("label", { class: "field" }, h("span", {}, `weight · ${bone}`), h("div", { class: "pair" }, range, num)),
      h("div", { class: "dim" }, `${sel.length} selected${sel.length > 1 ? `, average ${(cur * 100).toFixed(0)}%` : ""}`),
      ...(only
        ? [
            h(
              "div",
              { class: "wbars" },
              ...only.map(([b, x]) => h("div", { class: "wbar" }, h("span", { class: "dot", style: `background:${boneColor(m, b)}` }), h("span", { class: "name" }, b), h("div", { class: "bar" }, h("i", { style: `width:${(x * 100).toFixed(1)}%;background:${boneColor(m, b)}` })), h("span", { class: "pct" }, `${(x * 100).toFixed(0)}%`))),
            ),
          ]
        : []),
    ];
  };
  const brush = meshState.brush;
  const brushControls = (): HTMLElement[] => [
    field("brush", selectOf([["add", "add"], ["subtract", "subtract"], ["set", "set to value"], ["smooth", "smooth"]], brush.mode, (v) => (brush.mode = v as typeof brush.mode))),
    sliderRow("strength", "How much one dab changes", 0.05, 1, 0.05, brush.strength, (v) => (brush.strength = v)),
    sliderRow("radius", "Brush radius (screen pixels)", 5, 200, 5, brush.radius, (v) => (brush.radius = v), undefined, "px"),
    sliderRow("set value", "Target weight of the set brush", 0, 1, 0.05, brush.value, (v) => (brush.value = v)),
  ];
  // tools on the selection (or everything)
  const smooth = () => commit([{ op: "adjustWeights", attachment: id, mode: "smooth", ...(sel.length ? { vertices: sel } : {}) }], `${id}: smoothed ${scopeText}`);
  const auto = () => {
    if (!shownBones.length) return status("add bones to the list first", true);
    try {
      const auto = applyOps(m, [{ op: "autoWeight", attachment: id, bones: shownBones, maxInfluences: meshState.maxInfluences }]).model.attachments[id].weights;
      const set = new Set(scope);
      void setWeights(att.weights.map((w, i) => (set.has(i) ? auto[i] : w)), `${id}: automatic weights on ${scopeText} from ${shownBones.length} bones`);
    } catch (e) {
      status((e as Error).message, true);
    }
  };
  const prune = () => {
    const set = new Set(scope);
    void setWeights(att.weights.map((w, i) => (set.has(i) ? normalizeInfluences(w, meshState.maxInfluences) : w)), `${id}: at most ${meshState.maxInfluences} bones per vertex on ${scopeText}`);
  };
  const swap = async () => {
    if (shownBones.length < 2) return status("the list needs two bones to swap", true);
    const opts = shownBones.map((b) => [b, b] as [string, string]);
    const r = await dialog({
      title: "Swap weights",
      message: `Exchange two bones' weights on ${scopeText}.`,
      fields: [
        { name: "a", label: "Bone", type: "select", value: bone ?? shownBones[0], options: opts },
        { name: "b", label: "with", type: "select", value: shownBones.find((b) => b !== bone) ?? shownBones[1], options: opts },
      ],
      validate: (x) => (x.values.a === x.values.b ? "Pick two different bones" : null),
    });
    if (!r) return;
    const a = String(r.values.a);
    const b = String(r.values.b);
    const set = new Set(scope);
    void setWeights(att.weights.map((w, i) => (set.has(i) ? w.map(([x, v]) => [x === a ? b : x === b ? a : x, v] as [string, number]) : w)), `${id}: swapped ${a} and ${b} on ${scopeText}`);
  };
  const pie = h("input", { type: "checkbox", checked: meshState.pie });
  pie.addEventListener("change", () => ((meshState.pie = pie.checked), requestDraw()));
  box.replaceChildren(
    h("h3", {}, id),
    h("div", { class: "sub" }, `weights · ${att.vertices.length} vertices · ${shownBones.length} bone${shownBones.length === 1 ? "" : "s"}`),
    h("div", { class: "section" }, "Bones"),
    h("div", { class: "wbones" }, ...shownBones.map(boneRow)),
    addSel,
    h("div", { class: "segmented mesh-tools" }, wtool("direct", "Direct", "Select vertices and type or slide the chosen bone's weight"), wtool("brush", "Brush", "Paint the chosen bone's weight")),
    ...(meshState.weightTool === "direct" ? direct() : brushControls()),
    h("div", { class: "section" }, `Tools · ${scopeText}`),
    h(
      "div",
      { class: "mesh-actions" },
      h("button", { title: "Average each vertex with its neighbours", onclick: () => void smooth() }, "Smooth"),
      h("button", { title: "Automatic weights from the listed bones (by distance to each bone)", onclick: auto }, "Auto"),
      h("button", { title: "Exchange two bones' weights", onclick: () => void swap() }, "Swap…"),
      h("button", { title: "Keep at most this many bones per vertex (the weakest go)", onclick: prune }, "Prune"),
    ),
    sliderRow("max bones / vertex", "Influence limit for Auto and Prune", 1, 8, 1, meshState.maxInfluences, (v) => (meshState.maxInfluences = v)),
    h("div", { class: "grid2" }, field("pie overlay", pie)),
    h("div", { class: "note" }, "Colors: the chosen bone's weight (blue = none, red = full); the pie overlay shows every bone at each vertex. Alt+click a bone in the viewport to choose it. Check the result in Pose mode by moving bones."),
  );
}

function setWeightHint(): void {
  if (meshState.mode !== "weights") return;
  $("hint").textContent =
    meshState.weightTool === "direct"
      ? "Direct: click vertices (Shift adds) or box-drag to select them, then set the chosen bone's weight on the right. Alt+click a bone to choose it. Right-drag pans."
      : "Brush: paint the chosen bone's weight on the mesh. Alt+click a bone to choose it. Right-drag pans.";
}

// ---------- timeline bar, animation management, layout

let timeline: Timeline;

function jumpTo(t: number): void {
  state.playing = false;
  updatePlayButton();
  state.time = t;
  refreshProps();
}

function stepFrame(dir: number): void {
  const a = animDef();
  if (!a) return;
  const f = Math.round(localT() * timeline.fps) + dir;
  const last = Math.round(a.duration * timeline.fps);
  jumpTo(Math.max(0, Math.min(last, f)) / timeline.fps);
}

/** Ops that recreate every track of animation `from` under the name `to`. */
function copyAnimationOps(from: string, to: string): Op[] {
  const a = state.model!.animations![from];
  const ops: Op[] = [{ op: "setAnimation", name: to, duration: a.duration, loop: a.loop !== false }];
  for (const [bone, tl] of Object.entries(a.bones ?? {})) {
    for (const [channel, keys] of Object.entries(tl)) if ((keys as unknown[]).length) ops.push({ op: "setKeys", animation: to, bone, channel, keys, mode: "replace" } as Op);
  }
  for (const [slot, tl] of Object.entries(a.slots ?? {})) {
    for (const [channel, keys] of Object.entries(tl)) if ((keys as unknown[]).length) ops.push({ op: "setSlotKeys", animation: to, slot, channel, keys, mode: "replace" } as Op);
  }
  for (const [ik, tl] of Object.entries(a.ik ?? {})) {
    for (const [channel, keys] of Object.entries(tl)) if ((keys as unknown[]).length) ops.push({ op: "setIkKeys", animation: to, ik, channel, keys, mode: "replace" } as Op);
  }
  for (const [parameter, keys] of Object.entries(a.params ?? {})) if (keys.length) ops.push({ op: "setParamTrack", animation: to, parameter, keys, mode: "replace" });
  for (const [part, keys] of Object.entries(a.partOpacity ?? {})) if (keys.length) ops.push({ op: "setPartOpacityKeys", animation: to, part, keys, mode: "replace" });
  for (const [attachment, keys] of Object.entries(a.deform ?? {})) {
    if (keys.length) ops.push({ op: "setDeformKeys", animation: to, attachment, keys: keys.map((k) => ({ t: k.t, offsets: k.v, ...(k.ease ? { ease: k.ease } : {}), ...(k.local ? { local: k.local } : {}) })), mode: "replace" } as Op);
  }
  const kinds = { transforms: "transform", paths: "path", spinePhysics: "physics", sliders: "slider" } as const;
  for (const [field, kind] of Object.entries(kinds) as Array<[keyof typeof kinds, string]>) {
    for (const [constraint, tl] of Object.entries((a[field] ?? {}) as Record<string, Record<string, unknown>>)) {
      for (const [channel, keys] of Object.entries(tl)) {
        if (!Array.isArray(keys) || !keys.length) continue;
        // physics reset: restart times
        const list = channel === "reset" ? (keys as number[]).map((t) => ({ t })) : keys;
        ops.push({ op: "setConstraintKeys", animation: to, kind, constraint, channel, keys: list, mode: "replace" } as Op);
      }
    }
  }
  if (a.drawOrder?.length) ops.push({ op: "setDrawOrderKeys", animation: to, keys: a.drawOrder });
  if (a.events?.length) ops.push({ op: "setEventKeys", animation: to, keys: a.events, mode: "replace" } as Op);
  return ops;
}

function wireTimelineBar(): void {
  $("to-start").addEventListener("click", () => jumpTo(0));
  $("to-end").addEventListener("click", () => jumpTo(animDef()?.duration ?? 0));
  $("prev-frame").addEventListener("click", () => stepFrame(-1));
  $("next-frame").addEventListener("click", () => stepFrame(1));
  $("tl-fit").addEventListener("click", () => timeline.fit());
  $<HTMLSelectElement>("fps").addEventListener("change", (e) => (timeline.fps = Number((e.target as HTMLSelectElement).value)));
  $<HTMLInputElement>("snap").addEventListener("change", (e) => (timeline.snap = (e.target as HTMLInputElement).checked));
  $<HTMLInputElement>("all-tracks").addEventListener("change", (e) => timeline.setShowAll((e.target as HTMLInputElement).checked));
  $<HTMLInputElement>("duration").addEventListener("change", (e) => {
    const a = animDef();
    const d = Number((e.target as HTMLInputElement).value);
    if (!a || !state.anim) return;
    if (!(d > 0)) return status("duration must be > 0", true);
    void commit([{ op: "setAnimation", name: state.anim, duration: d, loop: a.loop !== false }], `${state.anim} is now ${d}s`);
  });
  $<HTMLInputElement>("loop").addEventListener("change", (e) => {
    const a = animDef();
    if (!a || !state.anim) return;
    void commit([{ op: "setAnimation", name: state.anim, duration: a.duration, loop: (e.target as HTMLInputElement).checked }]);
  });
  $("dup-anim").addEventListener("click", async () => {
    if (!state.anim) return;
    const from = state.anim;
    const name = await animName("Duplicate Animation", `${from}_copy`);
    if (name && (await commit(copyAnimationOps(from, name), `duplicated ${from} as ${name}`))) showAnimation(name);
  });
  $("rename-anim").addEventListener("click", async () => {
    if (!state.anim) return;
    const from = state.anim;
    const name = await animName("Rename Animation", from, from);
    if (name && name !== from && (await commit([{ op: "renameAnimation", name: from, to: name }]))) showAnimation(name);
  });
  $("del-anim").addEventListener("click", async () => {
    if (!state.anim) return;
    const name = state.anim;
    if (!(await confirmDialog("Delete animation", `Delete animation "${name}" and all of its keys? (Undo brings it back.)`, "Delete", true))) return;
    state.anim = null;
    void commit([{ op: "removeAnimation", name }]);
  });
}

function selectAnimation(name: string | null): void {
  state.anim = name;
  if (name) revealSpineAnimation();
  state.time = 0;
  // Mesh and weight modes show the setup pose. Parameter pins belong to the previous preview.
  if (name && meshState.mode !== "pose") setMode("pose");
  if (Object.keys(state.params).length) state.params = {};
  state.playing = !!name;
  updatePlayButton();
  refreshPanels();
}

function showAnimation(name: string): void {
  state.anim = name;
  revealSpineAnimation();
  state.time = 0;
  refreshPanels();
}

/** Asks for an animation name that is not taken (`current` may keep its own name). */
async function animName(title: string, value: string, current?: string): Promise<string | null> {
  const taken = new Set(Object.keys(state.model?.animations ?? {}));
  return (
    (await dialog({
      title,
      fields: [{ name: "name", label: "Name", value }],
      validate: (x) => {
        const n = String(x.values.name).trim();
        if (!n) return "Enter a name";
        return n !== current && taken.has(n) ? `"${n}" already exists` : null;
      },
    }).then((r) => (r ? String(r.values.name).trim() : null))) ?? null
  );
}

async function newAnimation(): Promise<void> {
  if (!state.model) return;
  const taken = new Set(Object.keys(state.model.animations ?? {}));
  let n = 1;
  while (taken.has(`anim${n}`)) n++;
  const r = await dialog({
    title: "New Animation",
    fields: [
      { name: "name", label: "Name", value: `anim${n}` },
      { name: "duration", label: "Length (seconds)", type: "number", value: 1, step: 0.1, min: 0.01 },
      { name: "loop", label: "Loop", type: "checkbox", value: true },
    ],
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Create", value: "ok", primary: true },
    ],
    validate: (x) => {
      const name = String(x.values.name).trim();
      if (!name) return "Enter a name";
      if (taken.has(name)) return `"${name}" already exists`;
      return Number(x.values.duration) > 0 ? null : "Length must be greater than 0";
    },
  });
  if (!r) return;
  const name = String(r.values.name).trim();
  if (await commit([{ op: "setAnimation", name, duration: Number(r.values.duration), loop: r.values.loop === true }])) showAnimation(name);
}

// ---------- menus

const TOOL_KEYS: Record<string, Tool> = { q: "select", w: "move", e: "rotate", r: "scale", b: "bone" };

function closeMenus(except?: Element): void {
  document.querySelectorAll<HTMLDetailsElement>("details.menu[open]").forEach((d) => d !== except && (d.open = false));
}

function wireMenus(): void {
  const menus = document.querySelectorAll<HTMLDetailsElement>("details.menu");
  menus.forEach((d) => {
    d.addEventListener("toggle", () => d.open && closeMenus(d));
    // hovering another menu while one is open switches to it, like a desktop menu bar
    d.querySelector("summary")!.addEventListener("pointerenter", () => {
      if ([...menus].some((x) => x.open && x !== d)) {
        closeMenus(d);
        d.open = true;
      }
    });
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target as Element).closest("details.menu")) closeMenus();
  });
  const on = (id: string, fn: () => unknown) =>
    $(id).addEventListener("click", () => {
      closeMenus();
      void fn();
    });
  on("m-spine-import", spineImportDialog);
  on("m-spine-export", spineExportDialog);
  on("m-live2d-import", live2dImportDialog);
  on("m-live2d-export", live2dExportDialog);
  on("m-open", openDialog);
  on("m-save", saveFile);
  on("m-save-as", saveFileAs);
  on("m-revert", revertFile);
  on("m-undo", () => undoRedo("undo"));
  on("m-redo", () => undoRedo("redo"));
  on("m-rename", renameSelected);
  on("m-delete", deleteSelected);
  on("m-select-none", () => select(null));
  on("m-fit", fitView);
  on("m-shortcuts", showShortcuts);
  on("m-about", () =>
    alertDialog(
      "Awaken2D",
      "AI-friendly 2D skeletal animation. Every edit here is an op, the same ops agents apply through MCP or the CLI (rig spec lists them), so people and agents can work on the same file.",
    ),
  );
  $<HTMLInputElement>("m-autosave").addEventListener("change", (e) => void setAutosave((e.target as HTMLInputElement).checked));
}

async function showShortcuts(): Promise<void> {
  const rows: Array<[string, string]> = [
    ["Ctrl+S / Ctrl+Shift+S", "Save / Save As"],
    ["Ctrl+O", "Open model"],
    ["Ctrl+Z / Ctrl+Shift+Z", "Undo / Redo"],
    ["Q W E R B", "Select, Move, Rotate, Scale, New bone"],
    ["Shift while dragging", "Snap (5 units, 15°, 0.1×)"],
    ["Drag empty space", "Box-select bones / vertices (Shift adds, Ctrl removes)"],
    ["Shift/Ctrl+click a bone", "Add or remove it from the selection"],
    ["Right / middle drag", "Pan the view"],
    ["Ctrl+A (Mesh mode)", "Select every vertex"],
    ["T", "Toggle image compensation (Setup)"],
    ["Shift+T", "Toggle bone compensation (Setup)"],
    ["Shift+A (Live2D)", "Lock drawable objects: clicks pick deformers, not art meshes"],
    ["Shift+D (Live2D)", "Lock deformers: they are not picked or edited in the viewport"],
    ["1 2 3", "Pose, Mesh, Weights mode"],
    ["F2 / Shift+Del", "Rename / Delete selected bone or slot"],
    ["Space, ← →, Home/End", "Play, step frames, jump"],
    ["K", "Key the selected bone at the playhead"],
    ["Ctrl+C / Ctrl+V, Del", "Copy / paste / delete timeline keys"],
    ["F, wheel", "Fit, zoom"],
    ["Drag a field label", "Scrub the value (Shift: fine)"],
  ];
  await customDialog<void>("Keyboard Shortcuts", 560, (done) => {
    const close = h("button", { class: "primary", onclick: () => done(null) }, "Close");
    return {
      body: h("div", { class: "dlg-body shortcuts" }, ...rows.flatMap(([k, v]) => [h("span", { class: "sc-key" }, k), h("span", {}, v)])),
      footer: h("div", { class: "dlg-footer" }, close),
      onEnter: () => done(null),
      focus: close,
    };
  });
}

// resizable panels, remembered per browser
const LAYOUT_KEY = "awaken2d.layout";
function restoreLayout(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<string, string>;
    for (const [k, v] of Object.entries(saved)) document.documentElement.style.setProperty(k, v);
  } catch {
    /* storage unavailable: defaults */
  }
}
function wireResizers(): void {
  const root = document.documentElement;
  document.querySelectorAll<HTMLElement>(".resizer").forEach((bar) => {
    bar.addEventListener("pointerdown", (e) => {
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("active");
      const which = bar.dataset.resize!;
      const main = $("main").getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        if (which === "left") root.style.setProperty("--left-w", `${Math.max(150, Math.min(520, ev.clientX - main.left))}px`);
        else if (which === "right") root.style.setProperty("--right-w", `${Math.max(200, Math.min(560, main.right - ev.clientX))}px`);
        else {
          const status = document.querySelector(".statusbar")!.getBoundingClientRect().height;
          root.style.setProperty("--tl-h", `${Math.max(110, Math.min(window.innerHeight - 260, window.innerHeight - ev.clientY - status))}px`);
        }
      };
      const up = () => {
        bar.classList.remove("active");
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        try {
          const keep: Record<string, string> = {};
          for (const k of ["--left-w", "--right-w", "--tl-h"]) {
            const v = root.style.getPropertyValue(k);
            if (v) keep[k] = v;
          }
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(keep));
        } catch {
          /* not persisted */
        }
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
  });
}

function togglePlay(): void {
  if (meshState.mode !== "pose") setMode("pose");
  if (!state.anim) {
    // Setup has nothing to play: start the first animation instead of doing nothing
    const first = Object.keys(state.model?.animations ?? {})[0];
    if (!first) return status("no animations yet: create one with ＋ next to the animation list");
    state.anim = first;
    state.time = 0;
    refreshPanels();
  }
  state.playing = !state.playing;
  updatePlayButton();
  const pinned = Object.keys(state.params);
  if (state.playing && pinned.length) status(`${pinned.length} parameter slider(s) pinned (${pinned.join(", ")}): they override the animation until Reset sliders`);
}

/** Help › Language: English / 한국어 / 日本語 (switching reloads the page). */
function setupLanguageMenu(): void {
  const body = $("m-about").parentElement!;
  const buttons = LANGS.map(([code, label]) => {
    const b = h("button", { class: "lang" + (code === currentLang() ? " active" : ""), onclick: () => setLang(code) }, raw(label), code === currentLang() ? h("kbd", {}, "✓") : "");
    return b;
  });
  body.append(h("hr"), h("div", { class: "menu-label" }, "Language"), ...buttons);
}

async function main(): Promise<void> {
  setupLanguageMenu();
  useSetupPose((m) => computePose(m));
  startI18n();
  renderer = new MeshRenderer(glCanvas);
  restoreLayout();
  timeline = new Timeline($<HTMLCanvasElement>("tl-canvas"), $("tl-inspector"), {
    model: () => state.model,
    animation: () => state.anim,
    time: () => state.time,
    setTime: (t) => {
      state.time = t;
      // scrubbing means "show me this frame"; mesh/weight modes only ever show the setup pose
      if (state.anim && meshState.mode !== "pose") setMode("pose");
      refreshProps();
    },
    pause: () => {
      state.playing = false;
      updatePlayButton();
    },
    pose: () => lastPose,
    selectedBone: () => (state.sel?.kind === "bone" ? state.sel.id : null),
    selectedSlot: () => (state.sel?.kind === "slot" && modelTarget() !== "live2d" ? state.sel.id : null),
    pinnedParam: (id) => (typeof state.params[id] === "number" ? state.params[id] : undefined),
    selectBone: (id) => select({ kind: "bone", id }),
    pickEvent,
    commit,
    preview: (m) => (state.preview = m),
    apply: (m, ops) => applyOps(m, ops).model,
    status,
  });
  // handle for debugging and for agents driving the page through a browser
  Object.assign(window, { awaken2d: { state, commit, openFile, fitView, select, setTool, saveFile, i18nMisses, get timeline() { return timeline; }, get lastPose() { return lastPose; } } });
  wire();
  const { files } = await api<{ files: string[] }>("/api/files");
  const wanted = new URLSearchParams(location.search).get("file");
  const first = wanted && files.includes(wanted) ? wanted : files[0];
  if (first) {
    await openFile(first);
    await refreshFileList();
  } else {
    await refreshFileList();
    status("no *.rig.json files here yet: ask the agent to create one (rig_new, target spine or live2d) or use File › Import", true);
  }
  setTool("select");
  let carry = true;
  let compBones = false;
  try {
    carry = localStorage.getItem(CARRY_KEY) !== "0";
    compBones = localStorage.getItem(COMP_BONES_KEY) === "1";
  } catch {
    /* default */
  }
  setCompensation(!carry, compBones);
  requestAnimationFrame(frame);
}

main().catch((e) => status(`editor failed to start: ${(e as Error).message}`, true));
