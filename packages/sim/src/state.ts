import type { GameState, PlayerAction, UnitState, Position, GameEvents, ObjectiveState, DeviceState } from "./types.ts";
import { buildMap } from "./map.ts";
import { UNIT_DEFS, makeUnit, resetUnitCounters, faceEnemyTowards } from "./units.ts";
import { ABILITIES } from "./abilities.ts";
import { reachableCells, pathCost } from "./path.ts";
import { hasLineOfSight, previewDamage } from "./vision.ts";
import { cloneState, unitAtPos, isWalkableEmpty, cheb } from "./queries.ts";
import { decideEnemyActions } from "./ai.ts";
import { perceptionPass, updateVisibility, emitNoise, decayNoise, noiseAtPoint, escalate, knownEnemies, knownThreatCells, pathThreat, resetNoiseSeq } from "./stealth.ts";

export interface MissionDef {
  index: number;
  name: string;
  layout: string[];
  players: { archetype: keyof typeof UNIT_DEFS; x: number; y: number }[];
  enemies: { archetype: keyof typeof UNIT_DEFS; x: number; y: number }[];
}

export interface ApplyResult {
  state: GameState;
  events: GameEvents[];
  error?: string;
}

function addLog(s: GameState, msg: string): void {
  s.log.push(msg);
  if (s.log.length > 500) s.log.shift();
}

const NOISE_POWER: Record<string, number> = {
  move: 2,
  sprint: 4,
  dash: 4,
  blink: 1,
  pulse_rifle: 6,
  concussion: 8,
  silenced_shot: 1,
  backstab: 1,
  takedown: 1,
  arc_bolt: 2,
  emp: 4,
  enforcer_slam: 5,
  hunter_rush: 6,
  sentry_shot: 6,
  turret: 7,
  explosion: 9,
  cloak: 0,
  overwatch: 0,
  barrier: 0,
  remote_hack: 0,
  warden_field: 3,
};

export function noisePowerOf(kind: string): number {
  return NOISE_POWER[kind] ?? 0;
}

