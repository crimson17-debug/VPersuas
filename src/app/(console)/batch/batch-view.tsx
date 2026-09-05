'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Chip, Interval, Spark } from '../../../ui/components.js';
import { humanCause, humanIntervention, money, pp, ts } from '../../../ui/format.js';

export interface DecisionRow {
  id: string;
  runId: string;
  nowTs: number;
  kind: string;
  intervention: string;
  cohortLabel: string;
  cause: string | null;
  causeWeight: number | null;
  insufficientReason: string | null;
  reason: string;
  itemCount: number;
  treatedN: number;
  holdoutN: number;
  blockedN: number;
  exposedPaise: number;
  grossRecoveredPaise: number;
  incrementalPaise: number;
  spendPaise: number;
  netPaise: number;
  lift: { diff: number; low: number; high: number; significant: boolean } | null;
}

const KINDS = ['ACT', 'WAIT', 'EXPERIMENT', 'DO_NOT_ACT', 'BLOCKED'] as const;

export function BatchView({ rows }: { rows: DecisionRow[] }) {
  const [filter, setFilter] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) c.set(r.kind, (c.get(r.kind) ?? 0) + 1);
    return c;
  }, [rows]);

  const shown = filter ? rows.filter((r) => r.kind === filter) : rows;

  return (
    <>
      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={`btn${filter === null ? ' btn-primary' : ''}`}
          onClick={() => setFilter(null)}
        >
          All {rows.length}
        </button>
        {KINDS.map((k) => {
          const n = counts.get(k) ?? 0;
          return (
            <button
              key={k}
              type="button"
              className={`btn${filter === k ? ' btn-primary' : ''}`}
              onClick={() => setFilter(filter === k ? null : k)}
              disabled={n === 0}
            >
              {k.replace(/_/g, ' ')} {n}
            </button>
          );
        })}
      </div>

      <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Decision</th>
                <th>Cohort</th>
                <th>Diagnosis</th>
                <th className="num">Treated / held out</th>
                <th>Measured lift</th>
                <th className="num">Incremental of gross</th>
                <th className="num">Spend</th>
                <th className="num">Net</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Chip kind={r.kind} />
                    <div className="mono tiny dim" style={{ marginTop: 5 }}>
                      {ts(r.nowTs, false)}
                    </div>
                  </td>
                  <td className="lead">
                    <div>{r.cohortLabel}</div>
                    <div className="mono tiny dim">{money(r.exposedPaise)} at stake</div>
                  </td>
                  <td style={{ minWidth: 190 }}>
                    {r.cause ? (
                      <>
                        <div>{humanCause(r.cause)}</div>
                        <div className="mono tiny dim">
                          {Math.round((r.causeWeight ?? 0) * 100)}% of evidence weight
                        </div>
                      </>
                    ) : (
                      <span className="pha">Insufficient evidence</span>
                    )}
                    {r.kind !== 'DO_NOT_ACT' && r.intervention !== 'none' ? (
                      <div className="mono tiny sig" style={{ marginTop: 4 }}>
                        → {humanIntervention(r.intervention)}
                      </div>
                    ) : null}
                  </td>
                  <td className="num">
                    {r.treatedN} / {r.holdoutN}
                    <div className="mono tiny dim">of {r.itemCount}</div>
                    {r.blockedN > 0 ? (
                      <div className="mono tiny neg">{r.blockedN} blocked</div>
                    ) : null}
                  </td>
                  <td>
                    {/*
                      The interval glyph, not a number. A bracket crossing
                      the zero tick is legible as "this cannot be shown to
                      have worked" before any digit is read, which is the
                      thing a reader most needs to notice in this column.

                      Below ten treated items even the interval is noise
                      wearing a number's clothes — a refusal's small learning
                      slice can read as a 35-point swing — so the count is
                      shown instead.
                    */}
                    {r.lift && r.treatedN >= 10 ? (
                      <>
                        <Interval
                          point={r.lift.diff}
                          low={r.lift.low}
                          high={r.lift.high}
                          significant={r.lift.significant}
                          mini
                        />
                        <div className={`mono tiny ${r.lift.significant ? 'sig' : 'pha'}`}>
                          {pp(r.lift.diff)}
                          {r.lift.significant ? '' : ' · spans zero'}
                        </div>
                      </>
                    ) : r.treatedN > 0 ? (
                      <span className="dim mono tiny">n={r.treatedN}, too few</span>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td className="num">
                    {r.grossRecoveredPaise > 0 ? (
                      <>
                        <Spark
                          grossPaise={r.grossRecoveredPaise}
                          incrementalPaise={r.incrementalPaise}
                        />
                        <div className="mono tiny dim">
                          {money(r.incrementalPaise)} of {money(r.grossRecoveredPaise)}
                        </div>
                      </>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td className="num">{r.spendPaise > 0 ? money(r.spendPaise) : <span className="dim">—</span>}</td>
                  <td className={`num ${r.netPaise > 0 ? 'sig' : r.netPaise < 0 ? 'neg' : 'dim'}`}>
                    {r.treatedN > 0 ? money(r.netPaise) : '—'}
                  </td>
                  <td className="num">
                    <Link href={`/incidents/${r.id}`} className="btn">
                      Evidence
                    </Link>
                  </td>
                </tr>
              ))}
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={9} className="dim" style={{ padding: 26, textAlign: 'center' }}>
                    No decisions of this kind in the current history.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
      </div>

      {filter === 'DO_NOT_ACT' && shown.length > 0 ? (
        <div className="callout warn">
          <div className="callout-title">Why these matter</div>
          <p style={{ marginBottom: 0 }}>
            Each of these is a cohort where a cause was identified and no intervention
            cleared zero net value. A recovery product that always acts would have spent
            money on every one of them. The reasoning behind each refusal is on its
            evidence page.
          </p>
        </div>
      ) : null}
    </>
  );
}
