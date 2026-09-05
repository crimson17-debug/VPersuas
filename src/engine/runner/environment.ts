/**
 * The environment the runner acts against.
 *
 * The engine calls `resolve()` and learns only whether the payment came
 * back. It never sees the true cause, the true uplift, or the natural rate.
 * Swapping this implementation for one backed by real Razorpay webhooks is
 * the whole production path: same interface, real outcomes.
 */

import type { AtRiskItem, CauseType, Intervention } from '../types.js';
import type { Rng } from '../rng.js';
import { makeRng, hashString } from '../rng.js';
import { resolveRecovery } from '../simulator/world.js';
import type { ScenarioSpec } from '../simulator/generator.js';

export interface Environment {
  /** Did this payment recover under this intervention? */
  resolve(item: AtRiskItem, intervention: Intervention, rng: Rng): boolean;
}

/** Ground-truth lookup used by the environment and by the eval scorer. */
export interface TruthOracle {
  causeOf(item: AtRiskItem): CauseType | null;
}

function itemMatchesIncidentCohort(item: AtRiskItem, cohort: Record<string, string | undefined>): boolean {
  for (const [k, v] of Object.entries(cohort)) {
    if (v === undefined) continue;
    if (String((item as unknown as Record<string, unknown>)[k]) !== v) return false;
  }
  return true;
}

export function makeTruthOracle(spec: ScenarioSpec): TruthOracle {
  return {
    causeOf(item: AtRiskItem): CauseType | null {
      for (const inc of spec.incidents) {
        if (item.failedAt < inc.onsetTs || item.failedAt > inc.endTs) continue;
        if (!itemMatchesIncidentCohort(item, inc.cohort)) continue;
        return inc.cause;
      }
      return null;
    },
  };
}

/**
 * Environment backed by the synthetic world.
 *
 * Outcome draws are seeded from the item id so a batch replays identically
 * and an auditor can recompute any single outcome from the ledger.
 */
export function makeSimulatedEnvironment(spec: ScenarioSpec, seed: number): Environment & TruthOracle {
  const oracle = makeTruthOracle(spec);
  return {
    causeOf: oracle.causeOf,
    resolve(item, intervention, _rng) {
      const local = makeRng(
        (hashString(`${item.id}|${intervention}`) ^ (seed >>> 0)) >>> 0,
      );
      return resolveRecovery(oracle.causeOf(item), intervention, local);
    },
  };
}
