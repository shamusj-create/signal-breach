import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page) {
  await page.goto("/?seed=4321");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
}

test("rendering: 3D board is non-blank, perf is instrumented, debug overlay defaults OFF", async ({ page }) => {
  await deploy(page);
  // Debug overlay is OFF by default.
  await expect(page.getByTestId("debug-overlay")).toHaveCount(0);

  // Sample the WebGL canvas: it must contain varied pixels (a rendered scene, not a flat fill).
  const variance = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="game-canvas"] canvas') as HTMLCanvasElement | null;
    if (!c) return -1;
    const url = c.toDataURL("image/png");
    // crude non-blank check: unique-ish string length; a flat canvas compresses tiny.
    return url.length;
  });
  expect(variance).toBeGreaterThan(2000);

  const perf = await page.evaluate(() => (window as unknown as { __sbPerf?: () => { fps: number; drawCalls: number; tris: number; meshes: number; shadows: number } }).__sbPerf!());
  expect(perf.meshes).toBeGreaterThan(10); // board tiles + units are built
  expect(perf.shadows).toBeGreaterThan(0); // shadow casters exist
  expect(perf.drawCalls).toBeGreaterThanOrEqual(1);
  expect(perf.fps).toBeGreaterThanOrEqual(0);

  // Enable debug overlay and confirm it shows FPS / seed / revision.
  await page.keyboard.press("F3");
  await expect(page.getByTestId("debug-overlay")).toBeVisible();
  const dbgText = await page.getByTestId("debug-overlay").innerText();
  expect(dbgText).toContain("FPS");
  expect(dbgText).toContain("seed");
  await page.screenshot({ path: "artifacts/enemy-phase-or-combat.png" });
});
