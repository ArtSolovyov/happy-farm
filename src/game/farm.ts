/**
 * farm.ts — «Счастливая ферма»: 2D top-down farm demo on Canvas 2D.
 *
 * Core loop: till → plant → water → grow → harvest → coins → buy better seeds →
 * reach GOAL_COINS to win. Interacting systems: watering gates growth, seed
 * economy gates planting, crop choice trades time vs profit, day/night cycle
 * paces the run.
 *
 * All gameplay state lives here and advances in update(dt) at a fixed 60Hz step;
 * render() only draws current state. No allocation in the hot loop: particles
 * and floating texts are pooled, decor is precomputed once with a seeded PRNG.
 */

import { GameStateMachine } from "./state";
import type { Input } from "./input";
import type { AudioSystem } from "./audio";
import { storage } from "./storage";

export const LOGICAL_W = 1280;
export const LOGICAL_H = 720;

const GOAL_COINS = 200;
const DAY_LENGTH = 100; // real seconds per in-game day
const DAY_START = 0.3; // time-of-day the run starts at (morning)
const INTERACT_RADIUS = 60;
const PLAYER_SPEED = 155;
const WATER_DURATION = 25; // seconds a watering lasts

// ---------------------------------------------------------------------------
// Crops
// ---------------------------------------------------------------------------

interface CropDef {
  id: string;
  name: string;
  emoji: string;
  cost: number; // seed price
  sell: number; // harvest income
  grow: number; // seconds of watered growth to mature
}

const CROPS: CropDef[] = [
  { id: "wheat", name: "Пшеница", emoji: "🌾", cost: 5, sell: 12, grow: 14 },
  { id: "carrot", name: "Морковь", emoji: "🥕", cost: 10, sell: 26, grow: 22 },
  { id: "pumpkin", name: "Тыква", emoji: "🎃", cost: 25, sell: 70, grow: 34 },
];

// ---------------------------------------------------------------------------
// Field layout
// ---------------------------------------------------------------------------

const COLS = 6;
const ROWS = 4;
const CELL = 84;
const PLOT = 68;
const FIELD_OX = 640 - (COLS * CELL) / 2; // 388
const FIELD_OZ = 400 - (ROWS * CELL) / 2; // 232

type PlotState = "grass" | "tilled" | "planted";
type Action = "till" | "plant" | "water" | "harvest" | null;

interface Plot {
  cx: number;
  cz: number;
  state: PlotState;
  crop: number; // index into CROPS
  growth: number; // 0..1
  water: number; // seconds of moisture left
  flash: number; // interaction feedback pulse
}

// ---------------------------------------------------------------------------
// Pooled effects
// ---------------------------------------------------------------------------

interface Particle {
  alive: boolean;
  x: number; z: number; vx: number; vz: number;
  life: number; maxLife: number; size: number; grav: number;
  color: string;
}

interface Floater {
  alive: boolean;
  x: number; z: number; life: number;
  text: string; color: string;
}

// ---------------------------------------------------------------------------
// Day/night tint keyframes: [tod, color, alpha]
// ---------------------------------------------------------------------------

const TINTS: Array<[number, string, number]> = [
  [0.0, "#141c44", 0.42],
  [0.2, "#141c44", 0.42],
  [0.26, "#ff9a4a", 0.12],
  [0.32, "#000000", 0.0],
  [0.68, "#000000", 0.0],
  [0.76, "#ff9a4a", 0.14],
  [0.84, "#141c44", 0.42],
  [1.0, "#141c44", 0.42],
];

// Deterministic PRNG (no bare Math.random): stable decor, reproducible feel.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tuft { x: number; z: number; s: number; phase: number }
interface Flower { x: number; z: number; color: string }
interface Butterfly { x: number; z: number; seed: number; color: string }

