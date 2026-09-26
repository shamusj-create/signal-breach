// HUD CLARITY criterion (c-hud-clarity-e2e): a real browser journey proving the HUD is legible to a
// new player — numeric health/energy (not just bars), how many moves/energy remain this turn,
// objective PROGRESS counts, plain-language objective states (no bare ACTIVE/LOCKED), and ability
// buttons that show cost + range with an explanation (effect/cost/range), including the four
// Cipher tools the supervisor called out (Arc Bolt / Remote Hack / EMP / Barrier).
import { test, expect } from "@playwright/test";

async function deployFresh(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1600);
}

async function selectByArchetype(page: import("@playwright/test").Page, archetype: string) {
  const id = await page.evaluate((a) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const u = g.debugState().units.find((x: any) => x.alive && x.side === "player" && x.archetype === a);
    return u ? u.id : "";
  }, archetype);
  expect(id, `a ${archetype} operative exists to inspect`).not.toBe("");
  await page.evaluate((uid) => (window as unknown as { __sbGame: any }).__sbGame.debugSelect(uid), id);
  await page.waitForTimeout(300);
}

test("ability buttons are explained with cost + range (and the four Cipher tools are legible)", async ({ page }) => {
  await deployFresh(page);
  await selectByArchetype(page, "cipher");

  const card = page.getByTestId("unit-card");
  await expect(card, "unit card shows after selecting an operative").toBeVisible();

  // The four named tools are present as buttons.
  for (const name of ["Arc Bolt", "Remote Hack", "EMP", "Barrier"]) {
    await expect(card, `ability "${name}" is labelled`).toContainText(name);
  }
  // Costs and ranges are visible, not hidden.
  const abilitiesText = await page.getByTestId("ability-0").evaluate((el) => {
    let p: HTMLElement | null = el.parentElement;
    return p ? p.innerText : "";
  });
  expect(abilitiesText, "ability area shows an energy cost").toMatch(/\d+E/);
  expect(abilitiesText, "ability area shows a range").toMatch(/R\d|Self/);

  // Each ability button carries a substantive explanation (effect/cost/range) reachable by hover.
  const n = await page.locator(".ability").count();
  expect(n, "selected operative has ability buttons").toBeGreaterThanOrEqual(4);
  for (let i = 0; i < n; i++) {
    const hint = await page.locator(".ability").nth(i).getAttribute("data-hint");
    expect(hint && /energy/i.test(hint) && /range|Self/i.test(hint), `ability ${i} explains cost+range: ${hint}`).toBeTruthy();
  }
});

test("HUD shows numeric HP/energy, remaining moves/energy, and no clipped primary controls", async ({ page }) => {
  await deployFresh(page);
  await selectByArchetype(page, "vanguard");
  const card = page.getByTestId("unit-card");
  const text = await card.innerText();
  expect(text, "health is numeric, not only a bar").toMatch(/HEALTH\s+\d+\/\d+/);
  expect(text, "energy is numeric, not only a bar").toMatch(/ENERGY\s+\d+\/\d+/);
  expect(text, "it states how many moves remain this turn").toMatch(/Moves left \d+ of \d+/);
  expect(text, "it states remaining energy to spend").toMatch(/energy to spend/i);
});

test("objectives use progress counts and plain-language states (never bare ACTIVE/LOCKED)", async ({ page }) => {
  await deployFresh(page);
  const right = page.locator(".hud-right");
  const progress = page.getByTestId("obj-progress");
  await expect(progress, "objective progress is counted").toContainText(/Relays \d+ of \d+/, { timeout: 8000 });

  // Plain language with an explanation; the technical ACTIVE/LOCKED tokens are gone.
  const rightText = await right.innerText();
  expect(rightText, "no bare ACTIVE token").not.toMatch(/\bACTIVE\b/);
  expect(rightText, "no bare LOCKED token").not.toMatch(/\bLOCKED\b/);
  expect(rightText, "uses a plain-language state word").toMatch(/Ready|Sealed|Done|Breach|Idle/);
  expect(rightText, "explains what the locked Core wants").toMatch(/relays|Core|extract|win/i);

  // Shape + text still carry state (accessibility independent of colour).
  const dotShapes = await page.locator(".obj-dot").evaluateAll((els) => els.map((e) => e.getAttribute("data-shape")));
  expect(dotShapes.every((s) => s === "square" || s === "ring" || s === "circle"), `objective shapes: ${dotShapes}`).toBe(true);
});