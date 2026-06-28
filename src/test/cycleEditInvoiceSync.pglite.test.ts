// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Correctness test for `mergeNewBookingIdsIntoCycleInvoices` (the cyclus-edit "Write A"
// booking_ids merge). PR-1a extracted it verbatim and PINNED bug A1 (the no-op matcher that
// misrouted new bookings); PR-2 replaced the matcher with a real per-player join, so these
// assertions now encode the CORRECT routing: each player's new bookings land ONLY on the
// invoice(s) that already bill that player. Runs the REAL helper against real Postgres (PGlite).
// See docs/audits/TSO_INVOICE_WRITES_AUDIT.md (Write A).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { mergeNewBookingIdsIntoCycleInvoices } from '@/lib/cycleEditInvoiceSync';

let db: PGlite;
let supa: SupabaseClient<Database>;

const ALICE = '20000000-0000-0000-0000-00000000000a';
const BOB = '20000000-0000-0000-0000-00000000000b';
const CAROL = '20000000-0000-0000-0000-00000000000c'; // a GUEST player (guest_player_id, no profile)
const bA = '30000000-0000-0000-0000-0000000000a1'; // Alice's EXISTING booking (slot S1)
const bB = '30000000-0000-0000-0000-0000000000b1'; // Bob's   EXISTING booking (slot S1)
const bC = '30000000-0000-0000-0000-0000000000c1'; // Carol's EXISTING guest booking (slot S1)
const nA = '40000000-0000-0000-0000-0000000000a2'; // Alice's NEW booking (added slot S2)
const nB = '40000000-0000-0000-0000-0000000000b2'; // Bob's   NEW booking (added slot S2)
const nC = '40000000-0000-0000-0000-0000000000c2'; // Carol's NEW guest booking (added slot S2)
const INV_A = 'a0000000-0000-0000-0000-0000000000a0'; // Alice's single-player invoice
const INV_B = 'a0000000-0000-0000-0000-0000000000b0'; // Bob's   single-player invoice
const INV_C = 'a0000000-0000-0000-0000-0000000000d0'; // Carol's single-guest invoice
const INV_G = 'a0000000-0000-0000-0000-0000000000c0'; // one GROUP invoice covering Alice+Bob

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
  // Two existing players on the original cycle slot S1.
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
  existingSlotIds: ['S1'],
};

describe('mergeNewBookingIdsIntoCycleInvoices — per-player routing (bug A1 fixed)', () => {
  it('PER-PLAYER invoices: each invoice gets ONLY its own player’s new booking', async () => {
    // Each player has their OWN single-player invoice — the dominant academy shape.
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_A}','sent', ARRAY['${bA}']::uuid[]),
      ('${INV_B}','sent', ARRAY['${bB}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices(params, supa);

    // Alice's invoice bills Alice's added week and nothing else.
    expect((await bookingIdsOf(INV_A)).sort()).toEqual([bA, nA].sort());
    // Bob's invoice bills Bob's added week — it is no longer left empty.
    expect((await bookingIdsOf(INV_B)).sort()).toEqual([bB, nB].sort());
  });

  it('GUEST player: routing keys off guest_player_id, isolating the guest’s invoice', async () => {
    // Add Carol as a guest on S1, and mint a new guest booking for her too.
    await db.exec(`INSERT INTO bookings (id, slot_id, guest_player_id, status) VALUES ('${bC}','S1','${CAROL}','confirmed');`);
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_A}','sent', ARRAY['${bA}']::uuid[]),
      ('${INV_C}','sent', ARRAY['${bC}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices(
      { createdBookings: [...params.createdBookings, { id: nC, player_id: null, guest_player_id: CAROL }], existingSlotIds: ['S1'] },
      supa,
    );

    // Carol's guest invoice gets her guest booking only — not Alice's or Bob's.
    expect((await bookingIdsOf(INV_C)).sort()).toEqual([bC, nC].sort());
    expect((await bookingIdsOf(INV_A)).sort()).toEqual([bA, nA].sort());
  });

  it('GROUP invoice: a single invoice covering several players gets all of their new bookings', async () => {
    // Regression guard. (Note: a group invoice was already "accidentally correct" under the old
    // no-op matcher — the PER-PLAYER and GUEST cases above are what actually pin the fix.)
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_G}','sent', ARRAY['${bA}','${bB}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices(params, supa);

    // Group shape: the invoice bills both players, so both players' new ids are appended.
    expect((await bookingIdsOf(INV_G)).sort()).toEqual([bA, bB, nA, nB].sort());
  });

  it('MIXED invoice: a foreign booking id is preserved and only the in-cycle player’s new booking is appended', async () => {
    // INV_A bills Alice (bA, in this cycle) AND carries an id from a DIFFERENT cycle (foreign).
    const foreign = '99999999-9999-9999-9999-999999999999'; // not on S1, not in the player map
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_A}','sent', ARRAY['${bA}','${foreign}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices(params, supa);

    // The foreign id resolves to no in-cycle player (filtered out), so the invoice's billed-players
    // set is {Alice}: Alice's new booking is appended, the foreign id is left intact, and Bob's
    // new booking is NOT leaked in.
    expect((await bookingIdsOf(INV_A)).sort()).toEqual([bA, foreign, nA].sort());
  });

  it('no created bookings → no-op (early return, no invoice write)', async () => {
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_A}','sent', ARRAY['${bA}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices({ ...params, createdBookings: [] }, supa);

    expect(await bookingIdsOf(INV_A)).toEqual([bA]); // untouched
  });

  it('a paid invoice is excluded by the status filter and never mutated', async () => {
    await db.exec(`INSERT INTO invoices (id, status, booking_ids) VALUES
      ('${INV_A}','paid', ARRAY['${bA}']::uuid[]);`);

    await mergeNewBookingIdsIntoCycleInvoices(params, supa);

    expect(await bookingIdsOf(INV_A)).toEqual([bA]); // paid → not in ('draft','sent','pending')
  });
});
