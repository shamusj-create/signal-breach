// Runtime-required builtin: avoids Vite trying to statically resolve the Node 24 SQLite builtin
// (which is not yet in Vite's builtin list). Type is imported type-only (erased at build).
import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => DB };

export interface LeaderRow {
  id?: number;
  player: string;
  mission: number;
  score: number;
  turns: number;
  survival: number;
  ts: number;
  replay_id: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leaderboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player TEXT NOT NULL,
  mission INTEGER NOT NULL,
  score INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  survival INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  replay_id TEXT NOT NULL,
  validated INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_mission ON leaderboard(mission, score DESC);
`;

export function openDb(path = ":memory:"): DB {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new sqlite.DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function addEntry(db: DB, e: LeaderRow): number {
  const stmt = db.prepare(
    "INSERT INTO leaderboard (player, mission, score, turns, survival, ts, replay_id, validated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const r = stmt.run(e.player, e.mission, e.score, e.turns, e.survival, e.ts, e.replay_id, 1);
  return Number(r.lastInsertRowid);
}

export function top(db: DB, mission: number | "all" = "all", limit = 25): LeaderRow[] {
  if (mission === "all") {
    return db.prepare("SELECT * FROM leaderboard ORDER BY score DESC LIMIT ?").all(limit) as unknown as LeaderRow[];
  }
  return db.prepare("SELECT * FROM leaderboard WHERE mission = ? ORDER BY score DESC LIMIT ?").all(mission, limit) as unknown as LeaderRow[];
}

export function count(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM leaderboard").get() as { c: number };
  return row.c;
}
