// Durable payment-path audit trail. Writes a structured row to public.payment_audit_log
// (service-role only; RLS = false). BEST-EFFORT: never throws — a failed audit insert must never
// break the money flow. Used by the payment/webhook edge functions so every money-path outcome
// (created / paid / mismatch / cancelled / duplicate / no-account) leaves a queryable trail that
// survives a Slack outage. See docs/payments/PAYMENT_OBSERVABILITY_AUDIT.md.

// Narrow shape — avoids depending on the full SupabaseClient type (and `any`).
type AuditSupabase = {
  from: (table: string) => { insert: (rows: Record<string, unknown>) => PromiseLike<unknown> };
};

export interface PaymentAuditEvent {
  function_name: string;
  /** The event/outcome, e.g. 'webhook_received', 'invoice_marked_paid', 'amount_mismatch_blocked'. */
  status: string;
  invoice_id?: string | null;
  booking_id?: string | null;
  recipient_type?: string | null;
  mollie_org_id?: string | null;
  amount?: number | null;
  mollie_payment_id?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Well-known status values so producers + reconciliation agree on the vocabulary. */
export const PaymentAuditStatus = {
  webhookReceived: "webhook_received",
  paymentCreated: "payment_created",
  paymentCreateFailed: "payment_create_failed",
  invoiceMarkedPaid: "invoice_marked_paid",
  bookingMarkedPaid: "booking_marked_paid",
  duplicateWebhookIgnored: "duplicate_webhook_ignored",
  amountMismatchBlocked: "amount_mismatch_blocked",
  paymentForCancelledInvoice: "payment_for_cancelled_invoice",
  paymentForCancelledBooking: "payment_for_cancelled_booking",
  paymentForUnknownInvoice: "payment_for_unknown_invoice",
  noConnectedMollieAccount: "no_connected_mollie_account",
  paymentChargedBack: "payment_charged_back",
  paymentRefunded: "payment_refunded",
} as const;

export async function writePaymentAuditLog(
  supabase: AuditSupabase,
  event: PaymentAuditEvent,
): Promise<void> {
  try {
    await supabase.from("payment_audit_log").insert({ ...event });
  } catch (_) {
    // Best-effort: swallow — the audit trail must never fail a payment write.
  }
}
