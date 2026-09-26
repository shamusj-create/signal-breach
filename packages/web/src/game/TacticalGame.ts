import type { GameState, PlayerAction, Position, UnitState, AbilityId, GameEvents } from "@sb/sim";
import {
  createInitialState,
  missionByIndex,
  applyAction,
  reachableCells,
  reconstructPathFromReach,
  previewAttack,
  autoSolve,
  serializeGame,
  deserializeGame,
  ABILITIES,
} from "@sb/sim";
import { World } from "../scene/World.ts";
import { Store, type Snapshot } from "./serialize.ts";
import { playSfx, playVoice } from "../audio.ts";
import { legalTargetsFor } from "./targeting.ts";
import { deviceKindName } from "../guidance.ts";

export type SnapshotStore = Store<Snapshot>;

function posKey(p: Position): string {
  return `${p.x},${p.y}`;
}

// Left-drag grab-to-rotate + click-vs-drag tuning. A left gesture that moves more than CLICK_DRAG_PX
// becomes a continuous orbit (the azimuth follows the drag through intermediate angles, no quarter snap);
// under that threshold it stays a plain click, which now resolves on pointer-UP (never on DOWN), so a
// click preceded by a drag cannot double-fire a selection/move/attack. Instead of the old horizontal-only
// delta, the azimuth follows the pointer's ANGLE about the screen-centre pivot (the point you grabbed
// follows the cursor); GRAB_ROT_SIGN/GAIN were tuned by measuring the subject's angular change against
// the pointer's, and a straight pass within GRAB_PIVOT_DEGEN px of the pivot is a degenerate no-op.
const CLICK_DRAG_PX = 8;
const GRAB_PIVOT_DEGEN = 20;
const GRAB_ROT_SIGN = 1;
const GRAB_ROT_GAIN = 1.0;

export class TacticalGame {
  state: GameState;
  store: SnapshotStore;
  world: World;
  seed: number;
  actionLog: PlayerAction[] = [];
  selected: string | null = null;
  private down = false;
  // Drag mode for the CURRENT pressed gesture: "pan" (right / shift / space), "orbit" (left past the
  // click threshold), or "click" (left, still under the threshold → resolves to a pick on pointer-up).
  private drag: "pan" | "orbit" | "click" = "click";
  private spacePan = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private moveRange = new Set<string>();
  // Signature of each device's render-relevant authority, used to spark/smoke a device as its state
  // changes (presentation-only diff of authoritative device state; never read for rules).
  private prevDev = new Map<string, string>();
  private stateListeners = new Set<(g: TacticalGame) => void>();
  // Presentation-only hover state: the piece currently highlighted by the cursor (any side) and the
  // last action's per-unit travelled-tile paths (authoritative, for tests). Never a rule source.
  private hovered: string | null = null;
  private lastMovePaths = new Map<string, string[]>();
  // Ability-targeting presentation state (presentation-only; never feeds rules back).
  // - `preview` = the legal-target set currently shown because an ability is being HOVERED.
  // - `armed` = a targeted ability that has been CLICKED and is awaiting a target click. When set,
  //   its highlight persists and the next click on a highlighted target fires the ability.
  // Both hold an independently computed legal set (derived from sim state + the ability's range/kind).
  flightEnabled = true;
  preview: { unitId: string; ability: string; keys: string[]; kind: "units" | "devices" | "none" } | null = null;
  armed: { unitId: string; ability: string; keys: string[]; kind: "units" | "devices" | "none" } | null = null;
  // Running commentary: plain-language lines derived from the authoritative event stream, kept in
  // chronological order (newest pushed last). Presentation-only; never a rule source; no state is
  // read back from it. Capped so the scrollback is bounded but still lets a player read back.
  feed: { seq: number; text: string }[] = [];
  private feedSeq = 0;
  // Presentation-only clarity surfaces. `previewLine` is the projected outcome of the tile currently
  // under the cursor (derived from the shared sim so it can be checked against the delivered result);
  // `notice` is a visible explanation of a refusal or denied action. Neither is a rule source.
  previewLine: { kind: "attack" | "move" | "support" | "device"; tile: string; text: string } | null = null;
  private previewTileKey: string | null = null;
  notice: { seq: number; text: string } | null = null;
  private noticeSeq = 0;

  constructor(_container: HTMLElement, world: World, store: SnapshotStore, missionIndex: number, seed: number) {
    this.world = world;
    this.store = store;
    this.seed = seed;
    this.state = createInitialState(missionByIndex(missionIndex), seed);
    this.world.buildBoard(this.state.tiles, { hazard: [] });
    this.world.buildProps(this.state.devices, this.state.extraction);
    this.pushFeed("Squad inserted. Turn 1 — your move.");
    this.sync();
    this.attachInput();
  }

  private unitAt(x: number, y: number): UnitState | undefined {
    return this.state.units.find((u) => u.alive && u.pos.x === x && u.pos.y === y);
  }
  private selectedUnit(): UnitState | undefined {
    return this.selected ? this.state.units.find((u) => u.id === this.selected && u.alive) : undefined;
  }

  private snapshot(): Snapshot {
    const s = this.state;
    const sel = this.selectedUnit();
    return {
      revision: s.revision,
      phase: s.phase,
      turn: s.turn,
      mission: s.mission,
      missionName: missionByIndex(s.mission).name,
      selectedId: sel?.id ?? null,
      statusLine: s.log[s.log.length - 1] ?? "",
      log: s.log.slice(-6),
      objectives: s.objectives.map((o) => ({ id: o.id, label: o.label, status: o.status })),
      units: s.units.map((u) => ({ ...u, statuses: [...u.statuses] })),
      gameOver: s.gameOver,
      victory: s.victory,
      enemyBusy: false,
      feed: this.feed.slice(-160),
      pending: this.armed
        ? {
            ability: this.armed.ability,
            label: ABILITIES[this.armed.ability as keyof typeof ABILITIES]?.label ?? this.armed.ability,
            keys: [...this.armed.keys],
          }
        : null,
      preview: this.previewLine ? { ...this.previewLine } : null,
      notice: this.notice ? { seq: this.notice.seq, text: this.notice.text } : null,
    };
  }

  private hiddenEnemies(): Set<string> {
    const s = this.state;
    const hidden = new Set<string>();
    for (const u of s.units) {
      if (u.alive && u.side === "enemy" && s.vis[u.pos.y * 14 + u.pos.x] !== 2) hidden.add(u.id);
    }
    return hidden;
  }

