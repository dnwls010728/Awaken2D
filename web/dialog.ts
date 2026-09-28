// Modal dialogs styled like the editor (replacing window.prompt / confirm / alert).
// Esc cancels, Enter confirms the primary button, focus starts on the first field.

export interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "checkbox" | "select" | "list" | "path";
  value?: string | number | boolean;
  options?: Array<[string, string]>; // select / list: [value, label]
  placeholder?: string;
  hint?: string;
  step?: number;
  min?: number;
  /** list: right-click menu of an item; an action returning true removes the item from the list. */
  menu?: (value: string) => MenuItem[];
  /** path: opens a picker (given the current value) and resolves with the chosen path, or null. Paths are never typed. */
  browse?: (current: string) => Promise<string | null>;
  /** path: shows a ✕ that clears it. */
  optional?: boolean;
  /** path / text: called after the user picks or types a value; `set` updates other text / path fields. */
  onPick?: (value: string, set: (name: string, value: string) => void) => void;
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  run: () => Promise<boolean | void> | boolean | void;
}

export interface Button {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export interface DialogResult {
  button: string;
  values: Record<string, string | number | boolean>;
}

export interface DialogOptions {
  title: string;
  message?: string;
  fields?: Field[];
  buttons?: Button[];
  /** Return an error message to keep the dialog open. */
  validate?: (r: DialogResult) => string | null;
  width?: number;
  /** Show the message in a monospace font (tables). */
  mono?: boolean;
}

let open = 0;
/** Open dialogs, innermost last: only the innermost one reacts to Esc / Enter. */
const stack: HTMLElement[] = [];
/** True while a dialog is showing (editor shortcuts should stay quiet). */
export const dialogOpen = () => open > 0;

export function dialog(opts: DialogOptions): Promise<DialogResult | null> {
  const buttons = opts.buttons ?? [
    { label: "Cancel", value: "cancel" },
    { label: "OK", value: "ok", primary: true },
  ];
  return new Promise((done) => {
    open++;
    const backdrop = el("div", { class: "dlg-backdrop" });
    const box = el("div", { class: "dlg", role: "dialog", "aria-modal": "true", style: opts.width ? `width:${opts.width}px` : "" });
    const error = el("div", { class: "dlg-error" });
    const inputs = new Map<string, () => string | number | boolean>();
    const setters = new Map<string, (v: string) => void>();
    const body = el("div", { class: "dlg-body" });
    if (opts.message) body.append(el("p", { class: `dlg-message${opts.mono ? " mono" : ""}` }, opts.message));
    for (const f of opts.fields ?? []) body.append(fieldEl(f, inputs, setters, () => finish(buttons.find((b) => b.primary)?.value ?? "ok")));
    body.append(error);
    const footer = el("div", { class: "dlg-footer" });
    for (const b of buttons) {
      footer.append(el("button", { class: `${b.primary ? "primary" : ""} ${b.danger ? "danger" : ""}`, onclick: () => finish(b.value) }, b.label));
    }
    box.append(el("div", { class: "dlg-title" }, opts.title), body, footer);
    backdrop.append(box);
    document.body.append(backdrop);
    stack.push(box);

    const values = () => Object.fromEntries([...inputs].map(([k, get]) => [k, get()]));
    function finish(button: string) {
      if (button !== "cancel") {
        const r = { button, values: values() };
        const msg = opts.validate?.(r) ?? null;
        if (msg) {
          error.textContent = msg;
          return;
        }
        close(r);
      } else close(null);
    }
    function close(r: DialogResult | null) {
      document.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(box), 1);
      backdrop.remove();
      open--;
      done(r);
    }
    function onKey(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== box) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
        e.preventDefault();
        e.stopPropagation();
        finish(buttons.find((b) => b.primary)?.value ?? "ok");
      }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => e.target === backdrop && close(null));
    const first = box.querySelector<HTMLElement>("input, select, .dlg-list");
    (first ?? box.querySelector<HTMLElement>("button.primary"))?.focus();
    if (first instanceof HTMLInputElement && first.type === "text") first.select();
  });
}

