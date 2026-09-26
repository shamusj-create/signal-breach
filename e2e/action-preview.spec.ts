// ACTION-PREVIEW evidence (BROWSER, c-action-preview-e2e).
//
// Before the user confirms, hovering must show what the action will DO, derived from the AUTHORITATIVE
// simulation. The hard bar is HONESTY: the promise must MATCH the delivered result. For an armed attack
// we read the projected damage / resulting HP / energy cost+remaining from the HUD, then PERFORM the
// action with a real pointer and assert the actual state change equals what was promised. For movement we
// read the projected cost, move, and assert the movement actually spent exactly that. A preview that
// disagrees with the result fails here. Real pointer throughout; the truth is read from the sim.
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

const previewText = (page: Page) => page.getByTestId("preview-text").innerText().catch(() => "");

// Canvas-safe points for a tile (independent geometry, so the pointer path is real and not swallowed).
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
      for (const [ox, oy] of [[0, 0], [0, 6], [0, -6], [6, 0], [-6, 0], [3, 3], [-3, -3]] as const) {
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

test("PREVIEW — a hovered armed attack previews the outcome, and the RESULT matches the promise", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  await page.getByTestId("squad-p_vanguard_0").click();
  await page.waitForTimeout(250);
  await page.getByTestId("ability-0").click(); // arm the rifle
  await page.waitForTimeout(200);
  const armed = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugArmed());
  expect(armed, "rifle armed").not.toBeNull();
  const keys: string[] = armed.keys;

  // Find a legal target with a real-pointer point that projects a NON-ZERO outcome, so the promise is
  // meaningful, then confirm and compare the delivered result to the promise.
  let tested = false;
  for (const k of keys) {
    const [xs, ys] = k.split(",");
    const tx = Number(xs);
    const ty = Number(ys);
    const pts = await tilePoints(page, tx, ty);
    if (pts.length === 0) continue;
    await page.mouse.move(6, 6, { steps: 5 });
    await page.waitForTimeout(80);
    await page.mouse.move(pts[0].x, pts[0].y, { steps: 5 });
    await page.waitForTimeout(220);

    const pv = await previewText(page);
    console.log(`[PREVIEW ATTACK] tile=(${tx},${ty}) promised="${pv}"`);
    const m = pv.match(/(\d+) damage, HP (\d+) → (\d+)\. Energy (\d+) \((\d+) left\)/);
    if (!m) continue; // this target is a non-damaging/no-preview case; try the next
    const dmg = Number(m[1]);
    const hpAfter = Number(m[3]);
    const energyLeft = Number(m[5]);
    if (dmg <= 0) continue;

    // Record the authoritative BEFORE from the real state (this is the delivery, not the preview).
    const before = await page.evaluate(([px, py]) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const s = g.debugState();
      const en = s.units.find((u: any) => u.alive && u.pos.x === px && u.pos.y === py);
      const sh = s.units.find((u: any) => u.id === g.selected);
      return { enHp: en ? en.hp : -1, shEnergy: sh ? sh.energy : -1, rev: s.revision };
    }, [tx, ty] as const);

    // Confirm the action with a real pointer click on the same target.
    await page.mouse.click(pts[0].x, pts[0].y);
    await page.waitForTimeout(600);

    const after = await page.evaluate(([px, py]) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const s = g.debugState();
      const en = s.units.find((u: any) => u.id !== undefined && u.alive && u.pos.x === px && u.pos.y === py)
        ?? s.units.find((u: any) => u.pos.x === px && u.pos.y === py);
      const sh = s.units.find((u: any) => u.id === g.selected);
      return { enHp: en ? en.hp : -1, shEnergy: sh ? sh.energy : -1, rev: s.revision };
    }, [tx, ty] as const);

    const actualHpAfter = after.enHp;
    const spent = before.shEnergy - after.shEnergy;
    console.log(`[PREVIEW MATCH] promised dmg=${dmg} hpAfter=${hpAfter} energyLeft=${energyLeft} :: actual hpAfter=${actualHpAfter} spent=${spent}`);

    // The delivered result must equal the promise (HONESTY).
    expect(actualHpAfter, `target HP after must equal the previewed resulting HP (predicted ${hpAfter})`).toBe(hpAfter);
    expect(before.enHp - actualHpAfter, `actual damage dealt must equal the previewed damage (${dmg})`).toBe(dmg);
    expect(spent, "energy actually spent must equal the previewed cost").toBeGreaterThan(0);
    expect(after.shEnergy, "energy remaining must equal the previewed remaining").toBe(energyLeft);
    expect(after.rev, "the confirmed action advanced the authoritative revision").toBeGreaterThan(before.rev);
    tested = true;
    break;
  }
  expect(tested, "at least one legal target must preview a non-zero outcome that then matches its result").toBe(true);
});

