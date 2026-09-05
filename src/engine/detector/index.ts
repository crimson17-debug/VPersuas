/**
 * Detection.
 *
 * Answers only the first question: WHAT changed, for WHOM, starting WHEN.
 * It deliberately says nothing about why — that is diagnosis, and keeping
 * the two apart is what stops a correlation in the scan from being
 * reported as a cause.
 *
 * The hard part is not finding drops. It is not finding drops that are not
 * there. Several hundred cohorts get tested on every window, so an
 * uncorrected 5% threshold would fire on roughly one in twenty by chance
 * alone. Three guards apply: a Šidák-corrected significance threshold, a
 * minimum effect size, and a minimum exposed value.
 */

import type { Cohort, Detection, PaymentEvent } from '../types.js';
import { cohortKey } from '../types.js';
import { cusum, sidakAlpha, twoProportion, zForTwoSidedAlpha } from '../stats.js';
import { enumerateCohorts, statsFor } from './cohorts.js';

const HOUR = 3_600_000;

export interface DetectorConfig {
  /** Length of the recent window under test. */
  postHours: number;
  /** Minimum events in each of the pre and post windows for a cohort. */
  minCohortN: number;
  /** Minimum drop in success rate, in proportion points. */
  minEffect: number;
  /** Minimum estimated value at stake, in paise. */
  minExposedPaise: number;
  /** Family-wise error rate across the whole scan. */
  alpha: number;
  /** Cap on how many detections to return. */
  maxDetections: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  postHours: 6,
  minCohortN: 40,
  minEffect: 0.04,
  minExposedPaise: 500_000, // ₹5,000
  alpha: 0.05,
  maxDetections: 3,
};

export interface DetectionRun {
  detections: Detection[];
  /** How many cohorts cleared the volume floor and were actually tested. */
  cohortsTested: number;
  /** The corrected |z| a cohort had to beat. Reported for auditability. */
  zThreshold: number;
  preWindow: { fromTs: number; toTs: number };
  postWindow: { fromTs: number; toTs: number };
}

/** True when one cohort is a refinement of the other (or they are equal). */
function nested(a: Cohort, b: Cohort): boolean {
  const [small, large] =
    Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  for (const [k, v] of Object.entries(small)) {
    if (large[k as keyof Cohort] !== v) return false;
  }
  return true;
}

/** Hourly success rate for a cohort, used to locate onset. */
function hourlySeries(
  events: readonly PaymentEvent[],
  cohort: Cohort,
  fromTs: number,
  toTs: number,
): { rates: number[]; hourStarts: number[] } {
  const buckets = Math.max(1, Math.ceil((toTs - fromTs) / HOUR));
  const total = new Array<number>(buckets).fill(0);
  const ok = new Array<number>(buckets).fill(0);
  const entries = Object.entries(cohort) as [keyof PaymentEvent, string][];

  outer: for (const e of events) {
    if (e.ts < fromTs || e.ts >= toTs) continue;
    for (const [d, want] of entries) {
      if (String(e[d]) !== want) continue outer;
    }
    const b = Math.min(buckets - 1, Math.floor((e.ts - fromTs) / HOUR));
    total[b]!++;
    if (e.outcome === 'captured') ok[b]!++;
  }

  const rates: number[] = [];
  const hourStarts: number[] = [];
  for (let b = 0; b < buckets; b++) {
    // Empty hours inherit the running rate rather than reading as a
    // catastrophic drop to zero.
    const r = total[b]! > 0 ? ok[b]! / total[b]! : (rates[b - 1] ?? 1);
    rates.push(r);
    hourStarts.push(fromTs + b * HOUR);
  }
  return { rates, hourStarts };
}

export function detect(
  events: readonly PaymentEvent[],
  config: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): DetectionRun {
  if (events.length === 0) {
    return {
      detections: [], cohortsTested: 0, zThreshold: Infinity,
      preWindow: { fromTs: 0, toTs: 0 }, postWindow: { fromTs: 0, toTs: 0 },
    };
  }

  const minTs = events[0]!.ts;
  const maxTs = events[events.length - 1]!.ts;
  const splitTs = maxTs - config.postHours * HOUR;

  const preEvents = events.filter((e) => e.ts < splitTs);
  const postEvents = events.filter((e) => e.ts >= splitTs);

  const preWindow = { fromTs: minTs, toTs: splitTs };
  const postWindow = { fromTs: splitTs, toTs: maxTs };

  if (preEvents.length < config.minCohortN || postEvents.length < config.minCohortN) {
    return { detections: [], cohortsTested: 0, zThreshold: Infinity, preWindow, postWindow };
  }

  const candidates = enumerateCohorts(events, config.minCohortN * 2);

  // First pass: compute statistics and record how many cohorts were
  // genuinely testable, because that count sets the correction.
  const measured: {
    cohort: Cohort;
    z: number;
    diff: number;
    preRate: number; postRate: number;
    preN: number; postN: number;
    exposedPaise: number;
  }[] = [];

  for (const cohort of candidates) {
    const pre = statsFor(preEvents, cohort);
    const post = statsFor(postEvents, cohort);
    if (pre.n < config.minCohortN || post.n < config.minCohortN) continue;

    const t = twoProportion(post.captured, post.n, pre.captured, pre.n);
    const meanAmount = post.n > 0 ? post.totalPaise / post.n : 0;
    const excessFailures = Math.max(0, -t.diff) * post.n;

    measured.push({
      cohort,
      z: t.z,
      diff: t.diff,
      preRate: t.p2,
      postRate: t.p1,
      preN: pre.n,
      postN: post.n,
      exposedPaise: Math.round(excessFailures * meanAmount),
    });
  }

  const cohortsTested = measured.length;
  const zThreshold =
    cohortsTested > 0
      ? zForTwoSidedAlpha(sidakAlpha(config.alpha, cohortsTested))
      : Infinity;

  const passing = measured
    .filter((m) => m.diff <= -config.minEffect)
    .filter((m) => m.z <= -zThreshold)
    .filter((m) => m.exposedPaise >= config.minExposedPaise)
    .sort((a, b) => b.exposedPaise - a.exposedPaise);

  // Prune nested cohorts: reporting both "UPI" and "UPI × HDFC" as separate
  // incidents would double-count the same money and hand the policy engine
  // two decisions about the same customers.
  const kept: typeof passing = [];
  for (const m of passing) {
    if (kept.some((k) => nested(k.cohort, m.cohort))) continue;
    kept.push(m);
    if (kept.length >= config.maxDetections) break;
  }

  const detections: Detection[] = kept.map((m) => {
    const { rates, hourStarts } = hourlySeries(events, m.cohort, minTs, maxTs);
    const cp = cusum(rates);
    const onsetTs = cp ? (hourStarts[cp.index] ?? splitTs) : splitTs;
    return {
      cohort: m.cohort,
      onsetTs,
      preRate: m.preRate,
      postRate: m.postRate,
      preN: m.preN,
      postN: m.postN,
      score: Math.abs(m.z),
      exposedPaise: m.exposedPaise,
    };
  });

  return { detections, cohortsTested, zThreshold, preWindow, postWindow };
}

export { cohortKey };
