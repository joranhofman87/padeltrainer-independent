// @vitest-environment node
// P0: academy managers could not CREATE guest players. The P2-2 migration
// (20260706130100) narrowed the academy SELECT policy to
// guest_belongs_to_user_academy(id, auth.uid()), which determines membership by
// RE-READING guest_players BY id. The app inserts with `.insert().select()` →
// INSERT ... RETURNING, and Postgres applies the SELECT policy to the RETURNING row;
// the just-inserted row isn't yet visible to the function's nested self-read, so it
// returns false and the row is rejected: "new row violates row-level security policy".
// The plain INSERT WITH CHECK passes — only the RETURNING/SELECT step fails — so guests
// could be READ but never CREATED, on every academy account.
//
// This reproduces the bug against the broken policy, loads the REAL fix migration
// (20260801100000), and proves INSERT ... RETURNING works while tenant isolation holds.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MGR = '11111111-1111-1111-1111-111111111111';       // manages Academy A
const STRANGER = '99999999-9999-9999-9999-999999999999';  // manages Academy B only
const ACADEMY_A = '22222222-2222-2222-2222-222222222222';
const ACADEMY_B = '33333333-3333-3333-3333-333333333333';

const readMigration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SELECT set_config('test.uid', '${userId}', false); SET ROLE authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('test.uid', '', false);`);
  }
}

const insertReturning = (userId: string, academyId: string, name: string) =>
  asUser(userId, () =>
    db.query<{ id: string }>(
      `INSERT INTO guest_players (academy_profile_id, full_name, rating_system)
       VALUES ($1, $2, 'knltb') RETURNING id`,
      [academyId, name],
    ),
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE academy_profiles (id uuid PRIMARY KEY, name text);
    CREATE TABLE academy_managers (academy_profile_id uuid, user_id uuid, role text);
    CREATE TABLE availability_slots (id uuid PRIMARY KEY, academy_profile_id uuid);
    CREATE TABLE bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, guest_player_id uuid);
    CREATE TABLE academy_player_metadata (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, academy_profile_id uuid);
    CREATE TABLE guest_players (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid, academy_profile_id uuid, full_name text, rating_system text
    );

    -- SECURITY DEFINER helpers exactly as deployed (definer → bypass RLS on their reads).
    CREATE FUNCTION public.get_user_academy_ids(_user_id uuid) RETURNS SETOF uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _user_id
    $fn$;

    -- The P2-2 predicate: branch (a) re-reads guest_players BY id — the RETURNING trap.
    CREATE FUNCTION public.guest_belongs_to_user_academy(_guest_id uuid, _user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (
          SELECT 1 FROM public.guest_players gp
          WHERE gp.id = _guest_id
            AND gp.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))
        )
        OR EXISTS (
          SELECT 1 FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
          WHERE b.guest_player_id = _guest_id
            AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))
        )
        OR EXISTS (
          SELECT 1 FROM public.academy_player_metadata m
          WHERE m.guest_player_id = _guest_id
            AND m.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))
        )
    $fn$;

    CREATE ROLE authenticated;
    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

    ALTER TABLE guest_players ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Academy managers can create guest players for their trainers"
      ON guest_players FOR INSERT TO authenticated
      WITH CHECK (academy_profile_id IN (SELECT get_user_academy_ids(auth.uid())));
    -- The BROKEN P2-2 SELECT policy (id self-lookup only).
    CREATE POLICY "Academy managers can view related academy guest players"
      ON guest_players FOR SELECT TO authenticated
      USING (guest_belongs_to_user_academy(id, auth.uid()));

    INSERT INTO academy_profiles (id, name) VALUES ('${ACADEMY_A}', 'A'), ('${ACADEMY_B}', 'B');
    INSERT INTO academy_managers (academy_profile_id, user_id, role) VALUES
      ('${ACADEMY_A}', '${MGR}', 'owner'),
      ('${ACADEMY_B}', '${STRANGER}', 'owner');
  `);
});

describe('guest_players INSERT ... RETURNING for academy managers (real fix migration)', () => {
  it('reproduces the bug: INSERT ... RETURNING is rejected under the P2-2 SELECT policy', async () => {
    await expect(insertReturning(MGR, ACADEMY_A, 'Repro')).rejects.toThrow(/row-level security/i);
  });

  it('plain INSERT (no RETURNING) already worked — proving it is the RETURNING/SELECT step', async () => {
    await asUser(MGR, () =>
      db.query(
        `INSERT INTO guest_players (academy_profile_id, full_name, rating_system)
         VALUES ($1, 'NoReturn', 'knltb')`,
        [ACADEMY_A],
      ),
    );
    await db.exec(`DELETE FROM guest_players WHERE full_name = 'NoReturn'`);
  });

  it('fix migration applies cleanly', async () => {
    await db.exec(readMigration('20260801100000_fix_guest_players_select_returning.sql'));
  });

  it('after fix: a manager CAN INSERT ... RETURNING a guest for their academy', async () => {
    const r = await insertReturning(MGR, ACADEMY_A, 'Fixed');
    expect(r.rows).toHaveLength(1);
  });

  it('isolation preserved: a manager of another academy is BLOCKED from creating a guest for academy A', async () => {
    await expect(insertReturning(STRANGER, ACADEMY_A, 'X-tenant')).rejects.toThrow(/row-level security/i);
  });

  it('isolation preserved: a manager of another academy cannot SELECT academy A guests', async () => {
    const ids = await asUser(STRANGER, () =>
      db.query<{ id: string }>(`SELECT id FROM guest_players WHERE academy_profile_id = $1`, [ACADEMY_A]),
    );
    expect(ids.rows).toHaveLength(0);
  });
});
