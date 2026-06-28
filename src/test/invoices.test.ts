import { describe, it, expect } from 'vitest';
import {
  deleteOrCancelInvoices,
  markInvoicesSent,
  revertInvoicesToDraft,
  setInvoicesDueDate,
} from '@/lib/invoices';

/**
 * Characterization + invariant test for the invoice delete/cancel facade
 * (Codex mutation-boundary Finding 3, the one real P1 move). Pins the exact
 * delete-vs-cancel partition the six duplicated handlers implemented, and proves
 * the load-bearing money invariant: a non-draft (esp. PAID) invoice is NEVER
 * hard-deleted — it is soft-cancelled.
 */
function makeClient(opts: { deleteError?: unknown; cancelError?: unknown } = {}) {
  const calls = { deletedIds: [] as string[], cancelledIds: [] as string[], updateData: null as unknown };
  const client = {
    from() {
      return {
        delete() {
          return {
            in: (_col: string, ids: string[]) => {
              calls.deletedIds.push(...ids);
              return Promise.resolve({ error: opts.deleteError ?? null });
            },
          };
        },
        update(data: unknown) {
          calls.updateData = data;
          return {
            in: (_col: string, ids: string[]) => {
              calls.cancelledIds.push(...ids);
              return Promise.resolve({ error: opts.cancelError ?? null });
            },
          };
        },
      };
    },
  };
  return { client: client as never, calls };
}

describe('deleteOrCancelInvoices', () => {
  it('partitions: drafts are DELETED, every other status is soft-cancelled', async () => {
    const { client, calls } = makeClient();
    const res = await deleteOrCancelInvoices(
      [
        { id: 'd', status: 'draft' },
        { id: 's', status: 'sent' },
        { id: 'o', status: 'overdue' },
        { id: 'p', status: 'paid' },
        { id: 'c', status: 'cancelled' },
      ],
      client,
    );

    expect(res.deletedIds).toEqual(['d']);
    expect(res.cancelledIds).toEqual(['s', 'o', 'p', 'c']);
    expect(calls.deletedIds).toEqual(['d']);
    expect(calls.cancelledIds).toEqual(['s', 'o', 'p', 'c']);
    expect(calls.updateData).toEqual({ status: 'cancelled' });
  });

  it('INVARIANT: a paid (non-draft) invoice is never hard-deleted — it is cancelled', async () => {
    const { client, calls } = makeClient();
    const res = await deleteOrCancelInvoices([{ id: 'paid1', status: 'paid' }], client);

    expect(calls.deletedIds).toEqual([]); // nothing deleted
    expect(calls.cancelledIds).toEqual(['paid1']);
    expect(res.deletedIds).toEqual([]);
    expect(res.cancelledIds).toEqual(['paid1']);
  });

  it('all-drafts → only a DELETE, no cancel UPDATE', async () => {
    const { client, calls } = makeClient();
    await deleteOrCancelInvoices([{ id: 'a', status: 'draft' }, { id: 'b', status: 'draft' }], client);
    expect(calls.deletedIds).toEqual(['a', 'b']);
    expect(calls.cancelledIds).toEqual([]);
    expect(calls.updateData).toBeNull();
  });

  it('surfaces delete vs cancel errors separately', async () => {
    const delErr = { message: 'delete boom' };
    const r1 = await deleteOrCancelInvoices([{ id: 'd', status: 'draft' }], makeClient({ deleteError: delErr }).client);
    expect(r1.deleteError).toBe(delErr);
    expect(r1.cancelError).toBeNull();

    const cancErr = { message: 'cancel boom' };
    const r2 = await deleteOrCancelInvoices([{ id: 'p', status: 'paid' }], makeClient({ cancelError: cancErr }).client);
    expect(r2.cancelError).toBe(cancErr);
    expect(r2.deleteError).toBeNull();
  });

  it('empty list is a no-op', async () => {
    const { client, calls } = makeClient();
    const res = await deleteOrCancelInvoices([], client);
    expect(res).toEqual({ deletedIds: [], cancelledIds: [], deleteError: null, cancelError: null });
    expect(calls.deletedIds).toEqual([]);
    expect(calls.cancelledIds).toEqual([]);
  });
});

/**
 * Characterization + invariant tests for the invoice STATUS facade (mark-sent /
 * revert-to-draft / set-due-date) — the three write transitions that were
 * duplicated byte-for-byte across the trainer + academy list pages. Pins the
 * exact emitted payloads (so a facade move stays behaviour-frozen) and the
 * load-bearing money invariant: reverting a PAID invoice to draft is refused.
 */
