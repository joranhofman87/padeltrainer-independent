import { describe, it, expect } from 'vitest';
import {
  evaluateInvoicePayment,
  shouldRunBookingPaidSideEffects,
} from '../../supabase/functions/_shared/mollie-webhook-payment.ts';

describe('evaluateInvoicePayment', () => {
  it('marks paid and notifies on first transition when amount matches', () => {
    expect(evaluateInvoicePayment(50, 50, false)).toEqual({
      amountMismatch: false,
      markPaid: true,
      notify: true,
    });
  });

  it('tolerates sub-cent rounding differences', () => {
    expect(evaluateInvoicePayment(50.0, 50.009, false)).toEqual({
      amountMismatch: false,
      markPaid: true,
      notify: true,
    });
  });

  it('BLOCKS marking paid when the paid amount does not match the invoice total', () => {
    expect(evaluateInvoicePayment(50, 1, false)).toEqual({
      amountMismatch: true,
      markPaid: false,
      notify: false,
    });
  });

  it('does not re-notify when the invoice was already paid (duplicate webhook)', () => {
    expect(evaluateInvoicePayment(50, 50, true)).toEqual({
      amountMismatch: false,
      markPaid: true,
      notify: false,
    });
  });

  it('skips the amount check when no comparable total exists', () => {
    expect(evaluateInvoicePayment(0, 50, false)).toEqual({
      amountMismatch: false,
      markPaid: true,
      notify: true,
    });
    expect(evaluateInvoicePayment(Number.NaN, 50, false).amountMismatch).toBe(false);
  });
});

describe('shouldRunBookingPaidSideEffects', () => {
  it('runs side-effects on the first paid transition', () => {
    expect(shouldRunBookingPaidSideEffects('paid', false)).toBe(true);
  });

  it('does NOT re-run side-effects when bookings were already paid (duplicate webhook)', () => {
    expect(shouldRunBookingPaidSideEffects('paid', true)).toBe(false);
  });

  it('does not run side-effects for non-paid statuses', () => {
    expect(shouldRunBookingPaidSideEffects('open', false)).toBe(false);
    expect(shouldRunBookingPaidSideEffects('failed', false)).toBe(false);
  });
});
