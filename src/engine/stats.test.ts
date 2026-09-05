import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  brier, calibration, cusum, differenceInDifferences, expectedCalibrationError,
  normalCdf, sidakAlpha, twoProportion, wilson, zForTwoSidedAlpha,
} from './stats.js';

const close = (a: number, b: number, tol = 1e-3) =>
  assert.ok(Math.abs(a - b) < tol, `${a} not within ${tol} of ${b}`);

test('normalCdf matches known values', () => {
  close(normalCdf(0), 0.5);
  close(normalCdf(1.96), 0.975, 2e-3);
  close(normalCdf(-1.96), 0.025, 2e-3);
});

test('zForTwoSidedAlpha inverts the two-sided p-value', () => {
  close(zForTwoSidedAlpha(0.05), 1.96, 5e-3);
  close(zForTwoSidedAlpha(0.01), 2.576, 5e-3);
});

test('sidak correction tightens with more tests', () => {
  assert.equal(sidakAlpha(0.05, 1), 0.05);
  assert.ok(sidakAlpha(0.05, 500) < 0.0002);
  // The whole point: a 500-cohort scan must clear a much higher bar than
  // a single test, or one in twenty windows fires on noise.
  assert.ok(zForTwoSidedAlpha(sidakAlpha(0.05, 500)) > 3.8);
});

test('wilson interval stays inside [0,1] at the extremes', () => {
  const zero = wilson(0, 30);
  assert.ok(zero.low >= 0 && zero.high <= 1 && zero.high > 0);
  const all = wilson(30, 30);
  assert.ok(all.low < 1 && all.high <= 1);
  // The normal approximation would give [1, 1] here and claim certainty
  // from thirty observations, which is why this uses Wilson.
  assert.ok(all.low < 0.95);
});

test('wilson handles n = 0 without dividing by zero', () => {
  const none = wilson(0, 0);
  assert.equal(none.low, 0);
  assert.equal(none.high, 1);
});

test('twoProportion detects a real difference and ignores a small one', () => {
  const real = twoProportion(620, 1000, 410, 1000);
  close(real.diff, 0.21, 1e-6);
  assert.ok(real.significant);
  assert.ok(real.low > 0);

  const noise = twoProportion(52, 100, 48, 100);
  assert.ok(!noise.significant, 'a 4pp difference on n=100 is not significant');
  assert.ok(noise.low < 0 && noise.high > 0);
});

test('twoProportion interval widens as sample shrinks', () => {
  const big = twoProportion(600, 1000, 500, 1000);
  const small = twoProportion(60, 100, 50, 100);
  close(big.diff, small.diff, 1e-9);
  assert.ok(small.high - small.low > big.high - big.low);
});

test('difference-in-differences nets out a shared shock', () => {
  // Both cohorts drop 10pp. Nothing is specific to the treated cohort, so
  // the estimated effect must be zero, not -10pp.
  const shared = differenceInDifferences(
    900, 1000, 800, 1000,
    900, 1000, 800, 1000,
  );
  close(shared.effect, 0, 1e-9);
  assert.ok(!shared.significant);

  // Treated drops 20pp while control drops 5pp: a 15pp specific effect.
  const specific = differenceInDifferences(
    900, 1000, 700, 1000,
    900, 1000, 850, 1000,
  );
  close(specific.effect, -0.15, 1e-9);
  assert.ok(specific.significant);
  assert.ok(specific.high < 0);
});

test('cusum locates a step change and ignores flat noise', () => {
  const flat = [0.91, 0.92, 0.90, 0.91, 0.92, 0.91, 0.90, 0.92, 0.91, 0.90];
  assert.equal(cusum(flat), null, 'no change point in a flat series');

  const stepped = [
    0.91, 0.92, 0.90, 0.91, 0.92, 0.91,
    0.62, 0.60, 0.61, 0.59, 0.60, 0.62,
  ];
  const cp = cusum(stepped);
  assert.ok(cp !== null);
  assert.ok(cp!.index >= 4 && cp!.index <= 7, `onset at index ${cp!.index}, expected near 6`);
});

test('cusum refuses to guess on a series too short to have a trend', () => {
  assert.equal(cusum([0.9, 0.8, 0.7]), null);
});

test('brier rewards confident correct predictions', () => {
  const confidentRight = brier([{ p: 0.95, correct: true }, { p: 0.9, correct: true }]);
  const hedging = brier([{ p: 0.5, correct: true }, { p: 0.5, correct: true }]);
  const confidentWrong = brier([{ p: 0.95, correct: false }, { p: 0.9, correct: false }]);
  assert.ok(confidentRight < hedging);
  assert.ok(hedging < confidentWrong);
});

test('calibration bins report observed accuracy', () => {
  const preds = [
    { p: 0.9, correct: true }, { p: 0.9, correct: true },
    { p: 0.9, correct: true }, { p: 0.9, correct: false },
  ];
  const bins = calibration(preds, 5);
  const top = bins[4]!;
  assert.equal(top.n, 4);
  close(top.observed, 0.75);
  // Stated 90%, observed 75% — a 15-point gap the ECE should surface.
  close(expectedCalibrationError(preds, 5), 0.15, 1e-6);
});
