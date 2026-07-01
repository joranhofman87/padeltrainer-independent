import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { writePaymentAuditLog, PaymentAuditStatus } from "./payment-audit.ts";

Deno.test("writePaymentAuditLog inserts a structured row into payment_audit_log", async () => {
  const inserted: Record<string, unknown>[] = [];
  const sb = {
    from: (t: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (t === "payment_audit_log") inserted.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  };
  await writePaymentAuditLog(sb, {
    function_name: "mollie-webhook",
    status: PaymentAuditStatus.invoiceMarkedPaid,
    invoice_id: "inv-1",
    mollie_payment_id: "tr_x",
    amount: 42,
  });
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].function_name, "mollie-webhook");
  assertEquals(inserted[0].status, "invoice_marked_paid");
  assertEquals(inserted[0].invoice_id, "inv-1");
  assertEquals(inserted[0].amount, 42);
});

Deno.test("writePaymentAuditLog NEVER throws — a failing insert is swallowed (best-effort)", async () => {
  const sb = { from: () => ({ insert: () => Promise.reject(new Error("db down")) }) };
  // If this rejected, the test runner would fail the test. Reaching the assert = it swallowed.
  await writePaymentAuditLog(sb, { function_name: "x", status: "y" });
  assertEquals(true, true);
});

Deno.test("PaymentAuditStatus is the shared vocabulary producers + reconciliation agree on", () => {
  assertEquals(PaymentAuditStatus.webhookReceived, "webhook_received");
  assertEquals(PaymentAuditStatus.bookingMarkedPaid, "booking_marked_paid");
  assertEquals(PaymentAuditStatus.amountMismatchBlocked, "amount_mismatch_blocked");
  assertEquals(PaymentAuditStatus.paymentForCancelledInvoice, "payment_for_cancelled_invoice");
  assertEquals(PaymentAuditStatus.noConnectedMollieAccount, "no_connected_mollie_account");
});
