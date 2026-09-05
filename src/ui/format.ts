/**
 * Display formatting.
 *
 * One rule runs through all of it: an estimate is never shown as a bare
 * number. Anything measured comes with its interval, and anything whose
 * interval spans zero is marked, because a lift that cannot be
 * distinguished from nothing is the single most important thing a reader
 * of this console needs to notice.
 */

/** Indian money, in lakh where that reads better than five digits. */
export function money(paise: number): string {
  const rupees = paise / 100;
  const sign = rupees < 0 ? '−' : '';
  const a = Math.abs(rupees);
  if (a >= 10000000) return `${sign}₹${(a / 10000000).toFixed(2)}Cr`;
  if (a >= 100000) return `${sign}₹${(a / 100000).toFixed(2)}L`;
  if (a >= 1000) return `${sign}₹${(a / 1000).toFixed(1)}k`;
  return `${sign}₹${Math.round(a).toLocaleString('en-IN')}`;
}

export function moneyExact(paise: number): string {
  const rupees = paise / 100;
  const sign = rupees < 0 ? '−' : '';
  return `${sign}₹${Math.abs(Math.round(rupees)).toLocaleString('en-IN')}`;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** Percentage points — the unit for a difference between two rates. */
export function pp(x: number, digits = 1): string {
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}${Math.abs(x * 100).toFixed(digits)}pp`;
}

export function ppRange(low: number, high: number, digits = 1): string {
  return `${(low * 100).toFixed(digits)} to ${(high * 100).toFixed(digits)}pp`;
}

export function moneyRange(low: number, high: number): string {
  return `${money(low)} to ${money(high)}`;
}

export function ts(t: number, withTime = true): string {
  const d = new Date(t);
  const date = d.toISOString().slice(0, 10);
  return withTime ? `${date} ${d.toISOString().slice(11, 16)}` : date;
}

export function timeOnly(t: number): string {
  return new Date(t).toISOString().slice(11, 16);
}

export function humanCause(cause: string | null): string {
  if (!cause) return 'No cause established';
  return cause.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function humanIntervention(i: string): string {
  const map: Record<string, string> = {
    none: 'No action',
    alternate_method: 'Steer to healthy method',
    wait_and_retry: 'Delay retry',
    immediate_retry: 'Retry immediately',
    nudge: 'Recovery message',
    discount_nudge: 'Recovery message with discount',
    checkout_rollback: 'Roll back checkout release',
  };
  return map[i] ?? i;
}

export function humanRule(rule: string): string {
  const map: Record<string, string> = {
    attempt_cap: 'Attempt cap reached',
    cooldown: 'Cooldown not elapsed',
    quiet_hours: 'Quiet hours',
    consent: 'No consent for channel',
    promise_to_pay: 'Promise to pay active',
    kill_switch: 'Kill switch engaged',
  };
  return map[rule] ?? rule.replace(/_/g, ' ');
}
