/**
 * verify-game.mjs — Playwright smoke self-check: serve dist → zero console errors → three-state screenshots →
 * **direction-mapping assertions** (directly targets the most frequent playtest defect). When changing the input
 * mapping you must sync the assertions here.
 *
 * Usage: npm run build && node scripts/verify-game.mjs
 * Serves dist/public when a backend has been grafted on, otherwise dist/.
 *
 * Notes:
 * - The canvas is looked up by id — CANVAS_ID below must match the <canvas id="..."> that
 *   src/pages/Home.tsx renders. Rename it in one place and you must rename it in the other.
 * - Both WebGL and 2D canvases are supported: WebGL is read through readPixels (needs
 *   preserveDrawingBuffer), a 2D canvas through getImageData.
 * - Headless falls back to SwiftShader (software GL): it proves rendering/logic correctness only,
 *   never performance. Measure fps on a real GPU separately.
 * - Screenshots land in verification-shots/ (process files: review them, then delete the dir
 *   before delivery — the deliverable must not keep process artifacts).
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: .pathname keeps percent-encoding, so a project living under a
// path with a space (or any non-ASCII character) would yield ".../My%20Games/app" and every
// existsSync() below would miss, reporting "no build output" for a build that is right there.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Build output location depends on whether a backend has been grafted on:
// plain game template -> dist/ ; after backend-building -> dist/public/ (dist/boot.js is the server bundle).
const DIST = existsSync(join(ROOT, "dist/public/index.html"))
  ? join(ROOT, "dist/public")
  : join(ROOT, "dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`VERIFY FAIL: no build output at ${DIST} — run \`npm run build\` first`);
  process.exit(1);
}
const SHOTS = join(ROOT, "verification-shots");
mkdirSync(SHOTS, { recursive: true });

// Must match <canvas id="..."> in src/pages/Home.tsx. Change both together.
const CANVAS_ID = "game-canvas";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm" };

const server = createServer(async (req, res) => {
  try {
    const raw = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    // Decode: request paths are percent-encoded, so an asset named "level 1.png" arrives as
    // "level%201.png" and would 404 (surfacing later as a bogus console-error failure).
    let path;
    try { path = decodeURIComponent(raw); } catch { path = raw; }
    const file = resolve(DIST, "." + path);
    if (file !== DIST && !file.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});

const fail = (msg) => { console.error("VERIFY FAIL:", msg); server.close(); process.exit(1); };

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
// prefer the playwright-bundled browser; fall back to system chrome (CHROMIUM_PATH overrides)
const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/gchrome/opt/google/chrome/chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);
let browser;
for (const exe of [null, ...CANDIDATES]) {
  try {
    browser = await chromium.launch(exe
      ? { executablePath: exe, args: ["--no-sandbox", "--disable-gpu-sandbox", "--use-gl=swiftshader"] }
      : {});
    break;
  } catch { /* try the next one */ }
}
if (!browser) fail("no usable browser found (playwright bundled/chrome/chromium all unavailable)");
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
// The page boots through a React shell (src/main.tsx -> src/App.tsx -> src/pages/Home.tsx),
// so the canvas only exists after the first effect runs: wait for the readiness flag the game
// raises on its first rendered frame, then fall back to a fixed delay if it never appears.
await page
  .waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 8000 })
  .catch(() => console.warn("WARN: window.__GAME_READY__ never turned true — falling back to a fixed wait (raise the flag in src/game/boot.ts)"));
await page.waitForTimeout(1200);

