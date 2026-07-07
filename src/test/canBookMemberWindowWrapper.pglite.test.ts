// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Lockdown follow-up — can_book_member_window(_user_id, _cycle_id) took an arbitrary _user_id
// and was anon-callable (a membership-probe leak). 20260717100000 locks it to service_role and
// adds can_current_user_book_member_window(_cycle_id), an auth.uid()-based wrapper the client
// uses. This suite proves the wrapper answers for the CURRENT user only, and that the raw
// function is no longer executable by anon/authenticated (the Supabase default privilege that
// caused the leak is replicated so the assertion is meaningful).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CYCLE = 'c0000000-0000-0000-0000-000000000001';
const SLOT = '50000000-0000-0000-0000-000000000001';
const MEMBER = { p: 'a0000000-0000-0000-0000-000000000001', u: 'b0000000-0000-0000-0000-000000000001' }; // registered cohort
const RANDOM = { p: 'a0000000-0000-0000-0000-000000000002', u: 'b0000000-0000-0000-0000-000000000002' };

const migration = (file: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8');

const currentUserCanBook = async (user: string | null) => {
  await db.exec(`SET test.uid = '${user ?? ''}';`);
  try {
    return (
      await db.query<{ ok: boolean }>(`SELECT public.can_current_user_book_member_window($1::uuid) AS ok`, [CYCLE])
    ).rows[0].ok;
  } finally {
    await db.exec(`SET test.uid = '';`);
  }
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    -- Replicate Supabase's default privilege (auto-grants EXECUTE on new functions to
    -- anon/authenticated by name) so the lockdown assertion is meaningful.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, source_cycle_id uuid, cyclus_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text);
    CREATE TABLE public.slot_priority_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid, status text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, linked_profile_id uuid, email text);

    CREATE OR REPLACE FUNCTION public.is_cycle_member(_user_id uuid, _cycle_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM bookings b JOIN availability_slots s ON s.id = b.slot_id JOIN profiles p ON p.id = b.player_id
        WHERE p.user_id = _user_id AND s.cyclus_id = _cycle_id AND COALESCE(b.status,'confirmed') NOT IN ('cancelled','cancelled_swap')
      )
    $fn$;

    INSERT INTO public.profiles (id, user_id) VALUES ('${MEMBER.p}','${MEMBER.u}'), ('${RANDOM.p}','${RANDOM.u}');
    INSERT INTO public.cycles (id) VALUES ('${CYCLE}');
    INSERT INTO public.availability_slots (id, source_cycle_id, cyclus_id) VALUES ('${SLOT}', '${CYCLE}', '${CYCLE}');
    INSERT INTO public.slot_priority_claims (id, slot_id, player_id, status) VALUES (gen_random_uuid(), '${SLOT}', '${MEMBER.p}', 'declined');
  `);
  await db.exec(migration('20260716100000_member_window_linked_guest.sql'));
  await db.exec(migration('20260717100000_lock_can_book_member_window.sql'));
});

describe('can_current_user_book_member_window — auth.uid() wrapper', () => {
  it('returns true for the current user when they are a cohort member', async () => {
    expect(await currentUserCanBook(MEMBER.u)).toBe(true);
  });

  it('returns false for a random current user', async () => {
    expect(await currentUserCanBook(RANDOM.u)).toBe(false);
  });

  it('returns false for anon (no auth.uid)', async () => {
    expect(await currentUserCanBook(null)).toBe(false);
  });

  it('locks the arbitrary-_user_id function to service_role; wrapper stays client-callable', async () => {
    const { rows } = await db.query<{
      raw_anon: boolean; raw_auth: boolean; raw_svc: boolean;
      wrap_anon: boolean; wrap_auth: boolean; wrap_svc: boolean;
    }>(`
      SELECT
        has_function_privilege('anon',          'public.can_book_member_window(uuid,uuid)', 'EXECUTE') AS raw_anon,
        has_function_privilege('authenticated', 'public.can_book_member_window(uuid,uuid)', 'EXECUTE') AS raw_auth,
        has_function_privilege('service_role',  'public.can_book_member_window(uuid,uuid)', 'EXECUTE') AS raw_svc,
        has_function_privilege('anon',          'public.can_current_user_book_member_window(uuid)', 'EXECUTE') AS wrap_anon,
        has_function_privilege('authenticated', 'public.can_current_user_book_member_window(uuid)', 'EXECUTE') AS wrap_auth,
        has_function_privilege('service_role',  'public.can_current_user_book_member_window(uuid)', 'EXECUTE') AS wrap_svc
    `);
    const r = rows[0];
    expect(r.raw_anon).toBe(false);
    expect(r.raw_auth).toBe(false);
    expect(r.raw_svc).toBe(true);
    expect(r.wrap_anon).toBe(true);
    expect(r.wrap_auth).toBe(true);
    expect(r.wrap_svc).toBe(true);
  });
});
