// @vitest-environment node
/**
 * U1b — the backfill logbook (`membership_backfill_runs` / `membership_backfill_items`): exact
 * catalog shape, default-deny ACL, and the constraints the resume/rollback model depends on.
 *
 * Runs the REAL migration UNSTRIPPED, for the same reason the U1a suite does: stripping GRANT/REVOKE
 * (the usual PGlite shortcut in this repo) would delete the statements under test and every ACL
 * assertion would pass vacuously. So the Supabase roles are created first, the project's
 * `ALTER DEFAULT PRIVILEGES` auto-grants are reproduced — that is what makes a named-role REVOKE
 * load-bearing at all — and only then is the migration applied verbatim.
 *
 * The constraint assertions are not schema trivia. Each one is a guard the applier or the rollback
 * leans on, and if it is quietly dropped the failure is silent: rows written twice, or written with
 * no way to attribute them back to the run that created them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const U1A = 'supabase/migrations/20261113100000_u1a_academy_player_memberships.sql';
const U1B = 'supabase/migrations/20261114100000_u1b_membership_backfill_manifest.sql';
const SEED = 'supabase/seed.sql';

const RUNS = 'public.membership_backfill_runs';
const ITEMS = 'public.membership_backfill_items';

const ACADEMY = '11111111-1111-4111-8111-111111111111';
const PERSON = '33333333-3333-4333-8333-333333333333';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();

  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  `);

  // Probe: prove the default privileges REALLY grant on this engine. Without it the ACL assertions
  // could pass on an engine that silently ignored ALTER DEFAULT PRIVILEGES — i.e. the migration's
  // REVOKE would look load-bearing while being untested.
  await db.exec('CREATE TABLE public._acl_probe (id int);');

  await db.exec(`
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    INSERT INTO public.academy_profiles VALUES ('${ACADEMY}');
    INSERT INTO public.persons VALUES ('${PERSON}');
  `);

  await db.exec(readFileSync(U1A, 'utf8'));
  await db.exec(readFileSync(U1B, 'utf8'));
});

afterAll(async () => { await db?.close(); });

const newRun = async (planHash = 'hash-a', planned = 1) => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ${RUNS} (plan_hash, inventory_version, as_of, planned_row_count, batch_size)
     VALUES ($1, 'u1a.1', timestamptz '2026-08-08T00:00:00Z', $2, 100) RETURNING id`,
    [planHash, planned],
  );
  return rows[0].id;
};

/** Tear down a fixture run. Items first — the FK is RESTRICT, deliberately. */
const dropRun = async (...ids: string[]) => {
  await db.query(`DELETE FROM ${ITEMS} WHERE run_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM ${RUNS} WHERE id = ANY($1)`, [ids]);
};

describe('U1b backfill logbook — the ACL probe is real', () => {
  it('default privileges genuinely grant on this engine', async () => {
    const { rows } = await db.query<{ granted: boolean }>(
      `SELECT has_table_privilege('service_role', 'public._acl_probe', 'SELECT') AS granted`);
    expect(rows[0].granted).toBe(true);
  });
});

