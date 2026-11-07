/**
 * engine.ts — fixed-timestep game loop (decoupled from frame rate) + pooled frame state.
 * All gameplay logic advances at a fixed step in update(dt); rendering runs with interpolation in render(alpha).
 */

export interface GameLoopHooks {
  /** Fixed-step logic update. dt is always STEP (seconds). */
  update: (dt: number) => void;
  /** Render. alpha ∈ [0,1) is the interpolation factor between the previous and current step. */
  render: (alpha: number) => void;
}

export class GameLoop {
  /** Fixed step: 60Hz. */
  static readonly STEP = 1 / 60;
  private static readonly MAX_FRAME = 0.25; // never catch up more than 250ms after a stall, to prevent the spiral of death

  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  constructor(private hooks: GameLoopHooks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      let delta = (now - this.last) / 1000;
      this.last = now;
      if (delta > GameLoop.MAX_FRAME) delta = GameLoop.MAX_FRAME;
      this.acc += delta;
      while (this.acc >= GameLoop.STEP) {
        this.hooks.update(GameLoop.STEP);
        this.acc -= GameLoop.STEP;
      }
      this.hooks.render(this.acc / GameLoop.STEP);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
