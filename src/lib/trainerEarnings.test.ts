import { describe, it, expect } from 'vitest';
import { bookingReceivedAmount, isReceivedPayment, sumReceivedInRange } from './trainerEarnings';

const inMonth = '2026-06-15T10:00:00Z';
const lastMonth = '2026-05-15T10:00:00Z';
const start = new Date('2026-06-01T00:00:00Z');
const end = new Date('2026-06-30T23:59:59Z');

describe('bookingReceivedAmount', () => {
  it('uses payment_amount when present', () => {
    expect(bookingReceivedAmount({ payment_amount: 42 })).toBe(42);
  });
  it('falls back to slot price_per_session', () => {
    expect(bookingReceivedAmount({ payment_amount: null, availability_slots: { price_per_session: 30 } })).toBe(30);
  });
  it('falls back to a flat price_per_session field', () => {
    expect(bookingReceivedAmount({ price_per_session: 25 })).toBe(25);
  });
  it('returns 0 when nothing is set', () => {
    expect(bookingReceivedAmount({})).toBe(0);
  });
});

describe('isReceivedPayment', () => {
  it('true only when paid and paid_at present', () => {
    expect(isReceivedPayment({ payment_status: 'paid', paid_at: inMonth })).toBe(true);
    expect(isReceivedPayment({ payment_status: 'paid', paid_at: null })).toBe(false);
    expect(isReceivedPayment({ payment_status: 'pending', paid_at: inMonth })).toBe(false);
  });
});

describe('sumReceivedInRange', () => {
  it('sums only paid bookings with paid_at inside the range; no fee', () => {
    const bookings = [
      { payment_status: 'paid', paid_at: inMonth, payment_amount: 50 },       // in
      { payment_status: 'paid', paid_at: inMonth, payment_amount: null, availability_slots: { price_per_session: 30 } }, // in, fallback
      { payment_status: 'paid', paid_at: lastMonth, payment_amount: 99 },     // out of range
      { payment_status: 'pending', paid_at: inMonth, payment_amount: 80 },    // not received
      { payment_status: 'paid', paid_at: null, payment_amount: 80 },          // no paid_at
    ];
    expect(sumReceivedInRange(bookings, start, end)).toBe(80); // 50 + 30, gross (no ×0.9)
  });

  it('counts a paid booking regardless of session status (money received model)', () => {
    // No `status` field at all — earnings is keyed on payment, not completion.
    expect(sumReceivedInRange([{ payment_status: 'paid', paid_at: inMonth, payment_amount: 20 }], start, end)).toBe(20);
  });
});
