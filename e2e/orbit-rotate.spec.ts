// ORBIT criterion (c-orbit-grab-e2e, BROWSER, INDEPENDENT oracle). Proves a LEFT-drag over the board
// does GRAB-TO-ROTATE: it spins the board about the pivot at the SCREEN CENTRE (the projected look-at
// point) so the point you grabbed FOLLOWS the cursor, tracking the pointer's ANGLE about that pivot.
//
// Why the oracle is a DIRECTION oracle, not a magnitude/continuity one. The old build rotated by the
// drag's HORIZONTAL delta only, and it did so the OPPOSITE way round: grab a point and pull it one way
// and the board spun the other, and a vertical drag was a no-op (dx~0). A test that only asked "did the
// angle change / did the subject move >=8px" could not tell follow from oppose, nor exercise the vertical
// axis, so it certified the WRONG way round. So here every capture projects FIXED WORLD LANDMARKS through
// the live camera to a screen PIXEL position before/after, and we compare the grabbed point's SIGNED
// angular change about the pivot to the pointer's: they must share a SIGN and be close in MAGNITUDE
// (that is what "follows the cursor" means). Direction is defined only by where the world actually
// appears, never by reading an internal angle as truth.
//
// Exercised: (1) a right-side grab and a left-side grab each FOLLOW the cursor (per-side, direction);
// (2) a predominantly-VERTICAL drag off the pin rotates (the vertical component is not dropped); (3) a
// straight pass THROUGH the pin is a near no-op (a radial drag is not a real orbit) — the inversion of the
// old horizontal-drag assertion; (4) a big continuous arc keeps the subject moving through many poses and
// STAYS where you left it; (5) a drag over a piece still rotates and still does NOT fire the pick, and a
// non-drag click still picks.
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

interface Proj { sx: number; sy: number; ok: boolean }

// Project world points to canvas PIXELS (independent of any product helper), settle the camera at the
// CURRENT pose so the sample is the real pose, and report the canvas rect in page coords. `ok` = the
// probe is on-screen and inside the central 55% region (so we only measure SUBJECT that can move).
function probeLandmarks(page: Page, pts: [number, number, number][]) {
  return page.evaluate((P) => {
    const w = (window as unknown as { __sbGame: { world: any } }).__sbGame.world;
    const cam = w.camera;
    w.reducedMotion = true;
    w.computeCamera();
    w.computeCamera();
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const canvas = w.renderer.domElement;
    const CW = canvas.clientWidth || canvas.width;
    const CH = canvas.clientHeight || canvas.height;
    const rect = canvas.getBoundingClientRect();
    const mv = cam.matrixWorldInverse.elements;
    const mp = cam.projectionMatrix.elements;
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
      return { sx: (c.x * 0.5 + 0.5) * CW, sy: (-c.y * 0.5 + 0.5) * CH, ok: Math.abs(c.x) <= 0.55 && Math.abs(c.y) <= 0.55 && c.z < 1 } as Proj;
    });
    return { pts: out, rect: { left: rect.left, top: rect.top, w: rect.width, h: rect.height } };
  }, pts);
}

async function resetPose(page: Page) {
  await page.evaluate(() => {
    const w = (window as unknown as { __sbGame: { world: any } }).__sbGame.world;
    w.reducedMotion = true;
    w.setAngle(0);
    w.zoom = 1;
    w.focus.set(0, 0, 0);
    w.computeCamera();
    w.camera.updateMatrixWorld(true);
  });
}

const readAngle = (page: Page) => page.evaluate(() => (window as unknown as { __sbGame: { world: any } }).__sbGame.world.angleQuarters);

