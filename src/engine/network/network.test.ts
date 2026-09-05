import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { assessNetwork, DEFAULT_NETWORK_CONFIG } from './index.js';
import { heterogeneity, onsetSpreadMinutes, stouffer } from './meta.js';
import type { NetworkContribution, RailSignal } from './types.js';

const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);

function rail(z: number, n = 120, diff = -0.2, onsetTs: number | null = T0): RailSignal {
  return { method: 'upi', issuer: 'bank_hdfc', z, diff, n, onsetTs };
}

function fleet(
  signals: readonly RailSignal[],
  prefix = 'm',
): NetworkContribution[] {
  return signals.map((r, i) => ({
    contributorId: `${prefix}${i}`,
    windowEndTs: T0,
    rails: [r],
  }));
}

test('stouffer combines same-direction evidence into a stronger signal', () => {
  const weak = [-1.5, -1.4, -1.6, -1.5].map((z) => ({ z, n: 100 }));
  const combined = stouffer(weak)!;
  // Four independent near-misses are together far past any single one.
  assert.ok(combined.z < -2.9, `expected strong combined z, got ${combined.z}`);
  assert.ok(combined.p < 0.005);
});

test('stouffer weights by sqrt(n), so a large contributor counts more', () => {
  const balanced = stouffer([{ z: -4, n: 100 }, { z: 0, n: 100 }])!;
  const bigNegative = stouffer([{ z: -4, n: 10_000 }, { z: 0, n: 100 }])!;
  assert.ok(
    bigNegative.z < balanced.z,
    'a high-volume degraded contributor should pull the pool further down',
  );
});

test('stouffer cancels opposing evidence rather than accumulating it', () => {
  const opposed = stouffer([{ z: -3, n: 100 }, { z: 3, n: 100 }])!;
  assert.ok(Math.abs(opposed.z) < 0.001, `expected ~0, got ${opposed.z}`);
});

test('heterogeneity separates agreeing contributors from one outlier', () => {
  const agreeing = heterogeneity(
    [-0.20, -0.19, -0.21, -0.20].map((effect) => ({ effect, variance: 0.001 })),
  )!;
  const outlier = heterogeneity(
    [-0.60, -0.01, 0.00, -0.01].map((effect) => ({ effect, variance: 0.001 })),
  )!;
  assert.ok(agreeing.iSquared < 0.3, `agreeing I² too high: ${agreeing.iSquared}`);
  assert.ok(outlier.iSquared > 0.9, `outlier I² too low: ${outlier.iSquared}`);
});

test('onset spread uses the IQR, so two bad estimates cannot widen it', () => {
  const tight = Array.from({ length: 20 }, (_, i) => T0 + i * 60_000);
  const withOutliers = [...tight, T0 - 40 * 3_600_000, T0 + 40 * 3_600_000];
  const a = onsetSpreadMinutes(tight)!;
  const b = onsetSpreadMinutes(withOutliers)!;
  // Two wild estimates out of 22 must not triple the reported spread.
  assert.ok(b < a * 3, `outliers dominated the spread: ${a} -> ${b}`);
});

test('a rail below the k-anonymity floor is withheld entirely', () => {
  const contributions = fleet([rail(-6), rail(-5), rail(-7)]); // 3 < k=5
  const out = assessNetwork(contributions, T0);
  const f = out.findings[0]!;
  assert.equal(f.verdict, 'below_k_anonymity');
  // Nothing derived from the underlying data may leak through the envelope.
  assert.equal(f.combinedZ, 0);
  assert.equal(f.pooledDiff, 0);
  assert.equal(f.degradedCount, 0);
});

test('a fleet-wide degradation is confirmed as an issuer event', () => {
  const contributions = fleet(
    Array.from({ length: 12 }, (_, i) => rail(-5 - (i % 3), 150, -0.18, T0 + i * 60_000)),
  );
  const out = assessNetwork(contributions, T0);
  const f = out.findings[0]!;
  assert.equal(f.verdict, 'issuer_confirmed');
  assert.equal(f.contributors, 12);
  assert.equal(f.degradedCount, 12);
  assert.ok(f.confidence > 0.7, `confidence too low: ${f.confidence}`);
});

test('one broken merchant among healthy ones is ruled merchant-specific', () => {
  // The outlier is both extreme and high-volume — the exact shape that
  // drags a pooled average and would fool a mean-based implementation.
  const contributions = fleet([
    rail(-30, 20_000, -0.62),
    ...Array.from({ length: 11 }, () => rail(0.1, 150, 0.0)),
  ]);
  const out = assessNetwork(contributions, T0);
  const f = out.findings[0]!;

  assert.ok(
    f.combinedZ < -2,
    'the pooled statistic should indeed look significant — that is the trap',
  );
  assert.equal(f.verdict, 'merchant_specific');
  assert.equal(f.degradedCount, 1);
  assert.equal(f.confidence, 0);
});

test('a quiet rail with quorum reports no signal, not a fault', () => {
  const contributions = fleet(Array.from({ length: 10 }, () => rail(0.3, 150, 0.001)));
  const out = assessNetwork(contributions, T0);
  const f = out.findings[0]!;
  // Everyone is fine, so "the rail is healthy" is the honest reading.
  assert.equal(f.verdict, 'merchant_specific');
  assert.equal(f.degradedCount, 0);
});

test('a contributor cannot manufacture a quorum by resubmitting', () => {
  const repeated: NetworkContribution[] = Array.from({ length: 9 }, () => ({
    contributorId: 'same-merchant',
    windowEndTs: T0,
    rails: [rail(-8)],
  }));
  const out = assessNetwork(repeated, T0);
  const f = out.findings[0]!;
  assert.equal(f.contributors, 1);
  assert.equal(f.verdict, 'below_k_anonymity');
});

test('contributors below the sample floor are not admitted', () => {
  const contributions = fleet(
    Array.from({ length: 10 }, () => rail(-9, DEFAULT_NETWORK_CONFIG.minContributorN - 1)),
  );
  const out = assessNetwork(contributions, T0);
  assert.equal(out.findings.length, 0, 'thin contributors should not form a rail at all');
});
