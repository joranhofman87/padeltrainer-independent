// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Slice A / F4 + group-exclusion regression. The no-login single-claim mint (create-rebook-invoice-
// public) charges FULL price because it mints over ONLY the claimant's OWN bookings — a single-identity
// batch, so auto-create-invoice's split auto-detect (needs >1 distinct player) can never fire. This
// proves the two-step booking gather the edge fn runs returns exactly the claimant's non-group bookings
// even when (a) the slots are split_payment=true and OTHER participants are booked on them, and (b) the
// claimant ALSO holds a group claim in the same cyclus (which must be excluded — the single path).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const C = '50000000-0000-0000-0000-000000000001';
const S1 = '30000000-0000-0000-0000-000000000001';
const S2 = '30000000-0000-0000-0000-000000000002';
const P = '10000000-0000-0000-0000-000000000001'; // the claimant paying
const P2 = '10000000-0000-0000-0000-000000000002'; // another participant on the same split slots
const G = '60000000-0000-0000-0000-000000000001'; // a rebook group P also belongs to

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, split_payment boolean);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text, booking_id uuid,
      player_id uuid, guest_player_id uuid, rebook_group_id uuid);
    INSERT INTO public.availability_slots (id, cyclus_id, split_payment) VALUES
      ('${S1}', '${C}', true), ('${S2}', '${C}', true);
    -- Claimant P: two claimed non-group bookings (the full cycle) → B1, B2.
    INSERT INTO public.slot_priority_claims (slot_id, status, booking_id, player_id) VALUES
      ('${S1}', 'claimed', '00000000-0000-0000-0000-0000000000b1', '${P}'),
      ('${S2}', 'claimed', '00000000-0000-0000-0000-0000000000b2', '${P}');
    -- Another participant P2 booked on the SAME split slots → must be EXCLUDED from P's batch.
    INSERT INTO public.slot_priority_claims (slot_id, status, booking_id, player_id) VALUES
      ('${S1}', 'claimed', '00000000-0000-0000-0000-0000000000b3', '${P2}'),
      ('${S2}', 'claimed', '00000000-0000-0000-0000-0000000000b4', '${P2}');
    -- P also has a GROUP claim in this cyclus → must be EXCLUDED (single path only).
    INSERT INTO public.slot_priority_claims (slot_id, status, booking_id, player_id, rebook_group_id) VALUES
      ('${S1}', 'claimed', '00000000-0000-0000-0000-0000000000b5', '${P}', '${G}');
    -- A pending (not-yet-booked) P claim → excluded (booking_id NULL).
    INSERT INTO public.slot_priority_claims (slot_id, status, booking_id, player_id) VALUES
      ('${S2}', 'pending', NULL, '${P}');
  `);
});

// The exact two-step gather create-rebook-invoice-public runs: cyclus slots → the claimant's claimed
// non-group booking ids.
async function gather(playerId: string): Promise<string[]> {
  const slots = (await db.query<{ id: string }>(`SELECT id FROM public.availability_slots WHERE cyclus_id = $1`, [C])).rows.map((r) => r.id);
  const rows = (
    await db.query<{ booking_id: string }>(
      `SELECT booking_id FROM public.slot_priority_claims
       WHERE slot_id = ANY($1) AND status = 'claimed' AND booking_id IS NOT NULL
         AND rebook_group_id IS NULL AND player_id = $2`,
      [slots, playerId],
    )
  ).rows;
  return [...new Set(rows.map((r) => r.booking_id))].sort();
}

describe('create-rebook-invoice-public booking gather is single-identity + non-group (F4 / #5)', () => {
  it("returns ONLY the claimant's own non-group bookings — the full cycle, no other participant", async () => {
    const ids = await gather(P);
    expect(ids).toEqual([
      '00000000-0000-0000-0000-0000000000b1',
      '00000000-0000-0000-0000-0000000000b2',
    ]);
    // Crucially NOT P2's bookings (b3/b4) and NOT P's group booking (b5) → the batch has ONE identity,
    // so auto-create-invoice's split auto-detect cannot fire → full cycle price is charged.
    expect(ids).not.toContain('00000000-0000-0000-0000-0000000000b3');
    expect(ids).not.toContain('00000000-0000-0000-0000-0000000000b5');
  });

  it('the batch contains exactly one distinct player identity (the split-detect precondition)', async () => {
    const ids = await gather(P);
    const players = (
      await db.query<{ player_id: string }>(
        `SELECT DISTINCT player_id FROM public.slot_priority_claims WHERE booking_id = ANY($1)`,
        [ids],
      )
    ).rows;
    expect(players).toHaveLength(1);
    expect(players[0].player_id).toBe(P);
  });
});
