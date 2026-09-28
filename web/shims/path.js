// Minimal POSIX-style node:path for the browser (only what the core uses).
const norm = (p) => {
  const abs = p.startsWith("/");
  const out = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (abs ? "/" : "") + out.join("/");
};
export const sep = "/";
export const resolve = (...parts) => norm(parts.reduce((acc, p) => (p.startsWith("/") ? p : acc + "/" + p), ""));
export const join = (...parts) => norm(parts.join("/"));
export const dirname = (p) => {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? (p.startsWith("/") ? "/" : ".") : p.slice(0, i);
};
export const basename = (p, ext) => {
  const b = p.replace(/\/+$/, "").split("/").pop() ?? "";
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
};
export const relative = (from, to) => {
  const a = norm(from).split("/").filter(Boolean);
  const b = norm(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
};
export const isAbsolute = (p) => p.startsWith("/");
export default { sep, resolve, join, dirname, basename, extname, relative, isAbsolute };
