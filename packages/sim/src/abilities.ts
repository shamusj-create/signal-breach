import type { AbilityId } from "./types.ts";

export interface AbilityDef {
  id: AbilityId;
  label: string;
  cost: number; // energy cost
  kind: "attack" | "movement" | "support" | "control";
  range: number;
  desc: string;
}

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  pulse_rifle: { id: "pulse_rifle", label: "Pulse Rifle", cost: 3, kind: "attack", range: 5, desc: "Reliable rifle shot." },
  dash: { id: "dash", label: "Dash", cost: 2, kind: "movement", range: 3, desc: "Burst 3 tiles ignoring cost." },
  overwatch: { id: "overwatch", label: "Overwatch", cost: 2, kind: "control", range: 5, desc: "Reaction fire at movers." },
  concussion: { id: "concussion", label: "Concussion", cost: 3, kind: "attack", range: 4, desc: "AoE: damage + stun, ignores cover." },
  silenced_shot: { id: "silenced_shot", label: "Silenced Shot", cost: 3, kind: "attack", range: 6, desc: "Long quiet shot." },
  cloak: { id: "cloak", label: "Cloak", cost: 3, kind: "support", range: 0, desc: "Unattackable until revealed." },
  blink: { id: "blink", label: "Blink", cost: 2, kind: "movement", range: 4, desc: "Teleport up to 4 tiles." },
  backstab: { id: "backstab", label: "Backstab", cost: 3, kind: "attack", range: 3, desc: "Ignores cover, +4 dmg when flanking." },
  takedown: { id: "takedown", label: "Silent Takedown", cost: 3, kind: "attack", range: 1, desc: "Eliminates an unaware or suspicious target from adjacency. Keeps cloak." },
  arc_bolt: { id: "arc_bolt", label: "Arc Bolt", cost: 3, kind: "attack", range: 5, desc: "Pierces cover." },
  remote_hack: { id: "remote_hack", label: "Remote Hack", cost: 4, kind: "support", range: 5, desc: "Hack device/door at range." },
  emp: { id: "emp", label: "EMP", cost: 3, kind: "control", range: 4, desc: "Disables electronics, AoE." },
  barrier: { id: "barrier", label: "Barrier", cost: 4, kind: "support", range: 3, desc: "Damage shield on ally/self." },
  sentry_shot: { id: "sentry_shot", label: "Sentry Shot", cost: 3, kind: "attack", range: 5, desc: "Ranged." },
  enforcer_slam: { id: "enforcer_slam", label: "Crush", cost: 3, kind: "attack", range: 1, desc: "Melee, ignores cover." },
  hunter_rush: { id: "hunter_rush", label: "Lunge", cost: 4, kind: "attack", range: 3, desc: "Fast flank attack." },
  warden_field: { id: "warden_field", label: "Support Field", cost: 4, kind: "support", range: 4, desc: "Shield allies or control foes." },
};