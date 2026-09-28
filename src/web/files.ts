// File browsing for the editor's Import / Export dialogs, so paths are picked, never typed: a folder listing
// (drives on Windows) for the in-app picker, and the operating system's own open / folder dialog on Windows.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface BrowseEntry {
  name: string;
  dir: boolean;
}

export interface BrowseResult {
  /** Absolute folder, with forward slashes. */
  dir: string;
  /** Its parent, or null at a drive / file-system root. */
  parent: string | null;
  /** Sub-folders first, then files matching `exts` (all files when none are given), each sorted by name. */
  entries: BrowseEntry[];
  /** Places to jump to: drives on Windows, else "/". */
  roots: string[];
  home: string;
}

const slash = (p: string) => p.replace(/\\/g, "/");

/** Drive roots on Windows ("C:/", "D:/", ...), "/" elsewhere. */
export function fileRoots(): string[] {
  if (process.platform !== "win32") return ["/"];
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:/`;
    if (existsSync(d)) out.push(d);
  }
  return out;
}

/**
 * Lists a folder: sub-folders and the files whose names end in one of `exts` (case-insensitive, e.g. ".model3.json").
 * Hidden entries (dot names) and entries that cannot be read are skipped.
 */
export function browseDir(dir: string, exts: string[] = []): BrowseResult {
  const full = resolve(dir);
  let st;
  try {
    st = statSync(full);
  } catch {
    throw new Error(`no such folder: ${dir}`);
  }
  if (!st.isDirectory()) throw new Error(`not a folder: ${dir}`);
  let names: string[];
  try {
    names = readdirSync(full);
  } catch (e) {
    throw new Error(`cannot open ${dir}: ${(e as Error).message}`);
  }
  const want = exts.map((e) => e.toLowerCase());
  const dirs: BrowseEntry[] = [];
  const files: BrowseEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "$RECYCLE.BIN" || name === "System Volume Information") continue;
    let isDir: boolean;
    try {
      isDir = statSync(join(full, name)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) dirs.push({ name, dir: true });
    else if (!want.length || want.some((e) => name.toLowerCase().endsWith(e))) files.push({ name, dir: false });
  }
  const byName = (a: BrowseEntry, b: BrowseEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const root = parse(full).root;
  return {
    dir: slash(full),
    parent: full === root ? null : slash(dirname(full)),
    entries: [...dirs.sort(byName), ...files.sort(byName)],
    roots: fileRoots(),
    home: slash(homedir()),
  };
}

export interface NativePickOptions {
  mode: "file" | "folder";
  title?: string;
  /** File mode: extensions to show (e.g. [".json"]). */
  exts?: string[];
  /** Folder to start in. */
  start?: string;
}

/** True when the OS dialog is available (Windows: PowerShell + WinForms). */
export const nativePickAvailable = () => process.platform === "win32";

/**
 * Shows the Windows open-file or folder dialog (on top of other windows) and resolves with the chosen path,
 * or null when cancelled.
 */
export function nativePick(o: NativePickOptions): Promise<string | null> {
  if (!nativePickAvailable()) return Promise.reject(new Error("the system file dialog is only available on Windows"));
  // values reach PowerShell through the environment, never through the script text
  const env = {
    ...process.env,
    AWAKEN2D_PICK_TITLE: o.title ?? "",
    AWAKEN2D_PICK_START: o.start && existsSync(o.start) ? resolve(o.start) : "",
    AWAKEN2D_PICK_FILTER: o.exts?.length ? `${o.exts.map((e) => `*${e}`).join(";")}|${o.exts.map((e) => `*${e}`).join(";")}|All files (*.*)|*.*` : "All files (*.*)|*.*",
  };
  const script =
    o.mode === "file"
      ? `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = $env:AWAKEN2D_PICK_TITLE
$d.Filter = $env:AWAKEN2D_PICK_FILTER
if ($env:AWAKEN2D_PICK_START) { $d.InitialDirectory = $env:AWAKEN2D_PICK_START }
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($d.FileName) }`
      : `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:AWAKEN2D_PICK_TITLE
$d.ShowNewFolderButton = $true
if ($env:AWAKEN2D_PICK_START) { $d.SelectedPath = $env:AWAKEN2D_PICK_START }
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($d.SelectedPath) }`;
  return new Promise((done, fail) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { env, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return fail(new Error(`the system file dialog failed: ${err.message}`));
      const p = stdout.trim();
      done(p ? slash(p) : null);
    });
  });
}
