// @vitest-environment node
// Public-booking audit P1-1: get_public_slot_occupancy is the anon-safe occupancy source for
// the public availability pages (anon has no SELECT RLS on bookings, so the direct read
// returned 0 → full slots showed bookable). This exercises the function body against real
// Postgres: it counts only pending/confirmed bookings, only for is_public slots, grouped per
// slot. Function body copied verbatim from migration 20260706140000.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const PUB_A = '10000000-0000-0000-0000-00000000000a';
const PUB_B = '10000000-0000-0000-0000-00000000000b';
const PRIV = '10000000-0000-0000-0000-0000000000cc';

const occupancy = async (ids: string[]): Promise<Record<string, number>> => {
  const { rows } = await db.query<{ slot_id: string; occupied: number }>(
    `SELECT * FROM public.get_public_slot_occupancy($1::uuid[])`,
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.slot_id, Number(r.occupied)]));
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, is_public boolean NOT NULL DEFAULT true);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid NOT NULL,
      status text NOT NULL,
      hold_expires_at timestamptz
    );
    INSERT INTO public.availability_slots (id, is_public) VALUES
      ('${PUB_A}', true), ('${PUB_B}', true), ('${PRIV}', false);
    INSERT INTO public.bookings (slot_id, status, hold_expires_at) VALUES
      -- PUB_A: 3 occupying (confirmed, pending, pending_approval) + a LIVE payment_pending hold
      -- = 4; plus ignored states (cancelled/…/completed/rejected) and an EXPIRED hold.
      ('${PUB_A}','confirmed', NULL), ('${PUB_A}','pending', NULL), ('${PUB_A}','pending_approval', NULL),
      ('${PUB_A}','payment_pending', now() + interval '10 min'),
      ('${PUB_A}','payment_pending', now() - interval '1 min'),
      ('${PUB_A}','cancelled', NULL), ('${PUB_A}','cancelled_swap', NULL),
      ('${PUB_A}','completed', NULL), ('${PUB_A}','rejected', NULL),
      ('${PUB_B}','confirmed', NULL),
      ('${PRIV}','confirmed', NULL), ('${PRIV}','pending', NULL);
  `);
  // Verbatim from migration 20260706140000 (aligned to the capacity-enforcement predicate).
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.get_public_slot_occupancy(_slot_ids uuid[])
    RETURNS TABLE (slot_id uuid, occupied integer)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT b.slot_id, COUNT(*)::integer AS occupied
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE b.slot_id = ANY(_slot_ids)
        AND s.is_public = true
        AND (
          COALESCE(b.status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
          OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
        )
      GROUP BY b.slot_id;
    $$;
  `);
});

describe('get_public_slot_occupancy', () => {
  it('counts confirmed/pending/pending_approval + LIVE holds; ignores cancelled/completed/rejected + EXPIRED holds', async () => {
    const occ = await occupancy([PUB_A]);
    // confirmed + pending + pending_approval + 1 live payment_pending hold = 4.
    // The expired hold and the 4 dead states are excluded — matches capacity enforcement.
    expect(occ[PUB_A]).toBe(4);
  });

  it('never reveals a private (is_public=false) slot occupancy', async () => {
    const occ = await occupancy([PRIV]);
    expect(occ[PRIV]).toBeUndefined(); // filtered out entirely
  });

  it('groups per slot and only returns requested slots', async () => {
    const occ = await occupancy([PUB_A, PUB_B, PRIV]);
    expect(occ).toEqual({ [PUB_A]: 4, [PUB_B]: 1 });
  });

  it('returns nothing for an empty / unmatched id set', async () => {
    expect(await occupancy([])).toEqual({});
    expect(await occupancy(['20000000-0000-0000-0000-000000000000'])).toEqual({});
  });
});
