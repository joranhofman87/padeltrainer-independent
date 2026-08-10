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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseIni } from 'ini';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The gate's prerequisites and the exact command each must run. */
export const PREREQUISITE_RUNS = {
  'unit-tests': 'npm run test:unit',
  'db-tests': 'npm run test:db -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}',
  'db-rehearsals': 'npm run db:rehearse:all -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}',
  i18n: 'bun scripts/check-i18n-parity.ts',
  'workflow-contract': 'node scripts/ci/workflow-contract.mjs',
};

/**
 * Exactly what each gated job may RUN. A positive list, because the previous
 * rule ("no step may run a gated suite twice") let arbitrary OTHER commands in
 * — and a step as ordinary as `cp ci/npmrc "$HOME/.npmrc"` writes npm's user
 * config after npm loaded its own, so every later `npm run` in that job can be
 * neutered without touching a repository .npmrc, an npm_config_* variable, or
 * a working directory. Config layers outside the repo cannot be validated from
 * inside it; what CAN be bounded is the set of commands that run before a
 * suite, so that is bounded here. Adding a step is a reviewed edit.
 *
 * Only gated jobs are listed: every GitHub job gets its own runner, so a write
 * to $HOME elsewhere cannot reach the runner a suite executes on.
 */
export const APPROVED_JOB_RUNS = {
  lint: [
    'npm ci',
    'npm run lint',
    'npm run check:edge-config',
    'npm run check:legacy-key:selftest',
    'npm run check:legacy-key',
    'npm run check:edge-pins:selftest',
    'npm run check:edge-pins',
    'node scripts/ci/workflow-contract.mjs',
  ],
  'unit-tests': ['npm ci', 'npm run test:unit'],
  'db-tests': ['npm ci', 'npm run test:db -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}'],
  'db-rehearsals': ['npm ci', 'npm run db:rehearse:all -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}'],
  i18n: ['bun scripts/check-i18n-parity.ts'],
  'workflow-contract': ['npm ci', 'node scripts/ci/workflow-contract.mjs'],
};

/**
 * The exact, ORDERED steps of every job that backs a required status check.
 *
 * One sequence per job, actions and commands together, because splitting them
 * hid two holes: an approved action could be dropped (the suite then runs on
 * whatever Node the runner image ships) or REORDERED below the command that
 * depends on it, and neither changed the set of actions or the set of
 * commands. Order is the property that matters, so order is what is pinned.
 *
 * Covers the branch-required contexts (lint, typecheck, test, edge-tests,
 * edge-typecheck) as well as the aggregator's prerequisites: `ref: main` on
 * typecheck, or an `if:` on the edge-tests suite, would otherwise leave a
 * required check green while validating something other than this PR.
 *
 * The aggregator's own program is the one entry not compared as text — it is
 * verified by EXECUTION in aggregatorTruthTable().
 */
/**
 * The runner every required job must use.
 *
 * The step contract is only sound because each GitHub-hosted job gets a fresh,
 * isolated machine — that is what makes a $HOME write in one job unable to
 * reach another's suite. A self-hosted or custom-labelled runner can be
 * persistent and shared, so the isolation model is asserted, not assumed.
 */
const APPROVED_RUNNER = 'ubuntu-latest';

const AGGREGATOR_PROGRAM = Symbol('aggregator program, verified by execution');
export const APPROVED_JOB_STEPS = {
  lint: [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "actions/setup-node@v4", with: { "node-version": "24", cache: "npm" } },
    { run: "npm ci" },
    { run: "npm run lint" },
    { run: "npm run check:edge-config" },
    { run: "npm run check:legacy-key:selftest" },
    { run: "npm run check:legacy-key" },
    { run: "npm run check:edge-pins:selftest" },
    { run: "npm run check:edge-pins" },
    { run: "node scripts/ci/workflow-contract.mjs" },
  ],
  typecheck: [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "actions/setup-node@v4", with: { "node-version": "24", cache: "npm" } },
    { run: "npm ci" },
    { run: "npm run typecheck:baseline" },
    { run: "npm run build" },
  ],
  "unit-tests": [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "actions/setup-node@v4", with: { "node-version": "24", cache: "npm" } },
    { run: "npm ci" },
    { run: "npm run test:unit" },
  ],
  "db-tests": [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "actions/setup-node@v4", with: { "node-version": "24", cache: "npm" } },
    { run: "npm ci" },
    { run: "npm run test:db -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}" },
  ],
  "db-rehearsals": [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "actions/setup-node@v4", with: { "node-version": "24", cache: "npm" } },
    { run: "npm ci" },
    { run: "npm run db:rehearse:all -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}" },
  ],
  i18n: [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "oven-sh/setup-bun@v2", with: { "bun-version": "latest" } },
    { run: "bun scripts/check-i18n-parity.ts" },
  ],
  "workflow-contract": [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "actions/setup-node@v4", with: { "node-version": "24", cache: "npm" } },
    { run: "npm ci" },
    { run: "node scripts/ci/workflow-contract.mjs" },
  ],
  test: [
    { run: AGGREGATOR_PROGRAM }, // verified by aggregatorTruthTable(), not by text
  ],
  "edge-tests": [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "denoland/setup-deno@v2", with: { "deno-version": "v2.x" } },
    { run: "deno test --no-check --allow-env --allow-net supabase/functions/_shared/" },
  ],
  "edge-typecheck": [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "actions/setup-node@v4", with: { "node-version": "24", cache: "npm" } },
    { run: "npm ci" },
    { uses: "denoland/setup-deno@v2", with: { "deno-version": "v2.x" } },
    { run: "npm run check:edge-types:selftest" },
    { run: "npm run check:edge-types" },
  ],
};

