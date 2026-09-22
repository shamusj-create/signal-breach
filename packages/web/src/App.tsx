import { useEffect, useState, useSyncExternalStore } from "react";
import { ui, setScreen, setAudioSettings } from "./ui.ts";
import { GameCanvas } from "./GameCanvas.tsx";
import { HUD } from "./HUD.tsx";
import { missionByIndex, computeScore, serializeCampaign, deserializeCampaign, type CampaignSave } from "@sb/sim";

const SAVE_KEY = "signal-breach-campaign-v2";

function useUi() {
  return useSyncExternalStore(ui.state.subscribe, ui.state.get);
}

function loadSave(): CampaignSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return deserializeCampaign(raw);
  } catch {
    return null;
  }
}
function persist(s: CampaignSave) {
  try {
    localStorage.setItem(SAVE_KEY, serializeCampaign(s));
  } catch {
    /* ignore */
  }
}

function missionFromUrl(): number {
  // Test/fixture hook: deploy directly into a sector (1-based, e.g. /?mission=3 for Core Chamber).
  try {
    const m = new URLSearchParams(window.location.search).get("mission");
    if (m) {
      const n = Number(m) - 1;
      if (n >= 0 && n <= 2) return n;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function seedFromUrl(): number {
  try {
    const s = new URLSearchParams(window.location.search).get("seed");
    if (s) return Number(s) >>> 0;
  } catch {
    /* ignore */
  }
  return (Date.now() & 0xffffff) || 7;
}

export function App() {
  const uiState = useUi();
  return (
    <div className="app-root" data-screen={uiState.screen}>
      {uiState.screen === "title" && <TitleScreen />}
      {uiState.screen === "briefing" && <Briefing />}
      {uiState.screen === "game" && <GameScreen key={`${uiState.campaign.mission}`} />}
      {uiState.screen === "results" && <Results />}
      {uiState.screen === "upgrade" && <Upgrade />}
      {uiState.screen === "leaderboard" && <Leaderboard />}
    </div>
  );
}

// Shell wraps every non-game screen. When atmospheric=true it layers decorative
// presentation (haze band, scanline texture, horizon rule) beneath the content.
// The shell has a CSS fade-in animation (shell-in) so screen changes never flash
// a blank or unstyled field; the animation respects prefers-reduced-motion.
function Shell({ children, atmospheric = false }: { children: React.ReactNode; atmospheric?: boolean }) {
  return (
    <div className="menu-shell">
      {atmospheric && (
        <>
          <div className="title-haze" aria-hidden="true" />
          <div className="title-scanlines" aria-hidden="true" />
          <div className="title-horizon" aria-hidden="true" />
        </>
      )}
      <div className="title-content">{children}</div>
    </div>
  );
}

function TitleScreen() {
  const hasSave = !!loadSave();
  return (
    <Shell atmospheric>
      <div className="title-mark">SIGNAL&nbsp;BREACH</div>
      <div className="title-sub">3D TACTICAL INFILTRATION</div>
      <div className="menu">
        <button
          className="btn primary"
          data-testid="new-campaign"
          onClick={() => {
            ui.state.set({ ...ui.state.get(), campaign: { mission: missionFromUrl(), seed: seedFromUrl(), upgrades: {}, squad: ["vanguard", "ghost", "cipher"] } });
            setScreen("briefing");
          }}
        >
          New Campaign
        </button>
        <button className="btn" disabled={!hasSave} data-testid="continue-campaign" onClick={() => setScreen("briefing")}>
          Continue Campaign
        </button>
        <button className="btn" data-testid="open-leaderboard" onClick={() => setScreen("leaderboard")}>
          Leaderboard
        </button>
      </div>
      <SettingsBar />
    </Shell>
  );
}

function Briefing() {
  const u = useUi();
  const m = missionByIndex(u.campaign.mission);
  return (
    <Shell>
      <div className="title-mark small">MISSION {u.campaign.mission + 1}: {m.name}</div>
      <p className="body-text">
        Infiltrate the data fortress. Hack both network relays, unseal and breach the core, then extract. Combat is deterministic — no dice, no guessing: what you preview is what you get.
      </p>
      <button
        className="btn primary"
        data-testid="deploy"
        onClick={() => {
          setScreen("game");
        }}
      >
        Deploy Squad
      </button>
      <button className="btn" onClick={() => setScreen("title")}>
        Back
      </button>
    </Shell>
  );
}

function GameScreen() {
  const u = useUi();
  return (
    <div className="game-shell">
      <GameCanvas mission={u.campaign.mission} seed={u.campaign.seed} reducedMotion={u.audio.reducedMotion} />
      <HUD />
      <ResultGate />
    </div>
  );
}

// Watches the store; when a mission becomes game-over, offers to move to results.
function ResultGate() {
  const snap = useSyncExternalStore(ui.store.subscribe, ui.store.get);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (snap.gameOver) {
      const t = setTimeout(() => setReady(true), 1400);
      return () => clearTimeout(t);
    }
  }, [snap.gameOver]);
  if (!snap.gameOver || !ready) return null;
  const score = computeScore(snapObjectState(snap));
  const toResults = () => {
    const s = ui.state.get();
    persist({ version: 2, seed: s.campaign.seed, mission: Math.min(2, s.campaign.mission + 1), upgrades: s.campaign.upgrades as never });
    setScreen("results");
  };
  return (
    <div className="overlay center">
      <div className="panel">
        <div className="title-mark small">{snap.victory ? "MISSION COMPLETE" : "MISSION FAILED"}</div>
        <div className="score">SCORE {score.total}</div>
        <SubmitRun />
        <button className="btn primary" data-testid="to-results" onClick={toResults}>
          Continue
        </button>
      </div>
    </div>
  );
}

// Submits the authoritative action log for server-side re-validation. The server replays the
// exact same shared-sim rules; only a validated win enters the SQLite leaderboard.
function SubmitRun() {
  const [status, setStatus] = useState<string>("");
  const submit = () => {
    const g = ui.game;
    if (!g || g.actionLog.length === 0) {
      setStatus("NO LOG");
      return;
    }
    const body = {
      mission: g.state.mission,
      seed: g.seed,
      actions: g.actionLog,
      claimedOutcome: g.state.victory ? "win" : "lose",
      claimedScore: computeScore(g.state).total,
      player: "operator",
    };
    setStatus("submitting…");
    fetch("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => {
        const d = (await r.json()) as { accepted?: boolean; reason?: string; entry?: { score?: number } };
        setStatus(r.status === 200 && d.accepted ? `ACCEPTED ${d.entry?.score ?? ""}` : `REJECTED ${d.reason ?? r.status}`);
      })
      .catch(() => setStatus("SERVER UNAVAILABLE"));
  };
  return (
    <div className="row-label">
      <button className="btn" data-testid="submit-run" onClick={submit}>
        Submit to Leaderboard
      </button>
      <span data-testid="submit-status">{status}</span>
    </div>
  );
}

