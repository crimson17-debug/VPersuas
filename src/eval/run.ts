/**
 * The evaluation harness.
 *
 *   npm run eval
 *
 * Builds 200 labelled windows, runs a warm-up phase in which the engine
 * starts with no priors at all, then evaluates on held-out windows and
 * writes EVAL.md.
 *
 * The warm-up is not a cheat, it is the learning loop. The engine begins
 * knowing nothing about which interventions work, so it cannot justify
 * acting and returns EXPERIMENT — spending a little to buy evidence. By
 * the time the evaluation split runs, the priors have been earned from
 * measured holdout comparisons rather than handed over.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generate } from '../engine/simulator/generator.js';
import { makeSimulatedEnvironment } from '../engine/runner/environment.js';
import { atRiskFrom, runBatch, type BatchResult } from '../engine/runner/index.js';
import { PriorStore } from '../engine/policy/priors.js';
import type { CustomerState } from '../engine/types.js';
import { CAUSE_LABEL } from '../engine/types.js';

import { buildCorpus, type LabelledScenario } from './corpus.js';
import { fileLedger } from '../store/ledger.js';
import type { EvalSnapshot } from '../store/types.js';
import {
  BASELINES, BASELINE_LABEL, baselinePolicy, coverAllDetection, type BaselineName,
} from './baselines.js';
import {
  abstentionMetrics, calibrationMetrics, detectionMetrics, economicTotals,
  money, pct, rateWithCi, recallByCause, rootCauseMetrics, type ScenarioRecord,
} from './metrics.js';

const CORPUS_SIZE = 200;
const WARMUP_SIZE = 60;
const WARMUP_EPOCHS = 6;

function recordFrom(
  sc: LabelledScenario,
  batch: BatchResult,
  itemsConsidered: number,
  elapsedMs: number,
): ScenarioRecord {
  const first = batch.decisions[0];
  const verdict = first?.verdict;
  const diagnosed = verdict?.kind === 'diagnosed';

  let treatedN = 0, treatedRecovered = 0, treatedAmountPaise = 0;
  let holdoutN = 0, holdoutRecovered = 0;
  for (const d of batch.decisions) {
    treatedN += d.treatedN;
    treatedRecovered += d.treatedRecovered;
    holdoutN += d.holdoutN;
    holdoutRecovered += d.holdoutRecovered;
    for (const o of d.outcomes) {
      if (o.arm === 'treated') treatedAmountPaise += o.amountPaise;
    }
  }

  return {
    treatedN, treatedRecovered, treatedAmountPaise, holdoutN, holdoutRecovered,
    id: sc.spec.id,
    kind: sc.kind,
    trueCause: sc.trueCause,
    detected: batch.decisions.length > 0,
    diagnosed,
    topCause: diagnosed ? verdict.top.cause : null,
    topWeight: diagnosed ? verdict.top.weight : null,
    rankedCauses: verdict ? (verdict.kind === 'diagnosed' ? verdict.ranked : verdict.ranked).map((h) => h.cause) : [],
    decisionKinds: batch.decisions.map((d) => d.decision.kind),
    actedAtAll: batch.decisions.some(
      (d) => d.decision.kind === 'ACT' || d.decision.kind === 'EXPERIMENT' || d.decision.kind === 'WAIT',
    ),
    grossRecoveredPaise: batch.totals.grossRecoveredPaise,
    incrementalPaise: batch.totals.incrementalPaise,
    spendPaise: batch.totals.spendPaise,
    netPaise: batch.totals.netPaise,
    itemsConsidered,
    itemsActedOn: batch.totals.itemsActedOn,
    itemsBlocked: batch.totals.itemsBlocked,
    elapsedMs,
  };
}

interface RunOptions {
  priors: PriorStore;
  states: Map<string, CustomerState>;
  baseline?: BaselineName;
  /**
   * During warm-up a larger share of each decision is spent on learning.
   * A deployment would run this deliberately for a few weeks before
   * trusting the policy; the eval compresses it into six passes and then
   * never touches these windows again.
   */
  warmup?: boolean;
}

