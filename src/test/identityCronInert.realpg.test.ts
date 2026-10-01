// @vitest-environment node
// U2 slice A — the identity sender's cron ships INACTIVE, and re-applying the migration must never
// disarm a job an owner has already armed.
//
// This replaces a source-regex assertion that could not hold the property. Twice. The first version
// searched the whole migration for `username = current_user`, which also appears in the activation
// comment, so deleting the executable predicate stayed green. The second pinned "no RETURN before
// the existing-job guard", which a RETURN placed AFTER that guard walks straight past — leaving
// `cron.schedule` unreachable while the test still passed. A text assertion keeps losing to text.
//
// So the migration is executed here, against a minimal pg_cron stub, and the assertions are about
// what ends up in `cron.job`. pg_cron does not exist in embedded-postgres; the stub models the two
// behaviours this migration actually depends on — `cron.schedule` UPSERTing on (jobname, username),
// and jobname being unique PER USERNAME rather than globally. Modelling either one wrong would make
// the owner-scoping look safe without testing it.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 54389;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let c: pg.Client;

const MIG_PATH = join(process.cwd(), 'supabase', 'migrations', '20261202100000_u2_identity_worker_cron_inert.sql');
const MIG = readFileSync(MIG_PATH, 'utf8');
const JOB = 'notification-identity-worker';

/** The stub, rebuilt from scratch for each test so no test can inherit another's cron state. */
const buildStub = async (opts: { vaultSecret: boolean }) => {
  await c.query(`DROP SCHEMA IF EXISTS cron CASCADE; DROP SCHEMA IF EXISTS vault CASCADE;`);
  await c.query(`
    CREATE SCHEMA cron;
    -- UNIQUE (jobname, username), exactly as real pg_cron scopes it. A globally unique jobname
    -- would make this migration's owner-scoped lookup untestable and its lookups look safe.
    CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text,
                           username text NOT NULL DEFAULT current_user,
                           active boolean NOT NULL DEFAULT true, UNIQUE (jobname, username));
    -- real cron.schedule UPSERTS rather than failing on a duplicate name
    CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint
      LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_schedule, p_command)
        ON CONFLICT (jobname, username) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
        RETURNING jobid $$;
    CREATE FUNCTION cron.alter_job(p_jobid bigint, active boolean) RETURNS void
      LANGUAGE sql AS $$ UPDATE cron.job SET active = $2 WHERE jobid = $1 $$;
    CREATE FUNCTION cron.unschedule(p_name text) RETURNS boolean
      LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = $1 RETURNING true $$;
    CREATE SCHEMA vault;
    CREATE TABLE vault.decrypted_secrets (name text PRIMARY KEY, decrypted_secret text);`);
  if (opts.vaultSecret) {
    await c.query(`INSERT INTO vault.decrypted_secrets VALUES ('service_role_key', 'eyJ.SERVICE_ROLE_TEST.sig')`);
  }
  // The migration's pg_cron guard reads pg_extension, so the stub has to be visible there. The row
  // is re-pointed each time because dropping and recreating the cron schema leaves the previous
  // extnamespace dangling. (ON CONFLICT is rejected on system catalogs, hence delete-then-insert.)
  await c.query(`DELETE FROM pg_extension WHERE extname = 'pg_cron'`);
  await c.query(`
    INSERT INTO pg_extension (oid, extname, extowner, extnamespace, extrelocatable, extversion)
      SELECT 999998, 'pg_cron', 10, n.oid, false, '1.6' FROM pg_namespace n WHERE n.nspname = 'cron';`);
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-cron-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise(); await epg.start();
  c = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();
  await c.query(`CREATE ROLE other_owner;`);
}, 180_000);

afterAll(async () => { if (c) await c.end(); if (epg) await epg.stop(); });

beforeEach(async () => { await buildStub({ vaultSecret: true }); });

const job = async () =>
  (await c.query(`SELECT jobid, jobname, schedule, command, username, active FROM cron.job
                   WHERE jobname=$1 AND username=current_user`, [JOB])).rows[0];

