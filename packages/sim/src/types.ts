// Core domain types for the deterministic tactical simulation.
// These types are shared by web (render/UI), server (validation) and tests.

export type Side = "player" | "enemy";

export interface Position {
  x: number;
  y: number;
  h: number; // elevation layer 0..2
}

export type TerrainType =
  | "floor"
  | "conceal" // stealth floor (vents/shadow): reduces detection
  | "wall"
  | "crate" // half cover, blocks movement
  | "pillar" // full cover, blocks movement
  | "panel" // destructible sight blocker
  | "machine" // destructible mover blocker
  | "ramp" // traversal between elevations
  | "hazard"; // electrical hazard (damage on end-of-move)

export interface TileDef {
  x: number;
  y: number;
  h: number;
  terrain: TerrainType;
  blocksSight: boolean;
  blocksMove: boolean;
  moveCost: number;
  cover: CoverLevel; // cover granted to a unit standing on it
  height: number; // elevation of the surface (== h)
}

export type CoverLevel = "none" | "half" | "full";

export interface DoorState {
  id: string;
  x: number;
  y: number;
  h: number;
  open: boolean;
  secure: boolean; // security door: hackable; lockdown re-locks unhacked doors
  hacked: boolean;
  // doors block sight & movement when closed
}

export type DestructibleKind = "cell" | "barrier" | "panel" | "machine";

export type DeviceKind = "terminal" | "turret" | "core" | "camera" | "node";

export type DeviceOwner = "security" | "hijacked" | "disabled";

export interface DeviceState {
  id: string;
  kind: DeviceKind;
  x: number;
  y: number;
  h: number;
  hacked: boolean;
  disabled: boolean; // via EMP
  label: string;
  objectiveId?: ObjectiveId;
  netId: string; // connected security network cluster
  powered: boolean;
  owner: DeviceOwner;
  fov?: number;
  range?: number;
}

export interface DestructibleState {
  id: string;
  x: number;
  y: number;
  h: number;
  kind: DestructibleKind;
  destroyed: boolean;
  hp: number;
  label: string;
  blocksSight: boolean;
  blocksMove: boolean;
}

export type UnitArchetype =
  // players
  | "vanguard"
  | "ghost"
  | "cipher"
  // enemies
  | "sentry"
  | "enforcer"
  | "hunter"
  | "warden";

export type AbilityId =
  | "pulse_rifle"
  | "dash"
  | "overwatch"
  | "concussion"
  | "silenced_shot"
  | "cloak"
  | "blink"
  | "backstab"
  | "takedown"
  | "arc_bolt"
  | "remote_hack"
  | "emp"
  | "barrier"
  // enemy abilities
  | "sentry_shot"
  | "enforcer_slam"
  | "hunter_rush"
  | "warden_field";

export type DetectionState = "unaware" | "suspicious" | "alerted" | "searching";

export type StatusKind = "cloak" | "barrier" | "stun" | "disabled" | "overwatch";

export interface Status {
  kind: StatusKind;
  turns: number;
  power?: number;
}

export interface UnitState {
  id: string;
  name: string;
  side: Side;
  archetype: UnitArchetype;
  pos: Position;
  hp: number;
  maxHp: number;
  energy: number; // skill points this activation
  maxEnergy: number;
  moveLeft: number; // movement points this activation
  maxMove: number;
  alive: boolean;
  activated: boolean; // has been activated this turn (refilled)
  abilities: AbilityId[];
  statuses: Status[];
  // range of default attack, used by AI + previews
  atkRange: number;
  atkDamage: number;
  defaultAttack: AbilityId;
  facing: number; // 0..7 octant, tactical: enemy vision cone + backstab
  // stealth layer
  stealth: number; // 0..100, higher = harder to detect
  visionRange: number; // enemy perception range (players: player fog vision range)
  fovAngle: number; // enemy perception cone angle in degrees
  detMeter: number; // 0..100 accumulated detection for enemies
  detState: DetectionState;
  searchPos: Position | null;
  searchTurns: number;
}

export type ObjectiveStatus = "locked" | "available" | "done";

export type ObjectiveId = "relay_a" | "relay_b" | "core" | "extraction";

export interface ObjectiveState {
  id: ObjectiveId;
  status: ObjectiveStatus;
  label: string;
}

export type Phase = "player" | "enemy";

export interface GameEvents {
  // emitted by the reducer for the renderer; NEVER feeds back into rules
  kind: string;
  data: Record<string, unknown>;
}

export type PlayerAction =
  | { kind: "activate"; unitId: string }
  | { kind: "move"; unitId: string; path: Position[]; mode?: "walk" | "sprint" }
  | { kind: "attack"; unitId: string; ability: AbilityId; targetUnitId?: string; targetPos?: Position }
  | { kind: "ability"; unitId: string; ability: AbilityId; targetUnitId?: string; targetPos?: Position }
  | { kind: "endTurn" };

export interface NoiseState {
  id: string;
  x: number;
  y: number;
  power: number;
  ttl: number;
  src: string;
}

export interface GameState {
  version: number;
  revision: number; // bumped on every applied action
  seed: number;
  mission: number;
  phase: Phase;
  turn: number;
  activeUnitId: string | null;
  units: UnitState[];
  tiles: TileDef[];
  width: number;
  height: number;
  doors: DoorState[];
  devices: DeviceState[];
  destructibles: DestructibleState[];
  extraction: Position;
  objectives: ObjectiveState[];
  gameOver: boolean;
  victory: boolean;
  rngState: number;
  log: string[];
  // stealth/security layer (v3)
  vis: number[]; // 0 unexplored, 1 remembered, 2 currently visible
  noises: NoiseState[];
  alert: number; // 0 covert, 1 suspicious, 2 alert, 3 lockdown
  alertCool: number;
  alertFocus: Position | null;
}
