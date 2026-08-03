// @vitest-environment node
// 10c-b G — the activation preflight's copy of the reviewed cron job must never drift from the
// migration that actually schedules it.
//
// The preflight refuses to arm any job whose stored schedule/command is not the reviewed one. That
// check is only as good as the text it compares against: the moment someone legitimately changes
// the F migration's endpoint or command and does not update the preflight, the preflight starts
// refusing every correct job — or, if the edit went the other way, starts accepting a job nobody
// reviewed. Neither failure announces itself at activation time, when it is far too late.
//
// So the two literals are pinned to each other HERE, in the test suite CI always runs, rather than
// left to a comment asking the next person to remember.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

const MIGRATION = read('supabase', 'migrations', '20261012100000_notif_10cb_digest_cron_inert.sql');
// The assertions live in a shared include, pulled in by BOTH the read-only dry run
// (activation_preflight.sql) and the transactional gate (activate.sql), so the two can never
// diverge into checking different things.
const PREFLIGHT = read('scripts', 'rollout', 'notif-10cb', 'sql', '_activation_assertions.sql');
const ACTIVATE = read('scripts', 'rollout', 'notif-10cb', 'sql', 'activate.sql');
const DRY_RUN = read('scripts', 'rollout', 'notif-10cb', 'sql', 'activation_preflight.sql');

/** The same normalisation the preflight applies in SQL: btrim + collapse whitespace runs. */
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What the F migration ACTUALLY schedules. */
const reviewed = (() => {
  const m = MIGRATION.match(
    /cron\.schedule\(\s*'notification-digest-worker'\s*,\s*'([^']+)'\s*,\s*\$cmd\$([\s\S]*?)\$cmd\$\s*\)/);
  if (!m) throw new Error('the F migration no longer schedules notification-digest-worker in the expected form');
  return { schedule: m[1], command: m[2] };
})();

