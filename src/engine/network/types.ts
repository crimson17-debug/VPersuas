/**
 * The federated wire contract.
 *
 * This file exists to be read by someone sceptical about privacy, so it is
 * deliberately small. A merchant contributes exactly the fields below and
 * nothing else. There is no merchant identifier, no customer identifier, no
 * transaction amount, no order, no device, no geography — nothing that
 * survives aggregation and nothing that could be joined back to a person.
 *
 * What is shared is the *result of a test*, not the data the test ran on:
 * a z-statistic, the sample size behind it, and the rail it concerns. That
 * is enough to combine tests across merchants and not enough to reconstruct
 * any merchant's traffic.
 *
 * The reason this layer exists at all: a single merchant cannot distinguish
 * "this issuer is degraded" from "my checkout broke for this issuer's
 * customers". Both produce an identical signature in one merchant's data.
 * The distinction is not recoverable by a better model — it is missing
 * information, and the only place it exists is across merchants.
 */

import type { Issuer, PaymentMethod } from '../types.js';

/**
 * One merchant's contribution about one rail in one window.
 *
 * `z` is negative when success got worse — the same sign convention the
 * detector uses, kept deliberately so nothing has to be flipped in transit.
 */
export interface RailSignal {
  method: PaymentMethod;
  issuer: Issuer;
  /** Standardised effect. Negative = degradation. */
  z: number;
  /** Observed change in success rate, proportion points. Negative = worse. */
  diff: number;
  /** Post-window sample size. Weights the pooled estimate. */
  n: number;
  /** When this merchant's series changed, if a change point was found. */
  onsetTs: number | null;
}

/**
 * The anonymous envelope a merchant submits.
 *
 * `contributorId` is a rotating per-window pseudonym, not a merchant ID: it
 * exists only so the aggregator can count distinct contributors for the
 * k-anonymity gate and reject double-submission. It carries no meaning
 * across windows and maps to nothing.
 */
export interface NetworkContribution {
  contributorId: string;
  windowEndTs: number;
  rails: RailSignal[];
}

/** Why a rail did or did not produce a network-level finding. */
export type NetworkVerdict =
  /** Enough independent merchants, consistent effect: this is the rail. */
  | 'issuer_confirmed'
  /** Merchants disagree sharply. Whoever is moving is moving alone. */
  | 'merchant_specific'
  /** Below the k-anonymity floor. Deliberately not reported. */
  | 'below_k_anonymity'
  /** Contributors agree there is nothing here. */
  | 'no_signal';

export interface NetworkFinding {
  method: PaymentMethod;
  issuer: Issuer;
  verdict: NetworkVerdict;
  /** Number of distinct merchants that contributed to this rail. */
  contributors: number;
  /**
   * How many contributors independently show degradation on this rail.
   *
   * This, not the pooled average, is the discriminator. A pooled mean can
   * be dragged anywhere by one merchant with a broken checkout and heavy
   * volume; a count of independent parties cannot. Under a real issuer
   * event most contributors move. Under one merchant's own bug, one does.
   */
  degradedCount: number;
  /** degradedCount / contributors. */
  degradedShare: number;
  /** Stouffer's combined Z across contributors. Negative = degradation. */
  combinedZ: number;
  /** Two-sided p for combinedZ. */
  p: number;
  /** Sample-weighted mean effect across contributors, proportion points. */
  pooledDiff: number;
  /** Cochran's Q heterogeneity statistic. */
  q: number;
  /** I², share of variance due to real between-merchant differences (0..1). */
  iSquared: number;
  /**
   * Spread of change-point onsets across contributors, in minutes. A true
   * issuer event lands in a tight window; unrelated merchant problems do
   * not synchronise.
   */
  onsetSpreadMinutes: number | null;
  /** Confidence that this is an issuer-level event, 0..1. */
  confidence: number;
}

export interface NetworkAssessment {
  windowEndTs: number;
  /** Total merchants that submitted anything for this window. */
  fleetSize: number;
  findings: NetworkFinding[];
  /** The k-anonymity floor actually applied. */
  kAnonymity: number;
}

export interface NetworkConfig {
  /** Minimum distinct contributors before a rail may be reported at all. */
  kAnonymity: number;
  /** Minimum post-window sample for a merchant's signal to be admissible. */
  minContributorN: number;
  /** Two-sided significance for the combined test. */
  alpha: number;
  /** I² above this means the merchants are not measuring the same thing. */
  maxHeterogeneity: number;
  /** Onset spread above this many minutes argues against a shared cause. */
  maxOnsetSpreadMinutes: number;
  /** Per-contributor z at or below which that merchant counts as degraded. */
  contributorZ: number;
  /** Share of contributors that must degrade before blaming the rail. */
  minDegradedShare: number;
  /**
   * At or below this share, the rail is affirmatively healthy.
   *
   * This is the branch that makes the network useful in the negative case.
   * "Everyone else on this rail is fine" is not an absence of evidence —
   * it is positive evidence that the problem is local, and it is the only
   * way a merchant can ever be told the fault is theirs.
   */
  maxHealthyShare: number;
}

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  // Five is the smallest floor at which no single contributor dominates a
  // reported aggregate. Below it, a merchant with unusual volume can infer
  // a competitor's traffic from the movement of the pooled number.
  kAnonymity: 5,
  minContributorN: 30,
  alpha: 0.01,
  maxHeterogeneity: 0.6,
  maxOnsetSpreadMinutes: 90,
  contributorZ: -2,
  minDegradedShare: 0.5,
  maxHealthyShare: 0.2,
};

export function railKey(method: PaymentMethod, issuer: Issuer): string {
  return `${method}:${issuer}`;
}
