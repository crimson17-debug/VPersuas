import Link from 'next/link';
import { notFound } from 'next/navigation';

import { fileLedger } from '../../../../store/ledger.js';
import { Callout, Chip, LiftInterval, Panel, SplitBar, Stat } from '../../../../ui/components.js';
import {
  humanCause, humanIntervention, humanRule, money, pct, pp, ppRange, ts,
} from '../../../../ui/format.js';

export const dynamic = 'force-dynamic';

export default async function IncidentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const found = fileLedger.findDecision(id);
  if (!found) notFound();

  const { decision: d, run } = found;
  const top = d.hypotheses[0];
  const chosen = d.options.find((o) => o.intervention === d.intervention);

  const blockedCounts = new Map<string, number>();
  for (const o of d.outcomes) {
    for (const b of o.blockedBy) {
      const rule = b.split(':')[0]!.trim();
      blockedCounts.set(rule, (blockedCounts.get(rule) ?? 0) + 1);
    }
  }
  const firstBlockedDetail = d.outcomes.find((o) => o.blockedBy.length > 0)?.blockedBy[0];

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">
          <Link href="/incidents" className="dim">
            ← Incidents
          </Link>{' '}
          · {run.runId} · {d.id}
        </div>
        <h1>{d.cohortLabel}</h1>
        <p className="page-sub">
          Success rate fell from {pct(d.preRate)} to {pct(d.postRate)} ({pp(d.postRate - d.preRate)})
          starting {ts(d.onsetTs)}, putting {money(d.exposedPaise)} at risk.
        </p>
      </div>

      <div className="stats stats-4" style={{ marginBottom: 20 }}>
        <Stat label="Decision" value={<Chip kind={d.kind} />} sub={humanIntervention(d.intervention)} />
        <Stat
          label="Diagnosis"
          value={
            d.cause ? (
              <span style={{ fontSize: 17 }}>{humanCause(d.cause)}</span>
            ) : (
              <span style={{ fontSize: 17 }} className="pha">
                Insufficient evidence
              </span>
            )
          }
          sub={d.cause ? `${Math.round((d.causeWeight ?? 0) * 100)}% of evidence weight` : d.insufficientReason ?? ''}
        />
        <Stat
          label="Cohorts tested"
          value={run.cohortsTested}
          sub={`had to clear |z| > ${run.zThreshold.toFixed(2)} after correction`}
        />
        <Stat label="Items in cohort" value={d.itemCount} sub={`${d.treatedN} treated · ${d.holdoutN} held out`} />
      </div>

      {/* ---------------- hypotheses ---------------- */}
      <h2>Why — ranked hypotheses</h2>
      <Panel>
        {d.hypotheses.map((h, i) => (
          <div key={h.cause} className={`hyp-row${i === 0 ? ' top' : ''}`}>
            <div>
              <span style={{ fontWeight: i === 0 ? 600 : 400 }}>{humanCause(h.cause)}</span>
              {i === 0 && h.effect < 0 ? (
                <div className="mono dim" style={{ fontSize: 11 }}>
                  {pp(h.effect)} vs {h.controlLabel} (95% CI {ppRange(h.ciLow, h.ciHigh)})
                </div>
              ) : null}
            </div>
            <div className="num mono">{Math.round(h.weight * 100)}%</div>
            <div className="hyp-bar">
              <i style={{ width: `${Math.max(1, h.weight * 100)}%` }} />
            </div>
          </div>
        ))}
      </Panel>

      {top ? (
        <div className="panel">
          <div className="panel-title" style={{ marginBottom: 10 }}>
            Evidence for {humanCause(top.cause).toLowerCase()}
          </div>
          <ul className="evidence">
            {top.evidenceFor.map((e, i) => (
              <li key={`f${i}`} className="for">
                <b>✓</b>
                <span>{e}</span>
              </li>
            ))}
            {top.evidenceAgainst.map((e, i) => (
              <li key={`a${i}`} className="against">
                <b>✗</b>
                <span>{e}</span>
              </li>
            ))}
          </ul>
          <p className="note" style={{ marginBottom: 0 }}>
            The effect is estimated by difference-in-differences against a matched control:{' '}
            {top.controlLabel}. That identifies a cause only if the two cohorts would have
            moved together absent it — an assumption checked in the pre-period, and the main
            threat to this conclusion.
          </p>
        </div>
      ) : null}

      {/* ---------------- options ---------------- */}
      {d.options.length > 0 ? (
        <>
          <h2>What each intervention was worth</h2>
          <Panel tight title="Scored options — ranked by net value">
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Intervention</th>
                    <th className="num">Est. lift</th>
                    <th className="num">95% CI</th>
                    <th className="num">Value</th>
                    <th className="num">Cost</th>
                    <th className="num">Net</th>
                    <th className="num">Net, lower bound</th>
                    <th className="num">n</th>
                  </tr>
                </thead>
                <tbody>
                  {d.options.map((o) => (
                    <tr key={o.intervention} className={o.intervention === d.intervention ? 'is-engine' : ''}>
                      <td>
                        {humanIntervention(o.intervention)}
                        {o.intervention === d.intervention ? (
                          <span className="mono sig" style={{ marginLeft: 8, fontSize: 11 }}>
                            chosen
                          </span>
                        ) : null}
                      </td>
                      <td className="num">{pp(o.lift)}</td>
                      <td className="num dim">{ppRange(o.liftLow, o.liftHigh)}</td>
                      <td className="num">{money(o.expectedValuePaise)}</td>
                      <td className="num">{money(o.expectedCostPaise)}</td>
                      <td className={`num ${o.netPaise > 0 ? 'sig' : 'neg'}`}>{money(o.netPaise)}</td>
                      <td className={`num ${o.netLowPaise > 0 ? 'sig' : 'neg'}`}>{money(o.netLowPaise)}</td>
                      <td className="num dim">{o.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <p className="note">
            The policy acts only when the <b>lower bound</b> of net value is positive, not the
            point estimate. Acting on a point estimate means acting half the time on noise.
          </p>
        </>
      ) : null}

      {d.rejected.length > 0 ? (
        <Panel title="Rejected, and why">
          {d.rejected.map((r, i) => (
            <div key={`${r.intervention}${i}`} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 550 }}>{humanIntervention(r.intervention)}</div>
              <div className="note">{r.why}</div>
            </div>
          ))}
        </Panel>
      ) : null}

      {/* ---------------- decision ---------------- */}
      <h2>Decision</h2>
      <Callout
        tone={d.kind === 'ACT' || d.kind === 'WAIT' ? 'good' : d.kind === 'BLOCKED' ? 'bad' : 'warn'}
        title={d.kind.replace(/_/g, ' ')}
      >
        <p style={{ marginBottom: d.explorationNote ? 10 : 0 }}>{d.reason}</p>
        {d.explorationNote ? <p className="note" style={{ marginBottom: 0 }}>{d.explorationNote}</p> : null}
      </Callout>

      {blockedCounts.size > 0 ? (
        <Panel title="Stopped by compliance">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th className="num">Items</th>
                </tr>
              </thead>
              <tbody>
                {[...blockedCounts]
                  .sort((a, b) => b[1] - a[1])
                  .map(([rule, n]) => (
                    <tr key={rule}>
                      <td>{humanRule(rule)}</td>
                      <td className="num">{n}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {firstBlockedDetail ? (
            <p className="note" style={{ marginTop: 10, marginBottom: 0 }}>
              Example: <span className="mono">{firstBlockedDetail}</span>
            </p>
          ) : null}
        </Panel>
      ) : null}

      {/* ---------------- outcome ---------------- */}
      <h2>What actually happened</h2>
      {d.treatedN > 0 && d.lift ? (
        <>
          <div className="stats stats-4" style={{ marginBottom: 16 }}>
            <Stat
              label="Treated"
              value={pct(d.treatedRecovered / d.treatedN)}
              sub={`${d.treatedRecovered} of ${d.treatedN} recovered`}
            />
            <Stat
              label="Holdout"
              value={d.holdoutN > 0 ? pct(d.holdoutRecovered / d.holdoutN) : '—'}
              sub={`${d.holdoutRecovered} of ${d.holdoutN} recovered with nothing done`}
            />
            <Stat
              label="Incremental"
              value={money(d.incrementalPaise)}
              tone={d.lift.significant ? 'sig' : 'pha'}
              sub={`95% CI ${money(d.incrementalLowPaise)} – ${money(d.incrementalHighPaise)}`}
            />
            <Stat
              label="Net"
              value={money(d.netPaise)}
              tone={d.netPaise >= 0 ? 'sig' : 'neg'}
              sub={`after ${money(d.spendPaise)} of spend`}
            />
          </div>

          <Panel title="Measured lift, treated minus holdout">
            <LiftInterval
              lift={d.lift.diff}
              low={d.lift.low}
              high={d.lift.high}
              significant={d.lift.significant}
            />
            {!d.lift.significant ? (
              <p className="note" style={{ marginTop: 12, marginBottom: 0 }}>
                At this cohort&rsquo;s sample size the effect cannot be distinguished from
                zero. The portfolio-level estimate on the incrementality screen pools every
                arm and is the figure to trust.
              </p>
            ) : null}
          </Panel>

          <Panel title="Gross versus incremental for this cohort">
            <SplitBar grossPaise={d.grossRecoveredPaise} incrementalPaise={d.incrementalPaise} />
          </Panel>

          {chosen ? (
            <Callout tone="good" title="Predicted against observed">
              <p style={{ marginBottom: 0 }}>
                The policy predicted a lift of <b>{pp(chosen.lift)}</b> from {chosen.n} prior
                observations. The holdout measured <b>{pp(d.lift.diff)}</b> — off by{' '}
                {pp(Math.abs(chosen.lift - d.lift.diff))}. Both arms have been written back
                to the prior store, so the next decision on this cause starts from a slightly
                better estimate than this one did.
              </p>
            </Callout>
          ) : null}
        </>
      ) : (
        <Callout tone="warn" title="Nothing was done, on purpose">
          <p style={{ marginBottom: 0 }}>
            {d.holdoutRecovered} of {d.holdoutN} payments in this cohort recovered with no
            intervention at all — {d.holdoutN > 0 ? pct(d.holdoutRecovered / d.holdoutN) : '—'}{' '}
            for free. Nothing was spent. Those outcomes still went into the prior store, so
            the refusal was not a wasted observation.
          </p>
        </Callout>
      )}

      <h2>Item-level outcomes</h2>
      <Panel tight title={`${d.outcomes.length} payments`}>
        <div className="tablewrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Arm</th>
                <th>Applied</th>
                <th className="num">Amount</th>
                <th className="num">Spend</th>
                <th>Result</th>
                <th>Idempotency key</th>
              </tr>
            </thead>
            <tbody>
              {d.outcomes.slice(0, 300).map((o) => (
                <tr key={o.itemId}>
                  <td className="mono">{o.customerId}</td>
                  <td>
                    <Chip kind={o.arm} />
                  </td>
                  <td className="dim">
                    {o.arm === 'blocked' ? (
                      <span className="neg">{humanRule(o.blockedBy[0]?.split(':')[0] ?? '')}</span>
                    ) : (
                      humanIntervention(o.intervention)
                    )}
                  </td>
                  <td className="num">{money(o.amountPaise)}</td>
                  <td className="num">{o.spendPaise > 0 ? money(o.spendPaise) : <span className="dim">—</span>}</td>
                  <td className={o.recovered ? 'sig' : 'dim'}>{o.recovered ? 'recovered' : 'lost'}</td>
                  <td className="mono dim" style={{ fontSize: 11 }}>
                    {o.idempotencyKey ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {d.outcomes.length > 300 ? (
        <p className="note">Showing the first 300 of {d.outcomes.length}.</p>
      ) : null}
    </>
  );
}
