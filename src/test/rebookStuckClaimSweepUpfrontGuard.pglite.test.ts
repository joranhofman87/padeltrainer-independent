// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Migration 20260804100000 (the 2026-07-10 Eveline incident), two guards run against real Postgres:
//  1. release_expired_rebook_holds gains a GLOBAL stuck-claim sweep: a claim left 'claimed' on a
//     booking that was cancelled OUTSIDE the cron pass (client rollback on a failed checkout mint)
//     must revert to 'pending' so the claim link works again — but ONLY when the booking died as an
//     UNPAID strict hold (hold_expires_at set, payment_status <> 'paid'). Paid refund-trails and
//     deliberate cancellations of confirmed seats (no hold marker) stay untouched.
//  2. rebook_group_apply refuses UPFRONT cycles server-side ({ok:false, reason:'upfront_cycle'}):
//     the deferred apply path books confirmed-but-UNPAID seats and must never run on a pay-first
//     round, no matter what the client's mode resolution said.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const readMigration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');

// Sweep fixtures
const B_STUCK = 'b0000000-0000-0000-0000-000000000011'; // cancelled unpaid hold, cancelled OUTSIDE the cron
const B_REFUND = 'b0000000-0000-0000-0000-000000000012'; // cancelled but PAID (refund trail)
const B_ADMIN = 'b0000000-0000-0000-0000-000000000013'; // cancelled confirmed seat (no hold marker)
const B_LIVE = 'b0000000-0000-0000-0000-000000000014'; // live hold — untouched

// Guard fixtures
const SLOT_UP = '30000000-0000-0000-0000-000000000021';
const SLOT_DEF = '30000000-0000-0000-0000-000000000022';
const SLOT_ORPHAN = '30000000-0000-0000-0000-000000000023';
const CY_UP = 'c0000000-0000-0000-0000-000000000021';
const CY_DEF = 'c0000000-0000-0000-0000-000000000022';
const CAPTAIN = '10000000-0000-0000-0000-000000000001';
const GROUP_UP = '50000000-0000-0000-0000-000000000021';
const GROUP_DEF = '50000000-0000-0000-0000-000000000022';
const GROUP_ORPHAN = '50000000-0000-0000-0000-000000000023';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, trainer_id uuid, cyclus_id uuid, max_participants integer,
      start_time timestamptz, priority_window_ends_at timestamptz);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
      guest_player_id uuid, status text, payment_status text, hold_expires_at timestamptz,
      created_at timestamptz, updated_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, claim_token text,
      rebook_group_id uuid, player_id uuid, guest_player_id uuid, status text,
      responded_at timestamptz, decline_reason text, booking_id uuid,
      booked_by_player_id uuid, booked_by_guest_player_id uuid);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, booking_ids uuid[],
      rebook_cyclus_id uuid, rebook_group_id uuid);

    INSERT INTO public.cycles (id, settings) VALUES
      ('${CY_UP}',  '{"rebook_payment_mode":"upfront","rebook_strict_mollie":true}'::jsonb),
      ('${CY_DEF}', '{"rebook_payment_mode":"deferred_split"}'::jsonb);

    INSERT INTO public.availability_slots (id, trainer_id, cyclus_id, max_participants, start_time, priority_window_ends_at) VALUES
      ('${SLOT_UP}',     NULL, '${CY_UP}',  4, now() + interval '7 days', now() + interval '2 days'),
      ('${SLOT_DEF}',    NULL, '${CY_DEF}', 4, now() + interval '7 days', now() + interval '2 days'),
      ('${SLOT_ORPHAN}', NULL, NULL,        4, now() + interval '7 days', now() + interval '2 days');
  `);
  // The real functions under test: the prior definitions, then the incident migration on top.
  await db.exec(readMigration('20260705100000_rebook_group_count_live_holds.sql'));
  await db.exec(readMigration('20260803100000_release_holds_cancel_zombie_invoice.sql'));
  await db.exec(readMigration('20260804100000_rebook_stuck_claim_sweep_and_upfront_apply_guard.sql'));
});

describe('release_expired_rebook_holds — global stuck-claim sweep (Eveline regression)', () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.bookings (id, slot_id, status, payment_status, hold_expires_at, updated_at) VALUES
        ('${B_STUCK}',  '${SLOT_UP}', 'cancelled',       'pending', now() - interval '30 minutes', now()),
        ('${B_REFUND}', '${SLOT_UP}', 'cancelled',       'paid',    now() - interval '30 minutes', now()),
        ('${B_ADMIN}',  '${SLOT_UP}', 'cancelled',       'pending', NULL,                          now()),
        ('${B_LIVE}',   '${SLOT_UP}', 'payment_pending', 'pending', now() + interval '10 minutes', now());
      INSERT INTO public.slot_priority_claims (slot_id, claim_token, status, booking_id) VALUES
        ('${SLOT_UP}', 'tok-stuck',  'claimed', '${B_STUCK}'),
        ('${SLOT_UP}', 'tok-refund', 'claimed', '${B_REFUND}'),
        ('${SLOT_UP}', 'tok-admin',  'claimed', '${B_ADMIN}'),
        ('${SLOT_UP}', 'tok-live',   'claimed', '${B_LIVE}');
    `);
  });

  const claim = async (token: string) =>
    (await db.query<{ status: string; booking_id: string | null }>(
      `SELECT status, booking_id FROM public.slot_priority_claims WHERE claim_token=$1`, [token],
    )).rows[0];

  it('reverts the claim whose booking died as an UNPAID hold cancelled outside the cron', async () => {
    await db.query(`SELECT public.release_expired_rebook_holds()`);
    const stuck = await claim('tok-stuck');
    expect(stuck.status).toBe('pending'); // the dead-ended link works again
    expect(stuck.booking_id).toBeNull();
  });

  it('never touches a PAID refund trail, an admin-cancelled confirmed seat, or a live hold', async () => {
    expect((await claim('tok-refund')).status).toBe('claimed'); // paid → money trail preserved
    expect((await claim('tok-admin')).status).toBe('claimed'); // no hold marker → deliberate cancel
    expect((await claim('tok-live')).status).toBe('claimed'); // hold still live → mid-checkout
  });

  it('is idempotent', async () => {
    await db.query(`SELECT public.release_expired_rebook_holds()`);
    expect((await claim('tok-stuck')).status).toBe('pending');
    expect((await claim('tok-refund')).status).toBe('claimed');
  });
});

