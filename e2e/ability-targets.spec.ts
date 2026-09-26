// ABILITY-TARGETING evidence (BROWSER, c-ability-targets-e2e).
//
// The subject is the ability-target HIGHLIGHT (the tiles drawn under an ability while it is hovered,
// and while a targeted ability is armed). The honesty bar: the highlighted set is compared to a set
// computed INDEPENDENTLY of the app's own marker list — here the RULES ENGINE itself. `applyAction`
// from @sb/sim returns an `error` for an ILLEGAL action; an ability is "accepted against a candidate"
// when applyAction comes back with NO error. We enumerate candidates and ask the reducer. That holds
// the highlight to the actual rules, not to the web layer's legalTargetsFor helper (which would be
// checking the implementation against itself).
//
// Three required cases on the mission-3 (Core Chamber) fixture, seeded so the layout is fixed:
//   * ATTACK (units):   p_vanguard_0 / pulse_rifle  -> enemy units in range+LOS
//   * SUPPORT (allies): p_cipher_2   / barrier       -> allied operatives only (never enemies)
//   * DEVICE (not units): p_cipher_2 / remote_hack    -> device/area tiles (never units)
// plus negative directions: out-of-range enemies are NOT highlighted; allies are NOT highlighted by an
// attack; units are NOT highlighted by a device ability.
//
// Interaction is driven through the deterministic seams the app exposes (debugHoverAbility /
// debugArmAbility / debugClickTile / debugSelect), which route through the SAME code a live pointer/key
// uses; there is no DOM hover affordance for abilities, so hover is exercised via that hook.
import { test, expect } from "@playwright/test";
import { applyAction } from "../packages/sim/src/state.ts";

type Page = import("@playwright/test").Page;

async function deploy(page: Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  const dismiss = page.getByTestId("dismiss-onboarding");
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});
  await page.waitForTimeout(1500);
}

// The live highlighted target-tile set as drawn by the renderer (world.debugAbilityTargets via
// window.__sbTargetKeys). "x,y" tile keys — the same shape the oracle produces.
async function targetKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => [...new Set((window as unknown as { __sbTargetKeys?: () => string[] }).__sbTargetKeys!())].sort());
}

// Read the authoritative state (for the rules oracle) plus the current armed ability state.
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    // A structurally-cloned snapshot keeps the Node-side oracle from mutating the live state.
    return { state: JSON.parse(JSON.stringify(s)), armed: g.debugArmed(), revision: s.revision as number };
  });
}

// --- INDEPENDENT oracle: the rules engine, not the helper ------------------------------
// For an ATTACK ability, candidate = every living enemy; a candidate is "accepted" when applyAction of
// that attack returns no error. Returns the tile keys the rules accept.
function oracleAttackUnits(state: any, unitId: string, ability: string) {
  const keys: string[] = [];
  const detail: string[] = [];
  for (const e of state.units) {
    if (!e.alive || e.side !== "enemy") continue;
    const cheb = Math.max(Math.abs(e.pos.x - (state.units.find((u: any) => u.id === unitId).pos.x)), Math.abs(e.pos.y - (state.units.find((u: any) => u.id === unitId).pos.y)));
    const r = applyAction(state, { kind: "attack", unitId, ability, targetUnitId: e.id } as any);
    detail.push(`${e.id}@${e.pos.x},${e.pos.y} cheb=${cheb} error=${r.error ?? "NONE"}`);
    if (!r.error) keys.push(`${e.pos.x},${e.pos.y}`);
  }
  return { keys: [...new Set(keys)].sort(), detail };
}

// For a SUPPORT ability that shields allies, candidate = every living friendly (incl. self); accepted
// when applying it with that ally as the target returns no error.
function oracleAllySupport(state: any, unitId: string, ability: string) {
  const keys: string[] = [];
  const detail: string[] = [];
  for (const a of state.units) {
    if (!a.alive || a.side !== state.units.find((u: any) => u.id === unitId).side) continue;
    const r = applyAction(state, { kind: "ability", unitId, ability, targetUnitId: a.id } as any);
    detail.push(`${a.id}@${a.pos.x},${a.pos.y} error=${r.error ?? "NONE"}`);
    if (!r.error) keys.push(`${a.pos.x},${a.pos.y}`);
  }
  return { keys: [...new Set(keys)].sort(), detail };
}

