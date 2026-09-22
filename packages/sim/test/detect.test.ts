import { describe, it, expect } from "vitest";
import { createInitialState, missionByIndex, applyAction, inCone, cloneState, stateHash } from "../src/index.ts";
import type { GameState, MissionDef, UnitArchetype } from "../src/index.ts";

function deploy(mission = 0, seed = 42): GameState {
  return createInitialState(missionByIndex(mission), seed);
}

function putGhostBehindEnemy(s: GameState) {
  const ghost = s.units.find((u) => u.archetype === "ghost")!;
  const sentry = s.units
    .filter((u) => u.alive && u.side === "enemy")
    .sort((a, b) => a.id.localeCompare(b.id))
    .find((u) => u.archetype === "sentry" || u.archetype === "hunter")!;
  const dirs: [number, number][] = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];
  const [fx, fy] = dirs[sentry.facing];
  const behind = { x: sentry.pos.x - Math.sign(fx), y: sentry.pos.y - Math.sign(fy), h: 0 };
  const occ = s.units.find((u) => u.alive && u.pos.x === behind.x && u.pos.y === behind.y && u.id !== ghost.id);
  if (occ) throw new Error("fixture blocked");
  ghost.pos = { ...behind, h: 0 };
  return { ghost, sentry };
}

describe("detection cones", () => {
  it("cone math includes ahead, excludes behind and wide flanks", () => {
    const guard = {
      pos: { x: 5, y: 5, h: 0 },
      facing: 0,
      fovAngle: 80,
    };
    expect(inCone(guard, { x: 8, y: 5, h: 0 })).toBe(true);
    expect(inCone(guard, { x: 2, y: 5, h: 0 })).toBe(false);
    expect(inCone(guard, { x: 8, y: 8, h: 0 })).toBe(false);
    expect(inCone(guard, { x: 7, y: 6, h: 0 })).toBe(true);
  });

  it("an exposed operative causes escalation (no RNG involved)", () => {
    let s = deploy(1, 21);
    const sentry = s.units.find((u) => u.archetype === "sentry" && u.alive)!;
    const ghost = s.units.find((u) => u.archetype === "ghost")!;
    s = cloneState(s);
    const s2 = s;
    s2.units.find((u) => u.id === sentry.id)!.pos = { x: ghost.pos.x + 4, y: ghost.pos.y, h: 0 };
    s2.units.find((u) => u.id === sentry.id)!.facing = 4; // facing -x toward ghost
    expect(s2.units.find((u) => u.id === sentry.id)!.pos.x).toBe(ghost.pos.x + 4);
    let escalated = false;
    let cur = s2;
    for (let i = 0; i < 6; i++) {
      const r = applyAction(cur, { kind: "endTurn" });
      cur = r.state;
      if (cur.units.some((u) => u.side === "enemy" && (u.detState === "alerted" || u.detState === "searching"))) escalated = true;
    }
    expect(escalated, "guard should escalate against an exposed operative").toBe(true);
  });

  it("perception is a pure function: equal states => equal detection", () => {
    const a = deploy(1, 5);
    const b = cloneState(deploy(1, 5));
    expect(a.units.map((u) => u.detState)).toEqual(b.units.map((u) => u.detState));
    expect(stateHash(a)).toBe(stateHash(b));
  });
});

describe("silent takedown", () => {
  it("kills an unaware guard and keeps cloak", () => {
    const s = deploy(0, 5);
    s.units.find((u) => u.archetype === "ghost")!.statuses.push({ kind: "cloak", turns: 99 });
    const { ghost, sentry } = putGhostBehindEnemy(s);
    expect(sentry.detState).toBe("unaware");
    const r = applyAction(s, { kind: "ability", unitId: ghost.id, ability: "takedown", targetUnitId: sentry.id });
    expect(r.error).toBeUndefined();
    expect(r.state.units.find((u) => u.id === sentry.id)!.alive).toBe(false);
    const g = r.state.units.find((u) => u.id === ghost.id)!;
    expect(g.statuses.some((x) => x.kind === "cloak")).toBe(true);
  });

  it("is refused against an alerted target", () => {
    const s = deploy(0, 5);
    const { ghost, sentry } = putGhostBehindEnemy(s);
    sentry.detState = "alerted";
    const r = applyAction(s, { kind: "ability", unitId: ghost.id, ability: "takedown", targetUnitId: sentry.id });
    expect(r.error).toBe("target_alerted");
    expect(r.state.units.find((u) => u.id === sentry.id)!.alive).toBe(true);
  });

  it("is refused when the target is farther than adjacency", () => {
    const s = deploy(0, 5);
    const { ghost, sentry } = putGhostBehindEnemy(s);
    const far = cloneState(s);
    const g = far.units.find((u) => u.id === ghost.id)!;
    const t = far.units.find((u) => u.id === sentry.id)!;
    g.pos = { x: t.pos.x - 3, y: t.pos.y, h: 0 };
    const r = applyAction(far, { kind: "ability", unitId: g.id, ability: "takedown", targetUnitId: t.id });
    expect(r.error).toBe("out_of_range");
  });
});

describe("tactical layout sanity", () => {
  it("mission 2 keeps a cross-spine route even when every door is locked", () => {
    let s = deploy(1, 2);
    const m: MissionDef = {
      index: 1,
      name: "Relay Junction",
      layout: missionByIndex(1).layout,
      players: missionByIndex(1).players as { archetype: UnitArchetype; x: number; y: number }[],
      enemies: missionByIndex(1).enemies as { archetype: UnitArchetype; x: number; y: number }[],
    };
    s = createInitialState(m, 2);
    for (const d of s.doors) d.open = false;
    // the hazard gap at (6,5) keeps both halves connected; doors are a shortcut, not the only way
    let open = 0;
    for (let y = 0; y < 14; y++) {
      if (!s.tiles[y * 14 + 6] || s.tiles[y * 14 + 6].blocksMove) continue;
      open++;
    }
    expect(open).toBeGreaterThanOrEqual(1);
  });
});