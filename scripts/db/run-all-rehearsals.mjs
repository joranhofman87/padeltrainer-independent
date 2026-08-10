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
 *
 * CI sharding: `--shard=<index>/<count>` runs a deterministic subset of the
 * DISCOVERED inventory (see scripts/db/rehearsal-shards.mjs) so isolated runners
 * split the wall-clock cost. Across shards 1..count every rehearsal runs exactly
 * once; src/test/rehearsalSharding.test.ts pins that against the real directory.
 * No flag = run everything, exactly as before (local gates and ci-equivalent.sh
 * keep the complete unsharded run). `--list` prints the selected files without
 * executing anything, for auditing what a shard would run.
 *
 * Exit codes: 0 all selected rehearsals passed · 1 a rehearsal failed (or the
 * discovery found nothing) · 2 the invocation itself was invalid.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { discoverRehearsals, parseRunnerArgs, UsageError, partitionShard } from './rehearsal-shards.mjs';

const dir = dirname(fileURLToPath(import.meta.url));

let opts;
try {
  opts = parseRunnerArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(err.message);
    console.error('Usage: node scripts/db/run-all-rehearsals.mjs [--shard=<index>/<count>] [--list]');
    process.exit(2);
  }
  throw err;
}

const all = discoverRehearsals(dir);
if (all.length === 0) {
  console.error('No scripts/db/rehearse-*.{mjs,ts} found — runner misconfigured.');
  process.exit(1);
}

if (opts.shard && opts.shard.count > all.length) {
  // Same fail-closed stance as vitest --shard: a count beyond the inventory
  // guarantees empty shards, and an empty shard passing is indistinguishable
  // from a shard that silently skipped its work.
  console.error(`--shard count ${opts.shard.count} exceeds the ${all.length} discovered rehearsals.`);
  process.exit(2);
}

const files = opts.shard ? partitionShard(all, opts.shard.index, opts.shard.count) : all;

if (opts.list) {
  for (const f of files) console.log(f);
  process.exit(0);
}

const label = opts.shard
  ? `${files.length} of ${all.length} DB rehearsals (shard ${opts.shard.index}/${opts.shard.count})`
  : `${files.length} DB rehearsals`;
console.log(`Running ${label}…\n`);
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
