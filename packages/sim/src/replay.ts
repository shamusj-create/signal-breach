import type { GameState, PlayerAction, GameEvents } from "./types.ts";
import { applyAction } from "./state.ts";
import { stateHash } from "./hash.ts";

export interface ReplayResult {
  state: GameState;
  events: GameEvents[];
  errors: string[];
}

// Re-runs the authoritative action log from a given starting state. Rendering never participates,
// so a replay is a pure re-execution and reproduces the identical final state.
export function replay(state: GameState, actions: PlayerAction[]): ReplayResult {
  let cur = state;
  const events: GameEvents[] = [];
  const errors: string[] = [];
  for (const a of actions) {
    const res = applyAction(cur, a);
    if (res.error) errors.push(`${cur.turn}:${a.kind}:${res.error}`);
    cur = res.state;
    events.push(...res.events);
    if (cur.gameOver) break;
  }
  return { state: cur, events, errors };
}

export function replayHash(state: GameState, actions: PlayerAction[]): string {
  return stateHash(replay(state, actions).state);
}
