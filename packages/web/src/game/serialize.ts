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
}
