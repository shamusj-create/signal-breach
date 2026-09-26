// NO-SILENT-FEEDBACK evidence (BROWSER, c-no-silent-feedback-e2e).
//
// Oracle, not a string list: after each action we compare the AUTHORITATIVE state delta against the
// user-visible text delta and FAIL if the state changed while the visible text did not (a silent change).
// It also proves refusals are explained in VISIBLE TEXT with audio MUTED (a sound-only refusal, or a
// deaf player with sound off, still gets an explanation). Everything is driven by real pointer / control
// clicks; the truth is read from the sim (__sbHash of debugState), not from a presentation accessor.
import { test, expect } from "@playwright/test";

type Page = import("@playwright/test").Page;

async function deploy(page: Page, url: string, audioMuted = false) {
  await page.addInitScript((muted) => {
    try {
      localStorage.setItem("sb.onboarding.seen.v2", "1");
      if (muted) localStorage.setItem("signal-breach-audio-v1", JSON.stringify({ muted: true }));
      // Instrument audio so we can prove a refusal did not rely on sound (muted => zero playback).
      (window as unknown as { __sfx: number }).__sfx = 0;
      const AC = (window as unknown as { AudioContext?: { prototype: { createBufferSource: () => unknown } } }).AudioContext;
      if (AC) {
        const orig = AC.prototype.createBufferSource;
        (AC.prototype as unknown as { createBufferSource: (...a: unknown[]) => unknown }).createBufferSource = function (...a: unknown[]) {
          (window as unknown as { __sfx: number }).__sfx++;
          return orig.call(this) as unknown;
        };
      }
    } catch {
      /* ignore */
    }
  }, audioMuted);
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
}

const stateHash = (page: Page) =>
  page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    return (window as unknown as { __sbHash: (s: unknown) => string }).__sbHash(g.debugState());
  });
const sfxCount = (page: Page) => page.evaluate(() => (window as unknown as { __sfx: number }).__sfx);
// User-visible text = the RENDERED commentary pane (not the game's internal feed array), so the oracle
// compares authoritative state against what a player actually sees.
const feedText = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-testid="commentary-pane"]');
    return pane ? (pane.innerText || "") : "«no commentary pane»";
  });

// The whole point of the oracle: a change in AUTHORITATIVE state must coincide with a change in
// USER-VISIBLE text. Returns whether state changed, so the caller can require real coverage.
async function oracleStep(page: Page, label: string, action: () => Promise<void>): Promise<boolean> {
  const h0 = await stateHash(page);
  const t0 = await feedText(page);
  await action();
  await page.waitForTimeout(250);
  const h1 = await stateHash(page);
  const t1 = await feedText(page);
  const changed = h0 !== h1;
  if (changed) {
    expect(t1, `${label}: authoritative state changed but the commentary feed did NOT (silent change)`).not.toBe(t0);
  }
  console.log(`[ORACLE ${label}] stateChanged=${changed} feedChanged=${t0 !== t1}`);
  return changed;
}

// A real, independent plan: a player operative, a reachable empty destination with clear canvas points,
// and an enemy that (from that destination) is shootable — all with verified non-HUD pointer points.
function computePlan(page: Page) {
  return page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const state = g.debugState();
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const cam = w.camera;
    cam.updateMatrixWorld(true);
    const reach = (window as unknown as { __sbReachableCells: any }).__sbReachableCells;
    const pts = (tx: number, ty: number) => {
      const base = w.tileToWorld({ x: tx, y: ty, h: 0 });
      base.y = 0;
      const out: { x: number; y: number }[] = [];
      for (const [ox, oy] of [[0, 0], [0, 7], [0, -7], [7, 0], [-7, 0]] as const) {
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
    };
    const players = state.units.filter((u: any) => u.alive && u.side === "player");
    for (const u of players) {
      const cells = reach(state, u);
      const fromKey = `${u.pos.x},${u.pos.y}`;
      for (const k of cells.keys()) {
        if (k === fromKey) continue;
        const [xs, ys] = k.split(",");
        const dx = Number(xs);
        const dy = Number(ys);
        if (state.units.some((o: any) => o.alive && o.pos.x === dx && o.pos.y === dy)) continue;
        const destPoints = pts(dx, dy);
        if (destPoints.length < 2) continue;
        const enemy = state.units.find((e: any) => e.alive && e.side === "enemy" && Math.max(Math.abs(e.pos.x - dx), Math.abs(e.pos.y - dy)) <= (u.atkRange ?? 3));
        if (!enemy) continue;
        const enemyPoints = pts(enemy.pos.x, enemy.pos.y);
        if (enemyPoints.length < 2) continue;
        return { unitId: u.id, unitName: u.name, dest: { x: dx, y: dy }, destPoints, enemyId: enemy.id, enemyPoints };
      }
    }
    return null;
  });
}

