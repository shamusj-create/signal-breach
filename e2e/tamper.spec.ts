// Negative control #2 (server trust boundary): the leaderboard must reject doctored submissions.
// Corrupted action logs must diverge under server-side replay, and inflated scores must fail
// comparison. The server replays with the shared authoritative sim; nothing trusted is client-side.
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
}

test("negative control: doctored submissions are rejected by the server", async ({ page }) => {
  await deploy(page, 2024);
  const out = await page.evaluate(async () => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const play = g.debugAutoPlay();
    if (!play.victory) return { win: false };
    const log = g.actionLog as any[];
    const rowsBefore = await fetch("/api/leaderboard?mission=all").then((r) => r.json()).then((d) => (d.rows ?? []).length);
    // 1) inflated score against a truthful log
    const inflated = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission: g.state.mission,
        seed: g.seed,
        actions: log,
        claimedOutcome: "win",
        claimedScore: 999999,
        player: "cheater-score",
      }),
    }).then((r) => ({ status: r.status, body: r.json() }));
    // 2) corrupted action log (teleport a mover to a non-adjacent cell)
    const broken = log.map((a) => ({ ...a }));
    const firstMove = broken.findIndex((a) => a.kind === "move");
    if (firstMove >= 0) {
      broken[firstMove] = { ...broken[firstMove], path: [...broken[firstMove].path, { x: 0, y: 0, h: 0 }] };
    } else {
      broken[0] = { kind: "attack", unitId: "ghost_999", ability: "silenced_shot", targetUnitId: "nobody" };
    }
    const corrupt = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission: g.state.mission,
        seed: g.seed,
        actions: broken,
        claimedOutcome: "win",
        claimedScore: 1,
        player: "cheater-log",
      }),
    }).then((r) => ({ status: r.status, body: r.json() }));
    const rowsAfter = await fetch("/api/leaderboard?mission=all").then((r) => r.json()).then((d) => (d.rows ?? []).length);
    const names = await fetch("/api/leaderboard?mission=all").then((r) => r.json()).then((d) => (d.rows ?? []).map((x: any) => x.player));
    return { win: true, inflatedStatus: inflated.status, corruptStatus: corrupt.status, rowsBefore, rowsAfter, names };
  });
  expect(out.win, "fixture requires a win first").toBe(true);
  expect(out.inflatedStatus, "inflated score must be rejected").toBe(400);
  expect(out.corruptStatus, "corrupted log must be rejected").toBe(400);
  expect(out.rowsAfter, "no cheater rows may enter the leaderboard").toBe(out.rowsBefore);
  expect(out.names.filter((n: string) => n.startsWith("cheater"))).toEqual([]);
});
