import { describe, it, expect, vi } from 'vitest';
import { markInvoicePaidAndSyncBookings } from './markInvoicePaid';

type Result = { data?: unknown; error: unknown };

function makeClient(opts: { invoice?: Result; booking?: { error: unknown } } = {}) {
  const invoiceResult: Result = opts.invoice ?? { data: [{ id: 'inv1' }], error: null };
  const bookingResult = opts.booking ?? { error: null };
  const invoiceSelect = vi.fn().mockResolvedValue(invoiceResult);
  const bookingIn = vi.fn(() => {
    const chain: { neq: ReturnType<typeof vi.fn>; then: (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => Promise<unknown> } = {
      neq: vi.fn(() => chain),
      then: (r, j) => Promise.resolve(bookingResult).then(r, j),
    };
    return chain;
  });
  const from = vi.fn((table: string) => {
    if (table === 'invoices') {
      return { update: vi.fn(() => ({ eq: () => ({ neq: () => ({ select: invoiceSelect }) }) })) };
    }
    if (table === 'bookings') {
      return { update: vi.fn(() => ({ in: bookingIn })) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { client: { from } as never, bookingIn };
}

describe('markInvoicePaidAndSyncBookings', () => {
  it('marks the invoice paid and syncs bookings to paid+confirmed', async () => {
    const { client, bookingIn } = makeClient();
    const r = await markInvoicePaidAndSyncBookings('inv1', ['b1', 'b2'], client);
    expect(r.error).toBeNull();
    expect(r.invoicePaid).toBe(true);
    expect(bookingIn).toHaveBeenCalledWith('id', ['b1', 'b2']);
  });

  it('blocks a cancelled invoice and does not touch bookings', async () => {
    const { client, bookingIn } = makeClient({ invoice: { data: [], error: null } });
    const r = await markInvoicePaidAndSyncBookings('inv1', ['b1'], client);
    expect(r.blockedCancelled).toBe(true);
    expect(r.invoicePaid).toBe(false);
    expect(bookingIn).not.toHaveBeenCalled();
  });

  it('reports invoicePaid=true when only the booking sync fails', async () => {
    const { client } = makeClient({ booking: { error: { message: 'boom' } } });
    const r = await markInvoicePaidAndSyncBookings('inv1', ['b1'], client);
    expect(r.invoicePaid).toBe(true);
    expect(r.error).toBeInstanceOf(Error);
  });

  it('skips the booking update when there are no booking ids', async () => {
    const { client, bookingIn } = makeClient();
    const r = await markInvoicePaidAndSyncBookings('inv1', [], client);
    expect(r.error).toBeNull();
    expect(r.invoicePaid).toBe(true);
    expect(bookingIn).not.toHaveBeenCalled();
  });

  it('returns invoicePaid=false when the invoice update errors', async () => {
    const { client, bookingIn } = makeClient({ invoice: { data: null, error: { message: 'db' } } });
    const r = await markInvoicePaidAndSyncBookings('inv1', ['b1'], client);
    expect(r.error).toBeInstanceOf(Error);
    expect(r.invoicePaid).toBe(false);
    expect(bookingIn).not.toHaveBeenCalled();
  });
});
