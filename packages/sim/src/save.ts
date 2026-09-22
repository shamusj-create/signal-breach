import type { GameState, UnitState } from "./types.ts";
import type { UpgradeId } from "./upgrades.ts";

export const SAVE_VERSION = 3;

export interface CampaignSave {
  version: number;
  seed: number;
  mission: number;
  upgrades: Record<string, UpgradeId[]>;
  state?: GameState;
  savedAt?: number;
}

import { UNIT_DEFS } from "./units.ts";
import { updateVisibility } from "./stealth.ts";

function defaultUnitPatch(u: Record<string, unknown>): Record<string, unknown> {
  const def = UNIT_DEFS[(u.archetype as keyof typeof UNIT_DEFS) ?? "vanguard"] ?? UNIT_DEFS.vanguard;
  return {
    stealth: typeof u.stealth === "number" ? u.stealth : def.stealth,
    visionRange: typeof u.visionRange === "number" ? u.visionRange : def.visionRange,
    fovAngle: typeof u.fovAngle === "number" ? u.fovAngle : def.fovAngle,
    detMeter: typeof u.detMeter === "number" ? u.detMeter : 0,
    detState: typeof u.detState === "string" ? u.detState : "unaware",
    searchPos: u.searchPos ?? null,
    searchTurns: typeof u.searchTurns === "number" ? u.searchTurns : 0,
  };
}

// Fail-safe: any malformed payload returns null rather than throwing/crashing.
export function deserializeGame(text: string): GameState | null {
  if (typeof text !== "string" || text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const migrated = migrate(parsed);
  if (!migrated) return null;
  return migrated.state;
}

function isPlausibleState(s: unknown): s is GameState {
  if (!s || typeof s !== "object") return false;
  const g = s as Record<string, unknown>;
  return (
    Array.isArray(g.units) &&
    (g.units as unknown[]).length > 0 &&
    Array.isArray(g.tiles) &&
    g.tiles.length === 196 &&
    Array.isArray(g.objectives) &&
    typeof g.turn === "number" &&
    typeof g.seed === "number" &&
    (g.phase === "player" || g.phase === "enemy")
  );
}

// Migration chain: v1 (top-level state) -> v2 (state wrapper) -> v3 (stealth/security fields).
// Never throws; anything unrecognisable returns null.
export function migrate(payload: unknown): { version: number; state: GameState } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  let version = typeof p.version === "number" ? p.version : 1;
  if (version > SAVE_VERSION) return null;
  let state: GameState | undefined = p.state as GameState | undefined;
  if (version === 1 && !state && Array.isArray(p.units)) state = p as unknown as GameState;
  if (!state || !isPlausibleState(state)) return null;
  // fill stealth/security fields absent before v3
  const raw = state as unknown as Record<string, unknown>;
  const units = (raw.units as Record<string, unknown>[]).map((u) => ({ ...u, ...defaultUnitPatch(u) })) as unknown as UnitState[];
  const filled: GameState = {
    ...(state as GameState),
    version: SAVE_VERSION,
    units,
    vis: Array.isArray(raw.vis) && (raw.vis as number[]).length === 196 ? (raw.vis as number[]) : new Array(196).fill(2),
    noises: Array.isArray(raw.noises) ? (raw.noises as GameState["noises"]) : [],
    alert: typeof raw.alert === "number" ? raw.alert : 0,
    alertCool: typeof raw.alertCool === "number" ? raw.alertCool : 0,
    alertFocus: (raw.alertFocus as GameState["alertFocus"]) ?? null,
    doors: Array.isArray(raw.doors)
      ? (raw.doors as Record<string, unknown>[]).map((d) => ({ ...d, secure: d.secure ?? false, hacked: d.hacked ?? false }) as unknown as GameState["doors"][number])
      : [],
    devices: Array.isArray(raw.devices)
      ? (raw.devices as Record<string, unknown>[]).map((d) => ({
          ...d,
          netId: d.netId ?? "net_0_0",
          powered: d.powered ?? true,
          owner: d.owner ?? "security",
        }) as unknown as GameState["devices"][number])
      : [],
    destructibles: Array.isArray(raw.destructibles)
      ? (raw.destructibles as Record<string, unknown>[]).map((d) => ({
          ...d,
          blocksSight: d.blocksSight ?? false,
          blocksMove: d.blocksMove ?? true,
        }) as unknown as GameState["destructibles"][number])
      : [],
  };
  updateVisibility(filled);
  return { version: SAVE_VERSION, state: filled };
}

export function serializeGame(state: GameState): string {
  return JSON.stringify({ version: SAVE_VERSION, state });
}

export function serializeCampaign(c: CampaignSave): string {
  return JSON.stringify(c);
}

export function deserializeCampaign(text: string): CampaignSave | null {
  if (typeof text !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as CampaignSave;
  if (typeof c.version !== "number") return null;
  if (typeof c.seed !== "number" || typeof c.mission !== "number") return null;
  if (c.mission < 0 || c.mission > 2) return null;
  if (c.state) {
    const m = migrate({ version: c.version, state: c.state });
    if (!m) return null;
    return { ...c, version: SAVE_VERSION, state: m.state };
  }
  return c;
}
