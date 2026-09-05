/**
 * Diagnosis.
 *
 * Ranks candidate causes for a detection using difference-in-differences
 * against a matched control, plus two observable signals the generator
 * cannot fake away: which failure reason the excess failures carry, and
 * whether the depression is sustained or a short burst.
 *
 * The important output is not the winner. It is the ability to return
 * INSUFFICIENT_EVIDENCE when the top two hypotheses are statistically
 * indistinguishable — which happens on purpose for issuer degradation
 * versus retry timing, because those two genuinely look alike from the
 * outside and pretending otherwise would be the dishonest choice.
 */

import type {
  CauseType, Cohort, CohortDimension, Detection, DiagnosisVerdict,
  FailureReason, Hypothesis, PaymentEvent,
} from '../types.js';
import { CAUSE_LABEL, COHORT_DIMENSIONS } from '../types.js';
import { differenceInDifferences } from '../stats.js';
import type { NetworkFinding } from '../network/types.js';
import {
  checkParallelTrends, controlFor, depressionDurationHours,
  reasonShare, sliceControl, sliceTreated,
} from './matching.js';

const HOUR = 3_600_000;

interface Signature {
  cause: CauseType;
  /** Failure reason the excess failures should carry. */
  reason: FailureReason;
  /** Dimension whose negation forms the natural control cohort. */
  blameDim: CohortDimension | null;
  /** Expected shape of the depression. */
  shape: 'sustained' | 'burst' | 'any';
  /** Hours beyond which a depression counts as sustained. */
  sustainedThresholdHours: number;
  /**
   * Where this cause lives.
   *
   * 'rail'  — infrastructure shared with every other merchant on it.
   * 'local' — this merchant's own code, config, or customers.
   *
   * This single field is what the federated layer acts on. A rail cause
   * should show up across the fleet; a local cause must not. Corroboration
   * across merchants is therefore evidence *for* rail causes and evidence
   * *against* local ones, and the reverse when the fleet stays flat.
   */
  locus: 'rail' | 'local';
}

const SIGNATURES: Signature[] = [
  { cause: 'issuer_degradation',   reason: 'issuer_unavailable',    blameDim: 'issuer',          shape: 'sustained', sustainedThresholdHours: 3, locus: 'rail'  },
  { cause: 'retry_timing',         reason: 'issuer_unavailable',    blameDim: 'issuer',          shape: 'burst',     sustainedThresholdHours: 3, locus: 'local' },
  { cause: 'gateway_degradation',  reason: 'gateway_timeout',       blameDim: 'method',          shape: 'any',       sustainedThresholdHours: 3, locus: 'rail'  },
  { cause: 'checkout_regression',  reason: 'authentication_failed', blameDim: 'checkoutVersion', shape: 'any',       sustainedThresholdHours: 3, locus: 'local' },
  { cause: 'method_mismatch',      reason: 'method_not_supported',  blameDim: 'method',          shape: 'any',       sustainedThresholdHours: 3, locus: 'local' },
  { cause: 'customer_abandonment', reason: 'user_dropped',          blameDim: null,              shape: 'any',       sustainedThresholdHours: 3, locus: 'local' },
];

/**
 * Turn a network finding into a likelihood ratio on one hypothesis.
 *
 * Framed as a Bayes factor rather than a bonus, because that is what it
 * actually is: the network observation is more probable under one locus
 * than the other, and the ratio scales with how confident the network is.
 * At zero confidence the factor is 1 and nothing moves, which is the
 * property that keeps the un-federated path byte-identical.
 *
 * The cap of 4x is deliberate. A single external signal should be able to
 * break a tie and reverse a wrong call; it should not be able to overrule
 * the local evidence outright. If the network says issuer and every local
 * signal says otherwise, the right outcome is an unresolved diagnosis, not
 * confident deference to the fleet.
 */
function networkFactor(locus: Signature['locus'], finding: NetworkFinding | null): number {
  if (!finding) return 1;

  const MAX = 4;
  switch (finding.verdict) {
    case 'issuer_confirmed': {
      const strength = 1 + (MAX - 1) * finding.confidence;
      return locus === 'rail' ? strength : 1 / strength;
    }
    case 'merchant_specific': {
      // The fleet carries this rail and is not moving with this merchant.
      // That is positive evidence of a local cause, not merely absence of
      // evidence for a shared one.
      const strength = 1 + (MAX - 1) * 0.7;
      return locus === 'local' ? strength : 1 / strength;
    }
    case 'no_signal':
    case 'below_k_anonymity':
    default:
      // Too few contributors to say anything. Silence is not evidence.
      return 1;
  }
}