export function createInitialState(mission: MissionDef, seed: number): GameState {
  resetUnitCounters();
  resetNoiseSeq();
  const built = buildMap({ layout: mission.layout });
  const units: UnitState[] = [];
  for (const p of mission.players) {
    const t = built.tiles[p.y * 14 + p.x];
    units.push(makeUnit(p.archetype, "player", { x: p.x, y: p.y, h: t ? t.height : 0 }));
  }
  for (const e of mission.enemies) {
    const t = built.tiles[e.y * 14 + e.x];
    units.push(makeUnit(e.archetype, "enemy", { x: e.x, y: e.y, h: t ? t.height : 0 }, e.archetype.toUpperCase()));
  }
  for (const e of units) {
    if (e.side !== "enemy") continue;
    let nearest: UnitState | null = null;
    let best = Infinity;
    for (const p of units) {
      if (p.side !== "player") continue;
      const d = cheb(e.pos, p.pos);
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    if (nearest) faceEnemyTowards(e, nearest.pos);
  }
  const relays = built.devices.filter((d) => d.kind === "terminal").sort((a, b) => a.y * 100 + a.x - (b.y * 100 + b.x));
  if (relays[0]) relays[0].objectiveId = "relay_a";
  if (relays[1]) relays[1].objectiveId = "relay_b";
  for (const d of built.devices) if (d.kind === "core") d.objectiveId = "core";

  const objectives: ObjectiveState[] = [
    { id: "relay_a", status: "available", label: "Relay Alpha" },
    { id: "relay_b", status: "available", label: "Relay Beta" },
    { id: "core", status: "locked", label: "Core Node" },
    { id: "extraction", status: "locked", label: "Extraction" },
  ];
  const state: GameState = {
    version: 3,
    revision: 0,
    seed,
    mission: mission.index,
    phase: "player",
    turn: 1,
    activeUnitId: null,
    units,
    tiles: built.tiles,
    width: 14,
    height: 14,
    doors: built.doors,
    devices: built.devices,
    destructibles: built.destructibles,
    extraction: built.extraction,
    objectives,
    gameOver: false,
    victory: false,
    rngState: seed >>> 0,
    log: [],
    vis: new Array(196).fill(0),
    noises: [],
    alert: 0,
    alertCool: 0,
    alertFocus: null,
  };
  startPlayerPhase(state);
  updateVisibility(state);
  return state;
}

function startPlayerPhase(state: GameState): void {
  state.phase = "player";
  for (const u of state.units) {
    if (u.side === "player" && u.alive) {
      u.energy = u.maxEnergy;
      u.moveLeft = u.maxMove;
      u.activated = false;
      u.statuses = u.statuses.filter((s) => s.kind !== "overwatch");
    }
  }
}

function startEnemyPhase(state: GameState): void {
  state.phase = "enemy";
  for (const u of state.units) {
    if (u.side === "enemy" && u.alive) {
      u.energy = u.maxEnergy;
      u.moveLeft = u.maxMove;
      if (state.alert >= 2 && u.detMeter < 40) u.detMeter = 40;
      if (state.alert === 3) {
        for (const d of state.doors) if (d.secure && !d.hacked) d.open = false;
      }
    }
  }
}

export function playerUnits(state: GameState): UnitState[] {
  return state.units.filter((u) => u.side === "player" && u.alive);
}

export function checkGameOver(state: GameState): void {
  const alive = state.units.filter((u) => u.alive && u.side === "player");
  if (alive.length === 0 && !state.gameOver) {
    state.gameOver = true;
    state.victory = false;
    addLog(state, "All operatives down. Mission failed.");
    return;
  }
  const core = state.objectives.find((o) => o.id === "core")!;
  const extraction = state.objectives.find((o) => o.id === "extraction")!;
  if (core.status === "done" && extraction.status === "locked") {
    extraction.status = "available";
    addLog(state, "Extraction unlocked.");
  }
  if (core.status === "done") {
    const onX = state.units.find(
      (u) => u.alive && u.side === "player" && u.pos.x === state.extraction.x && u.pos.y === state.extraction.y,
    );
    if (onX && !state.gameOver) {
      state.victory = true;
      state.gameOver = true;
      addLog(state, "Extraction reached. Mission complete.");
    }
  }
}

export function validatePath(state: GameState, unit: UnitState, path: Position[]): string | undefined {
  if (path.length === 0) return "empty_path";
  let cur: Position = { ...unit.pos };
  let cost = 0;
  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const dx = Math.abs(step.x - cur.x);
    const dy = Math.abs(step.y - cur.y);
    if (dx + dy !== 1) return "non_adjacent";
    const tile = state.tiles[step.y * 14 + step.x];
    if (!tile) return "blocked";
    const occ = unitAtPos(state, step.x, step.y);
    if (occ) return "occupied";
    if (tile.blocksMove) return "blocked";
    if (Math.abs(tile.height - (state.tiles[cur.y * 14 + cur.x]?.height ?? 0)) > 1) return "cliff";
    let stepCost = tile.moveCost;
    if (tile.height > (state.tiles[cur.y * 14 + cur.x]?.height ?? 0)) stepCost += 1;
    cost += stepCost;
    if (cost > unit.moveLeft) return "not_enough_move";
    cur = step;
  }
  return undefined;
}

function applyMove(state: GameState, unit: UnitState, path: Position[], sprint: boolean, events: GameEvents[]): void {
  const dest = path[path.length - 1];
  const cost = pathCost(state, [{ ...unit.pos }, ...path]);
  const first = path[0];
  unit.facing = path.length === 1 ? facingDelta(unit, first) : facingDelta(unit, path[Math.min(1, path.length - 1)]);
  unit.pos = { x: dest.x, y: dest.y, h: dest.h };
  unit.moveLeft = Math.max(0, unit.moveLeft - cost);
  const loud = sprint || path.length > 3;
  emitNoise(state, dest.x, dest.y, loud ? 4 : 2, loud ? "sprint" : "move");
  if (loud) noiseAlarm(state, dest.x, dest.y, 4, events);
  events.push({ kind: "move", data: { unitId: unit.id, to: dest, sprint: loud } });
  fireReactions(state, unit, events);
  const tile = state.tiles[dest.y * 14 + dest.x];
  if (tile && tile.terrain === "hazard") {
    applyDamage(state, unit, 3, "hazard", events);
  }
  tryAutoHack(state, unit, events);
}

function facingDelta(unit: UnitState, step: Position): number {
  const dx = step.x - unit.pos.x;
  const dy = step.y - unit.pos.y;
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
  return oct;
}

