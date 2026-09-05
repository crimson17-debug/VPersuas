import { fileLedger } from '../../../store/ledger.js';
import { Callout, Empty, Panel, Stat } from '../../../ui/components.js';
import { humanCause, money, pct, pp } from '../../../ui/format.js';

export const dynamic = 'force-dynamic';

export default function EvaluationPage() {
  const ev = fileLedger.readEval();
  if (!ev) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Screen 5</div>
          <h1>Evaluation</h1>
        </div>
        <Empty>
          No evaluation data yet. Run <code>npm run eval</code> — it takes about twenty
          seconds — then reload.
        </Empty>
      </>
    );
  }

  const engine = ev.policies.find((p) => p.isEngine);
  const nudge = ev.policies.find((p) => p.key === 'always_nudge');
  const discount = ev.policies.find((p) => p.key === 'always_discount');
  const nullFp = ev.detection.falsePositivesOnNulls;

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Screen 5 · the numbers, including the bad ones</div>
        <h1>Evaluation</h1>
        <p className="page-sub">
          {ev.heldOutSize} labelled windows the engine has never seen, from a corpus of{' '}
          {ev.corpusSize}. Priors were earned on a separate {ev.warmupSize}-window warm-up
          starting from nothing. Every stochastic step is seeded, so these numbers reproduce
          exactly on any machine.
        </p>
      </div>

      {engine && nudge ? (
        <div className="stats stats-4" style={{ marginBottom: 18 }}>
          <Stat
            label="Net value, engine"
            value={money(engine.netPaise)}
            tone="sig"
            sub={`vs ${money(nudge.netPaise)} for nudge-everything`}
          />
          <Stat
            label="False positives on nulls"
            value={`${nullFp} / ${ev.detection.nullWindows}`}
            tone={nullFp === 0 ? 'sig' : 'neg'}
            sub="windows where nothing was wrong"
          />
          <Stat
            label="Root cause top-1"
            value={pct(ev.rootCause.considered ? ev.rootCause.top1 / ev.rootCause.considered : 0)}
            sub={`${ev.rootCause.top1} of ${ev.rootCause.considered} detected windows`}
          />
          <Stat
            label="Calibration error"
            value={pct(ev.calibration.ece)}
            sub={`Brier ${ev.calibration.brier.toFixed(3)} over ${ev.calibration.n} calls`}
          />
        </div>
      ) : null}

      <h2>Against baselines</h2>
      <p className="note">
        Every baseline runs the identical execution, holdout, cost and measurement path, and
        sees <b>all</b> at-risk items rather than only the ones this detector flagged.
        Handicapping a baseline with your own detector and then beating it proves nothing.
      </p>
      <Panel tight title="140 held-out windows">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Policy</th>
                <th className="num">Gross claimed</th>
                <th className="num">Lift</th>
                <th className="num">Incremental (95% CI)</th>
                <th className="num">Spend</th>
                <th className="num">Net</th>
                <th className="num">Items touched</th>
              </tr>
            </thead>
            <tbody>
              {ev.policies.map((p) => (
                <tr key={p.key} className={p.isEngine ? 'is-engine' : ''}>
                  <td>{p.label}</td>
                  <td className="num pha">{money(p.grossRecoveredPaise)}</td>
                  <td className={`num ${p.itemsActedOn === 0 ? 'dim' : p.significant ? 'sig' : 'pha'}`}>
                    {p.itemsActedOn === 0 ? '—' : pp(p.liftPp)}
                  </td>
                  <td className="num dim">
                    {p.itemsActedOn === 0
                      ? '—'
                      : `${money(p.incrementalPaise)} (${money(p.incrementalLowPaise)} – ${money(p.incrementalHighPaise)})`}
                  </td>
                  <td className="num">{money(p.spendPaise)}</td>
                  <td className={`num ${p.netPaise > 0 ? 'sig' : p.netPaise < 0 ? 'neg' : 'dim'}`}>
                    {money(p.netPaise)}
                  </td>
                  <td className="num">{p.itemsActedOn.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Callout tone="warn" title="Read the gross column">
        <p>
          {discount ? (
            <>
              Discount-everything posts {money(discount.grossRecoveredPaise)} of gross recovery
              — the second-highest figure in the table — and nets{' '}
              <b className={discount.netPaise < 0 ? 'neg' : ''}>{money(discount.netPaise)}</b>,
              because the discount is paid on every recovery including the ones that needed
              no help.{' '}
            </>
          ) : null}
          An interval that spans zero is not a rounding artefact: it means that policy cannot
          be shown to have worked at this sample size, and reporting it as a win would be the
          exact error this project exists to point at.
        </p>
        <p style={{ marginBottom: 0 }}>
          Do-nothing spends nothing and creates nothing measurable. It is the floor every
          other policy has to clear, and on the null windows it is the correct policy — which
          is why the engine matches it there rather than trying to beat it.
        </p>
      </Callout>

      <h2>Detection</h2>
      <div className="stats stats-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Precision"
          value={pct(ev.detection.precision)}
          sub={`${ev.detection.truePositives} true / ${ev.detection.falsePositives} false positives`}
        />
        <Stat
          label="Recall"
          value={pct(ev.detection.recall)}
          sub={`${ev.detection.falseNegatives} incidents missed`}
        />
        <Stat
          label="Fired on a null window"
          value={`${nullFp} of ${ev.detection.nullWindows}`}
          tone={nullFp === 0 ? 'sig' : 'neg'}
          sub="half of which shipped a checkout release anyway"
        />
      </div>

      <Panel tight title="Recall by cause — where the misses are">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>True cause</th>
                <th className="num">Detected</th>
                <th className="num">Windows</th>
                <th className="num">Recall</th>
              </tr>
            </thead>
            <tbody>
              {ev.recallByCause.map((r) => {
                const rate = r.total ? r.detected / r.total : 0;
                return (
                  <tr key={r.cause}>
                    <td>{humanCause(r.cause)}</td>
                    <td className="num">{r.detected}</td>
                    <td className="num dim">{r.total}</td>
                    <td className={`num ${rate < 0.5 ? 'neg' : ''}`}>{pct(rate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <p className="note">
        An aggregate recall number hides blind spots. The misses concentrate in shallow
        declines spread thinly across large cohorts — those do not clear a
        multiple-comparison-corrected threshold, and lowering it to catch them would put
        false positives back on the null windows. That trade is the detector&rsquo;s single
        most consequential setting, and it is deliberately tuned toward silence.
      </p>

      <h2>Root cause</h2>
      <div className="stats stats-4" style={{ marginBottom: 16 }}>
        <Stat label="Detected windows with a true cause" value={ev.rootCause.considered} />
        <Stat label="A call was made on" value={ev.rootCause.diagnosed} sub={`abstained on ${ev.rootCause.abstained}`} />
        <Stat
          label="Top-1"
          value={pct(ev.rootCause.considered ? ev.rootCause.top1 / ev.rootCause.considered : 0)}
        />
        <Stat
          label="Top-3"
          value={pct(ev.rootCause.considered ? ev.rootCause.top3 / ev.rootCause.considered : 0)}
        />
      </div>

      {ev.rootCause.confusion.length > 0 ? (
        <Panel tight title="What it got wrong">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Truth → called</th>
                  <th className="num">Count</th>
                </tr>
              </thead>
              <tbody>
                {ev.rootCause.confusion.map((c) => (
                  <tr key={c.pair}>
                    <td className="mono">{c.pair.replace(/_/g, ' ')}</td>
                    <td className="num neg">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <h2>Abstention</h2>
      <div className="stats stats-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Null windows left alone"
          value={`${ev.abstention.nullWindowsLeftAlone} / ${ev.abstention.nullWindows}`}
          tone={ev.abstention.nullWindowsLeftAlone === ev.abstention.nullWindows ? 'sig' : undefined}
          sub="nothing detected, nothing spent"
        />
        <Stat
          label="Dual-cause windows"
          value={ev.abstention.ambiguousWindows}
          sub="two real causes running at once"
        />
        <Stat
          label="Returned insufficient evidence"
          value={`${ev.abstention.ambiguousAbstained} / ${ev.abstention.ambiguousWindows}`}
          tone="neg"
          sub="lower than it should be — see below"
        />
      </div>
      <Callout tone="bad" title="A weakness, stated plainly">
        <p style={{ marginBottom: 0 }}>
          Dual-cause windows contain an issuer wobble and a checkout regression starting
          within an hour of each other. The correct output is &ldquo;these cannot be
          separated&rdquo;. The engine abstains on only{' '}
          {ev.abstention.ambiguousAbstained} of {ev.abstention.ambiguousWindows} — usually it
          isolates the larger incident cleanly and reports it with confidence. That is
          arguably defensible behaviour, but it is not what the corpus was built to elicit,
          and it means the abstention path is under-demonstrated.
        </p>
      </Callout>

      <h2>Calibration</h2>
      <p className="note">
        A confidence number nobody has scored is decoration. These are the engine&rsquo;s
        stated confidences binned against how often it was actually right.
      </p>
      <Panel tight title={`Brier ${ev.calibration.brier.toFixed(3)} · ECE ${pct(ev.calibration.ece)} · n=${ev.calibration.n}`}>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Stated confidence</th>
                <th className="num">Windows</th>
                <th className="num">Mean stated</th>
                <th className="num">Observed correct</th>
                <th style={{ width: '34%' }}>Stated vs observed</th>
              </tr>
            </thead>
            <tbody>
              {ev.calibration.bins.map((b) => (
                <tr key={b.lower}>
                  <td className="mono">
                    {pct(b.lower, 0)}–{pct(b.upper, 0)}
                  </td>
                  <td className="num">{b.n}</td>
                  <td className="num">{pct(b.meanPredicted)}</td>
                  <td className="num">{pct(b.observed)}</td>
                  <td>
                    <div style={{ display: 'grid', gap: 3 }}>
                      <div className="bar" style={{ height: 9 }}>
                        <div className="bar-seg bar-muted" style={{ width: `${b.meanPredicted * 100}%` }} />
                      </div>
                      <div className="bar" style={{ height: 9 }}>
                        <div className="bar-seg bar-signal" style={{ width: `${b.observed * 100}%` }} />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="bar-legend" style={{ marginBottom: 20 }}>
        <span>
          <i style={{ background: 'var(--surface-3)' }} />
          stated confidence
        </span>
        <span>
          <i style={{ background: 'var(--signal)' }} />
          observed accuracy
        </span>
      </div>

      <h2>Speed</h2>
      <div className="stats stats-3" style={{ marginBottom: 16 }}>
        <Stat label="Median, events to decision" value={`${ev.speed.medianMs.toFixed(0)}ms`} />
        <Stat label="p95" value={`${ev.speed.p95Ms.toFixed(0)}ms`} />
        <Stat label="Full evaluation" value={`${(ev.elapsedMs / 1000).toFixed(1)}s`} sub="200 windows, 6 policies" />
      </div>
      <p className="note">
        Over roughly 4,000–6,000 events and several hundred cohort tests per window. The
        engine holds no connections and touches no database, which is why the whole
        evaluation runs in seconds and can be re-run on every commit.
      </p>

      <h2>What this does not prove</h2>
      <Panel>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li style={{ marginBottom: 6 }}>
            The event history is synthetic. These numbers measure the engine against a
            simulator, not against production traffic, and no claim about real-world revenue
            lift follows from them.
          </li>
          <li style={{ marginBottom: 6 }}>
            Cost and uplift structures are assumptions. They are plausible, and they are
            stated in the open in the repository, but they are assumptions.
          </li>
          <li>
            Difference-in-differences assumes treated and control cohorts would have moved in
            parallel absent the cause. That is checked in the pre-period and it can still be
            wrong.
          </li>
        </ul>
      </Panel>
    </>
  );
}
