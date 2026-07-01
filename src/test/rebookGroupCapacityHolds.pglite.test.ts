// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// F5 (Codex audit) regression: rebook_group_apply must count a LIVE payment_pending hold as
// occupying the slot, exactly like the pay-first RPCs do. This runs the ACTUAL migration
// (20260705100000_rebook_group_count_live_holds.sql) against real Postgres (PGlite) and proves:
//   • a live hold on the last seat blocks the rebook (skipped_full, no overbook), and
//   • an EXPIRED hold is ignored (the seat self-heals and the rebook proceeds).
// Before the fix the live hold was invisible to the capacity count → the group could overbook.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const SLOT = '30000000-0000-0000-0000-000000000001';
const CAPTAIN = '10000000-0000-0000-0000-000000000001'; // registered player rebooking the group
const PUBLIC_GUEST = '40000000-0000-0000-0000-000000000001'; // a public pay-first booker mid-checkout
const GROUP = '50000000-0000-0000-0000-000000000001';
const TOKEN = 'captain-token-1';

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260705100000_rebook_group_count_live_holds.sql'),
    'utf8',
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    -- Minimal shape of the tables the RPC touches (extra prod columns are irrelevant here).
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, trainer_id uuid, max_participants integer,
      start_time timestamptz, priority_window_ends_at timestamptz);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
      guest_player_id uuid, status text, payment_status text, hold_expires_at timestamptz,
      created_at timestamptz, updated_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, claim_token text,
      rebook_group_id uuid, player_id uuid, guest_player_id uuid, status text,
      responded_at timestamptz, decline_reason text, booking_id uuid,
      booked_by_player_id uuid, booked_by_guest_player_id uuid);
    -- manage's step 4 references invoices; create a stub so the function loads with body checks on.
    CREATE TABLE public.invoices (id uuid PRIMARY KEY, status text, booking_ids uuid[]);

    -- One whole-slot court (capacity 1) with an open priority window.
    INSERT INTO public.availability_slots (id, trainer_id, max_participants, start_time, priority_window_ends_at)
    VALUES ('${SLOT}', NULL, 1, now() + interval '7 days', now() + interval '2 days');
  `);
  // Apply the ACTUAL migration (the RPCs under test) — no stale inline copy.
  await db.exec(readMigration());
});

// Fresh seats + a pending captain claim before each case.
beforeEach(async () => {
  await db.exec(`DELETE FROM public.bookings;`);
  await db.exec(`DELETE FROM public.slot_priority_claims;`);
  await db.query(
    `INSERT INTO public.slot_priority_claims (slot_id, claim_token, rebook_group_id, player_id, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [SLOT, TOKEN, GROUP, CAPTAIN],
  );
});

async function apply() {
  return (
    await db.query<{ booked: number; skipped_full: number; declined: number; ok: boolean }>(
      `SELECT (r->>'booked')::int AS booked, (r->>'skipped_full')::int AS skipped_full,
              (r->>'declined')::int AS declined, (r->>'ok')::boolean AS ok
       FROM public.rebook_group_apply($1, '[]'::jsonb, '{}'::uuid[]) AS r`,
      [TOKEN],
    )
  ).rows[0];
}

describe('rebook_group_apply counts live payment_pending holds (F5)', () => {
  it('a LIVE hold on the last seat blocks the rebook (no overbook)', async () => {
    // A public booker holds the only seat, mid-Mollie-checkout (hold not yet expired).
    await db.query(
      `INSERT INTO public.bookings (slot_id, guest_player_id, status, payment_status, hold_expires_at)
       VALUES ($1, $2, 'payment_pending', 'pending', now() + interval '15 minutes')`,
      [SLOT, PUBLIC_GUEST],
    );

    const r = await apply();
    expect(r.skipped_full).toBe(1); // capacity counted the live hold
    expect(r.booked).toBe(0);

    // The slot must NOT be overbooked: no new confirmed booking was inserted.
    const confirmed = (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM public.bookings WHERE slot_id = $1 AND status = 'confirmed'`,
        [SLOT],
      )
    ).rows[0];
    expect(Number(confirmed.n)).toBe(0);
  });

  it('an EXPIRED hold is ignored — the seat self-heals and the rebook proceeds', async () => {
    // Same booker, but the hold has lapsed (expired holds free capacity).
    await db.query(
      `INSERT INTO public.bookings (slot_id, guest_player_id, status, payment_status, hold_expires_at)
       VALUES ($1, $2, 'payment_pending', 'pending', now() - interval '1 minute')`,
      [SLOT, PUBLIC_GUEST],
    );

    const r = await apply();
    expect(r.skipped_full).toBe(0);
    expect(r.booked).toBe(1); // expired hold ignored → captain booked into the free seat

    const confirmed = (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM public.bookings
         WHERE slot_id = $1 AND status = 'confirmed' AND player_id = $2`,
        [SLOT, CAPTAIN],
      )
    ).rows[0];
    expect(Number(confirmed.n)).toBe(1);
  });

  it('with NO competing hold the rebook books the captain (baseline)', async () => {
    const r = await apply();
    expect(r.booked).toBe(1);
    expect(r.skipped_full).toBe(0);
    expect(r.ok).toBe(true);
  });
});