/**
 * Install lifecycle hooks the repository is allowed to define: none.
 *
 * Previously a hook was only rejected when it ran a gated suite, which left
 * `postinstall: cp ci/npmrc "$HOME/.npmrc"` — arbitrary code on every runner,
 * before every suite — perfectly acceptable. The repository defines no install
 * hooks today, so an empty allowlist costs nothing and makes adding one a
 * reviewed decision rather than a silent one.
 */
export const APPROVED_INSTALL_HOOKS = new Set();

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
const SUITE_MARKERS = /vitest|rehears|check-i18n-parity|workflow-contract|test:unit|test:db|i18n:check/;

/**
 * Every npm subcommand that runs the root test script, read out of this repo's
 * npm 11.12.1 `lib/utils/cmd-list.js` (aliases + the abbrev table): `test` with
 * aliases t/tst/ts/tes, and the install-then-test commands with theirs.
 * Exotic unique-prefix abbreviations (`npm install-ci-t`) are not enumerated —
 * npm's abbrev table is version-specific, and no realistic step spells it that
 * way; every documented spelling is covered.
 */
const NPM_TEST_SUBCOMMANDS = new Set([
  'test', 't', 'tes', 'tst', 'ts',
  'it', 'install-test', 'cit', 'install-ci-test', 'sit', 'si', 'clean-install-test',
]);

/** A script name that names a test target: `test`, `test:db`, `x-tst`, but NOT `selftest`. */
const NAMES_A_TEST_TARGET = /(^|[-:_.])(t|tst|test)($|[-:_.])/i;

/**
 * Does this `run:` block invoke one of the gated suites, however it is spelled?
 *
 * Tokenized rather than pattern-matched, because the spellings kept escaping
 * regexes: `npm test`, `npm run test:db`, `npm --silent test`, `npm t`, `npm
 * tst`, and a backslash-continued line splitting `npm` from its subcommand.
 * Errs toward saying yes: a false positive means a new step must be added to
 * the pinned allow-list, while a false negative means a suite silently runs
 * twice.
 */
/** npm subcommands that MUTATE configuration, with npm 11's aliases/abbrevs. */
const NPM_CONFIG_SUBCOMMANDS = new Set(['config', 'c', 'con', 'conf', 'confi', 'set', 'get']);

/**
 * Does this command mutate npm's configuration at runtime?
 *
 * `npm config set script-shell=/bin/true --location=project` rewrites the very
 * .npmrc the allowlist above validates, on that runner only, after this
 * checker has already looked. Nothing in this workflow legitimately configures
 * npm at runtime, so any such invocation is refused.
 */
export function isNpmConfigMutation(run) {
  for (const args of npmInvocations(run)) {
    // `npm run <script>` takes arbitrary script names — `npm run set` is a
    // script called "set", not a config command — so a run invocation is never
    // a config one. Otherwise any bare word may be the subcommand, because a
    // flag with a separate operand (`npm --loglevel silent config set`) shifts
    // its position.
    if (args[0] === 'run' || args[0] === 'run-script') continue;
    if (args.some((a) => NPM_CONFIG_SUBCOMMANDS.has(a.toLowerCase()))) return true;
  }
  return false;
}

/**
 * The bare-word arguments of every npm invocation in a command, or [] if none.
 * Shared by the suite and config detectors so both see identical tokenization.
 */
