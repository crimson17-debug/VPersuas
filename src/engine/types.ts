/**
 * Core domain types.
 *
 * Everything here is data the engine is allowed to see. The ground-truth
 * causal model lives in src/engine/simulator/world.ts and is deliberately
 * NOT importable from engine code — see scripts/check-boundaries.ts.
 */

export type PaymentMethod = 'upi' | 'card' | 'netbanking' | 'wallet';

export type Issuer =
  | 'bank_hdfc' | 'bank_sbi' | 'bank_icici' | 'bank_axis' | 'bank_kotak'
  | 'wallet_paytm' | 'wallet_phonepe';

export type Device = 'android' | 'ios' | 'desktop';

export type ValueBand = 'lt_500' | 'v500_2000' | 'v2000_5000' | 'gt_5000';

export type CustomerType = 'new' | 'returning';

export type FailureReason =
  | 'issuer_unavailable'
  | 'gateway_timeout'
  | 'authentication_failed'
  | 'insufficient_funds'
  | 'method_not_supported'
  | 'user_dropped';

/** A single payment attempt. The atomic unit of the event stream. */
export interface PaymentEvent {
  id: string;
  ts: number;                    // epoch ms
  customerId: string;
  orderId: string;
  method: PaymentMethod;
  issuer: Issuer;
  device: Device;
  valueBand: ValueBand;
  customerType: CustomerType;
  amountPaise: number;
  checkoutVersion: string;
  outcome: 'captured' | 'failed';
  failureReason?: FailureReason;
  /** Provenance. Never inferred — always set at creation. */
  source: 'simulated' | 'razorpay_test';
  /** Razorpay identifiers, present only when source === 'razorpay_test'. */
  razorpayPaymentId?: string;
  razorpayOrderId?: string;
}

/* ------------------------------------------------------------------ */
/* Cohorts                                                             */
/* ------------------------------------------------------------------ */

export const COHORT_DIMENSIONS = [
  'method', 'issuer', 'device', 'valueBand', 'customerType', 'checkoutVersion',
] as const;

export type CohortDimension = typeof COHORT_DIMENSIONS[number];

/**
 * A cohort is a partial assignment over dimensions. An empty object is the
 * population; { method: 'upi', issuer: 'bank_hdfc' } is a 2-dimensional slice.
 */
export type Cohort = Partial<Record<CohortDimension, string>>;

export function cohortKey(c: Cohort): string {
  const parts = COHORT_DIMENSIONS
    .filter((d) => c[d] !== undefined)
    .map((d) => `${d}=${c[d]}`);
  return parts.length ? parts.join('&') : '*';
}

/**
 * Human label for a cohort.
 *
 * The dimension has to survive into the label. A cohort printed as "new"
 * or "upi" is unreadable — the reader cannot tell whether that is a
 * customer type, a payment method or a device, and every screen in the
 * console leads with this string.
 */
const COHORT_VALUE_LABEL: Record<string, string> = {
  upi: 'UPI', card: 'cards', netbanking: 'netbanking', wallet: 'wallets',
  bank_hdfc: 'HDFC', bank_sbi: 'SBI', bank_icici: 'ICICI',
  bank_axis: 'Axis', bank_kotak: 'Kotak',
  wallet_paytm: 'Paytm', wallet_phonepe: 'PhonePe',
  android: 'Android', ios: 'iOS', desktop: 'desktop',
  lt_500: 'orders under ₹500',
  v500_2000: 'orders ₹500–2,000',
  v2000_5000: 'orders ₹2,000–5,000',
  gt_5000: 'orders above ₹5,000',
  new: 'new customers', returning: 'returning customers',
};

function labelFor(dim: CohortDimension, value: string): string {
  if (dim === 'checkoutVersion') return `checkout ${value}`;
  return COHORT_VALUE_LABEL[value] ?? value;
}

export function cohortLabel(c: Cohort): string {
  const parts = COHORT_DIMENSIONS
    .filter((d) => c[d] !== undefined)
    .map((d) => labelFor(d, String(c[d])));
  return parts.length ? parts.join(' · ') : 'all traffic';
}

