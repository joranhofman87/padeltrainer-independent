// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// RB01 hard boundary — book_slot_for_payment (the authenticated single-slot pay-first RPC,
// called by create-mollie-payment via the SERVICE-ROLE client, so auth.uid() is NULL and the
// enforce_booking_slot_tier trigger skips). 20260715100000 adds a tier gate INSIDE the RPC so
// the service-role path can no longer create a booking on a priority/member-hidden slot. This
// suite runs the REAL migrations and proves: refusal per tier, eligible bookings succeed,
// capacity is checked first, an unlinked profile is rejected (player_not_linked), and the new
// helper functions are NOT executable by anon/authenticated (restricted grants).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CYCLE = 'c0000000-0000-0000-0000-000000000001';
const SLOT = '50000000-0000-0000-0000-000000000001'; // max 2, allow_single_booking=true ⇒ capacity 2

const CLAIMER = { p: 'a0000000-0000-0000-0000-000000000001', u: 'b0000000-0000-0000-0000-000000000001' };
const REBOOKER = { p: 'a0000000-0000-0000-0000-000000000002', u: 'b0000000-0000-0000-0000-000000000002' };
const DECLINED = { p: 'a0000000-0000-0000-0000-000000000003', u: 'b0000000-0000-0000-0000-000000000003' };
const RANDOM = { p: 'a0000000-0000-0000-0000-000000000004', u: 'b0000000-0000-0000-0000-000000000004' };
const NOLINK = { p: 'a0000000-0000-0000-0000-000000000005' }; // profile with user_id = NULL

const migration = (file: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8');

const book = async (player: string, amount = 10) =>
  (
    await db.query<{ book_slot_for_payment: string }>(
      `SELECT public.book_slot_for_payment($1::uuid, $2::uuid, $3::numeric)`,
      [SLOT, player, amount],
    )
  ).rows[0].book_slot_for_payment;

async function expectRpcError(p: Promise<unknown>, re: RegExp) {
  let msg = '';
  await p.then(
    () => { throw new Error(`expected ${re}, but the RPC succeeded`); },
    (e: { message?: string }) => { msg = String(e.message ?? e); },
  );
  expect(msg).toMatch(re);
}

async function setSlot(cfg: { priorityEnds?: string; memberStarts?: string; memberEnds?: string; release?: string | null }) {
  await db.query(
    `UPDATE public.availability_slots
       SET priority_window_ends_at = CASE WHEN $2 = '' THEN NULL ELSE now() + $2::interval END,
           member_window_starts_at = CASE WHEN $3 = '' THEN NULL ELSE now() + $3::interval END,
           member_window_ends_at   = CASE WHEN $4 = '' THEN NULL ELSE now() + $4::interval END,
           public_release_status   = $5
     WHERE id = $1`,
    [SLOT, cfg.priorityEnds ?? '', cfg.memberStarts ?? '', cfg.memberEnds ?? '', cfg.release ?? null],
  );
}

async function addClaim(playerId: string, status: string) {
  await db.query(
    `INSERT INTO public.slot_priority_claims (id, slot_id, player_id, status) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [SLOT, playerId, status],
  );
}

// Fill a seat directly (bypasses the RPC + the trigger — auth.uid() is NULL here).
async function fillSeat(playerId: string) {
  await db.query(
    `INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES (gen_random_uuid(), $1, $2, 'confirmed')`,
    [SLOT, playerId],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, max_participants integer, allow_single_booking boolean,
      cyclus_id uuid, source_cycle_id uuid,
      priority_window_ends_at timestamptz,
      member_window_starts_at timestamptz, member_window_ends_at timestamptz,
      public_release_status text);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
      payment_status text, status text, payment_amount numeric, notes text,
      hold_expires_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text);

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

    INSERT INTO public.profiles (id, user_id) VALUES
      ('${CLAIMER.p}','${CLAIMER.u}'), ('${REBOOKER.p}','${REBOOKER.u}'),
      ('${DECLINED.p}','${DECLINED.u}'), ('${RANDOM.p}','${RANDOM.u}'),
      ('${NOLINK.p}', NULL);
    INSERT INTO public.cycles (id, settings) VALUES ('${CYCLE}', '{}'::jsonb);
    INSERT INTO public.availability_slots (id, max_participants, allow_single_booking, source_cycle_id, cyclus_id) VALUES
      ('${SLOT}', 2, true, '${CYCLE}', '${CYCLE}');
  `);
  await db.exec(migration('20260714100000_member_window_cohort_and_priority_list.sql'));
  await db.exec(migration('20260715100000_slot_tier_single_source_and_payment_gate.sql'));
});

