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
    -- the run ledger the liveness read summarises (the real shape, narrowed to what it reads)
    CREATE TABLE public.notification_worker_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), worker text, channel text NOT NULL,
      phase text NOT NULL, status text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz);
    -- a MINIMAL pg_cron stub: enough to observe what the migration does, and no more.
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text,
                           active boolean NOT NULL DEFAULT true);
    CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint
      LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_schedule, p_command) RETURNING jobid $$;
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
  (await c.query(`SELECT jobname, schedule, active FROM cron.job WHERE jobname='notification-digest-worker'`)).rows[0];
const liveness = async () => (await c.query(`SELECT * FROM public.notif_digest_worker_liveness()`)).rows[0];

describe('F — the digest cron is installed INERT', () => {
  it('creates the job and leaves it INACTIVE, in the same transaction', async () => {
    // Inert by construction: there is no window in which a scheduler tick could fire it.
    await c.query(MIG);
    const j = await job();
    expect(j, 'the job must exist — Stage 3 acceptance is "present but INACTIVE"').toBeTruthy();
    expect(j.active, 'ACTIVATION IS AN OWNER GATE').toBe(false);
    expect(j.schedule).toBe('*/5 * * * *');
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
    expect(after.jobid).toBe(before.jobid);
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

  it('skips cleanly when the Vault secret is absent (a fresh reset must not fail)', async () => {
    await c.query(`DELETE FROM vault.decrypted_secrets WHERE name='service_role_key'`);
    try {
      await c.query(MIG);
      expect(await job(), 'no key → no schedule, and no error').toBeUndefined();
    } finally {
      await c.query(`INSERT INTO vault.decrypted_secrets VALUES ('service_role_key','eyJ.SERVICE_ROLE_TEST.sig')`);
    }
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
    await c.query(`INSERT INTO public.notification_worker_runs (channel, phase, status, finished_at)
                   VALUES ('email','dispatch','failed', now() - interval '2 minutes')`);
    let l = await liveness();
    expect(l.last_success_at, 'a failed run is NOT a success').toBeNull();
    expect(l.last_status, 'but it IS the last thing that finished').toBe('failed');

    await c.query(`INSERT INTO public.notification_worker_runs (channel, phase, status, finished_at)
                   VALUES ('email','dispatch','succeeded', now() - interval '1 minute')`);
    l = await liveness();
    expect(l.last_success_at).not.toBeNull();
    expect(Number(l.seconds_since_success)).toBeGreaterThanOrEqual(55);
    expect(Number(l.seconds_since_success)).toBeLessThan(120);
    expect(l.last_status).toBe('succeeded');
  });

  it('ignores other phases and channels — this is the DISPATCH liveness', async () => {
    await c.query(`INSERT INTO public.notification_worker_runs (channel, phase, status, finished_at) VALUES
      ('email','materialize','succeeded', now()),
      ('whatsapp','dispatch','succeeded', now())`);
    expect((await liveness()).last_success_at, 'a materialize run proves nothing about delivery').toBeNull();
  });

  it('an unfinished run is not liveness either', async () => {
    await c.query(`INSERT INTO public.notification_worker_runs (channel, phase, status)
                   VALUES ('email','dispatch','running')`);
    expect((await liveness()).last_finished_at).toBeNull();
  });

  it('service_role only — it is an operator/monitor read, not a public one', async () => {
    const acl = (await c.query(
      `SELECT has_function_privilege('anon','public.notif_digest_worker_liveness()','EXECUTE') AS anon,
              has_function_privilege('authenticated','public.notif_digest_worker_liveness()','EXECUTE') AS auth,
              has_function_privilege('service_role','public.notif_digest_worker_liveness()','EXECUTE') AS sr`)).rows[0];
    expect([acl.anon, acl.auth, acl.sr]).toEqual([false, false, true]);
  });
});
