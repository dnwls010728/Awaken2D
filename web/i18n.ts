// Editor UI languages. The UI is written in English; in another language, text nodes and the title / placeholder /
// aria-label attributes are translated as they enter the page (a MutationObserver), and canvas text goes through t().
// The dictionary (web/i18n-text.ts) maps the English text to the translations; "{0}", "{1}"... mark the variable parts
// of a message (numbers, names), which are carried over (and translated too when they are known UI words).
// Elements with translate="no" (and inputs) are left alone: names of bones, slots, parameters, files stay as they are.
import { TEXT } from "./i18n-text.ts";

export type Lang = "en" | "ko" | "ja";
export const LANGS: Array<[Lang, string]> = [
  ["en", "English"],
  ["ko", "한국어"],
  ["ja", "日本語"],
];

const KEY = "awaken2d.lang";

// Settings saved before the project was renamed (rigkit.*) carry over once. This module loads first.
try {
  for (let i = 0; i < localStorage.length; i++) {
    const old = localStorage.key(i);
    if (!old?.startsWith("rigkit.")) continue;
    const key = "awaken2d." + old.slice("rigkit.".length);
    if (localStorage.getItem(key) === null) localStorage.setItem(key, localStorage.getItem(old)!);
  }
} catch {
  // storage blocked: nothing to carry over
}

function initialLang(): Lang {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // storage blocked: fall back to the browser language
  }
  if (saved === "en" || saved === "ko" || saved === "ja") return saved;
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  return nav.startsWith("ko") ? "ko" : nav.startsWith("ja") ? "ja" : "en";
}

let lang: Lang = initialLang();

export function currentLang(): Lang {
  return lang;
}

/** Switches the UI language (reloads the page: the editor state lives on the server, nothing is lost). */
export function setLang(l: Lang): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // not remembered; still switch for this page
  }
  if (l !== lang) location.reload();
}

/** Uses another language for t() from now on, without touching the page (tests). */
export function useLang(l: Lang): void {
  lang = l;
  exact = null;
  cache.clear();
}

/** used: the variable parts (by English position) the translation keeps. */
type Pattern = { re: RegExp; anchor: string; fixed: number; out: string; used: Set<number> };
let exact: Map<string, string> | null = null;
let patterns: Pattern[] = [];

function build(): void {
  const col = lang === "ko" ? 0 : 1;
  exact = new Map();
  patterns = [];
  for (const [en, tr] of Object.entries(TEXT)) {
    const out = tr[col];
    if (!/\{\d\}/.test(en)) {
      exact.set(en, out);
      continue;
    }
    const parts = en.split(/\{\d\}/);
    const re = new RegExp("^" + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("([\\s\\S]*?)") + "$");
    const anchor = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
    // the placeholders in English order: "{1} of {0}" style keys map their own numbers
    const order = [...en.matchAll(/\{(\d)\}/g)].map((m) => +m[1]);
    const used = new Set([...out.matchAll(/\{(\d)\}/g)].map((m) => order.indexOf(+m[1])));
    patterns.push({ re, anchor, fixed: parts.join("").length, used, out: out.replace(/\{(\d)\}/g, (_, d) => `{@${order.indexOf(+d)}}`) });
  }
}

type Found = { text: string; covered: number; fixed: number };
const cache = new Map<string, Found | null>();
const letters = (s: string) => (s.match(/[A-Za-z]/g) ?? []).length;

function lookup(s: string): string | null {
  return resolve(s)?.text ?? null;
}

// Several patterns can match one text ("Tools · all vertices": "Tools · {0}" and "{0} vertices"). The variable parts
// are translated too, and the match that covers the most English letters (its fixed text plus translated parts) wins.
function resolve(s: string): Found | null {
  if (!exact) build();
  const hit = exact!.get(s);
  if (hit !== undefined) return { text: hit, covered: letters(s), fixed: s.length };
  if (cache.has(s)) return cache.get(s)!;
  let res: Found | null = null;
  for (const p of patterns) {
    if (!s.includes(p.anchor)) continue;
    const m = p.re.exec(s);
    if (!m) continue;
    // every variable part counts, also one a translation drops, unless it is an English plural ending ("s", "es")
    let covered = letters(s);
    const parts = m.slice(1).map((v = "", i) => {
      const core = v.trim();
      if (!p.used.has(i) && /^(e?s)?$/.test(core)) return "";
      const sub = core && /[A-Za-z]/.test(core) ? resolve(core) : null;
      covered -= letters(v) - (sub?.covered ?? 0);
      return sub ? v.replace(core, () => sub.text) : v;
    });
    const text = p.out.replace(/\{@(\d)\}/g, (_, i) => parts[+i] ?? "");
    if (!res || covered > res.covered || (covered === res.covered && p.fixed > res.fixed)) res = { text, covered, fixed: p.fixed };
  }
  if (cache.size > 4000) cache.clear();
  cache.set(s, res);
  return res;
}

/** The text in the UI language (unchanged when there is no translation). */
export function t(s: string): string {
  if (lang === "en" || !s) return s;
  const core = s.trim();
  if (!core || !/[A-Za-z]/.test(core)) return s;
  const tr = lookup(core);
  if (tr === null) {
    if (!/[぀-ヿ㐀-鿿가-힯]/.test(core)) misses.add(core);
    return s;
  }
  return core === s ? tr : s.replace(core, () => tr);
}

/** English text seen in the UI without a translation (debugging: window.awaken2d.i18nMisses). */
export const misses = new Set<string>();

const ATTRS = ["title", "placeholder", "aria-label"];
// no text translated inside these (an input's placeholder / title still are)
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "KBD", "CODE", "PRE"]);

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP.has(e.tagName) || e.getAttribute("translate") === "no") return true;
  }
  return false;
}

function translateText(n: Text): void {
  if (skipped(n.parentElement)) return;
  const v = n.data;
  const tr = t(v);
  if (tr !== v) n.data = tr;
}

function translateAttrs(el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const tr = t(v);
    if (tr !== v) el.setAttribute(a, tr);
  }
}

function translateTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const top = root as Element;
  if (skipped(top)) return;
  translateAttrs(top);
  const walk = document.createTreeWalker(top, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (SKIP.has((n as Element).tagName) || (n as Element).getAttribute("translate") === "no") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const tn = n as Text;
      const tr = t(tn.data);
      if (tr !== tn.data) tn.data = tr;
    } else translateAttrs(n as Element);
  }
}

/** Translates the page now and everything added to it later. No-op in English. */
export function startI18n(): void {
  document.documentElement.lang = lang;
  if (lang === "en") return;
  translateTree(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "childList") r.addedNodes.forEach(translateTree);
      else if (r.type === "characterData") translateText(r.target as Text);
      else if (r.type === "attributes") translateAttrs(r.target as Element);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
