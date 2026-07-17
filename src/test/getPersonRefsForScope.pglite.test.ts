// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Phase 3.3b: get_person_refs_for_scope resolves a clicked g_/p_ player ref to the person's
// IN-SCOPE ref set (guest_ids + profile_id) — REFS ONLY, no identity/PII. Runs the REAL migration
// and proves: merged resolution from either side, frozen-click self-isolation, frozen-sibling
// exclusion, scope restriction, the IDOR guard (out-of-scope clicked ref rejected), profile side
// gated on caller-visible booking/invoice, unlinked-ref congruence, and the auth gate.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACADEMY = 'aa000000-0000-0000-0000-000000000001';
const MGR_USER = 'aa000000-0000-0000-0000-0000000000a0';
const OTHER_USER = 'bb000000-0000-0000-0000-0000000000b0';
const TR1 = 'aa000000-0000-0000-0000-000000000071';
const TR1_USER = 'aa000000-0000-0000-0000-0000000000a7';
const SLOT_A = 'aa000000-0000-0000-0000-0000000000c1'; // academy-scope slot (TR1)

// merged person: profile P1 (in-scope booking) + two guests GA (academy) & GB (trainer TR1) → PERSON1
const P1 = '10000000-0000-0000-0000-000000000002';
const PERSON1 = P1;
const GA = '10000000-0000-0000-0000-000000000001';
const GB = '10000000-0000-0000-0000-000000000003';
const GC = '10000000-0000-0000-0000-000000000004'; // frozen sibling
const GP = '20000000-0000-0000-0000-000000000001'; // plain unmerged guest

// out-of-scope: another academy B's guest + a profile with NO in-scope booking
const GB_OTHER = '30000000-0000-0000-0000-000000000001';
const P_NOBOOK = '30000000-0000-0000-0000-000000000002'; // linked to PERSON1 world but no in-scope booking
// registered player with an in-scope booking but NO login-side merge (plain profile click)
const P2 = '40000000-0000-0000-0000-000000000002';

type RefsRow = { guest_ids: string[] | null; profile_id: string | null };

