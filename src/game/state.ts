/**
 * state.ts — game state machine: title → playing ⇄ paused → gameover → (restart) → playing.
 * Each state has enter/exit hooks; illegal transitions throw immediately (surfacing flow holes early).
 */

export type GameState = "title" | "playing" | "paused" | "gameover";

const TRANSITIONS: Record<GameState, readonly GameState[]> = {
  title: ["playing"],
  playing: ["paused", "gameover", "title"],
  paused: ["playing", "title"],
  gameover: ["playing", "title"],
};

export class GameStateMachine {
  private _state: GameState = "title";
  private listeners = new Set<(s: GameState, prev: GameState) => void>();

  get state(): GameState {
    return this._state;
  }

  is(...states: GameState[]): boolean {
    return states.includes(this._state);
  }

  /** Illegal transitions throw — soft-locks surface here first. */
  transition(next: GameState): void {
    const prev = this._state;
    if (prev === next) return;
    if (!TRANSITIONS[prev].includes(next)) {
      throw new Error(`illegal state transition: ${prev} -> ${next}`);
    }
    this._state = next;
    for (const fn of this.listeners) fn(next, prev);
  }

  onChange(fn: (s: GameState, prev: GameState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
