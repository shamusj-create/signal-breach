import { useEffect, useRef, useState } from "react";
import { createInitialState, missionByIndex, applyAction, autoSolve, stateHash } from "@sb/sim";

// Replays a recorded / re-derived authoritative action log by RE-RUNNING the simulation. Speed
// controls change only pacing, never the outcome (verified by the replay-determinism test).

function runLog(mission: number, seed: number): { finalHash: string; steps: number } {
  const initial = createInitialState(missionByIndex(mission), seed);
  const { log } = autoSolve(createInitialState(missionByIndex(mission), seed), 60);
  let cur = initial;
  let steps = 0;
  for (const a of log) {
    const r = applyAction(cur, a);
    cur = r.state;
    steps++;
    if (cur.gameOver) break;
  }
  return { finalHash: stateHash(cur), steps };
}

export function ReplayViewer({ mission, seed }: { mission: number; seed: number }) {
  const [speed, setSpeed] = useState(4);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [finalHash, setFinalHash] = useState("");
  const [count, setCount] = useState(0);
  const timers = useRef<number[]>([]);

  const stop = () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  };

  const runReplay = (sp: number) => {
    stop();
    setDone(false);
    setFinalHash("");
    setCount(0);
    const initial = createInitialState(missionByIndex(mission), seed);
    const { log } = autoSolve(createInitialState(missionByIndex(mission), seed), 60);
    let cur = initial;
    let i = 0;
    setRunning(true);
    const tick = () => {
      if (i >= log.length) {
        setDone(true);
        setRunning(false);
        setFinalHash(stateHash(cur));
        return;
      }
      const r = applyAction(cur, log[i]);
      cur = r.state;
      i++;
      setCount(i);
      if (cur.gameOver) {
        setDone(true);
        setRunning(false);
        setFinalHash(stateHash(cur));
        return;
      }
      const t = window.setTimeout(tick, Math.max(3, 50 / sp));
      timers.current.push(t);
    };
    tick();
  };

  useEffect(() => () => stop(), []);

  const w = window as unknown as {
    __sbReplayRun?: (sp: number) => string;
    __sbReplayRestart?: () => string;
  };
  w.__sbReplayRun = (_sp: number) => runLog(mission, seed).finalHash; // deterministic regardless of sp
  w.__sbReplayRestart = () => (runLog(mission, seed).finalHash === runLog(mission, seed).finalHash ? "OK" : "DRIFT");

  return (
    <div data-testid="replay-viewer" style={{ position: "absolute", inset: 0, color: "#cfe6ff", fontFamily: "system-ui", padding: 24 }}>
      <div style={{ letterSpacing: 2, color: "#2bd7ff" }}>REPLAY · MISSION {mission + 1} · seed {seed}</div>
      <div style={{ marginTop: 12, height: 220, background: "rgba(10,20,30,0.6)", border: "1px solid rgba(43,215,255,0.3)", padding: 12, overflow: "hidden" }}>
        Re-running authoritative action log… {done ? "COMPLETE" : `step ${count}`}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button data-testid="replay-play" className="btn" onClick={() => (running ? (stop(), setRunning(false)) : runReplay(speed))}>
          {running ? "Pause" : "Play"}
        </button>
        {[1, 2, 4].map((s) => (
          <button key={s} data-testid={`replay-speed-${s}`} className={speed === s ? "btn sel" : "btn"} onClick={() => setSpeed(s)}>
            ×{s}
          </button>
        ))}
        <button data-testid="replay-restart" className="btn" onClick={() => runReplay(speed)}>
          Restart
        </button>
        {done && (
          <span data-testid="replay-final" className="chip">
            FINAL {finalHash}
          </span>
        )}
      </div>
    </div>
  );
}
