import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ui } from "./ui.ts";
import { deviceHint, deviceKindName, enemyGuide, UNIT_THREAT } from "./guidance.ts";

const ONBOARD_KEY = "sb.onboarding.seen.v2";

function readSeen(): boolean {
  try {
    return localStorage.getItem(ONBOARD_KEY) === "1";
  } catch {
    return false;
  }
}
function writeSeen() {
  try {
    localStorage.setItem(ONBOARD_KEY, "1");
  } catch {
    /* ignore */
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// Build a teaching tooltip for whatever is under the cursor (a HUD control, an enemy, a friendly,
// or a security device). Reads only authoritative state; never mutates anything.
function tipForPoint(clientX: number, clientY: number): { text: string } | null {
  const g = ui.game;
  if (!g) return null;
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (el) {
    const hinted = el.closest("[data-hint]") as HTMLElement | null;
    if (hinted) {
      const t = hinted.getAttribute("data-hint") || "";
      if (t) return { text: t };
    }
  }
  // Board hover: translate the pixel to a tile and look up the unit / device there.
  const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  if (!inside) return null;
  const tile = g.world.pickAt(clientX, clientY);
  if (!tile) return null;
  const s = g.debugState();
  const unit = s.units.find((u: any) => u.alive && u.pos.x === tile.x && u.pos.y === tile.y);
  if (unit) {
    if (unit.side === "enemy") {
      const guide = enemyGuide(unit.archetype);
      const sel = g.selected ? s.units.find((u: any) => u.id === g.selected && u.alive && u.side === "player") : undefined;
      let reach: string;
      if (!sel) reach = "Select an operative first, then click this enemy to shoot it.";
      else if (distance(sel.pos, unit.pos) <= sel.atkRange) reach = `${sel.name} is in range — click it to shoot.`;
      else reach = `Out of ${sel.name}'s reach now — move closer or use a longer-range tool.`;
      return { text: `${unit.name} — ${guide.threat} ${guide.counter} ${reach}` };
    }
    const guide = enemyGuide(unit.archetype);
    return { text: `${unit.name} (yours) — ${guide.threat} ${guide.counter}` };
  }
  const dev = s.devices.find((d: any) => d.x === tile.x && d.y === tile.y);
  if (dev) {
    const stateNote =
      dev.kind === "terminal"
        ? dev.hacked
          ? " Already hacked."
          : " Hack it to progress."
        : dev.kind === "core"
          ? dev.hacked
            ? " Breached."
            : " Breach it to unlock Extraction."
          : !dev.powered || dev.disabled
            ? " Currently disabled."
            : dev.owner === "hijacked"
              ? " Turned against security."
              : " Active — deal with it before crossing.";
    return { text: `${deviceKindName(dev.kind)} — ${deviceHint(dev.kind)}${stateNote}` };
  }
  return null;
}

export function Guidance() {
  const [tip, setTip] = useState("");
  const [tipPos, setTipPos] = useState({ x: 0, y: 0 });
  const [guideOpen, setGuideOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(() => !readSeen());
  const tipRef = useRef<HTMLDivElement>(null);
  // Re-render on authoritative state changes so the tutorial can stand down the moment a mission
  // ends — the first-run card must never sit over the post-mission results UI.
  const snap = useSyncExternalStore(ui.store.subscribe, ui.store.get);

  // Hover tooltips: a single window-level pointermove drives both DOM ([data-hint]) and board
  // (unit/device) tooltips. The tooltip element is pointer-events:none so it never blocks the board.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const next = tipForPoint(e.clientX, e.clientY);
      if (next) {
        const x = Math.min(window.innerWidth - 300, e.clientX + 16);
        const y = Math.min(window.innerHeight - 90, e.clientY + 16);
        setTipPos({ x, y });
        setTip(next.text);
      } else if (tipRef.current && tipRef.current.dataset.show === "1") {
        setTip("");
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowOverlay(false);
        setGuideOpen(false);
      } else if (e.key === "g" || e.key === "G") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        setGuideOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dismiss = () => {
    writeSeen();
    setShowOverlay(false);
  };

  const s = ui.game?.debugState();
  const enemies = (s?.units ?? []).filter((u: any) => u.alive && u.side === "enemy");
  const devices = (s?.devices ?? []).filter((d: any) => ["turret", "camera", "node", "core", "terminal"].includes(d.kind));

  return (
    <>
      <button
        className="guide-launcher btn small"
        data-testid="field-guide"
        onClick={() => setGuideOpen((o) => !o)}
        aria-expanded={guideOpen}
      >
        Field Guide (G)
      </button>

      {guideOpen && (
        <div className="field-guide panel" data-testid="field-guide-panel" role="dialog" aria-label="Field guide">
          <div className="fg-head">
            <span>FIELD GUIDE — know your enemy</span>
            <button className="btn small" data-testid="field-guide-close" onClick={() => setGuideOpen(false)}>Close</button>
          </div>
          <div className="fg-cols">
            <div className="fg-col">
              <div className="fg-title">Hostiles (threat & how to answer)</div>
              {enemies.length === 0 && <div className="fg-empty">No contacts spotted yet. Hover the board when enemies appear for live threat readouts.</div>}
              {enemies.map((u: any) => {
                const g = enemyGuide(u.archetype);
                const dmg = (UNIT_THREAT[u.archetype] ?? { atkDamage: 0, atkRange: 0 });
                return (
                  <div key={u.id} className="fg-item" data-testid={`fg-enemy-${u.archetype}`}>
                    <div className="fg-item-head">
                      <span className="fg-name">{u.name}</span>
                      <span className="fg-tag">dmg {dmg.atkDamage} · range {dmg.atkRange}</span>
                    </div>
                    <div className="fg-body">{g.threat}</div>
                    <div className="fg-body fg-counter">{g.counter}</div>
                  </div>
                );
              })}
            </div>
            <div className="fg-col">
              <div className="fg-title">Security devices</div>
              {devices.length === 0 && <div className="fg-empty">No security devices spotted yet.</div>}
              {devices.map((d: any) => (
                <div key={d.id} className="fg-item" data-testid={`fg-device-${d.kind}`}>
                  <div className="fg-item-head">
                    <span className="fg-name">{deviceKindName(d.kind)}</span>
                    <span className="fg-tag">{!d.powered || d.disabled ? "offline" : d.owner === "hijacked" ? "yours" : "active"}</span>
                  </div>
                  <div className="fg-body">{deviceHint(d.kind)}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="fg-foot">Tip: hover a unit or device on the board to read its threat live. Costs and ranges are shown on each ability button.</div>
        </div>
      )}

      {showOverlay && !snap.gameOver && (
        <div className="onboard-overlay" data-testid="first-run-overlay" role="dialog" aria-label="How to play">
          <div className="onboard-card">
            <div className="onboard-title">FIRST INFILTRATION — how to play</div>
            <div className="onboard-body">
              <div className="onboard-sec" data-testid="ob-play">
                <b>Play:</b> Pick an operative (click it, or press <b>Tab</b>). Each one has a few <b>moves</b> and some <b>energy</b> — spend them on moving, shooting and abilities. When you are done, press <b>Enter</b> to end the turn.
              </div>
              <div className="onboard-sec" data-testid="ob-win">
                <b>Win:</b> Hack <b>both relays</b>, then <b>breach the Core</b>, then get a living operative to <b>Extraction</b>. Lose everyone and the mission fails.
              </div>
              <div className="onboard-sec" data-testid="ob-interact">
                <b>Interact (mouse first):</b> Click an operative to select it, or click its <b>Squad</b> row. Click <b>ground</b> to move, click an <b>enemy</b> to shoot, click an <b>ability</b> button to use it. The bottom bar carries mouse <b>camera</b> buttons (pan · zoom · rotate · reset) and a <b>Cancel</b> button; you can also drag to pan and scroll to zoom. Click <b>End Turn</b> to hand over. Keys are optional shortcuts afterwards: Tab next operative, Enter to End Turn, Q/E rotate, R resets the camera, Esc cancels a pending action. <b>Hover</b> any control, unit or device to read its rules.
              </div>
            </div>
            <div className="onboard-actions">
              <button className="btn primary" data-testid="dismiss-onboarding" onClick={dismiss}>Start mission</button>
              <button className="btn" data-testid="skip-onboarding" onClick={dismiss}>Skip the tour</button>
            </div>
          </div>
        </div>
      )}

      <div
        ref={tipRef}
        className="hud-tooltip"
        data-testid="tooltip"
        data-show={tip ? "1" : "0"}
        style={{ left: tipPos.x, top: tipPos.y }}
        aria-hidden={tip ? "false" : "true"}
      >
        {tip}
      </div>
    </>
  );
}