export function fireReactions(state: GameState, mover: UnitState, events: GameEvents[]): void {
  const otherSide: "player" | "enemy" = mover.side === "player" ? "enemy" : "player";
  for (const watcher of state.units) {
    if (!watcher.alive || watcher.side !== otherSide) continue;
    const ow = watcher.statuses.find((s) => s.kind === "overwatch" && !s.power);
    if (!ow) continue;
    if (cheb(watcher.pos, mover.pos) > watcher.atkRange) continue;
    if (!hasLineOfSight(state, watcher.pos, mover.pos)) continue;
    const preview = previewDamage(state, watcher, mover, watcher.atkDamage);
    if (!preview.valid) continue;
    applyDamage(state, mover, preview.finalDamage, "reaction", events);
    ow.power = 1;
    events.push({ kind: "reaction", data: { by: watcher.id, on: mover.id } });
  }
}

export function applyDamage(state: GameState, target: UnitState, amount: number, source: string, events: GameEvents[]): void {
  if (!target.alive || amount <= 0) return;
  const barrier = target.statuses.find((s) => s.kind === "barrier" && (s.power ?? 0) > 0);
  let dmg = amount;
  if (barrier) {
    const abs = Math.min(barrier.power ?? 0, dmg);
    barrier.power = (barrier.power ?? 0) - abs;
    dmg -= abs;
    if ((barrier.power ?? 0) <= 0) target.statuses = target.statuses.filter((s) => s !== barrier);
  }
  target.hp -= dmg;
  events.push({ kind: "damage", data: { unitId: target.id, amount: dmg, source } });
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    events.push({ kind: "death", data: { unitId: target.id } });
    addLog(state, `${target.name} incapacitated.`);
  }
}

function deductEnergy(unit: UnitState, cost: number): boolean {
  if (unit.energy < cost) return false;
  unit.energy -= cost;
  return true;
}

export function getUnit(state: GameState, id: string): UnitState | undefined {
  return state.units.find((u) => u.id === id);
}

function alliesAwareOf(state: GameState, victim: UnitState): UnitState[] {
  return state.units.filter((u) => u.alive && u.side === victim.side && u.id !== victim.id && cheb(u.pos, victim.pos) <= 8 && hasLineOfSight(state, u.pos, victim.pos));
}

function noiseAlarm(state: GameState, x: number, y: number, power: number, events: GameEvents[]): void {
  const at = { x, y, h: 0 };
  let heard = false;
  for (const e of state.units) {
    if (!e.alive || e.side !== "enemy") continue;
    if (noiseAtPoint(state, e.pos) >= 1) {
      heard = true;
      if (e.detState === "unaware" && power >= 6) {
        e.detMeter = Math.max(e.detMeter, 30);
        e.searchPos = { x, y, h: 0 };
        e.searchTurns = 2;
        e.detState = "suspicious";
      }
    }
  }
  if (heard && power >= 6) escalate(state, 1, at);
  void events;
}

export function resolveAttack(state: GameState, attacker: UnitState, ability: string, targetId: string, events: GameEvents[]): string | undefined {
  const target = getUnit(state, targetId);
  if (!target || !target.alive) return "no_target";
  const def = ABILITIES[ability as keyof typeof ABILITIES];
  if (!def) return "bad_ability";
  if (!hasLineOfSight(state, attacker.pos, target.pos)) return "no_los";
  if (!deductEnergy(attacker, def.cost)) return "not_enough_energy";
  const ignoreCover = ability === "arc_bolt" || ability === "backstab" || ability === "enforcer_slam";
  const base = ability === "backstab" ? attacker.atkDamage + 4 : attacker.atkDamage;
  const preview = previewDamage(state, attacker, target, base, { ignoreCover });
  if (!preview.valid) return "invalid";
  applyDamage(state, target, preview.finalDamage, ability, events);
  const quiet = ability === "silenced_shot" || ability === "backstab";
  attacker.facing = facingDelta(attacker, target.pos);
  emitNoise(state, attacker.pos.x, attacker.pos.y, noisePowerOf(ability), ability);
  if (!quiet) noiseAlarm(state, attacker.pos.x, attacker.pos.y, noisePowerOf(ability), events);
  if (target.alive && !quiet) {
    for (const a of alliesAwareOf(state, target)) {
      if (a.detState === "unaware") {
        a.detMeter = Math.max(a.detMeter, 30);
        a.searchPos = { ...target.pos };
        a.searchTurns = 2;
        a.detState = "suspicious";
      }
    }
  }
  if (!quiet) attacker.statuses = attacker.statuses.filter((s) => s.kind !== "cloak");
  return undefined;
}

