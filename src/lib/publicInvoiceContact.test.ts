import { describe, it, expect } from 'vitest';
import { resolvePublicInvoiceContactEmail } from './publicInvoiceContact';

describe('resolvePublicInvoiceContactEmail', () => {
  it('uses invoice_reply_to_email when present', () => {
    expect(
      resolvePublicInvoiceContactEmail({
        invoiceReplyToEmail: 'info@rlpadelperformance.nl',
        contactEmail: 'info@renelindenbergh.nl',
      }),
    ).toBe('info@rlpadelperformance.nl');
  });

  it('falls back to contact_email when invoice_reply_to_email is missing', () => {
    expect(
      resolvePublicInvoiceContactEmail({
        invoiceReplyToEmail: null,
        contactEmail: 'info@renelindenbergh.nl',
      }),
    ).toBe('info@renelindenbergh.nl');
  });

  it('falls back to contact_email when invoice_reply_to_email is empty', () => {
    expect(
      resolvePublicInvoiceContactEmail({
        invoiceReplyToEmail: '   ',
        contactEmail: 'info@renelindenbergh.nl',
      }),
    ).toBe('info@renelindenbergh.nl');
  });

  it('returns null when academy is null', () => {
    expect(resolvePublicInvoiceContactEmail(null)).toBeNull();
  });

  it('returns null when both emails are empty', () => {
    expect(
      resolvePublicInvoiceContactEmail({
        invoiceReplyToEmail: null,
        contactEmail: null,
      }),
    ).toBeNull();
  });
});
