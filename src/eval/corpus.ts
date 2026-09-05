/**
 * The evaluation corpus.
 *
 * 200 labelled 48-hour windows the engine has never seen. The labels live
 * here and in the truth oracle; no engine module imports either.
 *
 * The composition is deliberate:
 *
 *   140 incident windows   — one real cause, spread across six cause types
 *    40 null windows       — nothing wrong, only ordinary daily variation.
 *                            These are the most valuable windows in the set:
 *                            a detector that fires on them is worse than
 *                            useless because it spends money on noise.
 *    20 ambiguous windows  — issuer degradation with a duration close to
 *                            the retry-timing threshold, so the two
 *                            hypotheses are genuinely hard to separate. The
 *                            correct behaviour is to say so.
 */

import type { CauseType, Issuer, PaymentMethod } from '../engine/types.js';
import { makeRng } from '../engine/rng.js';
import type { IncidentSpec, ScenarioSpec } from '../engine/simulator/generator.js';

const HOUR = 3_600_000;
/** Fixed epoch so the corpus is byte-identical on every machine. */
const BASE_TS = Date.UTC(2026, 7, 3, 0, 0, 0);
const WINDOW_HOURS = 48;

export interface LabelledScenario {
  spec: ScenarioSpec;
  /** Null for windows where nothing is wrong. */
  trueCause: CauseType | null;
  trueCohortKey: string;
  kind: 'incident' | 'null' | 'ambiguous';
}

const UPI_ISSUERS: Issuer[] = ['bank_hdfc', 'bank_sbi', 'bank_icici', 'bank_axis', 'bank_kotak'];
const METHODS: PaymentMethod[] = ['upi', 'card', 'netbanking'];

const INCIDENT_CAUSES: CauseType[] = [
  'issuer_degradation', 'gateway_degradation', 'checkout_regression',
  'method_mismatch', 'retry_timing', 'customer_abandonment',
];

function buildIncident(
  cause: CauseType,
  seed: number,
  fromTs: number,
  toTs: number,
): { incident: IncidentSpec; releaseTs?: number } {
  const rng = makeRng(seed);
  const end = toTs;

  switch (cause) {
    case 'issuer_degradation': {
      const durationH = rng.int(8, 14);
      return {
        incident: {
          id: 'inc', cause,
          cohort: { method: 'upi', issuer: rng.pick(UPI_ISSUERS) },
          onsetTs: end - durationH * HOUR,
          endTs: end,
          severity: 0.30 + rng.next() * 0.28,
        },
      };
    }
    case 'gateway_degradation': {
      const durationH = rng.int(7, 12);
      return {
        incident: {
          id: 'inc', cause,
          cohort: { method: rng.pick(METHODS) },
          onsetTs: end - durationH * HOUR,
          endTs: end,
          severity: 0.16 + rng.next() * 0.16,
        },
      };
    }
    case 'checkout_regression': {
      // A staged rollout gives the diagnosis a concurrent control: half of
      // traffic stays on the old checkout after the release.
      const releaseTs = end - rng.int(9, 15) * HOUR;
      return {
        releaseTs,
        incident: {
          id: 'inc', cause,
          cohort: { checkoutVersion: 'v42', device: rng.bool(0.6) ? 'android' : 'ios' },
          onsetTs: releaseTs,
          endTs: end,
          severity: 0.30 + rng.next() * 0.30,
        },
      };
    }
    case 'method_mismatch': {
      const durationH = rng.int(9, 14);
      return {
        incident: {
          id: 'inc', cause,
          cohort: {
            method: rng.pick(METHODS),
            valueBand: rng.bool(0.5) ? 'gt_5000' : 'v2000_5000',
          },
          onsetTs: end - durationH * HOUR,
          endTs: end,
          severity: 0.34 + rng.next() * 0.30,
        },
      };
    }
    case 'retry_timing': {
      // A sharp, short burst — the shape is the only thing separating this
      // from issuer degradation, which is exactly the intended difficulty.
      return {
        incident: {
          id: 'inc', cause,
          cohort: { method: 'upi', issuer: rng.pick(UPI_ISSUERS) },
          onsetTs: end - 2 * HOUR,
          endTs: end,
          severity: 0.58 + rng.next() * 0.22,
        },
      };
    }
    case 'customer_abandonment': {
      const durationH = rng.int(8, 13);
      return {
        incident: {
          id: 'inc', cause,
          cohort: {
            device: rng.pick(['android', 'ios', 'desktop']),
            customerType: rng.bool(0.5) ? 'new' : 'returning',
          },
          onsetTs: end - durationH * HOUR,
          endTs: end,
          severity: 0.20 + rng.next() * 0.18,
        },
      };
    }
  }
}