// For a DEVICE/area ability, candidate = every device; accepted when applying it AT that device's tile
// (as a targetPos, the shape the reducer consumes) returns no error.
function oracleDeviceTargets(state: any, unitId: string, ability: string) {
  const keys: string[] = [];
  const detail: string[] = [];
  for (const d of state.devices) {
    const r = applyAction(state, { kind: "ability", unitId, ability, targetPos: { x: d.x, y: d.y, h: 0 } } as any);
    detail.push(`${d.kind}@${d.x},${d.y} error=${r.error ?? "NONE"}`);
    if (!r.error) keys.push(`${d.x},${d.y}`);
  }
  return { keys: [...new Set(keys)].sort(), detail };
}

const tileOf = (page: Page, id: string) => page.evaluate((pid) => {
  const s = (window as unknown as { __sbGame: any }).__sbGame.debugState();
  const u = s.units.find((x: any) => x.id === pid);
  return u ? `${u.pos.x},${u.pos.y}` : "";
}, id);

test("ATTACK — hovering the rifle highlights exactly the enemies the rules engine accepts; unhover clears", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  // Select the vanguard (a real squad-list click) so its ability card is shown.
  await page.getByTestId("squad-p_vanguard_0").click();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugArmed()), "starts unarmed").toBeNull();

  // Hover the rifle (index 0): the preview highlight must equal the rules-accepted enemy set.
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugHoverAbility(0));
  const keys = await targetKeys(page);
  const snap = await snapshot(page);
  const oracle = oracleAttackUnits(snap.state, "p_vanguard_0", "pulse_rifle");
  console.log(`[TARGETS ATTACK] highlight=${JSON.stringify(keys)} rulesAccepted=${JSON.stringify(oracle.keys)}\n  ${oracle.detail.join(" | ")}`);
  expect(keys, `highlight must equal the rules-accepted set — rules say ${JSON.stringify(oracle.keys)}`).toEqual(oracle.keys);
  expect(keys.length, "non-trivial: several enemy tiles highlighted").toBeGreaterThanOrEqual(2);

  // Negative direction: allies and out-of-range enemies are NOT highlighted.
  const allyTiles = [await tileOf(page, "p_ghost_1"), await tileOf(page, "p_cipher_2"), await tileOf(page, "p_vanguard_0")];
  for (const t of allyTiles) expect(keys, `ally tile ${t} must NOT be highlighted by an attack`).not.toContain(t);
  for (const t of ["2,4", "11,4", "5,4", "8,4"]) expect(keys, `out-of-range enemy tile ${t} must NOT be highlighted`).not.toContain(t);

  // Unhover clears.
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugUnhoverAbility());
  const cleared = await targetKeys(page);
  expect(cleared, "highlight cleared on unhover").toEqual([]);
});

test("ARM/USE — clicking the targeted ability arms it (highlight persists), a target click uses it, Esc + reselect cancel", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  const armed = () => page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugArmed());
  // (Re)select the vanguard and arm the rifle by a real DOM click on its button. Selecting first is
  // required: Esc deselects, which removes the ability card entirely.
  const armRifle = async () => {
    await page.getByTestId("squad-p_vanguard_0").click();
    await page.waitForTimeout(200);
    await page.getByTestId("ability-0").click();
    await page.waitForTimeout(150);
  };

  await page.getByTestId("squad-p_vanguard_0").click();
  await page.waitForTimeout(250);

  // ARM by CLICKING the rifle button (real DOM click -> abilityByIndex).
  await page.getByTestId("ability-0").click();
  await page.waitForTimeout(150);
  expect(await armed(), "a targeted ability is armed after clicking it").not.toBeNull();
  const armedKeys = await targetKeys(page);
  const armedNow = await armed();
  expect(armedNow!.keys.length, "armed highlight persists (targets still shown)").toBeGreaterThanOrEqual(2);
  expect(armedKeys, "the persisted highlight equals the armed target set").toEqual([...armedNow!.keys].sort());

  // USE it on a highlighted target through the board-click path; a LEGAL target resolves the action.
  const before = await snapshot(page);
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugClickTile(2, 8));
  await page.waitForTimeout(200);
  const after = await snapshot(page);
  expect(after.revision, "clicking a legal highlighted target executed the ability (state changed)").toBeGreaterThan(before.revision);
  expect(await armed(), "armed state cleared once used").toBeNull();
  expect(await targetKeys(page), "highlight cleared once the ability resolved").toEqual([]);

  // Re-arm, then ESC must cancel the arm + clear the highlight.
  await armRifle();
  expect(await armed(), "re-armed").not.toBeNull();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  expect(await armed(), "Esc cancels the arm").toBeNull();
  expect(await targetKeys(page), "Esc clears the highlight").toEqual([]);

  // Re-arm, then selecting a DIFFERENT operative must cancel the arm + clear the highlight.
  await armRifle();
  expect(await armed(), "re-armed again").not.toBeNull();
  await page.getByTestId("squad-p_ghost_1").click();
  await page.waitForTimeout(150);
  expect(await armed(), "selecting another operative cancels the arm").toBeNull();
  expect(await targetKeys(page), "selecting another operative clears the highlight").toEqual([]);
});

