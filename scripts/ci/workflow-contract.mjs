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
 * Run as a CLI (`node scripts/ci/workflow-contract.mjs`) by its own CI job AND
 * by `lint` — an independently required check that nothing aggregates, so a
 * weakening the aggregator could swallow still turns a required check red —
 * and imported by src/test/rehearsalSharding.test.ts so `npm test` covers it
 * locally. Same code every way: a contract checked only where it might be
 * disabled is not checked.
 *
 * ── WHAT THIS DOES NOT DEFEND AGAINST ─────────────────────────────────────
 *
 * A trusted contributor who deliberately rewrites the workflow, this checker
 * and its tests in one PR. That is not solvable from inside the repository:
 * any in-repo guard is itself repo content. The clearest example is a
 * workflow-level `env: SHELLOPTS: noexec`, which makes every bash `run:` parse
 * without executing and exit 0 — including both copies of this checker, so it
 * never runs to report the variable it would otherwise reject. The answer to
 * that class is governance (a CODEOWNERS entry for /.github/, or requiring
 * review), which is deliberately NOT attempted here.
 *
 * What it does defend against, and what its tests are written for: accidental
 * weakening, configuration drift, suite omissions, shard mistakes, and
 * ordinary dependency or tooling changes.
 */
import { existsSync, readFileSync, readdirSync, globSync } from 'node:fs';
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

/**
 * This checker's own command, and every job that must run it.
 *
 * `workflow-contract` alone is NOT enough: it is a prerequisite of `test`, and
 * a `continue-on-error: true` on the aggregator's step makes `test` tolerate
 * its own failed verification — so the checker would correctly detect the
 * weakening, fail its job, and be ignored. `lint` is an independently REQUIRED
 * branch-protection context that nothing aggregates, so a copy there turns any
 * such edit into a red required check that no aggregator can swallow.
 */
export const CONTRACT_CMD = 'node scripts/ci/workflow-contract.mjs';
export const CONTRACT_JOBS = ['lint', 'workflow-contract'];

/**
 * Any step that looks like it runs a gated suite — by alias OR directly
 * (`npx vitest run --project db`, `node scripts/db/run-all-rehearsals.mjs`) —
 * must be one of the pinned invocations above. A direct call matches no alias
 * marker, so an allow-list of exact commands is the only shape that cannot be
 * walked around.
 */
const SUITE_LIKE = /vitest|rehears|check-i18n-parity|workflow-contract|test:unit|test:db|i18n:check|\bnpm\b[^\n]*\btest\b/;

/** The exact concurrency contract (see the workflow's own comment for why). */
const EXPECTED_CONCURRENCY = {
  group:
    "${{ github.workflow }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.run_id }}",
  'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
};

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

/**
 * bash only. `bash -n {0}` syntax-checks instead of running, and `sh` on the
 * runner is dash — which rejects the gate's `set -euo pipefail` and would fail
 * the required check even when every prerequisite passed.
 */
const ALLOWED_STEP_SHELLS = ['bash'];

/**
 * Steps that must pin `shell: bash` EXPLICITLY. A workflow-level
 * `defaults.run.shell: bash -n {0}` would otherwise neuter every run step at
 * once — including this checker, so it could not report its own disabling.
 * An explicit shell on these two makes them immune to that default, and the
 * checker then flags the default itself.
 */
const MUST_PIN_BASH = { 'workflow-contract': 'the contract checker', lint: 'the contract checker copy', test: 'the aggregator gate' };

/**
 * Environment variables that turn a real command into a no-op, in any scope.
 * `SHELLOPTS=noexec` makes bash PARSE every gated step and execute nothing,
 * exiting 0; `BASH_ENV` is sourced by non-interactive bash (which is what
 * `shell: bash` runs) so it can `exit 0` before the step body; NODE_OPTIONS
 * can `--require` a module that does the same to the node-based steps; and
 * npm's `script-shell` replaces the shell every `npm run` uses. Pinning
 * `shell: bash` does not defend against any of them — they act inside it.
 */
