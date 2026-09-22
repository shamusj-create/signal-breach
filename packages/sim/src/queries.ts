import type { GameState, UnitState, Position, Side } from "./types.ts";
import { isBlockingMove, tileAt } from "./map.ts";

export function unitById(state: GameState, id: string): UnitState | undefined {
  return state.units.find((u) => u.id === id);
}

export function livingUnits(state: GameState, side?: Side): UnitState[] {
  return state.units.filter((u) => u.alive && (side ? u.side === side : true));
}

export function unitAtPos(state: GameState, x: number, y: number): UnitState | undefined {
  return state.units.find((u) => u.alive && u.pos.x === x && u.pos.y === y);
}

export function isWalkableEmpty(state: GameState, x: number, y: number): boolean {
  if (isBlockingMove(state, x, y)) return false;
  return !unitAtPos(state, x, y);
}

export function heightAt(state: GameState, x: number, y: number): number {
  const t = tileAt(state, x, y);
  return t ? t.height : 0;
}

export function cheb(a: Position, b: Position): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function manhattan(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// Objective devices that are currently hackable (relays). Extraction handled separately.
export function coreAvailable(state: GameState): boolean {
  const a = state.objectives.find((o) => o.id === "relay_a");
  const b = state.objectives.find((o) => o.id === "relay_b");
  return !!a && !!b && a.status === "done" && b.status === "done";
}

export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}
