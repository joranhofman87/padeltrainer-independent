import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { classifyMollieCreateError, distributeAmountCents, resolveSlotRecipient } from "./guest-payment.ts";

type Row = Record<string, unknown>;

// A tiny supabase-js-shaped mock: records the .eq() filters and returns fixture rows that match
// them. maybeSingle() mimics PostgREST — >1 matching row → { data: null } (the collapse that a
// multi-academy trainer hits without a disambiguator).
function makeSupabase(fixtures: Record<string, Row[]>): SupabaseClient {
  const client = {
    from(table: string) {
      const rows = fixtures[table] ?? [];
      const filters: Array<[string, unknown]> = [];
      const match = () => rows.filter((r) => filters.every(([c, v]) => r[c] === v));
      const builder = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters.push([col, val]); return builder; },
        maybeSingle() {
          const m = match();
          return Promise.resolve(m.length > 1 ? { data: null, error: { message: "multiple rows" } } : { data: m[0] ?? null, error: null });
        },
        update() { return { eq: () => Promise.resolve({ data: null, error: null }) }; },
      };
      return builder;
    },
  };
  return client as unknown as SupabaseClient;
}

const T = "trainer-1";
const RECIPIENT_FIXTURES = {
  academy_trainers: [
    { trainer_profile_id: T, status: "active", academy_profile_id: "A", academy: { platform_fee_override: null } },
    { trainer_profile_id: T, status: "active", academy_profile_id: "B", academy: { platform_fee_override: null } },
  ],
  academy_mollie_accounts: [
    { academy_profile_id: "A", onboarding_complete: true, charges_enabled: true, access_token: "tok-A", mollie_organization_id: "org-A", refresh_token: null, token_expires_at: null },
    { academy_profile_id: "B", onboarding_complete: true, charges_enabled: true, access_token: "tok-B", mollie_organization_id: "org-B", refresh_token: null, token_expires_at: null },
  ],
  trainer_mollie_accounts: [
    { trainer_id: T, onboarding_complete: true, access_token: "tok-own", mollie_organization_id: "org-own", refresh_token: null, token_expires_at: null },
  ],
  subscription_plans: [{ tier: "academy", plan_type: "trainer", is_active: true, platform_fee_flat: 0.5 }],
  trainer_profiles: [{ id: T, platform_fee_override: null, subscription_status: "inactive" }],
};

Deno.test("resolveSlotRecipient: a 2-academy trainer routes to the slot's NAMED academy (F3)", async () => {
  const sb = makeSupabase(RECIPIENT_FIXTURES);
  const a = await resolveSlotRecipient(sb, T, "A");
  assertEquals(a.recipientType, "academy");
  assertEquals(a.accessToken, "tok-A");
  assertEquals(a.mollieOrgId, "org-A");

  const b = await resolveSlotRecipient(sb, T, "B");
  assertEquals(b.recipientType, "academy");
  assertEquals(b.accessToken, "tok-B");
  assertEquals(b.mollieOrgId, "org-B");
});

Deno.test("resolveSlotRecipient: without the academy hint a 2-academy trainer collapses to their OWN Mollie (the F3 bug the hint fixes)", async () => {
  const sb = makeSupabase(RECIPIENT_FIXTURES);
  const r = await resolveSlotRecipient(sb, T, null);
  assertEquals(r.recipientType, "trainer");
  assertEquals(r.accessToken, "tok-own");
});

Deno.test("resolveSlotRecipient: for a SINGLE-academy trainer the hint is a no-op (unchanged behaviour)", async () => {
  const single = {
    ...RECIPIENT_FIXTURES,
    academy_trainers: [{ trainer_profile_id: T, status: "active", academy_profile_id: "A", academy: { platform_fee_override: null } }],
  };
  const sb = makeSupabase(single);
  const withHint = await resolveSlotRecipient(sb, T, "A");
  const noHint = await resolveSlotRecipient(sb, T, null);
  assertEquals(withHint.recipientType, "academy");
  assertEquals(withHint.accessToken, "tok-A");
  assertEquals(noHint.recipientType, "academy");
  assertEquals(noHint.accessToken, "tok-A"); // maybeSingle returns the one row either way
});

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

Deno.test("classifyMollieCreateError flags the 'method not activated' 422 as not-ready", () => {
  // The exact body Mollie returned for a freshly-connected account.
  const body = JSON.stringify({
    status: 422,
    title: "Unprocessable Entity",
    detail: "The payment method is not activated on your account",
    field: "method",
  });
  assertEquals(classifyMollieCreateError(body), "mollie_not_ready");
});

Deno.test("classifyMollieCreateError treats other 'not enabled' method errors as not-ready", () => {
  assertEquals(
    classifyMollieCreateError(JSON.stringify({ detail: "Payment method not enabled", field: "amount" })),
    "mollie_not_ready",
  );
});

Deno.test("classifyMollieCreateError falls back to generic mollie_error for unrelated / non-JSON bodies", () => {
  assertEquals(classifyMollieCreateError(JSON.stringify({ detail: "The amount is too low", field: "amount" })), "mollie_error");
  assertEquals(classifyMollieCreateError("<html>502 Bad Gateway</html>"), "mollie_error");
  assertEquals(classifyMollieCreateError(""), "mollie_error");
});
