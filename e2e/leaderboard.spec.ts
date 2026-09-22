// Journey L — leaderboard pipeline through the REAL stack: browser sim -> HTTP submit ->
// server-side re-validation with the shared authoritative sim -> SQLite -> leaderboard screen.
// No mocks: the submit endpoint replays the action log from scratch.
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
}

test("Journey L1 — a legit winning run is re-validated server-side and listed", async ({ page }) => {
  await deploy(page, 2024);
  const play = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    return g.debugAutoPlay();
  });
  expect(play.victory, `solver must actually win (turn ${play.turn})`).toBe(true);
  const submit = page.getByTestId("submit-run");
  await expect(submit).toBeVisible({ timeout: 15000 });
  await submit.click();
  await expect(page.getByTestId("submit-status")).toContainText("ACCEPTED", { timeout: 15000 });
  await page.getByTestId("to-results").click();
  await page.getByText("Leaderboard", { exact: true }).click();
  await expect(page.getByText("operator").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("(OK)")).toBeVisible();
});
