import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  invoiceOriginalBookingsAreSplitShares,
} from "./invoice-split-pricing.ts";

// slot price 76.50, split among 3 → per-recipient share 25.50
const shareBooking = () => ({
  payment_amount: 25.5,
  availability_slots: { price_per_session: 76.5 },
});

Deno.test("P2-8: original bookings that already carry per-recipient shares are detected", () => {
  // Two sessions, both share-priced (25.50 = 76.50/3). totalPlayers = 3.
  assertEquals(
    invoiceOriginalBookingsAreSplitShares(
      [shareBooking(), shareBooking()],
      3,
    ),
    true,
  );
});

Deno.test("P2-8: full-price single-payer bookings are NOT treated as pre-split", () => {
  // payment_amount equals the full slot price → not a share → still splittable.
  assertEquals(
    invoiceOriginalBookingsAreSplitShares(
      [{ payment_amount: 76.5, availability_slots: { price_per_session: 76.5 } }],
      3,
    ),
    false,
  );
});

Deno.test("P2-8: bookings without payment_amount are NOT pre-split (normal split path)", () => {
  assertEquals(
    invoiceOriginalBookingsAreSplitShares(
      [{ payment_amount: null, availability_slots: { price_per_session: 76.5 } }],
      3,
    ),
    false,
  );
});

Deno.test("P2-8: totalPlayers<=1 is never treated as pre-split", () => {
  assertEquals(
    invoiceOriginalBookingsAreSplitShares([shareBooking()], 1),
    false,
  );
});
