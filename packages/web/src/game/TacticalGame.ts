import type { GameState, PlayerAction, Position, UnitState, AbilityId } from "@sb/sim";
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
} from "@sb/sim";
import { World } from "../scene/World.ts";
import { Store, type Snapshot } from "./serialize.ts";
import { playSfx } from "../audio.ts";

export type SnapshotStore = Store<Snapshot>;

function posKey(p: Position): string {
  return `${p.x},${p.y}`;
}

export class TacticalGame {
  state: GameState;
  store: SnapshotStore;
  world: World;
  seed: number;
  actionLog: PlayerAction[] = [];
  selected: string | null = null;
  private down = false;
  private panning = false;
  private lastX = 0;
  private lastY = 0;
  private moveRange = new Set<string>();
  // Signature of each device's render-relevant authority, used to spark/smoke a device as its state
  // changes (presentation-only diff of authoritative device state; never read for rules).
  private prevDev = new Map<string, string>();
  private stateListeners = new Set<(g: TacticalGame) => void>();

  constructor(_container: HTMLElement, world: World, store: SnapshotStore, missionIndex: number, seed: number) {
    this.world = world;
    this.store = store;
    this.seed = seed;
    this.state = createInitialState(missionByIndex(missionIndex), seed);
    this.world.buildBoard(this.state.tiles, { hazard: [] });
    this.world.buildProps(this.state.devices, this.state.extraction);
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

  private act(action: PlayerAction) {
    const res = applyAction(this.state, action);
    if (res.error) {
      playSfx("deny");
      return;
    }
    this.state = res.state;
    this.actionLog.push(action);
    // Weapon-fire VFX for a directed attack: muzzle at the shooter + a tracer on the REAL line
    // (shooter tile -> target tile), positioned from authoritative geometry. If the round reached no
    // unit it is treated as intercepted — it sprays the intervening cover/deck instead of a unit.
    if (action.kind === "attack") {
      const attacker = this.state.units.find((u) => u.id === action.unitId);
      const target = action.targetUnitId ? this.state.units.find((u) => u.id === action.targetUnitId) : undefined;
      playSfx("shot");
      if (attacker && target) {
        this.world.fire({ ...attacker.pos }, { ...target.pos });
        this.world.pose(target.id, "hit");
        const reached = res.events.some((e) => e.kind === "damage" && (e.data as { unitId?: string }).unitId === target.id);
        if (!reached) this.deckOrCoverImpact(attacker.pos, target.pos);
      } else if (attacker && action.targetPos) {
        this.world.fire({ ...attacker.pos }, { ...action.targetPos });
      }
      this.world.pose(action.unitId, "fire");
    }
    // Presentation-only reaction to the AUTHORITATIVE event stream (rules untouched): hits scale
    // their burst, reactions/turret fire get their own muzzle + tracer, deaths a restrained
    // dissipate, and ability/hack events drive EMP / shimmer / sweep / device sparks.
    this.replayVfx(res.events);
    this.world.clearMarkers();
    this.select(this.selected); // refresh markers for the surviving/active unit
    this.sync();
  }

  // Drive combat/ability/device VFX from the authoritative event stream + real tile geometry. Reads
  // only identities and positions; never re-derives or mutates rules.
  private replayVfx(events: { kind: string; data: Record<string, unknown> }[]) {
    const S = this.state;
    for (const e of events) {
      if (e.kind === "damage") {
        const id = (e.data.unitId as string) ?? undefined;
        const amount = (e.data.amount as number) ?? 1;
        const u = S.units.find((x) => x.id === id);
        if (u) this.world.impact({ ...u.pos }, 0xff5577, Math.max(0.6, Math.min(1.6, amount / 5)));
        if (id) this.world.pose(id, "hit");
        playSfx("hit");
      } else if (e.kind === "reaction") {
        const by = S.units.find((x) => x.id === (e.data.by as string));
        const on = S.units.find((x) => x.id === (e.data.on as string));
        if (by && on) { this.world.fire({ ...by.pos }, { ...on.pos }, 0xff9a3c); playSfx("shot"); }
      } else if (e.kind === "turret_fire") {
        const dev = S.devices.find((x) => x.id === (e.data.deviceId as string));
        const on = S.units.find((x) => x.id === (e.data.target as string));
        if (dev && on) { this.world.fire({ x: dev.x, y: dev.y, h: 0 }, { ...on.pos }, 0xff9a3c); playSfx("shot"); }
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
    this.selected = id && this.state.units.find((u) => u.id === id && u.alive && u.side === "player") ? id : null;
    this.world.clearMarkers();
    if (this.selected) {
      const u = this.selectedUnit()!;
      this.world.showSelection({ ...u.pos });
      const reach = reachableCells(this.state, u);
      this.moveRange = new Set(reach.keys());
      this.world.showRange(this.moveRange, 0x2bd7ff);
      playSfx("select");
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
  }

  detachInput() {
    const el = this.world.renderer.domElement;
    el.removeEventListener("contextmenu", (e) => e.preventDefault());
    el.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKey);
  }

  private onDown = (e: PointerEvent) => {
    this.down = true;
    this.panning = e.button === 2 || e.shiftKey;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (!this.panning) this.onClick(e.clientX, e.clientY);
  };

  private onUp = () => {
    this.down = false;
    this.panning = false;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.down || !this.panning) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const f = 0.02 * this.world.zoom;
    this.world.pan(-dx * f, -dy * f);
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
        this.panning = true;
        break;
    }
  };

  cycleUnit() {
    const alive = this.state.units.filter((u) => u.alive && u.side === "player");
    if (alive.length === 0) return;
    const idx = alive.findIndex((u) => u.id === this.selected);
    const next = alive[(idx + 1) % alive.length];
    this.select(next.id);
    this.world.focusTile(next.pos.x, next.pos.y);
  }

  private onClick(clientX: number, clientY: number) {
    if (this.state.phase !== "player" || this.state.gameOver) return;
    const tile = this.world.pickAt(clientX, clientY);
    if (!tile) return;
    const enemy = this.unitAt(tile.x, tile.y);
    const sel = this.selectedUnit();
    if (sel) {
      if (enemy && enemy.side === "enemy") {
        this.tryAttack(sel.id, enemy);
        return;
      }
      const key = posKey({ x: tile.x, y: tile.y, h: 0 });
      if (!enemy && this.moveRange.has(key)) {
        this.tryMove(sel, tile);
        return;
      }
    }
    const ally = this.unitAt(tile.x, tile.y);
    if (ally && ally.side === "player") {
      this.select(ally.id);
      this.world.focusTile(ally.pos.x, ally.pos.y);
    } else {
      this.select(null);
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
      playSfx("deny");
      return;
    }
    this.act({ kind: "attack", unitId: attackerId, ability: attacker.defaultAttack, targetUnitId: target.id });
  }

  abilityByIndex(i: number) {
    const sel = this.selectedUnit();
    if (!sel || this.state.phase !== "player" || this.state.gameOver) return;
    const ability = sel.abilities[i];
    if (!ability) return;
    if (ability === "cloak" || ability === "barrier" || ability === "overwatch") {
      playSfx("click");
      this.act({ kind: "ability", unitId: sel.id, ability });
      return;
    }
    // targeted abilities need a hovered/last target; default to self/no-op for the demo build
    playSfx("deny");
  }

  endTurn() {
    if (this.state.phase !== "player" || this.state.gameOver) return;
    this.select(null);
    const snap = this.snapshot();
    this.store.set({ ...snap, enemyBusy: true });
    // The entire enemy phase resolves inside one deterministic sim call (no async phase to stall).
    const res = applyAction(this.state, { kind: "endTurn" });
    this.state = res.state;
    this.actionLog.push({ kind: "endTurn" });
    this.replayVfx(res.events.slice(0, 80));
    playSfx("click");
    this.sync();
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
