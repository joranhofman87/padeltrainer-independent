/**
 * Pure decision helpers for the mollie-webhook handler.
 *
 * These encapsulate the security- and idempotency-critical decisions so they
 * can be unit-tested without standing up the full edge function:
 *  - whether a paid amount matches the expected invoice/booking total, and
 *  - whether side-effects (emails, invoice creation, notifications) should run,
 *    which must only happen on the FIRST transition to paid (duplicate Mollie
 *    webhook deliveries must be no-ops for side-effects).
 */

import { amountsMatch } from "./booking-pricing.ts";

export type InvoicePaymentDecision = {
  /** Amount did not match the invoice total — refuse to mark paid. */
  amountMismatch: boolean;
  /** Safe to flip the invoice to paid. */
  markPaid: boolean;
  /** Send the "payment received" notification (first transition only). */
  notify: boolean;
};

/**
 * Decide what to do with an invoice-link payment that Mollie reports as paid.
 *
 * @param expectedTotal invoice.total from our DB (0/unknown disables the check)
 * @param paidValue     amount Mollie reports as paid
 * @param alreadyPaid   whether the invoice was already 'paid' before this webhook
 */
export function evaluateInvoicePayment(
  expectedTotal: number,
  paidValue: number,
  alreadyPaid: boolean,
): InvoicePaymentDecision {
  const hasComparableTotal = Number.isFinite(expectedTotal) && expectedTotal > 0;
  const amountMismatch = hasComparableTotal &&
    !amountsMatch(expectedTotal, paidValue);

  if (amountMismatch) {
    return { amountMismatch: true, markPaid: false, notify: false };
  }

  // Marking paid is idempotent (same end state), but notifications must only
  // fire on the first transition.
  return { amountMismatch: false, markPaid: true, notify: !alreadyPaid };
}

/**
 * Decide whether booking-payment side-effects (auto-create invoice, confirmation
 * email, Slack) should run. They run only on the first transition to paid.
 *
 * @param mollieStatus       payment.status reported by Mollie
 * @param bookingsAlreadyPaid whether every related booking was already 'paid'
 */
export function shouldRunBookingPaidSideEffects(
  mollieStatus: string,
  bookingsAlreadyPaid: boolean,
): boolean {
  return mollieStatus === "paid" && !bookingsAlreadyPaid;
}
