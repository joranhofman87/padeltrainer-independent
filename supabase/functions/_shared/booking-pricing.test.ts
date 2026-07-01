import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { computeSingleSlotPaymentAmount, sumSlotExtraCosts } from "./booking-pricing.ts";

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
