import { describe, it, expect } from "vitest";
import { Rng, seedFrom, nextRng } from "../src/prng.ts";
import { buildMap, isBlockingMove, isBlockingSight } from "../src/map.ts";
import { reachableCells, findPath, pathCost } from "../src/path.ts";
import type { GameState, UnitState } from "../src/types.ts";

// A tiny 14x14 sandbox map for pathfinding tests. Top row walls, a central wall line, one gap.
function sandboxState(): GameState {
  const layout = [
    "##############",
    "#............#",
    "#..cc....OO..#",
    "#............#",
    "####.###.#####",
    "#............#",
    "#..^^....^...#",
    "#............#",
    "#.111........#",
    "#.1r1....cc..#",
    "#............#",
    "#............#",
    "#...........X#",
    "##############",
  ];
  const built = buildMap({ layout });
  const p: UnitState = {
    id: "p1",
    name: "Test Unit",
    side: "player",
    archetype: "vanguard",
    pos: { x: 1, y: 1, h: 0 },
    hp: 10,
    maxHp: 10,
    energy: 100,
    maxEnergy: 100,
    moveLeft: 40,
    maxMove: 40,
    alive: true,
    activated: true,
    abilities: ["pulse_rifle"],
    statuses: [],
    atkRange: 4,
    atkDamage: 5,
    defaultAttack: "pulse_rifle",
    facing: 0,
    stealth: 0,
    visionRange: 6,
    fovAngle: 360,
    detMeter: 0,
    detState: "unaware",
    searchPos: null,
    searchTurns: 0,
  };
  const blocker: UnitState = { ...p, id: "e1", side: "enemy", archetype: "sentry", pos: { x: 2, y: 1, h: 0 } };
  return {
    version: 1,
    revision: 0,
    seed: 1,
    mission: 0,
    phase: "player",
    turn: 1,
    activeUnitId: "p1",
    units: [p, blocker],
    tiles: built.tiles,
    width: 14,
    height: 14,
    doors: built.doors,
    devices: built.devices,
    destructibles: built.destructibles,
    extraction: built.extraction,
    objectives: [],
    gameOver: false,
    victory: false,
    rngState: 1,
    log: [],
    vis: new Array(196).fill(2),
    noises: [],
    alert: 0,
    alertCool: 0,
    alertFocus: null,
  };
}

describe("prng", () => {
  it("is deterministic for identical seeds", () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
  });
  it("differs for different seeds", () => {
    expect(new Rng(seedFrom("a")).next()).not.toBe(new Rng(seedFrom("b")).next());
  });
  it("nextRng is pure and stateful-safe", () => {
    const [s1, v1] = nextRng(7);
    const [s2, v2] = nextRng(7);
    expect(s1).toBe(s2);
    expect(v1).toBe(v2);
    expect(v1).toBeGreaterThanOrEqual(0);
    expect(v1).toBeLessThan(1);
  });
});

describe("map builder", () => {
  it("marks walls blocking move and sight", () => {
    const s = sandboxState();
    expect(isBlockingMove(s, 0, 0)).toBe(true);
    expect(isBlockingSight(s, 0, 0)).toBe(true);
    expect(isBlockingMove(s, 1, 1)).toBe(false);
  });
  it("builds the extraction marker", () => {
    const s = sandboxState();
    expect(s.extraction.x).toBe(12);
    expect(s.extraction.y).toBe(12);
  });
});

describe("pathfinding", () => {
  it("computes reachable cells that respect move budget", () => {
    const s = sandboxState();
    const unit = s.units.find((u) => u.id === "p1")!;
    const reach = reachableCells(s, unit);
    // occupied tile (2,1) must not be reachable
    expect(reach.has("2,1")).toBe(false);
    // adjacent floor (1,2) reachable within budget
    expect(reach.has("1,2")).toBe(true);
  });
  it("finds a path that never crosses a blocking tile", () => {
    const s = sandboxState();
    const path = findPath(s, { x: 1, y: 1, h: 0 }, { x: 12, y: 12, h: 0 });
    expect(path).not.toBeNull();
    for (const step of path!) {
      expect(isBlockingMove(s, step.x, step.y)).toBe(false);
    }
    // no duplicate consecutive coords
    for (let i = 1; i < path!.length; i++) expect(path![i]).not.toEqual(path![i - 1]);
  });
  it("blockage with no path returns null", () => {
    const s = sandboxState();
    // (0,0) is wall corner, target outside the reachable region behind full wall via findPath
    const path = findPath(s, { x: 1, y: 1, h: 0 }, { x: 0, y: 0, h: 0 });
    expect(path).toBeNull();
  });
  it("climb cost includes elevation surcharge", () => {
    const s = sandboxState();
    // climb from ramp (2,9) up onto platform (3,9) region should cost more than flat
    const flat = pathCost(s, [
      { x: 1, y: 5, h: 0 },
      { x: 2, y: 5, h: 0 },
    ]);
    const climb = pathCost(s, [
      { x: 2, y: 9, h: 0 },
      { x: 3, y: 9, h: 1 },
    ]);
    expect(flat).toBe(1);
    expect(climb).toBe(2); // platform floor cost 1 + elevation surcharge 1
  });
});
