// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Slice 1 of the priority-list feature widens the member-window ("second bucket")
// booking gate from "rebookers only" to "original cohort + registered priority list".
// This runs the ACTUAL migration (20260714100000) against real Postgres (PGlite) via
// the enforce_booking_slot_tier trigger and proves who may / may not book a freed
// member-window seat, and that capacity is still enforced.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const CYCLE = 'c0000000-0000-0000-0000-000000000001'; // the round (source_cycle_id)
const SLOT = '50000000-0000-0000-0000-000000000001'; // freed member-window seat (capacity 2)
const SLOT2 = '50000000-0000-0000-0000-000000000002'; // another slot in CYCLE (for the rebooker)

// Each person: profile id + distinct auth user id.
const REBOOKER = { p: 'a0000000-0000-0000-0000-000000000001', u: 'b0000000-0000-0000-0000-000000000001' };
const DECLINED = { p: 'a0000000-0000-0000-0000-000000000002', u: 'b0000000-0000-0000-0000-000000000002' };
const EXPIRED = { p: 'a0000000-0000-0000-0000-000000000003', u: 'b0000000-0000-0000-0000-000000000003' };
const PRIORITY = { p: 'a0000000-0000-0000-0000-000000000004', u: 'b0000000-0000-0000-0000-000000000004' };
const RANDOM = { p: 'a0000000-0000-0000-0000-000000000005', u: 'b0000000-0000-0000-0000-000000000005' };

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260714100000_member_window_cohort_and_priority_list.sql'),
    'utf8',
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    -- auth.uid() reads a GUC we set per-test (empty ⇒ NULL, i.e. service/anon).
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, max_participants integer, cyclus_id uuid, source_cycle_id uuid,
      priority_window_ends_at timestamptz, member_window_ends_at timestamptz,
      public_release_status text);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
      status text, hold_expires_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text);

    -- Helpers the migration depends on (declared verbatim from their live definitions).
    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_uid uuid)
    RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT id FROM public.profiles WHERE user_id = _uid LIMIT 1
    $fn$;
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

    -- People.
    INSERT INTO public.profiles (id, user_id) VALUES
      ('${REBOOKER.p}','${REBOOKER.u}'), ('${DECLINED.p}','${DECLINED.u}'),
      ('${EXPIRED.p}','${EXPIRED.u}'), ('${PRIORITY.p}','${PRIORITY.u}'),
      ('${RANDOM.p}','${RANDOM.u}');
    -- The round: PRIORITY is on the registered priority list.
    INSERT INTO public.cycles (id, settings) VALUES
      ('${CYCLE}', jsonb_build_object('rebook_priority_people', jsonb_build_array('${PRIORITY.p}')));
    -- A freed member-window seat (priority window closed, member window open), capacity 2.
    INSERT INTO public.availability_slots
      (id, max_participants, cyclus_id, source_cycle_id, priority_window_ends_at, member_window_ends_at, public_release_status)
    VALUES
      ('${SLOT}', 2, '${CYCLE}', '${CYCLE}', now() - interval '1 day', now() + interval '7 days', 'auto_release_scheduled'),
      ('${SLOT2}', 4, '${CYCLE}', '${CYCLE}', now() - interval '1 day', now() + interval '7 days', 'auto_release_scheduled');
  `);
  // Apply the ACTUAL migration under test (can_book_member_window + trigger swap).
  await db.exec(readMigration());
});

// Fresh seats + claims before each case.
beforeEach(async () => {
  await db.exec(`SET test.uid = '';`);
  await db.exec(`DELETE FROM public.bookings; DELETE FROM public.slot_priority_claims;`);
});

// Insert a self-booking as `user` (NULL ⇒ setup insert, bypasses the trigger).
async function bookAs(user: string | null, playerId: string, slotId: string): Promise<{ ok: boolean; error: string | null }> {
  await db.exec(`SET test.uid = '${user ?? ''}';`);
  try {
    await db.query(
      `INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES (gen_random_uuid(), $1, $2, 'confirmed')`,
      [slotId, playerId],
    );
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await db.exec(`SET test.uid = '';`);
  }
}

async function addClaim(playerId: string, status: string) {
  await db.query(
    `INSERT INTO public.slot_priority_claims (id, slot_id, player_id, status) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [SLOT, playerId, status],
  );
}

describe('can_book_member_window — second bucket = rebookers + cohort + priority list', () => {
  it('rebooker (has a booking in the round) can book a freed member-window seat', async () => {
    await bookAs(null, REBOOKER.p, SLOT2); // existing booking in CYCLE → is_cycle_member
    const r = await bookAs(REBOOKER.u, REBOOKER.p, SLOT);
    expect(r.ok).toBe(true);
  });

  it('cohort non-rebooker with a DECLINED claim can book (clause b)', async () => {
    await addClaim(DECLINED.p, 'declined');
    const r = await bookAs(DECLINED.u, DECLINED.p, SLOT);
    expect(r.ok).toBe(true);
  });

  it('cohort non-rebooker with an EXPIRED claim can book (clause b)', async () => {
    await addClaim(EXPIRED.p, 'expired');
    const r = await bookAs(EXPIRED.u, EXPIRED.p, SLOT);
    expect(r.ok).toBe(true);
  });

  it('registered priority-list person with NO claim and NO booking can book (clause c)', async () => {
    const r = await bookAs(PRIORITY.u, PRIORITY.p, SLOT);
    expect(r.ok).toBe(true);
  });

  it('random non-cohort, non-priority user is refused (members_only)', async () => {
    const r = await bookAs(RANDOM.u, RANDOM.p, SLOT);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/members_only/);
  });

  it('capacity is still enforced — a full slot raises slot_full for an eligible user', async () => {
    // Fill both seats (setup inserts bypass the trigger), then an eligible cohort member tries.
    await bookAs(null, REBOOKER.p, SLOT);
    await bookAs(null, EXPIRED.p, SLOT);
    await addClaim(DECLINED.p, 'declined');
    const r = await bookAs(DECLINED.u, DECLINED.p, SLOT);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/slot_full/);
  });

  it('a user NOT in the priority list is refused even though the list is non-empty (registered-only, exact match)', async () => {
    // RANDOM is not in rebook_priority_people (only PRIORITY.p is) and has no claim.
    const r = await bookAs(RANDOM.u, RANDOM.p, SLOT);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/members_only/);
  });
});
