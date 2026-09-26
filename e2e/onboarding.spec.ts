// ONBOARDING criterion (c-onboarding-e2e): real browser journeys against the running game.
// Proves (1) a one-time, dismissible/skippable, PERSISTED first-run overlay that explains how to
// play/win/interact and never keeps blocking the board, and (2) hover tooltips that ACTUALLY TEACH —
// the ability button reveals effect/cost/range, hovering a live enemy teaches its threat + whether
// you can hit it, and a Field Guide enumerates enemies and security devices. No mocks.
import { test, expect } from "@playwright/test";

async function deployFresh(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1600);
}

async function firstPlayerId(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const u = g.debugState().units.find((x: any) => x.alive && x.side === "player");
    return u ? u.id : "";
  });
}

test("first-run overlay teaches play/win/interact, is dismissible, and persists so it never reappears", async ({ page }) => {
  await deployFresh(page);
  const overlay = page.getByTestId("first-run-overlay");
  await expect(overlay, "first-run overlay is shown on a fresh install").toBeVisible();
  await expect(page.getByTestId("ob-play")).toContainText(/moves|energy/i);
  await expect(page.getByTestId("ob-win")).toContainText(/relay/i);
  await expect(page.getByTestId("ob-win")).toContainText(/core/i);
  await expect(page.getByTestId("ob-win")).toContainText(/extract/i);
  await expect(page.getByTestId("ob-interact")).toContainText(/camera/i);
  await expect(page.getByTestId("ob-interact")).toContainText(/Tab|End Turn/i);

  await page.getByTestId("dismiss-onboarding").click();
  await expect(page.getByTestId("first-run-overlay")).toHaveCount(0, { timeout: 5000 });
  const seen = await page.evaluate(() => localStorage.getItem("sb.onboarding.seen.v2"));
  expect(seen, "dismissal is persisted").toBe("1");

  await page.reload();
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("first-run-overlay"), "overlay does not reappear after being dismissed").toHaveCount(0);

  // Not blocking the board afterwards: primary controls remain visible/clickable.
  await expect(page.getByTestId("end-turn")).toBeVisible();
  await expect(page.getByTestId("field-guide")).toBeVisible();
});

test("the tour is skippable and a pre-seen install never shows it", async ({ page }) => {
  await deployFresh(page);
  await expect(page.getByTestId("first-run-overlay")).toBeVisible();
  await page.getByTestId("skip-onboarding").click();
  await expect(page.getByTestId("first-run-overlay")).toHaveCount(0, { timeout: 5000 });

  await page.addInitScript(() => localStorage.setItem("sb.onboarding.seen.v2", "1"));
  await deployFresh(page);
  await expect(page.getByTestId("first-run-overlay"), "no overlay for an already-onboarded player").toHaveCount(0);
});

test("hover tooltips actually teach: ability cost/range, live enemy threat + reachability, and the Field Guide", async ({ page }) => {
  await deployFresh(page);
  const id = await firstPlayerId(page);
  expect(id, "fixture has a player unit to select").not.toBe("");
  await page.evaluate((uid) => (window as unknown as { __sbGame: any }).__sbGame.debugSelect(uid), id);
  await page.waitForTimeout(300);

  // (a) ability buttons reveal effect/cost/range on hover.
  const ab0 = page.getByTestId("ability-0");
  await expect(ab0).toBeVisible();
  const hintText = await ab0.getAttribute("data-hint");
  expect(hintText && /energy/i.test(hintText) && /range|Self/i.test(hintText), `ability tooltip teaches: ${hintText}`).toBeTruthy();
  const box = await ab0.boundingBox();
  expect(box, "ability button has a box to hover").not.toBeNull();
  if (box) {
    await page.mouse.move(box.x - 60, box.y - 60);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tip = page.getByTestId("tooltip");
    await expect(tip, "hover reveals the teaching tooltip").toContainText(/energy/i, { timeout: 4000 });
    await expect(tip).toContainText(/range|Self/i);
  }

  // (b) hovering a LIVE enemy on the board teaches its threat AND whether you can hit it.
  const spots = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const s = g.debugState();
    const cam = w.camera;
    cam.updateMatrixWorld(true);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const out: { name: string; points: { x: number; y: number }[] }[] = [];
    for (const u of s.units) {
      if (!u.alive || u.side !== "enemy") continue;
      const wpos = w.tileToWorld({ x: u.pos.x, y: u.pos.y, h: u.pos.h });
      const pt = new (wpos.constructor as any)(wpos.x, wpos.y + 0.4, wpos.z).project(cam);
      if (Math.abs(pt.x) > 0.95 || Math.abs(pt.y) > 0.95) continue; // off-screen
      const cx = rect.left + (pt.x * 0.5 + 0.5) * rect.width;
      const cy = rect.top + (-pt.y * 0.5 + 0.5) * rect.height;
      const points = [];
      for (const dx of [0, 6, -6, 0]) for (const dy of [0, 6, -6]) points.push({ x: cx + dx, y: cy + dy });
      out.push({ name: u.name, points });
    }
    return out;
  });
  expect(spots.length, "fixture has a visible enemy to hover").toBeGreaterThan(0);
  const tip = page.getByTestId("tooltip");
  let taught = false;
  for (const spot of spots) {
    await page.mouse.move(5, 5); // reset so a new pointermove is observed
    for (const p of spot.points) {
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(60);
      const text = (await tip.innerText()).toUpperCase();
      if (text.includes(spot.name.toUpperCase()) && /(REACH|RANGE|IN RANGE|HIT|COVER|SHOOT)/.test(text)) {
        taught = true;
        break;
      }
    }
    if (taught) break;
  }
  expect(taught, "hovering a live enemy taught its threat + reachability").toBe(true);

  // (c) the Field Guide enumerates hostiles (with a numeric threat) and security devices.
  await page.mouse.move(5, 5);
  await page.getByTestId("field-guide").click();
  const guide = page.getByTestId("field-guide-panel");
  await expect(guide, "field guide opens").toBeVisible();
  await expect(guide, "guide names a hostile").toContainText(/SENTRY|HUNTER|ENFORCER|WARDEN/i);
  await expect(guide, "guide quantifies the threat (damage + range)").toContainText(/dmg \d+ · range \d+/);
  await expect(guide).toContainText(/Security devices/i);
});