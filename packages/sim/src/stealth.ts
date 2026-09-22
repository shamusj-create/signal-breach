// Authoritative stealth layer: fog of war, enemy vision cones, detection states, noise.
// Pure + deterministic: no RNG, fixed iteration order. Rendering/HUD may only READ this.
import type { GameState, UnitState, Position, DetectionState } from "./types.ts";
import { tileAt, SIZE } from "./map.ts";
import { hasLineOfSight } from "./vision.ts";
import { cheb } from "./queries.ts";

export const VIS_UNEXPLORED = 0;
export const VIS_MEMORY = 1;
export const VIS_VISIBLE = 2;

export const DET_ALERT = 60;
export const DET_SUSPICION = 25;

const OCT_DIRS: [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export function octantToward(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const a = Math.atan2(dy, dx);
  return Math.round(a / (Math.PI / 4)) & 7;
}

export function octantVector(o: number): [number, number] {
  return OCT_DIRS[((o % 8) + 8) % 8];
}

export function facingBetween(from: Position, to: Position): number {
  return octantToward(to.x - from.x, to.y - from.y);
}

export function inCone(e: { facing: number; fovAngle: number; pos: Position }, target: Position): boolean {
  const dx = target.x - e.pos.x;
  const dy = target.y - e.pos.y;
  if (dx === 0 && dy === 0) return true;
  const [fx, fy] = octantVector(e.facing);
  const flen = Math.hypot(fx, fy);
  const len = Math.hypot(dx, dy);
  const dot = (dx * fx + dy * fy) / (len * flen);
  const half = ((e.fovAngle * Math.PI) / 180) / 2;
  return dot >= Math.cos(half);
}

export function visionRangeOf(state: GameState, u: UnitState): number {
  return u.visionRange + (state.alert >= 2 ? 1 : 0);
}

export function isConcealedTile(state: GameState, x: number, y: number): boolean {
  const t = tileAt(state, x, y);
  return !!t && t.terrain === "conceal";
}

export function unitHidden(_state: GameState, u: UnitState): boolean {
  return u.alive && u.statuses.some((s) => s.kind === "cloak");
}

export function playerHiddenFrom(state: GameState, enemy: UnitState, player: UnitState): boolean {
  if (unitHidden(state, player)) return cheb(enemy.pos, player.pos) > 1;
  return false;
}

export function enemyObserves(state: GameState, enemy: UnitState, player: UnitState): boolean {
  if (playerHiddenFrom(state, enemy, player)) return false;
  const d = cheb(enemy.pos, player.pos);
  if (d === 0) return true;
  if (!inCone(enemy, player.pos)) return false;
  if (d > visionRangeOf(state, enemy)) return false;
  if (!hasLineOfSight(state, enemy.pos, player.pos)) return false;
  return true;
}

function detectionRate(state: GameState, enemy: UnitState, player: UnitState): number {
  const d = cheb(enemy.pos, player.pos);
  let rate = 40;
  if (d <= 2) rate = 55;
  else if (d >= 5) rate = 22;
  rate -= Math.round(player.stealth / 8);
  if (isConcealedTile(state, player.pos.x, player.pos.y)) rate -= 14;
  if (state.alert >= 2) rate += 15;
  if (enemy.detState === "alerted") rate += 10;
  if (enemy.detState === "searching") rate += 8;
  return Math.max(6, rate);
}

export function detectionStateOf(meter: number, searching: boolean): DetectionState {
  if (searching) return "searching";
  if (meter >= DET_ALERT) return "alerted";
  if (meter >= DET_SUSPICION) return "suspicious";
  return "unaware";
}

export function escalate(state: GameState, level: number, focus?: Position): void {
  if (level > state.alert) {
    state.alert = level;
    state.alertCool = 0;
    if (focus) state.alertFocus = { x: focus.x, y: focus.y, h: focus.h };
  }
}

function applyAlertDecay(state: GameState): void {
  if (state.units.some((u) => u.alive && u.side === "enemy" && u.detState === "alerted")) {
    state.alertCool = 0;
    return;
  }
  state.alertCool += 1;
  if (state.alertCool >= 3 && state.alert > 0) {
    state.alert -= 1;
    state.alertCool = 0;
    if (state.alert === 0) state.alertFocus = null;
  }
}

// One deterministic perception pass over enemy units + cameras. Called after every applied
// action and after the enemy phase, so detection preview always equals authoritative result.
export function perceptionPass(state: GameState): void {
  const players = state.units.filter((u) => u.alive && u.side === "player").sort((a, b) => a.id.localeCompare(b.id));
  const enemies = state.units.filter((u) => u.alive && u.side === "enemy").sort((a, b) => a.id.localeCompare(b.id));
  let anyAlerted = false;
  for (const e of enemies) {
    let best: UnitState | null = null;
    let bestRate = 0;
    for (const p of players) {
      if (!enemyObserves(state, e, p)) continue;
      const r = detectionRate(state, e, p);
      if (!best || r > bestRate || (r === bestRate && p.id < best.id)) {
        best = p;
        bestRate = r;
      }
    }
    if (best) {
      e.detMeter = Math.min(100, e.detMeter + bestRate);
      e.searchPos = { x: best.pos.x, y: best.pos.y, h: best.pos.h };
      e.searchTurns = 2;
    } else {
      e.detMeter = Math.max(0, e.detMeter - 30);
      if (e.searchTurns > 0) e.searchTurns -= 1;
      else if (e.detState === "searching") e.searchPos = null;
    }
    const searching = !best && e.searchTurns > 0 && (e.detState === "searching" || e.detState === "alerted");
    e.detState = detectionStateOf(e.detMeter, searching);
    if (e.detState === "alerted") anyAlerted = true;
  }
  for (const dev of state.devices) {
    if (dev.kind !== "camera" || !dev.powered || dev.owner !== "security") continue;
    const cam = {
      pos: { x: dev.x, y: dev.y, h: 0 },
      facing: state.alertFocus ? facingBetween({ x: dev.x, y: dev.y, h: 0 }, state.alertFocus) : 0,
      fovAngle: dev.fov ?? 70,
    };
    for (const p of players) {
      if (unitHidden(state, p)) continue;
      if (cheb(cam.pos, p.pos) > (dev.range ?? 6)) continue;
      if (!inCone(cam, p.pos)) continue;
      if (!hasLineOfSight(state, cam.pos, p.pos)) continue;
      escalate(state, 1, { x: p.pos.x, y: p.pos.y, h: p.pos.h });
      for (const e of enemies) {
        if (cheb(e.pos, p.pos) <= 6 && e.detState !== "alerted") {
          e.detMeter = Math.max(e.detMeter, DET_SUSPICION + 10);
          e.searchPos = { x: p.pos.x, y: p.pos.y, h: p.pos.h };
          e.searchTurns = 2;
          e.detState = detectionStateOf(e.detMeter, false);
        }
      }
    }
  }
  if (anyAlerted) escalate(state, 2);
  applyAlertDecay(state);
}

// ---- fog of war ----

export function computeVisibleCells(state: GameState): Set<string> {
  const vis = new Set<string>();
  const players = state.units.filter((u) => u.alive && u.side === "player");
  for (const p of players) {
    vis.add(`${p.pos.x},${p.pos.y}`);
    const r = p.visionRange;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (vis.has(`${x},${y}`)) continue;
        const t = tileAt(state, x, y);
        if (!t) continue;
        const dx = Math.abs(x - p.pos.x);
        const dy = Math.abs(y - p.pos.y);
        if (dx > r || dy > r) continue;
        if (Math.hypot(dx, dy) > r + 0.75) continue;
        if (Math.abs(t.height - p.pos.h) > 1) continue;
        if (hasLineOfSight(state, p.pos, { x, y, h: t.height })) vis.add(`${x},${y}`);
      }
    }
  }
  return vis;
}

