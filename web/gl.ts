// WebGL mesh renderer for the editor: textured/tinted triangles in world space, premultiplied alpha.
import type { DrawItem } from "../src/core/index.ts";

export interface View {
  /** World point at the canvas center. */
  cx: number;
  cy: number;
  /** CSS pixels per world unit. */
  zoom: number;
}

const VS = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_center;
uniform vec2 u_scale;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4((a_pos - u_center) * u_scale, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_tint;
uniform vec3 u_screen;
uniform vec3 u_dark;
uniform float u_alphaTest;
varying vec2 v_uv;
void main() {
  vec4 t = texture2D(u_tex, v_uv);
  vec4 c = t * vec4(u_tint.rgb * u_tint.a, u_tint.a);
  // Spine two-color tint: the dark parts take u_dark (premultiplied: (a - rgb) * dark)
  c.rgb += (t.a - t.rgb) * u_dark * u_tint.a;
  if (c.a < u_alphaTest) discard;
  c.rgb += u_screen * c.a - c.rgb * u_screen;
  gl_FragColor = c;
}`;

interface MeshBuffers {
  key: unknown;
  uv: WebGLBuffer;
  index: WebGLBuffer;
  count: number;
}

export class MeshRenderer {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private pos: WebGLBuffer;
  private white: WebGLTexture;
  private textures = new Map<string, { tex: WebGLTexture; src: string }>();
  private meshes = new Map<string, MeshBuffers>();
  /** Reused upload buffer for deformed positions (no per-mesh, per-frame allocation). */
  private scratch = new Float32Array(4096);
  /** WebGL2 allows mipmaps on any texture size: big art stays smooth and cheap when zoomed out. */
  private readonly mipmapsAnySize: boolean;
  private loc: { pos: number; uv: number; center: WebGLUniformLocation; scale: WebGLUniformLocation; tint: WebGLUniformLocation; screen: WebGLUniformLocation; dark: WebGLUniformLocation; alphaTest: WebGLUniformLocation };

  constructor(canvas: HTMLCanvasElement) {
    const attrs = { premultipliedAlpha: true, alpha: false, antialias: true, stencil: true };
    const gl2 = canvas.getContext("webgl2", attrs);
    const gl = (gl2 as unknown as WebGLRenderingContext | null) ?? (canvas.getContext("webgl", attrs) as WebGLRenderingContext | null);
    if (!gl) throw new Error("WebGL is not available in this browser");
    this.mipmapsAnySize = !!gl2;
    this.gl = gl;
    this.prog = link(gl, VS, FS);
    this.loc = {
      pos: gl.getAttribLocation(this.prog, "a_pos"),
      uv: gl.getAttribLocation(this.prog, "a_uv"),
      center: gl.getUniformLocation(this.prog, "u_center")!,
      scale: gl.getUniformLocation(this.prog, "u_scale")!,
      tint: gl.getUniformLocation(this.prog, "u_tint")!,
      screen: gl.getUniformLocation(this.prog, "u_screen")!,
      dark: gl.getUniformLocation(this.prog, "u_dark")!,
      alphaTest: gl.getUniformLocation(this.prog, "u_alphaTest")!,
    };
    this.pos = gl.createBuffer()!;
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }

  /** Uploads (or keeps) the texture for an image id; `src` changes force a reload. */
  setImage(id: string, src: string, img: HTMLImageElement): void {
    const gl = this.gl;
    const old = this.textures.get(id);
    if (old?.src === src) return;
    const tex = old?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const pot = (n: number) => (n & (n - 1)) === 0;
    if (this.mipmapsAnySize || (pot(img.naturalWidth) && pot(img.naturalHeight))) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(id, { tex, src });
  }

  render(items: DrawItem[], view: View, width: number, height: number, dpr: number, background: [number, number, number]): void {
    const gl = this.gl;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (gl.canvas.width !== w || gl.canvas.height !== h) {
      gl.canvas.width = w;
      gl.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.uniform1f(this.loc.alphaTest, 0);
    gl.uniform2f(this.loc.center, view.cx, view.cy);
    gl.uniform2f(this.loc.scale, (2 * view.zoom) / width, (2 * view.zoom) / height);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.enableVertexAttribArray(this.loc.uv);

    const bySlot = new Map(items.map((it) => [it.slot, it]));
    /** Spine clipping polygon in the stencil buffer (bit 2), shared by the items it clips. */
    let stamped: unknown = null;
    for (const it of items) {
      if (it.clipPolygon) {
        if (stamped !== it.clipPolygon) {
          this.stampPolygon(it.clipPolygon);
          stamped = it.clipPolygon;
        }
        // (slot masks on a clipped item are ignored: Spine models have none)
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(it.clipOutside ? gl.NOTEQUAL : gl.EQUAL, 2, 0x02);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        this.drawItem(it);
        gl.disable(gl.STENCIL_TEST);
        continue;
      }
      if (it.clip) {
        // clipping: stamp the masks' shapes into the stencil buffer, then draw only where it is set (or not set)
        const masks = it.clip.map((c) => bySlot.get(c)).filter((m): m is DrawItem => !!m);
        if (!masks.length && !it.clipInvert) continue;
        gl.enable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        stamped = null;
        gl.stencilFunc(gl.ALWAYS, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.colorMask(false, false, false, false);
        gl.uniform1f(this.loc.alphaTest, 0.5);
        for (const m of masks) this.drawItem({ ...m, cull: false });
        gl.uniform1f(this.loc.alphaTest, 0);
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(it.clipInvert ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        this.drawItem(it);
        gl.disable(gl.STENCIL_TEST);
      } else this.drawItem(it);
    }
  }

  private drawItem(it: DrawItem): void {
    const gl = this.gl;
    {
      const mesh = this.meshFor(it);
      const tex = it.attachment.image ? this.textures.get(it.attachment.image)?.tex : undefined;
      if (it.attachment.image && !tex) return; // image still loading
      gl.bindTexture(gl.TEXTURE_2D, tex ?? this.white);
      if (it.blend === "multiply") gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
      else if (it.blend === "screen") gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      else if (it.blend === "additive") gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(this.loc.tint, it.color[0], it.color[1], it.color[2], it.color[3]);
      const sc = it.screen ?? [0, 0, 0];
      gl.uniform3f(this.loc.screen, sc[0], sc[1], sc[2]);
      const dk = it.dark ?? [0, 0, 0];
      gl.uniform3f(this.loc.dark, dk[0], dk[1], dk[2]);
      if (it.cull) {
        gl.enable(gl.CULL_FACE);
        gl.frontFace(gl.CCW);
        gl.cullFace(gl.BACK);
      } else gl.disable(gl.CULL_FACE);
      const n = it.positions.length * 2;
      if (this.scratch.length < n) this.scratch = new Float32Array(Math.max(n, this.scratch.length * 2));
      const flat = this.scratch;
      for (let i = 0; i < it.positions.length; i++) {
        flat[i * 2] = it.positions[i][0];
        flat[i * 2 + 1] = it.positions[i][1];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pos);
      gl.bufferData(gl.ARRAY_BUFFER, flat.subarray(0, n), gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
      gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
  }

  /**
   * Writes a polygon's inside into stencil bit 2 (cleared first): a triangle fan with INVERT marks every point
   * covered an odd number of times, which is the inside of any simple polygon, convex or not.
   */
  private stampPolygon(polygon: Array<[number, number]>): void {
    const gl = this.gl;
    const n = polygon.length * 2;
    if (this.scratch.length < n) this.scratch = new Float32Array(Math.max(n, this.scratch.length * 2));
    polygon.forEach((p, i) => {
      this.scratch[i * 2] = p[0];
      this.scratch[i * 2 + 1] = p[1];
    });
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0x02);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.CULL_FACE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pos);
    gl.bufferData(gl.ARRAY_BUFFER, this.scratch.subarray(0, n), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(this.loc.uv);
    gl.vertexAttrib2f(this.loc.uv, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    if (polygon.length >= 3) gl.drawArrays(gl.TRIANGLE_FAN, 0, polygon.length);
    gl.enableVertexAttribArray(this.loc.uv);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.disable(gl.STENCIL_TEST);
  }

  /** Static per-attachment buffers, rebuilt when the attachment object changes (i.e. after a reload). */
  private meshFor(it: DrawItem): MeshBuffers {
    const gl = this.gl;
    const cached = this.meshes.get(it.attachmentId);
    if (cached && cached.key === it.attachment) return cached;
    const att = it.attachment;
    const uv = new Float32Array(att.vertices.length * 2);
    att.uvs?.forEach((u, i) => {
      uv[i * 2] = u[0];
      uv[i * 2 + 1] = u[1];
    });
    const idx = new Uint16Array(att.triangles.flat());
    const mesh: MeshBuffers = cached ?? { key: null, uv: gl.createBuffer()!, index: gl.createBuffer()!, count: 0 };
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    mesh.key = att;
    mesh.count = idx.length;
    this.meshes.set(it.attachmentId, mesh);
    return mesh;
  }
}

function link(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}
