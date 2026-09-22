import type { GameState } from "./types.ts";

// Synchronous, dependency-free stable hash (FNV-1a 32-bit over a canonical projection).
// Used for determinism assertions and replay comparison. Deterministic across Node/browser.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Canonical projection excludes purely cosmetic fields (facing). Includes all state that
// affects rules so two identical simulations hash identically.
export function stateProjection(state: GameState): string {
  const u = state.units.map((x) => `${x.id}:${x.alive ? 1 : 0}:${x.hp}:${x.pos.x},${x.pos.y},${x.pos.h}:${x.energy}:${x.moveLeft}:${x.statuses.map((s) => `${s.kind}${s.power ?? ""}${s.turns}`).join("|")}:${x.detState}:${x.detMeter}:${x.facing}`);
  const dev = state.devices.map((d) => `${d.id}:${d.hacked ? 1 : 0}:${d.disabled ? 1 : 0}:${d.owner}:${d.powered ? 1 : 0}`);
  const doors = state.doors.map((d) => `${d.id}:${d.open ? 1 : 0}`);
  const obj = state.objectives.map((o) => `${o.id}:${o.status}`);
  const dest = state.destructibles.map((d) => `${d.id}:${d.destroyed ? 1 : 0}:${d.hp}`);
  let visSum = 0;
  for (const v of state.vis) visSum += v;
  return [state.turn, state.phase, state.mission, state.victory ? 1 : 0, state.gameOver ? 1 : 0, `a${state.alert}f${state.alertFocus ? state.alertFocus.x + "," + state.alertFocus.y : "-"}`, `v${visSum}`, `n${state.noises.length}:${state.noises.map((n) => `${n.src}@${n.x},${n.y}:${n.power}`).join(",")}`, u.join(";"), dev.join(";"), doors.join(";"), obj.join(";"), dest.join(";")].join("~");
}

export function stateHash(state: GameState): string {
  return fnv1a(stateProjection(state));
}
