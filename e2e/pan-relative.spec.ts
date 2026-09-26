// PAN criterion (c-pan-relative-e2e): right-drag pan (and the four HUD pan buttons) must be VIEW-
// RELATIVE at EVERY rotation angle, not board-relative.
//
// INDEPENDENT ORACLE (required — the old self-referential test was the bug). The previous build
// computed the pan axes from a HARDCODED board vector (World.getAzimuth -> (sin a + 0.8, cos a + 0.8))
// instead of the camera, so a right-drag could send the world up-to-24 deg off-screen-right at Q0 and
// 70/82 deg off at Q1-Q3, and a down-drag could push focus along the view direction (a near no-op).
// A test that simply asserted "pan() equals the same accessor it moves" could never see that. So here
// we do the opposite: we take FIXED WORLD POINTS (board-centre probes), project them to a PIXEL/
// screen position through the live camera BEFORE and AFTER the gesture, and assert the SCREEN motion
// direction. "Correct" is defined only by where the world actually appears to move, never by pan()/
// getAzimuth() math. A right-drag must make the world slide screen-RIGHT; a down-drag must make it
// slide screen-DOWN (the board follows the cursor). Off-axis travel beyond a tight few percent, or a
// near no-op (the real defect), FAILS — so this bar is strict enough that the measured 24/70/82 deg
// skew and the down-into-camera no-op would not pass it.
//
// We drive a REAL mouse right-drag (button 2) so the whole onMove -> world.pan path is exercised, and
// separately confirm the HUD pan button in the same screen direction produces a consistent landmark
// delta. Both the button and the drag go through the single fixed shared basis.
import { test, expect } from "@playwright/test";

type Page = import("@playwright/test").Page;

async function deploy(page: Page, seed = 4242) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 20000 });
  await page.waitForTimeout(1400);
  const dismiss = page.getByTestId("dismiss-onboarding");
  if (await dismiss.isVisible()) await dismiss.click();
  await page.waitForTimeout(250);
}

// A fixed probe point (a tile top / board-interior point) as a world coordinate. These live inside the
// board footprint and, at the default orbit distance (fov 50, radius ~19), project inside the central
// region for the whole sweep — so their screen motion is measurable and meaningful.
const PROBES: [number, number, number][] = [
  [3, 0.5, 3], [-3, 0.5, 3], [3, 0.5, -3], [-3, 0.5, -3],
  [0, 0.5, 4], [0, 0.5, -4], [4, 0.5, 0], [-4, 0.5, 0],
  [3.5, 0.5, 0], [-3.5, 0.5, 0], [0, 0.5, 3.5], [0, 0.5, -3.5],
];

interface Proj { sx: number; sy: number; ok: boolean }

// Project world points to canvas pixels using ONLY the camera's matrices (screen-space, independent of
// any product helper). Also returns the canvas rect so the caller can issue a real mouse drag.
function probeScreen(page: Page, pts: [number, number, number][]) {
  return page.evaluate((P) => {
    const w = (window as unknown as { __sbGame: { world: any } }).__sbGame.world;
    const cam = w.camera;
    // Settle the pose deterministically (reducedMotion snaps; two computeCamera passes + render so the
    // view matrix and projection matrix are current) before projecting.
    w.reducedMotion = true;
    w.computeCamera();
    w.computeCamera();
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const canvas = w.renderer.domElement;
    const CW = canvas.clientWidth || canvas.width;
    const CH = canvas.clientHeight || canvas.height;
    const rect = canvas.getBoundingClientRect();
    const mv = cam.matrixWorldInverse.elements; // column-major
    const mp = cam.projectionMatrix.elements; // column-major
    const mul = (m: number[], x: number, y: number, z: number) => {
      const x0 = m[0] * x + m[4] * y + m[8] * z + m[12];
      const y0 = m[1] * x + m[5] * y + m[9] * z + m[13];
      const z0 = m[2] * x + m[6] * y + m[10] * z + m[14];
      let w0 = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (Math.abs(w0) < 1e-9) w0 = w0 < 0 ? -1e-9 : 1e-9;
      return { x: x0 / w0, y: y0 / w0, z: z0 / w0 };
    };
    const out = P.map(([x, y, z]) => {
      const v1 = mul(mv, x, y, z);
      const c = mul(mp, v1.x, v1.y, v1.z);
      const sx = (c.x * 0.5 + 0.5) * CW;
      const sy = (-c.y * 0.5 + 0.5) * CH;
      const onScreen = Math.abs(c.x) <= 0.9 && Math.abs(c.y) <= 0.9 && c.z < 1;
      const central = Math.abs(c.x) <= 0.55 && Math.abs(c.y) <= 0.55;
      return { sx, sy, ok: onScreen && central } as Proj;
    });
    return { pts: out, rect: { left: rect.left, top: rect.top, w: rect.width, h: rect.height }, CW, CH };
  }, pts);
}

async function setPose(page: Page, angleQuarters: number) {
  await page.evaluate((q) => {
    const w = (window as unknown as { __sbGame: { world: any } }).__sbGame.world;
    w.setAngle(q);
    w.focus.set(0, 0, 0);
  }, angleQuarters);
}

// Issue a real right-button drag on the canvas starting at (ax,ay) with a delta of (dx,dy) in canvas
// pixels, in several steps so several pointermove events fire.
async function dragRightButton(page: Page, ax: number, ay: number, dx: number, dy: number) {
  const steps = 6;
  await page.mouse.move(ax, ay);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(ax + (dx * i) / steps, ay + (dy * i) / steps, { steps: 2 });
    await page.waitForTimeout(24);
  }
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(120);
}

