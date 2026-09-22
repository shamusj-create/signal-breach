import { describe, it, expect } from "vitest";
import { createInitialState, missionByIndex, applyAction, emitNoise, hasLineOfSight } from "../src/index.ts";
import type { GameState, MissionDef, UnitArchetype } from "../src/index.ts";

// Hermetic 14x14 fixture: open central corridor, one camera (A), one turret (R), one node (N),
// a locked security door (D) mid-right, plus guards. Lets security tests control LOS exactly.
const SEC_LAYOUT = [
  "##############",
  "#..v.....v...#",
  "#.A..........#",
  "#............#",
  "#..OO...OO...#",
  "#............#",
  "#.....R..N.D.#",
  "#............#",
  "#..v.....v...#",
  "#..T......T..#",
  "#....K.......#",
  "#............#",
  "#.....X......#",
  "##############",
];

function secMission(): MissionDef {
  return {
    index: 2,
    name: "Security Lab",
    layout: SEC_LAYOUT,
    players: [
      { archetype: "cipher" as UnitArchetype, x: 2, y: 11 },
      { archetype: "ghost" as UnitArchetype, x: 3, y: 11 },
      { archetype: "vanguard" as UnitArchetype, x: 1, y: 11 },
    ],
    enemies: [
      { archetype: "sentry" as UnitArchetype, x: 8, y: 6 },
      { archetype: "hunter" as UnitArchetype, x: 10, y: 8 },
    ],
  };
}

function sec(): GameState {
  return createInitialState(secMission(), 4242);
}

describe("security network", () => {
  it("security devices belong to labelled net clusters and start powered", () => {
    const s = sec();
    const cams = s.devices.filter((d) => d.kind === "camera");
    const turrets = s.devices.filter((d) => d.kind === "turret");
    const nodes = s.devices.filter((d) => d.kind === "node");
    expect(cams.length).toBeGreaterThanOrEqual(1);
    expect(turrets.length).toBe(1);
    expect(nodes.length).toBe(1);
    for (const d of s.devices) {
      expect(d.netId.startsWith("net_")).toBe(true);
      expect(d.owner).toBe("security");
    }
  });

  it("Cipher disables a camera at range through the network", () => {
    let s = sec();
    const cam = s.devices.find((d) => d.kind === "camera")!;
    const cipher = s.units.find((u) => u.archetype === "cipher")!;
    // step the cipher into the open lane with LOS
    cipher.pos = { x: cam.x + 2, y: cam.y + 2, h: 0 };
    expect(hasLineOfSight(s, cipher.pos, { x: cam.x, y: cam.y, h: 0 })).toBe(true);
    const r = applyAction(s, { kind: "ability", unitId: cipher.id, ability: "remote_hack", targetPos: { x: cam.x, y: cam.y, h: 0 } });
    expect(r.error).toBeUndefined();
    const dev = r.state.devices.find((d) => d.id === cam.id)!;
    expect(dev.owner).toBe("disabled");
    expect(dev.powered).toBe(false);
  });

  it("a hijacked turret fires on the guards", () => {
    let s = sec();
    const turret = s.devices.find((d) => d.kind === "turret")!;
    const guard = s.units.find((u) => u.alive && u.side === "enemy" && u.archetype === "sentry")!;
    const cipher = s.units.find((u) => u.archetype === "cipher")!;
    guard.pos = { x: turret.x + 1, y: turret.y, h: 0 };
    cipher.pos = { x: turret.x, y: turret.y + 3, h: 0 };
    expect(hasLineOfSight(s, cipher.pos, { x: turret.x, y: turret.y, h: 0 })).toBe(true);
    s.alert = 1;
    const r1 = applyAction(s, { kind: "ability", unitId: cipher.id, ability: "remote_hack", targetPos: { x: turret.x, y: turret.y, h: 0 } });
    expect(r1.error).toBeUndefined();
    expect(r1.state.devices.find((d) => d.id === turret.id)!.owner).toBe("hijacked");
    const before = r1.state.units.find((u) => u.id === guard.id)!.hp;
    const r2 = applyAction(r1.state, { kind: "endTurn" });
    const after = r2.state.units.find((u) => u.id === guard.id)!.hp;
    expect(after, "hijacked turret should shoot the guard").toBeLessThan(before);
  });

  it("blacking out a node kills its whole cluster and cools the alert", () => {
    let s = sec();
    const node = s.devices.find((d) => d.kind === "node")!;
    s.alert = 2;
    const cipher = s.units.find((u) => u.archetype === "cipher")!;
    cipher.pos = { x: node.x, y: node.y + 2, h: 0 };
    expect(hasLineOfSight(s, cipher.pos, { x: node.x, y: node.y, h: 0 })).toBe(true);
    const r = applyAction(s, { kind: "ability", unitId: cipher.id, ability: "remote_hack", targetPos: { x: node.x, y: node.y, h: 0 } });
    expect(r.error).toBeUndefined();
    const sameNet = r.state.devices.filter((d) => d.netId === node.netId && (d.kind === "camera" || d.kind === "turret" || d.kind === "node"));
    expect(sameNet.length).toBeGreaterThanOrEqual(2);
    for (const d of sameNet) expect(d.owner, `${d.id} should share the node fate`).toBe("disabled");
    expect(r.state.alert).toBe(1);
  });
});

