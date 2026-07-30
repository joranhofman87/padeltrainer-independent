import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { handler } from "../send-invoice-email/index.ts";

// A DEAD backend URL is the ordering probe: if the maintenance gate were moved AFTER the invoice/PDF/Resend side
// effects, a maintenance request would first hit this dead URL and surface a different status — never a clean 503
// invoice_email_maintenance. So "gate ON ⇒ 503 before any network" mutation-verifies the ordering.
function envMaintenance(on: boolean) {
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");          // dead: any query/fetch fails
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc-key");
  Deno.env.set("RESEND_API_KEY", "re_test");
  if (on) Deno.env.set("INVOICE_EMAIL_MAINTENANCE", "true"); else Deno.env.delete("INVOICE_EMAIL_MAINTENANCE");
}
const svcReq = (url: string) => new Request(url, {
  method: "POST", headers: { Authorization: "Bearer svc-key", "Content-Type": "application/json" },
  body: JSON.stringify({ invoiceId: "11111111-1111-1111-1111-111111111111" }),
});

Deno.test("gate ON ⇒ 503 invoice_email_maintenance BEFORE any side effect (service-role)", async () => {
  envMaintenance(true);
  const res = await handler(svcReq("https://x.test/send-invoice-email"));
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body, { success: false, error: "invoice_email_maintenance" });
});

Deno.test("probe ⇒ 200 switch state, no send (does not require the switch to be on)", async () => {
  envMaintenance(true);
  const res = await handler(svcReq("https://x.test/send-invoice-email?probe=1"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "maintenance", maintenance: true });
  envMaintenance(false);
  const res2 = await handler(svcReq("https://x.test/send-invoice-email?probe=1"));
  assertEquals(await res2.json(), { status: "active", maintenance: false });
});

Deno.test("gate OFF/unset ⇒ does NOT short-circuit as maintenance (parity: proceeds past the gate)", async () => {
  envMaintenance(false);
  const res = await handler(svcReq("https://x.test/send-invoice-email"));
  // proceeds to the real path against a dead backend → some non-maintenance outcome, never the 503 maintenance body
  assertEquals(res.status === 503, false);
  const body = await res.json().catch(() => ({}));
  assertEquals(body.error === "invoice_email_maintenance", false);
});

Deno.test("gate requires auth first: no Authorization ⇒ 401, never reaches the switch", async () => {
  envMaintenance(true);
  const res = await handler(new Request("https://x.test/send-invoice-email", { method: "POST", body: "{}" }));
  assertEquals(res.status, 401);
});