  private sync() {
    // Fog + hidden-unit gating are presentation-only: the authoritative sim state is never
    // consulted by the renderer for rules, and nothing here mutates state.
    this.world.setFog(this.state.vis);
    this.world.syncProps(this.state.devices);
    this.world.syncUnits(this.state.units, { hidden: this.hiddenEnemies() });
    this.world.syncThreat(this.state.units);
    // Presentation-only reaction to AUTHORITATIVE state changes: a device that went dark/hijacked
    // sparks + smokes, and alarm escalation gets an in-world pulsing wash on the affected cluster.
    this.deviceFeedback();
    this.alarmFeedback();
    this.store.set(this.snapshot());
    for (const fn of this.stateListeners) fn(this);
  }

  // Spark + a brief sweep on a device whose authority just changed (hijacked/disabled). Driven from
  // the authoritative device list, positioned at the device's own tile — never a fixed marker.
  private deviceFeedback() {
    for (const d of this.state.devices) {
      const sig = `${d.powered ? 1 : 0}|${d.owner}|${d.disabled ? 1 : 0}`;
      const prev = this.prevDev.get(d.id);
      this.prevDev.set(d.id, sig);
      if (prev === undefined || prev === sig) continue;
      if (!d.powered || d.disabled || d.owner === "hijacked") {
        const p = { x: d.x, y: d.y, h: d.h };
        this.world.impact(p, d.owner === "hijacked" ? 0x25e0c0 : 0xff6a3a, 0.9);
        this.world.sweep(p, d.owner === "hijacked" ? 0x25e0c0 : 0xff6a3a);
      }
    }
  }

  // In-world legibility for the alert level: a pulsing alert wash centred on the cluster of enemies
  // that are currently aware (alertFocus if set, else the mean of alerted/suspicious enemies).
  private alarmFeedback() {
    if (this.state.alert <= 0) {
      this.world.setAlertWash(0, null);
      return;
    }
    if (this.state.alertFocus) {
      this.world.setAlertWash(this.state.alert, { x: this.state.alertFocus.x, y: this.state.alertFocus.y });
      return;
    }
    let sx = 0, sy = 0, n = 0;
    for (const u of this.state.units) {
      if (u.alive && u.side === "enemy" && (u.detState === "alerted" || u.detState === "suspicious")) {
        sx += u.pos.x; sy += u.pos.y; n++;
      }
    }
    if (n === 0) {
      this.world.setAlertWash(0, null);
      return;
    }
    this.world.setAlertWash(this.state.alert, { x: Math.round(sx / n), y: Math.round(sy / n) });
  }

  // Presentation-only change channel: fires after every sync() so the debug UI can recompute a
  // CURRENT-STATE view from authoritative state. Never a rule source; performs no state mutation.
  onStateChange(fn: (g: TacticalGame) => void): () => void {
    this.stateListeners.add(fn);
    return () => {
      this.stateListeners.delete(fn);
    };
  }

  // Deterministic test hook: re-paint presentation + emit a change notification from the CURRENT
  // state without performing any game action (proves the debug preview is transition-driven, not
  // timer-driven). Presentation only; no rules, no mutation.
  debugRefresh() {
    this.sync();
  }

  // Build last-move trails from the AUTHORITATIVE move-event stream. Each "move" event carries the
  // real travelled tiles (path); we REPLACE that unit's trail (never append), so a piece keeps only
  // its most recent move's trail, separate per piece, and it never accumulates across turns. Reads
  // only event data; mutates no state. Presentation-only.
  private recordMoveHistory(events: { kind: string; data: Record<string, unknown> }[]) {
    const paths = new Map<string, string[]>();
    for (const e of events) {
      if (e.kind !== "move") continue;
      const unitId = e.data.unitId as string | undefined;
      const path = e.data.path as { x: number; y: number }[] | undefined;
      if (!unitId || !path || path.length === 0) continue;
      const tiles = path.map((p) => ({ x: p.x, y: p.y }));
      this.world.setTrail(unitId, tiles);
      paths.set(unitId, tiles.map((t) => `${t.x},${t.y}`));
    }
    this.lastMovePaths = paths;
  }

  // Compute a piece's max-move highlight from authoritative state and paint it (outline + range).
  // Uses the same reachableCells rule the pointer path uses, so the highlight equals the reachable
  // set. Works for either side (enemies included). Presentation-only; no state mutation.
  private applyHover(unitId: string) {
    const unit = this.state.units.find((u) => u.id === unitId && u.alive);
    if (!unit) {
      this.world.clearHover();
      return;
    }
    const reach = reachableCells(this.state, unit);
    const keys: string[] = [];
    for (const k of reach.keys()) {
      const [xs, ys] = k.split(",");
      if (Number(xs) === unit.pos.x && Number(ys) === unit.pos.y) continue; // its own tile is not a target
      keys.push(k);
    }
    const at = this.world.tileToWorld({ x: unit.pos.x, y: unit.pos.y, h: unit.pos.h });
    this.world.setHover(unit.id, { x: at.x, y: at.y, z: at.z }, keys);
  }

private act(action: PlayerAction) {
    const before = this.state;
    // A committed action supersedes any pending preview/arming highlight (presentation-only).
    this.clearAbilityHighlight();
    const res = applyAction(this.state, action);
    if (res.error) {
      playSfx("deny");
      return;
    }
    this.state = res.state;
    this.actionLog.push(action);
    this.feedForPlayerAction(action, res.events, before);
    this.feedObjectives(before);
    // Last-move trail history is drawn from the AUTHORITATIVE event stream (covers player moves and
    // the enemy phase in one place). Replace-only, per piece. Hover highlight is stale once the
    // board changes, so clear it here (a fresh pointermove / debugHover re-establishes it).
    this.recordMoveHistory(res.events);
    this.world.clearHover();
    this.hovered = null;
    if (action.kind === "move") this.world.beginMove(action.unitId, action.path);
    // Recoil/flare pose on the shooter for a directed attack. The FLIGHT PATH itself is driven from
    // the authoritative event stream below (replayVfx -> "shot"), NOT a parallel inline effect, so
    // the same geometry-driven path renders for player AND enemy fire. Rules are never read here.
    if (action.kind === "attack") {
      const attacker = this.state.units.find((u) => u.id === action.unitId);
      if (attacker) this.world.pose(action.unitId, "fire");
    }
    // Presentation-only reaction to the AUTHORITATIVE event stream (rules untouched): shots become a
    // travelling flight path, hits scale their burst, deaths a restrained dissipate, and ability/hack
    // events drive EMP / shimmer / sweep / device sparks.
    this.replayVfx(res.events);
    this.world.clearMarkers();
    this.select(this.selected); // refresh markers for the surviving/active unit
    this.sync();
  }

  // Drop the preview/armed ability-target highlight (presentation-only). Clears nothing in rules.
  private clearAbilityHighlight(): void {
    this.preview = null;
    this.armed = null;
    this.previewLine = null;
    this.previewTileKey = null;
    this.world.clearAbilityTargets();
  }

