import { describe, it, expect } from "vitest";
import { createInitialState, missionByIndex, applyAction, replay, stateHash, autoSolve, validateReplay, computeScore } from "../src/index.ts";
import type { GameState, PlayerAction } from "../src/index.ts";

function deploy(mission = 1, seed = 42): GameState {
  return createInitialState(missionByIndex(mission), seed);
}

function playScript(seed: number): { final: GameState; log: PlayerAction[]; errors: string[] } {
  let s = deploy(1, seed);
  const log: PlayerAction[] = [];
  const errors: string[] = [];
  const go = (a: PlayerAction): boolean => {
    const r = applyAction(s, a);
    if (r.error) {
      errors.push(r.error);
      return false;
    }
    s = r.state;
    log.push(a);
    return true;
  };
  const ghost = s.units.find((u) => u.archetype === "ghost")!;
  go({ kind: "ability", unitId: ghost.id, ability: "cloak" });
  for (let i = 0; i < 8; i++) {
    const g = s.units.find((u) => u.id === ghost.id && u.alive);
    if (!g) break;
    const adj = s.units.find((u) => u.alive && u.side === "enemy" && Math.max(Math.abs(u.pos.x - g.pos.x), Math.abs(u.pos.y - g.pos.y)) <= 1);
    if (adj && g.energy >= 3) {
      go({ kind: "ability", unitId: g.id, ability: "takedown", targetUnitId: adj.id });
    }
    go({ kind: "endTurn" });
  }
  return { final: s, log, errors };
}

describe("stealth/security determinism", () => {
  it("a stealth replay reproduces the identical final authoritative hash", () => {
    const a = playScript(31337);
    const b = playScript(31337);
    expect(b.log.length).toBe(a.log.length);
    expect(stateHash(a.final)).toBe(stateHash(b.final));
    const replayed = replay(deploy(1, 31337), a.log);
    expect(stateHash(replayed.state)).toBe(stateHash(a.final));
    expect(replayed.errors.length).toBe(0);
  });

  it("fog + alert state are part of the deterministic record", () => {
    const a = playScript(7);
    const replayed = replay(deploy(1, 7), a.log);
    expect(replayed.state.vis).toEqual(a.final.vis);
    expect(replayed.state.alert).toBe(a.final.alert);
    expect(replayed.state.noises.length).toBe(a.final.noises.length);
  });

  it("solver replays for every mission validate against the shared authoritative sim", () => {
    for (const idx of [0, 1, 2]) {
      const { state, log } = autoSolve(deploy(idx, 991 + idx), 90);
      const v = validateReplay({
        mission: idx,
        seed: 991 + idx,
        actions: log,
        claimedOutcome: state.victory ? "win" : "lose",
        claimedScore: computeScore(state).total,
      });
      expect(v.valid, JSON.stringify(v)).toBe(true);
    }
  });
});
