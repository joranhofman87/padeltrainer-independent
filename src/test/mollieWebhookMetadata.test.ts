import { describe, it, expect } from 'vitest';
import {
  hasNoRoutableMetadata,
  parseMolliePaymentMetadata,
  usesInvoicePaidBranch,
} from '../../supabase/functions/_shared/mollie-webhook-metadata.ts';

describe('parseMolliePaymentMetadata', () => {
  it('extracts invoice_id only (create-invoice-payment)', () => {
    expect(parseMolliePaymentMetadata({ invoice_id: 'inv-26000422' })).toEqual({
      invoiceId: 'inv-26000422',
      bookingIds: [],
    });
  });

  it('extracts booking_ids from metadata', () => {
    expect(
      parseMolliePaymentMetadata({ booking_ids: ['b1', 'b2'] }),
    ).toEqual({
      invoiceId: null,
      bookingIds: ['b1', 'b2'],
    });
  });

  it('keeps invoice_id when booking_ids are also present', () => {
    expect(
      parseMolliePaymentMetadata({
        invoice_id: 'inv-1',
        booking_ids: ['b1'],
      }),
    ).toEqual({
      invoiceId: 'inv-1',
      bookingIds: ['b1'],
    });
  });
});

describe('usesInvoicePaidBranch', () => {
  it('routes to invoice branch when invoice_id exists', () => {
    expect(usesInvoicePaidBranch('inv-1')).toBe(true);
  });

  it('does not route when invoice_id is missing', () => {
    expect(usesInvoicePaidBranch(null)).toBe(false);
  });
});

describe('hasNoRoutableMetadata', () => {
  it('is true when neither invoice nor bookings', () => {
    expect(hasNoRoutableMetadata(null, [])).toBe(true);
  });

  it('is false when invoice_id exists even with booking_ids', () => {
    expect(hasNoRoutableMetadata('inv-1', ['b1'])).toBe(false);
  });
});
