import { describe, it, expect } from 'vitest';
import {
  canSharePublicPaymentLink,
  getMissingInvoiceSettingsFields,
  isDraftInvoiceStatus,
  isInvoiceSettingsComplete,
} from './invoiceSettingsComplete';

describe('invoiceSettingsComplete', () => {
  it('detects missing required fields', () => {
    expect(getMissingInvoiceSettingsFields({ business_name: 'Academy', business_address: '', kvk_number: '123', iban: 'NL00' })).toEqual([
      'business_address',
    ]);
    expect(isInvoiceSettingsComplete({ business_name: 'A', business_address: 'B', kvk_number: '1', iban: 'NL00' })).toBe(true);
  });

  it('does not allow public link for draft invoices', () => {
    expect(
      canSharePublicPaymentLink({
        status: 'draft',
        sent_at: null,
        public_token: 'token-uuid',
      }),
    ).toBe(false);
  });

  it('allows public link for sent invoices with token', () => {
    expect(
      canSharePublicPaymentLink({
        status: 'sent',
        sent_at: '2026-01-02T00:00:00Z',
        public_token: 'token-uuid',
      }),
    ).toBe(true);
  });

  it('rejects share when token missing', () => {
    expect(
      canSharePublicPaymentLink({
        status: 'sent',
        sent_at: '2026-01-02T00:00:00Z',
        public_token: null,
      }),
    ).toBe(false);
  });

  it('identifies draft status', () => {
    expect(isDraftInvoiceStatus('draft')).toBe(true);
    expect(isDraftInvoiceStatus('sent')).toBe(false);
  });
});
