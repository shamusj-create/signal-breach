import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { World } from "./scene/World.ts";
import { TacticalGame } from "./game/TacticalGame.ts";
import { ui } from "./ui.ts";
import { stateHash, aiPreview, aiCandidates, reachableCells, decideEnemyActions, ABILITIES } from "@sb/sim";
import { SFX_FILES, playSfx, playVoice, getVoiceLog, type SfxName } from "./audio.ts";

declare global {
  interface Window {
    __sbGame?: TacticalGame | null;
    __sbHash?: (s: unknown) => string;
    __sbThree?: typeof THREE;
    __sbPerf?: () => { fps: number; drawCalls: number; tris: number; meshes: number; shadows: number };
    __sbAiCandidates?: typeof aiCandidates;
    __sbReachableCells?: typeof reachableCells;
    __sbDecide?: typeof decideEnemyActions;
    __sbAiPreview?: typeof aiPreview;
    // Ability-definition table + render readouts exposed so the TARGETS/FLIGHT specs can compute the
    // legal target set and the expected screen geometry INDEPENDENTLY of the app's own accessors.
    __sbAbilities?: typeof ABILITIES;
    __sbTargetKeys?: () => string[];
    __sbProjectiles?: () => { kind: string; x: number; y: number; z: number; from: number[]; to: number[]; f: number; impactFired: boolean }[];
    // Audio oracle surface (read-only to the game): the spec instruments AudioContext and drives
    // these directly so the proof is against the real audio path, not a cue-name log.
    __sbAudio?: {
      sfx: (name: SfxName) => void;
      voice: (name: string) => void;
      map: typeof SFX_FILES;
      voiceLog: () => ReturnType<typeof getVoiceLog>;
    };
  }
}

export function GameCanvas({ mission, seed, reducedMotion }: { mission: number; seed: number; reducedMotion: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const [debug, setDebug] = useState(() => new URLSearchParams(window.location.search).get("debug") === "1");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const world = new World(el);
    worldRef.current = world;
    world.reducedMotion = reducedMotion;
    const game = new TacticalGame(el, world, ui.store, mission, seed);
    ui.game = game;
    window.__sbGame = game;
    window.__sbThree = THREE;
    window.__sbHash = (s: unknown) => stateHash(s as never);
    window.__sbPerf = () => world.perf();
    window.__sbAiCandidates = aiCandidates;
    window.__sbReachableCells = reachableCells;
    window.__sbDecide = decideEnemyActions;
    window.__sbAiPreview = aiPreview;
    window.__sbAudio = { sfx: playSfx, voice: playVoice, map: SFX_FILES, voiceLog: getVoiceLog };
    window.__sbAbilities = ABILITIES;
    window.__sbTargetKeys = () => world.debugAbilityTargets();
    window.__sbProjectiles = () => world.debugProjectiles();
    const onResize = () => world.resize(el.clientWidth, el.clientHeight);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F3") {
        e.preventDefault();
        setDebug((d) => !d);
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      game.detachInput();
      world.dispose();
      ui.game = null;
      worldRef.current = null;
      if (window.__sbGame === game) window.__sbGame = null;
    };
  }, [mission, seed, reducedMotion]);

  const [perf, setPerf] = useState({ fps: 0, drawCalls: 0, tris: 0, meshes: 0, shadows: 0 });
  useEffect(() => {
    if (!debug) return;
    const id = window.setInterval(() => {
      if (worldRef.current) setPerf(worldRef.current.perf());
    }, 500);
    return () => clearInterval(id);
  }, [debug]);

  // AI candidate readout (debug-gated, default OFF). Recomputes a CURRENT-STATE preview from the
  // shared, non-mutating sim readout and shows only currently-visible living enemies. It refreshes
  // on AUTHORITATIVE STATE NOTIFICATIONS (TacticalGame.onStateChange, fired from every sync()), NOT
  // on a fixed interval, so rows can never lag a transition. A separate oracle (window.__sbAiCandidates
  // / __sbReachableCells) recomputes the truth in e2e/ai.spec.ts; the display is never trusted.
  const [aiText, setAiText] = useState("");
  useEffect(() => {
    if (!debug) {
      setAiText("");
      return;
    }
    const fmt = (g: TacticalGame) =>
      aiPreview(g.debugState()).map((r) => `EID ${r.id} top=${r.topKey} s=${r.topScore.toFixed(3)} n=${r.candidates}`).join("\n");
    const g0 = ui.game;
    if (!g0) return;
    setAiText(fmt(g0));
    return g0.onStateChange((g) => setAiText(fmt(g)));
  }, [debug, mission, seed, reducedMotion]);

  return (
    <div ref={ref} data-testid="game-canvas" style={{ position: "absolute", inset: 0, outline: "none" }}>
      {debug && (
        <div
          data-testid="debug-overlay"
          style={{ position: "absolute", top: 8, left: 8, fontFamily: "monospace", fontSize: 12, color: "#9fe8ff", background: "rgba(0,0,0,0.55)", padding: 8, borderRadius: 6, pointerEvents: "none", lineHeight: 1.5 }}
        >
          FPS {perf.fps} · draw {perf.drawCalls} · tri {perf.tris}
          <br />
          seed {seed} · rev {ui.game?.state.revision ?? 0} · turn {ui.game?.state.turn ?? 0}
          <br />
          units {ui.game?.state.units.filter((u) => u.alive).length ?? 0} · rev#{ui.game?.state.revision ?? 0}
        </div>
      )}
      {debug && (
        <pre
          data-testid="ai-preview"
          style={{ position: "absolute", top: 300, left: 12, maxWidth: 330, maxHeight: "320px", overflow: "hidden", fontFamily: "monospace", fontSize: 11, color: "#b9ffe0", background: "rgba(0,0,0,0.55)", padding: 8, borderRadius: 6, pointerEvents: "none", lineHeight: 1.4, whiteSpace: "pre-wrap" }}
        >
          {"AI current-state preview\n"}
          {aiText}
        </pre>
      )}
    </div>
  );
}