function npmInvocations(run) {
  // A backslash-newline is a line continuation — one command, not two.
  const normalized = String(run ?? '').replace(/\\\r?\n/g, ' ');
  const unquote = (t) => t.replace(/^["']|["']$/g, '');
  const found = [];
  for (const segment of normalized.split(/[\n;&|]+/)) {
    let tokens = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
    // `FOO=bar npm test` is still an npm invocation; `echo npm test` is not.
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
    const command = tokens[0];
    if (command !== 'npm' && !(command ?? '').endsWith('/npm')) continue;
    found.push(tokens.slice(1).filter((t) => !t.startsWith('-')));
  }
  return found;
}

export function isSuiteInvocation(run) {
  if (SUITE_MARKERS.test(String(run ?? '').replace(/\\\r?\n/g, ' '))) return true;
  for (const args of npmInvocations(run)) {
    // Any bare word that IS a test subcommand — which also survives a flag
    // taking a separate operand, as in `npm --prefix . test`, where the
    // operand would otherwise be mistaken for the subcommand.
    if (args.some((a) => NPM_TEST_SUBCOMMANDS.has(a.toLowerCase()))) return true;
    // `npm run <script>` counts only when a whole segment of the script name is
    // a test target, so `check:edge-types:selftest` stays out.
    const runAt = args.findIndex((a) => a === 'run' || a === 'run-script');
    if (runAt !== -1 && args[runAt + 1] && NAMES_A_TEST_TARGET.test(args[runAt + 1])) return true;
  }
  return false;
}

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
/**
 * Hooks npm fires during `npm ci` — read out of the npm this repo uses
 * (11.12.1), not from memory: lib/commands/ci.js:107-110 runs prepublish →
 * preprepare → prepare → postprepare on the root package; @npmcli/arborist
 * rebuild.js (#build) runs preinstall, install and postinstall; reify.js:246
 * runs predependencies → dependencies → postdependencies whenever the
 * dependency tree actually changed. `prepack`/`postpack` are pack- and
 * publish-time only, and are deliberately absent.
 */
export const NPM_INSTALL_LIFECYCLE_HOOKS = [
  'preinstall', 'install', 'postinstall',
  'prepublish', 'preprepare', 'prepare', 'postprepare',
  'predependencies', 'dependencies', 'postdependencies',
];

/**
 * The repository's approved root `.npmrc`, exactly — key AND value.
 *
 * An ALLOWLIST, deliberately, after a blocklist lost six rounds in a row:
 * script-shell, node-options, userconfig, globalconfig, prefix, usage… npm has
 * more knobs than an auditor can enumerate, and each new one was a silent
 * pass. Here a setting that is not on this list is a violation whatever it
 * does, so a future npm option cannot be quietly introduced — adding one is a
 * reviewed change to this constant.
 */
const APPROVED_NPMRC = new Map([
  ['fetch-retries', '10'],
  ['fetch-retry-factor', '2'],
  ['fetch-retry-mintimeout', '30000'],
  ['fetch-retry-maxtimeout', '180000'],
  ['maxsockets', '1'],
  ['network-concurrency', '1'],
  ['prefer-offline', 'true'],
]);

/**
 * Parses an .npmrc into ORDERED entries using npm's own INI library, one line
 * at a time so duplicates and `[sections]` survive — `ini.parse()` of a whole
 * file silently collapses a duplicate key to its last value, which is exactly
 * the shape an override would take.
 */
export function parseNpmrcEntries(source) {
  const entries = [];
  const sections = [];
  for (const line of String(source).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parsed = parseIni(line);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) sections.push(key);
      else entries.push([key, value]);
    }
  }
  return { entries, sections };
}

/** Every violation in one .npmrc, measured against the approved set. */
function checkNpmrc(source, where) {
  const violations = [];
  const { entries, sections } = parseNpmrcEntries(source);
  for (const section of sections) {
    violations.push(`${where}: has a [${section}] section — the approved config is flat, and a section can carry settings this check would otherwise read as absent`);
  }
  const seen = new Set();
  for (const [rawKey, value] of entries) {
    const key = String(rawKey).trim();
    if (seen.has(key)) {
      violations.push(`${where}: sets \`${key}\` more than once — npm applies the last one, so a duplicate is an override hiding behind an approved line`);
      continue;
    }
    seen.add(key);
    if (!APPROVED_NPMRC.has(key)) {
      violations.push(`${where}: sets \`${key}\`, which is not in the approved npm configuration — add it to APPROVED_NPMRC in scripts/ci/workflow-contract.mjs if it is genuinely wanted`);
      continue;
    }
    const approved = APPROVED_NPMRC.get(key);
    if (String(value) !== approved) {
      violations.push(`${where}: sets \`${key}=${value}\`, but the approved value is \`${approved}\``);
    }
  }
  return violations;
}

