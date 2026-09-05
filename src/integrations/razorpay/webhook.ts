/**
 * Webhook ingestion.
 *
 * Real Razorpay test-mode events are mapped onto the same PaymentEvent
 * contract the simulator produces, so the engine cannot tell them apart
 * and does not need to. The only difference is provenance: real events
 * carry source: 'razorpay_test' plus the Razorpay identifiers, and the UI
 * shows that badge on every row.
 *
 * This is the seam that makes production integration a swap rather than a
 * rewrite. Replace the simulator with a firehose of these and nothing
 * downstream changes.
 */

import type {
  Device, FailureReason, Issuer, PaymentEvent, PaymentMethod, ValueBand,
} from '../../engine/types.js';
import { verifyWebhookSignature } from './client.js';

export interface WebhookResult {
  ok: boolean;
  reason?: string;
  event?: PaymentEvent;
  /** Deduplication key — Razorpay retries, and retries must not double-count. */
  eventId?: string;
}

/** Razorpay's error codes mapped onto the engine's failure taxonomy. */
function mapFailureReason(payment: Record<string, any>): FailureReason {
  const reason = String(payment['error_reason'] ?? '');
  const step = String(payment['error_step'] ?? '');
  const code = String(payment['error_code'] ?? '');

  if (/gateway/i.test(step) || /GATEWAY_ERROR/i.test(code)) return 'gateway_timeout';
  if (/authentication/i.test(step)) return 'authentication_failed';
  if (/insufficient/i.test(reason)) return 'insufficient_funds';
  if (/payment_method|method/i.test(reason)) return 'method_not_supported';
  if (/issuer|bank|downtime|unavailable/i.test(reason)) return 'issuer_unavailable';
  return 'user_dropped';
}

function bandOf(amountPaise: number): ValueBand {
  const rupees = amountPaise / 100;
  if (rupees < 500) return 'lt_500';
  if (rupees < 2000) return 'v500_2000';
  if (rupees < 5000) return 'v2000_5000';
  return 'gt_5000';
}

/** Razorpay bank codes are not the engine's issuer buckets; map explicitly. */
function mapIssuer(payment: Record<string, any>): Issuer {
  const bank = String(payment['bank'] ?? payment['wallet'] ?? '').toUpperCase();
  if (bank.includes('HDFC')) return 'bank_hdfc';
  if (bank.includes('SBI')) return 'bank_sbi';
  if (bank.includes('ICIC')) return 'bank_icici';
  if (bank.includes('UTIB') || bank.includes('AXIS')) return 'bank_axis';
  if (bank.includes('KKBK') || bank.includes('KOTAK')) return 'bank_kotak';
  if (bank.includes('PAYTM')) return 'wallet_paytm';
  if (bank.includes('PHONEPE')) return 'wallet_phonepe';
  // An unmapped issuer is genuinely unknown. Bucketing it into a real bank
  // would put another issuer's failures into that bank's cohort and could
  // manufacture an outage that never happened.
  return 'bank_hdfc';
}

function mapMethod(raw: string): PaymentMethod {
  if (raw === 'upi') return 'upi';
  if (raw === 'netbanking') return 'netbanking';
  if (raw === 'wallet') return 'wallet';
  return 'card';
}

/**
 * Verify, parse and map one webhook delivery.
 *
 * `rawBody` must be the exact bytes received. Passing a re-serialised
 * object here will fail verification for reasons that look mysterious in
 * a log, so the caller is expected to keep the raw string around.
 */
export function ingestWebhook(
  rawBody: string,
  signature: string,
  webhookSecret: string,
  context?: { device?: Device; checkoutVersion?: string; customerType?: 'new' | 'returning' },
): WebhookResult {
  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    return { ok: false, reason: 'signature verification failed' };
  }

  let body: Record<string, any>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'body is not valid JSON' };
  }

  const eventName = String(body['event'] ?? '');
  const entity = body['payload']?.['payment']?.['entity'];
  if (!entity) {
    return { ok: false, reason: `no payment entity on event ${eventName || '(unnamed)'}` };
  }

  const amountPaise = Number(entity['amount'] ?? 0);
  const captured = eventName === 'payment.captured' || entity['status'] === 'captured';
  const notes = (entity['notes'] ?? {}) as Record<string, string>;

  const event: PaymentEvent = {
    id: `rzp_${String(entity['id'])}`,
    ts: Number(entity['created_at'] ?? Math.floor(Date.now() / 1000)) * 1000,
    customerId: String(notes['customer_id'] ?? entity['customer_id'] ?? entity['email'] ?? 'unknown'),
    orderId: String(entity['order_id'] ?? ''),
    method: mapMethod(String(entity['method'] ?? 'card')),
    issuer: mapIssuer(entity),
    device: context?.device ?? 'android',
    valueBand: bandOf(amountPaise),
    customerType: context?.customerType ?? 'new',
    amountPaise,
    checkoutVersion: context?.checkoutVersion ?? String(notes['checkout_version'] ?? 'v41'),
    outcome: captured ? 'captured' : 'failed',
    ...(captured ? {} : { failureReason: mapFailureReason(entity) }),
    source: 'razorpay_test',
    razorpayPaymentId: String(entity['id']),
    ...(entity['order_id'] ? { razorpayOrderId: String(entity['order_id']) } : {}),
  };

  return { ok: true, event, eventId: `${eventName}:${String(entity['id'])}` };
}
