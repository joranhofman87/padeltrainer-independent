#!/usr/bin/env node
/**
 * The CI gate contract, as executable assertions.
 *
 * The test gate is split across parallel, SHARDED jobs. That is only safe while
 * three things hold, and each of them is one careless edit away from silently
 * not holding — with every job still green:
 *
 *   1. WHAT RUNS. Each prerequisite job runs its real suite, exactly once,
 *      unconditionally. A step-level `if:`, a `continue-on-error:`, a
 *      `shell: bash -n {0}` (syntax-check only), a job-level `defaults.run`,
 *      an npm pre/post lifecycle hook, or an alias rewritten to `:` all keep
 *      the job green while running nothing — or running the unsharded suite
 *      twice.
 *   2. HOW IT IS SPLIT. Single-dimension `shard: [1..N]` matrices whose count
 *      comes from `strategy.job-total`, so every index/count pair is coherent
 *      and the union of shards is the whole inventory.
 *   3. WHAT IS AGGREGATED. The required check is the job id `test` — an added
 *      `name:` or matrix would rename it and leave branch protection waiting
 *      for a check that never reports — and it must need every split job under
 *      a bare `always()`.
 *
 * Plus the inventory itself: every database test file on disk must be selected
 * by the `db` project (a narrowed include would drop 126 pglite files while
 * both shards stay green) and by no other project.
 *
 * Run as a CLI (`node scripts/ci/workflow-contract.mjs`) by its own CI job, and
 * imported by src/test/rehearsalSharding.test.ts so `npm test` covers it
 * locally. Same code both ways — a contract checked only where it might be
 * disabled is not checked.
 */
import { readFileSync, readdirSync, globSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The gate's prerequisites and the exact command each must run. */
export const PREREQUISITE_RUNS = {
  'unit-tests': 'npm run test:unit',
  'db-tests': 'npm run test:db -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}',
  'db-rehearsals': 'npm run db:rehearse:all -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}',
  i18n: 'bun scripts/check-i18n-parity.ts',
  'workflow-contract': 'node scripts/ci/workflow-contract.mjs',
};

/** Jobs whose suite is split by a `shard` matrix. */
export const SHARDED_JOBS = ['db-tests', 'db-rehearsals'];

/** Every gated suite command must appear in exactly ONE step of the workflow. */
const SUITE_MARKERS = [
  'npm run test:unit',
  'npm run test:db',
  'npm run db:rehearse:all',
  'check-i18n-parity',
  'workflow-contract.mjs',
];

/** npm scripts the workflow invokes, and the exact command each must be. */
const PINNED_SCRIPTS = {
  'test:unit': 'vitest run --project unit',
  'test:db': 'vitest run --project db',
  'db:rehearse:all': 'node scripts/db/run-all-rehearsals.mjs',
  // The local/ci-equivalent full gate stays unsharded — CI sharding must never
  // become the only way to run the suite.
  test: 'vitest run --project unit && vitest run --project db',
};

// `npm run test:db -- --shard=…` forwards the args to the SCRIPT only; a
// pre-hook would run the whole unsharded project first, on every shard.
const FORBIDDEN_LIFECYCLE_HOOKS = [
  'pretest', 'posttest',
  'pretest:unit', 'posttest:unit',
  'pretest:db', 'posttest:db',
  'predb:rehearse:all', 'postdb:rehearse:all',
];

/** `bash -n` syntax-checks instead of running; anything but a real shell is a bypass. */
const ALLOWED_STEP_SHELLS = ['bash', 'sh'];

function checkStepIsUnweakened(step, where, violations) {
  if (step.if !== undefined) violations.push(`${where}: step has an \`if:\` — it can silently skip its suite`);
  if (step['continue-on-error'] !== undefined) {
    violations.push(`${where}: step sets \`continue-on-error\` — a failed suite would report green`);
  }
  if (step.shell !== undefined && !ALLOWED_STEP_SHELLS.includes(step.shell)) {
    violations.push(`${where}: step overrides \`shell: ${step.shell}\` — only ${ALLOWED_STEP_SHELLS.join('/')} actually run the command`);
  }
}

function checkJobIsUnweakened(job, where, violations, { allowIf = false } = {}) {
  if (job === undefined) {
    violations.push(`${where}: job is missing from the workflow`);
    return false;
  }
  // The aggregator legitimately carries `if: always()` — its exact value is
  // asserted separately. Every other job must be unconditional.
  if (!allowIf && job.if !== undefined) violations.push(`${where}: job has an \`if:\` — it can skip entirely`);
  if (job['continue-on-error'] !== undefined) {
    violations.push(`${where}: job sets \`continue-on-error\` — its failure would reach the gate as success`);
  }
  if (job.defaults?.run?.shell !== undefined && !ALLOWED_STEP_SHELLS.includes(job.defaults.run.shell)) {
    violations.push(`${where}: job sets \`defaults.run.shell: ${job.defaults.run.shell}\` — every step would stop really running`);
  }
  return true;
}

/** Files the `db` vitest project must own: the naming convention, derived independently. */
function databaseTestFilesOnDisk(repoRoot) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(repoRoot, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.(pglite|realpg)\.test\.ts$/.test(entry.name)) out.push(next);
    }
  };
  walk('src');
  return out.sort();
}

