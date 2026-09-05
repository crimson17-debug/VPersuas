/**
 * Metric accumulation and formatting.
 *
 * Every rate reported here is accompanied by the counts it came from, so a
 * reader can tell the difference between 100% of four and 100% of four
 * hundred.
 */

import type { CauseType } from '../engine/types.js';
import {
  brier, calibration, expectedCalibrationError, twoProportion, wilson,
  type CalibrationBin,
} from '../engine/stats.js';

export interface ScenarioRecord {
  id: string;
  kind: 'incident' | 'null' | 'ambiguous';
  trueCause: CauseType | null;
  detected: boolean;
  diagnosed: boolean;
  topCause: CauseType | null;
  topWeight: number | null;
  rankedCauses: CauseType[];
  decisionKinds: string[];
  actedAtAll: boolean;
  grossRecoveredPaise: number;
  incrementalPaise: number;
  spendPaise: number;
  netPaise: number;
  itemsConsidered: number;
  itemsActedOn: number;
  itemsBlocked: number;
  elapsedMs: number;
  /**
   * Arm-level counts, pooled across every decision in the window.
   *
   * Incremental value is computed from these at the run level rather than
   * per decision. A single window's holdout is 20-30 items, so the lift
   * measured inside one decision is mostly noise; summing 140 noisy
   * estimates gives a total with a standard error of lakhs. Pooling first
   * and dividing once gives one estimate with one honest interval.
   */
  treatedN: number;
  treatedRecovered: number;
  treatedAmountPaise: number;
  holdoutN: number;
  holdoutRecovered: number;
}

export interface DetectionMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  falsePositiveRateOnNulls: number;
  nullWindows: number;
}

export function detectionMetrics(records: readonly ScenarioRecord[]): DetectionMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let nulls = 0, nullsFired = 0;

  for (const r of records) {
    const hasIncident = r.kind !== 'null';
    if (r.kind === 'null') {
      nulls++;
      if (r.detected) nullsFired++;
    }
    if (hasIncident && r.detected) tp++;
    else if (hasIncident && !r.detected) fn++;
    else if (!hasIncident && r.detected) fp++;
    else tn++;
  }

  return {
    truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn,
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    falsePositiveRateOnNulls: nulls > 0 ? nullsFired / nulls : 0,
    nullWindows: nulls,
  };
}

export interface RootCauseMetrics {
  considered: number;
  diagnosed: number;
  abstained: number;
  top1: number;
  top3: number;
  top1Rate: number;
  top3Rate: number;
  /** Accuracy over the cases where a call was actually made. */
  top1RateWhenDiagnosed: number;
  confusion: Map<string, number>;
}

/**
 * Root-cause accuracy over single-cause windows only.
 *
 * Ambiguous windows are excluded on purpose: they contain two simultaneous
 * causes, so "correct" is not a cause at all — it is abstention, which is
 * scored separately. Counting them here would reward a confident guess
 * that happened to match the larger of two incidents.
 */
export function rootCauseMetrics(records: readonly ScenarioRecord[]): RootCauseMetrics {
  const relevant = records.filter(
    (r) => r.trueCause !== null && r.detected && r.kind === 'incident',
  );
  let diagnosed = 0, abstained = 0, top1 = 0, top3 = 0;
  const confusion = new Map<string, number>();

  for (const r of relevant) {
    if (!r.diagnosed) { abstained++; continue; }
    diagnosed++;
    if (r.topCause === r.trueCause) top1++;
    else confusion.set(`${r.trueCause} → ${r.topCause}`, (confusion.get(`${r.trueCause} → ${r.topCause}`) ?? 0) + 1);
    if (r.rankedCauses.slice(0, 3).includes(r.trueCause as CauseType)) top3++;
  }

  return {
    considered: relevant.length,
    diagnosed, abstained, top1, top3,
    top1Rate: relevant.length > 0 ? top1 / relevant.length : 0,
    top3Rate: relevant.length > 0 ? top3 / relevant.length : 0,
    top1RateWhenDiagnosed: diagnosed > 0 ? top1 / diagnosed : 0,
    confusion,
  };
}

export interface AbstentionMetrics {
  nullWindows: number;
  nullWindowsLeftAlone: number;
  nullSilenceRate: number;
  ambiguousWindows: number;
  ambiguousAbstained: number;
  ambiguousAbstentionRate: number;
}

export function abstentionMetrics(records: readonly ScenarioRecord[]): AbstentionMetrics {
  const nulls = records.filter((r) => r.kind === 'null');
  const ambiguous = records.filter((r) => r.kind === 'ambiguous');
  const nullQuiet = nulls.filter((r) => !r.actedAtAll).length;
  const ambAbstained = ambiguous.filter((r) => r.detected && !r.diagnosed).length;

  return {
    nullWindows: nulls.length,
    nullWindowsLeftAlone: nullQuiet,
    nullSilenceRate: nulls.length > 0 ? nullQuiet / nulls.length : 0,
    ambiguousWindows: ambiguous.length,
    ambiguousAbstained: ambAbstained,
    ambiguousAbstentionRate: ambiguous.length > 0 ? ambAbstained / ambiguous.length : 0,
  };
}

