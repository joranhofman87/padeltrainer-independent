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
 * Booking-payment write-back from a Mollie webhook, ALWAYS guarded by
 * `payment_status != 'paid'` AND `status != 'cancelled'`.
 *
 * The guards serve three purposes at once:
 *  - (E-15 idempotency) for the PAID transition `payment_status != 'paid'` is the atomic claim —
 *    only still-unpaid rows transition, so duplicate concurrent deliveries transition zero rows and
 *    can't double-run the paid side-effects; the returned rows ARE the ones this call transitioned.
 *  - (no-downgrade) for any NON-paid delivery (open/pending/failed/expired arriving late or out of
 *    order) it ensures an already-PAID booking is never overwritten back to pending/failed. The
 *    handler previously applied this guard only for paid/cancelled, so a stale `open`/`pending`
 *    delivery could downgrade a paid booking — this makes the guard unconditional.
 *  - (no-resurrection) `status != 'cancelled'` ensures a booking that was CANCELLED (e.g. the
 *    BookLesson online-cycle rollback soft-cancels its bookings when payment creation fails, while
 *    leaving payment_status='pending') can never be flipped back to paid/confirmed by a late
 *    Mollie webhook for a payment that was created just before the failure. The caller detects the
 *    "paid payment landed on a cancelled booking" case via {@link findCancelledPaidBookings} and
 *    alerts for a manual refund instead of silently auto-confirming.
 *
 * @returns the rows THIS call transitioned (empty = already paid OR cancelled — see the caller's
 *   {@link findCancelledPaidBookings} check to tell the two apart).
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
    .neq("status", "cancelled")
    .select("id");
  if (error) throw new Error(`Failed to update bookings: ${error.message}`);
  return (data ?? []) as { id: string }[];
}

/**
 * Bookings that a *paid* Mollie payment is landing on while they are already
 * CANCELLED (and not yet paid). With the `status != 'cancelled'` guard in
 * {@link applyBookingPaymentWriteback} these are NOT resurrected — but the money
 * WAS received, so the caller must alert for a manual refund / review rather
 * than letting a real payment vanish silently. Returns the offending ids.
 */
export function findCancelledPaidBookings(
  rows: { id: string; status?: string | null; payment_status?: string | null }[],
): string[] {
  return rows
    .filter((b) => b.status === "cancelled" && b.payment_status !== "paid")
    .map((b) => b.id);
}
