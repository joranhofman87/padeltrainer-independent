import { describe, expect, it, vi, beforeEach } from 'vitest';

type QueryResult = { data: unknown; error: unknown };

// --- Mock state ---------------------------------------------------------
// fetchInvoiceState reads (invoices select → maybeSingle), consumed in order.
let invoiceStateResults: QueryResult[] = [];
// List queries on invoices (select → overlaps, awaited directly).
let invoicesListResult: QueryResult = { data: [], error: null };
// Bookings select results, consumed in order.
let bookingsResults: QueryResult[] = [];
// Cycles settings read.
let cyclesResult: QueryResult = { data: null, error: null };
// Guarded updates: payload + filters recorded, results consumed in order.
let updateCalls: Array<{
  payload: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}> = [];
let updateResults: QueryResult[] = [];
let invokeCalls: Array<{ name: string; body: unknown }> = [];

interface SelectChain {
  eq: (col: string, val: unknown) => SelectChain;
  in: (col: string, vals: unknown) => SelectChain;
  overlaps: (col: string, vals: unknown) => SelectChain;
  maybeSingle: () => Promise<QueryResult>;
  then: (
    onFulfilled: (v: QueryResult) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise<unknown>;
}

function makeSelectChain(table: string): SelectChain {
  const listResult = (): QueryResult => {
    if (table === 'invoices') return invoicesListResult;
    if (table === 'bookings') {
      return bookingsResults.shift() ?? { data: [], error: null };
    }
    return { data: [], error: null };
  };
  const singleResult = (): QueryResult => {
    if (table === 'invoices') {
      return invoiceStateResults.shift() ?? { data: null, error: null };
    }
    if (table === 'cycles') return cyclesResult;
    return { data: null, error: null };
  };
  const chain: SelectChain = {
    eq: () => chain,
    in: () => chain,
    overlaps: () => chain,
    maybeSingle: () => Promise.resolve(singleResult()),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(listResult()).then(onFulfilled, onRejected),
  };
  return chain;
}

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => makeSelectChain(table),
      update: (payload: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return chain;
          },
          select: () => {
            updateCalls.push({ payload, filters });
            return Promise.resolve(updateResults.shift() ?? { data: [], error: null });
          },
        };
        return chain;
      },
    }),
    functions: {
      invoke: (name: string, options: { body: unknown }) => {
        invokeCalls.push({ name, body: options.body });
        return Promise.resolve({ data: null, error: null });
      },
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  hasExplicitPaymentAmount,
  resolveFinalBookingPrices,
  recalculateInvoiceAfterRemoval,
  syncInvoicesAfterBookingRemoval,
} from './invoiceSync';

function invoiceStateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    booking_ids: ['b1', 'b2'],
    vat_rate: 21,
    line_items: [{ description: 'Cyclus (2 weken)' }],
    status: 'draft',
    updated_at: '2026-06-01T10:00:00.000000+00:00',
    ...overrides,
  };
}

function bookingRow(
  id: string,
  paymentAmount: number | null,
  slotPrice: number | null,
  cyclusId: string | null = 'cyc-1',
) {
  return {
    id,
    payment_amount: paymentAmount,
    availability_slots: {
      price_per_session: slotPrice,
      cyclus_id: cyclusId,
      cyclus_name: cyclusId ? 'Zomercyclus' : null,
      start_time: '2026-06-08T09:00:00+00:00',
      locations: { name: 'Baan 1' },
      prices_include_vat: true,
      extra_costs: null,
    },
  };
}

beforeEach(() => {
  invoiceStateResults = [];
  invoicesListResult = { data: [], error: null };
  bookingsResults = [];
  cyclesResult = { data: null, error: null };
  updateCalls = [];
  updateResults = [];
  invokeCalls = [];
});

// --- M-21: explicit payment_amount is never re-divided -------------------

describe('resolveFinalBookingPrices', () => {
  it('keeps explicit payment_amount untouched regardless of split count', () => {
    expect(
      resolveFinalBookingPrices([{ paymentAmount: 25, slotPrice: 100 }], 4),
    ).toEqual([25]);
  });

  it('divides only the slot-price fallback by the split count', () => {
    expect(
      resolveFinalBookingPrices([{ paymentAmount: null, slotPrice: 40 }], 4),
    ).toEqual([10]);
  });

  it('decides per booking: mixed explicit/fallback with equal raw prices', () => {
    // Pre-fix, the collective allHaveExplicitAmount check divided BOTH.
    expect(
      resolveFinalBookingPrices(
        [
          { paymentAmount: 40, slotPrice: 40 },
          { paymentAmount: null, slotPrice: 40 },
        ],
        2,
      ),
    ).toEqual([40, 20]);
  });

  it('treats payment_amount of 0 as absent and falls back to slot price', () => {
    expect(
      resolveFinalBookingPrices([{ paymentAmount: 0, slotPrice: 30 }], 2),
    ).toEqual([15]);
  });

  it('does not divide anything when there is no split', () => {
    expect(
      resolveFinalBookingPrices(
        [
          { paymentAmount: 25, slotPrice: 40 },
          { paymentAmount: null, slotPrice: 40 },
        ],
        1,
      ),
    ).toEqual([25, 40]);
  });

  it('rounds divided fallback prices to 2 decimals', () => {
    expect(
      resolveFinalBookingPrices([{ paymentAmount: null, slotPrice: 100 }], 3),
    ).toEqual([33.33]);
  });
});

