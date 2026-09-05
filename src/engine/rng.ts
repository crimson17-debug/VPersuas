/**
 * Deterministic pseudo-random number generation.
 *
 * Every stochastic step in this system — event generation, incident
 * injection, holdout assignment, outcome resolution — draws from a seeded
 * generator. Two consequences that matter:
 *
 *  1. The eval is reproducible. `npm run eval` gives the same numbers on
 *     any machine, so the figures in EVAL.md can be checked.
 *  2. Holdout assignment is auditable. Given the run seed and the item id
 *     you can recompute which arm a customer landed in.
 */

/** mulberry32 — small, fast, good enough for simulation. Not for crypto. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    bool: (p) => next() < p,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => {
      if (xs.length === 0) throw new Error('pick() on empty array');
      return xs[Math.floor(next() * xs.length)]!;
    },
    weighted: <T>(entries: readonly (readonly [T, number])[]): T => {
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [value, w] of entries) {
        r -= w;
        if (r <= 0) return value;
      }
      return entries[entries.length - 1]![0];
    },
    /** Box–Muller. Used for daily traffic variation. */
    normal: (mean = 0, sd = 1) => {
      const u1 = Math.max(next(), 1e-12);
      const u2 = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}

export interface Rng {
  next(): number;
  bool(p: number): boolean;
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  normal(mean?: number, sd?: number): number;
}

/**
 * Stable hash of a string to a 32-bit int. Used to derive per-item seeds
 * so holdout assignment depends only on (runSeed, itemId) and can be
 * recomputed from the ledger.
 */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic uniform in [0,1) from a seed and an id. */
export function stableUnit(seed: number, id: string): number {
  return makeRng((hashString(id) ^ (seed >>> 0)) >>> 0).next();
}
