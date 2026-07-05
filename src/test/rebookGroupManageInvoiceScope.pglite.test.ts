// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// P2-3 regression: rebook_group_manage step 4 must ONLY append the captain's new booking ids onto
// the captain's OWN group invoice (invoices.rebook_group_id = the group). Before the fix the UPDATE
// matched any paid invoice by client-supplied _invoice_id → a paid captain could corrupt a
// stranger's invoice. This runs the base RPC migration + the NEW scope-fix migration against real
// Postgres (PGlite) and proves a FOREIGN invoice id is rejected while the OWN invoice is linked.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const SLOT = '30000000-0000-0000-0000-000000000001';
const CAPTAIN = '10000000-0000-0000-0000-000000000001';
const MEMBER = '10000000-0000-0000-0000-000000000002'; // a kept teammate booked in step 2
const GROUP = '50000000-0000-0000-0000-000000000001';
const OTHER_GROUP = '50000000-0000-0000-0000-000000000009';
const OWN_INVOICE = '60000000-0000-0000-0000-000000000001';
const FOREIGN_INVOICE = '60000000-0000-0000-0000-000000000009';
const CAP_BOOKING = '20000000-0000-0000-0000-000000000001';
const TOKEN = 'captain-token-1';

function readMigration(rel: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', rel), 'utf8');
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, trainer_id uuid, max_participants integer,
      start_time timestamptz, priority_window_ends_at timestamptz);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
      guest_player_id uuid, status text, payment_status text, paid_at timestamptz,
      paid_by_player_id uuid, paid_by_guest_player_id uuid, hold_expires_at timestamptz,
      created_at timestamptz, updated_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, claim_token text,
      rebook_group_id uuid, player_id uuid, guest_player_id uuid, status text,
      responded_at timestamptz, decline_reason text, booking_id uuid,
      booked_by_player_id uuid, booked_by_guest_player_id uuid);
    -- invoices stub now carries rebook_group_id — the column the scope check reads.
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY, status text, booking_ids uuid[], rebook_group_id uuid);

    -- Capacity 2 court so the kept MEMBER can be booked (→ v_new_ids non-empty → step 4 runs).
    INSERT INTO public.availability_slots (id, trainer_id, max_participants, start_time, priority_window_ends_at)
    VALUES ('${SLOT}', NULL, 2, now() + interval '7 days', now() + interval '2 days');
  `);
  // Base RPC definition, then the NEW scope-fix migration on top (LATEST wins).
  await db.exec(readMigration('20260705100000_rebook_group_count_live_holds.sql'));
  await db.exec(readMigration('20260706170000_p2_3_rebook_group_manage_scope.sql'));
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.bookings;`);
  await db.exec(`DELETE FROM public.slot_priority_claims;`);
  await db.exec(`DELETE FROM public.invoices;`);

  // Captain: claim already 'claimed' + a PAID booking (the manage gate requires this).
  await db.query(
    `INSERT INTO public.bookings (id, slot_id, player_id, status, payment_status, paid_at)
     VALUES ($1, $2, $3, 'confirmed', 'paid', now())`,
    [CAP_BOOKING, SLOT, CAPTAIN],
  );
  await db.query(
    `INSERT INTO public.slot_priority_claims (slot_id, claim_token, rebook_group_id, player_id, status, booking_id)
     VALUES ($1, $2, $3, $4, 'claimed', $5)`,
    [SLOT, TOKEN, GROUP, CAPTAIN, CAP_BOOKING],
  );
  // A kept teammate with a PENDING claim → gets booked in step 2 → non-empty v_new_ids.
  await db.query(
    `INSERT INTO public.slot_priority_claims (slot_id, rebook_group_id, player_id, status)
     VALUES ($1, $2, $3, 'pending')`,
    [SLOT, GROUP, MEMBER],
  );

  // The captain's OWN group invoice (paid, tagged to GROUP) and a FOREIGN paid invoice
  // belonging to another group — the attacker's target.
  await db.query(
    `INSERT INTO public.invoices (id, status, booking_ids, rebook_group_id)
     VALUES ($1, 'paid', ARRAY[$2]::uuid[], $3)`,
    [OWN_INVOICE, CAP_BOOKING, GROUP],
  );
  await db.query(
    `INSERT INTO public.invoices (id, status, booking_ids, rebook_group_id)
     VALUES ($1, 'paid', '{}'::uuid[], $2)`,
    [FOREIGN_INVOICE, OTHER_GROUP],
  );
});

async function manage(invoiceId: string) {
  return (
    await db.query<{ booked: number; ok: boolean; booking_ids: string[] }>(
      `SELECT (r->>'booked')::int AS booked, (r->>'ok')::boolean AS ok,
              ARRAY(SELECT jsonb_array_elements_text(r->'booking_ids'))::uuid[] AS booking_ids
       FROM public.rebook_group_manage($1, '["p:${MEMBER}"]'::jsonb, '{}'::uuid[], $2::uuid) AS r`,
      [TOKEN, invoiceId],
    )
  ).rows[0];
}

async function bookingIdsOf(invoiceId: string): Promise<string[]> {
  const row = (
    await db.query<{ ids: string[] }>(
      `SELECT COALESCE(booking_ids, '{}'::uuid[]) AS ids FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
  ).rows[0];
  return row.ids ?? [];
}

describe('rebook_group_manage scopes step-4 invoice link to the captain own group (P2-3)', () => {
  it('REJECTS a foreign invoice id — a stranger invoice is NOT modified', async () => {
    const r = await manage(FOREIGN_INVOICE);
    expect(r.ok).toBe(true);
    expect(r.booked).toBe(1); // the member WAS booked (covered seats still created)
    // ...but the foreign invoice's booking_ids are untouched (still empty).
    expect(await bookingIdsOf(FOREIGN_INVOICE)).toEqual([]);
  });

  it('LINKS the captain own group invoice (baseline still works)', async () => {
    const r = await manage(OWN_INVOICE);
    expect(r.ok).toBe(true);
    expect(r.booked).toBe(1);
    const ids = await bookingIdsOf(OWN_INVOICE);
    // Original captain booking is preserved and the new member booking is appended.
    expect(ids).toContain(CAP_BOOKING);
    for (const id of r.booking_ids) expect(ids).toContain(id);
  });
});
