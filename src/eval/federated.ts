/**
 * Does federation actually help, or does it just sound like it should?
 *
 * The twin script shows two hand-picked fleets. Two cases prove nothing —
 * any seed can be lucky. This runs many independently seeded twin pairs and
 * measures the same engine twice on each: once with only the focus
 * merchant's own data, once with anonymous fleet signals added.
 *
 * Everything else is held constant. Same detector, same diagnosis code,
 * same thresholds, same merchant, same events. The only variable is
 * whether the network is consulted, which is what makes the difference
 * attributable to federation rather than to two different engines.
 *
 * Written to EVAL_FEDERATED.md and .data/federated.json.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { detect } from '../engine/detector/index.js';
import { diagnose } from '../engine/diagnosis/index.js';
import {
  assessNetwork, buildContribution, findingFor,
  type NetworkAssessment,
} from '../engine/network/index.js';
import { generateFleet, twinScenarios, type GeneratedFleet } from '../engine/simulator/fleet.js';
import type { CauseType } from '../engine/types.js';
import { CAUSE_LABEL } from '../engine/types.js';

const PAIRS = 24;

type Arm = 'solo' | 'federated';

interface Case {
  seed: number;
  scenario: 'issuer_wide' | 'merchant_only';
  truth: CauseType;
  detected: boolean;
  solo: { called: CauseType | null; abstained: boolean };
  federated: { called: CauseType | null; abstained: boolean };
  networkVerdict: string;
  contributors: number;
  degradedCount: number;
}

interface ArmScore {
  arm: Arm;
  decided: number;
  correct: number;
  wrong: number;
  abstained: number;
  /** Accuracy over cases where the arm committed to an answer. */
  precision: number;
  /** Correct answers over all detected cases, abstentions counted as misses. */
  recall: number;
}

function evaluateFocus(
  fleet: GeneratedFleet,
  assessment: NetworkAssessment | null,
): { detected: boolean; called: CauseType | null; abstained: boolean; finding: ReturnType<typeof findingFor> } {
  const events = fleet.focus.world.events;
  const run = detect(events);
  const d = run.detections[0];
  if (!d) return { detected: false, called: null, abstained: true, finding: null };

  const finding = findingFor(assessment, d.cohort.method, d.cohort.issuer);
  const verdict = diagnose(events, d, undefined, finding);

  if (verdict.kind === 'diagnosed') {
    return { detected: true, called: verdict.top.cause, abstained: false, finding };
  }
  return { detected: true, called: null, abstained: true, finding };
}

