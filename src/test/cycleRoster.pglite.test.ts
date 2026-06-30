// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Money-path tests for the cycle-roster add/change/remove (src/lib/cycleRoster.ts) and the shared
// booking primitive (src/lib/slotBookingWrite.ts), run against real Postgres (PGlite).
//
// Scope: the "Don't update invoices" = ON path (skipInvoices:true), which is what the cycle page
// uses to change a wrong planning without touching billing — it short-circuits BEFORE any invoice
// edge call, so it runs end-to-end here. The split-rebalance math is tested directly on
// insertGuestsIntoSlots (it rebalances without any edge call). The invoice-ON path delegates to the
// already-tested syncInvoicesAfterAddPlayer.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { addPlayersToCycle, swapPlayerInCycle } from '@/lib/cycleRoster';
import { insertGuestsIntoSlots } from '@/lib/slotBookingWrite';
import { cancelBookingsAndSync } from '@/lib/bookings';

let db: PGlite;
let supa: SupabaseClient<Database>;

const CYCLE = '11111111-1111-1111-1111-111111111111';
const GA = '20000000-0000-0000-0000-0000000000a0'; // incoming guest
const GB = '20000000-0000-0000-0000-0000000000b0'; // existing guest
const GC = '20000000-0000-0000-0000-0000000000c0'; // filler guest
const PROF = '40000000-0000-0000-0000-0000000000d0'; // a linked-account profile id
const SP = '30000000-0000-0000-0000-0000000000f0'; // PAST session
const S1 = '30000000-0000-0000-0000-000000000010';
const S2 = '30000000-0000-0000-0000-000000000020';

const activeForGuest = async (guest: string): Promise<string[]> =>
  (await db.query<{ slot_id: string }>(
    `SELECT slot_id FROM bookings WHERE guest_player_id = $1 AND status <> 'cancelled' ORDER BY slot_id`,
    [guest],
  )).rows.map((r) => r.slot_id);

const amountOnSlot = async (guest: string, slot: string): Promise<number | null> => {
  const row = (await db.query<{ payment_amount: string | null }>(
    `SELECT payment_amount FROM bookings WHERE guest_player_id = $1 AND slot_id = $2 AND status <> 'cancelled'`,
    [guest, slot],
  )).rows[0];
  return row?.payment_amount == null ? null : Number(row.payment_amount);
};

const totalBookings = async (): Promise<number> =>
  Number((await db.query<{ n: string }>(`SELECT count(*)::text n FROM bookings`)).rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db) as unknown as SupabaseClient<Database>;
  await db.exec(`
    CREATE TABLE cycles (id uuid PRIMARY KEY, split_payment boolean, price_per_session numeric);
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY, cyclus_id uuid, start_time text, end_time text,
      price_per_session numeric, max_participants int
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, guest_player_id uuid, player_id uuid, status text, payment_status text,
      payment_amount numeric, original_amount numeric, discount_amount numeric,
      discount_reason text, paid_externally boolean, notes text
    );
    CREATE TABLE guest_players (id uuid PRIMARY KEY, has_trained boolean);
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings; DELETE FROM availability_slots; DELETE FROM cycles; DELETE FROM guest_players;`);
  await db.exec(`INSERT INTO cycles (id, split_payment, price_per_session) VALUES ('${CYCLE}', false, 20);`);
  // One PAST session + two upcoming — start_time as ISO text (sorts chronologically).
  await db.exec(`INSERT INTO availability_slots (id, cyclus_id, start_time, end_time, price_per_session, max_participants) VALUES
    ('${SP}','${CYCLE}','2020-01-01T10:00:00.000Z','2020-01-01T11:00:00.000Z', 20, 4),
    ('${S1}','${CYCLE}','2999-01-01T10:00:00.000Z','2999-01-01T11:00:00.000Z', 20, 4),
    ('${S2}','${CYCLE}','2999-01-08T10:00:00.000Z','2999-01-08T11:00:00.000Z', 20, 4);`);
  await db.exec(`INSERT INTO guest_players (id, has_trained) VALUES ('${GA}', false), ('${GB}', false), ('${GC}', false);`);
});

