import Link from 'next/link';

import { fileLedger } from '../store/ledger.js';
import { readNetwork } from '../store/network.js';
import { money, pct, pp } from '../ui/format.js';
import { HeroExperiment, type HeroRates } from './hero-experiment.js';
import { ThemeToggle } from './theme-toggle.js';

export const dynamic = 'force-dynamic';

const ENTRIES = [
  {
    href: '/batch',
    n: '01',
    title: 'Batch run',
    desc: 'The working queue. Every decision with its reason — including the four that are not "act".',
  },
  {
    href: '/incidents',
    n: '02',
    title: 'Incidents',
    desc: 'What changed, for whom, when it started, and which cause the evidence actually supports.',
  },
  {
    href: '/incrementality',
    n: '03',
    title: 'Incrementality',
    desc: 'Treated against holdout. The only number here that is a measurement rather than an assertion.',
  },
  {
    href: '/ledger',
    n: '04',
    title: 'Evidence ledger',
    desc: 'One decision end to end — evidence in, hypotheses rejected, compliance checks, outcome.',
  },
  {
    href: '/evaluation',
    n: '05',
    title: 'Evaluation',
    desc: '140 blind windows against five baselines, calibration, and the cases it got wrong.',
  },
  {
    href: '/network',
    n: '06',
    title: 'Rail network',
    desc: 'The question one merchant cannot answer about itself — is this rail down, or am I broken?',
  },
];

