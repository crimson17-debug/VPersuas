/**
 * Projection from engine output to stored shapes, and the pooled
 * aggregates the incrementality view depends on.
 *
 * Pooling happens here, once, over every arm in the portfolio. Doing it
 * per run and summing produces a total whose standard error swamps the
 * effect — the same mistake the evaluation harness made in its first
 * version, and the reason both places now pool first and divide once.
 */

import { cohortLabel, type Intervention } from '../engine/types.js';
import { twoProportion } from '../engine/stats.js';
import type { BatchResult } from '../engine/runner/index.js';
import type {
  InterventionBreakdown, PooledLift, Portfolio, StoredDecision, StoredRun,
} from './types.js';

export interface RunContext {
  runId: string;
  nowTs: number;
  fromTs: number;
  toTs: number;
  eventCount: number;
  source: 'simulated' | 'razorpay_test' | 'mixed';
}

export function projectRun(batch: BatchResult, ctx: RunContext): StoredRun {
  const decisions: StoredDecision[] = batch.decisions.map((r) => {
    const v = r.verdict;
    const ranked = v.kind === 'diagnosed' ? v.ranked : v.ranked;

    return {
      id: r.decision.id,
      runId: ctx.runId,
      createdAt: r.decision.createdAt,

      cohort: r.detection.cohort,
      cohortLabel: cohortLabel(r.detection.cohort),
      onsetTs: r.detection.onsetTs,
      preRate: r.detection.preRate,
      postRate: r.detection.postRate,
      preN: r.detection.preN,
      postN: r.detection.postN,
      exposedPaise: r.detection.exposedPaise,

      verdictKind: v.kind,
      insufficientReason: v.kind === 'insufficient_evidence' ? v.reason : null,
      cause: r.decision.cause,
      causeWeight: r.decision.causeWeight,
      hypotheses: ranked.map((h) => ({
        cause: h.cause,
        weight: h.weight,
        effect: h.effect,
        ciLow: h.ciLow,
        ciHigh: h.ciHigh,
        evidenceFor: h.evidenceFor,
        evidenceAgainst: h.evidenceAgainst,
        controlLabel: h.controlLabel,
      })),

      // An acting decision whose every item was vetoed by a contact rule
      // did not act. Reporting it as ACT in the queue would overstate what
      // the engine did and hide the compliance gate doing its job.
      kind:
        (r.decision.kind === 'ACT' || r.decision.kind === 'WAIT') &&
        r.treatedN === 0 && r.blockedN > 0
          ? 'BLOCKED'
          : r.decision.kind,
      policyKind: r.decision.kind,
      intervention: r.decision.intervention,
      reason: r.decision.reason,
      options: r.decision.options,
      rejected: r.decision.rejected,
      exploreIntervention: r.decision.exploreIntervention ?? null,
      explorationNote: r.decision.explorationNote ?? null,

      itemCount: r.decision.itemCount,
      treatedN: r.treatedN,
      treatedRecovered: r.treatedRecovered,
      holdoutN: r.holdoutN,
      holdoutRecovered: r.holdoutRecovered,
      blockedN: r.blockedN,
      lift: r.lift
        ? { diff: r.lift.diff, low: r.lift.low, high: r.lift.high, significant: r.lift.significant }
        : null,
      grossRecoveredPaise: r.grossRecoveredPaise,
      incrementalPaise: r.incrementalPaise,
      incrementalLowPaise: r.incrementalLowPaise,
      incrementalHighPaise: r.incrementalHighPaise,
      spendPaise: r.spendPaise,
      netPaise: r.netPaise,

      outcomes: r.outcomes.map((o) => ({
        itemId: o.itemId,
        customerId: o.customerId,
        arm: o.arm,
        intervention: o.intervention,
        recovered: o.recovered,
        amountPaise: o.amountPaise,
        spendPaise: o.spendPaise,
        blockedBy: o.blockedBy,
        idempotencyKey: o.idempotencyKey,
      })),
    };
  });

  return {
    runId: ctx.runId,
    nowTs: ctx.nowTs,
    fromTs: ctx.fromTs,
    toTs: ctx.toTs,
    eventCount: ctx.eventCount,
    itemsConsidered: batch.totals.itemsConsidered,
    cohortsTested: batch.cohortsTested,
    zThreshold: batch.zThreshold,
    source: ctx.source,
    decisions,
    totals: {
      itemsActedOn: batch.totals.itemsActedOn,
      itemsHeldOut: batch.totals.itemsHeldOut,
      itemsBlocked: batch.totals.itemsBlocked,
      grossRecoveredPaise: batch.totals.grossRecoveredPaise,
      spendPaise: batch.totals.spendPaise,
    },
  };
}

