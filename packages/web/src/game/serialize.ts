import type { GameState } from "@sb/sim";

// Tiny observable store. React subscribes via useSyncExternalStore; the game mutates a snapshot
// and notifies. Rendering/animation never changes simulation state (rules live in @sb/sim).
type Listener = () => void;

export class Store<T> {
  private listeners = new Set<Listener>();
  constructor(private state: T) {}
  get = (): T => this.state;
  set = (next: T): void => {
    this.state = next;
    this.listeners.forEach((l) => l());
  };
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export interface Snapshot {
  revision: number;
  phase: "player" | "enemy";
  turn: number;
  mission: number;
  missionName: string;
  selectedId: string | null;
  statusLine: string;
  log: string[];
  objectives: { id: string; label: string; status: string }[];
  units: GameState["units"];
  gameOver: boolean;
  victory: boolean;
  enemyBusy: boolean;
  feed: { seq: number; text: string }[];
  // Player-facing action clarity surfaces (presentation only; derived from authoritative state,
  // never a rule source). `pending` = an armed targeted action awaiting a target; `preview` = the
  // projected outcome of hovering the current tile (derived from the shared sim so it can be checked
  // against the delivered result); `notice` = a visible explanation of a refusal / system change so no
  // board mutation or denied action is ever left unexplained.
  pending: { ability: string; label: string; keys: string[] } | null;
  preview: { kind: "attack" | "move" | "support" | "device"; tile: string; text: string } | null;
  notice: { seq: number; text: string } | null;
}
