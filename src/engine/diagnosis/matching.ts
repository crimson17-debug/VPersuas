/**
 * Matched control construction and the parallel-trends check.
 *
 * A control cohort is the treated cohort with one dimension negated: same
 * device, same value band, same everything — a different issuer. If that
 * control moved too, the issuer is not the story.
 *
 * Difference-in-differences only identifies an effect if treated and
 * control would have moved in parallel absent the cause. That is an
 * assumption, not a fact, and it is the main threat to every causal claim
 * downstream. It cannot be verified for the post period, but it can be
 * checked in the pre period, and a control that was already drifting away
 * from the treated cohort before onset is rejected here rather than
 * silently producing a confident wrong answer.
 */

import type { Cohort, CohortDimension, PaymentEvent } from '../types.js';
import { sd } from '../stats.js';

const HOUR = 3_600_000;

export interface Slice {
  n: number;
  captured: number;
  failedPaise: number;
  totalPaise: number;
}

export const EMPTY_SLICE: Slice = { n: 0, captured: 0, failedPaise: 0, totalPaise: 0 };

export interface ControlSpec {
  /** Dimensions held equal to the treated cohort. */
  base: Cohort;
  /** The dimension that is negated. */
  dim: CohortDimension;
  /** The treated value on that dimension, which the control excludes. */
  excludedValue: string;
  label: string;
}

/** Build the control implied by blaming `dim` for a change in `treated`. */
export function controlFor(treated: Cohort, dim: CohortDimension): ControlSpec | null {
  const excludedValue = treated[dim];
  if (excludedValue === undefined) return null;
  const base: Cohort = { ...treated };
  delete base[dim];
  return {
    base,
    dim,
    excludedValue,
    label: `same profile, ${dim} other than ${excludedValue}`,
  };
}

function matchesBase(e: PaymentEvent, base: Cohort): boolean {
  for (const [d, want] of Object.entries(base) as [CohortDimension, string][]) {
    if (String(e[d as keyof PaymentEvent]) !== want) return false;
  }
  return true;
}

export function sliceTreated(
  events: readonly PaymentEvent[],
  cohort: Cohort,
  fromTs: number,
  toTs: number,
): Slice {
  const out = { ...EMPTY_SLICE };
  for (const e of events) {
    if (e.ts < fromTs || e.ts >= toTs) continue;
    if (!matchesBase(e, cohort)) continue;
    out.n++;
    out.totalPaise += e.amountPaise;
    if (e.outcome === 'captured') out.captured++;
    else out.failedPaise += e.amountPaise;
  }
  return out;
}

export function sliceControl(
  events: readonly PaymentEvent[],
  spec: ControlSpec,
  fromTs: number,
  toTs: number,
): Slice {
  const out = { ...EMPTY_SLICE };
  for (const e of events) {
    if (e.ts < fromTs || e.ts >= toTs) continue;
    if (!matchesBase(e, spec.base)) continue;
    if (String(e[spec.dim as keyof PaymentEvent]) === spec.excludedValue) continue;
    out.n++;
    out.totalPaise += e.amountPaise;
    if (e.outcome === 'captured') out.captured++;
    else out.failedPaise += e.amountPaise;
  }
  return out;
}

/** Hourly success rates for an arbitrary predicate over a window. */
function series(
  events: readonly PaymentEvent[],
  keep: (e: PaymentEvent) => boolean,
  fromTs: number,
  toTs: number,
): number[] {
  const buckets = Math.max(1, Math.ceil((toTs - fromTs) / HOUR));
  const total = new Array<number>(buckets).fill(0);
  const ok = new Array<number>(buckets).fill(0);
  for (const e of events) {
    if (e.ts < fromTs || e.ts >= toTs) continue;
    if (!keep(e)) continue;
    const b = Math.min(buckets - 1, Math.floor((e.ts - fromTs) / HOUR));
    total[b]!++;
    if (e.outcome === 'captured') ok[b]!++;
  }
  const rates: number[] = [];
  for (let b = 0; b < buckets; b++) {
    rates.push(total[b]! > 0 ? ok[b]! / total[b]! : (rates[b - 1] ?? 1));
  }
  return rates;
}

export interface ParallelTrendCheck {
  ok: boolean;
  /** Standard deviation of the treated-minus-control gap before onset. */
  preGapVolatility: number;
  /** Change in that gap across the first and second half of the pre period. */
  preGapDrift: number;
  note: string;
}

/**
 * Check that treated and control tracked each other before onset.
 *
 * Rejects a control whose gap to the treated cohort was already drifting,
 * because difference-in-differences would then attribute that pre-existing
 * divergence to the incident.
 */
export function checkParallelTrends(
  events: readonly PaymentEvent[],
  treated: Cohort,
  spec: ControlSpec,
  preFromTs: number,
  onsetTs: number,
): ParallelTrendCheck {
  const t = series(events, (e) => matchesBase(e, treated), preFromTs, onsetTs);
  const c = series(
    events,
    (e) => matchesBase(e, spec.base) && String(e[spec.dim as keyof PaymentEvent]) !== spec.excludedValue,
    preFromTs, onsetTs,
  );

  const len = Math.min(t.length, c.length);
  if (len < 4) {
    return {
      ok: true, preGapVolatility: 0, preGapDrift: 0,
      note: 'pre-period too short to test parallel trends',
    };
  }

  const gap: number[] = [];
  for (let i = 0; i < len; i++) gap.push(t[i]! - c[i]!);

  const half = Math.floor(len / 2);
  const firstHalf = gap.slice(0, half);
  const secondHalf = gap.slice(half);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const drift = avg(secondHalf) - avg(firstHalf);
  const volatility = sd(gap);

  // Drift beyond 3pp across the pre-period, or a gap noisier than 6pp,
  // means this control is not tracking the treated cohort well enough to
  // support a causal reading.
  const ok = Math.abs(drift) <= 0.03 && volatility <= 0.06;
  return {
    ok,
    preGapVolatility: volatility,
    preGapDrift: drift,
    note: ok
      ? `pre-period gap stable (drift ${(drift * 100).toFixed(1)}pp)`
      : `pre-period gap unstable (drift ${(drift * 100).toFixed(1)}pp, sd ${(volatility * 100).toFixed(1)}pp)`,
  };
}

/** Share of failures in a window carrying a given reason. */
export function reasonShare(
  events: readonly PaymentEvent[],
  cohort: Cohort,
  fromTs: number,
  toTs: number,
  reason: string,
): { share: number; failures: number } {
  let failures = 0;
  let matching = 0;
  for (const e of events) {
    if (e.ts < fromTs || e.ts >= toTs) continue;
    if (!matchesBase(e, cohort)) continue;
    if (e.outcome !== 'failed') continue;
    failures++;
    if (e.failureReason === reason) matching++;
  }
  return { share: failures > 0 ? matching / failures : 0, failures };
}

/** Duration in hours over which the cohort's success rate stays depressed. */
export function depressionDurationHours(
  events: readonly PaymentEvent[],
  cohort: Cohort,
  preFromTs: number,
  onsetTs: number,
  toTs: number,
): number {
  const pre = series(events, (e) => matchesBase(e, cohort), preFromTs, onsetTs);
  const post = series(events, (e) => matchesBase(e, cohort), onsetTs, toTs);
  if (!pre.length || !post.length) return 0;
  const baseline = pre.reduce((s, v) => s + v, 0) / pre.length;
  const threshold = baseline - 0.03;
  return post.filter((r) => r < threshold).length;
}