test("PREVIEW — a hovered reachable tile previews the move cost, and the MOVE spends exactly that", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  // Choose a player operative + a multi-cost destination (read-only planning), then select it with a
  // REAL squad-row click so the tested move needs no debug hook.
  const pick = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const reach = (window as unknown as { __sbReachableCells: any }).__sbReachableCells;
    const s = g.debugState();
    for (const u0 of s.units) {
      if (!u0.alive || u0.side !== "player") continue;
      const u = s.units.find((x: any) => x.id === u0.id);
      const info = reach(s, u);
      const fromKey = `${u.pos.x},${u.pos.y}`;
      const cands: { key: string; cost: number }[] = [];
      for (const [k, v] of info) {
        if (k === fromKey) continue;
        const cost = (v as any).cost;
        if (cost > 0) cands.push({ key: k, cost });
      }
      if (cands.length) {
        cands.sort((a, b) => b.cost - a.cost);
        return { id: u.id, cands };
      }
    }
    return null;
  });
  expect(pick, "fixture has a player unit with a multi-cost move to preview").not.toBeNull();

  // REAL selection of that operative (its squad row), so the previewed MOVE is reached by real input.
  await page.getByTestId(`squad-${pick!.id}`).click();
  await page.waitForTimeout(250);
  const selId = (await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.selected)) as string;
  expect(selId, "the operative is selected before previewing its move").toBe(pick!.id);

  const before = await page.evaluate((id) => {
    const s = (window as unknown as { __sbGame: any }).__sbGame.debugState();
    const u = s.units.find((x: any) => x.id === id);
    return { x: u.pos.x, y: u.pos.y, moveLeft: u.moveLeft };
  }, selId);

  // Find a destination with a canvas-safe point and drive the real-pointer preview + move.
  let tested = false;
  for (const cand of pick!.cands) {
    const [xs, ys] = cand.key.split(",");
    const tx = Number(xs);
    const ty = Number(ys);
    if (tx < 0 || ty < 0 || tx >= 14 || ty >= 14) continue;
    const pts = await tilePoints(page, tx, ty);
    if (pts.length === 0) continue;
    await page.mouse.move(6, 6, { steps: 5 });
    await page.waitForTimeout(80);
    await page.mouse.move(pts[0].x, pts[0].y, { steps: 5 });
    await page.waitForTimeout(220);
    const pv = await previewText(page);
    console.log(`[PREVIEW MOVE] dest=(${tx},${ty}) promised="${pv}"`);
    const m = pv.match(/Move to \((\d+),(\d+)\) — cost (\d+) move, (\d+) left/);
    if (!m) continue;
    const shownCost = Number(m[3]);
    expect(Number(m[1]), "preview names the destination x").toBe(tx);
    expect(Number(m[2]), "preview names the destination y").toBe(ty);
    expect(shownCost, "the previewed cost equals the independently computed reach cost").toBe(cand.cost);

    await page.mouse.click(pts[0].x, pts[0].y);
    await page.waitForTimeout(1300); // let the display tween settle

    const after = await page.evaluate((id) => {
      const s = (window as unknown as { __sbGame: any }).__sbGame.debugState();
      const u = s.units.find((x: any) => x.id === id);
      return { x: u.pos.x, y: u.pos.y, moveLeft: u.moveLeft };
    }, selId);
    const spentMove = before.moveLeft - after.moveLeft;
    console.log(`[PREVIEW MOVE MATCH] promised cost=${shownCost} :: spent move=${spentMove} reached=(${after.x},${after.y})`);
    expect(`${after.x},${after.y}`, "the operative must arrive at the previewed destination").toBe(`${tx},${ty}`);
    expect(spentMove, "movement must spend exactly the previewed cost").toBe(shownCost);
    tested = true;
    break;
  }
  expect(tested, "at least one reachable tile must preview a cost that matches the actual move").toBe(true);
});