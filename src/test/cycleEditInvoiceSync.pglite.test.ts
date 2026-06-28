// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// CHARACTERIZATION test (behaviour-freeze) for the bespoke cyclus-edit invoice writes
// extracted VERBATIM into src/lib/cycleEditInvoiceSync.ts. It runs the REAL helper against
// real Postgres (PGlite) and PINS TODAY's BUGGY output bit-for-bit, so the subsequent fix
// PRs have a reviewable money diff. Every assertion that encodes a KNOWN bug is marked
// `BUG …:` and cross-referenced to docs/audits/TSO_INVOICE_WRITES_AUDIT.md. When the fix
// lands (PR-2), these `BUG` assertions flip to the correct values — that flip IS the diff.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { mergeNewBookingIdsIntoCycleInvoices } from '@/lib/cycleEditInvoiceSync';

let db: PGlite;
let supa: SupabaseClient<Database>;

// Stable ids — Alice sorts before Bob, and existing bookings are inserted Alice-first so the
// heap-scan order (no ORDER BY in the helper) makes allCycleBookings[0] = Alice's booking.
const ALICE = '20000000-0000-0000-0000-00000000000a';
const BOB = '20000000-0000-0000-0000-00000000000b';
const bA = '30000000-0000-0000-0000-0000000000a1'; // Alice's EXISTING booking (slot S1)
const bB = '30000000-0000-0000-0000-0000000000b1'; // Bob's   EXISTING booking (slot S1)
const nA = '40000000-0000-0000-0000-0000000000a2'; // Alice's NEW booking (added slot S2)
const nB = '40000000-0000-0000-0000-0000000000b2'; // Bob's   NEW booking (added slot S2)
const INV_A = 'a0000000-0000-0000-0000-0000000000a0'; // Alice's single-player invoice
const INV_B = 'a0000000-0000-0000-0000-0000000000b0'; // Bob's   single-player invoice
const INV_G = 'a0000000-0000-0000-0000-0000000000c0'; // one GROUP invoice covering both

const bookingIdsOf = async (invId: string): Promise<string[]> =>
  ((await db.query<{ booking_ids: string[] | null }>(`SELECT booking_ids FROM invoices WHERE id = $1`, [invId]))
    .rows[0]?.booking_ids ?? []);

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db) as unknown as SupabaseClient<Database>;
  // Only the columns the merge touches. booking_ids is a real uuid[] so `&&` (overlaps) works.
  await db.exec(`
    CREATE TABLE bookings (id uuid PRIMARY KEY, slot_id text, player_id uuid, guest_player_id uuid, status text);
    CREATE TABLE invoices (id uuid PRIMARY KEY, status text, booking_ids uuid[], pdf_url text);
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM invoices; DELETE FROM bookings;`);
  // Two existing players on the original cycle slot S1 (Alice inserted first → heap order).
  await db.exec(`INSERT INTO bookings (id, slot_id, player_id, status) VALUES
    ('${bA}','S1','${ALICE}','confirmed'),
    ('${bB}','S1','${BOB}','confirmed');`);
});

// The params the trainer save builds after auto-booking both players onto the new slot S2.
const params = {
  createdBookings: [
    { id: nA, player_id: ALICE, guest_player_id: null },
    { id: nB, player_id: BOB, guest_player_id: null },
  ],
  existingBookings: [
    { player_id: ALICE, guest_player_id: null },
    { player_id: BOB, guest_player_id: null },
  ],
  existingSlotIds: ['S1'],
};

describe('mergeNewBookingIdsIntoCycleInvoices — characterization (pins bug A1)', () => {
  it('PER-PLAYER invoices: new ids are MISROUTED (one invoice absorbs both players, the other gets none)', async () => {
    // Each player has their OWN single-player invoice — the dominant academy shape.
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_A}','sent', ARRAY['${bA}']::uuid[]),
      ('${INV_B}','sent', ARRAY['${bB}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices(params, supa);

    // BUG A1 (P0): the no-op matcher collapses ebId to allCycleBookings[0] = Alice's bA, so the
    // invoice that contains bA (INV_A) is treated as covering EVERYONE → it absorbs BOTH Alice's
    // AND Bob's new bookings. Correct behaviour would be [bA, nA] (Alice billed for her 1 added
    // week only). It is over-billed by Bob's session.
    expect((await bookingIdsOf(INV_A)).sort()).toEqual([bA, nA, nB].sort());

    // BUG A1 (P0): INV_B's booking_ids ([bB]) do not contain the constant id bA, so its
    // invExistingBookings filter yields [] → it receives NONE of Bob's new bookings. Correct
    // would be [bB, nB] (Bob billed for his added week). Bob attends but is under-billed.
    expect(await bookingIdsOf(INV_B)).toEqual([bB]);
  });

  it('GROUP invoice: the same constant-collapse happens to land CORRECT (this is what masked the bug)', async () => {
    // One invoice covers both players' existing bookings.
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_G}','sent', ARRAY['${bA}','${bB}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices(params, supa);

    // Group shape: currentIds contains bA (the constant), so the filter passes ALL existing
    // bookings → both players' new ids are appended. Accidentally correct — which is exactly why
    // the per-player bug above stayed hidden in testing on group invoices.
    expect((await bookingIdsOf(INV_G)).sort()).toEqual([bA, bB, nA, nB].sort());
  });

  it('no created bookings → no-op (early return, no invoice write)', async () => {
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_A}','sent', ARRAY['${bA}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices({ ...params, createdBookings: [] }, supa);

    expect(await bookingIdsOf(INV_A)).toEqual([bA]); // untouched
  });

  it('A2 (P1): a paid invoice is excluded by the status filter and never mutated', async () => {
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_A}','paid', ARRAY['${bA}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices(params, supa);

    expect(await bookingIdsOf(INV_A)).toEqual([bA]); // paid → not in ('draft','sent','pending')
  });
});
