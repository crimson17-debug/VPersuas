/**
 * The prior store — the memory the learning loop writes to.
 *
 * The engine never receives the true uplift table. It accumulates observed
 * outcomes from previous batches: how often items recovered under each
 * intervention, and how often the randomly held-out items recovered with
 * nothing done to them. Lift is estimated as the difference, with a
 * confidence interval that starts hopeless and narrows with evidence.
 *
 * This is what makes the cold-start behaviour correct rather than lucky.
 * With no history every interval spans zero, so the policy cannot justify
 * acting and returns EXPERIMENT. After a few hundred observations the
 * intervals tighten and it starts acting. Nothing about that is scripted.
 *
 * Holdout counts are pooled per cause rather than per intervention: the
 * held-out arm receives no intervention by definition, so every holdout
 * observation for a cause informs the natural rate for all of them.
 */

import type { CauseType, Intervention } from '../types.js';
import { twoProportion } from '../stats.js';

export interface LiftEstimate {
  pNatural: number;
  pTreated: number;
  lift: number;
  low: number;
  high: number;
  /** Treated-arm sample size backing this estimate. */
  n: number;
  holdoutN: number;
  /** True when the interval excludes zero. */
  significant: boolean;
}

interface Counts { k: number; n: number; }

const CAUSE_KEY_NONE = '__no_cause__';

export class PriorStore {
  /** cause -> intervention -> treated outcomes */
  private treated = new Map<string, Map<Intervention, Counts>>();
  /** cause -> holdout outcomes */
  private holdout = new Map<string, Counts>();

  private key(cause: CauseType | null): string {
    return cause ?? CAUSE_KEY_NONE;
  }

  observeTreated(cause: CauseType | null, intervention: Intervention, recovered: boolean): void {
    const k = this.key(cause);
    let byIntervention = this.treated.get(k);
    if (!byIntervention) { byIntervention = new Map(); this.treated.set(k, byIntervention); }
    const c = byIntervention.get(intervention) ?? { k: 0, n: 0 };
    c.n++;
    if (recovered) c.k++;
    byIntervention.set(intervention, c);
  }

  observeHoldout(cause: CauseType | null, recovered: boolean): void {
    const k = this.key(cause);
    const c = this.holdout.get(k) ?? { k: 0, n: 0 };
    c.n++;
    if (recovered) c.k++;
    this.holdout.set(k, c);
  }

  /**
   * Estimated lift of an intervention over doing nothing.
   *
   * Returns a maximally uninformative estimate when either arm is empty —
   * a lift of zero with an interval spanning the whole plausible range —
   * which the policy reads as "not actionable" rather than "no effect".
   */
  estimate(cause: CauseType | null, intervention: Intervention): LiftEstimate {
    if (intervention === 'none') {
      const h = this.holdout.get(this.key(cause)) ?? { k: 0, n: 0 };
      const p = h.n > 0 ? h.k / h.n : 0;
      return { pNatural: p, pTreated: p, lift: 0, low: 0, high: 0, n: h.n, holdoutN: h.n, significant: false };
    }

    const t = this.treated.get(this.key(cause))?.get(intervention) ?? { k: 0, n: 0 };
    const h = this.holdout.get(this.key(cause)) ?? { k: 0, n: 0 };

    if (t.n < 5 || h.n < 5) {
      return {
        pNatural: h.n > 0 ? h.k / h.n : 0,
        pTreated: t.n > 0 ? t.k / t.n : 0,
        lift: 0, low: -1, high: 1,
        n: t.n, holdoutN: h.n, significant: false,
      };
    }

    const r = twoProportion(t.k, t.n, h.k, h.n);
    return {
      pNatural: r.p2,
      pTreated: r.p1,
      lift: r.diff,
      low: r.low,
      high: r.high,
      n: t.n,
      holdoutN: h.n,
      significant: r.significant,
    };
  }

  /** How many treated observations back one (cause, intervention) cell. */
  observationCount(cause: CauseType | null, intervention: Intervention): number {
    return this.treated.get(this.key(cause))?.get(intervention)?.n ?? 0;
  }

  /**
   * The candidate this cause knows least about.
   *
   * Exploration is targeted rather than uniform. There are six causes and
   * five explorable interventions, so thirty cells need filling before the
   * policy can act on evidence anywhere; spending the exploration budget
   * at random re-measures well-understood cells and leaves others empty
   * indefinitely. Spending it on the thinnest cell is the cheapest way out
   * of a cold start, and it is why the engine stops experimenting and
   * starts acting partway through the warm-up rather than never.
   */
  leastObserved(cause: CauseType | null, candidates: readonly Intervention[]): Intervention {
    let best = candidates[0]!;
    let bestN = Infinity;
    for (const c of candidates) {
      const n = this.observationCount(cause, c);
      if (n < bestN) { bestN = n; best = c; }
    }
    return best;
  }

  /** Total observations held, used to report learning progress. */
  size(): { treated: number; holdout: number } {
    let treated = 0;
    for (const m of this.treated.values()) for (const c of m.values()) treated += c.n;
    let holdout = 0;
    for (const c of this.holdout.values()) holdout += c.n;
    return { treated, holdout };
  }

  toJSON(): unknown {
    return {
      treated: [...this.treated].map(([cause, m]) => [cause, [...m]]),
      holdout: [...this.holdout],
    };
  }

  static fromJSON(raw: any): PriorStore {
    const s = new PriorStore();
    for (const [cause, entries] of raw?.treated ?? []) {
      s.treated.set(cause, new Map(entries));
    }
    for (const [cause, counts] of raw?.holdout ?? []) {
      s.holdout.set(cause, counts);
    }
    return s;
  }

  clone(): PriorStore {
    return PriorStore.fromJSON(this.toJSON());
  }
}
