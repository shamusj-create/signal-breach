# Signal Breach

A 3D isometric turn-based tactical infiltration game. Deterministic simulation (no dice), Three.js
presentation, React HUD, Node + SQLite server that validates replays against the shared sim.

**Play it:** `npm install`, then `npm run serve` and `npm run dev -w @sb/web` (the dev server proxies
`/api` to the backend). See [Run](#run) below.

## Playing it
Everything is reachable with the mouse alone — keyboard shortcuts exist as optional accelerators.

| Input | Action |
| --- | --- |
| Left click | Select an operative, move onto a highlighted tile, or click a highlighted target to act |
| Hover a piece | Glows its outline and highlights its maximum move range (both sides — enemy range is a threat read) |
| Left drag on the board | **Grab-to-rotate**: the board pivots around a pin at the centre of the screen and the point you grabbed follows the cursor |
| Right drag | Pan, relative to the current view at every rotation angle |
| Hover an ability | Highlights the tiles it can legally affect; click a targeted ability to **arm** it |
| Cancel (Esc) | Clear an armed ability or a pending action |
| Mouse wheel / camera dock | Zoom, rotate in 90° steps, reset view |

The top-right panel has two tabs: a **Commentary** feed of the running turn history, and **Objectives**
(objectives plus squad status). Selecting an operative plays its own robotic line (*"<unit> at your
service"*). Ability use renders a travelling flight path with a trail and an impact beat.

## Architecture (separation that enables headless testing)
- `packages/sim` (`@sb/sim`) — authoritative simulation: PRNG, map, A* pathfinding, LOS + cover,
  deterministic combat, abilities, enemy AI (scoring), turn system, replay, save, scoring, replay
  validation. No DOM/Three. Testable in browser + Node + Vitest.
- `packages/server` (`@sb/server`) — Node HTTP + SQLite leaderboard + `/api/submit` (server replays
  the action log with the SAME sim package; only validated runs are stored) + `/api/leaderboard`.
- `packages/web` (`@sb/web`) — Vite + React + Three.js (direct). Camera, lighting/shadows/fog/bloom,
  procedural unit/tile geometry, particles, screen shake, HUD, menus, replay viewer, audio, debug.

Determinism invariants: rules never call `Math.random()`; the renderer never feeds rules; the
server and browser share one sim. Replays re-run the action log, not a recording.

## Run
- `npm install`
- `npm run verify` — full verification (typecheck, build, headless tests, browser journeys)
- `npm run test` — headless (Vitest). `npm run e2e` — Playwright.
- `npm run serve` — server on :8787 (`SB_DB=./data/lb.sqlite npm run serve` to persist).
- Dev game: `npm run dev -w @sb/web`.

## Audio
Sound effects are 22 curated samples from **Kenney**'s CC0 audio packs (sci-fi, interface, impact and
UI), and the unit selection lines are robotic speech generated with **flite**. Both are licence-cleared
for commercial use and redistributable. The exact source packs, their pinned URLs and sha256s, the
per-event mapping and the generation recipe are recorded in
[`docs/AUDIO_PROVENANCE.md`](docs/AUDIO_PROVENANCE.md), and `scripts/gen-audio.sh` reproduces the whole
set — failing closed if a download no longer matches its recorded hash.

## Determinism hooks (debug, not gameplay shortcuts)
`window.__sbGame`, `window.__sbHash`, `window.__sbPerf`, `window.__sbReplayRun` drive the real
simulation for tests. F3 toggles the debug overlay (FPS/draw/tri/seed/turn/rev); default OFF.

See `docs/ACCEPTANCE.md` for the acceptance matrix + honest limitations.
