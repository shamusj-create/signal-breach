// AI candidate debug-preview journey (BROWSER / INTEGRATION-class evidence).
//
// The debug overlay is OFF by default; when ON it renders a CURRENT-STATE preview of the enemy
// candidate scores, limited to currently-visible living enemies, produced by a NON-MUTATING
// readout of the shared simulator. These tests verify: (1) it is gated OFF by default; (2) with
// debug ON the rendered rows match an INDEPENDENT oracle recomputed from the raw shared sim
// functions (window.__sbAiCandidates / __sbReachableCells) — we do NOT trust the display; (3) a
// state TRANSITION re-derives the rows from current state via the authoritative state-change
// channel, NOT from a fixed timer; (4) reading/rendering the preview does not mutate the separate
// client actionLog, revision, or serialized state over a NON-EMPTY action history; (5) the bounded
// preview never overlaps the HUD/controls at 1280x720 and 1024x768 in BOTH the unselected and a
// selected-operative HUD state, with no text clipping; (6) deterministic across identical seeds.
// No simulation rules / PRNG / replay are exercised.
import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

async function deploy(page: import("@playwright/test").Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1700);
}

// Advance through the SAME authoritative action path until at least one enemy is currently visible
// (deterministic; no Math.random). Also lets the transition-driven preview re-derive to that state.
async function exposeEnemy(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame?: any }).__sbGame;
    for (let i = 0; i < 30; i++) {
      const s = g.debugState();
      const vis = s.units.filter((u: any) => u.alive && u.side === "enemy" && s.vis[u.pos.y * 14 + u.pos.x] === 2).length;
      if (vis >= 1) break;
      g.debugTryOneAction();
    }
  });
}

function overlaps(a?: number[] | null, b?: number[] | null) {
  if (!a || !b) return false;
  return !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3]);
}

async function dumpEvidence(file: string, data: unknown) {
  const p = `artifacts/${file}`;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}

// Live geometry probe: bounding rects of the preview and the four HUD regions, plus a clipping
// signal (scrollHeight vs clientHeight) and the viewport size, read in one shot.
function probeGeometry() {
  const rect = (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  };
  const pv = document.querySelector('[data-testid="ai-preview"]') as HTMLElement | null;
  const pr = pv ? pv.getBoundingClientRect() : null;
  return {
    preview: rect('[data-testid="ai-preview"]'),
    unitCard: rect(".unit-card"),
    hudTop: rect(".hud-top"),
    objPanel: rect(".hud-right"),
    controls: rect(".hud-bottom"),
    clip: pv ? { scrollH: pv.scrollHeight, clientH: pv.clientHeight } : null,
    bottom: pr ? Math.round(pr.bottom) : -1,
    right: pr ? Math.round(pr.right) : -1,
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}

test("AI preview is debug-gated: absent by default even while playing", async ({ page }) => {
  await deploy(page, "/?seed=4242");
  await expect(page.getByTestId("ai-preview")).toHaveCount(0);
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame?: any }).__sbGame;
    for (let i = 0; i < 4; i++) g.debugTryOneAction();
  });
  await expect(page.getByTestId("ai-preview")).toHaveCount(0);
});