export function previewAttack(state: GameState, attackerId: string, ability: string, targetId: string) {
  const attacker = getUnit(state, attackerId);
  const target = getUnit(state, targetId);
  if (!attacker || !target) return { valid: false, reason: "no_unit", baseDamage: 0, cover: "none" as const, coverMult: 1, finalDamage: 0, shielded: 0, lethal: false };
  if (ability === "takedown") {
    const ok =
      cheb(attacker.pos, target.pos) <= 1 &&
      (target.detState === "unaware" || target.detState === "suspicious") &&
      !target.statuses.some((s) => s.kind === "barrier");
    return { valid: ok, reason: ok ? undefined : "takedown_invalid", baseDamage: 99, cover: "none" as const, coverMult: 1, finalDamage: ok ? 99 : 0, shielded: 0, lethal: ok };
  }
  const ignoreCover = ability === "arc_bolt" || ability === "backstab" || ability === "enforcer_slam";
  const base = ability === "backstab" ? attacker.atkDamage + 4 : attacker.atkDamage;
  const dist = Math.max(Math.abs(attacker.pos.x - target.pos.x), Math.abs(attacker.pos.y - target.pos.y));
  const p = previewDamage(state, attacker, target, base, { ignoreCover });
  if (dist > attacker.atkRange) return { ...p, valid: false, reason: "out_of_range" };
  return p;
}

function findDeviceAt(state: GameState, x: number, y: number) {
  return state.devices.find((d) => d.x === x && d.y === y);
}

export function hackObjective(state: GameState, deviceId: string, events: GameEvents[]): string | undefined {
  const dev = state.devices.find((d) => d.id === deviceId);
  if (!dev) return "no_device";
  if (dev.hacked) return "already";
  if (dev.kind === "core") {
    const done = (o: string) => state.objectives.find((x) => x.id === o)?.status === "done";
    if (!(done("relay_a") && done("relay_b"))) return "locked";
  }
  dev.hacked = true;
  events.push({ kind: "hack", data: { deviceId: dev.id } });
  if (dev.objectiveId) {
    const obj = state.objectives.find((o) => o.id === dev.objectiveId);
    if (obj && obj.status !== "done") obj.status = "done";
  }
  if (dev.kind === "core") {
    const ex = state.objectives.find((o) => o.id === "extraction");
    if (ex) ex.status = "available";
    addLog(state, "Core breached. Reach extraction.");
  }
  return undefined;
}

function securityHack(state: GameState, dev: DeviceState, events: GameEvents[]): string | undefined {
  if (dev.kind === "camera") {
    dev.owner = "disabled";
    dev.powered = false;
    events.push({ kind: "hack", data: { deviceId: dev.id, mode: "camera_off" } });
    addLog(state, "Camera disabled.");
    return undefined;
  }
  if (dev.kind === "turret") {
    if (state.alert < 2) {
      dev.owner = "hijacked";
      events.push({ kind: "hack", data: { deviceId: dev.id, mode: "turret_hijack" } });
      addLog(state, "Turret turned against its owners.");
      return undefined;
    }
    dev.owner = "disabled";
    dev.powered = false;
    events.push({ kind: "hack", data: { deviceId: dev.id, mode: "turret_off" } });
    return undefined;
  }
  if (dev.kind === "node") {
    dev.owner = "disabled";
    dev.powered = false;
    for (const other of state.devices) {
      if (other.id !== dev.id && (other.kind === "camera" || other.kind === "turret") && other.netId === dev.netId) {
        other.owner = "disabled";
        other.powered = false;
      }
    }
    if (state.alert > 0) {
      state.alert -= 1;
      state.alertCool = 0;
    }
    events.push({ kind: "hack", data: { deviceId: dev.id, mode: "blackout" } });
    addLog(state, `Security network ${dev.netId} blacked out.`);
    return undefined;
  }
  return hackObjective(state, dev.id, events);
}

function tryAutoHack(state: GameState, unit: UnitState, events: GameEvents[]): void {
  for (const dev of state.devices) {
    if (dev.hacked) continue;
    if (dev.kind !== "terminal" && dev.kind !== "core") continue;
    if (dev.objectiveId === "core") {
      const done = (o: string) => state.objectives.find((x) => x.id === o)?.status === "done";
      if (!(done("relay_a") && done("relay_b"))) continue;
    }
    if (cheb(unit.pos, { x: dev.x, y: dev.y, h: 0 }) <= 1) {
      hackObjective(state, dev.id, events);
    }
  }
}

