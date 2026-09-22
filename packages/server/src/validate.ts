import type { DatabaseSync } from "node:sqlite";
import { validateReplay, type ReplayInput } from "@sb/sim";
import { addEntry, top, type LeaderRow } from "./leaderboard.ts";

export interface SubmitResult {
  accepted: boolean;
  reason?: string;
  entry?: LeaderRow;
  recomputed?: unknown;
}

// Server-authoritative validation: re-run the shared sim, compare, and only store validated runs.
export function submitRun(db: DatabaseSync, input: ReplayInput & { player?: string }): SubmitResult {
  const v = validateReplay(input);
  if (!v.valid || !v.recomputed) {
    return { accepted: false, reason: v.reason ?? "invalid" };
  }
  if (v.recomputed.outcome !== "win") {
    return { accepted: false, reason: "not_a_win" };
  }
  const entry: LeaderRow = {
    player: (input.player ?? "anon").slice(0, 24),
    mission: input.mission,
    score: v.recomputed.score,
    turns: v.recomputed.turns,
    survival: v.recomputed.surviving,
    ts: Date.now(),
    replay_id: `${input.seed}:${input.actions.length}:${v.recomputed.finalHash}`,
  };
  addEntry(db, entry);
  return { accepted: true, entry, recomputed: v.recomputed };
}

export function leaderboard(db: DatabaseSync, mission: number | "all", limit?: number) {
  return top(db, mission, limit);
}
