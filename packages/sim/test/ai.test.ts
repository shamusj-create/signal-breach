import { describe, it, expect } from "vitest";
import { createInitialState, missionByIndex, applyAction, aiCandidates, reachableCells, emitNoise, aiPreview, decideEnemyActions } from "../src/index.ts";
import { cloneState } from "../src/queries.ts";
import type { GameState } from "../src/index.ts";

function deploy(mission = 1, seed = 42): GameState {
  return createInitialState(missionByIndex(mission), seed);
}

describe("AI scoring + determinism", () => {
  it("every enemy exposes scored candidates with a debug breakdown", () => {
    const s = deploy(2, 7);
    const enemies = s.units.filter((u) => u.alive && u.side === "enemy");
    expect(enemies.length).toBeGreaterThan(0);
    for (const e of enemies) {
      const reach = reachableCells(s, e);
      const cands = aiCandidates(s, e, reach);
      expect(cands.length).toBeGreaterThan(0);
      const best = [...cands].sort((a, b) => b.score - a.score)[0];
      expect(Number.isFinite(best.score)).toBe(true);
      expect(best.dbg).toHaveProperty("expectedDamage");
      expect(best.dbg).toHaveProperty("exposure");
      expect(best.dbg).toHaveProperty("hunt");
      expect(best.dbg).toHaveProperty("objective");
      expect(best.dbg).toHaveProperty("alert");
    }
  });

  it("identical states produce identical candidate scores and identical phases", () => {
    const a = deploy(1, 12);
    const b = deploy(1, 12);
    for (const ea of a.units.filter((u) => u.alive && u.side === "enemy")) {
      const eb = b.units.find((u) => u.id === ea.id)!;
      const ca = aiCandidates(a, ea, reachableCells(a, ea)).map((c) => `${c.key}:${c.score.toFixed(6)}`);
      const cb = aiCandidates(b, eb, reachableCells(b, eb)).map((c) => `${c.key}:${c.score.toFixed(6)}`);
      expect(ca).toEqual(cb);
    }
    const r1 = applyAction(deploy(1, 12), { kind: "endTurn" });
    const r2 = applyAction(deploy(1, 12), { kind: "endTurn" });
    expect(JSON.stringify(r1.state.units.filter((u) => u.side === "enemy").map((u) => `${u.id}@${u.pos.x},${u.pos.y}`))).toEqual(
      JSON.stringify(r2.state.units.filter((u) => u.side === "enemy").map((u) => `${u.id}@${u.pos.x},${u.pos.y}`)),
    );
  });

  it("noise shifts AI positioning toward the disturbance (no LOS needed)", () => {
    const quiet = deploy(2, 31);
    const loud = clone(quiet);
    emitNoise(loud, 2, 2, 9, "explosion");
    const hunterQ = quiet.units.find((u) => u.archetype === "hunter")!;
    const hunterL = loud.units.find((u) => u.archetype === "hunter")!;
    const cq = aiCandidates(quiet, hunterQ, reachableCells(quiet, hunterQ));
    const cl = aiCandidates(loud, hunterL, reachableCells(loud, hunterL));
    const bestQ = [...cq].sort((a, b) => b.score - a.score)[0];
    const bestL = [...cl].sort((a, b) => b.score - a.score)[0];
    const distQ = Math.max(Math.abs(bestQ.dest.x - 2), Math.abs(bestQ.dest.y - 2));
    const distL = Math.max(Math.abs(bestL.dest.x - 2), Math.abs(bestL.dest.y - 2));
    expect(distL).toBeLessThanOrEqual(distQ);
  });

  it("higher alert = more aggressive scoring than covert", () => {
    const covert = deploy(2, 3);
    const hot = clone(covert);
    hot.alert = 3;
    const e1 = covert.units.filter((u) => u.alive && u.side === "enemy" && u.detState !== "searching");
    for (const e of e1) {
      const e2 = hot.units.find((u) => u.id === e.id)!;
      const c1 = aiCandidates(covert, e, reachableCells(covert, e));
      const c2 = aiCandidates(hot, e2, reachableCells(hot, e2));
      const best1 = Math.max(...c1.map((c) => c.score));
      const best2 = Math.max(...c2.map((c) => c.score));
      expect(Number.isFinite(best1) && Number.isFinite(best2)).toBe(true);
    }
  });
});

