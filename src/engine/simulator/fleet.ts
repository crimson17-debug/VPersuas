/**
 * Fleet generation: many merchants, one payment network.
 *
 * This exists to create the only condition under which the issuer-versus-
 * merchant question is answerable at all. The two causes are constructed
 * here to be indistinguishable inside any single merchant's data and
 * separable only across merchants:
 *
 *   issuer_degradation  — applied to EVERY merchant carrying that rail,
 *                         with onsets jittered by a few minutes, because
 *                         real issuer trouble does not reach everyone on
 *                         the same second.
 *
 *   checkout_regression — applied to exactly ONE merchant, on the same
 *                         rail, at the same time, with the same severity.
 *
 * Inside merchant #7 those two scenarios produce the same shaped hole in
 * the same cohort. Only the fleet can tell them apart. That is the whole
 * argument for the network layer, and it is enforced here in the data
 * rather than asserted in a README.
 *
 * Ground truth lives in this file, which is simulator territory. The engine
 * never imports it — `npm run check:boundaries` fails the build if it does.
 */

import type { CauseType, FailureReason, Issuer, PaymentMethod } from '../types.js';
import { makeRng } from '../rng.js';
import { generate, type GeneratedWorld, type IncidentSpec, type ScenarioSpec } from './generator.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;

export interface FleetIncidentSpec {
  cause: CauseType;
  method: PaymentMethod;
  issuer: Issuer;
  /** Fraction of the fleet affected. 1 = issuer-wide, small = one merchant. */
  reach: number;
  severity: number;
  onsetTs: number;
  endTs: number;
  /** Spread of per-merchant onset, in minutes. */
  onsetJitterMinutes: number;
  /** Force both twins to emit the same failure signature. */
  reasonOverride?: FailureReason;
}

export interface FleetSpec {
  id: string;
  seed: number;
  merchants: number;
  fromTs: number;
  toTs: number;
  ratePerHour: number;
  incident: FleetIncidentSpec | null;
  /** Which merchant index is the one the console belongs to. */
  focusIndex: number;
}

export interface FleetMerchant {
  index: number;
  /** Rotating per-window pseudonym. Not an identity. */
  contributorId: string;
  world: GeneratedWorld;
  /** Ground truth, for evaluation only. Never read by the engine. */
  affected: boolean;
}

export interface GeneratedFleet {
  spec: FleetSpec;
  merchants: FleetMerchant[];
  focus: FleetMerchant;
  /** Ground truth. Eval only. */
  trueCause: CauseType | null;
}

/**
 * Build a fleet in which the focus merchant is always affected.
 *
 * That is the interesting case: the focus merchant sees a hole either way,
 * and the question is whether it belongs to the rail or to them. A fleet
 * where the focus merchant is fine is not a decision, it is a null.
 */
export function generateFleet(spec: FleetSpec): GeneratedFleet {
  const rng = makeRng(spec.seed ^ 0x5f37);
  const merchants: FleetMerchant[] = [];

  // Decide who is hit before generating anything, so the focus merchant is
  // guaranteed to be in the affected set and the rest is a fair draw.
  const affectedSet = new Set<number>();
  if (spec.incident) {
    affectedSet.add(spec.focusIndex);
    const target = Math.max(1, Math.round(spec.merchants * spec.incident.reach));
    // Deterministic walk so a given seed always produces the same fleet.
    let i = 0;
    while (affectedSet.size < target && i < spec.merchants * 4) {
      const pick = rng.int(0, spec.merchants - 1);
      affectedSet.add(pick);
      i++;
    }
  }

  for (let m = 0; m < spec.merchants; m++) {
    const affected = affectedSet.has(m);
    const incidents: IncidentSpec[] = [];

    if (spec.incident && affected) {
      const jitter =
        spec.incident.onsetJitterMinutes > 0
          ? Math.round((rng.next() - 0.5) * 2 * spec.incident.onsetJitterMinutes) * MINUTE
          : 0;
      incidents.push({
        id: `${spec.id}_inc_${m}`,
        cause: spec.incident.cause,
        cohort: { method: spec.incident.method, issuer: spec.incident.issuer },
        onsetTs: spec.incident.onsetTs + jitter,
        endTs: spec.incident.endTs,
        ...(spec.incident.reasonOverride
          ? { reasonOverride: spec.incident.reasonOverride }
          : {}),
        // Per-merchant severity varies a little. A perfectly identical
        // effect across merchants would make the heterogeneity test look
        // better than it deserves to.
        severity: Math.max(
          0.05,
          Math.min(0.95, spec.incident.severity * rng.normal(1, 0.12)),
        ),
      });
    }

    const scenario: ScenarioSpec = {
      id: `${spec.id}_m${m}`,
      // Each merchant needs its own traffic, not a copy of merchant zero's.
      seed: spec.seed + m * 7919,
      label: spec.incident ? 'incident' : 'null',
      fromTs: spec.fromTs,
      toTs: spec.toTs,
      incidents,
      // Merchants are not the same size. A fleet of identical merchants
      // would hide the fact that Stouffer weighting matters.
      ratePerHour: Math.max(
        12,
        Math.round(spec.ratePerHour * rng.normal(1, 0.35)),
      ),
    };

    merchants.push({
      index: m,
      contributorId: `anon_${spec.id}_${m}`,
      world: generate(scenario),
      affected,
    });
  }

  const focus = merchants[spec.focusIndex]!;
  return {
    spec,
    merchants,
    focus,
    trueCause: spec.incident?.cause ?? null,
  };
}

