// Transform gizmos for the viewport: move (axis arrows + free handle), rotate (ring), scale (axis + uniform).
// Pure drawing and hit testing in screen space; the editor turns handle drags into ops.

import { t as tr } from "./i18n.ts";

export type Tool = "select" | "move" | "rotate" | "scale" | "bone";
export type Handle = "moveX" | "moveY" | "moveFree" | "rotate" | "scaleX" | "scaleY" | "scaleUniform";

export interface GizmoSpec {
  tool: Tool;
  /** Screen position of the pivot. */
  x: number;
  y: number;
  /** Screen angle (radians, y down) of the local x axis, used by scale handles. */
  angle: number;
}

export const GIZMO_SIZE = 72;
const RED = "#ef5350";
const GREEN = "#5fd068";
const BLUE = "#4ea1ff";
const YELLOW = "#ffd166";

export function hitGizmo(g: GizmoSpec, px: number, py: number): Handle | null {
  const dx = px - g.x;
  const dy = py - g.y;
  const d = Math.hypot(dx, dy);
  if (g.tool === "move") {
    if (Math.abs(dx - 10) <= 9 && Math.abs(dy + 10) <= 9) return "moveFree";
    if (dx > 12 && dx < GIZMO_SIZE + 10 && Math.abs(dy) < 8) return "moveX";
    if (-dy > 12 && -dy < GIZMO_SIZE + 10 && Math.abs(dx) < 8) return "moveY";
    if (d < 8) return "moveFree";
  } else if (g.tool === "rotate") {
    if (Math.abs(d - GIZMO_SIZE * 0.85) < 8) return "rotate";
  } else if (g.tool === "scale") {
    if (d < 10) return "scaleUniform";
    const ax = Math.cos(g.angle);
    const ay = Math.sin(g.angle);
    const along = dx * ax + dy * ay;
    const across = -dx * ay + dy * ax;
    if (along > 12 && along < GIZMO_SIZE + 10 && Math.abs(across) < 8) return "scaleX";
    if (-across > 12 && -across < GIZMO_SIZE + 10 && Math.abs(along) < 8) return "scaleY";
  }
  return null;
}

export function drawGizmo(ctx: CanvasRenderingContext2D, g: GizmoSpec, hot: Handle | null, active: Handle | null): void {
  const L = GIZMO_SIZE;
  const col = (h: Handle, base: string) => (active === h ? YELLOW : hot === h ? "#ffffff" : base);
  ctx.save();
  ctx.lineCap = "round";
  const shadow = (draw: () => void) => {
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 6;
    draw();
  };
  if (g.tool === "move") {
    const arrow = (ex: number, ey: number, c: string) => {
      const line = () => {
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.lineTo(g.x + ex * L, g.y + ey * L);
        ctx.stroke();
      };
      shadow(line);
      ctx.strokeStyle = c;
      ctx.lineWidth = 3;
      line();
      ctx.fillStyle = c;
      ctx.beginPath();
      const tx = g.x + ex * (L + 12);
      const ty = g.y + ey * (L + 12);
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - ex * 14 - ey * 7, ty - ey * 14 + ex * 7);
      ctx.lineTo(tx - ex * 14 + ey * 7, ty - ey * 14 - ex * 7);
      ctx.closePath();
      ctx.fill();
    };
    arrow(1, 0, col("moveX", RED));
    arrow(0, -1, col("moveY", GREEN));
    ctx.fillStyle = col("moveFree", BLUE);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(g.x + 2, g.y - 18, 16, 16);
    ctx.globalAlpha = 1;
  } else if (g.tool === "rotate") {
    const r = L * 0.85;
    const ring = () => {
      ctx.beginPath();
      ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
      ctx.stroke();
    };
    shadow(ring);
    ctx.strokeStyle = col("rotate", BLUE);
    ctx.lineWidth = 3;
    ring();
    // current direction tick
    ctx.beginPath();
    ctx.moveTo(g.x + Math.cos(g.angle) * (r - 10), g.y + Math.sin(g.angle) * (r - 10));
    ctx.lineTo(g.x + Math.cos(g.angle) * (r + 10), g.y + Math.sin(g.angle) * (r + 10));
    ctx.stroke();
  } else if (g.tool === "scale") {
    const handle = (ax: number, ay: number, c: string) => {
      const line = () => {
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.lineTo(g.x + ax * L, g.y + ay * L);
        ctx.stroke();
      };
      shadow(line);
      ctx.strokeStyle = c;
      ctx.lineWidth = 3;
      line();
      ctx.fillStyle = c;
      ctx.fillRect(g.x + ax * L - 7, g.y + ay * L - 7, 14, 14);
    };
    const ax = Math.cos(g.angle);
    const ay = Math.sin(g.angle);
    handle(ax, ay, col("scaleX", RED));
    handle(ay, -ax, col("scaleY", GREEN));
    ctx.fillStyle = col("scaleUniform", BLUE);
    ctx.beginPath();
    ctx.arc(g.x, g.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Small label drawn next to the pointer while dragging. */
export function drawReadout(ctx: CanvasRenderingContext2D, x: number, y: number, label: string): void {
  const text = tr(label);
  ctx.save();
  ctx.font = "12px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = "rgba(15,17,20,0.85)";
  ctx.beginPath();
  ctx.roundRect(x + 14, y + 12, w, 20, 5);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x + 20, y + 26);
  ctx.restore();
}
