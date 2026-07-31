import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { handler } from "../send-invoice-email/index.ts";

// Every test snapshots + restores the env keys it touches, so nothing leaks into later tests.
const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "INVOICE_EMAIL_MAINTENANCE"];
async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const snap = Object.fromEntries(KEYS.map((k) => [k, Deno.env.get(k)]));
  try {
    for (const k of KEYS) { const v = overrides[k]; if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    await fn();
  } finally {
    for (const k of KEYS) { const v = snap[k]; if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}
// base env with a DEAD SUPABASE_URL: proves the maintenance/probe paths short-circuit BEFORE any network.
const BASE = { SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "svc-key" } as const;
const svcReq = (url: string, body = '{"invoiceId":"11111111-1111-1111-1111-111111111111"}') =>
  new Request(url, { method: "POST", headers: { Authorization: "Bearer svc-key", "Content-Type": "application/json" }, body });
const U = "https://x.test/send-invoice-email";

Deno.test("gate ON ⇒ 503 BEFORE any side effect (Resend configured)", () =>
  withEnv({ ...BASE, RESEND_API_KEY: "re_x", INVOICE_EMAIL_MAINTENANCE: "true" }, async () => {
    const res = await handler(svcReq(U));
    assertEquals(res.status, 503);
    assertEquals(await res.json(), { success: false, error: "invoice_email_maintenance" });
  }));

Deno.test("gate ON ⇒ 503 even when RESEND_API_KEY is MISSING (config checked AFTER the gate)", () =>
  withEnv({ ...BASE, RESEND_API_KEY: undefined, INVOICE_EMAIL_MAINTENANCE: "true" }, async () => {
    const res = await handler(svcReq(U));
    assertEquals(res.status, 503);                                   // not 500 email_not_configured
    assertEquals(await res.json(), { success: false, error: "invoice_email_maintenance" });
  }));

Deno.test("probe ⇒ 200 switch state, works even when Resend is UNCONFIGURED", () =>
  withEnv({ ...BASE, RESEND_API_KEY: undefined, INVOICE_EMAIL_MAINTENANCE: "true" }, async () => {
    const res = await handler(svcReq(U + "?probe=1"));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { status: "maintenance", maintenance: true });
  }));

Deno.test("probe ⇒ active when the switch is off (Resend configured or not)", () =>
  withEnv({ ...BASE, RESEND_API_KEY: "re_x", INVOICE_EMAIL_MAINTENANCE: undefined }, async () => {
    const res = await handler(svcReq(U + "?probe=1"));
    assertEquals(await res.json(), { status: "active", maintenance: false });
  }));

Deno.test("no Authorization ⇒ 401 regardless of Resend/maintenance config (auth is first)", () =>
  withEnv({ ...BASE, RESEND_API_KEY: undefined, INVOICE_EMAIL_MAINTENANCE: "true" }, async () => {
    const res = await handler(new Request(U, { method: "POST", body: "{}" }));
    assertEquals(res.status, 401);
  }));

Deno.test("gate OFF ⇒ passes auth+gate with NO network (missing Resend → 500 email_not_configured, deterministic)", () =>
  withEnv({ ...BASE, RESEND_API_KEY: undefined, INVOICE_EMAIL_MAINTENANCE: undefined }, async () => {
    // gate off → the AFTER-gate Resend check fires deterministically, BEFORE any body parse / DB / Slack call.
    const res = await handler(svcReq(U));
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { success: false, error: "email_not_configured" });   // reached past the gate, no network
  }));