test("debug-on preview matches an independent oracle and excludes hidden enemies", async ({ page }) => {
  await deploy(page, "/?seed=4242&mission=3&debug=1");
  await exposeEnemy(page);
  const res = await page.evaluate(() => {
    const W = window as unknown as { __sbGame: any; __sbAiCandidates: any; __sbReachableCells: any; __sbDecide: any };
    const g = W.__sbGame;
    const s = g.debugState();
    const block = document.querySelector('[data-testid="ai-preview"]');
    const dom = block ? block.textContent || "" : "";
    const domLines = dom.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("EID "));
    // INDEPENDENT oracle: recompute the truth from raw aiCandidates/reachability (not the display).
    const exp: string[] = [];
    const enemies = s.units.filter((u: any) => u.alive && u.side === "enemy").sort((a: any, b: any) => a.id.localeCompare(b.id));
    for (const e of enemies) {
      if (s.vis[e.pos.y * 14 + e.pos.x] !== 2) continue;
      const cands = W.__sbAiCandidates(s, e, W.__sbReachableCells(s, e));
      const ranked = [...cands].sort((a: any, b: any) => {
        if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
        if (a.dbg.exposure !== b.dbg.exposure) return a.dbg.exposure - b.dbg.exposure;
        return a.key < b.key ? -1 : 1;
      });
      const best = ranked[0];
      if (!best) continue;
      exp.push(`EID ${e.id} top=${best.key} s=${best.score.toFixed(3)} n=${cands.length}`);
    }
    const hiddenIds = s.units
      .filter((u: any) => u.alive && u.side === "enemy" && s.vis[u.pos.y * 14 + u.pos.x] !== 2)
      .map((u: any) => u.id);
    const leak = hiddenIds.filter((id: string) => dom.includes(id));
    const ruleMismatch: string[] = [];
    for (const e of enemies) {
      if (s.vis[e.pos.y * 14 + e.pos.x] !== 2) continue;
      const act = W.__sbDecide(s, e, W.__sbReachableCells(s, e))[0];
      if (!act) continue;
      const line = domLines.find((L: string) => L.startsWith(`EID ${e.id} `));
      if (!line) {
        ruleMismatch.push(`${e.id}: no row`);
        continue;
      }
      if (act.targetUnitId && !line.includes(act.targetUnitId)) ruleMismatch.push(`${e.id}: target mismatch`);
    }
    return { domLines, exp, visCount: exp.length, hiddenCount: hiddenIds.length, leak, ruleMismatch };
  });
  expect(res.visCount, `visible enemies ${res.visCount}`).toBeGreaterThanOrEqual(1);
  expect(res.hiddenCount, `hidden enemies ${res.hiddenCount}`).toBeGreaterThanOrEqual(1);
  expect(res.leak, `hidden leaks: ${res.leak.join(",")}`).toEqual([]);
  expect(res.domLines, "display must equal the independent oracle").toEqual(res.exp);
  expect(res.ruleMismatch, `rule mismatch: ${res.ruleMismatch.join("; ")}`).toEqual([]);
  await page.screenshot({ path: "artifacts/ai-preview.png" });
});

