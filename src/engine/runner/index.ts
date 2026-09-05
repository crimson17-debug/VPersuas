/**
 * The batch runner.
 *
 * Detect, diagnose, decide, gate, execute, measure, learn — over a batch of
 * at-risk payments, which is what the track brief asks for and what a
 * single hero incident cannot demonstrate.
 *
 * The part that matters is the holdout. Every batch that acts withholds a
 * random slice of the affected cohort and does nothing to it. The
 * difference between the two arms is the only number here that is a
 * measurement rather than an assertion, and it is routinely a third of
 * what the gross figure would have claimed.
 */

import type {
  AtRiskItem, CustomerState, Decision, Detection, DiagnosisVerdict,
  Intervention, PaymentEvent,
} from '../types.js';
import { stableUnit, makeRng } from '../rng.js';
import { twoProportion, type TwoProportionResult } from '../stats.js';
import { detect, DEFAULT_DETECTOR_CONFIG, type DetectorConfig } from '../detector/index.js';
import { diagnose, DEFAULT_DIAGNOSIS_CONFIG, type DiagnosisConfig } from '../diagnosis/index.js';
import { decide, DEFAULT_POLICY_CONFIG, type PolicyConfig } from '../policy/index.js';
import { PriorStore } from '../policy/priors.js';
import {
  checkCompliance, channelForAttempt, idempotencyKey,
  DEFAULT_COMPLIANCE, type ComplianceConfig,
} from '../policy/compliance.js';
import { CONDITIONAL_COST_RATE, DECISION_COST_PAISE, FIXED_COST_PAISE, isCustomerContact } from '../policy/costs.js';
import type { Environment } from './environment.js';

export type Arm = 'treated' | 'holdout' | 'blocked' | 'unmanaged';

export interface ItemOutcome {
  itemId: string;
  customerId: string;
  decisionId: string | null;
  arm: Arm;
  intervention: Intervention;
  recovered: boolean;
  amountPaise: number;
  spendPaise: number;
  blockedBy: string[];
  idempotencyKey: string | null;
}

export interface DecisionResult {
  detection: Detection;
  verdict: DiagnosisVerdict;
  decision: Decision;
  treatedN: number;
  treatedRecovered: number;
  holdoutN: number;
  holdoutRecovered: number;
  blockedN: number;
  /** Measured incremental lift, treated minus holdout. */
  lift: TwoProportionResult | null;
  grossRecoveredPaise: number;
  incrementalPaise: number;
  incrementalLowPaise: number;
  incrementalHighPaise: number;
  spendPaise: number;
  netPaise: number;
  outcomes: ItemOutcome[];
}

export interface BatchTotals {
  itemsConsidered: number;
  itemsActedOn: number;
  itemsHeldOut: number;
  itemsBlocked: number;
  /** What a system with no holdout would have claimed. */
  grossRecoveredPaise: number;
  /** What the holdout says was actually caused. */
  incrementalPaise: number;
  incrementalLowPaise: number;
  incrementalHighPaise: number;
  spendPaise: number;
  netPaise: number;
  decisionsByKind: Record<string, number>;
}

export interface BatchResult {
  runId: string;
  seed: number;
  decisions: DecisionResult[];
  totals: BatchTotals;
  cohortsTested: number;
  zThreshold: number;
  unmanaged: ItemOutcome[];
}

export interface RunConfig {
  holdoutFraction: number;
  /** Share of items an EXPERIMENT decision spends on exploration. */
  explorationFraction: number;
  /**
   * Share of an ACTING decision permanently reserved for learning about an
   * under-explored option. Without this the first intervention to clear the
   * sample floor is the only one ever used, and a better one that was never
   * tried stays invisible — which is exactly what happened before this
   * existed: checkout rollback recovers 34 points on a regression and the
   * engine had never once tried it.
   */
  learningSliceFraction: number;
  detector: DetectorConfig;
  diagnosis: DiagnosisConfig;
  policy: PolicyConfig;
  compliance: ComplianceConfig;
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  holdoutFraction: 0.2,
  explorationFraction: 0.8,
  learningSliceFraction: 0.15,
  detector: DEFAULT_DETECTOR_CONFIG,
  diagnosis: DEFAULT_DIAGNOSIS_CONFIG,
  policy: DEFAULT_POLICY_CONFIG,
  compliance: DEFAULT_COMPLIANCE,
};

