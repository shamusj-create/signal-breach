// TRAIL evidence (VISION, c-move-trail-e2e). Renders + verifies each piece's LAST-move trail — the
// tiles it actually travelled on its most recent move — for BOTH player operatives and enemy pieces.
//
// Two independent oracles, both read back from the SAVED png / authoritative state (never a live hue
// predicate the deck could satisfy):
//   1. STRUCTURAL — the drawn trail tile-set must equal the travelled tiles computed from
//      AUTHORITATIVE state (the exact path fed for a player; the authoritative move-event path for an
//      enemy). This proves WHICH tiles, per piece, replaced-not-accumulated, and cleared on rebuild.
//   2. PIXELS — a camera-locked A/B (identical pose, idle motion frozen, piece parked) where the ONLY
//      difference is trail markers. Trail tiles must change; control (non-trail) tiles must not. So
//      "the whole frame changed" or "the environment lit up" cannot satisfy it.
import { test, expect } from "@playwright/test";
import { measureAbDelta, lockOverhead, projectTiles, type AbPoint } from "./abDiff.ts";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
}
async function scene(page: import("@playwright/test").Page, seed: number) {
  await deploy(page, seed);
  await lockOverhead(page);
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.clearEffects());
}

const LIT_MIN = 0.02;
const DARK_MAX = 0.008;
const DARK_MIN = 4;

// Sample points for a target: "L" = travelled tiles (destination excluded — the piece ends there and
// could occlude its own plate), "D" = empty floor control tiles >=2 from the path and from every unit
// and not under any drawn trail (renderTrails toggles EVERY trail, so a control on any trail would
// light too). Built against CURRENT state so it reflects the state the A/B actually captures.
function buildPoints(page: import("@playwright/test").Page, path: { x: number; y: number }[]) {
  return page.evaluate((path) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const S = g.debugState();
    const pathSet = new Set(path.map((p: any) => `${p.x},${p.y}`));
    const occ = new Set(S.units.filter((u: any) => u.alive).map((u: any) => `${u.pos.x},${u.pos.y}`));
    const trailT = new Set<string>();
    const tr = g.debugTrail();
    for (const k in tr) for (const tk of tr[k]) trailT.add(tk);
    const lit = path.slice(0, -1).filter((p: any) => !occ.has(`${p.x},${p.y}`)).map((p: any, i: number) => ({ label: `L${i}:${p.x},${p.y}`, x: p.x, y: p.y }));
    const ctrls: { label: string; x: number; y: number }[] = [];
    let ci = 0;
    for (let y = 0; y < 14; y += 1)
      for (let x = 0; x < 14; x += 1) {
        const k = `${x},${y}`;
        if (pathSet.has(k) || occ.has(k) || trailT.has(k)) continue;
        const t = S.tiles[y * 14 + x];
        if (!t || t.terrain === "wall" || t.terrain === "pillar") continue;
        let far = true;
        for (const p of path) if (Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) < 2) { far = false; break; }
        for (const u of S.units) if (u.alive && Math.max(Math.abs(x - u.pos.x), Math.abs(y - u.pos.y)) < 2) { far = false; break; }
        if (!far) continue;
        ctrls.push({ label: `D${ci}:${x},${y}`, x, y });
        ci++;
        if (ctrls.length >= 12) break;
      }
    return [...lit, ...ctrls];
  }, path);
}

async function splitProjected(page: import("@playwright/test").Page, pts: { label: string; x: number; y: number }[]) {
  const projected = await projectTiles(page, pts);
  const litPts = projected.filter((p) => p.label.startsWith("L") && p.ok) as AbPoint[];
  const darkPts = projected.filter((p) => p.label.startsWith("D") && p.ok) as AbPoint[];
  return { litPts, darkPts };
}

