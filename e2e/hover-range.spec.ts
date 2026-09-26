// HOVER evidence (VISION, c-hover-range-e2e). Hovering a piece must (a) glow an OUTLINE that marks it
// selectable/interactive and (b) highlight its MAXIMUM move squares. Both work for player operatives
// AND enemy pieces (the enemy range is a tactical threat read), and both must clear on unhover.
//
// Honesty rules enforced here (never "something changed"):
//   * The highlighted set is compared to a REACHABLE set computed INDEPENDENTLY, inside the test, from
//     authoritative state via a hand-written flood (respecting the piece's remaining moves + blockers),
//     NOT from the app's own marker list and NOT from a hue band the deck can satisfy.
//   * Rendering is proven by a camera-locked A/B saved-png readback (idle vs hover, identical pose,
//     idle motion frozen). Range tiles must change; control (non-range, empty) tiles must NOT; the
//     piece footprint must change (the outline). A third capture after unhover must return to idle
//     (markers gone) — so an effect that never appears, or never clears, fails.
import { test, expect } from "@playwright/test";
import { measureAbDelta, lockOverhead, projectTiles, type AbPoint } from "./abDiff.ts";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("sb.onboarding.seen.v2", "1"); // no first-run card over the board
    } catch {
      /* ignore */
    }
  });
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

interface Pick {
  id: string;
  side: string;
  own: { x: number; y: number };
  reach: string[]; // "x,y", excludes the piece's own tile
}

// Pick a target (player or enemy) whose INDEPENDENTLY computed reachable set has >=4 tiles, so the
// range highlight is non-trivial. The reach flood mirrors path.ts semantics but is written here, not
// reused, so the assertion is against an independent computation from authoritative state.
function pickTarget(page: import("@playwright/test").Page, want: "player" | "enemy", minReach: number) {
  return page.evaluate(
    ([want, minReach]) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const S = g.debugState();
      const key = (x: number, y: number) => `${x},${y}`;
      const tileAt = (x: number, y: number) => (x < 0 || y < 0 || x >= 14 || y >= 14 ? null : S.tiles[y * 14 + x]);
      const occupied = (x: number, y: number, selfId: string) => S.units.some((u: any) => u.alive && u.id !== selfId && u.pos.x === x && u.pos.y === y);
      const blocking = (x: number, y: number) => {
        const t = tileAt(x, y);
        if (!t) return true;
        if (t.blocksMove) return true;
        const dest = S.destructibles.find((d: any) => d.x === x && d.y === y && !d.destroyed);
        if (dest && dest.blocksMove) return true;
        const door = S.doors.find((d: any) => d.x === x && d.y === y);
        if (door && !door.open) return true;
        return false;
      };
      // Independent Dijkstra over the same movement graph; budget = the piece's remaining moves.
      const flood = (unit: any) => {
        const start = key(unit.pos.x, unit.pos.y);
        const occ = new Set<string>();
        for (const u of S.units) if (u.alive && u.id !== unit.id) occ.add(key(u.pos.x, u.pos.y));
        const dist: Record<string, number> = { [start]: 0 };
        const frontier: [number, number, number][] = [[unit.pos.x, unit.pos.y, 0]];
        while (frontier.length) {
          frontier.sort((a, b) => a[2] - b[2]);
          const cur = frontier.shift()!;
          const ck = key(cur[0], cur[1]);
          if (cur[2] > (dist[ck] ?? Infinity)) continue;
          const curT = tileAt(cur[0], cur[1]);
          const curH = curT ? curT.height : 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cur[0] + dx;
            const ny = cur[1] + dy;
            if (nx < 0 || ny < 0 || nx >= 14 || ny >= 14) continue;
            if (blocking(nx, ny)) continue;
            const t = tileAt(nx, ny);
            if (!t) continue;
            const dh = t.height - curH;
            if (Math.abs(dh) > 1) continue;
            if (occ.has(key(nx, ny))) continue;
            let cost = t.moveCost;
            if (dh > 0) cost += 1;
            const nc = cur[2] + cost;
            if (nc <= unit.moveLeft && nc < (dist[key(nx, ny)] ?? Infinity)) {
              dist[key(nx, ny)] = nc;
              frontier.push([nx, ny, nc]);
            }
          }
        }
        return Object.keys(dist).filter((k) => k !== start);
      };
      for (const u of S.units) {
        if (!u.alive || u.side !== want) continue;
        const reach = flood(u);
        if (reach.length >= minReach) return { id: u.id, side: u.side, own: { x: u.pos.x, y: u.pos.y }, reach };
      }
      return null;
    },
    [want, minReach] as const,
  ) as Promise<Pick | null>;
}

