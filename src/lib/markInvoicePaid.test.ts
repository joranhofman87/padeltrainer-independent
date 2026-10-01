import { describe, it, expect, vi } from 'vitest';
import { requestManualInvoiceSettlement } from './markInvoicePaid';

/**
 * ABC-23 §4. These assert the property that matters at this boundary: the browser no longer
 * settles anything. It asks one server function, and it never reports success unless the server
 * says the settlement happened.
 */
type InvokeResult = { data: unknown; error: { message: string } | null };

const clientWith = (result: InvokeResult) => {
  const invoke = vi.fn().mockResolvedValue(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal client seam
  return { client: { functions: { invoke } } as any, invoke };
};

describe('requestManualInvoiceSettlement', () => {
  it('sends only the invoice id — never a booking list the browser chose', async () => {
    const { client, invoke } = clientWith({ data: { settled: true, invoicePaid: true }, error: null });
    await requestManualInvoiceSettlement('inv1', client);
    expect(invoke).toHaveBeenCalledWith('settle-invoice-manual', { body: { invoiceId: 'inv1' } });
    // the covered set is derived server-side from the stored invoice
    expect(JSON.stringify(invoke.mock.calls[0][1])).not.toContain('booking');
  });

  it('reports success only when the server settled', async () => {
    const { client } = clientWith({ data: { settled: true, invoicePaid: true, paidNoSeat: [] }, error: null });
    expect(await requestManualInvoiceSettlement('inv1', client)).toEqual({
      error: null, invoicePaid: true, paidNoSeat: [],
    });
  });

  it('a cancelled invoice is a blocked refusal, not an error and not a success', async () => {
    const { client } = clientWith({
      data: { settled: false, refusalReason: 'invoice_cancelled' },
      error: { message: 'Conflict' },
    });
    const r = await requestManualInvoiceSettlement('inv1', client);
    expect(r).toEqual({ error: null, blockedCancelled: true, invoicePaid: false });
  });

  it('a refusal is NEVER reported as paid', async () => {
    const { client } = clientWith({
      data: { settled: false, refusalReason: 'invoice_has_bookings' },
      error: { message: 'Conflict' },
    });
    const r = await requestManualInvoiceSettlement('inv1', client);
    expect(r.invoicePaid).toBe(false);
    expect(r.error?.message).toBe('invoice_has_bookings');
  });

  it('a transport failure is an error, not a silent success', async () => {
    const { client } = clientWith({ data: null, error: { message: 'network down' } });
    const r = await requestManualInvoiceSettlement('inv1', client);
    expect(r.invoicePaid).toBe(false);
    expect(r.error?.message).toBe('network down');
  });

  it('an empty 200 body is not treated as settled', async () => {
    const { client } = clientWith({ data: {}, error: null });
    const r = await requestManualInvoiceSettlement('inv1', client);
    expect(r.invoicePaid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('surfaces paid_no_seat so the UI can report money without a seat', async () => {
    const { client } = clientWith({
      data: { settled: true, invoicePaid: true, paidNoSeat: ['b9'] }, error: null,
    });
    expect((await requestManualInvoiceSettlement('inv1', client)).paidNoSeat).toEqual(['b9']);
  });
});