// How far did each on-screen central probe move on screen, BEFORE -> AFTER the gesture?
async function measureLandmarks(page: Page, before: Proj[]) {
  const after = await probeScreen(page, PROBES);
  return after.pts
    .map((p, i) => ({ before: before[i], after: p }))
    .filter((d) => d.before.ok && d.after.ok)
    .map((d) => ({ dx: d.after.sx - d.before.sx, dy: d.after.sy - d.before.sy }));
}

const ANGLES = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]; // a full 360, INCLUDING the four integer quarters.

test("PAN — right-drag slides the world screen-RIGHT at every orbit angle (not off-axis)", async ({ page }) => {
  await deploy(page);
  for (const q of ANGLES) {
    await setPose(page, q);
    const before = await probeScreen(page, PROBES);
    const rect = before.rect;
    // Right-drag centred in the canvas, 150 px to the +x (screen right).
    await dragRightButton(page, rect.left + rect.w / 2 - 75, rect.top + rect.h / 2, 150, 0);
    const moves = await measureLandmarks(page, before.pts);
    expect(moves.length, `Q${q}: need >=4 central on-screen probes to measure (got ${moves.length})`).toBeGreaterThanOrEqual(4);
    // Dominant motion must be screen-right. Aggregate the mean screen delta and bound the cross-axis.
    let sx = 0, sy = 0;
    for (const m of moves) { sx += m.dx; sy += m.dy; }
    sx /= moves.length; sy /= moves.length;
    const perp = Math.hypot(sx, sy);
    expect(sx, `Q${q}: right-drag must move the world screen-RIGHT (mean dx=${sx.toFixed(1)}px)`).toBeGreaterThanOrEqual(8);
    // Cross-axis (screen up/down) must be a tiny fraction of the dominant axis -> not off-axis. The
    // bound (0.15*hypot ~= 8.6 deg) is deliberately tighter than the 24/70/82 deg skew it must reject.
    expect(Math.abs(sy), `Q${q}: right-drag off-axis screen-Y drift=${sy.toFixed(1)}px vs dx=${sx.toFixed(1)}px`).toBeLessThanOrEqual(0.15 * perp);
  }
});

test("PAN — down-drag slides the world screen-DOWN (not into the camera / not off-axis)", async ({ page }) => {
  await deploy(page);
  for (const q of ANGLES) {
    await setPose(page, q);
    const before = await probeScreen(page, PROBES);
    const rect = before.rect;
    // Down-drag centred in the canvas, 150 px downward (+y on screen).
    await dragRightButton(page, rect.left + rect.w / 2, rect.top + rect.h / 2 - 75, 0, 150);
    const moves = await measureLandmarks(page, before.pts);
    expect(moves.length, `Q${q}: need >=4 central on-screen probes to measure (got ${moves.length})`).toBeGreaterThanOrEqual(4);
    let sx = 0, sy = 0;
    for (const m of moves) { sx += m.dx; sy += m.dy; }
    sx /= moves.length; sy /= moves.length;
    const perp = Math.hypot(sx, sy);
    // The real defect: down-drag pushed focus into the camera => near no-op. Require real downward move.
    expect(sy, `Q${q}: down-drag must move the world screen-DOWN (mean dy=${sy.toFixed(1)}px; the old bug was ~0)`).toBeGreaterThanOrEqual(8);
    expect(Math.abs(sx), `Q${q}: down-drag off-axis screen-X drift=${sx.toFixed(1)}px vs dy=${sy.toFixed(1)}px`).toBeLessThanOrEqual(0.15 * perp);
  }
});

test("PAN — the HUD pan button in a screen direction matches a drag in that direction", async ({ page }) => {
  await deploy(page);
  // Compare the button vs drag landmark delta at a few angles; both must move the world the SAME way.
  for (const q of [0, 1, 2, 3]) {
    // Drag-right baseline.
    await setPose(page, q);
    const beforeD = await probeScreen(page, PROBES);
    const rect = beforeD.rect;
    await dragRightButton(page, rect.left + rect.w / 2 - 75, rect.top + rect.h / 2, 150, 0);
    const dragMoves = await measureLandmarks(page, beforeD.pts);
    const dragSx = dragMoves.reduce((a, m) => a + m.dx, 0) / dragMoves.length;

    // Button baseline (pan-right button).
    await setPose(page, q);
    const beforeB = await probeScreen(page, PROBES);
    await page.getByTestId("pan-right").click();
    await page.waitForTimeout(160);
    await page.evaluate(() => {
      const w = (window as unknown as { __sbGame: { world: any } }).__sbGame.world;
      w.computeCamera();
      w.camera.updateMatrixWorld(true);
    });
    const btnMoves = await measureLandmarks(page, beforeB.pts);
    const btnSx = btnMoves.reduce((a, m) => a + m.dx, 0) / btnMoves.length;

    // Same sign, and the button must not be a no-op: both push the world screen-right at this angle.
    expect(dragSx, `Q${q}: drag moves world screen-right`).toBeGreaterThanOrEqual(4);
    expect(btnSx, `Q${q}: pan-right button must match the drag (same screen-right sign; got ${btnSx.toFixed(1)} vs ${dragSx.toFixed(1)})`).toBeGreaterThanOrEqual(Math.min(dragSx * 0.4, 4));
  }
});