// `**/*.pglite.test.ts` is unanchored, so without the exclude it walks
// node_modules on every call — seconds per pattern.
const globFiles = (patterns, repoRoot) =>
  [...new Set((patterns ?? []).flatMap((p) => globSync(p, { cwd: repoRoot, exclude: (name) => name === 'node_modules' })))]
    .map((f) => f.split('\\').join('/'))
    .sort();

/**
 * Returns a list of human-readable contract violations. Empty means the gate
 * still means what it claims to mean.
 */
export async function checkWorkflowContract({ repoRoot = REPO_ROOT } = {}) {
  const violations = [];
  const workflow = parseYaml(readFileSync(join(repoRoot, '.github/workflows/test.yml'), 'utf8'));
  const jobs = workflow.jobs ?? {};

  // ── 1. Concurrency: PR runs cancel only their own PR; pushes never cancel ──
  const group = workflow.concurrency?.group ?? '';
  if (!group.includes('github.event.pull_request.number') || !group.includes('github.run_id')) {
    violations.push(
      'concurrency.group must key PRs by pull_request.number and pushes by run_id — a branch-name key collides across forks and can cancel another run',
    );
  }
  if (workflow.concurrency?.['cancel-in-progress'] !== "${{ github.event_name == 'pull_request' }}") {
    violations.push('concurrency.cancel-in-progress must be PR-only — a push run must never be cancelled');
  }

  // ── 2. Each prerequisite job runs its real suite, exactly once, unweakened ──
  for (const [name, expected] of Object.entries(PREREQUISITE_RUNS)) {
    const job = jobs[name];
    if (!checkJobIsUnweakened(job, name, violations)) continue;
    const steps = job.steps ?? [];
    const matches = steps.filter((s) => (s.run ?? '').trim() === expected);
    if (matches.length !== 1) {
      violations.push(`${name}: expected exactly 1 step running \`${expected}\`, found ${matches.length}`);
      continue;
    }
    checkStepIsUnweakened(matches[0], name, violations);
  }

  // ── 3. No second invocation of a gated suite anywhere in the workflow ──
  for (const marker of SUITE_MARKERS) {
    const found = Object.entries(jobs).flatMap(([jobName, job]) =>
      (job.steps ?? []).filter((s) => (s.run ?? '').includes(marker)).map(() => jobName),
    );
    if (found.length !== 1) {
      violations.push(`suite command \`${marker}\` must run in exactly 1 step, found ${found.length} (${found.join(', ') || 'none'})`);
    }
  }

  // ── 4. Shard matrices: single dimension, exactly 1..N, no fail-fast ──
  for (const name of SHARDED_JOBS) {
    const strategy = jobs[name]?.strategy;
    const matrix = strategy?.matrix;
    if (!matrix) {
      violations.push(`${name}: missing strategy.matrix`);
      continue;
    }
    const keys = Object.keys(matrix);
    if (keys.length !== 1 || keys[0] !== 'shard') {
      violations.push(`${name}: matrix must have the single dimension \`shard\` (found ${keys.join(', ')}) — another dimension multiplies strategy.job-total and breaks every index/count pair`);
    }
    const shards = matrix.shard ?? [];
    const expected = Array.from({ length: shards.length }, (_, i) => i + 1);
    if (shards.length < 1 || JSON.stringify(shards) !== JSON.stringify(expected)) {
      violations.push(`${name}: shard list must be exactly [${expected.join(', ')}], found [${shards.join(', ')}]`);
    }
    if (strategy['fail-fast'] !== false) {
      violations.push(`${name}: strategy.fail-fast must be false — one shard failing must not cancel its sibling`);
    }
  }

  // ── 5. The required check: job id `test`, unrenamed, always(), needs all ──
  const gate = jobs.test;
  if (!checkJobIsUnweakened(gate, 'test (required gate)', violations, { allowIf: true })) {
    return violations;
  }
  if (gate.name !== undefined) {
    violations.push(`test: must not set \`name:\` (${gate.name}) — branch protection requires the check named "test"`);
  }
  if (gate.strategy !== undefined) {
    violations.push('test: must not use a matrix — it would suffix the emitted check name and branch protection would wait forever');
  }
  const expectedNeeds = Object.keys(PREREQUISITE_RUNS);
  if (JSON.stringify(gate.needs) !== JSON.stringify(expectedNeeds)) {
    violations.push(`test: needs must be exactly [${expectedNeeds.join(', ')}], found [${(gate.needs ?? []).join(', ')}]`);
  }
  // `always() && <anything>` can evaluate false, and a SKIPPED required check
  // does not block a merge in some tooling.
  if (gate.if !== 'always()') {
    violations.push(`test: \`if\` must be exactly always(), found ${JSON.stringify(gate.if)}`);
  }
  const gateSteps = gate.steps ?? [];
  if (gateSteps.length !== 1) {
    violations.push(`test: expected exactly 1 verification step, found ${gateSteps.length}`);
  } else {
    checkStepIsUnweakened(gateSteps[0], 'test (required gate)', violations);
    const script = gateSteps[0].run ?? '';
    const env = gateSteps[0].env ?? {};
    // The step must read EVERY prerequisite's result directly: a job dropped
    // from `needs:` expands to the empty string, which is not "success".
    for (const name of expectedNeeds) {
      const expr = `needs.${name}.result`;
      if (!Object.values(env).some((v) => typeof v === 'string' && v.includes(expr))) {
        violations.push(`test: verification step must read \${{ ${expr} }} into an env var`);
      }
    }
    if (!script.includes('set -euo pipefail')) {
      violations.push('test: verification step must run under `set -euo pipefail`');
    }
    if (!script.includes('join(needs.*.result')) {
      violations.push('test: verification step must also check join(needs.*.result) so a future prerequisite cannot be added unchecked');
    }
  }

  // ── 6. npm aliases still point at the real suites, with no lifecycle hooks ──
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(PINNED_SCRIPTS)) {
    if (pkg.scripts?.[name] !== command) {
      violations.push(`package.json scripts.${name} must be \`${command}\`, found \`${pkg.scripts?.[name]}\``);
    }
  }
  for (const hook of FORBIDDEN_LIFECYCLE_HOOKS) {
    if (pkg.scripts?.[hook] !== undefined) {
      violations.push(`package.json scripts.${hook} exists — an npm lifecycle hook runs OUTSIDE the sharded invocation, re-running the full suite on every shard`);
    }
  }

  // ── 7. The db project still selects every database test file, exclusively ──
  // Loaded through vite's own config loader, so this is the EFFECTIVE config
  // vitest will use — not a re-parse that could disagree with it. (A plain
  // `import` cannot: the config uses __dirname, which is CJS-only.)
  const { loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    join(repoRoot, 'vitest.config.ts'),
    repoRoot,
  );
  const config = loaded?.config ?? {};
  const projects = config.test?.projects ?? [];
  const byName = Object.fromEntries(projects.map((p) => [p.test?.name, p.test]));
  const db = byName.db;
  const unit = byName.unit;
  if (!db || !unit) {
    violations.push('vitest.config.ts must define both the `unit` and `db` projects');
    return violations;
  }
  if (db.fileParallelism !== false) {
    violations.push('vitest.config.ts: the db project must keep fileParallelism: false — one database at a time is the determinism safeguard sharding must not undo');
  }
  const onDisk = databaseTestFilesOnDisk(repoRoot);
  const selected = globFiles(db.include, repoRoot);
  const missing = onDisk.filter((f) => !selected.includes(f));
  if (missing.length > 0) {
    violations.push(`vitest.config.ts: ${missing.length} database test file(s) match no db-project include and would run NOWHERE, e.g. ${missing.slice(0, 3).join(', ')}`);
  }
  const unitExcluded = new Set(globFiles(unit.exclude, repoRoot));
  const unitSelected = new Set(globFiles(unit.include, repoRoot).filter((f) => !unitExcluded.has(f)));
  const both = selected.filter((f) => unitSelected.has(f));
  if (both.length > 0) {
    violations.push(`vitest.config.ts: ${both.length} file(s) are selected by BOTH projects and would run twice, e.g. ${both.slice(0, 3).join(', ')}`);
  }

  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = await checkWorkflowContract();
  if (violations.length > 0) {
    console.error(`CI gate contract violated (${violations.length}):`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log('CI gate contract holds.');
}
