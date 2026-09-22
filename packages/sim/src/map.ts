import type {
  TileDef,
  CoverLevel,
  Position,
  GameState,
  DoorState,
  DeviceState,
  DestructibleState,
  TerrainType,
} from "./types.ts";

export const SIZE = 14;
export const MAX_H = 2;

export function key(x: number, y: number): number {
  return y * SIZE + x;
}
export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE;
}

// Legend:
//  . floor   # wall(block)  c crate(half cover,block)  O pillar(full cover,block)
//  r ramp    ^ hazard       v vent/conceal floor        D secure door(closed)
//  T relay terminal         K core                       X extraction
//  A camera (security)      R turret (security)          N security node
//  P security panel (destructible, blocks sight)         M machinery (destructible, blocks move)
//  1 elevated floor(h1)     2 elevated floor(h2)
export interface MissionMapDef {
  layout: string[];
}

export interface BuiltMap {
  tiles: TileDef[];
  doors: DoorState[];
  devices: DeviceState[];
  destructibles: DestructibleState[];
  extraction: Position;
}

function terrainOf(ch: string): { terrain: TerrainType; blocksSight: boolean; blocksMove: boolean; moveCost: number; cover: CoverLevel; height: number } {
  switch (ch) {
    case "#":
      return { terrain: "wall", blocksSight: true, blocksMove: true, moveCost: Infinity, cover: "full", height: 1 };
    case "c":
      return { terrain: "crate", blocksSight: false, blocksMove: true, moveCost: Infinity, cover: "half", height: 0 };
    case "O":
      return { terrain: "pillar", blocksSight: true, blocksMove: true, moveCost: Infinity, cover: "full", height: 1 };
    case "r":
      return { terrain: "ramp", blocksSight: false, blocksMove: false, moveCost: 2, cover: "none", height: 0 };
    case "^":
      return { terrain: "hazard", blocksSight: false, blocksMove: false, moveCost: 1, cover: "none", height: 0 };
    case "v":
      return { terrain: "conceal", blocksSight: false, blocksMove: false, moveCost: 1, cover: "none", height: 0 };
    case "P":
      return { terrain: "panel", blocksSight: false, blocksMove: false, moveCost: 1, cover: "half", height: 0 };
    case "M":
      return { terrain: "machine", blocksSight: false, blocksMove: false, moveCost: 1, cover: "half", height: 0 };
    case "1":
      return { terrain: "floor", blocksSight: false, blocksMove: false, moveCost: 1, cover: "none", height: 1 };
    case "2":
      return { terrain: "floor", blocksSight: false, blocksMove: false, moveCost: 1, cover: "none", height: 2 };
    default:
      return { terrain: "floor", blocksSight: false, blocksMove: false, moveCost: 1, cover: "none", height: 0 };
  }
}

function netOf(x: number, y: number): string {
  return `net_${Math.floor(x / 5)}_${Math.floor(y / 5)}`;
}

export function buildMap(def: MissionMapDef): BuiltMap {
  const tiles: TileDef[] = [];
  const doors: DoorState[] = [];
  const devices: DeviceState[] = [];
  const destructibles: DestructibleState[] = [];
  let extraction: Position = { x: 0, y: 0, h: 0 };
  for (let y = 0; y < SIZE; y++) {
    const row = def.layout[y] ?? ".".repeat(SIZE);
    for (let x = 0; x < SIZE; x++) {
      const ch = row[x] ?? ".";
      const t = terrainOf(ch);
      tiles.push({ x, y, h: 0, terrain: t.terrain, blocksSight: t.blocksSight, blocksMove: t.blocksMove, moveCost: t.moveCost, cover: t.cover, height: t.height });
      if (ch === "D") doors.push({ id: `door_${x}_${y}`, x, y, h: 0, open: false, secure: true, hacked: false });
      if (ch === "T") devices.push({ id: `terminal_${x}_${y}`, kind: "terminal", x, y, h: 0, hacked: false, disabled: false, label: `Relay ${x},${y}`, netId: netOf(x, y), powered: true, owner: "security" });
      if (ch === "K") devices.push({ id: `core_${x}_${y}`, kind: "core", x, y, h: 0, hacked: false, disabled: false, label: `Core ${x},${y}`, netId: netOf(x, y), powered: true, owner: "security" });
      if (ch === "A") devices.push({ id: `cam_${x}_${y}`, kind: "camera", x, y, h: 0, hacked: false, disabled: false, label: `Camera ${x},${y}`, netId: netOf(x, y), powered: true, owner: "security", fov: 80, range: 6 });
      if (ch === "R") devices.push({ id: `turret_${x}_${y}`, kind: "turret", x, y, h: 0, hacked: false, disabled: false, label: `Turret ${x},${y}`, netId: netOf(x, y), powered: true, owner: "security", fov: 120, range: 5 });
      if (ch === "N") devices.push({ id: `node_${x}_${y}`, kind: "node", x, y, h: 0, hacked: false, disabled: false, label: `SecNode ${x},${y}`, netId: netOf(x, y), powered: true, owner: "security" });
      if (ch === "C") destructibles.push({ id: `cell_${x}_${y}`, kind: "cell", x, y, h: 0, destroyed: false, hp: 3, label: "Energy Cell", blocksSight: false, blocksMove: true });
      if (ch === "P") destructibles.push({ id: `panel_${x}_${y}`, kind: "panel", x, y, h: 0, destroyed: false, hp: 2, label: "Security Panel", blocksSight: true, blocksMove: false });
      if (ch === "M") destructibles.push({ id: `machine_${x}_${y}`, kind: "machine", x, y, h: 0, destroyed: false, hp: 5, label: "Machinery", blocksSight: false, blocksMove: true });
      if (ch === "X") extraction = { x, y, h: 0 };
    }
  }
  return { tiles, doors, devices, destructibles, extraction };
}

export function tileAt(state: GameState, x: number, y: number): TileDef | undefined {
  if (!inBounds(x, y)) return undefined;
  return state.tiles[key(x, y)];
}

export function destructibleAt(state: GameState, x: number, y: number): DestructibleState | undefined {
  return state.destructibles.find((d) => d.x === x && d.y === y && !d.destroyed);
}

export function doorAt(state: GameState, x: number, y: number): DoorState | undefined {
  return state.doors.find((d) => d.x === x && d.y === y);
}

export function isBlockingMove(state: GameState, x: number, y: number): boolean {
  const t = tileAt(state, x, y);
  if (!t) return true;
  if (t.blocksMove) return true;
  const dest = destructibleAt(state, x, y);
  if (dest && dest.blocksMove) return true;
  const door = doorAt(state, x, y);
  if (door && !door.open) return true;
  return false;
}

export function isBlockingSight(state: GameState, x: number, y: number): boolean {
  const t = tileAt(state, x, y);
  if (!t) return true;
  if (t.blocksSight) return true;
  const door = doorAt(state, x, y);
  if (door && !door.open) return true;
  const dest = destructibleAt(state, x, y);
  if (dest && dest.blocksSight) return true;
  return false;
}
