/**
 * Meta-analysis primitives.
 *
 * These are the standard tools for the question "N independent parties each
 * ran the same test — what do they say together, and do they agree?" They
 * are old, well understood, and exactly right for a federated payment
 * network, which is why they are used here instead of anything invented.
 *
 * Stouffer answers the first half: combine N z-statistics into one.
 * Cochran's Q and I² answer the second half, and the second half is the one
 * that matters here — it is what separates "the issuer is down" from "one
 * merchant broke something".
 */

import { normalCdf, twoSidedP } from '../stats.js';

/**
 * Stouffer's weighted Z-test.
 *
 * Combining z-scores directly (rather than averaging p-values, which is
 * wrong, or taking the minimum, which is worse) preserves both direction
 * and magnitude. Weights are sqrt(n): a merchant with four times the volume
 * carries twice the weight, which is the correct weighting for a mean of
 * proportions and stops one large merchant from deciding the network's
 * verdict on its own.
 *
 * Returns null when there is nothing to combine.
 */
export function stouffer(
  entries: readonly { z: number; n: number }[],
): { z: number; p: number } | null {
  if (entries.length === 0) return null;

  let num = 0;
  let denom = 0;
  for (const e of entries) {
    const w = Math.sqrt(Math.max(1, e.n));
    num += w * e.z;
    denom += w * w;
  }
  if (denom <= 0) return null;

  const z = num / Math.sqrt(denom);
  return { z, p: twoSidedP(z) };
}

export interface Heterogeneity {
  /** Cochran's Q. Large = contributors disagree beyond sampling noise. */
  q: number;
  /** Degrees of freedom, k - 1. */
  df: number;
  /** I² in 0..1. The share of total variation that is real disagreement. */
  iSquared: number;
  /** Inverse-variance weighted pooled effect. */
  pooled: number;
}

/**
 * Cochran's Q and Higgins' I² over per-contributor effect estimates.
 *
 * This is the crux of the whole federated idea. Two very different worlds
 * produce the same pooled average:
 *
 *   - Eleven merchants each down 9 points on HDFC UPI. Q is small, I² near
 *     zero: they are measuring one shared event. That is an issuer.
 *   - One merchant down 60 points and ten flat. The average still looks
 *     like a decline, but Q is enormous and I² near one: they are not
 *     measuring the same thing. That is one merchant's own regression.
 *
 * Without this test a federated system would confidently blame the issuer
 * for a bug in a single merchant's checkout — a worse failure than not
 * federating at all, because it exports one merchant's fault to everyone.
 *
 * Each effect needs a variance. For a difference in proportions the usual
 * estimate is p(1-p)(1/n_pre + 1/n_post); the caller supplies it directly
 * so this stays a pure statistical routine.
 */
export function heterogeneity(
  entries: readonly { effect: number; variance: number }[],
): Heterogeneity | null {
  const usable = entries.filter((e) => Number.isFinite(e.variance) && e.variance > 0);
  if (usable.length < 2) return null;

  let sumW = 0;
  let sumWX = 0;
  for (const e of usable) {
    const w = 1 / e.variance;
    sumW += w;
    sumWX += w * e.effect;
  }
  const pooled = sumWX / sumW;

  let q = 0;
  for (const e of usable) {
    const w = 1 / e.variance;
    q += w * (e.effect - pooled) ** 2;
  }

  const df = usable.length - 1;
  // I² is clamped at zero: Q below its expectation means the contributors
  // agree more than chance would predict, which is not negative variance,
  // it is just agreement.
  const iSquared = df > 0 ? Math.max(0, (q - df) / q) : 0;

  return { q, df, iSquared: Number.isFinite(iSquared) ? iSquared : 0, pooled };
}

/**
 * Variance of a difference in two proportions, for the heterogeneity test.
 */
export function diffVariance(
  postRate: number, postN: number,
  preRate: number, preN: number,
): number {
  if (postN <= 0 || preN <= 0) return Infinity;
  const a = (postRate * (1 - postRate)) / postN;
  const b = (preRate * (1 - preRate)) / preN;
  const v = a + b;
  // A degenerate cohort (every payment succeeded, or every one failed)
  // produces zero variance and would otherwise get infinite weight.
  return v > 1e-9 ? v : 1e-9;
}

/**
 * Spread of onset timestamps, in minutes, ignoring contributors that never
 * located a change point.
 *
 * Synchronisation is independent evidence. Two merchants can both be down
 * on the same rail for unrelated reasons, but they will not start within
 * the same half hour unless something shared caused it.
 *
 * Reported as the interquartile range, not the full range. Onset comes
 * from a change point over hourly buckets on per-merchant volumes that can
 * be small, so a handful of estimates will always be badly wrong. Max
 * minus min is decided entirely by those two worst estimates and gets
 * wider the more merchants join — the exact opposite of what more evidence
 * should do. The IQR describes where the fleet actually agrees and is
 * unmoved by the tails.
 */
export function onsetSpreadMinutes(
  onsets: readonly (number | null)[],
): number | null {
  const known = onsets.filter((o): o is number => o !== null).sort((a, b) => a - b);
  if (known.length < 2) return null;
  if (known.length < 4) {
    return (known[known.length - 1]! - known[0]!) / 60_000;
  }
  const q = (p: number): number => {
    const idx = (known.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return known[lo]! + (known[hi]! - known[lo]!) * (idx - lo);
  };
  return (q(0.75) - q(0.25)) / 60_000;
}

/** One-sided probability that a combined Z this negative arose by chance. */
export function degradationP(z: number): number {
  return normalCdf(z);
}
