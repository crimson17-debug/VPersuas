/**
 * The decision policy.
 *
 * Five outcomes, four of which are not "act":
 *
 *   ACT         a positive lower bound on net value, and the gate agrees
 *   WAIT        the best action is to delay, not to do nothing forever
 *   EXPERIMENT  material money at stake, but the evidence cannot justify
 *               a choice yet — spend a small randomised test instead
 *   DO_NOT_ACT  no intervention clears zero net value
 *   BLOCKED     economics approved, compliance vetoed
 *
 * The decision rule is deliberately conservative: it requires the LOWER
 * bound of estimated net value to be positive, not the point estimate.
 * Acting on a point estimate means acting half the time on noise, and the
 * cost of that shows up as real money spent on nudges that did nothing.
 */

import type {
  AtRiskItem, Decision, DiagnosisVerdict, Detection, Intervention, ScoredOption,
} from '../types.js';
import { CAUSE_LABEL, INTERVENTIONS, INTERVENTION_LABEL } from '../types.js';
import { CONDITIONAL_COST_RATE, DECISION_COST_PAISE, FIXED_COST_PAISE, REVERSIBLE } from './costs.js';
import type { PriorStore } from './priors.js';

export interface PolicyConfig {
  /** Treated-arm observations required before an estimate can be acted on. */
  minSamples: number;
  /** Exposed value above which unresolved evidence justifies an experiment. */
  experimentThresholdPaise: number;
  /** Causes where the right first move is to wait for the rail to recover. */
  infrastructureCauses: string[];
  /**
   * Observations beyond which an option counts as well understood and stops
   * attracting exploration budget.
   */
  wellUnderstoodSamples: number;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  // A floor, not the real gate. The real gate is that the lower bound of
  // net value must be positive, which already handles uncertainty. This
  // just stops the policy reasoning about a proportion measured on six
  // observations, where the interval is technically correct and useless.
  minSamples: 15,
  experimentThresholdPaise: 2_000_000, // ₹20,000
  infrastructureCauses: ['issuer_degradation', 'gateway_degradation', 'retry_timing'],
  wellUnderstoodSamples: 120,
};

export interface PolicyInput {
  detection: Detection;
  verdict: DiagnosisVerdict;
  items: readonly AtRiskItem[];
  priors: PriorStore;
  nowTs: number;
  decisionId: string;
  config?: PolicyConfig;
}

function money(paise: number): string {
  const r = paise / 100;
  if (Math.abs(r) >= 100000) return `₹${(r / 100000).toFixed(2)}L`;
  if (Math.abs(r) >= 1000) return `₹${(r / 1000).toFixed(1)}k`;
  return `₹${r.toFixed(0)}`;
}