const NEUTERING_ENV_VARS = [
  'npm_config_script_shell',
  // npm passes this to node for every `npm run`, so
  // `--import=data:text/javascript,process.exit(0)` makes a suite exit 0 in
  // ~0.5s with nothing run — while a direct `node` step stays honest.
  'npm_config_node_options',
  // Redirects npm at a different config file entirely, which can carry
  // script-shell or node-options, bypassing the .npmrc scan below.
  'npm_config_userconfig',
  'npm_config_globalconfig',
  'shellopts',
  'bash_env',
  'node_options',
];
const neuteringEnvVar = (key) => {
  const normalized = key.toLowerCase().replace(/-/g, '_');
  return NEUTERING_ENV_VARS.find((v) => v === normalized);
};

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

/** Every file under src/ matching `pattern`, walked independently of any config. */
function walkSrc(repoRoot, pattern) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(repoRoot, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (pattern.test(entry.name)) out.push(next);
    }
  };
  walk('src');
  return out.sort();
}

/**
 * Files the db project must own by NAME, beyond the *.pglite/*.realpg
 * convention: this one boots a real embedded Postgres but is named like an
 * ordinary integration test, so only an explicit entry keeps it from drifting
 * into the parallel unit project.
 */
const DB_OWNED_BY_NAME = ['src/test/notificationDigestRealPg.integration.test.ts'];

/** Files the `db` vitest project must own — convention plus the named exceptions. */
const databaseTestFilesOnDisk = (repoRoot) => {
  // `.tsx?`, deliberately wider than vitest.config.ts's `.ts`-only include: a
  // database test named *.pglite.test.tsx would be selected by the UNIT project
  // (jsdom, fileParallelism ON) — the exact contention the project split exists
  // to prevent. Catching it here turns that into a contract failure telling the
  // author to widen the include, instead of a silently mis-scheduled database.
  const byConvention = walkSrc(repoRoot, /\.(pglite|realpg)\.test\.tsx?$/);
  return [...new Set([...byConvention, ...DB_OWNED_BY_NAME])].sort();
};

/**
 * Named exceptions that no longer exist. Filtering them out silently was the
 * hole: renaming notificationDigestRealPg.integration.test.ts to any other
 * ordinary `.integration.test.ts` name moves a real-Postgres test into the
 * PARALLEL unit project, and an existence filter would call that fine.
 */
const missingNamedDbFiles = (repoRoot) => DB_OWNED_BY_NAME.filter((f) => !existsSync(join(repoRoot, f)));