// 1) The canvas must actually render content (not a black screen). Judge by reading the drawing
//    buffer, not the screenshot — on headless/swiftshader the compositor may show the canvas as
//    black while the drawing buffer holds the real frame. WebGL needs preserveDrawingBuffer for
//    that read (the template's src/game/boot.ts enables it); 2D canvases go through getImageData.
const shot = await page.evaluate((id) => {
  const SAMPLES = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
  const el = document.getElementById(id);
  if (!el) {
    const others = Array.from(document.querySelectorAll("canvas")).map((c) => c.id || "(no id)");
    return { kind: "no-canvas", others };
  }
  if (!(el instanceof HTMLCanvasElement)) return { kind: "not-canvas", tag: el.tagName.toLowerCase() };

  const gl = el.getContext("webgl2") || el.getContext("webgl");
  if (gl) {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (!w || !h) return { kind: "empty-buffer", api: "webgl", w, h };
    const px = new Uint8Array(4);
    let lit = 0;
    for (const [fx, fy] of SAMPLES) {
      gl.readPixels((w * fx) | 0, (h * fy) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (px[3] > 0 && px[0] + px[1] + px[2] > 8) lit++;
    }
    return { kind: "lit", api: "webgl", lit, total: SAMPLES.length };
  }

  const ctx = el.getContext("2d");
  if (ctx) {
    const w = el.width, h = el.height;
    if (!w || !h) return { kind: "empty-buffer", api: "2d", w, h };
    let lit = 0;
    try {
      for (const [fx, fy] of SAMPLES) {
        const d = ctx.getImageData((w * fx) | 0, (h * fy) | 0, 1, 1).data;
        if (d[3] > 0 && d[0] + d[1] + d[2] > 8) lit++;
      }
    } catch (e) {
      return { kind: "tainted", message: String(e) };
    }
    return { kind: "lit", api: "2d", lit, total: SAMPLES.length };
  }
  return { kind: "no-context" };
}, CANVAS_ID);

switch (shot.kind) {
  case "no-canvas":
    fail(
      `no element with id="${CANVAS_ID}" on the page, so the render check could not run.\n` +
      `  This script looks up document.getElementById("${CANVAS_ID}"); the template renders that id from src/pages/Home.tsx.\n` +
      (shot.others.length
        ? `  Canvases that do exist: ${shot.others.join(", ")} — you renamed the id.\n`
        : `  There is no <canvas> on the page at all — did startGame() run, or did the page throw before mounting?\n`) +
      `  Fix: keep id="${CANVAS_ID}" in the page, or change CANVAS_ID at the top of this script to the id you use.`
    );
    break;
  case "not-canvas":
    fail(`the element with id="${CANVAS_ID}" is a <${shot.tag}>, not a <canvas> — give the canvas that id (src/pages/Home.tsx), or point CANVAS_ID at the right element.`);
    break;
  case "no-context":
    fail(`#${CANVAS_ID} exposes neither a WebGL nor a 2D context — this is not a drawable canvas, so "black" cannot be judged. Check how the renderer acquires its context in src/game/boot.ts.`);
    break;
  case "tainted":
    fail(`#${CANVAS_ID} is a 2D canvas whose pixels cannot be read back (${shot.message}) — a cross-origin image tainted it. Serve textures from the project itself so the render check can run.`);
    break;
  case "empty-buffer":
    fail(`#${CANVAS_ID} has a zero-sized ${shot.api} buffer (${shot.w}x${shot.h}) — the canvas was never sized. Set renderer.setSize()/canvas.width+height in src/game/boot.ts.`);
    break;
  case "lit":
    if (shot.lit < 2) {
      fail(shot.api === "webgl"
        ? `#${CANVAS_ID} (WebGL) is black: only ${shot.lit}/${shot.total} sampled pixels carry colour. If you are sure the game has visuals, check whether the renderer disabled preserveDrawingBuffer — without it the buffer reads back empty.`
        : `#${CANVAS_ID} (2D) is blank: only ${shot.lit}/${shot.total} sampled pixels carry colour. Nothing was drawn to the 2D context by the time of the check.`);
    }
    break;
  default:
    fail(`unexpected canvas check result: ${JSON.stringify(shot)}`);
}
await page.screenshot({ path: join(SHOTS, "01-title.png") });

// 2) Enter playing
await page.keyboard.press("Space");
await page.waitForTimeout(400);

// 3) Direction assertions: pressing W must move forward (moving in the z-decreasing direction), pressing D must move right (x increasing)
async function playerPos() {
  return page.evaluate(() => window.__gameProbe ? window.__gameProbe() : null);
}
async function deltaAfter(key, ms = 500) {
  const before = await playerPos();
  if (!before) return null;
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  const after = await playerPos();
  return after ? { dx: after.x - before.x, dz: after.z - before.z } : null;
}

const probe = await page.evaluate(() => !!window.__gameProbe);
if (probe) {
  const dW = await deltaAfter("KeyW");
  if (dW && dW.dz >= -0.05) fail(`W did not move forward (dz=${dW?.dz.toFixed(3)}) — direction mapping looks reversed`);
  const dD = await deltaAfter("KeyD");
  if (dD && dD.dx <= 0.05) fail(`D did not move right (dx=${dD?.dx.toFixed(3)}) — direction mapping looks reversed`);
} else {
  console.warn("WARN: window.__gameProbe not injected, skipping direction assertions (expose a player-coordinate probe in src/game/boot.ts)");
}

// 4) Gameplay screenshot + Esc pause + restart
await page.screenshot({ path: join(SHOTS, "02-gameplay.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.screenshot({ path: join(SHOTS, "03-paused.png") });

// 5) Zero console errors
if (consoleErrors.length) fail(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);

await browser.close();
server.close();
console.log("VERIFY OK: render/enter/direction/pause/console all passed; screenshots in verification-shots/");
