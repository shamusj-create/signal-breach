import type { GameState, UnitState } from "./types.ts";

// Upgrades must change gameplay numbers, not just text.
export type UpgradeId = "fortify" | "powerCell" | "longRange" | "quickFeet" | "capacitor" | "sharpshooter";

export interface UpgradeDef {
  id: UpgradeId;
  label: string;
  desc: string;
}

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  fortify: { id: "fortify", label: "Reinforced Frame", desc: "+6 max health." },
  powerCell: { id: "powerCell", label: "Power Cell", desc: "+2 energy per turn." },
  longRange: { id: "longRange", label: "Targeting Optics", desc: "+1 weapon range." },
  quickFeet: { id: "quickFeet", label: "Servo Boost", desc: "+2 movement." },
  capacitor: { id: "capacitor", label: "Capacitor", desc: "+3 attack damage." },
  sharpshooter: { id: "sharpshooter", label: "Precision Core", desc: "+2 damage, +1 range." },
};

// Returns the list of upgrade choices offered for a unit archetype (>=2 meaningful choices).
export function choicesFor(archetype: string, already: UpgradeId[]): UpgradeId[] {
  const all: UpgradeId[] = ["fortify", "powerCell", "longRange", "quickFeet", "capacitor", "sharpshooter"];
  const pool = all.filter((u) => !already.includes(u));
  if (archetype === "cipher") return (["capacitor", "powerCell", "fortify", "longRange"] as UpgradeId[]).filter((u) => !already.includes(u));
  if (archetype === "ghost") return (["quickFeet", "longRange", "fortify", "powerCell"] as UpgradeId[]).filter((u) => !already.includes(u));
  if (archetype === "vanguard") return (["fortify", "capacitor", "quickFeet", "powerCell"] as UpgradeId[]).filter((u) => !already.includes(u));
  return pool;
}

export function applyUpgrade(unit: UnitState, id: UpgradeId): UnitState {
  const u = { ...unit, statuses: [...unit.statuses] };
  switch (id) {
    case "fortify":
      u.maxHp += 6;
      u.hp += 6;
      break;
    case "powerCell":
      u.maxEnergy += 2;
      u.energy += 2;
      break;
    case "longRange":
      u.atkRange += 1;
      break;
    case "quickFeet":
      u.maxMove += 2;
      u.moveLeft += 2;
      break;
    case "capacitor":
      u.atkDamage += 3;
      break;
    case "sharpshooter":
      u.atkDamage += 2;
      u.atkRange += 1;
      break;
  }
  return u;
}

export function applyUpgrades(state: GameState, picks: Record<string, UpgradeId>): GameState {
  const s = JSON.parse(JSON.stringify(state)) as GameState;
  for (const [unitId, up] of Object.entries(picks)) {
    const u = s.units.find((x) => x.id === unitId);
    if (u && u.alive) {
      const applied = applyUpgrade(u, up);
      s.units[s.units.indexOf(u)] = applied;
    }
  }
  return s;
}