test("TRAIL — a player's last-move trail is exactly the tiles travelled, and they render", async ({ page, context }) => {
  await scene(page, 4242);

  const sel = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (const u of g.debugState().units) {
      if (!u.alive || u.side !== "player") continue;
      const fp = g.debugFarthestPath(u.id);
      if (fp.ok && (fp.path?.length ?? 0) >= 4) return { unitId: u.id, path: fp.path.map((p: any) => ({ x: p.x, y: p.y })) };
    }
    return null;
  });
  expect(sel, "fixture must have a player with a >=4-tile path to trail").not.toBeNull();
  const unitId = sel!.unitId;
  const path = sel!.path;
  const pathSet = path.map((p) => `${p.x},${p.y}`);

  // Move first (reduced-motion parks the piece on the destination), THEN build points against the
  // post-move state so controls exclude the pieces' new positions.
  await page.evaluate(([id, p]) => (window as unknown as { __sbGame: any }).__sbGame.debugMove(id, p), [unitId, path] as const);
  await page.waitForTimeout(400);

  // STRUCTURAL: the drawn trail equals the travelled tiles, for THIS piece only.
  const trail = await page.evaluate((id) => (window as unknown as { __sbGame: any }).__sbGame.debugTrail()[id] ?? [], unitId);
  expect(trail.slice().sort(), `drawn trail [${trail}] must equal travelled tiles [${pathSet}]`).toEqual([...pathSet].sort());

  const pts = await buildPoints(page, path);
  const { litPts, darkPts } = await splitProjected(page, pts);
  expect(litPts.length, `on-screen travelled (lit) tiles = ${litPts.length}`).toBeGreaterThanOrEqual(3);
  expect(darkPts.length, `on-screen control (dark) tiles = ${darkPts.length}`).toBeGreaterThanOrEqual(DARK_MIN);

  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.setRenderTrails(false));
  await page.waitForTimeout(200);
  const aPath = "test-results/trail-A.png";
  await page.locator("canvas").screenshot({ path: aPath });
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.setRenderTrails(true));
  await page.waitForTimeout(200);
  const bPath = "test-results/trail-B.png";
  await page.locator("canvas").screenshot({ path: bPath });

  const delta = await measureAbDelta(context, aPath, bPath, [...litPts, ...darkPts], 0.018);
  const lit = delta.filter((d) => d.label.startsWith("L"));
  const dark = delta.filter((d) => d.label.startsWith("D"));
  const report = `lit minDelta=${Math.min(...lit.map((d) => d.delta))} maxDark=${Math.max(...dark.map((d) => d.delta))} :: ${JSON.stringify(delta.map((d) => `${d.label}:${d.delta}`))}`;
  for (const d of lit) expect(d.delta, `trail tile ${d.label} should light — ${report}`).toBeGreaterThanOrEqual(LIT_MIN);
  for (const d of dark) expect(d.delta, `control tile ${d.label} should stay dark — ${report}`).toBeLessThanOrEqual(DARK_MAX);
});

