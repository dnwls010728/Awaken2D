// Local editor server: serves the web UI (TypeScript is type-stripped on the fly, so the browser runs the
// same core code as the CLI) and the document API.
//
// Documents: every open model has an in-memory working copy. Edits (ops), undo and redo change the working
// copy only; Save writes it to disk (or every edit does, with auto-save on). Changes made on disk by someone
// else (an agent via MCP/CLI) are picked up live when the working copy has no unsaved edits; otherwise the
// editor is told about the conflict and the user chooses which version to keep.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { applyOps, formatIssues, normalizeModel, serializeModel, validateModel } from "../core/index.ts";
import type { Issue, Model, Op } from "../core/index.ts";
import { AUDIO_DIR, addEventSound, copyEventAudio, exportSpineData, importSpine, modelImageLoader } from "../spine/index.ts";
import { exportLive2D, importLive2D } from "../live2d/index.ts";
import { encodePNG } from "../render/png.ts";
import { browseDir, nativePick, nativePickAvailable } from "./files.ts";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

export interface ServeOptions {
  /** Folder whose *.rig.json files can be opened and edited. */
  root: string;
  port?: number;
  host?: string;
  /** Write every edit to disk immediately (the old behaviour). Default false: explicit Save. */
  autosave?: boolean;
}

interface Doc {
  /** Working copy. */
  current: string;
  /** What is on disk (as last loaded or saved). */
  disk: string;
  /** Newer disk content that arrived while the working copy had unsaved edits. */
  conflict?: string;
  undo: string[];
  redo: string[];
  version: number;
  clients: Set<ServerResponse>;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  /** Parsed working copy (text it was parsed from), so edits do not re-parse megabytes of JSON. */
  cache?: { text: string; model: Model };
  /** Full validation result and the version it belongs to (computed in a worker, see scheduleValidation). */
  issues?: Issue[];
  issuesVersion?: number;
  validateTimer?: ReturnType<typeof setTimeout>;
  /** A validation run is scheduled or in progress. */
  validatePending?: boolean;
}

type Source = "edit" | "undo" | "redo" | "external" | "saved" | "reverted" | "conflict" | "resolved" | "validated";

const HISTORY_LIMIT = 200;

