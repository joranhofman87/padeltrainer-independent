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
const PREFLIGHT = read('scripts', 'rollout', 'notif-10cb', 'sql', 'activation_preflight.sql');

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
    expect(PREFLIGHT).toContain('in flight or newer than this canary');
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
