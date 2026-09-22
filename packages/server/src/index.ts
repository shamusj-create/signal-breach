import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./leaderboard.ts";
import { submitRun, leaderboard } from "./validate.ts";

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

// Testable HTTP handler around a provided DB.
export function makeHandler(db: DatabaseSync) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/health") return json(res, 200, { ok: true, ts: Date.now() });
      if (req.method === "GET" && path === "/api/leaderboard") {
        const m = url.searchParams.get("mission");
        const mission = m === null || m === "all" ? "all" : Number(m);
        return json(res, 200, { rows: leaderboard(db, mission) });
      }
      if (req.method === "POST" && path === "/api/submit") {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return json(res, 400, { accepted: false, reason: "bad_json" });
        }
        const result = submitRun(db, parsed as never);
        return json(res, result.accepted ? 200 : 400, result);
      }
      return json(res, 404, { ok: false, reason: "not_found" });
    } catch (e) {
      return json(res, 500, { ok: false, reason: (e as Error).message });
    }
  };
}

export function main() {
  const dbPath = process.env.SB_DB ?? ":memory:";
  const db = openDb(dbPath);
  const port = Number(process.env.SB_PORT ?? 8787);
  const handler = makeHandler(db);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port, () => {
    console.log(`[signal-breach] server on http://localhost:${port} db=${dbPath}`);
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("index.ts")) main();