/** What the preflight will demand of a live job. */
const expected = (() => {
  const sched = PREFLIGHT.match(/'([^']*\*\/\d+[^']*)'::text,\n\s*'the cron schedule is the reviewed one/);
  const hash = PREFLIGHT.match(/'([0-9a-f]{32})'::text,\n\s*'the cron command is EXACTLY the reviewed command/);
  if (!sched) throw new Error('the preflight no longer pins a cron schedule literal');
  if (!hash) throw new Error('the preflight no longer pins a reviewed-command md5');
  return { schedule: sched[1], commandMd5: hash[1] };
})();

/** Postgres md5() over the same normalised text — the preflight computes exactly this. */
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

describe('G — activation_preflight is pinned to the reviewed cron job', () => {
  it('demands the schedule the F migration actually installs', () => {
    expect(expected.schedule).toBe(reviewed.schedule);
  });

  // The preflight pins a hash, so this is the ONLY thing standing between a legitimate change to
  // the migration's command and a gate that would then refuse every correctly-installed job.
  it('demands the command the F migration actually installs', () => {
    expect(expected.commandMd5).toBe(md5(normalize(reviewed.command)));
  });

  // The endpoint is the part that decides where a Vault-decrypted service_role bearer is posted,
  // so it is pinned on its own rather than only inside the whole-command comparison.
  it('pins the same worker endpoint in both files', () => {
    const url = /https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/notification-digest-worker/;
    const inMigration = reviewed.command.match(url);
    expect(inMigration, 'the F migration must post to a notification-digest-worker endpoint').not.toBeNull();
    expect(PREFLIGHT).toContain(inMigration![0]);
  });

  it('pins the endpoint to this project, not just any supabase host', () => {
    const config = read('supabase', 'config.toml');
    const projectId = config.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
    expect(projectId, 'supabase/config.toml must declare a project_id').toBeTruthy();
    expect(reviewed.command).toContain(`https://${projectId}.supabase.co/functions/v1/notification-digest-worker`);
  });

  // The bearer must be resolved at TICK time. A literal in either file would mean the
  // service_role key is sitting in a checked-in artifact and in cron.job in plaintext.
  it('neither file carries an inline credential', () => {
    const credential = /(eyJ[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{5,}|sbp_[A-Za-z0-9_-]{5,})/;
    expect(reviewed.command).not.toMatch(credential);
    // The preflight's own deny-list regex names these prefixes; strip that one line before
    // scanning, or the guard would trip on the guard.
    expect(PREFLIGHT.replace(/^.*command !~ .*$/m, '')).not.toMatch(credential);
    expect(reviewed.command).toContain('vault.decrypted_secrets');
  });

  // The legacy-key scan flags any .sql outside supabase/migrations that contains a POST + auth
  // header + credential read. This artifact must keep passing it on its own merits, not because
  // someone later widened an allow-list.
  it('does not itself look like a key-sending statement', () => {
    const noComments = PREFLIGHT.replace(/--.*$/gm, '');
    const sends = /\bhttp_post\s*\(/i.test(noComments)
      && /authorization|api[-_]?key|bearer/i.test(noComments)
      && /vault\.decrypted_secrets|decrypted_secret|current_setting/.test(noComments);
    expect(sends, 'activation_preflight.sql now matches the key-sender signature').toBe(false);
  });
});

describe('G — the preflight is bound to one named canary run', () => {
  // Every canary assertion must be scoped to :run_id. An unscoped one reads the whole table, which
  // any earlier rollout attempt satisfies permanently — the exact defect this slice closed.
  it('scopes its canary evidence to :run_id rather than the whole table', () => {
    const section = PREFLIGHT.slice(PREFLIGHT.indexOf('-- 5. THE CANARY'));
    for (const table of ['notification_digest_attempts', 'notification_worker_runs',
                         'notification_digest_group_attempts']) {
      const stmts = section.split(/;\s*\n/).filter((s) => s.includes(table));
      expect(stmts.length, `no assertion reads ${table}`).toBeGreaterThan(0);
      for (const s of stmts) {
        expect(s, `an assertion reads ${table} without binding to :run_id:\n${s}`).toContain("run_id'");
      }
    }
  });

  it('requires the canary to be the newest dispatch run and to be recent', () => {
    expect(PREFLIGHT).toContain('in flight, started after, or ended after this canary');
    expect(PREFLIGHT).toMatch(/now\(\) - ended_at <= interval '6 hours'/);
  });

  // `accepted` is written before the mismatch is detected, so the structural check is the only
  // honest evidence that the send correlated. Losing it would make every other canary assertion
  // pass over a permanently mis-correlated message.
  it('checks the attempt and its group agree on the provider message id', () => {
    expect(PREFLIGHT).toContain('a.provider_message_id IS DISTINCT FROM g.provider_message_id');
  });

  it('requires the email circuit to be closed', () => {
    expect(PREFLIGHT).toMatch(/channel = 'email' AND state <> 'closed'/);
  });
});

describe('G — verifying and arming are one transaction', () => {
  // Checking in one statement and arming in another is a time-of-check/time-of-use hole: between
  // them the job can be altered, replaced or unscheduled, and an arm-by-name matching ZERO rows
  // succeeds silently — reporting a cron as ARMED over a job that is no longer there.
  it('both wrappers run the SAME shared assertions', () => {
    expect(ACTIVATE).toContain('\\i _activation_assertions.sql');
    expect(DRY_RUN).toContain('\\i _activation_assertions.sql');
  });

  it('activate.sql locks the job row BEFORE it asserts anything', () => {
    const lock = ACTIVATE.indexOf('FOR UPDATE');
    const assertions = ACTIVATE.indexOf('\\i _activation_assertions.sql');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(assertions);
  });

  it('activate.sql is a single explicit transaction', () => {
    expect(ACTIVATE).toMatch(/^\s*BEGIN;/m);
    expect(ACTIVATE).toMatch(/^\s*COMMIT;/m);
    expect(ACTIVATE.indexOf('BEGIN;')).toBeLessThan(ACTIVATE.indexOf('FOR UPDATE'));
  });

  // Every lock wait must be bounded. This transaction holds a table lock on the run ledger while it
  // waits for group locks, so an unbounded wait behind a slow webhook — or a deadlock against the
  // orphan reconciler, which holds group locks across its loop — would stall every worker-run write
  // rather than failing an owner-driven step that is always safe to re-run.
  // COMMENTS STRIPPED FIRST. These files explain themselves at length, and every property below is
  // also *described* in prose next to the statement that implements it — so a search over the raw
  // text passes when the statement is commented out. That is the vacuous-assertion trap this slice
  // has hit repeatedly, in a new place.
  const activeSql = ACTIVATE.replace(/--.*$/gm, '');

  it('activate.sql bounds every lock wait before taking any lock', () => {
    const m = activeSql.match(/SET LOCAL lock_timeout\s*=\s*'([^']+)'/);
    expect(m, 'activate.sql must set a lock_timeout').not.toBeNull();
    // PostgreSQL treats 0 as DISABLED — the same footgun assert_timeout_ms guards in the shell
    // library. A zero here removes exactly the bound while every comment still says "bounded".
    expect(m![1]).toMatch(/^[1-9][0-9]*(ms|s|min)?$/);
    const at = activeSql.search(/SET LOCAL lock_timeout/);
    for (const lock of ['LOCK TABLE', 'FOR UPDATE', 'FOR SHARE']) {
      expect(at, `lock_timeout must precede ${lock}`).toBeLessThan(activeSql.indexOf(lock));
    }
  });

  // lock_timeout bounds EACH acquisition; the ordered FOR SHARE can take many group locks, so a
  // succession of blockers that each release in time would still stall activation indefinitely.
  it('activate.sql also caps the total statement time, before every lock', () => {
    const m = activeSql.match(/SET LOCAL statement_timeout\s*=\s*'([^']+)'/);
    expect(m, 'activate.sql must cap the whole statement, not just each lock wait').not.toBeNull();
    expect(m![1]).toMatch(/^[1-9][0-9]*(ms|s|min)?$/);
    // POSITION MATTERS as much as presence. Moved below the group lock it still exists and is still
    // positive, while the statement that actually needs the total bound runs without it.
    const at = activeSql.search(/SET LOCAL statement_timeout/);
    for (const lock of ['LOCK TABLE', 'FOR UPDATE', 'FOR SHARE']) {
      expect(at, `statement_timeout must precede ${lock}`).toBeLessThan(activeSql.indexOf(lock));
    }
  });

  // Two transactions taking overlapping group sets in opposite orders is the classic deadlock.
  it('activate.sql locks the canary groups in a deterministic order', () => {
    const groupLock = activeSql.match(/SELECT g\.id FROM public\.notification_digest_groups[\s\S]*?FOR SHARE;/)?.[0];
    expect(groupLock, 'activate.sql must lock the canary groups').toBeTruthy();
    expect(groupLock!).toMatch(/ORDER BY g\.id\s*\n\s*FOR SHARE;/);
  });

  // The cheap refusal must come BEFORE the group locks, or activation queues behind the very run
  // that is going to invalidate it — while holding the run-ledger lock.
  it('activate.sql refuses an in-flight dispatch run before taking group locks', () => {
    const check = activeSql.indexOf('no dispatch run is in flight');
    expect(check, 'activate.sql must pre-check for an in-flight run').toBeGreaterThan(-1);
    expect(check).toBeLessThan(activeSql.indexOf('FOR SHARE'));
  });

  it('activate.sql arms by jobid and count-checks the arm', () => {
    expect(ACTIVATE).toContain('cron.alter_job(j.jobid, active := true)');
    expect(ACTIVATE).toContain('exactly one job was armed');
  });

  // The dry run must stay a dry run, or "preflight" silently becomes a second way to arm.
  it('the dry run arms nothing', () => {
    expect(DRY_RUN).not.toContain('alter_job');
    expect(DRY_RUN).not.toContain('active := true');
  });
});

describe('G — the dispatcher can only reach psql through the sanitising wrapper', () => {
  const SCRIPT = read('scripts', 'rollout', 'notif-10cb', 'run-enablement.sh');

  // A single bare `psql` reintroduces the whole PGHOSTADDR/PGSERVICE hole for that one call, and
  // it is exactly the kind of thing a later edit adds without noticing.
  it('never invokes bare psql', () => {
    const bare = SCRIPT.split('\n')
      .map((l, i) => [i + 1, l] as const)
      // Comments are stripped, whole-line and trailing alike — this file documents `psql` in
      // prose next to the code that calls it, and a prose mention is not an invocation.
      .map(([n, l]) => [n, l.replace(/^\s*#.*$/, '').replace(/\s#.*$/, '')] as const)
      .filter(([, l]) => /(^|[^_a-zA-Z])psql\s/.test(l) && !/psql_safe/.test(l));
    expect(bare.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });

  it('runs the environment guard before dispatching any subcommand', () => {
    const guard = SCRIPT.indexOf('assert_no_hostile_libpq_env\n');
    const dispatch = SCRIPT.indexOf('case "$SUB" in');
    expect(guard, 'the guard must be called').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dispatch);
  });
});