export function matchesCohort(e: PaymentEvent, c: Cohort): boolean {
  for (const d of COHORT_DIMENSIONS) {
    const want = c[d];
    if (want === undefined) continue;
    if (String(e[d as keyof PaymentEvent]) !== want) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Causes and interventions                                            */
/* ------------------------------------------------------------------ */

export const CAUSE_TYPES = [
  'issuer_degradation',
  'gateway_degradation',
  'checkout_regression',
  'method_mismatch',
  'retry_timing',
  'customer_abandonment',
] as const;

export type CauseType = typeof CAUSE_TYPES[number];

export const INTERVENTIONS = [
  'none',
  'alternate_method',
  'wait_and_retry',
  'immediate_retry',
  'nudge',
  'discount_nudge',
  'checkout_rollback',
] as const;

export type Intervention = typeof INTERVENTIONS[number];

/** Human-readable names used in the UI and the ledger. */
export const INTERVENTION_LABEL: Record<Intervention, string> = {
  none: 'No action',
  alternate_method: 'Steer to healthy payment method',
  wait_and_retry: 'Delay retry until issuer recovers',
  immediate_retry: 'Retry immediately',
  nudge: 'Recovery message with payment link',
  discount_nudge: 'Recovery message with discount',
  checkout_rollback: 'Roll back checkout release',
};

export const CAUSE_LABEL: Record<CauseType, string> = {
  issuer_degradation: 'Issuer degradation',
  gateway_degradation: 'Gateway degradation',
  checkout_regression: 'Checkout regression',
  method_mismatch: 'Payment-method mismatch',
  retry_timing: 'Retry timing',
  customer_abandonment: 'Customer abandonment',
};

/* ------------------------------------------------------------------ */
/* Detection and diagnosis                                             */
/* ------------------------------------------------------------------ */

export interface Window {
  fromTs: number;
  toTs: number;
}

/** Output of the detector: something changed, here, at roughly this time. */
export interface Detection {
  cohort: Cohort;
  /** Estimated onset from the change-point detector. */
  onsetTs: number;
  /** Pre-period and post-period success rates for the affected cohort. */
  preRate: number;
  postRate: number;
  preN: number;
  postN: number;
  /** Anomaly score — how far the post-period sits from the rolling baseline. */
  score: number;
  /** Failing volume attributable to the change, in paise. */
  exposedPaise: number;
}

export interface Hypothesis {
  cause: CauseType;
  /** Difference-in-differences point estimate (pp, negative = harm). */
  effect: number;
  ciLow: number;
  ciHigh: number;
  /** Share of posterior mass, normalised across surviving hypotheses. */
  weight: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  controlLabel: string;
}

export type DiagnosisVerdict =
  | { kind: 'diagnosed'; top: Hypothesis; ranked: Hypothesis[] }
  | { kind: 'insufficient_evidence'; ranked: Hypothesis[]; reason: string };

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

export type DecisionKind =
  | 'ACT'
  | 'WAIT'
  | 'EXPERIMENT'
  | 'DO_NOT_ACT'
  | 'BLOCKED';

export interface ScoredOption {
  intervention: Intervention;
  /** Estimated probability of recovery with no intervention. */
  pNatural: number;
  /** Estimated probability of recovery under this intervention. */
  pTreated: number;
  liftLow: number;
  lift: number;
  liftHigh: number;
  /** Sample size backing the estimate. Drives confidence. */
  n: number;
  expectedValuePaise: number;
  expectedCostPaise: number;
  netPaise: number;
  netLowPaise: number;
}

export interface Decision {
  id: string;
  kind: DecisionKind;
  intervention: Intervention;
  reason: string;
  cohort: Cohort;
  cause: CauseType | null;
  causeWeight: number | null;
  options: ScoredOption[];
  rejected: { intervention: Intervention; why: string }[];
  /** Compliance rules that fired, if any. */
  blockedBy: string[];
  itemCount: number;
  createdAt: number;
  /**
   * A permanently reserved slice of every acting decision goes to the
   * intervention with the most to learn about, chosen by upper confidence
   * bound. Without it the first option to clear the sample floor becomes
   * the only option ever used, and a better one that was never tried stays
   * invisible forever.
   */
  exploreIntervention?: Intervention;
  explorationNote?: string;
}

/* ------------------------------------------------------------------ */
/* At-risk items — the unit a batch operates on                        */
/* ------------------------------------------------------------------ */

export interface AtRiskItem {
  id: string;
  customerId: string;
  orderId: string;
  eventId: string;
  amountPaise: number;
  failedAt: number;
  method: PaymentMethod;
  issuer: Issuer;
  device: Device;
  valueBand: ValueBand;
  customerType: CustomerType;
  checkoutVersion: string;
  failureReason: FailureReason;
}

/** Contact history, consulted by the compliance gate. */
export interface ContactRecord {
  customerId: string;
  ts: number;
  channel: 'link' | 'email' | 'sms';
}

export interface CustomerState {
  customerId: string;
  contacts: ContactRecord[];
  consent: { link: boolean; email: boolean; sms: boolean };
  /** Epoch ms the customer committed to pay by, if they made a promise. */
  promiseToPayTs?: number;
}
