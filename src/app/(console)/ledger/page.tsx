import Link from 'next/link';

import { fileLedger } from '../../../store/ledger.js';
import { Chip, Empty, Panel, Stat } from '../../../ui/components.js';
import {
  humanCause, humanIntervention, humanRule, money, pct, pp, ts,
} from '../../../ui/format.js';

export const dynamic = 'force-dynamic';

export default function LedgerPage() {
  const portfolio = fileLedger.readPortfolio();
  if (!portfolio) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Screen 4</div>
          <h1>Evidence ledger</h1>
        </div>
        <Empty>
          No run data yet. Generate it with <code>npm run seed</code>, then reload.
        </Empty>
      </>
    );
  }

  const decisions = portfolio.runs.flatMap((r) => r.decisions.map((d) => ({ run: r, d })));
  const totalOutcomes = decisions.reduce((s, x) => s + x.d.outcomes.length, 0);
  const withKeys = decisions.reduce(
    (s, x) => s + x.d.outcomes.filter((o) => o.idempotencyKey !== null).length,
    0,
  );
  const blockedTotal = portfolio.blockedByRule.reduce((s, r) => s + r.count, 0);

  // The worked example is the first acting decision, so the trail below is
  // never an empty shell.
  const example = decisions.find((x) => x.d.kind === 'ACT') ?? decisions[0];

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Screen 4 · the audit trail</div>
        <h1>Evidence ledger</h1>
        <p className="page-sub">
          Every decision is recorded with the evidence that produced it, the hypotheses it
          rejected, the policy checks it passed, the compliance rules that fired, and the
          outcome that followed. Nothing here is written by hand — it is what the engine
          emitted at the moment it decided.
        </p>
      </div>

      <div className="stats stats-4" style={{ marginBottom: 18 }}>
        <Stat label="Decisions recorded" value={decisions.length} sub={`across ${portfolio.runs.length} runs`} />
        <Stat label="Item outcomes" value={totalOutcomes.toLocaleString('en-IN')} sub="every arm assignment retained" />
        <Stat
          label="Idempotency keys issued"
          value={withKeys}
          sub="one per contact — a replayed webhook cannot double-send"
        />
        <Stat
          label="Compliance vetoes"
          value={blockedTotal}
          tone={blockedTotal > 0 ? 'neg' : undefined}
          sub="economics approved, a rule said no"
        />
      </div>

      {portfolio.blockedByRule.length > 0 ? (
        <Panel tight title="Which rules fired">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th className="num">Items stopped</th>
                  <th>What it protects</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.blockedByRule.map((r) => (
                  <tr key={r.rule}>
                    <td style={{ fontWeight: 550 }}>{humanRule(r.rule)}</td>
                    <td className="num">{r.count}</td>
                    <td className="dim">{RULE_PURPOSE[r.rule] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {example ? (
        <>
          <h2>A decision, end to end</h2>
          <p className="note">
            {example.d.id} — the same chain exists for every row in the table below.
          </p>
          <Panel>
            <ol className="trail">
              <li>
                <div className="trail-label">Triggering evidence</div>
                Success rate for <b>{example.d.cohortLabel}</b> fell from{' '}
                {pct(example.d.preRate)} to {pct(example.d.postRate)} ({pp(example.d.postRate - example.d.preRate)}),
                measured over {example.d.preN} pre-period and {example.d.postN} post-period payments.
                Change point placed the onset at {ts(example.d.onsetTs)}.
              </li>
              <li>
                <div className="trail-label">Multiple-comparison control</div>
                {example.run.cohortsTested} cohorts were tested in this window; a cohort had
                to clear |z| &gt; {example.run.zThreshold.toFixed(2)} after Šidák correction
                to be reported at all.
              </li>
              <li>
                <div className="trail-label">Hypotheses considered</div>
                <div className="pill-row" style={{ marginTop: 4 }}>
                  {example.d.hypotheses.map((h, i) => (
                    <span key={h.cause} className={`chip ${i === 0 ? 'chip-ACT' : 'chip-holdout'}`}>
                      {humanCause(h.cause)} {Math.round(h.weight * 100)}%
                    </span>
                  ))}
                </div>
              </li>
              <li>
                <div className="trail-label">Hypotheses rejected</div>
                {example.d.hypotheses.slice(1, 4).map((h) => (
                  <div key={h.cause} style={{ marginBottom: 4 }}>
                    <b>{humanCause(h.cause)}</b>
                    <span className="dim"> — {h.evidenceAgainst[0] ?? 'carried less evidence weight'}</span>
                  </div>
                ))}
              </li>
              <li>
                <div className="trail-label">Counterfactual estimates</div>
                {example.d.options.length > 0 ? (
                  example.d.options.map((o) => (
                    <div key={o.intervention} className="mono" style={{ fontSize: 12 }}>
                      {humanIntervention(o.intervention)} — net {money(o.netPaise)}, lower bound{' '}
                      {money(o.netLowPaise)} from {o.n} prior observations
                    </div>
                  ))
                ) : (
                  <span className="dim">No intervention had enough history to estimate.</span>
                )}
              </li>
              <li>
                <div className="trail-label">Policy check</div>
                Requires the lower bound of net value to exceed zero.{' '}
                {example.d.kind === 'ACT' || example.d.kind === 'WAIT' ? 'Passed.' : 'Not met.'}
              </li>
              <li>
                <div className="trail-label">Compliance gate</div>
                {example.d.blockedN > 0
                  ? `${example.d.blockedN} of ${example.d.itemCount} items vetoed by contact rules.`
                  : 'No contact rule vetoed this decision.'}
              </li>
              <li>
                <div className="trail-label">Action</div>
                <Chip kind={example.d.kind} />{' '}
                <span style={{ marginLeft: 6 }}>{humanIntervention(example.d.intervention)}</span>
                {' — '}
                {example.d.treatedN} treated, {example.d.holdoutN} held out.
              </li>
              <li>
                <div className="trail-label">Outcome</div>
                {example.d.lift && example.d.treatedN > 0 ? (
                  <>
                    Treated recovered at {pct(example.d.treatedRecovered / example.d.treatedN)},
                    holdout at {pct(example.d.holdoutN ? example.d.holdoutRecovered / example.d.holdoutN : 0)}.
                    Measured lift <b>{pp(example.d.lift.diff)}</b>. Gross{' '}
                    {money(example.d.grossRecoveredPaise)}, incremental{' '}
                    <b className="sig">{money(example.d.incrementalPaise)}</b>, spend{' '}
                    {money(example.d.spendPaise)}, net{' '}
                    <b className={example.d.netPaise >= 0 ? 'sig' : 'neg'}>{money(example.d.netPaise)}</b>.
                  </>
                ) : (
                  <>Nothing was done. {example.d.holdoutRecovered} of {example.d.holdoutN} recovered unaided.</>
                )}
              </li>
              <li>
                <div className="trail-label">Written back</div>
                Both arms were recorded against the diagnosed cause in the prior store, which
                is what the next decision on this cause reads.
              </li>
            </ol>
            <div style={{ marginTop: 14 }}>
              <Link href={`/incidents/${example.d.id}`} className="btn btn-primary">
                Open full evidence page
              </Link>
            </div>
          </Panel>
        </>
      ) : null}

      <h2>All decisions</h2>
      <Panel tight title={`${decisions.length} records, newest first`}>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Decision id</th>
                <th>Recorded</th>
                <th>Cohort</th>
                <th>Verdict</th>
                <th>Action</th>
                <th className="num">Items</th>
                <th className="num">Net</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {decisions.map(({ d }) => (
                <tr key={d.id}>
                  <td className="mono">{d.id}</td>
                  <td className="mono dim">{ts(d.createdAt)}</td>
                  <td>{d.cohortLabel}</td>
                  <td>
                    {d.verdictKind === 'diagnosed' ? (
                      humanCause(d.cause)
                    ) : (
                      <span className="pha">Insufficient evidence</span>
                    )}
                  </td>
                  <td>
                    <Chip kind={d.kind} />
                  </td>
                  <td className="num">{d.itemCount}</td>
                  <td className={`num ${d.netPaise > 0 ? 'sig' : d.netPaise < 0 ? 'neg' : 'dim'}`}>
                    {d.treatedN > 0 ? money(d.netPaise) : '—'}
                  </td>
                  <td className="num">
                    <Link href={`/incidents/${d.id}`} className="btn">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

const RULE_PURPOSE: Record<string, string> = {
  quiet_hours: 'No outreach 21:00–09:00 IST. Queued, not dropped.',
  attempt_cap: 'At most 3 contacts per customer per rolling 14 days.',
  cooldown: 'Escalating gap between attempts: 24h, then 72h, then 168h.',
  consent: 'Per-channel consent checked before every send.',
  promise_to_pay: 'All chasing suppressed until the committed date, plus one day.',
  kill_switch: 'Global halt, including server-side actions.',
};