test("SUPPORT — barrier highlights only allied operatives (never enemies) and equals the rules-accepted set", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");
  await page.getByTestId("squad-p_cipher_2").click();
  await page.waitForTimeout(250);

  // barrier is index 3 for the cipher kit.
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugHoverAbility(3));
  const keys = await targetKeys(page);
  const snap = await snapshot(page);
  const oracle = oracleAllySupport(snap.state, "p_cipher_2", "barrier");
  console.log(`[TARGETS SUPPORT] highlight=${JSON.stringify(keys)} rulesAccepted(allies)=${JSON.stringify(oracle.keys)}\n  ${oracle.detail.join(" | ")}`);
  expect(keys, `highlight must equal the rules-accepted ally set — rules say ${JSON.stringify(oracle.keys)}`).toEqual(oracle.keys);

  // Negative direction: NO enemy tile is ever a support-target tile.
  const enemyTiles = await page.evaluate(() => {
    const s = (window as unknown as { __sbGame: any }).__sbGame.debugState();
    return s.units.filter((u: any) => u.alive && u.side === "enemy").map((u: any) => `${u.pos.x},${u.pos.y}`);
  });
  for (const t of enemyTiles) expect(keys, `enemy tile ${t} must NOT be a support target`).not.toContain(t);
  // And every highlighted tile IS an allied operative tile (self included), i.e. it targets allies.
  const allyTiles = await page.evaluate(() => {
    const s = (window as unknown as { __sbGame: any }).__sbGame.debugState();
    return s.units.filter((u: any) => u.alive && u.side === "player").map((u: any) => `${u.pos.x},${u.pos.y}`);
  });
  for (const k of keys) expect(allyTiles, `support highlight ${k} is an ally tile`).toContain(k);

  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugUnhoverAbility());
});

test("DEVICE — remote_hack targets DEVICE tiles (never units) and equals the rules-accepted set", async ({ page }) => {
  await deploy(page, "/?mission=3&seed=4242");

  // Scenario construction for the device case: at the cipher's spawn tile no device is in range, so the
  // device-targeting highlight is empty and would not be observable. We reposition the cipher INTO the
  // central device cluster (a fixture placement, not a rules change) and then compare the highlight to
  // the rules engine applied to THAT EXACT repositioned state — still an independent oracle.
  const placed = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const c = g.debugState().units.find((u: any) => u.id === "p_cipher_2");
    c.pos.x = 6; c.pos.y = 9; // central cluster: node + two turrets + camera
    g.select("p_cipher_2");
    return { x: 6, y: 9 };
  });
  expect(placed).toEqual({ x: 6, y: 9 });
  await page.waitForTimeout(200);

  // remote_hack is index 1 for the cipher kit.
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugHoverAbility(1));
  const keys = await targetKeys(page);
  const snap = await snapshot(page);
  const oracle = oracleDeviceTargets(snap.state, "p_cipher_2", "remote_hack");
  console.log(`[TARGETS DEVICE] highlight=${JSON.stringify(keys)} rulesAccepted(devices)=${JSON.stringify(oracle.keys)}\n  ${oracle.detail.join(" | ")}`);
  expect(keys.length, "non-trivial device highlight").toBeGreaterThanOrEqual(2);
  expect(keys, `device highlight must equal the rules-accepted device set — rules say ${JSON.stringify(oracle.keys)}`).toEqual(oracle.keys);

  // Negative direction: a device ability must NOT highlight any unit tile (it targets devices, not units),
  // and must never highlight an enemy.
  const unitTiles = await page.evaluate(() => {
    const s = (window as unknown as { __sbGame: any }).__sbGame.debugState();
    return s.units.filter((u: any) => u.alive).map((u: any) => `${u.pos.x},${u.pos.y}`);
  });
  for (const k of keys) expect(unitTiles, `device highlight ${k} is NOT a unit tile (it targets devices)`).not.toContain(k);

  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugUnhoverAbility());
});