describe('rebook_group_apply — refuses upfront cycles server-side', () => {
  beforeEach(async () => {
    await db.exec(`DELETE FROM public.slot_priority_claims WHERE claim_token LIKE 'cap-%';`);
    await db.query(
      `INSERT INTO public.slot_priority_claims (slot_id, claim_token, rebook_group_id, player_id, status) VALUES
         ($1, 'cap-up',     $2, $4, 'pending'),
         ($3, 'cap-def',    $5, $4, 'pending'),
         ($6, 'cap-orphan', $7, $4, 'pending')`,
      [SLOT_UP, GROUP_UP, SLOT_DEF, CAPTAIN, GROUP_DEF, SLOT_ORPHAN, GROUP_ORPHAN],
    );
  });

  const apply = async (token: string) =>
    (await db.query<{ ok: boolean; reason: string | null; booked: number }>(
      `SELECT (r->>'ok')::boolean AS ok, r->>'reason' AS reason, COALESCE((r->>'booked')::int, 0) AS booked
       FROM public.rebook_group_apply($1, '[]'::jsonb, '{}'::uuid[]) AS r`, [token],
    )).rows[0];

  it('UPFRONT cycle → {ok:false, reason:upfront_cycle}, nothing booked, claim stays pending', async () => {
    const r = await apply('cap-up');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('upfront_cycle');
    expect(Number(r.booked)).toBe(0);
    const st = (await db.query<{ status: string }>(
      `SELECT status FROM public.slot_priority_claims WHERE claim_token='cap-up'`)).rows[0].status;
    expect(st).toBe('pending'); // still acceptable via the proper payment flow
  });

  it('deferred cycle still books (baseline unchanged)', async () => {
    const r = await apply('cap-def');
    expect(r.ok).toBe(true);
    expect(Number(r.booked)).toBe(1);
  });

  it('slot without a linked cycle keeps the legacy deferred behaviour (NULL mode ≠ upfront)', async () => {
    const r = await apply('cap-orphan');
    expect(r.ok).toBe(true);
    expect(Number(r.booked)).toBe(1);
  });
});
