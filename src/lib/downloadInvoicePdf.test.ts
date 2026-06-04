import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

describe('downloadInvoicePdf (authenticated path)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    global.fetch = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it('uses generate-invoice, not get-public-invoice', async () => {
    invokeMock.mockResolvedValue({
      data: { pdfUrl: 'https://example.com/invoice.pdf' },
      error: null,
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['pdf'])),
    });

    const { downloadInvoicePdf } = await import('./downloadInvoicePdf');
    const ok = await downloadInvoicePdf('inv-uuid', 'INV-100');

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe('generate-invoice');
    expect(invokeMock.mock.calls[0][1]).toEqual({ body: { invoiceId: 'inv-uuid' } });
  });
});
