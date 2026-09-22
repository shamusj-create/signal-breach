import type { PlayerAction } from "./types.ts";
import { createInitialState } from "./state.ts";
import { missionByIndex } from "./missions.ts";
import { replay } from "./replay.ts";
import { computeScore } from "./score.ts";
import { stateHash } from "./hash.ts";

export interface ReplayInput {
  mission: number;
  seed: number;
  actions: PlayerAction[];
  claimedOutcome: "win" | "lose";
  claimedScore: number;
  claimedHash?: string;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  detail?: string;
  recomputed?: { outcome: "win" | "lose"; score: number; finalHash: string; turns: number; surviving: number };
}

const MAX_ACTIONS = 4000;

// Authoritative re-run. Server and tests share this. A replay is only valid if it completes,
// contains no invalid transitions, and its outcome/score/hash match the client claim.
export function validateReplay(input: ReplayInput): ValidationResult {
  if (typeof input.mission !== "number" || input.mission < 0 || input.mission > 2) {
    return { valid: false, reason: "bad_mission" };
  }
  if (typeof input.seed !== "number" || !Number.isFinite(input.seed)) {
    return { valid: false, reason: "bad_seed" };
  }
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    return { valid: false, reason: "no_actions" };
  }
  if (input.actions.length > MAX_ACTIONS) return { valid: false, reason: "too_many_actions" };

  const initial = createInitialState(missionByIndex(input.mission), input.seed);
  const result = replay(initial, input.actions);

  if (result.errors.length > 0) return { valid: false, reason: "invalid_transition", detail: result.errors[0] };
  if (!result.state.gameOver) return { valid: false, reason: "incomplete" };

  const outcome: "win" | "lose" = result.state.victory ? "win" : "lose";
  const score = computeScore(result.state).total;
  const finalHash = stateHash(result.state);
  const surviving = result.state.units.filter((u) => u.alive && u.side === "player").length;
  const rec = { outcome, score, finalHash, turns: result.state.turn, surviving };

  if (outcome !== input.claimedOutcome) {
    return { valid: false, reason: "outcome_mismatch", recomputed: rec };
  }
  if (score !== input.claimedScore) {
    return { valid: false, reason: "score_mismatch", recomputed: rec };
  }
  if (input.claimedHash !== undefined && input.claimedHash !== finalHash) {
    return { valid: false, reason: "hash_mismatch", recomputed: rec };
  }
  return { valid: true, recomputed: rec };
}
