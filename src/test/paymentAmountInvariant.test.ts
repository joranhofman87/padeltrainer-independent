import { describe, it, expect } from 'vitest';
import {
  bookingSumTolerance,
  bookingSumMatches,
  evaluateInvoicePayment,
} from '../../supabase/functions/_shared/mollie-webhook-payment.ts';

/**
 * Invariant #5 (PAYMENT_INVARIANTS.md): the paid amount must equal the invoice total OR the sum of
 * per-booking payment_amounts, within a rounding tolerance — otherwise the webhook must NOT mark paid.
 * The booking-branch multi-booking tolerance was previously inline + untested; it's now
 * bookingSumTolerance() so it can be locked here.
 */
describe('payment amount-match invariant (#5)', () => {
  it('booking sum tolerance scales with the booking count (½ct/booking, floor 1ct)', () => {
    expect(bookingSumTolerance(1)).toBeCloseTo(0.01, 10);
    expect(bookingSumTolerance(3)).toBeCloseTo(0.03, 10);
    expect(bookingSumTolerance(12)).toBeCloseTo(0.12, 10);
    // Never below a cent even for a 0-booking edge input.
    expect(bookingSumTolerance(0)).toBeCloseTo(0.01, 10);
  });

  it('a multi-session cyclus tolerates cent-level distribution rounding but rejects a real mismatch', () => {
    // 3 bookings, total €30.00, per-booking rounding can drift up to ~3ct.
    expect(bookingSumMatches(30.0, 30.02, 3)).toBe(true); // 2ct drift, within 3ct → accepted
    expect(bookingSumMatches(30.0, 29.98, 3)).toBe(true); // 2ct drift, within 3ct → accepted
    expect(bookingSumMatches(30.0, 30.05, 3)).toBe(false); // 5ct drift → BLOCKED
    expect(bookingSumMatches(30.0, 27.0, 3)).toBe(false); // €3 short → BLOCKED
  });

  it('a single booking uses a strict 1ct tolerance', () => {
    expect(bookingSumMatches(50.0, 50.009, 1)).toBe(true); // sub-cent rounding ok
    expect(bookingSumMatches(50.0, 50.02, 1)).toBe(false); // 2ct → BLOCKED
    expect(bookingSumMatches(50.0, 1.0, 1)).toBe(false); // gross mismatch → BLOCKED
  });

  it('invoice branch: exact/rounding match marks paid; a mismatch blocks; already-paid is a no-notify duplicate', () => {
    expect(evaluateInvoicePayment(50, 50, false)).toEqual({ amountMismatch: false, markPaid: true, notify: true });
    expect(evaluateInvoicePayment(50, 50.009, false).markPaid).toBe(true); // sub-cent
    expect(evaluateInvoicePayment(50, 1, false)).toEqual({ amountMismatch: true, markPaid: false, notify: false });
    expect(evaluateInvoicePayment(50, 50, true)).toEqual({ amountMismatch: false, markPaid: true, notify: false }); // duplicate → no re-notify
    // No comparable total (0/NaN) → the check is skipped (never falsely blocks).
    expect(evaluateInvoicePayment(0, 50, false).amountMismatch).toBe(false);
    expect(evaluateInvoicePayment(Number.NaN, 50, false).amountMismatch).toBe(false);
  });
});