function tryTakedown(state: GameState, unit: UnitState, targetId: string | undefined, events: GameEvents[]): string | undefined {
  if (!targetId) return "no_target";
  const target = getUnit(state, targetId);
  if (!target || !target.alive) return "no_target";
  if (!deductEnergy(unit, 3)) return "not_enough_energy";
  if (cheb(unit.pos, target.pos) > 1) return "out_of_range";
  if (target.detState === "alerted" || target.detState === "searching") return "target_alerted";
  applyDamage(state, target, 99, "takedown", events);
  emitNoise(state, unit.pos.x, unit.pos.y, 1, "takedown");
  if (target.detState === "suspicious") {
    for (const a of alliesAwareOf(state, target)) {
      if (cheb(a.pos, target.pos) <= 3 && a.detState === "unaware") {
        a.detMeter = Math.max(a.detMeter, 20);
        a.searchPos = { ...target.pos };
        a.searchTurns = 2;
      }
    }
  }
  return undefined;
}

export function applyAbility(
  state: GameState,
  unit: UnitState,
  ability: string,
  targetUnitId?: string,
  targetPos?: Position,
  events: GameEvents[] = [],
): string | undefined {
  const def = ABILITIES[ability as keyof typeof ABILITIES];
  if (!def) return "bad_ability";
  if (ability === "takedown") {
    return tryTakedown(state, unit, targetUnitId ?? (targetPos ? state.units.find((u) => u.alive && u.side !== unit.side && u.pos.x === targetPos!.x && u.pos.y === targetPos!.y)?.id : undefined), events);
  }
  if (def.kind === "attack") {
    if (!targetUnitId && targetPos) {
      const dest = state.destructibles.find((d) => d.x === targetPos.x && d.y === targetPos.y && !d.destroyed);
      if (dest) {
        if (!deductEnergy(unit, def.cost)) return "not_enough_energy";
        if (cheb(unit.pos, targetPos) > def.range) return "out_of_range";
        const dmg = ability === "arc_bolt" ? 4 : ability === "concussion" ? 5 : 3;
        dest.hp -= dmg;
        events.push({ kind: "dest_damage", data: { destId: dest.id, amount: dmg } });
        if (dest.hp <= 0) {
          dest.destroyed = true;
          if (dest.kind === "cell") {
            for (const u of state.units) {
              if (u.alive && u.id !== unit.id && cheb(u.pos, { x: dest.x, y: dest.y, h: 0 }) <= 2 && u.archetype !== "enforcer") {
                applyDamage(state, u, 4, "explosion", events);
              }
            }
            emitNoise(state, dest.x, dest.y, 9, "explosion");
          } else {
            emitNoise(state, dest.x, dest.y, 3, "break");
          }
          events.push({ kind: "dest_destroyed", data: { destId: dest.id } });
          addLog(state, `${dest.label} destroyed.`);
        }
        if (ability !== "arc_bolt") unit.statuses = unit.statuses.filter((s) => s.kind !== "cloak");
        return undefined;
      }
    }
    const enemySide = unit.side === "player" ? "enemy" : "player";
    const targetId =
      targetUnitId ??
      (targetPos ? state.units.find((u) => u.alive && u.side === enemySide && u.pos.x === targetPos!.x && u.pos.y === targetPos!.y)?.id : undefined);
    if (!targetId) return "no_target";
    return resolveAttack(state, unit, ability, targetId, events);
  }
  if (!deductEnergy(unit, def.cost)) return "not_enough_energy";
  switch (ability) {
    case "dash":
    case "blink": {
      if (!targetPos) return "no_target";
      const range = ability === "dash" ? 3 : 4;
      if (cheb(unit.pos, targetPos) > range) return "out_of_range";
      if (!isWalkableEmpty(state, targetPos.x, targetPos.y)) return "invalid_target";
      applyMove(state, unit, [targetPos], ability === "dash", events);
      return undefined;
    }
    case "cloak": {
      unit.statuses = unit.statuses.filter((s) => s.kind !== "cloak");
      unit.statuses.push({ kind: "cloak", turns: 99 });
      events.push({ kind: "cloak", data: { unitId: unit.id } });
      return undefined;
    }
    case "overwatch": {
      unit.statuses = unit.statuses.filter((s) => s.kind !== "overwatch");
      unit.statuses.push({ kind: "overwatch", turns: 99 });
      events.push({ kind: "overwatch", data: { unitId: unit.id } });
      return undefined;
    }
    case "barrier": {
      const targetId = targetUnitId ?? unit.id;
      const target = getUnit(state, targetId);
      if (!target || !target.alive) return "no_target";
      target.statuses = target.statuses.filter((s) => s.kind !== "barrier");
      target.statuses.push({ kind: "barrier", turns: 99, power: 8 });
      events.push({ kind: "barrier", data: { unitId: target.id, power: 8 } });
      return undefined;
    }
    case "emp": {
      if (!targetPos) return "no_target";
      for (const d of state.devices) if (cheb({ x: d.x, y: d.y, h: 0 }, targetPos) <= 2) d.disabled = true;
      for (const u of state.units) {
        if (!u.alive) continue;
        if (cheb(u.pos, targetPos) <= 2 && u.side !== unit.side) {
          u.statuses = u.statuses.filter((s) => s.kind !== "barrier");
          if (u.archetype === "sentry" || u.archetype === "warden") u.statuses.push({ kind: "stun", turns: 1 });
          if (u.statuses.some((s) => s.kind === "cloak")) {
            const before = u.statuses.length;
            u.statuses = u.statuses.filter((s) => s.kind !== "cloak");
            if (u.statuses.length !== before) events.push({ kind: "cloak_broken", data: { unitId: u.id } });
          }
        }
      }
      emitNoise(state, targetPos.x, targetPos.y, 4, "emp");
      events.push({ kind: "emp", data: { at: targetPos } });
      return undefined;
    }
    case "remote_hack": {
      if (targetUnitId && state.doors.some((d) => d.id === targetUnitId)) {
        const door = state.doors.find((d) => d.id === targetUnitId)!;
        door.open = true;
        events.push({ kind: "hack", data: { deviceId: door.id, mode: "door_open" } });
        return undefined;
      }
      const dev = targetPos ? findDeviceAt(state, targetPos.x, targetPos.y) : targetUnitId ? state.devices.find((d) => d.id === targetUnitId) : undefined;
      if (!dev) return "no_target";
      if (!hasLineOfSight(state, unit.pos, { x: dev.x, y: dev.y, h: 0 })) return "no_los";
      return securityHack(state, dev, events);
    }
    case "warden_field": {
      const target = targetUnitId ? getUnit(state, targetUnitId) : undefined;
      if (target && target.alive && target.side === unit.side && target.hp < target.maxHp * 0.7) {
        target.statuses = target.statuses.filter((s) => s.kind !== "barrier");
        target.statuses.push({ kind: "barrier", turns: 99, power: 6 });
        events.push({ kind: "barrier", data: { unitId: target.id, power: 6 } });
        return undefined;
      }
      if (target && target.alive && target.side !== unit.side) return resolveAttack(state, unit, "warden_field", target.id, events);
      return undefined;
    }
    default:
      return undefined;
  }
}

