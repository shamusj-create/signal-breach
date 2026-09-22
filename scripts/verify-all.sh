#!/usr/bin/env bash
# Single verification entry point for Signal Breach. Runs the hard-gate checks against CURRENT
# source and reports a PASS/FAIL summary. Used by CI and the acceptance contract.
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

note "browser journeys (playwright)"
if npx playwright test; then echo "PASS e2e"; else echo "FAIL e2e"; FAIL=1; fi

echo "======================================"
if [ "$FAIL" -eq 0 ]; then echo "ALL CHECKS PASS"; exit 0; else echo "SOME CHECKS FAILED"; exit 1; fi