test("ORACLE — no state change is left unexplained: move, shot, camera, tabs and the enemy phase", async ({ page }) => {
  let plan = null as Awaited<ReturnType<typeof computePlan>> | null;
  let usedSeed = 0;
  for (const seed of [4242, 9, 7, 4243]) {
    await deploy(page, `/?seed=${seed}`);
    plan = await computePlan(page);
    if (plan) {
      usedSeed = seed;
      break;
    }
  }
  expect(plan, `no mouse-reachable move+shoot plan found (seeds 4242/9/7/4243; last ${usedSeed})`).not.toBeNull();
  const p = plan as NonNullable<Awaited<ReturnType<typeof computePlan>>>;

  // Select the operative with a REAL squad-row click. The squad list lives in the (default) Objectives
  // tab, so select here BEFORE switching the panel to Commentary so the oracle can read the feed.
  await page.getByTestId(`squad-${p.unitId}`).click();
  await page.waitForTimeout(300);
  await page.getByTestId("tab-commentary").click();
  await page.waitForTimeout(150);

  // (A) MOVE — a real board click must both change the board AND narrate it.
  const moved = await oracleStep(page, "move", async () => {
    await page.mouse.click(p.destPoints[0].x, p.destPoints[0].y);
    await page.waitForTimeout(1400);
  });
  expect(moved, "the move actually changed authoritative state (real coverage)").toBe(true);

  // (B) SHOT — a real board click on the enemy. Whether it lands (state change → must be narrated) or
  // is refused (no state change), the oracle invariant must hold. The move + enemy phase already
  // guarantee real state-change coverage, so this step asserts the invariant, not a specific delta.
  await oracleStep(page, "shot", async () => {
    await page.mouse.click(p.enemyPoints[0].x, p.enemyPoints[0].y);
    await page.waitForTimeout(500);
  });

  // (C) CAMERA — must NOT change authoritative state; if it ever did, the feed would have to change.
  await oracleStep(page, "camera", async () => {
    await page.getByTestId("rotate-right").click();
    await page.waitForTimeout(150);
    await page.getByTestId("zoom-out").click();
    await page.waitForTimeout(150);
    await page.getByTestId("cam-reset").click();
    await page.waitForTimeout(200);
  });

  // (D) TABS — switching the right panel is not a state change; assert the invariant + the panes swap.
  await oracleStep(page, "tabs", async () => {
    await page.getByTestId("tab-objectives").click();
    await page.waitForTimeout(150);
    await page.getByTestId("tab-commentary").click();
    await page.waitForTimeout(150);
  });

  // (E) ENEMY PHASE — repeated End Turns let the security AI actually act; every system change must be
  // narrated in the feed (this is the "no silent system change" bar).
  let sawPhaseChange = false;
  for (let i = 0; i < 3; i++) {
    const phaseChanged = await oracleStep(page, `enemy-phase-${i}`, async () => {
      const isPlayer = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugState().phase);
      if (isPlayer !== "player") return;
      await page.getByTestId("end-turn").click();
      await page.waitForTimeout(900);
    });
    if (phaseChanged) sawPhaseChange = true;
  }
  expect(sawPhaseChange, "at least one End Turn produced a system-driven state change that had to be narrated").toBe(true);
});

test("FEEDBACK — a refusal is explained in VISIBLE TEXT with audio MUTED (a sound-only refusal fails)", async ({ page }) => {
  // Audio muted: playSfx early-returns for every cue, so the ONLY thing that can inform the player is
  // the visible message. We also count audio buffer creations and require zero for the refusal.
  await deploy(page, "/?mission=3&seed=4242", true);
  const sel = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const me = s.units.find((x: any) => x.alive && x.side === "player" && x.archetype === "vanguard") ?? s.units.find((x: any) => x.alive && x.side === "player");
    if (!me) return null;
    g.debugSelect(me.id);
    // An enemy the selected operative CANNOT shoot (out of its range) → a refusal, not an action.
    const enemy = s.units.find((e: any) => e.alive && e.side === "enemy" && Math.max(Math.abs(e.pos.x - me.pos.x), Math.abs(e.pos.y - me.pos.y)) > (me.atkRange ?? 3));
    if (!enemy) return null;
    return { meId: me.id, atkRange: me.atkRange, enemy: { id: enemy.id, x: enemy.pos.x, y: enemy.pos.y } };
  });
  expect(sel, "fixture has a selected operative and an out-of-range enemy to refuse").not.toBeNull();
  const s = sel as NonNullable<typeof sel>;
  await page.waitForTimeout(300);

  // Re-select with a REAL squad-row click (the debugSelect above only locates the fixture).
  await page.getByTestId(`squad-${s.meId}`).click();
  await page.waitForTimeout(250);
  const hashBefore = await stateHash(page);

  // Find a canvas-safe real-pointer point on the out-of-range enemy and click it → refused.
  const pts = await page.evaluate(
    ([ex, ey]) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const cam = w.camera;
      cam.updateMatrixWorld(true);
      const base = w.tileToWorld({ x: ex, y: ey, h: 0 });
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
        if (!hit || hit.x !== ex || hit.y !== ey) continue;
        const top = document.elementFromPoint(px, py);
        if (!top || top.tagName !== "CANVAS") continue;
        out.push({ x: +px.toFixed(1), y: +py.toFixed(1) });
      }
      return out;
    },
    [s.enemy.x, s.enemy.y] as const,
  );
  expect(pts.length, "the refused enemy has a canvas-safe real-pointer point").toBeGreaterThan(0);

  await page.mouse.click(pts[0].x, pts[0].y);
  await page.waitForTimeout(300);

  // The refusal must be explained VISIBLELY (this is what a sound-only implementation could never do).
  const notice = page.getByTestId("action-notice");
  await expect(notice, "a refusal shows a visible explanation").toBeVisible({ timeout: 4000 });
  const text = await notice.innerText();
  console.log(`[REFUSAL muted] message="${text}" sfxCalls=${await sfxCount(page)}`);
  expect(text, "the refusal states a reason").toMatch(/out of range|no line of sight|Cannot shoot/i);

  // It stayed muted throughout: zero audio buffers were created, so the message is NOT just a sound.
  expect(await sfxCount(page), "no audio was produced while muted (the explanation is visual, not a sound)").toBe(0);

  // And a refusal is not a silent state change: the board did not change, yet the player was told why.
  const hashAfter = await stateHash(page);
  expect(hashAfter, "a refusal must not silently mutate the authoritative state").toBe(hashBefore);
});