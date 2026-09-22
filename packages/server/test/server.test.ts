import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createInitialState, missionByIndex, autoSolve, computeScore } from "@sb/sim";
import { openDb, count, top } from "../src/leaderboard.ts";
import { submitRun } from "../src/validate.ts";
import { makeHandler } from "../src/index.ts";

function winningRun() {
  const seed = 2024;
  const initial = createInitialState(missionByIndex(0), seed);
  const { state, log } = autoSolve(initial, 60);
  const score = computeScore(state);
  return { seed, state, log, score };
}

describe("server replay validation (shared authoritative sim)", () => {
  it("accepts a valid winning replay and records it", () => {
    const { seed, state, log, score } = winningRun();
    expect(state.victory).toBe(true); // sanity: a real win
    const db = openDb(":memory:");
    const input = {
      mission: 0,
      seed,
      actions: log,
      claimedOutcome: "win",
      claimedScore: score.total,
      player: "runner",
    };
    const r = submitRun(db, input as never);
    expect(r.accepted).toBe(true);
    expect(r.entry?.score).toBe(score.total);
    expect(r.entry?.survival).toBeGreaterThan(0);
    expect(count(db)).toBe(1);
  });

  it("rejects a tampered score", () => {
    const { seed, log, score } = winningRun();
    const db = openDb(":memory:");
    const r = submitRun(db, { mission: 0, seed, actions: log, claimedOutcome: "win", claimedScore: score.total + 999 });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("score_mismatch");
    expect(count(db)).toBe(0);
  });

  it("rejects a tampered action log", () => {
    const { seed, log, score } = winningRun();
    const db = openDb(":memory:");
    const mutated = log.slice(0, -1);
    const r = submitRun(db, { mission: 0, seed, actions: mutated, claimedOutcome: "win", claimedScore: score.total });
    // Removing actions changes the outcome/score => rejected (mismatch or incomplete)
    expect(r.accepted).toBe(false);
    expect(count(db)).toBe(0);
  });

  it("rejects an incomplete (non-terminal) replay", () => {
    const { seed, log, score } = winningRun();
    const partial = log.slice(0, 3);
    const db = openDb(":memory:");
    const r = submitRun(db, { mission: 0, seed, actions: partial, claimedOutcome: "win", claimedScore: score.total });
    expect(r.accepted).toBe(false);
  });
});

describe("leaderboard persistence", () => {
  it("persists validated entries across DB reopen (file-backed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbdb"));
    const path = join(dir, "lb.sqlite");
    try {
      const { seed, log, score } = winningRun();
      const db1 = openDb(path);
      const r1 = submitRun(db1, { mission: 0, seed, actions: log, claimedOutcome: "win", claimedScore: score.total, player: "a" });
      const r2 = submitRun(db1, { mission: 0, seed, actions: log, claimedOutcome: "win", claimedScore: score.total - 5, player: "b" });
      expect(r1.accepted).toBe(true);
      expect(r2.accepted).toBe(false); // wrong claimed score -> rejected, not stored
      expect(count(db1)).toBe(1);
      db1.close();
      const db2 = openDb(path);
      expect(count(db2)).toBe(1);
      const rows = top(db2, "all");
      expect(rows.length).toBe(1);
      expect(rows.every((r) => r.replay_id.includes(":"))).toBe(true);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves and rejects through the HTTP handler without crashing", async () => {    const db = openDb(":memory:");
    const handler = makeHandler(db);
    const { seed, log, score } = winningRun();

    // valid submit through HTTP
    const validBody = JSON.stringify({ mission: 0, seed, actions: log, claimedOutcome: "win", claimedScore: score.total, player: "a" });
    const r1 = await runHandler(handler, "POST", "/api/submit", validBody);
    expect(r1.status).toBe(200);
    expect(JSON.parse(r1.body).accepted).toBe(true);

    // garbage body -> 400 (bad_json), no crash
    const r2 = await runHandler(handler, "POST", "/api/submit", "not-json{");
    expect(r2.status).toBe(400);
    expect(JSON.parse(r2.body).reason).toBe("bad_json");

    // tampered score -> 400
    const tamper = JSON.stringify({ mission: 0, seed, actions: log, claimedOutcome: "win", claimedScore: score.total + 999 });
    const r3 = await runHandler(handler, "POST", "/api/submit", tamper);
    expect(r3.status).toBe(400);

    // leaderboard endpoint
    const r4 = await runHandler(handler, "GET", "/api/leaderboard?mission=0", "");
    expect(r4.status).toBe(200);
    expect(JSON.parse(r4.body).rows.length).toBe(1);
  });
});

interface FakeRes {
  statusCode: number;
  body: string;
  writeHead(code: number, h: Record<string, string>): void;
  end(d: string): void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: "",
    writeHead(code: number) {
      res.statusCode = code;
    },
    end(d: string) {
      res.body = d;
    },
  };
  return res;
}

async function runHandler(handler: (req: any, res: any) => Promise<void>, method: string, url: string, body: string) {
  const req = new Readable();
  if (body.length) {
    req.push(body);
    req.push(null);
  }
  const anyReq = req as unknown as { method: string; url: string };
  anyReq.method = method;
  anyReq.url = url;
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}