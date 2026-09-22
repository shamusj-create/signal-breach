# FINAL VISUAL PASS — SIGNAL BREACH (separately authorised follow-up)

## Authorisation & accounting status
- Explicitly authorised by the user for THIS short final visual pass (2026-09-19).
- Native longrun harness: available, but installed release v1.1.2 exposes NO run-creation
  action (only maintenance ops). Native status: NO ACTIVE RUN (`identity.kind=dir`, `run:null`).
- This pass is therefore MANUALLY LEDGERED, not a native controller session. Prior benchmark
  candidate totals (original ~78/80 + 20 visual extension) were user-stated ESTIMATES;
  they are preserved as historical evidence and deliberately NOT converted into
  machine-fabricated receipts.
- Budget: max 6 measured evaluated candidates OR 1 hour wall time (incl. verification),
  whichever first. "Candidate" = distinct source revision evaluated for acceptance
  (not each screenshot/tool call).
- Started ~07:35; time tracked in ledger table below.

## Prior requirements carried forward (NOT resolved by this pass unless fresh evidence)
- browser submission → server validation → persisted leaderboard (still unverified end-to-end in UI)
- demonstrated completion of Missions 2 & 3 (unverified)
- AI candidate-score display in debug overlay (unverified)

## Pass scope (per user)
- A. Restrain over-saturated cyan/reticle accents (keep overlay states distinct).
- B. Intentional environmental depth (small cohesive procedural set; must not read as cover;
  no topology/collision/LOS/rule changes).
- C. Menu coherence (title/briefing/upgrade) using the game's own visual language; restrained.
- Regression: a REAL unit-rendering wiring check (sync→scene) in the normal verification path,
  with sabotage proof (temporarily disable sync → check fails → restored).

## Method
Headed Chromium ~1440x900 (slowMo 150), persistent window, deterministic seed 4242;
iteration loop: render → screenshot → vision inspect → top 2-3 issues → ≤3 changes → re-render.
Subjective visual scores recorded separately from functional evidence; no auto score raises.

## Ledger — evaluated candidates
| # | change (hypothesis) | evidence | verification | verdict | budget |
|---|---------------------|----------|--------------|---------|--------|
| C1 | restrained accents (perimeter cap / unit contact rings / range footprint) + perimeter depth ring + menu gradient | first render: unit windows 0/6 hits; probe revealed unitGroup never added to scene (units rendered nowhere) | render-units failed at C1 (hits=0/6) | KEPT ONLY AFTER FIX: accent restraint retained, towers moved behind camera orbit (r>=15.2), unitGroup attached to scene | used: ~0:38 |
| C2 | unitGroup scene-attachment + render-units hardened (scene-path walk + per-unit pixel presence; sabotage fixture collapses to <=1/6) | probe pixel dumps pre/post; verify-all 12/12 e2e | ALL CHECKS PASS 08:09 | KEPT | included above |

## Notes
- C1 initially REGRESSED rendering: unit contact rings + bodies existed in unitMeshes but the
  unitGroup was absent from the scene graph (mesh-only evidence was insufficient). The hardened
  render-units spec now requires scene-graph path + per-unit team-colour pixels and still fails
  when the sync call is sabotaged. This is the permanent regression guard.
- Final verification 2026-09-19 ~08:09: typecheck PASS, build PASS, vitest 30/30, playwright e2e 12/12
  (incl. render-units 2/2). Headed showcase (baseline-after + paced walkthrough, 25-min open window)
  running afterwards via playwright.showcase.config.ts.

## Screenshot pairs
- baseline (pre-C1): artifacts/before/
- after-C1 (post-fix): artifacts/after/ (b-* captures + w-* paced walkthrough states)