const FONT = 'system-ui, "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export class FarmGame {
  private sm = new GameStateMachine();

  // world
  private plots: Plot[] = [];
  private tufts: Tuft[] = [];
  private flowers: Flower[] = [];
  private butterflies: Butterfly[] = [];
  private particles: Particle[] = [];
  private floaters: Floater[] = [];

  // player
  private px = 640;
  private pz = 580;
  private facing = 1; // -1 left, +1 right (for a subtle lean)
  private walkPhase = 0;
  private moving = false;

  // economy / run state
  private coins = 20;
  private seeds = [3, 1, 0];
  private selected = 0;
  private elapsed = 0; // in-game seconds this run
  private earned = 0;
  private harvests = 0;
  private bestCoins = 0;
  private bestDays = 0;

  private time = 0; // wall-clock animation time (runs in every state)
  private rng = mulberry32(20261107);

  constructor(
    private ctx: CanvasRenderingContext2D,
    private input: Input,
    private audio: AudioSystem,
  ) {
    for (let i = 0; i < 160; i++) {
      this.particles.push({ alive: false, x: 0, z: 0, vx: 0, vz: 0, life: 0, maxLife: 1, size: 2, grav: 0, color: "#fff" });
    }
    for (let i = 0; i < 14; i++) {
      this.floaters.push({ alive: false, x: 0, z: 0, life: 0, text: "", color: "#fff" });
    }
    this.bestCoins = storage.get<number>("farm.bestCoins", 0);
    this.bestDays = storage.get<number>("farm.bestDays", 0);

    // precomputed ambient decor
    const d = mulberry32(4242);
    for (let i = 0; i < 26; i++) this.tufts.push({ x: 40 + d() * 1200, z: 120 + d() * 560, s: 0.7 + d() * 0.7, phase: d() * 6.28 });
    const petal = ["#ff7eb6", "#ffd54a", "#ff8a65", "#c58cff"];
    for (let i = 0; i < 14; i++) this.flowers.push({ x: 60 + d() * 1160, z: 140 + d() * 520, color: petal[i % petal.length] });
    for (let i = 0; i < 3; i++) this.butterflies.push({ x: 0, z: 0, seed: d() * 100, color: petal[(i + 1) % petal.length] });

    this.reset();
    this.sm.onChange((s) => {
      if (s === "playing") this.audio.startMusic();
      else if (s === "title") this.audio.stopMusic();
    });
  }

  get state() { return this.sm.state; }
  get playerX() { return this.px; }
  get playerZ() { return this.pz; }

  /** Compact state snapshot for scripted playtests (verify scripts, smoke tests). */
  debugState(): { coins: number; seeds: number[]; state: string; tilled: number; planted: number; mature: number } {
    let tilled = 0, planted = 0, mature = 0;
    for (const p of this.plots) {
      if (p.state === "tilled") tilled++;
      else if (p.state === "planted") { planted++; if (p.growth >= 1) mature++; }
    }
    return { coins: this.coins, seeds: [...this.seeds], state: this.sm.state, tilled, planted, mature };
  }

  private reset(): void {
    this.plots = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        this.plots.push({
          cx: FIELD_OX + c * CELL + CELL / 2,
          cz: FIELD_OZ + r * CELL + CELL / 2,
          state: "grass", crop: 0, growth: 0, water: 0, flash: 0,
        });
      }
    }
    this.px = 640; this.pz = 580; this.facing = 1; this.walkPhase = 0;
    this.coins = 20; this.seeds = [3, 1, 0]; this.selected = 0;
    this.elapsed = 0; this.earned = 0; this.harvests = 0;
    for (const p of this.particles) p.alive = false;
    for (const f of this.floaters) f.alive = false;
  }

  private day(): number { return Math.floor(this.elapsed / DAY_LENGTH) + 1; }
  private tod(): number { return (DAY_START + this.elapsed / DAY_LENGTH) % 1; }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    this.time += dt;
    this.updateAmbient(dt);

    if (this.input.consumeAction("KeyM")) {
      this.audio.toggleMute();
      this.audio.sfx("ui");
    }

    const st = this.sm.state;
    if (st === "title") {
      if (this.input.consumeAction("Space") || this.input.consumeAction("Enter")) {
        this.audio.sfx("ui");
        this.sm.transition("playing");
      }
      return;
    }
    if (st === "paused") {
      if (this.input.consumeAction("Escape") || this.input.consumeAction("Space")) {
        this.audio.sfx("ui");
        this.sm.transition("playing");
      } else if (this.input.consumeAction("KeyT")) {
        this.audio.sfx("ui");
        this.audio.stopMusic();
        this.reset();
        this.sm.transition("title");
      }
      return;
    }
    if (st === "gameover") {
      if (this.input.consumeAction("Space") || this.input.consumeAction("Enter")) {
        this.audio.sfx("ui");
        this.reset();
        this.sm.transition("playing");
      }
      return;
    }

    // ---- playing ----
    this.elapsed += dt;
    if (this.input.consumeAction("Escape")) { this.sm.transition("paused"); return; }

    if (this.input.consumeAction("Digit1")) { this.selected = 0; this.audio.sfx("ui"); }
    if (this.input.consumeAction("Digit2")) { this.selected = 1; this.audio.sfx("ui"); }
    if (this.input.consumeAction("Digit3")) { this.selected = 2; this.audio.sfx("ui"); }
    if (this.input.consumeAction("KeyQ")) this.buySeed();

    // movement: W/forward = up on screen (z decreases), D = right (x increases)
    let dx = this.input.moveX;
    let dz = -this.input.moveZ;
    const m = Math.hypot(dx, dz);
    if (m > 1) { dx /= m; dz /= m; }
    this.moving = m > 0.05;
    if (this.moving) {
      this.px += dx * PLAYER_SPEED * dt;
      this.pz += dz * PLAYER_SPEED * dt;
      this.walkPhase += dt * 11;
      if (Math.abs(dx) > 0.1) this.facing = dx > 0 ? 1 : -1;
    }
    this.px = Math.min(LOGICAL_W - 26, Math.max(26, this.px));
    this.pz = Math.min(LOGICAL_H - 26, Math.max(116, this.pz));

    // crops
    for (const p of this.plots) {
      if (p.flash > 0) p.flash -= dt;
      if (p.state === "planted") {
        if (p.water > 0) {
          p.water -= dt;
          if (p.growth < 1) p.growth = Math.min(1, p.growth + dt / CROPS[p.crop].grow);
        }
      }
    }

    // interaction
    const target = this.nearestPlot();
    if (target && this.input.consumeAction("KeyE")) this.interact(target);
  }

  private nearestPlot(): Plot | null {
    let best: Plot | null = null;
    let bestD = INTERACT_RADIUS;
    for (const p of this.plots) {
      const d = Math.hypot(p.cx - this.px, p.cz - this.pz);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  private actionFor(p: Plot): Action {
    if (p.state === "grass") return "till";
    if (p.state === "tilled") return "plant";
    if (p.growth >= 1) return "harvest";
    if (p.water <= 0) return "water";
    return null;
  }

  private interact(p: Plot): void {
    const act = this.actionFor(p);
    if (act === "till") {
      p.state = "tilled"; p.flash = 0.35;
      this.audio.sfx("till");
      this.burst(p.cx, p.cz, 10, ["#8a5a33", "#6f4526", "#a9744a"], 55, 0.5, 120);
    } else if (act === "plant") {
      if (this.seeds[this.selected] <= 0) {
        this.audio.sfx("error");
        this.spawnFloater(p.cx, p.cz - 40, `Нет семян! Q — купить (${CROPS[this.selected].cost}●)`, "#ff8a80");
        return;
      }
      this.seeds[this.selected]--;
      p.state = "planted"; p.crop = this.selected; p.growth = 0; p.water = 0; p.flash = 0.35;
      this.audio.sfx("plant");
      this.burst(p.cx, p.cz, 8, ["#7ec850", "#5aa73c"], 40, 0.45, 90);
    } else if (act === "water") {
      p.water = WATER_DURATION; p.flash = 0.35;
      this.audio.sfx("water");
      this.burst(p.cx, p.cz - 10, 12, ["#5db9ff", "#8fd4ff", "#3d9be0"], 70, 0.55, 140);
    } else if (act === "harvest") {
      const def = CROPS[p.crop];
      this.coins += def.sell;
      this.earned += def.sell;
      this.harvests++;
      this.audio.sfx("harvest");
      this.audio.sfx("coin");
      this.spawnFloater(p.cx, p.cz - 44, `+${def.sell} ●`, "#ffd54a");
      this.burst(p.cx, p.cz, 16, ["#ffd54a", "#fff2b0", "#ffb830"], 85, 0.7, 150);
      p.state = "tilled"; p.growth = 0; p.water = 0; p.flash = 0.35;
      if (this.coins > this.bestCoins) { this.bestCoins = this.coins; storage.set("farm.bestCoins", this.bestCoins); }
      if (this.coins >= GOAL_COINS) this.win();
    }
  }

  private buySeed(): void {
    const def = CROPS[this.selected];
    if (this.coins < def.cost) {
      this.audio.sfx("error");
      this.spawnFloater(this.px, this.pz - 50, "Не хватает монет!", "#ff8a80");
      return;
    }
    this.coins -= def.cost;
    this.seeds[this.selected]++;
    this.audio.sfx("coin");
    this.spawnFloater(this.px, this.pz - 50, `+1 ${def.emoji}`, "#b9f6ca");
  }

  private win(): void {
    const days = this.day();
    if (this.bestDays === 0 || days < this.bestDays) { this.bestDays = days; storage.set("farm.bestDays", days); }
    this.audio.sfx("win");
    this.sm.transition("gameover");
    // confetti
    const palette = ["#ffd54a", "#ff7eb6", "#7ec850", "#5db9ff", "#c58cff"];
    for (let i = 0; i < 5; i++) {
      this.burst(340 + this.rng() * 600, 200 + this.rng() * 250, 18, palette, 120, 1.4, 90);
    }
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  private burst(x: number, z: number, n: number, colors: string[], speed: number, life: number, grav: number): void {
    for (let i = 0; i < n; i++) {
      const p = this.particles.find((q) => !q.alive);
      if (!p) return;
      const a = this.rng() * Math.PI * 2;
      const v = (0.35 + this.rng() * 0.65) * speed;
      p.alive = true;
      p.x = x; p.z = z;
      p.vx = Math.cos(a) * v; p.vz = Math.sin(a) * v * 0.7 - speed * 0.35;
      p.maxLife = life * (0.6 + this.rng() * 0.6);
      p.life = p.maxLife;
      p.size = 2 + this.rng() * 3;
      p.grav = grav;
      p.color = colors[(this.rng() * colors.length) | 0];
    }
  }

  private spawnFloater(x: number, z: number, text: string, color: string): void {
    const f = this.floaters.find((q) => !q.alive) ?? this.floaters[0];
    f.alive = true; f.x = x; f.z = z; f.life = 1.3; f.text = text; f.color = color;
  }

  private updateAmbient(dt: number): void {
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vz += p.grav * dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
    }
    for (const f of this.floaters) {
      if (!f.alive) continue;
      f.life -= dt;
      f.z -= 26 * dt;
      if (f.life <= 0) f.alive = false;
    }
    for (const b of this.butterflies) {
      const t = this.time * 0.35 + b.seed;
      b.x = 640 + Math.sin(t) * 480 + Math.sin(t * 2.7) * 90;
      b.z = 380 + Math.cos(t * 1.3) * 210 + Math.sin(t * 3.1) * 50;
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(): void {
    const c = this.ctx;
    this.drawGround(c);
    this.drawDecor(c);
    this.drawField(c);
    this.drawPlayer(c);
    this.drawEffects(c);
    this.drawDayNight(c);
    this.drawHud(c);

    const st = this.sm.state;
    if (st === "title") this.drawTitle(c);
    else if (st === "paused") this.drawPause(c);
    else if (st === "gameover") this.drawVictory(c);
  }

  private rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  private drawGround(c: CanvasRenderingContext2D): void {
    c.fillStyle = "#79bb4a";
    c.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    const s = 64;
    c.fillStyle = "#71b244";
    for (let y = 0; y < LOGICAL_H / s; y++) {
      for (let x = (y % 2); x < LOGICAL_W / s; x += 2) {
        c.fillRect(x * s, y * s, s, s);
      }
    }
    // dirt path from the bottom edge to the field
    c.fillStyle = "#c9a86f";
    this.rr(c, 600, 560, 80, 160, 18);
    c.fill();
    c.fillStyle = "#bb9a62";
    for (let i = 0; i < 5; i++) c.fillRect(610 + (i % 2) * 34, 578 + i * 28, 26, 12);
  }

  private drawDecor(c: CanvasRenderingContext2D): void {
    // grass tufts (gentle sway)
    c.strokeStyle = "#5aa73c";
    c.lineWidth = 2;
    for (const t of this.tufts) {
      const sway = Math.sin(this.time * 1.6 + t.phase) * 1.6;
      c.beginPath();
      c.moveTo(t.x, t.z);
      c.lineTo(t.x - 3 * t.s + sway, t.z - 7 * t.s);
      c.moveTo(t.x, t.z);
      c.lineTo(t.x + sway, t.z - 9 * t.s);
      c.moveTo(t.x, t.z);
      c.lineTo(t.x + 3 * t.s + sway, t.z - 7 * t.s);
      c.stroke();
    }
    // flowers
    for (const f of this.flowers) {
      c.fillStyle = "#4e9b38";
      c.fillRect(f.x - 1, f.z - 6, 2, 6);
      c.fillStyle = f.color;
      c.beginPath(); c.arc(f.x, f.z - 8, 3.4, 0, 6.29); c.fill();
      c.fillStyle = "#fff7d6";
      c.beginPath(); c.arc(f.x, f.z - 8, 1.4, 0, 6.29); c.fill();
    }
    // barn (top-left)
    c.fillStyle = "rgba(0,0,0,0.15)";
    c.beginPath(); c.ellipse(190, 216, 84, 16, 0, 0, 6.29); c.fill();
    c.fillStyle = "#b4453a";
    c.fillRect(126, 140, 128, 72);
    c.fillStyle = "#8e332b";
    c.beginPath(); c.moveTo(114, 142); c.lineTo(190, 92); c.lineTo(266, 142); c.closePath(); c.fill();
    c.fillStyle = "#7c2a23";
    c.fillRect(168, 170, 44, 42);
    c.strokeStyle = "#e8d8c0"; c.lineWidth = 3;
    c.strokeRect(168, 170, 44, 42);
    c.beginPath(); c.moveTo(168, 170); c.lineTo(212, 212); c.moveTo(212, 170); c.lineTo(168, 212); c.stroke();
    // tree (top-right)
    const swayT = Math.sin(this.time * 0.9) * 3;
    c.fillStyle = "rgba(0,0,0,0.15)";
    c.beginPath(); c.ellipse(1092, 226, 70, 14, 0, 0, 6.29); c.fill();
    c.fillStyle = "#7a4f2c";
    c.fillRect(1082, 168, 20, 54);
    c.fillStyle = "#4e8f3a";
    c.beginPath(); c.arc(1092 + swayT, 130, 52, 0, 6.29); c.fill();
    c.fillStyle = "#5da345";
    c.beginPath(); c.arc(1072 + swayT, 112, 34, 0, 6.29); c.fill();
    c.beginPath(); c.arc(1116 + swayT, 118, 30, 0, 6.29); c.fill();
    // well (left of the field)
    c.fillStyle = "rgba(0,0,0,0.15)";
    c.beginPath(); c.ellipse(306, 442, 36, 9, 0, 0, 6.29); c.fill();
    c.fillStyle = "#9aa3ad";
    c.beginPath(); c.arc(306, 428, 26, 0, 6.29); c.fill();
    c.fillStyle = "#39434e";
    c.beginPath(); c.arc(306, 428, 17, 0, 6.29); c.fill();
    c.fillStyle = "#7a4f2c";
    c.fillRect(284, 396, 6, 26); c.fillRect(322, 396, 6, 26);
    c.fillStyle = "#b4453a";
    c.beginPath(); c.moveTo(278, 398); c.lineTo(306, 378); c.lineTo(334, 398); c.closePath(); c.fill();
    // butterflies
    for (const b of this.butterflies) {
      const flap = Math.abs(Math.sin(this.time * 14 + b.seed)) * 0.8 + 0.2;
      c.fillStyle = b.color;
      c.beginPath(); c.ellipse(b.x - 4 * flap, b.z, 4.5 * flap, 3, -0.4, 0, 6.29); c.fill();
      c.beginPath(); c.ellipse(b.x + 4 * flap, b.z, 4.5 * flap, 3, 0.4, 0, 6.29); c.fill();
      c.fillStyle = "#3a2d22";
      c.fillRect(b.x - 0.8, b.z - 3, 1.6, 6);
    }
  }

  private drawField(c: CanvasRenderingContext2D): void {
    // fence around the field
    const fx = FIELD_OX - 18, fz = FIELD_OZ - 18;
    const fw = COLS * CELL + 36, fh = ROWS * CELL + 36;
    c.strokeStyle = "#a9744a";
    c.lineWidth = 5;
    c.strokeRect(fx, fz, fw, fh);
    c.fillStyle = "#8a5a33";
    for (let x = fx; x <= fx + fw; x += 42) { c.fillRect(x - 3, fz - 5, 6, 12); c.fillRect(x - 3, fz + fh - 7, 6, 12); }
    for (let z = fz; z <= fz + fh; z += 42) { c.fillRect(fx - 5, z - 3, 12, 6); c.fillRect(fx + fw - 7, z - 3, 12, 6); }

    const target = this.sm.state === "playing" ? this.nearestPlot() : null;

    for (const p of this.plots) {
      const x = p.cx - PLOT / 2, z = p.cz - PLOT / 2;
      if (p.state === "grass") {
        c.fillStyle = "#68ad3f";
        this.rr(c, x, z, PLOT, PLOT, 10); c.fill();
        c.strokeStyle = "rgba(0,0,0,0.12)"; c.lineWidth = 2;
        this.rr(c, x, z, PLOT, PLOT, 10); c.stroke();
      } else {
        const wet = p.state === "planted" && p.water > 0;
        c.fillStyle = wet ? "#5f3d22" : "#8a5a33";
        this.rr(c, x, z, PLOT, PLOT, 10); c.fill();
        c.strokeStyle = wet ? "#4a2f1a" : "#6f4526";
        c.lineWidth = 2;
        for (let i = 1; i < 4; i++) {
          c.beginPath(); c.moveTo(x + 8, z + i * 15); c.lineTo(x + PLOT - 8, z + i * 15); c.stroke();
        }
        if (p.state === "planted") this.drawCrop(c, p);
      }
      // water indicator
      if (p.state === "planted" && p.water > 0) {
        c.font = `13px ${FONT}`;
        c.textAlign = "center"; c.textBaseline = "middle";
        c.fillText("💧", x + PLOT - 10, z + 10);
      }
      // interaction feedback pulse
      if (p.flash > 0) {
        c.strokeStyle = `rgba(255,255,255,${Math.min(1, p.flash * 3)})`;
        c.lineWidth = 3;
        this.rr(c, x - 3, z - 3, PLOT + 6, PLOT + 6, 12); c.stroke();
      }
    }

    // highlight the plot under interaction
    if (target) {
      const pulse = 0.55 + Math.sin(this.time * 6) * 0.25;
      c.strokeStyle = `rgba(255,255,240,${pulse})`;
      c.lineWidth = 3;
      c.setLineDash([8, 6]);
      this.rr(c, target.cx - PLOT / 2 - 5, target.cz - PLOT / 2 - 5, PLOT + 10, PLOT + 10, 12);
      c.stroke();
      c.setLineDash([]);
    }
  }

  private drawCrop(c: CanvasRenderingContext2D, p: Plot): void {
    const g = p.growth;
    const stage = g >= 1 ? 2 : g >= 0.45 ? 1 : 0;
    const pop = g >= 1 ? 1 + Math.sin(this.time * 4 + p.cx) * 0.05 : 1;
    c.save();
    c.translate(p.cx, p.cz);
    c.scale(pop, pop);

    if (p.crop === 0) {
      // wheat: green sprouts → golden stalks
      const h = stage === 0 ? 10 + g * 12 : stage === 1 ? 26 : 34;
      const col = stage === 2 ? "#e8c552" : stage === 1 ? "#9fc24a" : "#6fbf4a";
      c.strokeStyle = col; c.lineWidth = 3;
      for (const [ox, oz] of [[-16, -12], [16, -12], [-16, 14], [16, 14], [0, 0]] as const) {
        c.beginPath(); c.moveTo(ox, oz + 6); c.lineTo(ox, oz + 6 - h); c.stroke();
        if (stage === 2) {
          c.fillStyle = "#f4dc7e";
          c.beginPath(); c.ellipse(ox, oz + 4 - h, 4, 7, 0, 0, 6.29); c.fill();
        }
      }
    } else if (p.crop === 1) {
      // carrot: leafy tops, orange shoulders when mature
      const s = stage === 0 ? 0.6 : stage === 1 ? 0.85 : 1.1;
      for (const [ox, oz] of [[-12, -8], [12, -8], [0, 12]] as const) {
        if (stage === 2) {
          c.fillStyle = "#f08c28";
          c.beginPath(); c.ellipse(ox, oz + 5, 6 * s, 5 * s, 0, 0, 6.29); c.fill();
        }
        c.strokeStyle = "#4e9b38"; c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(ox, oz + 3); c.lineTo(ox - 5 * s, oz - 9 * s);
        c.moveTo(ox, oz + 3); c.lineTo(ox, oz - 12 * s);
        c.moveTo(ox, oz + 3); c.lineTo(ox + 5 * s, oz - 9 * s);
        c.stroke();
      }
    } else {
      // pumpkin: sprout → vine → big pumpkin
      if (stage === 0) {
        c.strokeStyle = "#6fbf4a"; c.lineWidth = 3;
        c.beginPath(); c.moveTo(0, 6); c.lineTo(0, -10); c.stroke();
        c.beginPath(); c.moveTo(0, -4); c.lineTo(-7, -9); c.moveTo(0, -4); c.lineTo(7, -9); c.stroke();
      } else if (stage === 1) {
        c.strokeStyle = "#5da345"; c.lineWidth = 3;
        c.beginPath(); c.arc(0, 2, 12, 0.3, 5.4); c.stroke();
        c.fillStyle = "#f5a03a";
        c.beginPath(); c.arc(6, -4, 8, 0, 6.29); c.fill();
      } else {
        c.fillStyle = "#f5882a";
        c.beginPath(); c.ellipse(0, 2, 24, 19, 0, 0, 6.29); c.fill();
        c.strokeStyle = "#d96f1a"; c.lineWidth = 2.5;
        for (const ox of [-10, 0, 10]) {
          c.beginPath(); c.ellipse(ox, 2, 5, 18, 0, 0, 6.29); c.stroke();
        }
        c.fillStyle = "#6fbf4a";
        c.fillRect(-3, -22, 6, 8);
        c.beginPath(); c.ellipse(-12, -14, 8, 4, -0.5, 0, 6.29); c.fill();
      }
    }
    c.restore();

    // growth progress arc for immature crops
    if (g < 1) {
      c.strokeStyle = "rgba(255,255,255,0.85)";
      c.lineWidth = 3;
      c.beginPath();
      c.arc(p.cx, p.cz - PLOT / 2 - 12, 9, -Math.PI / 2, -Math.PI / 2 + g * Math.PI * 2);
      c.stroke();
    }
  }

  private drawPlayer(c: CanvasRenderingContext2D): void {
    const bob = this.moving ? Math.abs(Math.sin(this.walkPhase)) * 2.5 : 0;
    const x = this.px, z = this.pz - bob;
    // shadow
    c.fillStyle = "rgba(0,0,0,0.22)";
    c.beginPath(); c.ellipse(this.px, this.pz + 14, 15, 6, 0, 0, 6.29); c.fill();
    // boots shuffle
    const step = this.moving ? Math.sin(this.walkPhase) * 4 : 0;
    c.fillStyle = "#5b3a24";
    c.fillRect(x - 9 + step * 0.4, z + 8, 7, 6);
    c.fillRect(x + 2 - step * 0.4, z + 8, 7, 6);
    // body (shirt)
    c.fillStyle = "#4a90d9";
    c.beginPath(); c.arc(x, z + 2, 13, 0, 6.29); c.fill();
    c.fillStyle = "#3a74b3";
    c.fillRect(x - 13, z + 4, 26, 4);
    // head
    c.fillStyle = "#f2c894";
    c.beginPath(); c.arc(x, z - 10, 9, 0, 6.29); c.fill();
    // straw hat
    c.fillStyle = "#e8c552";
    c.beginPath(); c.ellipse(x, z - 13, 15, 6.5, 0, 0, 6.29); c.fill();
    c.beginPath(); c.arc(x, z - 14, 8, Math.PI, 0); c.fill();
    c.fillStyle = "#c9a23a";
    c.fillRect(x - 8, z - 15, 16, 3);
    // nose hint of facing
    c.fillStyle = "#d9a86e";
    c.beginPath(); c.arc(x + this.facing * 7, z - 9, 2, 0, 6.29); c.fill();

    // context hint
    if (this.sm.state === "playing") {
      const t = this.nearestPlot();
      if (t) {
        const act = this.actionFor(t);
        let hint: string | null = null;
        if (act === "till") hint = "E — вскопать";
        else if (act === "plant") hint = `E — посадить: ${CROPS[this.selected].name} ${CROPS[this.selected].emoji}`;
        else if (act === "water") hint = "E — полить 💧";
        else if (act === "harvest") hint = "E — собрать! ✨";
        else hint = `Растёт… ${Math.round(t.growth * 100)}%`;
        c.font = `bold 14px ${FONT}`;
        const w = c.measureText(hint).width + 22;
        const hx = Math.min(LOGICAL_W - w / 2 - 8, Math.max(w / 2 + 8, x));
        const hz = z - 46;
        c.fillStyle = "rgba(30,24,14,0.82)";
        this.rr(c, hx - w / 2, hz - 12, w, 24, 12); c.fill();
        c.fillStyle = "#fff3d6";
        c.textAlign = "center"; c.textBaseline = "middle";
        c.fillText(hint, hx, hz + 1);
      }
    }
  }

  private drawEffects(c: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      if (!p.alive) continue;
      c.globalAlpha = Math.max(0, p.life / p.maxLife);
      c.fillStyle = p.color;
      c.fillRect(p.x - p.size / 2, p.z - p.size / 2, p.size, p.size);
    }
    c.globalAlpha = 1;
    c.textAlign = "center"; c.textBaseline = "middle";
    for (const f of this.floaters) {
      if (!f.alive) continue;
      c.globalAlpha = Math.min(1, f.life);
      c.font = `bold 17px ${FONT}`;
      c.strokeStyle = "rgba(0,0,0,0.55)"; c.lineWidth = 3;
      c.strokeText(f.text, f.x, f.z);
      c.fillStyle = f.color;
      c.fillText(f.text, f.x, f.z);
    }
    c.globalAlpha = 1;
  }

  private drawDayNight(c: CanvasRenderingContext2D): void {
    const t = this.tod();
    let i = 0;
    while (i < TINTS.length - 2 && TINTS[i + 1][0] < t) i++;
    const [t0, col0, a0] = TINTS[i];
    const [t1, col1, a1] = TINTS[i + 1];
    const k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const alpha = a0 + (a1 - a0) * k;
    if (alpha > 0.005) {
      c.globalAlpha = Math.min(1, Math.max(0, alpha));
      c.fillStyle = a0 > a1 ? col0 : col1;
      c.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      c.globalAlpha = 1;
    }
  }

  private drawHud(c: CanvasRenderingContext2D): void {
    // top bar
    c.fillStyle = "rgba(30,24,14,0.72)";
    this.rr(c, 12, 12, 430, 58, 14); c.fill();
    c.textBaseline = "middle";
    c.textAlign = "left";
    c.font = `bold 24px ${FONT}`;
    c.fillStyle = "#ffd54a";
    c.fillText(`● ${this.coins}`, 28, 42);
    c.font = `bold 16px ${FONT}`;
    c.fillStyle = "#fff3d6";
    c.fillText(`День ${this.day()}`, 160, 34);
    c.font = `13px ${FONT}`;
    c.fillStyle = "#d9c9a8";
    c.fillText(`Цель: ${GOAL_COINS} ●`, 160, 56);

    // sun/moon arc
    const bx = 250, bw = 176;
    c.fillStyle = "rgba(255,255,255,0.16)";
    this.rr(c, bx, 34, bw, 10, 5); c.fill();
    const t = this.tod();
    const isDay = t > 0.28 && t < 0.78;
    c.font = `16px ${FONT}`;
    c.textAlign = "center";
    c.fillText(isDay ? "☀️" : "🌙", bx + t * bw, 39);

    // controls hint (top-right)
    c.font = `12px ${FONT}`;
    c.textAlign = "right";
    c.fillStyle = "rgba(30,24,14,0.6)";
    this.rr(c, LOGICAL_W - 252, 12, 240, 30, 10); c.fill();
    c.fillStyle = "#e8dcc2";
    c.fillText(`Esc — пауза · M — звук ${this.audio.muted ? "🔇" : "🔊"}`, LOGICAL_W - 26, 28);

    // seed bar (bottom-center)
    const slotW = 168, slotH = 62, gap = 12;
    const total = slotW * 3 + gap * 2;
    const sx = 640 - total / 2, sz = LOGICAL_H - slotH - 14;
    for (let i = 0; i < 3; i++) {
      const def = CROPS[i];
      const x = sx + i * (slotW + gap);
      const sel = i === this.selected;
      c.fillStyle = sel ? "rgba(255,246,221,0.95)" : "rgba(30,24,14,0.62)";
      this.rr(c, x, sz - (sel ? 6 : 0), slotW, slotH, 12); c.fill();
      if (sel) {
        c.strokeStyle = "#ffd54a"; c.lineWidth = 3;
        this.rr(c, x, sz - 6, slotW, slotH, 12); c.stroke();
      }
      c.textAlign = "left"; c.textBaseline = "middle";
      c.font = `22px ${FONT}`;
      c.fillText(def.emoji, x + 12, sz + 24 - (sel ? 6 : 0));
      c.font = `bold 14px ${FONT}`;
      c.fillStyle = sel ? "#4a3418" : "#fff3d6";
      c.fillText(`${i + 1} · ${def.name}`, x + 44, sz + 17 - (sel ? 6 : 0));
      c.font = `13px ${FONT}`;
      c.fillStyle = sel ? "#7a5c30" : "#d9c9a8";
      c.fillText(`семян: ${this.seeds[i]} · продажа ${def.sell}●`, x + 44, sz + 38 - (sel ? 6 : 0));
    }
    c.font = `12px ${FONT}`;
    c.textAlign = "center";
    c.fillStyle = "rgba(255,243,214,0.9)";
    c.fillText(`Q — купить семя «${CROPS[this.selected].name}» за ${CROPS[this.selected].cost} ●`, 640, sz - 14);
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  private dim(c: CanvasRenderingContext2D, a: number): void {
    c.fillStyle = `rgba(16,12,6,${a})`;
    c.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  }

  private panel(c: CanvasRenderingContext2D, w: number, h: number): void {
    const x = 640 - w / 2, z = 360 - h / 2;
    c.fillStyle = "rgba(0,0,0,0.3)";
    this.rr(c, x + 6, z + 8, w, h, 22); c.fill();
    c.fillStyle = "#fff6dd";
    this.rr(c, x, z, w, h, 22); c.fill();
    c.strokeStyle = "#8a5a33"; c.lineWidth = 4;
    this.rr(c, x, z, w, h, 22); c.stroke();
  }

  private drawTitle(c: CanvasRenderingContext2D): void {
    this.dim(c, 0.45);
    this.panel(c, 560, 400);
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = "#4a7c2f";
    c.font = `bold 46px ${FONT}`;
    c.fillText("🌻 Счастливая ферма", 640, 218);
    c.font = `17px ${FONT}`;
    c.fillStyle = "#6b4f2a";
    c.fillText(`Выращивай урожай и заработай ${GOAL_COINS} монет!`, 640, 264);

    c.font = `15px ${FONT}`;
    c.fillStyle = "#54401f";
    const lines = [
      "WASD / стрелки — движение",
      "E — вскопать · посадить · полить · собрать",
      "1 / 2 / 3 — выбор семян · Q — купить семена",
      "💧 Ростки растут, только пока почва влажная",
    ];
    lines.forEach((l, i) => c.fillText(l, 640, 312 + i * 26));

    if (this.bestCoins > 0) {
      c.font = `14px ${FONT}`;
      c.fillStyle = "#8a6a3a";
      const rec = this.bestDays > 0 ? `рекорд: ${this.bestCoins} ● · победа за ${this.bestDays} дн.` : `рекорд: ${this.bestCoins} ●`;
      c.fillText(rec, 640, 432);
    }

    const blink = 0.6 + Math.sin(this.time * 4) * 0.4;
    c.globalAlpha = blink;
    c.fillStyle = "#b4453a";
    c.font = `bold 22px ${FONT}`;
    c.fillText("ПРОБЕЛ — играть", 640, 500);
    c.globalAlpha = 1;
  }

  private drawPause(c: CanvasRenderingContext2D): void {
    this.dim(c, 0.5);
    this.panel(c, 420, 260);
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = "#54401f";
    c.font = `bold 34px ${FONT}`;
    c.fillText("⏸ Пауза", 640, 290);
    c.font = `15px ${FONT}`;
    c.fillText(`Монеты: ${this.coins} ● · День ${this.day()} · Урожаев: ${this.harvests}`, 640, 336);
    c.fillStyle = "#8a6a3a";
    c.fillText("Esc / Пробел — продолжить", 640, 392);
    c.fillText("T — выйти в меню", 640, 420);
  }

  private drawVictory(c: CanvasRenderingContext2D): void {
    this.dim(c, 0.45);
    this.panel(c, 520, 330);
    c.textAlign = "center"; c.textBaseline = "middle";
    c.font = `bold 38px ${FONT}`;
    c.fillStyle = "#4a7c2f";
    c.fillText("🎉 Ферма процветает!", 640, 240);
    c.font = `17px ${FONT}`;
    c.fillStyle = "#54401f";
    c.fillText(`Ты заработал ${this.earned} ● за ${this.day()} дн.`, 640, 296);
    c.fillText(`Собрано урожаев: ${this.harvests}`, 640, 326);
    c.font = `14px ${FONT}`;
    c.fillStyle = "#8a6a3a";
    c.fillText(`Рекорд: ${this.bestCoins} ● · лучший результат за ${this.bestDays} дн.`, 640, 364);

    const blink = 0.6 + Math.sin(this.time * 4) * 0.4;
    c.globalAlpha = blink;
    c.fillStyle = "#b4453a";
    c.font = `bold 20px ${FONT}`;
    c.fillText("ПРОБЕЛ — играть снова", 640, 452);
    c.globalAlpha = 1;
  }
}