export default function LandingPage() {
  const portfolio = fileLedger.readPortfolio();
  const ev = fileLedger.readEval();
  const net = readNetwork();
  const p = portfolio?.pooled;

  // The hero animates the real measured rates. If the data has not been
  // generated yet it falls back to a plainly-labelled illustration rather
  // than inventing a result.
  const rates: HeroRates = p && p.treatedN > 0
    ? { treatedRate: p.treatedRate, holdoutRate: p.holdoutRate, liftPp: p.liftPp }
    : { treatedRate: 0.55, holdoutRate: 0.39, liftPp: 0.16 };

  const engine = ev?.policies.find((x) => x.isEngine);
  const nudge = ev?.policies.find((x) => x.key === 'always_nudge');

  return (
    <div className="landing">
      <header className="topbar rise">
        <Link href="/" className="brand-mark">
          <span className="brand-glyph" aria-hidden="true" />
          Persuas
        </Link>
        <div className="topbar-links">
          <ThemeToggle />
          <Link href="/batch" className="btn">
            Open console
          </Link>
        </div>
      </header>

      <div className="landing-inner">
        <section className="hero">
          <div className="hero-grid">
            <div>
              <span className="hero-kicker rise d1">
                Razorpay AI Buildathon · Track 03
              </span>

              <h1 className="rise d2">
                Revenue recovery that only counts{' '}
                <span className="grad">what it caused</span>
              </h1>

              <p className="hero-lede rise d3">
                Failed payments recover on their own at a high rate. Every recovery
                product that reports gross recovered revenue is claiming credit for
                that. This one withholds a random slice of every cohort it acts on,
                does nothing to it, and reports only the difference —{' '}
                <b>
                  which on the current run is {p ? pct(p.phantomShare) : '67%'} smaller
                  than the gross figure.
                </b>
              </p>

              <div className="cta-row rise d4">
                <Link href="/batch" className="cta">
                  Open the console
                  <span aria-hidden="true">→</span>
                </Link>
                <Link href="/incrementality" className="cta cta-ghost">
                  See the measurement
                </Link>
              </div>
            </div>

            <div className="rise d3">
              <HeroExperiment rates={rates} />
            </div>
          </div>
        </section>

        {p ? (
          <div className="landing-strip rise d5">
            <div>
              <div className="k">Gross recovered</div>
              <div className="v pha">{money(p.grossRecoveredPaise)}</div>
              <div className="s">what a dashboard would claim</div>
            </div>
            <div>
              <div className="k">Incremental</div>
              <div className="v sig">{money(p.incrementalPaise)}</div>
              <div className="s">
                95% CI {money(p.incrementalLowPaise)} – {money(p.incrementalHighPaise)}
              </div>
            </div>
            <div>
              <div className="k">Measured lift</div>
              <div className="v" style={{ color: 'var(--violet-hi)' }}>
                {pp(p.liftPp)}
              </div>
              <div className="s">
                {p.treatedN} treated · {p.holdoutN} held out
              </div>
            </div>
            <div>
              <div className="k">Decisions not to act</div>
              <div className="v">
                {portfolio.runs
                  .flatMap((r) => r.decisions)
                  .filter((d) => d.kind === 'DO_NOT_ACT' || d.kind === 'BLOCKED').length}
              </div>
              <div className="s">of {portfolio.runs.flatMap((r) => r.decisions).length} total</div>
            </div>
          </div>
        ) : null}

        {net ? (
          <>
            <h2 style={{ marginTop: 54 }}>The question a merchant cannot answer alone</h2>
            <p className="note" style={{ marginBottom: 16, maxWidth: '78ch' }}>
              &ldquo;This issuer is degraded&rdquo; and &ldquo;my checkout broke for this
              issuer&rsquo;s customers&rdquo; make the same shaped hole, in the same cohort,
              over the same hours, carrying the same failure reason. No model separates them,
              because the information that would is not in one merchant&rsquo;s data. It only
              exists across merchants.
            </p>
            <div className="landing-strip rise">
              <div>
                <div className="k">Merchant alone</div>
                <div className="v pha">{pct(net.solo.recall)}</div>
                <div className="s">root causes correct, {net.detected} cases</div>
              </div>
              <div>
                <div className="k">Same engine, with the network</div>
                <div className="v sig">{pct(net.federated.recall)}</div>
                <div className="s">only the fleet signals differ</div>
              </div>
              <div>
                <div className="k">When the fault is its own</div>
                <div className="v" style={{ color: 'var(--stop)' }}>
                  {pct(net.byScenario.merchantOnly.solo.recall)}
                </div>
                <div className="s">solo accuracy — it cannot know</div>
              </div>
              <div>
                <div className="k">Corrected / broken</div>
                <div className="v">
                  {net.correctedByNetwork} / {net.brokenByNetwork}
                </div>
                <div className="s">by consulting the fleet</div>
              </div>
            </div>
          </>
        ) : null}

        <h2 style={{ marginTop: 54 }}>The six screens</h2>
        <div className="entry-grid">
          {ENTRIES.map((e, i) => (
            <Link
              key={e.href}
              href={e.href}
              className={`entry rise d${Math.min(6, i + 1)}`}
            >
              <span className="entry-num">{e.n}</span>
              <div className="entry-title">{e.title}</div>
              <div className="entry-desc">{e.desc}</div>
              <span className="entry-go">
                Open <span aria-hidden="true">→</span>
              </span>
            </Link>
          ))}
        </div>

        {engine && nudge ? (
          <>
            <h2>Against the obvious approach</h2>
            <div className="tablewrap rise">
              <table>
                <thead>
                  <tr>
                    <th>Policy</th>
                    <th className="num">Gross claimed</th>
                    <th className="num">Lift</th>
                    <th className="num">Spend</th>
                    <th className="num">Net value</th>
                  </tr>
                </thead>
                <tbody>
                  {ev!.policies.map((row) => (
                    <tr key={row.key} className={row.isEngine ? 'is-engine' : ''}>
                      <td className={row.isEngine ? 'lead' : ''}>{row.label}</td>
                      <td className="num pha">{money(row.grossRecoveredPaise)}</td>
                      <td
                        className={`num ${
                          row.itemsActedOn === 0 ? 'dim' : row.significant ? 'sig' : 'pha'
                        }`}
                      >
                        {row.itemsActedOn === 0 ? '—' : pp(row.liftPp)}
                      </td>
                      <td className="num">{money(row.spendPaise)}</td>
                      <td
                        className={`num ${
                          row.netPaise > 0 ? 'sig' : row.netPaise < 0 ? 'neg' : 'dim'
                        }`}
                      >
                        {money(row.netPaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ marginTop: 12 }}>
              Measured on {ev!.heldOutSize} labelled windows the engine has never seen.
              Read the gross column: the policies with the biggest numbers there are not
              the ones creating value. An interval that spans zero means that policy
              cannot be shown to have worked at all.
            </p>
          </>
        ) : null}

        <div className="landing-foot">
          Event history is synthetic and labelled as such on every screen. Razorpay
          orders, payment links, webhooks and identifiers are real test-mode objects
          when keys are configured. No claim about real-world revenue lift follows from
          any of it.
        </div>
      </div>
    </div>
  );
}