// ITEM 2 — the display must re-derive from AUTHORITATIVE STATE on a transition, NOT from a fixed
// timer. Timers are CONTROLLED (Playwright fake clock) and explicitly PAUSED, so the check does not
// depend on a wall-clock race and adds no product instrumentation: BOTH producers are first allowed
// to populate while the clock runs, then the clock is paused so no interval tick can fire unless the
// test explicitly advances it. We then apply a SYNTHETIC presentation-state change (NOT a legal
// gameplay transition): a visible living enemy becomes hidden AND dead, and a previously-hidden
// enemy becomes newly visible. With the timer frozen, a fixed-interval display cannot recompute and
// keeps the stale rows, so the checks below fail FOR THE OLD PRODUCER at the stale-DOM assertion;
// the event-driven display re-derives and passes. The direct state edits are labelled synthetic.
test("preview re-derives on hidden + DEAD transitions via state events (not the 500ms timer)", async ({ page }) => {
  await page.clock.install();
  await page.goto("/?seed=4242&mission=3&debug=1");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });

  // Populate phase: the clock runs (default fake-clock mode fires timers), so a fixed-interval
  // display has time to render too. Expose enemies, then let both displays settle.
  await page.waitForTimeout(800);
  await exposeEnemy(page);
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => (document.querySelector('[data-testid="ai-preview"]')?.textContent || "").includes("EID "), null, { timeout: 8000 });

  // Jump the clock forward AND pause it. A forward jump fires the fixed 500 ms interval at most
  // once, so an interval-based display is populated too (it cannot fail merely for lack of a tick),
  // and a forward target avoids "fast-forward to the past". After this the clock is frozen, so no
  // interval tick can fire unless we explicitly advance it — the timer cannot catch a transition.
  await page.clock.pauseAt(Date.now() + 6000);
  const before = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const dom = document.querySelector('[data-testid="ai-preview"]')?.textContent || "";
    const shown = s.units.filter((u: any) => u.alive && u.side === "enemy" && s.vis[u.pos.y * 14 + u.pos.x] === 2).map((u: any) => u.id);
    return { dom, shown };
  });
  expect(before.shown.length, "baseline must have a visible enemy (display populated)").toBeGreaterThanOrEqual(1);

  // SYNTHETIC presentation-state transition (NOT a legal gameplay transition): a visible living
  // enemy becomes DEAD+hidden, and a previously-hidden enemy becomes newly visible. Then ONE
  // authoritative re-paint via debugRefresh() = the onStateChange channel, exactly what a real
  // action uses. No clock time is consumed by this re-paint.
  const swap = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const cell = (u: any) => u.pos.y * 14 + u.pos.x;
    const shown = s.units.filter((u: any) => u.alive && u.side === "enemy" && s.vis[cell(u)] === 2);
    const hidden = s.units.filter((u: any) => u.alive && u.side === "enemy" && s.vis[cell(u)] !== 2);
    if (shown.length < 1) return { ok: false, reason: "no visible enemy" };
    if (hidden.length < 1) return { ok: false, reason: "no hidden enemy to reveal" };
    const killU = shown[0];
    const revealU = hidden[0];
    killU.alive = false;
    killU.hp = 0;
    s.vis[cell(killU)] = 0;
    s.vis[cell(revealU)] = 2;
    g.debugRefresh();
    return { ok: true, killed: killU.id as string, revealed: revealU.id as string };
  });
  expect(swap.ok, `transition precondition: ${swap.reason}`).toBe(true);

  // The clock is FROZEN: a fixed-interval display cannot fire the 500 ms recompute, so it must keep
  // the stale rows (the now-dead/hidden enemy lingers). Give the event display real time to commit;
  // this real-time wait does NOT advance the paused clock, so a fixed-interval display cannot tick.
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const W = window as unknown as { __sbGame: any; __sbAiCandidates: any; __sbReachableCells: any };
    const g = W.__sbGame;
    const s = g.debugState();
    const dom = document.querySelector('[data-testid="ai-preview"]')?.textContent || "";
    const domLines = dom.split("\n").map((x: string) => x.trim()).filter((x: string) => x.startsWith("EID "));
    const exp: string[] = [];
    const enemies = s.units.filter((u: any) => u.alive && u.side === "enemy" && s.vis[u.pos.y * 14 + u.pos.x] === 2).sort((a: any, b: any) => a.id.localeCompare(b.id));
    for (const e of enemies) {
      const cands = W.__sbAiCandidates(s, e, W.__sbReachableCells(s, e));
      const ranked = [...cands].sort((a: any, b: any) => {
        if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
        if (a.dbg.exposure !== b.dbg.exposure) return a.dbg.exposure - b.dbg.exposure;
        return a.key < b.key ? -1 : 1;
      });
      const best = ranked[0];
      if (!best) continue;
      exp.push(`EID ${e.id} top=${best.key} s=${best.score.toFixed(3)} n=${cands.length}`);
    }
    return { dom, domLines, exp };
  });
  // Stale-visible-DOM check (this is exactly where the old 500 ms timer must fail): the frozen
  // interval keeps the now-dead/hidden enemy's row and cannot show the newly-visible one, so the
  // display neither drops the old row nor equals a fresh oracle of the new state.
  expect(after.dom, "dead/hidden enemy row must NOT linger (stale timer keeps it)").not.toContain(swap.killed!);
  expect(after.exp.length, "the new visible set must be non-empty").toBeGreaterThanOrEqual(1);
  expect(after.domLines, "display must equal the fresh independent oracle after the transition").toEqual(after.exp);
});

// ITEM 3 — purity is asserted over the SEPARATE client actionLog (TacticalGame.actionLog), not just
// debugSerialize() (which serializes the sim state). A NON-EMPTY action history makes this
// meaningful: the actionLog, the revision and the serialized state must all be unchanged while the
// pure preview readout is hammered and the display re-renders, with NO new game action.
test("reading/rendering the preview leaves the non-empty actionLog, revision and state unchanged", async ({ page }) => {
  await deploy(page, "/?seed=4242&debug=1");
  // Build a NON-EMPTY action history through the authoritative action path (endTurn pushes actions).
  const built = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.debugTryOneAction();
    for (let i = 0; i < 3 && g.state.phase === "player" && !g.state.gameOver; i++) g.endTurn();
    return { logLen: g.actionLog.length, rev: g.state.revision };
  });
  expect(built.logLen, "action history must be non-empty for this check to be meaningful").toBeGreaterThan(0);
  const purity = await page.evaluate(async () => {
    const W = window as unknown as { __sbGame: any; __sbAiPreview: any };
    const g = W.__sbGame;
    const logBefore = JSON.stringify(g.actionLog);
    const stateBefore = g.debugSerialize();
    const revBefore = g.state.revision;
    // hammer the pure readout + force a re-render via the notification path, with NO new action
    for (let i = 0; i < 80; i++) {
      const s = g.debugState();
      W.__sbAiPreview(s);
      W.__sbAiPreview(s);
    }
    g.debugRefresh();
    await new Promise((r) => setTimeout(r, 500));
    return { logBefore, stateBefore, revBefore, logAfter: JSON.stringify(g.actionLog), stateAfter: g.debugSerialize(), revAfter: g.state.revision, logLen: g.actionLog.length };
  });
  expect(purity.logLen, "action history still non-empty after reading the preview").toBeGreaterThan(0);
  expect(purity.logAfter, "the separate actionLog array must be unchanged while reading the preview").toEqual(purity.logBefore);
  expect(purity.revAfter, "revision must be unchanged while reading the preview").toEqual(purity.revBefore);
  expect(purity.stateAfter, "serialized state must be unchanged while reading the preview").toEqual(purity.stateBefore);
});

