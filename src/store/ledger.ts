/**
 * The evidence ledger.
 *
 * Every decision the engine makes is written here with the evidence that
 * produced it, the hypotheses it rejected, the policy checks it passed,
 * the compliance rules that fired, and the outcome that followed. The
 * track brief asks for an audit trail; this is it.
 *
 * Backed by JSON files under .data/. That is a deliberate choice, not a
 * shortcut: the engine is pure and holds no connections, so persistence
 * sits at the edge behind an interface with four methods. Swapping this
 * for Postgres is one file — the callers only know `LedgerStore`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalSnapshot, Portfolio, StoredDecision, StoredRun } from './types.js';

export interface LedgerStore {
  readPortfolio(): Portfolio | null;
  writePortfolio(p: Portfolio): void;
  readEval(): EvalSnapshot | null;
  writeEval(e: EvalSnapshot): void;
  findDecision(id: string): { decision: StoredDecision; run: StoredRun } | null;
}

const DIR = join(process.cwd(), '.data');
const PORTFOLIO = join(DIR, 'portfolio.json');
const EVALUATION = join(DIR, 'evaluation.json');

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // A truncated write beats a crashed dashboard; the seed can be re-run.
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

export const fileLedger: LedgerStore = {
  readPortfolio: () => readJson<Portfolio>(PORTFOLIO),
  writePortfolio: (p) => writeJson(PORTFOLIO, p),
  readEval: () => readJson<EvalSnapshot>(EVALUATION),
  writeEval: (e) => writeJson(EVALUATION, e),
  findDecision(id) {
    const p = readJson<Portfolio>(PORTFOLIO);
    if (!p) return null;
    for (const run of p.runs) {
      const decision = run.decisions.find((d) => d.id === id);
      if (decision) return { decision, run };
    }
    return null;
  },
};