function runScenario(sc: LabelledScenario, i: number, opts: RunOptions): ScenarioRecord {
  const t0 = performance.now();
  const world = generate(sc.spec);
  const env = makeSimulatedEnvironment(sc.spec, sc.spec.seed);

  // Only recent failures are actionable; anything older has already
  // resolved one way or the other and chasing it would be chasing ghosts.
  const items = atRiskFrom(world.events, sc.spec.toTs - 24 * 3_600_000);

  const batch = runBatch({
    runId: `${opts.baseline ?? 'engine'}_${sc.spec.id}`,
    seed: sc.spec.seed ^ (i * 2654435761),
    events: world.events,
    items,
    priors: opts.priors,
    env,
    nowTs: sc.spec.toTs,
    customerStates: opts.states,
    ...(opts.warmup ? { config: { learningSliceFraction: 0.5, explorationFraction: 0.4 } } : {}),
    ...(opts.baseline
      ? {
          policyOverride: baselinePolicy(opts.baseline, sc.spec.seed),
          syntheticDetections: coverAllDetection(items),
        }
      : {}),
  });

  return recordFrom(sc, batch, items.length, performance.now() - t0);
}

function main(): void {
  const started = Date.now();
  console.log('Building corpus…');
  const corpus = buildCorpus(CORPUS_SIZE);
  const warmup = corpus.slice(0, WARMUP_SIZE);
  const evalSet = corpus.slice(WARMUP_SIZE);

  console.log(`Corpus: ${corpus.length} windows (${warmup.length} warm-up, ${evalSet.length} held out)`);

  // ---- Phase 1: cold start ------------------------------------------
  const priors = new PriorStore();
  const warmupStates = new Map<string, CustomerState>();
  const warmupRecords: ScenarioRecord[] = [];
  console.log('Warm-up (engine begins with no priors)…');
  // Six passes over the warm-up split, each with a different run seed so
  // holdout assignment and exploration differ. Thirty-six (cause,
  // intervention) cells need filling before the policy can act on evidence
  // anywhere, and one pass over sixty windows fills perhaps four of them.
  // A real deployment accumulates this over weeks; the eval compresses it
  // into six epochs and then never touches these windows again.
  for (let epoch = 0; epoch < WARMUP_EPOCHS; epoch++) {
    warmup.forEach((sc, i) => {
      const rec = runScenario(sc, i + epoch * 991, { priors, states: warmupStates, warmup: true });
      if (epoch === WARMUP_EPOCHS - 1) warmupRecords.push(rec);
    });
    const s = priors.size();
    console.log(`  epoch ${epoch + 1}: ${s.treated} treated, ${s.holdout} held-out observations`);
  }
  const learned = priors.size();
  console.log(`  learned from ${learned.treated} treated and ${learned.holdout} held-out observations`);

  // ---- Phase 2: held-out evaluation ----------------------------------
  console.log('Evaluating engine on held-out windows…');
  const engineStates = new Map<string, CustomerState>();
  const engineRecords: ScenarioRecord[] = evalSet.map((sc, i) =>
    runScenario(sc, i + WARMUP_SIZE, { priors, states: engineStates }),
  );

  // ---- Baselines ------------------------------------------------------
  const baselineRecords = new Map<BaselineName, ScenarioRecord[]>();
  for (const b of BASELINES) {
    console.log(`Evaluating baseline: ${b}…`);
    const bPriors = new PriorStore();
    const bStates = new Map<string, CustomerState>();
    baselineRecords.set(
      b,
      evalSet.map((sc, i) => runScenario(sc, i + WARMUP_SIZE, { priors: bPriors, states: bStates, baseline: b })),
    );
  }

  const report = buildReport({
    corpus, warmupRecords, engineRecords, baselineRecords,
    learned, elapsedMs: Date.now() - started,
  });

  const out = resolve(process.cwd(), 'EVAL.md');
  writeFileSync(out, report, 'utf8');

  // Same numbers, machine-readable, for the console's evaluation screen.
  // One source so the page and the markdown can never disagree.
  fileLedger.writeEval(buildEvalSnapshot({
    corpus, engineRecords, baselineRecords, elapsedMs: Date.now() - started,
  }));

  console.log(`\nWrote ${out} and .data/evaluation.json\n`);
  console.log(summaryLine(engineRecords, baselineRecords));
}