function snapObjectState(snap: ReturnType<typeof ui.store.get>) {
  // minimal shim consumed by computeScore (needs units/objectives/turn/victory/mission)
  return {
    units: snap.units,
    objectives: snap.objectives.map((o) => ({ id: o.id as never, status: o.status as never, label: o.label })),
    turn: snap.turn,
    victory: snap.victory,
    mission: snap.mission,
  } as never;
}

function Results() {
  const u = useUi();
  const isLast = u.campaign.mission >= 2;
  return (
    <Shell>
      <div className="title-mark small">AFTER-ACTION</div>
      <p className="body-text">Score is reconstructed server-side from your action log. Choose upgrades before the next sector.</p>
      <div className="menu">
        {!isLast ? (
          <button className="btn primary" data-testid="to-upgrade" onClick={() => setScreen("upgrade")}>
            Choose Upgrades
          </button>
        ) : (
          <button className="btn primary" onClick={() => setScreen("title")}>
            Campaign Complete
          </button>
        )}
        <button className="btn" onClick={() => setScreen("leaderboard")}>
          Leaderboard
        </button>
      </div>
    </Shell>
  );
}

function Upgrade() {
  const u = useUi();
  const [picks, setPicks] = useState<Record<string, string>>({});
  const slots = u.campaign.squad;
  const advance = () => {
    const s = ui.state.get();
    persist({ version: 2, seed: s.campaign.seed, mission: Math.min(2, s.campaign.mission + 1), upgrades: s.campaign.upgrades as never });
    ui.state.set({ ...s, campaign: { ...s.campaign, mission: Math.min(2, s.campaign.mission + 1) } });
    setScreen("briefing");
  };
  return (
    <Shell>
      <div className="title-mark small">UPGRADE OPERATIVES</div>
      <div className="upgrade-grid">
        {slots.map((slot) => (
          <div key={slot} className="upgrade-col">
            <div className="unit-name">{slot.toUpperCase()}</div>
            {["fortify", "powerCell", "capacitor", "quickFeet"].map((id) => (
              <button
                key={id}
                className={`btn small ${picks[slot] === id ? "sel" : ""}`}
                onClick={() => setPicks({ ...picks, [slot]: id })}
              >
                {id}
              </button>
            ))}
          </div>
        ))}
      </div>
      <button className="btn primary" data-testid="confirm-upgrade" onClick={advance}>
        Confirm &amp; Advance
      </button>
    </Shell>
  );
}

function Leaderboard() {
  const [rows, setRows] = useState<unknown[]>([]);
  const [status, setStatus] = useState("loading…");
  useEffect(() => {
    fetch("/api/leaderboard?mission=all")
      .then((r) => r.json())
      .then((d) => {
        setRows(d.rows ?? []);
        setStatus("OK");
      })
      .catch(() => setStatus("server unavailable"));
  }, []);
  return (
    <Shell>
      <div className="title-mark small">LEADERBOARD <span className="muted">({status})</span></div>
      <div className="lb">
        {rows.length === 0 && <div className="muted">No validated runs yet. Complete a mission and submit.</div>}
        {(rows as { player: string; score: number; mission: number }[]).map((r, i) => (
          <div key={i} className="lb-row">
            <span className="lb-rank">#{i + 1}</span>
            <span>{r.player}</span>
            <span>M{r.mission + 1}</span>
            <span className="lb-score">{r.score}</span>
          </div>
        ))}
      </div>
      <button className="btn" onClick={() => setScreen("title")}>Back</button>
    </Shell>
  );
}

function SettingsBar() {
  const u = useUi();
  return (
    <div className="settings-bar">
      <button className="btn small" data-testid="toggle-mute" onClick={() => setAudioSettings({ muted: !u.audio.muted })}>
        Sound: {u.audio.muted ? "OFF" : "ON"}
      </button>
      <button className="btn small" data-testid="toggle-reduced-motion" onClick={() => setAudioSettings({ reducedMotion: !u.audio.reducedMotion })}>
        Reduced Motion: {u.audio.reducedMotion ? "ON" : "OFF"}
      </button>
    </div>
  );
}
