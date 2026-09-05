/**
 * Baseline policies.
 *
 * These exist so the engine's numbers mean something. A recovery figure
 * with nothing to compare it against is unfalsifiable; the only useful
 * claim is "better than the obvious thing, by this much, measured the same
 * way".
 *
 * Every baseline runs through the identical execution, holdout, cost and
 * measurement path, and every baseline sees ALL at-risk items rather than
 * only the ones this system's detector flagged. Handicapping a baseline
 * with your own detector and then beating it proves nothing.
 *
 * `never_act` is the one to watch. It spends nothing and recovers whatever
 * would have recovered anyway, which on many windows is most of it.
 */

import type { AtRiskItem, Decision, Detection, DiagnosisVerdict, Intervention } from '../engine/types.js';
import { makeRng } from '../engine/rng.js';

export type BaselineName = 'always_nudge' | 'always_discount' | 'always_retry' | 'never_act' | 'random';

export const BASELINES: BaselineName[] = [
  'always_nudge', 'always_discount', 'always_retry', 'never_act', 'random',
];

export const BASELINE_LABEL: Record<BaselineName, string> = {
  always_nudge: 'Nudge every failed payment',
  always_discount: 'Discount every failed payment',
  always_retry: 'Retry every failed payment immediately',
  never_act: 'Do nothing, ever',
  random: 'Pick an intervention at random',
};

const RANDOM_POOL: Intervention[] = [
  'alternate_method', 'wait_and_retry', 'immediate_retry', 'nudge', 'discount_nudge',
];

/** One synthetic detection covering every at-risk item in the window. */
export function coverAllDetection(items: readonly AtRiskItem[]): Detection[] {
  if (items.length === 0) return [];
  const onsetTs = Math.min(...items.map((i) => i.failedAt));
  const exposedPaise = items.reduce((s, i) => s + i.amountPaise, 0);
  return [{
    cohort: {},
    onsetTs,
    preRate: 0, postRate: 0, preN: 0, postN: items.length,
    score: 0,
    exposedPaise,
  }];
}

export function baselinePolicy(name: BaselineName, seed: number) {
  const rng = makeRng(seed);

  return (input: {
    detection: Detection;
    verdict: DiagnosisVerdict;
    items: readonly AtRiskItem[];
    decisionId: string;
  }): Decision => {
    const common = {
      id: input.decisionId,
      cohort: input.detection.cohort,
      cause: null,
      causeWeight: null,
      options: [],
      rejected: [],
      blockedBy: [],
      itemCount: input.items.length,
      createdAt: Date.now(),
    };

    switch (name) {
      case 'never_act':
        return { ...common, kind: 'DO_NOT_ACT', intervention: 'none', reason: 'baseline: never acts' };
      case 'always_nudge':
        return { ...common, kind: 'ACT', intervention: 'nudge', reason: 'baseline: nudge everything' };
      case 'always_discount':
        return { ...common, kind: 'ACT', intervention: 'discount_nudge', reason: 'baseline: discount everything' };
      case 'always_retry':
        return { ...common, kind: 'ACT', intervention: 'immediate_retry', reason: 'baseline: retry everything' };
      case 'random': {
        const pick = RANDOM_POOL[rng.int(0, RANDOM_POOL.length - 1)]!;
        return { ...common, kind: 'ACT', intervention: pick, reason: `baseline: random (${pick})` };
      }
    }
  };
}
