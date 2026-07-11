import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/invoiceSync', () => ({
  syncInvoicesAfterBookingRemoval: vi.fn(),
}));

import { syncInvoicesAfterBookingRemoval } from '@/lib/invoiceSync';
import { cancelBookingsAndSync, insertBookings, insertBookingSingle } from './bookings';

const syncMock = syncInvoicesAfterBookingRemoval as unknown as ReturnType<typeof vi.fn>;

/** Minimal chainable supabase stub: from(..).update(..).in(..).select(..) → { data, error }. */
function mockClient(updateError: unknown = null, updatedRows: Array<{ id: string }> = [{ id: 'b1' }]) {
  const select = vi.fn().mockResolvedValue({ data: updateError ? null : updatedRows, error: updateError });
  const inFn = vi.fn().mockReturnValue({ select });
  const update = vi.fn().mockReturnValue({ in: inFn });
  const from = vi.fn().mockReturnValue({ update });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, from, update, in: inFn, select };
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
    expect(r).toEqual({ cancelError: null, syncError: null, declinedClaimCount: 0, paidClaimBookingIds: [] });
  });

  it('is a no-op for an empty list (no DB writes, no sync)', async () => {
    const { client, from } = mockClient();
    const r = await cancelBookingsAndSync([], client);
    expect(from).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    expect(r).toEqual({ cancelError: null, syncError: null, declinedClaimCount: 0, paidClaimBookingIds: [] });
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

  it('returns a cancelError (not phantom success) when the update changes 0 rows', async () => {
    // RLS can silently update 0 rows with NO error (the academy-manager bookings bug). The guard
    // must surface this so callers never claim "removed from N sessions" while nothing changed.
    const { client } = mockClient(null, []); // no error, but zero rows updated
    const r = await cancelBookingsAndSync(['b1'], client);
    expect(syncMock).not.toHaveBeenCalled();
    expect(r.cancelError).toBeInstanceOf(Error);
    expect(r.syncError).toBeNull();
  });
});

/**
 * Characterization test for the booking-insert write point. Pins the table +
 * rows passed through, the `.select(returning)`-only-when-asked behaviour, and
 * the `{ data, error }` (error coerced to null) shape — so the surfaces routed
 * through it stay behaviour-frozen.
 */
function mockInsertClient(opts: { error?: unknown; data?: unknown } = {}) {
  const calls = { table: null as string | null, rows: null as unknown, select: null as string | null };
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        insert(rows: unknown) {
          calls.rows = rows;
          const settle = () => Promise.resolve({ error: opts.error ?? null });
          return {
            select(cols: string) {
              calls.select = cols;
              return Promise.resolve({ data: opts.data ?? null, error: opts.error ?? null });
            },
            then(onF: (v: { error: unknown }) => unknown, onR?: (e: unknown) => unknown) {
              return settle().then(onF, onR);
            },
          };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

describe('insertBookings', () => {
  it('inserts the given rows into bookings (array, no returning → plain insert)', async () => {
    const { client, calls } = mockInsertClient();
    const rows = [{ slot_id: 's', guest_player_id: 'g', status: 'confirmed' }];
    const res = await insertBookings(rows, client);
    expect(calls.table).toBe('bookings');
    expect(calls.rows).toEqual(rows);
    expect(calls.select).toBeNull();
    expect(res).toEqual({ data: null, error: null });
  });

  it('accepts a single-object row the same as an array', async () => {
    const { client, calls } = mockInsertClient();
    const row = { slot_id: 's', player_id: 'p', status: 'confirmed', payment_amount: 25 };
    await insertBookings(row, client);
    expect(calls.rows).toEqual(row);
  });

  it('returns the inserted rows when `returning` is given', async () => {
    const inserted = [{ id: 'b1' }, { id: 'b2' }];
    const { client, calls } = mockInsertClient({ data: inserted });
    const res = await insertBookings([{ slot_id: 's' }], client, 'id');
    expect(calls.select).toBe('id');
    expect(res.data).toEqual(inserted);
    expect(res.error).toBeNull();
  });

  it('surfaces the insert error (and coerces undefined → null)', async () => {
    const err = { message: 'capacity full', code: 'P0001' };
    const res = await insertBookings([{ slot_id: 's' }], mockInsertClient({ error: err }).client);
    expect(res.error).toBe(err);
  });
});

/** insert(row).select(returning).single() stub for the single-row writer. */
function mockSingleClient(opts: { error?: unknown; data?: unknown } = {}) {
  const calls = { table: null as string | null, row: null as unknown, select: null as string | null, single: false };
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        insert(row: unknown) {
          calls.row = row;
          return {
            select(cols: string) {
              calls.select = cols;
              return {
                single() {
                  calls.single = true;
                  return Promise.resolve({ data: opts.data ?? null, error: opts.error ?? null });
                },
              };
            },
          };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

describe('insertBookingSingle', () => {
  it('inserts one row via .select(returning).single() — defaults returning to "*"', async () => {
    const inserted = { id: 'b1', slot_id: 's' };
    const { client, calls } = mockSingleClient({ data: inserted });
    const row = { slot_id: 's', player_id: 'p', status: 'confirmed' };
    const res = await insertBookingSingle(row, client);
    expect(calls.table).toBe('bookings');
    expect(calls.row).toEqual(row);
    expect(calls.select).toBe('*'); // bare .select() default
    expect(calls.single).toBe(true);
    expect(res).toEqual({ data: inserted, error: null });
  });

  it('honours an explicit returning projection', async () => {
    const { client, calls } = mockSingleClient({ data: { id: 'b1' } });
    await insertBookingSingle({ slot_id: 's' }, client, 'id');
    expect(calls.select).toBe('id');
  });

  it('surfaces the insert error (coerced to null otherwise)', async () => {
    const err = { message: 'denied', code: '42501' };
    const res = await insertBookingSingle({ slot_id: 's' }, mockSingleClient({ error: err }).client);
    expect(res.error).toBe(err);
  });
});
