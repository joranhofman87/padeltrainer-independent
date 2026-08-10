// @vitest-environment node
//
// Node, not the project-default jsdom: this file drives CI tooling (child
// processes, the filesystem, vite's config loader) and touches no DOM. jsdom's
// TextEncoder also fails esbuild's `encode("") instanceof Uint8Array`
// invariant, which breaks loading vitest.config.ts through vite.
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
 *   4. the workflow side of the contract, via scripts/ci/workflow-contract.mjs
 *      (the same module its own CI job runs) — so .github/workflows/test.yml
 *      cannot drift from the runner.
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { BaseSequencer } from 'vitest/node';
import { checkWorkflowContract, PREREQUISITE_RUNS, CONTRACT_JOBS } from '../../scripts/ci/workflow-contract.mjs';
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
const contractCli = resolve(dbDir, '../ci/workflow-contract.mjs');

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
        // The .ts fixture uses an ENUM — non-erasable TypeScript. Node ≥23.6
        // strips plain annotations natively, so only non-erasable syntax
        // proves the runner really routed .ts through tsx: rerouting it
        // through plain `node` makes this file refuse to run.
        const body = name.endsWith('.ts')
          ? `import { appendFileSync } from 'node:fs';\nenum Times { Once = 1 }\nconst line: string = ${JSON.stringify(`${name}\n`)};\nappendFileSync(${JSON.stringify(marker)}, line.repeat(Times.Once));\n`
          : `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});\n`;
        writeFileSync(join(tmp, name), body);
      }
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [join(tmp, 'run-all-rehearsals.mjs'), ...args], { encoding: 'utf8' });

      const s1 = run('--shard=1/2');
      const s2 = run('--shard=2/2');
      expect(s1.status, s1.stderr).toBe(0);
      expect(s2.status, s2.stderr).toBe(0);
      const ran = readFileSync(marker, 'utf8').split('\n').filter(Boolean).sort();
      expect(ran).toEqual([...names].sort()); // every fake exactly once ACROSS the shard set

      // No-argument mode — what `npm run db:rehearse:all` and
      // scripts/ci-equivalent.sh use — must EXECUTE the whole inventory, not
      // just select it. (A runner that fell through to list-mode without a
      // shard would exit 0 having run nothing.)
      rmSync(marker);
      const full = run();
      expect(full.status, full.stderr).toBe(0);
      expect(readFileSync(marker, 'utf8').split('\n').filter(Boolean).sort()).toEqual([...names].sort());

      // Failure propagation, .mjs branch: exactly the shard containing the
      // failing file exits 1 and the other exits 0 — [2,1] or [null,1] would
      // mean a crash we mistook for a pass.
      writeFileSync(join(tmp, 'rehearse-e2e-f.mjs'), 'process.exit(1);\n');
      const s3 = run('--shard=1/2');
      const s4 = run('--shard=2/2');
      expect([s3.status, s4.status].sort(), 'one failing .mjs rehearsal').toEqual([0, 1]);
      expect(`${s3.stdout}${s3.stderr}${s4.stdout}${s4.stderr}`).toContain('rehearse-e2e-f.mjs (');

      // Failure propagation, npx-tsx branch: a nonzero exit from a .ts
      // rehearsal must fail its shard exactly the same way (enum again — a
      // node-routed run would fail for the wrong reason and still be caught).
      rmSync(join(tmp, 'rehearse-e2e-f.mjs'));
      writeFileSync(join(tmp, 'rehearse-e2e-t.ts'), 'enum Code { Fail = 1 }\nprocess.exit(Code.Fail);\n');
      const s5 = run('--shard=1/2');
      const s6 = run('--shard=2/2');
      expect([s5.status, s6.status].sort(), 'one failing .ts rehearsal').toEqual([0, 1]);

      // …and the no-argument path propagates failure too: `npm run
      // db:rehearse:all` exiting 0 after a failed rehearsal is the exact shape
      // of a gate reporting green while an invariant is broken.
      const noArgs = run();
      expect(noArgs.status, 'no-arg run with a failing rehearsal').toBe(1);
      expect(`${noArgs.stdout}${noArgs.stderr}`).toContain('FAILED');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("vitest's own shard split, over the real db inventory", () => {
  // The db half of the partition is DELEGATED to vitest — the workflow only
  // passes --shard=i/2. Everything else here would still pass if that delegated
  // half broke (a vitest upgrade changing the algorithm, or a custom sequencer),
  // so this drives vitest's REAL BaseSequencer — imported, never re-implemented,
  // because a hand-copied algorithm tests the copy — over the actual 142 files.
  const repoRoot = resolve(dbDir, '../..');

  /** The db project's inventory, derived independently of vitest.config.ts. */
  const dbInventory = () => {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const entry of readdirSync(join(repoRoot, rel), { withFileTypes: true })) {
        const next = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else if (/\.(pglite|realpg)\.test\.tsx?$/.test(entry.name)) out.push(next);
      }
    };
    walk('src');
    out.push('src/test/notificationDigestRealPg.integration.test.ts');
    return [...new Set(out)].sort();
  };

  const shardWith = async (files: string[], index: number, count: number) => {
    const specs = files.map((f) => ({ moduleId: join(repoRoot, f) }));
    const sequencer = new BaseSequencer({ config: { root: repoRoot, shard: { index, count } } } as never);
    const out = (await sequencer.shard(specs as never)) as Array<{ moduleId: string }>;
    return out.map((s) => s.moduleId.slice(repoRoot.length + 1));
  };

  it('splits the real 142-file inventory into an exact, disjoint partition', async () => {
    const inventory = dbInventory();
    expect(inventory.length, 'db inventory size').toBe(142);
    const s1 = await shardWith(inventory, 1, 2);
    const s2 = await shardWith(inventory, 2, 2);
    expect([...s1, ...s2].sort()).toEqual(inventory); // complete AND duplicate-free
    expect(s1.filter((f) => s2.includes(f))).toEqual([]);
    expect(Math.abs(s1.length - s2.length)).toBeLessThanOrEqual(1);
  });

  it('stays an exact partition at other shard counts, and is deterministic', async () => {
    const inventory = dbInventory();
    for (const count of [1, 3, 4]) {
      const shards = [];
      for (let index = 1; index <= count; index++) shards.push(await shardWith(inventory, index, count));
      expect(shards.flat().sort(), `count=${count}`).toEqual(inventory);
      const sizes = shards.map((s) => s.length);
      expect(Math.max(...sizes) - Math.min(...sizes), `count=${count} balance`).toBeLessThanOrEqual(1);
    }
    // Same input, same output — the split must not depend on machine or order.
    expect(await shardWith(inventory, 1, 2)).toEqual(await shardWith([...inventory].reverse(), 1, 2));
  });
});

