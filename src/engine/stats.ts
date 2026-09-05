/**
 * Statistical primitives.
 *
 * Deliberately hand-written and small. Every one of these is something I
 * need to be able to explain line by line in an architecture interview,
 * which rules out pulling in a stats package whose assumptions I would
 * then be quoting rather than defending.
 *
 * Nothing here returns a bare point estimate. Every estimator returns an
 * interval, because the decision policy downstream refuses to act on
 * intervals that span zero and that refusal is the product.
 */

/** Abramowitz & Stegun 7.1.26 approximation of erf. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Two-sided p-value for a z statistic. */
export function twoSidedP(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/**
 * Smallest |z| whose two-sided p-value is <= alpha. Found by bisection
 * rather than a probit approximation: 60 iterations is instant, and I can
 * explain bisection in one sentence.
 */
export function zForTwoSidedAlpha(alpha: number): number {
  let lo = 0;
  let hi = 12;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (twoSidedP(mid) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Šidák correction for m independent tests. The cohort scan runs several
 * hundred comparisons; at an uncorrected alpha of 0.05 roughly one in
 * twenty would clear significance by chance and the detector would fire
 * constantly on windows where nothing is wrong. The 40 null windows in the
 * eval corpus exist to keep this honest.
 */
export function sidakAlpha(alpha: number, m: number): number {
  if (m <= 1) return alpha;
  return 1 - Math.pow(1 - alpha, 1 / m);
}

export interface Interval {
  point: number;
  low: number;
  high: number;
}

export const Z95 = 1.959963985;

/**
 * Wilson score interval for a single proportion.
 *
 * Chosen over the normal approximation because cohort slices routinely
 * have small n and rates near 0 or 1, where the naive interval produces
 * bounds outside [0,1] and badly wrong coverage.
 */
export function wilson(successes: number, n: number, z = Z95): Interval {
  if (n === 0) return { point: 0, low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    point: p,
    low: Math.max(0, centre - spread),
    high: Math.min(1, centre + spread),
  };
}

export interface TwoProportionResult {
  /** p1 - p2 */
  diff: number;
  low: number;
  high: number;
  se: number;
  z: number;
  p: number;
  n1: number;
  n2: number;
  p1: number;
  p2: number;
  /** True when the 95% interval excludes zero. */
  significant: boolean;
}

/**
 * Difference of two independent proportions, with a Wald interval on the
 * difference. This is the workhorse: it measures incremental lift
 * (treated vs holdout) and it measures difference-in-differences when
 * applied to pre/post changes.
 */
export function twoProportion(
  k1: number, n1: number,
  k2: number, n2: number,
  z = Z95,
): TwoProportionResult {
  const p1 = n1 > 0 ? k1 / n1 : 0;
  const p2 = n2 > 0 ? k2 / n2 : 0;
  const diff = p1 - p2;
  const se = Math.sqrt(
    (n1 > 0 ? (p1 * (1 - p1)) / n1 : 0) + (n2 > 0 ? (p2 * (1 - p2)) / n2 : 0),
  );
  const low = diff - z * se;
  const high = diff + z * se;
  const zStat = se > 0 ? diff / se : 0;
  return {
    diff, low, high, se, z: zStat, p: twoSidedP(zStat),
    n1, n2, p1, p2,
    significant: n1 > 0 && n2 > 0 && (low > 0 || high < 0),
  };
}

export interface DidResult {
  /** (treated_post - treated_pre) - (control_post - control_pre) */
  effect: number;
  low: number;
  high: number;
  se: number;
  significant: boolean;
  treatedDelta: number;
  controlDelta: number;
  minN: number;
}

/**
 * Difference-in-differences on four proportions.
 *
 * Identifying assumption: absent the cause, treated and control cohorts
 * would have moved in parallel. That assumption is checkable in the
 * pre-period (see diagnosis/matching.ts, which rejects controls whose
 * pre-trend diverges) and it is the main threat to validity of every
 * causal claim this system makes.
 */
export function differenceInDifferences(
  treatedPreK: number, treatedPreN: number,
  treatedPostK: number, treatedPostN: number,
  controlPreK: number, controlPreN: number,
  controlPostK: number, controlPostN: number,
  z = Z95,
): DidResult {
  const rate = (k: number, n: number) => (n > 0 ? k / n : 0);
  const varOf = (k: number, n: number) => {
    if (n === 0) return 0;
    const p = k / n;
    return (p * (1 - p)) / n;
  };

  const tPre = rate(treatedPreK, treatedPreN);
  const tPost = rate(treatedPostK, treatedPostN);
  const cPre = rate(controlPreK, controlPreN);
  const cPost = rate(controlPostK, controlPostN);

  const treatedDelta = tPost - tPre;
  const controlDelta = cPost - cPre;
  const effect = treatedDelta - controlDelta;

  const se = Math.sqrt(
    varOf(treatedPreK, treatedPreN) + varOf(treatedPostK, treatedPostN) +
    varOf(controlPreK, controlPreN) + varOf(controlPostK, controlPostN),
  );

  const low = effect - z * se;
  const high = effect + z * se;

  return {
    effect, low, high, se,
    significant: low > 0 || high < 0,
    treatedDelta, controlDelta,
    minN: Math.min(treatedPreN, treatedPostN, controlPreN, controlPostN),
  };
}

/* ------------------------------------------------------------------ */
/* Change-point detection                                              */
/* ------------------------------------------------------------------ */

export interface ChangePoint {
  index: number;
  /** Magnitude of the shift in the monitored series. */
  shift: number;
  /** Peak CUSUM statistic. Higher means a cleaner break. */
  statistic: number;
}

/**
 * Two-sided CUSUM over a series of rates.
 *
 * Used to answer "when did this start", which is what lets the system say
 * "began 11 minutes after release v42" rather than "sometime today".
 * A simple threshold on the level would fire late and give no onset at all.
 *
 * `k` is the slack parameter and `h` the decision threshold, both in units
 * of the reference period's standard deviation. `k` matters more than it
 * looks: set too low, ordinary hourly noise keeps the accumulator off zero
 * indefinitely, the recorded excursion start never resets, and the onset
 * is reported hours before anything actually happened.
 */
export function cusum(series: readonly number[], k = 1.0, h = 5): ChangePoint | null {
  if (series.length < 6) return null;

  // The baseline comes from the head of the series, not the whole of it.
  // Using the whole series puts the change itself into the mean and the
  // standard deviation, which shrinks the very deviation being looked for:
  // a clean 30-point drop halfway through a series reads as a ±1 sigma
  // wobble around a midpoint nothing ever sat at, and never fires. This
  // assumes the series starts in control, which holds here because the
  // detector always hands over a long pre-period.
  const refLen = Math.max(4, Math.floor(series.length / 3));
  const reference = series.slice(0, refLen);
  const mean = reference.reduce((s, v) => s + v, 0) / reference.length;
  const variance =
    reference.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, reference.length - 1);
  // Floor the scale. An unusually smooth reference period would otherwise
  // make every later wobble look like a ten-sigma event; below about
  // 1.5 percentage points a move in a success rate is not operationally
  // interesting anyway.
  const sd = Math.max(Math.sqrt(variance), 0.015);

  let up = 0;
  let down = 0;
  let best: ChangePoint | null = null;
  // Index at which the currently-accumulating excursion began.
  let upStart = 0;
  let downStart = 0;

  for (let i = 0; i < series.length; i++) {
    const z = (series[i]! - mean) / sd;
    if (up === 0) upStart = i;
    if (down === 0) downStart = i;
    up = Math.max(0, up + z - k);
    down = Math.max(0, down - z - k);

    if (down > h && (!best || down > best.statistic)) {
      best = { index: downStart, shift: series[i]! - mean, statistic: down };
    }
    if (up > h && (!best || up > best.statistic)) {
      best = { index: upStart, shift: series[i]! - mean, statistic: up };
    }
  }

  return best;
}

/** Mean of a numeric series. */
export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

/** Sample standard deviation. */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Brier score for probabilistic predictions. Lower is better; 0.25 is what
 * you get by always saying 50%. Reported in EVAL.md because a confidence
 * number nobody has scored is decoration.
 */
export function brier(predictions: readonly { p: number; correct: boolean }[]): number {
  if (!predictions.length) return 0;
  return (
    predictions.reduce((s, { p, correct }) => s + (p - (correct ? 1 : 0)) ** 2, 0) /
    predictions.length
  );
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  n: number;
  meanPredicted: number;
  observed: number;
}

/** Bins predictions by stated confidence and reports observed accuracy. */
export function calibration(
  predictions: readonly { p: number; correct: boolean }[],
  bins = 5,
): CalibrationBin[] {
  const out: CalibrationBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lower = b / bins;
    const upper = (b + 1) / bins;
    const inBin = predictions.filter(
      (x) => x.p >= lower && (b === bins - 1 ? x.p <= upper : x.p < upper),
    );
    out.push({
      lower, upper,
      n: inBin.length,
      meanPredicted: mean(inBin.map((x) => x.p)),
      observed: inBin.length ? inBin.filter((x) => x.correct).length / inBin.length : 0,
    });
  }
  return out;
}

/** Expected calibration error — weighted gap between stated and observed. */
export function expectedCalibrationError(
  predictions: readonly { p: number; correct: boolean }[],
  bins = 5,
): number {
  const cal = calibration(predictions, bins);
  const total = predictions.length || 1;
  return cal.reduce(
    (s, b) => s + (b.n / total) * Math.abs(b.meanPredicted - b.observed),
    0,
  );
}
