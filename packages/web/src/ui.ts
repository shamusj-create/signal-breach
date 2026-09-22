import { Store, type Snapshot } from "./game/serialize.ts";
import type { TacticalGame } from "./game/TacticalGame.ts";
import { getAudio, setAudio, type AudioSettings } from "./audio.ts";

export type Screen = "title" | "briefing" | "game" | "upgrade" | "results" | "leaderboard" | "replay" | "paused";

export interface UiState {
  screen: Screen;
  campaign: { mission: number; seed: number; upgrades: Record<string, string[]>; squad: string[] };
  audio: AudioSettings;
}

export const initialSnapshot: Snapshot = {
  revision: 0,
  phase: "player",
  turn: 1,
  mission: 0,
  missionName: "",
  selectedId: null,
  statusLine: "",
  log: [],
  objectives: [],
  units: [],
  gameOver: false,
  victory: false,
  enemyBusy: false,
};

export const ui = {
  game: null as TacticalGame | null,
  store: new Store<Snapshot>(initialSnapshot),
  state: new Store<UiState>({
    screen: "title",
    campaign: { mission: 0, seed: 20260918, upgrades: {}, squad: ["vanguard", "ghost", "cipher"] },
    audio: getAudio(),
  }),
};

export function setScreen(screen: Screen) {
  ui.state.set({ ...ui.state.get(), screen });
}
export function setAudioSettings(a: Partial<AudioSettings>) {
  setAudio(a);
  ui.state.set({ ...ui.state.get(), audio: getAudio() });
}