function postAction(state: GameState): void {
  updateVisibility(state);
  perceptionPass(state);
}

function applyActionNoEnemy(state: GameState, action: PlayerAction): ApplyResult {
  const clone = cloneState(state);
  const events: GameEvents[] = [];
  if (clone.gameOver) return { state, events, error: "game_over" };
  if (clone.phase !== "player") return { state, events, error: "not_player_phase" };

  if (action.kind === "move") {
    const u = getUnit(clone, action.unitId);
    if (!u || !u.alive || u.side !== "player") return { state, events, error: "bad_unit" };
    const err = validatePath(clone, u, action.path);
    if (err) return { state, events, error: err };
    applyMove(clone, u, action.path, action.mode === "sprint", events);
    clone.revision++;
    postAction(clone);
    checkGameOver(clone);
    return { state: clone, events };
  }
  if (action.kind === "attack" || action.kind === "ability") {
    const u = getUnit(clone, action.unitId);
    if (!u || !u.alive || u.side !== "player") return { state, events, error: "bad_unit" };
    const err = applyAbility(clone, u, action.ability, action.targetUnitId, action.targetPos, events);
    if (err) return { state, events, error: err };
    clone.revision++;
    postAction(clone);
    checkGameOver(clone);
    return { state: clone, events };
  }
  return { state, events, error: "unhandled" };
}