beforeEach(async () => {
  await db.exec(`SET test.uid = '';`);
  await db.exec(`DELETE FROM public.bookings; DELETE FROM public.slot_priority_claims;`);
  await setSlot({}); // reset to public (no windows)
});

describe('book_slot_for_payment — RB01 tier gate (service-role hard boundary)', () => {
  it('refuses a priority slot for a caller with no claim (priority_restricted)', async () => {
    await setSlot({ priorityEnds: '2 days' });
    await addClaim(CLAIMER.p, 'pending'); // slot in priority tier
    await expectRpcError(book(RANDOM.p), /priority_restricted/);
  });

  it('refuses a member slot for a non-cohort caller (members_only)', async () => {
    await setSlot({ priorityEnds: '-1 day', memberStarts: '-1 hour', memberEnds: '7 days', release: 'auto_release_scheduled' });
    await expectRpcError(book(RANDOM.p), /members_only/);
  });

  it('allows an eligible claimant to book a priority slot', async () => {
    await setSlot({ priorityEnds: '2 days' });
    await addClaim(CLAIMER.p, 'pending');
    const id = await book(CLAIMER.p);
    expect(id).toBeTruthy();
  });

  it('allows an eligible cohort member to book once the member window has started', async () => {
    await setSlot({ priorityEnds: '-1 day', memberStarts: '-1 hour', memberEnds: '7 days', release: 'auto_release_scheduled' });
    await addClaim(DECLINED.p, 'declined');
    const id = await book(DECLINED.p);
    expect(id).toBeTruthy();
  });

  it('RB02 via the RPC: claimed+declined, zero-pending, priority window open → member refused early', async () => {
    await setSlot({ priorityEnds: '2 days', memberStarts: '2 days', memberEnds: '9 days' });
    await addClaim(REBOOKER.p, 'claimed');
    await addClaim(DECLINED.p, 'declined');
    await expectRpcError(book(DECLINED.p), /priority_restricted/);
  });

  it('capacity is enforced BEFORE the tier gate — slot_full even for an eligible member', async () => {
    await setSlot({ priorityEnds: '-1 day', memberStarts: '-1 hour', memberEnds: '7 days', release: 'auto_release_scheduled' });
    await addClaim(DECLINED.p, 'declined');
    await fillSeat(CLAIMER.p);
    await fillSeat(REBOOKER.p);
    await expectRpcError(book(DECLINED.p), /slot_full/);
  });

  it('rejects an unlinked profile (user_id NULL) with player_not_linked and inserts no booking', async () => {
    // Public slot — the unlinked-profile guard must fire regardless of tier.
    await expectRpcError(book(NOLINK.p), /player_not_linked/);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.bookings WHERE player_id = $1`,
      [NOLINK.p],
    );
    expect(rows[0].n).toBe(0);
  });

  it('allows any authenticated player to book a public slot (no regression)', async () => {
    await setSlot({ release: 'released' });
    const id = await book(RANDOM.p);
    expect(id).toBeTruthy();
    const { rows } = await db.query<{ status: string; payment_status: string }>(
      `SELECT status, payment_status FROM public.bookings WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].payment_status).toBe('pending');
  });
});

describe('grants — helper functions are not client-callable', () => {
  it('can_book_slot / resolve_slot_booking_tier: service_role only, NOT anon/authenticated', async () => {
    const { rows } = await db.query<{
      cbs_anon: boolean; cbs_auth: boolean; cbs_svc: boolean;
      rst_anon: boolean; rst_auth: boolean; rst_svc: boolean;
    }>(`
      SELECT
        has_function_privilege('anon',          'public.can_book_slot(uuid,uuid)', 'EXECUTE') AS cbs_anon,
        has_function_privilege('authenticated', 'public.can_book_slot(uuid,uuid)', 'EXECUTE') AS cbs_auth,
        has_function_privilege('service_role',  'public.can_book_slot(uuid,uuid)', 'EXECUTE') AS cbs_svc,
        has_function_privilege('anon',          'public.resolve_slot_booking_tier(uuid)', 'EXECUTE') AS rst_anon,
        has_function_privilege('authenticated', 'public.resolve_slot_booking_tier(uuid)', 'EXECUTE') AS rst_auth,
        has_function_privilege('service_role',  'public.resolve_slot_booking_tier(uuid)', 'EXECUTE') AS rst_svc
    `);
    const r = rows[0];
    expect(r.cbs_anon).toBe(false);
    expect(r.cbs_auth).toBe(false);
    expect(r.cbs_svc).toBe(true);
    expect(r.rst_anon).toBe(false);
    expect(r.rst_auth).toBe(false);
    expect(r.rst_svc).toBe(true);
  });
});