// Build sample points for a hovered target: R = its range tiles (light), O = the piece footprint
// (outline light), C = empty floor controls >=2 from the range and from every unit (must stay dark).
function buildHoverPoints(page: import("@playwright/test").Page, pick: Pick) {
  return page.evaluate((p) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const S = g.debugState();
    const rangeSet = new Set(p.reach);
    const occ = new Set(S.units.filter((u: any) => u.alive).map((u: any) => `${u.pos.x},${u.pos.y}`));
    const rPts = p.reach.map((k: string, i: number) => { const [a, b] = k.split(",").map(Number); return { label: `R${i}:${k}`, x: a, y: b }; });
    const oPt = { label: `O:${p.own.x},${p.own.y}`, x: p.own.x, y: p.own.y };
    const ctrls: { label: string; x: number; y: number }[] = [];
    let ci = 0;
    for (let y = 0; y < 14; y++)
      for (let x = 0; x < 14; x++) {
        const k = `${x},${y}`;
        if (rangeSet.has(k) || occ.has(k)) continue;
        const t = S.tiles[y * 14 + x];
        if (!t || t.terrain === "wall" || t.terrain === "pillar") continue;
        let far = true;
        for (const rk of p.reach) { const [rx, ry] = rk.split(",").map(Number); if (Math.max(Math.abs(x - rx), Math.abs(y - ry)) < 2) { far = false; break; } }
        for (const u of S.units) if (u.alive && Math.max(Math.abs(x - u.pos.x), Math.abs(y - u.pos.y)) < 2) { far = false; break; }
        if (!far) continue;
        ctrls.push({ label: `C${ci}:${x},${y}`, x, y });
        ci++;
        if (ctrls.length >= 10) break;
      }
    return [oPt, ...rPts, ...ctrls];
  }, pick);
}

