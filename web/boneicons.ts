// Spine's bone icons (the "icon" of a bone in the skeleton JSON), drawn as 16x16 vector shapes in the order of
// Spine's icon picker: shapes, roman numerals, lines and arrows, props, faces and hands, symbols, suits, things.
// The same path data draws the tree / panel icons (SVG) and the viewport icons (canvas Path2D).
// Names seen in Spine exports: circle square triangle diamond diamondB star ik arrows arrowsB arrowLeftRight arrowUpDown
// eye mouth warning muzzleFlash particles asterisk gear rotate spiral handLeft handRight romanII. The others follow
// the same naming but are not confirmed against a Spine export yet; unknown names on imported bones are kept as they are.

export interface BoneIcon {
  /** The name written to the skeleton ("" = the default bone icon). */
  id: string;
  label: string;
  /** Filled path in a 16 x 16 box, or a text glyph (roman numerals, the rotate arrow). */
  path?: string;
  text?: string;
  /** Fill rule for paths with holes. */
  evenodd?: boolean;
}

const n = (v: number) => +v.toFixed(2);
const circle = (cx: number, cy: number, r: number) => `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;
const rect = (x: number, y: number, w: number, h: number) => `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
const poly = (pts: number[]) => `M${pts.map(n).join(" ")}Z`.replace(/^M([^ ]+) ([^ ]+)/, "M$1 $2L");
const around = (count: number, r1: number, r2: number, turn = -Math.PI / 2) => {
  const pts: number[] = [];
  for (let i = 0; i < count * 2; i++) {
    const a = turn + (i * Math.PI) / count;
    const r = i % 2 ? r2 : r1;
    pts.push(8 + Math.cos(a) * r, 8 + Math.sin(a) * r);
  }
  return poly(pts);
};
/** A bar from the center, turned by `deg`. */
const bar = (deg: number, len: number, w: number) => {
  const a = (deg * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const p = (x: number, y: number) => [8 + x * c - y * s, 8 + x * s + y * c];
  return poly([...p(-len, -w / 2), ...p(len, -w / 2), ...p(len, w / 2), ...p(-len, w / 2)]);
};
const gear = () => {
  const pts: number[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i * Math.PI) / 16;
    const r = i % 4 < 2 ? 7 : 5.2;
    pts.push(8 + Math.cos(a) * r, 8 + Math.sin(a) * r);
  }
  return poly(pts) + circle(8, 8, 2.3);
};
const spiral = () => {
  const out: number[] = [];
  const inn: number[] = [];
  for (let t = 0; t <= 4.2 * Math.PI; t += 0.25) {
    const r = 0.5 + t * 0.45;
    out.push(8 + Math.cos(t) * (r + 0.75), 8 + Math.sin(t) * (r + 0.75));
    inn.unshift(8 + Math.cos(t) * Math.max(0, r - 0.75), 8 + Math.sin(t) * Math.max(0, r - 0.75));
  }
  return poly([...out, ...inn]);
};
const hand = (thumbRight: boolean) => {
  const fingers = [rect(3.6, 3, 1.8, 6), rect(5.6, 1.5, 1.8, 7), rect(7.6, 1.2, 1.8, 7), rect(9.6, 2.2, 1.8, 7)].join("");
  const palm = rect(3.6, 7.5, 7.8, 7);
  const thumb = poly([11, 9.5, 13.6, 6.6, 15, 7.6, 11.4, 12.6]);
  const d = fingers + palm + thumb;
  return thumbRight ? d : mirror(d);
};
/** Mirrors path data horizontally (absolute commands only, which is all the hand uses). */
const mirror = (d: string) => d.replace(/([MLh])([^MLhvZ]+)/g, (_, cmd: string, args: string) => {
  const nums = args.trim().split(/[ ,]+/).map(Number);
  if (cmd === "h") return `h${n(-nums[0])}`;
  return cmd + nums.map((v, i) => (i % 2 ? v : n(16 - v))).join(" ");
});
const roman = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ"];

