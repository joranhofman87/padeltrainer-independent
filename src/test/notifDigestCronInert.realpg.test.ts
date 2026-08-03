// @vitest-environment node
// 10c-b F — the digest cron ships INACTIVE, and the liveness read tells a monitor the one thing
// the in-worker alert structurally cannot: whether it was invoked at all.
//
// pg_cron does not exist in embedded-postgres, so the fixture builds a MINIMAL cron stub — a
// `cron.job` table plus `schedule`/`alter_job` — and runs the REAL migration against it. That is
// the only way to exercise the branch that matters: what the migration does when the job already
// exists. Asserting on the migration's text instead would prove nothing about behaviour.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 54388;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let c: pg.Client;
const MIG = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20261012100000_notif_10cb_digest_cron_inert.sql'), 'utf8');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-cron-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise(); await epg.start();
  c = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE other_owner;`);
  // The run ledger is created by the REAL foundation migration's own DDL rather than a
  // hand-written lookalike: inventing it is how the first version of this suite ended up
  // asserting against a `finished_at` column production does not have, while the liveness RPC
  // would have RAISED on every call.
  const foundation = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20261002100000_notification_digest_schema_foundation.sql'), 'utf8');
  const runsDdl = foundation.slice(
    foundation.indexOf('CREATE TABLE IF NOT EXISTS public.notification_worker_runs'),
  );
  await c.query(runsDdl.slice(0, runsDdl.indexOf(');') + 2));
  await c.query(`
    -- a MINIMAL pg_cron stub: enough to observe what the migration does, and no more. jobname is
    -- UNIQUE PER USERNAME, exactly as real pg_cron scopes it — a globally unique jobname would
    -- make the owner-scoping this migration relies on untestable and its lookups look safe.
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text,
                           username text NOT NULL DEFAULT current_user,
                           active boolean NOT NULL DEFAULT true, UNIQUE (jobname, username));
    -- Real cron.schedule UPSERTS on (jobname, username): a second call with the same name UPDATES
    -- the existing job rather than failing. Modelling it as a plain INSERT would turn the race
    -- this migration guards against into a uniqueness error and hide the behaviour entirely.
    CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint
      LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_schedule, p_command)
        ON CONFLICT (jobname, username) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
        RETURNING jobid $$;
    CREATE FUNCTION cron.alter_job(p_jobid bigint, active boolean) RETURNS void
      LANGUAGE sql AS $$ UPDATE cron.job SET active = $2 WHERE jobid = $1 $$;
    CREATE FUNCTION cron.unschedule(p_name text) RETURNS boolean
      LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = $1 RETURNING true $$;
    -- the Vault secret the schedule is guarded on
    CREATE SCHEMA vault;
    CREATE TABLE vault.decrypted_secrets (name text PRIMARY KEY, decrypted_secret text);
    INSERT INTO vault.decrypted_secrets VALUES ('service_role_key', 'eyJ.SERVICE_ROLE_TEST.sig');
    -- the migration's pg_cron guard reads pg_extension; make the stub visible to it
    INSERT INTO pg_extension (oid, extname, extowner, extnamespace, extrelocatable, extversion)
      SELECT 999999, 'pg_cron', 10, n.oid, false, '1.6' FROM pg_namespace n WHERE n.nspname = 'cron';`);
}, 180_000);

afterAll(async () => { if (c) await c.end(); if (epg) await epg.stop(); });

beforeEach(async () => {
  await c.query(`DELETE FROM cron.job; DELETE FROM public.notification_worker_runs;`);
});

const job = async () =>
  (await c.query(`SELECT jobid, jobname, schedule, command, username, active FROM cron.job
                   WHERE jobname='notification-digest-worker' AND username=current_user`)).rows[0];
const liveness = async () => (await c.query(`SELECT * FROM public.notif_digest_worker_liveness()`)).rows[0];

describe('F — the digest cron is installed INERT', () => {
  it('creates the job and leaves it INACTIVE, in the same transaction', async () => {
    // Inert by construction: there is no window in which a scheduler tick could fire it.
    await c.query(MIG);
    const j = await job();
    expect(j, 'the job must exist — Stage 3 acceptance is "present but INACTIVE"').toBeTruthy();
    expect(j.active, 'ACTIVATION IS AN OWNER GATE').toBe(false);
    expect(j.schedule).toBe('*/5 * * * *');
    // ...and the stored command is the thing that will actually run, so assert what it does:
    // the right endpoint, and a bearer read from Vault AT TICK TIME (never a baked-in key).
    // The FULL url, not just the path: pointing the same path at another Supabase project would
    // send this project's Vault service-role bearer to that one the moment it is armed.
    expect(j.command).toContain("url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker'");
    expect(j.command).toContain("'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')");
    expect(j.command, 'no key may ever be frozen into the schedule').not.toContain('eyJ.SERVICE_ROLE_TEST');
  });

  it('a re-run NEVER disarms a job the owner has already activated', async () => {
    // The other worker crons in this repo unschedule-then-reschedule, which is fine for a job
    // meant to be running. Here it would silently disarm an owner's activation — the rollout
    // would look complete while nothing ran. An existing job is left exactly as it was found.
    await c.query(MIG);
    await c.query(`UPDATE cron.job SET active = true WHERE jobname='notification-digest-worker'`);
    const before = await job();

    await c.query(MIG);   // re-run, e.g. a db reset or a replayed chain

    const after = await job();
    expect(after.active, 'an owner activation survives a re-run').toBe(true);
    expect(after.jobid, 'the same job, not a replacement').toBe(before.jobid);
    expect(before.jobid).toBeDefined();
    expect((await c.query(`SELECT count(*)::int n FROM cron.job`)).rows[0].n, 'and no duplicate job').toBe(1);
  });

  it('MUTANT: unschedule-then-reschedule would silently disarm the owner', async () => {
    await c.query(MIG);
    await c.query(`UPDATE cron.job SET active = true WHERE jobname='notification-digest-worker'`);
    // what the mutant would do
    await c.query(`SELECT cron.unschedule('notification-digest-worker')`);
    await c.query(MIG);
    expect((await job()).active, 'the mutant loses the activation...').toBe(false);
    // ...whereas production, given an existing job, leaves it alone — asserted above.
  });

  it('installs INACTIVE even with no Vault secret — skipping would strand the rollout', async () => {
    // The other worker crons skip, correctly: they are created ARMED, so a missing secret means
    // ticking with no bearer. This one is created DISABLED and reads Vault at TICK time, so
    // skipping would be worse than pointless — on a restore where migrations run before
    // out-of-band secrets, the migration is recorded as applied and adding the key later never
    // creates the job, while the registry claims "installed inactive" over nothing at all.
    await c.query(`DELETE FROM vault.decrypted_secrets WHERE name='service_role_key'`);
    try {
      await c.query(MIG);
      const j = await job();
      expect(j, 'the job is installed regardless').toBeTruthy();
      expect(j.active, 'and still inert').toBe(false);
    } finally {
      await c.query(`INSERT INTO vault.decrypted_secrets VALUES ('service_role_key','eyJ.SERVICE_ROLE_TEST.sig')`);
    }
  });

  it('never touches ANOTHER owner\'s job of the same name', async () => {
    // Real pg_cron scopes named-job uniqueness by (jobname, username). A bare jobname lookup can
    // see another role's job — and the post-schedule lookup could then disable THAT one, leaving
    // the job this migration just created armed. The jobid comes from cron.schedule's own return
    // value for exactly that reason.
    await c.query(`INSERT INTO cron.job (jobname, schedule, command, username, active)
                   VALUES ('notification-digest-worker','* * * * *','SELECT 1','other_owner', true)`);
    await c.query(MIG);
    const mine = await job();
    expect(mine, 'ours is created despite the name collision').toBeTruthy();
    expect(mine.active, 'and it is the one that gets disabled').toBe(false);
    const theirs = (await c.query(
      `SELECT active FROM cron.job WHERE jobname='notification-digest-worker' AND username='other_owner'`)).rows[0];
    expect(theirs.active, "another owner's job is not ours to disarm").toBe(true);
  });

  it("the LIVENESS read is owner-scoped too — another owner's job is not ours to report", async () => {
    // A partial restore that carries only another owner's active, same-named job would otherwise
    // report present + armed, and a monitor would see a green light over a job we do not own and
    // cannot drive. Dropping the liveness predicate would leave every other test here green.
    //
    // The function is installed EXPLICITLY here, then our own job removed, so the state under
    // test is constructed by this test rather than left behind by whichever one ran before it.
    // Relying on that would make the test pass or fail on ordering, not on behaviour.
    await c.query(MIG);
    await c.query(`DELETE FROM cron.job WHERE jobname='notification-digest-worker' AND username=current_user`);
    await c.query(`INSERT INTO cron.job (jobname, schedule, command, username, active)
                   VALUES ('notification-digest-worker','* * * * *','SELECT 1','other_owner', true)`);
    const l = (await c.query(`SELECT * FROM public.notif_digest_worker_liveness()`)).rows[0];
    expect([l.job_present, l.job_active], 'we own no such job').toEqual([false, false]);

    await c.query(MIG);
    const ours = (await c.query(`SELECT * FROM public.notif_digest_worker_liveness()`)).rows[0];
    expect([ours.job_present, ours.job_active], 'and now we own one, inert').toEqual([true, false]);
  });
});

describe('F — the liveness read', () => {
  beforeEach(async () => { await c.query(MIG); });

  it('reports the job as present and disarmed, with no run history yet', async () => {
    const l = await liveness();
    expect([l.job_present, l.job_active]).toEqual([true, false]);
    expect(l.last_success_at).toBeNull();
    expect(l.seconds_since_success).toBeNull();
    expect(l.last_finished_at).toBeNull();
  });

  it('a SUCCEEDED dispatch run is what counts — a failing one is not liveness', async () => {
    // A worker invoked on schedule that fails every time is exactly as undelivered as one never
    // invoked. A monitor watching "did it run" would see a green light straight through that.
    await c.query(`INSERT INTO public.notification_worker_runs (worker, channel, phase, status, ended_at)
                   VALUES ('w','email','dispatch','failed', now() - interval '2 minutes')`);
    let l = await liveness();
    expect(l.last_success_at, 'a failed run is NOT a success').toBeNull();
    expect(l.last_status, 'but it IS the last thing that finished').toBe('failed');

    await c.query(`INSERT INTO public.notification_worker_runs (worker, channel, phase, status, ended_at)
                   VALUES ('w','email','dispatch','succeeded', now() - interval '1 minute')`);
    l = await liveness();
    expect(l.last_success_at).not.toBeNull();
    expect(Number(l.seconds_since_success)).toBeGreaterThanOrEqual(55);
    expect(Number(l.seconds_since_success)).toBeLessThan(120);
    expect(l.last_status).toBe('succeeded');
  });

  it('ignores other phases and channels — this is the DISPATCH liveness', async () => {
    await c.query(`INSERT INTO public.notification_worker_runs (worker, channel, phase, status, ended_at) VALUES
      ('w','email','materialize','succeeded', now()),
      ('w','whatsapp','dispatch','succeeded', now())`);
    expect((await liveness()).last_success_at, 'a materialize run proves nothing about delivery').toBeNull();
  });

  it('an unfinished run is not liveness either', async () => {
    // A run is BORN unfinished: status NULL, ended_at NULL. Finishing is the only update.
    await c.query(`INSERT INTO public.notification_worker_runs (worker, channel, phase)
                   VALUES ('w','email','dispatch')`);
    expect((await liveness()).last_finished_at).toBeNull();
    expect((await liveness()).last_success_at).toBeNull();
  });

  it('service_role only — it is an operator/monitor read, not a public one', async () => {
    const acl = (await c.query(
      `SELECT has_function_privilege('anon','public.notif_digest_worker_liveness()','EXECUTE') AS anon,
              has_function_privilege('authenticated','public.notif_digest_worker_liveness()','EXECUTE') AS auth,
              has_function_privilege('service_role','public.notif_digest_worker_liveness()','EXECUTE') AS sr`)).rows[0];
    expect([acl.anon, acl.auth, acl.sr]).toEqual([false, false, true]);
  });
});
