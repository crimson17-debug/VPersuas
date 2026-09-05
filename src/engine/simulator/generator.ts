/**
 * Synthetic Razorpay-compatible event generation.
 *
 * Every event produced here carries source: 'simulated'. Real events
 * arriving from Razorpay test mode carry source: 'razorpay_test' and flow
 * through the identical contract — the engine cannot tell them apart and
 * does not need to, but the UI always shows which is which.
 *
 * The generator knows about incidents. The engine does not.
 */

import type {
  Cohort, CustomerType, Device, FailureReason, Issuer, PaymentEvent,
  PaymentMethod, ValueBand, CauseType,
} from '../types.js';
import { makeRng, type Rng } from '../rng.js';
import { CAUSE_FAILURE_REASON } from './world.js';

export interface IncidentSpec {
  id: string;
  cause: CauseType;
  /** Who is affected. The engine has to discover this. */
  cohort: Cohort;
  onsetTs: number;
  endTs: number;
  /** Probability that a matching payment is forced to fail. */
  severity: number;
  /**
   * Force the failure reason instead of deriving it from the cause.
   *
   * Needed to build genuinely hard cases. By default each cause stamps its
   * own signature reason, which hands the diagnosis engine a near-free
   * answer. Real causes are not so considerate — a checkout that breaks the
   * UPI intent handoff surfaces as an issuer-ish failure, indistinguishable
   * from the issuer actually being down. Setting this makes two different
   * causes emit an identical signature, which is the only way to test
   * whether anything other than the reason code is doing work.
   */
  reasonOverride?: FailureReason;
}

export type ScenarioLabel = 'incident' | 'null' | 'ambiguous';

export interface ScenarioSpec {
  id: string;
  seed: number;
  label: ScenarioLabel;
  fromTs: number;
  toTs: number;
  /** When the staged checkout rollout begins, if this scenario has one. */
  releaseTs?: number;
  incidents: IncidentSpec[];
  /** Events per hour, before daily seasonality. */
  ratePerHour: number;
}

export interface GeneratedWorld {
  spec: ScenarioSpec;
  events: PaymentEvent[];
}

const HOUR = 3_600_000;

const METHOD_MIX = [
  ['upi', 0.55], ['card', 0.28], ['netbanking', 0.10], ['wallet', 0.07],
] as const satisfies readonly (readonly [PaymentMethod, number])[];

const ISSUERS_BY_METHOD: Record<PaymentMethod, readonly (readonly [Issuer, number])[]> = {
  upi: [['bank_hdfc', 0.30], ['bank_sbi', 0.26], ['bank_icici', 0.20], ['bank_axis', 0.14], ['bank_kotak', 0.10]],
  card: [['bank_hdfc', 0.34], ['bank_icici', 0.24], ['bank_axis', 0.20], ['bank_sbi', 0.14], ['bank_kotak', 0.08]],
  netbanking: [['bank_sbi', 0.36], ['bank_hdfc', 0.24], ['bank_icici', 0.20], ['bank_axis', 0.12], ['bank_kotak', 0.08]],
  wallet: [['wallet_paytm', 0.55], ['wallet_phonepe', 0.45]],
};

const DEVICE_MIX = [
  ['android', 0.58], ['ios', 0.22], ['desktop', 0.20],
] as const satisfies readonly (readonly [Device, number])[];

/** Baseline success rate per method, before any incident. */
const METHOD_BASE_SUCCESS: Record<PaymentMethod, number> = {
  upi: 0.923, card: 0.884, netbanking: 0.851, wallet: 0.936,
};

/** Higher-value orders fail slightly more — limits, step-up auth, nerves. */
const VALUE_BAND_PENALTY: Record<ValueBand, number> = {
  lt_500: 0.004, v500_2000: 0.0, v2000_5000: -0.012, gt_5000: -0.028,
};

const ORGANIC_FAILURE_REASONS = [
  ['insufficient_funds', 0.38], ['user_dropped', 0.26],
  ['authentication_failed', 0.20], ['issuer_unavailable', 0.10],
  ['gateway_timeout', 0.06],
] as const satisfies readonly (readonly [FailureReason, number])[];

/** Hour-of-day multiplier on volume. Indian consumer traffic, roughly. */
const HOURLY_SHAPE = [
  0.30, 0.18, 0.12, 0.10, 0.12, 0.22, 0.42, 0.68,
  0.88, 1.05, 1.18, 1.24, 1.20, 1.12, 1.08, 1.10,
  1.16, 1.28, 1.42, 1.55, 1.48, 1.20, 0.82, 0.52,
];

