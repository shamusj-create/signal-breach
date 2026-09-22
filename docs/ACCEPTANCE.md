# Signal Breach — Acceptance Contract

Durable acceptance matrix. Each criterion lists evidence + how to re-verify. "Verified" = a fresh
PASS on current source via the listed command. Run all: `bash scripts/verify-all.sh`.

Legend: status is `PASS` (freshly verified) or `PARTIAL` (implemented, not fully verified) or
`FAIL`. Loss = remaining weight of not-fully-verified criteria.

## Hard gates (completion forbidden if any FAIL)

| ID | Gate | Command | Status |
|----|------|---------|--------|
| GAME-001 | Production build (vite) | `npm run build -w @sb/web` | PASS |
| GAME-002 | Strict TypeScript (`tsc --noEmit`, strict, noUnusedLocals) | `npx tsc -p tsconfig.json --noEmit` | PASS |
| GAME-003 | Deterministic replay (log re-run reproduces state) | `npx vitest run` (replay + determinism tests) | PASS |
| GAME-004 | Server replay validation (shared sim) | `npx vitest run packages/server` | PASS |
| GAME-005 | Tamper rejection (score / action / outcome) | `npx vitest run packages/server` | PASS |
| GAME-006 | Pathfinding correctness (A*/reach, occupancy, elevation) | `npx vitest run packages/sim/test/core.test.ts` | PASS |
| GAME-007 | LOS correctness | `npx vitest run packages/sim/test/game.test.ts` | PASS |
| GAME-008 | Campaign persistence survives reload | `npx playwright test e2e/journeys.spec.ts` (Journey D) | PASS |
| GAME-009 | Required browser journeys A–H | `npx playwright test` | PASS |
| GAME-010 | Acceptance-contract integrity (this matrix + checks) | manual/`scripts/verify-all.sh` | PASS |

## Weighted criteria (20% each bucket summarized)

### Simulation correctness (20%) — GAME-011
Deterministic, no `Math.random()` in rules; pure reducer; state hashing. Verified: `vitest`
(`game.test.ts` determinism + `core.test.ts`). Status: PASS.

### Combat / pathfinding / LOS (15%) — GAME-012
Cover (none/half/full) + preview==result + enemy-phase never stalls. Verified: `vitest`
(preview==applied test), `playwright` Journey A + Journey B. Status: PASS.

### Enemy AI (10%) — GAME-013
Explicit scoring (damage/cover/exposure/kill/flank/warden-support), deterministic, debug candidate
list exists (`aiCandidates`). Verified: `vitest` (AI determinism test). Status: PASS.
Note: AI "flanking/objective-protection" are weighted in scoring; visual debug overlay shows
FPS/turn/seed but not yet a full per-candidate score readout — PARTIAL sub-item.

### Mission / objective / progression (10%) — GAME-014
3 distinct missions; relay→core→extract chain enforced; between-mission upgrades change stats.
Verified: `vitest` (mission authoring + completion), `playwright` Journey C (objectives win).
Status: PASS.

### Determinism / replay (15%) — GAME-015
Replay re-runs the action log; speed-independent; seed+action reproducibility. Verified:
`vitest` (replay determinism) + `playwright` Journey E (two runs identical hash) + Journey G
(replay viewer speed-independent + restart). Status: PASS.

### Server validation / persistence (10%) — GAME-016
SQLite leaderboard; server re-runs sim; rejects tampered; only validated runs stored. Verified:
`vitest packages/server` (function + real HTTP transport). Status: PASS.

### Rendering / visual polish (10%) — GAME-017
Persp iso camera, shadows, fog, bloom, particles, screen shake, distinct unit silhouettes,
range/path/hover markers, markers for objectives. Verified (functional): `playwright`
`render.spec.ts` (non-blank canvas, mesh/shadow counts, perf) + `journeys` H. 
VISUAL self-review: screenshots captured (artifacts/*), but no vision tool available in this run
to inspect them — recorded as an evidence gap (visual correctness not fully verified). Status: PARTIAL.

### UI / game feel / accessibility (5%) — GAME-018
Menus keyboard-operable, mute + volume + reduced-motion options, contextual HUD, debug overlay
(default OFF, F3). Verified: `playwright` render.spec (debug default OFF) + settings toggles exist.
Status: PASS.

### Build / testing / engineering (5%) — GAME-019
Monorepo with separate sim/rendering/ui/server; headless-testable rules; Playwright e2e. Verified:
`scripts/verify-all.sh`. Status: PASS.

## Known limitations (honest)
- AI difficulty for missions 2–3 is high; the greedy test-solver loses them (determinism still
  verified). Win-based evidence is on Mission 1 (tutorial), which is winnable + replayed + served.
- Post-processing is bloom only; particles/impacts are simple but present.
- No vision-based visual inspection performed this run (no image tool); visual integrity verified
  only via canvas non-blankness, object/shadow counts, console-cleanliness, and layout.
- Camera rotation/pan/zoom implemented; per-candidate AI score readout not surfaced in debug UI.

## Verification commands
- `bash scripts/verify-all.sh` — all hard gates + tests + e2e
- `npx vitest run` — 30 headless tests
- `npx playwright test` — 10 browser checks (journeys A–H + replay + render + smoke)