describe("alarm escalation", () => {
  it("loud gunfire alerts nearby guards; a silenced shot does not", () => {
    const quiet = sec();
    const loud = JSON.parse(JSON.stringify(quiet)) as GameState;
    for (const s of [quiet, loud]) {
      // isolate the noise rule: no camera watching the lane
      for (const d of s.devices) {
        if (d.kind === "camera") {
          d.owner = "disabled";
          d.powered = false;
        }
      }
      const guard = s.units.find((u) => u.archetype === "sentry" && u.alive)!;
      guard.pos = { x: 5, y: 6, h: 0 };
      const sniper = s.units.find((u) => u.archetype === "vanguard")!;
      sniper.pos = { x: 5, y: 3, h: 0 };
      sniper.energy = 9;
    }
    const guardId = quiet.units.find((u) => u.archetype === "sentry" && u.alive)!.id;
    const sniperId = quiet.units.find((u) => u.archetype === "vanguard")!.id;
    expect(hasLineOfSight(quiet, { x: 5, y: 3, h: 0 }, { x: 5, y: 6, h: 0 })).toBe(true);
    const rq = applyAction(quiet, { kind: "attack", unitId: sniperId, ability: "silenced_shot", targetUnitId: guardId });
    const rs = applyAction(loud, { kind: "attack", unitId: sniperId, ability: "pulse_rifle", targetUnitId: guardId });
    expect(rq.error).toBeUndefined();
    expect(rs.error).toBeUndefined();
    expect(rq.state.alert, "a quiet board must stay covert").toBe(0);
    const qGuard = rq.state.units.find((u) => u.id === guardId)!;
    expect(qGuard.detState, "a silenced hit may startle but must not escalate").not.toBe("alerted");
    const lGuard = rs.state.units.find((u) => u.id === guardId)!;
    expect(lGuard.detState, "loud gunfire must wake the target").toBe("alerted");
    expect(rs.state.alert).toBeGreaterThanOrEqual(1);
  });

  it("lockdown re-locks unhacked security doors", () => {
    let s = sec();
    const door = s.doors[0];
    expect(door).toBeTruthy();
    door.open = true;
    s.alert = 3;
    const r = applyAction(s, { kind: "endTurn" });
    expect(r.state.doors.find((d) => d.id === door.id)!.open).toBe(false);
  });

  it("a hacked door stays open through lockdown", () => {
    let s = sec();
    const door = s.doors[0];
    door.open = true;
    door.hacked = true;
    s.alert = 3;
    const r = applyAction(s, { kind: "endTurn" });
    expect(r.state.doors.find((d) => d.id === door.id)!.open).toBe(true);
  });

  it("noise without LOS still draws guards toward it", () => {
    let s = sec();
    const before = s.units.filter((u) => u.alive && u.side === "enemy");
    const nearestBefore = Math.min(...before.map((u) => Math.max(Math.abs(u.pos.x - 2), Math.abs(u.pos.y - 6))));
    emitNoise(s, 2, 6, 9, "explosion");
    const r = applyAction(s, { kind: "endTurn" });
    const after = r.state.units.filter((u) => u.alive && u.side === "enemy");
    const nearestAfter = Math.min(...after.map((u) => Math.max(Math.abs(u.pos.x - 2), Math.abs(u.pos.y - 6))));
    expect(nearestAfter).toBeLessThan(nearestBefore);
  });

  it("alert state serializes + round-trips through the save format", async () => {
    let s = sec();
    s.alert = 2;
    s.alertFocus = { x: 6, y: 6, h: 0 };
    const { serializeGame, deserializeGame, stateHash } = await import("../src/index.ts");
    const text = serializeGame(s);
    const back = deserializeGame(text);
    expect(back).not.toBeNull();
    expect(back!.alert).toBe(2);
    expect(back!.vis).toEqual(s.vis);
    expect(stateHash(back!)).toBe(stateHash(s));
  });
});

describe("mission 3 fixture", () => {
  it("core chamber has cameras + turrets + a connected node", () => {
    const s = createInitialState(missionByIndex(2), 9);
    expect(s.devices.filter((d) => d.kind === "camera").length).toBeGreaterThanOrEqual(2);
    expect(s.devices.filter((d) => d.kind === "turret").length).toBeGreaterThanOrEqual(2);
    const turrets = s.devices.filter((d) => d.kind === "turret");
    for (const t of turrets) expect(t.netId.startsWith("net_")).toBe(true);
  });
});
