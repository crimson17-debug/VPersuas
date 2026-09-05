import { fileLedger } from '../../../store/ledger.js';
import { Callout, Empty, LiftInterval, Panel, SplitBar, Stat } from '../../../ui/components.js';
import { humanIntervention, money, pct, pp, ppRange } from '../../../ui/format.js';

export const dynamic = 'force-dynamic';

export default function IncrementalityPage() {
  const portfolio = fileLedger.readPortfolio();
  if (!portfolio) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Screen 3</div>
          <h1>Incrementality</h1>
        </div>
        <Empty>
          No run data yet. Generate it with <code>npm run seed</code>, then reload.
        </Empty>
      </>
    );
  }

  const p = portfolio.pooled;
  const naturalPaise = Math.max(0, p.grossRecoveredPaise - p.incrementalPaise);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Screen 3 · the measurement</div>
        <h1>Incrementality</h1>
        <p className="page-sub">
          Every cohort the engine acts on has a randomly assigned holdout that receives
          nothing. The gap between the two arms is the only number in this product that is a
          measurement rather than an assertion.
        </p>
      </div>

      <div className="stats stats-4" style={{ marginBottom: 18 }}>
        <Stat
          label="Treated arm"
          value={pct(p.treatedRate)}
          sub={`${p.treatedRecovered} of ${p.treatedN} recovered`}
        />
        <Stat
          label="Holdout arm"
          value={pct(p.holdoutRate)}
          tone="pha"
          sub={`${p.holdoutRecovered} of ${p.holdoutN} recovered with nothing done`}
        />
        <Stat
          label="Measured lift"
          value={pp(p.liftPp)}
          tone={p.significant ? 'sig' : 'pha'}
          sub={`95% CI ${ppRange(p.liftLow, p.liftHigh)}`}
        />
        <Stat
          label="Net value created"
          value={money(p.netPaise)}
          tone={p.netPaise >= 0 ? 'sig' : 'neg'}
          sub={`${money(p.incrementalPaise)} incremental less ${money(p.spendPaise)} spend`}
        />
      </div>

      <Panel title="Lift with its confidence interval">
        <LiftInterval lift={p.liftPp} low={p.liftLow} high={p.liftHigh} significant={p.significant} />
      </Panel>

      <h2>Gross versus what was actually caused</h2>
      <Panel>
        <SplitBar grossPaise={p.grossRecoveredPaise} incrementalPaise={p.incrementalPaise} />
        <div className="kv" style={{ marginTop: 16 }}>
          <dt>Gross recovered</dt>
          <dd>
            <b className="pha">{money(p.grossRecoveredPaise)}</b> — the figure a recovery
            product with no holdout reports
          </dd>
          <dt>Would have recovered anyway</dt>
          <dd>
            <b className="pha">{money(naturalPaise)}</b> — inferred from the holdout arm&rsquo;s
            recovery rate of {pct(p.holdoutRate)}
          </dd>
          <dt>Incremental</dt>
          <dd>
            <b className="sig">{money(p.incrementalPaise)}</b> (95% CI{' '}
            {money(p.incrementalLowPaise)} – {money(p.incrementalHighPaise)})
          </dd>
          <dt>Spend</dt>
          <dd>{money(p.spendPaise)}</dd>
          <dt>Net</dt>
          <dd>
            <b className={p.netPaise >= 0 ? 'sig' : 'neg'}>{money(p.netPaise)}</b>
          </dd>
        </div>
      </Panel>

      <Callout tone="warn" title={`${pct(p.phantomShare)} of the gross figure was never caused`}>
        <p style={{ marginBottom: 0 }}>
          This is not a criticism of the engine — it is a property of payment recovery.
          Failed payments recover on their own at a high rate, so any system that intervenes
          and then counts everything that came back is claiming credit for most of it. The
          only defence is a holdout, and the only honest headline is the smaller number.
        </p>
      </Callout>

      <h2>Lift by intervention</h2>
      <p className="note">
        Each intervention is measured against the same pooled holdout. A held-out payment
        received nothing regardless of what the treated arm beside it got, so every holdout
        observation informs every intervention&rsquo;s counterfactual — splitting the control
        group per intervention would throw most of it away.
      </p>
      <Panel tight title="Measured separately, ranked by net value">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Intervention</th>
                <th className="num">Treated</th>
                <th className="num">Recovered</th>
                <th className="num">Lift</th>
                <th className="num">95% CI</th>
                <th className="num">Spend</th>
                <th className="num">Incremental</th>
                <th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.byIntervention.map((b) => (
                <tr key={b.intervention}>
                  <td style={{ fontWeight: 550 }}>{humanIntervention(b.intervention)}</td>
                  <td className="num">{b.treatedN}</td>
                  <td className="num">{pct(b.treatedN > 0 ? b.treatedRecovered / b.treatedN : 0)}</td>
                  <td className={`num ${b.significant ? 'sig' : 'pha'}`}>{pp(b.liftPp)}</td>
                  <td className="num dim">
                    {ppRange(b.liftLow, b.liftHigh)}
                    {b.significant ? '' : ' ·spans 0'}
                  </td>
                  <td className="num">{money(b.spendPaise)}</td>
                  <td className="num">{money(b.incrementalPaise)}</td>
                  <td className={`num ${b.netPaise > 0 ? 'sig' : 'neg'}`}>{money(b.netPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <h2>How this is computed</h2>
      <Panel>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          <li style={{ marginBottom: 8 }}>
            When the policy decides to act on a cohort, each item is assigned to the holdout
            with probability 0.2. Assignment is a deterministic hash of{' '}
            <span className="mono">(run seed, item id)</span>, so an auditor can recompute
            which arm any customer landed in from the ledger alone.
          </li>
          <li style={{ marginBottom: 8 }}>
            Held-out and compliance-blocked items are pooled into the control arm. Both
            received nothing, which is exactly the observation the natural rate needs.
          </li>
          <li style={{ marginBottom: 8 }}>
            Arms are pooled across the whole portfolio before the lift is computed, not
            summed from per-window estimates. One window holds out twenty or thirty items, so
            a lift measured inside one window is mostly noise; adding up two dozen noisy
            estimates gives a total whose standard error swamps the effect.
          </li>
          <li style={{ marginBottom: 8 }}>
            Incremental value is the lift multiplied by the treated count and the average
            treated order value. The interval on the value comes straight from the interval
            on the lift.
          </li>
          <li>
            Measured outcomes are written back to the prior store, which is what the policy
            reads when scoring the next decision.
          </li>
        </ol>
      </Panel>

      <Callout tone="bad" title="The holdout has an ethical cost">
        <p style={{ marginBottom: 0 }}>
          A random {pct(0.2, 0)} of affected customers deliberately receive no recovery
          attempt. In production that needs a volume cap, a written justification, and an
          exemption path for high-value or vulnerable accounts. It should not ship silently,
          and it is not free — it is paid for by the fact that without it every number on
          this screen would be a guess.
        </p>
      </Callout>
    </>
  );
}
