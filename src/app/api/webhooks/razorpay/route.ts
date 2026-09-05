/**
 * Razorpay webhook endpoint.
 *
 * POST /api/webhooks/razorpay
 *
 * Configure this URL in the Razorpay dashboard against the events listed
 * in SUBSCRIBED_EVENTS, with the same secret as RAZORPAY_WEBHOOK_SECRET.
 *
 * Two details this endpoint gets right because they are easy to get wrong:
 *
 *  - The signature is an HMAC of the RAW request bytes. Parsing the JSON
 *    and re-serialising it changes key order and whitespace and silently
 *    invalidates the digest, so the body is read as text and verified
 *    before anything looks at its contents.
 *  - Razorpay retries. Deliveries are deduplicated on
 *    (event name, payment id) so a retry cannot double-count a recovery
 *    or trigger a second action.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { configFromEnv } from '../../../../integrations/razorpay/client.js';
import { ingestWebhook } from '../../../../integrations/razorpay/webhook.js';
import type { PaymentEvent } from '../../../../engine/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DIR = join(process.cwd(), '.data');
const LIVE = join(DIR, 'live-events.json');

interface LiveLog {
  seen: string[];
  events: PaymentEvent[];
}

function readLog(): LiveLog {
  if (!existsSync(LIVE)) return { seen: [], events: [] };
  try {
    return JSON.parse(readFileSync(LIVE, 'utf8')) as LiveLog;
  } catch {
    return { seen: [], events: [] };
  }
}

/**
 * Best-effort persistence.
 *
 * Serverless filesystems are read-only, so this throws in production on
 * Vercel. That is not a bug to hide — it is the precise point where the
 * JSON file store stops being adequate and a real database has to take
 * over. The endpoint still verifies, parses and acknowledges the delivery;
 * it just cannot remember it, and it says so in the response rather than
 * pretending the write succeeded.
 */
function writeLog(log: LiveLog): { persisted: boolean; error?: string } {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(LIVE, JSON.stringify(log), 'utf8');
    return { persisted: true };
  } catch (e) {
    return {
      persisted: false,
      error: e instanceof Error ? e.message : 'filesystem is not writable',
    };
  }
}

export async function POST(request: Request): Promise<Response> {
  let cfg;
  try {
    cfg = configFromEnv();
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : 'bad configuration' },
      { status: 500 },
    );
  }

  if (!cfg || !cfg.webhookSecret) {
    // Returning 503 rather than 200 so a misconfigured deployment shows up
    // in Razorpay's own delivery log instead of silently discarding events.
    return Response.json(
      { ok: false, error: 'RAZORPAY_WEBHOOK_SECRET is not configured' },
      { status: 503 },
    );
  }

  const raw = await request.text();
  const signature = request.headers.get('x-razorpay-signature') ?? '';

  const result = ingestWebhook(raw, signature, cfg.webhookSecret);
  if (!result.ok || !result.event || !result.eventId) {
    const unauthorised = result.reason?.includes('signature');
    return Response.json({ ok: false, error: result.reason }, { status: unauthorised ? 401 : 400 });
  }

  const log = readLog();
  if (log.seen.includes(result.eventId)) {
    // Idempotent by design: acknowledge so Razorpay stops retrying, but
    // do not record the event twice.
    return Response.json({ ok: true, duplicate: true, eventId: result.eventId });
  }

  log.seen.push(result.eventId);
  log.events.push(result.event);
  // Keep the dedupe window bounded; the ledger is the durable record.
  if (log.seen.length > 5000) log.seen = log.seen.slice(-5000);
  const write = writeLog(log);

  // 200 either way: the delivery was genuinely accepted and verified, and
  // asking Razorpay to retry would not fix a read-only disk.
  return Response.json({
    ok: true,
    eventId: result.eventId,
    payment: result.event.razorpayPaymentId,
    outcome: result.event.outcome,
    source: result.event.source,
    persisted: write.persisted,
    ...(write.persisted
      ? {}
      : {
          warning:
            'Event verified but not persisted — this deployment has a read-only ' +
            'filesystem. Swap LedgerStore for a database before relying on it.',
          detail: write.error,
        }),
  });
}

/** Health check, so the endpoint can be verified before wiring the dashboard. */
export async function GET(): Promise<Response> {
  let configured = false;
  let error: string | null = null;
  try {
    const cfg = configFromEnv();
    configured = Boolean(cfg?.webhookSecret);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const log = readLog();
  return Response.json({
    ok: true,
    configured,
    error,
    received: log.events.length,
    subscribe: ['payment.captured', 'payment.failed', 'order.paid', 'payment_link.paid'],
  });
}
