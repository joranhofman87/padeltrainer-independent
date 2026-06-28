import { describe, it, expect } from 'vitest';
import { deleteOrCancelInvoices } from '@/lib/invoices';

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