/**
 * A dialog with custom content: `build` gets `done` (closes it with a value; null = cancelled) and returns the body,
 * the footer and what Enter does. Esc cancels; only the innermost dialog reacts to keys.
 */
export function customDialog<T>(
  title: string,
  width: number,
  build: (done: (v: T | null) => void) => { body: HTMLElement; footer: HTMLElement; onEnter?: () => void; focus?: HTMLElement },
): Promise<T | null> {
  return new Promise((resolve) => {
    open++;
    const backdrop = el("div", { class: "dlg-backdrop" });
    const box = el("div", { class: "dlg", role: "dialog", "aria-modal": "true", style: `width:${width}px` });
    const done = (v: T | null) => {
      document.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(box), 1);
      backdrop.remove();
      open--;
      resolve(v);
    };
    const parts = build(done);
    box.append(el("div", { class: "dlg-title" }, title), parts.body, parts.footer);
    backdrop.append(box);
    document.body.append(backdrop);
    stack.push(box);
    function onKey(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== box) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      } else if (e.key === "Enter" && parts.onEnter && (e.target as HTMLElement).tagName !== "BUTTON") {
        e.preventDefault();
        e.stopPropagation();
        parts.onEnter();
      }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => e.target === backdrop && done(null));
    (parts.focus ?? box.querySelector<HTMLElement>("button.primary"))?.focus();
  });
}

export async function promptText(title: string, label: string, value = "", hint?: string): Promise<string | null> {
  const r = await dialog({
    title,
    fields: [{ name: "v", label, value, hint }],
    validate: (x) => (String(x.values.v).trim() ? null : `${label} is required`),
  });
  return r ? String(r.values.v).trim() : null;
}

export async function confirmDialog(title: string, message: string, okLabel = "OK", danger = false): Promise<boolean> {
  const r = await dialog({ title, message, buttons: [{ label: "Cancel", value: "cancel" }, { label: okLabel, value: "ok", primary: true, danger }] });
  return !!r;
}

export async function alertDialog(title: string, message: string): Promise<void> {
  await dialog({ title, message, buttons: [{ label: "OK", value: "ok", primary: true }] });
}

