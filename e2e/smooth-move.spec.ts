// SMOOTH MOVE evidence (BROWSER). Movement used to SNAP tile-to-tile. This proves the rendered
// unit now travels through intermediate positions (a display tween), makes monotone progress toward
// the destination, and lands EXACTLY on the destination tile — and that the existing reduced-motion
// preference makes movement instant (no tween). All evidence is read back from the unit's live
// rendered position, not a hue band: the environment cannot satisfy "intermediate positions between
// the source and destination tiles, then an exact landing on the destination tile."
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  // let any deploy-time particles/tweens settle before we start sampling
  await page.waitForTimeout(1200);
}

interface SampleResult {
  ok: boolean;
  reason?: string;
  distSD?: number;
  first?: number;
  snapDist?: number;
  final?: number;
  samples: number[];
  tween: boolean;
}

test("SMOOTH — a player move tweens through intermediate positions and lands exactly on the destination", async ({ page }) => {
  await deploy(page, 4242);
  const res = await page.evaluate<SampleResult, void>(() => {
    return new Promise<SampleResult>((resolve) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      let chosen: { id: string; from: { x: number; y: number; h: number }; path: { x: number; y: number; h: number }[] } | null = null;
      for (const u of g.debugState().units) {
        if (!u.alive || u.side !== "player") continue;
        const fp = g.debugFarthestPath(u.id);
        if (fp.ok && (fp.path?.length ?? 0) >= 3) {
          chosen = { id: u.id, from: fp.from, path: fp.path };
          break;
        }
      }
      if (!chosen) {
        resolve({ ok: false, reason: "no multi-step player move found", samples: [], tween: false });
        return;
      }
      const id = chosen.id;
      const fromWorld = w.tileToWorld(chosen.from);
      // DISPLAY-ONLY: stretch the render tween (duration only; never touches authoritative state and
      // reduced motion still snaps) so even a loaded machine yields many sampled frames across it.
      w.tweenScale = 6;
      g.debugMove(id, chosen.path); // through act() -> starts the display tween
      const dest = g.debugState().units.find((x: { id: string }) => x.id === id);
      const destWorld = w.tileToWorld(dest.pos);
      const distSD = Math.hypot(destWorld.x - fromWorld.x, destWorld.z - fromWorld.z);
      const dOf = () => {
        const p = w.unitMeshes.get(id).position;
        return Math.hypot(p.x - destWorld.x, p.z - destWorld.z);
      };
      // sampled synchronously, before any render frame has advanced the tween: must still be near
      // the SOURCE (a snap would already be at the destination).
      const first = dOf();
      const samples: number[] = [];
      const t0 = performance.now();
      const step = () => {
        const tweening = w.moveTweening();
        const d = dOf();
        if (samples.length < 4000) samples.push(+d.toFixed(4));
        const elapsed = performance.now() - t0;
        // Widened sampling window that ends on the DISPLAY TWEEN actually finishing (no unit tweening
        // any more), not on a distance threshold. A threshold could catch the tail where the rendered
        // position is already at the tile while the render loop has not yet torn the tween down, which
        // raced under full-suite load (the exact-landing + no-tween claims). Ending on tween-settled
        // reads the fully-settled position instead. The stretched display tween keeps the descent
        // spread across many frames so a sparse cadence cannot starve the intermediate/monotone checks,
        // and there is no bare frame-count exit. Proven: not-a-snap, monotone, exact landing, settled.
        if (!tweening || elapsed > 20000) {
          resolve({ ok: true, distSD, first, final: d, samples, tween: tweening });
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  });

  expect(res.ok, (res as { reason?: string }).reason).toBe(true);
  expect(res.distSD, "the chosen move must span multiple tiles").toBeGreaterThan(1.0);
  expect(res.first, "first sample is still at the source (movement is not a snap)").toBeGreaterThan((res.distSD ?? 0) * 0.7);
  expect(res.samples.length, `sampled ${res.samples.length} frames`).toBeGreaterThanOrEqual(6);
  const intermediates = res.samples.filter((d) => d < (res.distSD ?? 0) * 0.95 && d > (res.distSD ?? 0) * 0.05);
  expect(intermediates.length, `intermediate positions sampled = ${intermediates.length}`).toBeGreaterThanOrEqual(4);
  let backSteps = 0;
  for (let i = 1; i < res.samples.length; i++) {
    if (res.samples[i] > res.samples[i - 1] + 0.02) backSteps++;
  }
  expect(backSteps, "distance to the destination must never increase (monotone progress)").toBe(0);
  expect(res.final, "the unit finishes exactly on the destination tile").toBeLessThan(1e-3);
  expect(res.tween, "the tween is finished (settled)").toBe(false);
});

test("SMOOTH — reduced motion makes the same move instant (no intermediate positions, no tween)", async ({ page }) => {
  await deploy(page, 4242);
  await page.evaluate(() => {
    (window as unknown as { __sbGame: any }).__sbGame.world.reducedMotion = true;
  });
  const res = await page.evaluate<SampleResult, void>(() => {
    return new Promise<SampleResult>((resolve) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      let chosen: { id: string; from: { x: number; y: number; h: number }; path: { x: number; y: number; h: number }[] } | null = null;
      for (const u of g.debugState().units) {
        if (!u.alive || u.side !== "player") continue;
        const fp = g.debugFarthestPath(u.id);
        if (fp.ok && (fp.path?.length ?? 0) >= 3) {
          chosen = { id: u.id, from: fp.from, path: fp.path };
          break;
        }
      }
      if (!chosen) {
        resolve({ ok: false, reason: "no multi-step player move found", samples: [], tween: false });
        return;
      }
      const id = chosen.id;
      const fromWorld = w.tileToWorld(chosen.from);
      g.debugMove(id, chosen.path);
      const dest = g.debugState().units.find((x: { id: string }) => x.id === id);
      const destWorld = w.tileToWorld(dest.pos);
      const distSD = Math.hypot(destWorld.x - fromWorld.x, destWorld.z - fromWorld.z);
      const dOf = () => {
        const p = w.unitMeshes.get(id).position;
        return Math.hypot(p.x - destWorld.x, p.z - destWorld.z);
      };
      const snapDist = dOf(); // synchronous, before any frame: reduced motion must already be at the tile
      const samples: number[] = [];
      let frames = 0;
      const step = () => {
        frames++;
        samples.push(+dOf().toFixed(4));
        if (frames >= 5) {
          resolve({ ok: true, distSD, snapDist, samples, tween: w.moveTweening() });
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  });

  expect(res.ok, (res as { reason?: string }).reason).toBe(true);
  expect(res.distSD, "the chosen move must span multiple tiles").toBeGreaterThan(1.0);
  expect(res.snapDist, "reduced motion snaps to the destination immediately").toBeLessThan(1e-3);
  const intermediates = res.samples.filter((d) => d > 1e-3);
  expect(intermediates.length, "no intermediate positions under reduced motion").toBe(0);
  expect(res.tween, "no tween exists under reduced motion").toBe(false);
});