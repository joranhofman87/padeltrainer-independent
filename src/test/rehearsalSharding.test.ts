/**
 * Focused tests for rehearsal shard partitioning (scripts/db/rehearsal-shards.mjs)
 * and its wiring into scripts/db/run-all-rehearsals.mjs.
 *
 * CI runs the DB rehearsals split across isolated runners (`--shard=<i>/<c>`).
 * What keeps that split trustworthy is the PARTITION invariant: every discovered
 * rehearse-* file runs in exactly one shard — a silent omission is how a
 * data-integrity regression ships green, and a duplicate wastes a runner while
 * hiding imbalance. These tests pin, on every CI run:
 *
 *   1. the exactly-once union over the REAL scripts/db inventory;
 *   2. strict argument validation that fails closed on malformed shard specs
 *      (a typo must never degrade into "quietly run everything, twice");
 *   3. the runner executable itself honors --shard/--list AND executes exactly
 *      the selected files (so the library being correct can't mask the CLI
 *      ignoring it, and listing correctly can't mask executing wrongly);
 *   4. the workflow side of the contract — single-dimension 1..N matrices whose
 *      count comes from strategy.job-total, aggregated by the required `test`
 *      gate — so .github/workflows/test.yml cannot drift from the runner.
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REHEARSAL_PATTERN,
  UsageError,
  discoverRehearsals,
  parseShardSpec,
  parseRunnerArgs,
  partitionShard,
} from '../../scripts/db/rehearsal-shards.mjs';

const dbDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/db');
const runnerPath = join(dbDir, 'run-all-rehearsals.mjs');

/** Multiset-safe partition check: union of shards 1..count === inventory, each exactly once. */
function expectExactPartition(inventory: string[], count: number) {
  const shards = [];
  for (let index = 1; index <= count; index++) {
    shards.push(partitionShard(inventory, index, count));
  }
  const union = shards.flat();
  // Sorted concatenation equality proves BOTH completeness (no omission) and
  // uniqueness (no duplication) in one shot, because the inventory is a set.
  expect([...union].sort()).toEqual([...inventory].sort());
  // Balance: round-robin over sorted names means sizes differ by at most one.
  const sizes = shards.map((s) => s.length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  return shards;
}

describe('rehearsal discovery (the real inventory)', () => {
  it('finds the rehearsals and matches an independent readdir', () => {
    const discovered = discoverRehearsals(dbDir);
    // Independent re-derivation (own readdir, own regex) so a broken
    // discoverRehearsals cannot vouch for itself.
    const independent = readdirSync(dbDir)
      .filter((f) => /^rehearse-.*\.(mjs|ts)$/.test(f))
      .sort();
    expect(discovered).toEqual(independent);
    expect(discovered.length).toBeGreaterThan(0);
    for (const f of discovered) expect(f).toMatch(REHEARSAL_PATTERN);
  });

  it('splits the real inventory exactly once across the CI shard set (count=2) and beyond', () => {
    const inventory = discoverRehearsals(dbDir);
    for (const count of [1, 2, 3]) {
      expectExactPartition(inventory, count);
    }
  });
});

describe('partitionShard', () => {
  it('is an exact, balanced partition for synthetic inventories', () => {
    for (const size of [1, 2, 5, 7, 46]) {
      const files = Array.from({ length: size }, (_, i) => `rehearse-${String(i).padStart(3, '0')}.mjs`);
      for (let count = 1; count <= size; count++) {
        expectExactPartition(files, count);
      }
    }
  });

  it('is deterministic and input-order independent', () => {
    const files = ['rehearse-c.ts', 'rehearse-a.mjs', 'rehearse-b.mjs', 'rehearse-d.mjs', 'rehearse-e.ts'];
    const reversed = [...files].reverse();
    for (let index = 1; index <= 2; index++) {
      expect(partitionShard(files, index, 2)).toEqual(partitionShard(reversed, index, 2));
      expect(partitionShard(files, index, 2)).toEqual(partitionShard(files, index, 2));
    }
  });

  it('with count=1 returns the whole sorted inventory (the unsharded run)', () => {
    const files = ['rehearse-b.mjs', 'rehearse-a.mjs'];
    expect(partitionShard(files, 1, 1)).toEqual(['rehearse-a.mjs', 'rehearse-b.mjs']);
  });

  it('rejects duplicate file names — a partition is defined over a set', () => {
    expect(() => partitionShard(['rehearse-a.mjs', 'rehearse-a.mjs'], 1, 2)).toThrow(/duplicate/);
  });

  it('rejects a count larger than the inventory — an empty shard must be impossible', () => {
    expect(() => partitionShard(['rehearse-a.mjs', 'rehearse-b.mjs'], 3, 3)).toThrow(RangeError);
    expect(() => partitionShard([], 1, 1)).toThrow(RangeError);
  });

  it('pins the allocation itself: position i goes to shard (i % count) + 1', () => {
    // Round-robin over the SORTED names is the documented contract, not an
    // accident: it spreads alphabetically adjacent (often similar-cost)
    // rehearsals across shards. A switch to e.g. a contiguous slice would keep
    // every set-level property above and still fail here, on purpose.
    const files = ['rehearse-b.mjs', 'rehearse-a.mjs', 'rehearse-c.ts', 'rehearse-e.ts', 'rehearse-d.mjs'];
    expect(partitionShard(files, 1, 2)).toEqual(['rehearse-a.mjs', 'rehearse-c.ts', 'rehearse-e.ts']);
    expect(partitionShard(files, 2, 2)).toEqual(['rehearse-b.mjs', 'rehearse-d.mjs']);
  });

  it('rejects invalid shard parameters', () => {
    const files = ['rehearse-a.mjs', 'rehearse-b.mjs'];
    expect(() => partitionShard('nope' as unknown as string[], 1, 2)).toThrow(TypeError);
    for (const [index, count] of [
      [0, 2],
      [3, 2],
      [-1, 2],
      [1, 0],
      [1, -2],
      [1.5, 2],
      [1, 2.5],
      [Number.NaN, 2],
      [1, Number.POSITIVE_INFINITY],
    ]) {
      expect(() => partitionShard(files, index, count), `shard ${index}/${count}`).toThrow(RangeError);
    }
  });
});

describe('parseShardSpec', () => {
  it('accepts well-formed specs', () => {
    expect(parseShardSpec('1/1')).toEqual({ index: 1, count: 1 });
    expect(parseShardSpec('1/2')).toEqual({ index: 1, count: 2 });
    expect(parseShardSpec('2/2')).toEqual({ index: 2, count: 2 });
    expect(parseShardSpec('46/46')).toEqual({ index: 46, count: 46 });
  });

  it('rejects malformed or out-of-range specs', () => {
    const bad = [
      '', '1', '/2', '1/', '1//2', '1/2/3',
      '0/2', '3/2', '1/0', '0/0',
      'a/2', '1/b', '-1/2', '+1/2', '1.5/2', '1e1/20',
      ' 1/2', '1/2 ', '1 /2', '0x1/2',
      '99999999999999999999/99999999999999999999',
    ];
    for (const spec of bad) {
      expect(() => parseShardSpec(spec), `spec "${spec}"`).toThrow(UsageError);
    }
  });
});

describe('parseRunnerArgs', () => {
  it('parses the supported flag combinations', () => {
    expect(parseRunnerArgs([])).toEqual({ shard: null, list: false });
    expect(parseRunnerArgs(['--list'])).toEqual({ shard: null, list: true });
    expect(parseRunnerArgs(['--shard=1/2'])).toEqual({ shard: { index: 1, count: 2 }, list: false });
    expect(parseRunnerArgs(['--shard=2/2', '--list'])).toEqual({ shard: { index: 2, count: 2 }, list: true });
  });

  it('fails closed on unknown or duplicated arguments', () => {
    const bad = [
      ['--shards=1/2'],
      ['--shard'],
      ['--shard', '1/2'],
      ['--shard=1/2', '--shard=1/2'],
      ['--shard=1/2', '--shard=2/2'],
      ['--list=yes'],
      ['extra'],
      ['--frobnicate'],
    ];
    for (const argv of bad) {
      expect(() => parseRunnerArgs(argv), `argv ${JSON.stringify(argv)}`).toThrow(UsageError);
    }
  });
});

describe('run-all-rehearsals.mjs CLI (end to end, --list mode: no rehearsal executes)', () => {
  const runList = (...args: string[]) =>
    spawnSync(process.execPath, [runnerPath, ...args], { encoding: 'utf8' });

  it('splits exactly once across --shard=1/2 and --shard=2/2, matching the unsharded list', () => {
    const s1 = runList('--list', '--shard=1/2');
    const s2 = runList('--list', '--shard=2/2');
    const full = runList('--list');
    expect(s1.status).toBe(0);
    expect(s2.status).toBe(0);
    expect(full.status).toBe(0);
    const lines = (out: string) => out.split('\n').filter(Boolean);
    const union = [...lines(s1.stdout), ...lines(s2.stdout)].sort();
    expect(union).toEqual(lines(full.stdout).sort());
    expect(lines(full.stdout).sort()).toEqual(discoverRehearsals(dbDir));
    // Disjoint AND balanced: 46 rehearsals → 23/23 today; sizes never differ by more than one.
    expect(Math.abs(lines(s1.stdout).length - lines(s2.stdout).length)).toBeLessThanOrEqual(1);
  });

  it('exits 2 with usage on an invalid invocation, without running anything', () => {
    for (const argv of [['--shard=0/2'], ['--shard=3/2'], ['--shards=1/2'], ['--shard=1/999999']]) {
      const res = runList(...argv, '--list');
      expect(res.status, `argv ${JSON.stringify(argv)}`).toBe(2);
      expect(res.stderr).toMatch(/Usage:|exceeds/);
    }
  });
});

describe('run-all-rehearsals.mjs EXECUTES exactly the selected shard (tmp fixture dir)', () => {
  // The --list tests above prove selection; this proves the execution loop runs
  // what was selected — a runner that listed correctly but executed `all`, or
  // skipped the first file, would pass every list-mode assertion. The REAL
  // runner and partition module are copied byte-for-byte at test time (never
  // hand-inlined — an inline copy tests the copy, not the code) into a temp dir
  // whose only rehearse-* files are fakes that append their name to a marker.
  it('runs each fake rehearsal exactly once across both shards, and a failing one fails only its shard', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rehearsal-shards-e2e-'));
    try {
      copyFileSync(runnerPath, join(tmp, 'run-all-rehearsals.mjs'));
      copyFileSync(join(dbDir, 'rehearsal-shards.mjs'), join(tmp, 'rehearsal-shards.mjs'));
      const marker = join(tmp, 'ran.log');
      // One .ts fake so the `npx tsx` branch runs for real too.
      const names = ['rehearse-e2e-a.mjs', 'rehearse-e2e-b.mjs', 'rehearse-e2e-c.ts', 'rehearse-e2e-d.mjs', 'rehearse-e2e-e.mjs'];
      for (const name of names) {
        writeFileSync(
          join(tmp, name),
          `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});\n`,
        );
      }
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [join(tmp, 'run-all-rehearsals.mjs'), ...args], { encoding: 'utf8' });

      const s1 = run('--shard=1/2');
      const s2 = run('--shard=2/2');
      expect(s1.status, s1.stderr).toBe(0);
      expect(s2.status, s2.stderr).toBe(0);
      const ran = readFileSync(marker, 'utf8').split('\n').filter(Boolean).sort();
      expect(ran).toEqual([...names].sort()); // every fake exactly once ACROSS the shard set

      // Failure propagation: add a failing fake; exactly one shard must exit 1.
      writeFileSync(join(tmp, 'rehearse-e2e-f.mjs'), 'process.exit(1);\n');
      const s3 = run('--shard=1/2');
      const s4 = run('--shard=2/2');
      expect([s3.status, s4.status].filter((c) => c === 1)).toHaveLength(1);
      expect(`${s3.stdout}${s3.stderr}${s4.stdout}${s4.stderr}`).toContain('rehearse-e2e-f.mjs (');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('workflow ↔ runner coupling (.github/workflows/test.yml)', () => {
  // The partition is only exactly-once if the workflow feeds coherent
  // index/count pairs. These are drift alarms binding the two: a second matrix
  // dimension (which would multiply strategy.job-total), a shard list that is
  // not exactly 1..N, or a run line that stops deriving count from job-total
  // all fail here, loudly, instead of silently running files twice or never.
  const workflowSrc = () =>
    readFileSync(resolve(dbDir, '../../.github/workflows/test.yml'), 'utf8');

  it('both sharded jobs use a single-dimension shard matrix of exactly 1..N', () => {
    const src = workflowSrc();
    // `matrix:` immediately followed by its ONLY key, `shard: [...]` — the
    // negative lookahead rejects any sibling key at the same indent.
    const blocks = [...src.matchAll(/matrix:\n(\s+)shard: \[([^\]\n]+)\]\n(?!\1\S)/g)];
    expect(blocks, 'expected exactly the db-tests and db-rehearsals shard matrices').toHaveLength(2);
    for (const block of blocks) {
      const shards = block[2].split(',').map((s) => Number(s.trim()));
      expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1));
    }
  });

  it('both sharded run lines derive the count from strategy.job-total', () => {
    const src = workflowSrc();
    const runLines = src.match(/--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/g) ?? [];
    expect(runLines).toHaveLength(2);
  });

  it('the required `test` gate needs every split job and runs under if: always()', () => {
    const src = workflowSrc();
    const gateStart = src.indexOf('\n  test:\n');
    expect(gateStart).toBeGreaterThan(-1);
    const rest = src.slice(gateStart + 1);
    const nextJob = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
    const gate = nextJob === -1 ? rest : rest.slice(0, nextJob + 2);
    expect(gate).toContain('needs: [unit-tests, db-tests, db-rehearsals, i18n]');
    expect(gate).toContain('if: always()');
  });
});
