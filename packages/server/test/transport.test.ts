import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInitialState, missionByIndex, autoSolve, computeScore } from "@sb/sim";
import { openDb } from "../src/leaderboard.ts";
import { makeHandler } from "../src/index.ts";

// Journey F — true network round-trip against the authoritative Node server. The server replays
// the submitted action log with the SHARED simulation package and only stores validated runs.
async function withServer(fn: (base: string, db: ReturnType<typeof openDb>) => Promise<void>) {
  const db = openDb(":memory:");
  const handler = makeHandler(db);
  const server = createServer((req, res) => {
    void (handler as unknown as (a: unknown, b: unknown) => Promise<void>)(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, db);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function winningRun() {
  const seed = 31337;
  const initial = createInitialState(missionByIndex(0), seed);
  const { state, log } = autoSolve(initial, 60);
  return { seed, state, log, score: computeScore(state) };
}

describe("server replay validation over HTTP (Journey F)", () => {
  it("accepts a valid replay and rejects a tampered score", async () => {
    const { seed, log, score } = winningRun();
    expect(log.length).toBeGreaterThan(3);
    await withServer(async (base) => {
      const valid = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mission: 0, seed, actions: log, claimedOutcome: "win", claimedScore: score.total, player: "runner" }),
      });
      expect(valid.status).toBe(200);
      const body = (await valid.json()) as { accepted: boolean; recomputed?: { score: number } };
      expect(body.accepted).toBe(true);
      expect(body.recomputed?.score).toBe(score.total);

      const lb = await fetch(`${base}/api/leaderboard?mission=0`);
      const lbBody = (await lb.json()) as { rows: { score: number }[] };
      expect(lbBody.rows.length).toBe(1);

      // tampered score -> rejected + not stored
      const bad = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mission: 0, seed, actions: log, claimedOutcome: "win", claimedScore: score.total + 999 }),
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { accepted: boolean; reason: string };
      expect(badBody.accepted).toBe(false);
      expect(badBody.reason).toBe("score_mismatch");

      const lb2 = await fetch(`${base}/api/leaderboard?mission=0`);
      const lb2Body = (await lb2.json()) as { rows: unknown[] };
      expect(lb2Body.rows.length).toBe(1); // tampered run did not enter the leaderboard
    });
  });

  it("rejects a replay whose action log is altered (invalid transition)", async () => {
    const { seed, log, score } = winningRun();
    const mutated = log.slice(0, -1).concat([{ kind: "attack", unitId: "ghost_999", ability: "silenced_shot", targetUnitId: "nonexistent" }]);
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mission: 0, seed, actions: mutated, claimedOutcome: "win", claimedScore: score.total }),
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { accepted: boolean; reason: string };
      expect(body.accepted).toBe(false);
    });
  });
});
