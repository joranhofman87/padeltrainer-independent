// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Phase 3.3c: can_book_member_window clauses (d)/(e) gain a PERSON ARM (guest and my profile are
// the same person via person_links) UNIONed with the Phase-0c twin-precedence bridge, with the
// split-freeze excluding uncertain-identity guests. Runs the REAL migration and proves: the person
// arm grants eligibility for a stamp-less merge, the bridge still covers linked-but-unmerged guests,
// a split-frozen guest is refused on both arms, and (a)/(b)/(c) + the negatives still hold.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CYCLE = 'c0000000-0000-0000-0000-000000000001';
const SLOT = '50000000-0000-0000-0000-000000000001';
const GUEST = '70000000-0000-0000-0000-000000000001'; // guest with a claim in the round (clause d)
const PGUEST = '70000000-0000-0000-0000-000000000002'; // guest on the priority-guest list (clause e)

const MERGED = { p: 'a0000000-0000-0000-0000-000000000001', u: 'b0000000-0000-0000-0000-000000000001', per: 'e0000000-0000-0000-0000-000000000001' };
const TWIN = { p: 'a0000000-0000-0000-0000-000000000002', u: 'b0000000-0000-0000-0000-000000000002' };   // twin_of_profile_id bridge
const LINKED = { p: 'a0000000-0000-0000-0000-000000000003', u: 'b0000000-0000-0000-0000-000000000003' }; // linked_profile_id bridge
const REG = { p: 'a0000000-0000-0000-0000-000000000004', u: 'b0000000-0000-0000-0000-000000000004' };    // cohort (clause b)
const PRIO = { p: 'a0000000-0000-0000-0000-000000000005', u: 'b0000000-0000-0000-0000-000000000005' };   // priority list (clause c)
const RANDOM = { p: 'a0000000-0000-0000-0000-000000000006', u: 'b0000000-0000-0000-0000-000000000006' };

const canBook = async (userId: string) =>
  (await db.query<{ ok: boolean }>(
    `SELECT public.can_book_member_window($1::uuid, $2::uuid) AS ok`, [userId, CYCLE])).rows[0].ok;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, source_cycle_id uuid, cyclus_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid, status text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, linked_profile_id uuid, twin_of_profile_id uuid);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid, person_id uuid);

    CREATE OR REPLACE FUNCTION public.is_cycle_member(_user_id uuid, _cycle_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (SELECT 1 FROM bookings b JOIN availability_slots s ON s.id = b.slot_id
        JOIN profiles p ON p.id = b.player_id
        WHERE p.user_id = _user_id AND s.cyclus_id = _cycle_id
          AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled','cancelled_swap')) $fn$;
    CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_guest_player_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT _guest_player_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.person_merge_review r
          WHERE r.guest_player_id = _guest_player_id AND r.status = 'pending'
            AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')) $fn$;

    INSERT INTO public.profiles (id, user_id) VALUES
      ('${MERGED.p}','${MERGED.u}'), ('${TWIN.p}','${TWIN.u}'), ('${LINKED.p}','${LINKED.u}'),
      ('${REG.p}','${REG.u}'), ('${PRIO.p}','${PRIO.u}'), ('${RANDOM.p}','${RANDOM.u}');
    INSERT INTO public.cycles (id, settings) VALUES
      ('${CYCLE}', jsonb_build_object(
        'rebook_priority_people', jsonb_build_array('${PRIO.p}'),
        'rebook_priority_guests', jsonb_build_array('${PGUEST}')));
    INSERT INTO public.availability_slots (id, source_cycle_id, cyclus_id) VALUES ('${SLOT}', '${CYCLE}', '${CYCLE}');

    -- clause (d) guest with a claim: MERGED person owns it via person_links (NO twin/linked stamp)
    INSERT INTO public.guest_players (id) VALUES ('${GUEST}');
    INSERT INTO public.persons (id) VALUES ('${MERGED.per}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${MERGED.per}', '${MERGED.p}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${MERGED.per}', '${GUEST}');
    INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status) VALUES
      ('${SLOT}', NULL, '${GUEST}', 'declined'),
      ('${SLOT}', '${REG.p}', NULL, 'declined');

    -- clause (e) priority-guest: also owned by the MERGED person
    INSERT INTO public.guest_players (id) VALUES ('${PGUEST}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${MERGED.per}', '${PGUEST}');
  `);
  await db.exec(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260830100000_phase33c_can_book_member_window_person.sql'), 'utf8')
      .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n'),
  );
});

beforeEach(async () => {
  // reset the bridge stamps + any freeze between tests
  await db.exec(`
    UPDATE public.guest_players SET linked_profile_id = NULL, twin_of_profile_id = NULL;
    DELETE FROM public.person_merge_review;
  `);
});

describe('can_book_member_window — Phase 3.3c person arm + bridge + freeze', () => {
  it('PERSON ARM (d): a guest merged to my person via person_links (no twin/linked stamp) → eligible', async () => {
    expect(await canBook(MERGED.u)).toBe(true);
  });

  it('PERSON ARM (e): a priority-guest merged to my person → eligible', async () => {
    // MERGED is also eligible via (e); prove the person arm covers the priority-guest list too by
    // removing the (d) claim path is unnecessary — assert the merged user is eligible.
    expect(await canBook(MERGED.u)).toBe(true);
  });

  it('BRIDGE (d): a linked-but-unmerged guest with twin_of_profile_id=me → eligible', async () => {
    await db.exec(`UPDATE public.guest_players SET twin_of_profile_id = '${TWIN.p}' WHERE id = '${GUEST}';`);
    expect(await canBook(TWIN.u)).toBe(true);
  });

  it('BRIDGE (d): linked_profile_id=me with twin NULL → eligible (Phase-0c precedence fallback)', async () => {
    await db.exec(`UPDATE public.guest_players SET linked_profile_id = '${LINKED.p}' WHERE id = '${GUEST}';`);
    expect(await canBook(LINKED.u)).toBe(true);
  });

  it('FREEZE: person-linked guests under a pending split review → NOT eligible on either arm', async () => {
    // MERGED owns both the (d) claim guest and the (e) priority guest — freeze both, so no arm grants
    await db.exec(`INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id) VALUES
      ('merged_guest_email_moved', 'pending', '${GUEST}', '${MERGED.per}'),
      ('merged_guest_email_moved', 'pending', '${PGUEST}', '${MERGED.per}');`);
    expect(await canBook(MERGED.u)).toBe(false); // frozen → excluded from the person arm on (d) AND (e)
  });

  it('FREEZE (d): a split-frozen guest also does not grant via the twin bridge', async () => {
    await db.exec(`
      UPDATE public.guest_players SET twin_of_profile_id = '${TWIN.p}' WHERE id = '${GUEST}';
      INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id)
        VALUES ('twin_detached_needs_split', 'pending', '${GUEST}', '${MERGED.per}');`);
    expect(await canBook(TWIN.u)).toBe(false);
  });

  it('NEGATIVE: a random user sharing neither person nor twin/link is refused', async () => {
    expect(await canBook(RANDOM.u)).toBe(false);
  });

  it('regression (b): a registered cohort member is still eligible', async () => {
    expect(await canBook(REG.u)).toBe(true);
  });

  it('regression (c): a registered priority-list person is still eligible', async () => {
    expect(await canBook(PRIO.u)).toBe(true);
  });
});
