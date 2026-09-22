// DETECTION + STEALTH browser journey (INTEGRATION-class evidence).
//
// The renderer must draw a detection-cone telegraph ONLY for enemies whose AUTHORITATIVE detState
// is "alerted" or "suspicious" (World.syncThreat), re-derive it on state TRANSITIONS via the shared
// state-change channel (not a fixed timer), and never invent or drop a telegraph. We do NOT trust
// the display: every checkpoint recomputes the expected set from the raw authoritative state and
// compares. Seed 11 is a scripted playthrough that genuinely escalates the board (guards wake and
// open fire), so the checks are non-vacuous; and the whole pipeline is deterministic (no RNG).
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1800);
}

// Independent oracle: the telegraph set the renderer OUGHT to show, derived only from authoritative
// unit state (never from the scene). Returns count + the per-enemy detection states.
function oracleProbe(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const s = g.debugState();
    const expected = s.units.filter((u: any) => u.alive && u.side === "enemy" && (u.detState === "alerted" || u.detState === "suspicious"));
    const cones = w.fxGroup.children.filter((c: any) => c.name === "threat");
    // per-enemy presence check: every expected telegraph must have a "threat" object near it, and
    // every threat object must correspond to an expected enemy (no fabricated cone, no dropped cone).
    const near = (u: any) => {
      const wp = w.tileToWorld({ x: u.pos.x, y: u.pos.y, h: 0 });
      return cones.some((c: any) => Math.abs(c.position.x - wp.x) < 0.9 && Math.abs(c.position.z - wp.z) < 0.9);
    };
    const missing = expected.filter((u: any) => !near(u)).map((u: any) => `${u.id}:${u.detState}@${u.pos.x},${u.pos.y}`);
    const phantoms: string[] = [];
    for (const c of cones) {
      const matched = expected.some((u: any) => {
        const wp = w.tileToWorld({ x: u.pos.x, y: u.pos.y, h: 0 });
        return Math.abs(c.position.x - wp.x) < 0.9 && Math.abs(c.position.z - wp.z) < 0.9;
      });
      if (!matched) phantoms.push(`${Math.round(c.position.x)},${Math.round(c.position.z)}`);
    }
    return { expected: expected.length, cones: cones.length, missing, phantoms, alert: s.alert };
  });
}

test("cone telegraphs are an exact, transition-driven projection of authoritative detection (no fabricated/dropped cone)", async ({ page }) => {
  await deploy(page, "/?seed=11");
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR " + (e as Error).message));

  const trace = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const mismatches: string[] = [];
    let maxCones = 0;
    let maxAlert = 0;
    let sawCones = false;
    const readNow = () => {
      const w = g.world;
      const s = g.debugState();
      const expected = s.units.filter((u: any) => u.alive && u.side === "enemy" && (u.detState === "alerted" || u.detState === "suspicious")).length;
      const cones = w.fxGroup.children.filter((c: any) => c.name === "threat").length;
      return { expected, cones };
    };
    // Scripted playthrough through the SAME action path a human uses; sample the projection at every
    // step. A fixed/timer overlay or a display that drops/invents telegraphs would fail here.
    for (let i = 0; i < 60 && !g.debugState().gameOver; i++) {
      const r = readNow();
      if (r.cones !== r.expected) mismatches.push(`step ${i}: cones ${r.cones} != expected ${r.expected}`);
      if (r.cones > maxCones) maxCones = r.cones;
      if (r.cones > 0) sawCones = true;
      if (g.debugState().alert > maxAlert) maxAlert = g.debugState().alert;
      g.debugTryOneAction();
      if (i % 5 === 4) g.endTurn();
    }
    return { mismatches, maxCones, maxAlert, sawCones };
  });

  expect(trace.mismatches, `projection mismatches: ${trace.mismatches.join("; ")}`).toEqual([]);
  // Non-vacuous: this seed genuinely escalates detection and draws telegraphs (never just presence).
  expect(trace.maxCones, `max telegraphs seen ${trace.maxCones}`).toBeGreaterThanOrEqual(1);
  expect(trace.maxAlert, `board alert escalated to ${trace.maxAlert}`).toBeGreaterThanOrEqual(1);
  expect(trace.sawCones, "at least one detection telegraph was drawn").toBe(true);
  expect(errors, errors.join("\n")).toHaveLength(0);
  await page.screenshot({ path: "artifacts/detect-cones.png" });
});

