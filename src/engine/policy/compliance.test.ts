import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AtRiskItem, CustomerState } from '../types.js';
import {
  channelForAttempt, checkCompliance, idempotencyKey, DEFAULT_COMPLIANCE,
} from './compliance.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IST = 5.5 * HOUR;

/** A timestamp at a given IST hour, so quiet-hours tests read plainly. */
const atIstHour = (hour: number) => Date.UTC(2026, 8, 4, 0, 0, 0) + hour * HOUR - IST;

const NOON = atIstHour(12);
const MIDNIGHT = atIstHour(0);

const item: AtRiskItem = {
  id: 'item_1', customerId: 'cust_1', orderId: 'order_1', eventId: 'evt_1',
  amountPaise: 250_000, failedAt: NOON - HOUR,
  method: 'upi', issuer: 'bank_hdfc', device: 'android',
  valueBand: 'v2000_5000', customerType: 'returning', checkoutVersion: 'v41',
  failureReason: 'issuer_unavailable',
};

const fresh = (over: Partial<CustomerState> = {}): CustomerState => ({
  customerId: 'cust_1',
  contacts: [],
  consent: { link: true, email: true, sms: true },
  ...over,
});

test('a clean customer during business hours is contactable', () => {
  const r = checkCompliance(item, fresh(), 'nudge', NOON);
  assert.equal(r.allowed, true);
  assert.deepEqual(r.blockedBy, []);
});

test('server-side interventions bypass contact rules entirely', () => {
  // Three contacts already used, and it is the middle of the night.
  const exhausted = fresh({
    contacts: [
      { customerId: 'cust_1', ts: NOON - 3 * DAY, channel: 'link' },
      { customerId: 'cust_1', ts: NOON - 2 * DAY, channel: 'email' },
      { customerId: 'cust_1', ts: NOON - DAY, channel: 'sms' },
    ],
  });
  // Retrying a payment does not message anyone, so none of that applies.
  assert.equal(checkCompliance(item, exhausted, 'wait_and_retry', MIDNIGHT).allowed, true);
  assert.equal(checkCompliance(item, exhausted, 'immediate_retry', MIDNIGHT).allowed, true);
  // Sending a message does.
  assert.equal(checkCompliance(item, exhausted, 'nudge', NOON).allowed, false);
});

test('attempt cap blocks a fourth contact inside the window', () => {
  const state = fresh({
    contacts: [
      { customerId: 'cust_1', ts: NOON - 10 * DAY, channel: 'link' },
      { customerId: 'cust_1', ts: NOON - 6 * DAY, channel: 'email' },
      { customerId: 'cust_1', ts: NOON - 2 * DAY, channel: 'sms' },
    ],
  });
  const r = checkCompliance(item, state, 'nudge', NOON);
  assert.equal(r.allowed, false);
  assert.ok(r.blockedBy.some((b) => b.startsWith('attempt_cap')));
});

test('contacts older than the rolling window stop counting', () => {
  const state = fresh({
    contacts: [
      { customerId: 'cust_1', ts: NOON - 30 * DAY, channel: 'link' },
      { customerId: 'cust_1', ts: NOON - 20 * DAY, channel: 'email' },
      { customerId: 'cust_1', ts: NOON - 16 * DAY, channel: 'sms' },
    ],
  });
  assert.equal(checkCompliance(item, state, 'nudge', NOON).allowed, true);
});

test('cooldown escalates between attempts', () => {
  const oneContact = (hoursAgo: number) =>
    fresh({ contacts: [{ customerId: 'cust_1', ts: NOON - hoursAgo * HOUR, channel: 'link' }] });

  // Second attempt needs 24h.
  assert.equal(checkCompliance(item, oneContact(10), 'nudge', NOON).allowed, false);
  assert.equal(checkCompliance(item, oneContact(30), 'nudge', NOON).allowed, true);
});

test('quiet hours defer rather than drop, and name the resume time', () => {
  const r = checkCompliance(item, fresh(), 'nudge', MIDNIGHT);
  assert.equal(r.allowed, false);
  assert.ok(r.blockedBy[0]!.startsWith('quiet_hours'));
  // The money is still recoverable in the morning; dropping the item would
  // be a worse outcome for the merchant than waiting.
  assert.ok(r.deferUntilTs !== undefined);
  assert.ok(r.deferUntilTs! > MIDNIGHT);
  const resumeIstHour = new Date(r.deferUntilTs! + IST).getUTCHours();
  assert.equal(resumeIstHour, DEFAULT_COMPLIANCE.quietToHourIST);
});

test('promise to pay suppresses chasing until the day after', () => {
  const promised = fresh({ promiseToPayTs: NOON + 2 * DAY });
  const during = checkCompliance(item, promised, 'nudge', NOON);
  assert.equal(during.allowed, false);
  assert.ok(during.blockedBy.some((b) => b.startsWith('promise_to_pay')));

  const after = checkCompliance(item, promised, 'nudge', NOON + 4 * DAY);
  assert.equal(after.allowed, true);
});

test('withdrawn consent blocks the channel', () => {
  const noEmail = fresh({ consent: { link: true, email: false, sms: true } });
  const r = checkCompliance(item, noEmail, 'nudge', NOON);
  assert.equal(r.allowed, false);
  assert.ok(r.blockedBy.some((b) => b.startsWith('consent')));
});

test('kill switch halts everything, including server-side actions', () => {
  const cfg = { ...DEFAULT_COMPLIANCE, killSwitch: true };
  for (const i of ['nudge', 'wait_and_retry', 'alternate_method'] as const) {
    const r = checkCompliance(item, fresh(), i, NOON, cfg);
    assert.equal(r.allowed, false, `${i} should be halted`);
    assert.ok(r.blockedBy[0]!.startsWith('kill_switch'));
  }
});

test('escalation ladder never skips a rung', () => {
  assert.equal(channelForAttempt(0), 'link');
  assert.equal(channelForAttempt(1), 'email');
  assert.equal(channelForAttempt(2), 'sms');
});

test('idempotency keys are stable and distinguish attempts', () => {
  assert.equal(idempotencyKey('cust_1', 'dec_1', 0), idempotencyKey('cust_1', 'dec_1', 0));
  assert.notEqual(idempotencyKey('cust_1', 'dec_1', 0), idempotencyKey('cust_1', 'dec_1', 1));
  assert.notEqual(idempotencyKey('cust_1', 'dec_1', 0), idempotencyKey('cust_2', 'dec_1', 0));
});