const EXPLORABLE: Intervention[] = [
  'alternate_method', 'wait_and_retry', 'immediate_retry', 'nudge',
  'discount_nudge', 'checkout_rollback',
];

/** Derive at-risk items from failed payments in a window. */
export function atRiskFrom(events: readonly PaymentEvent[], fromTs?: number): AtRiskItem[] {
  const out: AtRiskItem[] = [];
  for (const e of events) {
    if (e.outcome !== 'failed' || !e.failureReason) continue;
    if (fromTs !== undefined && e.ts < fromTs) continue;
    out.push({
      id: `item_${e.id}`,
      customerId: e.customerId,
      orderId: e.orderId,
      eventId: e.id,
      amountPaise: e.amountPaise,
      failedAt: e.ts,
      method: e.method,
      issuer: e.issuer,
      device: e.device,
      valueBand: e.valueBand,
      customerType: e.customerType,
      checkoutVersion: e.checkoutVersion,
      failureReason: e.failureReason,
    });
  }
  return out;
}

function itemInCohort(item: AtRiskItem, cohort: Record<string, string | undefined>): boolean {
  for (const [k, v] of Object.entries(cohort)) {
    if (v === undefined) continue;
    if (String((item as unknown as Record<string, unknown>)[k]) !== v) return false;
  }
  return true;
}

export interface RunInput {
  runId: string;
  seed: number;
  events: readonly PaymentEvent[];
  items: readonly AtRiskItem[];
  priors: PriorStore;
  env: Environment;
  nowTs: number;
  customerStates?: Map<string, CustomerState>;
  config?: Partial<RunConfig>;
  /**
   * Overrides the policy entirely — used by the evaluation baselines to
   * run "nudge everything" and friends through the identical execution,
   * measurement and cost path, so the comparison is like for like.
   */
  policyOverride?: (input: {
    detection: Detection; verdict: DiagnosisVerdict; items: readonly AtRiskItem[]; decisionId: string;
  }) => Decision;
  /**
   * Bypasses detection. The evaluation baselines use this to operate on
   * every at-risk item rather than only the ones the detector flagged —
   * "nudge everything" would otherwise be handicapped by this system's own
   * detector, and beating a baseline you crippled proves nothing.
   */
  syntheticDetections?: Detection[];
}

export function runBatch(input: RunInput): BatchResult {
  const cfg: RunConfig = { ...DEFAULT_RUN_CONFIG, ...input.config } as RunConfig;
  const { events, items, priors, env, nowTs, runId, seed } = input;
  const states = input.customerStates ?? new Map<string, CustomerState>();
  const rng = makeRng(seed ^ 0x9e3779b9);

  const detectionRun = input.syntheticDetections
    ? { detections: input.syntheticDetections, cohortsTested: 0, zThreshold: 0 }
    : detect(events, cfg.detector);
  const results: DecisionResult[] = [];
  const claimed = new Set<string>();

  let di = 0;
  for (const detection of detectionRun.detections) {
    di++;
    const decisionId = `${runId}_d${di}`;
    const verdict = diagnose(events, detection, cfg.diagnosis);

    // Items belonging to this detection, each claimed by exactly one
    // decision so no customer is acted on twice in a batch.
    const cohortItems = items.filter(
      (it) => !claimed.has(it.id) && itemInCohort(it, detection.cohort) && it.failedAt >= detection.onsetTs,
    );
    for (const it of cohortItems) claimed.add(it.id);
    if (cohortItems.length === 0) continue;

    const decision = input.policyOverride
      ? input.policyOverride({ detection, verdict, items: cohortItems, decisionId })
      : decide({
          detection, verdict, items: cohortItems, priors, nowTs, decisionId,
          config: cfg.policy,
        });

    results.push(
      executeDecision({
        decision, detection, verdict, items: cohortItems,
        priors, env, states, cfg, seed, nowTs, rng,
      }),
    );
  }

  // Everything the detector did not flag is left alone, deliberately.
  const unmanaged: ItemOutcome[] = items
    .filter((it) => !claimed.has(it.id))
    .map((it) => ({
      itemId: it.id, customerId: it.customerId, decisionId: null,
      arm: 'unmanaged' as const, intervention: 'none' as const,
      recovered: false, amountPaise: it.amountPaise, spendPaise: 0,
      blockedBy: [], idempotencyKey: null,
    }));

  const totals = summarise(results, items.length, unmanaged.length);

  return {
    runId, seed,
    decisions: results,
    totals,
    cohortsTested: detectionRun.cohortsTested,
    zThreshold: detectionRun.zThreshold,
    unmanaged,
  };
}

