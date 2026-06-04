import { describe, it, expect } from 'vitest';
import {
  isBookingAmountAlreadySplitShare,
  resolveInvoiceUnitPrice,
  bookingsUseSplitShareAmounts,
  splitAmongPlayersForInvoiceCreate,
} from './invoiceSplitPricing';

describe('resolveInvoiceUnitPrice', () => {
  it('returns payment_amount when already split (19, slot 76, split 4)', () => {
    expect(
      resolveInvoiceUnitPrice({ paymentAmount: 19, slotPrice: 76, splitAmongPlayers: 4 }),
    ).toBe(19);
  });

  it('splits slot price when payment_amount is null', () => {
    expect(
      resolveInvoiceUnitPrice({ paymentAmount: null, slotPrice: 76, splitAmongPlayers: 4 }),
    ).toBe(19);
  });

  it('returns full payer amount for non-split', () => {
    expect(
      resolveInvoiceUnitPrice({ paymentAmount: 76, slotPrice: 76, splitAmongPlayers: 1 }),
    ).toBe(76);
  });

  it('returns 0 for zero payment_amount and uses slot split only when null', () => {
    expect(
      resolveInvoiceUnitPrice({ paymentAmount: 0, slotPrice: 76, splitAmongPlayers: 4 }),
    ).toBe(19);
  });

  it('cycle invoice total: 9 sessions × 19 = 171', () => {
    const unit = resolveInvoiceUnitPrice({ paymentAmount: 19, slotPrice: 76, splitAmongPlayers: 4 });
    expect(unit * 9).toBe(171);
  });
});

describe('isBookingAmountAlreadySplitShare', () => {
  it('detects 19 × 4 ≈ 76', () => {
    expect(
      isBookingAmountAlreadySplitShare({ paymentAmount: 19, slotPrice: 76, splitAmongPlayers: 4 }),
    ).toBe(true);
  });

  it('returns false for full slot amount 76', () => {
    expect(
      isBookingAmountAlreadySplitShare({ paymentAmount: 76, slotPrice: 76, splitAmongPlayers: 4 }),
    ).toBe(false);
  });
});

describe('bookingsUseSplitShareAmounts', () => {
  const nineBookings = Array.from({ length: 9 }, () => ({
    payment_amount: 19,
    availability_slots: { price_per_session: 76 },
  }));

  it('true for 9 bookings at 19 with split 4', () => {
    expect(bookingsUseSplitShareAmounts(nineBookings, 4)).toBe(true);
  });

  it('splitAmongPlayersForInvoiceCreate omits split when already split', () => {
    expect(splitAmongPlayersForInvoiceCreate(nineBookings, 4)).toBeNull();
  });

  it('keeps split when payment_amount missing', () => {
    const bookings = [{ payment_amount: null, availability_slots: { price_per_session: 76 } }];
    expect(splitAmongPlayersForInvoiceCreate(bookings, 4)).toBe(4);
  });
});
