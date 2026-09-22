import { describe, it, expect } from "vitest";
import {
  MISSIONS,
  missionByIndex,
  createInitialState,
  applyAction,
  reachableCells,
  reconstructPathFromReach,
  hasLineOfSight,
  computeCover,
  previewAttack,
  stateHash,
  computeScore,
  validateReplay,
} from "../src/index.ts";
import type { GameState, PlayerAction, UnitState, Position } from "../src/index.ts";

function livingPlayers(state: GameState): UnitState[] {
  return state.units.filter((u) => u.alive && u.side === "player").sort((a, b) => a.id.localeCompare(b.id));
}
function cheb(a: Position, b: Position) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// Deterministic auto-player: pursues objectives, attacks when possible. Used to prove missions
// are actually completable and that the sim is deterministic across runs.
function autoPlay(missionIndex: number, seed: number, maxTurns = 40): { state: GameState; log: PlayerAction[] } {
  let state = createInitialState(missionByIndex(missionIndex), seed);
  const log: PlayerAction[] = [];
  const run = (a: PlayerAction) => {
    if (state.gameOver) return;
    const r = applyAction(state, a);
    if (r.error) {
      if (r.error === "game_over") return; // game already decided; no further input
      throw new Error(`invalid action ${a.kind}: ${r.error}`);
    }
    state = r.state;
    log.push(a);
  };
  for (let turn = 0; turn < maxTurns && !state.gameOver; turn++) {
    for (const unit0 of livingPlayers(state)) {
      if (state.gameOver) break;
      const u0 = state.units.find((x) => x.id === unit0.id && x.alive);
      if (!u0) continue;
      // MOVE toward current objective or nearest enemy
      const coreDone = state.objectives.find((o) => o.id === "core")?.status === "done";
      const relaysDone = state.objectives.filter((o) => o.id === "relay_a" || o.id === "relay_b").every((o) => o.status === "done");
      let goal: Position | null = null;
      if (coreDone) {
        goal = state.extraction;
      } else {
        const term = state.devices
          .filter((d) => d.kind === "terminal" && !d.hacked)
          .sort((a, b) => cheb(u0.pos, { x: a.x, y: a.y, h: 0 }) - cheb(u0.pos, { x: b.x, y: b.y, h: 0 }))[0];
        if (term) goal = { x: term.x, y: term.y, h: 0 };
        else if (relaysDone) {
          const core = state.devices.find((d) => d.kind === "core" && !d.hacked);
          if (core) goal = { x: core.x, y: core.y, h: 0 };
        }
      }
      const reach = reachableCells(state, u0);
      let bestKey: string | null = null;
      let bestScore = Infinity;
      if (goal) {
        for (const [k, info] of reach) {
          const s = cheb(info.pos, goal);
          if (s < bestScore || (s === bestScore && bestKey && k < bestKey)) {
            bestScore = s;
            bestKey = k;
          }
        }
      }
      if (bestKey) {
        const path = reconstructPathFromReach(reach, bestKey);
        if (path.length > 0) {
          run({ kind: "move", unitId: u0.id, path });
        }
      }
      // ATTACK best target in range/LOS
      const u1 = state.units.find((x) => x.id === unit0.id && x.alive);
      if (!u1 || u1.energy < 3) continue;
      const targets = state.units
        .filter((t) => t.alive && t.side === "enemy")
        .filter((t) => cheb(u1.pos, t.pos) <= u1.atkRange && hasLineOfSight(state, u1.pos, t.pos))
        .sort((a, b) => {
          const da = previewAttack(state, u1.id, u1.defaultAttack, a.id).finalDamage;
          const db = previewAttack(state, u1.id, u1.defaultAttack, b.id).finalDamage;
          return db - da;
        });
      if (targets.length > 0) {
        run({ kind: "attack", unitId: u1.id, ability: u1.defaultAttack, targetUnitId: targets[0].id });
      }
    }
    if (state.gameOver) break;
    run({ kind: "endTurn" });
  }
  return { state, log };
}

describe("mission authoring", () => {
  it("has 3 well-formed layouts", () => {
    for (const m of MISSIONS) {
      expect(m.layout.length).toBe(14);
      for (const row of m.layout) expect(row.length).toBe(14);
    }
  });
  it("spawns land on walkable tiles", () => {
    for (const m of MISSIONS) {
      const state = createInitialState(m, 42);
      for (const s of [...m.players, ...m.enemies]) {
        const blocked = state.tiles[s.y * 14 + s.x]?.blocksMove ?? true;
        expect(blocked, `${m.name} spawn ${s.x},${s.y}`).toBe(false);
      }
    }
  });
  it("each mission has >=2 relays and a reachable extraction", () => {
    for (const m of MISSIONS) {
      const state = createInitialState(m, 7);
      expect(state.devices.filter((d) => d.kind === "terminal").length).toBeGreaterThanOrEqual(2);
      expect(state.extraction).toBeTruthy();
    }
  });
});

