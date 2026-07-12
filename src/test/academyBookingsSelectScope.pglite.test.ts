// @vitest-environment node
// Audit Batch 5 (§4.5 P1): the academy-manager bookings SELECT policy scoped by ACTIVE-trainer
// membership, so a departed trainer's bookings vanished from reports retroactively AND a trainer
// active in two academies leaked the other academy's bookings. Reproduces both against the ORIGINAL
// policy, then loads the REAL fix migration (academy_profile_id boundary) and proves: the departed
// trainer's academy bookings are visible again, the other academy's are not, own stay visible.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD_A = '30000000-0000-0000-0000-0000000000a1';
const ACAD_B = '30000000-0000-0000-0000-0000000000b1';
const MGR_A = '10000000-0000-0000-0000-0000000000a9'; // manages ACAD_A
const T_SHARED = '20000000-0000-0000-0000-000000000001'; // active in A AND B
const T_GONE = '20000000-0000-0000-0000-000000000002';   // departed from A (inactive)
const SL_A = '40000000-0000-0000-0000-0000000000a1';    // academy A, shared trainer
const SL_B = '40000000-0000-0000-0000-0000000000b1';    // academy B, shared trainer
const SL_GONE = '40000000-0000-0000-0000-0000000000d1'; // academy A, departed trainer
const B_A = '50000000-0000-0000-0000-0000000000a1';
const B_B = '50000000-0000-0000-0000-0000000000b1';
const B_GONE = '50000000-0000-0000-0000-0000000000d1';

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SELECT set_config('test.uid', '${userId}', false); SET ROLE authenticated;`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('test.uid', '', false);`); }
}
const visibleBookings = (userId: string) =>
  asUser(userId, () => db.query<{ id: string }>(`SELECT id FROM bookings ORDER BY id`))
    .then((r) => r.rows.map((row) => row.id));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE FUNCTION public.get_user_academy_ids(_uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$
      SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _uid $fn$;

    CREATE TABLE academy_trainers (trainer_profile_id uuid, academy_profile_id uuid, status text);
    CREATE TABLE availability_slots (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid);
    CREATE TABLE bookings (id uuid PRIMARY KEY, slot_id uuid, status text);

    CREATE ROLE anon; CREATE ROLE authenticated;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

    ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
    -- The ORIGINAL policy (20260325192818): active-trainer scoped.
    CREATE POLICY "Academy managers can view bookings for their trainers slots"
      ON bookings FOR SELECT TO authenticated
      USING (
        slot_id IN (
          SELECT s.id FROM availability_slots s
          WHERE s.trainer_id IN (
            SELECT at.trainer_profile_id FROM academy_trainers at
            WHERE at.status = 'active'
              AND at.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
          )
        )
      );

    INSERT INTO public.academy_managers VALUES ('${MGR_A}', '${ACAD_A}');
    INSERT INTO public.academy_trainers VALUES
      ('${T_SHARED}', '${ACAD_A}', 'active'), ('${T_SHARED}', '${ACAD_B}', 'active'),
      ('${T_GONE}',   '${ACAD_A}', 'inactive');  -- departed from A
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id) VALUES
      ('${SL_A}', '${T_SHARED}', '${ACAD_A}'),
      ('${SL_B}', '${T_SHARED}', '${ACAD_B}'),
      ('${SL_GONE}', '${T_GONE}', '${ACAD_A}');
    INSERT INTO public.bookings (id, slot_id, status) VALUES
      ('${B_A}', '${SL_A}', 'confirmed'),
      ('${B_B}', '${SL_B}', 'confirmed'),
      ('${B_GONE}', '${SL_GONE}', 'confirmed');
  `);
});

describe('academy bookings SELECT scope (real migration SQL)', () => {
  it('reproduces the bug: departed trainer VANISHES, other academy LEAKS in', async () => {
    const ids = await visibleBookings(MGR_A);
    expect(ids).toContain(B_A);       // own academy, active trainer
    expect(ids).toContain(B_B);       // LEAK: academy B via the shared trainer
    expect(ids).not.toContain(B_GONE); // departed trainer's academy-A booking vanished
  });

  it('fix migration applies cleanly (incl. its install assertion)', async () => {
    await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260814100000_academy_bookings_select_by_academy.sql'), 'utf8'));
  });

  it('after fix: the departed trainer\'s academy booking is back, the other academy\'s is gone', async () => {
    const ids = await visibleBookings(MGR_A);
    expect(ids).toContain(B_A);        // own academy still visible
    expect(ids).toContain(B_GONE);     // departed trainer's academy-A booking now visible
    expect(ids).not.toContain(B_B);    // academy B never leaks in
  });
});
