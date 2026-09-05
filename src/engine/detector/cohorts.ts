/**
 * Cohort enumeration.
 *
 * The search space is every combination of up to three dimensions that has
 * enough volume to say anything about. This is the part that finds things
 * a human would not think to look for — "returning Android customers on
 * orders above ₹5,000 paying by UPI" is a cohort nobody queries by hand.
 *
 * The cost of searching widely is multiple comparisons, which is handled
 * in the detector by correcting the significance threshold for the number
 * of cohorts actually tested.
 */

import type { Cohort, CohortDimension, PaymentEvent } from '../types.js';

const SCAN_DIMENSIONS: CohortDimension[] = [
  'method', 'issuer', 'device', 'valueBand', 'customerType', 'checkoutVersion',
];

/**
 * Dimension triples worth testing. Left unrestricted, three-dimensional
 * enumeration produces thousands of cohorts, most of them too thin to
 * measure, and inflates the multiple-comparison correction to the point
 * where nothing can clear it. These four carry the failure modes that
 * actually occur in payments.
 */
const TRIPLES: (readonly [CohortDimension, CohortDimension, CohortDimension])[] = [
  ['method', 'issuer', 'device'],
  ['method', 'issuer', 'valueBand'],
  ['method', 'issuer', 'customerType'],
  ['checkoutVersion', 'device', 'method'],
];

export interface CohortStats {
  cohort: Cohort;
  n: number;
  captured: number;
  failedPaise: number;
  totalPaise: number;
}

function levelsOf(events: readonly PaymentEvent[], dim: CohortDimension): string[] {
  const set = new Set<string>();
  for (const e of events) set.add(String(e[dim as keyof PaymentEvent]));
  return [...set].sort();
}

/**
 * Enumerate candidate cohorts of size 1–3 with at least `minVolume` events
 * in the supplied slice. Returns cohort definitions only; the detector
 * computes pre/post statistics for each.
 */
export function enumerateCohorts(
  events: readonly PaymentEvent[],
  minVolume: number,
): Cohort[] {
  if (events.length === 0) return [];

  const levels = new Map<CohortDimension, string[]>();
  for (const d of SCAN_DIMENSIONS) levels.set(d, levelsOf(events, d));

  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

  // A single pass over events counting every cohort key they belong to is
  // far cheaper than filtering the event array once per candidate cohort.
  for (const e of events) {
    for (const d of SCAN_DIMENSIONS) {
      bump(`${d}=${String(e[d as keyof PaymentEvent])}`);
    }
    for (let i = 0; i < SCAN_DIMENSIONS.length; i++) {
      for (let j = i + 1; j < SCAN_DIMENSIONS.length; j++) {
        const a = SCAN_DIMENSIONS[i]!, b = SCAN_DIMENSIONS[j]!;
        bump(`${a}=${String(e[a as keyof PaymentEvent])}&${b}=${String(e[b as keyof PaymentEvent])}`);
      }
    }
    for (const [a, b, c] of TRIPLES) {
      bump(
        `${a}=${String(e[a as keyof PaymentEvent])}` +
        `&${b}=${String(e[b as keyof PaymentEvent])}` +
        `&${c}=${String(e[c as keyof PaymentEvent])}`,
      );
    }
  }

  const out: Cohort[] = [];
  const seen = new Set<string>();

  const consider = (dims: CohortDimension[], values: string[]) => {
    const pairs = dims.map((d, i) => `${d}=${values[i]}`);
    const key = pairs.join('&');
    if (seen.has(key)) return;
    if ((counts.get(key) ?? 0) < minVolume) return;
    seen.add(key);
    const cohort: Cohort = {};
    dims.forEach((d, i) => { cohort[d] = values[i]!; });
    out.push(cohort);
  };

  for (const d of SCAN_DIMENSIONS) {
    for (const v of levels.get(d)!) consider([d], [v]);
  }
  for (let i = 0; i < SCAN_DIMENSIONS.length; i++) {
    for (let j = i + 1; j < SCAN_DIMENSIONS.length; j++) {
      const a = SCAN_DIMENSIONS[i]!, b = SCAN_DIMENSIONS[j]!;
      for (const va of levels.get(a)!) {
        for (const vb of levels.get(b)!) consider([a, b], [va, vb]);
      }
    }
  }
  for (const [a, b, c] of TRIPLES) {
    for (const va of levels.get(a)!) {
      for (const vb of levels.get(b)!) {
        for (const vc of levels.get(c)!) consider([a, b, c], [va, vb, vc]);
      }
    }
  }

  return out;
}

/** Success/volume statistics for one cohort over a slice of events. */
export function statsFor(events: readonly PaymentEvent[], cohort: Cohort): CohortStats {
  let n = 0, captured = 0, failedPaise = 0, totalPaise = 0;
  const entries = Object.entries(cohort) as [CohortDimension, string][];

  outer: for (const e of events) {
    for (const [d, want] of entries) {
      if (String(e[d as keyof PaymentEvent]) !== want) continue outer;
    }
    n++;
    totalPaise += e.amountPaise;
    if (e.outcome === 'captured') captured++;
    else failedPaise += e.amountPaise;
  }

  return { cohort, n, captured, failedPaise, totalPaise };
}
