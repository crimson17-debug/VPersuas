/**
 * What a merchant computes locally and is willing to publish.
 *
 * This runs inside the merchant's own boundary. Raw events go in; a handful
 * of numbers come out. Nothing that leaves this function can be joined back
 * to a customer, an order, or an amount, and the merchant's identity is not
 * part of the payload at all.
 *
 * This is the honest version of "privacy-preserving": not an assertion in a
 * README, but a function whose entire output is visible in one screen of
 * code. If a reviewer wants to know what is shared, they read the return
 * type and they are done.
 */

import type { Issuer, PaymentEvent, PaymentMethod } from '../types.js';
import { cusum, twoProportion } from '../stats.js';
import type { NetworkContribution, RailSignal } from './types.js';

const HOUR = 3_600_000;

export interface ContributeConfig {
  postHours: number;
  minRailN: number;
  /**
   * How far back to look for the change point.
   *
   * Scanning the whole history finds *a* change in every merchant — three
   * days of traffic always contains something — and those spurious points
   * scatter across days, which destroys the synchronisation test that the
   * network depends on. The question is not "did this rail ever change",
   * it is "did it change recently, and did it change together".
   */
  onsetLookbackHours: number;
}

export const DEFAULT_CONTRIBUTE_CONFIG: ContributeConfig = {
  postHours: 6,
  minRailN: 30,
  onsetLookbackHours: 12,
};

interface Bucket {
  method: PaymentMethod;
  issuer: Issuer;
  preN: number; preOk: number;
  postN: number; postOk: number;
  series: { total: number; ok: number }[];
}

/**
 * Reduce one merchant's events to per-rail signals.
 *
 * Rails are (method × issuer) only. Deliberately not device, geography,
 * value band or customer type: those are merchant-shaped dimensions, and
 * publishing them would start to describe the merchant's own business
 * rather than the shared infrastructure. Method and issuer are the only
 * dimensions that mean the same thing to everyone on the network.
 */
export function buildContribution(
  events: readonly PaymentEvent[],
  contributorId: string,
  config: ContributeConfig = DEFAULT_CONTRIBUTE_CONFIG,
): NetworkContribution {
  if (events.length === 0) {
    return { contributorId, windowEndTs: 0, rails: [] };
  }

  const minTs = events[0]!.ts;
  const maxTs = events[events.length - 1]!.ts;
  const splitTs = maxTs - config.postHours * HOUR;
  const buckets = Math.max(1, Math.ceil((maxTs - minTs) / HOUR));

  const rails = new Map<string, Bucket>();

  for (const e of events) {
    const key = `${e.method}:${e.issuer}`;
    let b = rails.get(key);
    if (!b) {
      b = {
        method: e.method, issuer: e.issuer,
        preN: 0, preOk: 0, postN: 0, postOk: 0,
        series: Array.from({ length: buckets }, () => ({ total: 0, ok: 0 })),
      };
      rails.set(key, b);
    }

    const ok = e.outcome === 'captured';
    if (e.ts < splitTs) {
      b.preN++;
      if (ok) b.preOk++;
    } else {
      b.postN++;
      if (ok) b.postOk++;
    }

    const idx = Math.min(buckets - 1, Math.floor((e.ts - minTs) / HOUR));
    const s = b.series[idx]!;
    s.total++;
    if (ok) s.ok++;
  }

  const out: RailSignal[] = [];
  for (const b of rails.values()) {
    if (b.postN < config.minRailN || b.preN < config.minRailN) continue;

    const t = twoProportion(b.postOk, b.postN, b.preOk, b.preN);

    // Locate onset locally. Sharing *when* it started is what lets the
    // network test synchronisation, and a timestamp rounded to the hour
    // reveals nothing about any individual payment.
    let onsetTs: number | null = null;
    const series: number[] = [];
    let last = 1;
    for (const s of b.series) {
      const r = s.total > 0 ? s.ok / s.total : last;
      last = r;
      series.push(r);
    }
    const lookback = Math.min(series.length, config.onsetLookbackHours);
    const startIdx = series.length - lookback;
    const recent = series.slice(startIdx);
    const cp = cusum(recent);
    if (cp) onsetTs = minTs + (startIdx + cp.index) * HOUR;

    out.push({
      method: b.method,
      issuer: b.issuer,
      z: t.z,
      diff: t.diff,
      n: b.postN,
      onsetTs,
    });
  }

  return { contributorId, windowEndTs: maxTs, rails: out };
}