  // Set a visible, non-audio explanation of the most recent refusal / denial. Presentation only.
  private setNotice(text: string): void {
    this.notice = { seq: this.noticeSeq++, text };
  }

  // Drive combat/ability/device VFX from the authoritative event stream + real tile geometry. Reads
  // only identities and positions; never re-derives or mutates rules.
  private replayVfx(events: { kind: string; data: Record<string, unknown> }[]) {
    const S = this.state;
    for (const e of events) {
      if (e.kind === "shot") {
        // A travelling projectile for ANY ranged shot, from the authoritative shooter->target tiles.
        // Works for both sides; reduced-motion resolves instantly inside World.flight (no travel).
        const from = e.data.from as number[];
        const to = e.data.to as number[];
        if (from && to) {
          this.world.flight({ x: from[0], y: from[1], h: 0 }, { x: to[0], y: to[1], h: 0 });
          playSfx("shot");
        }
      } else if (e.kind === "damage") {
        const id = (e.data.unitId as string) ?? undefined;
        const amount = (e.data.amount as number) ?? 1;
        const u = S.units.find((x) => x.id === id);
        if (u) this.world.impact({ ...u.pos }, 0xff5577, Math.max(0.6, Math.min(1.6, amount / 5)));
        if (id) this.world.pose(id, "hit");
        playSfx("hit");
      } else if (e.kind === "reaction") {
        const by = S.units.find((x) => x.id === (e.data.by as string));
        const on = S.units.find((x) => x.id === (e.data.on as string));
        if (by && on) { this.world.flight({ ...by.pos }, { ...on.pos }, 0xff9a3c); playSfx("shot"); }
      } else if (e.kind === "turret_fire") {
        const dev = S.devices.find((x) => x.id === (e.data.deviceId as string));
        const on = S.units.find((x) => x.id === (e.data.target as string));
        if (dev && on) { this.world.flight({ x: dev.x, y: dev.y, h: 0 }, { ...on.pos }, 0xff9a3c); playSfx("shot"); }
      } else if (e.kind === "death") {
        const u = S.units.find((x) => x.id === (e.data.unitId as string));
        if (u) this.world.neutralize({ ...u.pos });
        playSfx("kill");
      } else if (e.kind === "emp") {
        const at = e.data.at as { x: number; y: number } | undefined;
        if (at) this.world.empRing({ x: at.x, y: at.y, h: 0 });
      } else if (e.kind === "cloak") {
        const u = S.units.find((x) => x.id === (e.data.unitId as string));
        if (u) this.world.shimmer({ ...u.pos });
      } else if (e.kind === "barrier" || e.kind === "overwatch") {
        const u = S.units.find((x) => x.id === (e.data.unitId as string));
        if (u) this.world.sweep({ ...u.pos }, 0x7fd8ff);
      } else if (e.kind === "hack") {
        const dev = S.devices.find((x) => x.id === (e.data.deviceId as string));
        if (dev) this.world.impact({ x: dev.x, y: dev.y, h: 0 }, dev.owner === "hijacked" ? 0x25e0c0 : 0xff6a3a, 0.8);
      } else if (e.kind === "dest_destroyed") {
        const d = S.destructibles.find((x) => x.id === (e.data.destId as string));
        if (d) this.world.coverHit({ x: d.x, y: d.y, h: 0 }, 0xff8a4a);
      }
    }
  }

  // A shot that reached no unit sprays the first intervening sight-blocking / half-cover tile; if
  // the line is open it sprays the deck at the target. Positions come from real tiles.
  private deckOrCoverImpact(from: Position, to: Position) {
    const cell = this.coverCellBetween(from, to);
    if (cell) this.world.coverHit({ x: cell.x, y: cell.y, h: 0 }, 0xbfe9ff);
    else this.world.coverHit({ ...to }, 0x9fb4c8);
  }

  // Presentation-only supercover scan between two tiles; returns the first cover/sight blocker
  // closest to the target (mirrors the sim's own cover walk). Reads tiles, changes nothing.
  private coverCellBetween(from: Position, to: Position): { x: number; y: number } | null {
    const cells = this.lineCells(from, to);
    const inner = cells.slice(1, cells.length - 1);
    for (let i = inner.length - 1; i >= 0; i--) {
      const c = inner[i];
      if (c.x < 0 || c.y < 0 || c.x >= 14 || c.y >= 14) continue;
      const t = this.state.tiles[c.y * 14 + c.x];
      if (!t) continue;
      if (t.blocksSight || t.terrain === "crate" || t.terrain === "hazard" || t.terrain === "wall" || t.terrain === "pillar") {
        return { x: c.x, y: c.y };
      }
    }
    return null;
  }

  private lineCells(from: Position, to: Position): Position[] {
    const cells: Position[] = [];
    let x0 = from.x;
    let y0 = from.y;
    const x1 = to.x;
    const y1 = to.y;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let guard = (dx + dy + 2) * 4;
    let lastKey = "";
    while (guard-- > 0) {
      const e2 = 2 * err;
      cells.push({ x: x0, y: y0, h: 0 });
      if (x0 === x1 && y0 === y1) break;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
      const k = `${x0},${y0}`;
      if (k === lastKey) continue;
      lastKey = k;
    }
    return cells;
  }

  // Deterministic presentation-only seam for the ENV vision evidence: runs the SAME fire/impact
  // pipeline combat uses for an arbitrary real line, so the test can assert geometry-driven effects
  // (tracer on the line / impact on cover) without depending on RNG. No state change, no rules.
  debugFireLine(from: Position, to: Position) {
    this.world.fire({ ...from }, { ...to });
    this.deckOrCoverImpact(from, to);
  }

  // ---- selection / markers ----
  select(id: string | null) {
    // Changing (or dropping) the selection cancels any armed ability + pending target preview, so the
    // armed highlight never bleeds across a new selection ("cancel by selecting something else").
    this.clearAbilityHighlight();
    this.selected = id && this.state.units.find((u) => u.id === id && u.alive && u.side === "player") ? id : null;
    this.world.clearMarkers();
    if (this.selected) {
      const u = this.selectedUnit()!;
      this.world.showSelection({ ...u.pos });
      const reach = reachableCells(this.state, u);
      this.moveRange = new Set(reach.keys());
      this.world.showRange(this.moveRange, 0x2bd7ff);
      playSfx("select");
      // Robotic voice line, distinct per operative, keyed on the unit's LIVE name (not a lookup).
      playVoice(u.name);
    } else {
      this.moveRange = new Set();
    }
    this.sync();
  }

  // ---- input ----
  private attachInput() {
    const el = this.world.renderer.domElement;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointermove", this.onMove);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);
  }

