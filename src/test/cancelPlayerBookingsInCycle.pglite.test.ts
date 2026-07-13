// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// FAM-02 Level 1 person scope for the whole-cycle Remove (src/lib/bookings.ts
// cancelPlayerBookingsInCycle), against real Postgres. The audit §4.3 finding: Remove matched
// player-first while Change matched guest-first, so on a dual-keyed (linked guest) row the two
// actions hit different booking sets — removing the profile-holder also swept the linked guest's
// seats. Under Level 1 a dual-keyed booking belongs to the GUEST person:
//   guest ref   → every booking carrying that guest id (dual rows included);
//   profile ref → only pure-profile rows (guest_player_id IS NULL).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { cancelPlayerBookingsInCycle } from '@/lib/bookings';

let db: PGlite;
let supa: SupabaseClient<Database>;

const PARENT = '40000000-0000-0000-0000-0000000000d0'; // profile (the account holder)
const CHILD = '20000000-0000-0000-0000-0000000000b0'; // guest linked to PARENT (dual-keyed rows)
const S1 = '30000000-0000-0000-0000-000000000010';
const S2 = '30000000-0000-0000-0000-000000000020';

const statusOf = async (where: string): Promise<string[]> =>
  (await db.query<{ status: string }>(`SELECT status FROM bookings WHERE ${where} ORDER BY slot_id`)).rows.map((r) => r.status);

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db) as unknown as SupabaseClient<Database>;
  await db.exec(`
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, guest_player_id uuid, player_id uuid, status text, payment_status text
    );
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings;`);
  // On BOTH slots: the parent's own pure-profile seat + the linked child's dual-keyed seat
  // (the historical signup linker stamped the parent's player_id onto the child's guest rows).
  await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, player_id, status, payment_status) VALUES
    ('${S1}', NULL,       '${PARENT}', 'confirmed', 'pending'),
    ('${S1}', '${CHILD}', '${PARENT}', 'confirmed', 'pending'),
    ('${S2}', NULL,       '${PARENT}', 'completed', 'paid'),
    ('${S2}', '${CHILD}', '${PARENT}', 'pending',   'pending');`);
});

describe('cancelPlayerBookingsInCycle — FAM-02 person scope', () => {
  it('removing the PROFILE person cancels only their pure-profile rows — the linked child keeps every seat', async () => {
    const res = await cancelPlayerBookingsInCycle([S1, S2], { playerId: PARENT }, supa, { skipInvoiceSync: true });
    expect(res.cancelError).toBeNull();
    expect(res.cancelledCount).toBe(2); // both of the parent's own rows (incl. the completed one — broadest sweep)
    expect(await statusOf(`player_id = '${PARENT}' AND guest_player_id IS NULL`)).toEqual(['cancelled', 'cancelled']);
    expect(await statusOf(`guest_player_id = '${CHILD}'`)).toEqual(['confirmed', 'pending']);
  });

  it('removing the GUEST person cancels every row carrying their guest id — the parent keeps their own seats', async () => {
    const res = await cancelPlayerBookingsInCycle([S1, S2], { guestPlayerId: CHILD }, supa, { skipInvoiceSync: true });
    expect(res.cancelError).toBeNull();
    expect(res.cancelledCount).toBe(2);
    expect(await statusOf(`guest_player_id = '${CHILD}'`)).toEqual(['cancelled', 'cancelled']);
    expect(await statusOf(`player_id = '${PARENT}' AND guest_player_id IS NULL`)).toEqual(['confirmed', 'completed']);
  });

  it('a dual-keyed ref (roster row carrying both ids) resolves to the GUEST person', async () => {
    const res = await cancelPlayerBookingsInCycle(
      [S1, S2],
      { playerId: PARENT, guestPlayerId: CHILD },
      supa,
      { skipInvoiceSync: true },
    );
    expect(res.cancelledCount).toBe(2);
    expect(await statusOf(`guest_player_id = '${CHILD}'`)).toEqual(['cancelled', 'cancelled']);
    expect(await statusOf(`player_id = '${PARENT}' AND guest_player_id IS NULL`)).toEqual(['confirmed', 'completed']);
  });

  it('scopes to the given slots only', async () => {
    const res = await cancelPlayerBookingsInCycle([S1], { guestPlayerId: CHILD }, supa, { skipInvoiceSync: true });
    expect(res.cancelledCount).toBe(1);
    expect(await statusOf(`guest_player_id = '${CHILD}'`)).toEqual(['cancelled', 'pending']);
  });
});
