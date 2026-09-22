// MISSION / OBJECTIVE browser journey (INTEGRATION-class evidence) for missions 2 and 3.
//
// The deterministic stealth solver has a legitimate winning line on BOTH later sectors; here we prove
// it through the LIVE page on the SAME action path a human uses (TacticalGame.debugAutoPlay replays
// the shared solver's action log against the authoritative reducer, not a mock). We assert the actual
// WIN CONDITION of the objective chain — relays done -> core unlocked+hacked -> a live operative
// reaching extraction — and that the run is deterministic (identical seed + actions -> identical
// final state hash). Non-superficial: a mission that merely *looked* winnable but never reached the
// extraction tile, or a solver that lost, fails these.
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1700);
}

const finalState = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const core = s.objectives.find((o: any) => o.id === "core");
    const ex = s.extraction as { x: number; y: number } | null;
    const onEx = ex ? s.units.some((u: any) => u.alive && u.side === "player" && u.pos.x === ex.x && u.pos.y === ex.y) : false;
    return {
      mission: s.mission as number,
      name: g.debugSnapshot().missionName as string,
      victory: s.victory as boolean,
      gameOver: s.gameOver as boolean,
      turn: s.turn as number,
      coreDone: core ? core.status === "done" : false,
      onExtraction: onEx,
      hash: (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(s),
    };
  });

const autoPlay = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    return g.debugAutoPlay();
  });

test("Mission 2 (Relay Junction): relay->core->extract chain reaches a live-extraction win", async ({ page }) => {
  await deploy(page, "/?seed=4242&mission=2");
  const start = await finalState(page);
  expect(start.mission, "deployed sector index").toBe(1);
  expect(start.victory, "must start unwon").toBe(false);

  const play = await autoPlay(page);
  const end = await finalState(page);
  expect(end.name, "sector must be the mission-2 layout, not the tutorial").toBe("Relay Junction");
  expect(play.victory, `Mission 2 must win (turn ${end.turn})`).toBe(true);
  expect(end.gameOver, "mission must terminate").toBe(true);
  expect(end.turn, `win in a bounded turn count (got ${end.turn})`).toBeLessThanOrEqual(40);
  // The actual win condition: core hacked AND a live operative standing on the extraction tile.
  expect(end.coreDone, "core objective must be breached").toBe(true);
  expect(end.onExtraction, "a live operative must reach extraction to win").toBe(true);
  await page.screenshot({ path: "artifacts/mission2-win.png" });
});

test("Mission 3 (Core Chamber): bypasses the security ring to a live-extraction win", async ({ page }) => {
  await deploy(page, "/?seed=4242&mission=3");
  const ring = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const cams = s.devices.filter((d: any) => d.kind === "camera").length;
    const turrets = s.devices.filter((d: any) => d.kind === "turret").length;
    return { mission: s.mission as number, cams, turrets };
  });
  expect(ring.mission).toBe(2);
  expect(ring.cams, "Core Chamber must field a camera ring").toBeGreaterThanOrEqual(2);
  expect(ring.turrets, "Core Chamber must field turrets").toBeGreaterThanOrEqual(2);

  const play = await autoPlay(page);
  const end = await finalState(page);
  expect(end.name).toBe("Core Chamber");
  expect(play.victory, `Mission 3 must win (turn ${end.turn})`).toBe(true);
  expect(end.turn, `win in a bounded turn count (got ${end.turn})`).toBeLessThanOrEqual(50);
  expect(end.coreDone, "core objective must be breached").toBe(true);
  expect(end.onExtraction, "a live operative must reach extraction to win").toBe(true);
  await page.screenshot({ path: "artifacts/mission3-win.png" });
});

test("missions 2 and 3 wins are deterministic (identical seed -> identical final hash, win every time)", async ({ page }) => {
  for (const { mission, name } of [
    { mission: 2, name: "Relay Junction" },
    { mission: 3, name: "Core Chamber" },
  ]) {
    const seed = 20261 + mission;
    const runOnce = async () => {
      await page.goto(`/?seed=${seed}&mission=${mission}`);
      await page.getByTestId("new-campaign").click();
      await page.getByTestId("deploy").click();
      await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
      await page.waitForTimeout(1200);
      await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugAutoPlay());
      return finalState(page);
    };
    const a = await runOnce();
    await page.reload();
    const b = await runOnce();
    expect(a.name, `${name} ran the right sector`).toBe(name);
    expect(a.victory, `${name} first run must win`).toBe(true);
    expect(b.victory, `${name} second run must win`).toBe(true);
    expect(b.hash, `${name} must be byte-identical across identical runs`).toBe(a.hash);
  }
});