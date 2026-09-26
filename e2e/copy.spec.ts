// COPY criterion (c-copy-e2e): the game must show honest, player-appropriate status copy — never
// raw developer markers. Real browser journeys against the running game + server (no mocks).
//
// Two halves, both asserted against the LIVE app:
//   (1) the leaderboard exposes a stable, VISIBLE server-status hook that reads "Connected" when
//       the server answers and an explicit unavailable line when it does not (the old raw
//       "(OK)" / "(server unavailable)" markers are gone), and
//   (2) no developer markers leak into rendered player-facing text on the title, game and
//       leaderboard screens — no "(OK)", no TODO/FIXME, no raw machine error codes, no visible
//       test ids.
import { test, expect } from "@playwright/test";

const DEV_MARKERS: RegExp[] = [
  /\(OK\)/, // the removed leaderboard success marker
  /\(server unavailable\)/i, // the removed raw failure marker (the player copy is worded differently)
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /\bNaN\b/,
  /\bundefined\b/,
  /\[object /,
  /0x[0-9a-fA-F]{4,}/, // raw hex (colour/error) leaks
  /:\d{4}\b/, // raw host:port leaks (e.g. :8787)
  /\bERR_[A-Z_]+/, // raw error codes
  /Error:\s/,
];

// A few representative test ids that must never be rendered as visible text.
const VISIBLE_TESTID_LEAKS = ["server-status", "submit-status", "open-leaderboard", "hud-phase", "end-turn", "game-canvas", "new-campaign"];

function scanPlayerText(text: string): string[] {
  const hits: string[] = [];
  for (const m of DEV_MARKERS) {
    const hit = text.match(m);
    if (hit) hits.push(`${m}: "${hit[0]}"`);
  }
  for (const id of VISIBLE_TESTID_LEAKS) {
    if (text.includes(id)) hits.push(`visible test id: "${id}"`);
  }
  return hits;
}

async function playerText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => document.body.innerText || "");
}

async function deployDefault(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1800);
}

test("leaderboard status chip reads 'Connected' via the server-status hook, not the raw (OK) marker", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-leaderboard").click();
  const status = page.getByTestId("server-status");
  await expect(status, "a visible server-status hook exists").toBeVisible({ timeout: 8000 });
  await expect(status, "honest success copy, not a raw developer marker").toContainText("Connected", { timeout: 8000 });
  // the (OK) marker is gone from every piece of rendered player text
  const txt = await playerText(page);
  expect(scanPlayerText(txt), `no developer markers on leaderboard: ${scanPlayerText(txt).join(" | ")}`).toHaveLength(0);
});

test("leaderboard degrades honestly when the API is unreachable (explicit unavailable copy, no (server unavailable))", async ({ page }) => {
  await page.route("**/api/leaderboard**", (route) => void route.abort());
  await page.goto("/");
  await page.getByTestId("open-leaderboard").click();
  const status = page.getByTestId("server-status");
  await expect(status, "the status hook is still present on failure").toBeVisible({ timeout: 8000 });
  await expect(status, "explicit unavailable copy, not a raw error token").toContainText("Server unavailable", { timeout: 8000 });
  const txt = await playerText(page);
  expect(scanPlayerText(txt), `no developer markers when offline: ${scanPlayerText(txt).join(" | ")}`).toHaveLength(0);
});

test("no developer markers appear in rendered player text on the title, game and leaderboard screens", async ({ page }) => {
  // Title screen.
  await page.goto("/");
  await expect(page.getByTestId("new-campaign")).toBeVisible();
  let txt = await playerText(page);
  expect(scanPlayerText(txt), `title markers: ${scanPlayerText(txt).join(" | ")}`).toHaveLength(0);

  // Default game view (debug overlay is OFF by default, so no machine readouts render).
  await deployDefault(page);
  txt = await playerText(page);
  expect(txt.length, "the game renders player-facing HUD text to scan").toBeGreaterThan(10);
  expect(scanPlayerText(txt), `game markers: ${scanPlayerText(txt).join(" | ")}`).toHaveLength(0);

  // And the leaderboard path once more from a fresh boot.
  await page.goto("/");
  await page.getByTestId("open-leaderboard").click();
  await expect(page.getByTestId("server-status")).toBeVisible({ timeout: 8000 });
  txt = await playerText(page);
  expect(scanPlayerText(txt), `leaderboard markers: ${scanPlayerText(txt).join(" | ")}`).toHaveLength(0);
});