describe('hasExplicitPaymentAmount', () => {
  it('requires a positive payment_amount', () => {
    expect(hasExplicitPaymentAmount({ paymentAmount: 12.5, slotPrice: null })).toBe(true);
    expect(hasExplicitPaymentAmount({ paymentAmount: 0, slotPrice: 40 })).toBe(false);
    expect(hasExplicitPaymentAmount({ paymentAmount: null, slotPrice: 40 })).toBe(false);
    expect(hasExplicitPaymentAmount({ paymentAmount: undefined, slotPrice: 40 })).toBe(false);
  });
});

describe('recalculateInvoiceAfterRemoval — line item rebuild (M-21)', () => {
  it('consolidates identical explicit split shares without re-dividing them', async () => {
    invoiceStateResults = [
      {
        data: invoiceStateRow({
          booking_ids: ['b1', 'b2', 'b3'],
          line_items: [{ description: 'Zomercyclus (3 weken) (1/2)' }],
        }),
        error: null,
      },
    ];
    bookingsResults = [
      { data: [bookingRow('b1', 25, 50), bookingRow('b2', 25, 50)], error: null },
    ];
    updateResults = [{ data: [{ id: 'inv-1' }], error: null }];

    const outcome = await recalculateInvoiceAfterRemoval({ id: 'inv-1' }, ['b3']);

    expect(outcome).toBe('updated');
    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0].payload;
    expect(payload.booking_ids).toEqual(['b1', 'b2']);
    const lineItems = payload.line_items as Array<{
      description: string;
      quantity: number;
      unit_price: number;
    }>;
    expect(lineItems).toHaveLength(1);
    // payment_amount (25) is already the per-player share — NOT 12.50
    expect(lineItems[0].unit_price).toBe(25);
    expect(lineItems[0].quantity).toBe(2);
    expect(lineItems[0].description).toContain('(1/2)');
    expect(payload.total).toBe(50);
  });

  it('splits mixed explicit/fallback bookings into per-session items with correct prices', async () => {
    invoiceStateResults = [
      {
        data: invoiceStateRow({
          booking_ids: ['b1', 'b2'],
          line_items: [{ description: 'Zomercyclus (2 weken) (1/2)' }],
        }),
        error: null,
      },
    ];
    // Explicit 40 (full price agreed for this player) + fallback slot price 40.
    bookingsResults = [
      { data: [bookingRow('b1', 40, 40), bookingRow('b2', null, 40)], error: null },
    ];
    updateResults = [{ data: [{ id: 'inv-1' }], error: null }];

    const outcome = await recalculateInvoiceAfterRemoval({ id: 'inv-1' }, []);

    expect(outcome).toBe('updated');
    const lineItems = updateCalls[0].payload.line_items as Array<{
      unit_price: number;
    }>;
    expect(lineItems.map((li) => li.unit_price)).toEqual([40, 20]);
  });

  it('cancels the invoice when all bookings are removed', async () => {
    invoiceStateResults = [
      { data: invoiceStateRow({ booking_ids: ['b1'] }), error: null },
    ];
    updateResults = [{ data: [{ id: 'inv-1' }], error: null }];

    const outcome = await recalculateInvoiceAfterRemoval({ id: 'inv-1' }, ['b1']);

    expect(outcome).toBe('cancelled');
    expect(updateCalls[0].payload.status).toBe('cancelled');
    expect(updateCalls[0].payload.total).toBe(0);
    expect(updateCalls[0].payload.booking_ids).toEqual([]);
  });
});

// --- M-36: optimistic concurrency + error propagation --------------------

