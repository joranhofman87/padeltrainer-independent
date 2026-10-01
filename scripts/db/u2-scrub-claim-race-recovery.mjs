#!/usr/bin/env node
/**
 * U2 B1 — the recovery contract of `u2-scrub-claim-race.mjs`, as a gate rather than as a claim.
 *
 * That harness has to disable the guard trigger to stage an expired lease, and it has to open three
 * sessions and write rows to stage a race. Every one of those is a thing a failure could leak, and a
 * leaked one is worse than a failed test: a disabled trigger makes every LATER assertion in the
 * database meaningless while everything stays green, and a leaked row survives into whatever runs
 * next. "We wrote a finally" is not evidence. This runs the real harness as a child process, with a
 * failure injected at each supported stage, and inspects the database from an independent connection
 * afterwards.
 *
 * TWO PROPERTIES, and the second is the one that needed a different shape of test:
 *
 *   1. RECOVERY — at every stage, the child exits non-zero and leaves no disabled trigger, no row,
 *      no open transaction and no session of its own.
 *   2. NO COMMITTED UNGUARDED WINDOW — while the child deliberately holds the guard off, another
 *      session never observes it. This cannot be checked after the fact: a non-transactional version
 *      passes property 1, because the cleanup path happens to re-enable the trigger on its way out.
 *      It is only distinguishable by looking DURING, from outside. Measured: the transactional
 *      version is never seen disabled; the autocommit one is seen disabled in roughly half of ~70
 *      samples.
 *
 * LOCAL ONLY — the connection string is hardcoded to 127.0.0.1:54322 and nothing here reads a
 * credential.
 */
import pg from 'pg';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONN = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?application_name=u2-race-recovery';
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'u2-scrub-claim-race.mjs');
const REPO_ROOT = resolve(HERE, '../..');
const OWNED_BY_HARNESS = 'u2-scrub-claim-race';

/**
 * Every stage the harness supports. Kept in step with the script by assertion, not by memory: a new
 * `faultIf(...)` that nobody adds here would be a recovery path with no coverage, and the check
 * below fails when the two disagree.
 */
const STAGES = [
  'after-connect-A', 'after-connect-B', 'after-connect-admin',
  'before-insert', 'after-insert',
  'inside-guard-window', 'after-claim-race', 'before-cleanup',
];

let failures = 0;
const fail = (msg, detail) => { failures++; console.error('FAIL', msg, detail ?? ''); };
const pass = (msg) => console.log('PASS', msg);
const ok_ = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));

const runChild = (env) => new Promise((res) => {
  execFile('node', [SCRIPT], { env: { ...process.env, ...env }, cwd: REPO_ROOT },
    (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr }));
});

const probe = new pg.Client({ connectionString: CONN });
await probe.connect();

/** Everything a leak would show up in, read from a session the harness does not own. */
async function observe() {
  const { rows: [t] } = await probe.query(`
    SELECT count(*) FILTER (WHERE tgenabled = 'D')::int AS disabled, count(*)::int AS total
      FROM pg_trigger
     WHERE tgrelid = 'public.account_scrub_operations'::regclass AND NOT tgisinternal`);
  const { rows: [r] } = await probe.query(
    `SELECT count(*)::int AS n FROM public.account_scrub_operations`);
  // Scoped by application_name: this stack keeps pooled backends of its own, and PostgREST holds its
  // schema cache in an OPEN TRANSACTION indefinitely. Counting those would fail this suite for
  // something the harness does not govern — it did, the first time it was written.
  const { rows: [s] } = await probe.query(`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = $1`,
    [OWNED_BY_HARNESS]);
  return { disabled: t.disabled, triggers: t.total, rows: r.n, sessions: s.n };
}

try {
  // ── the stage list matches the harness ───────────────────────────────────────────────────────
  {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(SCRIPT, 'utf8');
    const declared = [...src.matchAll(/faultIf\(\s*[`'"]([a-z-]+)[`'"]\s*\)/g)].map((m) => m[1]);
    const templated = [...src.matchAll(/faultIf\(`([a-z-]+)-\$\{[a-z]+\}`\)/g)].map((m) => m[1]);
    // the templated one expands to after-connect-A|B|admin
    const expected = new Set(STAGES);
    const found = new Set([
      ...declared,
      ...templated.flatMap((prefix) => ['A', 'B', 'admin'].map((s) => `${prefix}-${s}`)),
    ]);
    const missing = [...found].filter((s) => !expected.has(s));
    const stale = [...expected].filter((s) => !found.has(s));
    ok_(missing.length === 0 && stale.length === 0,
      `every fault stage in the harness is covered here (${STAGES.length})`, { missing, stale });
  }

  const before = await observe();
  ok_(before.disabled === 0 && before.triggers === 2 && before.sessions === 0,
    'baseline: guard enabled, no harness session open', before);

  // ── 1. RECOVERY at every stage ───────────────────────────────────────────────────────────────
  for (const stage of STAGES) {
    const out = await runChild({ U2_RACE_FAULT: stage });
    await new Promise((r) => setTimeout(r, 250));   // let a torn-down backend be reaped
    const after = await observe();
    ok_(out.code !== 0
        && after.disabled === 0
        && after.triggers === before.triggers
        && after.rows === before.rows
        && after.sessions === 0,
      `fault at ${stage}: fails loudly and leaves nothing behind`,
      { exit: out.code, ...after });
  }

  // ── 2. NO COMMITTED UNGUARDED WINDOW ─────────────────────────────────────────────────────────
  {
    const child = runChild({ U2_RACE_FAULT: 'hold-guard-window' });
    let sawDisabled = 0;
    let samples = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { rows: [t] } = await probe.query(`
        SELECT count(*) FILTER (WHERE tgenabled = 'D')::int AS disabled FROM pg_trigger
         WHERE tgrelid = 'public.account_scrub_operations'::regclass AND NOT tgisinternal`);
      samples++;
      if (t.disabled > 0) sawDisabled++;
      await new Promise((r) => setTimeout(r, 40));
    }
    const out = await child;
    ok_(samples > 20, `the window was sampled often enough to be meaningful (${samples} samples)`);
    ok_(out.code === 0 && sawDisabled === 0,
      'no other session ever observes a committed trigger-disabled window',
      { samples, sawDisabled, exit: out.code });
  }

  // ── 3. and the ordinary run still leaves nothing behind ──────────────────────────────────────
  {
    const out = await runChild({});
    await new Promise((r) => setTimeout(r, 250));
    const after = await observe();
    ok_(out.code === 0 && after.disabled === 0 && after.rows === before.rows && after.sessions === 0,
      'the clean run passes and leaves nothing behind', { exit: out.code, ...after });
  }
} finally {
  await probe.end().catch(() => {});
}

if (failures > 0) {
  console.error(`\n❌ u2 scrub claim race RECOVERY FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✅ u2 scrub claim race recovery passed');
