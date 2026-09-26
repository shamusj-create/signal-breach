// PENDING-ACTION evidence (BROWSER, c-pending-action-e2e).
//
// Arming a targeted ability must produce a VISIBLE, PERSISTENT pending-action state in the HUD that
// names the ability, states that a highlighted target must be chosen, and offers a visible way to
// cancel. It must survive the user looking away from the board, and clear when the action resolves or
// is cancelled. Driven with real pointer/DOM input; the state is asserted against the authoritative
// simulation (debugArmed), not against any presentation accessor.
import { test, expect } from "@playwright/test";

type Page = import("@playwright/test").Page;

async function deploy(page: Page, url: string) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("sb.onboarding.seen.v2", "1");
    } catch {
      /* ignore */
    }
  });
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
}

const armed = (page: Page) => page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugArmed());
const pendingVisible = (page: Page) => page.getByTestId("pending-action").isVisible().catch(() => false);
const pendingText = (page: Page) => page.getByTestId("pending-text").innerText().catch(() => "");

// Canvas-safe screen points for a tile: a point is usable only if the TOP element there is the canvas
// (so a HUD control cannot swallow the pointer) AND the tile actually raycasts back to (x,y). This
// drives the real pointer while staying independent of the preview/pending implementation.
function tilePoints(page: Page, x: number, y: number): Promise<{ x: number; y: number }[]> {
  return page.evaluate(
    ([tx, ty]) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const cam = w.camera;
      cam.updateMatrixWorld(true);
      const base = w.tileToWorld({ x: tx, y: ty, h: 0 });
      base.y = 0;
      const out: { x: number; y: number }[] = [];
      for (const [ox, oy] of [[0, 0], [0, 7], [0, -7], [7, 0], [-7, 0], [4, 4], [-4, -4]] as const) {
        const p = base.clone();
        const ndc = p.project(cam);
        if (Math.abs(ndc.x) > 0.96 || Math.abs(ndc.y) > 0.96) continue;
        const px = rect.left + (ndc.x * 0.5 + 0.5) * rect.width + ox;
        const py = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height + oy;
        if (px < rect.left + 1 || px > rect.right - 1 || py < rect.top + 1 || py > rect.bottom - 1) continue;
        const hit = w.pickAt(px, py);
        if (!hit || hit.x !== tx || hit.y !== ty) continue;
        const top = document.elementFromPoint(px, py);
        if (!top || top.tagName !== "CANVAS") continue;
        out.push({ x: +px.toFixed(1), y: +py.toFixed(1) });
      }
      return out;
    },
    [x, y] as const,
  );
}

test("PENDING — arming the rifle shows a persistent named pending state with a visible cancel", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  await page.getByTestId("squad-p_vanguard_0").click();
  await page.waitForTimeout(250);

  // No pending state before arming.
  expect(await pendingVisible(page), "no pending state before arming").toBe(false);

  // ARM by a real DOM click on the rifle button (this now also re-renders the HUD).
  await page.getByTestId("ability-0").click();
  await page.waitForTimeout(200);
  expect(await armed(page), "rifle is armed after clicking it").not.toBeNull();

  // The pending state is VISIBLE, names the ability, and says a target must be chosen.
  await expect(page.getByTestId("pending-action"), "pending-action bar is visible").toBeVisible();
  const text = await pendingText(page);
  console.log(`[PENDING] text="${text}"`);
  expect(text, "pending state names the ability").toMatch(/Pulse Rifle/i);
  expect(text, "pending state says a target must be chosen").toMatch(/target/i);

  // A visible way to cancel exists.
  await expect(page.getByTestId("pending-cancel"), "pending state offers a visible Cancel control").toBeVisible();
  expect(await page.getByTestId("pending-cancel").isEnabled()).toBe(true);
});

test("PENDING — the pending state survives looking away from the board, then clears on cancel", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  await page.getByTestId("squad-p_vanguard_0").click();
  await page.waitForTimeout(250);
  await page.getByTestId("ability-0").click();
  await page.waitForTimeout(200);
  expect(await pendingVisible(page), "pending state appeared after arming").toBe(true);

  // LOOK AWAY: sweep the real pointer over the board (a piece + empty ground) and a non-board control.
  await page.mouse.move(500, 300, { steps: 6 });
  await page.waitForTimeout(120);
  await page.mouse.move(640, 420, { steps: 6 });
  await page.waitForTimeout(120);
  await page.getByTestId("tab-commentary").click();
  await page.waitForTimeout(120);
  // The pending bar lives in the left panel, independent of the right-hand tab — it must still be there.
  expect(await pendingVisible(page), "pending state persists while the user looks away from the board").toBe(true);

  // CANCEL by the visible control clears it and drops the arm.
  await page.getByTestId("pending-cancel").click();
  await page.waitForTimeout(200);
  expect(await pendingVisible(page), "pending state cleared after cancel").toBe(false);
  expect(await armed(page), "arm cleared after cancel").toBeNull();
});

test("PENDING — the pending state clears when the armed action RESOLVES via a real target click", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  await page.getByTestId("squad-p_vanguard_0").click();
  await page.waitForTimeout(250);
  await page.getByTestId("ability-0").click();
  await page.waitForTimeout(200);
  const armedNow = await armed(page);
  expect(armedNow, "armed before resolving").not.toBeNull();
  const before = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugState().revision);

  // Find a legal target that has a canvas-safe real-pointer point and resolve the armed shot on it.
  const keys: string[] = armedNow!.keys as string[];
  let resolved = false;
  for (const k of keys) {
    const [xs, ys] = k.split(",");
    const pts = await tilePoints(page, Number(xs), Number(ys));
    if (pts.length === 0) continue;
    await page.mouse.click(pts[0].x, pts[0].y);
    await page.waitForTimeout(500);
    const st = await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      return { armed: g.debugArmed(), rev: g.debugState().revision };
    });
    if (st.armed === null && st.rev > before) {
      resolved = true;
      break;
    }
  }
  expect(resolved, "a real target click resolved the armed ability").toBe(true);
  expect(await pendingVisible(page), "pending state cleared once the action resolved").toBe(false);
});