/**
 * The twin test.
 *
 * Two fleets are generated with the same seed, the same rail, the same
 * window, the same severity and the same shape. In one, the cause is an
 * issuer degradation and every merchant on that rail is hit. In the other,
 * the cause is a checkout regression in a single merchant.
 *
 * The focus merchant is affected in both, and its own data is close to
 * identical in both. Any engine that looks only at one merchant is
 * guessing. The point of this script is to show it guessing, then show the
 * same engine given fleet-level evidence and getting both right.
 *
 *   npm run federated
 */

import { detect } from '../engine/detector/index.js';
import { diagnose } from '../engine/diagnosis/index.js';
import {
  assessNetwork, buildContribution, findingFor,
  type NetworkAssessment, type NetworkContribution,
} from '../engine/network/index.js';
import { generateFleet, twinScenarios, type GeneratedFleet } from '../engine/simulator/fleet.js';
import { CAUSE_LABEL, cohortLabel } from '../engine/types.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const R = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function rule(char = '─'): void {
  console.log(DIM + char.repeat(74) + R);
}

function heading(text: string): void {
  console.log('');
  console.log(BOLD + text + R);
  rule();
}

interface Outcome {
  detected: boolean;
  cohortLabel: string;
  verdict: 'diagnosed' | 'insufficient_evidence';
  cause: string | null;
  weight: number;
  reason: string;
  /** The rail the detected cohort sits on, so the report shows the right one. */
  rail: { method?: string; issuer?: string };
}

function runFocus(fleet: GeneratedFleet, assessment: NetworkAssessment | null): Outcome {
  const events = fleet.focus.world.events;
  const run = detect(events);
  const d = run.detections[0];

  if (!d) {
    return {
      detected: false, cohortLabel: '—', verdict: 'insufficient_evidence',
      cause: null, weight: 0, reason: 'nothing cleared the detection threshold',
      rail: {},
    };
  }

  const finding = findingFor(assessment, d.cohort.method, d.cohort.issuer);
  const verdict = diagnose(events, d, undefined, finding);

  if (verdict.kind === 'diagnosed') {
    return {
      detected: true,
      cohortLabel: cohortLabel(d.cohort),
      verdict: 'diagnosed',
      cause: verdict.top.cause,
      weight: verdict.top.weight,
      reason: '',
      rail: { method: d.cohort.method, issuer: d.cohort.issuer },
    };
  }
  return {
    detected: true,
    cohortLabel: cohortLabel(d.cohort),
    verdict: 'insufficient_evidence',
    cause: verdict.ranked[0]?.cause ?? null,
    weight: verdict.ranked[0]?.weight ?? 0,
    reason: verdict.reason,
    rail: { method: d.cohort.method, issuer: d.cohort.issuer },
  };
}

/** Every merchant computes locally and publishes only aggregate signals. */
function collect(fleet: GeneratedFleet): NetworkContribution[] {
  return fleet.merchants.map((m) =>
    buildContribution(m.world.events, m.contributorId),
  );
}

