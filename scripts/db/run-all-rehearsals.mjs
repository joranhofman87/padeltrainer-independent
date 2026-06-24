#!/usr/bin/env node
/**
 * Runs EVERY scripts/db/rehearse-*.{mjs,ts} sequentially.
 *
 * The previous hand-maintained `db:rehearse:all` chain ran only 8 of 28 rehearsals —
 * the money/capacity/payment golden-masters (split recalc, capacity locks, atomic
 * invoice numbering, Stripe idempotency, booking-tier enforcement, ...) ran NOWHERE,
 * so a regression to those invariants shipped green. This runner IS the orphan guard:
 * it discovers every rehearse-* file, so adding one auto-includes it in CI and a
 * rehearsal can never be silently dropped again.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((f) => /^rehearse-.*\.(mjs|ts)$/.test(f))
  .sort();

if (files.length === 0) {
  console.error('No scripts/db/rehearse-*.{mjs,ts} found — runner misconfigured.');
  process.exit(1);
}

console.log(`Running ${files.length} DB rehearsals…\n`);
const failed = [];
for (const f of files) {
  const isTs = f.endsWith('.ts');
  const cmd = isTs ? 'npx' : 'node';
  const args = isTs ? ['tsx', join(dir, f)] : [join(dir, f)];
  const started = Date.now();
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (res.status !== 0) {
    failed.push(f);
    console.error(`✗ ${f} (${secs}s) — FAILED\n`);
  } else {
    console.log(`✓ ${f} (${secs}s)\n`);
  }
}

console.log(`\n${files.length - failed.length}/${files.length} rehearsals passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
