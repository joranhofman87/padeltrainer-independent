/**
 * Single source of truth for "how much has a trainer earned".
 *
 * Earnings are based on money ACTUALLY RECEIVED — a booking whose payment has
 * been collected (`payment_status='paid'`, with a `paid_at` timestamp) — summed
 * gross. There is no platform fee. This deliberately fluctuates as payments come
 * in, and is shared by the TrainerDashboard "Revenue" tile and the Earnings
 * "This Month" card so the two never disagree (previously the dashboard applied
 * a phantom ×0.9 and a different status/amount rule).
 */

export interface EarningsBookingLike {
  payment_status?: string | null;
  paid_at?: string | null;
  payment_amount?: number | null;
  availability_slots?: { price_per_session?: number | null } | null;
  price_per_session?: number | null;
}

/**
 * Amount received for a booking: the charged amount, falling back to the slot's
 * per-session price (mirrors the long-standing Earnings-page `getAmount`).
 */
export function bookingReceivedAmount(b: EarningsBookingLike): number {
  return b.payment_amount || b.availability_slots?.price_per_session || b.price_per_session || 0;
}

/** Has this booking's payment actually been received (money in)? */
export function isReceivedPayment(b: EarningsBookingLike): boolean {
  return b.payment_status === 'paid' && !!b.paid_at;
}

/**
 * Sum of money received within [start, end] (inclusive, by `paid_at`). Gross,
 * no fee. The one computation both the dashboard tile and the earnings card use.
 */
export function sumReceivedInRange(
  bookings: EarningsBookingLike[],
  start: Date,
  end: Date,
): number {
  const startMs = start.getTime();
  const endMs = end.getTime();
  return bookings.reduce((sum, b) => {
    if (!isReceivedPayment(b)) return sum;
    const t = b.paid_at ? new Date(b.paid_at).getTime() : NaN;
    if (Number.isNaN(t) || t < startMs || t > endMs) return sum;
    return sum + bookingReceivedAmount(b);
  }, 0);
}
