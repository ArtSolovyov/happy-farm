# game-3d template guide

**Minimal general game scaffold**: it only pre-installs "the things you'd have to prepare every time" — dependencies, build config, base components, self-check script. **It contains no specific game/scene design**; the agent creates freely on top of it.

## Project structure (aligned with the webapp `0-origin` template)

```
index.html              <div id="root"> + /src/main.tsx
src/main.tsx            createRoot + StrictMode + BrowserRouter   ← React entry
src/App.tsx             <Routes>, at minimum the "/" route
src/pages/Home.tsx      hosts the game canvas: startGame() in useEffect, stopGame() on cleanup
src/game/boot.ts        startGame()/stopGame() — **this is where your game starts**
src/game/               all game logic (never re-renders through React)
src/index.css           full-bleed canvas + HUD overlay styles
vite.config.ts          "@" → ./src alias, base './', no build section
tsconfig.json           solution file → tsconfig.app.json (paths "@/*") + tsconfig.node.json
scripts/build-output.ts  Vite output verification and tracked-file cleanup
scripts/verify-game.mjs Playwright smoke self-check
.gitignore              node_modules / dist / verification-shots
```

**There is exactly one entry point**, and it is the chain above: `index.html` → `src/main.tsx` →
`src/App.tsx` → `src/pages/Home.tsx` → `src/game/boot.ts`. There is no `src/main.ts`; a file by that
name is not loaded by anything and vite will not bundle it, so writing your game there produces a
build that passes and a canvas that stays black. Write the game in `src/game/`.

The React shell exists so this template stays **structurally identical to the webapp templates**: the
`backend-building` skill can be grafted straight on top (see below). React owns only the DOM shell —
the render loop lives entirely in `src/game/` and never touches React state, so there is no per-frame
re-render cost. Writing a pure-canvas game is still fine; just keep `main.tsx` / `App.tsx` / `pages/Home.tsx`
in place as the mount point.

## Pre-installed dependencies (usable via npm install, no on-the-spot downloads)

- `three` (+ `@types/three`) — 3D rendering (the default direction; if 2D is explicitly wanted, `phaser` is also pre-installed)
- `@dimforge/rapier3d-compat` — physics engine
- `phaser` — 2D engine (fallback)
- `vite` + `typescript` + `react/react-dom` + `react-router` + `@vitejs/plugin-react` — build and UI shell
- `playwright` + `@playwright/test` — browser self-check
- `vitest`, `lucide-react`

## Reusable base components (src/game/, take what you need, or discard entirely)

- `boot.ts` — the placeholder scene and the `startGame(canvas)` / `stopGame()` contract used by `pages/Home.tsx`
- `engine.ts` — fixed-timestep loop (60Hz, decoupled from frame rate)
- `state.ts` — title/playing/paused/gameover state machine
- `input.ts` — keyboard/mouse + touch input, **control-direction conventions are fixed** (W forward/S backward/A left/D right, intuitive mouse directions) — the most frequent playtest defect is a reversed direction mapping; when changing the conventions, sync the assertions in `scripts/verify-game.mjs`. `dispose()` detaches every listener — call it from your teardown path.
- `audio.ts` — Web Audio synthesized SFX + mute toggle. Owns two window listeners and an AudioContext, so it has a `dispose()` too — call it in your teardown path next to `input.dispose()` (the placeholder `boot.ts` creates no AudioSystem, which is why its dispose list has no audio line; add one when you do). Reads/writes `localStorage` defensively (never throws when storage is blocked)
- `storage.ts` — localStorage persistence; every call is wrapped, so a blocked storage degrades to the fallback value instead of throwing
- `config.ts` / `types.ts` — tuning parameters and object pools (zero allocation in the hot loop)

## Placeholder scene (src/game/boot.ts)

A ~100-line minimal three.js scene (floor + one WASD-movable box + camera follow); **its only job is to prove the
build/render/input pipeline works**. **Replace it wholesale when writing your game**; reusing the base components is
recommended. Two globals must survive that replacement:

- `window.__gameProbe()` → `{x, y, z}` player coordinates — the self-check's direction assertions read it
- `window.__GAME_READY__ = true` on the first rendered frame — the self-check waits for it before screenshotting

The self-check also assumes one thing about your title screen: after the ready flag it presses **Space** once and then
expects `W` / `D` to move the probe. Keep Space as a way from the title into a controllable state (a click-only
"Start" button makes the direction assertion report a reversed mapping that is not there), or change the
`page.keyboard.press("Space")` line in your project's `scripts/verify-game.mjs` to whatever starts your game.

The canvas element id is also part of that contract: `src/pages/Home.tsx` renders
`<canvas id="game-canvas">` and `scripts/verify-game.mjs` looks it up by that id (`CANVAS_ID` at the
top of the script). If you rename the id, rename it in both places — otherwise the self-check fails
with "no element with id=game-canvas" instead of checking your game.