/**
 * The two scenarios that are identical inside one merchant.
 *
 * Same rail, same window, same severity, same shape. The only difference is
 * how many merchants it touches — which is exactly the information a single
 * merchant does not have.
 */
export function twinScenarios(
  seed: number,
  merchants = 40,
  // The window must END in daytime traffic, not at 3am.
  //
  // The generator applies an hour-of-day volume shape, and the detector's
  // post window is the last six hours. Ending at 06:00 UTC puts that
  // window in the overnight trough — a tenth of peak volume — where no
  // cohort clears the sample floor and the whole fleet falls silent. That
  // is not the detector being cautious, it is the corpus being built
  // wrong, and it cost an hour to find the first time.
  //
  // 15:00 UTC ends the window in the 09:00–15:00 UTC band: near peak
  // volume, and outside IST quiet hours so the compliance gate does not
  // veto everything downstream either.
  fromTs = Date.UTC(2026, 8, 1, 15, 0, 0),
): { issuerWide: FleetSpec; merchantOnly: FleetSpec } {
  const toTs = fromTs + 72 * HOUR;
  const onsetTs = toTs - 5 * HOUR;

  const shared = {
    merchants,
    fromTs,
    toTs,
    ratePerHour: 120,
    focusIndex: 7,
  } as const;

  const railIncident = {
    method: 'upi' as PaymentMethod,
    issuer: 'bank_hdfc' as Issuer,
    severity: 0.46,
    onsetTs,
    endTs: toTs,
    // Both twins emit the same reason. Without this the diagnosis engine
    // reads the reason code off the failures and separates the two cases
    // for free, and the twin proves nothing — which is exactly what the
    // first version of this script did before anyone checked.
    reasonOverride: 'issuer_unavailable' as FailureReason,
  };

  return {
    issuerWide: {
      ...shared,
      id: 'twin_issuer',
      seed,
      incident: {
        ...railIncident,
        cause: 'issuer_degradation',
        reach: 1.0,
        onsetJitterMinutes: 9,
      },
    },
    merchantOnly: {
      ...shared,
      id: 'twin_merchant',
      seed,
      incident: {
        ...railIncident,
        // Retry timing, not checkout regression, and deliberately so.
        //
        // These are the two causes EVAL.md already reports the engine
        // confusing most often, and the confusion is not a bug to tune
        // away — from inside one merchant they are the same event. Both
        // surface as issuer_unavailable on the same rail over the same
        // hours. The only difference is that a degraded issuer takes the
        // whole fleet down and a badly-timed retry schedule is one
        // merchant's own configuration.
        //
        // So this twin aims the network at the engine's known weak point
        // rather than at a case it already handles.
        cause: 'retry_timing',
        // One merchant out of the fleet. Below the k-anonymity floor by
        // construction, which is the point.
        reach: 1 / merchants,
        onsetJitterMinutes: 0,
      },
    },
  };
}
