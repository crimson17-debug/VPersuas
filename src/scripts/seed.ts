/**
 * Builds the dataset the console reads.
 *
 *   npm run seed
 *
 * Runs the engine over a stretch of a merchant's recent history — windows
 * it has never seen, using only priors earned during warm-up — and writes
 * the resulting decisions, outcomes and pooled measurements to .data/.
 *
 * Nothing here is hand-authored. Every number in the console comes out of
 * the same engine `npm run batch` and `npm run eval` use.
 */

import { generate } from '../engine/simulator/generator.js';
import { makeSimulatedEnvironment } from '../engine/runner/environment.js';
import { atRiskFrom, runBatch } from '../engine/runner/index.js';
import type { CustomerState } from '../engine/types.js';
import { buildCorpus } from '../eval/corpus.js';
import { loadOrEarnPriors } from '../store/bootstrap.js';
import { fileLedger } from '../store/ledger.js';
import { buildPortfolio, projectRun } from '../store/project.js';
import type { StoredRun } from '../store/types.js';

const HOUR = 3_600_000;
/** How many recent windows make up the merchant's visible history. */
const HISTORY_WINDOWS = 24;

function money(paise: number): string {
  const r = paise / 100;
  const a = Math.abs(r);
  const sign = r < 0 ? '-' : '';
  if (a >= 100000) return `${sign}₹${(a / 100000).toFixed(2)}L`;
  if (a >= 1000) return `${sign}₹${(a / 1000).toFixed(1)}k`;
  return `${sign}₹${a.toFixed(0)}`;
}

function main(): void {
  console.log('Earning priors…');
  const { priors, fromCache } = loadOrEarnPriors((epoch, size) =>
    console.log(`  epoch ${epoch}: ${size.treated} treated, ${size.holdout} held out`),
  );
  if (fromCache) console.log('  loaded from .data/priors.json (delete it to re-learn)');

  const corpus = buildCorpus(200);
  // Held-out windows only. The engine has never decided on any of these.
  const history = corpus.slice(60, 60 + HISTORY_WINDOWS);

  console.log(`\nRunning ${history.length} held-out windows…`);
  const states = new Map<string, CustomerState>();
  const runs: StoredRun[] = [];

  history.forEach((sc, i) => {
    const world = generate(sc.spec);
    const items = atRiskFrom(world.events, sc.spec.toTs - 24 * HOUR);
    const batch = runBatch({
      runId: `run_${String(i + 1).padStart(2, '0')}`,
      seed: sc.spec.seed ^ 0xbeef,
      events: world.events,
      items,
      priors,
      env: makeSimulatedEnvironment(sc.spec, sc.spec.seed),
      nowTs: sc.spec.toTs,
      customerStates: states,
    });

    runs.push(
      projectRun(batch, {
        runId: `run_${String(i + 1).padStart(2, '0')}`,
        nowTs: sc.spec.toTs,
        fromTs: sc.spec.fromTs,
        toTs: sc.spec.toTs,
        eventCount: world.events.length,
        source: 'simulated',
      }),
    );
  });

  // Newest first — the console opens on the most recent batch.
  runs.sort((a, b) => b.nowTs - a.nowTs);

  const portfolio = buildPortfolio(runs, priors.size());
  fileLedger.writePortfolio(portfolio);

  const p = portfolio.pooled;
  const decisions = runs.flatMap((r) => r.decisions);
  const byKind = new Map<string, number>();
  for (const d of decisions) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);

  console.log(`\nWrote .data/portfolio.json`);
  console.log(`  ${runs.length} runs, ${decisions.length} decisions`);
  console.log(`  ${[...byKind].map(([k, v]) => `${v}× ${k}`).join(', ')}`);
  console.log(`  treated ${p.treatedN} · held out ${p.holdoutN}`);
  console.log(`  lift ${(p.liftPp * 100).toFixed(1)}pp${p.significant ? '' : ' (interval spans zero)'}`);
  console.log(`  gross ${money(p.grossRecoveredPaise)} · incremental ${money(p.incrementalPaise)} · net ${money(p.netPaise)}`);
  console.log(`  ${(p.phantomShare * 100).toFixed(1)}% of the gross figure was never caused\n`);

  if (!fileLedger.readEval()) {
    console.log('No evaluation data yet — run `npm run eval` to populate that screen.\n');
  }
}

main();