function makeStatusClient(opts: { updateError?: unknown } = {}) {
  const calls = {
    updateData: null as unknown,
    inIds: [] as string[],
    neq: null as { col: string; val: unknown } | null,
  };
  const settle = () => Promise.resolve({ error: opts.updateError ?? null });
  const client = {
    from() {
      return {
        update(data: unknown) {
          calls.updateData = data;
          return {
            in(_col: string, ids: string[]) {
              calls.inIds.push(...ids);
              // The terminal `.in(...)` is awaitable for mark-sent / due-date,
              // and ALSO exposes `.neq(...)` for the revert-to-draft guard.
              return {
                neq(col: string, val: unknown) {
                  calls.neq = { col, val };
                  return settle();
                },
                then(onF: (v: { error: unknown }) => unknown, onR?: (e: unknown) => unknown) {
                  return settle().then(onF, onR);
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as never, calls };
}

describe('markInvoicesSent', () => {
  it('stamps sent_at + status="sent" filtered by the given ids', async () => {
    const { client, calls } = makeStatusClient();
    const res = await markInvoicesSent(['a', 'b'], client);
    expect(res.error).toBeNull();
    expect(calls.inIds).toEqual(['a', 'b']);
    expect(calls.updateData).toEqual({ sent_at: expect.any(String), status: 'sent' });
    // sent_at is a real ISO timestamp
    expect(() => new Date((calls.updateData as { sent_at: string }).sent_at).toISOString()).not.toThrow();
  });

  it('single send passes one id', async () => {
    const { client, calls } = makeStatusClient();
    await markInvoicesSent(['only'], client);
    expect(calls.inIds).toEqual(['only']);
  });

  it('empty list is a no-op (no write)', async () => {
    const { client, calls } = makeStatusClient();
    const res = await markInvoicesSent([], client);
    expect(res.error).toBeNull();
    expect(calls.updateData).toBeNull();
    expect(calls.inIds).toEqual([]);
  });

  it('surfaces the update error', async () => {
    const err = { message: 'boom' };
    const res = await markInvoicesSent(['a'], makeStatusClient({ updateError: err }).client);
    expect(res.error).toBe(err);
  });
});

describe('revertInvoicesToDraft', () => {
  it('resets non-paid to draft (clears sent_at + paid_at) with the .neq paid guard', async () => {
    const { client, calls } = makeStatusClient();
    const res = await revertInvoicesToDraft(
      [
        { id: 's', status: 'sent' },
        { id: 'o', status: 'overdue' },
        { id: 'c', status: 'cancelled' },
      ],
      client,
    );
    expect(res.revertedIds).toEqual(['s', 'o', 'c']);
    expect(res.skippedPaidIds).toEqual([]);
    expect(res.error).toBeNull();
    expect(calls.updateData).toEqual({ status: 'draft', sent_at: null, paid_at: null });
    expect(calls.inIds).toEqual(['s', 'o', 'c']);
    expect(calls.neq).toEqual({ col: 'status', val: 'paid' });
  });

  it('INVARIANT: a paid invoice is skipped, never reset — its paid_at survives', async () => {
    const { client, calls } = makeStatusClient();
    const res = await revertInvoicesToDraft(
      [{ id: 's', status: 'sent' }, { id: 'p', status: 'paid' }],
      client,
    );
    expect(res.revertedIds).toEqual(['s']);
    expect(res.skippedPaidIds).toEqual(['p']);
    expect(calls.inIds).toEqual(['s']); // the paid id never reaches the write
  });

  it('all-paid → no write, returns the skipped ids', async () => {
    const { client, calls } = makeStatusClient();
    const res = await revertInvoicesToDraft([{ id: 'p1', status: 'paid' }, { id: 'p2', status: 'paid' }], client);
    expect(res.revertedIds).toEqual([]);
    expect(res.skippedPaidIds).toEqual(['p1', 'p2']);
    expect(calls.updateData).toBeNull();
  });

  it('surfaces the update error', async () => {
    const err = { message: 'boom' };
    const res = await revertInvoicesToDraft([{ id: 's', status: 'sent' }], makeStatusClient({ updateError: err }).client);
    expect(res.error).toBe(err);
  });
});

describe('setInvoicesDueDate', () => {
  it('writes due_date filtered by the given ids', async () => {
    const { client, calls } = makeStatusClient();
    const res = await setInvoicesDueDate(['a', 'b'], '2026-07-01', client);
    expect(res.error).toBeNull();
    expect(calls.updateData).toEqual({ due_date: '2026-07-01' });
    expect(calls.inIds).toEqual(['a', 'b']);
  });

  it('empty list is a no-op', async () => {
    const { client, calls } = makeStatusClient();
    const res = await setInvoicesDueDate([], '2026-07-01', client);
    expect(res.error).toBeNull();
    expect(calls.updateData).toBeNull();
  });
});
