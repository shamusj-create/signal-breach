// FLIGHT-PATH evidence (VISION, c-flight-path-e2e).
//
// A ranged shot is presented as a TRAVELLING projectile that arcs from the shooter to the target and
// resolves with an impact beat — not an instant straight tracer. The honesty bar: we sample the
// projectile's live SCREEN position across successive frames with the camera LOCKED (identical pose for
// every sample), and prove it (a) starts at the shooter, (b) passes through several DISTINCT
// intermediate screen positions, (c) ends at the target, and (d) lands an impact when it resolves. A
// teleport (or a camera that drifts) cannot satisfy "several distinct positions BETWEEN two endpoints
// whose start/end match the geometry." The flight is presentation-only: the authoritative state /
// revision is UNCHANGED by it, so this also proves the effect does not feed rules. Reduced motion must
// resolve instantly with NO travel animation.
//
// Positions are read from the presentation oracle surface (window.__sbProjectiles / world.debugFx) and
// projected through the live camera — never from a hue band or an "effect happened" boolean.
import { test, expect } from "@playwright/test";

type Page = import("@playwright/test").Page;

async function deploy(page: Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  const dismiss = page.getByTestId("dismiss-onboarding");
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});
  await page.waitForTimeout(1600);
}

interface Trace {
  startScreen: { sx: number; sy: number };
  endScreen: { sx: number; sy: number };
  reducedMotion: boolean;
  samples: { sx: number; sy: number; f: number; impactFired: boolean }[];
  impactAtTarget: boolean;
  revisionBefore: number;
  revisionAfter: number;
  hashBefore: string;
  hashAfter: string;
}