  detachInput() {
    const el = this.world.renderer.domElement;
    el.removeEventListener("contextmenu", (e) => e.preventDefault());
    el.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  private onDown = (e: PointerEvent) => {
    this.down = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    // Right-drag / Shift-drag / Space-drag pan; a plain left-drag is a candidate orbit (and a plain
    // left press+release is a click, decided on pointer-up). NO pick fires on pointer-DOWN, so a
    // left-drag cannot also select/move/attack.
    this.drag = e.button === 2 || e.shiftKey || this.spacePan ? "pan" : "click";
  };

  private onUp = (e: PointerEvent) => {
    // A left gesture that never crossed the drag threshold is a genuine click → do the pick HERE
    // (using the release position) instead of on pointer-down. A drag (orbit) never picks.
    if (this.drag === "click") this.onClick(e.clientX, e.clientY);
    this.down = false;
    this.drag = "click";
  };

  private onMove = (e: PointerEvent) => {
    if (this.down) {
      if (this.drag === "click") {
        // Under the threshold → still a potential click (no orbit). Past it → become a continuous orbit.
        if (Math.abs(e.clientX - this.startX) + Math.abs(e.clientY - this.startY) < CLICK_DRAG_PX) return;
        this.drag = "orbit";
      }
      const px = this.lastX;
      const py = this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      const dx = e.clientX - px;
      const dy = e.clientY - py;
      if (this.drag === "pan") {
        // Screen-space pan: right-drag slides the world screen-right, down-drag slides it screen-down,
        // at every orbit angle (the shared view-relative basis in World.pan).
        const f = 0.02 * this.world.zoom;
        this.world.pan(dx * f, dy * f);
        return;
      }
      // Left-drag grab-to-rotate: yaw the board about the screen-centre pivot by the pointer's CHANGE OF
      // ANGLE about that pivot (atan2), so the grabbed point follows the cursor. Both axes matter — a
      // vertical drag across the pin rotates, while a straight pass THROUGH the pin is degenerate (both
      // endpoints within GRAB_PIVOT_DEGEN px of the pivot) and is treated as a no-op. Sign/gain tuned so
      // the subject's angular change matches the pointer's in sign and is close in magnitude.
      const rect = this.world.renderer.domElement.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const r0 = Math.hypot(px - cx, py - cy);
      const r1 = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (r0 >= GRAB_PIVOT_DEGEN && r1 >= GRAB_PIVOT_DEGEN) {
        const a0 = Math.atan2(py - cy, px - cx);
        const a1 = Math.atan2(e.clientY - cy, e.clientX - cx);
        let dAng = a1 - a0;
        if (dAng > Math.PI) dAng -= Math.PI * 2;
        else if (dAng < -Math.PI) dAng += Math.PI * 2;
        // 4 quarter-turns span 2π, so quarter-turns per radian is 2/π.
        this.world.orbitBy(GRAB_ROT_SIGN * (dAng * (2 / Math.PI)) * GRAB_ROT_GAIN);
      }
      return;
    }
    // Not dragging → this is a hover. Highlight the piece (any side) under the cursor so the board
    // reads as selectable / a threat, and show its max move range. Recompute only when the hovered
    // piece changes (cheap + stable); clears when the cursor leaves a piece.
    const tile = this.world.pickAt(e.clientX, e.clientY);
    const unit = tile ? this.state.units.find((u) => u.alive && u.pos.x === tile.x && u.pos.y === tile.y) : undefined;
    const id = unit ? unit.id : null;
    if (id !== this.hovered) {
      this.hovered = id;
      if (unit) this.applyHover(unit.id);
      else this.world.clearHover();
    }
    // Also derive an OUTCOME preview for the hovered tile (armed target or reachable move) so the
    // player sees what the action will do BEFORE committing. Recomputed only when the tile changes.
    this.updateHoverPreview(tile);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.world.zoomBy(e.deltaY > 0 ? 0.08 : -0.08);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    switch (e.key.toLowerCase()) {
      case "q":
        this.world.rotateQuarter(-1);
        break;
      case "e":
        this.world.rotateQuarter(1);
        break;
      case "r":
        this.world.setAngle(0);
        this.world.zoom = 1;
        this.world.focus.set(0, 0, 0);
        break;
      case "tab":
        e.preventDefault();
        this.cycleUnit();
        break;
      case "escape":
        this.select(null);
        break;
      case "enter":
        this.endTurn();
        break;
      case " ":
        e.preventDefault();
        this.spacePan = true; // hold Space (+ left-drag) to pan; released in onKeyUp
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") this.spacePan = false;
  };

  cycleUnit() {
    const alive = this.state.units.filter((u) => u.alive && u.side === "player");
    if (alive.length === 0) return;
    const idx = alive.findIndex((u) => u.id === this.selected);
    const next = alive[(idx + 1) % alive.length];
    this.select(next.id);
    // Framing contract: selecting a unit must NOT retarget the camera onto that unit. The old
    // focusTile lurch dropped the playfield to a corner and left roughly half the frame as empty
    // backdrop. The selected operative is communicated by its reticle + HUD card + a guidance toast,
    // so the camera keeps the whole board centred and dominant.
  }

  private onClick(clientX: number, clientY: number) {
    if (this.state.phase !== "player" || this.state.gameOver) return;
    const tile = this.world.pickAt(clientX, clientY);
    if (!tile) return;
    this.clickAtTile(tile);
  }

  // The tile-level resolution of a board click, shared by the pointer path and the deterministic test
  // hook. An armed ability resolves on a highlighted target and cancels on any other click.
  private clickAtTile(tile: { x: number; y: number }): void {
    if (this.state.phase !== "player" || this.state.gameOver) return;
    const key = posKey({ x: tile.x, y: tile.y, h: 0 });
    if (this.armed) {
      if (!this.armed.keys.includes(key)) {
        this.cancelArmed();
        return;
      }
      this.fireArmed(tile);
      return;
    }
    const enemy = this.unitAt(tile.x, tile.y);
    const sel = this.selectedUnit();
    if (sel) {
      if (enemy && enemy.side === "enemy") {
        this.tryAttack(sel.id, enemy);
        return;
      }
      const moveKey = posKey({ x: tile.x, y: tile.y, h: 0 });
      if (!enemy && this.moveRange.has(moveKey)) {
        this.tryMove(sel, tile);
        return;
      }
    }
    const ally = this.unitAt(tile.x, tile.y);
    if (ally && ally.side === "player") {
      this.select(ally.id);
    } else {
      this.select(null);
    }
  }

  // Deterministic hook: resolve a board click at a tile exactly as the pointer path would.
  debugClickTile(x: number, y: number) {
    this.clickAtTile({ x, y });
  }

  // ---- FLIGHT test readouts (presentation-only; never a rule source) -------------------------
  // The live projectiles with their world head positions + the real source/target tiles, so the spec
  // can project screen positions across frames and derive start/end/impact from camera geometry.
  debugProjectiles() {
    return this.world.debugProjectiles();
  }

  // Presentation-only: run the SAME event->flight pipeline combat uses for an arbitrary real line
  // (e.g. an enemy->player shot), so the spec proves the flight path is wired for BOTH sides without
  // depending on RNG. Feeds the identical replayVfx path a real shot event would, no state change.
  debugShotLine(from: { x: number; y: number }, to: { x: number; y: number }) {
    this.replayVfx([{ kind: "shot", data: { from: [from.x, from.y], to: [to.x, to.y] } }]);
  }

  // Resolve the armed ability on a highlighted target tile. Dispatches through the SAME action path a
  // keyboard/HUD action would, so the browser journey exercises the authoritative simulation.
  private fireArmed(tile: { x: number; y: number }): void {
    const armed = this.armed;
    if (!armed) return;
    const def = ABILITIES[armed.ability as keyof typeof ABILITIES];
    const target = this.state.units.find((u) => u.alive && u.pos.x === tile.x && u.pos.y === tile.y);
    this.clearAbilityHighlight();
    if (def && def.kind === "attack") {
      if (target) {
        this.act({ kind: "attack", unitId: armed.unitId, ability: armed.ability as AbilityId, targetUnitId: target.id });
      } else {
        this.act({ kind: "attack", unitId: armed.unitId, ability: armed.ability as AbilityId, targetPos: { x: tile.x, y: tile.y, h: 0 } });
      }
    } else if (target) {
      this.act({ kind: "ability", unitId: armed.unitId, ability: armed.ability as AbilityId, targetUnitId: target.id });
    } else {
      this.act({ kind: "ability", unitId: armed.unitId, ability: armed.ability as AbilityId, targetPos: { x: tile.x, y: tile.y, h: 0 } });
    }
  }

  // preview is computed from the same pure function the sim uses, so it equals the result.
  previewTarget(targetId: string) {
    const sel = this.selectedUnit();
    if (!sel) return null;
    return previewAttack(this.state, sel.id, sel.defaultAttack, targetId);
  }

  private tryMove(unit: UnitState, tile: { x: number; y: number }) {
    const reach = reachableCells(this.state, unit);
    const key = posKey({ x: tile.x, y: tile.y, h: 0 });
    if (!reach.has(key)) return;
    const path = reconstructPathFromReach(reach, key);
    if (path.length === 0) return;
    playSfx("move");
    this.act({ kind: "move", unitId: unit.id, path });
  }

  private tryAttack(attackerId: string, target: UnitState) {
    const attacker = this.state.units.find((u) => u.id === attackerId);
    if (!attacker) return;
    const pv = previewAttack(this.state, attackerId, attacker.defaultAttack, target.id);
    if (!pv.valid) {
      const why = pv.reason === "out_of_range" ? "out of range" : pv.reason === "no_los" ? "no line of sight" : "cannot shoot there";
      this.setNotice(`Cannot shoot ${target.name}: ${why}.`);
      playSfx("deny");
      this.sync();
      return;
    }
    this.act({ kind: "attack", unitId: attackerId, ability: attacker.defaultAttack, targetUnitId: target.id });
  }

  // Presentation-only hover preview for an ability button (index into the selected unit's abilities).
  // Hovering shows the authoritative legal target set for that ability; unhover clears it. An ARMED
  // highlight is never overwritten by a plain hover (arming persists until used or cancelled).
  hoverAbility(i: number) {
    if (this.armed) return; // an armed highlight persists until used or cancelled; a plain hover never wipes it
    const sel = this.selectedUnit();
    if (!sel || this.state.phase !== "player") return;
    const ability = sel.abilities[i];
    if (!ability) return;
    const t = legalTargetsFor(this.state, sel, ability);
    this.preview = { unitId: sel.id, ability, keys: t.keys, kind: t.kind };
    this.world.setAbilityTargets(t.keys);
  }

  unhoverAbility() {
    if (this.armed) return;
    this.preview = null;
    this.world.clearAbilityTargets();
  }

  // Derive the hovered-tile outcome preview from the AUTHORITATIVE sim (previewAttack / reach), so the
  // shown promise equals the delivered result. Presentation only; mutates nothing. Fires on every
  // non-drag pointermove but recomputes only when the hovered tile changes.
  private updateHoverPreview(tile: { x: number; y: number } | null): void {
    const key = tile ? `${tile.x},${tile.y}` : null;
    if (key === this.previewTileKey) return;
    this.previewTileKey = key;
    const hadLine = this.previewLine !== null;
    let line: { kind: "attack" | "move" | "support" | "device"; tile: string; text: string } | null = null;
    if (tile && key && this.state.phase === "player" && !this.state.gameOver) {
      if (this.armed) {
        if (this.armed.keys.includes(key)) line = this.describeTargetPreview(tile, key);
      } else {
        const sel = this.selectedUnit();
        if (sel && this.moveRange.has(key)) line = this.describeMovePreview(sel, tile, key);
      }
    }
    if (line === null && !hadLine) return;
    this.previewLine = line;
    this.sync();
  }

  private describeTargetPreview(
    tile: { x: number; y: number },
    key: string,
  ): { kind: "attack" | "move" | "support" | "device"; tile: string; text: string } | null {
    const armed = this.armed;
    if (!armed) return null;
    const shooter = this.state.units.find((u) => u.id === armed.unitId && u.alive);
    if (!shooter) return null;
    const def = ABILITIES[armed.ability as keyof typeof ABILITIES];
    const cost = def?.cost ?? 0;
    const energyLeft = Math.max(0, shooter.energy - cost);
    if (armed.kind === "devices") {
      const dev = this.state.devices.find((d) => d.x === tile.x && d.y === tile.y);
      if (dev) return { kind: "device", tile: key, text: `Disable ${deviceKindName(dev.kind)} here · ${cost}E (${energyLeft} left).` };
      return { kind: "device", tile: key, text: `Area effect here · ${cost}E (${energyLeft} left).` };
    }
    const unitHere = this.state.units.find((u) => u.alive && u.pos.x === tile.x && u.pos.y === tile.y);
    if (!unitHere) return null;
    if (unitHere.side !== "enemy") {
      return { kind: "support", tile: key, text: `Shield ${unitHere.name} · ${cost}E (${energyLeft} left).` };
    }
    const pv = previewAttack(this.state, armed.unitId, armed.ability, unitHere.id);
    if (!pv.valid) return null;
    if (armed.ability === "takedown") {
      return { kind: "attack", tile: key, text: `Silent takedown — neutralises ${unitHere.name}. Cost ${cost}E (${energyLeft} left).` };
    }
    const hpAfter = Math.max(0, unitHere.hp - pv.finalDamage);
    const shield = pv.shielded > 0 ? ` Shield absorbs ${pv.shielded}.` : "";
    const lethal = pv.lethal ? " Lethal." : "";
    return {
      kind: "attack",
      tile: key,
      text: `Shot ${unitHere.name} — ${pv.finalDamage} damage, HP ${unitHere.hp} → ${hpAfter}. Energy ${cost} (${energyLeft} left).${shield}${lethal}`,
    };
  }

  private describeMovePreview(
    sel: UnitState,
    tile: { x: number; y: number },
    key: string,
  ): { kind: "move"; tile: string; text: string } | null {
    const reach = reachableCells(this.state, sel);
    const info = reach.get(key);
    if (!info) return null;
    const path = reconstructPathFromReach(reach, key);
    if (path.length === 0) return null;
    const left = Math.max(0, sel.moveLeft - info.cost);
    const cover = this.coverCellBetween(sel.pos, { x: tile.x, y: tile.y, h: 0 });
    const note = cover ? " Likely cover at the stop." : " Open ground.";
    return { kind: "move", tile: key, text: `Move to (${tile.x},${tile.y}) — cost ${info.cost} move, ${left} left. May draw reaction fire.${note}` };
  }

  abilityByIndex(i: number) {
    const sel = this.selectedUnit();
    if (!sel || this.state.phase !== "player" || this.state.gameOver) return;
    const ability = sel.abilities[i];
    if (!ability) return;
    const label = ABILITIES[ability as keyof typeof ABILITIES]?.label ?? ability;
    // Re-clicking the already-armed ability cancels the arm.
    if (this.armed && this.armed.ability === ability) {
      this.cancelArmed();
      return;
    }
    // Self / support abilities that need no target click still act immediately.
    if (ability === "cloak" || ability === "barrier" || ability === "overwatch") {
      playSfx("click");
      this.act({ kind: "ability", unitId: sel.id, ability });
      return;
    }
    // A targeted ability: ARM it. The legal target set stays highlighted; the next click on a
    // highlighted target fires it, or Cancel/Esc (or selecting something else) cancels the arm.
    const t = legalTargetsFor(this.state, sel, ability);
    if (t.keys.length === 0) {
      this.setNotice(`No targets in range for ${label}.`);
      playSfx("deny");
      this.sync();
      return;
    }
    this.armed = { unitId: sel.id, ability, keys: t.keys, kind: t.kind };
    this.preview = null;
    this.previewLine = null;
    this.previewTileKey = null;
    this.world.setAbilityTargets(t.keys, 0xff3a2c);
    playSfx("click");
    this.sync(); // re-render so the pending-action state is VISIBLE the moment the ability is armed
  }

  cancelArmed(): void {
    if (!this.armed) return;
    const label = ABILITIES[this.armed.ability as keyof typeof ABILITIES]?.label ?? this.armed.ability;
    playSfx("deny");
    this.clearAbilityHighlight();
    this.setNotice(`Cancelled ${label}.`);
    this.sync();
  }

  // Deterministic test hooks (drive the SAME hover/arm path a real pointer/HUD interaction uses).
  debugHoverAbility(i: number) { this.hoverAbility(i); }
  debugUnhoverAbility() { this.unhoverAbility(); }
  debugArmAbility(i: number) { this.abilityByIndex(i); }
  debugArmed(): { ability: string; keys: string[] } | null {
    return this.armed ? { ability: this.armed.ability, keys: [...this.armed.keys] } : null;
  }

  // Deterministic test hook: paint a preview of an ability's legal target set WITHOUT mutating rules,
  // from an arbitrary attacker + ability, so the TARGETS spec can compare the render against a set it
  // computed independently. Presentation-only.
  debugPreviewTargets(unitId: string, ability: string) {
    const unit = this.state.units.find((u) => u.id === unitId && u.alive);
    if (!unit) return [];
    const t = legalTargetsFor(this.state, unit, ability);
    this.preview = { unitId, ability, keys: t.keys, kind: t.kind };
    this.world.setAbilityTargets(t.keys);
    return t.keys;
  }

  debugClearPreview() {
    this.clearAbilityHighlight();
  }

  endTurn() {
    if (this.state.phase !== "player" || this.state.gameOver) return;
    const beforeState = this.state;
    this.select(null);
    const snap = this.snapshot();
    this.store.set({ ...snap, enemyBusy: true });
    // The entire enemy phase resolves inside one deterministic sim call (no async phase to stall).
    const turnNo = this.state.turn;
    this.pushFeed(`Enemy phase (Turn ${turnNo}).`);
    const res = applyAction(this.state, { kind: "endTurn" });
    this.state = res.state;
    this.actionLog.push({ kind: "endTurn" });
    this.feedForEnemyPhase(res.events, res.state);
    this.feedObjectives(beforeState);
    // The whole enemy phase resolves in the one applyAction above; build every moving enemy's
    // last-move trail from the same authoritative event stream, then drop the stale hover highlight.
    this.recordMoveHistory(res.events);
    this.world.clearHover();
    this.hovered = null;
    this.replayVfx(res.events.slice(0, 80));
    playSfx("click");
    this.sync();
  }

  // ---- camera + action affordances for mouse-only play (keyboard shortcuts are kept too) ----
  rotateCam(dir: number) {
    this.world.rotateQuarter(dir);
  }

  resetCam() {
    this.world.setAngle(0);
    this.world.zoom = 1;
    this.world.focus.set(0, 0, 0);
  }

  zoomCam(delta: number) {
    this.world.zoomBy(delta);
  }

  panCam(dx: number, dy: number) {
    this.world.pan(dx, dy);
  }

  cancelAction() {
    this.select(null);
  }

  // ---- running commentary feed (plain language, derived from the authoritative event stream) ----
  private unitName(state: GameState, id?: string): string {
    const u = state.units.find((x) => x.id === id);
    return u ? u.name : "A unit";
  }

  private pushFeed(text: string) {
    this.feed.push({ seq: this.feedSeq++, text });
    if (this.feed.length > 200) this.feed.shift();
  }

  private feedForPlayerAction(action: PlayerAction, events: GameEvents[], before: GameState) {
    const S = this.state;
    const uid = (action as { unitId?: string }).unitId;
    const actor = S.units.find((u) => u.id === uid);
    const actorName = actor ? actor.name : "Operative";
    if (action.kind === "move") {
      this.pushFeed(`${actorName} moved.`);
      for (const e of events) {
        if (e.kind === "reaction") {
          this.pushFeed(`${this.unitName(S, e.data.by as string)} fired back at ${this.unitName(S, e.data.on as string)}.`);
        } else if (e.kind === "turret_fire") {
          this.pushFeed(`A turret fired at ${this.unitName(S, e.data.target as string)}.`);
        }
      }
    } else if (action.kind === "attack") {
      const targetId = action.targetUnitId;
      let hitFor = 0;
      for (const e of events) {
        if (e.kind === "damage" && (e.data.unitId as string) === targetId) hitFor += (e.data.amount as number) ?? 0;
      }
      this.pushFeed(`${actorName} shot at ${this.unitName(S, targetId)}. ${hitFor > 0 ? "Hit for " + hitFor + " damage." : "No effect."}`);
    } else if (action.kind === "ability") {
      this.pushFeed(`${actorName} used ${abilityWord(action.ability)}.`);
      for (const e of events) {
        if (e.kind === "hack") {
          const dev = S.devices.find((d) => d.id === (e.data.deviceId as string));
          if (dev) this.pushFeed(`${deviceWord(dev.kind)} disabled.`);
        }
      }
    }
    const aBefore = before.alert;
    const aAfter = S.alert;
    if (aAfter > aBefore) this.pushFeed("The alarm rises.");
    else if (aAfter < aBefore) this.pushFeed("The alarm eases.");
  }

  private feedForEnemyPhase(events: GameEvents[], after: GameState) {
    for (const e of events) {
      if (e.kind === "move") {
        this.pushFeed(`${this.unitName(after, e.data.unitId as string)} moved.`);
      } else if (e.kind === "damage") {
        const on = after.units.find((x) => x.id === (e.data.unitId as string));
        if (on && on.side === "player") {
          this.pushFeed(`${on.name} was hit for ${(e.data.amount as number) ?? 1}.`);
        }
      } else if (e.kind === "turret_fire") {
        this.pushFeed(`A turret fired at ${this.unitName(after, e.data.target as string)}.`);
      } else if (e.kind === "death") {
        this.pushFeed(`${this.unitName(after, e.data.unitId as string)} went down.`);
      }
    }
    this.pushFeed(`Your phase (Turn ${after.turn}).`);
  }

  // Player-facing objective-progress lines, derived by diffing the AUTHORITATIVE objective statuses
  // (and the victory flag) between the pre-action snapshot and the current state. Emitted whenever an
  // objective actually changes — a relay is captured, both relays are down (the Core opens), the Core
  // is breached (Extraction opens), or the squad reaches Extraction. Plain language only; presentation
  // channel; never a rule source and no state is read back from it.
  private feedObjectives(before: GameState) {
    const after = this.state;
    const isRelay = (id: string) => id === "relay_a" || id === "relay_b";
    const doneRelays = (s: GameState) => s.objectives.filter((o) => isRelay(o.id) && o.status === "done").length;
    const rBefore = doneRelays(before);
    const rAfter = doneRelays(after);
    if (rAfter > rBefore) {
      if (rAfter >= 2) {
        this.pushFeed("Both relays hacked — the Core is open.");
      } else {
        const newly = after.objectives.find(
          (o) => isRelay(o.id) && o.status === "done" && before.objectives.find((b) => b.id === o.id)?.status !== "done",
        );
        const name = newly ? newly.label : "A relay";
        this.pushFeed(`${name} hacked — ${rAfter} of 2 relays.`);
      }
    }
    const coreAfter = after.objectives.find((o) => o.id === "core");
    const coreBefore = before.objectives.find((o) => o.id === "core");
    if (coreAfter && coreAfter.status === "done" && (!coreBefore || coreBefore.status !== "done")) {
      this.pushFeed("Core breached — Extraction is open.");
    }
    if (after.victory && !before.victory) {
      this.pushFeed("Extraction reached — mission complete.");
    }
  }

  // ---- deterministic test/debug API (also used by the debug overlay) ----
  // These reuse the exact same action path as pointer input, so browser journeys exercise the
  // authoritative simulation, not a mock.

  debugSnapshot(): Snapshot {
    return this.snapshot();
  }

  debugSelect(id: string) {
    this.select(id);
  }

  debugMove(unitId: string, path: Position[]) {
    const unit = this.state.units.find((u) => u.id === unitId);
    if (!unit) return { ok: false, error: "no_unit" };
    playSfx("move");
    this.act({ kind: "move", unitId, path });
    return { ok: true };
  }

  // Test/sampling helper: choose the longest legal multi-step path a living player unit can take
  // right now, reconstructed from the same authoritative reach the pointer path uses. Does NOT move.
  debugFarthestPath(unitId: string): { ok: boolean; from?: Position; to?: Position; path?: Position[]; len?: number } {
    const unit = this.state.units.find((u) => u.id === unitId && u.alive);
    if (!unit) return { ok: false };
    const reach = reachableCells(this.state, unit);
    const fromKey = `${unit.pos.x},${unit.pos.y}`;
    let bestKey: string | null = null;
    let bestLen = 0;
    for (const k of reach.keys()) {
      if (k === fromKey) continue;
      const path = reconstructPathFromReach(reach, k);
      if (path.length > bestLen) {
        bestLen = path.length;
        bestKey = k;
      }
    }
    if (!bestKey || bestLen < 2) return { ok: false };
    const path = reconstructPathFromReach(reach, bestKey);
    const parts = bestKey.split(",");
    const to: Position = { x: Number(parts[0]), y: Number(parts[1]), h: 0 };
    return { ok: true, from: { ...unit.pos }, to, path, len: path.length };
  }

  debugAttack(unitId: string, targetId: string) {
    const target = this.state.units.find((u) => u.id === targetId);
    const attacker = this.state.units.find((u) => u.id === unitId);
    if (!target || !attacker) return { ok: false, error: "no_target" };
    const pv = previewAttack(this.state, unitId, attacker.defaultAttack, targetId);
    this.act({ kind: "attack", unitId, ability: attacker.defaultAttack, targetUnitId: targetId });
    return { ok: true, preview: pv };
  }

  debugAbility(unitId: string, ability: AbilityId) {
    const unit = this.state.units.find((u) => u.id === unitId);
    if (!unit) return { ok: false, error: "no_unit" };
    this.act({ kind: "ability", unitId, ability });
    return { ok: true };
  }

  debugPreview(unitId: string, targetId: string) {
    return previewAttack(this.state, unitId, this.state.units.find((u) => u.id === unitId)?.defaultAttack ?? "pulse_rifle", targetId);
  }

  debugSerialize(): string {
    return serializeGame(this.state);
  }

  debugLoad(text: string): boolean {
    const s = deserializeGame(text);
    if (!s) return false;
    this.state = s;
    this.world.buildBoard(this.state.tiles, { hazard: [] });
    this.world.buildProps(this.state.devices, this.state.extraction);
    this.sync();
    return true;
  }

  debugState() {
    return this.state;
  }

  // Test hooks: read/drive the presentation-only hover + trail state deterministically. debugHover
  // routes through the SAME applyHover path a live pointermove uses, so the specs exercise the real
  // hover code, not a mock. debugLastMovePaths exposes the authoritative travelled tiles from the
  // most recent action so the specs can verify the drawn trail WITHOUT trusting the renderer.
  debugHover(unitId: string | null) {
    if (!unitId) {
      this.hovered = null;
      this.world.clearHover();
      return;
    }
    const u = this.state.units.find((x) => x.id === unitId && x.alive);
    if (!u) {
      this.hovered = null;
      this.world.clearHover();
      return;
    }
    this.hovered = unitId;
    this.applyHover(unitId);
  }

  debugTrail(): Record<string, string[]> {
    return this.world.debugTrail();
  }

  debugLastMovePaths(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [k, v] of this.lastMovePaths) out[k] = v.slice();
    return out;
  }

  // Deterministic test hook used by Journey A: performs one greedy player action via the SAME
  // action path as a human, and reports whether preview damage equals applied damage.
  debugTryOneAction(): { kind: string; unitId: string; targetId?: string; previewFinal?: number; hpBefore?: number; hpAfter?: number; energyBefore?: number; energyAfter?: number; phase: string } {
    const before = this.state;
    const units = before.units.filter((u) => u.alive && u.side === "player");
    const enemies = before.units.filter((u) => u.alive && u.side === "enemy");
    for (const u of units) {
      for (const e of enemies) {
        if (u.energy < 3) continue;
        const pv = previewAttack(before, u.id, u.defaultAttack, e.id);
        if (pv.valid) {
          const res = applyAction(before, { kind: "attack", unitId: u.id, ability: u.defaultAttack, targetUnitId: e.id });
          const after = res.state.units.find((x) => x.id === e.id)!;
          this.state = res.state;
          this.sync();
          const afterU = res.state.units.find((x) => x.id === u.id)!;
          return { kind: "attack", unitId: u.id, targetId: e.id, previewFinal: pv.finalDamage, hpBefore: e.hp, hpAfter: after.hp, energyBefore: before.units.find((x) => x.id === u.id)!.energy, energyAfter: afterU.energy, phase: res.state.phase };
        }
      }
    }
    // no target yet: advance EVERY player unit one greedy step toward its nearest enemy, so the
    // distances collapse and a legal attack appears quickly. Still exercises pathfinding rules.
    let cur = before;
    let movedAny = false;
    for (const u0 of units) {
      const u = cur.units.find((x) => x.id === u0.id && x.alive);
      if (!u) continue;
      const nearest = cur.units
        .filter((e) => e.alive && e.side === "enemy")
        .sort((a, b) => Math.abs(a.pos.x - u.pos.x) + Math.abs(a.pos.y - u.pos.y) - (Math.abs(b.pos.x - u.pos.x) + Math.abs(b.pos.y - u.pos.y)))[0];
      if (!nearest) continue;
      const reach = reachableCells(cur, u);
      let bestKey: string | null = null;
      let best = Infinity;
      for (const [k, info] of reach) {
        const d = Math.max(Math.abs(info.pos.x - nearest.pos.x), Math.abs(info.pos.y - nearest.pos.y));
        if (d < best) {
          best = d;
          bestKey = k;
        }
      }
      if (!bestKey) continue;
      const path = reconstructPathFromReach(reach, bestKey);
      const mv = applyAction(cur, { kind: "move", unitId: u.id, path });
      if (!mv.error) {
        cur = mv.state;
        movedAny = true;
      }
    }
    this.state = cur;
    this.sync();
    return { kind: movedAny ? "move" : "wait", unitId: units[0]?.id ?? "", phase: cur.phase };
  }

  // Deterministic test hook: compute a full playthrough via the shared solver, then apply it to
  // the LIVE game through the same action path (not a mock). Reproducible for determinism tests.
  debugAutoPlay(): { victory: boolean; turn: number } {
    const { log } = autoSolve(this.state, 80);
    for (const a of log) {
      const r = applyAction(this.state, a);
      if (r.error) break;
      this.state = r.state;
      this.actionLog.push(a);
    }
    this.sync();
    return { victory: this.state.victory, turn: this.state.turn };
  }

  // Deterministic playthrough used by the COMMENTARY feed evidence: replays the shared solver's
  // action log through the SAME action path a human/pointer uses (act for move/attack/ability,
  // endTurn for the phase hand-off), so the running commentary — including objective-progress lines —
  // is populated from REAL transitions rather than a mock. The reducer trajectory is identical to a
  // headless replay of the same log; this only adds the presentation/feed side. No rule is read back.
  debugPlaythroughLogged(): { victory: boolean; turn: number; actions: number } {
    const { log } = autoSolve(this.state, 60);
    let n = 0;
    for (const a of log) {
      if (this.state.gameOver) break;
      if (a.kind === "endTurn") this.endTurn();
      else this.act(a as PlayerAction);
      n++;
    }
    return { victory: this.state.victory, turn: this.state.turn, actions: n };
  }

  debugReplay(log: PlayerAction[]): { ok: boolean; error?: string } {
    let s = this.state;
    for (const a of log) {
      if (s.gameOver) break;
      const r = applyAction(s, a);
      if (r.error) return { ok: false, error: r.error };
      s = r.state;
    }
    this.state = s;
    this.sync();
    return { ok: true };
  }
}

// Plain-language wording for the commentary feed. Keys are internal ids; the OUTPUT is always a
// player-facing phrase (no raw codes, no test ids), so it can never leak a developer marker.
function abilityWord(a: AbilityId): string {
  switch (a) {
    case "cloak":
      return "cloak";
    case "barrier":
      return "a barrier";
    case "overwatch":
      return "overwatch";
    case "arc_bolt":
      return "an arc bolt";
    case "remote_hack":
      return "a remote hack";
    case "emp":
      return "an EMP";
    case "takedown":
    case "backstab":
      return "a takedown";
    case "silenced_shot":
      return "a silenced shot";
    case "dash":
      return "a dash";
    case "blink":
      return "a blink";
    case "concussion":
      return "a concussion blast";
    default:
      return "an ability";
  }
}

function deviceWord(k: string): string {
  switch (k) {
    case "turret":
      return "Auto-Turret";
    case "camera":
      return "Camera";
    case "node":
      return "Security Node";
    case "core":
      return "Core";
    default:
      return "Relay Terminal";
  }
}