// Signed angle (deg) of a screen point about the canvas pivot (its centre), using screen coords (y down).
const angAboutPivot = (p: { x: number; y: number }, cx: number, cy: number) => (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;

// Drive a left-drag along a circle of radius R about the canvas pivot, sweeping the pointer's angle by
// `sweep` degrees (positive = CCW on screen). N sub-moves keep it continuous.
async function arcDrag(page: Page, cx: number, cy: number, R: number, a0: number, sweep: number, N: number) {
  const pt = (a: number) => ({ x: cx + R * Math.cos((a * Math.PI) / 180), y: cy + R * Math.sin((a * Math.PI) / 180) });
  const p0 = pt(a0);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  for (let i = 1; i <= N; i++) {
    const p = pt(a0 + (sweep * i) / N);
    await page.mouse.move(p.x, p.y, { steps: 2 });
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(140);
}

test("GRAB-TO-ROTATE — the grabbed point follows the cursor on BOTH sides of the pivot (DIRECTION)", async ({ page }) => {
  await deploy(page);

  // Each grab: a fixed world landmark, a cursor that sweeps its angle about the pivot, and the measured
  // subject angular change. Right side sweeps 3->6 o'clock (pointer +90), left side sweeps 9->12 (also
  // +90). On a correct follow the subject's signed angle change has the SAME sign as the pointer's.
  const cases: { name: string; subject: [number, number, number]; a0: number; sweep: number }[] = [
    { name: "right-of-pivot (3->6 o'clock)", subject: [5, 0.7, 0], a0: 0, sweep: 90 },
    { name: "left-of-pivot (9->12 o'clock)", subject: [-5, 0.7, 0], a0: 180, sweep: 90 },
  ];
  for (const c of cases) {
    await resetPose(page);
    const start = await probeLandmarks(page, [c.subject]);
    const rect = start.rect;
    const cx = rect.left + rect.w / 2;
    const cy = rect.top + rect.h / 2;
    const R = Math.min(rect.w, rect.h) * 0.42;
    const pStart = { x: cx + R * Math.cos((c.a0 * Math.PI) / 180), y: cy + R * Math.sin((c.a0 * Math.PI) / 180) };
    const pEnd = { x: cx + R * Math.cos(((c.a0 + c.sweep) * Math.PI) / 180), y: cy + R * Math.sin(((c.a0 + c.sweep) * Math.PI) / 180) };
    const cursorD = c.sweep;
    const subjStart = await probeLandmarks(page, [c.subject]);
    const subjectStart = subjStart.pts[0];
    expect(subjectStart.ok, `${c.name}: subject visible at start to be measurable`).toBe(true);
    await arcDrag(page, cx, cy, R, c.a0, c.sweep, 26);
    const subjectEnd = (await probeLandmarks(page, [c.subject])).pts[0];
    expect(subjectEnd.ok, `${c.name}: subject visible at end to be measurable`).toBe(true);

    const ptD = angAboutPivot({ x: subjectEnd.sx, y: subjectEnd.sy }, rect.w / 2, rect.h / 2) - angAboutPivot({ x: subjectStart.sx, y: subjectStart.sy }, rect.w / 2, rect.h / 2);
    // Normalize into (-180,180].
    let pt = ptD; if (pt > 180) pt -= 360; if (pt < -180) pt += 360;
    const moved = Math.hypot(subjectEnd.sx - subjectStart.sx, subjectEnd.sy - subjectStart.sy);
    const ratio = Math.abs(pt) / Math.abs(cursorD);
    // DIRECTION: same sign, and close in magnitude. A wrong-way (opposing) spin has the opposite sign; a
    // dropped-axis / no-op has near-zero motion or ratio.
    expect(Math.sign(pt), `${c.name}: subject angle change must have the SAME SIGN as the pointer (${cursorD} deg) — follow not oppose (got ${pt.toFixed(1)})`).toBe(Math.sign(cursorD));
    expect(moved, `${c.name}: subject moved a real distance on screen (got ${moved.toFixed(1)}px)`).toBeGreaterThanOrEqual(12);
    expect(ratio, `${c.name}: subject angular change close in magnitude to pointer (ratio ${ratio.toFixed(2)}, want 0.5..1.9)`).toBeGreaterThanOrEqual(0.5);
    expect(ratio, `${c.name}: subject angular change not over-spun (ratio ${ratio.toFixed(2)}, want <=1.9)`).toBeLessThanOrEqual(1.9);
  }
});

test("GRAB-TO-ROTATE — vertical drag off the pin rotates; a straight pass THROUGH the pin is a no-op", async ({ page }) => {
  await deploy(page);

  // (A) A predominantly-VERTICAL drag ON THE SIDE of the pin changes the pointer's angle about the pivot,
  // so it must rotate the board. The old horizontal-only orbit saw dx~0 here and did NOTHING, so this
  // case proves the vertical component is not dropped (both axes are live).
  await resetPose(page);
  const start = await probeLandmarks(page, [[0, 0.7, 5]]);
  const rect = start.rect;
  const cx = rect.left + rect.w / 2;
  const cy = rect.top + rect.h / 2;
  const xOff = rect.w * 0.30; // keep off the pin so the drag is angular, not radial-through-the-pivot
  const azA0 = await readAngle(page);
  await page.mouse.move(cx + xOff, cy - rect.h * 0.26);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(cx + xOff, cy - rect.h * 0.26 + (rect.h * 0.52 * i) / 16, { steps: 2 });
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(220);
  const azA1 = await readAngle(page);
  expect(Math.abs(azA1 - azA0), `a vertical drag off the pin must rotate the board (az ${Number(azA0).toFixed(2)} -> ${Number(azA1).toFixed(2)})`).toBeGreaterThanOrEqual(0.15);

  // (B) A straight pass THROUGH the pin (horizontal along the vertical midline, crossing the pivot) barely
  // changes the pointer's angle about the pivot, so it is a RADIAL drag and NOT a real orbit. The board
  // must stay ~put. This is the inversion of the old horizontal-drag test, which mistook a pass through
  // the pivot for an orbit.
  await resetPose(page);
  const azB0 = await readAngle(page);
  await page.mouse.move(cx + 250, cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(cx + 250 - (500 * i) / 20, cy, { steps: 2 });
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(220);
  const azB1 = await readAngle(page);
  expect(Math.abs(azB1 - azB0), `a straight pass THROUGH the pin is a radial no-op, not an orbit (az ${Number(azB0).toFixed(2)} -> ${Number(azB1).toFixed(2)})`).toBeLessThan(0.15);
});

test("GRAB-TO-ROTATE — a big arc is continuous and the board STAYS where you left it", async ({ page }) => {
  await deploy(page);
  await resetPose(page);
  const start = await probeLandmarks(page, [[5, 0.7, 0], [-5, 0.7, 0], [0, 0.7, 5], [0, 0.7, -5]]);
  const rect = start.rect;
  const cx = rect.left + rect.w / 2;
  const cy = rect.top + rect.h / 2;
  const R = Math.min(rect.w, rect.h) * 0.42;

  // One long left-drag along a big circle about the pivot, sampled per pointermove: a continuous orbit
  // passes through many intermediate poses (a snap would show only two).
  const N = 40;
  const sweep = 300; // a large arc around the pivot
  await page.mouse.move(cx + R, cy);
  await page.mouse.down();
  const samples: number[] = [];
  for (let i = 1; i <= N; i++) {
    const a = (sweep * i) / N;
    await page.mouse.move(cx + R * Math.cos((a * Math.PI) / 180), cy + R * Math.sin((a * Math.PI) / 180), { steps: 2 });
    await page.waitForTimeout(16);
    samples.push(await readAngle(page));
  }
  await page.mouse.up();
  await page.waitForTimeout(140);

  const end = await probeLandmarks(page, [[5, 0.7, 0], [-5, 0.7, 0], [0, 0.7, 5], [0, 0.7, -5]]);
  const central = end.pts.filter((p) => p.ok).length;
  expect(central, `need >=3 central landmarks (got ${central})`).toBeGreaterThanOrEqual(3);
  let mm = 0, n = 0;
  for (let i = 0; i < 4; i++) { if (end.pts[i].ok && start.pts[i].ok) { mm += Math.hypot(end.pts[i].sx - start.pts[i].sx, end.pts[i].sy - start.pts[i].sy); n++; } }
  expect(mm / n, "the big arc MOVED the board on screen").toBeGreaterThanOrEqual(8);

  const distinct = new Set(samples.map((a) => a.toFixed(3)));
  const betweenQuarters = samples.filter((a) => { const f = Math.abs(a % 0.25); return f > 0.03 && Math.abs(f - 0.25) > 0.03; });
  expect(distinct.size, `continuous: >=8 distinct poses (got ${distinct.size})`).toBeGreaterThanOrEqual(8);
  expect(betweenQuarters.length, `continuous: >=2 non-quarter poses (got ${betweenQuarters.length})`).toBeGreaterThanOrEqual(2);
  const span = Math.max(...samples) - Math.min(...samples);
  expect(span, `big arc travelled the circle (span ${span.toFixed(2)} quarters)`).toBeGreaterThanOrEqual(1.5);

  // STAYS: after release the board does not snap back.
  const endA = await readAngle(page);
  await page.waitForTimeout(260);
  const endA2 = await readAngle(page);
  expect(Math.abs(endA2 - endA), "the board STAYS at the end (no return-to-start snap)").toBeLessThan(0.02);
});

test("GRAB-TO-ROTATE — a drag over a piece rotates and does NOT fire the pick; a non-drag click still picks", async ({ page }) => {
  let P: { id: string; x: number; y: number } | null = null;
  let E: { x: number; y: number } | null = null;
  for (const seed of [4242, 9, 7, 4243, 21]) {
    await deploy(page, seed);
    await resetPose(page);
    const found = await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      const canvas = w.renderer.domElement as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const state = g.debugState();
      const unitAt = (x: number, y: number) => state.units.find((u: any) => u.alive && u.pos.x === x && u.pos.y === y);
      let p: { id: string; x: number; y: number } | null = null;
      let e: { x: number; y: number } | null = null;
      const step = 12;
      const x0 = rect.left + rect.width * 0.18;
      const x1 = rect.left + rect.width * 0.82;
      const y0 = rect.top + rect.height * 0.2;
      const y1 = rect.top + rect.height * 0.8;
      for (let py = y0; py <= y1 && (!p || !e); py += step) {
        for (let px = x0; px <= x1 && (!p || !e); px += step) {
          const top = document.elementFromPoint(px, py);
          if (!top || top.tagName !== "CANVAS") continue;
          const hit = w.pickAt(px, py);
          if (!hit) continue;
          const u = unitAt(hit.x, hit.y);
          if (!u) { if (!e) e = { x: +px.toFixed(1), y: +py.toFixed(1) }; }
          else if (u.side === "player" && !p) { p = { id: u.id, x: +px.toFixed(1), y: +py.toFixed(1) }; }
        }
      }
      return { p, e };
    });
    P = found.p;
    E = found.e;
    if (P && E) break;
  }
  expect(P, "no clickable player-operative point found across seeds (double-fire case must be provable)").not.toBeNull();
  expect(E, "no clickable empty-tile point found across seeds").not.toBeNull();

  // (A) A DRAG that STARTS on the operative must rotate the board and must NOT fire a pick. The drag is a
  // grab-to-rotate arc about the pivot (tangential, so it changes the pointer angle and rotates).
  await page.getByTestId(`squad-${P!.id}`).click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.selected), "squad click armed the selection").toBe(P!.id);
  const aBefore = await readAngle(page);
  const rect = (await probeLandmarks(page, [[0, 0.7, 0]])).rect;
  const cx = rect.left + rect.w / 2, cy = rect.top + rect.h / 2;
  const rP = Math.hypot(P!.x - cx, P!.y - cy);
  const aP = (Math.atan2(P!.y - cy, P!.x - cx) * 180) / Math.PI;
  await arcDrag(page, cx, cy, rP, aP, 70, 12);
  const selAfterDrag = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.selected);
  const aAfterDrag = await readAngle(page);
  expect(Math.abs(aAfterDrag - aBefore), "a left-DRAG rotated the board (angle changed)").toBeGreaterThan(0.05);
  expect(selAfterDrag, "a left-DRAG over a piece did NOT fire a pick (no double-fire)", selAfterDrag).toBe(P!.id);

  // (B) A NON-drag board CLICK still performs its pick, and does NOT rotate. Reset pose + clear selection
  // so the click is unambiguous.
  await resetPose(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.selected), "selection cleared before the click").toBeNull();
  const aNoRot = await readAngle(page);
  await page.mouse.click(P!.x, P!.y);
  await page.waitForTimeout(250);
  const selAfterClick = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.selected);
  const aAfterClick = await readAngle(page);
  expect(selAfterClick, "a plain click still performs its pick (selects the operative under the cursor)", selAfterClick).toBe(P!.id);
  expect(Math.abs(aAfterClick - aNoRot), "a plain click did NOT rotate the board").toBeLessThan(0.02);
});