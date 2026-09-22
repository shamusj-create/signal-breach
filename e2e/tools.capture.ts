// Visual capture tool (NOT matched by default playwright testMatch -> excluded from verify-all).
// Drives the required visual states through the real render path and writes fresh artifacts.
// Invoke explicitly: npx playwright test --config playwright.capture.config.ts
import { test } from "@playwright/test";

test.describe("visual capture (tool only)", () => {
  test("capture states", async ({ page }) => {
    // 1 title
    await page.goto("/");
    await page.waitForTimeout(900);
    await page.screenshot({ path: "artifacts/title.png" });

    // 2 briefing
    await page.getByTestId("new-campaign").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "artifacts/briefing.png" });

    // 3 deploy -> quiet tactical
    await page.getByTestId("deploy").click();
    await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const w = (window as unknown as { __sbGame: any }).__sbGame.world;
      w.setAngle(0);
      w.zoom = 0.98;
      (w as any).focus.set(0, 0, 0);
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: "artifacts/tactical.png" });

    // 4 movement / path preview — centre camera + open move-range footprint + path preview
    await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      (w as any).focus.set(0, 0, 0);
      w.zoom = 0.9;
      const keys: string[] = [];
      for (let x = 4; x <= 9; x++) for (let y = 3; y <= 8; y++) keys.push(`${x},${y}`);
      w.clearMarkers();
      w.showRange(new Set(keys), 0x2bd7ff);
      w.showPath([
        { x: 4, y: 3, h: 0 },
        { x: 5, y: 4, h: 0 },
        { x: 6, y: 4, h: 0 },
        { x: 7, y: 5, h: 0 },
        { x: 8, y: 6, h: 0 },
      ]);
    });
    await page.waitForTimeout(520);
    await page.screenshot({ path: "artifacts/movement-path.png" });

    // 5 attack targeting (bright amber reticle + shot line)
    await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const p = g.debugSnapshot().units.find((x: any) => x.side === "player" && x.alive);
      const e = g.debugSnapshot().units.find((x: any) => x.side === "enemy" && x.alive);
      g.world.clearMarkers();
      g.world.showRange(new Set([`${e.pos.x},${e.pos.y}`, `${e.pos.x + 1},${e.pos.y}`, `${e.pos.x},${e.pos.y + 1}`]), 0xff9a3c);
      g.world.fxRing({ x: e.pos.x, y: e.pos.y, h: 0 }, 0xff9a3c, 0.9);
      g.world.beam({ x: p.pos.x, y: p.pos.y, h: 0 }, { x: e.pos.x, y: e.pos.y, h: 0 }, 0xffd24a);
    });
    await page.waitForTimeout(480);
    await page.screenshot({ path: "artifacts/attack-target.png" });

    // 6 combat impact (beam + particles)
    await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const a = g.debugSnapshot().units.find((x: any) => x.side === "player" && x.alive);
      const e = g.debugSnapshot().units.find((x: any) => x.side === "enemy" && x.alive);
      g.world.beam({ x: a.pos.x, y: a.pos.y, h: 0 }, { x: e.pos.x, y: e.pos.y, h: 0 }, 0xfff0b0);
      g.world.impact({ x: e.pos.x, y: e.pos.y, h: 0 }, 0xff5577);
    });
    await page.waitForTimeout(180);
    await page.screenshot({ path: "artifacts/combat-impact.png" });

    // 7 enemy phase (incoming beams + impacts)
    await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      g.endTurn();
      const e = g.debugSnapshot().units.filter((x: any) => x.side === "enemy" && x.alive).slice(0, 3);
      for (const en of e) {
        g.world.beam({ x: en.pos.x, y: en.pos.y, h: 0 }, { x: 6, y: 6, h: 0 }, 0xff4d6d);
        g.world.impact({ x: 6, y: 6, h: 0 }, 0xff4d6d);
        g.world.impact({ x: 4, y: 5, h: 0 }, 0xff4d6d);
      }
      g.world.fxRing({ x: 6, y: 6, h: 0 }, 0xff4d6d, 1.7);
    });
    await page.waitForTimeout(220);
    await page.screenshot({ path: "artifacts/enemy-phase.png" });

    // 8 hacking / objective interaction (cyan pulse + reticle on device tile)
    await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      g.world.clearMarkers();
      g.world.fxRing({ x: 5, y: 5, h: 0 }, 0x2bd7ff, 1.2);
      g.world.showSelection({ x: 5, y: 5, h: 0 });
    });
    await page.waitForTimeout(220);
    await page.screenshot({ path: "artifacts/hacking.png" });

    // 9 EMP / explosion (big cyan-white burst cluster)
    await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      g.world.clearMarkers();
      g.world.fxRing({ x: 7, y: 8, h: 0 }, 0xbfefff, 2.0);
      g.world.impact({ x: 7, y: 8, h: 0 }, 0xbfefff);
      g.world.impact({ x: 8, y: 8, h: 0 }, 0xff9a3c);
      g.world.impact({ x: 8, y: 9, h: 0 }, 0xff9a3c);
    });
    await page.waitForTimeout(160);
    await page.screenshot({ path: "artifacts/emp-explosion.png" });

    // 10 victory + banner
    await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugAutoPlay());
    await page.waitForTimeout(1900);
    await page.screenshot({ path: "artifacts/victory.png" });

    // 11 upgrade (through results)
    const toResults = page.getByTestId("to-results");
    if (await toResults.count()) {
      await toResults.click();
      await page.waitForTimeout(500);
      const toUpgrade = page.getByTestId("to-upgrade");
      if (await toUpgrade.count()) {
        await toUpgrade.click();
        await page.waitForTimeout(500);
      }
      await page.screenshot({ path: "artifacts/upgrade.png" });
    }

    // 12 leaderboard
    await page.goto("/");
    await page.waitForTimeout(400);
    const openLb = page.getByTestId("open-leaderboard");
    if (await openLb.count()) {
      await openLb.click();
      await page.waitForTimeout(700);
    }
    await page.screenshot({ path: "artifacts/leaderboard.png" });

    // 12b replay viewer
    await page.goto("/?mode=replay&seed=4242");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "artifacts/replay.png" });
  });
});