async function hoverPair(page: import("@playwright/test").Page, tag: string, pick: Pick) {
  const pts = await buildHoverPoints(page, pick);
  const projected = await projectTiles(page, pts);
  const outline = projected.filter((p) => p.label.startsWith("O") && p.ok) as AbPoint[];
  const range = projected.filter((p) => p.label.startsWith("R") && p.ok) as AbPoint[];
  const dark = projected.filter((p) => p.label.startsWith("C") && p.ok) as AbPoint[];
  expect(range.length, `${tag}: on-screen range (R) points = ${range.length}`).toBeGreaterThanOrEqual(4);
  expect(dark.length, `${tag}: on-screen control (C) points = ${dark.length}`).toBeGreaterThanOrEqual(4);
  expect(outline.length, `${tag}: piece footprint point projected`).toBe(1);

  // IDLE frame (no hover) -> HOVER frame. Only the hover markers differ (camera locked, motion frozen).
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugHover(null));
  await page.waitForTimeout(180);
  const aPath = `test-results/hover-${tag}-A.png`;
  await page.locator("canvas").screenshot({ path: aPath });
  await page.evaluate((id) => (window as unknown as { __sbGame: any }).__sbGame.debugHover(id), pick.id);
  await page.waitForTimeout(220);
  const bPath = `test-results/hover-${tag}-B.png`;
  await page.locator("canvas").screenshot({ path: bPath });

  const ab = await measureAbDelta(page.context(), aPath, bPath, [...outline, ...range, ...dark], 0.018);
  const abO = ab.filter((d) => d.label.startsWith("O"));
  const abR = ab.filter((d) => d.label.startsWith("R"));
  const abD = ab.filter((d) => d.label.startsWith("C"));
  const report = `outline=${abO.map((d) => d.label + ":" + d.delta)} rangeMin=${Math.min(...abR.map((d) => d.delta))} ctrlMax=${Math.max(...abD.map((d) => d.delta))} :: ${JSON.stringify(ab.map((d) => `${d.label}:${d.delta}`))}`;
  console.log(`[HOVER ${tag}] rangeTiles=${abR.length} ctrlTiles=${abD.length} ` + report);
  for (const d of abO) expect(d.delta, `${tag}: outline should appear at the piece — ${report}`).toBeGreaterThanOrEqual(LIT_MIN);
  for (const d of abR) expect(d.delta, `${tag}: range tile ${d.label} should light — ${report}`).toBeGreaterThanOrEqual(LIT_MIN);
  for (const d of abD) expect(d.delta, `${tag}: control tile ${d.label} should stay dark — ${report}`).toBeLessThanOrEqual(DARK_MAX);

  // UNHOVER must clear the outline AND the range: return to the idle board.
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugHover(null));
  await page.waitForTimeout(200);
  const cPath = `test-results/hover-${tag}-C.png`;
  await page.locator("canvas").screenshot({ path: cPath });
  const back = await measureAbDelta(page.context(), aPath, cPath, [...outline, ...range, ...dark], 0.018);
  const backReport = JSON.stringify(back.map((d) => `${d.label}:${d.delta}`));
  for (const d of back.filter((x) => x.label.startsWith("R") || x.label.startsWith("O"))) expect(d.delta, `${tag}: marker must clear on unhover (${d.label}) — ${backReport}`).toBeLessThanOrEqual(DARK_MAX);
}

test("HOVER — a player operative glows + shows its independent max-move range, and clears on unhover", async ({ page }) => {
  await scene(page, 4242);
  const pick = await pickTarget(page, "player", 4);
  expect(pick, "fixture must have a player with >=4 reachable tiles").not.toBeNull();

  // STRUCTURAL: the app's highlighted set equals the independently computed reachable set.
  await page.evaluate((id) => (window as unknown as { __sbGame: any }).__sbGame.debugHover(id), pick!.id);
  const appRange = await page.evaluate(() => [...(window as unknown as { __sbGame: any }).__sbGame.world.debugHover().range].sort());
  const outlineOn = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.debugHover().outline);
  expect(appRange, "app highlight must equal the independent reachable set").toEqual([...pick!.reach].sort());
  expect(outlineOn, "an outline is shown while hovering").toBe(true);

  await hoverPair(page, "player", pick!);

  // Clear: range + outline are gone after unhover (visual check is in hoverPair; this is the state).
  const after = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.debugHover());
  expect(after.range.length, "range cleared on unhover").toBe(0);
  expect(after.outline, "outline cleared on unhover").toBe(false);
});

test("HOVER — an enemy piece glows + shows its independent threat range (reach read), and clears", async ({ page }) => {
  await scene(page, 4242);
  const pick = await pickTarget(page, "enemy", 4);
  expect(pick, "fixture must have an enemy with >=4 reachable tiles").not.toBeNull();

  // STRUCTURAL: the same rule drives the enemy's highlight; enemy hover needs no selection.
  await page.evaluate((id) => (window as unknown as { __sbGame: any }).__sbGame.debugHover(id), pick!.id);
  const appRange = await page.evaluate(() => [...(window as unknown as { __sbGame: any }).__sbGame.world.debugHover().range].sort());
  const unit = await page.evaluate((id) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    return { side: g.debugState().units.find((u: any) => u.id === id).side };
  }, pick!.id);
  expect(unit.side, "the hovered piece is an enemy").toBe("enemy");
  expect(appRange, "app enemy highlight must equal the independent reachable set").toEqual([...pick!.reach].sort());

  await hoverPair(page, "enemy", pick!);

  const after = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.debugHover());
  expect(after.range.length, "enemy range cleared on unhover").toBe(0);
  expect(after.outline, "enemy outline cleared on unhover").toBe(false);
});