interface ExecArgs {
  decision: Decision;
  detection: Detection;
  verdict: DiagnosisVerdict;
  items: readonly AtRiskItem[];
  priors: PriorStore;
  env: Environment;
  states: Map<string, CustomerState>;
  cfg: RunConfig;
  seed: number;
  nowTs: number;
  rng: ReturnType<typeof makeRng>;
}

function executeDecision(a: ExecArgs): DecisionResult {
  const { decision, detection, verdict, items, priors, env, states, cfg, seed, nowTs, rng } = a;

  const outcomes: ItemOutcome[] = [];
  let treatedN = 0, treatedRecovered = 0;
  let holdoutN = 0, holdoutRecovered = 0;
  let blockedN = 0;
  let grossRecoveredPaise = 0;
  let spendPaise = 0;

  const learnCause = decision.cause;

  // Chosen once per decision, before any item is processed, so the whole
  // explored slice shares one intervention.
  const exploreChoice: Intervention =
    decision.exploreIntervention ??
    (decision.kind === 'EXPERIMENT' ? priors.leastObserved(learnCause, EXPLORABLE) : 'none');

  for (const item of items) {
    // Holdout assignment: deterministic in (seed, itemId), so an auditor
    // can recompute which arm any customer landed in from the ledger.
    const u = stableUnit(seed, item.id);
    const inHoldout = u < cfg.holdoutFraction;

    let intervention: Intervention = 'none';
    let arm: Arm = 'holdout';
    let blockedBy: string[] = [];
    let key: string | null = null;

    const inLearningSlice =
      decision.exploreIntervention !== undefined &&
      stableUnit(seed ^ 0x51ed, item.id) < cfg.learningSliceFraction;

    if (decision.kind === 'ACT' || decision.kind === 'WAIT') {
      if (!inHoldout) {
        intervention = inLearningSlice ? decision.exploreIntervention! : decision.intervention;
        arm = 'treated';
      }
    } else if (decision.kind === 'DO_NOT_ACT') {
      // Deciding not to act is not the same as deciding not to learn. A
      // small slice still goes to the option with the least evidence,
      // because otherwise the first DO_NOT_ACT for a cause is permanent:
      // nothing clears the sample floor, so nothing ever gets tried, so
      // nothing ever clears the sample floor. The engine starved itself
      // this way until the slice was extended here.
      if (!inHoldout && inLearningSlice) {
        intervention = decision.exploreIntervention!;
        arm = 'treated';
      }
    } else if (decision.kind === 'EXPERIMENT') {
      // Explore on a slice; the rest are untouched and still inform the
      // natural rate, so an experiment is never wasted evidence. The whole
      // explored slice gets the SAME intervention — the one this cause has
      // the least evidence about — so the arm is clean enough to measure
      // rather than a mixture of five things.
      if (!inHoldout && stableUnit(seed ^ 0x51ed, item.id) < cfg.explorationFraction) {
        intervention = exploreChoice;
        arm = 'treated';
      }
    }
    // DO_NOT_ACT and BLOCKED leave every item on 'none'.

    if (arm === 'treated' && isCustomerContact(intervention)) {
      const state = states.get(item.customerId);
      const gate = checkCompliance(item, state, intervention, nowTs, cfg.compliance);
      if (!gate.allowed) {
        arm = 'blocked';
        blockedBy = gate.blockedBy;
        intervention = 'none';
        blockedN++;
      } else {
        const attempts = state?.contacts.length ?? 0;
        key = idempotencyKey(item.customerId, decision.id, attempts);
        const channel = channelForAttempt(attempts);
        const next: CustomerState = state ?? {
          customerId: item.customerId,
          contacts: [],
          consent: { link: true, email: true, sms: true },
        };
        next.contacts = [...next.contacts, { customerId: item.customerId, ts: nowTs, channel }];
        states.set(item.customerId, next);
      }
    }

    const recovered = env.resolve(item, intervention, rng);

    let itemSpend = 0;
    if (arm === 'treated') {
      itemSpend = FIXED_COST_PAISE[intervention];
      if (recovered) itemSpend += Math.round(CONDITIONAL_COST_RATE[intervention] * item.amountPaise);
      spendPaise += itemSpend;
      treatedN++;
      if (recovered) { treatedRecovered++; grossRecoveredPaise += item.amountPaise; }
      priors.observeTreated(learnCause, intervention, recovered);
    } else {
      // Blocked, held out and unacted items are all "nothing was done",
      // which is exactly the observation the natural rate needs.
      holdoutN++;
      if (recovered) holdoutRecovered++;
      priors.observeHoldout(learnCause, recovered);
    }

    outcomes.push({
      itemId: item.id,
      customerId: item.customerId,
      decisionId: decision.id,
      arm,
      intervention,
      recovered,
      amountPaise: item.amountPaise,
      spendPaise: itemSpend,
      blockedBy,
      idempotencyKey: key,
    });
  }

  // One-off costs are charged once per intervention actually applied, not
  // per item — a rollback happens once however many payments it touches.
  const appliedOnce = new Set<Intervention>();
  for (const o of outcomes) if (o.arm === 'treated') appliedOnce.add(o.intervention);
  for (const i of appliedOnce) spendPaise += DECISION_COST_PAISE[i];

  const avgAmount =
    items.length > 0 ? items.reduce((s, i) => s + i.amountPaise, 0) / items.length : 0;

  let lift: TwoProportionResult | null = null;
  let incrementalPaise = 0, incrementalLowPaise = 0, incrementalHighPaise = 0;

  if (treatedN > 0 && holdoutN > 0) {
    lift = twoProportion(treatedRecovered, treatedN, holdoutRecovered, holdoutN);
    incrementalPaise = Math.round(lift.diff * treatedN * avgAmount);
    incrementalLowPaise = Math.round(lift.low * treatedN * avgAmount);
    incrementalHighPaise = Math.round(lift.high * treatedN * avgAmount);
  }

  return {
    detection, verdict, decision,
    treatedN, treatedRecovered, holdoutN, holdoutRecovered, blockedN,
    lift,
    grossRecoveredPaise,
    incrementalPaise, incrementalLowPaise, incrementalHighPaise,
    spendPaise,
    netPaise: incrementalPaise - spendPaise,
    outcomes,
  };
}