async function refs(
  uid: string, scope: 'academy' | 'trainer', scopeId: string,
  click: { guest?: string; profile?: string },
): Promise<RefsRow[]> {
  await db.exec(`SET test.uid = '${uid}';`);
  try {
    const { rows } = await db.query<RefsRow>(
      `SELECT * FROM public.get_person_refs_for_scope($1, $2, $3, $4)`,
      [scope, scopeId, click.guest ?? null, click.profile ?? null],
    );
    return rows;
  } finally {
    await db.exec(`SET test.uid = '';`);
  }
}
const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid, person_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid, status text);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, trainer_id uuid, player_id uuid, guest_player_id uuid);

    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.academy_managers
                       WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id) $fn$;
    CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_guest_player_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT _guest_player_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.person_merge_review r
          WHERE r.guest_player_id = _guest_player_id AND r.status = 'pending'
            AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')) $fn$;

    INSERT INTO public.academy_managers VALUES ('${ACADEMY}', '${MGR_USER}');
    INSERT INTO public.trainer_profiles VALUES ('${TR1}', '${TR1_USER}');
    INSERT INTO public.academy_trainers VALUES ('${ACADEMY}', '${TR1}', 'active');
    INSERT INTO public.availability_slots VALUES ('${SLOT_A}', '${TR1}');

    -- merged: profile P1 (WITH an in-scope booking) + academy guest GA + trainer guest GB
    INSERT INTO public.profiles VALUES ('${P1}', 'aa000000-0000-0000-0000-0000000000f1');
    INSERT INTO public.persons VALUES ('${PERSON1}');
    INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${GA}', '${ACADEMY}');
    INSERT INTO public.guest_players (id, trainer_id) VALUES ('${GB}', '${TR1}');
    INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${GC}', '${ACADEMY}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PERSON1}', '${P1}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES
      ('${PERSON1}', '${GA}'), ('${PERSON1}', '${GB}'), ('${PERSON1}', '${GC}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id)
      VALUES ('merged_guest_email_moved', 'pending', '${GC}', '${PERSON1}');
    -- P1's in-scope pure-profile booking + GA guest booking (so both refs are caller-visible)
    INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${SLOT_A}', '${P1}', 'confirmed');
    INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES ('${SLOT_A}', '${GA}', 'confirmed');

    -- plain unmerged guest (in academy scope)
    INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${GP}', '${ACADEMY}');

    -- OUT-OF-SCOPE fixtures: another academy's guest, and a profile with NO in-scope booking
    INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${GB_OTHER}', 'cc000000-0000-0000-0000-000000000009');
    INSERT INTO public.profiles VALUES ('${P_NOBOOK}', 'aa000000-0000-0000-0000-0000000000f9');

    -- a plain registered player with an in-scope booking (unlinked → its own person)
    INSERT INTO public.profiles VALUES ('${P2}', 'aa000000-0000-0000-0000-0000000000f2');
    INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${SLOT_A}', '${P2}', 'confirmed');
  `);
  await db.exec(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260829100000_phase33b_person_detail_refs.sql'), 'utf8')
      .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n'),
  );
});

describe('get_person_refs_for_scope (Phase 3.3b) — refs only, scope-gated', () => {
  it('merged person via the GUEST side: both in-scope guests (frozen sibling excluded) + profile', async () => {
    const [r] = await refs(MGR_USER, 'academy', ACADEMY, { guest: GA });
    expect([...(r.guest_ids ?? [])].sort()).toEqual([GA, GB].sort()); // GC frozen → excluded
    expect(r.profile_id).toBe(P1); // P1 has an in-scope booking → caller-visible (proves person resolution)
  });

  it('the SAME person via the PROFILE side', async () => {
    const [r] = await refs(MGR_USER, 'academy', ACADEMY, { profile: P1 });
    expect(r.profile_id).toBe(P1);
    expect([...(r.guest_ids ?? [])].sort()).toEqual([GA, GB].sort()); // resolves to the same person's guests
  });

  it('a FROZEN clicked guest is its OWN person: just itself, no profile', async () => {
    const [r] = await refs(MGR_USER, 'academy', ACADEMY, { guest: GC });
    expect(r.profile_id).toBeNull();
    expect(r.guest_ids).toEqual([GC]); // frozen → its own person, no expansion
  });

  it('a plain unmerged guest resolves to just itself (congruent)', async () => {
    const [r] = await refs(MGR_USER, 'academy', ACADEMY, { guest: GP });
    expect(r.profile_id).toBeNull();
    expect(r.guest_ids).toEqual([GP]);
  });

  it('a plain unlinked registered player (profile click) returns itself — congruent, not empty', async () => {
    const [r] = await refs(MGR_USER, 'academy', ACADEMY, { profile: P2 });
    expect(r.profile_id).toBe(P2); // the clicked profile is always in the ref set
    expect(r.guest_ids).toEqual([]);
  });

  it('TRAINER scope sees only its own guest ref (GB); the profile is included only if caller-visible', async () => {
    // P1 has an in-scope booking under SLOT_A (TR1's slot), so the trainer CAN see the profile ref.
    const [r] = await refs(TR1_USER, 'trainer', TR1, { guest: GB });
    expect(r.guest_ids).toEqual([GB]); // GA is academy-only, out of this trainer's scope
    expect(r.profile_id).toBe(P1);
  });

  it('IDOR guard: a clicked guest in ANOTHER academy is rejected', async () => {
    expect(await failed(refs(MGR_USER, 'academy', ACADEMY, { guest: GB_OTHER }))).toBe(true);
  });

  it('IDOR guard: a clicked profile with NO in-scope booking is rejected', async () => {
    expect(await failed(refs(MGR_USER, 'academy', ACADEMY, { profile: P_NOBOOK }))).toBe(true);
  });

  it('rejects a manager of a different academy (auth gate)', async () => {
    expect(await failed(refs(OTHER_USER, 'academy', ACADEMY, { guest: GA }))).toBe(true);
  });

  it('rejects both-null / both-set ref args', async () => {
    expect(await failed(refs(MGR_USER, 'academy', ACADEMY, {}))).toBe(true);
    expect(await failed(refs(MGR_USER, 'academy', ACADEMY, { guest: GA, profile: P1 }))).toBe(true);
  });
});
