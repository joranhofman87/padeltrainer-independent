import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mockSessionStorage, mockSignupLocalStorage } from '@/test/signupPageFreeze';
import {
  bucketInvoiceCount,
  trackInvoiceClaimEvent,
  trackInvoiceClaimStarted,
  trackInvoiceClaimSignupStarted,
  trackInvoiceClaimOutcome,
} from './invoiceClaimTracking';
import { SIGNUP_CLAIM_SOURCE_STORAGE_KEY } from './signupClaimFlow';

const trackEventMock = vi.fn();

vi.mock('@/lib/tracking', () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

describe('invoiceClaimTracking', () => {
  beforeEach(() => {
    trackEventMock.mockClear();
    mockSessionStorage();
    mockSignupLocalStorage();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('bucketInvoiceCount maps counts safely', () => {
    expect(bucketInvoiceCount(0)).toBe('0');
    expect(bucketInvoiceCount(1)).toBe('1');
    expect(bucketInvoiceCount(5)).toBe('2_plus');
  });

  it('trackInvoiceClaimStarted sends no PII fields', () => {
    trackInvoiceClaimStarted();
    expect(trackEventMock).toHaveBeenCalledWith('invoice_claim_started', {
      event_category: 'invoice_claim',
      flow: 'paid_invoice',
      redirect_target: 'player_invoices',
      entry: 'paid_public_invoice',
    });
    const props = trackEventMock.mock.calls[0][1] as Record<string, unknown>;
    expect(props).not.toHaveProperty('email');
    expect(props).not.toHaveProperty('token');
    expect(props).not.toHaveProperty('invoice_id');
  });

  it('dedupes events within the same session', () => {
    trackInvoiceClaimStarted();
    trackInvoiceClaimStarted();
    expect(trackEventMock).toHaveBeenCalledTimes(1);
  });

  it('trackInvoiceClaimSignupStarted only fires in claim flow', () => {
    trackInvoiceClaimSignupStarted(true);
    expect(trackEventMock).not.toHaveBeenCalled();

    localStorage.setItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY, 'paid_invoice');
    trackInvoiceClaimSignupStarted(true);
    expect(trackEventMock).toHaveBeenCalledWith(
      'invoice_claim_signup_started',
      expect.objectContaining({
        entry: 'signup_page',
        has_redirect: true,
      }),
    );
  });

  it('trackInvoiceClaimOutcome fires linked vs empty events', () => {
    localStorage.setItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY, 'paid_invoice');

    trackInvoiceClaimOutcome(2);
    expect(trackEventMock).toHaveBeenCalledWith(
      'invoice_claim_linked_invoices_found',
      expect.objectContaining({ invoice_count_bucket: '2_plus' }),
    );

    trackEventMock.mockClear();
    sessionStorage.clear();

    trackInvoiceClaimOutcome(0);
    expect(trackEventMock).toHaveBeenCalledWith(
      'invoice_claim_no_invoices_found',
      expect.objectContaining({ invoice_count_bucket: '0' }),
    );
  });

  it('trackInvoiceClaimEvent respects force option', () => {
    trackInvoiceClaimEvent('invoice_claim_started', { entry: 'paid_public_invoice' });
    trackInvoiceClaimEvent('invoice_claim_started', { entry: 'paid_public_invoice' }, { force: true });
    expect(trackEventMock).toHaveBeenCalledTimes(2);
  });
});