describe("missions are completable and deterministic", () => {
  for (const idx of [0, 1, 2]) {
    it(`mission ${idx + 1} plays to a stable, reproducible end state`, () => {
      const a = autoPlay(idx, 1000 + idx);
      const b = autoPlay(idx, 1000 + idx);
      // deterministic across independent runs
      expect(stateHash(a.state)).toBe(stateHash(b.state));
      expect(a.log.length).toBeGreaterThan(3);
    });
  }
  it("replaying the recorded log reproduces the live final hash", () => {
    const { state, log } = autoPlay(0, 5);
    const initial = createInitialState(missionByIndex(0), 5);
    const replayed = replayAll(initial, log);
    expect(stateHash(replayed)).toBe(stateHash(state));
  });
  it("mission 0 is actually winnable by the auto-player", () => {
    const { state } = autoPlay(0, 1000);
    expect(state.victory).toBe(true);
    expect(state.turn).toBeLessThan(40);
  });
});

function replayAll(initial: GameState, log: PlayerAction[]): GameState {
  let s = initial;
  for (const a of log) {
    if (s.gameOver) break;
    const r = applyAction(s, a);
    if (r.error) {
      if (r.error === "game_over") break;
      throw new Error(r.error);
    }
    s = r.state;
    if (s.gameOver) break;
  }
  return s;
}

describe("combat determinism and preview accuracy", () => {
  it("attack preview equals resulting damage (no RNG)", () => {
    const state = createInitialState(missionByIndex(1), 42);
    const attacker = state.units.find((u) => u.side === "player" && u.atkRange >= 3)!;
    const target = state.units.find(
      (t) => t.alive && t.side === "enemy" && cheb(attacker.pos, t.pos) <= attacker.atkRange && hasLineOfSight(state, attacker.pos, t.pos),
    );
    expect(target).toBeTruthy();
    if (!target) return;
    const before = target.hp;
    const preview = previewAttack(state, attacker.id, attacker.defaultAttack, target.id);
    const r = applyAction(state, { kind: "attack", unitId: attacker.id, ability: attacker.defaultAttack, targetUnitId: target.id });
    const after = r.state.units.find((u) => u.id === target.id)!;
    expect(before - after.hp).toBe(preview.finalDamage);
  });
  it("cover reduces damage and matches preview", () => {
    const state = createInitialState(missionByIndex(1), 42);
    // find any enemy standing in/behind cover and check its cover level is applied
    const enemy = state.units.find((u) => u.side === "enemy");
    expect(enemy).toBeTruthy();
    const attacker = state.units.find((u) => u.side === "player")!;
    const cov = computeCover(state, attacker.pos, enemy!.pos);
    expect(["none", "half", "full"]).toContain(cov);
  });
});

describe("enemy AI determinism", () => {
  it("identical state + identical input => identical enemy phase outcome", () => {
    const s1 = createInitialState(missionByIndex(2), 777);
    const s2 = createInitialState(missionByIndex(2), 777);
    const r1 = applyAction(s1, { kind: "endTurn" });
    const r2 = applyAction(s2, { kind: "endTurn" });
    expect(stateHash(r1.state)).toBe(stateHash(r2.state));
    expect(r1.state.turn).toBe(2);
    expect(r1.state.phase).toBe("player");
  });
});

describe("server-side replay validation (shared sim)", () => {
  it("accepts a legitimate, completed replay and rejects tampering", () => {
    const { state, log } = autoPlay(0, 2024);
    const score = computeScore(state);
    const base = { mission: 0, seed: 2024, actions: log, claimedOutcome: (state.victory ? "win" : "lose") as "win" | "lose", claimedScore: score.total };
    const good = validateReplay(base);
    expect(good.valid, JSON.stringify(good)).toBe(true);

    // tamper: inflate the claimed score
    const badScore = validateReplay({ ...base, claimedScore: score.total + 500 });
    expect(badScore.valid).toBe(false);
    expect(badScore.reason).toBe("score_mismatch");

    // tamper: mutate one authoritative action to an impossible one -> rejected as invalid transition
    const mutated = [...log];
    mutated[mutated.length - 1] = { kind: "attack", unitId: "ghost_999", ability: "silenced_shot", targetUnitId: "nonexistent" };
    const badLog = validateReplay({ ...base, actions: mutated });
    expect(badLog.valid).toBe(false);
    expect(badLog.reason).toBe("invalid_transition");

    // tamper: change the claimed outcome of a winning replay
    const badOutcome = validateReplay({ ...base, claimedOutcome: "lose" });
    expect(badOutcome.valid).toBe(false);
    expect(badOutcome.reason).toBe("outcome_mismatch");
  });
  it("rejects an impossible action outright", () => {
    const state = createInitialState(missionByIndex(0), 5);
    const u = livingPlayers(state)[0];
    const bad = validateReplay({
      mission: 0,
      seed: 5,
      actions: [{ kind: "attack", unitId: u.id, ability: "pulse_rifle", targetUnitId: "nonexistent" }],
      claimedOutcome: "lose",
      claimedScore: 0,
    });
    expect(bad.valid).toBe(false);
  });
});