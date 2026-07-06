// Lost-webhook detector logic: candidate grouping (payments with ZERO paid local
// bookings) and the Mollie paid-status classification.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { collectStuckCandidates, isPaidAtMollie, type StuckCandidateRow } from "./stuck-payments.ts";

const row = (over: Partial<StuckCandidateRow>): StuckCandidateRow => ({
  id: "b1",
  mollie_payment_id: "tr_1",
  payment_status: "pending",
  status: "cancelled",
  slot_id: "s1",
  ...over,
});

Deno.test("groups bookings per payment and keeps only zero-paid payments", () => {
  const out = collectStuckCandidates(
    [
      row({ id: "b1", mollie_payment_id: "tr_lost" }),
      row({ id: "b2", mollie_payment_id: "tr_lost", slot_id: null }),
      // webhook landed for this one — one booking paid → NOT a candidate
      row({ id: "b3", mollie_payment_id: "tr_ok", payment_status: "paid" }),
      row({ id: "b4", mollie_payment_id: "tr_ok" }),
    ],
    10,
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].molliePaymentId, "tr_lost");
  assertEquals(out[0].bookingIds, ["b1", "b2"]);
  assertEquals(out[0].slotId, "s1");
});

Deno.test("a single paid booking clears the WHOLE payment (cart: one webhook flips all)", () => {
  const out = collectStuckCandidates(
    [
      row({ id: "b1", mollie_payment_id: "tr_cart", payment_status: "paid" }),
      row({ id: "b2", mollie_payment_id: "tr_cart", payment_status: "pending" }),
    ],
    10,
  );
  assertEquals(out.length, 0);
});

Deno.test("rows without a payment id are ignored; limit bounds the Mollie calls", () => {
  const rows: StuckCandidateRow[] = [row({ id: "b0", mollie_payment_id: null })];
  for (let i = 0; i < 40; i++) rows.push(row({ id: `b${i + 1}`, mollie_payment_id: `tr_${i}` }));
  const out = collectStuckCandidates(rows, 25);
  assertEquals(out.length, 25);
});

Deno.test("isPaidAtMollie: paid/authorized alert; open/expired/canceled/failed (abandonment) do not", () => {
  assertEquals(isPaidAtMollie("paid"), true);
  assertEquals(isPaidAtMollie("authorized"), true);
  for (const s of ["open", "expired", "canceled", "failed", "pending", null, undefined]) {
    assertEquals(isPaidAtMollie(s as string | null | undefined), false);
  }
});