/** The whole test inventory: what SOME project must select, exactly once. */
const testFilesOnDisk = (repoRoot) => walkSrc(repoRoot, /\.(test|spec)\.tsx?$/);

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
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const pkgScripts = pkg.scripts ?? {};

  // ── 1. Concurrency: PR runs cancel only their own PR; pushes never cancel ──
  // Exact equality, not "contains the right tokens": an expression can hold
  // both tokens with the branches SWAPPED (pushes sharing one group, PRs
  // unique per run) — the precise inversion of the intended behavior.
  for (const [key, expected] of Object.entries(EXPECTED_CONCURRENCY)) {
    const actual = workflow.concurrency?.[key];
    if (actual !== expected) {
      violations.push(`concurrency.${key} must be exactly \`${expected}\`, found \`${actual}\``);
    }
  }

  // ── 1b. Least privilege, and no token left lying in the workspace ──
  // Eleven runner instances now check out this repo and then execute repo code
  // (tests, rehearsals, postinstall). A write-scoped token persisted into
  // .git/config by actions/checkout would be readable by any of them.
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: 'read' })) {
    violations.push(`workflow permissions must be exactly {contents: read}, found ${JSON.stringify(workflow.permissions)}`);
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout') && step.with?.['persist-credentials'] !== false) {
        violations.push(`${jobName}: checkout must set persist-credentials: false — otherwise the job leaves a usable token in .git/config`);
      }
    }
  }

  // A workflow-level shell default neuters EVERY run step at once, including
  // this checker's own job and the aggregator.
  if (workflow.defaults?.run?.shell !== undefined && !ALLOWED_STEP_SHELLS.includes(workflow.defaults.run.shell)) {
    violations.push(`workflow defaults.run.shell: ${workflow.defaults.run.shell} — no run step would really execute`);
  }

  // ── 2. Each gated job runs its real command, exactly once, unweakened ──
  // `lint` is in here as well as the five prerequisites: it hosts the
  // independent copy of this checker, and a `continue-on-error: true` on THAT
  // step would let the one job that cannot be swallowed by the aggregator
  // swallow the detection itself.
  const GATED_JOB_COMMANDS = { ...PREREQUISITE_RUNS, lint: CONTRACT_CMD };
  for (const [name, expected] of Object.entries(GATED_JOB_COMMANDS)) {
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

  // ── 3. Every suite-like step in the workflow is one of the pinned ones ──
  const expectedRuns = Object.values(PREREQUISITE_RUNS);
  const suiteLikeSteps = Object.entries(jobs).flatMap(([jobName, job]) =>
    // The gate job is exempt: it names its prerequisites in its own script, and
    // it is separately pinned to exactly one (non-suite) verification step.
    (jobName === 'test' ? [] : job.steps ?? [])
      .map((s) => (s.run ?? '').trim())
      .filter((run) => SUITE_LIKE.test(run))
      .map((run) => ({ jobName, run })),
  );
  for (const { jobName, run } of suiteLikeSteps) {
    if (!expectedRuns.includes(run)) {
      violations.push(`${jobName}: unexpected suite invocation \`${run}\` — a second (or direct, un-sharded) run duplicates work and hides shard imbalance`);
    }
  }
  for (const expected of expectedRuns) {
    const runningJobs = suiteLikeSteps.filter((s) => s.run === expected).map((s) => s.jobName).sort();
    // Every suite runs in exactly one job — except this checker, which must run
    // in both its own job and the independently-required `lint` job.
    const wanted = expected === CONTRACT_CMD ? [...CONTRACT_JOBS].sort() : null;
    if (wanted) {
      if (JSON.stringify(runningJobs) !== JSON.stringify(wanted)) {
        violations.push(`the contract checker must run in exactly [${wanted.join(', ')}], found [${runningJobs.join(', ') || 'none'}] — a copy in an independently required job is what stops the aggregator from swallowing its own failed verification`);
      }
    } else if (runningJobs.length !== 1) {
      violations.push(`suite command \`${expected}\` must run in exactly 1 step, found ${runningJobs.length}`);
    }
  }

  // Install lifecycle hooks run OUTSIDE any gated command, in every job that
  // installs — a `postinstall` running the db project would execute the whole
  // unsharded suite on every runner without touching a single pinned step.
  // Exactly the hooks `npm ci` / `npm install` fire. `prepublish` is deprecated
  // for publishing but STILL runs on install; `prepare` is wrapped by
  // `preprepare`/`postprepare`. `prepack`/`postpack` are pack/publish-time only
  // and were noise here.
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    const command = pkgScripts[hook];
    if (typeof command === 'string' && SUITE_LIKE.test(command)) {
      violations.push(`package.json scripts.${hook} runs a gated suite (\`${command}\`) — install hooks run outside the sharded invocation, on every installing job`);
    }
  }

  // npm's script-shell can be redirected repo-wide (.npmrc) or per step
  // (npm_config_script_shell), making every `npm run …` exit 0 without running
  // anything — while this checker, a direct node call, stays green.
  let npmrc = '';
  try {
    npmrc = readFileSync(join(repoRoot, '.npmrc'), 'utf8');
  } catch {
    npmrc = '';
  }
  for (const key of ['script-shell', 'node-options', 'userconfig', 'globalconfig']) {
    if (new RegExp(`^\\s*${key}\\s*=`, 'm').test(npmrc)) {
      violations.push(`.npmrc sets ${key} — it can make every \`npm run\` in CI exit 0 without running its suite`);
    }
  }
  const envScopes = [
    ['workflow', workflow.env ?? {}],
    ...Object.entries(jobs).flatMap(([jobName, job]) => [
      [jobName, job.env ?? {}],
      [`${jobName}.container`, job.container?.env ?? {}],
      ...(job.steps ?? []).map((s) => [jobName, s.env ?? {}]),
    ]),
  ];
  for (const [scope, env] of envScopes) {
    for (const key of Object.keys(env)) {
      const neutering = neuteringEnvVar(key);
      if (neutering) {
        violations.push(`${scope}: sets ${key} — it can make gated steps exit 0 without running (see NEUTERING_ENV_VARS)`);
      }
    }
  }

  // A prerequisite that waits on another prerequisite, or a matrix capped to
  // one runner at a time, silently rebuilds the serial job this PR replaced —
  // green, correct, and slow again.
  for (const name of Object.keys(PREREQUISITE_RUNS)) {
    const job = jobs[name];
    if (job?.needs !== undefined) {
      violations.push(`${name}: prerequisite jobs must not declare \`needs\` (found ${JSON.stringify(job.needs)}) — they must all start at once`);
    }
    if (job?.strategy?.['max-parallel'] !== undefined) {
      violations.push(`${name}: strategy.max-parallel re-serialises the shards`);
    }
  }
  for (const name of SHARDED_JOBS) {
    // A job-level concurrency group shared by both matrix children queues them
    // one behind the other — the serial suite again, with every check green.
    // A group that varies per shard is fine, so require matrix.shard in it.
    const group = jobs[name]?.concurrency?.group ?? jobs[name]?.concurrency;
    if (group !== undefined && !String(group).includes('matrix.shard')) {
      violations.push(`${name}: job-level concurrency \`${group}\` is shared by every shard — the matrix children would run one at a time`);
    }
  }

  // The two steps that must survive a hostile workflow default. (Their setup
  // steps need no pin: a neutered `npm ci` leaves no node_modules, so the
  // pinned step below then fails to import — fail-closed either way.)
  for (const [jobName, description] of Object.entries(MUST_PIN_BASH)) {
    const steps = (jobs[jobName]?.steps ?? []).filter((s) => s.run !== undefined);
    const critical = jobName === 'test'
      ? steps
      : steps.filter((s) => (s.run ?? '').trim() === CONTRACT_CMD);
    if (critical.length === 0 || critical.some((s) => s.shell !== 'bash')) {
      violations.push(`${jobName}: ${description} must pin \`shell: bash\` explicitly, or a workflow-level defaults.run.shell could neuter it`);
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

  // ── 5b. No rehearsal hidden in a subdirectory ──
  // The runner discovers with a NON-recursive readdir, and the exactly-once test
  // compares the shard union against that same function — self-consistent, so a
  // rehearsal moved into scripts/db/<subdir>/ would run zero times with every
  // check green. Fail closed on the placement instead.
  const rehearsalDir = join(repoRoot, 'scripts/db');
  if (existsSync(rehearsalDir)) {
    const strays = [];
    const walkForStrays = (rel) => {
      for (const entry of readdirSync(join(rehearsalDir, rel), { withFileTypes: true })) {
        if (entry.isDirectory()) walkForStrays(join(rel, entry.name));
        else if (rel !== '.' && /^rehearse-.*\.(mjs|ts)$/.test(entry.name)) strays.push(join(rel, entry.name));
      }
    };
    walkForStrays('.');
    if (strays.length > 0) {
      violations.push(`scripts/db: rehearsal(s) in a subdirectory would be discovered by nothing and run zero times: ${strays.join(', ')}`);
    }
  }

  // ── 6. npm aliases still point at the real suites, with no lifecycle hooks ──
  for (const [name, command] of Object.entries(PINNED_SCRIPTS)) {
    if (pkgScripts[name] !== command) {
      violations.push(`package.json scripts.${name} must be \`${command}\`, found \`${pkgScripts[name]}\``);
    }
  }
  for (const hook of FORBIDDEN_LIFECYCLE_HOOKS) {
    if (pkgScripts[hook] !== undefined) {
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
  // A custom sequencer replaces the audited BaseSequencer.shard() — the one
  // piece of the partition this repo delegates rather than implements. One that
  // returned the same half for both indices would run 71 files twice and 71
  // never, with every other check still green.
  for (const [label, cfg] of [['root', config.test], ['unit', unit], ['db', db]]) {
    if (cfg?.sequence?.sequencer !== undefined) {
      violations.push(`vitest.config.ts: ${label} defines a custom sequence.sequencer — the shard partition depends on vitest's own BaseSequencer (pinned by src/test/rehearsalSharding.test.ts)`);
    }
  }
  if (db.fileParallelism !== false) {
    violations.push('vitest.config.ts: the db project must keep fileParallelism: false — one database at a time is the determinism safeguard sharding must not undo');
  }
  // EFFECTIVE selection per project: include minus the project's own exclude
  // and any inherited root-level exclude. An exclude added to the db project
  // would otherwise be invisible here while removing files from the run.
  const rootExcluded = globFiles(config.test?.exclude, repoRoot);
  const effective = (project) => {
    const excluded = new Set([...globFiles(project.exclude, repoRoot), ...rootExcluded]);
    return globFiles(project.include, repoRoot).filter((f) => !excluded.has(f));
  };
  const dbSelected = effective(db);
  const unitSelected = effective(unit);

  // Independent inventory: EVERY test file under src/, derived from the naming
  // convention by its own walk — not from the config being checked. Comparing
  // against the union catches a narrowed include on EITHER project (files that
  // would run nowhere), and the intersection catches files that would run twice.
  const inventory = testFilesOnDisk(repoRoot);
  const selectedOnce = new Set([...dbSelected, ...unitSelected]);
  const nowhere = inventory.filter((f) => !selectedOnce.has(f));
  if (nowhere.length > 0) {
    violations.push(`vitest.config.ts: ${nowhere.length} test file(s) are selected by NO project and would run nowhere, e.g. ${nowhere.slice(0, 3).join(', ')}`);
  }
  const unitSet = new Set(unitSelected);
  const both = dbSelected.filter((f) => unitSet.has(f));
  if (both.length > 0) {
    violations.push(`vitest.config.ts: ${both.length} file(s) are selected by BOTH projects and would run twice, e.g. ${both.slice(0, 3).join(', ')}`);
  }
  const unexpected = [...selectedOnce].filter((f) => !inventory.includes(f));
  if (unexpected.length > 0) {
    violations.push(`vitest.config.ts: ${unexpected.length} selected file(s) are outside the src test inventory, e.g. ${unexpected.slice(0, 3).join(', ')}`);
  }
  // The database naming convention must land in the db project specifically —
  // where fileParallelism: false (one database at a time) actually applies.
  const missingNamed = missingNamedDbFiles(repoRoot);
  if (missingNamed.length > 0) {
    violations.push(`DB_OWNED_BY_NAME lists file(s) that no longer exist (${missingNamed.join(', ')}) — if one was renamed it has silently moved into the parallel unit project; update BOTH the vitest include and that list`);
  }
  const misfiled = databaseTestFilesOnDisk(repoRoot).filter((f) => unitSet.has(f) || !dbSelected.includes(f));
  if (misfiled.length > 0) {
    violations.push(`vitest.config.ts: ${misfiled.length} database test file(s) are not owned by the db project, e.g. ${misfiled.slice(0, 3).join(', ')}`);
  }

  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Optional repo root: CI passes none (this repo); the tests point it at
  // deliberately-broken fixture trees to prove the exit-1 path is wired.
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : REPO_ROOT;
  const violations = await checkWorkflowContract({ repoRoot });
  if (violations.length > 0) {
    console.error(`CI gate contract violated (${violations.length}):`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log('CI gate contract holds.');
}