export const BONE_ICONS: BoneIcon[] = [
  { id: "", label: "Default", path: poly([2, 14, 3, 11, 12, 2, 14, 4, 5, 13]) },
  { id: "point", label: "Point", path: rect(7, 1, 2, 4.5) + rect(7, 10.5, 2, 4.5) + rect(1, 7, 4.5, 2) + rect(10.5, 7, 4.5, 2) + circle(8, 8, 1.6) },
  { id: "circle", label: "Circle", path: circle(8, 8, 6.5) + circle(8, 8, 5) + circle(8, 8, 3.5), evenodd: true },
  { id: "square", label: "Square", path: rect(2.5, 2.5, 11, 11) },
  { id: "triangle", label: "Triangle", path: poly([8, 2.5, 14.5, 13, 1.5, 13]) },
  { id: "diamond", label: "Diamond", path: poly([8, 1.5, 14.5, 8, 8, 14.5, 1.5, 8]) },
  { id: "circleB", label: "Circle B", path: circle(8, 8, 4.5) + rect(7.3, 0.8, 1.4, 2.6) + rect(7.3, 12.6, 1.4, 2.6) + rect(0.8, 7.3, 2.6, 1.4) + rect(12.6, 7.3, 2.6, 1.4) },
  ...roman.map((text, i) => ({ id: `roman${["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][i]}`, label: `Roman ${i + 1}`, text })),
  { id: "line", label: "Line", path: rect(1.5, 7, 13, 2) },
  { id: "lineEnd", label: "Line end", path: rect(1.5, 7, 10.5, 2) + rect(12, 3, 2, 10) },
  { id: "forward", label: "Forward", path: poly([2, 3, 4.2, 3, 9, 8, 4.2, 13, 2, 13, 6.8, 8]) + poly([7, 3, 9.2, 3, 14, 8, 9.2, 13, 7, 13, 11.8, 8]) },
  { id: "rotate", label: "Rotate", text: "↻" },
  { id: "arrows", label: "Arrows", path: "M8 0.5L11 3.5H9.2V6.8H12.5V5L15.5 8L12.5 11V9.2H9.2V12.5H11L8 15.5L5 12.5H6.8V9.2H3.5V11L0.5 8L3.5 5V6.8H6.8V3.5H5Z" },
  { id: "arrowLeftRight", label: "Left / right arrow", path: "M0.5 8L5 3.5V6.5H11V3.5L15.5 8L11 12.5V9.5H5V12.5Z" },
  { id: "arrowUpDown", label: "Up / down arrow", path: "M8 0.5L12.5 5H9.5V11H12.5L8 15.5L3.5 11H6.5V5H3.5Z" },
  { id: "arrowLeft", label: "Left arrow", path: "M1 8L7 2.5V6H15V10H7V13.5Z" },
  { id: "arrowRight", label: "Right arrow", path: "M15 8L9 2.5V6H1V10H9V13.5Z" },
  { id: "arrowUp", label: "Up arrow", path: "M8 1L13.5 7H10V15H6V7H2.5Z" },
  { id: "arrowDown", label: "Down arrow", path: "M8 15L13.5 9H10V1H6V9H2.5Z" },
  { id: "arrowsB", label: "Arrows B", path: "M8 0.5L10.5 3H8.7V7.3H13V5.5L15.5 8L13 10.5V8.7H8.7V13H10.5L8 15.5L5.5 13H7.3V8.7H3V10.5L0.5 8L3 5.5V7.3H7.3V3H5.5Z" },
  { id: "sword", label: "Sword", path: poly([14, 1, 15, 2, 6.2, 10.8, 5.2, 9.8]) + poly([3.2, 8.6, 7.4, 12.8, 6.4, 13.8, 2.2, 9.6]) + poly([3.4, 11.6, 4.4, 12.6, 1.9, 15.1, 0.9, 14.1]) },
  { id: "shield", label: "Shield", path: "M8 1L14 3V8C14 11.5 11 14 8 15C5 14 2 11.5 2 8V3Z" },
  { id: "gun", label: "Gun", path: "M1 4.5H14.5V8H9L8 10.2H6.2L5 14H2L3.4 8H1Z" },
  { id: "muzzleFlash", label: "Muzzle flash", path: poly([1, 8, 6, 6, 4, 2, 8, 5, 12, 1, 11, 6, 15, 8, 11, 10, 12, 15, 8, 11, 4, 14, 6, 10]) },
  { id: "ik", label: "IK", path: circle(8, 8, 5.4) + circle(8, 8, 4.1) + rect(7.35, 0.5, 1.3, 2.1) + rect(7.35, 13.4, 1.3, 2.1) + rect(0.5, 7.35, 2.1, 1.3) + rect(13.4, 7.35, 2.1, 1.3) + circle(8, 8, 1.1), evenodd: true },
  { id: "fire", label: "Fire", path: "M8 1C9 4 13 5 13 10C13 13 11 15 8 15C5 15 3 13 3 10C3 7 5 6 5.5 4C7 6 6.5 7.5 8 9C8.5 7 7 4 8 1Z" },
  { id: "eye", label: "Eye", path: "M1 8C3 4 13 4 15 8C13 12 3 12 1 8Z" + circle(8, 8, 2.6) + circle(8, 8, 1.3), evenodd: true },
  { id: "mouth", label: "Mouth", path: "M1 7C5 5 11 5 15 7C13 11 3 11 1 7ZM3.5 7.6C6 7 10 7 12.5 7.6C10.5 9 5.5 9 3.5 7.6Z", evenodd: true },
  { id: "speech", label: "Speech", path: "M8 2C12 2 15 4 15 7C15 10 12 12 8 12H7L3 15L4 11.5C2 10.5 1 9 1 7C1 4 4 2 8 2Z" },
  { id: "handLeft", label: "Left hand", path: hand(false) },
  { id: "handRight", label: "Right hand", path: hand(true) },
  { id: "warning", label: "Warning", path: rect(6.4, 1.5, 3.2, 9) + circle(8, 13.3, 1.8) },
  { id: "warningB", label: "Warning B", path: rect(7, 2, 2, 8) + circle(8, 13, 1.3) },
  { id: "gear", label: "Gear", path: gear(), evenodd: true },
  { id: "particles", label: "Particles", path: [circle(4, 4, 1.2), circle(11.5, 3, 1), circle(8, 8, 1.5), circle(3, 11.5, 1), circle(12, 12.5, 1.3), circle(13.5, 7.5, 0.8), circle(6.5, 14, 0.8), circle(7.5, 2, 0.7)].join("") },
  { id: "gem", label: "Gem", path: poly([4, 2, 12, 2, 15, 6, 8, 15, 1, 6]) },
  { id: "spiral", label: "Spiral", path: spiral() },
  { id: "star", label: "Star", path: around(5, 7, 2.9) },
  { id: "asterisk", label: "Asterisk", path: bar(90, 6.5, 2.2) + bar(30, 6.5, 2.2) + bar(150, 6.5, 2.2) },
  { id: "no", label: "No", path: circle(8, 8, 6.8) + circle(8, 8, 4.9) + bar(-45, 4.9, 2), evenodd: true },
  { id: "batWing", label: "Bat wing", path: "M1 10C4 3 11 2 15 3C13 5 13 7 14 9C12 8 11 9 10 11C9 9 7 9 6 11C5 9 3 9 1 10Z" },
  { id: "wings", label: "Wings", path: "M2 4C6 4 10 6 12 10L14 12L12 14C9 13 7 12 6 10C4 10 3 8 3 7C2 7 1 6 2 4Z" },
  { id: "pencil", label: "Pencil", path: poly([11, 1.5, 14.5, 5, 5, 14.5, 1.5, 14.5, 1.5, 11]) },
  { id: "club", label: "Club", path: circle(8, 4.6, 3) + circle(4.6, 9.4, 3) + circle(11.4, 9.4, 3) + poly([7, 8.5, 9, 8.5, 10.2, 15, 5.8, 15]) },
  { id: "diamondB", label: "Diamond B", path: "M8 1C9.5 4 11.5 6 13.5 8C11.5 10 9.5 12 8 15C6.5 12 4.5 10 2.5 8C4.5 6 6.5 4 8 1Z" },
  { id: "heart", label: "Heart", path: "M8 14.5C3 10.5 1 8 1 5.5C1 3.2 2.8 1.8 4.7 1.8C6.2 1.8 7.4 2.7 8 4C8.6 2.7 9.8 1.8 11.3 1.8C13.2 1.8 15 3.2 15 5.5C15 8 13 10.5 8 14.5Z" },
  { id: "spade", label: "Spade", path: "M8 1C11 4.5 15 6.5 15 9.5C15 11.5 13.5 12.5 12 12.5C10.8 12.5 9.6 11.8 9 10.8L10 15H6L7 10.8C6.4 11.8 5.2 12.5 4 12.5C2.5 12.5 1 11.5 1 9.5C1 6.5 5 4.5 8 1Z" },
  { id: "flower", label: "Flower", path: [0, 1, 2, 3, 4].map((i) => circle(8 + Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / 5) * 4, 8 + Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / 5) * 4, 2.9)).join("") },
  { id: "bowtie", label: "Bow tie", path: "M1 4L7 7V9L1 12ZM15 4L9 7V9L15 12Z" + rect(6.5, 6.3, 3, 3.4) },
  { id: "hat", label: "Hat", path: rect(4, 2, 8, 9) + rect(1, 11, 14, 2.6) },
  { id: "shoe", label: "Shoe", path: "M1 9L2 4H5L6 7C9 7 12 8 14.5 10V13H1Z" },
  { id: "drop", label: "Drop", path: "M8 1C10 5 13 8 13 10.5C13 13.3 10.8 15 8 15C5.2 15 3 13.3 3 10.5C3 8 6 5 8 1Z" },
  { id: "leaf", label: "Leaf", path: "M14.5 1.5C14.5 9 11 14 4 14L2 15.5L1 14.5L2.5 12.5C2 5 7 1.5 14.5 1.5Z" },
  { id: "lightning", label: "Lightning", path: poly([9.5, 1, 3, 9, 7.5, 9, 6, 15, 13, 6.5, 8.5, 6.5, 11, 1]) },
];

