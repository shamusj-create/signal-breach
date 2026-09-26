// ABILITY-HOVER REACH evidence (BROWSER, c-ability-hover-reach-e2e).
//
// This is the REAL-POINTER companion to e2e/ability-targets.spec.ts. That spec proves the legal-target
// highlight through the debugHoverAbility hook; THIS spec proves the same behaviour is reachable by an
// actual mouse pointer on the HUD — which is exactly the defect that shipped (hoverAbility was wired to
// NO UI event, so a real hover highlighted nothing while the debug-hook suite stayed green). We drive
// the pointer onto the ability button and off it again, and compare the drawn highlight to a set computed
// INDEPENDENTLY of the app (the rules engine, applyAction). No debug hook performs the hover here.
import { test, expect } from "@playwright/test";
import { applyAction } from "../packages/sim/src/state.ts";

type Page = import("@playwright/test").Page;

async function deploy(page: Page, url: string) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("sb.onboarding.seen.v2", "1"); // no first-run card over the board/abilities
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

// The live drawn ability-target highlight (renderer truth), same shape the oracle emits.
async function targetKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => [...new Set((window as unknown as { __sbTargetKeys?: () => string[] }).__sbTargetKeys!())].sort());
}

// Move a REAL pointer onto an element's centre. A far-away lead-in plus stepped travel guarantees the
// browser dispatches mouseover/pointerover into the element (so React onMouseEnter actually fires),
// instead of relying on a debug accessor to fabricate the hover.
async function realPointerHover(page: Page, testid: string): Promise<boolean> {
  const loc = page.getByTestId(testid);
  if (!(await loc.isVisible().catch(() => false))) return false;
  const box = await loc.boundingBox();
  if (!box) return false;
  await page.mouse.move(4, 4, { steps: 6 });
  await page.waitForTimeout(60);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(160);
  return true;
}

// INDEPENDENT oracle: which enemy tiles does the RULES ENGINE accept for a pulse-rifle shot by this
// unit? (applyAction returns no error for a legal action; that is the honest bar, not the web helper.)
function oracleAttackUnits(state: any, unitId: string, ability: string): string[] {
  const keys: string[] = [];
  for (const e of state.units) {
    if (!e.alive || e.side !== "enemy") continue;
    const r = applyAction(state, { kind: "attack", unitId, ability, targetUnitId: e.id } as any);
    if (!r.error) keys.push(`${e.pos.x},${e.pos.y}`);
  }
  return [...new Set(keys)].sort();
}

test("REACH — hovering the rifle button with a REAL pointer highlights exactly the rules-accepted targets", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");

  // Select the vanguard by a real squad-row click so its ability card (and rifle) render.
  await page.getByTestId("squad-p_vanguard_0").click();
  await page.waitForTimeout(250);

  // Baseline: nothing highlighted before the pointer ever touches the ability.
  expect(await targetKeys(page), "no highlight before a real hover").toEqual([]);

  // Real pointer onto the rifle (ability-0). This is the whole point: the SAME behaviour the debug hook
  // used to fake must now occur from an actual mouse move.
  const hovered = await realPointerHover(page, "ability-0");
  expect(hovered, "rifle button has a box to hover with a real pointer").toBe(true);

  const keys = await targetKeys(page);
  const snap = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    return JSON.parse(JSON.stringify(g.debugState()));
  });
  const oracle = oracleAttackUnits(snap, "p_vanguard_0", "pulse_rifle");
  console.log(`[REACH ATTACK] realPointerHighlight=${JSON.stringify(keys)} rulesAccepted=${JSON.stringify(oracle)}`);

  // The real-pointer highlight must equal the independent rules set and be non-trivial (>=2), i.e. it is
  // not the empty result the shipped bug produced.
  expect(keys, `real-pointer highlight must equal the rules-accepted set — rules say ${JSON.stringify(oracle)}`).toEqual(oracle);
  expect(keys.length, "non-trivial: a real hover lights several enemy tiles").toBeGreaterThanOrEqual(2);

  // Negative directions: allies and out-of-range enemies must never be lit by the rifle.
  const allyTiles = await page.evaluate(() => {
    const s = (window as unknown as { __sbGame: any }).__sbGame.debugState();
    return s.units.filter((u: any) => u.alive && u.side === "player").map((u: any) => `${u.pos.x},${u.pos.y}`);
  });
  for (const t of allyTiles) expect(keys, `ally tile ${t} must NOT be lit by an attack`).not.toContain(t);
});

test("REACH — moving the real pointer OFF the ability button clears the highlight", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  await page.getByTestId("squad-p_vanguard_0").click();
  await page.waitForTimeout(250);

  // Arm the highlight by a real hover, then verify it is actually lit before we test the clear.
  await realPointerHover(page, "ability-0");
  const lit = await targetKeys(page);
  expect(lit.length, "the highlight is present after the real hover").toBeGreaterThanOrEqual(2);

  // Move the real pointer away from the ability (down to the open board). mouseleave must clear it.
  await page.mouse.move(640, 360, { steps: 8 });
  await page.waitForTimeout(200);
  const cleared = await targetKeys(page);
  console.log(`[REACH CLEAR] afterUnhover=${JSON.stringify(cleared)}`);
  expect(cleared, "highlight cleared when the real pointer leaves the ability").toEqual([]);
});