function summaryLine(
  engine: ScenarioRecord[],
  baselines: Map<BaselineName, ScenarioRecord[]>,
): string {
  const e = economicTotals(engine);
  const d = detectionMetrics(engine);
  const rc = rootCauseMetrics(engine);
  const ab = abstentionMetrics(engine);
  const nudge = economicTotals(baselines.get('always_nudge') ?? []);
  return [
    `net value        engine ${money(e.netPaise)}  vs nudge-everything ${money(nudge.netPaise)}`,
    `gross vs real    ${money(e.grossRecoveredPaise)} claimed, ${money(e.incrementalPaise)} incremental (${pct(e.phantomShare)} phantom)`,
    `detection        precision ${pct(d.precision)}, recall ${pct(d.recall)}, FP on nulls ${pct(d.falsePositiveRateOnNulls)}`,
    `root cause       top-1 ${pct(rc.top1Rate)}, abstained on ${rc.abstained}`,
    `abstention       ${ab.nullWindowsLeftAlone}/${ab.nullWindows} nulls left alone`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function buildReport(a: {
  corpus: LabelledScenario[];
  warmupRecords: ScenarioRecord[];
  engineRecords: ScenarioRecord[];
  baselineRecords: Map<BaselineName, ScenarioRecord[]>;
  learned: { treated: number; holdout: number };
  elapsedMs: number;
}): string {
  const { engineRecords, baselineRecords, warmupRecords } = a;

  const det = detectionMetrics(engineRecords);
  const rc = rootCauseMetrics(engineRecords);
  const ab = abstentionMetrics(engineRecords);
  const cal = calibrationMetrics(engineRecords);
  const econ = economicTotals(engineRecords);

  const L: string[] = [];
  const p = (s = '') => L.push(s);

  p('# Evaluation');
  p();
  p('Generated by `npm run eval`. Reproducible: every stochastic step is seeded,');
  p('so these numbers are identical on any machine.');
  p();
  p(`- Corpus: **${a.corpus.length}** labelled 48-hour windows`);
  p(`- Warm-up split: **${warmupRecords.length}** (engine starts with zero priors)`);
  p(`- Held-out split: **${engineRecords.length}** (all figures below)`);
  p(`- Priors earned during warm-up: ${a.learned.treated} treated, ${a.learned.holdout} held-out observations`);
  p(`- Wall clock: ${(a.elapsedMs / 1000).toFixed(1)}s`);
  p();
  p('The engine never imports the ground-truth world model. `npm run check:boundaries`');
  p('fails the build if it does.');
  p();

  p('## The headline');
  p();
  p('| | |');
  p('|---|---|');
  p(`| Gross recovered (what a system with no holdout would claim) | **${money(econ.grossRecoveredPaise)}** |`);
  p(`| Recovery rate, treated arm | ${pct(econ.treatedRate)} (n=${econ.treatedN}) |`);
  p(`| Recovery rate, holdout arm | ${pct(econ.holdoutRate)} (n=${econ.holdoutN}) |`);
  p(`| Measured lift | **${(econ.liftPp * 100).toFixed(1)}pp**${econ.liftSignificant ? '' : ' — interval spans zero'} |`);
  p(`| Incremental recovered | **${money(econ.incrementalPaise)}** (95% CI ${money(econ.incrementalLowPaise)} – ${money(econ.incrementalHighPaise)}) |`);
  p(`| Share of the gross figure that was never caused | **${pct(econ.phantomShare)}** |`);
  p(`| Spend | ${money(econ.spendPaise)} |`);
  p(`| Net value created | **${money(econ.netPaise)}** (lower bound ${money(econ.netLowPaise)}) |`);
  p();
  p(`Across ${engineRecords.length} held-out windows the engine acted on ${econ.itemsActedOn}`);
  p(`items out of ${econ.itemsConsidered} at risk, and ${econ.itemsBlocked} were stopped by`);
  p('compliance rules before anything was sent.');
  p();
  p('Incremental value is pooled across the whole run rather than summed from');
  p('per-window estimates. A single window holds out twenty or thirty items, so the');
  p('lift measured inside one window is mostly noise; adding up 140 noisy estimates');
  p('produces a total whose standard error runs to lakhs. Pooling the arms first and');
  p('dividing once gives one estimate with one interval that means something.');
  p();

  p('## Against baselines');
  p();
  p('Every baseline runs the identical execution, holdout, cost and measurement path,');
  p('and sees **all** at-risk items rather than only the ones this detector flagged.');
  p();
  p('| Policy | Gross claimed | Lift | Incremental (95% CI) | Spend | Net | Items touched |');
  p('|---|---:|---:|---:|---:|---:|---:|');
  p(
    `| **This engine** | ${money(econ.grossRecoveredPaise)} | ${(econ.liftPp * 100).toFixed(1)}pp | ` +
    `${money(econ.incrementalPaise)} (${money(econ.incrementalLowPaise)}–${money(econ.incrementalHighPaise)}) | ` +
    `${money(econ.spendPaise)} | **${money(econ.netPaise)}** | ${econ.itemsActedOn} |`,
  );
  for (const b of BASELINES) {
    const t = economicTotals(baselineRecords.get(b) ?? []);
    const liftCell = t.treatedN > 0 ? `${(t.liftPp * 100).toFixed(1)}pp` : '—';
    const incCell = t.treatedN > 0
      ? `${money(t.incrementalPaise)} (${money(t.incrementalLowPaise)}–${money(t.incrementalHighPaise)})`
      : '—';
    p(
      `| ${BASELINE_LABEL[b]} | ${money(t.grossRecoveredPaise)} | ${liftCell} | ${incCell} | ` +
      `${money(t.spendPaise)} | ${money(t.netPaise)} | ${t.itemsActedOn} |`,
    );
  }
  p();

  const nudge = economicTotals(baselineRecords.get('always_nudge') ?? []);
  const discount = economicTotals(baselineRecords.get('always_discount') ?? []);
  const never = economicTotals(baselineRecords.get('never_act') ?? []);
  p('Read this table honestly:');
  p();
  p(`- Nudge-everything claims **${money(nudge.grossRecoveredPaise)}** gross and delivers`);
  p(`  **${money(nudge.incrementalPaise)}** incremental for ${money(nudge.spendPaise)} of spend.`);
  p(`  Its gross figure is the number a dashboard would print.`);
  p(`- Discount-everything claims ${money(discount.grossRecoveredPaise)} and nets`);
  p(`  ${money(discount.netPaise)}, because the discount is paid on every recovery`);
  p('  including the ones that needed no help.');
  p(`- Do-nothing spends nothing and creates nothing measurable. It is the floor every`);
  p('  other policy has to clear, and on the null windows it is the correct policy —');
  p('  which is why this engine matches it there rather than trying to beat it.');
  p();
  p('An interval that spans zero in this table is not a rounding artefact. It means');
  p('that policy cannot be shown to have worked at this sample size, and reporting it');
  p('as a win would be the exact error this project exists to point at.');
  p();

  p('## Detection');
  p();
  p(`- Precision: ${rateWithCi(det.truePositives, det.truePositives + det.falsePositives)}`);
  p(`- Recall: ${rateWithCi(det.truePositives, det.truePositives + det.falseNegatives)}`);
  p(`- **False positives on null windows: ${rateWithCi(Math.round(det.falsePositiveRateOnNulls * det.nullWindows), det.nullWindows)}**`);
  p();
  p('The null windows contain nothing but ordinary daily variation, and half of them');
  p('ship a checkout release anyway so that "a release happened" is never on its own');
  p('enough to convict. Several hundred cohorts are tested per window, so the');
  p('significance threshold is Šidák-corrected for the number of tests actually run.');
  p();
  p('### Recall by cause');
  p();
  p('An aggregate recall number hides blind spots, so here is where the misses are.');
  p();
  p('| True cause | Detected | Windows | Recall |');
  p('|---|---:|---:|---:|');
  for (const [cause, v] of [...recallByCause(engineRecords)].sort((x, y) => x[0].localeCompare(y[0]))) {
    p(`| ${CAUSE_LABEL[cause as keyof typeof CAUSE_LABEL] ?? cause} | ${v.detected} | ${v.total} | ${pct(v.total ? v.detected / v.total : 0)} |`);
  }
  p();
  p('Misses concentrate in the low-severity, broad-cohort incidents — a shallow');
  p('conversion decline spread thinly across a large cohort does not clear a');
  p('multiple-comparison-corrected threshold, and lowering that threshold to catch');
  p('them would put false positives back on the null windows. That trade is the');
  p('detector\'s single most consequential setting and it is deliberately tuned');
  p('toward silence.');
  p();

  p('## Root cause');
  p();
  p(`- Windows with a true cause that were detected: ${rc.considered}`);
  p(`- A call was made on ${rc.diagnosed}; the engine abstained on ${rc.abstained}`);
  p(`- Top-1 over all detected windows: ${rateWithCi(rc.top1, rc.considered)}`);
  p(`- Top-3 over all detected windows: ${rateWithCi(rc.top3, rc.considered)}`);
  p(`- Top-1 among windows where a call was made: ${rateWithCi(rc.top1, rc.diagnosed)}`);
  p();
  if (rc.confusion.size > 0) {
    p('### What it got wrong');
    p();
    p('| Truth → called | Count |');
    p('|---|---:|');
    for (const [k, v] of [...rc.confusion].sort((x, y) => y[1] - x[1])) {
      p(`| ${k} | ${v} |`);
    }
    p();
  }

  p('## Abstention');
  p();
  p(`- Null windows left completely alone: **${ab.nullWindowsLeftAlone}/${ab.nullWindows}** (${pct(ab.nullSilenceRate)})`);
  p(`- Ambiguous windows where the engine returned insufficient evidence: **${ab.ambiguousAbstained}/${ab.ambiguousWindows}** (${pct(ab.ambiguousAbstentionRate)})`);
  p();
  p('Ambiguous windows contain two real causes at once — an issuer wobble and a');
  p('checkout regression starting within an hour of each other on overlapping traffic.');
  p('The affected cohort then carries a mix of failure reasons and no hypothesis can');
  p('take a majority of the evidence. There is a correct answer and it is not a cause:');
  p('it is "these cannot be separated". Naming either one confidently would be wrong');
  p('even on the windows where it happens to match the larger incident, which is why');
  p('these windows are excluded from the root-cause accuracy above.');
  p();

  p('## Calibration');
  p();
  p(`Brier score: **${cal.brier.toFixed(3)}** (0.25 is what always saying 50% gets you).`);
  p(`Expected calibration error: **${pct(cal.ece)}** over ${cal.n} diagnosed windows.`);
  p();
  p('| Stated confidence | Windows | Mean stated | Observed correct |');
  p('|---|---:|---:|---:|');
  for (const b of cal.bins) {
    if (b.n === 0) continue;
    p(`| ${pct(b.lower, 0)}–${pct(b.upper, 0)} | ${b.n} | ${pct(b.meanPredicted)} | ${pct(b.observed)} |`);
  }
  p();

  p('## Speed');
  p();
  const times = engineRecords.map((r) => r.elapsedMs).sort((x, y) => x - y);
  const median = times[Math.floor(times.length / 2)] ?? 0;
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  p(`Median time from raw events to a decision: **${median.toFixed(0)}ms** (p95 ${p95.toFixed(0)}ms),`);
  p('over roughly 4,000–6,000 events and several hundred cohort tests per window.');
  p();

  p('## What this evaluation does not prove');
  p();
  p('- The event history is synthetic. These numbers measure the engine against a');
  p('  simulator, not against production traffic, and no claim about real-world revenue');
  p('  lift follows from them.');
  p('- Cost and uplift structures are assumptions. They are plausible and they are');
  p('  stated in the open, but they are assumptions.');
  p('- Difference-in-differences assumes treated and control cohorts would have moved');
  p('  in parallel absent the cause. That assumption is checked in the pre-period and');
  p('  it can still be wrong.');
  p();

  return L.join('\n') + '\n';
}

function buildEvalSnapshot(a: {
  corpus: LabelledScenario[];
  engineRecords: ScenarioRecord[];
  baselineRecords: Map<BaselineName, ScenarioRecord[]>;
  elapsedMs: number;
}): EvalSnapshot {
  const { engineRecords, baselineRecords } = a;
  const econ = economicTotals(engineRecords);
  const det = detectionMetrics(engineRecords);
  const rc = rootCauseMetrics(engineRecords);
  const ab = abstentionMetrics(engineRecords);
  const cal = calibrationMetrics(engineRecords);

  const row = (key: string, label: string, isEngine: boolean, t: ReturnType<typeof economicTotals>) => ({
    key, label, isEngine,
    grossRecoveredPaise: t.grossRecoveredPaise,
    liftPp: t.liftPp,
    incrementalPaise: t.incrementalPaise,
    incrementalLowPaise: t.incrementalLowPaise,
    incrementalHighPaise: t.incrementalHighPaise,
    spendPaise: t.spendPaise,
    netPaise: t.netPaise,
    itemsActedOn: t.itemsActedOn,
    significant: t.liftSignificant,
  });

  const times = engineRecords.map((r) => r.elapsedMs).sort((x, y) => x - y);

  return {
    generatedAt: Date.now(),
    corpusSize: a.corpus.length,
    warmupSize: WARMUP_SIZE,
    heldOutSize: engineRecords.length,
    elapsedMs: a.elapsedMs,
    policies: [
      row('engine', 'This engine', true, econ),
      ...BASELINES.map((b) => row(b, BASELINE_LABEL[b], false, economicTotals(baselineRecords.get(b) ?? []))),
    ],
    detection: {
      precision: det.precision,
      recall: det.recall,
      truePositives: det.truePositives,
      falsePositives: det.falsePositives,
      falseNegatives: det.falseNegatives,
      nullWindows: det.nullWindows,
      falsePositivesOnNulls: Math.round(det.falsePositiveRateOnNulls * det.nullWindows),
    },
    recallByCause: [...recallByCause(engineRecords)]
      .map(([cause, v]) => ({ cause, detected: v.detected, total: v.total }))
      .sort((x, y) => x.cause.localeCompare(y.cause)),
    rootCause: {
      considered: rc.considered,
      diagnosed: rc.diagnosed,
      abstained: rc.abstained,
      top1: rc.top1,
      top3: rc.top3,
      confusion: [...rc.confusion]
        .map(([pair, count]) => ({ pair, count }))
        .sort((x, y) => y.count - x.count),
    },
    abstention: {
      nullWindows: ab.nullWindows,
      nullWindowsLeftAlone: ab.nullWindowsLeftAlone,
      ambiguousWindows: ab.ambiguousWindows,
      ambiguousAbstained: ab.ambiguousAbstained,
    },
    calibration: {
      brier: cal.brier,
      ece: cal.ece,
      n: cal.n,
      bins: cal.bins.filter((b) => b.n > 0),
    },
    speed: {
      medianMs: times[Math.floor(times.length / 2)] ?? 0,
      p95Ms: times[Math.floor(times.length * 0.95)] ?? 0,
    },
  };
}

main();
