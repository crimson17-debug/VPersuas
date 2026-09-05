'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The hero animation runs the product's actual experiment.
 *
 * Two lanes of failed payments fall in parallel. The left lane is treated:
 * the engine acts on it. The right lane is the holdout: nothing is done to
 * it at all. Each payment resolves at the line — recovered or lost — and
 * the two bars fill at their own rates.
 *
 * The point is what the right lane does. It fills too, because failed
 * payments recover on their own, and the gap between the bars is the only
 * part any intervention can claim. A recovery product with no holdout
 * reports the whole left bar; this one reports the difference.
 *
 * The rates are the real measured ones from the current run, passed in
 * from the ledger — not numbers chosen to make the animation look good.
 */

export interface HeroRates {
  treatedRate: number;
  holdoutRate: number;
  liftPp: number;
}

interface Dot {
  x: number;
  y: number;
  vy: number;
  lane: 0 | 1;
  recovered: boolean;
  /** 0 falling, 1 flaring at the line, 2 done */
  phase: 0 | 1 | 2;
  flare: number;
}

const LANE_LABELS = ['TREATED', 'HOLDOUT'] as const;

export function HeroExperiment({ rates }: { rates: HeroRates }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [counts, setCounts] = useState({ t: 0, tR: 0, h: 0, hR: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Read the palette from CSS so the animation follows the theme rather
    // than hard-coding a second copy of the colours.
    const css = getComputedStyle(document.documentElement);
    const signal = css.getPropertyValue('--signal').trim() || '#22d3ee';
    const phantom = css.getPropertyValue('--phantom').trim() || '#7f6fb4';
    const violet = css.getPropertyValue('--violet').trim() || '#8b5cf6';
    const ink3 = css.getPropertyValue('--ink-3').trim() || '#6f6892';
    const rule = css.getPropertyValue('--rule-strong').trim() || 'rgba(167,139,250,0.28)';

    let w = 0;
    let h = 0;
    let raf = 0;
    const dots: Dot[] = [];
    const tally = { t: 0, tR: 0, h: 0, hR: 0 };
    let spawnAcc = 0;
    let last = performance.now();

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const laneX = (lane: 0 | 1) => (lane === 0 ? w * 0.29 : w * 0.71);
    // Geometry note: the rate label sits above each bar, so the resolution
    // line needs real clearance from the bar top or the two collide.
    const resolveY = () => h * 0.5;
    const barTop = () => h * 0.66;
    const barH = () => h * 0.22;

    // Outcomes are allocated to hold each lane at its measured rate rather
    // than drawn independently. Free sampling looks more "real" but drifts
    // several points either way on a few hundred dots, and a hero that
    // announces a 28pp lift while every other number on the page says 16.7
    // is a hero that undermines the product. The animation illustrates the
    // measurement; it does not re-run it.
    const issued = [
      { n: 0, k: 0 },
      { n: 0, k: 0 },
    ];
    const spawn = () => {
      const lane: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
      const rate = lane === 0 ? rates.treatedRate : rates.holdoutRate;
      const acc = issued[lane]!;
      // Round-to-nearest rather than floor: `(k+1)/(n+1) <= rate` biases
      // every lane low by roughly 1/n, which showed up as a holdout arm
      // two points under its true rate and an inflated lift.
      const recovered = (acc.k + 0.5) / (acc.n + 1) < rate;
      acc.n++;
      if (recovered) acc.k++;

      dots.push({
        x: laneX(lane) + (Math.random() - 0.5) * w * 0.2,
        y: -8,
        vy: 42 + Math.random() * 34,
        lane,
        recovered,
        phase: 0,
        flare: 0,
      });
    };

    const drawBar = (lane: 0 | 1, total: number, recovered: number) => {
      const cx = laneX(lane);
      const bw = Math.min(w * 0.3, 150);
      const x = cx - bw / 2;
      const y = barTop();
      const bh = barH();
      const frac = total > 0 ? recovered / total : 0;
      const colour = lane === 0 ? signal : phantom;

      // track
      ctx.fillStyle = 'rgba(127,127,160,0.12)';
      roundRect(ctx, x, y, bw, bh, 6);
      ctx.fill();

      // fill, from the bottom up
      const fh = bh * frac;
      if (fh > 0.5) {
        ctx.save();
        ctx.shadowBlur = lane === 0 ? 22 : 0;
        ctx.shadowColor = colour;
        ctx.fillStyle = colour;
        roundRect(ctx, x, y + bh - fh, bw, fh, 6);
        ctx.fill();
        ctx.restore();
      }

      // rate label
      ctx.font = '600 15px ui-monospace, "IBM Plex Mono", monospace';
      ctx.fillStyle = colour;
      ctx.textAlign = 'center';
      ctx.fillText(`${(frac * 100).toFixed(1)}%`, cx, y - 11);

      ctx.font = '500 9px ui-monospace, "IBM Plex Mono", monospace';
      ctx.fillStyle = ink3;
      ctx.fillText(LANE_LABELS[lane], cx, y + bh + 15);
    };

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      ctx.clearRect(0, 0, w, h);

      // the resolution line
      ctx.strokeStyle = rule;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(w * 0.08, resolveY());
      ctx.lineTo(w * 0.92, resolveY());
      ctx.stroke();
      ctx.setLineDash([]);

      // spawn
      spawnAcc += dt;
      const interval = 1 / 26;
      while (spawnAcc > interval) {
        spawnAcc -= interval;
        if (tally.t + tally.h < 720) spawn();
      }

      // update and draw dots
      for (const d of dots) {
        if (d.phase === 0) {
          d.y += d.vy * dt;
          if (d.y >= resolveY()) {
            d.y = resolveY();
            d.phase = 1;
            if (d.lane === 0) {
              tally.t++;
              if (d.recovered) tally.tR++;
            } else {
              tally.h++;
              if (d.recovered) tally.hR++;
            }
          }
        } else if (d.phase === 1) {
          d.flare += dt * 3.4;
          if (d.flare >= 1) d.phase = 2;
        }

        if (d.phase === 2) continue;

        const base = d.lane === 0 ? signal : phantom;
        const colour = d.recovered ? base : ink3;
        const alpha =
          d.phase === 0
            ? 0.5 + 0.5 * Math.min(1, d.y / resolveY())
            : Math.max(0, 1 - d.flare);
        const r = d.phase === 1 ? 2.5 + d.flare * 5 : 2.5;

        ctx.save();
        ctx.globalAlpha = alpha;
        if (d.recovered) {
          ctx.shadowBlur = d.phase === 1 ? 18 : 8;
          ctx.shadowColor = base;
        }
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // retire finished dots without reallocating every frame
      if (dots.length > 320) {
        for (let i = dots.length - 1; i >= 0; i--) {
          if (dots[i]!.phase === 2) dots.splice(i, 1);
        }
      }

      drawBar(0, tally.t, tally.tR);
      drawBar(1, tally.h, tally.hR);

      // the gap between the bars, which is the whole product
      if (tally.t > 20 && tally.h > 20) {
        const tf = tally.tR / tally.t;
        const hf = tally.hR / tally.h;
        const y0 = barTop() + barH() * (1 - tf);
        const y1 = barTop() + barH() * (1 - hf);
        ctx.strokeStyle = violet;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(laneX(0), y0);
        ctx.lineTo(laneX(1), y1);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = '600 10px ui-monospace, "IBM Plex Mono", monospace';
        ctx.fillStyle = violet;
        ctx.textAlign = 'center';
        ctx.fillText(
          `LIFT ${((tf - hf) * 100).toFixed(1)}pp`,
          w * 0.5,
          Math.min(y0, y1) - 11,
        );
      }

      // restart the run so the page never sits on a frozen frame
      if (tally.t + tally.h >= 720 && dots.every((d) => d.phase === 2)) {
        tally.t = 0; tally.tR = 0; tally.h = 0; tally.hR = 0;
        issued[0]!.n = 0; issued[0]!.k = 0;
        issued[1]!.n = 0; issued[1]!.k = 0;
        dots.length = 0;
      }

      raf = requestAnimationFrame(frame);
    };

    // Reduced motion: draw the finished state once and stop.
    if (reduced) {
      tally.t = 640; tally.tR = Math.round(640 * rates.treatedRate);
      tally.h = 640; tally.hR = Math.round(640 * rates.holdoutRate);
      ctx.clearRect(0, 0, w, h);
      drawBar(0, tally.t, tally.tR);
      drawBar(1, tally.h, tally.hR);
      setCounts({ t: tally.t, tR: tally.tR, h: tally.h, hR: tally.hR });
      return;
    }

    raf = requestAnimationFrame(frame);
    const tick = setInterval(() => setCounts({ ...tally }), 260);
    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(tick);
      window.removeEventListener('resize', onResize);
    };
  }, [rates]);

  const tRate = counts.t > 0 ? counts.tR / counts.t : 0;
  const hRate = counts.h > 0 ? counts.hR / counts.h : 0;

  return (
    <div className="hero-stage">
      <div className="stage-head">
        <span className="stage-title">Live holdout · treated vs untouched</span>
        <span className="stage-title">{counts.t + counts.h} resolved</span>
      </div>

      <canvas ref={canvasRef} className="stage-canvas" aria-hidden="true" />

      <p className="sr-only">
        An animation of the holdout experiment. Treated payments recover at{' '}
        {(rates.treatedRate * 100).toFixed(1)} percent, held-out payments at{' '}
        {(rates.holdoutRate * 100).toFixed(1)} percent, a measured lift of{' '}
        {(rates.liftPp * 100).toFixed(1)} percentage points.
      </p>

      <div className="stage-readout">
        <div>
          <div className="k">Treated</div>
          <div className="v sig">{(tRate * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="k">Holdout</div>
          <div className="v pha">{(hRate * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="k">Lift · what we caused</div>
          <div className="v" style={{ color: 'var(--violet-hi)' }}>
            {((tRate - hRate) * 100).toFixed(1)}pp
          </div>
        </div>
      </div>
    </div>
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
