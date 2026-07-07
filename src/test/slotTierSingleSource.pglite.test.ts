// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// RB01/RB02 hardening — the canonical slot-tier source of truth (resolve_slot_booking_tier
// + can_book_slot) is consulted by the enforce_booking_slot_tier trigger. This suite runs
// the ACTUAL migrations (20260714100000 for can_book_member_window, then 20260715100000 for
// the single-source functions + the rebased trigger) against real Postgres (PGlite) and
// proves the SELF-BOOKING tier gate: who may / may not book each tier, the RB02 fix
// (claimed counts as still-priority; member window gated on member_window_starts_at), that
// staff/service/manager overrides still bypass, and that capacity is enforced first.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CYCLE = 'c0000000-0000-0000-0000-000000000001';
const SLOT = '50000000-0000-0000-0000-000000000001'; // capacity 2, reconfigured per test

const CLAIMER = { p: 'a0000000-0000-0000-0000-000000000001', u: 'b0000000-0000-0000-0000-000000000001' };
const REBOOKER = { p: 'a0000000-0000-0000-0000-000000000002', u: 'b0000000-0000-0000-0000-000000000002' }; // 'claimed'
const DECLINED = { p: 'a0000000-0000-0000-0000-000000000003', u: 'b0000000-0000-0000-0000-000000000003' }; // cohort via declined claim
const RANDOM = { p: 'a0000000-0000-0000-0000-000000000004', u: 'b0000000-0000-0000-0000-000000000004' };
const MANAGER = { p: 'a0000000-0000-0000-0000-000000000005', u: 'b0000000-0000-0000-0000-000000000005' };