`startGame()` stops any previous session first, and `stopGame()` releases loop + listeners + GPU resources, so
React StrictMode's dev-mode double mount never leaves two renderers alive. Keep that property if you rewrite `boot.ts`.

## Grafting a backend (backend-building)

> **Availability**: the `backend-building` skill is **not bundled in the Build plugin**, and the
> `webapp-publish` skill accepts STATIC sites only — a game built here ships frontend-only
> (`localStorage` saves; no real leaderboard, accounts, or cross-device sync). This section is
> reference for environments where a backend-building skill exists; do not attempt the graft here.

This template is a valid graft target for the `backend-building` skill: `vite.config.ts` carries the `"@"` alias and
**deliberately has no `build:` section** (the graft inserts `build.outDir = dist/public`), the tsconfig is the
solution-file layout the graft merges into, and `src/main.tsx` / `src/App.tsx` carry the `<BrowserRouter>` and
`</Routes>` anchors the auto-wiring looks for. Do not reintroduce a `build:` block in `vite.config.ts` — production
`npm start` serves `dist/public`, and a pre-existing `build:` section makes the graft skip the outDir rewrite, which
turns the home page into a 404.

The auth feature copies `src/pages/Login.tsx`, `src/pages/NotFound.tsx` and `src/components/AuthLayout*.tsx`, which
import shadcn/ui components (`@/components/ui/button`, `card`, `skeleton`, `sidebar`, `avatar`, `dropdown-menu`) and the
`@/hooks/use-mobile` hook. This game template ships no shadcn/ui and no Tailwind, so after grafting auth you must
either add those components *and* that hook or rewrite those pages in plain CSS before `npm run check` passes. The
graft's own exit code stays 0 either way — run `npm run check` yourself. Prefer `--features db` for a game unless it
really needs Kimi login.

## Self-check

```bash
cd app
npm run build              # tsc -b + vite build → dist/
node scripts/verify-game.mjs   # page loads → canvas not black → direction assertions (needs probe) → zero console errors
```

After a backend graft the `build` script is replaced by the backend's (`vite build` + server bundle, **no `tsc -b`**),
the client lands in `dist/public` and only `npm run check` type-checks — run it separately.

verify-game.mjs is a general smoke test: serve the build output → three-state screenshots (`verification-shots/`) →
zero console errors; if the page exposes `window.__gameProbe()` (returning player coordinates), it also asserts
"press W to move forward, press D to move right". It serves `dist/public` when that exists and falls back to `dist`,
but it is a **static** server: once the game calls `/api/*` on load, those requests 404 in the console and the check
fails on a "bug" that is only the missing server. So after a backend graft use it for the render/controls smoke test
before wiring API calls, and verify the wired game against the real server — `npm run dev` (port 3000, source + HMR)
in a real browser, or `npm run build && npm start` to exercise the production bundle that serves `dist/public`. The render check reads the canvas drawing buffer and
handles both a WebGL canvas (`readPixels`, needs `preserveDrawingBuffer`) and a 2D canvas (`getImageData`), so a
phaser/2D game is judged on its own terms instead of being reported as black.

`npm run build` keeps the output directory in place. The `gameBuildOutput()` Vite plugin in
`scripts/build-output.ts` disables Vite's initial directory clearing, reads back every emitted file and checks
its content against the current bundle (retrying reads for at most 5 seconds). Missing or stale output fails
the build with the affected paths; do not delete `dist` or repeatedly rebuild to diagnose it. Preserve the full
build log and investigate the mount's write visibility. Run builds sequentially, and start verification only
after the build command exits successfully; if piping logs, use `set -o pipefail`.

After verification, the plugin removes only unchanged generated files recorded by the previous successful
build that are no longer used. It never recursively deletes the output directory, and leaves public files and
user-modified files alone. `.game-build-files.json` stores that cleanup history outside `dist`; keep it while
iterating. The plugin also follows the backend graft's `dist/public` output path, cleaning tracked old frontend
files at the root of `dist` without touching the server bundle. Keep the plugin in `vite.config.ts` after a graft.
Files from builds made before this plugin existed are untracked and are left alone.

This checks the files visible at build completion; it is not an atomic deployment or a fix for the mount itself.
A type-check failure leaves the prior output untouched; a failure during output writing may leave a partial
update, which must not be published.

`vite build` prints a "chunks are larger than 500 kB" warning for a plain three.js bundle — that is a warning, not a
failure. Code-split with dynamic `import()` if you want it gone.

## Pre-delivery self-check (three most frequent defect classes)

1. **Control mapping**: press every key one by one and confirm no direction is reversed.
2. **Models & assets**: inspect the main entity up close — no clipping, no floating/misalignment, crosshair aligned with the impact point.
3. **Interaction coverage**: every button/key must genuinely respond.
