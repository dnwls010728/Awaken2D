// Event sounds in the editor: while an animation plays, events whose definition has an audio path play
// audio/<path> next to the model (Spine's event volume / balance, a key's own values first).
import type { Animation, Model } from "../src/core/index.ts";

const MUTE_KEY = "awaken2d.audio.muted";

export class EventAudio {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  /** Sounds that could not be loaded (missing file, unsupported format), by audio path. */
  readonly missing = new Set<string>();
  muted: boolean;
  private url: (path: string) => string | null;
  private onMissing: (path: string, why: string) => void;

  constructor(url: (path: string) => string | null, onMissing: (path: string, why: string) => void) {
    this.url = url;
    this.onMissing = onMissing;
    let m = false;
    try {
      m = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      /* storage blocked */
    }
    this.muted = m;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  }

  /** Forgets loaded sounds (another model, or its files changed). */
  reset(): void {
    this.buffers.clear();
    this.missing.clear();
  }

  private context(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Loads the sound early so the first event plays on time. */
  preload(path: string): void {
    void this.load(path);
  }

  private load(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (p) return p;
    const ctx = this.context();
    const url = this.url(path);
    p =
      !ctx || !url
        ? Promise.resolve(null)
        : fetch(url)
            .then(async (r) => {
              if (!r.ok) throw new Error(r.status === 404 ? "file not found" : `HTTP ${r.status}`);
              return ctx.decodeAudioData(await r.arrayBuffer());
            })
            .catch((e: Error) => {
              this.missing.add(path);
              this.onMissing(path, e.message || "cannot decode");
              return null;
            });
    this.buffers.set(path, p);
    return p;
  }

  /** Plays one sound now. */
  async play(path: string, volume = 1, balance = 0): Promise<void> {
    const ctx = this.context();
    const buf = await this.load(path);
    if (!ctx || !buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, volume);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, balance));
    src.connect(gain).connect(pan).connect(ctx.destination);
    src.start();
  }

  /**
   * Plays the sounds of the events keyed in (from, to] of the animation's local time; `wrapped` when playback looped
   * past the end in between (then (from, duration] and [0, to]). `from` < 0 includes keys at time 0.
   */
  fire(model: Model, anim: Animation, from: number, to: number, wrapped: boolean): void {
    if (this.muted || !anim.events?.length) return;
    const hit = (t: number) => (wrapped ? t > from || t <= to : t > from && t <= to);
    for (const key of anim.events) {
      if (!hit(key.t)) continue;
      const def = model.events?.[key.name];
      if (!def?.audio || this.missing.has(def.audio)) continue;
      void this.play(def.audio, key.volume ?? def.volume ?? 1, key.balance ?? def.balance ?? 0);
    }
  }
}

/** The audio paths an animation's events play. */
export function animationSounds(model: Model, anim: Animation | undefined): string[] {
  const out = new Set<string>();
  for (const k of anim?.events ?? []) {
    const a = model.events?.[k.name]?.audio;
    if (a) out.add(a);
  }
  return [...out];
}
