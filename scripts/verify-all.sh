#!/usr/bin/env bash
# Single verification entry point for Signal Breach. Runs the hard-gate checks against CURRENT
# source and reports a PASS/FAIL summary. Used by CI and the acceptance contract.
#
# The browser suite is split into two SEQUENTIAL lanes over the SAME full test set (a partition,
# not a subset): every Playwright test (the original suite plus the new action-clarity specs) runs
# exactly once. Nothing is skipped, removed, marked fixme, given a raised timeout or weakened
# assertion — only WHICH INVOCATION runs each test changed. Lane A runs the heavy 3D journeys at
# workers=1 so none contend; lane B runs everything else at workers=4 AFTER lane A has fully
# finished. The parallel lane was raised from 2 to 4 so the four new action-clarity specs keep the
# whole gate inside its 900 s budget (workers=6 contended and flaked the timing-sensitive visual
# specs; workers=4 measured green and ~160 s faster). The two lanes share one
# server pair (lane B reuses lane A's servers). A failure in either lane fails the gate.
set -u
cd "$(dirname "$0")/.."
FAIL=0
note() { echo "== $1 =="; }

note "typecheck (strict TS)"
if npx tsc -p tsconfig.json --noEmit; then echo "PASS typecheck"; else echo "FAIL typecheck"; FAIL=1; fi

note "production build (web)"
if npm run build -w @sb/web >/tmp/sb-build.log 2>&1; then echo "PASS build"; else echo "FAIL build"; tail -20 /tmp/sb-build.log; FAIL=1; fi

note "unit + integration tests (sim + server)"
if npx vitest run; then echo "PASS tests"; else echo "FAIL tests"; FAIL=1; fi

# ---- browser suite: two sequential lanes over a shared server pair --------------------------
note "browser journeys (playwright — 2 sequential lanes, shared server pair)"

# Clean slate: never reuse a stale server from a prior run.
pkill -f "packages/server/src/index.ts" >/dev/null 2>&1 || true
pkill -f "vite --config packages/web/vite.config.ts" >/dev/null 2>&1 || true
sleep 1

# Start ONE server pair, reused by both lanes.
npx tsx packages/server/src/index.ts >/tmp/sb-server.log 2>&1 &
SRV=$!
npx vite --config packages/web/vite.config.ts --port 5199 --host 127.0.0.1 --strictPort >/tmp/sb-vite.log 2>&1 &
VIT=$!

# Wait for both servers to answer before the first lane runs.
READY=0
for _ in $(seq 1 120); do
  sc=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/health 2>/dev/null)
  vc=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5199 2>/dev/null)
  if [ "$sc" = "200" ] && [ "$vc" = "200" ]; then READY=1; break; fi
  sleep 0.5
done
if [ "$READY" -ne 1 ]; then
  echo "FAIL server startup (8787 health / 5199 not ready)"; FAIL=1
  kill "$SRV" "$VIT" >/dev/null 2>&1 || true
fi

# LANE A — heavy 3D journeys, workers=1 (no contention). Runs first, alone.
note "browser lane A — heavy specs, workers=1"
npx playwright test --project=heavy --workers=1; A=$?
if [ "$A" -eq 0 ]; then echo "PASS e2e laneA"; else echo "FAIL e2e laneA (exit $A)"; FAIL=1; fi

# LANE B — everything else, workers=4 (parallel). Runs only after lane A has fully finished.
note "browser lane B — remaining specs, workers=4"
npx playwright test --project=rest --workers=4; B=$?
if [ "$B" -eq 0 ]; then echo "PASS e2e laneB"; else echo "FAIL e2e laneB (exit $B)"; FAIL=1; fi

kill "$SRV" "$VIT" >/dev/null 2>&1 || true

echo "======================================"
if [ "$FAIL" -eq 0 ]; then echo "ALL CHECKS PASS"; exit 0; else echo "SOME CHECKS FAILED"; exit 1; fi