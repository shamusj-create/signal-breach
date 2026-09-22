import type { CoverLevel, GameState, Position, UnitState } from "./types.ts";
import { isBlockingSight, tileAt } from "./map.ts";
import { unitAt } from "./path.ts";

// Integer grid LOS using a supercover line between tile centres. A shot is blocked if any
// INTERVENING tile blocks sight. Source/target tiles themselves are ignored.
export function lineCells(from: Position, to: Position): Position[] {
  const cells: Position[] = [];
  let x0 = from.x;
  let y0 = from.y;
  const x1 = to.x;
  const y1 = to.y;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let guard = (dx + dy + 2) * 4;
  let lastKey = "";
  while (guard-- > 0) {
    const e2 = 2 * err;
    cells.push({ x: x0, y: y0, h: 0 });
    if (x0 === x1 && y0 === y1) break;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
    const k = `${x0},${y0}`;
    if (k === lastKey) continue;
    lastKey = k;
  }
  return cells;
}

export function hasLineOfSight(state: GameState, from: Position, to: Position): boolean {
  const cells = lineCells(from, to);
  // drop endpoints
  const inner = cells.slice(1, cells.length - 1);
  for (const c of inner) {
    if (isBlockingSight(state, c.x, c.y)) return false;
  }
  // Elevation: a big height jump blocks (e.g. shooting over a cliff is fine, into a pit blocked)
  const fromT = tileAt(state, from.x, from.y);
  const toT = tileAt(state, to.x, to.y);
  if (fromT && toT && Math.abs(fromT.height - toT.height) > 1) return false;
  return true;
}

// Determine cover protecting `to` against fire from `from`. Inspects intervening cover tiles
// near the target: the nearest cover source gives the protection level.
export function computeCover(state: GameState, from: Position, to: Position): CoverLevel {
  const cells = lineCells(from, to);
  const inner = cells.slice(1, cells.length - 1);
  let cover: CoverLevel = "none";
  // walk from target outward to attacker; the first cover tile encountered dominates
  for (let i = inner.length - 1; i >= 0; i--) {
    const c = inner[i];
    const t = tileAt(state, c.x, c.y);
    if (!t) continue;
    if (t.terrain === "wall" || t.terrain === "pillar") return "full";
    if (t.terrain === "crate" || t.terrain === "hazard") return "half";
  }
  return cover;
}

export const COVER_MULT: Record<CoverLevel, number> = {
  none: 1.0,
  half: 0.6,
  full: 0.3,
};

export interface DamagePreview {
  valid: boolean;
  reason?: string;
  baseDamage: number;
  cover: CoverLevel;
  coverMult: number;
  finalDamage: number;
  shielded: number; // how much a barrier will absorb
  lethal: boolean;
}

// Pure: used BOTH for preview and for authoritative resolution, guaranteeing they agree.
export function previewDamage(
  state: GameState,
  attacker: UnitState,
  target: UnitState,
  baseDamage: number,
  opts: { ignoreCover?: boolean; ignoreLoS?: boolean } = {},
): DamagePreview {
  const dist = Math.max(Math.abs(attacker.pos.x - target.pos.x), Math.abs(attacker.pos.y - target.pos.y));
  if (dist > (opts.ignoreLoS ? 99 : attacker.atkRange)) {
    return { valid: false, reason: "out_of_range", baseDamage, cover: "none", coverMult: 1, finalDamage: 0, shielded: 0, lethal: false };
  }
  if (!opts.ignoreLoS && !hasLineOfSight(state, attacker.pos, target.pos)) {
    return { valid: false, reason: "no_los", baseDamage, cover: "none", coverMult: 1, finalDamage: 0, shielded: 0, lethal: false };
  }
  const cover = opts.ignoreCover ? "none" : computeCover(state, attacker.pos, target.pos);
  const coverMult = COVER_MULT[cover];
  let dmg = Math.round(baseDamage * coverMult);
  const barrier = target.statuses.find((s) => s.kind === "barrier");
  let shielded = 0;
  if (barrier && barrier.power) {
    shielded = Math.min(barrier.power, dmg);
    dmg -= shielded;
  }
  const lethal = dmg >= target.hp;
  return { valid: true, baseDamage, cover, coverMult, finalDamage: dmg, shielded, lethal };
}

export function unitDist(a: UnitState, b: UnitState): number {
  return Math.max(Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y));
}

export { unitAt };