function summarise(
  results: readonly DecisionResult[],
  itemsConsidered: number,
  unmanagedCount: number,
): BatchTotals {
  const decisionsByKind: Record<string, number> = {};
  let itemsActedOn = 0, itemsHeldOut = 0, itemsBlocked = 0;
  let grossRecoveredPaise = 0, incrementalPaise = 0;
  let incrementalLowPaise = 0, incrementalHighPaise = 0, spendPaise = 0;

  for (const r of results) {
    decisionsByKind[r.decision.kind] = (decisionsByKind[r.decision.kind] ?? 0) + 1;
    itemsActedOn += r.treatedN;
    itemsHeldOut += r.holdoutN;
    itemsBlocked += r.blockedN;
    grossRecoveredPaise += r.grossRecoveredPaise;
    incrementalPaise += r.incrementalPaise;
    incrementalLowPaise += r.incrementalLowPaise;
    incrementalHighPaise += r.incrementalHighPaise;
    spendPaise += r.spendPaise;
  }

  if (unmanagedCount > 0) decisionsByKind['UNMANAGED_ITEMS'] = unmanagedCount;

  return {
    itemsConsidered, itemsActedOn, itemsHeldOut, itemsBlocked,
    grossRecoveredPaise, incrementalPaise, incrementalLowPaise, incrementalHighPaise,
    spendPaise,
    netPaise: incrementalPaise - spendPaise,
    decisionsByKind,
  };
}

export { PriorStore };
