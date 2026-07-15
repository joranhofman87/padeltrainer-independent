import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  buildAcademyMollieConnectStatus,
  evaluateAcademyMollieReadiness,
  evaluateTrainerMollieReadiness,
} from "./mollie-payment-ready.ts";

Deno.test("connect status: org exists but access_token null → connected, not paymentReady", () => {
  const status = buildAcademyMollieConnectStatus({
    mollie_organization_id: "org_19475084",
    access_token: null,
    refresh_token: null,
    charges_enabled: true,
    payouts_enabled: true,
    onboarding_complete: true,
  });
  assertEquals(status.connected, true);
  assertEquals(status.paymentReady, false);
  assertEquals(status.paymentUnavailableReason, "missing_access_token");
  assertEquals(status.hasAccessToken, false);
});

Deno.test("connect status: charges disabled → paymentReady false", () => {
  const status = buildAcademyMollieConnectStatus({
    mollie_organization_id: "org_1",
    access_token: "tok",
    charges_enabled: false,
    onboarding_complete: true,
  });
  assertEquals(status.paymentReady, false);
  assertEquals(status.paymentUnavailableReason, "charges_disabled");
});

Deno.test("connect status: onboarding incomplete → paymentReady false", () => {
  const status = buildAcademyMollieConnectStatus({
    mollie_organization_id: "org_1",
    access_token: "tok",
    charges_enabled: true,
    onboarding_complete: false,
  });
  assertEquals(status.paymentReady, false);
  assertEquals(status.paymentUnavailableReason, "onboarding_incomplete");
});

Deno.test("connect status: ready account → paymentReady true", () => {
  const status = buildAcademyMollieConnectStatus({
    mollie_organization_id: "org_1",
    access_token: "tok",
    refresh_token: "ref",
    charges_enabled: true,
    onboarding_complete: true,
  });
  assertEquals(status.paymentReady, true);
  assertEquals(status.paymentUnavailableReason, null);
  assertEquals(status.hasAccessToken, true);
  assertEquals(status.hasRefreshToken, true);
});

Deno.test("academy: flags true but no access_token is not ready", () => {
  const result = evaluateAcademyMollieReadiness({
    access_token: null,
    charges_enabled: true,
    onboarding_complete: true,
  });
  assertEquals(result.ready, false);
  assertEquals(result.reason, "missing_access_token");
});

Deno.test("academy: full readiness when token and flags set", () => {
  const result = evaluateAcademyMollieReadiness({
    access_token: "tok_academy",
    charges_enabled: true,
    onboarding_complete: true,
  });
  assertEquals(result.ready, true);
  assertEquals(result.account?.access_token, "tok_academy");
});

Deno.test("academy: charges_disabled", () => {
  const result = evaluateAcademyMollieReadiness({
    access_token: "tok",
    charges_enabled: false,
    onboarding_complete: true,
  });
  assertEquals(result.ready, false);
  assertEquals(result.reason, "charges_disabled");
});

Deno.test("academy: onboarding_incomplete", () => {
  const result = evaluateAcademyMollieReadiness({
    access_token: "tok",
    charges_enabled: true,
    onboarding_complete: false,
  });
  assertEquals(result.ready, false);
  assertEquals(result.reason, "onboarding_incomplete");
});

Deno.test("academy: no_row", () => {
  const result = evaluateAcademyMollieReadiness(null);
  assertEquals(result.ready, false);
  assertEquals(result.reason, "no_row");
});

Deno.test("academy not ready does not become ready via trainer account (separate paths)", () => {
  const academy = evaluateAcademyMollieReadiness({
    access_token: null,
    charges_enabled: true,
    onboarding_complete: true,
  });
  const trainer = evaluateTrainerMollieReadiness({
    access_token: "trainer_tok",
    onboarding_complete: true,
  });
  assertEquals(academy.ready, false);
  assertEquals(trainer.ready, true);
});

Deno.test("academy (F06): soft-disconnected refuses NEW charges even when fully KYC-ready", () => {
  const r = evaluateAcademyMollieReadiness({
    access_token: "tok",
    refresh_token: "ref",
    charges_enabled: true,
    onboarding_complete: true,
    mollie_organization_id: "org_1",
    disconnected_at: "2026-07-15T10:00:00Z",
  });
  assertEquals(r.ready, false);
  assertEquals(r.reason, "disconnected");
});

Deno.test("connect status (F06): soft-disconnected reports NOT connected (settings UI offers reconnect)", () => {
  const status = buildAcademyMollieConnectStatus({
    mollie_organization_id: "org_1",
    access_token: "tok",
    refresh_token: "ref",
    charges_enabled: true,
    payouts_enabled: true,
    onboarding_complete: true,
    disconnected_at: "2026-07-15T10:00:00Z",
  });
  assertEquals(status.connected, false);
  assertEquals(status.paymentReady, false);
});

Deno.test("trainer: onboarding and access_token required", () => {
  assertEquals(
    evaluateTrainerMollieReadiness({
      access_token: "tok_trainer",
      onboarding_complete: true,
    }).ready,
    true,
  );
  assertEquals(
    evaluateTrainerMollieReadiness({
      access_token: null,
      onboarding_complete: true,
    }).reason,
    "missing_access_token",
  );
  assertEquals(
    evaluateTrainerMollieReadiness({
      access_token: "tok",
      onboarding_complete: false,
    }).reason,
    "onboarding_incomplete",
  );
});
