/**
 * THE HIDDEN WORLD MODEL — ground truth.
 *
 * ============================ BOUNDARY ============================
 * Nothing under src/engine/{detector,diagnosis,policy,runner} may import
 * this file. The engine must estimate everything in here from observed
 * data; if it could read the table it would score perfectly and the
 * evaluation would be meaningless.
 *
 * `npm run check:boundaries` enforces this and fails the build.
 * ==================================================================
 *
 * This file is the environment: it decides what actually happens when an
 * intervention is applied. The engine's job is to infer these numbers from
 * observed outcomes, with uncertainty, and to refuse to act when it cannot.
 */

import type { CauseType, FailureReason, Intervention } from '../types.js';
import type { Rng } from '../rng.js';
import { FIXED_COST_PAISE as FIXED, CONDITIONAL_COST_RATE as CONDITIONAL } from '../policy/costs.js';

/**
 * True recovery probability with no intervention, per underlying cause.
 *
 * This is the number that makes gross recovery figures dishonest. When
 * 42% of payments hit by an issuer wobble recover on their own, a system
 * that intervenes on all of them and reports "62% recovered" is claiming
 * credit for 42 points it did not create.
 */
const P_NATURAL: Record<CauseType, number> = {
  issuer_degradation: 0.42,
  gateway_degradation: 0.38,
  checkout_regression: 0.28,
  method_mismatch: 0.34,
  retry_timing: 0.36,
  customer_abandonment: 0.19,
};

/** Baseline natural recovery when nothing is actually wrong (null windows). */
export const P_NATURAL_BASELINE = 0.44;

/**
 * True additive uplift of each intervention over the natural rate, per cause.
 *
 * The structure here is what makes the problem non-trivial and the
 * abstention behaviour correct rather than lucky:
 *
 *  - Nudging an infrastructure failure is near-useless (+0.02). The customer
 *    did not abandon; the rail was down. Spending on a nudge here is waste,
 *    so the right decision is DO_NOT_ACT.
 *  - Retrying immediately during issuer degradation is actively NEGATIVE
 *    (-0.04): it burns the attempt against a rail that is still down. The
 *    right decision is WAIT.
 *  - Discounting recovers the most gross volume almost everywhere, and loses
 *    money on net nearly everywhere, because the discount is paid on every
 *    recovery including the ones that would have happened anyway.
 *  - Nudging genuine abandonment works (+0.17). This is the one case where
 *    the obvious action is the right action.
 */
const UPLIFT: Record<CauseType, Record<Intervention, number>> = {
  issuer_degradation: {
    none: 0, alternate_method: 0.24, wait_and_retry: 0.20, immediate_retry: -0.04,
    nudge: 0.02, discount_nudge: 0.04, checkout_rollback: 0.00,
  },
  gateway_degradation: {
    none: 0, alternate_method: 0.26, wait_and_retry: 0.18, immediate_retry: -0.03,
    nudge: 0.01, discount_nudge: 0.03, checkout_rollback: 0.00,
  },
  checkout_regression: {
    none: 0, alternate_method: 0.04, wait_and_retry: 0.02, immediate_retry: 0.01,
    nudge: 0.05, discount_nudge: 0.07, checkout_rollback: 0.34,
  },
  method_mismatch: {
    none: 0, alternate_method: 0.22, wait_and_retry: 0.01, immediate_retry: 0.00,
    nudge: 0.04, discount_nudge: 0.06, checkout_rollback: 0.01,
  },
  retry_timing: {
    none: 0, alternate_method: 0.05, wait_and_retry: 0.28, immediate_retry: -0.08,
    nudge: 0.03, discount_nudge: 0.05, checkout_rollback: 0.00,
  },
  customer_abandonment: {
    none: 0, alternate_method: 0.02, wait_and_retry: 0.01, immediate_retry: 0.01,
    // A discount buys a little more than a free message and costs 15% of the
    // order to do it. That gap — 3 percentage points of extra recovery for a
    // fifteen percent giveaway — is the whole argument against reflexive
    // discounting, and it is why gross recovery figures flatter it so badly.
    nudge: 0.17, discount_nudge: 0.20, checkout_rollback: 0.00,
  },
};

/** Uplift when nothing is wrong — interventions do almost nothing. */
const UPLIFT_BASELINE: Record<Intervention, number> = {
  none: 0, alternate_method: 0.02, wait_and_retry: 0.01, immediate_retry: 0.00,
  nudge: 0.03, discount_nudge: 0.05, checkout_rollback: 0.00,
};

/**
 * Costs are NOT hidden truth — a merchant knows what an SMS costs and what
 * discount they are offering. They live in the engine's own price list and
 * are re-exported here only so the outcome resolver and the scorer cannot
 * drift apart.
 */
export { FIXED_COST_PAISE, CONDITIONAL_COST_RATE } from '../policy/costs.js';

/** The failure reason a given cause produces. Observable by the engine. */
export const CAUSE_FAILURE_REASON: Record<CauseType, FailureReason> = {
  issuer_degradation: 'issuer_unavailable',
  gateway_degradation: 'gateway_timeout',
  checkout_regression: 'authentication_failed',
  method_mismatch: 'method_not_supported',
  retry_timing: 'issuer_unavailable',
  customer_abandonment: 'user_dropped',
};

/**
 * Resolve whether one at-risk payment recovers.
 *
 * `cause` is null for items drawn from a window where nothing was wrong.
 * The draw is deterministic given the rng, so a batch replays identically.
 */
export function resolveRecovery(
  cause: CauseType | null,
  intervention: Intervention,
  rng: Rng,
): boolean {
  const base = cause ? P_NATURAL[cause] : P_NATURAL_BASELINE;
  const uplift = cause ? UPLIFT[cause][intervention] : UPLIFT_BASELINE[intervention];
  const p = Math.max(0.01, Math.min(0.98, base + uplift));
  return rng.bool(p);
}

/**
 * The best intervention available for a cause by true net value, used only
 * to score the engine's action choice in the evaluation. Never consulted
 * during a run.
 */
export function trueBestIntervention(cause: CauseType | null): Intervention {
  const table = cause ? UPLIFT[cause] : UPLIFT_BASELINE;
  let best: Intervention = 'none';
  let bestVal = 0;
  for (const [k, v] of Object.entries(table) as [Intervention, number][]) {
    // Approximate net: uplift on a typical ₹1,500 order minus fixed cost,
    // minus the conditional discount paid on every recovery.
    const typicalPaise = 150_000;
    const pRec = (cause ? P_NATURAL[cause] : P_NATURAL_BASELINE) + v;
    const net = v * typicalPaise - FIXED[k] - CONDITIONAL[k] * typicalPaise * pRec;
    if (net > bestVal) { bestVal = net; best = k; }
  }
  return best;
}

/** Exposed for the eval report so the appendix can show what truth was. */
export const GROUND_TRUTH = { P_NATURAL, UPLIFT, UPLIFT_BASELINE } as const;