/** Pool every arm in the portfolio into one lift estimate with one interval. */
export function poolLift(runs: readonly StoredRun[]): PooledLift {
  let treatedN = 0, treatedRecovered = 0, treatedAmountPaise = 0;
  let holdoutN = 0, holdoutRecovered = 0;
  let grossRecoveredPaise = 0, spendPaise = 0;

  for (const run of runs) {
    for (const d of run.decisions) {
      grossRecoveredPaise += d.grossRecoveredPaise;
      spendPaise += d.spendPaise;
      for (const o of d.outcomes) {
        if (o.arm === 'treated') {
          treatedN++;
          treatedAmountPaise += o.amountPaise;
          if (o.recovered) treatedRecovered++;
        } else if (o.arm !== 'unmanaged') {
          // Held-out and compliance-blocked items both received nothing,
          // which is exactly the observation the natural rate needs.
          holdoutN++;
          if (o.recovered) holdoutRecovered++;
        }
      }
    }
  }

  const avg = treatedN > 0 ? treatedAmountPaise / treatedN : 0;
  const empty: PooledLift = {
    treatedN, treatedRecovered, treatedAmountPaise, holdoutN, holdoutRecovered,
    treatedRate: 0, holdoutRate: 0, liftPp: 0, liftLow: 0, liftHigh: 0,
    significant: false, grossRecoveredPaise, incrementalPaise: 0,
    incrementalLowPaise: 0, incrementalHighPaise: 0, spendPaise,
    netPaise: -spendPaise, phantomShare: 0,
  };
  if (treatedN === 0 || holdoutN === 0) return empty;

  const t = twoProportion(treatedRecovered, treatedN, holdoutRecovered, holdoutN);
  const incrementalPaise = Math.round(t.diff * treatedN * avg);

  return {
    treatedN, treatedRecovered, treatedAmountPaise, holdoutN, holdoutRecovered,
    treatedRate: t.p1,
    holdoutRate: t.p2,
    liftPp: t.diff,
    liftLow: t.low,
    liftHigh: t.high,
    significant: t.significant,
    grossRecoveredPaise,
    incrementalPaise,
    incrementalLowPaise: Math.round(t.low * treatedN * avg),
    incrementalHighPaise: Math.round(t.high * treatedN * avg),
    spendPaise,
    netPaise: incrementalPaise - spendPaise,
    phantomShare: grossRecoveredPaise > 0
      ? Math.max(0, 1 - incrementalPaise / grossRecoveredPaise)
      : 0,
  };
}

/**
 * Lift per intervention, each against the pooled holdout.
 *
 * The holdout is shared rather than split per intervention: a held-out
 * item received nothing regardless of what the treated arm beside it got,
 * so every holdout observation informs every intervention's counterfactual.
 * Splitting it would throw away most of the control group.
 */
export function breakdownByIntervention(runs: readonly StoredRun[]): InterventionBreakdown[] {
  const treated = new Map<Intervention, { n: number; k: number; amount: number; spend: number }>();
  let holdoutN = 0, holdoutRecovered = 0;

  for (const run of runs) {
    for (const d of run.decisions) {
      for (const o of d.outcomes) {
        if (o.arm === 'treated') {
          const c = treated.get(o.intervention) ?? { n: 0, k: 0, amount: 0, spend: 0 };
          c.n++;
          c.amount += o.amountPaise;
          c.spend += o.spendPaise;
          if (o.recovered) c.k++;
          treated.set(o.intervention, c);
        } else if (o.arm !== 'unmanaged') {
          holdoutN++;
          if (o.recovered) holdoutRecovered++;
        }
      }
    }
  }

  const out: InterventionBreakdown[] = [];
  for (const [intervention, c] of treated) {
    if (c.n === 0) continue;
    const t = twoProportion(c.k, c.n, holdoutRecovered, holdoutN);
    const avg = c.amount / c.n;
    const incrementalPaise = Math.round(t.diff * c.n * avg);
    out.push({
      intervention,
      treatedN: c.n,
      treatedRecovered: c.k,
      holdoutN,
      holdoutRecovered,
      liftPp: t.diff,
      liftLow: t.low,
      liftHigh: t.high,
      significant: t.significant,
      spendPaise: c.spend,
      incrementalPaise,
      netPaise: incrementalPaise - c.spend,
    });
  }

  return out.sort((a, b) => b.netPaise - a.netPaise);
}

/** Compliance rules that fired, counted across the portfolio. */
export function countBlockedByRule(runs: readonly StoredRun[]): { rule: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (const d of run.decisions) {
      for (const o of d.outcomes) {
        for (const b of o.blockedBy) {
          const rule = b.split(':')[0]!.trim();
          counts.set(rule, (counts.get(rule) ?? 0) + 1);
        }
      }
    }
  }
  return [...counts].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count);
}

export function buildPortfolio(
  runs: StoredRun[],
  priors: { treated: number; holdout: number },
): Portfolio {
  return {
    generatedAt: Date.now(),
    runs,
    pooled: poolLift(runs),
    byIntervention: breakdownByIntervention(runs),
    priors,
    blockedByRule: countBlockedByRule(runs),
  };
}
