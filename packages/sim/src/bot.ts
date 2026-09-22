// Shared deterministic auto-solver. Used by headless tests, the debug overlay, and the server
// to generate known reproducible playthroughs. Never used to shortcut a real player action;
// it only *reads* state and emits legal PlayerActions, so it exercises the same code path.
// Policy is stealth-first: disable optics before crossing corridors, cloak + take down isolated
// unaware guards, prefer conceal lanes, only fight when the exchange is favourable.
import type { GameState, PlayerAction, Position, UnitState } from "./types.ts";
import { applyAction, previewAttack } from "./state.ts";
import { reachableCells, reconstructPathFromReach } from "./path.ts";
import { hasLineOfSight } from "./vision.ts";
import { knownThreatCells } from "./stealth.ts";

function cheb(a: Position, b: Position) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function livingPlayers(s: GameState): UnitState[] {
  return s.units.filter((u) => u.alive && u.side === "player").sort((a, b) => a.id.localeCompare(b.id));
}

function threatCells(s: GameState): Set<string> {
  const set = new Set<string>();
  for (const z of knownThreatCells(s)) for (const c of z.cells) set.add(c);
  return set;
}

function nearestEnemy(s: GameState, from: Position): UnitState | null {
  let best: UnitState | null = null;
  let bestD = Infinity;
  for (const e of s.units) {
    if (!e.alive || e.side !== "enemy") continue;
    const d = cheb(from, e.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function objectiveGoal(s: GameState, u: UnitState): Position | null {
  const coreDone = s.objectives.find((o) => o.id === "core")?.status === "done";
  if (coreDone) return s.extraction;
  const relaysDone = s.objectives.filter((o) => o.id === "relay_a" || o.id === "relay_b").every((o) => o.status === "done");
  const term = s.devices
    .filter((d) => d.kind === "terminal" && !d.hacked)
    .sort((a, b) => cheb(u.pos, { x: a.x, y: a.y, h: 0 }) - cheb(u.pos, { x: b.x, y: b.y, h: 0 }))[0];
  if (term) return { x: term.x, y: term.y, h: 0 };
  if (relaysDone) {
    const core = s.devices.find((d) => d.kind === "core" && !d.hacked);
    if (core) return { x: core.x, y: core.y, h: 0 };
  }
  return null;
}

function choosePath(s: GameState, u: UnitState, goal: Position): Position[] {
  const reach = reachableCells(s, u);
  const threats = threatCells(s);
  const nearEnemies = s.units.filter((e) => e.alive && e.side === "enemy").sort((a, b) => cheb(u.pos, a.pos) - cheb(u.pos, b.pos)).slice(0, 2);
  let bestKey: string | null = null;
  let bestScore = Infinity;
  for (const [k, info] of reach) {
    const dGoal = cheb(info.pos, goal);
    const tile = s.tiles[info.pos.y * 14 + info.pos.x];
    let score = dGoal * 3;
    if (tile && tile.terrain === "conceal") score -= 2.5;
    if (tile && tile.cover === "half") score -= 1.5;
    if (tile && tile.cover === "full") score -= 0.5;
    if (threats.has(k)) score += 6;
    for (const e of nearEnemies) {
      const d = cheb(info.pos, e.pos);
      if (d <= 2) score += 4;
      if (d <= 4 && hasLineOfSight(s, e.pos, info.pos)) score += 2;
    }
    if (score < bestScore || (score === bestScore && bestKey !== null && k < bestKey)) {
      bestScore = score;
      bestKey = k;
    }
  }
  if (!bestKey) return [];
  return reconstructPathFromReach(reach, bestKey);
}

function takedownTarget(s: GameState, u: UnitState): UnitState | null {
  if (u.archetype !== "ghost") return null;
  for (const e of s.units) {
    if (!e.alive || e.side !== "enemy") continue;
    if (cheb(u.pos, e.pos) > 1) continue;
    const pv = previewAttack(s, u.id, "takedown", e.id);
    if (pv.valid) return e;
  }
  return null;
}

function hackTarget(s: GameState, u: UnitState): { x: number; y: number; h: number } | null {
  if (u.archetype !== "cipher") return null;
  const optics = s.devices
    .filter((d) => (d.kind === "camera" || d.kind === "turret" || d.kind === "node") && d.powered && !d.disabled && d.owner === "security")
    .sort((a, b) => cheb(u.pos, { x: a.x, y: a.y, h: 0 }) - cheb(u.pos, { x: b.x, y: b.y, h: 0 }));
  for (const d of optics) {
    if (cheb(u.pos, { x: d.x, y: d.y, h: 0 }) > 5) continue;
    if (!hasLineOfSight(s, u.pos, { x: d.x, y: d.y, h: 0 })) continue;
    return { x: d.x, y: d.y, h: 0 };
  }
  return null;
}

export function autoSolve(state: GameState, maxTurns = 60): { state: GameState; log: PlayerAction[] } {
  let cur = state;
  const log: PlayerAction[] = [];
  const push = (a: PlayerAction): boolean => {
    if (cur.gameOver) return false;
    const r = applyAction(cur, a);
    if (r.error) return false;
    cur = r.state;
    log.push(a);
    return true;
  };
  for (let turn = 0; turn < maxTurns && !cur.gameOver; turn++) {
    for (const unit0 of livingPlayers(cur)) {
      if (cur.gameOver) break;
      const u0 = cur.units.find((x) => x.id === unit0.id && x.alive);
      if (!u0) continue;
      if (u0.archetype === "ghost" && !u0.statuses.some((s) => s.kind === "cloak") && u0.energy >= 3) {
        const near = nearestEnemy(cur, u0.pos);
        if (near && cheb(u0.pos, near.pos) <= 8) {
          push({ kind: "ability", unitId: u0.id, ability: "cloak" });
        }
      }
      let u1 = cur.units.find((x) => x.id === unit0.id && x.alive);
      if (!u1) continue;
      if (u1.archetype === "cipher" && u1.energy >= 4) {
        const hack = hackTarget(cur, u1);
        if (hack) push({ kind: "ability", unitId: u1.id, ability: "remote_hack", targetPos: hack });
      }
      u1 = cur.units.find((x) => x.id === unit0.id && x.alive);
      if (!u1) continue;
      let td: UnitState | null = null;
      if (u1.energy >= 3) td = takedownTarget(cur, u1);
      if (td) {
        push({ kind: "ability", unitId: u1.id, ability: "takedown", targetUnitId: td.id });
      } else if (u1.moveLeft > 0) {
        const goal = objectiveGoal(cur, u1) ?? nearestEnemy(cur, u1.pos)?.pos ?? null;
        if (goal) {
          const path = choosePath(cur, u1, goal);
          if (path.length > 0) push({ kind: "move", unitId: u1.id, path });
        }
      }
      const u2 = cur.units.find((x) => x.id === unit0.id && x.alive);
      if (!u2 || u2.energy < 3) continue;
      const targets = cur.units
        .filter((t) => t.alive && t.side === "enemy")
        .filter((t) => cheb(u2.pos, t.pos) <= u2.atkRange && hasLineOfSight(cur, u2.pos, t.pos))
        .sort((a, b) => previewAttack(cur, u2.id, u2.defaultAttack, b.id).finalDamage - previewAttack(cur, u2.id, u2.defaultAttack, a.id).finalDamage);
      if (targets.length > 0) {
        push({ kind: "attack", unitId: u2.id, ability: u2.defaultAttack, targetUnitId: targets[0].id });
      }
    }
    if (cur.gameOver) break;
    push({ kind: "endTurn" });
  }
  return { state: cur, log };
}