export function updateVisibility(state: GameState): void {
  const vis = computeVisibleCells(state);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (vis.has(`${x},${y}`)) state.vis[i] = VIS_VISIBLE;
      else if (state.vis[i] === VIS_VISIBLE) state.vis[i] = VIS_MEMORY;
    }
  }
}

export function isPositionVisible(state: GameState, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
  return state.vis[y * SIZE + x] === VIS_VISIBLE;
}

export function knownEnemies(state: GameState): UnitState[] {
  return state.units.filter((u) => u.alive && u.side === "enemy" && isPositionVisible(state, u.pos.x, u.pos.y));
}

export function isUnitVisible(state: GameState, u: UnitState): boolean {
  if (u.side === "player") return true;
  return isPositionVisible(state, u.pos.x, u.pos.y);
}

export function knownThreatCells(state: GameState): { unitId: string; cells: string[] }[] {
  const out: { unitId: string; cells: string[] }[] = [];
  for (const e of knownEnemies(state)) {
    const cells: string[] = [];
    const r = visionRangeOf(state, e);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (Math.abs(x - e.pos.x) > r || Math.abs(y - e.pos.y) > r) continue;
        if (Math.hypot(x - e.pos.x, y - e.pos.y) > r + 0.5) continue;
        if (!inCone(e, { x, y, h: 0 })) continue;
        if (!hasLineOfSight(state, e.pos, { x, y, h: tileAt(state, x, y)?.height ?? 0 })) continue;
        cells.push(`${x},${y}`);
      }
    }
    if (cells.length > 0) out.push({ unitId: e.id, cells });
  }
  for (const dev of state.devices) {
    if (dev.kind !== "camera" || !dev.powered || dev.owner !== "security") continue;
    if (!isPositionVisible(state, dev.x, dev.y)) continue;
    const cam = {
      pos: { x: dev.x, y: dev.y, h: 0 },
      facing: state.alertFocus ? facingBetween({ x: dev.x, y: dev.y, h: 0 }, state.alertFocus) : 0,
      fovAngle: dev.fov ?? 70,
    };
    const cells: string[] = [];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (Math.hypot(x - dev.x, y - dev.y) > (dev.range ?? 6) + 0.5) continue;
        if (!inCone(cam, { x, y, h: 0 })) continue;
        if (!hasLineOfSight(state, cam.pos, { x, y, h: tileAt(state, x, y)?.height ?? 0 })) continue;
        cells.push(`${x},${y}`);
      }
    }
    if (cells.length > 0) out.push({ unitId: dev.id, cells });
  }
  return out;
}

