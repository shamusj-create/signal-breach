import { describe, it, expect } from "vitest";
import { createInitialState, missionByIndex, serializeGame, deserializeGame, deserializeCampaign, SAVE_VERSION } from "../src/index.ts";
import type { GameState } from "../src/index.ts";

function freshMission0(): GameState {
  return createInitialState(missionByIndex(0), 4321);
}

function toV2(state: GameState): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  delete s.vis;
  delete s.noises;
  delete s.alert;
  delete s.alertCool;
  delete s.alertFocus;
  s.version = 2;
  for (const u of s.units as Record<string, unknown>[]) {
    delete u.stealth;
    delete u.visionRange;
    delete u.fovAngle;
    delete u.detMeter;
    delete u.detState;
    delete u.searchPos;
    delete u.searchTurns;
  }
  for (const d of s.doors as Record<string, unknown>[]) {
    delete d.secure;
    delete d.hacked;
  }
  return s;
}

describe("save migration v2 -> v3", () => {
  it("migrates an old-format game state and keeps the squad + objectives", () => {
    const fresh = freshMission0();
    const v2Text = JSON.stringify({ version: 2, state: toV2(fresh) });
    const migrated = deserializeGame(v2Text);
    expect(migrated).not.toBeNull();
    expect(migrated!.version).toBe(SAVE_VERSION);
    expect(migrated!.units.length).toBe(fresh.units.length);
    expect(migrated!.units.map((u) => u.archetype)).toEqual(fresh.units.map((u) => u.archetype));
    expect(migrated!.objectives.map((o) => `${o.id}:${o.status}`)).toEqual(fresh.objectives.map((o) => `${o.id}:${o.status}`));
    expect(migrated!.turn).toBe(fresh.turn);
    expect(migrated!.vis.length).toBe(196);
    expect(migrated!.noises).toEqual([]);
    expect(migrated!.alert).toBe(0);
    for (const u of migrated!.units) expect(u.detState).toBe("unaware");
  });

  it("migrates a legacy v1 top-level payload", () => {
    const fresh = freshMission0();
    const v1 = toV2(fresh);
    delete v1.version;
    const migrated = deserializeGame(JSON.stringify(v1));
    expect(migrated).not.toBeNull();
    expect(migrated!.units.length).toBe(fresh.units.length);
  });

  it("campaign saves preserve squad, upgrades, mission progress", () => {
    const old = {
      version: 2,
      seed: 777,
      mission: 1,
      upgrades: { "p_vanguard_0": ["fortify", "capacitor"], "p_ghost_2": ["quickFeet"] },
      state: undefined,
    };
    const back = deserializeCampaign(JSON.stringify(old));
    expect(back).not.toBeNull();
    expect(back!.mission).toBe(1);
    expect(back!.upgrades["p_vanguard_0"]).toContain("fortify");
    expect(back!.seed).toBe(777);
  });

  it("a campaign carrying a v2 mid-mission state migrates and continues to load", () => {
    const fresh = freshMission0();
    const old = { version: 2, seed: 42, mission: 0, upgrades: {}, state: toV2(fresh) };
    const back = deserializeCampaign(JSON.stringify(old));
    expect(back).not.toBeNull();
    expect(back!.state).toBeTruthy();
    expect(back!.state!.version).toBe(SAVE_VERSION);
  });

  it("round-trips v3 exactly (hash equality)", () => {
    const fresh = freshMission0();
    const text = serializeGame(fresh);
    const back = deserializeGame(text);
    expect(back).not.toBeNull();
    expect(JSON.stringify(back)).toBe(JSON.stringify(fresh));
  });
});

describe("malformed saves fail safely", () => {
  it("rejects garbage, wrong versions and truncated payloads", () => {
    expect(deserializeGame("")).toBeNull();
    expect(deserializeGame("not json")).toBeNull();
    expect(deserializeGame(JSON.stringify({ version: 99, state: {} }))).toBeNull();
    expect(deserializeGame(JSON.stringify({ state: { units: [], tiles: [1, 2, 3] } }))).toBeNull();
    expect(deserializeGame(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(deserializeCampaign("garbage")).toBeNull();
    expect(deserializeCampaign(JSON.stringify({ version: 2, seed: "x", mission: 1 }))).toBeNull();
    expect(deserializeCampaign(JSON.stringify({ version: 2, seed: 1, mission: 9, upgrades: {} }))).toBeNull();
  });

  it("rejects a payload whose migrated state is nonsense", () => {
    const bad = { version: 2, state: { units: [{ id: "x" }], tiles: new Array(196).fill({}), objectives: [] } };
    expect(deserializeGame(JSON.stringify(bad))).toBeNull();
  });
});
