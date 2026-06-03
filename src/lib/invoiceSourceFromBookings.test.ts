import { describe, it, expect } from 'vitest';
import {
  resolveInvoiceSourceFromBookings,
  TRAINING_CYCLE_FALLBACK_LABEL,
  type InvoiceSourceBookingRow,
} from './invoiceSourceFromBookings';

function booking(
  id: string,
  slot: NonNullable<InvoiceSourceBookingRow['availability_slots']>,
): InvoiceSourceBookingRow {
  return { id, slot_id: typeof slot === 'object' && !Array.isArray(slot) ? slot.id : 's', availability_slots: slot };
}

describe('resolveInvoiceSourceFromBookings', () => {
  it('returns none for empty bookings', () => {
    expect(resolveInvoiceSourceFromBookings([])).toEqual({ kind: 'none' });
  });

  it('resolves single shared cyclus as cycle', () => {
    const result = resolveInvoiceSourceFromBookings([
      booking('b1', { id: 's1', cyclus_id: 'cyc-1', cyclus_name: 'Spring Block', start_time: '2026-03-01T10:00:00Z' }),
      booking('b2', { id: 's2', cyclus_id: 'cyc-1', cyclus_name: 'Spring Block', start_time: '2026-03-08T10:00:00Z' }),
    ]);
    expect(result).toEqual({ kind: 'cycle', cyclusId: 'cyc-1', label: 'Spring Block' });
  });

  it('uses training cycle fallback when cyclus_name missing', () => {
    const result = resolveInvoiceSourceFromBookings([
      booking('b1', { id: 's1', cyclus_id: 'cyc-1', cyclus_name: null, start_time: '2026-03-01T10:00:00Z' }),
    ]);
    expect(result).toMatchObject({ kind: 'cycle', cyclusId: 'cyc-1', label: TRAINING_CYCLE_FALLBACK_LABEL });
  });

  it('resolves single slot without shared cyclus as session', () => {
    const result = resolveInvoiceSourceFromBookings([
      booking('b1', { id: 'slot-a', cyclus_id: null, cyclus_name: null, start_time: '2026-04-15T14:30:00Z' }),
    ]);
    expect(result).toEqual({
      kind: 'session',
      slotId: 'slot-a',
      startTime: '2026-04-15T14:30:00Z',
      label: TRAINING_CYCLE_FALLBACK_LABEL,
    });
  });

  it('resolves multiple unrelated slots', () => {
    const result = resolveInvoiceSourceFromBookings([
      booking('b1', { id: 's1', cyclus_id: 'c1', cyclus_name: 'A', start_time: '2026-01-01T10:00:00Z' }),
      booking('b2', { id: 's2', cyclus_id: 'c2', cyclus_name: 'B', start_time: '2026-01-02T10:00:00Z' }),
    ]);
    expect(result).toEqual({ kind: 'multiple', sessionCount: 2 });
  });
});