export function pathThreat(state: GameState, path: Position[]): string[] {
  const zones = knownThreatCells(state);
  const near = knownEnemies(state).map((e) => `${e.pos.x},${e.pos.y}`);
  const hit = new Set<string>();
  for (const p of path) {
    const k = `${p.x},${p.y}`;
    for (const z of zones) if (z.cells.includes(k)) hit.add(k);
    for (const nk of near) {
      const [nx, ny] = nk.split(",").map(Number);
      if (Math.max(Math.abs(p.x - nx), Math.abs(p.y - ny)) <= 2) hit.add(k);
    }
  }
  return [...hit];
}

// ---- noise ----

let noiseSeq = 0;
export function resetNoiseSeq(): void {
  noiseSeq = 0;
}

export function emitNoise(state: GameState, x: number, y: number, power: number, src: string): void {
  state.noises.push({ id: `n${noiseSeq++}`, x, y, power, ttl: 2, src });
  if (state.noises.length > 24) state.noises.shift();
}

export function decayNoise(state: GameState): void {
  for (const n of state.noises) n.ttl -= 1;
  state.noises = state.noises.filter((n) => n.ttl > 0);
}

export function noiseAtPoint(state: GameState, from: Position): number {
  let best = 0;
  for (const n of state.noises) {
    let s = n.power - cheb(from, { x: n.x, y: n.y, h: 0 });
    if (s <= 0) continue;
    if (!hasLineOfSight(state, from, { x: n.x, y: n.y, h: 0 })) s -= 3;
    if (s > best) best = s;
  }
  return best;
}

export function noiseInvestigate(state: GameState, e: UnitState): Position | null {
  let best: { x: number; y: number; id: string } | null = null;
  let bestScore = 0;
  for (const n of state.noises) {
    let s = n.power - cheb(e.pos, { x: n.x, y: n.y, h: 0 });
    if (s <= 0) continue;
    if (!hasLineOfSight(state, e.pos, { x: n.x, y: n.y, h: 0 })) s -= 3;
    if (s > bestScore || (s === bestScore && best !== null && n.id < best.id)) {
      best = { x: n.x, y: n.y, id: n.id };
      bestScore = s;
    }
  }
  if (best && bestScore >= 3 && e.detState === "unaware") return { x: best.x, y: best.y, h: 0 };
  if (best && bestScore >= 1 && e.detState === "suspicious") return { x: best.x, y: best.y, h: 0 };
  return null;
}
