/**
 * Reader for the federated snapshot the console renders.
 *
 * Same shape as the rest of the store: a typed read of a file the engine
 * wrote, so no number on the screen is authored by the UI.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RailRow {
  method: string;
  issuer: string;
  verdict: 'issuer_confirmed' | 'merchant_specific' | 'no_signal' | 'below_k_anonymity';
  contributors: number;
  degradedCount: number;
  combinedZ: number;
  pooledDiff: number;
  iSquared: number;
  confidence: number;
}

export interface TwinFinding extends RailRow {
  degradedShare: number;
  onsetSpreadMinutes: number | null;
}

export interface TwinCase {
  key: 'issuerWide' | 'merchantOnly';
  truth: string | null;
  merchantsAffected: number;
  fleetSize: number;
  focusIndex: number;
  solo: { called: string | null; abstained: boolean; correct: boolean };
  federated: { called: string | null; abstained: boolean; correct: boolean };
  finding: TwinFinding | null;
  rails: RailRow[];
  withheld: number;
  kAnonymity: number;
}

export interface ArmScore {
  arm: 'solo' | 'federated';
  decided: number;
  correct: number;
  wrong: number;
  abstained: number;
  precision: number;
  recall: number;
}

export interface NetworkSnapshot {
  generatedAt: number;
  pairs: number;
  detected: number;
  solo: ArmScore;
  federated: ArmScore;
  byScenario: {
    issuerWide: { solo: ArmScore; federated: ArmScore; n: number };
    merchantOnly: { solo: ArmScore; federated: ArmScore; n: number };
  };
  correctedByNetwork: number;
  brokenByNetwork: number;
  twins: TwinCase[];
}

const FILE = join(process.cwd(), '.data', 'network.json');

export function readNetwork(): NetworkSnapshot | null {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as NetworkSnapshot;
  } catch {
    return null;
  }
}
