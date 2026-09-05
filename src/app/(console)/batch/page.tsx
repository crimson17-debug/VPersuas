import { fileLedger } from '../../../store/ledger.js';
import { Empty, Stat, SplitBar, Callout } from '../../../ui/components.js';
import { money, pct, pp, ts } from '../../../ui/format.js';
import { BatchView, type DecisionRow } from './batch-view.js';

export const dynamic = 'force-dynamic';

export default function BatchPage() {
  const portfolio = fileLedger.readPortfolio();

  if (!portfolio) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Screen 1</div>
          <h1>Batch run</h1>
        </div>
        <Empty>
          No run data yet. Generate it with <code>npm run seed</code>, then reload.
        </Empty>
      </>
    );
  }

  const { runs, pooled } = portfolio;
  const rows: DecisionRow[] = runs.flatMap((run) =>
    run.decisions.map((d) => ({
      id: d.id,
      runId: run.runId,
      nowTs: run.nowTs,
      kind: d.kind,
      intervention: d.intervention,
      cohortLabel: d.cohortLabel,
      cause: d.cause,
      causeWeight: d.causeWeight,
      insufficientReason: d.insufficientReason,
      reason: d.reason,
      itemCount: d.itemCount,
      treatedN: d.treatedN,
      holdoutN: d.holdoutN,
      blockedN: d.blockedN,
      exposedPaise: d.exposedPaise,
      grossRecoveredPaise: d.grossRecoveredPaise,
      incrementalPaise: d.incrementalPaise,
      spendPaise: d.spendPaise,
      netPaise: d.netPaise,
      lift: d.lift,
    })),
  );

  const itemsConsidered = runs.reduce((s, r) => s + r.itemsConsidered, 0);
  const blocked = runs.reduce((s, r) => s + r.totals.itemsBlocked, 0);
  const windowFrom = Math.min(...runs.map((r) => r.fromTs));
  const windowTo = Math.max(...runs.map((r) => r.toTs));
  const refusals = rows.filter((r) => r.kind === 'DO_NOT_ACT' || r.kind === 'BLOCKED').length;

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Screen 1 · the working queue</div>
        <h1>Batch run</h1>
        <p className="page-sub">
          {runs.length} analysis windows between {ts(windowFrom, false)} and{' '}
          {ts(windowTo, false)}, {itemsConsidered.toLocaleString('en-IN')} at-risk payments,{' '}
          {rows.length} decisions. {refusals} of them were decisions not to act.
        </p>
      </div>

      <div className="stats stats-5" style={{ marginBottom: 18 }}>
        <Stat
          label="Gross recovered"
          value={money(pooled.grossRecoveredPaise)}
          tone="pha"
          sub="what a dashboard with no holdout would claim"
        />
        <Stat
          label="Incremental"
          value={money(pooled.incrementalPaise)}
          tone="sig"
          sub={`95% CI ${money(pooled.incrementalLowPaise)} – ${money(pooled.incrementalHighPaise)}`}
        />
        <Stat label="Spend" value={money(pooled.spendPaise)} sub={`${pooled.treatedN} items acted on`} />
        <Stat
          label="Net value"
          value={money(pooled.netPaise)}
          tone={pooled.netPaise >= 0 ? 'sig' : 'neg'}
          sub="incremental minus spend"
        />
        <Stat
          label="Stopped by rule"
          value={blocked}
          sub="compliance vetoed after economics approved"
        />
      </div>

      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 10 }}>
          Where the gross figure actually goes
        </div>
        <SplitBar grossPaise={pooled.grossRecoveredPaise} incrementalPaise={pooled.incrementalPaise} />
        <p className="note" style={{ marginTop: 12, marginBottom: 0 }}>
          {pct(pooled.phantomShare)} of the gross figure recovered without any help from the
          engine. Treated items recovered at {pct(pooled.treatedRate)} against{' '}
          {pct(pooled.holdoutRate)} in the randomly held-out arm — a measured lift of{' '}
          <b className={pooled.significant ? 'sig' : 'pha'}>{pp(pooled.liftPp)}</b> across{' '}
          {pooled.treatedN} treated and {pooled.holdoutN} held-out payments.
        </p>
      </div>

      {refusals > 0 ? (
        <Callout tone="good" title="The queue includes refusals">
          <p style={{ marginBottom: 0 }}>
            Four of the five decision types are not &ldquo;act&rdquo;. Filter to{' '}
            <b>DO NOT ACT</b> below to see the cohorts where a cause was identified and
            intervening still lost money, and to <b>BLOCKED</b> for the ones where the
            economics approved and a contact rule vetoed.
          </p>
        </Callout>
      ) : null}

      <h2>Decisions</h2>
      <BatchView rows={rows} />
    </>
  );
}
