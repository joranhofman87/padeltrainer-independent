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
 * @param alreadyPaid   whether the invoice was already 'paid' before this webhook.
 *   Note (E-15): `notify` based on a pre-read is only an approximation under
 *   concurrent duplicate deliveries — the webhook additionally gates
 *   notifications/forwarding on its atomic claim (UPDATE filtered on
 *   status != paid/cancelled, with .select()).
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
 * @param bookingsAlreadyPaid whether every related booking was already 'paid'.
 *   E-15: callers derive this from the atomic claim — the bookings UPDATE
 *   filtered on `payment_status != 'paid'` with `.select()` — so "already
 *   paid" means "this request transitioned zero rows", which is race-safe
 *   against duplicate concurrent deliveries (a plain pre-read is not).
 */
export function shouldRunBookingPaidSideEffects(
  mollieStatus: string,
  bookingsAlreadyPaid: boolean,
): boolean {
  return mollieStatus === "paid" && !bookingsAlreadyPaid;
}

/** The minimal Supabase surface the write-back helpers need — so they can be unit-tested against a
 * PGlite-backed client without standing up the edge runtime. */
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate test-seam: the minimal Supabase write surface, left untyped so a PGlite client can stand in
export interface MollieWriteClient { from(table: string): any }

/**
 * Booking-payment write-back from a Mollie webhook, ALWAYS guarded by `payment_status != 'paid'`.
 *
 * The guard serves two purposes at once:
 *  - (E-15 idempotency) for the PAID transition it is the atomic claim — only still-unpaid rows
 *    transition, so duplicate concurrent deliveries transition zero rows and can't double-run the
 *    paid side-effects; the returned rows ARE the ones this call transitioned.
 *  - (no-downgrade) for any NON-paid delivery (open/pending/failed/expired arriving late or out of
 *    order) it ensures an already-PAID booking is never overwritten back to pending/failed. The
 *    handler previously applied this guard only for paid/cancelled, so a stale `open`/`pending`
 *    delivery could downgrade a paid booking — this makes the guard unconditional.
 *
 * @returns the rows THIS call transitioned (empty = the bookings were already paid).
 */
export async function applyBookingPaymentWriteback(
  supabase: MollieWriteClient,
  bookingIds: string[],
  updateData: Record<string, unknown>,
): Promise<{ id: string }[]> {
  const { data, error } = await supabase
    .from("bookings")
    .update(updateData)
    .in("id", bookingIds)
    .neq("payment_status", "paid")
    .select("id");
  if (error) throw new Error(`Failed to update bookings: ${error.message}`);
  return (data ?? []) as { id: string }[];
}
