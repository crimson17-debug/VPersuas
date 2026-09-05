import type { ReactNode } from 'react';

import { money, pp, ppRange } from './format.js';

export function Chip({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={`chip chip-${kind}`}>{children ?? kind.replace(/_/g, ' ')}</span>;
}

/* ------------------------------------------------------------------ */
/* Readout strip                                                       */
/* ------------------------------------------------------------------ */

export function Readout({ cols, children }: { cols: 3 | 4 | 5; children: ReactNode }) {
  return <div className={`stats stats-${cols}`}>{children}</div>;
}

export function Stat({
  label, value, sub, tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'sig' | 'pha' | 'neg';
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` ${tone}` : ''}`}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

export function Section({
  title, note, children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {note ? <span className="section-note">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Panel({
  title, children, tight,
}: {
  title?: string;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <div className={`panel${tight ? ' panel-tight' : ''}`}>
      {title ? <div className="panel-label">{title}</div> : null}
      {children}
    </div>
  );
}

/**
 * A claim, as opposed to a figure.
 *
 * Set in serif and hung off a coloured rule rather than boxed, because
 * these are the places the product argues rather than reports, and they
 * should read as writing instead of as another card.
 */
export function Callout({
  tone = 'good', title, children,
}: {
  tone?: 'good' | 'warn' | 'bad';
  title: string;
  children: ReactNode;
}) {
  const cls = tone === 'good' ? '' : tone === 'warn' ? ' warn' : ' bad';
  return (
    <div className={`callout${cls}`}>
      <div className="callout-title">{title}</div>
      {children}
    </div>
  );
}

/** Back-compatible alias used by the incident and incrementality screens. */
export function LiftInterval(props: {
  lift: number; low: number; high: number; significant: boolean;
}) {
  return (
    <Interval
      point={props.lift}
      low={props.low}
      high={props.high}
      significant={props.significant}
    />
  );
}

/* ------------------------------------------------------------------ */
/* The interval bracket — this product's signature device              */
/* ------------------------------------------------------------------ */

/**
 * Draws an estimate as what it is: a range with a mark on it, positioned
 * against a zero reference.
 *
 * A bracket whose span crosses the zero line is the visual shape of
 * "this cannot be shown to have worked", and it is legible before any
 * label is read. Rendered at two sizes — a full readout, and a 92px glyph
 * that fits inside a table cell so a column of estimates can be scanned
 * for the ones that mean nothing.
 */
export function Interval({
  point, low, high, significant, mini, caption = true,
}: {
  point: number;
  low: number;
  high: number;
  significant: boolean;
  mini?: boolean;
  caption?: boolean;
}) {
  const bound = Math.max(0.02, Math.abs(low), Math.abs(high)) * 1.2;
  const at = (v: number) => ((v + bound) / (2 * bound)) * 100;
  const left = at(low);
  const width = Math.max(1.5, at(high) - at(low));
  const spans = !significant;

  return (
    <div className={`iv${mini ? ' iv-mini' : ''}`}>
      <div className="iv-track">
        <div className="iv-axis" />
        <div className="iv-zero" style={{ left: `${at(0)}%` }} />
        <div
          className={`iv-range${spans ? ' spans' : ''}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        <div className={`iv-point${spans ? ' spans' : ''}`} style={{ left: `${at(point)}%` }} />
      </div>
      {caption && !mini ? (
        <div className="iv-caption">
          <span>
            lift <b className={spans ? 'pha' : 'sig'}>{pp(point)}</b>
          </span>
          <span>95% CI {ppRange(low, high)}</span>
          <span className={spans ? 'pha' : 'sig'}>
            {spans ? 'spans zero — no measurable effect' : 'excludes zero'}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Gross versus incremental                                            */
/* ------------------------------------------------------------------ */

export function SplitBar({
  grossPaise, incrementalPaise,
}: {
  grossPaise: number;
  incrementalPaise: number;
}) {
  const inc = Math.max(0, Math.min(incrementalPaise, grossPaise));
  const natural = Math.max(0, grossPaise - inc);
  const total = grossPaise || 1;
  const incPct = (inc / total) * 100;
  const natPct = (natural / total) * 100;

  return (
    <div>
      <div className="split">
        <div className="split-seg split-phantom" style={{ width: `${natPct}%` }}>
          {natPct > 15 ? <span>{money(natural)}</span> : null}
        </div>
        <div className="split-seg split-signal" style={{ width: `${incPct}%` }}>
          {incPct > 15 ? <span>{money(inc)}</span> : null}
        </div>
      </div>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--phantom)' }} />
          would have recovered anyway — {money(natural)}
        </span>
        <span>
          <i style={{ background: 'var(--signal)' }} />
          incremental, caused by the engine — {money(inc)}
        </span>
      </div>
    </div>
  );
}

/** Row-sized version of the split, for scanning a column of decisions. */
export function Spark({ grossPaise, incrementalPaise }: { grossPaise: number; incrementalPaise: number }) {
  if (grossPaise <= 0) return <span className="dim">—</span>;
  const inc = Math.max(0, Math.min(incrementalPaise, grossPaise));
  const incPct = (inc / grossPaise) * 100;
  return (
    <span className="spark" title={`${money(inc)} incremental of ${money(grossPaise)} gross`}>
      <i className="p" style={{ width: `${100 - incPct}%` }} />
      <i className="s" style={{ width: `${incPct}%` }} />
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