describe('U1b backfill logbook — catalog shape', () => {
  it('both tables exist and start EMPTY', async () => {
    const { rows } = await db.query<{ runs: number; items: number }>(
      `SELECT (SELECT count(*)::int FROM ${RUNS}) AS runs, (SELECT count(*)::int FROM ${ITEMS}) AS items`);
    expect(rows[0]).toEqual({ runs: 0, items: 0 });
  });

  it('runs has exactly its declared columns and nothing more', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='membership_backfill_runs' ORDER BY column_name`);
    expect(rows.map((r) => r.column_name)).toEqual([
      'as_of', 'batch_size', 'completed_at', 'created_at', 'id', 'inventory_version',
      'plan_hash', 'planned_row_count', 'started_at', 'status', 'updated_at',
    ]);
  });

  it('items has exactly its declared columns and nothing more', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='membership_backfill_items' ORDER BY column_name`);
    expect(rows.map((r) => r.column_name)).toEqual([
      'academy_profile_id', 'batch_seq', 'created_at', 'id', 'membership_id', 'outcome',
      'person_id', 'run_id',
    ]);
  });

  it('items references its run with RESTRICT and has no other FK', async () => {
    // Exactly one FK, and it must be RESTRICT ('r'), not CASCADE: cascading would let a single
    // `DELETE FROM membership_backfill_runs` erase the provenance of membership rows that still
    // exist. And there must be NO FK to academy_player_memberships — the log has to outlive the rows
    // it describes, which is the whole point of a rollback record.
    const { rows } = await db.query<{ confrelid: string; confdeltype: string }>(
      `SELECT confrelid::regclass::text AS confrelid, confdeltype
       FROM pg_constraint WHERE conrelid = '${ITEMS}'::regclass AND contype = 'f'`);
    expect(rows).toEqual([{ confrelid: 'membership_backfill_runs', confdeltype: 'r' }]);
  });

  it('membership_id is NOT NULL, so no line can claim a pair is done without naming its row', async () => {
    const { rows } = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='membership_backfill_items'
         AND column_name='membership_id'`);
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('the run keeps updated_at current through the shared trigger', async () => {
    const id = await newRun('hash-trigger');
    const before = await db.query<{ updated_at: Date }>(`SELECT updated_at FROM ${RUNS} WHERE id=$1`, [id]);
    await db.query(`UPDATE ${RUNS} SET planned_row_count = 7 WHERE id=$1`, [id]);
    const after = await db.query<{ updated_at: Date }>(`SELECT updated_at FROM ${RUNS} WHERE id=$1`, [id]);
    expect(new Date(after.rows[0].updated_at).getTime())
      .toBeGreaterThanOrEqual(new Date(before.rows[0].updated_at).getTime());
    await db.query(`DELETE FROM ${RUNS} WHERE id=$1`, [id]);
  });
});

describe('U1b backfill logbook — the guards the applier depends on', () => {
  it('rejects a second item for the same pair in one run (the double-write guard)', async () => {
    const runId = await newRun('hash-dup');
    const ins = () => db.query(
      `INSERT INTO ${ITEMS} (run_id, academy_profile_id, person_id, membership_id, batch_seq, outcome)
       VALUES ($1, $2, $3, gen_random_uuid(), 0, 'inserted')`,
      [runId, ACADEMY, PERSON]);
    await ins();
    await expect(ins()).rejects.toThrow();
    await dropRun(runId);
  });

  it('allows the SAME pair under a different run', async () => {
    // Two runs may legitimately touch one pair — the second records it already_present.
    const a = await newRun('hash-r1');
    const b = await newRun('hash-r2');
    await db.query(
      `INSERT INTO ${ITEMS} (run_id, academy_profile_id, person_id, membership_id, batch_seq, outcome)
       VALUES ($1,$2,$3, gen_random_uuid(), 0, 'inserted')`, [a, ACADEMY, PERSON]);
    await expect(db.query(
      `INSERT INTO ${ITEMS} (run_id, academy_profile_id, person_id, membership_id, batch_seq, outcome)
       VALUES ($1,$2,$3, gen_random_uuid(), 0, 'already_present')`, [b, ACADEMY, PERSON])).resolves.toBeTruthy();
    await dropRun(a, b);
  });

  it('rejects an item with no membership_id, whichever outcome it claims', async () => {
    // BOTH directions. An 'already_present' line with nothing to point at is just as damaging as an
    // 'inserted' one: the pair leaves the remaining set, so it is never retried, and no membership row
    // exists. That is the one way this design can lose a planned row.
    const runId = await newRun('hash-noid');
    for (const outcome of ['inserted', 'already_present']) {
      await expect(db.query(
        `INSERT INTO ${ITEMS} (run_id, academy_profile_id, person_id, membership_id, batch_seq, outcome)
         VALUES ($1,$2,$3, NULL, 0, $4)`, [runId, ACADEMY, PERSON, outcome])).rejects.toThrow();
    }
    await dropRun(runId);
  });

  it('rejects an unknown outcome and an unknown status', async () => {
    const runId = await newRun('hash-enum');
    await expect(db.query(
      `INSERT INTO ${ITEMS} (run_id, academy_profile_id, person_id, membership_id, batch_seq, outcome)
       VALUES ($1,$2,$3, gen_random_uuid(), 0, 'maybe')`, [runId, ACADEMY, PERSON])).rejects.toThrow();
    await expect(db.query(`UPDATE ${RUNS} SET status='finished' WHERE id=$1`, [runId])).rejects.toThrow();
    await dropRun(runId);
  });

  it('refuses a terminal run with no completed_at, and a live run that has one', async () => {
    const runId = await newRun('hash-consistency');
    await expect(db.query(`UPDATE ${RUNS} SET status='completed' WHERE id=$1`, [runId])).rejects.toThrow();
    await expect(db.query(`UPDATE ${RUNS} SET completed_at=now() WHERE id=$1`, [runId])).rejects.toThrow();
    await expect(db.query(
      `UPDATE ${RUNS} SET status='completed', completed_at=now() WHERE id=$1`, [runId])).resolves.toBeTruthy();
    await dropRun(runId);
  });

  it('REFUSES to delete a run while its evidence lines exist', async () => {
    // Deleting a run must not be a way to quietly erase the provenance of membership rows that are
    // still in the table. Discarding evidence has to be explicit: items first, deliberately.
    const runId = await newRun('hash-restrict');
    await db.query(
      `INSERT INTO ${ITEMS} (run_id, academy_profile_id, person_id, membership_id, batch_seq, outcome)
       VALUES ($1,$2,$3, gen_random_uuid(), 0, 'inserted')`, [runId, ACADEMY, PERSON]);
    await expect(db.query(`DELETE FROM ${RUNS} WHERE id=$1`, [runId])).rejects.toThrow();

    await db.query(`DELETE FROM ${ITEMS} WHERE run_id=$1`, [runId]);
    await expect(db.query(`DELETE FROM ${RUNS} WHERE id=$1`, [runId])).resolves.toBeTruthy();
  });

  it('an item survives the membership row it names (the log outlives the row)', async () => {
    const runId = await newRun('hash-outlive');
    const { rows: m } = await db.query<{ id: string }>(
      `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id)
       VALUES ($1,$2) RETURNING id`, [ACADEMY, PERSON]);
    await db.query(
      `INSERT INTO ${ITEMS} (run_id, academy_profile_id, person_id, membership_id, batch_seq, outcome)
       VALUES ($1,$2,$3,$4,0,'inserted')`, [runId, ACADEMY, PERSON, m[0].id]);
    await db.query('DELETE FROM public.academy_player_memberships WHERE id=$1', [m[0].id]);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${ITEMS} WHERE membership_id=$1`, [m[0].id]);
    expect(rows[0].n).toBe(1);
    await dropRun(runId);
  });
});