describe('the CI gate contract (scripts/ci/workflow-contract.mjs)', () => {
  // The partition is only exactly-once if the workflow feeds coherent
  // index/count pairs — and only meaningful if each job really runs its suite.
  // Those assertions live in the checker module so the SAME code runs here
  // (via `npm test`, locally) and as its own CI job; a contract enforced only
  // inside a job whose steps could be skipped is not enforced.
  it('holds for the current workflow, package.json and vitest config', async () => {
    const violations = await checkWorkflowContract();
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('runs the contract in an independently required job, not only its own', () => {
    // If it only ran in `workflow-contract`, a `continue-on-error: true` on the
    // aggregator's step would make `test` tolerate its own failed verification.
    expect(CONTRACT_JOBS).toContain('lint');
    expect(CONTRACT_JOBS).toContain('workflow-contract');
  });

  it('lists the gate prerequisites the aggregator waits for', () => {
    expect(Object.keys(PREREQUISITE_RUNS)).toEqual([
      'unit-tests', 'db-tests', 'db-rehearsals', 'i18n', 'workflow-contract',
    ]);
  });

  it('the CLI its CI job runs exits 0 and says so', () => {
    // The workflow calls the CLI, not the module: a checker that computed
    // violations but never exited nonzero would gate nothing.
    const res = spawnSync(process.execPath, [contractCli], { encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('CI gate contract holds.');
  });
});

describe('the gate program itself (executed against a result truth table)', () => {
  // Pinning tokens in the gate's script proves nothing about CONTROL FLOW: an
  // `exit 0` inserted after `set -euo pipefail` leaves every token in place.
  // So the actual script is extracted from the workflow, the Actions
  // expressions are substituted, and it is RUN under bash for each combination
  // of prerequisite results that CI can produce.
  const gateProgram = () => {
    const workflow = parseYaml(readFileSync(resolve(dbDir, '../../.github/workflows/test.yml'), 'utf8')) as {
      jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }>;
    };
    return workflow.jobs.test.steps[0];
  };

  /** Runs the gate's real script with the given per-job results; returns its exit code. */
  const runGate = (results: Record<string, string>) => {
    const step = gateProgram();
    const env: Record<string, string> = { NEEDS: JSON.stringify(results) };
    // The `env:` block maps RESULT_* names to ${{ needs.<id>.result }}; resolve
    // each through the results table (a job missing from needs → empty string,
    // exactly as the expression engine would expand it).
    for (const [key, expr] of Object.entries(step.env ?? {})) {
      const match = /needs\.([a-z0-9-]+)\.result/.exec(expr);
      if (match) env[key] = results[match[1]] ?? '';
    }
    const script = (step.run ?? '').replace(
      /\$\{\{ join\(needs\.\*\.result, ' '\) \}\}/g,
      Object.values(results).join(' '),
    );
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
    return res.status;
  };

  const ALL = ['unit-tests', 'db-tests', 'db-rehearsals', 'i18n', 'workflow-contract'];
  const allSuccess = () => Object.fromEntries(ALL.map((j) => [j, 'success']));

  it('succeeds only when every prerequisite succeeded', () => {
    expect(runGate(allSuccess())).toBe(0);
  });

  it('fails on any non-success result, for every prerequisite', () => {
    for (const job of ALL) {
      for (const bad of ['failure', 'cancelled', 'skipped', '']) {
        expect(runGate({ ...allSuccess(), [job]: bad }), `${job}=${bad || '<empty>'}`).toBe(1);
      }
    }
  });

  it('fails when a prerequisite is missing from needs entirely', () => {
    for (const job of ALL) {
      const partial = allSuccess();
      delete partial[job];
      expect(runGate(partial), `${job} dropped`).toBe(1);
    }
  });

  it('fails when needs is empty', () => {
    expect(runGate({})).toBe(1);
  });
});

describe('the contract checker detects each weakening (fixture repos)', () => {
  // Committed negative tests: without them, deleting a detector — or the CLI's
  // process.exit(1) — leaves everything green and only a human's memory of a
  // manual mutation run stands between the gate and a silent hole.
  const makeFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-contract-fixture-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, 'src/test'), { recursive: true });
    copyFileSync(resolve(dbDir, '../../.github/workflows/test.yml'), join(root, '.github/workflows/test.yml'));
    const realPkg = JSON.parse(readFileSync(resolve(dbDir, '../../package.json'), 'utf8'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: realPkg.scripts }, null, 2));
    // A minimal config with the same project shape and no imports, so vite can
    // load it from a temp dir with no node_modules.
    writeFileSync(
      join(root, 'vitest.config.ts'),
      `export default {\n  test: {\n    projects: [\n` +
        `      { test: { name: 'unit', include: ['src/**/*.{test,spec}.{ts,tsx}'],\n` +
        `        exclude: ['**/*.realpg.test.ts', '**/*.pglite.test.ts', 'src/test/notificationDigestRealPg.integration.test.ts'] } },\n` +
        `      { test: { name: 'db', include: ['src/**/*.realpg.test.ts', 'src/**/*.pglite.test.ts', 'src/test/notificationDigestRealPg.integration.test.ts'],\n` +
        `        fileParallelism: false } },\n    ],\n  },\n};\n`,
    );
    for (const f of ['src/plain.test.ts', 'src/test/thing.pglite.test.ts', 'src/test/other.realpg.test.ts', 'src/test/notificationDigestRealPg.integration.test.ts']) {
      writeFileSync(join(root, f), '// fixture\n');
    }
    mkdirSync(join(root, 'scripts/db'), { recursive: true });
    for (const f of ['scripts/db/rehearse-alpha.mjs', 'scripts/db/rehearse-beta.ts']) {
      writeFileSync(join(root, f), '// fixture rehearsal\n');
    }
    return root;
  };

  const editWorkflow = (root: string, edit: (src: string) => string) => {
    const p = join(root, '.github/workflows/test.yml');
    writeFileSync(p, edit(readFileSync(p, 'utf8')));
  };
  const editJson = (root: string, file: string, edit: (o: Record<string, unknown>) => void) => {
    const p = join(root, file);
    const o = JSON.parse(readFileSync(p, 'utf8'));
    edit(o);
    writeFileSync(p, JSON.stringify(o, null, 2));
  };

  it('reports nothing for a faithful fixture, and one violation per weakening', async () => {
    const root = makeFixture();
    try {
      // The fixture must be CLEAN first — otherwise every case below would
      // "pass" on a pre-existing violation rather than the one it introduces.
      expect(await checkWorkflowContract({ repoRoot: root })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const cases: Array<[string, RegExp, (root: string) => void]> = [
      ['gate renamed', /must not set `name:`/, (r) => editWorkflow(r, (s) => s.replace('  test:\n    runs-on:', '  test:\n    name: Aggregate\n    runs-on:'))],
      ['gate need dropped', /needs must be exactly/, (r) => editWorkflow(r, (s) => s.replace(', i18n, workflow-contract]', ', workflow-contract]'))],
      ['gate condition widened', /`if` must be exactly always\(\)/, (r) => editWorkflow(r, (s) => s.replace('    if: always()', "    if: always() && github.event_name == 'push'"))],
      ['gate stops reading a result', /must read \$\{\{ needs\.i18n\.result \}\}/, (r) => editWorkflow(r, (s) => s.replace('          RESULT_I18N: ${{ needs.i18n.result }}\n', ''))],
      ['second matrix dimension', /single dimension/, (r) => editWorkflow(r, (s) => s.replace('        shard: [1, 2]\n', '        shard: [1, 2]\n\n        os: [ubuntu-latest]\n'))],
      ['shard list not 1..N', /shard list must be exactly/, (r) => editWorkflow(r, (s) => s.replace('        shard: [1, 2]', '        shard: [1, 1]'))],
      ['fail-fast dropped', /fail-fast must be false/, (r) => editWorkflow(r, (s) => s.replace('      fail-fast: false\n', ''))],
      ['suite step made conditional', /step has an `if:`/, (r) => editWorkflow(r, (s) => s.replace('        run: npm run test:unit', '        if: github.event_name == \'push\'\n        run: npm run test:unit'))],
      ['suite step continue-on-error', /continue-on-error/, (r) => editWorkflow(r, (s) => s.replace('        run: npm run test:unit', '        continue-on-error: true\n        run: npm run test:unit'))],
      ['suite step shell bypass', /overrides `shell/, (r) => editWorkflow(r, (s) => s.replace('        run: npm run test:unit', '        shell: bash -n {0}\n        run: npm run test:unit'))],
      ['job defaults shell bypass', /defaults\.run\.shell/, (r) => editWorkflow(r, (s) => s.replace('  unit-tests:\n    runs-on: ubuntu-latest', '  unit-tests:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash -n {0}'))],
      ['workflow defaults shell bypass', /workflow defaults\.run\.shell/, (r) => editWorkflow(r, (s) => s.replace('\njobs:\n', '\ndefaults:\n  run:\n    shell: bash -n {0}\n\njobs:\n'))],
      ['shard forwarding dropped', /must run in exactly 1 step|unexpected suite invocation/, (r) => editWorkflow(r, (s) => s.replace('        run: npm run test:db -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}', '        run: npm run test:db'))],
      ['direct unsharded invocation added', /unexpected suite invocation/, (r) => editWorkflow(r, (s) => s.replace('      - name: Run unit tests\n', '      - name: Sneaky\n        run: npx vitest run --project db\n\n      - name: Run unit tests\n'))],
      ['concurrency branches swapped', /concurrency\.group must be exactly/, (r) => editWorkflow(r, (s) => s.replace("github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.run_id", "github.event_name == 'pull_request' && github.run_id || format('pr-{0}', github.event.pull_request.number)"))],
      ['cancellation widened to pushes', /cancel-in-progress must be exactly/, (r) => editWorkflow(r, (s) => s.replace("  cancel-in-progress: ${{ github.event_name == 'pull_request' }}", '  cancel-in-progress: true'))],
      ['npm alias neutered', /scripts\.test:db must be/, (r) => editJson(r, 'package.json', (o) => { (o.scripts as Record<string, string>)['test:db'] = ':'; })],
      ['npm lifecycle hook added', /scripts\.pretest:db exists/, (r) => editJson(r, 'package.json', (o) => { (o.scripts as Record<string, string>)['pretest:db'] = 'vitest run --project db'; })],
      ['npmrc redirects script-shell', /\.npmrc sets script-shell/, (r) => writeFileSync(join(r, '.npmrc'), 'script-shell=/bin/true\n')],
      ['step env redirects script-shell', /npm_config_script_shell/, (r) => editWorkflow(r, (s) => s.replace('      - name: Run unit tests\n', '      - name: Run unit tests\n        env:\n          npm_config_script_shell: /bin/true\n'))],
      ['db loses fileParallelism false', /fileParallelism: false/, (r) => editJson(r, 'package.json', () => {
        const p = join(r, 'vitest.config.ts');
        writeFileSync(p, readFileSync(p, 'utf8').replace('fileParallelism: false', 'fileParallelism: true'));
      })],
      ['db include narrowed', /selected by NO project|not owned by the db project/, (r) => {
        const p = join(r, 'vitest.config.ts');
        writeFileSync(p, readFileSync(p, 'utf8').replace(", 'src/**/*.pglite.test.ts'", ''));
      }],
      ['db exclude added', /selected by NO project|not owned by the db project/, (r) => {
        const p = join(r, 'vitest.config.ts');
        writeFileSync(p, readFileSync(p, 'utf8').replace('fileParallelism: false', "exclude: ['**/*.pglite.test.ts'], fileParallelism: false"));
      }],
      ['unit include narrowed', /selected by NO project/, (r) => {
        const p = join(r, 'vitest.config.ts');
        writeFileSync(p, readFileSync(p, 'utf8').replace("include: ['src/**/*.{test,spec}.{ts,tsx}']", "include: ['src/test/nothing.test.ts']"));
      }],
      ['contract step loses its explicit bash', /must pin `shell: bash`/, (r) => editWorkflow(r, (s) => s.replace('      - name: Verify the CI gate contract\n        shell: bash\n', '      - name: Verify the CI gate contract\n'))],
      ['gate step loses its explicit bash', /must pin `shell: bash`/, (r) => editWorkflow(r, (s) => s.replace('      - name: Verify every test prerequisite succeeded\n        shell: bash\n', '      - name: Verify every test prerequisite succeeded\n'))],
      ['gate step set to sh (dash rejects set -o pipefail)', /overrides `shell|must pin `shell: bash`/, (r) => editWorkflow(r, (s) => s.replace('      - name: Verify every test prerequisite succeeded\n        shell: bash', '      - name: Verify every test prerequisite succeeded\n        shell: sh'))],
      ['workflow-level env redirects script-shell', /npm_config_script_shell|NPM_CONFIG/, (r) => editWorkflow(r, (s) => s.replace('\njobs:\n', '\nenv:\n  npm_config_script_shell: /bin/true\n\njobs:\n'))],
      ['hyphenated NPM_CONFIG_SCRIPT-SHELL spelling', /SCRIPT-SHELL|script_shell/i, (r) => editWorkflow(r, (s) => s.replace('      - name: Run unit tests\n', '      - name: Run unit tests\n        env:\n          NPM_CONFIG_SCRIPT-SHELL: /bin/true\n'))],
      ['extra full-suite `npm test` step', /unexpected suite invocation/, (r) => editWorkflow(r, (s) => s.replace('      - name: Run unit tests\n', '      - name: Sneaky full gate\n        run: npm test\n\n      - name: Run unit tests\n'))],
      ['the real-pg integration file drifts into unit', /not owned by the db project/, (r) => {
        const p = join(r, 'vitest.config.ts');
        writeFileSync(p, readFileSync(p, 'utf8')
          .replace(", 'src/test/notificationDigestRealPg.integration.test.ts']", ']')
          .replace("'**/*.pglite.test.ts', 'src/test/notificationDigestRealPg.integration.test.ts']", "'**/*.pglite.test.ts']"));
      }],
      ['SHELLOPTS=noexec neuters every bash step', /can make gated steps exit 0/, (r) => editWorkflow(r, (s) => s.replace('\njobs:\n', '\nenv:\n  SHELLOPTS: noexec\n\njobs:\n'))],
      ['BASH_ENV sourced before each step', /can make gated steps exit 0/, (r) => editWorkflow(r, (s) => s.replace('      - name: Run unit tests\n', '      - name: Run unit tests\n        env:\n          BASH_ENV: /tmp/exit0.sh\n'))],
      ['NODE_OPTIONS preloads a module', /can make gated steps exit 0/, (r) => editWorkflow(r, (s) => s.replace('  db-tests:\n    runs-on: ubuntu-latest\n', '  db-tests:\n    runs-on: ubuntu-latest\n    env:\n      NODE_OPTIONS: --require /tmp/exit0.js\n'))],
      ['contract no longer runs in the required lint job', /contract checker must run in exactly/, (r) => editWorkflow(r, (s) => s.replace('      - name: Verify the CI gate contract (independently required copy)\n        shell: bash\n        run: node scripts/ci/workflow-contract.mjs\n', ''))],
      ['a prerequisite waits on another (re-serialised)', /must not declare `needs`/, (r) => editWorkflow(r, (s) => s.replace('  db-tests:\n    runs-on: ubuntu-latest\n', '  db-tests:\n    runs-on: ubuntu-latest\n    needs: [unit-tests]\n'))],
      ['max-parallel re-serialises the shards', /max-parallel/, (r) => editWorkflow(r, (s) => s.replace('      fail-fast: false\n', '      fail-fast: false\n      max-parallel: 1\n'))],
      ['an extra `npm run --silent test` step', /unexpected suite invocation/, (r) => editWorkflow(r, (s) => s.replace('      - name: Run unit tests\n', '      - name: Sneaky\n        run: npm run --silent test\n\n      - name: Run unit tests\n'))],
      ['a postinstall hook running the db suite', /install hooks run outside/, (r) => editJson(r, 'package.json', (o) => { (o.scripts as Record<string, string>).postinstall = 'vitest run --project db'; })],
      ['a custom vitest sequencer takes over the split', /custom sequence\.sequencer/, (r) => {
        const p = join(r, 'vitest.config.ts');
        writeFileSync(p, readFileSync(p, 'utf8').replace('fileParallelism: false', 'fileParallelism: false, sequence: { sequencer: class {} }'));
      }],
      ['the named real-pg exception is renamed away', /no longer exist/, (r) => {
        rmSync(join(r, 'src/test/notificationDigestRealPg.integration.test.ts'));
        writeFileSync(join(r, 'src/test/renamedDigest.integration.test.ts'), '// fixture\n');
        const p = join(r, 'vitest.config.ts');
        writeFileSync(p, readFileSync(p, 'utf8').split('notificationDigestRealPg.integration.test.ts').join('renamedDigest.integration.test.ts'));
      }],
      ['workflow token widened beyond read', /permissions must be exactly/, (r) => editWorkflow(r, (s) => s.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'))],
      ['permissions block removed entirely', /permissions must be exactly/, (r) => editWorkflow(r, (s) => s.replace('permissions:\n  contents: read\n\n', ''))],
      ['checkout starts persisting credentials again', /persist-credentials: false/, (r) => editWorkflow(r, (s) => s.replace('        uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n', '        uses: actions/checkout@v4\n'))],
      ['a rehearsal hidden in a subdirectory', /run zero times/, (r) => {
        mkdirSync(join(r, 'scripts/db/nested'), { recursive: true });
        writeFileSync(join(r, 'scripts/db/nested/rehearse-buried.mjs'), '// unreachable\n');
      }],
      ['a database test named .tsx (would land in the parallel unit project)', /not owned by the db project/, (r) => {
        writeFileSync(join(r, 'src/test/widget.pglite.test.tsx'), '// fixture\n');
      }],
      ['a file selected by both projects', /run twice/, (r) => {
        const p = join(r, 'vitest.config.ts');
        writeFileSync(p, readFileSync(p, 'utf8').replace("exclude: ['**/*.realpg.test.ts', '**/*.pglite.test.ts', 'src/test/notificationDigestRealPg.integration.test.ts']", "exclude: []"));
      }],
    ];

    for (const [label, pattern, mutate] of cases) {
      const root = makeFixture();
      try {
        mutate(root);
        const violations = await checkWorkflowContract({ repoRoot: root });
        expect(violations.join('\n'), `${label}: expected a violation matching ${pattern}`).toMatch(pattern);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('the CLI exits 1 and prints the violations for a broken fixture', () => {
    const root = makeFixture();
    try {
      editWorkflow(root, (s) => s.replace('    if: always()', '    if: success()'));
      const res = spawnSync(process.execPath, [contractCli, root], { encoding: 'utf8' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('CI gate contract violated');
      expect(res.stderr).toMatch(/always\(\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
