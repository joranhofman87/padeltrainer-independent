import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { distributeAmountCents } from "./guest-payment.ts";

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

Deno.test("distributeAmountCents splits evenly and sums back to the total", () => {
  const d = distributeAmountCents(30, 3);
  assertEquals(d, [10, 10, 10]);
  assertEquals(sum(d), 30);
});

Deno.test("distributeAmountCents spreads the remainder cent-by-cent to the front", () => {
  const d = distributeAmountCents(20, 3); // 2000c / 3 = 666 base, 2 remainder
  assertEquals(d, [6.67, 6.67, 6.66]);
  assertEquals(sum(d), 20);
});

Deno.test("distributeAmountCents handles sub-euro and single-session totals", () => {
  assertEquals(distributeAmountCents(0.05, 2), [0.03, 0.02]);
  assertEquals(distributeAmountCents(19.99, 1), [19.99]);
  assertEquals(sum(distributeAmountCents(99.97, 7)), 99.97);
});

Deno.test("distributeAmountCents returns [] for zero sessions", () => {
  assertEquals(distributeAmountCents(50, 0), []);
});
