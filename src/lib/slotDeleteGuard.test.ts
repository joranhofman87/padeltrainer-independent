import { describe, it, expect, vi, beforeEach } from 'vitest';

// cancelBookingsAndDeleteSlots orchestrates: cancel active bookings → delete slots (RPC) → split
// resync. The booking-cancel + split-resync are mocked (tested elsewhere); this pins the ordering,
// the skip-invoices gating, and the returned counts.
const mocks = vi.hoisted(() => ({
  bookingRows: [] as { id: string }[],
  rpcResult: { data: [{ deleted_count: 0, protected_count: 0, protected_slot_ids: [] }], error: null } as unknown,
  cancelBookingsAndSync: vi.fn(),
  syncSplitCountForCycle: vi.fn(),
}));

vi.mock('@/lib/bookings', () => ({
  cancelBookingsAndSync: (...a: unknown[]) => mocks.cancelBookingsAndSync(...a),
}));
vi.mock('@/lib/invoiceSync', () => ({
  syncSplitCountForCycle: (...a: unknown[]) => mocks.syncSplitCountForCycle(...a),
}));
vi.mock('@/lib/supabaseClient', () => {
  // Chainable builder: from('bookings').select('id').in(..).in(..) resolves to { data, error }.
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.in = vi.fn(() => builder);
  (builder as { then: (r: (v: unknown) => unknown) => unknown }).then = (resolve) =>
    resolve({ data: mocks.bookingRows, error: null });
  return { supabase: { from: vi.fn(() => builder), rpc: vi.fn(async () => mocks.rpcResult) } };
});

import { cancelBookingsAndDeleteSlots } from '@/lib/slotDeleteGuard';

beforeEach(() => {
  mocks.bookingRows = [];
  mocks.rpcResult = { data: [{ deleted_count: 1, protected_count: 0, protected_slot_ids: [] }], error: null };
  mocks.cancelBookingsAndSync.mockReset().mockResolvedValue({ cancelError: null, syncError: null });
  mocks.syncSplitCountForCycle.mockReset().mockResolvedValue(undefined);
});

describe('cancelBookingsAndDeleteSlots', () => {
  it('cancels the slot\'s bookings (invoices ON), then deletes, then resyncs the split', async () => {
    mocks.bookingRows = [{ id: 'b1' }, { id: 'b2' }];

    const res = await cancelBookingsAndDeleteSlots('cyc1', ['s1'], { skipInvoices: false });

    // cancel first, with skipInvoiceSync=false (invoices follow)
    expect(mocks.cancelBookingsAndSync).toHaveBeenCalledWith(['b1', 'b2'], expect.anything(), { skipInvoiceSync: false, declineClaims: true });
    // split resync runs (deletedCount > 0, not skipping)
    expect(mocks.syncSplitCountForCycle).toHaveBeenCalledWith('cyc1');
    expect(res.cancelledBookings).toBe(2);
    expect(res.deletedCount).toBe(1);
    expect(res.syncError).toBeNull();
  });

  it('skipInvoices=true: cancels without invoice sync AND skips the split resync', async () => {
    mocks.bookingRows = [{ id: 'b1' }];

    const res = await cancelBookingsAndDeleteSlots('cyc1', ['s1'], { skipInvoices: true });

    expect(mocks.cancelBookingsAndSync).toHaveBeenCalledWith(['b1'], expect.anything(), { skipInvoiceSync: true, declineClaims: true });
    expect(mocks.syncSplitCountForCycle).not.toHaveBeenCalled();
    expect(res.cancelledBookings).toBe(1);
  });

  it('empty session (no bookings): no cancel call, still deletes', async () => {
    mocks.bookingRows = [];

    const res = await cancelBookingsAndDeleteSlots('cyc1', ['s1'], { skipInvoices: false });

    expect(mocks.cancelBookingsAndSync).not.toHaveBeenCalled();
    expect(res.cancelledBookings).toBe(0);
    expect(res.deletedCount).toBe(1);
  });

  it('empty slotIds: no-op', async () => {
    const res = await cancelBookingsAndDeleteSlots('cyc1', []);
    expect(res.deletedCount).toBe(0);
    expect(res.cancelledBookings).toBe(0);
    expect(mocks.cancelBookingsAndSync).not.toHaveBeenCalled();
  });
});
