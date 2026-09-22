import { describe, it, expect } from "vitest";
import { createInitialState, applyAction, isBlockingSight, isBlockingMove, findPath, hasLineOfSight } from "../src/index.ts";
import type { GameState, MissionDef, UnitArchetype } from "../src/index.ts";

// Fixture A: a wall line at column 7 with ONE walkable sight plug (P).
// Fixture B: the same wall line with TWO movement plugs (M) at rows 6-7 — the only crossing.
const SIGHT_LAYOUT = [
  "##############",
  "#......#.....#",
  "#......#.....#",
  "#......P.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#X.....#.....#",
  "##############",
];

const PLUG_LAYOUT = [
  "##############",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......MM....#",
  "#......MM....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#......#.....#",
  "#X.....#.....#",
  "##############",
];

function layoutMission(layout: string[]): MissionDef {
  return {
    index: 2,
    name: "Destruction Lab",
    layout,
    players: [
      { archetype: "cipher" as UnitArchetype, x: 1, y: 12 },
      { archetype: "ghost" as UnitArchetype, x: 2, y: 12 },
      { archetype: "vanguard" as UnitArchetype, x: 1, y: 11 },
    ],
    enemies: [
      { archetype: "sentry" as UnitArchetype, x: 10, y: 5 },
      { archetype: "warden" as UnitArchetype, x: 11, y: 10 },
    ],
  };
}

function deploy(layout: string[]): GameState {
  return createInitialState(layoutMission(layout), 4242);
}

function shootAt(s: GameState, x: number, y: number, ability: "arc_bolt" = "arc_bolt"): GameState {
  for (let i = 0; i < 6; i++) {
    const c = s.units.find((u) => u.archetype === "cipher" && u.alive)!;
    c.energy = 9;
    const r = applyAction(s, { kind: "attack", unitId: c.id, ability, targetPos: { x, y, h: 0 } });
    if (r.error) break;
    s = r.state;
    const obj = s.destructibles.find((d) => d.x === x && d.y === y);
    if (!obj || obj.destroyed) break;
  }
  return s;
}

describe("destructible environment", () => {
  it("the sight plug blocks LOS until destroyed, then the lane opens", () => {
    let s = deploy(SIGHT_LAYOUT);
    const c = s.units.find((u) => u.archetype === "cipher")!;
    const guard = s.units.find((u) => u.archetype === "sentry" && u.alive)!;
    c.pos = { x: 6, y: 3, h: 0 };
    guard.pos = { x: 8, y: 3, h: 0 };
    expect(isBlockingSight(s, 7, 3)).toBe(true);
    expect(hasLineOfSight(s, c.pos, guard.pos)).toBe(false);
    s = shootAt(s, 7, 3);
    expect(isBlockingSight(s, 7, 3)).toBe(false);
    const c2 = s.units.find((u) => u.id === c.id)!;
    const g2 = s.units.find((u) => u.id === guard.id)!;
    expect(hasLineOfSight(s, c2.pos, g2.pos)).toBe(true);
  });

  it("destroying the movement plugs reopens the only crossing", () => {
    let s = deploy(PLUG_LAYOUT);
    const sniper = s.units.find((u) => u.archetype === "cipher")!;
    sniper.pos = { x: 5, y: 6, h: 0 };
    expect(isBlockingMove(s, 7, 6)).toBe(true);
    expect(isBlockingMove(s, 7, 7)).toBe(true);
    const before = findPath(s, { x: 4, y: 6, h: 0 }, { x: 10, y: 6, h: 0 });
    expect(before, "wall line must be impassable while plugged").toBeNull();
    s = shootAt(s, 7, 6);
    s = shootAt(s, 8, 6);
    s = shootAt(s, 7, 7);
    s = shootAt(s, 8, 7);
    for (const [x, y] of [[7, 6], [8, 6], [7, 7], [8, 7]] as const) {
      expect(s.destructibles.find((d) => d.x === x && d.y === y)!.destroyed, `${x},${y} destroyed`).toBe(true);
    }
    const after = findPath(s, { x: 4, y: 6, h: 0 }, { x: 10, y: 6, h: 0 });
    expect(after, "destroying the plugs must reopen the route").not.toBeNull();
  });

  it("an exploding energy cell damages neighbours and emits a loud noise", () => {
    let s = deploy(PLUG_LAYOUT);
    const c = s.units.find((u) => u.archetype === "cipher")!;
    c.pos = { x: 5, y: 3, h: 0 };
    s.destructibles.push({ id: "cell_t1", kind: "cell", x: 3, y: 3, h: 0, destroyed: false, hp: 3, label: "Energy Cell", blocksSight: false, blocksMove: true });
    const guard = s.units.find((u) => u.archetype === "warden" && u.alive)!;
    guard.pos = { x: 4, y: 3, h: 0 };
    const hpBefore = guard.hp;
    expect(hasLineOfSight(s, c.pos, { x: 3, y: 3, h: 0 })).toBe(true);
    s = shootAt(s, 3, 3);
    const cell = s.destructibles.find((d) => d.id === "cell_t1")!;
    expect(cell.destroyed).toBe(true);
    const g = s.units.find((u) => u.id === guard.id)!;
    expect(g.hp).toBeLessThan(hpBefore);
    expect(s.noises.some((n) => n.power === 9)).toBe(true);
    expect(isBlockingSight(s, 3, 3)).toBe(false);
    expect(isBlockingMove(s, 3, 3)).toBe(false);
  });
});
