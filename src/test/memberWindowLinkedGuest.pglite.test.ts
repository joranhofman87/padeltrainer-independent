// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// R06 — a guest whose seat frees up can book the member window once they complete an
// account. link_guest_data_to_profile links the guest to the new profile by email at
// signup (sets guest_players.linked_profile_id); this suite proves that can_book_member_window
// clause (d) then recognises the linked ex-guest, while an unlinked guest / random user is
// refused, and the existing cohort (b) + priority-list (c) grants still hold. Runs the REAL
// migration (20260716100000) against Postgres (PGlite) and calls the function directly.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CYCLE = 'c0000000-0000-0000-0000-000000000001';
const SLOT = '50000000-0000-0000-0000-000000000001';
const GUEST = '70000000-0000-0000-0000-000000000001'; // the guest_players row with a claim in the round

const EXGUEST = { p: 'a0000000-0000-0000-0000-000000000001', u: 'b0000000-0000-0000-0000-000000000001' }; // ex-guest's new profile
const REG = { p: 'a0000000-0000-0000-0000-000000000002', u: 'b0000000-0000-0000-0000-000000000002' };     // registered cohort (clause b)
const PRIO = { p: 'a0000000-0000-0000-0000-000000000003', u: 'b0000000-0000-0000-0000-000000000003' };    // priority list (clause c)
const RANDOM = { p: 'a0000000-0000-0000-0000-000000000004', u: 'b0000000-0000-0000-0000-000000000004' };

const migration = (file: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8');

const canBook = async (userId: string) =>
  (
    await db.query<{ ok: boolean }>(`SELECT public.can_book_member_window($1::uuid, $2::uuid) AS ok`, [userId, CYCLE])
  ).rows[0].ok;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, email text);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, source_cycle_id uuid, cyclus_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid, status text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, linked_profile_id uuid, email text);

    CREATE OR REPLACE FUNCTION public.is_cycle_member(_user_id uuid, _cycle_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM bookings b
        JOIN availability_slots s ON s.id = b.slot_id
        JOIN profiles p ON p.id = b.player_id
        WHERE p.user_id = _user_id AND s.cyclus_id = _cycle_id
          AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled','cancelled_swap')
      )
    $fn$;

    INSERT INTO public.profiles (id, user_id, email) VALUES
      ('${EXGUEST.p}','${EXGUEST.u}','exguest@example.com'),
      ('${REG.p}','${REG.u}','reg@example.com'),
      ('${PRIO.p}','${PRIO.u}','prio@example.com'),
      ('${RANDOM.p}','${RANDOM.u}','random@example.com');
    INSERT INTO public.cycles (id, settings) VALUES
      ('${CYCLE}', jsonb_build_object('rebook_priority_people', jsonb_build_array('${PRIO.p}')));
    INSERT INTO public.availability_slots (id, source_cycle_id, cyclus_id) VALUES ('${SLOT}', '${CYCLE}', '${CYCLE}');
    -- The ex-guest is a guest with a (declined) cohort claim; the registered cohort member too.
    INSERT INTO public.guest_players (id, linked_profile_id, email) VALUES ('${GUEST}', NULL, 'exguest@example.com');
    INSERT INTO public.slot_priority_claims (id, slot_id, player_id, guest_player_id, status) VALUES
      (gen_random_uuid(), '${SLOT}', NULL, '${GUEST}', 'declined'),
      (gen_random_uuid(), '${SLOT}', '${REG.p}', NULL, 'declined');
  `);
  await db.exec(migration('20260716100000_member_window_linked_guest.sql'));
});

beforeEach(async () => {
  // Reset the guest to UNLINKED before each test (the migration is idempotent).
  await db.query(`UPDATE public.guest_players SET linked_profile_id = NULL WHERE id = $1`, [GUEST]);
});

describe('can_book_member_window — clause (d): linked ex-guest', () => {
  it('an UNLINKED guest\'s new profile is NOT yet eligible (before signup links them)', async () => {
    expect(await canBook(EXGUEST.u)).toBe(false);
  });

  it('once the guest is linked to the profile (email match at signup), the ex-guest CAN book', async () => {
    await db.query(`UPDATE public.guest_players SET linked_profile_id = $1 WHERE id = $2`, [EXGUEST.p, GUEST]);
    expect(await canBook(EXGUEST.u)).toBe(true);
  });

  it('a registered cohort member is still eligible (clause b regression)', async () => {
    expect(await canBook(REG.u)).toBe(true);
  });

  it('a registered priority-list person is still eligible (clause c regression)', async () => {
    expect(await canBook(PRIO.u)).toBe(true);
  });

  it('a random user with no claim / link / priority is refused', async () => {
    expect(await canBook(RANDOM.u)).toBe(false);
  });

  it('a linked guest only grants access for THEIR linked profile, not an unrelated user', async () => {
    await db.query(`UPDATE public.guest_players SET linked_profile_id = $1 WHERE id = $2`, [EXGUEST.p, GUEST]);
    expect(await canBook(RANDOM.u)).toBe(false); // link is to EXGUEST, not RANDOM
    expect(await canBook(EXGUEST.u)).toBe(true);
  });
});
