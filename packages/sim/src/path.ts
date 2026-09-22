import type { GameState, Position, UnitState } from "./types.ts";
import { SIZE, inBounds, isBlockingMove, tileAt } from "./map.ts";

export function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function unitAt(state: GameState, x: number, y: number): UnitState | undefined {
  return state.units.find((u) => u.alive && u.pos.x === x && u.pos.y === y);
}

export function posEqual(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y && a.h === b.h;
}

// Four-adjacent neighbours. Height changes up to +1/-1 allowed (ramp/stair semantics); a change
// of 2 is treated as a cliff. Movement cost includes a +1 surcharge for climbing.
export function neighbors(state: GameState, from: Position): { pos: Position; cost: number }[] {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const out: { pos: Position; cost: number }[] = [];
  const fromTile = tileAt(state, from.x, from.y);
  const fromH = fromTile ? fromTile.height : 0;
  for (const [dx, dy] of dirs) {
    const nx = from.x + dx;
    const ny = from.y + dy;
    if (!inBounds(nx, ny)) continue;
    if (isBlockingMove(state, nx, ny)) continue;
    const t = tileAt(state, nx, ny);
    if (!t) continue;
    const dh = t.height - fromH;
    if (Math.abs(dh) > 1) continue;
    let cost = t.moveCost;
    if (dh > 0) cost += 1;
    out.push({ pos: { x: nx, y: ny, h: t.height }, cost });
  }
  return out;
}

export interface ReachInfo {
  cost: number;
  prevKey: string | null;
  pos: Position;
}

// Dijkstra flood over movement cost, respecting occupancy (occupied cells are not reachable as
// destinations but block passage). Returns map keyed by "x,y".
export function reachableCells(state: GameState, unit: UnitState): Map<string, ReachInfo> {
  const start = { x: unit.pos.x, y: unit.pos.y, h: unit.pos.h };
  const startKey = posKey(start.x, start.y);
  const dist = new Map<string, number>();
  const info = new Map<string, ReachInfo>();
  dist.set(startKey, 0);
  info.set(startKey, { cost: 0, prevKey: null, pos: start });
  const frontier: { key: string; cost: number; pos: Position }[] = [{ key: startKey, cost: 0, pos: start }];
  const occupied = new Set<string>();
  for (const u of state.units) {
    if (u.alive && !(u.pos.x === unit.pos.x && u.pos.y === unit.pos.y)) {
      occupied.add(posKey(u.pos.x, u.pos.y));
    }
  }
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    if (cur.cost > (dist.get(cur.key) ?? Infinity)) continue;
    for (const n of neighbors(state, cur.pos)) {
      const nk = posKey(n.pos.x, n.pos.y);
      if (occupied.has(nk)) continue; // cannot pass or stop on occupied tiles
      const nc = cur.cost + n.cost;
      if (nc <= unit.moveLeft && nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        info.set(nk, { cost: nc, prevKey: cur.key, pos: n.pos });
        frontier.push({ key: nk, cost: nc, pos: n.pos });
      }
    }
  }
  return info;
}

// A* over the same movement graph, ignoring move budget (used by AI to plan long routes).
export function findPath(state: GameState, from: Position, to: Position, ignoreOccupancy = false): Position[] | null {
  const startKey = posKey(from.x, from.y);
  const goalKey = posKey(to.x, to.y);
  const occupied = new Set<string>();
  if (!ignoreOccupancy) {
    for (const u of state.units) if (u.alive && !(u.pos.x === from.x && u.pos.y === from.y)) occupied.add(posKey(u.pos.x, u.pos.y));
    // allow stopping on `to` even if occupied? callers decide; here block.
  }
  interface Node {
    key: string;
    pos: Position;
    g: number;
    f: number;
    prev: string | null;
  }
  const heuristic = (p: Position) => Math.abs(p.x - to.x) + Math.abs(p.y - to.y);
  const open: Node[] = [{ key: startKey, pos: from, g: 0, f: heuristic(from), prev: null }];
  const best = new Map<string, number>();
  best.set(startKey, 0);
  const came = new Map<string, string>();
  let guard = SIZE * SIZE * 6;
  while (open.length && guard-- > 0) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;
    if (cur.key === goalKey) {
      const rev: Position[] = [to];
      let curKey: string | null = goalKey;
      while (curKey && curKey !== startKey) {
        const pk = came.get(curKey);
        if (pk === undefined) return null;
        const [sx, sy] = pk.split(",").map(Number);
        const t = tileAt(state, sx, sy);
        rev.push({ x: sx, y: sy, h: t ? t.height : 0 });
        curKey = pk;
      }
      return rev.reverse();
    }
    for (const n of neighbors(state, cur.pos)) {
      const nk = posKey(n.pos.x, n.pos.y);
      if (!ignoreOccupancy && occupied.has(nk) && nk !== goalKey) continue;
      const g = cur.g + n.cost;
      if (g < (best.get(nk) ?? Infinity)) {
        best.set(nk, g);
        came.set(nk, cur.key);
        open.push({ key: nk, pos: n.pos, g, f: g + heuristic(n.pos), prev: cur.key });
      }
    }
  }
  return null;
}

export function reconstructPathFromReach(info: Map<string, ReachInfo>, destKey: string): Position[] {
  const out: Position[] = [];
  let k: string | null = destKey;
  while (k) {
    const i = info.get(k);
    if (!i) break;
    out.push(i.pos);
    k = i.prevKey;
  }
  const full = out.reverse();
  return full.length > 1 ? full.slice(1) : [];
}

export function pathCost(state: GameState, path: Position[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    const pt = tileAt(state, prev.x, prev.y);
    const ct = tileAt(state, cur.x, cur.y);
    if (!ct) continue;
    let c = ct.moveCost;
    if (pt && ct.height - pt.height > 0) c += 1;
    total += c;
  }
  return total;
}
