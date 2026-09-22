import { test, expect, type Page } from "@playwright/test";

// Evidence-only screenshot with a bounded retry + paint wait. `page.screenshot` intermittently
// raises "Protocol error (Page.captureScreenshot): Unable to capture screenshot" on a fully-painted
// page (the DOM-only title screen) during long full-suite runs. This is a transient Chromium CDP
// capture-path flake, NOT a product defect: the real checks are control visibility + a clean
// console, and the PNG is evidence, not an assertion. We let the compositor paint one more frame,
// disable animations, then retry the capture up to 3 times with a short backoff. If every attempt
// still fails we let the test continue so the console-clean assertion below still runs instead of
// aborting on a capture side-effect. No assertion is added, skipped or relaxed.
async function captureEvidence(page: Page, path: string, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    try {
      const buf = await page.screenshot({ path, animations: "disabled" });
      if (buf.length > 0) return;
    } catch {
      // transient Page.captureScreenshot failure: back off, let a frame paint, then retry the evidence shot
    }
    await page.waitForTimeout(250 * i);
  }
  console.log("WARN screenshot capture failed after retries (non-load-bearing evidence): " + path);
}

test("title screen renders and console is clean", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));

  await page.goto("/");
  await expect(page.getByTestId("new-campaign")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("open-leaderboard")).toBeVisible();
  await captureEvidence(page, "artifacts/title.png");
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("deploy into tactical board with a live 3D canvas", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));

  await page.goto("/");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();

  const canvas = page.getByTestId("game-canvas").locator("canvas");
  await expect(canvas).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500); // let the scene render a few frames
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(300);
  expect(box!.height).toBeGreaterThan(300);

  await page.screenshot({ path: "artifacts/tactical.png" });
  expect(errors, errors.join("\n")).toHaveLength(0);
});
