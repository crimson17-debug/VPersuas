/**
 * Intervention costs.
 *
 * These live in the engine, not in the hidden world model, because a
 * merchant genuinely knows what an SMS costs and what discount rate they
 * are offering. The engine is allowed to know its own price list; it is
 * not allowed to know whether the intervention works.
 */

import type { Intervention } from '../types.js';

/** Charged per item the moment the intervention is applied. */
export const FIXED_COST_PAISE: Record<Intervention, number> = {
  none: 0,
  alternate_method: 200,
  wait_and_retry: 100,
  immediate_retry: 100,
  nudge: 300,
  discount_nudge: 300,
  checkout_rollback: 0,
};

/**
 * Fraction of order value given away, charged only when the payment
 * recovers. Discounting therefore costs most where it "works" most, which
 * is exactly why gross recovery figures flatter it.
 */
export const CONDITIONAL_COST_RATE: Record<Intervention, number> = {
  none: 0,
  alternate_method: 0,
  wait_and_retry: 0,
  immediate_retry: 0,
  nudge: 0,
  /** 15% off to win the order back — the low end of a real recovery offer. */
  discount_nudge: 0.15,
  checkout_rollback: 0,
};

/**
 * One-off cost of the intervention, charged once per decision rather than
 * per item.
 *
 * Rolling back a checkout release is an engineering operation, not a send:
 * it costs review time, a deploy, and the reverted feature's own value.
 * Modelling it at zero made it a free lottery ticket — the policy played
 * it on every cause because a zero-cost option only has to get lucky once
 * on noise to clear a net-value test. With a real fixed cost it is chosen
 * only when the affected cohort is large enough to pay for it, which is
 * the actual decision a merchant faces.
 */
export const DECISION_COST_PAISE: Record<Intervention, number> = {
  none: 0,
  alternate_method: 0,
  wait_and_retry: 0,
  immediate_retry: 0,
  nudge: 0,
  discount_nudge: 0,
  checkout_rollback: 2_500_000, // ₹25,000 of engineering time and deploy risk
};

/** Interventions that put a message in front of a customer. */
export function isCustomerContact(i: Intervention): boolean {
  return i === 'nudge' || i === 'discount_nudge' || i === 'alternate_method';
}

/** Interventions a merchant must approve before they run. */
export function requiresMerchantApproval(i: Intervention): boolean {
  return i === 'checkout_rollback';
}

/** Reversibility, used as a tie-break and surfaced in the ledger. */
export const REVERSIBLE: Record<Intervention, boolean> = {
  none: true,
  alternate_method: true,
  wait_and_retry: true,
  immediate_retry: false,   // a spent attempt cannot be unspent
  nudge: false,             // a message cannot be unsent
  discount_nudge: false,
  checkout_rollback: true,
};
