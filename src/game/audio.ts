/**
 * audio.ts — Web Audio synthesized SFX + a light generative music loop + mute toggle
 * (remembered in localStorage). No audio asset files at all — everything is synthesized
 * at runtime.
 */

export type SfxId =
  | "move" | "hit" | "pickup" | "ui" | "explosion" | "win" | "lose"
  | "till" | "plant" | "water" | "harvest" | "coin" | "error";

const MUTE_KEY = "game.muted";

// localStorage can throw (storage disabled, private mode, third-party storage blocked
// inside a preview iframe) — a game must never fail to start because of that.
function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeMuted(v: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    // not persisted this session; the in-memory flag still works
  }
}

// C-major pentatonic-ish scale (C D E G A across two octaves) for the generative melody.
const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99];
// Eighth-note melody pattern; -1 = rest.
const MELODY = [
  0, -1, 2, 4, -1, 4, 3, -1,
  0, -1, 2, 3, 4, -1, -1, -1,
  5, -1, 4, 2, -1, 3, 2, -1,
  1, 2, 3, 2, 0, -1, -1, -1,
];
// Bass as scale degrees (played two octaves down), one per quarter note.
const BASS = [
  0, -1, -1, -1, -1, -1, -1, -1,
  3, -1, -1, -1, -1, -1, -1, -1,
  4, -1, -1, -1, -1, -1, -1, -1,
  3, -1, -1, -1, 2, -1, -1, -1,
];

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private nextNote = 0;
  private noteIdx = 0;
  private disposed = false;
  muted = false;

  // browsers require a first user interaction before the AudioContext can start
  private readonly unlock = () => {
    this.ensureCtx();
    this.detachUnlock();
  };

  constructor() {
    this.muted = readMuted();
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  private detachUnlock(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  /**
   * Release everything: unlock listeners, the music scheduler and the AudioContext.
   * Call it from your teardown path (stopGame) next to input.dispose() — otherwise React
   * StrictMode's double mount / HMR leaks one AudioContext per mount, and Chrome caps a
   * page at about six of them.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachUnlock();
    this.stopMusic();
    this.master?.disconnect();
    this.master = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    writeMuted(this.muted);
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  private note(type: OscillatorType, freq: number, t: number, dur: number, gain: number): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  sfx(id: SfxId): void {
    if (this.disposed || this.muted) return; // muted: no context is created either
    const ctx = this.ensureCtx();
    if (!this.master) return;
    const t = ctx.currentTime;
    const spec: Record<SfxId, [type: OscillatorType, f0: number, f1: number, dur: number, gain: number]> = {
      move: ["triangle", 220, 180, 0.08, 0.15],
      hit: ["square", 160, 60, 0.12, 0.3],
      pickup: ["sine", 660, 990, 0.12, 0.25],
      ui: ["sine", 440, 520, 0.05, 0.15],
      explosion: ["sawtooth", 120, 30, 0.4, 0.4],
      win: ["sine", 523, 1046, 0.5, 0.3],
      lose: ["sawtooth", 220, 55, 0.6, 0.3],
      till: ["square", 95, 55, 0.14, 0.3],
      plant: ["triangle", 480, 720, 0.1, 0.25],
      water: ["sine", 340, 190, 0.22, 0.22],
      harvest: ["sine", 700, 1250, 0.16, 0.28],
      coin: ["square", 990, 1480, 0.09, 0.2],
      error: ["sawtooth", 210, 130, 0.18, 0.22],
    };
    const [type, f0, f1, dur, g] = spec[id];
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    env.gain.setValueAtTime(g, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
    if (id === "harvest" || id === "win") {
      // small sparkle arpeggio on top
      this.note("sine", f1 * 1.5, t + dur * 0.7, 0.12, 0.15);
      this.note("sine", f1 * 2, t + dur * 1.2, 0.14, 0.12);
    }
  }

  /** Gentle generative music loop (pentatonic melody + soft bass), lookahead-scheduled. */
  startMusic(): void {
    if (this.disposed || this.musicTimer !== null) return;
    const ctx = this.ensureCtx();
    this.nextNote = ctx.currentTime + 0.08;
    this.noteIdx = 0;
    this.musicTimer = setInterval(() => this.scheduleMusic(), 110);
  }

  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.disposed) return;
    const STEP = 0.27;
    while (this.nextNote < ctx.currentTime + 0.35) {
      const deg = MELODY[this.noteIdx % MELODY.length];
      if (deg >= 0) this.note("triangle", SCALE[deg], this.nextNote, STEP * 1.9, 0.06);
      const bass = BASS[this.noteIdx % BASS.length];
      if (bass >= 0) this.note("sine", SCALE[bass] / 4, this.nextNote, STEP * 3.2, 0.07);
      this.nextNote += STEP;
      this.noteIdx++;
    }
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }
}