export function startServer(opts: ServeOptions): Promise<{ url: string; close: () => void }> {
  const root = resolve(opts.root);
  const docs = new Map<string, Doc>();
  const tsCache = new Map<string, { mtime: number; code: string }>();
  const settings = { autosave: opts.autosave === true };
  let port = opts.port ?? 5178;

  /** Resolves a client-supplied path and refuses anything outside `base`. */
  const inside = (base: string, p: string): string => {
    const full = resolve(base, p);
    const rel = relative(base, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw httpError(403, `path outside ${base}: ${p}`);
    return full;
  };
  const rel = (full: string) => relative(root, full).split(sep).join("/");
  const modelPath = (file: unknown, mustExist = true): string => {
    if (typeof file !== "string" || !file.endsWith(".json")) throw httpError(400, "file must be a .json model path");
    const full = inside(root, file);
    if (mustExist && !existsSync(full)) throw httpError(404, `no such model: ${file}`);
    return full;
  };
  /** Export destination: an absolute folder the user picked (anywhere), or a folder relative to the project. */
  const exportDir = (out: string): string => (isAbsolute(out) ? resolve(out) : inside(root, out));
  /** A path for messages: project-relative inside the project, absolute outside it. */
  const shown = (full: string): string => {
    const r = relative(root, full);
    return r.startsWith("..") || isAbsolute(r) ? full.split(sep).join("/") : r.split(sep).join("/");
  };
  const newModelPath = (file: unknown, overwrite: unknown): string => {
    if (typeof file !== "string" || !/\.rig\.json$/.test(file)) throw httpError(400, "the file name must end in .rig.json");
    const full = inside(root, file);
    if (existsSync(full) && overwrite !== true) throw httpError(409, `${file} already exists`);
    return full;
  };

  const docFor = (full: string): Doc => {
    let d = docs.get(full);
    if (!d) {
      const text = readFileSync(full, "utf8");
      d = { current: text, disk: text, undo: [], redo: [], version: 1, clients: new Set() };
      docs.set(full, d);
    }
    return d;
  };
  const dirty = (d: Doc) => d.current !== d.disk;

  const modelOf = (d: Doc): Model => {
    if (d.cache?.text !== d.current) d.cache = { text: d.current, model: normalizeModel(JSON.parse(d.current)) };
    return d.cache.model;
  };

  // ---- validation: structural checks are instant; pose sampling (physics) runs in a worker after edits settle
  let worker: Worker | null = null;
  let jobId = 0;
  const jobs = new Map<number, (r: { issues?: Issue[]; error?: string }) => void>();
  const validateAsync = (text: string, baseDir: string) =>
    new Promise<{ issues?: Issue[]; error?: string }>((done) => {
      if (!worker) {
        worker = new Worker(new URL("./validate-worker.ts", import.meta.url));
        worker.unref();
        worker.on("message", (m: { id: number; issues?: Issue[]; error?: string }) => {
          jobs.get(m.id)?.(m);
          jobs.delete(m.id);
        });
        worker.on("error", (e) => {
          for (const j of jobs.values()) j({ error: e.message });
          jobs.clear();
          worker = null;
        });
      }
      const id = ++jobId;
      jobs.set(id, done);
      worker.postMessage({ id, text, baseDir });
    });
  const scheduleValidation = (full: string, d: Doc, delay = 400) => {
    clearTimeout(d.validateTimer);
    d.validatePending = true;
    d.validateTimer = setTimeout(async () => {
      const version = d.version;
      const r = await validateAsync(d.current, dirname(full));
      if (d.version !== version) return; // edited meanwhile: a newer run is scheduled
      d.validatePending = false;
      if (!r.issues) return;
      d.issues = r.issues;
      d.issuesVersion = version;
      notify(d, "validated");
    }, delay);
    d.validateTimer.unref?.();
  };
  /** Current issues: the full result when it is up to date, else the instant structural checks. */
  const issuesOf = (full: string, d: Doc): { issues: Issue[]; validating: boolean } => {
    if (d.issuesVersion === d.version && d.issues) return { issues: d.issues, validating: false };
    if (!d.validatePending) scheduleValidation(full, d, 0);
    return { issues: validateModel(modelOf(d), { baseDir: dirname(full), poseSamples: 0 }), validating: true };
  };

  const notify = (d: Doc, source: Source) => {
    const extra = source === "validated" ? { issues: d.issues } : {};
    const msg = `data: ${JSON.stringify({ version: d.version, source, dirty: dirty(d), conflict: d.conflict !== undefined, ...extra })}\n\n`;
    for (const c of d.clients) c.write(msg);
  };
  const writeDisk = (full: string, d: Doc) => {
    writeFileSync(full, d.current, "utf8");
    d.disk = d.current;
    d.conflict = undefined;
  };

  /** Replaces the working copy (edits, undo/redo, reverts, accepted disk changes). */
  const change = (full: string, d: Doc, text: string, source: Source, history: "push" | "none" = "push", model?: Model) => {
    if (text === d.current) return;
    if (model) d.cache = { text, model };
    if (history === "push") {
      d.undo.push(d.current);
      if (d.undo.length > HISTORY_LIMIT) d.undo.shift();
      d.redo = [];
    }
    d.current = text;
    d.version++;
    if (settings.autosave && (source === "edit" || source === "undo" || source === "redo")) writeDisk(full, d);
    notify(d, source);
    scheduleValidation(full, d);
  };

  const watchFile = (full: string, d: Doc) => {
    if (d.watcher) return;
    d.watcher = watch(full, () => {
      clearTimeout(d.timer);
      d.timer = setTimeout(() => {
        try {
          const text = readFileSync(full, "utf8");
          JSON.parse(text); // ignore half-written files
          if (text === d.disk || text === d.conflict) return; // our own save, or already known
          if (!dirty(d)) {
            d.disk = text;
            change(full, d, text, "external");
          } else {
            d.conflict = text;
            notify(d, "conflict");
          }
        } catch {
          /* next event will retry */
        }
      }, 60);
    });
    // the file or its folder was deleted/renamed (Windows reports EPERM): stop watching instead of crashing;
    // the next request for the file re-opens it and watches again
    d.watcher.on("error", () => {
      d.watcher?.close();
      d.watcher = undefined;
      if (!existsSync(full)) docs.delete(full);
    });
  };

  /** Document state for the client; `lean` leaves out the model (the client applied the ops itself). */
  const info = (full: string, d: Doc, lean = false) => {
    const { issues, validating } = issuesOf(full, d);
    return {
      file: rel(full),
      version: d.version,
      ...(lean ? {} : { model: modelOf(d) }),
      issues,
      validating,
      canUndo: d.undo.length > 0,
      canRedo: d.redo.length > 0,
      dirty: dirty(d),
      conflict: d.conflict !== undefined,
      autosave: settings.autosave,
    };
  };

  const listModels = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, depth + 1);
        else if (name.endsWith(".rig.json")) out.push(rel(full));
      }
    };
    walk(root, 0);
    return out.sort();
  };

  /** Model text re-targeted to live at `toFull`: image paths are rewritten relative to the new folder. */
  const retarget = (text: string, fromFull: string, toFull: string): string => {
    if (dirname(fromFull) === dirname(toFull)) return text;
    const model = normalizeModel(JSON.parse(text));
    for (const img of Object.values(model.images ?? {})) {
      img.path = relative(dirname(toFull), resolve(dirname(fromFull), img.path)).split(sep).join("/");
    }
    return serializeModel(model) + "\n";
  };

  const serveTs = (full: string): string => {
    const mtime = statSync(full).mtimeMs;
    const hit = tsCache.get(full);
    if (hit && hit.mtime === mtime) return hit.code;
    const code = stripTypeScriptTypes(readFileSync(full, "utf8"))
      // Node built-ins used by the file-system parts of the core are shimmed in the browser
      .replace(/from\s+"node:(fs|path)"/g, 'from "/web/shims/$1.js"');
    tsCache.set(full, { mtime, code });
    return code;
  };

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only answer requests addressed to this machine
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host && !["127.0.0.1", "localhost", "[::1]"].includes(host)) throw httpError(403, "unexpected Host header");
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = decodeURIComponent(url.pathname);
      if (p.startsWith("/api/")) return await api(p, url, req, res);
      if (p === "/" || p === "/index.html") return send(res, 200, readFileSync(join(APP_ROOT, "web/index.html")), MIME[".html"]);
      if (p.startsWith("/web/") || p.startsWith("/src/")) {
        const full = inside(APP_ROOT, "." + p);
        if (!existsSync(full) || statSync(full).isDirectory()) throw httpError(404, "not found");
        const ext = extname(full);
        const body = ext === ".ts" ? serveTs(full) : readFileSync(full);
        return send(res, 200, body, MIME[ext] ?? "application/octet-stream");
      }
      throw httpError(404, "not found");
    } catch (e) {
      const err = e as Error & { status?: number };
      send(res, err.status ?? 500, JSON.stringify({ ok: false, error: err.message }), MIME[".json"]);
    }
  });

  async function api(p: string, url: URL, req: IncomingMessage, res: ServerResponse) {
    const json = (status: number, body: unknown) => send(res, status, JSON.stringify(body), MIME[".json"]);
    if (req.method === "POST" && !/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
      // browsers cannot send JSON cross-origin without a preflight we never answer: blocks CSRF
      throw httpError(415, "POST bodies must be application/json");
    }
    const body = req.method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};
    const openDoc = () => {
      const full = modelPath(body.file ?? url.searchParams.get("file"));
      const d = docFor(full);
      watchFile(full, d);
      return { full, d };
    };
    switch (p) {
      case "/api/delete": {
        // "deleting" moves the model, and the images no other model uses, into .awaken2d-trash/<time>/ (recoverable)
        const full = modelPath(body.file);
        if (!full.endsWith(".rig.json")) throw httpError(400, "only .rig.json models can be deleted");
        const d = docs.get(full);
        if (d && dirty(d) && body.discard !== true) throw httpError(409, "the model has unsaved edits (pass discard: true to delete anyway)");
        let model: Model | null = null;
        try {
          model = normalizeModel(JSON.parse(readFileSync(full, "utf8")));
        } catch {
          /* unreadable: just the file */
        }
        const mine = new Set(Object.values(model?.images ?? {}).map((i) => resolve(dirname(full), i.path)));
        for (const other of listModels().map((f) => resolve(root, f))) {
          if (other === full) continue;
          try {
            const m = JSON.parse(readFileSync(other, "utf8")) as Model;
            for (const i of Object.values(m.images ?? {})) mine.delete(resolve(dirname(other), i.path));
          } catch {
            /* skip */
          }
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const trash = join(root, ".awaken2d-trash", stamp);
        const moved: string[] = [];
        const moveOut = (src: string) => {
          const dst = join(trash, relative(root, src));
          mkdirSync(dirname(dst), { recursive: true });
          renameSync(src, dst);
          moved.push(rel(src));
        };
        d?.watcher?.close();
        docs.delete(full);
        moveOut(full);
        for (const img of mine) {
          if (!existsSync(img)) continue;
          try {
            inside(root, img);
          } catch {
            continue; // never touch files outside the project
          }
          moveOut(img);
          // drop folders the move left empty (e.g. images/<model>/)
          for (let dir = dirname(img); dir.startsWith(root) && dir !== root; dir = dirname(dir)) {
            try {
              if (readdirSync(dir).length) break;
              rmdirSync(dir);
            } catch {
              break;
            }
          }
        }
        return json(200, { ok: true, moved, trash: rel(trash) });
      }
      case "/api/files":
        return json(200, { root, files: listModels(), dirty: [...docs].filter(([, d]) => dirty(d)).map(([f]) => rel(f)) });
      case "/api/settings":
        if (req.method === "POST" && typeof body.autosave === "boolean") settings.autosave = body.autosave;
        return json(200, { ok: true, ...settings });
      case "/api/model": {
        const { full, d } = openDoc();
        return json(200, { ok: true, ...info(full, d) });
      }
      case "/api/asset": {
        const full = modelPath(url.searchParams.get("file"));
        const asset = inside(root, resolve(dirname(full), url.searchParams.get("path") ?? ""));
        if (!existsSync(asset)) throw httpError(404, `missing asset ${url.searchParams.get("path")}`);
        // images are big and rarely change: let the browser revalidate instead of downloading them again
        const st = statSync(asset);
        const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag, "cache-control": "no-cache" });
          return res.end();
        }
        res.writeHead(200, { "content-type": MIME[extname(asset)] ?? "application/octet-stream", etag, "cache-control": "no-cache" });
        return res.end(readFileSync(asset));
      }
      case "/api/apply": {
        const { full, d } = openDoc();
        let result;
        try {
          result = applyOps(modelOf(d), (body.ops as Op[]) ?? []);
        } catch (e) {
          return json(400, { ok: false, error: (e as Error).message });
        }
        change(full, d, serializeModel(result.model) + "\n", "edit", "push", result.model);
        const out = info(full, d, body.lean === true);
        return json(200, { ok: true, log: result.log, summary: formatIssues(out.issues), ...out });
      }
      case "/api/undo":
      case "/api/redo": {
        const { full, d } = openDoc();
        const isUndo = p === "/api/undo";
        const from = isUndo ? d.undo : d.redo;
        const to = isUndo ? d.redo : d.undo;
        const text = from.pop();
        if (text === undefined) return json(400, { ok: false, error: `nothing to ${isUndo ? "undo" : "redo"}` });
        to.push(d.current);
        change(full, d, text, isUndo ? "undo" : "redo", "none");
        return json(200, { ok: true, ...info(full, d) });
      }
      case "/api/save": {
        const { full, d } = openDoc();
        writeDisk(full, d);
        notify(d, "saved");
        return json(200, { ok: true, ...info(full, d) });
      }
      case "/api/save-as": {
        const { full, d } = openDoc();
        const target = newModelPath(body.to, body.overwrite);
        mkdirSync(dirname(target), { recursive: true });
        const text = retarget(d.current, full, target);
        writeFileSync(target, text, "utf8");
        docs.get(target)?.watcher?.close();
        docs.set(target, { current: text, disk: text, undo: [], redo: [], version: 1, clients: new Set() });
        // the original keeps what is on its disk; unsaved edits now live in the copy
        if (dirty(d)) change(full, d, d.disk, "reverted", "none");
        return json(200, { ok: true, ...info(target, docs.get(target)!) });
      }
      case "/api/revert": {
        const { full, d } = openDoc();
        change(full, d, d.disk, "reverted");
        return json(200, { ok: true, ...info(full, d) });
      }
      case "/api/resolve": {
        const { full, d } = openDoc();
        if (d.conflict === undefined) return json(200, { ok: true, ...info(full, d) });
        if (body.use === "disk") {
          const text = d.conflict;
          d.disk = text;
          d.conflict = undefined;
          change(full, d, text, "resolved");
        } else {
          // keep the working copy; the next save overwrites the newer disk file
          d.disk = d.conflict;
          d.conflict = undefined;
          notify(d, "resolved");
        }
        return json(200, { ok: true, ...info(full, d) });
      }
      case "/api/browse": {
        // the Import / Export pickers: a folder listing (default: the project folder)
        const exts = Array.isArray(body.exts) ? body.exts.filter((e): e is string => typeof e === "string") : [];
        let dir = typeof body.dir === "string" && body.dir ? resolve(root, body.dir) : root;
        // a folder that does not exist yet (e.g. the default export folder): start at its nearest existing parent
        while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
        try {
          return json(200, { ok: true, ...browseDir(dir, exts), project: root.split(sep).join("/"), native: nativePickAvailable() });
        } catch (e) {
          return json(400, { ok: false, error: (e as Error).message });
        }
      }
      case "/api/mkdir": {
        // "New folder" in the picker: a plain name inside the folder being browsed
        if (typeof body.dir !== "string" || !body.dir) throw httpError(400, "dir must be a folder");
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!/^[^\\/:*?"<>|]+$/.test(name) || name === "." || name === "..") throw httpError(400, 'the folder name cannot contain \\ / : * ? " < > |');
        const dir = join(resolve(root, body.dir), name);
        if (existsSync(dir)) throw httpError(409, `${name} already exists`);
        mkdirSync(dir);
        return json(200, { ok: true, dir: dir.split(sep).join("/") });
      }
      case "/api/native-pick": {
        // the operating system's own open / folder dialog (Windows), shown on this machine
        const mode = body.mode === "folder" ? "folder" : "file";
        const exts = Array.isArray(body.exts) ? body.exts.filter((e): e is string => typeof e === "string") : [];
        const start = typeof body.start === "string" && body.start ? resolve(root, body.start) : root;
        try {
          const path = await nativePick({ mode, exts, start, title: typeof body.title === "string" ? body.title : undefined });
          return json(200, { ok: true, path });
        } catch (e) {
          return json(400, { ok: false, error: (e as Error).message });
        }
      }
      case "/api/add-sound": {
        // a sound file the user picked is copied into audio/ next to the model; events then play it by that name
        const full = modelPath(body.file);
        if (typeof body.source !== "string" || !body.source) throw httpError(400, "source must be the path to a .wav, .ogg or .mp3 file");
        try {
          return json(200, { ok: true, path: addEventSound(resolve(root, body.source), dirname(full)) });
        } catch (e) {
          return json(400, { ok: false, error: (e as Error).message });
        }
      }
      case "/api/spine-import": {
        // a Spine export (JSON + atlas next to it) becomes a new model; its region images go to images/ beside it
        const target = newModelPath(body.file, body.overwrite);
        if (typeof body.source !== "string" || !body.source) throw httpError(400, "source must be the path to a Spine skeleton .json");
        const source = resolve(root, body.source);
        if (!existsSync(source)) throw httpError(400, `no such file: ${body.source}`);
        mkdirSync(dirname(target), { recursive: true });
        let res;
        try {
          res = importSpine(source, target, {
            atlas: typeof body.atlas === "string" && body.atlas ? resolve(root, body.atlas) : undefined,
            mesh: body.mesh === "auto" ? "auto" : undefined,
          });
        } catch (e) {
          return json(400, { ok: false, error: (e as Error).message });
        }
        docs.delete(target);
        return json(200, { ok: true, log: res.log, warnings: res.warnings, ...info(target, docFor(target)) });
      }
      case "/api/live2d-import": {
        // a Live2D runtime model (model3.json or moc3) becomes a new model; textures are copied to images/ beside it
        const target = newModelPath(body.file, body.overwrite);
        if (typeof body.source !== "string" || !body.source) throw httpError(400, "source must be the path to a .model3.json or .moc3");
        const source = resolve(root, body.source);
        if (!existsSync(source)) throw httpError(400, `no such file: ${body.source}`);
        mkdirSync(dirname(target), { recursive: true });
        let res;
        try {
          res = importLive2D(source, target);
        } catch (e) {
          return json(400, { ok: false, error: (e as Error).message });
        }
        docs.delete(target);
        return json(200, { ok: true, log: res.log, warnings: res.warnings, ...info(target, docFor(target)) });
      }
      case "/api/live2d-export": {
        // the working copy (with unsaved edits) is what gets exported
        const { full, d } = openDoc();
        if (typeof body.out !== "string" || !body.out) throw httpError(400, "out must be a folder (picked in the editor, or relative to the project)");
        const outDir = exportDir(body.out);
        const name = typeof body.name === "string" && body.name ? body.name : basename(full).replace(/\.rig\.json$|\.json$/i, "");
        if (!/^[^\\/:*?"<>|]+$/.test(name)) throw httpError(400, "name must be a plain file name");
        const res = exportLive2D(modelOf(d), dirname(full), outDir, { name });
        return json(200, { ok: true, out: shown(outDir), files: res.files, warnings: res.warnings });
      }
      case "/api/spine-export": {
        // the working copy (with unsaved edits) is what gets exported
        const { full, d } = openDoc();
        if (typeof body.out !== "string" || !body.out) throw httpError(400, "out must be a folder (picked in the editor, or relative to the project)");
        const outDir = exportDir(body.out);
        const name = typeof body.name === "string" && body.name ? body.name : basename(full).replace(/\.rig\.json$|\.json$/i, "");
        if (!/^[^\\/:*?"<>|]+$/.test(name)) throw httpError(400, "name must be a plain file name");
        const model = modelOf(d);
        const res = exportSpineData(model, { name, loadImage: modelImageLoader(model, dirname(full)) });
        mkdirSync(join(outDir, "images"), { recursive: true });
        // event sounds go to audio/ beside the JSON; a skeleton without an audio folder then points there
        const sounds = copyEventAudio(model, dirname(full), outDir);
        if (sounds.copied && !res.json.skeleton.audio) res.json.skeleton.audio = `./${AUDIO_DIR}/`;
        writeFileSync(join(outDir, `${name}.json`), JSON.stringify(res.json, null, "\t"));
        writeFileSync(join(outDir, `${name}.atlas`), res.atlas);
        writeFileSync(join(outDir, `${name}.png`), encodePNG(res.page));
        for (const [id, img] of res.images) {
          const file = inside(outDir, join("images", `${id}.png`));
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, encodePNG(img));
        }
        for (const p of sounds.missing) res.warnings.push(`event sound "${p}" is not in audio/ next to the model: not copied`);
        const files = [`${name}.json`, `${name}.atlas`, `${name}.png`, `images/ (${res.images.size})`, ...(sounds.copied ? [`audio/ (${sounds.copied})`] : [])];
        return json(200, { ok: true, out: shown(outDir), files, warnings: res.warnings });
      }
      case "/api/events": {
        const { d } = openDoc();
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ version: d.version, source: "hello", dirty: dirty(d), conflict: d.conflict !== undefined })}\n\n`);
        d.clients.add(res);
        req.on("close", () => d.clients.delete(res));
        return;
      }
      default:
        throw httpError(404, `unknown endpoint ${p}`);
    }
  }

  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : port;
      ok({
        url: `http://${opts.host ?? "127.0.0.1"}:${port}/`,
        close: () => {
          void worker?.terminate();
          for (const d of docs.values()) {
            clearTimeout(d.validateTimer);
            d.watcher?.close();
            for (const c of d.clients) c.end();
          }
          server.close();
        },
      });
    });
  });
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 20_000_000) fail(httpError(413, "request too large"));
    });
    req.on("end", () => {
      try {
        ok(data ? JSON.parse(data) : {});
      } catch {
        fail(httpError(400, "body must be JSON"));
      }
    });
    req.on("error", fail);
  });
}
