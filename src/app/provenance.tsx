import { configFromEnv } from '../integrations/razorpay/client.js';

/**
 * Provenance badge.
 *
 * Every screen in this console is one click from a number, and a reader
 * is entitled to know at a glance which of those numbers came from a
 * simulator and which came from Razorpay. Stating it once, permanently,
 * in the chrome is better than a disclaimer nobody scrolls to.
 */
export function ProvenanceBadge() {
  let live = false;
  let keyId = '';
  let error: string | null = null;

  try {
    const cfg = configFromEnv();
    live = cfg !== null;
    keyId = cfg?.keyId ?? '';
  } catch (e) {
    // configFromEnv throws on a live key on purpose. Surface it rather
    // than silently falling back to the simulator.
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    return (
      <div className="provenance">
        <b style={{ color: 'var(--stop)' }}>Configuration refused</b>
        <br />
        {error}
      </div>
    );
  }

  return (
    <div className={`provenance${live ? ' is-live' : ''}`}>
      {live ? (
        <>
          <b>Razorpay test mode</b> connected
          <br />
          <span className="dim">{keyId}</span>
          <br />
          <br />
          Event history is <b>simulated</b>. Payment links, webhooks and payment
          identifiers are real test-mode objects. No real money moves.
        </>
      ) : (
        <>
          <b>Simulated</b> — no Razorpay keys set
          <br />
          <br />
          Every figure here comes from the engine running against a synthetic
          event stream. Add <span className="dim">rzp_test_</span> keys to{' '}
          <span className="dim">.env</span> to route real recovery links and
          webhooks through the same contract.
        </>
      )}
    </div>
  );
}