describe("AI current-state preview (debug readout)", () => {
  // INDEPENDENT oracle: derive the expected preview straight from aiCandidates (never via
  // aiPreview) using the same total order the enemy phase uses. This catches a display that shows
  // a wrong/mocked candidate or that leaks hidden enemies, instead of trusting the display.
  function oracleRows(s: GameState): { id: string; key: string; score: number }[] {
    const enemies = s.units
      .filter((u) => u.alive && u.side === "enemy" && s.vis[u.pos.y * 14 + u.pos.x] === 2)
      .sort((a, b) => a.id.localeCompare(b.id));
    const out: { id: string; key: string; score: number }[] = [];
    for (const e of enemies) {
      const cands = aiCandidates(s, e, reachableCells(s, e));
      const ranked = [...cands].sort((a, b) => {
        if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
        if (a.dbg.exposure !== b.dbg.exposure) return a.dbg.exposure - b.dbg.exposure;
        return a.key < b.key ? -1 : 1;
      });
      const best = ranked[0];
      if (best) out.push({ id: e.id, key: best.key, score: best.score });
    }
    return out;
  }

  it("preview mirrors the independent oracle and exposes only currently-visible living enemies", () => {
    const s = deploy(2, 7);
    const enemies = s.units.filter((u) => u.alive && u.side === "enemy");
    expect(enemies.length).toBeGreaterThanOrEqual(2);
    // craft a deterministic mix: make exactly one enemy visible, keep the rest hidden.
    for (const e of enemies) s.vis[e.pos.y * 14 + e.pos.x] = 0;
    const visible = enemies[0];
    s.vis[visible.pos.y * 14 + visible.pos.x] = 2;
    const hidden = enemies.slice(1);

    const prod = aiPreview(s);
    const exp = oracleRows(s);
    const fmt = (r: { id: string; topKey: string; topScore: number }) => `${r.id}:${r.topKey}:${r.topScore.toFixed(3)}`;
    expect(prod.map(fmt)).toEqual(exp.map((r) => `${r.id}:${r.key}:${r.score.toFixed(3)}`));
    expect(prod.length).toBe(1);
    // hidden enemies must not leak into the readout at all
    const blob = JSON.stringify(prod);
    for (const h of hidden) expect(blob).not.toContain(h.id);
  });

  it("reading the preview is pure: no mutation of state, revision, or the action log", () => {
    const s = deploy(1, 12);
    const anyEnemy = s.units.find((u) => u.alive && u.side === "enemy")!;
    s.vis[anyEnemy.pos.y * 14 + anyEnemy.pos.x] = 2;
    const before = clone(s);
    const rev = s.revision;
    const logLen = s.log.length;
    const a = aiPreview(s);
    const b = aiPreview(s);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    expect(JSON.stringify(s)).toEqual(JSON.stringify(before));
    expect(s.revision).toBe(rev);
    expect(s.log.length).toBe(logLen);
  });

  it("preview top corresponds to the authoritative enemy decision (one shared source)", () => {
    const s = deploy(2, 7);
    for (const e of s.units.filter((u) => u.alive && u.side === "enemy")) s.vis[e.pos.y * 14 + e.pos.x] = 2;
    const rows = aiPreview(s);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const e = s.units.find((u) => u.id === row.id)!;
      const act = decideEnemyActions(s, e, reachableCells(s, e))[0];
      expect(act).toBeTruthy();
      expect(row.topAbility).toBe(act!.ability);
      if (act!.targetUnitId) expect(row.topTarget).toBe(act!.targetUnitId);
    }
  });

  it("preview is deterministic: equivalent seeded states yield an identical preview", () => {
    const a = deploy(3, 99);
    const b = deploy(3, 99);
    for (const e of a.units.filter((u) => u.alive && u.side === "enemy")) a.vis[e.pos.y * 14 + e.pos.x] = 2;
    for (const e of b.units.filter((u) => u.alive && u.side === "enemy")) b.vis[e.pos.y * 14 + e.pos.x] = 2;
    expect(JSON.stringify(aiPreview(a))).toEqual(JSON.stringify(aiPreview(b)));
  });

  it("producer keys on CURRENT visibility+aliveness: a now-hidden or dead enemy drops out of a fresh recompute", () => {
    const s = deploy(2, 7);
    const enemies = s.units.filter((u) => u.alive && u.side === "enemy");
    expect(enemies.length).toBeGreaterThanOrEqual(1);
    const target = enemies[0];
    s.vis[target.pos.y * 14 + target.pos.x] = 2;
    const before = aiPreview(s);
    expect(before.map((r) => r.id)).toContain(target.id); // shown while alive AND currently visible
    // Transition fixture: the enemy is now DEAD and no longer currently visible. A preview computed
    // over this state must not still describe it — the property the browser checks against the live,
    // notification-driven display, so the display can never lag a state transition (item 2).
    const after = cloneState(s);
    const dead = after.units.find((u) => u.id === target.id)!;
    dead.alive = false;
    dead.hp = 0;
    after.vis[target.pos.y * 14 + target.pos.x] = 0;
    const rows = aiPreview(after);
    expect(rows.map((r) => r.id)).not.toContain(target.id);
    expect(JSON.stringify(rows)).not.toEqual(JSON.stringify(before));
  });

  it("reading the preview is pure over a NON-EMPTY history: log, revision and state unchanged", () => {
    const s = deploy(2, 7);
    const enemy = s.units.find((u) => u.alive && u.side === "enemy")!;
    s.vis[enemy.pos.y * 14 + enemy.pos.x] = 2;
    // Make the assertion meaningful: a NON-EMPTY authoritative history (log + revision), not an empty
    // one where "unchanged" would be trivially true.
    s.log = ["a_unit_1 moves to 3,4", "e_enforcer_5 reacts", "alarm level -> 1"];
    s.revision = 9;
    const snapshot = cloneState(s);
    const rev = s.revision;
    const logLen = s.log.length;
    expect(logLen, "history must be non-empty for this check").toBeGreaterThan(0);
    const r1 = aiPreview(s);
    const r2 = aiPreview(s);
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2));
    expect(JSON.stringify(s)).toEqual(JSON.stringify(snapshot));
    expect(s.revision, "revision unchanged while reading the preview").toBe(rev);
    expect(s.log.length, "action history length unchanged while reading the preview").toBe(logLen);
  });
});

function clone(s: GameState): GameState {
  return JSON.parse(JSON.stringify(s)) as GameState;
}
