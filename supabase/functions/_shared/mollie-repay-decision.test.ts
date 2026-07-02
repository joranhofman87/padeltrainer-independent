import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideRepayAction } from "./mollie-repay-decision.ts";

// FAILS before the fix (old code fell through to "recreate" on probe failure /
// cancel failure, minting a 2nd payable checkout => double charge).
Deno.test("probe non-ok / throw => retry, never recreate", () => {
  assertEquals(
    decideRepayAction({ probeOk: false, expectedAmount: 50 }),
    { kind: "retry" },
  );
});

Deno.test("open + drifted amount + cancel FAILED => retry, never recreate", () => {
  assertEquals(
    decideRepayAction({
      probeOk: true,
      priorStatus: "open",
      priorValueEuros: 40,
      expectedAmount: 50,
      cancelFailed: true,
    }),
    { kind: "retry" },
  );
});

Deno.test("open + drifted amount + cancel OK => recreate", () => {
  assertEquals(
    decideRepayAction({
      probeOk: true,
      priorStatus: "open",
      priorValueEuros: 40,
      expectedAmount: 50,
      cancelFailed: false,
    }),
    { kind: "recreate" },
  );
});

Deno.test("open + same amount => reuse", () => {
  assertEquals(
    decideRepayAction({
      probeOk: true,
      priorStatus: "open",
      priorValueEuros: 50,
      expectedAmount: 50,
    }),
    { kind: "reuse" },
  );
});

Deno.test("paid => already_paid", () => {
  assertEquals(
    decideRepayAction({ probeOk: true, priorStatus: "paid", expectedAmount: 50 }),
    { kind: "already_paid" },
  );
});

Deno.test("expired/canceled => recreate", () => {
  assertEquals(
    decideRepayAction({ probeOk: true, priorStatus: "expired", expectedAmount: 50 }),
    { kind: "recreate" },
  );
});