const byId = new Map(BONE_ICONS.map((i) => [i.id, i]));

/** The icon for a bone's icon name (unknown names show the default bone icon). */
export function boneIcon(id: string | undefined): BoneIcon {
  return byId.get(id ?? "") ?? byId.get("")!;
}

/** An inline SVG of an icon, colored by `currentColor`. */
export function boneIconSvg(id: string | undefined, size = 16): SVGSVGElement {
  const icon = boneIcon(id);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "bone-icon");
  svg.setAttribute("aria-hidden", "true");
  if (icon.path) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", icon.path);
    p.setAttribute("fill", "currentColor");
    if (icon.evenodd) p.setAttribute("fill-rule", "evenodd");
    svg.append(p);
  } else {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", "8");
    t.setAttribute("y", "12.5");
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("font-size", "13");
    t.setAttribute("font-family", "'Times New Roman', serif");
    t.setAttribute("fill", "currentColor");
    t.textContent = icon.text ?? "";
    svg.append(t);
  }
  return svg;
}

const pathCache = new Map<string, Path2D>();

/** Draws an icon centered at (x, y), `size` pixels across, with a dark outline so it reads on any art. */
export function drawBoneIcon(ctx: CanvasRenderingContext2D, id: string | undefined, x: number, y: number, size: number, fill: string): void {
  const icon = boneIcon(id);
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 16, size / 16);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.lineWidth = 2.4;
  ctx.fillStyle = fill;
  if (icon.path) {
    let p = pathCache.get(icon.id);
    if (!p) pathCache.set(icon.id, (p = new Path2D(icon.path)));
    const rule: CanvasFillRule = icon.evenodd ? "evenodd" : "nonzero";
    ctx.stroke(p);
    ctx.fill(p, rule);
  } else {
    ctx.font = "13px 'Times New Roman', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.strokeText(icon.text ?? "", 8, 12.5);
    ctx.fillText(icon.text ?? "", 8, 12.5);
  }
  ctx.restore();
}
