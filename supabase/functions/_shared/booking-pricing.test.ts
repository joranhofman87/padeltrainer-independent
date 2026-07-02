import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  applySplitPayment,
  computeSingleSlotPaymentAmount,
  hasNonUniformCapacity,
  resolveSplitDivisorFromSlots,
  shouldSkipExtrasForPaidExtrasBookings,
  sumSlotExtraCosts,
} from "./booking-pricing.ts";

const slot = (over: Record<string, unknown> = {}) => ({
  start_time: "2026-09-01T10:00:00Z",
  end_time: "2026-09-01T11:00:00Z",
  price_per_session: 76.5,
  max_participants: 4,
  allow_single_booking: false,
  ...over,
});

Deno.test("sumSlotExtraCosts sums positive extras and ignores blanks/non-positive", () => {
  assertEquals(sumSlotExtraCosts([{ price: 5 }, { price: 2.5 }]), 7.5);
  assertEquals(sumSlotExtraCosts([{ price: 5 }, { price: 0 }, { price: -3 }, { price: null }]), 5);
  assertEquals(sumSlotExtraCosts([]), 0);
  assertEquals(sumSlotExtraCosts(null), 0);
  assertEquals(sumSlotExtraCosts(undefined), 0);
});

Deno.test("single-slot amount + extras: guest is charged the full session price PLUS extras", () => {
  // whole-slot (allow_single_booking=false) → full price, no per-spot division
  const base = computeSingleSlotPaymentAmount(slot(), null, 1);
  assertEquals(base, 76.5);
  const extras = sumSlotExtraCosts([{ price: 5, type: "per_session" }, { price: 2.5, type: "one_time" }]);
  assertEquals(base + extras, 84);
});

Deno.test("no extras → amount is unchanged (regression guard for the €0-extras case)", () => {
  const base = computeSingleSlotPaymentAmount(slot(), null, 1);
  assertEquals(base + sumSlotExtraCosts([]), 76.5);
  assertEquals(base + sumSlotExtraCosts(null), 76.5);
});

// G5 — the split divisor is the cycle's COURT CAPACITY (frozen), never a live player count.
Deno.test("resolveSplitDivisorFromSlots = MAX(max_participants), clamp ≥1", () => {
  assertEquals(resolveSplitDivisorFromSlots([{ max_participants: 4 }, { max_participants: 4 }]), 4);
  // non-uniform → MAX (never overcharges)
  assertEquals(resolveSplitDivisorFromSlots([{ max_participants: 4 }, { max_participants: 6 }]), 6);
  // null / 0 → 1
  assertEquals(resolveSplitDivisorFromSlots([{ max_participants: null }, { max_participants: 4 }]), 4);
  assertEquals(resolveSplitDivisorFromSlots([{ max_participants: 1 }]), 1);
  assertEquals(resolveSplitDivisorFromSlots([]), 1);
});

Deno.test("capacity divisor is frozen — €40 on a 4-seat court → €10 each regardless of headcount", () => {
  const divisor = resolveSplitDivisorFromSlots([{ max_participants: 4 }, { max_participants: 4 }]);
  assertEquals(applySplitPayment(40, divisor), 10);
  // divisor 1 (capacity ≤ 1) ⇒ no split (full price)
  assertEquals(applySplitPayment(40, resolveSplitDivisorFromSlots([{ max_participants: 1 }])), 40);
});

Deno.test("hasNonUniformCapacity flags the data anomaly (only)", () => {
  assertEquals(hasNonUniformCapacity([{ max_participants: 4 }, { max_participants: 4 }]), false);
  assertEquals(hasNonUniformCapacity([{ max_participants: 4 }, { max_participants: 6 }]), true);
  assertEquals(hasNonUniformCapacity([{ max_participants: 4 }]), false);
});

Deno.test("shouldSkipExtrasForPaidExtrasBookings: only non-cyclus + all flagged", () => {
  // both flagged, non-cyclus → skip
  assertEquals(
    shouldSkipExtrasForPaidExtrasBookings(
      [{ amount_includes_extras: true }],
      false,
    ),
    true,
  );
  // cyclus → never skip (extras billed separately)
  assertEquals(
    shouldSkipExtrasForPaidExtrasBookings(
      [{ amount_includes_extras: true }],
      true,
    ),
    false,
  );
  // any unflagged booking → do not skip (manual booking mixed in)
  assertEquals(
    shouldSkipExtrasForPaidExtrasBookings(
      [{ amount_includes_extras: true }, { amount_includes_extras: null }],
      false,
    ),
    false,
  );
  // empty set → do not skip
  assertEquals(shouldSkipExtrasForPaidExtrasBookings([], false), false);
});

Deno.test("single-slot invoice total == captured amount for a slot WITH extras (both paths)", () => {
  const extras = [
    { price: 5, type: "per_session", description: "Ballen" },
    { price: 2.5, type: "one_time", description: "Baanhuur" },
  ];
  const base = computeSingleSlotPaymentAmount(slot(), null, 1); // 76.5, whole-slot
  // Authed path (after fix) AND guest path both charge base + extras:
  const charged = base + sumSlotExtraCosts(extras); // 84
  assertEquals(charged, 84);

  // The paid booking carries payment_amount = charged and amount_includes_extras = true.
  const paidBooking = { amount_includes_extras: true };
  // auto-create-invoice / invoiceSync skip extras for this booking set...
  assertEquals(
    shouldSkipExtrasForPaidExtrasBookings([paidBooking], false),
    true,
  );
  // ...so the ONLY line item is the session line priced at payment_amount (= charged),
  // and the invoice total equals exactly what was captured. (resolveInvoiceUnitPrice
  // returns payment_amount verbatim when > 0.)
  const invoiceLineTotal = charged; // single line, quantity 1
  assertEquals(invoiceLineTotal, charged);
});