describe('U2 slice A — the identity cron is installed INERT', () => {
  it('creates the job and leaves it INACTIVE, in the same transaction', async () => {
    await c.query(MIG);
    const j = await job();
    expect(j, 'the job must exist — the acceptance is "present but INACTIVE"').toBeTruthy();
    expect(j.active, 'ACTIVATION IS AN OWNER GATE').toBe(false);
    expect(j.schedule).toBe('*/2 * * * *');
  });

  it('installs even with NO Vault secret — an apply-time skip would record the migration over nothing', async () => {
    // This is the property the deleted source assertion was trying to hold. On a restore where
    // migrations run before out-of-band secrets, an early return would mark the migration applied
    // and adding the key later would never create the job.
    await buildStub({ vaultSecret: false });
    await c.query(MIG);
    const j = await job();
    expect(j, 'the job must be installed even without the Vault secret').toBeTruthy();
    expect(j.active).toBe(false);
  });

  it('stores a command that reads the bearer at TICK time, never a baked-in key', async () => {
    await c.query(MIG);
    const j = await job();
    expect(j.command).toContain(`url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/${JOB}'`);
    expect(j.command, 'no key may ever be frozen into the schedule').not.toContain('eyJ.SERVICE_ROLE_TEST');
    expect(j.command).toContain('vault.decrypted_secrets');
  });

  it('stores EXACTLY what the migration schedules, and every name in it is qualified', async () => {
    await c.query(MIG);
    const j = await job();
    // compared against the migration's own text rather than a retyped copy, so any drift fails here
    const scheduled = MIG.match(
      new RegExp(`cron\\.schedule\\(\\s*'${JOB}'\\s*,\\s*'[^']+'\\s*,\\s*\\$cmd\\$([\\s\\S]*?)\\$cmd\\$\\s*\\)`))?.[1];
    expect(scheduled, 'the migration must still schedule the job in the expected form').toBeTruthy();
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(norm(j.command)).toBe(norm(scheduled!));
    // a tick runs under its owner's search_path and resolution does not prefer pg_catalog, so an
    // exact-arity overload in `public` would receive the decrypted bearer
    for (const q of ['pg_catalog.jsonb_build_object', 'OPERATOR(pg_catalog.||)', 'OPERATOR(pg_catalog.=)', '::pg_catalog.jsonb']) {
      expect(j.command, `the stored command must qualify ${q}`).toContain(q);
    }
  });

  it('re-applying leaves an ARMED job armed and unchanged — the whole point of the guard', async () => {
    await c.query(MIG);
    const before = await job();
    // the owner arms it, as they would at the cutover
    await c.query(`UPDATE cron.job SET active = true WHERE jobid = $1`, [before.jobid]);
    await c.query(MIG);
    const after = await job();
    expect(after.active, 'a re-apply must NOT disarm a sender the owner already armed').toBe(true);
    expect(after.jobid, 'and must not recreate it under a new id').toBe(before.jobid);
    expect(after.command).toBe(before.command);
    expect(after.schedule).toBe(before.schedule);
  });

  it('re-applying leaves an INACTIVE job inactive, and does not duplicate it', async () => {
    await c.query(MIG);
    await c.query(MIG);
    const rows = (await c.query(`SELECT * FROM cron.job WHERE jobname=$1`, [JOB])).rows;
    expect(rows.length, 'exactly one job for this owner').toBe(1);
    expect(rows[0].active).toBe(false);
  });

  it('does not select or alter a same-name job owned by ANOTHER role', async () => {
    // pg_cron scopes uniqueness by (jobname, username). A bare jobname lookup would find this row,
    // and either disable someone else's armed job or return early and never create our own.
    await c.query(`INSERT INTO cron.job (jobname, schedule, command, username, active)
                   VALUES ($1, '*/9 * * * *', 'SELECT 1', 'other_owner', true)`, [JOB]);
    await c.query(MIG);

    const theirs = (await c.query(`SELECT * FROM cron.job WHERE jobname=$1 AND username='other_owner'`, [JOB])).rows[0];
    expect(theirs.active, "another role's job must be left armed").toBe(true);
    expect(theirs.schedule, "…and untouched").toBe('*/9 * * * *');
    expect(theirs.command).toBe('SELECT 1');

    const ours = await job();
    expect(ours, 'and OUR job must still have been created').toBeTruthy();
    expect(ours.active).toBe(false);
    expect(ours.schedule).toBe('*/2 * * * *');
  });

  it('SERIALIZES against a concurrent apply — the advisory lock is load-bearing', async () => {
    // cron.schedule UPSERTS on (jobname, username), so an unserialized check-then-create can see
    // "absent", then update a job a concurrent apply had just created — and disable it. The lock is
    // what closes that, and nothing else in this file would notice if it were deleted.
    //
    // Proven by contention: a second connection holds the SAME transaction-scoped advisory lock, and
    // the migration must then BLOCK rather than proceed. A short statement_timeout turns "blocked"
    // into an observable error (55P03/57014) instead of a hung test.
    const other = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT pg_advisory_xact_lock(hashtextextended('cron:${JOB}', 0))`);

      await c.query(`SET statement_timeout = '2s'`);
      let blocked = false;
      try {
        await c.query(MIG);
      } catch (e) {
        blocked = /timeout|canceling statement/i.test(String((e as Error).message));
      }
      await c.query(`RESET statement_timeout`);
      expect(blocked, 'the migration must wait on the advisory lock a concurrent apply holds').toBe(true);

      // and once the other transaction releases it, the migration completes normally
      await other.query('ROLLBACK');
      await c.query(MIG);
      const j = await job();
      expect(j, 'after the lock is released the job installs').toBeTruthy();
      expect(j.active).toBe(false);
    } finally {
      await other.end();
    }
  });

  it('makes no outbound request while applying — the command is stored, not executed', async () => {
    // net is never installed here. If applying the migration tried to EXECUTE net.http_post rather
    // than store it as text, this would raise `schema "net" does not exist` instead of succeeding.
    const netExists = await c.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'net'`);
    expect(netExists.rowCount, 'the premise: there is no net schema to call').toBe(0);
    await expect(c.query(MIG)).resolves.toBeTruthy();
    const j = await job();
    expect(j.command).toContain('net.http_post');   // stored…
    expect(j.active).toBe(false);                    // …and never armed, so never ticked
  });
});
