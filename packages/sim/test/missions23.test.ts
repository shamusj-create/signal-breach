import { describe, it, expect } from "vitest";
import { createInitialState, missionByIndex, autoSolve, replay, stateHash, validateReplay, computeScore } from "../src/index.ts";

describe("missions 1-3 have legitimate deterministic win replays", () => {
  for (const idx of [0, 1, 2]) {
    it(`mission ${idx + 1}: stealth solver wins twice identically`, () => {
      const seed = 20261 + idx;
      const a = autoSolve(createInitialState(missionByIndex(idx), seed), 90);
      expect(a.state.victory, `solver should win M${idx + 1}: turn=${a.state.turn} gameOver=${a.state.gameOver}`).toBe(true);
      const b = autoSolve(createInitialState(missionByIndex(idx), seed), 90);
      expect(stateHash(a.state)).toBe(stateHash(b.state));
      const replayed = replay(createInitialState(missionByIndex(idx), seed), a.log);
      expect(stateHash(replayed.state)).toBe(stateHash(a.state));
      const valid = validateReplay({
        mission: idx,
        seed,
        actions: a.log,
        claimedOutcome: "win",
        claimedScore: computeScore(a.state).total,
        claimedHash: stateHash(a.state),
      });
      expect(valid.valid, JSON.stringify(valid)).toBe(true);
    });
  }
});
