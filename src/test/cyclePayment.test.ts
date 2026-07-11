import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Behavioral contract for the cycle online-payment orchestration
 * (Codex foundation-verification, Tier A3): when create-mollie-payment fails
 * AFTER the cycle bookings were inserted, the just-inserted bookings MUST be
 * soft-cancelled so a failed checkout never strands capacity-occupying orphans.
 *
 * The facade is mocked so this asserts the orchestration (does it roll back?),
 * not cancelBookingsAndSync's internals (covered by the booking facade tests).
 */
const cancelBookingsAndSync = vi.fn();
vi.mock('@/lib/bookings', () => ({
  cancelBookingsAndSync: (...args: unknown[]) => cancelBookingsAndSync(...args),
}));

const loggerError = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => loggerError(...args), warn: vi.fn(), info: vi.fn() },
}));

import { initiateCyclePayment } from '@/lib/cyclePayment';

function makeClient(invokeResult: { data: unknown; error: unknown }) {
  return { functions: { invoke: vi.fn().mockResolvedValue(invokeResult) } };
}

const params = {
  bookingIds: ['b1', 'b2'],
  slotId: 's1',
  amount: 30,
  description: 'Cycle (3 sessions)',
  trainerId: 't1',
};

beforeEach(() => {
  cancelBookingsAndSync.mockReset();
  cancelBookingsAndSync.mockResolvedValue({ cancelError: null, syncError: null, declinedClaimCount: 0, paidClaimBookingIds: [] });
  loggerError.mockReset();
});

describe('initiateCyclePayment', () => {
  it('returns the checkout URL, passes the exact booking ids, and does NOT cancel on success', async () => {
    const client = makeClient({ data: { checkoutUrl: 'https://mollie.test/checkout' }, error: null });

    const res = await initiateCyclePayment(params, client as never);

    expect(res.checkoutUrl).toBe('https://mollie.test/checkout');
    expect(client.functions.invoke).toHaveBeenCalledWith('create-mollie-payment', {
      body: { slotId: 's1', amount: 30, description: 'Cycle (3 sessions)', trainerId: 't1', bookingIds: ['b1', 'b2'] },
    });
    expect(cancelBookingsAndSync).not.toHaveBeenCalled();
  });

  it('soft-cancels the just-inserted bookings and rethrows the ORIGINAL error when payment creation fails', async () => {
    const err = { message: 'mollie boom' };
    const client = makeClient({ data: null, error: err });

    await expect(initiateCyclePayment(params, client as never)).rejects.toBe(err);
    expect(cancelBookingsAndSync).toHaveBeenCalledWith(['b1', 'b2'], client);
  });

  it('soft-cancels and throws when the edge function returns no checkout URL', async () => {
    const client = makeClient({ data: {}, error: null });

    await expect(initiateCyclePayment(params, client as never)).rejects.toThrow('No checkout URL received');
    expect(cancelBookingsAndSync).toHaveBeenCalledWith(['b1', 'b2'], client);
  });

  it('rethrows the ORIGINAL payment error (not the cancel error) and logs when the rollback itself fails', async () => {
    const err = { message: 'mollie boom' };
    const client = makeClient({ data: null, error: err });
    cancelBookingsAndSync.mockResolvedValue({ cancelError: { message: 'cancel write failed' }, syncError: null });

    await expect(initiateCyclePayment(params, client as never)).rejects.toBe(err);
    expect(loggerError).toHaveBeenCalled();
  });
});
