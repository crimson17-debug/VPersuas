/**
 * The compliance gate.
 *
 * The track brief asks for compliant escalation and stopping rules, and
 * this is where an agent that chases people stops being only an
 * optimisation problem. Every rule here can veto an action the economics
 * approved of, and every veto is recorded with the rule that caused it.
 *
 * Nothing here is advisory. The gate runs after scoring and before
 * execution, and a blocked item is closed as abandoned-by-rule rather than
 * quietly retried later.
 */

import type { AtRiskItem, CustomerState, Intervention } from '../types.js';
import { isCustomerContact } from './costs.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** India Standard Time is UTC+05:30; no DST to worry about. */
const IST_OFFSET_MS = 5.5 * HOUR;

export interface ComplianceConfig {
  /** Maximum customer contacts within the rolling window. */
  maxContacts: number;
  contactWindowDays: number;
  /** Minimum gap before contact n+1, indexed by attempts already made. */
  cooldownHours: number[];
  /** Local hour outreach stops, and the hour it resumes. */
  quietFromHourIST: number;
  quietToHourIST: number;
  /** Global halt. */
  killSwitch: boolean;
}

export const DEFAULT_COMPLIANCE: ComplianceConfig = {
  maxContacts: 3,
  contactWindowDays: 14,
  cooldownHours: [0, 24, 72, 168],
  quietFromHourIST: 21,
  quietToHourIST: 9,
  killSwitch: false,
};

export interface GateResult {
  allowed: boolean;
  /** Rules that vetoed, in the order they were evaluated. */
  blockedBy: string[];
  /** Set when the action is legal but must wait for the quiet period to end. */
  deferUntilTs?: number;
}

function istHour(ts: number): number {
  return new Date(ts + IST_OFFSET_MS).getUTCHours();
}

/** Next moment outreach is permitted, given quiet hours. */
function nextAllowedTs(ts: number, cfg: ComplianceConfig): number {
  const d = new Date(ts + IST_OFFSET_MS);
  const target = new Date(d);
  target.setUTCMinutes(0, 0, 0);
  target.setUTCHours(cfg.quietToHourIST);
  if (target.getTime() <= d.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - IST_OFFSET_MS;
}

export function checkCompliance(
  item: AtRiskItem,
  state: CustomerState | undefined,
  intervention: Intervention,
  nowTs: number,
  cfg: ComplianceConfig = DEFAULT_COMPLIANCE,
): GateResult {
  const blockedBy: string[] = [];

  if (cfg.killSwitch) {
    return { allowed: false, blockedBy: ['kill_switch: recovery halted globally'] };
  }

  if (intervention === 'none') return { allowed: true, blockedBy: [] };

  // Server-side interventions touch routing and retry scheduling, not the
  // customer, so contact rules do not apply to them.
  if (!isCustomerContact(intervention)) return { allowed: true, blockedBy: [] };

  const contacts = state?.contacts ?? [];
  const windowStart = nowTs - cfg.contactWindowDays * DAY;
  const recent = contacts.filter((c) => c.ts >= windowStart);

  if (recent.length >= cfg.maxContacts) {
    blockedBy.push(
      `attempt_cap: ${recent.length} contacts in the last ${cfg.contactWindowDays} days ` +
      `(max ${cfg.maxContacts})`,
    );
  }

  const last = recent.reduce<number | null>((m, c) => (m === null || c.ts > m ? c.ts : m), null);
  if (last !== null) {
    const required = cfg.cooldownHours[Math.min(recent.length, cfg.cooldownHours.length - 1)] ?? 0;
    const elapsedHours = (nowTs - last) / HOUR;
    if (elapsedHours < required) {
      blockedBy.push(
        `cooldown: ${elapsedHours.toFixed(1)}h since last contact, ${required}h required ` +
        `before attempt ${recent.length + 1}`,
      );
    }
  }

  if (state?.promiseToPayTs !== undefined && nowTs <= state.promiseToPayTs + DAY) {
    blockedBy.push(
      `promise_to_pay: customer committed to pay by ` +
      `${new Date(state.promiseToPayTs).toISOString().slice(0, 10)} — suppressed until the day after`,
    );
  }

  const channel: 'link' | 'email' | 'sms' =
    intervention === 'alternate_method' ? 'link' : recent.length === 0 ? 'email' : 'sms';
  if (state && !state.consent[channel]) {
    blockedBy.push(`consent: customer has not consented to ${channel}`);
  }

  // Quiet hours defer rather than block: the money is still recoverable
  // tomorrow morning, and dropping the item would be a worse outcome for
  // the merchant than waiting eight hours.
  const hour = istHour(nowTs);
  const inQuiet =
    cfg.quietFromHourIST > cfg.quietToHourIST
      ? hour >= cfg.quietFromHourIST || hour < cfg.quietToHourIST
      : hour >= cfg.quietFromHourIST && hour < cfg.quietToHourIST;

  if (inQuiet && blockedBy.length === 0) {
    const until = nextAllowedTs(nowTs, cfg);
    return {
      allowed: false,
      blockedBy: [
        `quiet_hours: ${hour}:00 IST is inside the ${cfg.quietFromHourIST}:00–` +
        `${cfg.quietToHourIST}:00 window — queued until ` +
        `${new Date(until).toISOString().slice(11, 16)} UTC`,
      ],
      deferUntilTs: until,
    };
  }

  return { allowed: blockedBy.length === 0, blockedBy };
}

/** Escalation ladder. Attempt number decides the channel; never skip a rung. */
export function channelForAttempt(attempt: number): 'link' | 'email' | 'sms' {
  if (attempt <= 0) return 'link';
  if (attempt === 1) return 'email';
  return 'sms';
}

/**
 * Idempotency key for an action. Replayed webhooks and re-run batches
 * cannot double-send because the executor refuses a key it has seen.
 */
export function idempotencyKey(
  customerId: string, incidentId: string, attempt: number,
): string {
  return `act_${customerId}_${incidentId}_${attempt}`;
}