export function decide(input: PolicyInput): Decision {
  const cfg = input.config ?? DEFAULT_POLICY_CONFIG;
  const { detection, verdict, items, priors, nowTs, decisionId } = input;

  const n = items.length;
  const avgAmount = n > 0 ? items.reduce((s, i) => s + i.amountPaise, 0) / n : 0;

  const base = {
    id: decisionId,
    cohort: detection.cohort,
    itemCount: n,
    createdAt: nowTs,
    blockedBy: [] as string[],
    options: [] as ScoredOption[],
    rejected: [] as { intervention: Intervention; why: string }[],
  };

  // ---- No cause established ------------------------------------------
  if (verdict.kind === 'insufficient_evidence') {
    const worthTesting = detection.exposedPaise >= cfg.experimentThresholdPaise;
    return {
      ...base,
      kind: worthTesting ? 'EXPERIMENT' : 'DO_NOT_ACT',
      intervention: 'none',
      cause: null,
      causeWeight: null,
      reason: worthTesting
        ? `${verdict.reason}. ${money(detection.exposedPaise)} is at stake, which justifies a ` +
          `small randomised test to buy the evidence rather than guessing.`
        : `${verdict.reason}. ${money(detection.exposedPaise)} at stake does not justify ` +
          `spending to find out.`,
    };
  }

  const cause = verdict.top.cause;
  const causeWeight = verdict.top.weight;

  // ---- Score every candidate intervention -----------------------------
  const options: ScoredOption[] = [];
  const rejected: { intervention: Intervention; why: string }[] = [];

  // Candidates the exploration budget could usefully be spent on: not yet
  // well understood, and optimistically worth something. Ranked by upper
  // confidence bound, which is what makes an untried option attractive
  // precisely because nothing is known about it.
  const explorationCandidates: { intervention: Intervention; optimisticNet: number; n: number }[] = [];

  for (const intervention of INTERVENTIONS) {
    if (intervention === 'none') continue;

    const est = priors.estimate(cause, intervention);

    if (est.n < cfg.wellUnderstoodSamples) {
      const optimisticValue = Math.round(Math.min(est.high, 0.4) * n * avgAmount);
      const optimisticCost =
        DECISION_COST_PAISE[intervention] +
        FIXED_COST_PAISE[intervention] * n +
        CONDITIONAL_COST_RATE[intervention] * avgAmount * Math.max(est.pTreated, 0.3) * n;
      explorationCandidates.push({
        intervention,
        optimisticNet: optimisticValue - optimisticCost,
        n: est.n,
      });
    }

    if (est.n < cfg.minSamples) {
      rejected.push({
        intervention,
        why: `only ${est.n} prior observations for ${CAUSE_LABEL[cause]} ` +
             `(${cfg.minSamples} required before acting on an estimate)`,
      });
      continue;
    }

    const fixed = FIXED_COST_PAISE[intervention] * n + DECISION_COST_PAISE[intervention];
    const conditional = CONDITIONAL_COST_RATE[intervention] * avgAmount * est.pTreated * n;
    const expectedCostPaise = Math.round(fixed + conditional);

    const expectedValuePaise = Math.round(est.lift * n * avgAmount);
    const netPaise = expectedValuePaise - expectedCostPaise;
    const netLowPaise = Math.round(est.low * n * avgAmount) - expectedCostPaise;

    options.push({
      intervention,
      pNatural: est.pNatural,
      pTreated: est.pTreated,
      liftLow: est.low,
      lift: est.lift,
      liftHigh: est.high,
      n: est.n,
      expectedValuePaise,
      expectedCostPaise,
      netPaise,
      netLowPaise,
    });
  }

  options.sort((a, b) => b.netPaise - a.netPaise);

  // Coverage first, optimism second. Ranking exploration purely by
  // optimistic net degenerates immediately: with no observations every
  // option has the same wide upper bound, so the ranking collapses to
  // "whichever is cheapest" and the budget pours into one cheap option
  // forever. Spending it on the least-observed option that could still be
  // worth something gives every candidate its turn.
  const explore = explorationCandidates
    .filter((c) => c.optimisticNet > 0)
    .sort((a, b) => a.n - b.n || b.optimisticNet - a.optimisticNet)[0];
  const exploreFields = explore
    ? {
        exploreIntervention: explore.intervention,
        explorationNote:
          `A slice is reserved for ${INTERVENTION_LABEL[explore.intervention].toLowerCase()}: ` +
          `${explore.n} observations so far, optimistic net ${money(explore.optimisticNet)}. ` +
          `Untried options look attractive because nothing rules them out yet, which is the ` +
          `point — the alternative is never discovering a better one.`,
      }
    : {};

  // Nothing measurable at all — buy evidence if it is worth buying.
  if (options.length === 0) {
    const worthTesting = detection.exposedPaise >= cfg.experimentThresholdPaise;
    return {
      ...base,
      options, rejected,
      ...exploreFields,
      kind: worthTesting ? 'EXPERIMENT' : 'DO_NOT_ACT',
      intervention: 'none',
      cause, causeWeight,
      reason: worthTesting
        ? `${CAUSE_LABEL[cause]} identified, but no intervention has enough history to ` +
          `estimate its effect. Running a randomised test on a small slice.`
        : `${CAUSE_LABEL[cause]} identified, but no intervention has enough history and the ` +
          `${money(detection.exposedPaise)} at stake does not justify buying evidence.`,
    };
  }

  const actionable = options.filter((o) => o.netLowPaise > 0);

  for (const o of options) {
    if (o.netLowPaise > 0) continue;
    const grossPositive = o.expectedValuePaise > o.expectedCostPaise;
    rejected.push({
      intervention: o.intervention,
      why: grossPositive
        ? `point estimate is positive (${money(o.netPaise)}) but the lower bound is ` +
          `${money(o.netLowPaise)} — not confident enough to spend`
        : o.expectedCostPaise > o.expectedValuePaise && CONDITIONAL_COST_RATE[o.intervention] > 0
          ? `recovers ${money(o.expectedValuePaise)} but costs ${money(o.expectedCostPaise)}, ` +
            `because the discount is paid on every recovery including the ` +
            `${Math.round(o.pNatural * 100)}% that would have paid anyway`
          : `estimated lift ${(o.lift * 100).toFixed(1)}pp does not cover ` +
            `${money(o.expectedCostPaise)} of cost`,
    });
  }

  if (actionable.length === 0) {
    const best = options[0]!;
    return {
      ...base,
      ...exploreFields,
      options, rejected,
      kind: 'DO_NOT_ACT',
      intervention: 'none',
      cause, causeWeight,
      reason:
        `${CAUSE_LABEL[cause]} identified with ${Math.round(causeWeight * 100)}% of the evidence ` +
        `weight, but no intervention clears zero net value. The best available ` +
        `(${INTERVENTION_LABEL[best.intervention].toLowerCase()}) has a lower bound of ` +
        `${money(best.netLowPaise)}. Doing nothing is worth more than acting.`,
    };
  }

  const best = actionable[0]!;

  // ---- Waiting is an action ------------------------------------------
  if (best.intervention === 'wait_and_retry') {
    const immediate = options.find((o) => o.intervention === 'immediate_retry');
    const comparison = immediate
      ? ` Retrying now is estimated at ${money(immediate.netPaise)} against ` +
        `${money(best.netPaise)} for waiting.`
      : '';
    return {
      ...base,
      ...exploreFields,
      options, rejected,
      kind: 'WAIT',
      intervention: 'wait_and_retry',
      cause, causeWeight,
      reason:
        `${CAUSE_LABEL[cause]} is an infrastructure fault, not customer abandonment. ` +
        `Delaying the retry until the rail recovers is worth ${money(best.netPaise)} ` +
        `(lower bound ${money(best.netLowPaise)}).${comparison}`,
    };
  }

  const runnerUp = actionable[1];
  const margin = runnerUp
    ? ` Next best is ${INTERVENTION_LABEL[runnerUp.intervention].toLowerCase()} at ` +
      `${money(runnerUp.netPaise)}.`
    : '';

  return {
    ...base,
    ...exploreFields,
    options, rejected,
    kind: 'ACT',
    intervention: best.intervention,
    cause, causeWeight,
    reason:
      `${CAUSE_LABEL[cause]} (${Math.round(causeWeight * 100)}% of evidence weight). ` +
      `${INTERVENTION_LABEL[best.intervention]} — estimated lift ` +
      `${(best.lift * 100).toFixed(1)}pp (95% CI ${(best.liftLow * 100).toFixed(1)}–` +
      `${(best.liftHigh * 100).toFixed(1)}pp) on ${n} items, net ${money(best.netPaise)} ` +
      `with a lower bound of ${money(best.netLowPaise)}.` +
      `${REVERSIBLE[best.intervention] ? '' : ' Not reversible once sent.'}${margin}`,
  };
}
