// Deterministic seeded PRNG. No Math.random() anywhere in simulation logic.
// splitmix32 -> mulberry32 style. Pure functions only operating on a numeric state.

export type RngState = number;

export function seedFrom(...parts: (number | string)[]): number {
  let h = 0x9e3779b9 ^ 0;
  for (const p of parts) {
    const s = typeof p === "number" ? String(p) : p;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x85ebca6b);
      h = (h ^ (h >>> 13)) >>> 0;
    }
  }
  return h >>> 0;
}

// Returns next state and a [0,1) float.
export function nextRng(state: RngState): [RngState, number] {
  let z = (state + 0x9e3779b9) >>> 0;
  const next = z;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  z = (z ^ (z >>> 15)) >>> 0;
  return [next, (z >>> 0) / 4294967296];
}

// Stateless-style wrapper: a tiny generator object created from a seed. Used for cosmetic-only
// randomness (particles/decor) and map generation. NEVER used for authoritative combat.
export class Rng {
  private s: RngState;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    const [ns, v] = nextRng(this.s);
    this.s = ns;
    return v;
  }
  range(min: number, maxExclusive: number): number {
    return min + Math.floor(this.next() * (maxExclusive - min));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.range(0, arr.length)];
  }
  fork(salt: number): Rng {
    return new Rng(seedFrom(this.s, salt));
  }
}