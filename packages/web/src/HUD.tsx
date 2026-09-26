import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ui } from "./ui.ts";
import { ABILITIES } from "@sb/sim";
import { abilityCaption, abilityHint, enemyGuide, objectiveHint, objectivePlain } from "./guidance.ts";

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
  const relayTotal = snap.objectives.filter((o) => o.id === "relay_a" || o.id === "relay_b").length || 2;
  const relayDone = snap.objectives.filter((o) => (o.id === "relay_a" || o.id === "relay_b") && o.status === "done").length;
  const [tab, setTab] = useState<"commentary" | "objectives">("objectives");
  const feedRef = useRef<HTMLDivElement>(null);

  // Newest commentary stays visible; the player scrolls up to read back through the turn history.
  useEffect(() => {
    if (tab === "commentary" && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [tab, snap.feed]);

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
          data-hint={
            snap.phase === "player"
              ? "Your phase: move, shoot and spend energy, then press Enter to end the turn."
              : "Enemy phase: the squad holds while the security AI reacts to you. No inputs needed."
          }
        >
          <span className="phase-shape" aria-hidden="true">{snap.phase === "player" ? "\u25B2" : "\u25CF"}</span>
          {snap.phase === "player" ? "PLAYER PHASE" : "ENEMY PHASE"}
        </div>
        <div className="chip" data-testid="hud-turn" data-hint="Each turn every operative gets fresh moves and energy. End the turn to hand over to the enemy.">TURN {snap.turn}</div>
        {snap.enemyBusy && <div className="chip busy" data-hint="Resolving the enemy reaction step — wait for it to finish.">RESOLVING\u2026</div>}
      </div>

      <div className="hud-left">
        {sel ? (
          <div className="unit-card" data-testid="unit-card">
            <div className="unit-name" data-testid="unit-name">{sel.name}</div>
            <div className="row-label">HEALTH {sel.hp}/{sel.maxHp}</div>
            <Bar value={sel.hp} max={sel.maxHp} color="#25e0c0" />
            <div className="row-label">ENERGY {sel.energy}/{sel.maxEnergy}</div>
            <Bar value={sel.energy} max={sel.maxEnergy} color="#2bd7ff" />
            <div className="row-label" data-testid="turn-resource">
              Moves left {sel.moveLeft} of {sel.maxMove} · {sel.energy} energy to spend
            </div>
            <div className="abilities">
              {sel.abilities.map((a, i) => {
                const def = ABILITIES[a];
                const cap = abilityCaption(a);
                const usable = game ? snap.phase === "player" && sel.energy >= (def?.cost ?? 99) : false;
                const hint = abilityHint(a);
                return (
                  <button
                    key={a}
                    className={`ability ${usable ? "" : "off"}`}
                    disabled={!usable}
                    onClick={() => game?.abilityByIndex(i)}
                    onMouseEnter={() => game?.hoverAbility(i)}
                    onMouseLeave={() => game?.unhoverAbility()}
                    data-testid={`ability-${i}`}
                    data-hint={hint}
                    aria-label={`${cap.label}, ${cap.cost} energy, range ${cap.range}. ${def?.desc ?? ""}`}
                    title={hint}
                  >
                    <span className="ab-name">{cap.label}</span>
                    <span className="ab-sub">{cap.cost} · {cap.range}</span>
                  </button>
                );
              })}
            </div>
            <div className="hint">Tap a target to shoot · tap ground to move · click a squad row to switch · End Turn below.</div>
            {snap.pending && (
              <div className="action-bar pending" data-testid="pending-action" data-hint={snap.pending.label + " is armed — pick a highlighted target to commit it."}>
                <span className="ab-line" data-testid="pending-text">
                  {snap.pending.label} armed — pick a highlighted target to commit, or cancel.
                </span>
                <button className="btn small pending-cancel" data-testid="pending-cancel" onClick={() => game?.cancelArmed()}>
                  Cancel
                </button>
              </div>
            )}
            {snap.preview && (
              <div className="action-bar preview" data-testid="action-preview">
                <span className="ab-line" data-testid="preview-text">
                  {snap.preview.text}
                </span>
              </div>
            )}
            {snap.notice && (
              <div className="action-bar notice" data-testid="action-notice">
                <span className="ab-line" data-testid="notice-text">
                  {snap.notice.text}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="unit-card">
            <div className="unit-name">No unit selected</div>
            <div className="hint">Click one of your operatives — on the board or in the Squad list — to begin.</div>
          </div>
        )}
      </div>

      <div className="hud-right">
        <div className="tabbar" role="tablist" aria-label="Right panel" data-testid="right-tabs">
          <button
            role="tab"
            className={`tab ${tab === "commentary" ? "on" : ""}`}
            aria-selected={tab === "commentary"}
            data-testid="tab-commentary"
            onClick={() => setTab("commentary")}
          >
            Commentary
          </button>
          <button
            role="tab"
            className={`tab ${tab === "objectives" ? "on" : ""}`}
            aria-selected={tab === "objectives"}
            data-testid="tab-objectives"
            onClick={() => setTab("objectives")}
          >
            Objectives
          </button>
        </div>

        {tab === "objectives" && (
          <div className="tabpane" data-testid="objectives-pane">
            <div className="obj-title">OBJECTIVES</div>
            <div className="obj-progress" data-testid="obj-progress" data-hint="Hack 2 relays, then breach the Core, then reach Extraction.">
              Relays {relayDone} of {relayTotal} hacked
            </div>
            {snap.objectives.map((o) => {
              const plain = objectivePlain(o.id, o.status);
              return (
                <div key={o.id} className={`obj ${o.status}`} data-testid={`obj-${o.id}`} data-state={o.status} data-hint={objectiveHint(o.id, o.status)}>
                  {/* Shape distinguishes state without colour alone:
                      done=square+check, available=ring, locked=circle+cross */}
                  <span
                    className="obj-dot"
                    data-shape={o.status === "done" ? "square" : o.status === "available" ? "ring" : "circle"}
                    aria-hidden="true"
                  />
                  <span className="obj-text">
                    <span className="obj-line">
                      <span className="obj-label">{o.label}</span>
                      <span className="obj-status" data-state={o.status}>{plain.label}</span>
                    </span>
                    <span className="obj-explain">{plain.explain}</span>
                  </span>
                </div>
              );
            })}
            <div className="obj-title">SQUAD</div>
            {playerUnits.map((u) => {
              const guide = enemyGuide(u.archetype);
              return (
                <button
                  key={u.id}
                  className="squad-row squad-pick"
                  data-testid={`squad-${u.id}`}
                  data-selected={u.id === snap.selectedId ? "1" : "0"}
                  data-hint={guide.threat + " " + guide.counter}
                  onClick={() => game?.select(u.id)}
                >
                  <span className="squad-name">{u.name}</span>
                  <span className="squad-plot">
                    <Bar value={u.hp} max={u.maxHp} color={u.side === "player" ? "#25e0c0" : "#ff4d6d"} />
                    <span className="squad-hp">HP {u.hp}/{u.maxHp}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {tab === "commentary" && (
          <div className="tabpane feed" data-testid="commentary-pane" ref={feedRef}>
            {snap.feed.length === 0 && <div className="cm-entry cm-empty">No actions yet.</div>}
            {snap.feed.map((f) => (
              <div key={f.seq} className="cm-entry" data-seq={f.seq} data-testid="cm-entry">
                {f.text}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mouse-only camera + action dock. Every keyboard-only path (Q/E/R/Esc) now has a clickable
          button; the keys are kept as optional accelerators. */}
      <div className="cam-dock" data-testid="cam-dock" data-hint="Mouse camera controls: pan, zoom, rotate and reset — no keys needed.">
        <div className="cam-group" aria-label="Pan">
          <span className="cam-label">Pan</span>
          <button className="btn small cam-btn" data-testid="pan-left" onClick={() => game?.panCam(-4, 0)} aria-label="Pan left" title="Pan left">◀</button>
          <button className="btn small cam-btn" data-testid="pan-up" onClick={() => game?.panCam(0, -4)} aria-label="Pan up" title="Pan up">▲</button>
          <button className="btn small cam-btn" data-testid="pan-down" onClick={() => game?.panCam(0, 4)} aria-label="Pan down" title="Pan down">▼</button>
          <button className="btn small cam-btn" data-testid="pan-right" onClick={() => game?.panCam(4, 0)} aria-label="Pan right" title="Pan right">▶</button>
        </div>
        <div className="cam-group" aria-label="Zoom">
          <span className="cam-label">Zoom</span>
          <button className="btn small cam-btn" data-testid="zoom-out" onClick={() => game?.zoomCam(0.18)} aria-label="Zoom out" title="Zoom out">−</button>
          <button className="btn small cam-btn" data-testid="zoom-in" onClick={() => game?.zoomCam(-0.18)} aria-label="Zoom in" title="Zoom in">+</button>
        </div>
        <div className="cam-group" aria-label="Rotate">
          <span className="cam-label">Rotate</span>
          <button className="btn small cam-btn" data-testid="rotate-left" onClick={() => game?.rotateCam(-1)} aria-label="Rotate left" title="Rotate left (Q)">⟲</button>
          <button className="btn small cam-btn" data-testid="rotate-right" onClick={() => game?.rotateCam(1)} aria-label="Rotate right" title="Rotate right (E)">⟳</button>
        </div>
        <button className="btn small" data-testid="cam-reset" onClick={() => game?.resetCam()} title="Reset camera (R)">Reset view (R)</button>
        <button className="btn" data-testid="cancel-action" onClick={() => game?.cancelAction()} title="Cancel a pending action (Esc)">Cancel (Esc)</button>
      </div>

      <div className="hud-bottom">
        <button className="btn primary" data-testid="end-turn" disabled={snap.phase !== "player"} onClick={() => game?.endTurn()}>
          End Turn (Enter)
        </button>
        <button className="btn" data-testid="next-operative" onClick={() => game?.cycleUnit()}>
          Next Operative (Tab)
        </button>
      </div>
    </div>
  );
}