import { describe, it, expect } from 'vitest';
import { splitAmongPlayersForInvoiceCreate } from './invoiceSplitPricing';

/** Mirrors AddSlotDialog per-player auto-create-invoice body split field. */
function buildAddSlotInvoiceSplitField(
  playerBookingIds: string[],
  insertedBookings: { id: string; payment_amount: number | null }[],
  sessionPrice: number,
  participantCount: number,
): number | undefined {
  const playerBookings = insertedBookings.filter((b) => playerBookingIds.includes(b.id));
  const splitCount = splitAmongPlayersForInvoiceCreate(
    playerBookings.map((b) => ({
      payment_amount: b.payment_amount,
      availability_slots: { price_per_session: sessionPrice },
    })),
    participantCount,
  );
  return splitCount ?? undefined;
}

describe('AddSlotDialog per-player invoice splitAmongPlayers', () => {
  it('omits splitAmongPlayers when payment_amount is already 19 per session', () => {
    const bookingIds = Array.from({ length: 9 }, (_, i) => `b${i}`);
    const inserted = bookingIds.map((id) => ({ id, payment_amount: 19 }));
    expect(
      buildAddSlotInvoiceSplitField(bookingIds, inserted, 76, 4),
    ).toBeUndefined();
  });

  it('includes splitAmongPlayers when payment_amount not set on bookings', () => {
    const inserted = [{ id: 'b1', payment_amount: null }];
    expect(buildAddSlotInvoiceSplitField(['b1'], inserted, 76, 4)).toBe(4);
  });
});
