import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renumberDraftInvoices } from './renumberDraftInvoices';
import { allocateInvoiceNumber, formatInvoiceNumber } from './invoiceNumber';

type DraftRow = { id: string; invoice_number: string | null };

let selectResult: { data: DraftRow[] | null; error: { message: string } | null };
let selectFilters: Array<[string, unknown]> = [];
let updateCalls: Array<{ payload: Record<string, unknown>; id: unknown }> = [];
let updateResults: Array<{ error: unknown }> = [];

function selectChain() {
  const chain = {
    eq: (col: string, val: unknown) => {
      selectFilters.push([col, val]);
      return chain;
    },
    order: () => chain,
    then: (
      onFulfilled: (v: typeof selectResult) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(selectResult).then(onFulfilled, onRejected),
  };
  return chain;
}

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => selectChain(),
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          updateCalls.push({ payload, id });
          return Promise.resolve(updateResults.shift() ?? { error: null });
        },
      }),
    }),
  },
}));

// Keep the real formatInvoiceNumber / isInvoiceNumberCollision; only the
// RPC-backed allocator is replaced.
vi.mock('@/lib/invoiceNumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invoiceNumber')>();
  return { ...actual, allocateInvoiceNumber: vi.fn() };
});

const allocateMock = vi.mocked(allocateInvoiceNumber);

function stubAllocator(startSequence: number) {
  let seq = startSequence;
  allocateMock.mockImplementation(async ({ prefix, includeYear }) => {
    const sequence = seq++;
    return {
      sequence,
      invoiceNumber: formatInvoiceNumber(prefix, new Date().getFullYear(), sequence, includeYear),
    };
  });
}

const collisionError = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "unique_invoice_number_per_trainer"',
};

beforeEach(() => {
  selectResult = { data: [], error: null };
  selectFilters = [];
  updateCalls = [];
  updateResults = [];
  allocateMock.mockReset();
});

describe('renumberDraftInvoices', () => {
  it('only targets draft invoices in the owner scope', async () => {
    selectResult = { data: [], error: null };
    await renumberDraftInvoices({
      ownerType: 'academy',
      ownerId: 'acad-1',
      prefix: 'INV',
      includeYear: true,
    });
    expect(selectFilters).toEqual([
      ['academy_profile_id', 'acad-1'],
      ['status', 'draft'],
    ]);
  });

  it('renumbers each draft via the atomic allocator and resets pdf_url + render_path', async () => {
    selectResult = {
      data: [
        { id: 'a', invoice_number: 'INV-2026-0001' },
        { id: 'b', invoice_number: 'INV-2026-0002' },
      ],
      error: null,
    };
    stubAllocator(51);

    const result = await renumberDraftInvoices({
      ownerType: 'trainer',
      ownerId: 'tr-1',
      prefix: 'INV',
      includeYear: true,
    });

    const year = new Date().getFullYear();
    expect(updateCalls).toEqual([
      { payload: { invoice_number: `INV-${year}-0051`, pdf_url: null, render_path: null }, id: 'a' },
      { payload: { invoice_number: `INV-${year}-0052`, pdf_url: null, render_path: null }, id: 'b' },
    ]);
    expect(result.updated).toBe(2);
    expect(result.failures).toEqual([]);
    // Counter mirror = last allocated sequence + 1; no manual counter write.
    expect(result.nextNumber).toBe(53);
  });

  it('retries with a fresh allocation on a number collision', async () => {
    selectResult = { data: [{ id: 'a', invoice_number: null }], error: null };
    stubAllocator(10);
    updateResults = [{ error: collisionError }, { error: null }];

    const result = await renumberDraftInvoices({
      ownerType: 'trainer',
      ownerId: 'tr-1',
      prefix: '',
      includeYear: false,
    });

    expect(allocateMock).toHaveBeenCalledTimes(2);
    expect(result.updated).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.nextNumber).toBe(12);
  });

  it('collects per-row failures and keeps processing remaining drafts', async () => {
    selectResult = {
      data: [
        { id: 'a', invoice_number: 'INV-0001' },
        { id: 'b', invoice_number: 'INV-0002' },
      ],
      error: null,
    };
    stubAllocator(5);
    updateResults = [{ error: { message: 'row is locked' } }, { error: null }];

    const result = await renumberDraftInvoices({
      ownerType: 'trainer',
      ownerId: 'tr-1',
      prefix: 'INV',
      includeYear: false,
    });

    expect(result.updated).toBe(1);
    expect(result.failures).toEqual([
      { invoiceId: 'a', invoiceNumber: 'INV-0001', message: 'row is locked' },
    ]);
    expect(updateCalls[1].id).toBe('b');
  });

  it('gives up on a draft after repeated collisions and reports it', async () => {
    selectResult = { data: [{ id: 'a', invoice_number: 'INV-0001' }], error: null };
    stubAllocator(1);
    updateResults = [
      { error: collisionError },
      { error: collisionError },
      { error: collisionError },
    ];

    const result = await renumberDraftInvoices({
      ownerType: 'trainer',
      ownerId: 'tr-1',
      prefix: 'INV',
      includeYear: false,
    });

    expect(allocateMock).toHaveBeenCalledTimes(3);
    expect(result.updated).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].invoiceId).toBe('a');
  });

  it('returns the fetch error without touching rows', async () => {
    selectResult = { data: null, error: { message: 'network down' } };

    const result = await renumberDraftInvoices({
      ownerType: 'academy',
      ownerId: 'acad-1',
      prefix: 'INV',
      includeYear: true,
    });

    expect(result).toEqual({ updated: 0, failures: [], nextNumber: null, error: 'network down' });
    expect(updateCalls).toEqual([]);
    expect(allocateMock).not.toHaveBeenCalled();
  });

  it('reports nothing to do when there are no drafts', async () => {
    selectResult = { data: [], error: null };

    const result = await renumberDraftInvoices({
      ownerType: 'trainer',
      ownerId: 'tr-1',
      prefix: 'INV',
      includeYear: true,
    });

    expect(result).toEqual({ updated: 0, failures: [], nextNumber: null });
    expect(allocateMock).not.toHaveBeenCalled();
  });
});