function fieldEl(f: Field, inputs: Map<string, () => string | number | boolean>, setters: Map<string, (v: string) => void>, submit: () => void): HTMLElement {
  const wrap = el(f.type === "path" ? "div" : "label", { class: `dlg-field ${f.type === "checkbox" ? "check" : ""}` });
  const set = (name: string, v: string) => setters.get(name)?.(v);
  if (f.type === "path") {
    // a chosen path: shown, picked with Browse…, never typed
    let value = String(f.value ?? "");
    const shown = el("div", { class: "dlg-path", title: "" });
    const clear = el("button", { type: "button", class: "icon small", title: "Clear", onclick: () => update("") }, "✕");
    const update = (v: string, picked = false) => {
      value = v;
      // long paths show their end (the file and its folders), the whole path is the tooltip
      shown.textContent = v ? (v.length > 64 ? "…" + v.slice(-63) : v) : f.placeholder || "(none)";
      shown.title = v;
      shown.classList.toggle("empty", !v);
      clear.style.display = f.optional && v ? "" : "none";
      if (picked) f.onPick?.(v, set);
    };
    const browse = el("button", {
      type: "button",
      onclick: async () => {
        const v = await f.browse?.(value);
        if (v) update(v, true);
      },
    }, "Browse…");
    update(value);
    shown.addEventListener("dblclick", () => browse.click());
    inputs.set(f.name, () => value);
    setters.set(f.name, (v) => update(v));
    wrap.append(el("span", {}, f.label), el("div", { class: "dlg-path-row" }, shown, clear, browse));
  } else if (f.type === "checkbox") {
    const c = el("input", { type: "checkbox", checked: f.value === true }) as HTMLInputElement;
    inputs.set(f.name, () => c.checked);
    wrap.append(c, el("span", {}, f.label));
  } else if (f.type === "select") {
    const s = el("select", {}, ...(f.options ?? []).map(([v, l]) => el("option", { value: v, selected: v === f.value }, l))) as HTMLSelectElement;
    inputs.set(f.name, () => s.value);
    wrap.append(el("span", {}, f.label), s);
  } else if (f.type === "list") {
    // filterable list: click selects, double-click confirms
    let selected = String(f.value ?? f.options?.[0]?.[0] ?? "");
    const options = [...(f.options ?? [])];
    const filter = el("input", { type: "search", placeholder: "Filter…" }) as HTMLInputElement;
    const list = el("div", { class: "dlg-list", tabIndex: 0 });
    list.setAttribute("translate", "no"); // names (files, bones): not UI text
    const render = () => {
      const q = filter.value.toLowerCase();
      list.replaceChildren(
        ...options
          .filter(([v, l]) => !q || (v + l).toLowerCase().includes(q))
          .map(([v, l]) =>
            el(
              "div",
              {
                class: `dlg-list-item ${v === selected ? "selected" : ""}`,
                onclick: () => ((selected = v), render()),
                ondblclick: () => ((selected = v), submit()),
                oncontextmenu: (e: MouseEvent) => {
                  if (!f.menu) return;
                  e.preventDefault();
                  selected = v;
                  render();
                  showMenu(e.clientX, e.clientY, f.menu(v).map((it) => ({
                    ...it,
                    run: async () => {
                      if ((await it.run()) === true) {
                        const i = options.findIndex(([x]) => x === v);
                        if (i >= 0) options.splice(i, 1);
                        if (selected === v) selected = options[0]?.[0] ?? "";
                        render();
                      }
                    },
                  })));
                },
              },
              l,
            ),
          ),
      );
    };
    filter.addEventListener("input", render);
    render();
    inputs.set(f.name, () => selected);
    wrap.append(el("span", {}, f.label), filter, list);
  } else {
    const i = el("input", {
      type: f.type === "number" ? "number" : "text",
      value: String(f.value ?? ""),
      placeholder: f.placeholder ?? "",
      ...(f.step !== undefined ? { step: String(f.step) } : {}),
      ...(f.min !== undefined ? { min: String(f.min) } : {}),
    }) as HTMLInputElement;
    inputs.set(f.name, () => (f.type === "number" ? Number(i.value) : i.value));
    setters.set(f.name, (v) => (i.value = v));
    if (f.onPick) i.addEventListener("input", () => f.onPick!(i.value, set));
    wrap.append(el("span", {}, f.label), i);
  }
  if (f.hint) wrap.append(el("small", { class: "dlg-hint" }, f.hint));
  return wrap;
}

/** A small context menu at a screen point; closes on the next click or Esc. */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  const menu = el("div", { class: "ctx-menu", role: "menu", style: `left:${x}px;top:${y}px` });
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  for (const it of items) {
    menu.append(
      el("button", { class: it.danger ? "danger" : "", role: "menuitem", onclick: () => (close(), void it.run()) }, it.label),
    );
  }
  document.body.append(menu);
  // keep it on screen
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${Math.max(0, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight) menu.style.top = `${Math.max(0, innerHeight - r.height - 4)}px`;
  setTimeout(() => {
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
  });
}

export function el(tag: string, attrs: Record<string, unknown> = {}, ...kids: Array<Node | string>): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (k === "style" || k.startsWith("aria-") || k === "role" || k === "translate") e.setAttribute(k, String(v));
    else if (v !== undefined && v !== false) (e as unknown as Record<string, unknown>)[k] = v;
  }
  e.append(...kids);
  return e;
}
