/**
 * End-to-end demonstration of one batch.
 *
 *   npm run batch            # issuer degradation
 *   npm run batch -- regression | retry | abandonment | quiet
 *
 * Prints the whole chain for one window: what changed, who it hit, what
 * caused it, what each intervention was worth, what was decided and why,
 * what was refused, what compliance blocked, and finally what the holdout
 * says actually happened versus what was predicted.
 */

import { generate, type ScenarioSpec } from '../engine/simulator/generator.js';
import { makeSimulatedEnvironment } from '../engine/runner/environment.js';
import { atRiskFrom, runBatch } from '../engine/runner/index.js';
import { detect } from '../engine/detector/index.js';
import { loadOrEarnPriors } from '../store/bootstrap.js';
import {
  CAUSE_LABEL, INTERVENTION_LABEL, cohortLabel,
  type CauseType,
} from '../engine/types.js';
import { buildCorpus } from '../eval/corpus.js';

const HOUR = 3_600_000;

const SCENARIOS: Record<string, { cause: CauseType | null; title: string }> = {
  issuer:      { cause: 'issuer_degradation',   title: 'Issuer degradation' },
  regression:  { cause: 'checkout_regression',  title: 'Checkout regression' },
  retry:       { cause: 'retry_timing',         title: 'Retry timing' },
  abandonment: { cause: 'customer_abandonment', title: 'Customer abandonment' },
  quiet:       { cause: null,                   title: 'Nothing is wrong' },
};

const money = (paise: number) => {
  const r = paise / 100;
  const sign = r < 0 ? '-' : '';
  const a = Math.abs(r);
  if (a >= 100000) return `${sign}₹${(a / 100000).toFixed(2)}L`;
  if (a >= 1000) return `${sign}₹${(a / 1000).toFixed(1)}k`;
  return `${sign}₹${a.toFixed(0)}`;
};
const pp = (x: number) => `${(x * 100).toFixed(1)}pp`;
const pctOf = (x: number) => `${(x * 100).toFixed(1)}%`;
const rule = (s = '') => console.log(`\n${'─'.repeat(74)}${s ? `\n${s}` : ''}`);

