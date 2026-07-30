import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { recordInvoiceEmailEvent, type RecordDeliveryDeps } from "./invoice-delivery-tracking.ts";

function harness(rpcImpl: RecordDeliveryDeps["rpc"]) {
  const alerts: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logs: Array<{ step: string; details?: Record<string, unknown> }> = [];
  let rpcCalls = 0;
  const deps: RecordDeliveryDeps = {
    rpc: (name, args) => { rpcCalls++; return rpcImpl(name, args); },
    notifySlack: (_fn, message, context) => { alerts.push({ message, context }); return Promise.resolve(); },
    log: (step, details) => logs.push({ step, details }),
  };
  return { deps, alerts, logs, rpcCalls: () => rpcCalls };
}
const baseArgs = { eventType: "sent" as const, invoiceId: "inv-abc", invoiceNumber: "F-1", recipientEmail: "p@x.com", testEmail: null };

Deno.test("RESOLVED { error } result is surfaced: one log + one alert, returns false", async () => {
  const h = harness(() => Promise.resolve({ error: { message: "deadlock detected" } }));
  const ok = await recordInvoiceEmailEvent(h.deps, baseArgs);
  assertEquals(ok, false);
  assertEquals(h.alerts.length, 1);                              // exactly one alert (no duplicate)
  assertEquals(h.logs.filter((l) => l.step === "record_failed").length, 1);
  assertEquals(h.alerts[0].context?.invoiceId, "inv-abc");
  // PII-free: the alert context carries no recipient address
  assertEquals(Object.values(h.alerts[0].context ?? {}).includes("p@x.com"), false);
});

Deno.test("THROWN/network error is surfaced: one log + one alert, returns false", async () => {
  const h = harness(() => { throw new Error("fetch failed"); });
  const ok = await recordInvoiceEmailEvent(h.deps, baseArgs);
  assertEquals(ok, false);
  assertEquals(h.alerts.length, 1);
  assertEquals(h.alerts[0].context?.error, "fetch failed");
});

Deno.test("successful record: no alert, no record_failed log, returns true", async () => {
  const h = harness(() => Promise.resolve({ error: null }));
  const ok = await recordInvoiceEmailEvent(h.deps, baseArgs);
  assertEquals(ok, true);
  assertEquals(h.alerts.length, 0);
  assertEquals(h.logs.filter((l) => l.step === "record_failed").length, 0);
});

Deno.test("test-email send is bypassed: no RPC, no alert", async () => {
  const h = harness(() => Promise.resolve({ error: { message: "should not be called" } }));
  const ok = await recordInvoiceEmailEvent(h.deps, { ...baseArgs, testEmail: "me@x.com" });
  assertEquals(ok, true);
  assertEquals(h.rpcCalls(), 0);
  assertEquals(h.alerts.length, 0);
});

Deno.test("no recipient is bypassed: no RPC, no alert", async () => {
  const h = harness(() => Promise.resolve({ error: { message: "x" } }));
  const ok = await recordInvoiceEmailEvent(h.deps, { ...baseArgs, recipientEmail: null });
  assertEquals(ok, true);
  assertEquals(h.rpcCalls(), 0);
  assertEquals(h.alerts.length, 0);
});

Deno.test("exactly one alert per failed record (no duplicate for a single call)", async () => {
  const h = harness(() => Promise.resolve({ error: { message: "boom" } }));
  await recordInvoiceEmailEvent(h.deps, baseArgs);
  assertEquals(h.alerts.length, 1);
});

Deno.test("PII in the RPC error is redacted before EITHER sink (log + alert)", async () => {
  const leaky = "record failed for victim@example.com bearer eyJabc123.eyJdef456.sigGHI789 at "
    + "https://app.padeltrainer.ai/pay/secret-token-9f8e?apikey=supersecretvalue1234567890abcd";
  const h = harness(() => Promise.resolve({ error: { message: leaky } }));
  const ok = await recordInvoiceEmailEvent(h.deps, baseArgs);
  assertEquals(ok, false);
  const logged = String(h.logs.find((l) => l.step === "record_failed")?.details?.error ?? "");
  const alerted = String(h.alerts[0]?.context?.error ?? "");
  for (const sink of [logged, alerted]) {
    assertEquals(sink.includes("victim@example.com"), false);       // email
    assertEquals(sink.includes("eyJabc123"), false);                // JWT
    assertEquals(sink.includes("secret-token-9f8e"), false);        // URL path token
    assertEquals(sink.includes("supersecretvalue1234567890abcd"), false); // query secret
  }
});

Deno.test("a THROWING alert sink never breaks tracking's never-throw contract (still returns false)", async () => {
  const h = harness(() => Promise.resolve({ error: { message: "deadlock" } }));
  h.deps.notifySlack = () => { throw new Error("slack webhook down"); };   // sink itself throws
  const ok = await recordInvoiceEmailEvent(h.deps, baseArgs);             // must not propagate
  assertEquals(ok, false);
  assertEquals(h.logs.filter((l) => l.step === "record_failed").length, 1); // the log still happened
});
