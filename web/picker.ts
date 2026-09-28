// In-app file / folder picker for Import and Export (paths are picked, never typed): folders from the editor
// server (/api/browse, drives on Windows), or the system dialog on Windows (/api/native-pick).
import { customDialog, el, promptText } from "./dialog.ts";

export interface PickOptions {
  title: string;
  mode: "file" | "folder";
  /** File mode: extensions shown (e.g. [".model3.json", ".moc3"]). */
  exts?: string[];
  /** Folder to start in (absolute or project-relative); else the last folder used for `key`, else the project. */
  start?: string;
  /** Remembers the last folder per purpose (e.g. "live2d-import"). */
  key: string;
}

interface Listing {
  dir: string;
  parent: string | null;
  entries: Array<{ name: string; dir: boolean }>;
  roots: string[];
  home: string;
  project: string;
  native: boolean;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as T;
}

const remembered = (key: string): string | undefined => {
  try {
    return localStorage.getItem(`awaken2d.pick.${key}`) ?? undefined;
  } catch {
    return undefined;
  }
};
const remember = (key: string, dir: string) => {
  try {
    localStorage.setItem(`awaken2d.pick.${key}`, dir);
  } catch {
    /* storage unavailable: nothing to remember */
  }
};
const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || p;

/** Shows the picker; resolves with an absolute path (forward slashes), or null when cancelled. */
export function pickPath(o: PickOptions): Promise<string | null> {
  return customDialog<string>(o.title, 560, (done) => {
    let cur: Listing | null = null;
    let selected: string | null = null;
    const places = el("div", { class: "key-chips pick-places" });
    const crumbs = el("div", { class: "pick-crumbs", translate: "no" });
    const filter = el("input", { type: "search", placeholder: "Filter…" }) as HTMLInputElement;
    const list = el("div", { class: "dlg-list pick-list", tabIndex: 0 });
    list.setAttribute("translate", "no"); // file and folder names
    const error = el("div", { class: "dlg-error" });
    const note = el("div", { class: "pick-note" }, o.mode === "file" && o.exts?.length ? `Showing ${o.exts.join(", ")}` : o.mode === "folder" ? "Double-click a folder to open it; Select uses the folder you are in (or the one selected)." : "");
    const primary = el("button", { class: "primary", onclick: () => choose() }, o.mode === "file" ? "Open" : "Select folder") as HTMLButtonElement;
    const newFolder = el("button", { onclick: () => void makeFolder() }, "New folder");
    const native = el("button", { title: "Pick with the Windows file dialog", onclick: () => void pickNative() }, "Windows dialog…");
    native.style.display = "none";
    if (o.mode !== "folder") newFolder.style.display = "none";

    const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
    const choose = () => {
      if (!cur) return;
      if (o.mode === "file") {
        if (!selected) return void (error.textContent = "Pick a file");
        remember(o.key, cur.dir);
        return done(join(cur.dir, selected));
      }
      const dir = selected ? join(cur.dir, selected) : cur.dir;
      remember(o.key, dir);
      done(dir);
    };
    const render = () => {
      if (!cur) return;
      const q = filter.value.toLowerCase();
      const entries = cur.entries.filter((e) => (o.mode === "file" || e.dir) && (!q || e.name.toLowerCase().includes(q)));
      list.replaceChildren(
        ...(cur.parent ? [el("div", { class: "dlg-list-item pick-up", ondblclick: () => void go(cur!.parent!), onclick: () => void go(cur!.parent!) }, "⬆ ..")] : []),
        ...entries.map((e) =>
          el(
            "div",
            {
              class: `dlg-list-item ${e.dir ? "dir" : "file"} ${selected === e.name ? "selected" : ""}`,
              title: e.name,
              onclick: () => {
                selected = e.dir && o.mode === "file" ? null : e.name;
                error.textContent = "";
                render();
              },
              ondblclick: () => (e.dir ? void go(join(cur!.dir, e.name)) : ((selected = e.name), choose())),
            },
            `${e.dir ? "📁" : "📄"} ${e.name}`,
          ),
        ),
        ...(entries.length ? [] : [el("div", { class: "pick-empty" }, o.mode === "file" ? "No matching files here" : "No sub-folders")]),
      );
      primary.disabled = o.mode === "file" && !selected;
      primary.textContent = o.mode === "file" ? "Open" : selected ? `Select "${selected}"` : "Select this folder";
    };
    const go = async (dir?: string) => {
      try {
        cur = await post<Listing>("/api/browse", { dir, exts: o.exts ?? [] });
      } catch (e) {
        if (!cur && dir) return void go(); // a remembered folder that is gone: start at the project
        error.textContent = (e as Error).message;
        return;
      }
      selected = null;
      filter.value = "";
      error.textContent = "";
      native.style.display = cur.native ? "" : "none";
      // places: project, home, drives
      const jump = (label: string, dir: string, title = dir) => el("button", { class: `chip${cur!.dir === dir ? " active" : ""}`, title, onclick: () => void go(dir) }, label);
      places.replaceChildren(jump("Project", cur.project), jump("Home", cur.home), ...cur.roots.map((r) => jump(r.replace(/\/$/, ""), r)));
      // breadcrumbs: each segment opens that folder
      const parts = cur.dir.split("/").filter(Boolean);
      const isDrive = /^[A-Za-z]:$/.test(parts[0] ?? "");
      crumbs.replaceChildren(
        ...parts.flatMap((part, i) => {
          const path = (isDrive ? "" : "/") + parts.slice(0, i + 1).join("/") + (i === 0 && isDrive ? "/" : "");
          return [...(i ? [el("span", { class: "sep" }, "›")] : []), el("button", { class: "crumb", onclick: () => void go(path) }, part)];
        }),
      );
      render();
      list.scrollTop = 0;
    };
    const makeFolder = async () => {
      if (!cur) return;
      const name = await promptText("New folder", "Folder name");
      if (!name) return;
      try {
        const r = await post<{ dir: string }>("/api/mkdir", { dir: cur.dir, name });
        await go(r.dir);
      } catch (e) {
        error.textContent = (e as Error).message;
      }
    };
    const pickNative = async () => {
      try {
        const r = await post<{ path: string | null }>("/api/native-pick", { mode: o.mode, exts: o.exts ?? [], title: o.title, start: cur?.dir });
        if (!r.path) return;
        remember(o.key, o.mode === "file" ? parentOf(r.path) : r.path);
        done(r.path);
      } catch (e) {
        error.textContent = (e as Error).message;
      }
    };
    filter.addEventListener("input", render);
    list.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && cur?.parent) void go(cur.parent);
    });
    void go(o.start ?? remembered(o.key));
    const body = el("div", { class: "dlg-body pick" }, places, crumbs, filter, list, note, error);
    const footer = el("div", { class: "dlg-footer" }, native, newFolder, el("span", { class: "spacer" }), el("button", { onclick: () => done(null) }, "Cancel"), primary);
    return { body, footer, onEnter: choose, focus: list };
  });
}
