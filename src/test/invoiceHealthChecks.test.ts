import { describe, it, expect } from 'vitest';
import {
  formatAnomalySlackDetails,
  formatAnomalySlackLine,
  isAllBookingsPaidMismatch,
  pushAnomaly,
  type InvoiceAnomaly,
} from '../../supabase/functions/_shared/invoice-health-checks.ts';

describe('isAllBookingsPaidMismatch', () => {
  it('returns false when booking_ids empty', () => {
    expect(isAllBookingsPaidMismatch([], [{ id: 'b1', payment_status: 'paid' }])).toBe(false);
    expect(isAllBookingsPaidMismatch(null, [{ id: 'b1', payment_status: 'paid' }])).toBe(false);
  });

  it('returns false when not all bookings returned', () => {
    expect(
      isAllBookingsPaidMismatch(['b1', 'b2'], [{ id: 'b1', payment_status: 'paid' }]),
    ).toBe(false);
  });

  it('returns false when any booking is not paid', () => {
    expect(
      isAllBookingsPaidMismatch(
        ['b1', 'b2'],
        [
          { id: 'b1', payment_status: 'paid' },
          { id: 'b2', payment_status: 'pending' },
        ],
      ),
    ).toBe(false);
  });

  it('returns true when all linked bookings are paid', () => {
    expect(
      isAllBookingsPaidMismatch(
        ['b1', 'b2'],
        [
          { id: 'b1', payment_status: 'paid' },
          { id: 'b2', payment_status: 'paid' },
        ],
      ),
    ).toBe(true);
  });
});

describe('anomaly formatting', () => {
  it('pushAnomaly adds ids and invoice numbers without PII fields', () => {
    const anomalies: InvoiceAnomaly[] = [];
    pushAnomaly(anomalies, 'mollie_payment_stuck', [
      { id: 'uuid-1', invoice_number: 'INV-2025-001' },
      { id: 'uuid-2', invoice_number: 'INV-2025-002' },
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].check).toBe('mollie_payment_stuck');
    expect(anomalies[0].count).toBe(2);
    expect(anomalies[0].ids).toEqual(['uuid-1', 'uuid-2']);
    expect(anomalies[0].numbers).toEqual(['INV-2025-001', 'INV-2025-002']);
  });

  it('formatAnomalySlackLine includes check, count, ids, and numbers', () => {
    const line = formatAnomalySlackLine({
      check: 'paid_missing_paid_at',
      count: 1,
      ids: ['abc'],
      numbers: ['INV-9'],
    });
    expect(line).toContain('paid_missing_paid_at: 1');
    expect(line).toContain('ids=abc');
    expect(line).toContain('numbers=INV-9');
  });

  it('formatAnomalySlackDetails joins multiple checks', () => {
    const details = formatAnomalySlackDetails([
      {
        check: 'sent_missing_sent_at',
        count: 2,
        ids: ['a', 'b'],
        numbers: ['N1', 'N2'],
      },
      {
        check: 'bookings_paid_invoice_unpaid',
        count: 1,
        ids: ['c'],
        numbers: ['N3'],
      },
    ]);
    expect(details).toContain('sent_missing_sent_at');
    expect(details).toContain('bookings_paid_invoice_unpaid');
  });
});
