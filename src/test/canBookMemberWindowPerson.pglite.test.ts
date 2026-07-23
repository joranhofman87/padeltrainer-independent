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
const GUEST = '70000000-0000-0000-0000-000000000001'; // guest with a claim in the round (clause d), person_links → MERGED
const PGUEST = '70000000-0000-0000-0000-000000000002'; // guest on the priority-guest list (clause e), person_links → MERGED
const BRIDGE_GUEST = '70000000-0000-0000-0000-000000000004'; // claim in the round, NO person_links → the twin/linked BRIDGE arms apply

const MERGED = { p: 'a0000000-0000-0000-0000-000000000001', u: 'b0000000-0000-0000-0000-000000000001', per: 'e0000000-0000-0000-0000-000000000001' };
const TWIN = { p: 'a0000000-0000-0000-0000-000000000002', u: 'b0000000-0000-0000-0000-000000000002' };   // twin_of_profile_id bridge
const LINKED = { p: 'a0000000-0000-0000-0000-000000000003', u: 'b0000000-0000-0000-0000-000000000003' }; // linked_profile_id bridge
const REG = { p: 'a0000000-0000-0000-0000-000000000004', u: 'b0000000-0000-0000-0000-000000000004' };    // cohort (clause b)
const PRIO = { p: 'a0000000-0000-0000-0000-000000000005', u: 'b0000000-0000-0000-0000-000000000005' };   // priority list (clause c)
const RANDOM = { p: 'a0000000-0000-0000-0000-000000000006', u: 'b0000000-0000-0000-0000-000000000006' };
// EONLY: eligible ONLY via clause (e) — owns EGUEST (on the priority-guest list, NO claim in the round)
const EONLY = { p: 'a0000000-0000-0000-0000-000000000007', u: 'b0000000-0000-0000-0000-000000000007', per: 'e0000000-0000-0000-0000-000000000007' };
const EGUEST = '70000000-0000-0000-0000-000000000003';
// OTHER: a DIFFERENT person entirely — must never gain eligibility from another person's guest
const OTHER = { p: 'a0000000-0000-0000-0000-000000000008', u: 'b0000000-0000-0000-0000-000000000008', per: 'e0000000-0000-0000-0000-000000000008' };
const NO_PROFILE_USER = 'b0000000-0000-0000-0000-0000000000ff'; // an auth uid with no profiles row

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
      ('${REG.p}','${REG.u}'), ('${PRIO.p}','${PRIO.u}'), ('${RANDOM.p}','${RANDOM.u}'),
      ('${EONLY.p}','${EONLY.u}'), ('${OTHER.p}','${OTHER.u}');
    INSERT INTO public.cycles (id, settings) VALUES
      ('${CYCLE}', jsonb_build_object(
        'rebook_priority_people', jsonb_build_array('${PRIO.p}'),
        'rebook_priority_guests', jsonb_build_array('${PGUEST}', '${EGUEST}')));
    INSERT INTO public.availability_slots (id, source_cycle_id, cyclus_id) VALUES ('${SLOT}', '${CYCLE}', '${CYCLE}');

    -- clause (d) guest with a claim: MERGED person owns it via person_links (NO twin/linked stamp)
    INSERT INTO public.guest_players (id) VALUES ('${GUEST}');
    INSERT INTO public.persons (id) VALUES ('${MERGED.per}'), ('${EONLY.per}'), ('${OTHER.per}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES
      ('${MERGED.per}', '${MERGED.p}'), ('${EONLY.per}', '${EONLY.p}'), ('${OTHER.per}', '${OTHER.p}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${MERGED.per}', '${GUEST}');
    INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status) VALUES
      ('${SLOT}', NULL, '${GUEST}', 'declined'),
      ('${SLOT}', '${REG.p}', NULL, 'declined');

    -- clause (e) priority-guest: also owned by the MERGED person
    INSERT INTO public.guest_players (id) VALUES ('${PGUEST}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${MERGED.per}', '${PGUEST}');

    -- EONLY's ONLY route is clause (e): EGUEST is on the priority-guest list with NO claim in the round
    INSERT INTO public.guest_players (id) VALUES ('${EGUEST}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${EONLY.per}', '${EGUEST}');

    -- BRIDGE_GUEST: a claim in the round with NO person_links, so the twin/linked bridge arms apply.
    INSERT INTO public.guest_players (id) VALUES ('${BRIDGE_GUEST}');
    INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status) VALUES
      ('${SLOT}', NULL, '${BRIDGE_GUEST}', 'declined');
  `);
  const loadNoGrants = (file: string) =>
    db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8')
      .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n'));
  await loadNoGrants('20260830100000_phase33c_can_book_member_window_person.sql');
  // PR 10d #2: curated person_links suppresses the twin/linked bridge (person_links precedence).
  await loadNoGrants('20260928100000_can_book_member_window_person_links_precedence.sql');
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

  it('PERSON ARM (e) IN ISOLATION: a priority-guest merged to my person, with NO round claim → eligible', async () => {
    // EONLY's only route is (e): EGUEST is on rebook_priority_guests and owned by EONLY's person,
    // but has no slot_priority_claim in the round — so this proves the (e) person arm specifically.
    expect(await canBook(EONLY.u)).toBe(true);
  });

  it('cross-person FALSE-POSITIVE guard: a different person is NOT eligible via my guest', async () => {
    // GUEST (a round claim) + PGUEST (priority list) are owned by MERGED's person, NOT OTHER's.
    // OTHER has their own person and profile but no claim/priority/link → must be refused.
    expect(await canBook(OTHER.u)).toBe(false);
  });

  it('BRIDGE (d): a linked-but-unmerged guest (NO person_links) with twin_of_profile_id=me → eligible', async () => {
    await db.exec(`UPDATE public.guest_players SET twin_of_profile_id = '${TWIN.p}' WHERE id = '${BRIDGE_GUEST}';`);
    expect(await canBook(TWIN.u)).toBe(true);
  });

  it('BRIDGE (d): linked_profile_id=me with twin NULL (NO person_links) → eligible (Phase-0c fallback)', async () => {
    await db.exec(`UPDATE public.guest_players SET linked_profile_id = '${LINKED.p}' WHERE id = '${BRIDGE_GUEST}';`);
    expect(await canBook(LINKED.u)).toBe(true);
  });

  // PR 10d #2: curated person_links SUPPRESSES the twin/linked bridge (person_links precedence).
  it('CONFLICT (d): person_links → A allowed, a STALE twin → B DENIED (A wins, bridge suppressed)', async () => {
    // GUEST has person_links → MERGED (A). Stamp a stale twin → TWIN (B).
    await db.exec(`UPDATE public.guest_players SET twin_of_profile_id = '${TWIN.p}' WHERE id = '${GUEST}';`);
    expect(await canBook(MERGED.u)).toBe(true);  // A: curated person_links account still books
    expect(await canBook(TWIN.u)).toBe(false);   // B: stale twin is suppressed by the person_links account
  });

  it('CONFLICT (d): person_links → A allowed, a STALE linked_profile_id → B DENIED', async () => {
    await db.exec(`UPDATE public.guest_players SET linked_profile_id = '${LINKED.p}' WHERE id = '${GUEST}';`);
    expect(await canBook(MERGED.u)).toBe(true);
    expect(await canBook(LINKED.u)).toBe(false);
  });

  it('CONFLICT (e): on the priority-guest list, person_links A allowed, stale twin B denied', async () => {
    // PGUEST is on rebook_priority_guests and person_links → MERGED. Stamp a stale twin → TWIN.
    await db.exec(`UPDATE public.guest_players SET twin_of_profile_id = '${TWIN.p}' WHERE id = '${PGUEST}';`);
    expect(await canBook(MERGED.u)).toBe(true);
    expect(await canBook(TWIN.u)).toBe(false);
  });

  it('FREEZE: person-linked guests under a pending split review → NOT eligible on either arm', async () => {
    // MERGED owns both the (d) claim guest and the (e) priority guest — freeze both, so no arm grants
    await db.exec(`INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id) VALUES
      ('merged_guest_email_moved', 'pending', '${GUEST}', '${MERGED.per}'),
      ('merged_guest_email_moved', 'pending', '${PGUEST}', '${MERGED.per}');`);
    expect(await canBook(MERGED.u)).toBe(false); // frozen → excluded from the person arm on (d) AND (e)
  });

  it('FREEZE (d): a split-frozen bridge guest (no person_links) does not grant via the twin bridge', async () => {
    await db.exec(`
      UPDATE public.guest_players SET twin_of_profile_id = '${TWIN.p}' WHERE id = '${BRIDGE_GUEST}';
      INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id)
        VALUES ('twin_detached_needs_split', 'pending', '${BRIDGE_GUEST}', '${MERGED.per}');`);
    expect(await canBook(TWIN.u)).toBe(false);
  });

  it('FREEZE granularity: freezing ONE of the person\'s guests does NOT over-refuse (the other still grants)', async () => {
    // freeze only the (d) claim guest → MERGED still eligible via the non-frozen (e) priority guest
    await db.exec(`INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id)
      VALUES ('merged_guest_email_moved', 'pending', '${GUEST}', '${MERGED.per}');`);
    expect(await canBook(MERGED.u)).toBe(true);
  });

  it('NEGATIVE: a random user sharing neither person nor twin/link is refused', async () => {
    expect(await canBook(RANDOM.u)).toBe(false);
  });

  it('NEGATIVE: a user with no profiles row (me → NULL) is refused, not spuriously granted', async () => {
    expect(await canBook(NO_PROFILE_USER)).toBe(false);
  });

  it('regression (b): a registered cohort member is still eligible', async () => {
    expect(await canBook(REG.u)).toBe(true);
  });

  it('regression (c): a registered priority-list person is still eligible', async () => {
    expect(await canBook(PRIO.u)).toBe(true);
  });
});
