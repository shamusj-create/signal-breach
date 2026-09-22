// Deterministic enemy decision-making. Reads ONLY authoritative state (detection state, noise,
// alert level, known player positions). No randomness, fixed iteration order. Candidate scores
// are exposed for the debug overlay.
import type { GameState, Position, UnitState } from "./types.ts";
import { type ReachInfo, reconstructPathFromReach, posKey } from "./path.ts";
import { hasLineOfSight, previewDamage } from "./vision.ts";
import { cheb, manhattan, livingUnits } from "./queries.ts";
import { noiseInvestigate } from "./stealth.ts";

export interface EnemyAction {
  move?: Position[];
  ability: string;
  targetUnitId?: string;
  targetPos?: Position;
}

export interface AiCandidate {
  key: string;
  dest: Position;
  ability: string;
  targetUnitId?: string;
  score: number;
  dbg: {
    expectedDamage: number;
    kill: boolean;
    cover: number;
    exposure: number;
    advance: number;
    hunt: number;
    objective: number;
    alert: number;
    noise: number;
  };
}

function tileCover(state: GameState, p: Position): "none" | "half" | "full" {
  const t = state.tiles[p.y * 14 + p.x];
  return t ? t.cover : "none";
}

function coverValue(c: "none" | "half" | "full"): number {
  return c === "full" ? 2 : c === "half" ? 1 : 0;
}

function exposureThreat(state: GameState, pos: Position, me: UnitState): number {
  let threat = 0;
  for (const p of state.units) {
    if (!p.alive || p.side === me.side) continue;
    if (cheb(p.pos, pos) <= p.atkRange && hasLineOfSight(state, p.pos, pos)) {
      const d = previewDamage(state, p, me, p.atkDamage);
      threat += d.valid ? d.finalDamage : 0;
    }
  }
  return threat;
}

function friendlyFireRisk(state: GameState, pos: Position, me: UnitState): number {
  // a hijacked turret shoots enemies: allies avoid parking under it
  for (const t of state.devices) {
    if (t.kind !== "turret" || !t.powered || t.disabled) continue;
    if (t.owner !== "hijacked") continue;
    if (me.side !== "enemy") continue;
    if (cheb({ x: t.x, y: t.y, h: 0 }, pos) > (t.range ?? 5)) continue;
    if (!hasLineOfSight(state, { x: t.x, y: t.y, h: 0 }, pos)) continue;
    return 2;
  }
  return 0;
}

function objectiveUnderThreat(state: GameState): { pos: Position; threat: number } | null {
  let best: { pos: Position; threat: number } | null = null;
  for (const d of state.devices) {
    if (d.kind !== "terminal" && d.kind !== "core") continue;
    if (d.hacked) continue;
    if (d.kind === "core") {
      const done = (o: string) => state.objectives.find((x) => x.id === o)?.status === "done";
      if (!(done("relay_a") && done("relay_b"))) continue;
    }
    for (const p of livingUnits(state, "player")) {
      const t = 4 - Math.min(cheb(p.pos, { x: d.x, y: d.y, h: 0 }), 4);
      if (t > 0 && (!best || t > best.threat)) best = { pos: { x: d.x, y: d.y, h: 0 }, threat: t };
    }
  }
  return best;
}

