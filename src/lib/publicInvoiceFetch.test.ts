import { describe, it, expect } from 'vitest';
import {
  isPublicInvoiceDetailPayload,
  resolvePublicInvoiceLoadError,
} from './publicInvoiceFetch';

describe('resolvePublicInvoiceLoadError', () => {
  it('maps draft_invoice from response body', () => {
    expect(resolvePublicInvoiceLoadError({ error: 'draft_invoice' }, null)).toBe('draft_invoice');
  });

  it('maps 401 to unavailable', () => {
    expect(resolvePublicInvoiceLoadError(null, { context: { status: 401 } })).toBe('unavailable');
  });

  it('maps status paid (minimal response)', () => {
    expect(resolvePublicInvoiceLoadError({ status: 'paid' }, null)).toBe('already_paid');
  });

  it('maps status cancelled (minimal response)', () => {
    expect(resolvePublicInvoiceLoadError({ status: 'cancelled' }, null)).toBe('cancelled');
  });

  it('maps legacy already_paid error', () => {
    expect(resolvePublicInvoiceLoadError({ error: 'already_paid' }, null)).toBe('already_paid');
  });

  it('maps unknown errors to not_found', () => {
    expect(resolvePublicInvoiceLoadError({ error: 'Invoice not found' }, null)).toBe('not_found');
    expect(resolvePublicInvoiceLoadError(null, { context: { status: 404 } })).toBe('not_found');
  });

  it('maps 403 invoke error (no body available) to draft_invoice', () => {
    expect(resolvePublicInvoiceLoadError(null, { context: { status: 403 } })).toBe('draft_invoice');
  });

  it('maps 5xx to transient so the page can offer a retry', () => {
    expect(resolvePublicInvoiceLoadError(null, { context: { status: 500 } })).toBe('transient');
    expect(resolvePublicInvoiceLoadError(null, { context: { status: 503 } })).toBe('transient');
    expect(resolvePublicInvoiceLoadError({ error: 'internal' }, { context: { status: 500 } })).toBe('transient');
  });

  it('maps network failures without an HTTP status to transient', () => {
    expect(resolvePublicInvoiceLoadError(null, new TypeError('Failed to fetch'))).toBe('transient');
    expect(resolvePublicInvoiceLoadError(null, { message: 'Failed to send a request to the Edge Function' })).toBe('transient');
  });
});

describe('isPublicInvoiceDetailPayload', () => {
  it('accepts full unpaid invoice payload', () => {
    expect(
      isPublicInvoiceDetailPayload({
        invoice: { id: 'inv-1', invoiceNumber: 'INV-001', status: 'sent' },
        academy: null,
      }),
    ).toBe(true);
  });

  it('rejects minimal paid response', () => {
    expect(isPublicInvoiceDetailPayload({ status: 'paid' })).toBe(false);
  });

  it('rejects minimal cancelled response', () => {
    expect(isPublicInvoiceDetailPayload({ status: 'cancelled' })).toBe(false);
  });
});
