/**
 * Razorpay test-mode client.
 *
 * Small on purpose. The SDK would work, but three endpoints and an HMAC
 * check are easier to read, easier to audit, and mean there is nothing in
 * the request path I cannot explain.
 *
 * Test mode needs no KYC. Keys are issued from the dashboard immediately
 * and start with `rzp_test_`; transactions use dummy credentials and move
 * no real money. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable —
 * with them unset the system runs entirely on the simulator and every
 * record stays tagged source: 'simulated'.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.razorpay.com/v1';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  /** Secret configured on the webhook in the dashboard. */
  webhookSecret: string;
}

export function configFromEnv(): RazorpayConfig | null {
  const keyId = process.env['RAZORPAY_KEY_ID'];
  const keySecret = process.env['RAZORPAY_KEY_SECRET'];
  const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET'] ?? '';
  if (!keyId || !keySecret) return null;
  if (!keyId.startsWith('rzp_test_')) {
    // A live key would move real money. This system creates payment links
    // and charges cards; it has no business holding one.
    throw new Error(
      'RAZORPAY_KEY_ID is not a test key. This project refuses live keys — ' +
      'it creates payment links and would be spending real customers\' money.',
    );
  }
  return { keyId, keySecret, webhookSecret };
}

function authHeader(cfg: RazorpayConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64');
}

async function call<T>(
  cfg: RazorpayConfig, method: 'GET' | 'POST', path: string, body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: authHeader(cfg),
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Razorpay ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ */
/* Orders — used to seed real test transactions into the event stream  */
/* ------------------------------------------------------------------ */

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
}

export function createOrder(
  cfg: RazorpayConfig,
  opts: { amountPaise: number; receipt: string; notes?: Record<string, string> },
): Promise<RazorpayOrder> {
  return call<RazorpayOrder>(cfg, 'POST', '/orders', {
    amount: opts.amountPaise,
    currency: 'INR',
    receipt: opts.receipt,
    notes: opts.notes ?? {},
  });
}

/* ------------------------------------------------------------------ */
/* Payment Links — the recovery action itself                          */
/* ------------------------------------------------------------------ */

export interface RazorpayPaymentLink {
  id: string;
  short_url: string;
  status: string;
  amount: number;
}

/**
 * Create the recovery link.
 *
 * `notes` carries the decision id and the idempotency key, so a link found
 * in the Razorpay dashboard can be traced back to the decision that
 * created it and the evidence behind it. That trace is the audit trail the
 * track brief asks for, and it exists on Razorpay's side as well as ours.
 */
export function createRecoveryLink(
  cfg: RazorpayConfig,
  opts: {
    amountPaise: number;
    description: string;
    customer: { name?: string; email?: string; contact?: string };
    /** Steer the customer to a method the engine believes is healthy. */
    preferredMethod?: 'upi' | 'card' | 'netbanking' | 'wallet';
    decisionId: string;
    idempotencyKey: string;
    notifyBy: { sms: boolean; email: boolean };
  },
): Promise<RazorpayPaymentLink> {
  return call<RazorpayPaymentLink>(cfg, 'POST', '/payment_links', {
    amount: opts.amountPaise,
    currency: 'INR',
    accept_partial: false,
    description: opts.description,
    customer: opts.customer,
    notify: { sms: opts.notifyBy.sms, email: opts.notifyBy.email },
    reminder_enable: false, // escalation is this system's job, not Razorpay's
    notes: {
      decision_id: opts.decisionId,
      idempotency_key: opts.idempotencyKey,
      ...(opts.preferredMethod ? { preferred_method: opts.preferredMethod } : {}),
    },
    ...(opts.preferredMethod
      ? { options: { checkout: { method: { [opts.preferredMethod]: '1' } } } }
      : {}),
  });
}

export function fetchPayment(cfg: RazorpayConfig, paymentId: string): Promise<unknown> {
  return call(cfg, 'GET', `/payments/${paymentId}`);
}

/* ------------------------------------------------------------------ */
/* Webhook signature verification                                      */
/* ------------------------------------------------------------------ */

/**
 * Verify the X-Razorpay-Signature header.
 *
 * The signature is an HMAC-SHA256 of the RAW request body under the
 * webhook secret. Two details matter and both are easy to get wrong:
 * the body must be the exact bytes received — re-serialising parsed JSON
 * changes key order and whitespace and invalidates the digest — and the
 * comparison must be constant-time, or the endpoint leaks the expected
 * signature one byte at a time to anyone willing to measure.
 */
export function verifyWebhookSignature(
  rawBody: string, signature: string, webhookSecret: string,
): boolean {
  if (!signature || !webhookSecret) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Webhook events this system subscribes to. */
export const SUBSCRIBED_EVENTS = [
  'payment.captured',
  'payment.failed',
  'order.paid',
  'payment_link.paid',
] as const;

export type SubscribedEvent = typeof SUBSCRIBED_EVENTS[number];