export interface DiagnosisConfig {
  /** Weight below which no cause is considered established. */
  minTopWeight: number;
  /** Minimum separation between first and second hypothesis. */
  minSeparation: number;
  /** Pre-period length used for the difference-in-differences baseline. */
  preHours: number;
}

export const DEFAULT_DIAGNOSIS_CONFIG: DiagnosisConfig = {
  minTopWeight: 0.45,
  minSeparation: 0.12,
  preHours: 24,
};

function pickControlDim(cohort: Cohort, preferred: CohortDimension | null): CohortDimension | null {
  if (preferred && cohort[preferred] !== undefined) return preferred;
  // Fall back to any dimension the cohort actually pins, so a control can
  // still be built for hypotheses with no natural blame dimension.
  for (const d of COHORT_DIMENSIONS) if (cohort[d] !== undefined) return d;
  return null;
}

export function diagnose(
  events: readonly PaymentEvent[],
  detection: Detection,
  config: DiagnosisConfig = DEFAULT_DIAGNOSIS_CONFIG,
  /**
   * What the federated network says about this cohort's rail, if anything.
   *
   * Optional on purpose. Passing nothing reproduces the single-merchant
   * behaviour exactly, which is what makes the solo-versus-network
   * comparison a fair test rather than two different engines.
   */
  network: NetworkFinding | null = null,
): DiagnosisVerdict {
  const maxTs = events.length ? events[events.length - 1]!.ts : detection.onsetTs;
  const onset = detection.onsetTs;
  const preFrom = onset - config.preHours * HOUR;

  const observedDuration = depressionDurationHours(events, detection.cohort, preFrom, onset, maxTs);

  const scored: { hyp: Hypothesis; raw: number }[] = [];

  for (const sig of SIGNATURES) {
    const dim = pickControlDim(detection.cohort, sig.blameDim);
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];

    // --- Signal 1: does the failure reason match this cause? -----------
    const post = reasonShare(events, detection.cohort, onset, maxTs, sig.reason);
    const pre = reasonShare(events, detection.cohort, preFrom, onset, sig.reason);
    // Excess concentration, not raw share: some reasons are common at
    // baseline, and only the increase is evidence of a new cause.
    const excessShare = Math.max(0, post.share - pre.share);
    const concentration = Math.min(1, post.share * 0.4 + excessShare * 1.6);

    if (post.share > 0.4) {
      evidenceFor.push(
        `${Math.round(post.share * 100)}% of failures after onset are ${sig.reason.replace(/_/g, ' ')}`,
      );
    } else {
      evidenceAgainst.push(
        `only ${Math.round(post.share * 100)}% of failures are ${sig.reason.replace(/_/g, ' ')}`,
      );
    }

    // --- Signal 2: difference-in-differences against a matched control --
    let didStrength = 0.05;
    let effect = 0, ciLow = 0, ciHigh = 0;
    let controlLabel = 'no matched control available';

    if (dim) {
      const spec = controlFor(detection.cohort, dim);
      if (spec) {
        controlLabel = spec.label;
        const tPre = sliceTreated(events, detection.cohort, preFrom, onset);
        const tPost = sliceTreated(events, detection.cohort, onset, maxTs);
        const cPre = sliceControl(events, spec, preFrom, onset);
        const cPost = sliceControl(events, spec, onset, maxTs);

        if (tPre.n > 20 && tPost.n > 20 && cPre.n > 20 && cPost.n > 20) {
          const did = differenceInDifferences(
            tPre.captured, tPre.n, tPost.captured, tPost.n,
            cPre.captured, cPre.n, cPost.captured, cPost.n,
          );
          effect = did.effect;
          ciLow = did.low;
          ciHigh = did.high;

          const trends = checkParallelTrends(events, detection.cohort, spec, preFrom, onset);
          if (!trends.ok) {
            evidenceAgainst.push(`control rejected — ${trends.note}`);
            didStrength = 0.1;
          } else if (did.effect < 0 && did.significant) {
            didStrength = Math.min(1, Math.abs(did.effect) / 0.10);
            evidenceFor.push(
              `${(Math.abs(did.effect) * 100).toFixed(1)}pp drop vs ${spec.label} ` +
              `(95% CI ${(Math.abs(did.high) * 100).toFixed(1)}–${(Math.abs(did.low) * 100).toFixed(1)}pp)`,
            );
            evidenceFor.push(trends.note);
          } else if (did.effect < 0) {
            didStrength = 0.25;
            evidenceAgainst.push('difference vs control not statistically significant');
          } else {
            didStrength = 0.05;
            evidenceAgainst.push('control cohort moved as much as the affected cohort');
          }
        } else {
          evidenceAgainst.push('control cohort too small to test');
          didStrength = 0.15;
        }
      }
    }

    // --- Signal 3: shape of the depression -----------------------------
    let shapeFit = 1;
    if (sig.shape === 'sustained') {
      if (observedDuration >= sig.sustainedThresholdHours) {
        evidenceFor.push(`depression sustained for ${observedDuration}h`);
      } else {
        shapeFit = 0.45;
        evidenceAgainst.push(`depression lasted only ${observedDuration}h — short for a sustained outage`);
      }
    } else if (sig.shape === 'burst') {
      if (observedDuration < sig.sustainedThresholdHours) {
        evidenceFor.push(`short ${observedDuration}h burst, consistent with a timing problem`);
      } else {
        shapeFit = 0.45;
        evidenceAgainst.push(`depression ran ${observedDuration}h — too long for a retry-timing burst`);
      }
    }

    // --- Signal 4: what the rest of the network sees on this rail -------
    const netFactor = networkFactor(sig.locus, network);
    if (network && netFactor !== 1) {
      const others = network.contributors - 1;
      if (network.verdict === 'issuer_confirmed') {
        const line =
          `${others} other merchants on ${network.method}/${network.issuer} moved together ` +
          `(pooled ${(network.pooledDiff * 100).toFixed(1)}pp, I²=${Math.round(network.iSquared * 100)}%` +
          (network.onsetSpreadMinutes !== null
            ? `, onsets within ${Math.round(network.onsetSpreadMinutes)}min)`
            : ')');
        if (netFactor > 1) evidenceFor.push(line);
        else evidenceAgainst.push(`${line} — a rail-wide event, not merchant-local`);
      } else if (network.verdict === 'merchant_specific') {
        const line =
          `${others} other merchants carry this rail and did not move ` +
          `(I²=${Math.round(network.iSquared * 100)}%, contributors disagree)`;
        if (netFactor > 1) evidenceFor.push(line);
        else evidenceAgainst.push(`${line} — the rail itself is healthy`);
      }
    }

    const raw =
      Math.pow(Math.max(concentration, 0.01), 1.5) * didStrength * shapeFit * netFactor;

    scored.push({
      raw,
      hyp: {
        cause: sig.cause,
        effect, ciLow, ciHigh,
        weight: 0,
        evidenceFor, evidenceAgainst,
        controlLabel,
      },
    });
  }

  const total = scored.reduce((s, x) => s + x.raw, 0);
  const ranked = scored
    .map(({ hyp, raw }) => ({ ...hyp, weight: total > 0 ? raw / total : 0 }))
    .sort((a, b) => b.weight - a.weight);

  const top = ranked[0];
  const second = ranked[1];

  if (!top || total <= 0) {
    return { kind: 'insufficient_evidence', ranked, reason: 'no hypothesis produced usable evidence' };
  }
  if (top.weight < config.minTopWeight) {
    return {
      kind: 'insufficient_evidence',
      ranked,
      reason:
        `strongest hypothesis (${CAUSE_LABEL[top.cause]}) carries only ` +
        `${Math.round(top.weight * 100)}% of the evidence weight`,
    };
  }
  if (second && top.weight - second.weight < config.minSeparation) {
    return {
      kind: 'insufficient_evidence',
      ranked,
      reason:
        `${CAUSE_LABEL[top.cause]} and ${CAUSE_LABEL[second.cause]} are not ` +
        `separable on this evidence (${Math.round(top.weight * 100)}% vs ${Math.round(second.weight * 100)}%)`,
    };
  }

  return { kind: 'diagnosed', top, ranked };
}