const migration = (file: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8');

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
      hold_expires_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text);

    -- Helpers the migrations depend on (verbatim from their live definitions).
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
      ('${MANAGER.p}','${MANAGER.u}');
    INSERT INTO public.cycles (id, settings) VALUES ('${CYCLE}', '{}'::jsonb);
    INSERT INTO public.availability_slots (id, max_participants, source_cycle_id, cyclus_id) VALUES
      ('${SLOT}', 2, '${CYCLE}', '${CYCLE}');
  `);
  // Apply the real migrations in deploy order.
  await db.exec(migration('20260714100000_member_window_cohort_and_priority_list.sql'));
  await db.exec(migration('20260715100000_slot_tier_single_source_and_payment_gate.sql'));
});

beforeEach(async () => {
  await db.exec(`SET test.uid = '';`);
  await db.exec(`DELETE FROM public.bookings; DELETE FROM public.slot_priority_claims;`);
  // Reset the slot to "no windows" (public).
  await db.query(
    `UPDATE public.availability_slots
       SET priority_window_ends_at = NULL, member_window_starts_at = NULL,
           member_window_ends_at = NULL, public_release_status = NULL
     WHERE id = $1`,
    [SLOT],
  );
});

// Configure the slot's tier windows using intervals relative to now.
async function setSlot(cfg: {
  priorityEnds?: string; memberStarts?: string; memberEnds?: string; release?: string | null;
}) {
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

// Self-booking as `user` (NULL ⇒ setup insert / service role, bypasses the tier gate).
async function bookAs(user: string | null, playerId: string): Promise<{ ok: boolean; error: string | null }> {
  await db.exec(`SET test.uid = '${user ?? ''}';`);
  try {
    await db.query(
      `INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES (gen_random_uuid(), $1, $2, 'confirmed')`,
      [SLOT, playerId],
    );
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await db.exec(`SET test.uid = '';`);
  }
}

describe('enforce_booking_slot_tier via can_book_slot (single source of truth)', () => {
  it('priority: a live claim-holder can book their reserved seat', async () => {
    await setSlot({ priorityEnds: '2 days' });
    await addClaim(CLAIMER.p, 'pending');
    const r = await bookAs(CLAIMER.u, CLAIMER.p);
    expect(r.ok).toBe(true);
  });

  it('priority: a non-claimant is refused (priority_restricted)', async () => {
    await setSlot({ priorityEnds: '2 days' });
    await addClaim(CLAIMER.p, 'pending'); // keeps the slot in priority tier
    const r = await bookAs(RANDOM.u, RANDOM.p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/priority_restricted/);
  });

  it('RB02: claimed+declined, zero-pending, priority window open → slot stays PRIORITY (claimed counts)', async () => {
    // Priority window still open; member window scheduled to START in the future.
    await setSlot({ priorityEnds: '2 days', memberStarts: '2 days', memberEnds: '9 days' });
    await addClaim(REBOOKER.p, 'claimed');
    await addClaim(DECLINED.p, 'declined');
    // A cohort member (declined claim) must NOT be able to book early — the 'claimed'
    // claim keeps the slot in the priority tier, and a declined claim can't authorize it.
    const member = await bookAs(DECLINED.u, DECLINED.p);
    expect(member.ok).toBe(false);
    expect(member.error).toMatch(/priority_restricted/);
    // And a random user is likewise refused (not silently opened to members).
    const random = await bookAs(RANDOM.u, RANDOM.p);
    expect(random.ok).toBe(false);
    expect(random.error).toMatch(/priority_restricted/);
  });

  it('RB02: member window NOT open before member_window_starts_at even with zero live claims', async () => {
    // All claims resolved (declined/expired), priority window still open, member window future.
    await setSlot({ priorityEnds: '2 days', memberStarts: '2 days', memberEnds: '9 days' });
    await addClaim(DECLINED.p, 'declined');
    // No pending/claimed claim ⇒ not priority; but member window hasn't started ⇒ not members.
    // public_release_status is NULL ⇒ resolves to 'public', so the tier gate allows it — the
    // POINT is that it must NOT be gated as 'members' (which would wrongly require membership
    // yet also wrongly open early). Assert it did NOT raise members_only for a non-cohort user.
    const random = await bookAs(RANDOM.u, RANDOM.p);
    expect(random.error ?? '').not.toMatch(/members_only/);
  });

  it('members: an eligible cohort member books once the member window has STARTED', async () => {
    await setSlot({ priorityEnds: '-1 day', memberStarts: '-1 hour', memberEnds: '7 days', release: 'auto_release_scheduled' });
    await addClaim(DECLINED.p, 'declined'); // cohort membership (clause b)
    const r = await bookAs(DECLINED.u, DECLINED.p);
    expect(r.ok).toBe(true);
  });

  it('members: a non-cohort user is refused (members_only)', async () => {
    await setSlot({ priorityEnds: '-1 day', memberStarts: '-1 hour', memberEnds: '7 days', release: 'auto_release_scheduled' });
    const r = await bookAs(RANDOM.u, RANDOM.p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/members_only/);
  });

  it('hidden: a held slot refuses a self-booking (slot_not_released)', async () => {
    await setSlot({ release: 'held' });
    const r = await bookAs(RANDOM.u, RANDOM.p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/slot_not_released/);
  });

  it('public: anyone can self-book once released', async () => {
    await setSlot({ release: 'released' });
    const r = await bookAs(RANDOM.u, RANDOM.p);
    expect(r.ok).toBe(true);
  });

  it('override: a service/staff insert (auth.uid NULL) bypasses the tier on a hidden slot', async () => {
    await setSlot({ release: 'held' });
    const r = await bookAs(null, RANDOM.p);
    expect(r.ok).toBe(true);
  });

  it('override: a manager booking ON BEHALF (player_id ≠ caller) bypasses the tier on a hidden slot', async () => {
    await setSlot({ release: 'held' });
    const r = await bookAs(MANAGER.u, DECLINED.p); // caller MANAGER, player DECLINED ⇒ not self
    expect(r.ok).toBe(true);
  });

  it('capacity is enforced BEFORE the tier gate — a full slot raises slot_full even for an eligible member', async () => {
    await setSlot({ priorityEnds: '-1 day', memberStarts: '-1 hour', memberEnds: '7 days', release: 'auto_release_scheduled' });
    await addClaim(DECLINED.p, 'declined');
    await bookAs(null, CLAIMER.p);   // fill seat 1 (setup insert, bypasses gate)
    await bookAs(null, REBOOKER.p);  // fill seat 2
    const r = await bookAs(DECLINED.u, DECLINED.p); // eligible, but slot is full
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/slot_full/);
  });
});
