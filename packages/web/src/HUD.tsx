import { useSyncExternalStore } from "react";
import { ui } from "./ui.ts";
import { ABILITIES } from "@sb/sim";

function useSnapshot() {
  return useSyncExternalStore(ui.store.subscribe, ui.store.get);
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="bar">
      <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function HUD() {
  const snap = useSnapshot();
  const game = ui.game;
  const sel = snap.selectedId ? snap.units.find((u) => u.id === snap.selectedId) : undefined;
  const playerUnits = snap.units.filter((u) => u.alive && u.side === "player");

  return (
    <div className="hud">
      <div className="hud-top">
        <div className="chip">{snap.missionName || `Mission ${snap.mission + 1}`}</div>
        {/* Phase: ▲ (player, upward triangle) vs ● (enemy, circle) — shape distinguishes
            them even when hue is indistinguishable (deuteranopia/protanopia). */}
        <div
          className={`chip phase ${snap.phase}`}
          data-testid="hud-phase"
          data-shape={snap.phase === "player" ? "up-triangle" : "circle"}
          aria-label={`${snap.phase === "player" ? "Player" : "Enemy"} phase`}
        >
          <span className="phase-shape" aria-hidden="true">{snap.phase === "player" ? "\u25B2" : "\u25CF"}</span>
          {snap.phase === "player" ? "PLAYER PHASE" : "ENEMY PHASE"}
        </div>
        <div className="chip" data-testid="hud-turn">TURN {snap.turn}</div>
        {snap.enemyBusy && <div className="chip busy">RESOLVING\u2026</div>}
      </div>

      <div className="hud-left">
        {sel ? (
          <div className="unit-card">
            <div className="unit-name">{sel.name}</div>
            <div className="row-label">HEALTH</div>
            <Bar value={sel.hp} max={sel.maxHp} color="#25e0c0" />
            <div className="row-label">ENERGY</div>
            <Bar value={sel.energy} max={sel.maxEnergy} color="#2bd7ff" />
            <div className="row-label">MOVE {sel.moveLeft}/{sel.maxMove}</div>
            <div className="abilities">
              {sel.abilities.map((a, i) => {
                const def = ABILITIES[a];
                const usable = game ? snap.phase === "player" && sel.energy >= def.cost : false;
                return (
                  <button
                    key={a}
                    className={`ability ${usable ? "" : "off"}`}
                    disabled={!usable}
                    onClick={() => game?.abilityByIndex(i)}
                    data-testid={`ability-${i}`}
                    title={def.desc}
                  >
                    <span className="ab-name">{def.label}</span>
                    <span className="ab-cost">{def.cost}E</span>
                  </button>
                );
              })}
            </div>
            <div className="hint">Tap an enemy to shoot · tap ground to move · Tab next unit · Enter End Turn</div>
          </div>
        ) : (
          <div className="unit-card">
            <div className="unit-name">No unit selected</div>
            <div className="hint">Click one of your operatives to begin.</div>
          </div>
        )}
      </div>

      <div className="hud-right">
        <div className="obj-title">OBJECTIVES</div>
        {snap.objectives.map((o) => (
          <div key={o.id} className={`obj ${o.status}`} data-testid={`obj-${o.id}`} data-state={o.status}>
            {/* Shape distinguishes state without colour alone:
                done=square+check, available=ring, locked=circle+cross */}
            <span
              className="obj-dot"
              data-shape={o.status === "done" ? "square" : o.status === "available" ? "ring" : "circle"}
              aria-hidden="true"
            />
            <span className="obj-label">{o.label}</span>
            <span className="obj-status" data-state={o.status}>{o.status === "done" ? "DONE" : o.status === "available" ? "ACTIVE" : "LOCKED"}</span>
          </div>
        ))}
        <div className="obj-title">SQUAD</div>
        {playerUnits.map((u) => (
          <div key={u.id} className="squad-row">
            <span className="squad-name">{u.name}</span>
            <Bar value={u.hp} max={u.maxHp} color={u.side === "player" ? "#25e0c0" : "#ff4d6d"} />
          </div>
        ))}
      </div>

      <div className="hud-bottom">
        <button className="btn primary" data-testid="end-turn" disabled={snap.phase !== "player"} onClick={() => game?.endTurn()}>
          End Turn (Enter)
        </button>
        <button className="btn" onClick={() => game?.cycleUnit()}>
          Next Operative (Tab)
        </button>
        <div className="cam-hint">Camera: drag to pan · wheel zoom · Q/E rotate · R reset</div>
      </div>
    </div>
  );
}
