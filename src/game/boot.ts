/**
 * boot.ts — «Счастливая ферма» bootstrap: mounts the 2D canvas, wires the fixed-timestep
 * loop, input and audio into FarmGame, handles resize/DPR letterboxing, and exposes the
 * readiness flag + direction probe that scripts/verify-game.mjs relies on.
 *
 * Contract with the React shell (src/pages/Home.tsx):
 *   startGame(canvas)  mounts the game onto the existing <canvas id="game-canvas">
 *   stopGame()         tears everything down (loop, listeners, audio)
 * Calling startGame twice is safe: the previous session is stopped first, so React
 * StrictMode's double mount in dev never leaves two loops alive.
 */

import { GameLoop } from "./engine";
import { Input } from "./input";
import { AudioSystem } from "./audio";
import { FarmGame, LOGICAL_W, LOGICAL_H } from "./farm";

declare global {
  interface Window {
    /** Player-coordinate probe — scripts/verify-game.mjs asserts direction mapping through it. */
    __gameProbe?: () => { x: number; y: number; z: number };
    /** Readiness signal — the self-check waits for it before screenshotting/asserting. */
    __GAME_READY__?: boolean;
    /** Compact farm-state snapshot for scripted playtests. */
    __farmState?: () => unknown;
  }
}

let session: { dispose: () => void } | null = null;

export function startGame(canvas: HTMLCanvasElement): void {
  stopGame();

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // Logical resolution is fixed (LOGICAL_W x LOGICAL_H); the world is letterboxed to fit.
  let dpr = 1;
  let scale = 1;
  let offX = 0;
  let offY = 0;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = window.innerWidth;
    const ch = window.innerHeight;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    scale = Math.min(cw / LOGICAL_W, ch / LOGICAL_H);
    offX = (cw - LOGICAL_W * scale) / 2;
    offY = (ch - LOGICAL_H * scale) / 2;
  };
  resize();
  window.addEventListener("resize", resize);

  const input = new Input(canvas);
  const audio = new AudioSystem();
  const game = new FarmGame(ctx, input, audio);

  const loop = new GameLoop({
    update: (dt) => game.update(dt),
    render: () => {
      // letterbox bars in device pixels, then the logical frame
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#101a10";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offX, dpr * offY);
      game.render();
      window.__GAME_READY__ = true; // first rendered frame = the page is playable
    },
  });
  loop.start();

  // self-check probe: W must decrease z (up on screen), D must increase x
  window.__gameProbe = () => ({ x: game.playerX, y: 0, z: game.playerZ });
  window.__farmState = () => game.debugState();

  session = {
    dispose: () => {
      loop.stop();
      window.removeEventListener("resize", resize);
      input.dispose();
      audio.dispose();
      delete window.__gameProbe;
      delete window.__farmState;
      window.__GAME_READY__ = false;
    },
  };
}

export function stopGame(): void {
  session?.dispose();
  session = null;
}