// ITEM 1 — the bounded, viewport-independent preview column must NOT intersect the top HUD strip,
// the LEFT unit-card (in BOTH the unselected state and a SELECTED-operative state, whose card is
// much taller), the right objective panel, or the bottom controls, at both requested viewports, and
// must not clip its own text. Both populated previews are checked with a living operative selected
// and with nothing selected.
for (const vp of [
  { w: 1280, h: 720 },
  { w: 1024, h: 768 },
]) {
  test(`bounded preview does not overlap the (expanded) HUD at ${vp.w}x${vp.h}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await deploy(page, "/?seed=4242&mission=3&debug=1");
    await exposeEnemy(page);
    await page.waitForFunction(() => (document.querySelector('[data-testid="ai-preview"]')?.textContent || "").includes("EID "), null, { timeout: 6000 });

    const checkNoClash = async (label: string) => {
      const g = await page.evaluate(probeGeometry);
      const clash = ["unitCard", "hudTop", "objPanel", "controls"].filter((k) => overlaps(g.preview, (g as any)[k]));
      // no clipping: the panel's content fits its box, and the panel stays inside the viewport.
      const clip = !!g.clip && g.clip.scrollH > g.clip.clientH + 2;
      const outOfView = g.right > g.vw || g.bottom > g.vh;
      await dumpEvidence(`preview-bbox-${vp.w}x${vp.h}-${label}.json`, { viewport: `${vp.w}x${vp.h}`, label, ...g, clash, clip, outOfView });
      expect(clash, `preview overlaps HUD/controls (${label}): ${clash.join(",")} :: ${JSON.stringify(g)}`).toEqual([]);
      expect(clip, `preview text is clipped (${label}): ${JSON.stringify(g.clip)}`).toBe(false);
      expect(outOfView, `preview extends beyond the viewport (${label})`).toBe(false);
    };

    // (a) UNSELECTED unit card.
    await checkNoClash("unselected");

    // (b) SELECTED living operative (Vanguard first, else any living player unit): the left HUD
    // expands to the tall abilities card that produced the reported overlap. Selecting goes through
    // the authoritative select()/sync() path; we wait for the card to actually re-render first.
    const selName = await page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const s = g.debugState();
      const u = s.units.find((x: any) => x.alive && x.side === "player" && x.archetype === "vanguard") || s.units.find((x: any) => x.alive && x.side === "player");
      if (u) g.debugSelect(u.id);
      return u ? (u.name as string) : null;
    });
    await page.waitForFunction((n) => !n || (document.querySelector(".unit-card .unit-name")?.textContent || "").includes(n), selName, { timeout: 4000 });
    await checkNoClash("selected");

    await page.screenshot({ path: `artifacts/ai-preview-${vp.w}x${vp.h}.png` });
  });
}

test("preview is deterministic across two identical seeded runs", async ({ page }) => {
  const run = async () => {
    await deploy(page, "/?seed=11&debug=1");
    await exposeEnemy(page);
    await page.waitForFunction(() => (document.querySelector('[data-testid="ai-preview"]')?.textContent || "").includes("EID "), null, { timeout: 6000 });
    return await page.evaluate(() => document.querySelector('[data-testid="ai-preview"]')?.textContent ?? "");
  };
  const a = await run();
  const b = await run();
  const aLines = a.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("EID "));
  const bLines = b.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("EID "));
  expect(aLines.length, "preview non-empty").toBeGreaterThan(0);
  expect(bLines).toEqual(aLines);
});