function score(cases: readonly Case[], arm: Arm): ArmScore {
  const detected = cases.filter((c) => c.detected);
  let correct = 0, wrong = 0, abstained = 0;
  for (const c of detected) {
    const r = c[arm];
    if (r.abstained) abstained++;
    else if (r.called === c.truth) correct++;
    else wrong++;
  }
  const decided = correct + wrong;
  return {
    arm,
    decided,
    correct,
    wrong,
    abstained,
    precision: decided > 0 ? correct / decided : 0,
    recall: detected.length > 0 ? correct / detected.length : 0,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  const cases: Case[] = [];

  for (let i = 0; i < PAIRS; i++) {
    const seed = 4_100_000 + i * 977;
    const { issuerWide, merchantOnly } = twinScenarios(seed);

    for (const spec of [issuerWide, merchantOnly]) {
      const fleet = generateFleet(spec);
      const assessment = assessNetwork(
        fleet.merchants.map((m) => buildContribution(m.world.events, m.contributorId)),
        spec.toTs,
      );

      const solo = evaluateFocus(fleet, null);
      const federated = evaluateFocus(fleet, assessment);

      cases.push({
        seed,
        scenario: spec.incident?.cause === 'issuer_degradation' ? 'issuer_wide' : 'merchant_only',
        truth: fleet.trueCause!,
        detected: solo.detected,
        solo: { called: solo.called, abstained: solo.abstained },
        federated: { called: federated.called, abstained: federated.abstained },
        networkVerdict: federated.finding?.verdict ?? 'none',
        contributors: federated.finding?.contributors ?? 0,
        degradedCount: federated.finding?.degradedCount ?? 0,
      });
    }
  }

  const soloScore = score(cases, 'solo');
  const fedScore = score(cases, 'federated');

  const byScenario = (s: Case['scenario']) => {
    const subset = cases.filter((c) => c.scenario === s);
    return { solo: score(subset, 'solo'), federated: score(subset, 'federated'), n: subset.length };
  };
  const wide = byScenario('issuer_wide');
  const only = byScenario('merchant_only');

  // The cases that matter most: where federation changed the answer.
  const flippedToCorrect = cases.filter(
    (c) => c.detected && c.solo.called !== c.truth && c.federated.called === c.truth,
  );
  const flippedToWrong = cases.filter(
    (c) => c.detected && c.solo.called === c.truth && c.federated.called !== c.truth,
  );

  const detectedN = cases.filter((c) => c.detected).length;

  const lines: string[] = [];
  lines.push('# Federated diagnosis — measured effect');
  lines.push('');
  lines.push(
    `Generated by \`npm run eval:federated\`. ${PAIRS} independently seeded twin ` +
    `pairs, ${cases.length} fleets, ${detectedN} of which produced a detection ` +
    `in the focus merchant.`,
  );
  lines.push('');
  lines.push(
    'Each twin pair is the same rail, window, severity, duration and failure ' +
    'reason. One is a genuine issuer degradation across the fleet; the other ' +
    'is retry timing in a single merchant. Inside the focus merchant the two ' +
    'are the same event. Only the fleet can tell them apart.',
  );
  lines.push('');
  lines.push('## Root cause, same engine, with and without the network');
  lines.push('');
  lines.push('| Arm | Committed | Correct | Wrong | Abstained | Accuracy when committed | Correct of all detected |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const s of [soloScore, fedScore]) {
    lines.push(
      `| ${s.arm === 'solo' ? 'Merchant alone' : '**With network**'} | ${s.decided} | ${s.correct} | ` +
      `${s.wrong} | ${s.abstained} | ${pct(s.precision)} | ${pct(s.recall)} |`,
    );
  }
  lines.push('');
  lines.push('## Split by which world the fleet was in');
  lines.push('');
  lines.push('| Scenario | n | Solo correct | Federated correct |');
  lines.push('|---|---:|---:|---:|');
  lines.push(
    `| Issuer genuinely degraded (fleet-wide) | ${wide.n} | ${wide.solo.correct} | ${wide.federated.correct} |`,
  );
  lines.push(
    `| Only this merchant broken | ${only.n} | ${only.solo.correct} | ${only.federated.correct} |`,
  );
  lines.push('');
  lines.push(
    `The second row is the whole argument. A single merchant has no way to ` +
    `know it is the only one affected, so it reads its own outage as the ` +
    `rail's. The fleet is the only thing that can correct it.`,
  );
  lines.push('');
  lines.push('## What changed');
  lines.push('');
  lines.push(`- Corrected by the network: **${flippedToCorrect.length}**`);
  lines.push(`- Broken by the network: **${flippedToWrong.length}**`);
  lines.push('');
  if (flippedToWrong.length > 0) {
    lines.push(
      'Regressions are listed rather than omitted. Federation is evidence, ' +
      'not authority, and evidence can point the wrong way.',
    );
    lines.push('');
    lines.push('| Seed | Scenario | Truth | Solo | Federated | Network |');
    lines.push('|---|---|---|---|---|---|');
    for (const c of flippedToWrong) {
      lines.push(
        `| ${c.seed} | ${c.scenario} | ${CAUSE_LABEL[c.truth]} | ${c.solo.called ? CAUSE_LABEL[c.solo.called] : '—'} | ` +
        `${c.federated.called ? CAUSE_LABEL[c.federated.called] : 'abstained'} | ${c.networkVerdict} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Network rulings issued');
  lines.push('');
  const rulingCounts = new Map<string, number>();
  for (const c of cases) {
    rulingCounts.set(c.networkVerdict, (rulingCounts.get(c.networkVerdict) ?? 0) + 1);
  }
  lines.push('| Ruling | Cases |');
  lines.push('|---|---:|');
  for (const [k, v] of [...rulingCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${k.replace(/_/g, ' ')} | ${v} |`);
  }
  lines.push('');
  lines.push('## What this does not show');
  lines.push('');
  lines.push(
    '- The fleet is synthetic. Real merchants are not independent draws: they ' +
    'share seasonality, campaigns and customers, and correlated traffic would ' +
    'weaken the independence Stouffer assumes.',
  );
  lines.push(
    '- Every contributor here runs the identical detector. A real network ' +
    'would have version skew, and a merchant on an older build would ' +
    'contribute a subtly different statistic.',
  );
  lines.push(
    '- The k-anonymity floor is a structural guarantee about what is ' +
    'published, not a formal differential-privacy budget. Repeated queries ' +
    'across many windows still leak, slowly, and a production version would ' +
    'need noise added and a budget tracked.',
  );
  lines.push('');

  writeFileSync('EVAL_FEDERATED.md', lines.join('\n'), 'utf8');

  // A fully-detailed representative pair for the console to render. Built
  // from the same code path as the aggregate above rather than hand-written,
  // so the screen cannot drift away from the measurement.
  // One pair rendered in full on the console. It is chosen from the same
  // seeded set measured above rather than tuned, and it is a clean example
  // rather than a typical one — the aggregate table is the honest claim,
  // and the console links to it for exactly that reason.
  const showcaseSeed = 4_107_816;
  const showcase = twinScenarios(showcaseSeed);
  const twins = (['issuerWide', 'merchantOnly'] as const).map((key) => {
    const spec = showcase[key];
    const fleet = generateFleet(spec);
    const assessment = assessNetwork(
      fleet.merchants.map((m) => buildContribution(m.world.events, m.contributorId)),
      spec.toTs,
    );
    const solo = evaluateFocus(fleet, null);
    const fed = evaluateFocus(fleet, assessment);
    const f = fed.finding;

    return {
      key,
      truth: fleet.trueCause,
      merchantsAffected: fleet.merchants.filter((m) => m.affected).length,
      fleetSize: fleet.merchants.length,
      focusIndex: fleet.focus.index,
      solo: { called: solo.called, abstained: solo.abstained, correct: solo.called === fleet.trueCause },
      federated: { called: fed.called, abstained: fed.abstained, correct: fed.called === fleet.trueCause },
      finding: f
        ? {
            method: f.method, issuer: f.issuer, verdict: f.verdict,
            contributors: f.contributors, degradedCount: f.degradedCount,
            degradedShare: f.degradedShare, combinedZ: f.combinedZ,
            pooledDiff: f.pooledDiff, iSquared: f.iSquared,
            onsetSpreadMinutes: f.onsetSpreadMinutes, confidence: f.confidence,
          }
        : null,
      rails: assessment.findings
        .filter((x) => x.verdict !== 'below_k_anonymity')
        .slice(0, 8)
        .map((x) => ({
          method: x.method, issuer: x.issuer, verdict: x.verdict,
          contributors: x.contributors, degradedCount: x.degradedCount,
          combinedZ: x.combinedZ, pooledDiff: x.pooledDiff,
          iSquared: x.iSquared, confidence: x.confidence,
        })),
      withheld: assessment.findings.filter((x) => x.verdict === 'below_k_anonymity').length,
      kAnonymity: assessment.kAnonymity,
    };
  });

  mkdirSync(join(process.cwd(), '.data'), { recursive: true });
  writeFileSync(
    join(process.cwd(), '.data', 'network.json'),
    JSON.stringify(
      {
        generatedAt: Date.now(),
        pairs: PAIRS,
        detected: detectedN,
        solo: soloScore,
        federated: fedScore,
        byScenario: { issuerWide: wide, merchantOnly: only },
        correctedByNetwork: flippedToCorrect.length,
        brokenByNetwork: flippedToWrong.length,
        twins,
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(process.cwd(), '.data', 'federated.json'),
    JSON.stringify(
      {
        pairs: PAIRS,
        fleets: cases.length,
        detected: detectedN,
        solo: soloScore,
        federated: fedScore,
        byScenario: { issuerWide: wide, merchantOnly: only },
        correctedByNetwork: flippedToCorrect.length,
        brokenByNetwork: flippedToWrong.length,
        rulings: Object.fromEntries(rulingCounts),
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log('');
  console.log('FEDERATED EVALUATION');
  console.log('─'.repeat(62));
  console.log(`twin pairs           ${PAIRS}   (${cases.length} fleets, ${detectedN} detected)`);
  console.log('');
  console.log(`merchant alone       ${soloScore.correct}/${detectedN} correct   ${pct(soloScore.recall)}`);
  console.log(`with the network     ${fedScore.correct}/${detectedN} correct   ${pct(fedScore.recall)}`);
  console.log('');
  console.log(`corrected by network ${flippedToCorrect.length}`);
  console.log(`broken by network    ${flippedToWrong.length}`);
  console.log('');
  console.log('wrote EVAL_FEDERATED.md and .data/federated.json');
  console.log('');
}

main();
