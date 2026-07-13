import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contract for the "Don't update invoices" roster-edit option (default OFF).
 * Asserts the skip flags gate the invoice work without changing the booking
 * write: the player is still added/removed, but no invoice is created/recalced.
 * The invoice helpers are mocked — this tests the gating, not their internals.
 */
const syncInvoicesAfterBookingRemoval = vi.fn();
vi.mock('@/lib/invoiceSync', () => ({
  syncInvoicesAfterBookingRemoval: (...a: unknown[]) => syncInvoicesAfterBookingRemoval(...a),
}));

const applyAffectedInvoiceUpdates = vi.fn();
vi.mock('@/lib/applyAffectedInvoiceUpdates', () => ({
  applyAffectedInvoiceUpdates: (...a: unknown[]) => applyAffectedInvoiceUpdates(...a),
}));

import { cancelBookingsAndSync, cancelPlayerBookingsInCycle } from '@/lib/bookings';
import { syncInvoicesAfterAddPlayer } from '@/lib/invoiceAfterAddPlayer';

// Minimal chainable supabase-shaped builder: every method returns the same
// builder, and awaiting it resolves to `result` (the terminal read).
function makeClient(result: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ['update', 'select', 'in', 'neq', 'eq', 'is', 'insert']) b[m] = vi.fn(() => b);
  (b as { then: (r: (v: unknown) => unknown) => unknown }).then = (resolve) => resolve(result);
  return { from: vi.fn(() => b), builder: b };
}

beforeEach(() => {
  syncInvoicesAfterBookingRemoval.mockReset().mockResolvedValue(undefined);
  applyAffectedInvoiceUpdates.mockReset().mockResolvedValue({
    classification: { draftInvoiceIds: [], sentOrPendingInvoiceIds: [], paidInvoiceIds: [], cancelledInvoiceIds: [] },
    draftsRecalculated: false,
    sentRecalculated: false,
    needsConfirmation: false,
    paidUnchangedCount: 0,
  });
});

describe('cancelBookingsAndSync — skipInvoiceSync', () => {
  it('with skipInvoiceSync: cancels the booking but does NOT sync invoices', async () => {
    const client = makeClient({ data: [{ id: 'b1' }], error: null });
    const res = await cancelBookingsAndSync(['b1'], client as never, { skipInvoiceSync: true });
    expect(res).toEqual({ cancelError: null, syncError: null, declinedClaimCount: 0, paidClaimBookingIds: [] });
    expect(syncInvoicesAfterBookingRemoval).not.toHaveBeenCalled();
  });

  it('without options: syncs invoices (unchanged behaviour)', async () => {
    const client = makeClient({ data: [{ id: 'b1' }], error: null });
    await cancelBookingsAndSync(['b1'], client as never);
    expect(syncInvoicesAfterBookingRemoval).toHaveBeenCalledTimes(1);
    expect(syncInvoicesAfterBookingRemoval).toHaveBeenCalledWith(['b1']);
  });

  it('on cancel error: never reaches the sync (skip irrelevant)', async () => {
    const client = makeClient({ error: { message: 'boom' } });
    const res = await cancelBookingsAndSync(['b1'], client as never);
    expect(res.cancelError).toEqual({ message: 'boom' });
    expect(syncInvoicesAfterBookingRemoval).not.toHaveBeenCalled();
  });
});

describe('cancelPlayerBookingsInCycle — whole-cycle remove', () => {
  it("finds the player's active bookings across the slots and forwards skipInvoiceSync", async () => {
    const client = makeClient({ data: [{ id: 'b1' }, { id: 'b2' }], error: null });
    const res = await cancelPlayerBookingsInCycle(
      ['s1', 's2'],
      { playerId: 'p1' },
      client as never,
      { skipInvoiceSync: true },
    );
    expect(res.cancelledCount).toBe(2);
    expect(res.cancelError).toBeNull();
    expect(syncInvoicesAfterBookingRemoval).not.toHaveBeenCalled();
    // FAM-02 Level 1: a profile person owns only PURE profile rows — the match must scope
    // player_id AND guest_player_id IS NULL, so dual-keyed (linked guest) rows stay untouched.
    expect(client.builder.eq).toHaveBeenCalledWith('player_id', 'p1');
    expect(client.builder.is).toHaveBeenCalledWith('guest_player_id', null);
  });

  it('without skip: still syncs invoices for the removed bookings', async () => {
    const client = makeClient({ data: [{ id: 'b1' }], error: null });
    const res = await cancelPlayerBookingsInCycle(['s1'], { guestPlayerId: 'g1' }, client as never);
    expect(res.cancelledCount).toBe(1);
    expect(syncInvoicesAfterBookingRemoval).toHaveBeenCalledWith(['b1']);
    // A guest person owns EVERY row carrying their guest id (dual rows are theirs) — no is() scope.
    expect(client.builder.eq).toHaveBeenCalledWith('guest_player_id', 'g1');
    expect(client.builder.is).not.toHaveBeenCalled();
  });

  it('a dual-keyed ref resolves to the GUEST person (guest-first)', async () => {
    const client = makeClient({ data: [{ id: 'b1' }], error: null });
    await cancelPlayerBookingsInCycle(['s1'], { playerId: 'p1', guestPlayerId: 'g1' }, client as never);
    expect(client.builder.eq).toHaveBeenCalledWith('guest_player_id', 'g1');
    expect(client.builder.eq).not.toHaveBeenCalledWith('player_id', 'p1');
  });

  it('no matching bookings: clean no-op (no cancel, no sync)', async () => {
    const client = makeClient({ data: [], error: null });
    const res = await cancelPlayerBookingsInCycle(['s1'], { guestPlayerId: 'g1' }, client as never);
    expect(res.cancelledCount).toBe(0);
    expect(syncInvoicesAfterBookingRemoval).not.toHaveBeenCalled();
  });

  it('no player identifier: no-op', async () => {
    const client = makeClient({ data: [{ id: 'b1' }], error: null });
    const res = await cancelPlayerBookingsInCycle(['s1'], {}, client as never);
    expect(res.cancelledCount).toBe(0);
  });
});

describe('syncInvoicesAfterAddPlayer — skipInvoices', () => {
  it('with skipInvoices: no new draft, no recalc (returns the empty result)', async () => {
    const res = await syncInvoicesAfterAddPlayer({
      newBookings: [],
      splitPayment: false,
      slotIds: ['s1'],
      skipInvoices: true,
    });
    expect(applyAffectedInvoiceUpdates).not.toHaveBeenCalled();
    expect(res.created).toBe(0);
    expect(res.needsConfirmation).toBe(false);
  });

  it('without skip: recalcs affected invoices (unchanged behaviour)', async () => {
    await syncInvoicesAfterAddPlayer({ newBookings: [], splitPayment: false, slotIds: ['s1'] });
    expect(applyAffectedInvoiceUpdates).toHaveBeenCalledTimes(1);
    expect(applyAffectedInvoiceUpdates).toHaveBeenCalledWith(['s1'], 'update_drafts_only');
  });
});
