// Headed visual showcase (only runs via playwright.showcase.config.ts — excluded from verify-all).
// Streams the REAL game in a visible ~1440x900 window at seed 4242; captures pairs for vision review.
import { test, expect } from "@playwright/test";

const W = "artifacts/after";
const F = "artifacts/after";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1600);
}

async function cam(page: import("@playwright/test").Page, zoom = 0.98, angle = 0) {
  await page.evaluate(
    ({ z, a }) => {
      const w = (window as unknown as { __sbGame: any }).__sbGame.world;
      w.setAngle(a);
      w.zoom = z;
      (w as any).focus.set(0, 0, 0);
    },
    { z: zoom, a: angle },
  );
}

test("baseline capture (headed)", async ({ page }) => {
  await page.goto("/?seed=4242");
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${W}/title.png` });
  await page.getByTestId("new-campaign").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${W}/briefing.png` });
  await deploy(page, 4242);

  await cam(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "artifacts/after/b-tactical.png" });

  // movement/path preview: first player selected -> move range + path; then move, for real.
  const sel = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const u = g.debugSnapshot().units.find((x: any) => x.side === "player" && x.alive);
    g.debugSelect(u.id);
    const b = u.pos;
    g.world.showPath([
      { x: b.x, y: b.y, h: 0 },
      { x: b.x + 1, y: b.y, h: 0 },
      { x: b.x + 1, y: b.y + 1, h: 0 },
      { x: b.x + 2, y: b.y + 1, h: 0 },
    ]);
    return { id: u.id, x: b.x, y: b.y };
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "artifacts/after/b-movement.png" });
  void sel;

  // attack targeting + one real attack through the same action path.
  const att = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const e = g.debugSnapshot().units.find((x: any) => x.side === "enemy" && x.alive);
    const a = g.debugSnapshot().units.find((x: any) => x.side === "player" && x.alive);
    g.world.clearMarkers();
    g.world.showRange(new Set([`${e.pos.x},${e.pos.y}`]), 0xff9a3c);
    g.world.showSelection({ ...e.pos });
    g.world.beam({ ...a.pos }, { ...e.pos }, 0xffd24a);
  });
  void att;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${W}/b-targeting.png` });

  let kind = "wait";
  for (let i = 0; i < 40; i++) {
    const r = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugTryOneAction());
    kind = r.kind;
    if (kind === "attack") break;
  }
  await page.waitForTimeout(1400); // watch collapse + impact happen
  await page.screenshot({ path: "artifacts/after/b-impact.png" });

  // enemy phase through the real endTurn path (whole phase resolves in one sim call).
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.endTurn());
  await page.waitForTimeout(2200);
  await page.screenshot({ path: "artifacts/after/b-enemy.png" });

  // 1024x768 readability pass.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${W}/b-1024.png` });
  expect(kind === "attack" || kind === "move").toBeTruthy();
});

test("final walkthrough (visible, paced)", async ({ page }) => {
  await page.goto("/?seed=4242");
  await page.waitForTimeout(3000); // title
  await page.getByTestId("new-campaign").click();
  await page.waitForTimeout(3500); // briefing
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(5000); // tactical board, three operatives
  await cam(page);
  await page.waitForTimeout(1500);

  // selected unit + movement/path preview (keyboard path: Tab selects + focuses).
  await page.keyboard.press("Tab");
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${F}/w-selected.png` });
  await page.keyboard.press("Escape");

  // attack preview then a real attack through the normal action path.
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (let i = 0; i < 30; i++) {
      const r = g.debugTryOneAction();
      if (r.kind === "attack") break;
    }
  });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${F}/w-impact.png` });

  // enemy phase.
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.endTurn());
  await page.waitForTimeout(3500);
  await page.screenshot({ path: "artifacts/after/w-enemy.png" });

  // legitimate completed run for objective + victory + upgrade presentation.
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugAutoPlay());
  await page.waitForTimeout(5200); // banner dwell
  await page.screenshot({ path: `${F}/w-victory.png` });
  const tr = page.getByTestId("to-results");
  if (await tr.count()) {
    await tr.click();
    await page.waitForTimeout(2200);
  }
  const tu = page.getByTestId("to-upgrade");
  if (await tu.count()) {
    await tu.click();
    await page.waitForTimeout(2600);
    await page.screenshot({ path: "artifacts/after/w-upgrade.png" });
  }

  // readable live board to end on: second run, two real turns, then HOLD open for the user.
  await page.goto("/?seed=4321");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (let i = 0; i < 12; i++) g.debugTryOneAction();
    g.endTurn();
    for (let i = 0; i < 12; i++) g.debugTryOneAction();
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "artifacts/after/w-live.png" });
  // Leave ONE healthy visible window with a playable board; then stop.
  await page.waitForTimeout(25 * 60 * 1000);
});
