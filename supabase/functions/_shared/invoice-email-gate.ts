// Reversible maintenance gate for `send-invoice-email`, plus PII-free structured lifecycle events.
//
// Why: a live migration on the email-delivery tables can make `record_email_event` block/fail. Because
// send-invoice-email sends via Resend FIRST and treats tracking as best-effort, an in-flight send during that
// window can lose its `sent` row. The gate lets an operator STOP new sends BEFORE any side effect (invoice/PDF
// reads, generate-invoice, Resend, tracking, invoice-status mutation), returning a retryable maintenance response
// that no caller can mistake for a successful delivery.

export const INVOICE_EMAIL_MAINTENANCE_ENV = "INVOICE_EMAIL_MAINTENANCE";

/** Truthy iff the value is an explicit on token (1/true/yes/on, case/space-insensitive). Everything else is off. */
export function isMaintenanceFlag(value: string | null | undefined): boolean {
  return value != null && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Reads the maintenance switch from an env-like object (Deno.env or a test double). */
export function invoiceEmailMaintenanceActive(env: { get(key: string): string | undefined }): boolean {
  return isMaintenanceFlag(env.get(INVOICE_EMAIL_MAINTENANCE_ENV));
}

// The maintenance response — explicit, retryable, and NOT `success:true`. Callers keying on `success` see false;
// callers keying on status see 503 (retryable). It carries no invoice/recipient side effect.
export const MAINTENANCE_HTTP_STATUS = 503;
export const MAINTENANCE_ERROR_CODE = "invoice_email_maintenance";
// The 503 body echoes the per-invocation id so a rollout drain-proof canary can
// correlate its exact request to the `event:blocked` log line (not just "some"
// blocked event). PII-free: a random uuid, never customer data.
export function maintenanceResponseBody(invocationId: string): { success: false; error: string; invocationId: string } {
  return { success: false, error: MAINTENANCE_ERROR_CODE, invocationId };
}

/** The authenticated status-probe body — proves the switch state WITHOUT sending. */
export function probeResponseBody(active: boolean): { status: "maintenance" | "active"; maintenance: boolean } {
  return { status: active ? "maintenance" : "active", maintenance: active };
}

// Structured lifecycle events, correlated by a per-invocation id. Details MUST stay PII-free (invoice id/number,
// booleans, counts — never email addresses or names). The runbook proves "no send passed the gate" by observing
// zero `provider_send_started` events after the switch is activated, and drains by waiting for `finished`.
export type InvoiceEmailEvent = "blocked" | "provider_send_started" | "finished";
export function logInvoiceEmailEvent(
  log: (step: string, details?: Record<string, unknown>) => void,
  invocationId: string,
  event: InvoiceEmailEvent,
  details: Record<string, unknown> = {},
): void {
  log(`event:${event}`, { invocationId, ...details });
}
