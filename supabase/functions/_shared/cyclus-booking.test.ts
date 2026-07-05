import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { isCyclusBookingAllowed } from "./cyclus-booking.ts";

Deno.test("default: absent flag keeps the cyclus bookable (long-standing behavior)", () => {
  assertEquals(isCyclusBookingAllowed(null), true);
  assertEquals(isCyclusBookingAllowed(undefined), true);
  assertEquals(isCyclusBookingAllowed({}), true);
  assertEquals(isCyclusBookingAllowed({ allow_single_booking: true }), true);
});

Deno.test("explicit false blocks the whole-cyclus checkout", () => {
  assertEquals(isCyclusBookingAllowed({ allow_cyclus_booking: false }), false);
});

Deno.test("explicit true and junk values stay bookable (only literal false blocks)", () => {
  assertEquals(isCyclusBookingAllowed({ allow_cyclus_booking: true }), true);
  assertEquals(isCyclusBookingAllowed({ allow_cyclus_booking: "false" }), true);
  assertEquals(isCyclusBookingAllowed("garbage"), true);
});
