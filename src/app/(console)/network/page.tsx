import Link from 'next/link';

import { readNetwork, type RailRow, type TwinCase } from '../../../store/network.js';
import { Callout, Empty, Panel, Stat } from '../../../ui/components.js';
import { humanCause, pct, pp } from '../../../ui/format.js';

export const dynamic = 'force-dynamic';

const RAIL_LABEL: Record<string, string> = {
  bank_hdfc: 'HDFC', bank_sbi: 'SBI', bank_icici: 'ICICI',
  bank_axis: 'Axis', bank_kotak: 'Kotak',
  wallet_paytm: 'Paytm', wallet_phonepe: 'PhonePe',
};

const METHOD_LABEL: Record<string, string> = {
  upi: 'UPI', card: 'Card', netbanking: 'Netbanking', wallet: 'Wallet',
};

const VERDICT_LABEL: Record<RailRow['verdict'], string> = {
  issuer_confirmed: 'Rail degraded',
  merchant_specific: 'Rail healthy',
  no_signal: 'No call',
  below_k_anonymity: 'Withheld',
};

function railName(r: { method: string; issuer: string }): string {
  return `${METHOD_LABEL[r.method] ?? r.method} · ${RAIL_LABEL[r.issuer] ?? r.issuer}`;
}

function Verdict({ v }: { v: RailRow['verdict'] }) {
  const tone =
    v === 'issuer_confirmed' ? 'chip-stop'
    : v === 'merchant_specific' ? 'chip-sig'
    : 'chip-dim';
  return <span className={`chip ${tone}`}>{VERDICT_LABEL[v]}</span>;
}

