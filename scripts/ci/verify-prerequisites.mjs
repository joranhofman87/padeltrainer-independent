#!/usr/bin/env node
/**
 * The required `test` check: every prerequisite job must have succeeded.
 *
 * This replaced an inline bash program in the workflow. The bash version was
 * correct, but proving it stayed correct meant modelling arbitrary shell — its
 * ambient environment, its variable reads, its expression interpolation — and
 * every round of review found another thing the model did not capture
 * (`SHELLOPTS`, `CI`, `printenv GITHUB_REF`, a shell override on the step). The
 * problem was never a missing check; it was that "arbitrary bash, verified by
 * modelling it" is not a contract anyone can hold.
 *
 * So the gate is now a fixed command over ONE declared input. There is no shell
 * program to model, no ambient state to read, and the decision itself is a pure
 * function of a JSON string — which means it is tested directly, exhaustively
 * and in milliseconds, instead of by executing hundreds of simulated runs.
 *
 * The workflow passes `${{ toJSON(needs) }}` as NEEDS_JSON. GitHub omits a job
 * that is not in `needs:` from that object entirely, so dropping a prerequisite
 * shows up here as a MISSING key — which fails, exactly like a failed one.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The jobs the gate exists to wait for. Changing this is a reviewed edit. */
export const EXPECTED_PREREQUISITES = [
  'unit-tests',
  'db-tests',
  'db-rehearsals',
  // NOTE the trainer-namespace property is NOT a prerequisite job any more. It used to be
  // `db-trainer-guard`, which re-ran the whole database suite with a client-side observer armed;
  // that observer's terminal review refused the approach, and the property is now established at
  // the SOURCE (a branded factory plus a compiler-API guard) and proved by two `lint` steps that
  // take about a second between them. `lint` is itself a required branch-protection context, so
  // the property is still gated — by a check that cannot be satisfied by a lane running nothing.
  'i18n',
  'workflow-contract',
];

/** The environment variable the workflow puts `${{ toJSON(needs) }}` into. */
export const NEEDS_ENV_VAR = 'NEEDS_JSON';

/**
 * Every reason this run must NOT be reported as a success. Empty means green.
 *
 * Pure: same string in, same verdicts out. Fails closed on anything it does not
 * positively recognise — absent input, unparseable input, a shape that is not
 * an object of objects, a result that is not the exact string "success".
 */
export function validatePrerequisites(raw, expected = EXPECTED_PREREQUISITES) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [`${NEEDS_ENV_VAR} is empty or unset — the gate has nothing to check, so it cannot report success`];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return [`${NEEDS_ENV_VAR} is not valid JSON: ${error.message}`];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [`${NEEDS_ENV_VAR} must be a JSON object of job results, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`];
  }

  const problems = [];
  const present = Object.keys(parsed);

  // A job removed from `needs:` simply is not here — the failure mode that
  // matters most, because nothing would have waited for it.
  for (const job of expected) {
    if (!present.includes(job)) {
      problems.push(`prerequisite '${job}' is missing from needs — nothing waited for it`);
    }
  }
  // And one added without being expected here means the gate is judging a set
  // it was never reviewed against.
  for (const job of present) {
    if (!expected.includes(job)) {
      problems.push(`unexpected prerequisite '${job}' — EXPECTED_PREREQUISITES must be updated deliberately`);
    }
  }

  for (const job of expected) {
    if (!present.includes(job)) continue;
    const entry = parsed[job];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`prerequisite '${job}' has no result object`);
      continue;
    }
    const { result } = entry;
    if (typeof result !== 'string') {
      problems.push(`prerequisite '${job}' has a non-string result (${JSON.stringify(result) ?? 'undefined'})`);
    } else if (result !== 'success') {
      problems.push(`prerequisite '${job}' finished with result '${result}'`);
    }
  }

  return problems;
}

// Resolved through realpath, not string-concatenated: `file://${argv[1]}`
// misses when the invoking path is a symlink (macOS /var -> /private/var), and
// the failure mode is silent — the CLI would parse nothing, check nothing and
// exit 0, which for a required gate means green for every red run. A fixture
// running this file from a temp directory caught exactly that.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  const problems = validatePrerequisites(process.env[NEEDS_ENV_VAR]);
  console.log(process.env[NEEDS_ENV_VAR] ?? `<${NEEDS_ENV_VAR} unset>`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    console.error(`${problems.length} prerequisite problem(s); this check fails.`);
    process.exit(1);
  }
  console.log('All test prerequisites succeeded.');
}
