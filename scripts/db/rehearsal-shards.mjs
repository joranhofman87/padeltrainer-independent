/**
 * Shard partitioning for the rehearsal runner (scripts/db/run-all-rehearsals.mjs).
 *
 * CI splits the discovered rehearsals across isolated runners with
 * `--shard=<index>/<count>`. The property that keeps that split safe is the
 * PARTITION invariant: for a fixed inventory and count, every rehearse-* file
 * lands in EXACTLY one shard — no omissions (a rehearsal silently not running
 * is how a data-integrity regression ships green) and no duplicates. The
 * partition is deterministic and input-order independent: files are sorted by
 * name, then dealt round-robin (position i goes to shard (i % count) + 1), so
 * shard sizes differ by at most one regardless of where slow rehearsals sit
 * alphabetically.
 *
 * Argument parsing is deliberately strict and FAILS CLOSED: an unknown flag, a
 * malformed spec, an out-of-range index, or a count larger than the inventory
 * is an error — never a silent fallback to "run everything" (which would run
 * the whole suite N times) or to an empty shard (which would run nothing).
 *
 * src/test/rehearsalSharding.test.ts pins all of this against the REAL
 * scripts/db inventory on every CI run.
 */
import { readdirSync } from 'node:fs';

export const REHEARSAL_PATTERN = /^rehearse-.*\.(mjs|ts)$/;

/** Errors that mean "the invocation is wrong", as opposed to "a rehearsal failed". */
export class UsageError extends Error {}

/** Every rehearse-*.{mjs,ts} in `dir`, sorted by name. */
export function discoverRehearsals(dir) {
  return readdirSync(dir)
    .filter((f) => REHEARSAL_PATTERN.test(f))
    .sort();
}

/**
 * Parses the value of a --shard flag, e.g. "2/3" → { index: 2, count: 3 }.
 * Digits only (no signs, decimals, whitespace), count >= 1, 1 <= index <= count.
 */
export function parseShardSpec(raw) {
  const m = /^([0-9]+)\/([0-9]+)$/.exec(raw);
  if (!m) {
    throw new UsageError(`--shard must be <index>/<count>, e.g. --shard=1/2 (got "${raw}")`);
  }
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count)) {
    throw new UsageError(`--shard index/count out of safe integer range (got "${raw}")`);
  }
  if (count < 1) {
    throw new UsageError(`--shard count must be >= 1 (got "${raw}")`);
  }
  if (index < 1 || index > count) {
    throw new UsageError(`--shard index must be within 1..count (got "${raw}")`);
  }
  return { index, count };
}

/**
 * Strict argv parsing for the runner. Unknown arguments are fatal: a typo like
 * `--shards=1/2` must never degrade into "this runner quietly executes the full
 * suite" — on two shards that means every rehearsal runs twice and the shard
 * split validates nothing.
 */
export function parseRunnerArgs(argv) {
  const opts = { shard: null, list: false };
  for (const arg of argv) {
    if (arg === '--list') {
      opts.list = true;
    } else if (arg.startsWith('--shard=')) {
      if (opts.shard !== null) {
        throw new UsageError(`--shard given more than once (second was "${arg}")`);
      }
      opts.shard = parseShardSpec(arg.slice('--shard='.length));
    } else {
      throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

/**
 * The shard `index` (1-based) of `files` out of `count` shards.
 *
 * Sorts a copy, then keeps positions where i % count === index - 1. Each
 * position has exactly one residue, so across shards 1..count every file
 * appears exactly once — the union is the whole inventory and the shards are
 * pairwise disjoint, by construction. Revalidates everything: this is also the
 * API surface the tests (and any future caller) hit directly.
 */
export function partitionShard(files, index, count) {
  if (!Array.isArray(files)) {
    throw new TypeError('partitionShard: files must be an array');
  }
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index < 1 || index > count) {
    throw new RangeError(`partitionShard: invalid shard ${index}/${count}`);
  }
  if (count > files.length) {
    // Same fail-closed stance as vitest --shard: more shards than files
    // guarantees empty shards, and an empty shard passing is indistinguishable
    // from a shard that silently skipped its work. Guarded HERE, not only in
    // the runner, so no future direct caller can fail open.
    throw new RangeError(`partitionShard: count ${count} exceeds the ${files.length} files`);
  }
  const sorted = [...files].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      // A partition is defined over a SET; a duplicate name would run twice in
      // one shard and make "exactly once" unverifiable.
      throw new Error(`partitionShard: duplicate file name "${sorted[i]}"`);
    }
  }
  return sorted.filter((_, i) => i % count === index - 1);
}
