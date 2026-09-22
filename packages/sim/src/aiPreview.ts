// DEBUG / readout ONLY — NOT a rule path. This module reuses the authoritative aiCandidates +
// reachability functions unchanged and reads state only: it never mutates state, revision or the
// action log, and nothing here feeds back into the reducer or replay. It presents a CURRENT-STATE
// preview of the enemy candidate scores — explicitly NOT a record of any past enemy decision.
//
// Only currently-visible living enemies (alive AND that cell's visibility === 2) appear, so
// hidden-unit identity/position/scores are never exposed (same confidentiality rule as the fog
// renderer). Iteration is id-sorted so the output is deterministic regardless of unit array order.
import type { GameState } from "./types.ts";
import { aiCandidates, type AiCandidate } from "./ai.ts";
import { reachableCells } from "./path.ts";
import { livingUnits } from "./queries.ts";

export interface AiPreviewRow {
  id: string;
  x: number;
  y: number;
  topKey: string;
  topAbility: string;
  topTarget?: string;
  topScore: number;
  candidates: number;
}

// Selects the highest candidate under the SAME total order the enemy phase uses
// (score desc, then exposure asc, then key asc). Kept independent of the display so a browser
// oracle can recompute it straight from aiCandidates and compare — see e2e/ai.spec.ts.
function pickTop(cands: AiCandidate[]): AiCandidate | null {
  if (cands.length === 0) return null;
  const ranked = [...cands].sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    if (a.dbg.exposure !== b.dbg.exposure) return a.dbg.exposure - b.dbg.exposure;
    return a.key < b.key ? -1 : 1;
  });
  return ranked[0];
}

export function aiPreview(state: GameState): AiPreviewRow[] {
  const enemies = livingUnits(state, "enemy").sort((a, b) => a.id.localeCompare(b.id));
  const rows: AiPreviewRow[] = [];
  for (const e of enemies) {
    // Gate: a living enemy whose cell is CURRENTLY visible (vis === 2). Hidden enemies are
    // excluded entirely, even in debug mode, so their identity/position/score never leak.
    if (state.vis[e.pos.y * 14 + e.pos.x] !== 2) continue;
    const cands = aiCandidates(state, e, reachableCells(state, e));
    const top = pickTop(cands);
    if (!top) continue;
    const row: AiPreviewRow = {
      id: e.id,
      x: e.pos.x,
      y: e.pos.y,
      topKey: top.key,
      topAbility: top.ability,
      topScore: top.score,
      candidates: cands.length,
    };
    if (top.targetUnitId) row.topTarget = top.targetUnitId;
    rows.push(row);
  }
  return rows;
}