function report(
  title: string,
  fleet: GeneratedFleet,
  solo: Outcome,
  federated: Outcome,
  assessment: NetworkAssessment,
): boolean {
  const truth = fleet.trueCause;
  const truthLabel = truth ? CAUSE_LABEL[truth] : 'nothing';

  heading(title);

  const affected = fleet.merchants.filter((m) => m.affected).length;
  console.log(
    `${DIM}ground truth${R}  ${truthLabel}   ` +
    `${DIM}·${R}  ${affected} of ${fleet.merchants.length} merchants affected   ` +
    `${DIM}·${R}  focus merchant #${fleet.focus.index}`,
  );
  console.log(`${DIM}focus merchant sees${R}  ${solo.cohortLabel}`);

  // Look up the rail the merchant actually landed on, not whichever rail
  // happens to sort first. Showing an unrelated rail's numbers next to
  // this merchant's verdict is how a demo quietly lies.
  const finding = findingFor(assessment, solo.rail.method, solo.rail.issuer);

  console.log('');
  console.log(`${BOLD}A · alone${R}  ${DIM}(one merchant's own data — every other submission today)${R}`);
  if (solo.verdict === 'diagnosed') {
    const right = solo.cause === truth;
    console.log(
      `   verdict    ${right ? GREEN : RED}${CAUSE_LABEL[solo.cause as never] ?? solo.cause}${R} ` +
      `at ${Math.round(solo.weight * 100)}% weight  ${right ? GREEN + '✓ correct' : RED + '✗ WRONG'}${R}`,
    );
  } else {
    console.log(`   verdict    ${YELLOW}INSUFFICIENT EVIDENCE${R}`);
    console.log(`   ${DIM}${solo.reason}${R}`);
  }

  console.log('');
  console.log(`${BOLD}B · with the network${R}  ${DIM}(same engine, same merchant, plus anonymous fleet signals)${R}`);
  if (finding && finding.verdict !== 'below_k_anonymity') {
    console.log(
      `   network    ${BOLD}${finding.degradedCount} of ${finding.contributors}${R} merchants on ` +
      `${finding.method}/${finding.issuer} independently degraded  ` +
      `${DIM}·${R} Stouffer Z ${finding.combinedZ.toFixed(1)}  ` +
      `${DIM}·${R} I² ${Math.round(finding.iSquared * 100)}%  ` +
      (finding.onsetSpreadMinutes !== null
        ? `${DIM}·${R} onsets within ${Math.round(finding.onsetSpreadMinutes)}min`
        : ''),
    );
    console.log(
      `   ruling     ${CYAN}${finding.verdict.replace(/_/g, ' ')}${R}` +
      (finding.confidence > 0 ? ` at ${Math.round(finding.confidence * 100)}% confidence` : ''),
    );
  } else {
    console.log(`   network    ${DIM}below k-anonymity floor — withheld${R}`);
  }

  let correct = false;
  if (federated.verdict === 'diagnosed') {
    correct = federated.cause === truth;
    console.log(
      `   verdict    ${correct ? GREEN : RED}${CAUSE_LABEL[federated.cause as never] ?? federated.cause}${R} ` +
      `at ${Math.round(federated.weight * 100)}% weight  ${correct ? GREEN + '✓ correct' : RED + '✗ WRONG'}${R}`,
    );
  } else {
    console.log(`   verdict    ${YELLOW}INSUFFICIENT EVIDENCE${R}`);
    console.log(`   ${DIM}${federated.reason}${R}`);
  }

  return correct;
}

function main(): void {
  const seed = 20260905;
  const { issuerWide, merchantOnly } = twinScenarios(seed);

  console.log('');
  console.log(BOLD + 'FEDERATED RAIL INTELLIGENCE — the twin test' + R);
  rule('═');
  console.log(
    `${DIM}Two fleets, one seed. Identical rail, window, severity and shape.${R}`,
  );
  console.log(
    `${DIM}The only difference is how many merchants the cause reaches —${R}`,
  );
  console.log(
    `${DIM}which is exactly the information a single merchant does not have.${R}`,
  );

  let score = 0;

  for (const spec of [issuerWide, merchantOnly]) {
    const fleet = generateFleet(spec);
    const contributions = collect(fleet);
    const assessment = assessNetwork(contributions, spec.toTs);

    const solo = runFocus(fleet, null);
    const federated = runFocus(fleet, assessment);

    const title =
      spec.incident?.cause === 'issuer_degradation'
        ? 'SCENARIO 1 — the issuer really is degraded (whole fleet hit)'
        : 'SCENARIO 2 — identical signature, but only this merchant is broken';

    if (report(title, fleet, solo, federated, assessment)) score++;
  }

  heading('WHAT THIS SHOWS');
  console.log(
    'The two scenarios are indistinguishable inside one merchant. No model,\n' +
    'no prompt and no amount of tuning separates them, because the\n' +
    'distinguishing information is not present in the data. It exists only\n' +
    'across merchants — and only a payment processor is standing where it\n' +
    'can be seen.',
  );
  console.log('');
  console.log(
    `Federated diagnosis was correct on ${BOLD}${score}/2${R} twins.`,
  );
  console.log('');
  console.log(
    `${DIM}Contributed per merchant: method, issuer, z, effect, n, onset hour.${R}\n` +
    `${DIM}Not contributed: identity, customers, orders, amounts, devices.${R}\n` +
    `${DIM}No rail is reported below 5 independent contributors.${R}`,
  );
  console.log('');
}

main();
