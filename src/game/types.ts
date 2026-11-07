/**
 * types.ts — shared types.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Camera pose (right-handed): yaw around the Y axis (turning right increases in the negative direction), pitch around the X axis (looking up is positive). */
export interface CameraRig {
  yaw: number;
  pitch: number;
  pos: Vec3;
}

/** Common interface for pooled objects: avoids allocation in the hot loop. */
export interface Poolable {
  alive: boolean;
  reset(): void;
}

export class Pool<T extends Poolable> {
  private items: T[] = [];
  constructor(private factory: () => T, size: number) {
    for (let i = 0; i < size; i++) this.items.push(factory());
  }
  obtain(): T | null {
    for (const it of this.items) {
      if (!it.alive) {
        it.alive = true;
        it.reset();
        return it;
      }
    }
    return null; // pool exhausted: rather spawn nothing than allocate in the hot loop
  }
  each(fn: (it: T) => void): void {
    for (const it of this.items) if (it.alive) fn(it);
  }
}
