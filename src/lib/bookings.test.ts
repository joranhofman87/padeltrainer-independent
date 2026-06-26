import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/invoiceSync', () => ({
  syncInvoicesAfterBookingRemoval: vi.fn(),
}));

import { syncInvoicesAfterBookingRemoval } from '@/lib/invoiceSync';
import { cancelBookingsAndSync } from './bookings';

const syncMock = syncInvoicesAfterBookingRemoval as unknown as ReturnType<typeof vi.fn>;

/** Minimal chainable supabase stub: from(..).update(..).in(..) → { error }. */
function mockClient(updateError: unknown = null) {
  const inFn = vi.fn().mockResolvedValue({ error: updateError });
  const update = vi.fn().mockReturnValue({ in: inFn });
  const from = vi.fn().mockReturnValue({ update });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, from, update, in: inFn };
}

describe('cancelBookingsAndSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('soft-cancels the bookings (status=cancelled) then reconciles their invoices', async () => {
    syncMock.mockResolvedValue({ skippedPaidInvoiceNumbers: [] });
    const { client, from, update, in: inFn } = mockClient();

    const r = await cancelBookingsAndSync(['b1', 'b2'], client);

    expect(from).toHaveBeenCalledWith('bookings');
    expect(update).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(inFn).toHaveBeenCalledWith('id', ['b1', 'b2']);
    expect(syncMock).toHaveBeenCalledWith(['b1', 'b2']);
    // Ordering: the cancel MUST commit before the invoice sync.
    expect(inFn.mock.invocationCallOrder[0]).toBeLessThan(syncMock.mock.invocationCallOrder[0]);
    expect(r).toEqual({ cancelError: null, syncError: null });
  });

  it('is a no-op for an empty list (no DB writes, no sync)', async () => {
    const { client, from } = mockClient();
    const r = await cancelBookingsAndSync([], client);
    expect(from).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    expect(r).toEqual({ cancelError: null, syncError: null });
  });

  it('returns the raw cancelError and does NOT touch invoices when the cancel fails', async () => {
    const err = { message: 'permission denied', code: '42501' };
    const { client } = mockClient(err);

    const r = await cancelBookingsAndSync(['b1'], client);

    expect(syncMock).not.toHaveBeenCalled();
    expect(r.cancelError).toBe(err); // returned raw for getFriendlyErrorMessage
    expect(r.syncError).toBeNull();
  });

  it('surfaces syncError separately when reconciliation throws (cancel already committed)', async () => {
    syncMock.mockRejectedValue(new Error('boom'));
    const { client } = mockClient();

    const r = await cancelBookingsAndSync(['b1'], client);

    expect(r.cancelError).toBeNull();
    expect(r.syncError).toBeInstanceOf(Error);
    expect((r.syncError as Error).message).toBe('boom');
  });
});