export function isActionValid(state: GameState, action: PlayerAction): boolean {
  if (action.kind === "endTurn") return state.phase === "player" && !state.gameOver;
  return applyActionNoEnemy(state, action).error === undefined;
}

export function applyAction(state: GameState, action: PlayerAction): ApplyResult {
  if (action.kind === "endTurn") {
    const clone = cloneState(state);
    const events: GameEvents[] = [{ kind: "phase", data: { to: "enemy" } }];
    startEnemyPhase(clone);
    runEnemyPhase(clone, events);
    decayNoise(clone);
    if (!clone.gameOver) {
      clone.turn += 1;
      events.push({ kind: "phase", data: { to: "player" } });
      startPlayerPhase(clone);
    }
    clone.revision++;
    postAction(clone);
    checkGameOver(clone);
    return { state: clone, events };
  }
  return applyActionNoEnemy(state, action);
}

function turretFire(state: GameState, events: GameEvents[]): void {
  for (const t of state.devices) {
    if (t.kind !== "turret" || !t.powered || t.disabled || t.owner === "disabled") continue;
    if (t.owner === "security" && state.alert < 1) continue; // covert: sensors do not preempt
    const enemySide: "player" | "enemy" = t.owner === "security" ? "player" : "enemy";
    const targets = state.units.filter((u) => u.alive && u.side === enemySide);
    let best: UnitState | null = null;
    for (const cand of targets) {
      if (cheb({ x: t.x, y: t.y, h: 0 }, cand.pos) > (t.range ?? 5)) continue;
      if (!hasLineOfSight(state, { x: t.x, y: t.y, h: 0 }, cand.pos)) continue;
      best = cand;
      break;
    }
    if (!best) continue;
    const shooter: UnitState = {
      id: t.id,
      name: "turret",
      side: t.owner === "security" ? "enemy" : "player",
      archetype: "sentry",
      pos: { x: t.x, y: t.y, h: 0 },
      hp: 1,
      maxHp: 1,
      energy: 0,
      maxEnergy: 0,
      moveLeft: 0,
      maxMove: 0,
      alive: false,
      activated: true,
      abilities: [],
      statuses: [],
      atkRange: t.range ?? 4,
      atkDamage: 4,
      defaultAttack: "sentry_shot",
      facing: 0,
      stealth: 0,
      visionRange: 0,
      fovAngle: t.fov ?? 120,
      detMeter: 0,
      detState: "alerted",
      searchPos: null,
      searchTurns: 0,
    };
    shooter.facing = Math.round(Math.atan2(best.pos.y - t.y, best.pos.x - t.x) / (Math.PI / 4)) & 7;
    if (!inTurretCone(shooter, best)) continue;
    const pv = previewDamage(state, shooter, best, 3);
    if (!pv.valid) continue;
    applyDamage(state, best, pv.finalDamage, "turret", events);
    emitNoise(state, t.x, t.y, 7, "turret");
    events.push({ kind: "turret_fire", data: { deviceId: t.id, target: best.id } });
  }
}

function inTurretCone(shooter: UnitState, target: UnitState): boolean {
  const dx = target.pos.x - shooter.pos.x;
  const dy = target.pos.y - shooter.pos.y;
  if (dx === 0 && dy === 0) return true;
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
  const diff = Math.abs(((oct - shooter.facing + 8) % 8));
  return diff <= 2 || shooter.fovAngle >= 120;
}

function runEnemyPhase(state: GameState, events: GameEvents[]): void {
  turretFire(state, events);
  const enemies = state.units.filter((u) => u.side === "enemy" && u.alive).sort((a, b) => a.id.localeCompare(b.id));
  for (const enemy of enemies) {
    if (!enemy.alive || state.gameOver) continue;
    if (enemy.statuses.some((s) => s.kind === "stun")) continue;
    const reach = reachableCells(state, enemy);
    const actions = decideEnemyActions(state, enemy, reach);
    for (const a of actions) {
      const cur = getUnit(state, enemy.id);
      if (!cur || !cur.alive) break;
      if (a.move && a.move.length) applyMove(state, cur, a.move, false, events);
      const after = getUnit(state, enemy.id);
      if (!after || !after.alive) break;
      const err = applyAbility(state, after, a.ability, a.targetUnitId, a.targetPos, events);
      void err;
    }
  }
}

export { knownEnemies, knownThreatCells, pathThreat };