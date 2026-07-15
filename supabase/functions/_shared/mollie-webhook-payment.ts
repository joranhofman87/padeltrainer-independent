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

import { amountsMatch, parseMollieAmountValue } from "./booking-pricing.ts";

/**
 * Tolerance for matching the Mollie-charged total against the SUM of per-booking `payment_amount`s.
 * Per-booking amounts are stored to the cent, so an N-booking payment can legitimately differ from
 * the charged total by up to ~half a cent per booking; a flat 1ct tolerance wrongly rejected valid
 * multi-session cyclus payments (money taken, bookings stuck). Scales with the booking count.
 */
export function bookingSumTolerance(bookingCount: number): number {
  return Math.max(0.01, bookingCount * 0.01);
}

/** Does the Mollie-paid amount match the sum of per-booking amounts for an N-booking payment? */
export function bookingSumMatches(expectedSum: number, paidValue: number, bookingCount: number): boolean {
  return amountsMatch(expectedSum, paidValue, bookingSumTolerance(bookingCount));
}

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
  if (!error) return (data ?? []) as { id: string }[];

  // M-17 tolerance (P1-4): flipping a payment_pending HOLD to 'confirmed' enters
  // the (slot_id, guest_player_id) / (slot_id, player_id) partial unique index
  // whose predicate is status IN ('pending','confirmed','completed'). If a staff
  // member added the SAME person to the SAME slot while the guest was paying, a
  // pre-existing active booking already occupies that index slot and this flip
  // raises 23505. A batched .update() aborts entirely on the FIRST 23505, so we
  // fall back to per-id handling: flip each id on its own, and route only the
  // truly-colliding id(s) through the survivor path (stamp the pre-existing
  // active booking paid, cancel the redundant hold). Never surface 23505 to the
  // caller (which would 500 → Mollie retries forever with money already captured).
  const code = (error as { code?: string }).code;
  if (code !== "23505") throw new Error(`Failed to update bookings: ${error.message}`);
  return await applyBookingPaymentWritebackPerId(supabase, bookingIds, updateData);
}

/**
 * Per-id fallback for {@link applyBookingPaymentWriteback} after a batch 23505.
 * Non-colliding ids flip exactly as the batch would have; a colliding id is
 * replaced by its SURVIVOR (the pre-existing active booking on the same slot for
 * the same guest/player). Returns the final set of survivor/paid ids that THIS
 * call transitioned — same contract the batch path returns (drives the caller's
 * bookingsAlreadyPaid gate and keys the paid side-effects).
 */
async function applyBookingPaymentWritebackPerId(
  supabase: MollieWriteClient,
  bookingIds: string[],
  updateData: Record<string, unknown>,
): Promise<{ id: string }[]> {
  const transitioned: { id: string }[] = [];
  for (const id of bookingIds) {
    const { data, error } = await supabase
      .from("bookings")
      .update(updateData)
      .in("id", [id])
      .neq("payment_status", "paid")
      .neq("status", "cancelled")
      .select("id");
    if (!error) {
      for (const r of (data ?? []) as { id: string }[]) transitioned.push(r);
      continue;
    }
    if ((error as { code?: string }).code !== "23505") {
      throw new Error(`Failed to update bookings: ${error.message}`);
    }
    // This id collided: find its survivor and stamp/cancel accordingly.
    const survivorId = await resolveSurvivorAndSettle(supabase, id, updateData);
    if (survivorId) transitioned.push({ id: survivorId });
  }
  return transitioned;
}

/**
 * A payment_pending HOLD (`holdId`) collided with the M-17 unique index while
 * being flipped paid. Resolve the SURVIVOR — a DIFFERENT active
 * ('pending'/'confirmed'/'completed') booking on the same slot for the same
 * (guest_player_id ?? player_id) — stamp it with the SAME `updateData` under the
 * SAME idempotency guard (a survivor already paid transitions 0 rows), and
 * cancel the redundant hold. Returns the survivor id IFF this call actually
 * transitioned it to paid (so it flows into the paid side-effects exactly once);
 * returns null if the survivor was already paid or cannot be resolved.
 */
async function resolveSurvivorAndSettle(
  supabase: MollieWriteClient,
  holdId: string,
  updateData: Record<string, unknown>,
): Promise<string | null> {
  const { data: holdRow } = await supabase
    .from("bookings")
    .select("id, slot_id, guest_player_id, player_id")
    .in("id", [holdId])
    .neq("id", "__never__") // no-op filter to keep the adapter's builder shape
    .select("id, slot_id, guest_player_id, player_id");
  const hold = (Array.isArray(holdRow) ? holdRow[0] : holdRow) as
    | { id: string; slot_id: string | null; guest_player_id: string | null; player_id: string | null }
    | undefined;
  if (!hold?.slot_id) return null;

  let survivorQuery = supabase
    .from("bookings")
    .select("id, payment_status")
    .eq("slot_id", hold.slot_id)
    .neq("id", holdId)
    .in("status", ["pending", "confirmed", "completed"]);
  if (hold.guest_player_id) {
    survivorQuery = survivorQuery.eq("guest_player_id", hold.guest_player_id);
  } else if (hold.player_id) {
    survivorQuery = survivorQuery.eq("player_id", hold.player_id);
  } else {
    return null;
  }
  const { data: survivors } = await survivorQuery;
  const survivor = ((survivors ?? []) as { id: string; payment_status: string | null }[])[0];
  if (!survivor) return null;

  // Stamp the survivor paid (idempotent via the guard); capture whether THIS
  // call transitioned it so side-effects run exactly once.
  const { data: stamped } = await supabase
    .from("bookings")
    .update(updateData)
    .in("id", [survivor.id])
    .neq("payment_status", "paid")
    .neq("status", "cancelled")
    .select("id");
  const transitionedSurvivor = ((stamped ?? []) as { id: string }[]).length > 0;

  // Cancel the redundant hold so it stops occupying capacity / the index.
  await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .in("id", [holdId])
    .neq("payment_status", "paid");

  return transitionedSurvivor ? survivor.id : null;
}


