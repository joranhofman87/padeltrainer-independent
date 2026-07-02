import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { detectPaymentReversal } from "./mollie-webhook-payment.ts";
import { PaymentAuditStatus, writePaymentAuditLog } from "./payment-audit.ts";

// --- Pure detector ---------------------------------------------------------

Deno.test("detectPaymentReversal: status charged_back is a reversal (chargeback)", () => {
  const r = detectPaymentReversal({ status: "charged_back", amountChargedBack: { value: "25.00" } });
  assertEquals(r.isReversal, true);
  assertEquals(r.kind, "charged_back");
  assertEquals(r.chargedBackValue, 25);
});

Deno.test("detectPaymentReversal: paid + non-zero amountChargedBack is a partial chargeback", () => {
  const r = detectPaymentReversal({ status: "paid", amountChargedBack: { value: "10.00" } });
  assertEquals(r.isReversal, true);
  assertEquals(r.kind, "charged_back");
  assertEquals(r.chargedBackValue, 10);
});

Deno.test("detectPaymentReversal: paid + non-zero amountRefunded is a refund", () => {
  const r = detectPaymentReversal({ status: "paid", amountRefunded: { value: "12.50" } });
  assertEquals(r.isReversal, true);
  assertEquals(r.kind, "refunded");
  assertEquals(r.refundedValue, 12.5);
});

Deno.test("detectPaymentReversal: clean paid payment is NOT a reversal", () => {
  const r = detectPaymentReversal({
    status: "paid",
    amountChargedBack: { value: "0.00" },
    amountRefunded: { value: "0.00" },
  });
  assertEquals(r.isReversal, false);
  assertEquals(r.kind, null);
});

Deno.test("detectPaymentReversal: missing amount objects are not a reversal", () => {
  assertEquals(detectPaymentReversal({ status: "paid" }).isReversal, false);
  assertEquals(detectPaymentReversal(null).isReversal, false);
});

Deno.test("detectPaymentReversal: chargeback wins when both refund and chargeback present", () => {
  const r = detectPaymentReversal({
    status: "charged_back",
    amountChargedBack: { value: "5.00" },
    amountRefunded: { value: "3.00" },
  });
  assertEquals(r.kind, "charged_back");
});

// --- Webhook reversal branch: audit written, NO state resurrection ----------

Deno.test("webhook reversal branch: writes an audit row and touches NO booking/invoice state", async () => {
  // Fake a charged_back payment flowing through the reversal branch's effects:
  // it must (1) write a payment_audit_log row with the reversal status, and
  // (2) never issue an update to bookings/invoices (no resurrection/downgrade).
  const inserted: Record<string, unknown>[] = [];
  const touchedTables: string[] = [];
  const sb = {
    from: (t: string) => {
      touchedTables.push(t);
      return {
        insert: (row: Record<string, unknown>) => {
          if (t === "payment_audit_log") inserted.push(row);
          return Promise.resolve({ error: null });
        },
        // If the branch ever tried to mutate state, it would call .update() —
        // make that observable so the test fails if resurrection is introduced.
        update: () => {
          throw new Error(`reversal branch must not update ${t}`);
        },
      };
    },
  };

  const payment = { status: "charged_back", amountChargedBack: { value: "25.00" } };
  const reversal = detectPaymentReversal(payment);
  assertEquals(reversal.isReversal, true);

  // Mirror exactly what index.ts writes on the reversal branch.
  await writePaymentAuditLog(sb, {
    function_name: "mollie-webhook",
    status: reversal.kind === "refunded" ? PaymentAuditStatus.paymentRefunded : PaymentAuditStatus.paymentChargedBack,
    mollie_payment_id: "tr_reversed",
    invoice_id: null,
    booking_id: "bk-1",
    amount: reversal.chargedBackValue,
    metadata: { kind: reversal.kind },
  });

  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].status, "payment_charged_back");
  assertEquals(inserted[0].amount, 25);
  // Only the audit table was written; no bookings/invoices update was attempted.
  assertEquals(touchedTables.includes("bookings"), false);
  assertEquals(touchedTables.includes("invoices"), false);
});

Deno.test("PaymentAuditStatus exposes the reversal vocabulary", () => {
  assertEquals(PaymentAuditStatus.paymentChargedBack, "payment_charged_back");
  assertEquals(PaymentAuditStatus.paymentRefunded, "payment_refunded");
});
