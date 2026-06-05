import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeInvoicePayRecipientType,
  normalizeInvoicePayStatus,
  trackInvoicePaymentFailed,
  trackInvoicePaymentRedirect,
  trackInvoicePaymentStarted,
  trackInvoicePayPageLoaded,
  trackInvoicePayPageLoadFailed,
} from './invoicePayTracking';

const trackEventMock = vi.fn();

vi.mock('@/lib/tracking', () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

describe('invoicePayTracking', () => {
  beforeEach(() => {
    trackEventMock.mockClear();
  });

  it('normalizes recipient and status enums', () => {
    expect(normalizeInvoicePayRecipientType('academy')).toBe('academy');
    expect(normalizeInvoicePayRecipientType('trainer')).toBe('trainer');
    expect(normalizeInvoicePayRecipientType(null)).toBe('unknown');
    expect(normalizeInvoicePayStatus('sent')).toBe('sent');
    expect(normalizeInvoicePayStatus('weird')).toBe('unknown');
  });

  it('tracks page loaded without PII fields', () => {
    trackInvoicePayPageLoaded({
      has_mollie_account: true,
      payment_unavailable_reason: 'no_row',
      recipient_type: 'trainer',
      status: 'sent',
    });
    expect(trackEventMock).toHaveBeenCalledWith('invoice_pay_page_loaded', {
      event_category: 'invoice_pay',
      has_mollie_account: true,
      payment_unavailable_reason: 'no_row',
      recipient_type: 'trainer',
      status: 'sent',
    });
    const props = trackEventMock.mock.calls[0][1] as Record<string, unknown>;
    expect(props).not.toHaveProperty('invoice_id');
    expect(props).not.toHaveProperty('email');
    expect(props).not.toHaveProperty('amount');
  });

  it('tracks load failed with error_code only', () => {
    trackInvoicePayPageLoadFailed('not_found');
    expect(trackEventMock).toHaveBeenCalledWith('invoice_pay_page_load_failed', {
      event_category: 'invoice_pay',
      error_code: 'not_found',
    });
  });

  it('tracks payment started, redirect, and failed without PII', () => {
    trackInvoicePaymentStarted({
      has_mollie_account: true,
      recipient_type: 'academy',
      status: 'sent',
    });
    trackInvoicePaymentRedirect({ recipient_type: 'academy', status: 'sent' });
    trackInvoicePaymentFailed('no_mollie_account');

    expect(trackEventMock).toHaveBeenCalledWith('invoice_payment_started', expect.objectContaining({
      event_category: 'invoice_pay',
      has_mollie_account: true,
      recipient_type: 'academy',
      status: 'sent',
    }));
    expect(trackEventMock).toHaveBeenCalledWith('invoice_payment_redirect', expect.objectContaining({
      recipient_type: 'academy',
      status: 'sent',
    }));
    expect(trackEventMock).toHaveBeenCalledWith('invoice_payment_failed', expect.objectContaining({
      error_code: 'no_mollie_account',
    }));

    for (const call of trackEventMock.mock.calls) {
      const props = call[1] as Record<string, unknown>;
      expect(props).not.toHaveProperty('invoice_id');
      expect(props).not.toHaveProperty('public_token');
      expect(props).not.toHaveProperty('invoice_number');
      expect(props).not.toHaveProperty('amount');
    }
  });
});