// One locked-camera trace: lock the pose, stretch the (display-only) flight duration, fire a real
// line through the shot pipeline, and sample the projectile's screen position every frame until it
// resolves. The whole trace runs inside the page across real animation frames.
function sampleTrace(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, reducedMotion: boolean, flightScale: number) {
  return page.evaluate(
    ([from, to, reducedMotion, flightScale]) => {
      return new Promise<Trace>((resolve) => {
        const g = (window as unknown as { __sbGame: any }).__sbGame;
        const w = g.world;
        const T = (window as unknown as { __sbThree: any }).__sbThree;
        // Camera LOCK: a fixed overhead pose for the whole trace, so any screen movement is the
        // projectile, not the camera.
        w.reducedMotion = reducedMotion;
        w.flightScale = flightScale;
        w.camPoseOverride = { px: 0, py: 20, pz: 0.001, tx: 0, ty: 0, tz: 0 };
        w.clearProjectiles();
        w.clearEffects();
        w.shake = 0;
        w.computeCamera();
        w.camera.updateMatrixWorld(true);
        const canvas = w.renderer.domElement as HTMLCanvasElement;
        const CW = canvas.clientWidth || canvas.width;
        const CH = canvas.clientHeight || canvas.height;
        const project = (x: number, y: number, z: number) => {
          const p = new T.Vector3(x, y, z);
          p.project(w.camera);
          return { sx: (p.x * 0.5 + 0.5) * CW, sy: (-p.y * 0.5 + 0.5) * CH };
        };
        // The launch + impact world points the flight is BUILT from (geometry, not the animation).
        const wa = w.tileToWorld({ x: from.x, y: from.y, h: 0 }); wa.y += 0.55;
        const wb = w.tileToWorld({ x: to.x, y: to.y, h: 0 }); wb.y += 0.5;
        const startScreen = project(wa.x, wa.y, wa.z);
        const endScreen = project(wb.x, wb.y, wb.z);
        const revBefore = g.debugState().revision;
        const hashBefore = (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(g.debugState());

        // Fire a real shot through the identical event->flight pipeline combat uses.
        g.debugShotLine(from, to);

        const samples: { sx: number; sy: number; f: number; impactFired: boolean }[] = [];
        let impactAtTarget = false;
        let frames = 0;
        let lastF = 0;
        const t0 = performance.now();
        let sawProjectile = false;
        let resolved = false;
        // Presentation-only: the DISPLAY duration is stretched by flightScale (the same hook as
        // tweenScale for smooth-move) so ONE projectile spans far more animation frames than the sampler
        // needs, giving many distinct intermediate positions even at a sparse render cadence. It changes
        // NO authoritative state. Termination is driven by the flight ACTUALLY resolving — the impact
        // caught at the target plus a few settle frames — NOT a fixed wall-clock window: under full-suite
        // (workers=2) contention the rAF cadence drops, and the old fixed 4s window closed before a shot
        // resolved (impactAtTarget stayed false) — the same load-sensitivity as smooth-move/orbit. The
        // wall/frame caps below are only a runaway backstop, never a threshold or frame-count-only exit.
        // reducedMotion creates no travelling projectile (instant resolve) so it exits once the immediate
        // impact is seen; the reduced-motion bar (no travel animation) is unchanged.
        const SETTLE = 6;
        const WALL = 20000;
        const FRAMES = 800;
        let settle = 0;
        const step = () => {
          frames++;
          const elapsed = performance.now() - t0;
          // Watch for the impact beat landing on the target tile on EVERY frame.
          const fx = g.world.debugFx();
          const sawImpact = fx.some((e: any) => e.kind === "impact" && e.at && Math.abs(e.at[0] - to.x) <= 1 && Math.abs(e.at[1] - to.y) <= 1);
          if (sawImpact) impactAtTarget = true;
          const projs = g.debugProjectiles();
          const flight = projs.find((p: any) => p.kind === "flight");
          if (flight) {
            sawProjectile = true;
            lastF = Math.max(lastF, flight.f);
            const s = project(flight.x, flight.y, flight.z);
            samples.push({ sx: +s.sx.toFixed(2), sy: +s.sy.toFixed(2), f: flight.f, impactFired: flight.impactFired });
          } else if (sawProjectile) {
            resolved = true;
          }
          const settled = reducedMotion ? sawImpact : resolved && impactAtTarget;
          if (settled) settle++;
          if (settled && settle > SETTLE) {
            resolve({
              startScreen, endScreen, reducedMotion, samples,
              impactAtTarget,
              revisionBefore: revBefore,
              revisionAfter: g.debugState().revision,
              hashBefore,
              hashAfter: (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(g.debugState()),
            });
            return;
          }
          if (elapsed > WALL || frames >= FRAMES) {
            resolve({
              startScreen, endScreen, reducedMotion, samples,
              impactAtTarget,
              revisionBefore: revBefore,
              revisionAfter: g.debugState().revision,
              hashBefore,
              hashAfter: (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(g.debugState()),
            });
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
    [from, to, reducedMotion, flightScale] as const,
  ) as Promise<Trace>;
}

const dist = (a: { sx: number; sy: number }, b: { sx: number; sy: number }) => Math.hypot(a.sx - b.sx, a.sy - b.sy);

test("FLIGHT — a shot travels through distinct screen positions (not a teleport), start at shooter, end at target, impact on resolve", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  // A cross-board shot so there are many intermediate positions.
  const from = { x: 2, y: 12 }; // the vanguard's tile (shooter / "user")
  const to = { x: 11, y: 4 };   // far enemy side ("target")
  const trace = await sampleTrace(page, from, to, false, 6);
  const distinct = new Set(trace.samples.map((s) => `${s.sx}|${s.sy}`));
  console.log(`[FLIGHT] samples=${trace.samples.length} distinctPositions=${distinct.size}`);
  console.log(`[FLIGHT] start=(${trace.startScreen.sx.toFixed(1)},${trace.startScreen.sy.toFixed(1)}) end=(${trace.endScreen.sx.toFixed(1)},${trace.endScreen.sy.toFixed(1)}) impactAtTarget=${trace.impactAtTarget}`);
  console.log(`[FLIGHT] positions=${JSON.stringify(trace.samples.map((s) => [s.sx, s.sy, +s.f.toFixed(2)]))}`);

  expect(trace.samples.length, `the projectile was sampled across frames (${trace.samples.length})`).toBeGreaterThanOrEqual(6);

  const span = dist(trace.startScreen, trace.endScreen);
  expect(span, "the shot spans a large on-screen distance (so 'intermediate' is meaningful)").toBeGreaterThan(60);

  // It covers the SHOOTER and the TARGET (a straight jump between two points has no intermediates).
  const toStart = Math.min(...trace.samples.map((s) => dist(s, trace.startScreen)));
  const toEnd = Math.min(...trace.samples.map((s) => dist(s, trace.endScreen)));
  expect(toStart, `a sampled position starts near the shooter (closest ${toStart.toFixed(1)}px, span ${span.toFixed(1)})`).toBeLessThan(span * 0.2);
  expect(toEnd, `a sampled position ends near the target (closest ${toEnd.toFixed(1)}px, span ${span.toFixed(1)})`).toBeLessThan(span * 0.2);

  // (a) It TRAVELS: several DISTINCT positions strictly BETWEEN the shooter and the target. A teleport
  // (or a two-point jump) cannot produce four distinct intermediate screen positions.
  const intermediate = new Set(
    trace.samples
      .map((s) => ({ s, dStart: dist(s, trace.startScreen), dEnd: dist(s, trace.endScreen) }))
      .filter((x) => x.dStart > span * 0.1 && x.dEnd > span * 0.1)
      .map((x) => `${x.s.sx}|${x.s.sy}`),
  );
  expect(intermediate.size, `distinct intermediate screen positions = ${intermediate.size}`).toBeGreaterThanOrEqual(4);

  // (d) the impact beat fires when it resolves.
  expect(trace.impactAtTarget, "the impact beat fired at the target when the flight resolved").toBe(true);

  // Presentation-only: authoritative revision + state hash unchanged by the flight animation.
  expect(trace.revisionAfter, "the flight did NOT change the authoritative revision").toBe(trace.revisionBefore);
  expect(trace.hashAfter, "the flight did NOT change the authoritative state hash (presentation-only)").toBe(trace.hashBefore);

  // Camera-locked evidence frame for the operator.
  await page.locator("canvas").screenshot({ path: "test-results/flight-idle.png" });
});

test("FLIGHT — reduced motion resolves instantly with NO travel animation", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  const from = { x: 2, y: 12 };
  const to = { x: 11, y: 4 };
  const trace = await sampleTrace(page, from, to, true, 6);
  console.log(`[FLIGHT reduced] samples=${trace.samples.length} impactAtTarget=${trace.impactAtTarget}`);
  // No travelling projectile is created (no animation), and the beat resolves immediately at the target.
  expect(trace.samples.length, "reduced motion creates no travelling projectile (no travel animation)").toBe(0);
  expect(trace.impactAtTarget, "reduced motion still lands the impact instantly at the target").toBe(true);
  // Still presentation-only.
  expect(trace.revisionAfter, "reduced-motion flight did not change revision").toBe(trace.revisionBefore);
  expect(trace.hashAfter, "reduced-motion flight did not change state").toBe(trace.hashBefore);
});