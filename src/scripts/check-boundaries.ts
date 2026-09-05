/**
 * Architectural boundary check.
 *
 * The engine's detector, diagnosis, policy and runner must never import
 * the ground-truth world model. If they could, the evaluation would be
 * measuring a lookup rather than an inference.
 *
 * This runs in CI. It is three dozen lines and it is the difference
 * between "the engine cannot see the answers" being a claim and being a
 * fact.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'src');

/** Directories that must not reach into the hidden world model. */
const SEALED = ['engine/detector', 'engine/diagnosis', 'engine/policy'];

/** The module they must not import. */
const FORBIDDEN = /from\s+['"].*simulator\/world(\.js)?['"]/;

/** The runner may import the Environment interface but not the world. */
const RUNNER_ALLOWED_FROM_WORLD = ['engine/runner/environment.ts'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations: string[] = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const sealed = SEALED.some((s) => rel.startsWith(s));
  const isRunner = rel.startsWith('engine/runner');
  if (!sealed && !isRunner) continue;
  if (RUNNER_ALLOWED_FROM_WORLD.includes(rel)) continue;

  const src = readFileSync(file, 'utf8');
  if (FORBIDDEN.test(src)) {
    violations.push(rel);
  }
}

if (violations.length > 0) {
  console.error('Boundary violation — engine code imports the hidden world model:');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nThe engine must estimate uplift from observed outcomes, not read it.');
  process.exit(1);
}

console.log(`Boundaries OK — ${SEALED.join(', ')} and the runner are sealed from simulator/world.`);