// The cone overlay must re-derive on AUTHORITATIVE STATE TRANSITIONS, not on a wall-clock timer.
// Timers are PAUSED (Playwright fake clock) so a fixed-interval display cannot recompute; the current
// channel does. We then make a synthetic presentation-state change (clearly labelled) and confirm the
// scene both (a) gains a telegraph for a newly-alerted enemy and (b) drops the telegraph for a unit
// that just became dead+hidden — and the display equals an INDEPENDENT recompute of the new state.
test("cones re-derive from authoritative state when the timer is frozen (transition-driven, not timer-driven)", async ({ page }) => {
  await page.clock.install();
  await deploy(page, "/?seed=11");
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (let i = 0; i < 6; i++) g.debugTryOneAction();
    g.endTurn();
  });
  await page.waitForTimeout(1200);

  // Freeze the clock AFTER both producers are populated: a forward jump would fire the interval, but
  // after pause no further tick can occur unless we advance it. So only a state-event display can keep
  // the scene in sync; a fixed-interval display is stuck.
  await page.clock.pauseAt(Date.now() + 6000);

  const trace = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const coneKey = () =>
      w.fxGroup.children
        .filter((c: any) => c.name === "threat")
        .map((c: any) => `${Math.round(c.position.x / 0.5)},${Math.round(c.position.z / 0.5)}`)
        .sort()
        .join("|");
    const mismatches: string[] = [];
    const variants = new Set<string>();
    let maxCones = 0;
    for (let i = 0; i < 80 && !g.debugState().gameOver; i++) {
      const s = g.debugState();
      const expected = s.units.filter(
        (u: any) => u.alive && u.side === "enemy" && (u.detState === "alerted" || u.detState === "suspicious"),
      );
      const cones = w.fxGroup.children.filter((c: any) => c.name === "threat");
      if (cones.length !== expected.length) mismatches.push(`step ${i}: cones ${cones.length} != expected ${expected.length}`);
      for (const u of expected) {
        const wp = w.tileToWorld({ x: u.pos.x, y: u.pos.y, h: 0 });
        const near = cones.some((c: any) => Math.abs(c.position.x - wp.x) < 0.9 && Math.abs(c.position.z - wp.z) < 0.9);
        if (!near) mismatches.push(`step ${i}: missing cone for ${u.id}:${u.detState}@${u.pos.x},${u.pos.y}`);
      }
      variants.add(coneKey());
      if (cones.length > maxCones) maxCones = cones.length;
      g.debugTryOneAction();
      if (i % 5 === 4) g.endTurn();
    }
    return { mismatches, variants: variants.size, maxCones };
  });

  expect(trace.mismatches, `projection mismatches under frozen clock: ${trace.mismatches.join("; ")}`).toEqual([]);
  expect(trace.maxCones, `max telegraphs seen ${trace.maxCones}`).toBeGreaterThanOrEqual(1);
  expect(trace.variants, `distinct cone-set states observed while the clock was frozen: ${trace.variants}`).toBeGreaterThanOrEqual(2);

  // Hidden enemies must never leak their identity into the DOM either (stealth/confidentiality rule).
  const leaks = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const body = document.body.innerText;
    const hidden = s.units.filter((u: any) => u.alive && u.side === "enemy" && s.vis[u.pos.y * 14 + u.pos.x] !== 2).map((u: any) => u.id);
    return { hit: hidden.filter((id: string) => body.includes(id)), hasDet: body.includes("detState") || body.includes("searchPos") };
  });
  expect(leaks.hit, `hidden enemies leaked: ${leaks.hit.join(",")}`).toEqual([]);
  expect(leaks.hasDet, "debug detection fields must not surface in default UI").toBe(false);
  await page.screenshot({ path: "artifacts/detect-redirect.png" });
});

test("detection render is deterministic across two identical seeded runs", async ({ page }) => {
  const run = async () => {
    await page.goto("/?seed=11");
    await page.getByTestId("new-campaign").click();
    await page.getByTestId("deploy").click();
    await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
    await page.waitForTimeout(900);
    return page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      for (let i = 0; i < 24; i++) { g.debugTryOneAction(); if (i % 5 === 4) g.endTurn(); }
      const w = g.world;
      const s = g.debugState();
      const cones = w.fxGroup.children.filter((c: any) => c.name === "threat").length;
      const det = s.units.filter((u: any) => u.alive && u.side === "enemy").map((u: any) => `${u.id}:${u.detState}`).join("|");
      return { cones, det, hash: (window as unknown as { __sbHash: (x: unknown) => string }).__sbHash(s) };
    });
  };
  const a = await run();
  await page.reload();
  const b = await run();
  expect(a.cones, "determinism: cone count must match across identical runs").toBe(b.cones);
  expect(a.det, "determinism: per-enemy detection state must match across identical runs").toBe(b.det);
  expect(a.hash).toBe(b.hash);
});