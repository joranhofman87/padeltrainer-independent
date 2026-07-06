// @vitest-environment node
// Trainer-audit P1: guests minted by the PUBLIC payment flows on academy slots are
// academy-owned (create-guest-*-payment), and trainer RLS on guest_players was
// own-rows only — the trainer saw a paying newcomer as "Unknown" everywhere.
// Reproduces that against the original own-rows policy, then loads the REAL fix
// migration (20260713110000) and proves: booked-into-own-slot guests become
// readable, other trainers' guests / cancelled seats stay hidden, own guests keep
// working.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const TRAINER_USER = '10000000-0000-0000-0000-0000000000a1';
const TRAINER_TP = '10000000-0000-0000-0000-0000000000a2';
const OTHER_USER = '20000000-0000-0000-0000-0000000000b1';
const OTHER_TP = '20000000-0000-0000-0000-0000000000b2';
const ACADEMY = '30000000-0000-0000-0000-0000000000c1';
const SLOT_MINE = '40000000-0000-0000-0000-0000000000d1';
const SLOT_OTHER = '40000000-0000-0000-0000-0000000000d2';
const GUEST_PUBLIC = '50000000-0000-0000-0000-0000000000e1'; // academy-owned, booked on my slot
const GUEST_ELSEWHERE = '50000000-0000-0000-0000-0000000000e2'; // academy-owned, booked on other trainer's slot
const GUEST_CANCELLED = '50000000-0000-0000-0000-0000000000e3'; // academy-owned, cancelled seat on my slot
const GUEST_OWN = '50000000-0000-0000-0000-0000000000e4'; // trainer-owned (pre-existing policy)

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

const visibleGuests = (userId: string) =>
  asUser(userId, () =>
    db.query<{ id: string }>(`SELECT id FROM guest_players ORDER BY id`),
  ).then(r => r.rows.map(row => row.id));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY,
      trainer_id uuid,
      academy_profile_id uuid
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid,
      guest_player_id uuid,
      status text
    );
    CREATE TABLE guest_players (
      id uuid PRIMARY KEY,
      trainer_id uuid,
      academy_profile_id uuid,
      full_name text,
      email text
    );

    CREATE ROLE anon;
    CREATE ROLE authenticated;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

    ALTER TABLE guest_players ENABLE ROW LEVEL SECURITY;
    -- The ORIGINAL trainer visibility (20260116200114): own rows only.
    CREATE POLICY "Trainers can view their own guest players"
      ON guest_players FOR SELECT TO authenticated
      USING (trainer_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid()));

    INSERT INTO trainer_profiles (id, user_id) VALUES
      ('${TRAINER_TP}', '${TRAINER_USER}'),
      ('${OTHER_TP}', '${OTHER_USER}');
    INSERT INTO availability_slots (id, trainer_id, academy_profile_id) VALUES
      ('${SLOT_MINE}', '${TRAINER_TP}', '${ACADEMY}'),
      ('${SLOT_OTHER}', '${OTHER_TP}', '${ACADEMY}');
    INSERT INTO guest_players (id, trainer_id, academy_profile_id, full_name, email) VALUES
      ('${GUEST_PUBLIC}', NULL, '${ACADEMY}', 'Paying Newcomer', 'new@example.com'),
      ('${GUEST_ELSEWHERE}', NULL, '${ACADEMY}', 'Someone Elses Player', 'else@example.com'),
      ('${GUEST_CANCELLED}', NULL, '${ACADEMY}', 'Cancelled Guest', 'gone@example.com'),
      ('${GUEST_OWN}', '${TRAINER_TP}', NULL, 'My Own Guest', 'own@example.com');
    INSERT INTO bookings (slot_id, guest_player_id, status) VALUES
      ('${SLOT_MINE}', '${GUEST_PUBLIC}', 'confirmed'),
      ('${SLOT_OTHER}', '${GUEST_ELSEWHERE}', 'confirmed'),
      ('${SLOT_MINE}', '${GUEST_CANCELLED}', 'cancelled');
  `);
});

describe('trainer guest visibility (real migration SQL)', () => {
  it('reproduces the bug: the paying public guest on MY slot is invisible ("Unknown")', async () => {
    const ids = await visibleGuests(TRAINER_USER);
    expect(ids).toEqual([GUEST_OWN]);
  });

  it('fix migration applies cleanly (incl. its install assertions)', async () => {
    await db.exec(readMigration('20260713110000_trainer_guest_visibility.sql'));
  });

  it('after fix: the guest booked into my slot resolves; other/cancelled stay hidden', async () => {
    const ids = await visibleGuests(TRAINER_USER);
    expect(ids).toContain(GUEST_PUBLIC);
    expect(ids).toContain(GUEST_OWN);
    expect(ids).not.toContain(GUEST_ELSEWHERE);
    expect(ids).not.toContain(GUEST_CANCELLED);
  });

  it('the other trainer sees only THEIR booked guest', async () => {
    const ids = await visibleGuests(OTHER_USER);
    expect(ids).toEqual([GUEST_ELSEWHERE]);
  });

  it('cancelled_swap grants no visibility either', async () => {
    await db.query(`UPDATE bookings SET status = 'cancelled_swap' WHERE guest_player_id = $1`, [
      GUEST_ELSEWHERE,
    ]);
    const ids = await visibleGuests(OTHER_USER);
    expect(ids).toEqual([]);
  });
});
