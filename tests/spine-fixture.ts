// Synthetic Spine 4.2 data for the Spine import/export tests.
import type { RGBAImage } from "../src/render/png.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A small Spine 4.2 skeleton exercising what the importer maps (and some things it only keeps). */
export function skeleton(): any {
  return {
    skeleton: { hash: "abc", spine: "4.2.43", x: -50, y: -10, width: 100, height: 120, images: "./images/", audio: "./audio" },
    bones: [
      { name: "root" },
      { name: "hip", parent: "root", length: 30, rotation: 90, y: 20, color: "ff0000ff" },
      { name: "chest", parent: "hip", length: 40, rotation: -10, x: 30, shearX: 8, scaleY: 1.1 },
      { name: "arm", parent: "chest", length: 25, rotation: 120, x: 30, y: 5 },
    ],
    slots: [
      { name: "body", bone: "chest", attachment: "body" },
      { name: "arm", bone: "arm", attachment: "arm", color: "ffeeddff" },
      { name: "hat", bone: "chest", attachment: "hat", blend: "additive", dark: "000000" },
      { name: "box", bone: "hip", attachment: "hitbox" },
    ],
    ik: [{ name: "reach", order: 1, bones: ["arm"], target: "hip", mix: 0 }],
    transform: [{ name: "t1", order: 0, bones: ["arm"], target: "chest", rotation: 10, mixRotate: 0.5 }],
    skins: [
      {
        name: "default",
        attachments: {
          // weighted mesh (2 bones), per-vertex [count, bone, x, y, weight, ...]
          body: {
            body: {
              type: "mesh",
              uvs: [0, 1, 1, 1, 1, 0, 0, 0, 0.5, 0.5],
              triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
              vertices: [
                1, 1, -5, -15, 1,
                2, 1, -5, 15, 0.6, 2, -35, 16, 0.4,
                1, 2, 20, 15, 1,
                1, 2, 20, -15, 1,
                2, 1, 20, 0, 0.5, 2, -10, 1, 0.5,
              ],
              hull: 4,
              edges: [0, 2, 2, 4, 4, 6, 6, 0],
              width: 20,
              height: 30,
            },
          },
          // unweighted mesh, bone-local vertices
          arm: { arm: { type: "mesh", uvs: [0, 1, 1, 1, 1, 0, 0, 0], triangles: [0, 1, 2, 0, 2, 3], vertices: [0, -4, 25, -4, 25, 4, 0, 4], hull: 4, width: 8, height: 12 } },
          // region, rotated and scaled
          hat: { hat: { x: 40, y: 3, rotation: -80, scaleX: 1.2, width: 16, height: 10 } },
          box: { hitbox: { type: "boundingbox", vertexCount: 3, vertices: [0, 0, 10, 0, 5, 8] } },
        },
      },
      { name: "alt", attachments: { hat: { hat2: { path: "hat", width: 16, height: 10 } } } },
    ],
    events: { step: { int: 1 }, hit: { string: "x" } },
    animations: {
      move: {
        bones: {
          chest: {
            rotate: [{ value: 5, curve: [0.2, 5, 0.4, -20] }, { time: 0.6, value: -20 }, { time: 1, value: 5 }],
            translate: [{ curve: [0.1, 0, 0.3, 4, 0.1, 0, 0.3, 0] }, { time: 0.5, x: 4 }],
            shear: [{ time: 0.2 }, { time: 0.8, x: 15, y: -5 }],
          },
          arm: { scale: [{ curve: "stepped" }, { time: 0.4, x: 1.3, y: 0.8 }] },
        },
        slots: {
          arm: { rgba: [{ color: "ffffffff", curve: [0.1, 1, 0.3, 1, 0.1, 1, 0.3, 0.5, 0.1, 1, 0.3, 0.5, 0.1, 1, 0.3, 0.2] }, { time: 0.5, color: "ff8080aa" }] },
          hat: { attachment: [{ time: 0.3 }, { time: 0.7, name: "hat" }], rgba2: [{ light: "ffffffff", dark: "000000" }] },
        },
        attachments: {
          default: {
            // per-bone deltas that do NOT agree in setup space (keyed in a posed state)
            body: { body: { deform: [{ curve: [0.2, 0, 0.5, 1] }, { time: 0.5, offset: 3, vertices: [2, 1, 3, -2, 0, 0, 0, 0, 4, 4] }, { time: 1 }] } },
            arm: { arm: { deform: [{ time: 0.2, vertices: [0, 0, 3, 1, 3, -1] }] } },
          },
        },
        drawOrder: [{ time: 0.4, offsets: [{ slot: "body", offset: 2 }] }, { time: 0.9 }],
        events: [{ time: 0.25, name: "step" }, { time: 0.75, name: "hit", string: "y" }],
      },
    },
  };
}

/** Solid-colored images for every region, sized as the attachments expect. */
export const IMAGES: Record<string, [number, number, number[]]> = { body: [20, 30, [200, 100, 50]], arm: [8, 12, [50, 200, 100]], hat: [16, 10, [100, 50, 200]] };
export const imageOf = (name: string): RGBAImage | null => {
  const spec = IMAGES[name];
  if (!spec) return null;
  const [w, h, c] = spec;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([c[0], c[1], c[2], 128 + (i % 100)], i * 4);
  return { width: w, height: h, data };
};

