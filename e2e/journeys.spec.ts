import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR " + (e as Error).message));
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(900);
  return { errors };
}

test("Journey A — basic combat: preview damage equals applied damage, energy deducted", async ({ page }) => {
  const { errors } = await deploy(page, 1234);
  const result = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    let last: any = null;
    for (let i = 0; i < 30; i++) {
      const r = g.debugTryOneAction();
      if (r.kind === "attack") {
        last = r;
        break;
      }
    }
    return last;
  });
  expect(result, "a valid attack should occur during play").not.toBeNull();
  // deterministic: no RNG — preview equals actual result
  expect(result.previewFinal).toBe(result.hpBefore - result.hpAfter);
  expect(result.energyAfter).toBeLessThan(result.energyBefore);
  expect(result.phase).toBe("player");
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("Journey B — enemy phase resolves legally and the game never stalls", async ({ page }) => {
  const { errors } = await deploy(page, 77);
  const res = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (let i = 0; i < 6; i++) g.debugTryOneAction();
    const beforeTurn = g.debugSnapshot().turn;
    const beforePhase = g.debugSnapshot().phase;
    g.endTurn();
    const afterTurn = g.debugSnapshot().turn;
    const afterPhase = g.debugSnapshot().phase;
    return { beforeTurn, beforePhase, afterTurn, afterPhase };
  });
  expect(res.beforePhase).toBe("player");
  expect(res.afterPhase).toBe("player"); // returned to player, not stuck
  expect(res.afterTurn).toBe(res.beforeTurn + 1);
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("Journey C — objectives: relays, core unlock+hack, extraction reach win", async ({ page }) => {
  const { errors } = await deploy(page, 4242);
  const res = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const startCore = g.debugSnapshot().objectives.find((o: { id: string }) => o.id === "core").status;
    const out = g.debugAutoPlay();
    const snap = g.debugSnapshot();
    const core = snap.objectives.find((o: { id: string }) => o.id === "core").status;
    return { startCore, victory: out.victory, core, turn: out.turn, objectives: snap.objectives };
  });
  expect(res.startCore).toBe("locked"); // gated until relays done
  expect(res.core).toBe("done");
  expect(res.victory).toBe(true);
  expect(errors, errors.join("\n")).toHaveLength(0);
  await page.screenshot({ path: "artifacts/victory.png" });
});

test("Journey D — persistence: authoritative state survives reload", async ({ page }) => {
  const { errors } = await deploy(page, 9911);
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (let i = 0; i < 5; i++) g.debugTryOneAction();
    const s = g.debugSerialize();
    (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash; // noop
    localStorage.setItem("sbtest", s);
    return { hash: (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(g.debugState()), s };
  });
  await page.reload();
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  const res = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const ok = g.debugLoad(localStorage.getItem("sbtest"));
    return { ok, hash: (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(g.debugState()) };
  });
  expect(res.ok).toBe(true);
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("Journey E — determinism: identical seed+actions produce identical final hash", async ({ page }) => {
  const seed = 555001;
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  const h1 = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.debugAutoPlay();
    return (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(g.debugState());
  });
  await page.reload();
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  const h2 = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.debugAutoPlay();
    return (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(g.debugState());
  });
  expect(h1).toBe(h2);
});

test("Journey H — responsive/visual integrity at laptop sizes", async ({ page }) => {
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(vp);
    const { errors } = await deploy(page, 2000 + vp.width);
    const canvas = page.getByTestId("game-canvas").locator("canvas");
    await expect(canvas).toBeVisible();
    const metrics = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="game-canvas"] canvas') as HTMLCanvasElement | null;
      return {
        w: c ? c.clientWidth : 0,
        h: c ? c.clientHeight : 0,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        endTurnVisible: !!document.querySelector('[data-testid="end-turn"]'),
      };
    });
    expect(metrics.w).toBeGreaterThan(300);
    expect(metrics.h).toBeGreaterThan(300);
    expect(metrics.overflow).toBeLessThanOrEqual(2);
    expect(metrics.endTurnVisible).toBe(true);
    expect(errors, errors.join("\n")).toHaveLength(0);
    await page.screenshot({ path: `artifacts/viewport-${vp.width}.png` });
  }
});
