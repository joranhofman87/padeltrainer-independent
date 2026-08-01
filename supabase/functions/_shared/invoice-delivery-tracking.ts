// Delivery-tracking recorder for `send-invoice-email`, with BOTH failure paths surfaced.
//
// Why: supabase-js resolves an RPC error as a { error } RESULT (it does not throw); network/unexpected faults DO
// throw. The old inline recorder only had a try/catch, so the common resolved-{error} path was silently swallowed —
// an accepted email could lose its `sent` row with no signal. This recorder inspects both, emits a PII-free log +
// one Slack alert on failure (the error string is run through redactDetail first — a DB error can echo an email /
// token / URL / id), and NEVER throws (tracking must not break a send that already succeeded — so even a throwing
// alert sink is contained).
import { redactDetail } from "./redact-detail.ts";

export interface RecordDeliveryDeps {
  // mirrors supabase.rpc(...): resolves { error } on an RPC error, may throw on network/unexpected faults.
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>;
  notifySlack: (fnName: string, message: string, context?: Record<string, unknown>) => Promise<void>;
  log: (step: string, details?: Record<string, unknown>) => void;
}

export interface RecordDeliveryArgs {
  eventType: "sent" | "send_failed";
  invoiceId: string;
  invoiceNumber?: string | number | null;
  recipientEmail: string | null;   // never logged/alerted (PII)
  testEmail: string | null;        // a test send is never tracked
  rpcArgs?: Record<string, unknown>;
}

/**
 * Record a sent/send_failed delivery event. Returns true when tracking succeeded (or was intentionally bypassed),
 * false when it failed — after emitting exactly one PII-free log + one Slack alert. Never throws.
 */
export async function recordInvoiceEmailEvent(deps: RecordDeliveryDeps, args: RecordDeliveryArgs): Promise<boolean> {
  // bypass: test sends + invoices with no recipient are intentionally not tracked
  if (args.testEmail || !args.recipientEmail) return true;

  let failure: string | null = null;
  try {
    const { error } = await deps.rpc("record_email_event", {
      p_event_type: args.eventType,
      p_recipient_email: args.recipientEmail,
      p_invoice_id: args.invoiceId,
      ...(args.rpcArgs ?? {}),
    });
    if (error) failure = error.message ?? "record_email_event returned an error";   // RESOLVED-error path (was swallowed)
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);                            // THROWN/network path
  }

  if (failure) {
    // PII-free: redact any echoed email/JWT/token/URL/id before EITHER sink (invoice id/number are safe).
    const safe = redactDetail(failure);
    // Both observability sinks are protected INDEPENDENTLY: a throwing log must not skip the alert, and neither may
    // break tracking's never-throw contract (the email already succeeded).
    try {
      deps.log("record_failed", { invoiceId: args.invoiceId, eventType: args.eventType, error: safe });
    } catch (_) { /* log sink must never throw up */ }
    try {
      await deps.notifySlack(
        "send-invoice-email",
        "record_email_event failed — invoice delivery tracking lost",
        { invoiceId: args.invoiceId, invoiceNumber: args.invoiceNumber ?? null, eventType: args.eventType, error: safe },
      );
    } catch (_) { /* alert sink must never throw up */ }
    return false;
  }
  return true;
}
