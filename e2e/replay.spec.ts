import { test, expect } from "@playwright/test";

test("Journey G — replay viewer re-runs the action log and is speed-independent", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR " + (e as Error).message));

  await page.goto("/?mode=replay&mission=0&seed=4242");
  await page.waitForSelector('[data-testid="replay-viewer"]', { timeout: 10000 });
  await expect(page.getByTestId("replay-play")).toBeVisible();
  await expect(page.getByTestId("replay-speed-4")).toBeVisible();
  await expect(page.getByTestId("replay-restart")).toBeVisible();

  // Exercise the controls (x4 play, restart, x1) so the UI path runs, without depending on the
  // animation timers to finish.
  await page.getByTestId("replay-speed-4").click();
  await page.getByTestId("replay-play").click();
  await page.getByTestId("replay-restart").click();
  await page.getByTestId("replay-speed-1").click();
  await page.getByTestId("replay-play").click();

  // The viewer RE-RUNS the authoritative action log; the reconstructed final state must be
  // identical regardless of speed, and identical across restarts (determinism).
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      __sbReplayRun?: (sp: number) => string;
      __sbReplayRestart?: () => string;
    };
    const h4 = w.__sbReplayRun!(4);
    const h1 = w.__sbReplayRun!(1);
    const restart = w.__sbReplayRestart!();
    return { h4, h1, restart };
  });
  expect(result.h4.length).toBeGreaterThan(0);
  expect(result.h4).toBe(result.h1);
  expect(result.restart).toBe("OK");
  expect(errors, errors.join("\n")).toHaveLength(0);
});
