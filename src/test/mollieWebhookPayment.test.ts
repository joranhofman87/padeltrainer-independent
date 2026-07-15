import { describe, it, expect } from 'vitest';
import {
  evaluateInvoicePayment,
  memberSettlementBookingIds,
  openMemberCheckoutPaymentIds,
  partitionMemberInvoices,
  selfPaidMemberBookingIds,
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

// F05: the captain's full-court payment must settle members who accepted "just my spot" first —
// their own unpaid invoice/checkout would otherwise stay payable and collect the seat twice.
describe('memberSettlementBookingIds', () => {
  it("excludes the captain's own bookings and dedups the rest", () => {
    expect(
      memberSettlementBookingIds(
        [
          { booking_id: 'cap-1' },
          { booking_id: 'mem-1' },
          { booking_id: 'mem-1' },
          { booking_id: 'mem-2' },
          { booking_id: null },
        ],
        ['cap-1', 'cap-2'],
      ),
    ).toEqual(['mem-1', 'mem-2']);
  });

  it('returns empty when every claimed booking is the captain’s (solo-captain group)', () => {
    expect(memberSettlementBookingIds([{ booking_id: 'cap-1' }], ['cap-1'])).toEqual([]);
    expect(memberSettlementBookingIds([], ['cap-1'])).toEqual([]);
  });
});

describe('partitionMemberInvoices', () => {
  it('routes paid invoices to the manual-refund alert and everything else to cancel', () => {
    const paid = { id: 'i-paid', status: 'paid' };
    const sent = { id: 'i-sent', status: 'sent' };
    const draft = { id: 'i-draft', status: 'draft' };
    const overdue = { id: 'i-overdue', status: 'overdue' };
    expect(partitionMemberInvoices([paid, sent, draft, overdue])).toEqual({
      alreadyPaid: [paid],
      toCancel: [sent, draft, overdue],
    });
  });

  it('handles the common case of no member invoices', () => {
    expect(partitionMemberInvoices([])).toEqual({ alreadyPaid: [], toCancel: [] });
  });
});

describe('openMemberCheckoutPaymentIds', () => {
  it('returns distinct payment ids of unpaid, non-cancelled bookings only', () => {
    expect(
      openMemberCheckoutPaymentIds([
        { id: 'b1', payment_status: 'pending', status: 'confirmed', mollie_payment_id: 'tr_1' },
        { id: 'b2', payment_status: 'pending', status: 'payment_pending', mollie_payment_id: 'tr_1' },
        { id: 'b3', payment_status: 'paid', status: 'confirmed', mollie_payment_id: 'tr_2' },
        { id: 'b4', payment_status: 'pending', status: 'cancelled', mollie_payment_id: 'tr_3' },
        { id: 'b5', payment_status: 'pending', status: 'confirmed', mollie_payment_id: null },
      ]),
    ).toEqual(['tr_1']);
  });
});

describe('selfPaidMemberBookingIds', () => {
  it('flags a member seat self-paid via checkout (no covering paid_by stamp) for the double-collect alert', () => {
    expect(
      selfPaidMemberBookingIds(
        [
          { id: 'b1', payment_status: 'paid', status: 'confirmed' },
          { id: 'b2', payment_status: 'pending', status: 'confirmed' },
        ],
        [],
      ),
    ).toEqual(['b1']);
  });

  it('ignores seats covered BY the captain (paid_by stamp) — those are the fix working, not a double-collect', () => {
    expect(
      selfPaidMemberBookingIds(
        [
          { id: 'b1', payment_status: 'paid', status: 'confirmed', paid_by_player_id: 'captain' },
          { id: 'b2', payment_status: 'paid', status: 'confirmed', paid_by_guest_player_id: 'captain-guest' },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('excludes seats already reported via a PAID member invoice (one alert per seat)', () => {
    expect(
      selfPaidMemberBookingIds(
        [{ id: 'b1', payment_status: 'paid', status: 'confirmed' }],
        ['b1'],
      ),
    ).toEqual([]);
  });
});