test("TRAIL — replaced not appended, separate per piece, never accumulates, clears on rebuild", async ({ page }) => {
  await deploy(page, 4242);
  const two = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const players = g.debugState().units.filter((u: any) => u.alive && u.side === "player");
    return players.map((u: any) => ({ id: u.id, fp: g.debugFarthestPath(u.id) })).filter((x: any) => x.fp.ok && x.fp.path.length >= 3).map((x: any) => ({ id: x.id, path: x.fp.path.map((p: any) => ({ x: p.x, y: p.y })) }));
  });
  expect(two.length, "need two player units with legal paths").toBeGreaterThanOrEqual(2);
  const [u1, u2] = two as { id: string; path: { x: number; y: number }[] }[];
  const keys = (arr: { x: number; y: number }[]) => arr.map((p) => `${p.x},${p.y}`).sort();

  // Separate trails: move u1 along p1 and u2 along p2; each keeps its own.
  await page.evaluate(([id, p]) => (window as unknown as { __sbGame: any }).__sbGame.debugMove(id, p), [u1.id, u1.path] as const);
  await page.evaluate(([id, p]) => (window as unknown as { __sbGame: any }).__sbGame.debugMove(id, p), [u2.id, u2.path] as const);
  const t1 = await page.evaluate((id) => (window as unknown as { __sbGame: any }).__sbGame.debugTrail()[id] ?? [], u1.id);
  const t2 = await page.evaluate((id) => (window as unknown as { __sbGame: any }).__sbGame.debugTrail()[id] ?? [], u2.id);
  expect(t1.slice().sort(), "unit1 trail == p1").toEqual(keys(u1.path));
  expect(t2.slice().sort(), "unit2 trail == p2 (a separate trail, not merged)").toEqual(keys(u2.path));

  // Re-move unit 1 (restore its movement budget — scenario setup) along a FRESH farthest path. Its
  // trail must be REPLACED by the new travelled tiles, not appended — "last move only".
  const p3 = await page.evaluate((id) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const u = g.debugState().units.find((x: any) => x.id === id);
    if (!u) return null;
    u.moveLeft = 6;
    const fp = g.debugFarthestPath(id);
    return fp.ok ? fp.path.map((p: any) => ({ x: p.x, y: p.y })) : null;
  }, u1.id);
  expect(p3, "unit1 must have a second legal move to test replacement").not.toBeNull();
  await page.evaluate(([id, p]) => (window as unknown as { __sbGame: any }).__sbGame.debugMove(id, p), [u1.id, p3!] as const);
  const trailKeys = await page.evaluate(() => Object.keys((window as unknown as { __sbGame: any }).__sbGame.debugTrail()));
  expect(trailKeys.sort(), `pieces with trails = ${trailKeys.join(",")} (no new accumulations)`).toEqual([u1.id, u2.id].sort());
  const t1final = await page.evaluate((id) => (window as unknown as { __sbGame: any }).__sbGame.debugTrail()[id] ?? [], u1.id);
  expect(t1final.slice().sort(), "unit1 trail replaced by its SECOND move").toEqual((p3 as { x: number; y: number }[]).map((p) => `${p.x},${p.y}`).sort());
  expect(t1final, "unit1 new trail differs from its first move (replaced, not appended)").not.toEqual(t1.slice().sort());

  // A mission rebuild wipes every trail.
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.debugLoad(g.debugSerialize()); // rebuildBoard -> clearTrails
  });
  const afterRebuild = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugTrail());
  expect(Object.keys(afterRebuild), "trails cleared on board rebuild").toEqual([]);
});

