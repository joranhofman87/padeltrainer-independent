import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  isMaintenanceFlag, invoiceEmailMaintenanceActive, maintenanceResponseBody, probeResponseBody,
  MAINTENANCE_HTTP_STATUS, MAINTENANCE_ERROR_CODE, logInvoiceEmailEvent, INVOICE_EMAIL_MAINTENANCE_ENV,
} from "./invoice-email-gate.ts";

const envOf = (v: string | undefined) => ({ get: (k: string) => (k === INVOICE_EMAIL_MAINTENANCE_ENV ? v : undefined) });

Deno.test("isMaintenanceFlag: only explicit on tokens are truthy", () => {
  for (const on of ["1", "true", "TRUE", " yes ", "on"]) assertEquals(isMaintenanceFlag(on), true, on);
  for (const off of [undefined, null, "", "0", "false", "off", "no", "maybe"]) assertEquals(isMaintenanceFlag(off as string), false, String(off));
});

Deno.test("invoiceEmailMaintenanceActive reads the env switch", () => {
  assertEquals(invoiceEmailMaintenanceActive(envOf("true")), true);
  assertEquals(invoiceEmailMaintenanceActive(envOf(undefined)), false);   // OFF/UNSET parity
  assertEquals(invoiceEmailMaintenanceActive(envOf("false")), false);
});

Deno.test("maintenance response is a retryable 503 that is not success", () => {
  assertEquals(MAINTENANCE_HTTP_STATUS, 503);
  assertEquals(maintenanceResponseBody(), { success: false, error: "invoice_email_maintenance" });
  assertEquals(MAINTENANCE_ERROR_CODE, "invoice_email_maintenance");
  // never a success shape — callers keying on `success` route it to failure
  assertEquals((maintenanceResponseBody() as { success: boolean }).success, false);
});

Deno.test("probe reports the switch state without sending", () => {
  assertEquals(probeResponseBody(true), { status: "maintenance", maintenance: true });
  assertEquals(probeResponseBody(false), { status: "active", maintenance: false });
});

Deno.test("structured events are correlated + PII-free (no recipient field)", () => {
  const seen: Array<{ step: string; details?: Record<string, unknown> }> = [];
  const log = (step: string, details?: Record<string, unknown>) => seen.push({ step, details });
  logInvoiceEmailEvent(log, "inv-1", "blocked");
  logInvoiceEmailEvent(log, "inv-1", "provider_send_started", { invoiceId: "abc" });
  logInvoiceEmailEvent(log, "inv-1", "finished", { invoiceId: "abc", outcome: "sent" });
  assertEquals(seen.map((s) => s.step), ["event:blocked", "event:provider_send_started", "event:finished"]);
  assertEquals(seen.every((s) => s.details?.invocationId === "inv-1"), true);
  // no event may carry a recipient/email/name key
  const banned = ["email", "recipientEmail", "recipient", "to", "name", "fullName"];
  assertEquals(seen.every((s) => Object.keys(s.details ?? {}).every((k) => !banned.includes(k))), true);
});
