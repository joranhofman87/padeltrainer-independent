// @vitest-environment node
/**
 * U1a — `academy_player_memberships` skeleton: exact catalog shape, default-deny ACL, behaviour.
 *
 * Runs the REAL migration file UNSTRIPPED. That matters: most PGlite suites in this repo strip
 * GRANT/REVOKE because PGlite has no Supabase roles — but stripping them here would delete the very
 * statements under test and the ACL assertions would pass vacuously. So this suite CREATES the
 * Supabase roles first, reproduces the project's `ALTER DEFAULT PRIVILEGES` auto-grants (the reason
 * a named-role REVOKE is load-bearing at all), and only then applies the migration verbatim.
 *
 * It also reproduces `supabase/seed.sql`: the seed re-GRANTs ALL on ALL TABLES to service_role after
 * every reset, so the default-deny property is only real if the seed's deny-list REVOKE runs after
 * it. That sequence is asserted end-to-end here, and again for real by `supabase db reset`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const MIGRATION = 'supabase/migrations/20261113100000_u1a_academy_player_memberships.sql';
const SEED = 'supabase/seed.sql';
const TABLE = 'public.academy_player_memberships';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const PERSON2 = '44444444-4444-4444-8444-444444444444';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();

  // Supabase-like roles. service_role carries BYPASSRLS on the hosted project, which is exactly why
  // RLS alone cannot make this table default-deny — the privilege REVOKE has to do it.
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  `);

  // The project's default privileges: a NEWLY created table is auto-granted to these roles BY NAME.
  await db.exec(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  `);

  // Probe: prove the default privileges REALLY grant here. Without this the ACL assertions could pass
  // vacuously on an engine that silently ignored ALTER DEFAULT PRIVILEGES — i.e. the migration's
  // REVOKE would look load-bearing while actually being untested.
  await db.exec(`CREATE TABLE public._acl_probe (id int);`);

  // Parents + the shared timestamp function the migration depends on.
  await db.exec(`
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    INSERT INTO public.academy_profiles VALUES ('${A1}'), ('${A2}');
    INSERT INTO public.persons VALUES ('${PERSON}'), ('${PERSON2}');
  `);

  // THE REAL MIGRATION — verbatim, grants and revokes included.
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => { await db?.close(); });

const ROLES = ['anon', 'authenticated', 'service_role', 'public'] as const;
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

async function grantedPrivileges(): Promise<string[]> {
  const held: string[] = [];
  for (const role of ROLES) {
    for (const priv of PRIVS) {
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1, $2, $3) AS ok`, [role, TABLE, priv],
      );
      if (rows[0].ok) held.push(`${role}:${priv}`);
    }
  }
  return held;
}

describe('U1a — academy_player_memberships catalog shape', () => {
  it('has EXACTLY the five reviewed columns and nothing more', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'academy_player_memberships'
       ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'academy_profile_id', 'created_at', 'id', 'person_id', 'updated_at',
    ]);
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(byName.id.data_type).toBe('uuid');
    expect(byName.id.column_default).toContain('gen_random_uuid()');
    expect(byName.academy_profile_id.is_nullable).toBe('NO');
    expect(byName.person_id.is_nullable).toBe('NO');
    for (const ts of ['created_at', 'updated_at']) {
      expect(byName[ts].data_type).toBe('timestamp with time zone');
      expect(byName[ts].is_nullable).toBe('NO');
      expect(byName[ts].column_default).toContain('now()');
    }
  });

  it('pins the FK deletion actions: person RESTRICT (r), academy CASCADE (c)', async () => {
    const { rows } = await db.query<{ conname: string; confdeltype: string; reftable: string }>(
      `SELECT c.conname, c.confdeltype, cl.relname AS reftable
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class cl ON cl.oid = c.confrelid
       WHERE t.relname = 'academy_player_memberships' AND c.contype = 'f'
       ORDER BY cl.relname`,
    );
    const byRef = Object.fromEntries(rows.map((r) => [r.reftable, r.confdeltype]));
    // 'r' = RESTRICT (immediate, non-deferrable) — deliberately NOT 'a' (NO ACTION).
    expect(byRef.persons).toBe('r');
    expect(byRef.academy_profiles).toBe('c');
    expect(rows).toHaveLength(2);
  });

  it('pins the primary key and the FK column mappings', async () => {
    const pk = await db.query<{ conname: string; cols: string }>(
      `SELECT c.conname,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'academy_player_memberships' AND c.contype = 'p'`,
    );
    expect(pk.rows).toHaveLength(1);
    expect(pk.rows[0].cols).toBe('id');

    const fks = await db.query<{ reftable: string; localcol: string; refcol: string }>(
      `SELECT cl.relname AS reftable,
              (SELECT a.attname FROM pg_attribute a
               WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) AS localcol,
              (SELECT a.attname FROM pg_attribute a
               WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) AS refcol
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class cl ON cl.oid = c.confrelid
       WHERE t.relname = 'academy_player_memberships' AND c.contype = 'f'
       ORDER BY cl.relname`,
    );
    expect(fks.rows).toEqual([
      { reftable: 'academy_profiles', localcol: 'academy_profile_id', refcol: 'id' },
      { reftable: 'persons', localcol: 'person_id', refcol: 'id' },
    ]);
  });

  it('pins the unique/index column ORDER and the trigger timing + function', async () => {
    const uniq = await db.query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes
       WHERE tablename = 'academy_player_memberships'
         AND indexname = 'academy_player_memberships_academy_person_key'`,
    );
    // academy-leading: the person-leading access path is the separate index below
    expect(uniq.rows[0].def).toMatch(/\(academy_profile_id,\s*person_id\)/);

    const idx = await db.query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes
       WHERE tablename = 'academy_player_memberships'
         AND indexname = 'idx_academy_player_memberships_person'`,
    );
    expect(idx.rows[0].def).toMatch(/\(person_id\)/);

    const trg = await db.query<{ timing: number; fname: string }>(
      `SELECT tg.tgtype AS timing, p.proname AS fname
       FROM pg_trigger tg
       JOIN pg_class t ON t.oid = tg.tgrelid
       JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE t.relname = 'academy_player_memberships' AND NOT tg.tgisinternal`,
    );
    expect(trg.rows[0].fname).toBe('update_updated_at_column');
    // tgtype bit 0 = ROW, bit 1 = BEFORE, bit 4 = UPDATE  → BEFORE UPDATE FOR EACH ROW
    expect(trg.rows[0].timing & 1).toBe(1);
    expect(trg.rows[0].timing & 2).toBe(2);
    expect(trg.rows[0].timing & 16).toBe(16);
  });

  it('carries the exact reviewed constraint, index and trigger names', async () => {
    const uniq = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'academy_player_memberships' AND c.contype = 'u'`,
    );
    expect(uniq.rows.map((r) => r.conname)).toEqual(['academy_player_memberships_academy_person_key']);

    const idx = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'academy_player_memberships'
       ORDER BY indexname`,
    );
    expect(idx.rows.map((r) => r.indexname)).toContain('idx_academy_player_memberships_person');

    const trg = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger tg JOIN pg_class t ON t.oid = tg.tgrelid
       WHERE t.relname = 'academy_player_memberships' AND NOT tg.tgisinternal`,
    );
    expect(trg.rows.map((r) => r.tgname)).toEqual(['update_academy_player_memberships_updated_at']);
  });

  it('starts EMPTY — U1a ships a skeleton, never data', async () => {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`);
    expect(rows[0].n).toBe(0);
  });
});

describe('U1a — default-deny access', () => {
  it('the default-privilege auto-grant is REAL here (guards against a vacuous ACL proof)', async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege('service_role', 'public._acl_probe', 'SELECT') AS ok`,
    );
    expect(rows[0].ok).toBe(true);
  });

  it('has RLS enabled with ZERO policies (the absence IS the control)', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'academy_player_memberships'`,
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);

    const pol = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'academy_player_memberships'`,
    );
    expect(pol.rows[0].n).toBe(0);
  });

  it('grants NO direct privilege to PUBLIC, anon, authenticated or service_role', async () => {
    expect(await grantedPrivileges()).toEqual([]);
  });

  it('stays denied after the seed re-grants ALL on ALL TABLES to service_role', async () => {
    // Without the seed's deny-list this is exactly where default-deny would silently break: the
    // blanket grant lands after the migration on every local/CI reset.
    await db.exec(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
    expect(await grantedPrivileges()).not.toEqual([]); // sanity: the blanket grant really did apply

    // Apply the seed's deny-list block verbatim from supabase/seed.sql.
    const seed = readFileSync(SEED, 'utf8');
    const denyList = seed.slice(seed.indexOf('DO $$'));
    expect(denyList).toContain('academy_player_memberships');
    await db.exec(denyList);

    expect(await grantedPrivileges()).toEqual([]);
  });

  it('the seed deny-list is existence-guarded so a rolled-back reset still works', async () => {
    const seed = readFileSync(SEED, 'utf8');
    expect(seed).toContain("to_regclass('public.academy_player_memberships')");
  });
});

describe('U1a — behaviour', () => {
  it('rejects a duplicate (academy, person) membership', async () => {
    await db.exec(`INSERT INTO ${TABLE} (academy_profile_id, person_id) VALUES ('${A1}','${PERSON}')`);
    await expect(
      db.exec(`INSERT INTO ${TABLE} (academy_profile_id, person_id) VALUES ('${A1}','${PERSON}')`),
    ).rejects.toThrow(/academy_player_memberships_academy_person_key|duplicate key/);
  });

  it('rejects NULL keys — uniqueness cannot be defeated by NULL pairs', async () => {
    await expect(
      db.exec(`INSERT INTO ${TABLE} (academy_profile_id, person_id) VALUES (NULL,'${PERSON}')`),
    ).rejects.toThrow(/null value|not-null/i);
    await expect(
      db.exec(`INSERT INTO ${TABLE} (academy_profile_id, person_id) VALUES ('${A1}', NULL)`),
    ).rejects.toThrow(/null value|not-null/i);
  });

  it('rejects invalid academy and Player references', async () => {
    const ghost = '99999999-9999-4999-8999-999999999999';
    await expect(
      db.exec(`INSERT INTO ${TABLE} (academy_profile_id, person_id) VALUES ('${ghost}','${PERSON}')`),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      db.exec(`INSERT INTO ${TABLE} (academy_profile_id, person_id) VALUES ('${A1}','${ghost}')`),
    ).rejects.toThrow(/foreign key/i);
  });

  it('REFUSES to hard-delete a Player while a membership exists (OD-10)', async () => {
    await expect(
      db.exec(`DELETE FROM public.persons WHERE id = '${PERSON}'`),
    ).rejects.toThrow(/foreign key|violates/i);
    const still = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.persons WHERE id = '${PERSON}'`);
    expect(still.rows[0].n).toBe(1);
  });

  it('lets two academies relate to ONE Player independently', async () => {
    await db.exec(`INSERT INTO ${TABLE} (academy_profile_id, person_id) VALUES ('${A2}','${PERSON}')`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE person_id = '${PERSON}'`,
    );
    expect(rows[0].n).toBe(2);
  });

  it('academy deletion removes ONLY that academy\'s membership rows', async () => {
    await db.exec(`DELETE FROM public.academy_profiles WHERE id = '${A1}'`);

    const a1 = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE} WHERE academy_profile_id = '${A1}'`);
    expect(a1.rows[0].n).toBe(0);

    const a2 = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE} WHERE academy_profile_id = '${A2}'`);
    expect(a2.rows[0].n).toBe(1);

    // the Player survives its academy — financial/booking evidence lives elsewhere and is untouched
    const person = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.persons WHERE id = '${PERSON}'`);
    expect(person.rows[0].n).toBe(1);
  });

  it('maintains updated_at through the shared trigger', async () => {
    await db.exec(
      `INSERT INTO ${TABLE} (academy_profile_id, person_id, created_at, updated_at)
       VALUES ('${A2}','${PERSON2}', timestamptz '2020-01-01', timestamptz '2020-01-01')`,
    );
    await db.exec(`UPDATE ${TABLE} SET person_id = '${PERSON2}' WHERE person_id = '${PERSON2}'`);
    const { rows } = await db.query<{ moved: boolean; created_untouched: boolean }>(
      `SELECT updated_at > timestamptz '2020-01-01' AS moved,
              created_at = timestamptz '2020-01-01' AS created_untouched
       FROM ${TABLE} WHERE person_id = '${PERSON2}'`,
    );
    expect(rows[0].moved).toBe(true);
    expect(rows[0].created_untouched).toBe(true);
  });
});