describe('addPlayersToCycle (skipInvoices) — all-sessions scope', () => {
  it('books the player into EVERY session of the cycle, past + future, and marks them trained', async () => {
    const res = await addPlayersToCycle({ cycleId: CYCLE, guestPlayerIds: [GA], skipInvoices: true, client: supa });

    expect(res.insertedCount).toBe(3);
    expect(await activeForGuest(GA)).toEqual([SP, S1, S2].sort());
    // not split, single new player → full session price each.
    expect(await amountOnSlot(GA, SP)).toBe(20);
    const trained = (await db.query<{ has_trained: boolean }>(`SELECT has_trained FROM guest_players WHERE id = $1`, [GA])).rows[0];
    expect(trained.has_trained).toBe(true);
  });

  it('skips sessions where the player is already booked (no duplicate)', async () => {
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, paid_externally) VALUES
      ('${S1}','${GA}','confirmed','pending', false);`);

    const res = await addPlayersToCycle({ cycleId: CYCLE, guestPlayerIds: [GA], skipInvoices: true, client: supa });

    expect(res.insertedCount).toBe(2);
    expect(res.alreadyBookedSlotIds).toContain(S1);
    expect(await activeForGuest(GA)).toEqual([SP, S1, S2].sort()); // S1 still single (not doubled)
    const onS1 = (await db.query<{ n: string }>(`SELECT count(*)::text n FROM bookings WHERE slot_id = $1 AND guest_player_id = $2`, [S1, GA])).rows[0];
    expect(Number(onS1.n)).toBe(1);
  });

  it('skips a full session (capacity) and reports it as blocked', async () => {
    await db.exec(`UPDATE availability_slots SET max_participants = 1 WHERE id = '${S2}';`);
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, paid_externally) VALUES
      ('${S2}','${GC}','confirmed','pending', false);`);

    const res = await addPlayersToCycle({ cycleId: CYCLE, guestPlayerIds: [GA], skipInvoices: true, client: supa });

    expect(res.insertedCount).toBe(2);
    expect(res.blockedSlotIds).toContain(S2);
    expect(await activeForGuest(GA)).toEqual([SP, S1].sort());
  });

  it("treats a past 'completed' booking as already-enrolled and does NOT abort the add (M-17 dedup parity)", async () => {
    // 'completed' is in the unique-index status set but NOT the capacity set — the old pre-filter
    // missed it and the whole add would trip the unique index. Now that session is just skipped.
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, paid_externally) VALUES
      ('${SP}','${GA}','completed','pending', false);`);

    const res = await addPlayersToCycle({ cycleId: CYCLE, guestPlayerIds: [GA], skipInvoices: true, client: supa });

    expect(res.insertedCount).toBe(2); // S1 + S2 only
    expect(res.alreadyBookedSlotIds).toContain(SP);
    expect(await activeForGuest(GA)).toEqual([SP, S1, S2].sort()); // SP still the single completed row
  });
});

describe('swapPlayerInCycle (skipInvoices) — in-place reassign across all sessions', () => {
  it('re-points the outgoing player\'s bookings to the incoming guest IN PLACE (no new rows)', async () => {
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, payment_amount, paid_externally) VALUES
      ('${SP}','${GB}','confirmed','pending', 20, false),
      ('${S1}','${GB}','confirmed','pending', 20, false),
      ('${S2}','${GB}','confirmed','pending', 20, false);`);

    const res = await swapPlayerInCycle({ cycleId: CYCLE, fromPlayer: { guestPlayerId: GB }, toGuestPlayerId: GA, skipInvoices: true, client: supa });

    expect(res.error).toBeNull();
    expect(res.reassignedCount).toBe(3);
    expect(res.cancelledCollisionCount).toBe(0);
    expect(await activeForGuest(GB)).toEqual([]);
    expect(await activeForGuest(GA)).toEqual([SP, S1, S2].sort());
    expect(await totalBookings()).toBe(3); // reassigned in place — no remove+add row churn
  });

  it('PRESERVES the non-split payer amount on swap (no €0 session — the key fix)', async () => {
    // GB is the sole payer on S1 at the full €20; GC is a €0 companion.
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, payment_amount, paid_externally) VALUES
      ('${S1}','${GB}','confirmed','pending', 20, false),
      ('${S1}','${GC}','confirmed','pending', 0, false);`);

    await swapPlayerInCycle({ cycleId: CYCLE, fromPlayer: { guestPlayerId: GB }, toGuestPlayerId: GA, skipInvoices: true, client: supa });

    expect(await amountOnSlot(GA, S1)).toBe(20); // incoming player inherits the payer amount
    expect(await amountOnSlot(GC, S1)).toBe(0);  // companion untouched — session still bills €20
  });

  it('cancels the outgoing booking where the incoming guest is already enrolled (collision)', async () => {
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, payment_amount, paid_externally) VALUES
      ('${SP}','${GB}','confirmed','pending', 20, false),
      ('${S1}','${GB}','confirmed','pending', 20, false),
      ('${S1}','${GA}','confirmed','pending', 20, false);`);

    const res = await swapPlayerInCycle({ cycleId: CYCLE, fromPlayer: { guestPlayerId: GB }, toGuestPlayerId: GA, skipInvoices: true, client: supa });

    expect(res.reassignedCount).toBe(1);        // SP re-pointed
    expect(res.cancelledCollisionCount).toBe(1); // GB's redundant S1 booking cancelled
    expect(await activeForGuest(GB)).toEqual([]);
    expect(await activeForGuest(GA)).toEqual([SP, S1].sort());
  });

  it('reports nothing changed when the outgoing player has no bookings', async () => {
    const res = await swapPlayerInCycle({ cycleId: CYCLE, fromPlayer: { guestPlayerId: GB }, toGuestPlayerId: GA, skipInvoices: true, client: supa });
    expect(res.reassignedCount + res.cancelledCollisionCount).toBe(0);
  });

  it('clears a stale player_id when swapping a linked (account-claimed) guest', async () => {
    // GB has claimed their account, so the booking carries BOTH guest_player_id and player_id.
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, player_id, status, payment_status, payment_amount, paid_externally) VALUES
      ('${S1}','${GB}','${PROF}','confirmed','pending', 20, false);`);

    const res = await swapPlayerInCycle({
      cycleId: CYCLE,
      fromPlayer: { playerId: PROF, guestPlayerId: GB }, // roster entry carries both
      toGuestPlayerId: GA,
      skipInvoices: true,
      client: supa,
    });

    expect(res.reassignedCount).toBe(1);
    const row = (await db.query<{ guest_player_id: string | null; player_id: string | null }>(
      `SELECT guest_player_id, player_id FROM bookings WHERE slot_id = '${S1}' AND status <> 'cancelled'`,
    )).rows[0];
    expect(row.guest_player_id).toBe(GA);
    expect(row.player_id).toBeNull(); // stale profile link cleared → seat belongs to GA only
  });
});

describe('cancelBookingsAndSync — 0-row guard (RLS-blocked / phantom-success)', () => {
  it('returns a cancelError when the update changes NO rows (the academy-manager RLS bug symptom)', async () => {
    // No booking with this id exists → the UPDATE matches 0 rows. Before the guard this returned
    // success (no error), letting the UI claim "removed from N sessions" while nothing changed.
    const res = await cancelBookingsAndSync(['90000000-0000-0000-0000-000000000099'], supa, { skipInvoiceSync: true });
    expect(res.cancelError).not.toBeNull();
  });

  it('succeeds when it actually cancels a booking', async () => {
    const id = '70000000-0000-0000-0000-000000000071';
    await db.exec(`INSERT INTO bookings (id, slot_id, guest_player_id, status, payment_status, paid_externally) VALUES
      ('${id}','${S1}','${GB}','confirmed','pending', false);`);
    const res = await cancelBookingsAndSync([id], supa, { skipInvoiceSync: true });
    expect(res.cancelError).toBeNull();
    const row = (await db.query<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [id])).rows[0];
    expect(row.status).toBe('cancelled');
  });
});

describe('insertGuestsIntoSlots — split rebalance math', () => {
  it('splits the session price and rebalances the existing co-occupant', async () => {
    // GB sits alone on S1 at the full €30; adding GA splits it 15/15.
    await db.exec(`UPDATE availability_slots SET price_per_session = 30 WHERE id = '${S1}';`);
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, payment_amount, original_amount, paid_externally) VALUES
      ('${S1}','${GB}','confirmed','pending', 30, 30, false);`);

    const res = await insertGuestsIntoSlots({
      slots: [{ id: S1, start_time: '2999-01-01T10:00:00.000Z', end_time: '2999-01-01T11:00:00.000Z', price_per_session: 30 }],
      guestPlayerIds: [GA],
      splitPayment: true,
      skipRebalance: false,
      resolveSessionPrice: () => 30,
      client: supa,
    });

    expect(res.insertedRows.length).toBe(1);
    expect(await amountOnSlot(GA, S1)).toBe(15); // new player's split share
    expect(await amountOnSlot(GB, S1)).toBe(15); // existing co-occupant rebalanced down
  });

  it('skipRebalance leaves the existing co-occupant amount untouched', async () => {
    await db.exec(`UPDATE availability_slots SET price_per_session = 30 WHERE id = '${S1}';`);
    await db.exec(`INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, payment_amount, original_amount, paid_externally) VALUES
      ('${S1}','${GB}','confirmed','pending', 30, 30, false);`);

    await insertGuestsIntoSlots({
      slots: [{ id: S1, start_time: '2999-01-01T10:00:00.000Z', end_time: '2999-01-01T11:00:00.000Z', price_per_session: 30 }],
      guestPlayerIds: [GA],
      splitPayment: true,
      skipRebalance: true,
      resolveSessionPrice: () => 30,
      client: supa,
    });

    expect(await amountOnSlot(GB, S1)).toBe(30); // untouched — owner reconciles billing manually
  });
});