function TwinPanel({ twin }: { twin: TwinCase }) {
  const isWide = twin.key === 'issuerWide';
  const f = twin.finding;

  return (
    <Panel
      title={isWide ? 'World A — the issuer really is degraded' : 'World B — only this merchant is broken'}
    >
      <p className="note" style={{ marginTop: -4, marginBottom: 12 }}>
        {twin.merchantsAffected} of {twin.fleetSize} merchants affected · ground truth:{' '}
        {twin.truth ? humanCause(twin.truth) : '—'}
      </p>
      <div className="net-arms">
        <div className={`net-arm ${twin.solo.correct ? '' : 'is-wrong'}`}>
          <div className="net-arm-k">Merchant alone</div>
          <div className="net-arm-v">
            {twin.solo.abstained ? 'Insufficient evidence' : humanCause(twin.solo.called!)}
          </div>
          <div className={`net-arm-tag ${twin.solo.correct ? 'ok' : 'bad'}`}>
            {twin.solo.correct ? 'correct' : 'wrong'}
          </div>
        </div>

        <div className="net-arrow" aria-hidden="true">→</div>

        <div className={`net-arm ${twin.federated.correct ? '' : 'is-wrong'}`}>
          <div className="net-arm-k">With the network</div>
          <div className="net-arm-v">
            {twin.federated.abstained ? 'Insufficient evidence' : humanCause(twin.federated.called!)}
          </div>
          <div className={`net-arm-tag ${twin.federated.correct ? 'ok' : 'bad'}`}>
            {twin.federated.correct ? 'correct' : 'wrong'}
          </div>
        </div>
      </div>

      {f ? (
        <>
          <div className="net-evidence">
            <div>
              <span className="k">Rail</span>
              <span className="v">{railName(f)}</span>
            </div>
            <div>
              <span className="k">Independently degraded</span>
              <span className="v mono">
                {f.degradedCount} of {f.contributors}
              </span>
            </div>
            <div>
              <span className="k">Stouffer Z</span>
              <span className="v mono">{f.combinedZ.toFixed(1)}</span>
            </div>
            <div>
              <span className="k">Pooled effect</span>
              <span className="v mono">{pp(f.pooledDiff)}</span>
            </div>
            <div>
              <span className="k">I² (disagreement)</span>
              <span className="v mono">{Math.round(f.iSquared * 100)}%</span>
            </div>
            <div>
              <span className="k">Onset spread (IQR)</span>
              <span className="v mono">
                {f.onsetSpreadMinutes === null ? '—' : `${Math.round(f.onsetSpreadMinutes)} min`}
              </span>
            </div>
          </div>
          <div className="net-ruling">
            <Verdict v={f.verdict} />
            {f.confidence > 0 ? (
              <span className="mono dim">{pct(f.confidence)} confidence</span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="note">
          The network made no call on this merchant&rsquo;s rail — the local evidence
          stands on its own.
        </p>
      )}
    </Panel>
  );
}

export default function NetworkPage() {
  const snap = readNetwork();

  if (!snap) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Screen 6</div>
          <h1>Rail network</h1>
        </div>
        <Empty>
          No federated data yet. Generate it with <code>npm run eval:federated</code>,
          then reload.
        </Empty>
      </>
    );
  }

  const wide = snap.twins.find((t) => t.key === 'issuerWide');
  const only = snap.twins.find((t) => t.key === 'merchantOnly');
  const rails = wide?.rails ?? [];

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Screen 6 · the information a single merchant does not have</div>
        <h1>Rail network</h1>
        <p className="page-sub">
          A merchant cannot tell &ldquo;this issuer is degraded&rdquo; from &ldquo;my
          checkout broke for this issuer&rsquo;s customers.&rdquo; Both make the same
          shaped hole in the same cohort. It is not a modelling problem — the
          distinguishing information is not in one merchant&rsquo;s data at all. It
          exists only across merchants, which is why this layer belongs inside a
          processor rather than beside one.
        </p>
      </div>

      <div className="stats stats-4" style={{ marginBottom: 18 }}>
        <Stat
          label="Merchant alone"
          value={pct(snap.solo.recall)}
          tone="pha"
          sub={`${snap.solo.correct} of ${snap.detected} root causes correct`}
        />
        <Stat
          label="With the network"
          value={pct(snap.federated.recall)}
          tone="sig"
          sub={`${snap.federated.correct} of ${snap.detected} root causes correct`}
        />
        <Stat
          label="Corrected by the network"
          value={String(snap.correctedByNetwork)}
          sub={`across ${snap.pairs} seeded twin pairs`}
        />
        <Stat
          label="Broken by the network"
          value={String(snap.brokenByNetwork)}
          tone={snap.brokenByNetwork > 0 ? 'neg' : undefined}
          sub="cases the network turned from right to wrong"
        />
      </div>

      <Callout title="Same engine, same merchant, same events">
        Both arms are the same engine, the same merchant and the same events. The only
        variable is whether anonymous fleet signals are consulted, which is what makes
        the difference attributable to federation rather than to two different systems.
        {' '}
        <b>
          Alone, the engine is right {pct(snap.byScenario.issuerWide.solo.recall)} of the
          time when the rail really is down, and{' '}
          {pct(snap.byScenario.merchantOnly.solo.recall)} of the time when the fault is
          its own.
        </b>{' '}
        It is not guessing badly — it has no way to know which world it is in.
      </Callout>

      <h2>The same incident, in two worlds</h2>
      <p className="note" style={{ marginBottom: 14 }}>
        Same rail, same window, same severity, same duration, same failure reason. Inside
        the focus merchant these two are indistinguishable, which is the point.
      </p>

      {wide ? <TwinPanel twin={wide} /> : null}
      {only ? <TwinPanel twin={only} /> : null}

      <h2>What the network saw that window</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Rail</th>
              <th>Ruling</th>
              <th className="num">Degraded</th>
              <th className="num">Contributors</th>
              <th className="num">Stouffer Z</th>
              <th className="num">Pooled</th>
              <th className="num">I²</th>
            </tr>
          </thead>
          <tbody>
            {rails.map((r) => (
              <tr key={`${r.method}:${r.issuer}`}>
                <td className="lead">{railName(r)}</td>
                <td><Verdict v={r.verdict} /></td>
                <td className="num mono">{r.degradedCount}</td>
                <td className="num mono">{r.contributors}</td>
                <td className={`num mono ${r.combinedZ < -2.58 ? 'neg' : 'dim'}`}>
                  {r.combinedZ.toFixed(1)}
                </td>
                <td className="num mono">{pp(r.pooledDiff)}</td>
                <td className="num mono dim">{Math.round(r.iSquared * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {wide && wide.withheld > 0 ? (
        <p className="note" style={{ marginTop: 10 }}>
          {wide.withheld} further {wide.withheld === 1 ? 'rail was' : 'rails were'} withheld
          entirely for having fewer than {wide.kAnonymity} independent contributors. The
          k-anonymity gate runs before any statistic is computed, so a below-floor rail
          never produces a number at all — not even internally.
        </p>
      ) : null}

      <h2>What crosses the boundary</h2>
      <Panel title="The entire contribution — per merchant, per rail, per window">
        <div className="net-wire">
          <div className="net-wire-col">
            <div className="net-wire-h ok">Shared</div>
            <ul>
              <li>payment method</li>
              <li>issuer bucket</li>
              <li>z-statistic</li>
              <li>change in success rate</li>
              <li>sample size</li>
              <li>onset hour</li>
            </ul>
          </div>
          <div className="net-wire-col">
            <div className="net-wire-h bad">Never shared</div>
            <ul>
              <li>merchant identity</li>
              <li>customers or orders</li>
              <li>transaction amounts</li>
              <li>devices or geography</li>
              <li>raw events of any kind</li>
              <li>anything joinable to a person</li>
            </ul>
          </div>
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          What is shared is the result of a test, not the data the test ran on — enough to
          combine tests across merchants, not enough to reconstruct any merchant&rsquo;s
          traffic. The contributor id is a rotating per-window pseudonym that exists only
          to count distinct parties and reject double-submission; it means nothing across
          windows. Read it in{' '}
          <code>src/engine/network/contribute.ts</code> — the whole payload is one screen
          of code.
        </p>
      </Panel>

      <Callout tone="warn" title="What this does not establish">
        The fleet is synthetic, and real merchants are
        not independent draws — they share seasonality, campaigns and customers, and
        correlated traffic weakens the independence Stouffer&rsquo;s method assumes. Every
        contributor here also runs an identical detector; a real network would have version
        skew. And k-anonymity is a structural guarantee about what gets published, not a
        formal differential-privacy budget: repeated queries across many windows still leak
        slowly, and a production version would need calibrated noise and a tracked budget.
        The full numbers, including the regressions, are in{' '}
        <Link href="/evaluation">the evaluation</Link> and{' '}
        <code>EVAL_FEDERATED.md</code>.
      </Callout>
    </>
  );
}
