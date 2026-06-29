#!/usr/bin/env node
/**
 * Type-check ratchet for tsconfig.app.json — the REAL type-check.
 *
 * The root `tsconfig.json` has `files: []` + project references and type-checks NOTHING, so a bare
 * `tsc --noEmit` is a useless gate (it let a runtime ReferenceError ship in cycleWrites.ts — a value
 * call to an un-imported name — because eslint/vitest/`vite build` can't catch cross-module name
 * resolution; only `tsc -p tsconfig.app.json` does). That project is perma-red with a known set of
 * pre-existing errors, so this gates on NEW errors only, exactly like the eslint-suppressions ratchet:
 *
 *   - signature each error as `file|code|message` (line/col stripped — they shift when code moves)
 *   - count occurrences per signature
 *   - FAIL if any signature exceeds the committed baseline (a genuinely-new error)
 *   - note (non-fatal) signatures that dropped below baseline — fixed errors you can prune
 *
 * Regenerate after intentionally changing the error set:  node scripts/check-tsc-baseline.mjs --update
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'tsc-app.baseline.json');
const ERR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

// tsc embeds ABSOLUTE module paths inside some messages (e.g. a TS2322 "Type
// import("/abs/path/foo").X is not assignable to import("/abs/path/bar").X").
// Those paths differ per machine (/Users/tom/... locally vs /home/runner/...
// on CI), so a signature that keeps them is non-portable: a baseline captured
// locally then reads as a NEW error on CI (and the local one as "resolved").
// Strip the repo-root prefix so signatures are stable across checkouts.
const CWD = process.cwd();
const stripAbs = (s) => s.split(`${CWD}/`).join('').split(CWD).join('');

function collectErrorCounts() {
  let out = '';
  try {
    // tsc exits non-zero when there are errors; its diagnostics go to stdout.
    out = execSync('npx tsc --noEmit -p tsconfig.app.json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const counts = {};
  for (const line of out.split('\n')) {
    const m = ERR_RE.exec(line.trim());
    if (!m) continue; // skip indented continuation lines + noise
    const sig = `${stripAbs(m[1])}|${m[4]}|${stripAbs(m[5])}`;
    counts[sig] = (counts[sig] || 0) + 1;
  }
  return counts;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const current = collectErrorCounts();

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${BASELINE}: ${Object.keys(sorted).length} signatures, ${sum(sorted)} errors.`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('No tsc baseline. Generate it with:  node scripts/check-tsc-baseline.mjs --update');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

const newErrors = [];
for (const [sig, n] of Object.entries(current)) {
  const allowed = baseline[sig] || 0;
  if (n > allowed) newErrors.push(`  +${n - allowed}  ${sig.replaceAll('|', '  ')}`);
}
const resolved = Object.entries(baseline).filter(([sig, n]) => (current[sig] || 0) < n);

if (newErrors.length) {
  console.error(`\n❌ tsconfig.app.json — ${newErrors.length} NEW type-error signature(s) (baseline ${sum(baseline)}, now ${sum(current)}):\n`);
  console.error(newErrors.join('\n'));
  console.error('\nFix them. If a new error is genuinely intentional, run `node scripts/check-tsc-baseline.mjs --update` and commit the baseline.');
  process.exit(1);
}
console.log(`✅ tsconfig.app.json — no new type errors (${sum(current)} pre-existing, baseline ${sum(baseline)}).`);
if (resolved.length) {
  console.log(`\nℹ️  ${resolved.length} baseline signature(s) appear fixed — run \`--update\` to shrink the baseline (optional):`);
  console.log(resolved.slice(0, 8).map(([sig]) => `  - ${sig.split('|')[0]}`).join('\n'));
}
