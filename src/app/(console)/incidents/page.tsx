import Link from 'next/link';

import { fileLedger } from '../../../store/ledger.js';
import { Chip, Empty } from '../../../ui/components.js';
import { humanCause, money, pct, pp, ts } from '../../../ui/format.js';

export const dynamic = 'force-dynamic';

export default function IncidentsPage() {
  const portfolio = fileLedger.readPortfolio();
  if (!portfolio) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Screen 2</div>
          <h1>Incidents</h1>
        </div>
        <Empty>
          No run data yet. Generate it with <code>npm run seed</code>, then reload.
        </Empty>
      </>
    );
  }

  const incidents = portfolio.runs.flatMap((run) =>
    run.decisions.map((d) => ({ run, d })),
  );

  const detected = incidents.length;
  const withCause = incidents.filter((i) => i.d.cause !== null).length;
  const cohortsTested = portfolio.runs.reduce((s, r) => s + r.cohortsTested, 0);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Screen 2 · what changed and why</div>
        <h1>Incidents</h1>
        <p className="page-sub">
          {cohortsTested.toLocaleString('en-IN')} cohort comparisons across{' '}
          {portfolio.runs.length} windows produced {detected} detections, {withCause} of
          which the engine was willing to attribute to a cause. Every threshold is
          corrected for the number of tests actually run.
        </p>
      </div>

      <div className="panel panel-tight">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Cohort</th>
                <th>Onset</th>
                <th className="num">Success rate</th>
                <th className="num">Sample</th>
                <th>Diagnosis</th>
                <th className="num">At stake</th>
                <th>Decision</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {incidents.map(({ run, d }) => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 550 }}>{d.cohortLabel}</td>
                  <td className="mono dim">{ts(d.onsetTs)}</td>
                  <td className="num">
                    <span className="dim">{pct(d.preRate)}</span> →{' '}
                    <span className="neg">{pct(d.postRate)}</span>
                    <div className="neg" style={{ fontSize: 11 }}>
                      {pp(d.postRate - d.preRate)}
                    </div>
                  </td>
                  <td className="num dim">
                    {d.preN} / {d.postN}
                    <div style={{ fontSize: 11 }}>pre / post</div>
                  </td>
                  <td style={{ maxWidth: 240 }}>
                    {d.cause ? (
                      <>
                        <div>{humanCause(d.cause)}</div>
                        <div className="mono dim">
                          {Math.round((d.causeWeight ?? 0) * 100)}% evidence weight
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="pha">Insufficient evidence</span>
                        <div className="mono dim" style={{ fontSize: 11 }}>
                          hypotheses not separable
                        </div>
                      </>
                    )}
                  </td>
                  <td className="num">{money(d.exposedPaise)}</td>
                  <td>
                    <Chip kind={d.kind} />
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
      </div>

      <p className="note">
        Detections are pruned so a cohort and a refinement of it are never reported as two
        incidents — that would double-count the same money and hand the policy two
        decisions about the same customers.
      </p>
    </>
  );
}
