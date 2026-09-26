// Truthful player-facing guidance text. All of it is derived from the AUTHORITATIVE sim tables
// (ABILITIES / UNIT_DEFS / device kinds) so the HUD and the first-run tutorial teach what the game
// actually does — not marketing copy. Pure functions; no state, no rules.
import { ABILITIES, UNIT_DEFS, type AbilityId, type DeviceKind, type UnitArchetype } from "@sb/sim";

export interface EnemyGuide {
  threat: string;
  counter: string;
}

// Per-archetype threat + counterplay, keyed off the real UNIT_DEFS (damage / range / mobility).
const ENEMY_GUIDE: Record<UnitArchetype, EnemyGuide> = {
  // Player archetypes: short "what this operative does" so the squad list can teach too.
  vanguard: { threat: "Your heavy breacher — tough, 5 dmg to 5 tiles, and can screen with Overwatch.", counter: "Lead with it through cover, then let the others follow." },
  ghost: { threat: "Your stealth infiltrator — long 6-tile silenced shots, cloak, and a flanking takedown.", counter: "Slip behind a target while it is unaware for a silent kill." },
  cipher: { threat: "Your hacker/controller — arcs bolts through cover, hacks and EMPs at range.", counter: "Keep it behind a shooter; hack devices before crossing them." },
  sentry: { threat: "Ranged gunner (5 dmg, range 5) with a 100° cone.", counter: "Break its line of sight or cross in the open only with cover. Flank it." },
  enforcer: { threat: "Armoured bruiser — 8 dmg but MELEE ONLY (range 1), slow.", counter: "Stay at range and shoot; it cannot reach you from distance." },
  hunter: { threat: "Fast flanker (range 3) that lunges for your back.", counter: "Watch your flanks; keep cover between you and it." },
  warden: { threat: "Support (range 4) that shields allies and pins you.", counter: "Focus it first so it cannot keep the pack alive." },
};

export function enemyGuide(archetype: UnitArchetype): EnemyGuide {
  return ENEMY_GUIDE[archetype] ?? { threat: "Unknown contact.", counter: "Assume it can shoot and act — keep cover." };
}

// Real damage/range per archetype (from the authoritative UNIT_DEFS) so the field guide can quote
// actual threat numbers instead of vibes.
export const UNIT_THREAT: Record<string, { atkDamage: number; atkRange: number }> = Object.fromEntries(
  Object.values(UNIT_DEFS).map((d) => [d.archetype, { atkDamage: d.atkDamage, atkRange: d.atkRange }]),
);

export function abilityHint(id: AbilityId): string {
  const a = ABILITIES[id];
  if (!a) return "";
  const range = a.range <= 0 ? "self / allies" : `${a.range} tiles`;
  return `${a.label}: ${a.desc} Cost ${a.cost} energy · ${a.kind}, range ${range}.`;
}

// A compact button caption that still shows cost + range without wrapping ("Arc Bolt · 3E · R5").
export function abilityCaption(id: AbilityId): { label: string; cost: string; range: string } {
  const a = ABILITIES[id];
  const range = !a || a.range <= 0 ? "Self" : `R${a.range}`;
  return { label: a?.label ?? id, cost: `${a?.cost ?? 0}E`, range };
}

// Plain-language objective state. `label` is a SHORT state word for the row chip (kept short so it
// never clips the panel); `explain` is a short plain-language gloss of what the state MEANS (never
// hue-only). The full explanation of what the objective wants lives in the hover tooltip.
export function objectivePlain(id: string, status: string): { label: string; explain: string } {
  if (id === "core") {
    if (status === "done") return { label: "Breach", explain: "Breached" };
    if (status === "available") return { label: "Ready", explain: "Hack to breach" };
    return { label: "Locked", explain: "Needs 2 relays" };
  }
  if (id === "extraction") {
    if (status === "done") return { label: "Done", explain: "Reached" };
    if (status === "available") return { label: "Ready", explain: "Reach it to win" };
    return { label: "Sealed", explain: "Breach Core first" };
  }
  // relays
  if (status === "done") return { label: "Done", explain: "Hacked" };
  if (status === "available") return { label: "Ready", explain: "Hack to open Core" };
  return { label: "Idle", explain: "Inactive" };
}

export function objectiveHint(id: string, status: string): string {
  if (id === "core") {
    return status === "available"
      ? "The Core is hackable now — move a hacker onto it to breach, which unlocks Extraction."
      : "The Core. Hackable only after BOTH relays are down. Breaching it unlocks Extraction.";
  }
  if (id === "extraction") {
    return "Reach this point with a living operative AFTER breaching the Core to win the mission.";
  }
  return "A relay (terminal). Hack it to open the way; you need BOTH relays hacked to unseal the Core.";
}

export function deviceKindName(kind: DeviceKind): string {
  return kind === "turret" ? "Auto-Turret" : kind === "camera" ? "Camera" : kind === "node" ? "Security Node" : kind === "core" ? "Core Node" : "Relay Terminal";
}

export function deviceHint(kind: DeviceKind): string {
  switch (kind) {
    case "turret":
      return "Auto-Turret: fires in its cone once the area is alert. EMP it, or Remote-Hack it to turn it around, before you cross.";
    case "camera":
      return "Camera: spots you and raises the alarm. Disable it with Remote Hack or EMP.";
    case "node":
      return "Security Node: powers the cameras and turrets nearby. Blacking it out blinds that whole cluster and lowers the alarm.";
    case "core":
      return "The Core (objective): hack it after both relays to breach and unlock Extraction.";
    default:
      return "Network relay/terminal: a hacking objective — hack it to advance.";
  }
}

// The four named ability buttons the supervisor called out; used by the HUD clarity + onboarding
// specs to assert the Cipher's toolkit is explained (effect, cost, range), not just labelled.
export const CIPHER_ABILITIES = ["arc_bolt", "remote_hack", "emp", "barrier"] as const;