describe('U1b backfill logbook — default-deny', () => {
  it('has RLS enabled with zero policies on both tables', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; policies: number }>(
      `SELECT c.relname, c.relrowsecurity,
              (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
       FROM pg_class c
       WHERE c.relname IN ('membership_backfill_runs','membership_backfill_items')
       ORDER BY c.relname`);
    expect(rows).toEqual([
      { relname: 'membership_backfill_items', relrowsecurity: true, policies: 0 },
      { relname: 'membership_backfill_runs', relrowsecurity: true, policies: 0 },
    ]);
  });

  it('grants nothing to anon, authenticated or service_role', async () => {
    for (const table of [RUNS, ITEMS]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const { rows } = await db.query<{ ok: boolean }>(
            `SELECT has_table_privilege($1, $2, $3) AS ok`, [role, table, priv]);
          expect(`${role}:${table}:${priv}=${rows[0].ok}`).toBe(`${role}:${table}:${priv}=false`);
        }
      }
    }
  });

  it('stays default-deny after the seed re-grants everything', async () => {
    // seed.sql GRANTs ALL ON ALL TABLES to service_role on every reset; the deny-list REVOKE that
    // follows it is the only reason the property survives locally and in CI.
    await db.exec(readFileSync(SEED, 'utf8'));
    for (const table of [RUNS, ITEMS, 'public.academy_player_memberships']) {
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT has_table_privilege('service_role', $1, 'SELECT') AS ok`, [table]);
      expect(`${table}=${rows[0].ok}`).toBe(`${table}=false`);
    }
  });
});
