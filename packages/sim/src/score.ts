import type { GameState } from "./types.ts";

export interface ScoreBreakdown {
  victory: number;
  survival: number;
  speed: number;
  damageTaken: number;
  objectives: number;
  total: number;
}

export const PAR_TURNS: Record<number, number> = { 0: 10, 1: 14, 2: 18 };

export function computeScore(state: GameState): ScoreBreakdown {
  const alive = state.units.filter((u) => u.alive && u.side === "player");
  const squadSize = state.units.filter((u) => u.side === "player").length;
  const victory = state.victory ? 1000 : 0;
  const survival = alive.length * 200;
  const par = PAR_TURNS[state.mission] ?? 12;
  const speed = state.victory ? Math.max(0, (par - state.turn) * 25) : 0;
  let hpLost = 0;
  for (const u of state.units) if (u.side === "player") hpLost += u.maxHp - u.hp;
  const damageTaken = -hpLost * 3;
  let objectives = 0;
  for (const o of state.objectives) if (o.id !== "extraction" && o.status === "done") objectives += 150;
  const total = Math.max(0, victory + survival + speed + damageTaken + objectives);
  void squadSize;
  return { victory, survival, speed, damageTaken, objectives, total };
}