export function buildCorpus(size = 200): LabelledScenario[] {
  const out: LabelledScenario[] = [];
  const counts = { incident: 140, null: 40, ambiguous: 20 };
  const scale = size / 200;
  const nIncident = Math.round(counts.incident * scale);
  const nNull = Math.round(counts.null * scale);
  const nAmbiguous = Math.max(0, size - nIncident - nNull);

  let idx = 0;

  // Stagger window ends across the clock. Without this every batch would
  // run at the same local hour, and since 05:30 IST sits inside the quiet
  // window the compliance gate would defer every outreach in the corpus —
  // the gate would look like it worked while the evaluation measured
  // nothing. Staggering means quiet hours bite on roughly a third of
  // windows, which is what it should look like.
  const windowFor = (i: number) => {
    const fromTs = BASE_TS + i * WINDOW_HOURS * HOUR + (i % 24) * HOUR;
    return { fromTs, toTs: fromTs + WINDOW_HOURS * HOUR };
  };

  for (let i = 0; i < nIncident; i++) {
    const seed = 1000 + idx;
    const rng = makeRng(seed);
    const cause = INCIDENT_CAUSES[i % INCIDENT_CAUSES.length]!;
    const { fromTs, toTs } = windowFor(idx);
    const built = buildIncident(cause, seed, fromTs, toTs);
    out.push({
      kind: 'incident',
      trueCause: cause,
      trueCohortKey: JSON.stringify(built.incident.cohort),
      spec: {
        id: `sc${idx}`,
        seed,
        label: 'incident',
        fromTs, toTs,
        ratePerHour: rng.int(70, 130),
        incidents: [built.incident],
        ...(built.releaseTs !== undefined ? { releaseTs: built.releaseTs } : {}),
      },
    });
    idx++;
  }

  for (let i = 0; i < nNull; i++) {
    const seed = 5000 + idx;
    const rng = makeRng(seed);
    const { fromTs, toTs } = windowFor(idx);
    // Half of the null windows still ship a checkout release, so "a release
    // happened" on its own is never enough to convict.
    const withRelease = rng.bool(0.5);
    out.push({
      kind: 'null',
      trueCause: null,
      trueCohortKey: '{}',
      spec: {
        id: `sc${idx}`,
        seed,
        label: 'null',
        fromTs, toTs,
        ratePerHour: rng.int(70, 130),
        incidents: [],
        ...(withRelease ? { releaseTs: toTs - rng.int(8, 16) * HOUR } : {}),
      },
    });
    idx++;
  }

  for (let i = 0; i < nAmbiguous; i++) {
    const seed = 9000 + idx;
    const rng = makeRng(seed);
    const { fromTs, toTs } = windowFor(idx);

    // Two real causes running at once on overlapping traffic: an issuer
    // wobble and a checkout regression, starting within an hour of each
    // other. The affected cohort then carries a mix of failure reasons and
    // no single hypothesis can take a majority of the evidence.
    //
    // There is a correct answer here and it is not a cause — it is
    // "I cannot separate these". Confidently naming either one would be
    // wrong even when it happens to match the larger incident.
    const releaseTs = toTs - rng.int(8, 11) * HOUR;
    const issuerOnset = releaseTs + rng.int(0, 1) * HOUR;
    out.push({
      kind: 'ambiguous',
      trueCause: 'issuer_degradation',
      trueCohortKey: '{"method":"upi"}',
      spec: {
        id: `sc${idx}`,
        seed,
        label: 'ambiguous',
        fromTs, toTs,
        releaseTs,
        ratePerHour: rng.int(70, 130),
        incidents: [
          {
            id: 'inc_issuer',
            cause: 'issuer_degradation',
            cohort: { method: 'upi', issuer: rng.pick(UPI_ISSUERS) },
            onsetTs: issuerOnset,
            endTs: toTs,
            severity: 0.26 + rng.next() * 0.14,
          },
          {
            id: 'inc_checkout',
            cause: 'checkout_regression',
            cohort: { checkoutVersion: 'v42' },
            onsetTs: releaseTs,
            endTs: toTs,
            severity: 0.20 + rng.next() * 0.14,
          },
        ],
      },
    });
    idx++;
  }

  // Deterministic shuffle so warm-up and evaluation splits both contain a
  // representative mix rather than all the nulls landing in one half.
  const rng = makeRng(424242);
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }

  return out;
}
