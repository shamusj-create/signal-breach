import type { AbilityId, UnitArchetype, UnitState, Position } from "./types.ts";
import { facingBetween } from "./stealth.ts";

export interface UnitDef {
  archetype: UnitArchetype;
  label: string;
  role: string;
  hp: number;
  energy: number;
  move: number;
  atkRange: number;
  atkDamage: number;
  abilities: AbilityId[];
  defaultAttack: AbilityId;
  stealth: number;
  visionRange: number;
  fovAngle: number;
}

export const UNIT_DEFS: Record<UnitArchetype, UnitDef> = {
  vanguard: {
    archetype: "vanguard",
    label: "Vanguard",
    role: "Front-line assault",
    hp: 22,
    energy: 6,
    move: 5,
    atkRange: 5,
    atkDamage: 5,
    abilities: ["pulse_rifle", "dash", "overwatch", "concussion"],
    defaultAttack: "pulse_rifle",
    stealth: 0,
    visionRange: 6,
    fovAngle: 360,
  },
  ghost: {
    archetype: "ghost",
    label: "Ghost",
    role: "Mobility and stealth",
    hp: 15,
    energy: 6,
    move: 7,
    atkRange: 6,
    atkDamage: 5,
    abilities: ["silenced_shot", "cloak", "blink", "takedown"],
    defaultAttack: "silenced_shot",
    stealth: 45,
    visionRange: 8,
    fovAngle: 360,
  },
  cipher: {
    archetype: "cipher",
    label: "Cipher",
    role: "Control and hacking",
    hp: 14,
    energy: 7,
    move: 5,
    atkRange: 5,
    atkDamage: 4,
    abilities: ["arc_bolt", "remote_hack", "emp", "barrier"],
    defaultAttack: "arc_bolt",
    stealth: 20,
    visionRange: 7,
    fovAngle: 360,
  },
  sentry: {
    archetype: "sentry",
    label: "Sentry",
    role: "Ranged attacker",
    hp: 12,
    energy: 5,
    move: 4,
    atkRange: 5,
    atkDamage: 5,
    abilities: ["sentry_shot"],
    defaultAttack: "sentry_shot",
    stealth: 10,
    visionRange: 7,
    fovAngle: 100,
  },
  enforcer: {
    archetype: "enforcer",
    label: "Enforcer",
    role: "Armoured aggressor",
    hp: 22,
    energy: 5,
    move: 3,
    atkRange: 1,
    atkDamage: 8,
    abilities: ["enforcer_slam"],
    defaultAttack: "enforcer_slam",
    stealth: 0,
    visionRange: 4,
    fovAngle: 160,
  },
  hunter: {
    archetype: "hunter",
    label: "Hunter",
    role: "Fast flanker",
    hp: 11,
    energy: 5,
    move: 6,
    atkRange: 3,
    atkDamage: 4,
    abilities: ["hunter_rush"],
    defaultAttack: "hunter_rush",
    stealth: 15,
    visionRange: 8,
    fovAngle: 80,
  },
  warden: {
    archetype: "warden",
    label: "Warden",
    role: "Support / control",
    hp: 18,
    energy: 6,
    move: 4,
    atkRange: 4,
    atkDamage: 3,
    abilities: ["warden_field"],
    defaultAttack: "warden_field",
    stealth: 10,
    visionRange: 6,
    fovAngle: 120,
  },
};

let counter = 0;
export function makeUnit(archetype: UnitArchetype, side: "player" | "enemy", pos: Position, name?: string): UnitState {
  const def = UNIT_DEFS[archetype];
  return {
    id: `${side[0]}_${archetype}_${counter++}`,
    name: name ?? def.label,
    side,
    archetype,
    pos: { ...pos },
    hp: def.hp,
    maxHp: def.hp,
    energy: def.energy,
    maxEnergy: def.energy,
    moveLeft: def.move,
    maxMove: def.move,
    alive: true,
    activated: false,
    abilities: [...def.abilities],
    statuses: [],
    atkRange: def.atkRange,
    atkDamage: def.atkDamage,
    defaultAttack: def.defaultAttack,
    facing: 0,
    stealth: def.stealth,
    visionRange: def.visionRange,
    fovAngle: def.fovAngle,
    detMeter: 0,
    detState: "unaware",
    searchPos: null,
    searchTurns: 0,
  };
}

export function resetUnitCounters(): void {
  counter = 0;
}

export function faceEnemyTowards(unit: UnitState, target: Position): void {
  unit.facing = facingBetween(unit.pos, target);
}