describe('recalculateInvoiceAfterRemoval — optimistic concurrency (M-36)', () => {
  it('guards the update with the previously-read updated_at', async () => {
    invoiceStateResults = [
      { data: invoiceStateRow({ updated_at: 'T1' }), error: null },
    ];
    bookingsResults = [{ data: [bookingRow('b1', 30, 30)], error: null }];
    updateResults = [{ data: [{ id: 'inv-1' }], error: null }];

    await recalculateInvoiceAfterRemoval({ id: 'inv-1' }, ['b2']);

    expect(updateCalls[0].filters).toEqual([
      ['id', 'inv-1'],
      ['updated_at', 'T1'],
    ]);
  });

  it('re-reads and retries once when the guard matches zero rows', async () => {
    invoiceStateResults = [
      { data: invoiceStateRow({ updated_at: 'T1' }), error: null },
      { data: invoiceStateRow({ updated_at: 'T2' }), error: null },
    ];
    bookingsResults = [
      { data: [bookingRow('b1', 30, 30)], error: null },
      { data: [bookingRow('b1', 30, 30)], error: null },
    ];
    // First update loses the race (0 rows), second succeeds.
    updateResults = [
      { data: [], error: null },
      { data: [{ id: 'inv-1' }], error: null },
    ];

    const outcome = await recalculateInvoiceAfterRemoval({ id: 'inv-1' }, ['b2']);

    expect(outcome).toBe('updated');
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[1].filters).toEqual([
      ['id', 'inv-1'],
      ['updated_at', 'T2'],
    ]);
    // PDF regenerated only after the successful write
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].name).toBe('generate-invoice');
  });

  it('throws after a second consecutive conflict', async () => {
    invoiceStateResults = [
      { data: invoiceStateRow({ updated_at: 'T1' }), error: null },
      { data: invoiceStateRow({ updated_at: 'T2' }), error: null },
    ];
    bookingsResults = [
      { data: [bookingRow('b1', 30, 30)], error: null },
      { data: [bookingRow('b1', 30, 30)], error: null },
    ];
    updateResults = [
      { data: [], error: null },
      { data: [], error: null },
    ];

    await expect(
      recalculateInvoiceAfterRemoval({ id: 'inv-1' }, ['b2']),
    ).rejects.toThrow(/modified concurrently/);
    expect(invokeCalls).toHaveLength(0);
  });

  it('propagates update errors instead of swallowing them', async () => {
    invoiceStateResults = [{ data: invoiceStateRow(), error: null }];
    bookingsResults = [{ data: [bookingRow('b1', 30, 30)], error: null }];
    updateResults = [{ data: null, error: new Error('row level security') }];

    await expect(
      recalculateInvoiceAfterRemoval({ id: 'inv-1' }, ['b2']),
    ).rejects.toThrow('row level security');
  });

  it('skips without writing when the invoice became paid', async () => {
    invoiceStateResults = [
      { data: invoiceStateRow({ status: 'paid' }), error: null },
    ];

    const outcome = await recalculateInvoiceAfterRemoval({ id: 'inv-1' }, ['b1']);

    expect(outcome).toBe('skipped');
    expect(updateCalls).toHaveLength(0);
  });

  it('is a noop when the invoice no longer exists', async () => {
    invoiceStateResults = [{ data: null, error: null }];

    const outcome = await recalculateInvoiceAfterRemoval({ id: 'inv-1' }, ['b1']);

    expect(outcome).toBe('noop');
    expect(updateCalls).toHaveLength(0);
  });
});

// --- M-28: paid-invoice skip is loud --------------------------------------

describe('syncInvoicesAfterBookingRemoval — paid invoices (M-28)', () => {
  it('returns paid invoice numbers instead of silently ignoring them', async () => {
    invoicesListResult = {
      data: [
        {
          id: 'inv-paid',
          invoice_number: 'INV-2026-001',
          status: 'paid',
          booking_ids: ['b1'],
        },
        {
          id: 'inv-draft',
          invoice_number: 'INV-2026-002',
          status: 'draft',
          booking_ids: ['b1', 'b2'],
        },
      ],
      error: null,
    };
    invoiceStateResults = [
      {
        data: invoiceStateRow({ id: 'inv-draft', booking_ids: ['b1', 'b2'] }),
        error: null,
      },
    ];
    bookingsResults = [{ data: [bookingRow('b2', 20, 40)], error: null }];
    updateResults = [{ data: [{ id: 'inv-draft' }], error: null }];

    const result = await syncInvoicesAfterBookingRemoval(['b1']);

    expect(result.skippedPaidInvoiceNumbers).toEqual(['INV-2026-001']);
    // The unpaid invoice was still recalculated
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.booking_ids).toEqual(['b2']);
  });

  it('reports an invoice that became paid between the list query and the write', async () => {
    invoicesListResult = {
      data: [
        {
          id: 'inv-1',
          invoice_number: 'INV-2026-003',
          status: 'sent',
          booking_ids: ['b1'],
        },
      ],
      error: null,
    };
    // Fresh read inside the recalc sees it paid.
    invoiceStateResults = [
      { data: invoiceStateRow({ status: 'paid', booking_ids: ['b1'] }), error: null },
    ];

    const result = await syncInvoicesAfterBookingRemoval(['b1']);

    expect(result.skippedPaidInvoiceNumbers).toEqual(['INV-2026-003']);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns an empty result for no removed bookings', async () => {
    const result = await syncInvoicesAfterBookingRemoval([]);
    expect(result.skippedPaidInvoiceNumbers).toEqual([]);
  });

  it('propagates the invoices query error', async () => {
    invoicesListResult = { data: null, error: new Error('connection lost') };

    await expect(syncInvoicesAfterBookingRemoval(['b1'])).rejects.toThrow(
      'connection lost',
    );
  });
});
