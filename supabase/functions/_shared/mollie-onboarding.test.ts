import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { deriveMollieReadiness } from "./mollie-onboarding.ts";

Deno.test("completed + can-receive → fully ready", () => {
  assertEquals(
    deriveMollieReadiness({ status: "completed", canReceivePayments: true, canReceiveSettlements: true }),
    { onboardingComplete: true, chargesEnabled: true, payoutsEnabled: true },
  );
});

Deno.test("in-review (KYC not done) → NOT charges-enabled even though connected", () => {
  assertEquals(
    deriveMollieReadiness({ status: "in-review", canReceivePayments: false, canReceiveSettlements: false }),
    { onboardingComplete: false, chargesEnabled: false, payoutsEnabled: false },
  );
});

Deno.test("needs-data → not ready", () => {
  assertEquals(
    deriveMollieReadiness({ status: "needs-data", canReceivePayments: false }),
    { onboardingComplete: false, chargesEnabled: false, payoutsEnabled: false },
  );
});

Deno.test("can receive payments but not settlements yet (charges on, payouts off)", () => {
  assertEquals(
    deriveMollieReadiness({ status: "completed", canReceivePayments: true, canReceiveSettlements: false }),
    { onboardingComplete: true, chargesEnabled: true, payoutsEnabled: false },
  );
});

Deno.test("missing/undefined fields default to NOT ready (conservative)", () => {
  assertEquals(
    deriveMollieReadiness({}),
    { onboardingComplete: false, chargesEnabled: false, payoutsEnabled: false },
  );
  assertEquals(
    deriveMollieReadiness(null),
    { onboardingComplete: false, chargesEnabled: false, payoutsEnabled: false },
  );
});
