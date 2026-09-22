// Negative control #3: replay determinism. The verifier MUST fail when the authoritative replay
// state is corrupted. If this file's assertions stop failing, the verifier has gone blind.
import { describe, it, expect } from "vitest";
import { createInitialState, missionByIndex, replay, stateHash, validateReplay, computeScore, autoSolve, serializeGame, deserializeGame } from "../src/index.ts";

function legitRun(seed = 2024) {
  const initial = createInitialState(missionByIndex(0), seed);
  const { state, log } = autoSolve(initial, 60);
  return { initial, state, log, hash: stateHash(state) };
}

describe("negative control: corrupted replay state is rejected", () => {
  it("a valid replay passes (control anchor)", () => {
    const { state, log, hash } = legitRun();
    const replayed = replay(createInitialState(missionByIndex(0), 2024), log);
    expect(stateHash(replayed.state)).toBe(hash);
    const v = validateReplay({
      mission: 0,
      seed: 2024,
      actions: log,
      claimedOutcome: state.victory ? "win" : "lose",
      claimedScore: computeScore(state).total,
      claimedHash: hash,
    });
    expect(v.valid).toBe(true);
  });

  it("corrupting one action log entry fails validation", () => {
    const { state, log, hash } = legitRun();
    const corrupted = log.slice(0, -1).concat([{ kind: "attack", unitId: "ghost_999", ability: "silenced_shot", targetUnitId: "nobody" }]);
    const replayed = replay(createInitialState(missionByIndex(0), 2024), corrupted);
    expect(replayed.errors.length, "corrupted log must produce replay errors").toBeGreaterThan(0);
    const v = validateReplay({
      mission: 0,
      seed: 2024,
      actions: corrupted,
      claimedOutcome: state.victory ? "win" : "lose",
      claimedScore: computeScore(state).total,
      claimedHash: hash,
    });
    expect(v.valid).toBe(false);
  });

  it("a doctored end-state blob does NOT match the authoritative hash", () => {
    const { state } = legitRun();
    const text = serializeGame(state);
    const doctored = JSON.parse(text) as { state: { units: { hp: number; alive: boolean }[] } };
    let mutated = false;
    for (const u of doctored.state.units) {
      if (u.alive) {
        u.hp = 99;
        mutated = true;
      }
    }
    expect(mutated).toBe(true);
    const loaded = deserializeGame(JSON.stringify(doctored));
    expect(loaded).not.toBeNull();
    expect(stateHash(loaded!)).not.toBe(stateHash(state));
    const v = validateReplay({
      mission: 0,
      seed: 2024,
      actions: [],
      claimedOutcome: "win",
      claimedScore: 999999,
      claimedHash: stateHash(state),
    });
    expect(v.valid).toBe(false);
  });

  it("a corrupted action log cannot impersonate the run", () => {
    const { state, log, hash } = legitRun();
    if (log.length < 2) return;
    const corrupted = log.slice();
    const firstMove = corrupted.findIndex((a) => a.kind === "move");
    const target = firstMove >= 0 ? firstMove : 0;
    if (corrupted[target].kind === "move") {
      const mv = corrupted[target] as { kind: "move"; unitId: string; path: { x: number; y: number; h: number }[] };
      mv.path = [...mv.path, { x: 0, y: 0, h: 0 }];
    } else {
      corrupted[target] = { kind: "attack", unitId: "ghost_999", ability: "silenced_shot", targetUnitId: "nobody" };
    }
    const replayed = replay(createInitialState(missionByIndex(0), 2024), corrupted);
    expect(replayed.errors.length, "corrupted log must produce replay errors").toBeGreaterThan(0);
    const v = validateReplay({
      mission: 0,
      seed: 2024,
      actions: corrupted,
      claimedOutcome: state.victory ? "win" : "lose",
      claimedScore: computeScore(state).total,
      claimedHash: hash,
    });
    expect(v.valid).toBe(false);
  });
});
