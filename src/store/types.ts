/**
 * Serialisable projections of engine output.
 *
 * The engine returns rich in-memory structures. These are the flattened,
 * JSON-safe shapes the ledger persists and the UI reads. Keeping them
 * separate means the engine's internals can change without breaking
 * stored history, and stored history can be read without loading the
 * engine at all.
 */

import type {
  CauseType, Cohort, DecisionKind, Intervention, ScoredOption,
} from '../engine/types.js';

export interface StoredHypothesis {
  cause: CauseType;
  weight: number;
  effect: number;
  ciLow: number;
  ciHigh: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  controlLabel: string;
}

export interface StoredOutcome {
  itemId: string;
  customerId: string;
  arm: 'treated' | 'holdout' | 'blocked' | 'unmanaged';
  intervention: Intervention;
  recovered: boolean;
  amountPaise: number;
  spendPaise: number;
  blockedBy: string[];
  idempotencyKey: string | null;
  /** Present only for items acted on through the live Razorpay path. */
  razorpayPaymentLinkId?: string;
  razorpayPaymentId?: string;
}

export interface StoredDecision {
  id: string;
  runId: string;
  createdAt: number;

  /* what changed */
  cohort: Cohort;
  cohortLabel: string;
  onsetTs: number;
  preRate: number;
  postRate: number;
  preN: number;
  postN: number;
  exposedPaise: number;

  /* why */
  verdictKind: 'diagnosed' | 'insufficient_evidence';
  insufficientReason: string | null;
  cause: CauseType | null;
  causeWeight: number | null;
  hypotheses: StoredHypothesis[];

  /* what was decided */
  /**
   * The effective outcome. When the policy said ACT and the compliance
   * gate then vetoed every single item, this reads BLOCKED — which is
   * what actually happened — while `policyKind` keeps what the economics
   * concluded, so the two are never conflated.
   */
  kind: DecisionKind;
  policyKind: DecisionKind;
  intervention: Intervention;
  reason: string;
  options: ScoredOption[];
  rejected: { intervention: Intervention; why: string }[];
  exploreIntervention: Intervention | null;
  explorationNote: string | null;

  /* what happened */
  itemCount: number;
  treatedN: number;
  treatedRecovered: number;
  holdoutN: number;
  holdoutRecovered: number;
  blockedN: number;
  lift: { diff: number; low: number; high: number; significant: boolean } | null;
  grossRecoveredPaise: number;
  incrementalPaise: number;
  incrementalLowPaise: number;
  incrementalHighPaise: number;
  spendPaise: number;
  netPaise: number;

  outcomes: StoredOutcome[];
}

export interface StoredRun {
  runId: string;
  /** End of the analysis window — the moment the batch was decided. */
  nowTs: number;
  fromTs: number;
  toTs: number;
  eventCount: number;
  itemsConsidered: number;
  cohortsTested: number;
  zThreshold: number;
  source: 'simulated' | 'razorpay_test' | 'mixed';
  decisions: StoredDecision[];
  totals: {
    itemsActedOn: number;
    itemsHeldOut: number;
    itemsBlocked: number;
    grossRecoveredPaise: number;
    spendPaise: number;
  };
}

/** Arm counts pooled across many runs — the honest way to measure lift. */
export interface PooledLift {
  treatedN: number;
  treatedRecovered: number;
  treatedAmountPaise: number;
  holdoutN: number;
  holdoutRecovered: number;
  treatedRate: number;
  holdoutRate: number;
  liftPp: number;
  liftLow: number;
  liftHigh: number;
  significant: boolean;
  grossRecoveredPaise: number;
  incrementalPaise: number;
  incrementalLowPaise: number;
  incrementalHighPaise: number;
  spendPaise: number;
  netPaise: number;
  phantomShare: number;
}

/** Lift measured separately for each intervention the engine has used. */
export interface InterventionBreakdown {
  intervention: Intervention;
  treatedN: number;
  treatedRecovered: number;
  holdoutN: number;
  holdoutRecovered: number;
  liftPp: number;
  liftLow: number;
  liftHigh: number;
  significant: boolean;
  spendPaise: number;
  incrementalPaise: number;
  netPaise: number;
}

export interface Portfolio {
  generatedAt: number;
  runs: StoredRun[];
  pooled: PooledLift;
  byIntervention: InterventionBreakdown[];
  priors: { treated: number; holdout: number };
  blockedByRule: { rule: string; count: number }[];
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export interface EvalPolicyRow {
  key: string;
  label: string;
  isEngine: boolean;
  grossRecoveredPaise: number;
  liftPp: number;
  incrementalPaise: number;
  incrementalLowPaise: number;
  incrementalHighPaise: number;
  spendPaise: number;
  netPaise: number;
  itemsActedOn: number;
  significant: boolean;
}

export interface EvalSnapshot {
  generatedAt: number;
  corpusSize: number;
  warmupSize: number;
  heldOutSize: number;
  elapsedMs: number;
  policies: EvalPolicyRow[];
  detection: {
    precision: number;
    recall: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    nullWindows: number;
    falsePositivesOnNulls: number;
  };
  recallByCause: { cause: string; detected: number; total: number }[];
  rootCause: {
    considered: number;
    diagnosed: number;
    abstained: number;
    top1: number;
    top3: number;
    confusion: { pair: string; count: number }[];
  };
  abstention: {
    nullWindows: number;
    nullWindowsLeftAlone: number;
    ambiguousWindows: number;
    ambiguousAbstained: number;
  };
  calibration: {
    brier: number;
    ece: number;
    n: number;
    bins: { lower: number; upper: number; n: number; meanPredicted: number; observed: number }[];
  };
  speed: { medianMs: number; p95Ms: number };
}