export interface CalibrationMetrics {
  bins: CalibrationBin[];
  brier: number;
  ece: number;
  n: number;
}

export function calibrationMetrics(records: readonly ScenarioRecord[]): CalibrationMetrics {
  const preds = records
    .filter((r) => r.diagnosed && r.topWeight !== null && r.trueCause !== null && r.kind === 'incident')
    .map((r) => ({ p: r.topWeight!, correct: r.topCause === r.trueCause }));

  return {
    bins: calibration(preds, 5),
    brier: brier(preds),
    ece: expectedCalibrationError(preds, 5),
    n: preds.length,
  };
}

export interface EconomicTotals {
  grossRecoveredPaise: number;
  /** Pooled point estimate of value actually caused. */
  incrementalPaise: number;
  incrementalLowPaise: number;
  incrementalHighPaise: number;
  spendPaise: number;
  netPaise: number;
  netLowPaise: number;
  itemsConsidered: number;
  itemsActedOn: number;
  itemsBlocked: number;
  /** Share of the gross figure that the holdout says was never caused. */
  phantomShare: number;
  treatedRate: number;
  holdoutRate: number;
  liftPp: number;
  liftSignificant: boolean;
  treatedN: number;
  holdoutN: number;
}

export function economicTotals(records: readonly ScenarioRecord[]): EconomicTotals {
  let grossRecoveredPaise = 0, spendPaise = 0;
  let itemsConsidered = 0, itemsActedOn = 0, itemsBlocked = 0;
  let treatedN = 0, treatedRecovered = 0, treatedAmountPaise = 0;
  let holdoutN = 0, holdoutRecovered = 0;

  for (const r of records) {
    grossRecoveredPaise += r.grossRecoveredPaise;
    spendPaise += r.spendPaise;
    itemsConsidered += r.itemsConsidered;
    itemsActedOn += r.itemsActedOn;
    itemsBlocked += r.itemsBlocked;
    treatedN += r.treatedN;
    treatedRecovered += r.treatedRecovered;
    treatedAmountPaise += r.treatedAmountPaise;
    holdoutN += r.holdoutN;
    holdoutRecovered += r.holdoutRecovered;
  }

  const avgTreatedAmount = treatedN > 0 ? treatedAmountPaise / treatedN : 0;

  let incrementalPaise = 0, incrementalLowPaise = 0, incrementalHighPaise = 0;
  let treatedRate = 0, holdoutRate = 0, liftPp = 0, liftSignificant = false;

  if (treatedN > 0 && holdoutN > 0) {
    const lift = twoProportion(treatedRecovered, treatedN, holdoutRecovered, holdoutN);
    treatedRate = lift.p1;
    holdoutRate = lift.p2;
    liftPp = lift.diff;
    liftSignificant = lift.significant;
    incrementalPaise = Math.round(lift.diff * treatedN * avgTreatedAmount);
    incrementalLowPaise = Math.round(lift.low * treatedN * avgTreatedAmount);
    incrementalHighPaise = Math.round(lift.high * treatedN * avgTreatedAmount);
  }

  const phantom = grossRecoveredPaise > 0
    ? Math.max(0, 1 - incrementalPaise / grossRecoveredPaise)
    : 0;

  return {
    grossRecoveredPaise,
    incrementalPaise, incrementalLowPaise, incrementalHighPaise,
    spendPaise,
    netPaise: incrementalPaise - spendPaise,
    netLowPaise: incrementalLowPaise - spendPaise,
    itemsConsidered, itemsActedOn, itemsBlocked,
    phantomShare: phantom,
    treatedRate, holdoutRate, liftPp, liftSignificant,
    treatedN, holdoutN,
  };
}

/** Recall broken out by true cause — an aggregate can hide a blind spot. */
export function recallByCause(records: readonly ScenarioRecord[]): Map<string, { detected: number; total: number }> {
  const out = new Map<string, { detected: number; total: number }>();
  for (const r of records) {
    if (r.kind !== 'incident' || !r.trueCause) continue;
    const e = out.get(r.trueCause) ?? { detected: 0, total: 0 };
    e.total++;
    if (r.detected) e.detected++;
    out.set(r.trueCause, e);
  }
  return out;
}

/* ---------------------------- formatting ---------------------------- */

export function money(paise: number): string {
  const r = paise / 100;
  const sign = r < 0 ? '-' : '';
  const a = Math.abs(r);
  if (a >= 100000) return `${sign}₹${(a / 100000).toFixed(2)}L`;
  if (a >= 1000) return `${sign}₹${(a / 1000).toFixed(1)}k`;
  return `${sign}₹${a.toFixed(0)}`;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** Rate with its Wilson interval — a rate over 12 windows is not a rate. */
export function rateWithCi(k: number, n: number): string {
  if (n === 0) return 'n/a';
  const w = wilson(k, n);
  return `${pct(w.point)} (${k}/${n}, 95% CI ${pct(w.low)}–${pct(w.high)})`;
}
