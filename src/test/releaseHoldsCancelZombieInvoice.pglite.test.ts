// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Zombie-invoice kill (migration 20260803100000): release_expired_rebook_holds must, after
// releasing expired holds, cancel UNPAID rebook-tagged invoices whose bookings are ALL cancelled —
// and must NOT touch paid invoices, non-rebook invoices, or invoices with a still-active booking.
// Runs the real function against Postgres (PGlite).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CY = 'c0000000-0000-0000-0000-000000000001';
const B_EXPIRED_1 = 'b0000000-0000-0000-0000-000000000001';
const B_EXPIRED_2 = 'b0000000-0000-0000-0000-000000000002';
const B_LIVE = 'b0000000-0000-0000-0000-000000000003';
const B_PAIDINV = 'b0000000-0000-0000-0000-000000000004';
const B_PLAIN = 'b0000000-0000-0000-0000-000000000005';

const inv = async (id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM public.invoices WHERE id=$1`, [id])).rows[0]?.status;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE service_role;
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY, status text, hold_expires_at timestamptz, updated_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, booking_id uuid, responded_at timestamptz);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, booking_ids uuid[],
      rebook_cyclus_id uuid, rebook_group_id uuid);

    INSERT INTO public.bookings VALUES
      ('${B_EXPIRED_1}', 'payment_pending', now() - interval '1 minute', now()),
      ('${B_EXPIRED_2}', 'payment_pending', now() - interval '1 minute', now()),
      ('${B_LIVE}',      'payment_pending', now() + interval '10 minutes', now()),
      ('${B_PAIDINV}',   'cancelled',       now() - interval '1 hour', now()),
      ('${B_PLAIN}',     'cancelled',       NULL, now());

    INSERT INTO public.slot_priority_claims (status, booking_id) VALUES
      ('claimed', '${B_EXPIRED_1}'), ('claimed', '${B_EXPIRED_2}'), ('claimed', '${B_LIVE}');

    INSERT INTO public.invoices (id, status, booking_ids, rebook_cyclus_id, rebook_group_id) VALUES
      -- zombie: unpaid, rebook-tagged, all bookings will be cancelled → MUST cancel
      ('11111111-0000-0000-0000-000000000001', 'sent', ARRAY['${B_EXPIRED_1}','${B_EXPIRED_2}']::uuid[], '${CY}', NULL),
      -- still-live seat: one booking not expired → must stay
      ('11111111-0000-0000-0000-000000000002', 'sent', ARRAY['${B_EXPIRED_1}','${B_LIVE}']::uuid[], '${CY}', NULL),
      -- PAID over cancelled bookings (manual-refund trail) → must stay paid
      ('11111111-0000-0000-0000-000000000003', 'paid', ARRAY['${B_PAIDINV}']::uuid[], NULL, 'dddd0000-0000-0000-0000-000000000001'),
      -- NON-rebook invoice over cancelled bookings (e.g. cancellation fee) → must stay
      ('11111111-0000-0000-0000-000000000004', 'sent', ARRAY['${B_PLAIN}']::uuid[], NULL, NULL);
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260803100000_release_holds_cancel_zombie_invoice.sql'), 'utf8'));
});

describe('release_expired_rebook_holds — zombie-invoice sweep', () => {
  it('releases expired holds, resets claims, and cancels only the true zombie invoice', async () => {
    const released = (await db.query<{ n: number }>(`SELECT public.release_expired_rebook_holds() AS n`)).rows[0].n;
    expect(Number(released)).toBe(2); // the two expired holds

    // Holds + claims behave as before.
    const b1 = (await db.query<{ status: string }>(`SELECT status FROM public.bookings WHERE id=$1`, [B_EXPIRED_1])).rows[0].status;
    const bLive = (await db.query<{ status: string }>(`SELECT status FROM public.bookings WHERE id=$1`, [B_LIVE])).rows[0].status;
    expect(b1).toBe('cancelled');
    expect(bLive).toBe('payment_pending');
    const pendingClaims = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.slot_priority_claims WHERE status='pending' AND booking_id IS NULL`)).rows[0].n;
    expect(Number(pendingClaims)).toBe(2);

    // The invoice sweep.
    expect(await inv('11111111-0000-0000-0000-000000000001')).toBe('cancelled'); // zombie killed
    expect(await inv('11111111-0000-0000-0000-000000000002')).toBe('sent'); // live seat → untouched
    expect(await inv('11111111-0000-0000-0000-000000000003')).toBe('paid'); // paid → never touched
    expect(await inv('11111111-0000-0000-0000-000000000004')).toBe('sent'); // non-rebook → untouched
  });

  it('is idempotent — a second run changes nothing', async () => {
    const released = (await db.query<{ n: number }>(`SELECT public.release_expired_rebook_holds() AS n`)).rows[0].n;
    expect(Number(released)).toBe(0);
    expect(await inv('11111111-0000-0000-0000-000000000002')).toBe('sent');
  });
});
