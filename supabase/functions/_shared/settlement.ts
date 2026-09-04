/**
 * ABC-23 §3 — the ONE way captured money becomes a paid, seated booking.
 *
 * Every settlement goes through `settle_paid_bookings`, a service-role-only SQL command that
 * takes the slot and per-booking locks, decides capacity under those locks, resolves M-17
 * survivors, and settles the invoice in the SAME transaction. Callers here contribute
 * authorization and identity — never a settlement decision.
 *
 * Two things this module deliberately does NOT do, because both were live defects:
 *  - it keeps NO process-global or request-global state. Settlement is a value returned to the
 *    caller that requested it; a module-level "last result" leaks across concurrent invocations
 *    in a warm isolate and attributes one payment's outcome to another's request.
 *  - it has NO fallback to raw writes when the RPC is unavailable. A missing command means the
 *    deployed database is not the one this code was written against; writing directly would
 *    reintroduce the unlocked classifier→update shape ABC-23 exists to remove. It throws, the
 *    caller 500s, and Mollie retries once the migration is applied.
 */

/** Where a settlement request came from. Recorded on every log/audit line so a paid transition
 *  can always be traced to the boundary that authorized it. */
export type SettlementSource =
  | "webhook_direct"
  | "webhook_invoice"
  | "webhook_rebook_member"
  | "verifier"
  | "manual_invoice";

export interface SettlementRequest {
  source: SettlementSource;
  /** The COMPLETE stored set this payment covers. Never a filtered subset — filtering is the
   *  command's job, under locks. */
  bookingIds: string[];
  providerPaymentId: string;
  providerTransactionId?: string | null;
  invoiceId?: string | null;
  paidByPlayerId?: string | null;
  paidByGuestPlayerId?: string | null;
  /** 'mollie' (default) = a captured provider payment. 'manual' = recorded out of band; NO
   *  provider column is written, so no Mollie id is ever invented. */
  settlementSource?: "mollie" | "manual";
}

export interface SettlementOutcome {
  source: SettlementSource;
  providerPaymentId: string;
  providerTransactionId: string | null;
  invoiceId: string | null;
  /** FIRST paid transitions — the only ids that may trigger customer-facing confirmation. */
  confirmedPaid: string[];
  /** Already paid before this request (duplicate delivery). No side-effects. */
  alreadyConfirmedPaid: string[];
  /** Money captured, no seat: cancelled + paid. FIRST observation only. */
  paidNoSeat: string[];
  /** A previous request already recorded these as paid_no_seat. No side-effects. */
  replayedPaidNoSeat: string[];
  refused: string[];
  refusalReason: string | null;
  /** TRUE only when THIS request transitioned the invoice to paid. */
  invoicePaidNow: boolean;
}

/**
 * Refusals a retry can never fix. The distinction matters financially: a hard refusal must be
 * ACCEPTED (200) and alerted for manual review, because returning 500 makes Mollie retry forever
 * on money that is already captured. Everything else is treated as transient and retried.
 */
export const HARD_REFUSALS: readonly string[] = [
  "no_targets",
  "null_target",
  "duplicate_targets",
  "missing_provider_payment_id",
  "unknown_target",
  "multiple_slots",
  "provider_conflict",
  "already_cancelled",
  "invoice_missing",
  "invoice_cancelled",
  "invoice_provider_conflict",
  "invoice_association_mismatch",
  "invoice_has_bookings",
  "invalid_settlement_source",
];

export function isHardRefusal(reason: string | null | undefined): boolean {
  return !!reason && HARD_REFUSALS.includes(reason);
}

/** Did this request perform a first paid transition anywhere? Keys the paid side-effects. */
export function hasFirstPaidTransition(o: SettlementOutcome): boolean {
  return o.confirmedPaid.length > 0;
}

/** The minimal Supabase surface needed, so this is testable against a PGlite-backed client. */
export interface SettlementClient {
  // Deliberate seam: the real SupabaseClient's rpc() overloads are generic, and narrowing here
  // would stop a PGlite- or pg-backed test client from standing in for it.
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  rpc(fn: string, args?: any, options?: any): any;
}

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => !!x) : []);

/**
 * Invoke the settlement authority. Returns a request-local typed outcome; throws on a transport
 * or SQL error so the caller can decide (retry vs. accept), and throws when the command is not
 * deployed rather than degrading to raw writes.
 */
export async function settlePaidBookings(
  supabase: SettlementClient,
  req: SettlementRequest,
): Promise<SettlementOutcome> {
  if (typeof supabase?.rpc !== "function") {
    throw new Error("settle_paid_bookings unavailable: this client cannot call RPCs");
  }
  const { data, error } = await supabase.rpc("settle_paid_bookings", {
    _booking_ids: req.bookingIds,
    _provider_payment_id: req.providerPaymentId,
    _provider_transaction_id: req.providerTransactionId ?? null,
    _invoice_id: req.invoiceId ?? null,
    _paid_by_player_id: req.paidByPlayerId ?? null,
    _paid_by_guest_player_id: req.paidByGuestPlayerId ?? null,
    _settlement_source: req.settlementSource ?? "mollie",
  });
  if (error) {
    throw new Error(`settle_paid_bookings failed (${req.source}): ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row) {
    // A settlement that returns nothing is NOT a settlement. Reporting success here is how
    // captured money silently loses its seat.
    throw new Error(`settle_paid_bookings returned no result (${req.source})`);
  }
  return {
    source: req.source,
    providerPaymentId: req.providerPaymentId,
    providerTransactionId: req.providerTransactionId ?? null,
    invoiceId: req.invoiceId ?? null,
    confirmedPaid: asIds(row.confirmed_paid),
    alreadyConfirmedPaid: asIds(row.already_confirmed_paid),
    paidNoSeat: asIds(row.paid_no_seat),
    replayedPaidNoSeat: asIds(row.replayed_paid_no_seat),
    refused: asIds(row.refused),
    refusalReason: (row.refusal_reason as string | null) ?? null,
    invoicePaidNow: row.invoice_paid_now === true,
  };
}

/** Compact, PII-free shape for logs and audit metadata. */
export function settlementLogContext(o: SettlementOutcome): Record<string, unknown> {
  return {
    source: o.source,
    provider_payment_id: o.providerPaymentId,
    invoice_id: o.invoiceId,
    confirmed_paid: o.confirmedPaid.length,
    already_paid: o.alreadyConfirmedPaid.length,
    paid_no_seat: o.paidNoSeat.length,
    replayed_no_seat: o.replayedPaidNoSeat.length,
    refused: o.refused.length,
    refusal_reason: o.refusalReason,
    invoice_paid_now: o.invoicePaidNow,
  };
}
