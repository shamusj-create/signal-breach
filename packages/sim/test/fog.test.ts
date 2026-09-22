import { describe, it, expect } from "vitest";
import {
  createInitialState,
  missionByIndex,
  knownEnemies,
  knownThreatCells,
  isPositionVisible,
  updateVisibility,
  computeVisibleCells,
  pathThreat,
  cloneState,
  replay,
  stateHash,
} from "../src/index.ts";
import type { GameState } from "../src/index.ts";

function deploy(mission = 0, seed = 42): GameState {
  return createInitialState(missionByIndex(mission), seed);
}

describe("fog of war: three-state visibility", () => {
  it("starts with explored + unexplored regions, never fully revealed", () => {
    const s = deploy(0, 7);
    const visible = s.vis.filter((v) => v === 2).length;
    const unexplored = s.vis.filter((v) => v === 0).length;
    expect(visible).toBeGreaterThan(10);
    expect(unexplored).toBeGreaterThan(40);
    expect(s.vis.length).toBe(196);
  });

  it("remembered tiles stay at level 1 after the viewer leaves them", () => {
    const s0 = deploy(0, 7);
    const before = [...s0.vis];
    const seenCells = before.map((v, i) => (v === 2 ? i : -1)).filter((i) => i >= 0);
    const s = cloneState(s0);
    for (const u of s.units) if (u.side === "player") u.pos = { x: 12, y: 1, h: 0 };
    updateVisibility(s);
    for (const i of seenCells) {
      const x = i % 14;
      const y = Math.floor(i / 14);
      if (Math.max(Math.abs(x - 12), Math.abs(y - 1)) > 9) {
        expect(s.vis[i], `tile ${x},${y}`).toBe(1);
      }
    }
  });

  it("walls + the door spine hide everything behind them at mission start", () => {
    const s = deploy(1, 7);
    // players start bottom-left; the right half must be unexplored
    expect(isPositionVisible(s, 7, 5)).toBe(false);
    expect(isPositionVisible(s, 9, 3)).toBe(false);
    expect(isPositionVisible(s, 11, 1)).toBe(false);
  });

  it("hidden enemies are not in the player's known set", () => {
    const s = deploy(0, 3);
    const hidden = s.units.filter((u) => u.alive && u.side === "enemy" && !isPositionVisible(s, u.pos.x, u.pos.y));
    expect(hidden.length).toBeGreaterThan(0);
    const known = knownEnemies(s);
    for (const h of hidden) expect(known.some((k) => k.id === h.id)).toBe(false);
  });

  it("known threat zones never include hidden enemies", () => {
    const s = deploy(0, 3);
    const zones = knownThreatCells(s);
    const hidden = s.units.filter((u) => u.alive && u.side === "enemy" && !isPositionVisible(s, u.pos.x, u.pos.y));
    for (const h of hidden) expect(zones.some((z) => z.unitId === h.id)).toBe(false);
    for (const z of zones) {
      const enemy = s.units.find((u) => u.id === z.unitId);
      if (enemy) expect(isPositionVisible(s, enemy.pos.x, enemy.pos.y)).toBe(true);
    }
  });

  it("movement preview threat uses only KNOWN cones", () => {
    const s = deploy(0, 3);
    const ghost = s.units.find((u) => u.archetype === "ghost")!;
    const path = [
      { x: ghost.pos.x, y: ghost.pos.y - 1, h: 0 },
      { x: ghost.pos.x, y: ghost.pos.y - 2, h: 0 },
    ];
    const zones = knownThreatCells(s);
    const knownEnemyCells = s.units.filter((e) => e.alive && e.side === "enemy" && isPositionVisible(s, e.pos.x, e.pos.y));
    for (const t of pathThreat(s, path)) {
      const [tx, ty] = t.split(",").map(Number);
      const inZone = zones.some((z) => z.cells.includes(t));
      const nearKnown = knownEnemyCells.some((e) => Math.max(Math.abs(e.pos.x - tx), Math.abs(e.pos.y - ty)) <= 2);
      expect(inZone || nearKnown).toBe(true);
    }
  });

  it("visibility is replay-reproducible: identical logs reproduce identical fog", () => {
    const log = [{ kind: "endTurn" as const }, { kind: "endTurn" as const }];
    const r1 = replay(deploy(0, 11), log);
    const r2 = replay(deploy(0, 11), log);
    expect(r1.state.vis).toEqual(r2.state.vis);
    expect(stateHash(r1.state)).toBe(stateHash(r2.state));
  });

  it("visible set matches computeVisibleCells", () => {
    const s = deploy(1, 5);
    const cells = computeVisibleCells(s);
    for (const k of cells) {
      const [x, y] = k.split(",").map(Number);
      expect(isPositionVisible(s, x, y)).toBe(true);
    }
  });
});