test("TRAIL — enemy pieces get their own last-move trail (tactical threat history)", async ({ page, context }) => {
  await scene(page, 4242);

  // STRUCTURE: drive the real enemy phase, then every moving enemy's drawn trail must equal its
  // AUTHORITATIVE last-move path (independent of the renderer) and be its own (no accumulation).
  const struct = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const enemyIds = g.debugState().units.filter((u: any) => u.alive && u.side === "enemy").map((u: any) => u.id);
    g.debugTryOneAction();
    const lastByEnemy: Record<string, string[]> = {};
    for (let i = 0; i < 5; i++) {
      const S0 = g.debugState();
      if (S0.phase !== "player" || S0.gameOver) break;
      (S0 as any).alert = 3; // force aggressive enemy behaviour so pieces advance/move
      g.endTurn();
      const paths = g.debugLastMovePaths();
      for (const id of Object.keys(paths)) if (enemyIds.includes(id)) lastByEnemy[id] = paths[id];
    }
    const drawn: Record<string, string[]> = {};
    for (const id of enemyIds) drawn[id] = g.debugTrail()[id] ?? [];
    return { lastByEnemy, drawn };
  });
  const moved = Object.keys(struct.lastByEnemy);
  expect(moved.length, `enemies must move in the scenario (moved: ${moved.join(",") || "none"})`).toBeGreaterThanOrEqual(1);
  for (const id of moved) {
    expect([...(struct.drawn[id] ?? [])].sort(), `enemy ${id} trail must equal its last move path`).toEqual([...struct.lastByEnemy[id]].sort());
  }

  // PIXELS on a FRESH, quiet board so the enemy trail sits on clean floor: reload, freeze, provoke a
  // single aggressive enemy phase, then A/B the trail of the enemy whose path has the most clean,
  // on-screen travelled tiles.
  await scene(page, 4242);
  const pick = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    (g.debugState() as any).alert = 3;
    for (let i = 0; i < 3; i++) {
      if (g.debugState().phase !== "player") break;
      (g.debugState() as any).alert = 3;
      g.endTurn();
    }
    const S = g.debugState();
    const occ = new Set(S.units.filter((u: any) => u.alive).map((u: any) => `${u.pos.x},${u.pos.y}`));
    let best: { id: string; tiles: { x: number; y: number }[] } | null = null;
    for (const id in g.debugTrail()) {
      const keys = g.debugTrail()[id] as string[];
      const tiles = keys.map((k: string) => { const [a, b] = k.split(",").map(Number); return { x: a, y: b }; });
      const dest = tiles[tiles.length - 1];
      const clean = tiles.slice(0, -1).filter((t: any) => !occ.has(`${t.x},${t.y}`) && !(t.x === dest.x && t.y === dest.y));
      if (!best || clean.length > best.tiles.length) best = { id, tiles: clean };
    }
    return best;
  });
  expect(pick, "need an enemy that moved a clean multi-tile path to measure").toBeTruthy();
  const enemyId = pick!.id;
  const path = pick!.tiles; // already excludes the destination

  // Sample points: lit = the enemy's travelled tiles; controls = clean floor far from the path.
  const pts = await page.evaluate((path) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const S = g.debugState();
    const pathSet = new Set(path.map((p: any) => `${p.x},${p.y}`));
    const occ = new Set(S.units.filter((u: any) => u.alive).map((u: any) => `${u.pos.x},${u.pos.y}`));
    const trailT = new Set<string>();
    const tr = g.debugTrail();
    for (const k in tr) for (const tk of tr[k]) trailT.add(tk);
    const lit = path.filter((p: any) => !occ.has(`${p.x},${p.y}`)).map((p: any, i: number) => ({ label: `L${i}:${p.x},${p.y}`, x: p.x, y: p.y }));
    const ctrls: { label: string; x: number; y: number }[] = [];
    let ci = 0;
    for (let y = 0; y < 14; y++)
      for (let x = 0; x < 14; x++) {
        const k = `${x},${y}`;
        if (pathSet.has(k) || occ.has(k) || trailT.has(k)) continue;
        const t = S.tiles[y * 14 + x];
        if (!t || t.terrain === "wall" || t.terrain === "pillar") continue;
        let far = true;
        for (const p of path) if (Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) < 2) { far = false; break; }
        if (!far) continue;
        ctrls.push({ label: `D${ci}:${x},${y}`, x, y });
        ci++;
        if (ctrls.length >= 10) break;
      }
    return [...lit, ...ctrls];
  }, path);
  const { litPts, darkPts } = await splitProjected(page, pts);
  expect(litPts.length, `enemy trail lit points = ${litPts.length}`).toBeGreaterThanOrEqual(2);
  expect(darkPts.length, `enemy control points = ${darkPts.length}`).toBeGreaterThanOrEqual(DARK_MIN);

  // Freeze per-frame animation (particles + alert wash) so A/B isolates ONLY the trail markers.
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const w = (window as unknown as { __sbGame: any }).__sbGame.world;
    w.clearEffects();
    w.setAlertWash(0, null);
    w.setRenderTrails(false);
  });
  await page.waitForTimeout(220);
  const aPath = "test-results/trail-enemy-A.png";
  await page.locator("canvas").screenshot({ path: aPath });
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.setRenderTrails(true));
  await page.waitForTimeout(220);
  const bPath = "test-results/trail-enemy-B.png";
  await page.locator("canvas").screenshot({ path: bPath });

  const delta = await measureAbDelta(context, aPath, bPath, [...litPts, ...darkPts], 0.018);
  const lit = delta.filter((d) => d.label.startsWith("L"));
  const dark = delta.filter((d) => d.label.startsWith("D"));
  const report = `lit=${lit.map((d) => d.label + ":" + d.delta)} dark=${dark.map((d) => d.label + ":" + d.delta)}`;
  for (const d of lit) expect(d.delta, `enemy trail tile ${d.label} should light — ${report}`).toBeGreaterThanOrEqual(LIT_MIN);
  for (const d of dark) expect(d.delta, `control tile ${d.label} stays dark — ${report}`).toBeLessThanOrEqual(DARK_MAX);
  expect(enemyId, "enemy id recorded for the operator").toBeTruthy();
});