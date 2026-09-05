/**
 * Federated rail assessment.
 *
 * Takes anonymous per-merchant signals and answers the one question a
 * single merchant cannot answer about itself: is this rail degraded for
 * everyone, or is this merchant broken?
 *
 * Two gates decide the verdict, and both must hold:
 *
 *   1. Enough independent contributors   (k-anonymity, and statistical power)
 *   2. Most of them independently moved  (degraded share) AND the pooled
 *                                        test agrees (Stouffer's Z)
 *
 * Gate 2 is deliberately a count of parties rather than an average effect.
 * A pooled mean can be dragged anywhere by one merchant with a broken
 * checkout and heavy volume, and a federated system that falls for that
 * broadcasts one merchant's bug to everyone on the rail as fact — worse
 * than not federating at all. A count of independent parties cannot be
 * moved that way.
 *
 * Heterogeneity (Cochran's Q, I²) and onset spread are computed, reported
 * and folded into confidence, but hold no veto. They are measured over
 * hourly buckets on per-merchant volumes that are often small, so they are
 * the least reliable signals here; letting either overrule near-unanimous
 * agreement across the fleet is the wrong way round, and an earlier
 * version of this file did exactly that.
 *
 * The third state matters as much as the other two: when the fleet carries
 * a rail and is *not* moving, that is positive evidence the fault is local.
 * It is the only way a merchant is ever told the problem is theirs.
 */

import type { Issuer, PaymentMethod } from '../types.js';
import {
  DEFAULT_NETWORK_CONFIG,
  railKey,
  type NetworkAssessment,
  type NetworkConfig,
  type NetworkContribution,
  type NetworkFinding,
  type RailSignal,
} from './types.js';
import {
  degradationP,
  diffVariance,
  heterogeneity,
  onsetSpreadMinutes,
  stouffer,
} from './meta.js';
import { zForTwoSidedAlpha } from '../stats.js';

export * from './types.js';
export { stouffer, heterogeneity, diffVariance, onsetSpreadMinutes } from './meta.js';
export { buildContribution, DEFAULT_CONTRIBUTE_CONFIG } from './contribute.js';

interface RailGroup {
  method: PaymentMethod;
  issuer: Issuer;
  signals: RailSignal[];
  contributors: Set<string>;
}

/**
 * Confidence that a rail-level finding is an issuer event.
 *
 * Deliberately not a model output. Three independent multipliers, each
 * bounded, each traceable to a number on the screen:
 *
 *   - strength:  how far past the significance threshold the combined Z is
 *   - agreement: 1 - I², how much of the variation is *not* disagreement
 *   - synchrony: how tightly the onsets cluster
 *
 * A judge can point at any of the three and ask where it came from, and the
 * answer is a statistic, not a weight someone tuned.
 */
function confidenceFor(
  combinedZ: number,
  zThreshold: number,
  iSquared: number,
  spreadMinutes: number | null,
  cfg: NetworkConfig,
  degradedShare: number,
): number {
  // Primary evidence: how many independent parties agree, and how far the
  // pooled test clears its threshold. Either one failing should collapse
  // the confidence, so they multiply.
  const strength = Math.min(1, Math.abs(combinedZ) / (zThreshold * 2));
  const consensus = Math.min(1, degradedShare / 0.8);
  const primary = strength * consensus;

  // Secondary evidence modulates within a bounded band. It can shade a
  // finding down; it cannot overturn near-unanimous agreement across the
  // fleet, because it is measured far less reliably than the primary
  // signals are.
  const synchronyScore =
    spreadMinutes === null
      ? 0.6 // unknown: neither credited nor punished
      : Math.max(0, 1 - spreadMinutes / (cfg.maxOnsetSpreadMinutes * 3));
  const synchrony = 0.8 + 0.2 * synchronyScore;

  // I² is reported and shown, but only lightly weighted. Real issuer
  // degradation hits merchants with different traffic mixes at genuinely
  // different severities, so high heterogeneity is expected and is not by
  // itself a reason to doubt a rail event. Treating it as one is what made
  // the first version of this call every genuine outage "merchant specific".
  const agreement = 0.88 + 0.12 * (1 - Math.min(1, iSquared));

  return Math.max(0, Math.min(0.99, primary * synchrony * agreement));
}