function main(): void {
  const which = (process.argv[2] ?? 'issuer').toLowerCase();
  const target = SCENARIOS[which];
  if (!target) {
    console.error(`Unknown scenario "${which}". Try: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  const corpus = buildCorpus(200);

  // Priors are earned, never handed over — see store/bootstrap.ts.
  const { priors, fromCache } = loadOrEarnPriors((epoch, size) =>
    console.log(`  warm-up epoch ${epoch}: ${size.treated} treated, ${size.holdout} held out`),
  );
  if (fromCache) console.log('\n  (priors loaded from .data/priors.json — delete it to re-learn)');

  const matching = corpus
    .slice(60)
    .filter((s) =>
      target.cause === null
        ? s.kind === 'null'
        : s.kind === 'incident' && s.trueCause === target.cause,
    );
  if (matching.length === 0) { console.error('No matching scenario in the corpus.'); process.exit(1); }

  // For a real incident, walk forward to the first window the detector
  // actually fires on, and say how many were skipped. The detector misses
  // roughly a third of incidents — mostly shallow ones spread across large
  // cohorts — and picking the first window that happens to work without
  // saying so would be quietly hiding that. Null windows are not searched:
  // the interesting behaviour there is silence.
  let pick = matching[0]!;
  let skipped = 0;
  if (target.cause !== null) {
    for (const candidate of matching) {
      const probe = generate(candidate.spec);
      if (detect(probe.events).detections.length > 0) { pick = candidate; break; }
      skipped++;
    }
  }

  const spec: ScenarioSpec = pick.spec;
  const world = generate(spec);
  const items = atRiskFrom(world.events, spec.toTs - 24 * HOUR);

  console.log(`\n  ${target.title.toUpperCase()}`);
  console.log(`  window ${new Date(spec.fromTs).toISOString().slice(0, 16)} → ${new Date(spec.toTs).toISOString().slice(0, 16)}`);
  console.log(`  ${world.events.length.toLocaleString()} synthetic events, ${items.length} failed payments in the last 24h`);
  console.log(`  priors earned during warm-up: ${priors.size().treated} treated, ${priors.size().holdout} held out`);
  if (skipped > 0) {
    console.log(`  (skipped ${skipped} window${skipped === 1 ? '' : 's'} of this type the detector missed — see EVAL.md for recall by cause)`);
  }

  const batch = runBatch({
    runId: 'demo',
    seed: spec.seed ^ 0xbeef,
    events: world.events,
    items,
    priors,
    env: makeSimulatedEnvironment(spec, spec.seed),
    nowTs: spec.toTs,
    customerStates: new Map(),
  });

  rule('  DETECTION');
  console.log(`  ${batch.cohortsTested} cohorts tested; a cohort had to clear |z| > ${batch.zThreshold.toFixed(2)}`);
  console.log('  (Šidák-corrected for the number of tests, which is what keeps null windows quiet)');
  if (batch.decisions.length === 0) {
    console.log('\n  Nothing cleared the threshold. No action, nothing spent.');
    console.log(
      target.cause === null
        ? '  Correct: this window contains nothing but ordinary daily variation.\n'
        : '  This window contains a real incident, so this is a miss, not a success.\n',
    );
    return;
  }

  for (const r of batch.decisions) {
    const d = r.detection;
    rule();
    console.log(`  Cohort        ${cohortLabel(d.cohort)}`);
    console.log(`  Success rate  ${pctOf(d.preRate)} → ${pctOf(d.postRate)}  (${pp(d.postRate - d.preRate)})`);
    console.log(`  Onset         ${new Date(d.onsetTs).toISOString().slice(11, 16)} UTC, from change-point detection`);
    console.log(`  At stake      ${money(d.exposedPaise)}`);

    rule('  DIAGNOSIS');
    if (r.verdict.kind === 'insufficient_evidence') {
      console.log(`  INSUFFICIENT EVIDENCE — ${r.verdict.reason}`);
      console.log('\n  Ranked anyway, for the record:');
      for (const h of r.verdict.ranked.slice(0, 3)) {
        console.log(`    ${(h.weight * 100).toFixed(0).padStart(3)}%  ${CAUSE_LABEL[h.cause]}`);
      }
    } else {
      const top = r.verdict.top;
      console.log(`  ${CAUSE_LABEL[top.cause]} — ${(top.weight * 100).toFixed(0)}% of the evidence weight`);
      console.log(`  Control: ${top.controlLabel}`);
      console.log('\n  For:');
      for (const e of top.evidenceFor) console.log(`    ✓ ${e}`);
      if (top.evidenceAgainst.length) {
        console.log('  Against:');
        for (const e of top.evidenceAgainst) console.log(`    ✗ ${e}`);
      }
      const runnerUp = r.verdict.ranked[1];
      if (runnerUp) {
        console.log(`\n  Next hypothesis: ${CAUSE_LABEL[runnerUp.cause]} at ${(runnerUp.weight * 100).toFixed(0)}%`);
      }
    }

    if (r.decision.options.length > 0) {
      rule('  WHAT EACH INTERVENTION IS WORTH');
      console.log('  intervention                        lift      value      cost       net   n');
      for (const o of r.decision.options) {
        console.log(
          `  ${INTERVENTION_LABEL[o.intervention].padEnd(34).slice(0, 34)}` +
          `${pp(o.lift).padStart(7)}` +
          `${money(o.expectedValuePaise).padStart(11)}` +
          `${money(o.expectedCostPaise).padStart(11)}` +
          `${money(o.netPaise).padStart(10)}` +
          `${String(o.n).padStart(5)}`,
        );
      }
    }

    if (r.decision.rejected.length > 0) {
      rule('  REJECTED');
      for (const rej of r.decision.rejected.slice(0, 5)) {
        console.log(`  ${INTERVENTION_LABEL[rej.intervention]}`);
        console.log(`    ${rej.why}`);
      }
    }

    rule(`  DECISION: ${r.decision.kind}`);
    console.log(`  ${r.decision.reason}`);
    if (r.decision.explorationNote) console.log(`\n  ${r.decision.explorationNote}`);

    const blocked = r.outcomes.filter((o) => o.arm === 'blocked');
    if (blocked.length > 0) {
      rule('  STOPPED BY RULE');
      const byRule = new Map<string, number>();
      for (const b of blocked) {
        const key = (b.blockedBy[0] ?? 'unknown').split(':')[0]!;
        byRule.set(key, (byRule.get(key) ?? 0) + 1);
      }
      for (const [k, v] of byRule) console.log(`  ${String(v).padStart(4)} × ${k}`);
      console.log(`  ${blocked[0]!.blockedBy[0]}`);
    }

    rule('  WHAT ACTUALLY HAPPENED');
    console.log(`  Treated   ${String(r.treatedN).padStart(4)} items, ${r.treatedRecovered} recovered  (${pctOf(r.treatedN ? r.treatedRecovered / r.treatedN : 0)})`);
    console.log(`  Holdout   ${String(r.holdoutN).padStart(4)} items, ${r.holdoutRecovered} recovered  (${pctOf(r.holdoutN ? r.holdoutRecovered / r.holdoutN : 0)})`);
    if (r.lift) {
      console.log(`\n  Measured lift        ${pp(r.lift.diff)}  (95% CI ${pp(r.lift.low)} – ${pp(r.lift.high)})`);
      if (!r.lift.significant) {
        console.log('  The interval spans zero. On this window, at this sample size, the');
        console.log('  intervention cannot be shown to have done anything.');
      }
    }
    console.log(`\n  Gross recovered      ${money(r.grossRecoveredPaise)}   ← what a dashboard with no holdout would claim`);
    console.log(`  Incremental          ${money(r.incrementalPaise)}   ← what the holdout says was actually caused`);
    console.log(`  Spend                ${money(r.spendPaise)}`);
    console.log(`  Net                  ${money(r.netPaise)}`);

    const best = r.decision.options.find((o) => o.intervention === r.decision.intervention);
    if (best && r.lift) {
      const err = Math.abs(best.lift - r.lift.diff);
      console.log(`\n  Predicted lift ${pp(best.lift)}, observed ${pp(r.lift.diff)} — off by ${pp(err)}.`);
      console.log('  Both arms are now written back to the priors, so the next window');
      console.log('  starts from a slightly better estimate than this one did.');
    }
  }

  rule('  BATCH TOTALS');
  const t = batch.totals;
  console.log(`  ${t.itemsConsidered} at-risk payments → ${t.itemsActedOn} acted on, ${t.itemsHeldOut} held out, ${t.itemsBlocked} stopped by rule`);
  console.log(`  decisions: ${Object.entries(t.decisionsByKind).filter(([k]) => k !== 'UNMANAGED_ITEMS').map(([k, v]) => `${v}× ${k}`).join(', ')}`);
  console.log(`  gross ${money(t.grossRecoveredPaise)} · incremental ${money(t.incrementalPaise)} · spend ${money(t.spendPaise)} · net ${money(t.netPaise)}\n`);
}

main();