/**
 * A group that really varies per shard: an Actions EXPRESSION referencing
 * matrix.shard (dot or bracket form). A literal `db-tests-matrix.shard`
 * contains the words and still gives both children one group — the substring
 * test this replaces accepted exactly that.
 */
function shardConcurrencyIsSafe(group) {
  const bodies = [...String(group).matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1].trim());
  // A DIRECT reference, not merely a mention: `${{ 'matrix.shard' }}` is a
  // string literal and `${{ matrix.shard && github.workflow }}` collapses to
  // the same value for every shard — both would serialise the children.
  const variesByShard = bodies.some((b) => /^matrix\s*(?:\.\s*shard|\[\s*(['"])shard\1\s*\])$/.test(b));
  // Job concurrency groups are repository-wide, so without run identity a
  // second PR's shard queues behind (or replaces) this one's.
  const isolatesRuns = bodies.some((b) => /\bgithub\s*\.\s*run_id\b/.test(b));
  return variesByShard && isolatesRuns;
}

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
 *
 * The npm side is a NAMESPACE rule, not a list. Enumerating dangerous npm
 * options lost repeatedly — script-shell, node-options, userconfig,
 * globalconfig, prefix, usage, if-present — because `npm_config_<anything>`
 * sets the corresponding npm option, so the list could never be finished.
 * No gated job has a legitimate reason to configure npm through the
 * environment, so the whole namespace is refused.
 *
 * The rest are the non-npm ways to the same place: bash startup controls, and
 * the HOME-like variables npm and other tools resolve their per-user config
 * from (a redirected HOME means a different .npmrc than the one checked above).
 */
const NPM_ENV_NAMESPACE = 'npm_config_';
const CONFIG_HOME_VARS = new Set(['home', 'userprofile', 'xdg_config_home', 'appdata', 'localappdata']);
const SHELL_CONTROL_VARS = new Set(['shellopts', 'bash_env', 'node_options']);

const normalizeEnvKey = (key) => String(key).toLowerCase().replace(/-/g, '_');

/** Why this env key is forbidden in a gated scope, or null if it is fine. */
function neuteringEnvVar(key) {
  const normalized = normalizeEnvKey(key);
  if (normalized.startsWith(NPM_ENV_NAMESPACE)) {
    return `it configures npm through the environment (${NPM_ENV_NAMESPACE}* is refused as a namespace, not key by key)`;
  }
  if (CONFIG_HOME_VARS.has(normalized)) {
    return 'it relocates the per-user config directory, so npm would read a different .npmrc than the approved one';
  }
  if (SHELL_CONTROL_VARS.has(normalized)) {
    return 'it can make a gated step exit 0 without running its command';
  }
  return null;
}

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

/**
 * Every .npmrc in the repository other than the root one. npm resolves config
 * by walking UP from the current directory, so a file in any package directory
 * a gated command might run from wins over the approved root file.
 */
function findNestedNpmrcFiles(repoRoot) {
  const found = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', 'build']);
  const walk = (rel) => {
    for (const entry of readdirSync(join(repoRoot, rel || '.'), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.name === '.npmrc' && rel !== '') {
        found.push(`${rel}/.npmrc`);
      }
    }
  };
  walk('');
  return found.sort();
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

/** The aggregator's real step: its script and the env that feeds it results. */
export function extractAggregatorProgram(workflow) {
  const step = (workflow?.jobs?.test?.steps ?? []).find((s) => s.run !== undefined);
  return step ? { script: String(step.run), env: step.env ?? {} } : null;
}

/**
 * EXECUTES the aggregator's real program against a table of GitHub result
 * combinations and reports what it did.
 *
 * Token assertions cannot see behaviour: changing `exit "$status"` to `exit 0`
 * leaves every pinned token in place, and the workflow-level test that would
 * catch it runs inside `unit-tests` — whose failure the now-broken aggregator
 * converts back to green. Running the program here means the independently
 * required `lint` job enforces it, where no aggregator can swallow the result.
 *
 * Returns one row per case so the checker and the tests share this executor
 * rather than each growing their own.
 */
/**
 * The ambient variables the model provides, matching what Actions sets.
 *
 * Modelling these is only half the answer — the list can never be complete, and
 * `CI=true` was the one it was missing. So `unmodelledVariables()` below rejects
 * a program that reads ANY variable outside this set, its own locals and its
 * declared `env:`. The gate cannot branch on something this verification does
 * not know about, which is a boundary rather than another list to extend.
 */
const MODELLED_AMBIENT_ENV = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_JOB: 'test',
  RUNNER_OS: 'Linux',
};

/** Shell variables that are always defined, and need no declaration. */
const SHELL_BUILTIN_VARS = new Set(['PATH', 'HOME', 'PWD', 'IFS', 'RANDOM', 'SECONDS', 'LINENO', 'HOSTNAME', 'BASH_VERSION', 'OSTYPE', 'SHLVL', '_']);

/**
 * Variables a program reads that nothing here defines.
 *
 * Assignments (`x=…`), loop variables (`for x in …`) and the step's own `env:`
 * are known; everything else would be ambient on the runner and absent (or
 * different) in this model, so the program's behaviour could not be verified.
 */
export function unmodelledVariables(script, declaredEnv) {
  const text = String(script);
  const defined = new Set([
    ...Object.keys(declaredEnv ?? {}),
    ...Object.keys(MODELLED_AMBIENT_ENV),
    ...SHELL_BUILTIN_VARS,
  ]);
  for (const m of text.matchAll(/(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=/gm)) defined.add(m[1]);
  for (const m of text.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) defined.add(m[1]);
  const read = new Set();
  // $NAME, ${NAME}, ${NAME:-default}, ${NAME#pattern} … but not $((arithmetic)).
  for (const m of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\b/g)) read.add(m[1]);
  return [...read].filter((name) => !defined.has(name)).sort();
}

/** The result states GitHub can hand an aggregator for a prerequisite. */
export const RESULT_STATES = ['success', 'failure', 'cancelled', 'skipped', 'empty', 'missing'];

/** The only expression forms the behavioural model understands, anchored whole. */
const EXACT_NEEDS_RESULT = /^needs\.([A-Za-z0-9_-]+)\.result$/;
const EXACT_TOJSON_NEEDS = /^toJSON\(\s*needs\s*\)$/;
const WHOLE_EXPRESSION = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/;

/**
 * Resolves one `env:` value the way GitHub would, or reports that it cannot.
 *
 * Anchored, not substring-matched: `${{ needs.x.result && 'success' }}` and
 * `${{ needs.x.result == 'failure' }}` both CONTAIN `needs.x.result` while
 * evaluating to something else entirely, so modelling them as the bare result
 * would verify a program that does not exist. Anything outside the two exact
 * forms fails closed.
 */
function resolveAggregatorEnv(text, results) {
  const raw = String(text);
  if (!raw.includes('${{')) return { value: raw };
  const whole = WHOLE_EXPRESSION.exec(raw);
  if (!whole) return { unresolved: raw };
  const body = whole[1];
  const needsResult = EXACT_NEEDS_RESULT.exec(body);
  // A job dropped from `needs` expands to the empty string, exactly as here.
  if (needsResult) return { value: results[needsResult[1]] ?? '' };
  if (EXACT_TOJSON_NEEDS.test(body)) {
    return { value: JSON.stringify(Object.fromEntries(Object.entries(results).map(([j, r]) => [j, { result: r }]))) };
  }
  return { unresolved: raw };
}

/**
 * The result vectors to execute: bounded, deterministic, and exhaustive over
 * every multi-job interaction that matters.
 *
 * The full product is 6^5 = 7776 vectors, which costs more runtime than it buys
 * — the defects it finds are interactions between at most two positions, plus
 * whole-vector uniformity. So this enumerates, exactly:
 *   - all-success;
 *   - every non-empty SUBSET of jobs set to each non-success state (so two
 *     cancelled, three missing, all skipped … are all present);
 *   - every ORDERED PAIR of distinct jobs crossed with every pair of
 *     non-success states (so failure+skipped, cancelled+missing, and every
 *     other mixed pair are present).
 * That is exhaustive for 1- and 2-way interactions and for uniform vectors,
 * which is what discriminates an aggregator that handles one bad result but
 * not two.
 */
export function aggregatorCases(prerequisites) {
  const badStates = RESULT_STATES.filter((state) => state !== 'success');
  const seen = new Set();
  const cases = [];
  const add = (vector) => {
    const key = vector.join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const label =
      prerequisites.map((job, i) => `${job}=${vector[i]}`).filter((_, i) => vector[i] !== 'success').join(', ') ||
      'all success';
    cases.push({
      label,
      results: Object.fromEntries(
        prerequisites.map((job, i) => [job, vector[i] === 'empty' ? '' : vector[i]]).filter((_, i) => vector[i] !== 'missing'),
      ),
      emptyJobs: prerequisites.filter((_, i) => vector[i] === 'empty'),
      expectSuccess: vector.every((state) => state === 'success'),
    });
  };

  add(prerequisites.map(() => 'success'));
  // Every subset, one state at a time — covers "two cancelled", "all missing".
  for (const state of badStates) {
    for (let mask = 1; mask < 2 ** prerequisites.length; mask++) {
      add(prerequisites.map((_, i) => ((mask >> i) & 1 ? state : 'success')));
    }
  }
  // Every mixed pair — covers "failure + skipped", "cancelled + missing".
  for (let a = 0; a < prerequisites.length; a++) {
    for (let b = 0; b < prerequisites.length; b++) {
      if (a === b) continue;
      for (const stateA of badStates) {
        for (const stateB of badStates) {
          add(prerequisites.map((_, i) => (i === a ? stateA : i === b ? stateB : 'success')));
        }
      }
    }
  }
  return cases;
}

/**
 * EXECUTES the aggregator's real program across every result vector and reports
 * what it did.
 *
 * Token assertions cannot see behaviour: changing `exit "$status"` to `exit 0`
 * leaves every pinned token in place, and a workflow-level test would run
 * inside `unit-tests` — whose failure the now-broken aggregator converts back
 * to green. Running the program here means the independently required `lint`
 * job enforces it, where no aggregator can swallow the result.
 *
 * One bash process runs the whole table: the program is written once with its
 * `join()` interpolation lifted into an environment variable, and a driver
 * loops the vectors. 7776 cases cost about a second instead of two minutes.
 */
/**
 * Memo for the truth table.
 *
 * The table is a pure function of (program text, declared env, prerequisites) —
 * same input, same 356 executions, same verdicts — so identical programs are
 * computed once. That matters because the fixture suite checks ~55 repositories
 * whose aggregator is usually byte-identical to the real one; without this it
 * re-ran ~19,000 shells to learn the same answer.
 */
const truthTableMemo = new Map();

export function aggregatorTruthTable(workflow, prerequisites = Object.keys(PREREQUISITE_RUNS)) {
  const program = extractAggregatorProgram(workflow);
  if (!program) return [{ label: 'aggregator step', ok: false, detail: 'the `test` job has no run step to execute' }];
  const memoKey = JSON.stringify([program.script, program.env, prerequisites, String(workflow.name ?? '')]);
  const memoized = truthTableMemo.get(memoKey);
  if (memoized) return memoized;

  // Each `join(needs.*.result, <sep>)` is substituted with ITS OWN separator.
  // Collapsing several occurrences onto one value would make a script that
  // compares a space-joined list against a comma-joined one see them as equal
  // here, and branch differently on the real runner.
  const scriptFor = (results, emptyJobs) =>
    program.script.replace(
      /\$\{\{\s*join\(needs\.\*\.result,\s*'([^']*)'\)\s*\}\}/g,
      (_m, sep) => Object.entries(results).map(([job, state]) => (emptyJobs.includes(job) ? '' : state)).join(sep),
    );
  const remember = (rows) => {
    truthTableMemo.set(memoKey, rows);
    return rows;
  };
  if (scriptFor({}, []).includes('${{')) {
    return remember([{ label: 'aggregator program', ok: false, detail: 'it contains an expression this verification cannot resolve, so its behaviour is unverified' }]);
  }
  const unmodelled = unmodelledVariables(scriptFor({}, []), program.env);
  if (unmodelled.length > 0) {
    return remember([{
      label: 'aggregator program',
      ok: false,
      detail: `it reads ${unmodelled.map((n) => `$${n}`).join(', ')}, which this verification does not model — the gate would then behave differently on the runner than it does here`,
    }]);
  }

  return remember(aggregatorCases(prerequisites).map((c) => {
    const env = {};
    for (const [key, expression] of Object.entries(program.env)) {
      const resolved = resolveAggregatorEnv(expression, c.results);
      if (resolved.unresolved !== undefined) {
        return { label: c.label, ok: false, detail: `env ${key}: ${resolved.unresolved} uses an expression this verification cannot resolve, so the gate's behaviour is unverified` };
      }
      env[key] = resolved.value;
    }
    // A MODELLED environment, not this process's. Inheriting the checker's own
    // env would let an aggregator branch on something only true here — e.g.
    // `[ "${GITHUB_JOB:-}" = test ] && exit 0` passes every case run from
    // `lint`, while the real gate always succeeds. Only PATH and HOME carry
    // over, because bash and coreutils need them.
    const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', scriptFor(c.results, c.emptyJobs)], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        // The GitHub context the real `test` job would run under.
        ...MODELLED_AMBIENT_ENV,
        GITHUB_WORKFLOW: String(workflow.name ?? ''),
        ...env,
      },
    });
    const succeeded = res.status === 0;
    const ok = succeeded === c.expectSuccess;
    return {
      label: c.label,
      ok,
      detail: ok ? '' : `expected the gate to ${c.expectSuccess ? 'SUCCEED' : 'FAIL'}, but it exited ${res.status}`,
    };
  }));
}


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
      .filter((run) => isSuiteInvocation(run))
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
  // Every root-package hook `npm ci` can fire, read out of the npm this repo
  // uses (11.12.1): lib/commands/ci.js runs prepublish → preprepare → prepare →
  // postprepare; @npmcli/arborist rebuild.js runs preinstall, install and
  // postinstall; and reify.js runs predependencies → dependencies →
  // postdependencies whenever the dep tree actually changed. `prepack`/
  // `postpack` are pack/publish-time only and are deliberately absent.
  for (const hook of NPM_INSTALL_LIFECYCLE_HOOKS) {
    const command = pkgScripts[hook];
    if (typeof command === 'string' && !APPROVED_INSTALL_HOOKS.has(hook)) {
      violations.push(`package.json scripts.${hook} exists (\`${command}\`) — npm runs install hooks on every runner before every gated command, so they are refused unless added to APPROVED_INSTALL_HOOKS`);
    }
  }

  // ── npm configuration: an ALLOWLIST, not a hunt for dangerous keys ──
  // Every .npmrc a gated command could load must be exactly the approved set.
  // The root file is checked against APPROVED_NPMRC; any OTHER .npmrc in the
  // repository is rejected outright, because npm walks up from the working
  // directory and would read one nearer the command than this file.
  let rootNpmrc = '';
  try {
    rootNpmrc = readFileSync(join(repoRoot, '.npmrc'), 'utf8');
  } catch {
    rootNpmrc = '';
  }
  violations.push(...checkNpmrc(rootNpmrc, '.npmrc'));
  for (const nested of findNestedNpmrcFiles(repoRoot)) {
    violations.push(`${nested}: a second .npmrc — npm reads the one nearest the working directory, so this can override the approved root configuration`);
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
      const reason = neuteringEnvVar(key);
      if (reason) {
        violations.push(`${scope}: sets ${key} — ${reason}`);
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
    if (group !== undefined && !shardConcurrencyIsSafe(group)) {
      violations.push(`${name}: job-level concurrency \`${group}\` must interpolate matrix.shard directly AND github.run_id, or the matrix children queue behind each other (groups are repository-wide)`);
    }
  }

  // ── Every required job runs exactly its approved steps, in order ──
  for (const [jobName, approvedSteps] of Object.entries(APPROVED_JOB_STEPS)) {
    const steps = jobs[jobName]?.steps ?? [];
    const describe = (step) => (step.uses !== undefined ? `uses ${step.uses}` : `run ${String(step.run ?? '').trim().split('\n')[0]}`);
    if (steps.length !== approvedSteps.length) {
      violations.push(`${jobName}: has ${steps.length} steps, but the approved sequence has ${approvedSteps.length}`);
    }
    for (let i = 0; i < Math.max(steps.length, approvedSteps.length); i++) {
      const step = steps[i];
      const approved = approvedSteps[i];
      if (!step || !approved) continue;
      if (approved.uses !== undefined) {
        if (step.uses !== approved.uses) {
          violations.push(`${jobName}: step ${i + 1} is \`${describe(step)}\`, but the approved step is \`uses ${approved.uses}\` — order matters, because a setup action moved below the command that needs it changes what the command runs on`);
          continue;
        }
        const actual = step.with ?? {};
        for (const [key, value] of Object.entries(approved.with ?? {})) {
          if (!(key in actual)) {
            violations.push(`${jobName}: \`${step.uses}\` is missing the required input \`${key}: ${JSON.stringify(value)}\``);
          } else if (JSON.stringify(actual[key]) !== JSON.stringify(value)) {
            violations.push(`${jobName}: \`${step.uses}\` sets \`${key}: ${JSON.stringify(actual[key])}\`, but the approved value is ${JSON.stringify(value)}`);
          }
        }
        for (const key of Object.keys(actual)) {
          if (!(key in (approved.with ?? {}))) {
            violations.push(`${jobName}: \`${step.uses}\` sets the unapproved input \`${key}: ${JSON.stringify(actual[key])}\` — \`ref\` in particular would make this job test something other than the pull request's own head`);
          }
        }
      } else if (approved.run === AGGREGATOR_PROGRAM) {
        if (step.run === undefined) {
          violations.push(`${jobName}: step ${i + 1} is \`${describe(step)}\`, but the approved step is the aggregator program`);
        }
      } else if (String(step.run ?? '').trim() !== approved.run) {
        violations.push(`${jobName}: step ${i + 1} is \`${describe(step)}\`, but the approved step is \`run ${approved.run}\``);
      }
      // Every step of a required job, action or command, must be unweakened.
      if (step.if !== undefined) {
        violations.push(`${jobName}: step ${i + 1} (\`${describe(step)}\`) has an \`if:\` — it could be skipped while the job still reports success`);
      }
      if (step['continue-on-error'] !== undefined) {
        violations.push(`${jobName}: step ${i + 1} (\`${describe(step)}\`) sets \`continue-on-error\` — its failure would be tolerated`);
      }
    }
    checkJobIsUnweakened(jobs[jobName], jobName, violations, { allowIf: jobName === 'test' });
  }

  // ── Gated jobs run on isolated, GitHub-hosted runners ──
  for (const jobName of Object.keys(APPROVED_JOB_STEPS)) {
    const runsOn = jobs[jobName]?.['runs-on'];
    if (runsOn === undefined) continue;
    if (runsOn !== APPROVED_RUNNER) {
      violations.push(`${jobName}: runs-on is ${JSON.stringify(runsOn)}, not "${APPROVED_RUNNER}" — a self-hosted, custom-labelled or expression-selected runner may be persistent and shared, which is what the per-job isolation argument rests on`);
    }
  }

  // ── Only approved commands run in a gated job ──
  for (const [jobName, approved] of Object.entries(APPROVED_JOB_RUNS)) {
    for (const step of jobs[jobName]?.steps ?? []) {
      if (step.run === undefined) continue;
      if (!approved.includes(String(step.run).trim())) {
        violations.push(`${jobName}: runs \`${String(step.run).trim().split('\n')[0]}\`, which is not in APPROVED_JOB_RUNS — a gated job runs only its suite and its setup, because anything else executes on the same runner before that suite`);
      }
    }
  }

  // ── Runtime npm-configuration mutation, anywhere ──
  // A `npm config set …` step rewrites the .npmrc the allowlist just validated,
  // on that runner only, after this checker has looked. Nothing here needs it.
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (step.run !== undefined && isNpmConfigMutation(step.run)) {
        violations.push(`${jobName}: step runs \`npm config\` (\`${String(step.run).trim().split('\n')[0]}\`) — runtime npm configuration is refused; change .npmrc and APPROVED_NPMRC in one reviewed edit instead`);
      }
    }
  }
  for (const [name, command] of Object.entries(pkgScripts)) {
    if (typeof command === 'string' && isNpmConfigMutation(command)) {
      violations.push(`package.json scripts.${name} runs \`npm config\` — an npm script can rewrite the approved configuration before a gated command runs`);
    }
  }

  // ── Root execution boundary ──
  // Every gated command is a ROOT command. `working-directory` keeps the pinned
  // text while running it somewhere else: pointed at a package without that
  // script (with npm's if-present, or simply a different package.json) the step
  // exits 0 having run nothing. If this ever becomes a monorepo, that is a
  // reviewed redesign, not silent drift.
  if (workflow.defaults?.run?.['working-directory'] !== undefined) {
    violations.push('workflow defaults.run.working-directory moves every gated command off the repository root');
  }
  const rootBoundaryJobs = new Set([...Object.keys(GATED_JOB_COMMANDS), 'test']);
  for (const [jobName, job] of Object.entries(jobs)) {
    if (job.defaults?.run?.['working-directory'] !== undefined) {
      violations.push(`${jobName}: defaults.run.working-directory moves its commands off the repository root`);
    }
    for (const step of job.steps ?? []) {
      const isInstall = step.run !== undefined && /\bnpm\s+(ci|install|i)\b/.test(String(step.run));
      if (step['working-directory'] === undefined) continue;
      if (rootBoundaryJobs.has(jobName) || isInstall) {
        violations.push(`${jobName}: step sets working-directory: ${step['working-directory']} — gated and install steps must run at the repository root, or the pinned command runs against a different package.json`);
      }
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

  // ── 5c. The aggregator is verified by RUNNING it, not by reading it ──
  for (const row of aggregatorTruthTable(workflow, expectedNeeds)) {
    if (!row.ok) {
      violations.push(`test (required gate): with ${row.label}, ${row.detail}`);
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