export function assessNetwork(
  contributions: readonly NetworkContribution[],
  windowEndTs: number,
  config: NetworkConfig = DEFAULT_NETWORK_CONFIG,
): NetworkAssessment {
  const groups = new Map<string, RailGroup>();

  for (const c of contributions) {
    for (const rail of c.rails) {
      if (rail.n < config.minContributorN) continue;
      const key = railKey(rail.method, rail.issuer);
      let g = groups.get(key);
      if (!g) {
        g = { method: rail.method, issuer: rail.issuer, signals: [], contributors: new Set() };
        groups.set(key, g);
      }
      // One contribution per contributor per rail. A repeated submission is
      // dropped rather than counted twice — otherwise a single party could
      // manufacture a quorum on its own.
      if (g.contributors.has(c.contributorId)) continue;
      g.contributors.add(c.contributorId);
      g.signals.push(rail);
    }
  }

  const zThreshold = zForTwoSidedAlpha(config.alpha);
  const findings: NetworkFinding[] = [];

  for (const g of groups.values()) {
    const contributors = g.contributors.size;

    const base = {
      method: g.method,
      issuer: g.issuer,
      contributors,
    };

    // The k-anonymity gate runs before any statistic is computed, so a
    // below-floor rail never produces a number that could leak, not even
    // internally.
    if (contributors < config.kAnonymity) {
      findings.push({
        ...base,
        verdict: 'below_k_anonymity',
        degradedCount: 0, degradedShare: 0,
        combinedZ: 0, p: 1, pooledDiff: 0, q: 0, iSquared: 0,
        onsetSpreadMinutes: null, confidence: 0,
      });
      continue;
    }

    const combined = stouffer(g.signals.map((s) => ({ z: s.z, n: s.n })));
    if (!combined) continue;

    const totalN = g.signals.reduce((acc, s) => acc + s.n, 0);
    const pooledDiff =
      totalN > 0
        ? g.signals.reduce((acc, s) => acc + s.diff * s.n, 0) / totalN
        : 0;

    // Reconstruct each contributor's variance from what it shared. The
    // post-window rate is recoverable from the reported effect; the pre
    // window is approximated by the same n, which is conservative — it
    // slightly overstates variance and therefore understates disagreement,
    // so the heterogeneity test errs toward *not* crying issuer.
    const het = heterogeneity(
      g.signals.map((s) => {
        const postRate = Math.min(0.999, Math.max(0.001, 0.9 + s.diff));
        const preRate = Math.min(0.999, Math.max(0.001, postRate - s.diff));
        return {
          effect: s.diff,
          variance: diffVariance(postRate, s.n, preRate, s.n),
        };
      }),
    );

    const iSquared = het?.iSquared ?? 0;
    const q = het?.q ?? 0;
    const spread = onsetSpreadMinutes(g.signals.map((s) => s.onsetTs));

    // How many contributors independently see it. This is the robust
    // statistic: unlike a pooled mean it cannot be moved by one large
    // merchant, which is precisely the failure mode a federated system
    // has to survive.
    const degradedCount = g.signals.filter((s) => s.z <= config.contributorZ).length;
    const degradedShare = degradedCount / contributors;

    const significant = combined.z <= -zThreshold;

    // Synchrony informs confidence; it does not hold a veto.
    //
    // Onset comes from a change point over hourly buckets, and a merchant
    // with sixty payments an hour on a rail produces a genuinely noisy
    // series. Spread therefore measures the fleet's smallest members as
    // much as it measures the event. Letting it gate the verdict meant
    // thirty-seven of thirty-nine merchants down at Z = -49 was reported
    // as "no signal" — the secondary signal overruling the primary one,
    // which is the wrong way round.
    let verdict: NetworkFinding['verdict'];
    if (degradedShare >= config.minDegradedShare && significant) {
      // Most of the fleet moved, and the pooled test agrees.
      verdict = 'issuer_confirmed';
    } else if (degradedShare <= config.maxHealthyShare) {
      // Quorum of merchants carry this rail and are fine. That is a
      // positive finding, not a shrug: whatever this merchant is seeing,
      // the rail is not the reason.
      verdict = 'merchant_specific';
    } else {
      // Somewhere in between — a partial outage, a regional split, or an
      // effect too weak to call. The honest answer is to say nothing and
      // let the local evidence stand on its own.
      verdict = 'no_signal';
    }

    findings.push({
      ...base,
      verdict,
      degradedCount,
      degradedShare,
      combinedZ: combined.z,
      p: degradationP(combined.z),
      pooledDiff,
      q,
      iSquared,
      onsetSpreadMinutes: spread,
      confidence:
        verdict === 'issuer_confirmed'
          ? confidenceFor(combined.z, zThreshold, iSquared, spread, config, degradedShare)
          : 0,
    });
  }

  findings.sort((a, b) => {
    const rank = (f: NetworkFinding) => (f.verdict === 'issuer_confirmed' ? 0 : f.verdict === 'merchant_specific' ? 1 : 2);
    const r = rank(a) - rank(b);
    return r !== 0 ? r : a.combinedZ - b.combinedZ;
  });

  return {
    windowEndTs,
    fleetSize: new Set(contributions.map((c) => c.contributorId)).size,
    findings,
    kAnonymity: config.kAnonymity,
  };
}

/**
 * Look up what the network says about one rail.
 *
 * Diagnosis calls this to decide whether an issuer hypothesis has external
 * corroboration. Returns null when the network has nothing to say, which is
 * a different thing from saying nothing is wrong.
 */
export function findingFor(
  assessment: NetworkAssessment | null,
  // Widened to string because a Cohort stores its dimension values as
  // plain strings; narrowing here would push a cast onto every caller.
  method: string | undefined,
  issuer: string | undefined,
): NetworkFinding | null {
  if (!assessment) return null;
  if (!method && !issuer) return null;

  const matches = assessment.findings.filter(
    (f) =>
      (method === undefined || f.method === method) &&
      (issuer === undefined || f.issuer === issuer),
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  // The detector often reports a cohort coarser than a rail — "HDFC" rather
  // than "HDFC on UPI" — because when a rail goes down the issuer as a
  // whole moves with it and the nested-cohort pruning keeps the broader
  // one. That is correct behaviour there and it means this lookup has to
  // resolve a partial cohort to a rail rather than give up.
  //
  // A confirmed rail wins outright: if any rail under this cohort is
  // genuinely down, that is the answer to "is the rail the problem".
  const confirmed = matches.filter((f) => f.verdict === 'issuer_confirmed');
  if (confirmed.length > 0) {
    return confirmed.reduce((worst, f) => (f.combinedZ < worst.combinedZ ? f : worst));
  }

  // Otherwise every matching rail is healthy or unresolved, and the
  // representative is the best-evidenced one — the rail with the most
  // contributors behind it.
  //
  // Not the most negative Z. Across a healthy fleet the minimum of several
  // near-zero statistics is pure noise, and picking it surfaced an
  // unrelated rail at Z = -0.2 next to the merchant's verdict. The answer
  // was still right, but the evidence shown for it was the wrong rail,
  // which is the kind of detail that loses an audience deservedly.
  return matches.reduce((best, f) => (f.contributors > best.contributors ? f : best));
}
