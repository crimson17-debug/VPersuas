/**
 * Earning the priors.
 *
 * The policy is handed nothing. It starts with no idea which intervention
 * works for which cause, cannot justify acting on any of them, and so
 * returns EXPERIMENT — spending a little to buy the evidence. Six passes
 * over sixty windows later it has measured enough to start acting.
 *
 * A deployment would accumulate this over weeks of real traffic and carry
 * it forward between runs, which is what the disk cache imitates.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generate } from '../engine/simulator/generator.js';
import { makeSimulatedEnvironment } from '../engine/runner/environment.js';
import { atRiskFrom, runBatch } from '../engine/runner/index.js';
import { PriorStore } from '../engine/policy/priors.js';
import type { CustomerState } from '../engine/types.js';
import { buildCorpus, type LabelledScenario } from '../eval/corpus.js';

const HOUR = 3_600_000;
const EPOCHS = 6;
const CACHE = join(process.cwd(), '.data', 'priors.json');

/** Exploration is turned up during warm-up and back down for normal running. */
const WARMUP_CONFIG = { learningSliceFraction: 0.5, explorationFraction: 0.4 };

export function earnPriors(
  warmupWindows: readonly LabelledScenario[],
  onProgress?: (epoch: number, size: { treated: number; holdout: number }) => void,
): PriorStore {
  const priors = new PriorStore();
  const states = new Map<string, CustomerState>();

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    warmupWindows.forEach((sc, i) => {
      const world = generate(sc.spec);
      runBatch({
        runId: `warm_${epoch}_${sc.spec.id}`,
        seed: sc.spec.seed ^ ((i + epoch * 991) * 2654435761),
        events: world.events,
        items: atRiskFrom(world.events, sc.spec.toTs - 24 * HOUR),
        priors,
        env: makeSimulatedEnvironment(sc.spec, sc.spec.seed),
        nowTs: sc.spec.toTs,
        customerStates: states,
        config: WARMUP_CONFIG,
      });
    });
    onProgress?.(epoch + 1, priors.size());
  }

  return priors;
}

/** Cached variant. Delete .data/priors.json to force a cold start. */
export function loadOrEarnPriors(
  onProgress?: (epoch: number, size: { treated: number; holdout: number }) => void,
): { priors: PriorStore; fromCache: boolean } {
  if (existsSync(CACHE)) {
    try {
      const priors = PriorStore.fromJSON(JSON.parse(readFileSync(CACHE, 'utf8')));
      return { priors, fromCache: true };
    } catch {
      // Fall through and re-learn rather than run on a corrupt store.
    }
  }
  const warmup = buildCorpus(200).slice(0, 60);
  const priors = earnPriors(warmup, onProgress);
  mkdirSync(join(process.cwd(), '.data'), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(priors.toJSON()), 'utf8');
  return { priors, fromCache: false };
}
