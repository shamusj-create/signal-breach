import type { GameState, UnitState } from "@sb/sim";
import { ABILITIES, cheb, hasLineOfSight } from "@sb/sim";

// Presentation-only legal-target derivation. This computes the set of tiles an ability can legally
// affect, derived from AUTHORITATIVE sim state + the ability definition (kind + range + LoS). It is a
// READ-ONLY derivation used for highlighting + arming; it never mutates state and is never a rule
// source. It mirrors the resolver's own legality: an attack is legal against an enemy unit within the
// shooter's authoritative range (atkRange) that has line-of-sight; support shields allies/self within
// its stated range; remote_hack/emp affect devices/doors within range.

export type TargetKind = "units" | "devices" | "none";

export interface LegalTargets {
  kind: TargetKind;
  keys: string[]; // "x,y" tile keys, deduped
  unitIds: string[]; // legal unit targets (attack / ally)
  deviceIds: string[]; // legal device targets (hack / emp)
}

function withinRange(from: { x: number; y: number }, to: { x: number; y: number }, range: number): boolean {
  return cheb({ x: from.x, y: from.y, h: 0 }, { x: to.x, y: to.y, h: 0 }) <= range;
}

// The authoritative "attack-like" abilities resolve against a target unit within the shooter's
// atkRange with line-of-sight (see state.resolveAttack / vision.previewDamage). Everything else keys
// off the ability's declared kind + range.
export function legalTargetsFor(state: GameState, unit: UnitState, ability: string): LegalTargets {
  const empty: LegalTargets = { kind: "none", keys: [], unitIds: [], deviceIds: [] };
  const def = ABILITIES[ability as keyof typeof ABILITIES];
  if (!def) return empty;

  const keys: string[] = [];
  const unitIds: string[] = [];
  const deviceIds: string[] = [];
  const add = (x: number, y: number) => {
    const k = `${x},${y}`;
    if (!keys.includes(k)) keys.push(k);
  };

  // Support / ally abilities shield allied units (and self) within the declared range.
  if (ability === "barrier" || ability === "warden_field") {
    for (const u of state.units) {
      if (!u.alive || u.side !== unit.side) continue;
      if (!withinRange(unit.pos, u.pos, def.range)) continue;
      add(u.pos.x, u.pos.y);
      unitIds.push(u.id);
    }
    return { kind: "units", keys, unitIds, deviceIds };
  }

  // Device / object abilities affect electronics within range (remote_hack also needs line-of-sight,
  // matching state.applyAbility; emp is an area disable with no LOS gate).
  if (ability === "remote_hack") {
    for (const d of state.devices) {
      if (!withinRange(unit.pos, { x: d.x, y: d.y }, def.range)) continue;
      if (!hasLineOfSight(state, unit.pos, { x: d.x, y: d.y, h: 0 })) continue;
      add(d.x, d.y);
      deviceIds.push(d.id);
    }
    for (const dr of state.doors) {
      if (!dr.secure || dr.open) continue;
      if (!withinRange(unit.pos, { x: dr.x, y: dr.y }, def.range)) continue;
      if (!hasLineOfSight(state, unit.pos, { x: dr.x, y: dr.y, h: 0 })) continue;
      add(dr.x, dr.y);
    }
    return { kind: "devices", keys, unitIds, deviceIds };
  }
  if (ability === "emp") {
    for (const d of state.devices) {
      if (!withinRange(unit.pos, { x: d.x, y: d.y }, def.range)) continue;
      add(d.x, d.y);
      deviceIds.push(d.id);
    }
    return { kind: "devices", keys, unitIds, deviceIds };
  }

  // Movement abilities (blink/dash) target empty ground tiles, not units/devices — no unit/device
  // highlight; the existing move-range affordance already covers those.
  if (def.kind === "movement") return empty;

  // Default: attack-like abilities target enemy UNITS within the shooter's authoritative range and
  // line-of-sight. Friendly units are never included.
  if (def.kind === "attack" || def.kind === "control") {
    const range = def.kind === "attack" ? unit.atkRange : def.range;
    for (const u of state.units) {
      if (!u.alive || u.side === unit.side) continue;
      if (!withinRange(unit.pos, u.pos, range)) continue;
      if (!hasLineOfSight(state, unit.pos, u.pos)) continue;
      add(u.pos.x, u.pos.y);
      unitIds.push(u.id);
    }
    return { kind: "units", keys, unitIds, deviceIds };
  }

  return empty;
}

// Whether a click on a given tile (with an optional unit there) should resolve the armed ability.
export function armedCanFire(armed: { ability: string; keys: string[] }, key: string): boolean {
  return armed.keys.includes(key);
}