function bandOf(amountPaise: number): ValueBand {
  const rupees = amountPaise / 100;
  if (rupees < 500) return 'lt_500';
  if (rupees < 2000) return 'v500_2000';
  if (rupees < 5000) return 'v2000_5000';
  return 'gt_5000';
}

function amountFor(rng: Rng): number {
  // Log-normal-ish: most orders small, a long tail of large ones.
  const r = rng.next();
  let rupees: number;
  if (r < 0.34) rupees = 120 + rng.next() * 380;
  else if (r < 0.72) rupees = 500 + rng.next() * 1500;
  else if (r < 0.93) rupees = 2000 + rng.next() * 3000;
  else rupees = 5000 + rng.next() * 14000;
  return Math.round(rupees) * 100;
}

function matchesIncidentCohort(
  cohort: Cohort,
  f: { method: PaymentMethod; issuer: Issuer; device: Device; valueBand: ValueBand; customerType: CustomerType; checkoutVersion: string },
): boolean {
  if (cohort.method && cohort.method !== f.method) return false;
  if (cohort.issuer && cohort.issuer !== f.issuer) return false;
  if (cohort.device && cohort.device !== f.device) return false;
  if (cohort.valueBand && cohort.valueBand !== f.valueBand) return false;
  if (cohort.customerType && cohort.customerType !== f.customerType) return false;
  if (cohort.checkoutVersion && cohort.checkoutVersion !== f.checkoutVersion) return false;
  return true;
}

export function generate(spec: ScenarioSpec): GeneratedWorld {
  const rng = makeRng(spec.seed);
  const events: PaymentEvent[] = [];

  const totalHours = Math.max(1, Math.round((spec.toTs - spec.fromTs) / HOUR));
  // A stable pool of customers so 'returning' means something and the
  // compliance gate has repeat contacts to reason about.
  const customerPool = Math.max(200, Math.round(spec.ratePerHour * totalHours * 0.55));

  let seq = 0;

  for (let h = 0; h < totalHours; h++) {
    const hourStart = spec.fromTs + h * HOUR;
    const hourOfDay = new Date(hourStart).getUTCHours();
    const shape = HOURLY_SHAPE[hourOfDay] ?? 1;
    // Daily variation on top of the shape — this is the noise the detector
    // has to not fire on. Null scenarios contain nothing but this.
    const jitter = Math.max(0.55, rng.normal(1, 0.14));
    const n = Math.max(0, Math.round(spec.ratePerHour * shape * jitter));

    for (let i = 0; i < n; i++) {
      const ts = hourStart + Math.floor(rng.next() * HOUR);
      const method = rng.weighted(METHOD_MIX);
      const issuer = rng.weighted(ISSUERS_BY_METHOD[method]);
      const device = rng.weighted(DEVICE_MIX);
      const customerType: CustomerType = rng.bool(0.42) ? 'returning' : 'new';
      const amountPaise = amountFor(rng);
      const valueBand = bandOf(amountPaise);

      // Staged rollout: after releaseTs, half of traffic is on the new
      // checkout. That concurrent split is what makes a clean control
      // cohort exist for a regression, and it is how a real staged release
      // would be structured anyway.
      let checkoutVersion = 'v41';
      if (spec.releaseTs !== undefined && ts >= spec.releaseTs) {
        checkoutVersion = rng.bool(0.5) ? 'v42' : 'v41';
      }

      const facts = { method, issuer, device, valueBand, customerType, checkoutVersion };

      let pSuccess =
        METHOD_BASE_SUCCESS[method] +
        VALUE_BAND_PENALTY[valueBand] +
        (device === 'desktop' ? 0.006 : 0) +
        (customerType === 'returning' ? 0.010 : 0);

      let forcedReason: FailureReason | null = null;

      for (const inc of spec.incidents) {
        if (ts < inc.onsetTs || ts > inc.endTs) continue;
        if (!matchesIncidentCohort(inc.cohort, facts)) continue;
        if (rng.bool(inc.severity)) {
          forcedReason = inc.reasonOverride ?? CAUSE_FAILURE_REASON[inc.cause];
          pSuccess = 0;
        }
      }

      const captured = forcedReason ? false : rng.bool(pSuccess);
      const failureReason: FailureReason | undefined = captured
        ? undefined
        : (forcedReason ?? rng.weighted(ORGANIC_FAILURE_REASONS));

      seq++;
      events.push({
        id: `evt_${spec.id}_${seq}`,
        ts,
        customerId: `cust_${rng.int(1, customerPool)}`,
        orderId: `order_${spec.id}_${seq}`,
        method, issuer, device, valueBand, customerType,
        amountPaise,
        checkoutVersion,
        outcome: captured ? 'captured' : 'failed',
        ...(failureReason ? { failureReason } : {}),
        source: 'simulated',
      });
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  return { spec, events };
}
