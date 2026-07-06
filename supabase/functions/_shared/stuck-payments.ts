// Pure logic for the nightly LOST-WEBHOOK detector (P0 payments observability).
//
// The failure mode: a guest pays at Mollie but the webhook never lands (endpoint
// down past Mollie's retry window). Locally that booking is indistinguishable
// from an abandoned checkout — the hold expires, the 5-min sweep cancels it, and
// nothing ever looks again. Guests cannot call verify-mollie-payment (auth-only),
// and the invoice-shaped health checks never see direct booking payments (their
// invoice is only minted AFTER payment). The only trustworthy discriminator is
// Mollie itself: an abandoned checkout is open/expired/canceled there; captured
// money is paid. invoice-health-check gathers candidates with these helpers,
// fetches each payment with the SAME org token the webhook would use, and alerts
// on any payment Mollie says is paid while no local booking is.

export interface StuckCandidateRow {
  id: string;
  mollie_payment_id: string | null;
  payment_status: string | null;
  status: string | null;
  slot_id: string | null;
}

export interface StuckCandidate {
  molliePaymentId: string;
  bookingIds: string[];
  /** slot of the first booking — used to resolve the org token. */
  slotId: string | null;
}

/**
 * Group recent bookings by Mollie payment id and keep only payments where NO
 * booking reached paid — the "money might be at Mollie with nothing to show"
 * suspects. Bounded by `limit` (each candidate costs one Mollie API call).
 */
export function collectStuckCandidates(rows: StuckCandidateRow[], limit: number): StuckCandidate[] {
  const byPayment = new Map<string, { bookingIds: string[]; slotId: string | null; anyPaid: boolean }>();
  for (const row of rows) {
    if (!row.mollie_payment_id) continue;
    let entry = byPayment.get(row.mollie_payment_id);
    if (!entry) {
      entry = { bookingIds: [], slotId: null, anyPaid: false };
      byPayment.set(row.mollie_payment_id, entry);
    }
    entry.bookingIds.push(row.id);
    if (!entry.slotId && row.slot_id) entry.slotId = row.slot_id;
    if (row.payment_status === 'paid') entry.anyPaid = true;
  }
  const out: StuckCandidate[] = [];
  for (const [molliePaymentId, entry] of byPayment) {
    if (entry.anyPaid) continue; // webhook (or verify) already landed — not stuck
    out.push({ molliePaymentId, bookingIds: entry.bookingIds, slotId: entry.slotId });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Mollie payment statuses that mean money was (or will be) captured. 'paid' is
 * the terminal captured state; 'authorized' is captured-on-shipment methods —
 * neither should ever coexist with zero paid local bookings.
 */
export function isPaidAtMollie(mollieStatus: string | null | undefined): boolean {
  return mollieStatus === 'paid' || mollieStatus === 'authorized';
}
