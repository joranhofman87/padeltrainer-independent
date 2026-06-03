import { describe, it, expect } from 'vitest';
import { resolvePublicInvoiceLoadError } from './publicInvoiceFetch';

describe('resolvePublicInvoiceLoadError', () => {
  it('maps draft_invoice from response body', () => {
    expect(resolvePublicInvoiceLoadError({ error: 'draft_invoice' }, null)).toBe('draft_invoice');
  });

  it('maps 401 to unavailable', () => {
    expect(resolvePublicInvoiceLoadError(null, { context: { status: 401 } })).toBe('unavailable');
  });

  it('maps already_paid', () => {
    expect(resolvePublicInvoiceLoadError({ error: 'already_paid' }, null)).toBe('already_paid');
  });

  it('maps unknown errors to not_found', () => {
    expect(resolvePublicInvoiceLoadError({ error: 'Invoice not found' }, null)).toBe('not_found');
    expect(resolvePublicInvoiceLoadError(null, { context: { status: 500 } })).toBe('not_found');
  });
});