export function aiCandidates(state: GameState, enemy: UnitState, reach: Map<string, ReachInfo>): AiCandidate[] {
  const targets = livingUnits(state, "player").sort((a, b) => a.id.localeCompare(b.id));
  const cands: AiCandidate[] = [];
  const dests: { pos: Position; key: string }[] = [{ pos: { ...enemy.pos }, key: posKey(enemy.pos.x, enemy.pos.y) }];
  const reachKeys = [...reach.keys()].sort();
  for (const k of reachKeys) {
    if (k === dests[0].key) continue;
    dests.push({ pos: reach.get(k)!.pos, key: k });
  }
  const huntPos =
    enemy.detState === "alerted" || enemy.detState === "searching"
      ? enemy.searchPos ?? null
      : noiseInvestigate(state, enemy);
  const guard = objectiveUnderThreat(state);
  const alert = state.alert;
  const aggressive = alert >= 2 || enemy.detState === "alerted";
  for (const dest of dests) {
    const cover = coverValue(tileCover(state, dest.pos));
    const exposure = exposureThreat(state, dest.pos, enemy);
    const ff = friendlyFireRisk(state, dest.pos, enemy);
    const nearestPlayer = targets.length > 0 ? targets.reduce((acc, t) => (manhattan(enemy.pos, t.pos) < manhattan(enemy.pos, acc.pos) ? t : acc)) : null;
    const advance = nearestPlayer ? -Math.min(manhattan(dest.pos, nearestPlayer.pos), 20) : 0;
    const hunt = huntPos ? -Math.min(manhattan(dest.pos, huntPos), 24) : 0;
    let objective = 0;
    if (guard) {
      const dToPlayer = nearestPlayer ? manhattan(dest.pos, nearestPlayer.pos) : 20;
      const dToObj = manhattan(dest.pos, guard.pos);
      objective = 6 - dToPlayer * 0.35 - dToObj * 0.25;
    }
    let bestTarget: AiCandidate | null = null;
    for (const t of targets) {
      if (cheb(dest.pos, t.pos) > enemy.atkRange) continue;
      if (!hasLineOfSight(state, dest.pos, t.pos)) continue;
      const ignoreCover = enemy.archetype === "enforcer" || enemy.archetype === "cipher";
      const pv = previewDamage(state, enemy, t, enemy.atkDamage, { ignoreCover });
      if (!pv.valid) continue;
      const flank = enemy.archetype === "hunter" || enemy.archetype === "warden" ? 2 : 0;
      const score =
        12 * pv.finalDamage +
        (pv.lethal ? 22 : 0) +
        4 * cover -
        3 * exposure -
        2 * ff +
        0.6 * advance +
        (aggressive ? 1.4 : 0.5) * hunt +
        objective +
        flank +
        (aggressive ? 6 : 0);
      const cand: AiCandidate = {
        key: `${dest.key}>atk:${t.id}`,
        dest: dest.pos,
        ability: enemy.defaultAttack ?? enemy.abilities[0],
        targetUnitId: t.id,
        score,
        dbg: { expectedDamage: pv.finalDamage, kill: pv.lethal, cover, exposure, advance, hunt, objective, alert, noise: 0 },
      };
      if (!bestTarget || score > bestTarget.score) bestTarget = cand;
    }
    if (enemy.archetype === "warden") {
      const allies = livingUnits(state, "enemy").filter((a) => a.hp < a.maxHp * 0.7);
      const heal = allies.sort((a, b) => a.hp - b.hp)[0];
      if (heal) {
        const score = 20 + 4 * cover - 3 * exposure + (aggressive ? 4 : 0);
        cands.push({
          key: `${dest.key}>shield:${heal.id}`,
          dest: dest.pos,
          ability: "warden_field",
          targetUnitId: heal.id,
          score,
          dbg: { expectedDamage: 0, kill: false, cover, exposure, advance, hunt, objective, alert, noise: 0 },
        });
      }
    }
    if (bestTarget) {
      cands.push(bestTarget);
    } else {
      const noise = huntPos ? 1 : 0;
      cands.push({
        key: `${dest.key}>move`,
        dest: dest.pos,
        ability: enemy.abilities[0],
        score: 4 * cover - 3 * exposure - 2 * ff + 0.6 * advance + (aggressive ? 1.4 : 0.5) * hunt + objective + (noise ? 1 : 0),
        dbg: { expectedDamage: 0, kill: false, cover, exposure, advance, hunt, objective, alert, noise },
      });
    }
  }
  return cands;
}

export function decideEnemyActions(state: GameState, enemy: UnitState, reach: Map<string, ReachInfo>): EnemyAction[] {
  const cands = aiCandidates(state, enemy, reach);
  if (cands.length === 0) return [];
  cands.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    if (a.dbg.exposure !== b.dbg.exposure) return a.dbg.exposure - b.dbg.exposure;
    return a.key < b.key ? -1 : 1;
  });
  const best = cands[0];
  const startKey = posKey(enemy.pos.x, enemy.pos.y);
  const destKey = posKey(best.dest.x, best.dest.y);
  let move: Position[] | undefined;
  if (destKey !== startKey) {
    move = reconstructPathFromReach(reach, destKey);
    if (move.length === 0) move = undefined;
  }
  return [{ move, ability: best.ability, targetUnitId: best.targetUnitId }];
}