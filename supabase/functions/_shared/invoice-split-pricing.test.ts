import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  resolveInvoiceUnitPrice,
  splitAmongPlayersForInvoiceCreate,
  type BookingWithSlotPrice,
} from "./invoice-split-pricing.ts";
import { resolveSplitDivisorFromSlots } from "./booking-pricing.ts";

// Faithful model of auto-create-invoice/index.ts:128-140 → resolveInvoiceUnitPrice.
// Rebook accept RPCs insert bookings with payment_amount = null, so the invoice unit
// price is driven entirely by (slot price, effective split).
//
// Rebooking on a shared-court (split_payment=true) cycle has TWO correct prices:
//   - WHOLE-GROUP CAPTAIN (create-group-rebook-invoice): pays FULL court price — that one
//     payment covers every seat. Must pass splitAmongPlayers:1 or the capacity auto-detect
//     charges the captain 1/capacity for the whole court (the P0 undercharge).
//   - SOLO CLAIMANT (create-rebook-invoice-public / authed create-rebook-invoice): pays their
//     1/capacity SHARE — they only rebook their own seat. Must OMIT splitAmongPlayers (or pass
//     the divisor) so the auto-detect applies; forcing full price would N×-OVERCHARGE them.
function effectiveSplit(
  requestedSplitAmongPlayers: number | null,
  slot: { split_payment?: boolean; max_participants?: number | null },
  bookings: BookingWithSlotPrice[],
): number | null {
  let split: number | null = requestedSplitAmongPlayers || null;
  if (!split && slot.split_payment === true) {
    const divisor = resolveSplitDivisorFromSlots([{ max_participants: slot.max_participants }]);
    if (divisor > 1) split = divisor;
  }
  return splitAmongPlayersForInvoiceCreate(bookings, split);
}

const rebookBookings = (slotPrice: number): BookingWithSlotPrice[] => [
  // payment_amount null: the strict/deferred rebook accept never stamps it.
  { payment_amount: null, availability_slots: { price_per_session: slotPrice } },
];

Deno.test("GROUP captain fix (P0): splitAmongPlayers=1 bills FULL court price on a split_payment slot", () => {
  const slot = { split_payment: true, max_participants: 4 };
  const split = effectiveSplit(1, slot, rebookBookings(40));
  // create-group-rebook-invoice passes splitAmongPlayers:1 → the captain's one payment is the
  // full court price (€40), covering all 4 seats. Omitting it (the bug) would bill €10 for the
  // whole court — a 4× undercharge.
  assertEquals(split, null);
  assertEquals(
    resolveInvoiceUnitPrice({ paymentAmount: null, slotPrice: 40, splitAmongPlayers: split }),
    40,
  );
});

Deno.test("GROUP captain regression: omitting the split would bill 1/capacity for the whole court", () => {
  const slot = { split_payment: true, max_participants: 4 };
  const split = effectiveSplit(null, slot, rebookBookings(40));
  assertEquals(split, 4);
  assertEquals(
    resolveInvoiceUnitPrice({ paymentAmount: null, slotPrice: 40, splitAmongPlayers: split }),
    10, // the undercharge the group fix prevents
  );
});

Deno.test("SOLO claimant: omitting the split correctly bills the 1/capacity SHARE (NOT full price)", () => {
  const slot = { split_payment: true, max_participants: 4 };
  const split = effectiveSplit(null, slot, rebookBookings(40));
  // create-rebook-invoice-public omits splitAmongPlayers on purpose: a solo claimant rebooking
  // their own seat pays their share (€10), matching the authed create-rebook-invoice. Forcing
  // full price here would 4× overcharge them.
  assertEquals(split, 4);
  assertEquals(
    resolveInvoiceUnitPrice({ paymentAmount: null, slotPrice: 40, splitAmongPlayers: split }),
    10,
  );
});

Deno.test("Both paths are a no-op on non-split cycles (already full price)", () => {
  const slot = { split_payment: false, max_participants: 4 };
  assertEquals(effectiveSplit(null, slot, rebookBookings(40)), null);
  assertEquals(effectiveSplit(1, slot, rebookBookings(40)), null);
  assertEquals(
    resolveInvoiceUnitPrice({ paymentAmount: null, slotPrice: 40, splitAmongPlayers: 1 }),
    40,
  );
});

Deno.test("splitAmongPlayersForInvoiceCreate: a requested split of 1 (or 0) means no split", () => {
  const bookings = rebookBookings(40);
  assertEquals(splitAmongPlayersForInvoiceCreate(bookings, 1), null);
  assertEquals(splitAmongPlayersForInvoiceCreate(bookings, 0), null);
  assertEquals(splitAmongPlayersForInvoiceCreate(bookings, null), null);
  // A genuine >1 split still passes through (per-player deferred invoice batches / solo share).
  assertEquals(splitAmongPlayersForInvoiceCreate(bookings, 4), 4);
});