/**
 * P2-5 reversal detection. A Mollie payment can be reversed AFTER it settled paid:
 *  - a full chargeback flips `status` to "charged_back";
 *  - a partial chargeback or a refund leaves `status === "paid"` but sets a non-zero
 *    `amountChargedBack` / `amountRefunded` {value,currency} object.
 * The webhook must NOT auto-resurrect/downgrade booking or invoice state (that risks
 * clobbering a legitimate re-payment or a concurrent manual fix); it only surfaces the
 * reversal for manual reconciliation (audit row + Slack alert). Pure so it is CI-covered.
 */
export type MollieReversal = {
  isReversal: boolean;
  /** "charged_back" | "refunded" | null — what triggered it (chargeback wins if both). */
  kind: "charged_back" | "refunded" | null;
  chargedBackValue: number;
  refundedValue: number;
};

export function detectPaymentReversal(
  payment: {
    status?: string;
    amountChargedBack?: { value?: string | number } | null;
    amountRefunded?: { value?: string | number } | null;
  } | null | undefined,
): MollieReversal {
  const chargedBackRaw = parseMollieAmountValue(payment?.amountChargedBack?.value);
  const refundedRaw = parseMollieAmountValue(payment?.amountRefunded?.value);
  const chargedBackValue = Number.isFinite(chargedBackRaw) ? chargedBackRaw : 0;
  const refundedValue = Number.isFinite(refundedRaw) ? refundedRaw : 0;

  const isChargedBack = payment?.status === "charged_back" || chargedBackValue > 0;
  const isRefunded = refundedValue > 0;

  if (isChargedBack) {
    return { isReversal: true, kind: "charged_back", chargedBackValue, refundedValue };
  }
  if (isRefunded) {
    return { isReversal: true, kind: "refunded", chargedBackValue, refundedValue };
  }
  return { isReversal: false, kind: null, chargedBackValue, refundedValue };
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

/**
 * F05 (group rebook): the booking ids of GROUP MEMBERS whose seats the captain's full-court
 * payment now covers — every 'claimed' claim's booking in the group EXCEPT the captain's own
 * (the group invoice's booking_ids). A member who accepted "just my spot" BEFORE the captain
 * paid carries exactly such a booking, with its own untagged invoice/checkout the group-level
 * dedup can't see. Deduped; null booking_ids dropped.
 */
export function memberSettlementBookingIds(
  claimRows: { booking_id: string | null }[],
  captainBookingIds: string[],
): string[] {
  const captain = new Set(captainBookingIds);
  return [...new Set(
    claimRows
      .map((r) => r.booking_id)
      .filter((id): id is string => !!id && !captain.has(id)),
  )];
}

export interface MemberInvoiceRow {
  id: string;
  status: string | null;
  total?: number | string | null;
  mollie_payment_id?: string | null;
  booking_ids?: string[] | null;
}

/**
 * F05: split a member's own rebook invoices (overlapping the covered member bookings) into the
 * ones to CANCEL (still unpaid — the captain's full-court payment covers those seats now) and
 * the ones already PAID (the seat was collected twice → manual-refund alert; deducting money is
 * a manual decision, never automatic).
 */
export function partitionMemberInvoices(rows: MemberInvoiceRow[]): {
  alreadyPaid: MemberInvoiceRow[];
  toCancel: MemberInvoiceRow[];
} {
  const alreadyPaid: MemberInvoiceRow[] = [];
  const toCancel: MemberInvoiceRow[] = [];
  for (const r of rows) (r.status === "paid" ? alreadyPaid : toCancel).push(r);
  return { alreadyPaid, toCancel };
}

export interface MemberBookingRow {
  id: string;
  payment_status: string | null;
  status: string | null;
  mollie_payment_id?: string | null;
  paid_by_player_id?: string | null;
  paid_by_guest_player_id?: string | null;
}

/**
 * F05: distinct Mollie payment ids of the members' own still-live checkouts (unpaid,
 * non-cancelled bookings carrying a mollie_payment_id) — expired best-effort once the captain's
 * payment covers the seats, so a stale hosted-checkout link can no longer collect a seat twice.
 */
export function openMemberCheckoutPaymentIds(rows: MemberBookingRow[]): string[] {
  return [...new Set(
    rows
      .filter((r) => r.payment_status !== "paid" && r.status !== "cancelled" && !!r.mollie_payment_id)
      .map((r) => r.mollie_payment_id as string),
  )];
}

/**
 * F05 TOCTOU mirror: member bookings that were SELF-paid (payment_status='paid' with no
 * paid_by_* covering stamp) before the captain's payment landed — the create-group-rebook-invoice
 * mint guard only sees payments that already LANDED at mint time, so a member checkout completing
 * between that check and this webhook slips through it. Seats already reported via a PAID member
 * invoice are excluded (one alert per seat).
 */
export function selfPaidMemberBookingIds(
  rows: MemberBookingRow[],
  paidInvoiceBookingIds: string[],
): string[] {
  const viaInvoice = new Set(paidInvoiceBookingIds);
  return rows
    .filter((r) =>
      r.payment_status === "paid" &&
      !r.paid_by_player_id && !r.paid_by_guest_player_id &&
      !viaInvoice.has(r.id))
    .map((r) => r.id);
}
